/**
 * server-internal/routes/cleanup-candidates.test.ts — GET /api/cleanup-candidates
 * 후보 조회 REST 통합 검증 (MCP spec 6.1).
 *
 * 격리 양식: `buildMemoryApi` 우회 + `registerCleanupCandidatesRoutes` 직접 호출
 * (cleanup-proposals.test.ts 양식 정합). 실 :memory: SQLite + 실 SqliteMemoryStore +
 * 실 RegexL0Extractor(builtin 양식만) — mock 클래스 0.
 *
 * 검증 case (brief 그대로):
 *   (a) ?stage=regexStrengthen → 200 + 후보마다 targetKey·inputFingerprint·stageVersion.
 *   (b) stage 미지정/미지원(summary 포함) → 400 + 유효 값 목록.
 *   (c) limit default 20 / 상한 100 (parseLimit clamp).
 *   (d) 원장 completed 기록 후보 재회신 차단 (라우트 통과 확인 — 계약은 candidates.test.ts 권위).
 *   (e) regexL0 미주입 → 503 + extractor.regex.enabled.
 *   (f) 후보 0건 → 200 { count: 0, candidates: [] } (정직한 빈 결과).
 */

import { beforeAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { createEmbedder, embeddingDimensionOf } from "../../embedding/factory.ts";
import type { Embedder } from "../../embedding/types.ts";
import { RegexL0Extractor } from "../../memory/regex-l0/extractor.ts";
import type { MemoryApiDeps } from "../types.ts";
import { registerCleanupCandidatesRoutes } from "./cleanup-candidates.ts";
import { CLEANUP_STAGE_LLM_LIMITS } from "../../memory/cleanup-deep-pass/stage-constants.ts";
import { regexFingerprint } from "../../memory/cleanup-deep-pass/stage-fingerprint.ts";
import {
  getStageResult,
  recordStageSuccess,
} from "../../memory/cleanup-deep-pass/stage-results-ledger.ts";
import { entityTargetKey } from "../../memory/cleanup-deep-pass/lens-draft-candidate-query.ts";

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

function buildApp(regexL0?: RegexL0Extractor): Hono {
  const deps: MemoryApiDeps = {
    store,
    retriever: undefined as unknown as MemoryApiDeps["retriever"],
    assembler: undefined as unknown as MemoryApiDeps["assembler"],
    regexL0,
  };
  const app = new Hono({ strict: false });
  registerCleanupCandidatesRoutes(app, deps);
  return app;
}

/** auto_capture raw + llm_extract 자식(merged_into) 삽입 — candidates.test.ts fixture 재사용. */
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

// ── (a) 정상 회신 — 3열쇠 동봉 ───────────────────────────────────────────────

describe("GET /api/cleanup-candidates — regexStrengthen", () => {
  test("(a) ?stage=regexStrengthen → 200 + 후보마다 targetKey·inputFingerprint·stageVersion", async () => {
    const ext = makeExtractor();
    const n1 = insertRegexMissed("이거 진짜 몰랐어", "이거 진짜");
    const app = buildApp(ext);

    const res = await app.request("/api/cleanup-candidates?stage=regexStrengthen");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stage: string;
      stageVersion: number;
      count: number;
      candidates: Array<{ targetKey: string; inputFingerprint: string; stageVersion: number }>;
    };
    expect(body.stage).toBe("regexStrengthen");
    expect(body.stageVersion).toBe(CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion);
    expect(body.count).toBe(1);
    expect(body.candidates).toHaveLength(1);

    const c = body.candidates[0]!;
    expect(c.targetKey).toBe(String(n1));
    expect(c.inputFingerprint).toBe(regexFingerprint({ content: "이거 진짜 몰랐어" }));
    expect(c.stageVersion).toBe(CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion);
  });

  // ── (f) 후보 0건 — 정직한 빈 결과 ──────────────────────────────────────────

  test("(f) 후보 0건 → 200 { count: 0, candidates: [] } (503 아님)", async () => {
    const app = buildApp(makeExtractor());
    const res = await app.request("/api/cleanup-candidates?stage=regexStrengthen");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; candidates: unknown[] };
    expect(body.count).toBe(0);
    expect(body.candidates).toEqual([]);
  });

  // ── (d) 원장 completed 기록 후보 재회신 차단 ────────────────────────────────

  test("(d) 원장 completed 기록 후보는 재회신되지 않는다", async () => {
    const ext = makeExtractor();
    const nDone = insertRegexMissed("이거 진짜 몰랐어", "이거 진짜");
    insertRegexMissed("딱히 생각 안 해봤어", "생각 안 함");
    const fpDone = regexFingerprint({ content: "이거 진짜 몰랐어" });

    recordStageSuccess(db, {
      stage: "regex_strengthen",
      targetKey: String(nDone),
      inputFingerprint: fpDone,
      stageVersion: CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion,
      noop: false,
    });

    const app = buildApp(ext);
    const res = await app.request("/api/cleanup-candidates?stage=regexStrengthen");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: Array<{ targetKey: string }> };
    expect(body.candidates.map((c) => c.targetKey)).not.toContain(String(nDone));
  });

  // ── (c) limit default·상한 ─────────────────────────────────────────────────

  test("(c) limit 미지정 → default 20 이내로 clamp (parseLimit 위임 확인)", async () => {
    const ext = makeExtractor();
    for (let i = 0; i < 25; i++) {
      insertRegexMissed(`이거 진짜 몰랐어${i}`, `이거 진짜${i}`);
    }
    const app = buildApp(ext);
    const res = await app.request("/api/cleanup-candidates?stage=regexStrengthen");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(20);
  });

  test("(c2) limit=500 요청 → 상한 100 으로 clamp", async () => {
    const ext = makeExtractor();
    for (let i = 0; i < 5; i++) {
      insertRegexMissed(`이거 진짜 몰랐어${i}`, `이거 진짜${i}`);
    }
    const app = buildApp(ext);
    const res = await app.request("/api/cleanup-candidates?stage=regexStrengthen&limit=500");
    expect(res.status).toBe(200);
    // 실제 후보가 5건뿐이라 상한 자체는 간접 확인 — parseLimit 단위 테스트가 100 clamp 권위.
    // 여기서는 limit 파라미터가 라우트를 깨지 않고 통과함을 확인.
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(5);
  });

  // ── (e) regexL0 미주입 → 503 ────────────────────────────────────────────────

  test("(e) regexL0 미주입 → 503 + extractor.regex.enabled 메시지", async () => {
    const app = buildApp(undefined);
    const res = await app.request("/api/cleanup-candidates?stage=regexStrengthen");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("extractor.regex.enabled");
  });
});

// ── (b) stage 검증 ───────────────────────────────────────────────────────────

describe("GET /api/cleanup-candidates — stage 검증", () => {
  test("(b) stage 미지정 → 400 + 유효 값 목록", async () => {
    const app = buildApp(makeExtractor());
    const res = await app.request("/api/cleanup-candidates");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("regexStrengthen");
    expect(body.error).toContain("personLink");
    expect(body.error).toContain("lensDraft");
  });

  test("(b2) 미지원 stage(summary) → 400 + 유효 값 목록", async () => {
    const app = buildApp(makeExtractor());
    const res = await app.request("/api/cleanup-candidates?stage=summary");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("summary");
    expect(body.error).toContain("regexStrengthen");
    expect(body.error).toContain("personLink");
    expect(body.error).toContain("lensDraft");
  });

  test("(b3) metadata_fill → 400 (외부 stage 없음, D-3)", async () => {
    const app = buildApp(makeExtractor());
    const res = await app.request("/api/cleanup-candidates?stage=metadata_fill");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("metadata_fill");
  });

  test("(b4) 원장 stage 명(regex_strengthen, snake_case) → 400 (외부 stage 아님)", async () => {
    const app = buildApp(makeExtractor());
    const res = await app.request("/api/cleanup-candidates?stage=regex_strengthen");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("regex_strengthen");
  });
});

// ── personLink 갈래 (간단 통과 확인 — 상세 계약은 candidates.test.ts 권위) ─────

describe("GET /api/cleanup-candidates — personLink", () => {
  test("shared.people 동봉 + 200 회신", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    await store.addNode({
      content: "민수와 회의했다.",
      sourceType: "llm_extract",
      metadata: { personCandidates: ["민수"] },
    });

    const app = buildApp();
    const res = await app.request("/api/cleanup-candidates?stage=personLink");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stage: string;
      count: number;
      shared?: { people: Array<{ personId: string }> };
    };
    expect(body.stage).toBe("personLink");
    expect(body.count).toBe(1);
    expect(body.shared?.people.map((p) => p.personId)).toContain(minsu.personId);
  });
});

// ── nodeIds 쿼리 (Task 18 — 펫 "입력한 메모 바로 정리") ────────────────────

describe("GET /api/cleanup-candidates — nodeIds", () => {
  test("entityRegister + nodeIds=<id> → 그 메모만 + shared.instruction", async () => {
    await store.addNode({ content: "금목서를 키우고 있다", sourceType: "auto_capture" });
    const b = await store.addNode({ content: "보리밥 먹고 싶다", sourceType: "auto_capture" });
    const res = await buildApp().request(`/api/cleanup-candidates?stage=entityRegister&nodeIds=${b}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: Array<{ targetKey: string }>; shared: { instruction: string } };
    expect(body.candidates.map((c) => c.targetKey)).toEqual([String(b)]);
    expect(typeof body.shared.instruction).toBe("string");
  });

  test("숫자가 아닌 조각·0·빈 값 → 400", async () => {
    for (const q of ["1,x", "0", "", "1,,2", "-3", "1.5"]) {
      const res = await buildApp().request(`/api/cleanup-candidates?stage=entityRegister&nodeIds=${q}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("nodeIds");
    }
  });

  test("메모 단위가 아닌 단계(lensDraft) + nodeIds → 400", async () => {
    const res = await buildApp().request("/api/cleanup-candidates?stage=lensDraft&nodeIds=1");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("nodeIds");
  });
});

// ── POST /api/cleanup-candidates/no-finding — 무산출 신고 (spec 6.3·6.4) ──────

describe("POST /api/cleanup-candidates/no-finding", () => {
  function noFindingBody(nodeId: number, content: string) {
    return {
      stage: "regexStrengthen",
      targetKey: String(nodeId),
      inputFingerprint: regexFingerprint({ content }),
      stageVersion: CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion,
    };
  }

  test("(a) 유효 신고 → 200 recorded:true + status completed_noop + 원장 행 completed_noop", async () => {
    const content = "이거 진짜 몰랐어";
    const nodeId = insertRegexMissed(content, "이거 진짜");
    const app = buildApp(makeExtractor());

    const res = await app.request("/api/cleanup-candidates/no-finding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(noFindingBody(nodeId, content)),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recorded: boolean; status: string };
    expect(body.recorded).toBe(true);
    expect(body.status).toBe("completed_noop");

    const row = getStageResult(db, "regex_strengthen", String(nodeId));
    expect(row?.status).toBe("completed_noop");
  });

  test("(b) 신고 후 GET 조회에서 그 후보 재회신 차단", async () => {
    const content = "이거 진짜 몰랐어";
    const nodeId = insertRegexMissed(content, "이거 진짜");
    const app = buildApp(makeExtractor());

    const postRes = await app.request("/api/cleanup-candidates/no-finding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(noFindingBody(nodeId, content)),
    });
    expect(postRes.status).toBe(200);

    const getRes = await app.request("/api/cleanup-candidates?stage=regexStrengthen");
    const body = (await getRes.json()) as { candidates: Array<{ targetKey: string }> };
    expect(body.candidates.map((c) => c.targetKey)).not.toContain(String(nodeId));
  });

  test("(c) 노드 content 변경 후 신고 → 409 + current.inputFingerprint 동봉 + 그 후보는 GET 재등장", async () => {
    const originalContent = "이거 진짜 몰랐어";
    const nodeId = insertRegexMissed(originalContent, "이거 진짜");
    // 지문 재계산 재료가 바뀌도록 content 를 직접 갱신 — 신고 시점 fingerprint 는 stale.
    db.prepare("UPDATE knowledge_nodes SET content = ? WHERE id = ?").run(
      "완전히 다른 내용",
      nodeId,
    );
    const app = buildApp(makeExtractor());

    const res = await app.request("/api/cleanup-candidates/no-finding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(noFindingBody(nodeId, originalContent)),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      current?: { inputFingerprint: string; stageVersion: number };
    };
    expect(body.current?.inputFingerprint).toBe(
      regexFingerprint({ content: "완전히 다른 내용" }),
    );

    // 원장에 completed_noop 기록되지 않았으므로 GET 조회에서 그대로 재등장.
    const getRes = await app.request("/api/cleanup-candidates?stage=regexStrengthen");
    const getBody = (await getRes.json()) as { candidates: Array<{ targetKey: string }> };
    expect(getBody.candidates.map((c) => c.targetKey)).toContain(String(nodeId));
  });

  test("(d1) 4칸 중 하나 누락(stageVersion 없음) → 400", async () => {
    const content = "이거 진짜 몰랐어";
    const nodeId = insertRegexMissed(content, "이거 진짜");
    const app = buildApp(makeExtractor());

    const res = await app.request("/api/cleanup-candidates/no-finding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stage: "regexStrengthen",
        targetKey: String(nodeId),
        inputFingerprint: regexFingerprint({ content }),
        // stageVersion 누락.
      }),
    });
    expect(res.status).toBe(400);
  });

  test("(d2) 미지원 stage → 400", async () => {
    const app = buildApp(makeExtractor());
    const res = await app.request("/api/cleanup-candidates/no-finding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stage: "summary",
        targetKey: "1",
        inputFingerprint: "deadbeef",
        stageVersion: 1,
      }),
    });
    expect(res.status).toBe(400);
  });

  test("(d3) 대상 부재 targetKey → 404", async () => {
    const app = buildApp(makeExtractor());
    const res = await app.request("/api/cleanup-candidates/no-finding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stage: "regexStrengthen",
        targetKey: "999999",
        inputFingerprint: "deadbeef",
        stageVersion: CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion,
      }),
    });
    expect(res.status).toBe(404);
  });

  test("(d4) stageVersion 불일치 → 409 + current", async () => {
    const content = "이거 진짜 몰랐어";
    const nodeId = insertRegexMissed(content, "이거 진짜");
    const app = buildApp(makeExtractor());

    const res = await app.request("/api/cleanup-candidates/no-finding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stage: "regexStrengthen",
        targetKey: String(nodeId),
        inputFingerprint: regexFingerprint({ content }),
        stageVersion: CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion + 999,
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      current?: { inputFingerprint: string; stageVersion: number };
    };
    expect(body.current?.stageVersion).toBe(
      CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion,
    );
  });

  test("(d3-2) lensDraft 대상 부재(삭제된 엔티티) targetKey → 404 + 원장 미기록 (review Fix 1)", async () => {
    // parseEntityTargetKey + isPlacementType 통과만으로 진행하면(수정 전 버그) 존재하지
    // 않는 entityId 도 "빈 엔티티" 지문이 정상 계산돼 409(지문 불일치)로 오회신됐다.
    // 대상 확인 추가 후에는 대상 부재가 먼저 걸려 404 로 회신하고 원장에도 안 남는다.
    const app = buildApp(makeExtractor());
    const missingKey = entityTargetKey("material", "삭제된-엔티티-id");

    const res = await app.request("/api/cleanup-candidates/no-finding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stage: "lensDraft",
        targetKey: missingKey,
        inputFingerprint: "deadbeef",
        stageVersion: CLEANUP_STAGE_LLM_LIMITS.lens_draft.stageVersion,
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(missingKey);

    // 원장 미기록 — completed_noop 행이 남지 않는다(spec 6.2 "대상 부재 404 + 원장 기록 없음").
    const ledgerRow = getStageResult(db, "lens_draft", missingKey);
    expect(ledgerRow).toBeNull();
  });

  test("(멱등) 이미 completed_noop 인 같은 지문 재신고 → 200 (재신고 자체가 완료 상태 재확인)", async () => {
    const content = "이거 진짜 몰랐어";
    const nodeId = insertRegexMissed(content, "이거 진짜");
    const app = buildApp(makeExtractor());
    const body = noFindingBody(nodeId, content);

    const first = await app.request("/api/cleanup-candidates/no-finding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(200);

    const second = await app.request("/api/cleanup-candidates/no-finding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { recorded: boolean; status: string };
    expect(secondBody.recorded).toBe(true);
    expect(secondBody.status).toBe("completed_noop");
  });
});
