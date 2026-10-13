/**
 * cleanup-external/proposal-items.test.ts — 제안 승인 semantics 보강 검증 (spec 5-9 / T32).
 *
 * 실 SQLite + 실 SqliteMemoryStore + 실 bge-m3 임베더 + 실 Repository. mock 클래스 0 —
 * 엔티티·제안·원장 전부 실제 행으로 심는다(lens-apply.test.ts 양식 정합).
 *
 * 검증 가족:
 *   (a) 항목 분해 — payload values 네 갈래를 itemKey 로 쪼갠다(추가형 kind 는 빈 배열).
 *   (b) 부분 승인 — 3항목 중 2항목만 고르면 2건 적용 + 1건 skipped + partially_applied.
 *   (c) 적용 시점 checksum — 제안 생성과 적용 사이 대상이 바뀌면 전건 미적용 +
 *       needs_revision(제출 시점 대조를 적용 시점까지 연장).
 *   (d) 중단 복구 — 적용 도중 끊긴 뒤 재시도가 이미 적용된 항목을 다시 적용하지 않는다.
 *       중단은 onItemApplied seam 에서 예외를 던져 재현한다(가짜 클래스 없이 실제 흐름
 *       한가운데를 끊는다).
 *   (e) 상태 판정 — 전건/일부/0건 각각 applied·partially_applied·needs_revision.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { CleanupProposalsRepository } from "../../db/store-internal/cleanup-proposals-repository.ts";
import { createEmbedder, embeddingDimensionOf } from "../../embedding/factory.ts";
import type { Embedder } from "../../embedding/types.ts";
import type { MemoryApiDeps } from "../types.ts";
import { buildEntityLens } from "../../memory/cleanup-deep-pass/entity-lens.ts";
import {
  lensToApplyView,
  serializeLens,
  listEvidenceNodeIds,
  entityTargetKey,
} from "../../memory/cleanup-deep-pass/lens-draft-candidate-query.ts";
import { serializeEntityStructuredValue } from "../../memory/cleanup-deep-pass/lens-apply.ts";
import { lensDraftFingerprint } from "../../memory/cleanup-deep-pass/stage-fingerprint.ts";
import {
  listProposalItems,
  applyProposalItems,
  judgeProposalStatus,
  describeZeroApplyReason,
  ITEMIZED_KINDS,
} from "./proposal-items.ts";

const MODEL = "bge-m3";
/**
 * usable 종류를 쓰는 이유: 렌즈가 columns(사용법)·attributes(주의사항)·metadata
 * (event_at·event_until·place)를 모두 광고하는 유일한 종류라, 한 제안 안에 여러 갈래
 * 항목이 섞인 실제 다항목 제안을 만들 수 있다(항목 분해의 진짜 검증 대상).
 */
const TYPE_NAME = "usable";

let embedder: Embedder;
let db: Database;
let store: SqliteMemoryStore;
let repo: CleanupProposalsRepository;
let deps: MemoryApiDeps;

beforeAll(async () => {
  embedder = createEmbedder({ model: MODEL });
  await embedder.load();
});

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: embeddingDimensionOf(MODEL) });
  store = new SqliteMemoryStore(db, embedder);
  repo = new CleanupProposalsRepository(db);
  deps = {
    store,
    retriever: undefined as unknown as MemoryApiDeps["retriever"],
    assembler: undefined as unknown as MemoryApiDeps["assembler"],
  };
});

afterEach(() => {
  db.close();
});

/** 실 knowledge_nodes 행 — metadata 항목 적용에 필요한 근거 노드. */
function insertNode(content: string): number {
  const info = db
    .prepare(
      "INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES (?, 'auto_capture', '2026-08-03 10:00:00')",
    )
    .run(content);
  return Number(info.lastInsertRowid);
}

/**
 * 실 엔티티 + 근거 노드 + 그 엔티티의 현재 값으로 만든 정상 지문을 담은 제안을 심는다.
 * 적용 시점 재계산 지문이 이 값과 같아야 적용이 통과한다(정상 경로).
 *
 * values 는 호출자가 갈래별로 넘긴다 — 한 제안 안에 columns·labels·metadata 가 섞인
 * 진짜 다항목 제안을 만든다.
 */
async function seedProposal(values: {
  columns?: Record<string, unknown>;
  labels?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<{ proposalId: string; entityId: string; evidenceNodeId: number }> {
  const ent = await store.entitiesRepo.findOrCreateEntity(TYPE_NAME, "도구A");
  const evidenceNodeId = insertNode("도구A 사용 기록");
  const lens = lensToApplyView(buildEntityLens(TYPE_NAME));
  const evidenceNodeIds = [evidenceNodeId];
  const lensSerialization = serializeLens(lens);
  const expectedFingerprint = lensDraftFingerprint({
    entityStructuredValue: serializeEntityStructuredValue({ store }, ent.id),
    lensSerialization,
    evidenceNodeIds: listEvidenceNodeIds(db, ent.id),
  });
  const payload: Record<string, unknown> = {
    typeName: TYPE_NAME,
    entityId: ent.id,
    values: {
      columns: values.columns ?? {},
      labels: values.labels ?? {},
      relations: {},
      metadata: values.metadata ?? {},
    },
    fingerprintGuard: {
      expectedFingerprint,
      lensSerialization,
      evidenceNodeIds,
    },
  };
  const proposalId = repo.insert("lens_draft", payload);
  return { proposalId, entityId: ent.id, evidenceNodeId };
}

/** 엔티티의 칸 현재 값을 key→value 로 읽는다(적용 결과 확인용). */
function readColumns(entityId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of store.entitiesRepo.listAttributes(entityId)) {
    if (a.isColumn) out.set(a.key, a.value);
  }
  return out;
}

/** usable 렌즈가 광고하는 칸·라벨 이름(하드코딩 대신 렌즈에서 읽는다). */
function lensKeys(): { column: string; label: string } {
  const lens = lensToApplyView(buildEntityLens(TYPE_NAME));
  expect(lens.columns.length).toBeGreaterThanOrEqual(1);
  expect(lens.attributeKeys.length).toBeGreaterThanOrEqual(1);
  return { column: lens.columns[0]!.key, label: lens.attributeKeys[0]! };
}

// ── (a) 항목 분해 ────────────────────────────────────────────────────────────

describe("(a) listProposalItems — payload 항목 분해", () => {
  test("lens_draft values 네 갈래를 itemKey 로 쪼갠다", () => {
    const items = listProposalItems("lens_draft", {
      values: {
        columns: { 주제: "그래프", 저자: "홍" },
        labels: {},
        relations: {},
        metadata: { place: "서울" },
      },
    });
    expect(items.map((i) => i.itemKey)).toEqual([
      "columns:저자",
      "columns:주제",
      "metadata:place",
    ]);
    expect(items.find((i) => i.itemKey === "columns:주제")?.value).toBe("그래프");
  });

  test("추가형 kind 는 빈 배열 — 항목 분해를 안 쓴다(단일 승인 유지)", () => {
    for (const kind of ["metadata_fill", "person_link", "regex_pattern_add"]) {
      expect(ITEMIZED_KINDS.has(kind)).toBe(false);
      expect(listProposalItems(kind, { nodeId: 1, field: "place", value: "서울" })).toEqual(
        [],
      );
    }
  });

  test("파괴형 kind 는 lens_draft 한 종류 — 분해 대상 명시", () => {
    expect([...ITEMIZED_KINDS]).toEqual(["lens_draft"]);
  });
});

// ── (b) 부분 승인 ────────────────────────────────────────────────────────────

describe("(b) 부분 승인 — 고른 항목만 적용", () => {
  test("3항목 중 2항목 선택 → 2건 적용 + 1건 skipped + partially_applied", async () => {
    const { column, label } = lensKeys();
    const { proposalId, entityId, evidenceNodeId } = await seedProposal({
      columns: { [column]: "사용법 값" },
      labels: { [label]: "주의 값" },
      metadata: { place: "서울" },
    });

    // columns·labels 두 항목만 고르고 metadata:place 는 뺀다.
    const result = await applyProposalItems(deps, repo, {
      proposalId,
      payload: repo.findById(proposalId)!.payload,
      selectedItemKeys: new Set([`columns:${column}`, `labels:${label}`]),
    });

    expect(result.appliedCount).toBe(2);
    expect(result.checksumMismatch).toBe(false);
    expect(judgeProposalStatus(result)).toBe("partially_applied");

    // 고른 칸은 실제로 채워졌다.
    expect(readColumns(entityId).get(column)).toBe("사용법 값");

    // 안 고른 metadata 는 근거 노드에 반영되지 않았다 — 적용이 실제로 일어나지 않았다.
    const nodeRow = db
      .prepare("SELECT metadata_json FROM knowledge_nodes WHERE id = ?")
      .get(evidenceNodeId) as { metadata_json: string | null };
    expect(nodeRow.metadata_json ?? "").not.toContain("서울");

    // 안 고른 항목은 사유와 함께 원장에 남는다(조용한 누락 없음).
    const skipped = result.outcomes.find((o) => o.itemKey === "metadata:place");
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.detail).toBe("사용자가 고르지 않음");

    const journal = repo.listJournal(proposalId);
    expect(journal).toHaveLength(3);
    expect(journal.filter((j) => j.status === "applied")).toHaveLength(2);
    expect(journal.filter((j) => j.status === "skipped")).toHaveLength(1);
  });

  test("선택 미지정 = 전건 승인 → applied (옛 단일 승인 계약 보존)", async () => {
    const { column, label } = lensKeys();
    const { proposalId, entityId } = await seedProposal({
      columns: { [column]: "사용법 값" },
      labels: { [label]: "주의 값" },
    });

    const result = await applyProposalItems(deps, repo, {
      proposalId,
      payload: repo.findById(proposalId)!.payload,
    });

    expect(result.appliedCount).toBe(2);
    expect(judgeProposalStatus(result)).toBe("applied");
    expect(readColumns(entityId).get(column)).toBe("사용법 값");
  });
});

// ── (c) 적용 시점 checksum ───────────────────────────────────────────────────

describe("(c) 적용 시점 checksum — 제안 생성 이후 대상 변경", () => {
  test("적용 직전 대상이 바뀌면 전건 미적용 + needs_revision", async () => {
    const { column, label } = lensKeys();
    const { proposalId, entityId } = await seedProposal({
      columns: { [column]: "AI 가 제안한 값" },
      labels: { [label]: "주의 값" },
    });

    // 제안 생성과 승인 사이에 사람이 직접 같은 칸을 채운다. 이 변경으로 적용 시점
    // 재계산 지문이 제안 시점 지문과 어긋난다 — AI 는 이 값을 보지 못한 상태다.
    store.entitiesRepo.setAttribute(entityId, column, "사람이 채운 값", true);

    const result = await applyProposalItems(deps, repo, {
      proposalId,
      payload: repo.findById(proposalId)!.payload,
    });

    expect(result.checksumMismatch).toBe(true);
    expect(result.appliedCount).toBe(0);
    expect(judgeProposalStatus(result)).toBe("needs_revision");

    // 사람이 채운 값이 그대로다 — AI 제안이 덮지 않았다(파괴 차단의 핵심).
    expect(readColumns(entityId).get(column)).toBe("사람이 채운 값");

    // 원장에 전건 사유가 남는다(일부만 적용되는 일 없음).
    const journal = repo.listJournal(proposalId);
    expect(journal).toHaveLength(2);
    expect(journal.every((j) => j.status === "skipped")).toBe(true);
    expect(journal[0]!.detail).toBe(
      "제안 생성 이후 대상이 바뀌어 적용을 거부 — 재평가 필요",
    );
  });

  test("대상 엔티티가 사라지면 적용 거부 — 조용한 no-op 아님", async () => {
    const { column } = lensKeys();
    const { proposalId, entityId } = await seedProposal({
      columns: { [column]: "값1" },
    });

    db.prepare("DELETE FROM entities WHERE entity_id = ?").run(entityId);

    const result = await applyProposalItems(deps, repo, {
      proposalId,
      payload: repo.findById(proposalId)!.payload,
    });

    expect(result.checksumMismatch).toBe(true);
    expect(result.appliedCount).toBe(0);
    expect(repo.listJournal(proposalId)[0]!.detail).toBe(
      "적용 대상이 사라져 적용 거부 — 재평가 필요",
    );
  });
});

// ── (d) 중단 복구 ────────────────────────────────────────────────────────────

describe("(d) journal 중단 복구 — 이미 적용된 항목 재적용 차단", () => {
  test("적용 도중 끊긴 뒤 재시도가 적용된 항목을 건너뛴다", async () => {
    const { column, label } = lensKeys();
    const { proposalId, entityId } = await seedProposal({
      columns: { [column]: "사용법 값" },
      labels: { [label]: "주의 값" },
      metadata: { place: "서울" },
    });
    const payload = repo.findById(proposalId)!.payload;

    // 1차 시도 — 첫 항목 적용 직후 프로세스가 끊긴 상황을 재현한다. seam 에서 던진
    // 예외는 applyProposalItems 밖으로 그대로 나간다(적용 흐름 한가운데 중단).
    const appliedBeforeCrash: string[] = [];
    await expect(
      applyProposalItems(deps, repo, {
        proposalId,
        payload,
        onItemApplied: (itemKey) => {
          appliedBeforeCrash.push(itemKey);
          throw new Error("적용 도중 중단(시험)");
        },
      }),
    ).rejects.toThrow("적용 도중 중단(시험)");

    // 끊기기 전 한 항목만 적용됐고, 그 사실이 원장에 남았다.
    expect(appliedBeforeCrash).toHaveLength(1);
    const crashedKey = appliedBeforeCrash[0]!;
    expect(repo.appliedItemKeys(proposalId)).toEqual(new Set([crashedKey]));

    // 중단 시점 — 원장이 "한 항목 적용됨" 이라 말하고, 그 뒤 항목들은 아직 원장에 없다.
    expect(repo.listJournal(proposalId).filter((j) => j.status === "applied")).toHaveLength(
      1,
    );

    // 2차 시도(재적용) — 이미 적용된 항목은 다시 적용하지 않는다. 그 항목을 다시
    // 적용했다면 applyLensDraft 가 또 불려 쓰기가 반복됐을 것이다.
    const reapplied: string[] = [];
    const result = await applyProposalItems(deps, repo, {
      proposalId,
      payload,
      onItemApplied: (itemKey) => {
        reapplied.push(itemKey);
      },
    });

    // 중단된 항목은 재적용 대상에서 빠졌다(건너뛰기 = 중복 적용 차단).
    expect(reapplied).not.toContain(crashedKey);
    expect(reapplied).toHaveLength(2);
    expect(result.appliedCount).toBe(2);

    // 결과적으로 세 항목 전부 적용 상태 — 중단이 유실을 남기지 않았다.
    expect(judgeProposalStatus(result)).toBe("applied");
    expect(readColumns(entityId).get(column)).toBe("사용법 값");
    expect(repo.appliedItemKeys(proposalId).size).toBe(3);
  });

  test("중단 뒤 남이 대상을 바꿨으면 재시도도 거부 — 복구가 checksum 을 무력화하지 않는다", async () => {
    const { column, label } = lensKeys();
    const { proposalId, entityId } = await seedProposal({
      columns: { [column]: "사용법 값" },
      labels: { [label]: "주의 값" },
      metadata: { place: "서울" },
    });
    const payload = repo.findById(proposalId)!.payload;

    // 1차 시도 — 첫 항목 적용 직후 중단.
    await expect(
      applyProposalItems(deps, repo, {
        proposalId,
        payload,
        onItemApplied: () => {
          throw new Error("적용 도중 중단(시험)");
        },
      }),
    ).rejects.toThrow("적용 도중 중단(시험)");
    expect(repo.appliedItemKeys(proposalId).size).toBe(1);

    // 중단과 재시도 사이에 *사람이* 대상을 바꾼다. 재개 기준 지문(중단 직후 값)과
    // 어긋나므로, 재시도는 "내가 만든 변화" 가 아니라 "남의 변경" 으로 판정해야 한다.
    store.entitiesRepo.setAttribute(entityId, column, "사람이 덮어쓴 값", true);

    const result = await applyProposalItems(deps, repo, { proposalId, payload });

    expect(result.checksumMismatch).toBe(true);
    expect(result.appliedCount).toBe(0);
    expect(judgeProposalStatus(result)).toBe("needs_revision");
    // 사람이 덮어쓴 값이 그대로다 — 복구 통로가 파괴 방어를 뚫지 않았다.
    expect(readColumns(entityId).get(column)).toBe("사람이 덮어쓴 값");
  });
});

// ── (f) 원장 기록 실패 격리 (리뷰 High) ──────────────────────────────────────
//
// 원장 INSERT 자체가 실패해도: (1) 적용된 항목을 failed 로 거짓 보고하지 않고,
// (2) 그 예외가 루프를 끊어 앞선 결과를 삼키지 않는다.
// 실패는 실제 SQLite 오류로 만든다 — 원장 테이블을 지워 INSERT 가 진짜로 던지게 한다
// (가짜 repo 클래스 안 만듦).

describe("(f) 원장 기록 실패 — 거짓 진술 금지 + 루프 계속", () => {
  test("원장 INSERT 실패 시 적용 항목은 applied(경고 동반)로 보고되고 루프가 이어진다", async () => {
    const { column, label } = lensKeys();
    const { proposalId, entityId } = await seedProposal({
      columns: { [column]: "사용법 값" },
      labels: { [label]: "주의 값" },
    });
    const payload = repo.findById(proposalId)!.payload;

    // 원장 테이블을 없애 recordJournalEntry 가 실제 SQLite 오류로 던지게 만든다.
    db.prepare("DROP TABLE cleanup_proposal_item_journal").run();

    const result = await applyProposalItems(deps, repo, { proposalId, payload });

    // (1) 거짓 진술 없음 — 실제로 적용됐으므로 failed 가 아니라 applied 다.
    expect(result.outcomes.every((o) => o.status === "applied")).toBe(true);
    expect(result.appliedCount).toBe(2);
    expect(judgeProposalStatus(result)).toBe("applied");

    // (2) 원장 기록 실패 사실이 회신에 정직하게 실린다(조용히 삼키지 않음).
    expect(result.outcomes[0]?.detail).toContain("원장 기록 실패");
    expect(result.outcomes[0]?.detail).toContain("자동 재개 대상이 아님");

    // (3) 루프가 끊기지 않아 두 항목 모두 실제로 적용됐다.
    expect(readColumns(entityId).get(column)).toBe("사용법 값");
  });

  test("원장 기록이 실패해도 checksum 거부 판정은 회신된다 — 결론이 사라지지 않는다", async () => {
    const { column } = lensKeys();
    const { proposalId, entityId } = await seedProposal({
      columns: { [column]: "AI 값" },
    });
    const payload = repo.findById(proposalId)!.payload;

    // 대상 변경(적용 거부 유발) + 원장 테이블 제거(기록 실패 유발)를 겹친다.
    store.entitiesRepo.setAttribute(entityId, column, "사람이 채운 값", true);
    db.prepare("DROP TABLE cleanup_proposal_item_journal").run();

    const result = await applyProposalItems(deps, repo, { proposalId, payload });

    // 판정 자체는 살아 있다 — 기록 실패가 "적용 거부" 라는 결론을 삼키지 않았다.
    expect(result.checksumMismatch).toBe(true);
    expect(result.appliedCount).toBe(0);
    expect(result.outcomes[0]?.detail).toContain("원장 기록 실패");
    expect(readColumns(entityId).get(column)).toBe("사람이 채운 값");
  });
});

// ── (g) 적용~원장 사이 잔여 창 (리뷰 High 3) ────────────────────────────────
//
// applyLensDraft 는 자기 트랜잭션을 커밋하고 돌아오므로, 그 직후~원장 INSERT 직전에
// 프로세스가 죽으면 "적용됐는데 원장에 없는" 항목이 남는다. 이 창을 없앨 수는 없고
// (트랜잭션 소유권이 적용 함수에 있다), 데이터가 깨지지도 않는다 — 재시도가 적용 시점
// 지문 대조에서 걸려 전건 거부되므로 같은 변경이 두 번 적용되지 않는다. 증상은
// "자동 재개 불가(재작업)" 다. 그 사실을 테스트로 고정한다.

describe("(g) 적용~원장 사이 잔여 창 — 이중 적용 없음, 재개 불가로 수렴", () => {
  test("원장 없이 적용만 된 상태에서 재시도하면 이중 적용 대신 needs_revision", async () => {
    const { column, label } = lensKeys();
    const { proposalId, entityId } = await seedProposal({
      columns: { [column]: "사용법 값" },
      labels: { [label]: "주의 값" },
    });
    const payload = repo.findById(proposalId)!.payload;

    // 적용은 일어났으나 원장에는 안 남은 상태를 만든다(창 안에서 죽은 상황과 동일).
    const items = listProposalItems("lens_draft", payload);
    const firstItem = items[0]!;
    await applyProposalItems(deps, repo, {
      proposalId,
      payload,
      selectedItemKeys: new Set([firstItem.itemKey]),
    });
    db.prepare("DELETE FROM cleanup_proposal_item_journal WHERE proposal_id = ?").run(
      proposalId,
    );
    const appliedValue = readColumns(entityId).get(column);
    expect(repo.appliedItemKeys(proposalId).size).toBe(0);

    // 재시도 — 원장이 비어 제안 시점 지문으로 대조하고, 대상이 이미 바뀌었으므로 거부.
    const retry = await applyProposalItems(deps, repo, { proposalId, payload });

    expect(retry.checksumMismatch).toBe(true);
    expect(retry.appliedCount).toBe(0);
    expect(judgeProposalStatus(retry)).toBe("needs_revision");
    // 이중 적용 없음 — 값이 그대로다(데이터 오염이 아니라 재개 불가로 수렴).
    expect(readColumns(entityId).get(column)).toBe(appliedValue);
  });
});

// ── (h) 적용 0건 사유 구분 (리뷰 Low) ───────────────────────────────────────

describe("(h) describeZeroApplyReason — 사유 갈래 구분", () => {
  test("빈 초안 / 대상 변경 / 미선택 / 전건 실패를 각각 다른 문구로 알린다", () => {
    const skipped = (itemKey: string, detail: string) =>
      ({ itemKey, status: "skipped" as const, detail });

    // 항목 0개 — 생산자가 빈 초안을 냈다.
    expect(
      describeZeroApplyReason({
        outcomes: [],
        appliedCount: 0,
        checksumMismatch: false,
      }),
    ).toContain("생산자가 빈 초안");

    // 대상 변경.
    expect(
      describeZeroApplyReason({
        outcomes: [skipped("a", "무관")],
        appliedCount: 0,
        checksumMismatch: true,
      }),
    ).toContain("재평가 필요");

    // 전건 미선택.
    expect(
      describeZeroApplyReason({
        outcomes: [skipped("a", "사용자가 고르지 않음")],
        appliedCount: 0,
        checksumMismatch: false,
      }),
    ).toContain("고른 항목이 없어");

    // 전건 실패.
    expect(
      describeZeroApplyReason({
        outcomes: [{ itemKey: "a", status: "failed", detail: "칸 형식 어긋남" }],
        appliedCount: 0,
        checksumMismatch: false,
      }),
    ).toContain("items 참조");
  });
});

// ── (e) 상태 판정 ────────────────────────────────────────────────────────────

describe("(e) judgeProposalStatus — 상태 확장 판정", () => {
  test("전건 적용 = applied / 일부 = partially_applied / 0건 = needs_revision", () => {
    const applied = (itemKey: string) =>
      ({ itemKey, status: "applied" as const, detail: null });
    const skipped = (itemKey: string) =>
      ({ itemKey, status: "skipped" as const, detail: "사유" });

    expect(
      judgeProposalStatus({
        outcomes: [applied("a"), applied("b")],
        appliedCount: 2,
        checksumMismatch: false,
      }),
    ).toBe("applied");

    expect(
      judgeProposalStatus({
        outcomes: [applied("a"), skipped("b")],
        appliedCount: 1,
        checksumMismatch: false,
      }),
    ).toBe("partially_applied");

    expect(
      judgeProposalStatus({
        outcomes: [skipped("a"), skipped("b")],
        appliedCount: 0,
        checksumMismatch: true,
      }),
    ).toBe("needs_revision");
  });
});
