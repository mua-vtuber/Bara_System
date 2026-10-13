/**
 * cleanup-external/candidates.test.ts — 정리 외부 표면 공유층 검증 (Task 7).
 *
 * 실 :memory: SQLite + 실 SqliteMemoryStore + 실 RegexL0Extractor(builtin 양식만) 로 돈다
 * — mock 객체 0. 노드·사람은 store 메서드/raw SQL 로 실제 삽입한다(데이터 fixture 만).
 *
 * 이 파일은 regexStrengthen·personLink 갈래 + stage↔kind 대응 표 한정이다. lensDraft
 * 갈래는 실 store 구조화 상태가 필요해 T11 heavy 통합 테스트에서 검증한다.
 *
 * 검증:
 *   (a) externalStageContractOf 대응 + 미지원 문자열 null.
 *   (b) regexStrengthen 후보 회신(targetKey·inputFingerprint·content 3칸) + limit 준수.
 *   (c) regexL0 미주입 → CleanupExternalDisabledError(누락 식별자 메시지).
 *   (d) 원장 completed/completed_noop/terminal_failure 제외, retryable 은 next_retry_at
 *       경과 시에만 포함.
 *   (e) personLink shared.people 동봉 + 후보 content 5칸.
 *   (f) recomputeExternalFingerprint 재계산 일치 + 대상 부재 null.
 */

import { beforeAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { createEmbedder, embeddingDimensionOf } from "../../embedding/factory.ts";
import type { Embedder } from "../../embedding/types.ts";
import { RegexL0Extractor } from "../../memory/regex-l0/extractor.ts";
import { buildRegexStrengthenInstruction } from "../../memory/cleanup-deep-pass/regex-strengthen-cycle.ts";
import type { MemoryApiDeps } from "../types.ts";
import {
  externalStageContractOf,
  EXTERNAL_CANDIDATE_STAGES,
} from "./stage-map.ts";
import {
  CleanupExternalDisabledError,
  CleanupExternalInputError,
  listExternalCandidates,
  recomputeExternalFingerprint,
} from "./candidates.ts";
import { CLEANUP_STAGE_LLM_LIMITS } from "../../memory/cleanup-deep-pass/stage-constants.ts";
import { regexFingerprint } from "../../memory/cleanup-deep-pass/stage-fingerprint.ts";
import {
  recordStageSuccess,
  recordStageRetryable,
  recordStageTerminal,
} from "../../memory/cleanup-deep-pass/stage-results-ledger.ts";
import { nextRetryAt } from "../../memory/cleanup-deep-pass/stage-retry.ts";
import { personLinkFingerprint } from "../../memory/cleanup-deep-pass/stage-fingerprint.ts";
import { collectPersonLinkCandidates } from "../../memory/person-link-candidate-query.ts";
import { entityTargetKey } from "../../memory/cleanup-deep-pass/lens-draft-candidate-query.ts";
import { entityRegisterFingerprint } from "../../memory/cleanup-deep-pass/stage-fingerprint.ts";
import { entityRegisterTypeNames } from "../../memory/cleanup-deep-pass/entity-register/constants.ts";

const MODEL = "bge-m3";

let embedder: Embedder;
let db: Database;
let store: SqliteMemoryStore;

beforeAll(async () => {
  embedder = createEmbedder({ model: MODEL });
  await embedder.load();
});

beforeEach(() => {
  db = openMemoryDatabase(":memory:", {
    embeddingDim: embeddingDimensionOf(MODEL),
  });
  store = new SqliteMemoryStore(db, embedder);
});

afterEach(() => {
  db.close();
});

/** 실 builtin 양식만 가진 추출기(yaml·user 경로 0 — 결정적 정규식 세트). */
function makeExtractor(): RegexL0Extractor {
  return new RegexL0Extractor({ patternPaths: [], boosterPaths: [], langs: ["ko"] });
}

/** MemoryApiDeps 를 candidates.ts 가 만지는 최소 필드로 조립(store + 선택 regexL0). */
function makeDeps(regexL0?: RegexL0Extractor): MemoryApiDeps {
  return { store, regexL0 } as unknown as MemoryApiDeps;
}

/**
 * auto_capture raw + llm_extract 자식(merged_into) 삽입. candidate-query.test.ts fixture
 * 양식 재사용 — 실 정규식으로 0매치인 raw 만 regexStrengthen 후보가 된다.
 */
function insertRegexMissed(content: string, atomic: string): number {
  const rawInfo = db
    .prepare(
      "INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES (?, 'auto_capture', '2026-07-19 10:00:00')",
    )
    .run(content);
  const rawId = Number(rawInfo.lastInsertRowid);
  const childInfo = db
    .prepare(
      "INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES (?, 'llm_extract', '2026-07-19 10:00:01')",
    )
    .run(atomic);
  const childId = Number(childInfo.lastInsertRowid);
  db.prepare(
    "INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, source_node_id) VALUES (?, ?, 'merged_into', 'user_input', NULL)",
  ).run(childId, rawId);
  return rawId;
}

// ── (a) stage↔kind 대응 표 ──────────────────────────────────────────────────

describe("externalStageContractOf — stage↔kind 대응 표", () => {
  test("regexStrengthen → regex_pattern_add + stage-constants stageVersion 일치", () => {
    expect(externalStageContractOf("regexStrengthen")).toEqual({
      ledgerStage: "regex_strengthen",
      kind: "regex_pattern_add",
      stageVersion: CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion,
    });
  });

  test("personLink·lensDraft 도 표와 일치", () => {
    expect(externalStageContractOf("personLink")).toEqual({
      ledgerStage: "person_link",
      kind: "person_link",
      stageVersion: CLEANUP_STAGE_LLM_LIMITS.person_link.stageVersion,
    });
    expect(externalStageContractOf("lensDraft")).toEqual({
      ledgerStage: "lens_draft",
      kind: "lens_draft",
      stageVersion: CLEANUP_STAGE_LLM_LIMITS.lens_draft.stageVersion,
    });
  });

  test("미지원 문자열 → null (metadata_fill 외부 통로 없음은 T9 kind=400 이 검증)", () => {
    expect(externalStageContractOf("metadata_fill")).toBeNull();
    expect(externalStageContractOf("regex_strengthen")).toBeNull(); // 원장 stage 명은 외부 stage 아님
    expect(externalStageContractOf("nope")).toBeNull();
    // EXTERNAL_CANDIDATE_STAGES 는 전부 계약이 있다(대응 표 완전성).
    for (const s of EXTERNAL_CANDIDATE_STAGES) {
      expect(externalStageContractOf(s)).not.toBeNull();
    }
  });
});

// ── (b),(c),(d) regexStrengthen 갈래 ────────────────────────────────────────

describe("listExternalCandidates — regexStrengthen", () => {
  test("(b) 0매치 raw 가 targetKey·inputFingerprint·content 3칸으로 회신 + limit 준수", async () => {
    const ext = makeExtractor();
    // 정규식 0매치 예상(평범한 회상문).
    const n1 = insertRegexMissed("이거 진짜 몰랐어", "이거 진짜");
    insertRegexMissed("딱히 생각 안 해봤어", "생각 안 함");
    expect(ext.extract("이거 진짜 몰랐어").candidates.length).toBe(0);

    const list = await listExternalCandidates(makeDeps(ext), "regexStrengthen", 1);
    expect(list.stage).toBe("regexStrengthen");
    expect(list.stageVersion).toBe(CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion);
    expect(list.count).toBe(1); // limit 준수
    expect(list.candidates).toHaveLength(1);
    // 서버 원본 지시문(한 건 모양)을 후보마다 반복하지 않고 한 번 동봉한다 — 펫이 이 문장을 그대로 쓴다.
    expect(list.shared).toEqual({ instruction: buildRegexStrengthenInstruction("single") });

    const c = list.candidates[0]!;
    expect(c.targetKey).toBe(String(n1));
    expect(c.inputFingerprint).toBe(regexFingerprint({ content: "이거 진짜 몰랐어" }));
    expect(c.content).toEqual({ id: n1, content: "이거 진짜 몰랐어", atomics: ["이거 진짜"] });
  });

  test("(c) regexL0 미주입 → CleanupExternalDisabledError(누락 식별자 메시지)", async () => {
    let caught: unknown;
    try {
      await listExternalCandidates(makeDeps(undefined), "regexStrengthen", 10);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CleanupExternalDisabledError);
    expect((caught as Error).message).toContain("extractor.regex.enabled");
  });

  test("(d) 원장 completed/terminal 제외, retryable 은 next_retry_at 경과 시에만 포함", async () => {
    const ext = makeExtractor();
    const nDone = insertRegexMissed("이거 진짜 몰랐어", "이거 진짜");
    const nTerminal = insertRegexMissed("딱히 생각 안 해봤어", "생각 안 함");
    const nRetry = insertRegexMissed("그건 잘 모르겠어", "그건 모름");
    const fpDone = regexFingerprint({ content: "이거 진짜 몰랐어" });
    const fpTerminal = regexFingerprint({ content: "딱히 생각 안 해봤어" });
    const fpRetry = regexFingerprint({ content: "그건 잘 모르겠어" });
    const version = CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion;

    // completed·terminal 은 늘 제외. retryable 은 미래 next_retry_at 이라 아직 제외.
    recordStageSuccess(db, {
      stage: "regex_strengthen",
      targetKey: String(nDone),
      inputFingerprint: fpDone,
      stageVersion: version,
      noop: false,
    });
    recordStageTerminal(db, {
      stage: "regex_strengthen",
      targetKey: String(nTerminal),
      inputFingerprint: fpTerminal,
      stageVersion: version,
      lastError: "max_tokens 잘림",
    });
    recordStageRetryable(db, {
      stage: "regex_strengthen",
      targetKey: String(nRetry),
      inputFingerprint: fpRetry,
      stageVersion: version,
      nextRetryAt: nextRetryAt(3_600_000, 3_600_000), // 1시간 뒤 — 아직 미경과
      lastError: "429",
    });

    const still = await listExternalCandidates(makeDeps(ext), "regexStrengthen", 10);
    expect(still.candidates.map((c) => c.targetKey)).toEqual([]); // 셋 다 제외

    // retryable 을 과거 next_retry_at 으로 갱신(경과) → 그 노드만 재등장.
    recordStageRetryable(db, {
      stage: "regex_strengthen",
      targetKey: String(nRetry),
      inputFingerprint: fpRetry,
      stageVersion: version,
      nextRetryAt: "2000-01-01 00:00:00", // 이미 지난 시각
      lastError: "429",
    });
    const after = await listExternalCandidates(makeDeps(ext), "regexStrengthen", 10);
    expect(after.candidates.map((c) => c.targetKey)).toEqual([String(nRetry)]);
  });
});

// ── (e) personLink 갈래 ─────────────────────────────────────────────────────

describe("listExternalCandidates — personLink", () => {
  test("(e) shared.people 동봉 + 후보 content 5칸", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const nodeId = await store.addNode({
      content: "민수와 회의했다.",
      sourceType: "llm_extract",
      metadata: { personCandidates: ["민수"] },
    });

    const list = await listExternalCandidates(makeDeps(), "personLink", 10);
    expect(list.stage).toBe("personLink");
    expect(list.count).toBe(1);
    // shared.people = 내부 LLM 프롬프트 사람 명단(loadPeople 산출)을 응답에 한 번 동봉.
    expect(list.shared).toBeDefined();
    const people = (list.shared as { people: Array<{ personId: string }> }).people;
    expect(people.map((p) => p.personId)).toContain(minsu.personId);

    const c = list.candidates[0]!;
    expect(c.targetKey).toBe(String(nodeId));
    // content 5칸 — nodeId·content·personCandidates·existingPersonIds·topKPersonIds.
    expect(c.content).toEqual({
      nodeId,
      content: "민수와 회의했다.",
      personCandidates: ["민수"],
      existingPersonIds: [],
      topKPersonIds: [minsu.personId],
    });
    expect(c.inputFingerprint).toBe(
      personLinkFingerprint({
        content: "민수와 회의했다.",
        personCandidates: ["민수"],
        topKPersonIds: [minsu.personId],
      }),
    );
  });

  test("사람 0명 → 후보 0 + shared.people 빈 배열", async () => {
    await store.addNode({
      content: "디롱이는 봇 캐릭터다.",
      sourceType: "llm_extract",
      metadata: { personCandidates: ["디롱이"] },
    });
    const list = await listExternalCandidates(makeDeps(), "personLink", 10);
    expect(list.count).toBe(0);
    expect(list.candidates).toEqual([]);
    expect((list.shared as { people: unknown[] }).people).toEqual([]);
  });
});

// ── (f) recomputeExternalFingerprint ────────────────────────────────────────

describe("recomputeExternalFingerprint", () => {
  test("(f) regexStrengthen 재계산이 노드 content 지문과 일치, 부재 targetKey → null", async () => {
    const ext = makeExtractor();
    const n1 = insertRegexMissed("이거 진짜 몰랐어", "이거 진짜");

    const fp = await recomputeExternalFingerprint(makeDeps(ext), "regexStrengthen", String(n1));
    expect(fp).toBe(regexFingerprint({ content: "이거 진짜 몰랐어" }));

    // 없는 노드 → null(호출부가 404 매핑).
    const missing = await recomputeExternalFingerprint(makeDeps(ext), "regexStrengthen", "999999");
    expect(missing).toBeNull();
  });

  test("(f) personLink 재계산이 collectPersonLinkCandidates 산출 지문과 일치", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const nodeId = await store.addNode({
      content: "민수와 회의했다.",
      sourceType: "llm_extract",
      metadata: { personCandidates: ["민수"] },
    });

    const { rows } = await collectPersonLinkCandidates({
      db: store.getRawDb(),
      store,
      batchSize: 20,
      stageVersion: CLEANUP_STAGE_LLM_LIMITS.person_link.stageVersion,
    });
    const collected = rows.find((r) => r.id === nodeId)!;

    const fp = await recomputeExternalFingerprint(makeDeps(), "personLink", String(nodeId));
    expect(fp).toBe(collected.inputFingerprint);
    // 사람이 있으니 지문은 topK(민수) 를 반영한다.
    expect(fp).toBe(
      personLinkFingerprint({
        content: "민수와 회의했다.",
        personCandidates: ["민수"],
        topKPersonIds: [minsu.personId],
      }),
    );

    // 없는 노드 → null.
    expect(await recomputeExternalFingerprint(makeDeps(), "personLink", "999999")).toBeNull();
  });

  test("(f) lensDraft — 대상 엔티티 부재 targetKey → null (review Fix 1)", async () => {
    // parseEntityTargetKey + isPlacementType 은 형식만 검사한다("material" 은 배치
    // 가능 종류) — entityId 가 실제 entities 행을 가리키는지는 별도 확인이 필요하다.
    // 존재하지 않는 entityId 로 만든 targetKey 가 재계산에서 null 로 떨어지는지
    // 검증한다(호출부 submitExternalProposal·reportExternalNoFinding 이 404 로 매핑).
    const missingKey = entityTargetKey("material", "존재하지-않는-엔티티-id");
    const fp = await recomputeExternalFingerprint(makeDeps(), "lensDraft", missingKey);
    expect(fp).toBeNull();
  });

  test("(f) lensDraft — 존재하는 엔티티는 재계산 지문이 null 이 아니다(회귀 방지)", async () => {
    const ent = await store.entitiesRepo.findOrCreateEntity("material", "그래프 이론");
    const key = entityTargetKey("material", ent.id);
    const fp = await recomputeExternalFingerprint(makeDeps(), "lensDraft", key);
    expect(fp).not.toBeNull();
  });
});

// ── entityRegister 갈래 + nodeIds (Task 18) ─────────────────────────────────

describe("listExternalCandidates — entityRegister·nodeIds", () => {
  test("entityRegister 대응 표 = entity_register 원장·제안 종류 + stage-constants stageVersion", () => {
    expect(externalStageContractOf("entityRegister")).toEqual({
      ledgerStage: "entity_register",
      kind: "entity_register",
      stageVersion: CLEANUP_STAGE_LLM_LIMITS.entity_register.stageVersion,
    });
  });

  test("entityRegister 후보 content 에 nodeId·content·createdAt·alreadyLinked·allowedTypes, shared 에 지시문", async () => {
    const nodeId = await store.addNode({ content: "금목서를 키우고 있다", sourceType: "auto_capture" });
    const createdAt = (db.query("SELECT created_at FROM knowledge_nodes WHERE id = ?").get(nodeId) as { created_at: string }).created_at;
    const list = await listExternalCandidates(makeDeps(), "entityRegister", 10);
    expect(list.count).toBe(1);
    const c = list.candidates[0]!;
    expect(c.targetKey).toBe(String(nodeId));
    expect(c.inputFingerprint).toBe(entityRegisterFingerprint({ content: "금목서를 키우고 있다", createdAt }));
    expect(c.content).toEqual({
      nodeId,
      content: "금목서를 키우고 있다",
      createdAt,
      alreadyLinked: [],
      allowedTypes: entityRegisterTypeNames(),
    });
    expect(typeof (list.shared as { instruction: unknown }).instruction).toBe("string");
    expect(await recomputeExternalFingerprint(makeDeps(), "entityRegister", String(nodeId))).toBe(c.inputFingerprint);
    expect(await recomputeExternalFingerprint(makeDeps(), "entityRegister", "999999")).toBeNull();
  });

  test("nodeIds 를 주면 그 메모만 나온다(entityRegister)", async () => {
    const a = await store.addNode({ content: "금목서를 키우고 있다", sourceType: "auto_capture" });
    const b = await store.addNode({ content: "보리밥 먹고 싶다", sourceType: "auto_capture" });
    const list = await listExternalCandidates(makeDeps(), "entityRegister", 10, [b]);
    expect(list.candidates.map((c) => c.targetKey)).toEqual([String(b)]);
    expect(list.candidates.map((c) => c.targetKey)).not.toContain(String(a));
  });

  test("nodeIds 가 limit 보다 많아도 잘라 내지 않는다(entityRegister·personLink)", async () => {
    const a = await store.addNode({ content: "금목서를 키우고 있다", sourceType: "auto_capture" });
    const b = await store.addNode({ content: "보리밥 먹고 싶다", sourceType: "auto_capture" });
    const er = await listExternalCandidates(makeDeps(), "entityRegister", 1, [a, b]);
    expect(er.candidates.map((c) => c.targetKey)).toEqual([String(a), String(b)]);

    await store.findOrCreatePersonByName("민수");
    const p1 = await store.addNode({ content: "민수와 회의했다.", sourceType: "llm_extract", metadata: { personCandidates: ["민수"] } });
    const p2 = await store.addNode({ content: "민수와 밥을 먹었다.", sourceType: "llm_extract", metadata: { personCandidates: ["민수"] } });
    const pl = await listExternalCandidates(makeDeps(), "personLink", 1, [p1, p2]);
    expect(pl.candidates.map((c) => c.targetKey).sort()).toEqual([String(p1), String(p2)].sort());
  });

  test("personLink 에도 nodeIds 가 먹는다", async () => {
    await store.findOrCreatePersonByName("민수");
    await store.addNode({ content: "민수와 회의했다.", sourceType: "llm_extract", metadata: { personCandidates: ["민수"] } });
    const b = await store.addNode({ content: "민수와 밥을 먹었다.", sourceType: "llm_extract", metadata: { personCandidates: ["민수"] } });
    const list = await listExternalCandidates(makeDeps(), "personLink", 10, [b]);
    expect(list.candidates.map((c) => c.targetKey)).toEqual([String(b)]);
  });

  test("메모 단위가 아닌 단계에 nodeIds 를 주면 CleanupExternalInputError", async () => {
    await expect(listExternalCandidates(makeDeps(makeExtractor()), "regexStrengthen", 10, [1])).rejects.toBeInstanceOf(CleanupExternalInputError);
    await expect(listExternalCandidates(makeDeps(), "lensDraft", 10, [1])).rejects.toThrow("nodeIds");
  });
});
