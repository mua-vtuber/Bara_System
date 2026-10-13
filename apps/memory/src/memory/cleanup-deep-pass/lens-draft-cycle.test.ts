/**
 * lens-draft-cycle.test.ts — 데이터 정리 AI 렌즈 소비 단계 사이클 검증 (spec 6.C-2).
 *
 * 실 SQLite + 실 SqliteMemoryStore + 실 bge-m3 임베더 + 실 EventBus. LLM 은 데이터 fixture
 * 응답 함수만 주입한다(mock 클래스 0). 검증 초점:
 *   - 후보 검출: 렌즈 정의 종류의 빈 칸 엔티티만 후보, 칸이 다 찬 엔티티는 후보 아님.
 *   - 멱등 1: kind=lens_draft 제안이 이미 있는 엔티티 제외.
 *   - 멱등 2: 결과 원장(completed)이 같은 엔티티 재검출 차단.
 *   - 사전 필터: 렌즈 밖 키 초안은 제안이 안 되고 결정적 실패로 원장 기록(자동 적용 0).
 *   - 자동 적용 0: 유효 초안도 엔티티를 안 고치고 cleanup_proposals 로만 남는다.
 *   - fingerprint guard: 제안 payload 에 초안 시점 fingerprint·렌즈 직렬화·근거 노드 동반.
 *   - approve 공유 함수 경유: cleanup-proposals approve 가 applyLensDraft 로 실제 적용.
 */

import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import type { MemoryType } from "../types.ts";
import { createEmbedder, embeddingDimensionOf } from "../../embedding/factory.ts";
import type { Embedder } from "../../embedding/types.ts";
import { EventRepository } from "../../db/store-internal/event-repository.ts";
import { EventBus } from "../../server-internal/event-bus.ts";
import type { MemoryApiDeps } from "../../server-internal/types.ts";
import { registerCleanupProposalsRoutes } from "../../server-internal/routes/cleanup-proposals.ts";
import { registerEntityLensRoutes } from "../../server-internal/routes/entity-lenses.ts";
import {
  runLensDraftCycle,
  LENS_DRAFT_KIND,
  type LensDraftDecision,
  type LensDraftInferCycleDeps,
  type LensDraftInferFn,
  type LensDraftInferInput,
} from "./lens-draft-cycle.ts";
import { getStageResult } from "./stage-results-ledger.ts";

const STAGE_VERSION = 1;
const MAX_ATTEMPTS = 3;
const MODEL = "bge-m3";

/** 원장 target_key 구성 — candidate-query 의 entityTargetKey 와 같은 구분자(U+001F). */
function targetKeyOf(typeName: string, entityId: string): string {
  return `${typeName}${String.fromCharCode(0x1f)}${entityId}`;
}

let embedder: Embedder;
let db: Database;
let store: SqliteMemoryStore;
let events: EventRepository;
let eventBus: EventBus;
let deps: MemoryApiDeps;

beforeAll(async () => {
  embedder = createEmbedder({ model: MODEL });
  await embedder.load();
});

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: embeddingDimensionOf(MODEL) });
  store = new SqliteMemoryStore(db, embedder);
  events = new EventRepository(db);
  eventBus = new EventBus(events);
  deps = {
    store,
    retriever: undefined as unknown as MemoryApiDeps["retriever"],
    assembler: undefined as unknown as MemoryApiDeps["assembler"],
  };
});

afterEach(() => {
  db.close();
});

/** infer fixture — responder 가 낸 결정 배열을 ok StageInferResult 로 감싼다. */
function fixtureInfer(
  responder: (input: LensDraftInferInput) => LensDraftDecision[],
): { fn: LensDraftInferFn; calls: LensDraftInferInput[] } {
  const calls: LensDraftInferInput[] = [];
  const fn: LensDraftInferFn = async (input) => {
    calls.push(input);
    return { kind: "ok", parsed: responder(input) };
  };
  return { fn, calls };
}

function cycleDeps(
  overrides: Pick<LensDraftInferCycleDeps, "infer"> &
    Partial<LensDraftInferCycleDeps>,
): LensDraftInferCycleDeps {
  return {
    deps,
    eventBus,
    batchSize: 20,
    stageVersion: STAGE_VERSION,
    maxAttemptsPerTarget: MAX_ATTEMPTS,
    perCallInputCap: 30000,
    ...overrides,
  };
}

/** 근거 노드 하나를 만들고 엔티티에 라벨 엣지로 이어 근거로 등록한다. */
async function addEvidenceNode(entityId: string, content: string): Promise<number> {
  const nodeId = await store.addNode({ content, sourceType: "llm_extract" });
  const conceptId = await store.findOrCreateTagConcept(`근거_${nodeId}`);
  db.prepare(
    `INSERT INTO entity_concept_edges
       (entity_id, concept_id, role, provenance, source_node_id, created_at)
     VALUES (?, ?, 'has_attribute', 'evolver', ?, datetime('now','localtime'))`,
  ).run(entityId, conceptId, nodeId);
  return nodeId;
}

/**
 * addEvidenceNode 와 같되 근거 노드의 memory_type 을 지정한다(선호 트랙 배제 검증
 * fixture 전용 — spec H 후반). lensDraft 후보는 entity(entities 테이블, 독립 PK
 * entity_id) 이지 knowledge_nodes 행이 아니므로, 근거 노드가 preference 든 fact
 * 든 그 자체가 후보 목록을 바꿀 이유가 없다 — 이 함수는 그 구조적 무관성을
 * 회귀 테스트로 고정한다.
 */
async function addEvidenceNodeWithMemoryType(
  entityId: string,
  content: string,
  memoryType: MemoryType,
): Promise<number> {
  const nodeId = await store.addNode({
    content,
    sourceType: "llm_extract",
    memoryType,
  });
  const conceptId = await store.findOrCreateTagConcept(`근거_${nodeId}`);
  db.prepare(
    `INSERT INTO entity_concept_edges
       (entity_id, concept_id, role, provenance, source_node_id, created_at)
     VALUES (?, ?, 'has_attribute', 'evolver', ?, datetime('now','localtime'))`,
  ).run(entityId, conceptId, nodeId);
  return nodeId;
}

function listLensDraftProposals(): Array<{
  id: string;
  status: string;
  payload: Record<string, unknown>;
}> {
  const rows = db
    .prepare(
      "SELECT id, status, payload_json FROM cleanup_proposals WHERE kind = ? ORDER BY rowid ASC",
    )
    .all(LENS_DRAFT_KIND) as Array<{ id: string; status: string; payload_json: string }>;
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    payload: JSON.parse(r.payload_json) as Record<string, unknown>,
  }));
}

describe("후보 검출", () => {
  test("빈 칸 엔티티만 후보로 잡고, 칸이 다 찬 엔티티는 후보 아님", async () => {
    const empty = await store.entitiesRepo.findOrCreateEntity("material", "빈자료");
    const filled = await store.entitiesRepo.findOrCreateEntity("material", "찬자료");
    await addEvidenceNode(empty.id, "이 자료의 주제는 그래프 이론이다.");
    // material 렌즈 유일 칸(주제)을 filled 는 미리 채운다 → 후보에서 빠진다.
    store.entitiesRepo.setAttribute(filled.id, "주제", "이미 채움", true);

    const seen: string[] = [];
    const capture = fixtureInfer((input) => {
      for (const e of input.entities) seen.push(e.entityId);
      return [];
    });
    await runLensDraftCycle(cycleDeps({ infer: capture.fn }));
    expect(seen).toContain(empty.id);
    expect(seen).not.toContain(filled.id);
  });

  test("LLM 미가용(infer=null)이면 no-op(후보 0, 제안 0)", async () => {
    const ent = await store.entitiesRepo.findOrCreateEntity("material", "자료");
    await addEvidenceNode(ent.id, "내용");
    const summary = await runLensDraftCycle(cycleDeps({ infer: null }));
    expect(summary.candidatesFound).toBe(0);
    expect(listLensDraftProposals()).toHaveLength(0);
  });

  test("선호(memory_type='preference') 근거 노드가 달려도 엔티티는 그대로 후보(spec H 후반 — lensDraft 대상은 entity 이지 knowledge_nodes 가 아니다)", async () => {
    // entities 테이블은 entity_id 독립 PK 라 knowledge_nodes.memory_type 과
    // 무관하다 — 근거 노드가 선호든 사실이든 그 엔티티가 빈 칸을 갖고 있으면
    // 후보에 그대로 잡혀야 정상(선호 배제는 knowledge_nodes 원문 후보 검출
    // 쪽 candidate-query.ts/summary-candidate-query.ts 의 몫).
    const ent = await store.entitiesRepo.findOrCreateEntity("material", "선호근거자료");
    await addEvidenceNodeWithMemoryType(ent.id, "이 자료의 주제는 선호에서 나왔다.", "preference");

    const seen: string[] = [];
    const capture = fixtureInfer((input) => {
      for (const e of input.entities) seen.push(e.entityId);
      return [];
    });
    await runLensDraftCycle(cycleDeps({ infer: capture.fn }));
    expect(seen).toContain(ent.id);
  });
});

describe("유효 초안 → 제안(자동 적용 0)", () => {
  test("유효 초안은 엔티티를 안 고치고 cleanup_proposals 로만 남는다 + fingerprint guard 동반", async () => {
    const ent = await store.entitiesRepo.findOrCreateEntity("material", "그래프자료");
    await addEvidenceNode(ent.id, "이 자료의 주제는 그래프 이론이다.");

    let filledKey = "";
    const infer = fixtureInfer((input) => {
      const target = input.entities.find((e) => e.entityId === ent.id)!;
      filledKey = target.emptyColumnKeys[0]!;
      return [
        {
          typeName: "material",
          entityId: ent.id,
          values: {
            columns: { [filledKey]: "그래프 이론" },
            labels: {},
            relations: {},
            metadata: {},
          },
        },
      ];
    });
    const summary = await runLensDraftCycle(cycleDeps({ infer: infer.fn }));

    expect(summary.proposalsInserted).toBe(1);
    // 자동 적용 0 — 엔티티 칸은 그대로 비어 있다.
    const cols = store.entitiesRepo.listAttributes(ent.id).filter((a) => a.isColumn);
    expect(cols.find((c) => c.key === filledKey)).toBeUndefined();

    const proposals = listLensDraftProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.status).toBe("pending");
    expect(proposals[0]!.payload.entityId).toBe(ent.id);
    // fingerprint guard 동반(오래된 초안 방어 seam).
    const guard = proposals[0]!.payload.fingerprintGuard as Record<string, unknown>;
    expect(typeof guard.expectedFingerprint).toBe("string");
    expect(typeof guard.lensSerialization).toBe("string");
    expect(Array.isArray(guard.evidenceNodeIds)).toBe(true);

    // 원장 completed 기록.
    const led = getStageResult(db, "lens_draft", targetKeyOf("material", ent.id));
    expect(led?.status).toBe("completed");
  });
});

describe("멱등", () => {
  test("kind=lens_draft 제안이 있는 엔티티는 다시 후보로 안 나온다", async () => {
    const ent = await store.entitiesRepo.findOrCreateEntity("material", "자료");
    await addEvidenceNode(ent.id, "주제는 그래프.");
    const infer = fixtureInfer((input) => {
      const t = input.entities.find((e) => e.entityId === ent.id);
      if (!t) return [];
      return [
        {
          typeName: "material",
          entityId: ent.id,
          values: {
            columns: { [t.emptyColumnKeys[0]!]: "그래프" },
            labels: {},
            relations: {},
            metadata: {},
          },
        },
      ];
    });
    await runLensDraftCycle(cycleDeps({ infer: infer.fn }));
    expect(listLensDraftProposals()).toHaveLength(1);

    // 두 번째 사이클 — 이미 pending 제안이 있어 후보 0.
    const seen: string[] = [];
    const capture = fixtureInfer((input) => {
      for (const e of input.entities) seen.push(e.entityId);
      return [];
    });
    const summary2 = await runLensDraftCycle(cycleDeps({ infer: capture.fn }));
    expect(summary2.candidatesFound).toBe(0);
    expect(seen).not.toContain(ent.id);
  });

  test("결과 원장 completed 는 같은 fingerprint 엔티티 재검출을 막는다", async () => {
    const ent = await store.entitiesRepo.findOrCreateEntity("material", "자료");
    await addEvidenceNode(ent.id, "주제는 그래프.");
    // 첫 사이클: 빈 초안(채울 값 0) → completed_noop 로 원장 기록(제안 0).
    const noop = fixtureInfer((input) =>
      input.entities.map((e) => ({
        typeName: "material",
        entityId: e.entityId,
        values: { columns: {}, labels: {}, relations: {}, metadata: {} },
      })),
    );
    const s1 = await runLensDraftCycle(cycleDeps({ infer: noop.fn }));
    expect(s1.completedNoop).toBe(1);
    expect(listLensDraftProposals()).toHaveLength(0);

    // 둘째 사이클: fingerprint·stageVersion 그대로 → 원장이 재검출 차단(후보 0).
    const s2 = await runLensDraftCycle(cycleDeps({ infer: noop.fn }));
    expect(s2.candidatesFound).toBe(0);
  });
});

describe("사전 필터 — 렌즈 밖 키 초안은 제안이 안 된다(자동 적용 0)", () => {
  test("렌즈에 없는 column 키 초안은 결정적 실패로 원장 기록 + 제안 0", async () => {
    const ent = await store.entitiesRepo.findOrCreateEntity("material", "자료");
    await addEvidenceNode(ent.id, "내용");
    const infer = fixtureInfer(() => [
      {
        typeName: "material",
        entityId: ent.id,
        values: {
          columns: { 없는칸_xyz: "값" },
          labels: {},
          relations: {},
          metadata: {},
        },
      },
    ]);
    const summary = await runLensDraftCycle(cycleDeps({ infer: infer.fn }));
    expect(summary.rejectedInvalid).toBe(1);
    expect(summary.proposalsInserted).toBe(0);
    expect(listLensDraftProposals()).toHaveLength(0);
    // 결정적 실패로 원장 기록(재과금 attempt 누적).
    const led = getStageResult(db, "lens_draft", targetKeyOf("material", ent.id));
    expect(led?.status === "retryable_failure" || led?.status === "terminal_failure").toBe(true);
    expect(led?.attemptCount).toBe(1);
  });
});

describe("approve 공유 함수 경유", () => {
  test("lens_draft approve = applyLensDraft 로 실제 엔티티에 적용된다", async () => {
    const ent = await store.entitiesRepo.findOrCreateEntity("material", "그래프자료");
    await addEvidenceNode(ent.id, "이 자료의 주제는 그래프 이론이다.");
    let filledKey = "";
    const infer = fixtureInfer((input) => {
      const t = input.entities.find((e) => e.entityId === ent.id)!;
      filledKey = t.emptyColumnKeys[0]!;
      return [
        {
          typeName: "material",
          entityId: ent.id,
          values: {
            columns: { [filledKey]: "그래프 이론" },
            labels: {},
            relations: {},
            metadata: {},
          },
        },
      ];
    });
    await runLensDraftCycle(cycleDeps({ infer: infer.fn }));
    const proposal = listLensDraftProposals()[0]!;

    // 검토 게이트 라우트를 세워 approve 를 실제로 태운다.
    const app = new Hono();
    registerEntityLensRoutes(app, deps);
    registerCleanupProposalsRoutes(app, deps);
    const res = await app.request(
      `/cleanup-proposals/${proposal.id}/approve`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);

    // 이제 엔티티 칸이 채워졌다(공유 적용 함수 경유).
    const cols = store.entitiesRepo.listAttributes(ent.id).filter((a) => a.isColumn);
    expect(cols.find((c) => c.key === filledKey)?.value).toBe("그래프 이론");
    // 제안은 applied 로 — lens_draft 는 항목별 적용 kind 라 전 항목이 들어가면 'applied'
    // 다(T32 상태 확장: 옛 단일 어휘 'approved' 는 추가형 kind 전용으로 남았다).
    expect(listLensDraftProposals()[0]!.status).toBe("applied");
  });

  test("초안 생성 뒤 엔티티가 바뀌면 approve 가 fingerprint 재대조로 거부(오래된 초안 방어)", async () => {
    const ent = await store.entitiesRepo.findOrCreateEntity("material", "그래프자료");
    await addEvidenceNode(ent.id, "이 자료의 주제는 그래프 이론이다.");
    let filledKey = "";
    const infer = fixtureInfer((input) => {
      const t = input.entities.find((e) => e.entityId === ent.id)!;
      filledKey = t.emptyColumnKeys[0]!;
      return [
        {
          typeName: "material",
          entityId: ent.id,
          values: {
            columns: { [filledKey]: "그래프 이론" },
            labels: {},
            relations: {},
            metadata: {},
          },
        },
      ];
    });
    await runLensDraftCycle(cycleDeps({ infer: infer.fn }));
    const proposal = listLensDraftProposals()[0]!;

    // 승인 전에 엔티티 구조화 값을 바꾼다(초안 시점 fingerprint 와 어긋나게) — 초안이
    // 채우려던 칸을 사용자가 먼저 다른 값으로 채웠다고 가정. serializeEntityStructuredValue
    // 가 이 칸을 읽으므로 fingerprint 가 달라진다.
    store.entitiesRepo.setAttribute(ent.id, filledKey, "사용자가 먼저 채운 값", true);

    const app = new Hono();
    registerEntityLensRoutes(app, deps);
    registerCleanupProposalsRoutes(app, deps);
    const res = await app.request(
      `/cleanup-proposals/${proposal.id}/approve`,
      { method: "POST" },
    );
    // fingerprint 재대조 실패 → 400(적용 거부) + 제안은 needs_revision.
    //
    // T32 상태 확장 전에는 pending 보존이었다. 이제 적용 시점 대조 실패는 "나중에 다시
    // 눌러보면 될 일" 이 아니라 종결 판정이다 — 대상이 이미 바뀌었으므로 같은 초안을 다시
    // 승인해도 영원히 같은 이유로 거부된다. AI 재작업이 필요하다는 뜻의 needs_revision 이
    // 정직한 상태다(pending 으로 두면 사용자가 재시도를 반복하게 만든다).
    expect(res.status).toBe(400);
    expect(listLensDraftProposals()[0]!.status).toBe("needs_revision");
    // 초안 값("그래프 이론")이 적용되지 않았다 — 사용자가 먼저 채운 값이 그대로 남는다.
    const cols = store.entitiesRepo.listAttributes(ent.id).filter((a) => a.isColumn);
    expect(cols.find((c) => c.key === filledKey)?.value).toBe("사용자가 먼저 채운 값");
  });
});
