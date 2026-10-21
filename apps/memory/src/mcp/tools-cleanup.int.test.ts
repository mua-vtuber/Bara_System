/**
 * mcp/tools-cleanup.int.test.ts — 정리 도구 4종 통합 검증 (MCP plan T11).
 *
 * 실 bge-m3 + 실 SqliteMemoryStore + Bun.serve + SDK StreamableHTTPClientTransport
 * (tools-capture.int.test.ts T6 harness 재사용). REST 3표면과 같은 공유 함수
 * (listExternalCandidates / submitExternalProposal / reportExternalNoFinding)를 도구가
 * 재노출하므로, 상세 계약은 cleanup-candidates.test.ts·cleanup-proposals.test.ts 권위이고
 * 여기서는 도구 표면(도구 결과 JSON·isError·409 current 동봉)과 교차 검증(등록 후 재조회
 * 차단)에 초점을 둔다. lensDraft 갈래(content 7칸)는 T7 에서 미룬 검증을 여기서 한다.
 *
 * cleanup_run_status 는 두 harness 를 쓴다:
 *   - deps.cleanupRuns 미주입 harness → isError + "cleanup run API 비활성" 문구.
 *   - ledger fixture 주입 harness(CleanupRunsRouteDeps 객체 리터럴 — ledger.getRun 만 실
 *     CleanupRunsLedger, 나머지는 이 도구가 안 부르는 데이터형 stub) → run 행 JSON 회신.
 *
 * (f) 실 조립 배선 — createMemoryApi 실 app 을 Bun.serve 로 띄우고 SDK 로 tools/list 12종
 *     확인. buildMemoryApi 안 registerMcpRoutes 마운트 1줄이 빠지면 이 케이스만 깨진다.
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { RegexL0Extractor } from "../memory/regex-l0/extractor.ts";
import { SseTokenStore } from "../federation/sse-tokens.ts";
import { createAuthGate } from "../server-internal/auth-gate.ts";
import type { MemoryApiDeps } from "../server-internal/types.ts";
import type { CleanupRunsRouteDeps } from "../server-internal/routes/cleanup-runs.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";
import type { MemorySettings } from "../settings/memory-settings.ts";
import { CleanupRunsLedger } from "../memory/cleanup-deep-pass/cleanup-runs-ledger.ts";
import { CLEANUP_STAGE_LLM_LIMITS } from "../memory/cleanup-deep-pass/stage-constants.ts";
import { regexFingerprint } from "../memory/cleanup-deep-pass/stage-fingerprint.ts";
import { getStageResult } from "../memory/cleanup-deep-pass/stage-results-ledger.ts";
import { entityTargetKey } from "../memory/cleanup-deep-pass/lens-draft-candidate-query.ts";
import { registerMcpRoutes } from "./server.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let tmpDir: string;
let db: Database;
let store: SqliteMemoryStore;
let deps: MemoryApiDeps;
let server: ReturnType<typeof Bun.serve>;
let client: Client;

/** builtin 양식만 가진 실 추출기(yaml·user 경로 0 — 결정적 정규식 세트). */
function makeExtractor(): RegexL0Extractor {
  return new RegexL0Extractor({ patternPaths: [], boosterPaths: [], langs: ["ko"] });
}

/**
 * regexStrengthen 후보 씨앗 — auto_capture raw + llm_extract 자식(merged_into).
 * cleanup-candidates.test.ts insertRegexMissed 와 동형.
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

/**
 * lensDraft 후보 씨앗 — material 엔티티(주제 칸을 광고하는 렌즈) 하나 + 근거 노드.
 * 빈 칸이 하나 이상이면 detectLensDraftCandidates 가 후보로 잡는다(lens-draft-cycle.test.ts
 * addEvidenceNode 와 동형). entityId 회신.
 */
async function seedLensDraftEntity(name: string): Promise<string> {
  const ent = await store.entitiesRepo.findOrCreateEntity("material", name);
  const nodeId = await store.addNode({
    content: "이 자료의 주제는 그래프 이론이다.",
    sourceType: "llm_extract",
  });
  const conceptId = await store.findOrCreateTagConcept(`근거_${nodeId}`);
  db.prepare(
    `INSERT INTO entity_concept_edges
       (entity_id, concept_id, role, provenance, source_node_id, created_at)
     VALUES (?, ?, 'has_attribute', 'evolver', ?, datetime('now','localtime'))`,
  ).run(ent.id, conceptId, nodeId);
  return ent.id;
}

/** 인증 게이트를 태워 Bun.serve + SDK 클라이언트를 연결한다(공통 harness). */
async function connectClient(inner: Hono): Promise<void> {
  const sseTokens = new SseTokenStore(join(tmpDir, "tokens.json"));
  const token = sseTokens.issueToken("claude-code");
  const outer = new Hono({ strict: false });
  outer.use(
    "*",
    createAuthGate({
      sseTokens,
      remoteAddrOf: () => "127.0.0.1",
      getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
    }),
  );
  outer.route("/", inner);
  server = Bun.serve({ port: 0, fetch: outer.fetch });

  const mcpUrl = new URL(`http://127.0.0.1:${server.port}/mcp`);
  client = new Client({ name: "test-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bara-mcp-cleanup-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  deps = {
    store,
    retriever: undefined as unknown as MemoryApiDeps["retriever"],
    assembler: undefined as unknown as MemoryApiDeps["assembler"],
    regexL0: makeExtractor(),
    getSettings: () => structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings,
  };
});

afterEach(async () => {
  await client.close();
  server.stop(true);
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function toolResultJson(res: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = res.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text);
}

function toolResultText(res: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = res.content as Array<{ type: string; text: string }>;
  return content[0]!.text;
}

/** deps.cleanupRuns 를 뺀 harness(직접 마운트) — 도구 4종 + run_status(비활성) 검증용. */
async function connectNoRuns(): Promise<void> {
  const inner = new Hono({ strict: false });
  registerMcpRoutes(inner, deps);
  await connectClient(inner);
}

// ── (a) cleanup_list_candidates ─────────────────────────────────────────────

test("(a) cleanup_list_candidates regexStrengthen → REST GET 과 같은 3열쇠 동봉", async () => {
  const n1 = insertRegexMissed("이거 진짜 몰랐어", "이거 진짜");
  await connectNoRuns();

  const res = await client.callTool({
    name: "cleanup_list_candidates",
    arguments: { stage: "regexStrengthen" },
  });
  expect(res.isError).not.toBe(true);
  const body = toolResultJson(res);
  expect(body.stage).toBe("regexStrengthen");
  expect(body.stageVersion).toBe(CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion);
  expect(body.count).toBe(1);
  const c = body.candidates[0];
  expect(c.targetKey).toBe(String(n1));
  expect(c.inputFingerprint).toBe(regexFingerprint({ content: "이거 진짜 몰랐어" }));
  expect(c.stageVersion).toBe(CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion);
});

test("(a2) cleanup_list_candidates lensDraft → content 7칸(T7 미룬 갈래)", async () => {
  const entityId = await seedLensDraftEntity("빈자료");
  await connectNoRuns();

  const res = await client.callTool({
    name: "cleanup_list_candidates",
    arguments: { stage: "lensDraft" },
  });
  expect(res.isError).not.toBe(true);
  const body = toolResultJson(res);
  expect(body.stage).toBe("lensDraft");
  expect(body.count).toBe(1);
  const c = body.candidates[0];
  // 3열쇠.
  expect(c.targetKey).toBe(entityTargetKey("material", entityId));
  expect(typeof c.inputFingerprint).toBe("string");
  expect(c.stageVersion).toBe(CLEANUP_STAGE_LLM_LIMITS.lens_draft.stageVersion);
  // content 7칸(candidates.ts lensDraft 계약).
  const keys = Object.keys(c.content).sort();
  expect(keys).toEqual(
    [
      "emptyColumnKeys",
      "entityId",
      "evidenceNodeIds",
      "filledColumns",
      "lens",
      "name",
      "typeName",
    ].sort(),
  );
  expect(c.content.typeName).toBe("material");
  expect(c.content.entityId).toBe(entityId);
  expect(c.content.emptyColumnKeys).toContain("주제");
});

test("(a3) cleanup_list_candidates regexL0 미주입 → isError(비활성 사유)", async () => {
  deps.regexL0 = undefined;
  await connectNoRuns();

  const res = await client.callTool({
    name: "cleanup_list_candidates",
    arguments: { stage: "regexStrengthen" },
  });
  expect(res.isError).toBe(true);
  const body = toolResultJson(res) as { code: string; message: string };
  // T16 — regexL0 미배선은 고장이 아니라 꺼진 상태라 DISABLED (문구는 그대로).
  expect(body.code).toBe("DISABLED");
  expect(body.message).toContain("extractor.regex.enabled");
});

/**
 * "이거 진짜 몰랐어" 후보에 맞는 서버 하네스 통과 payload(sourceNodeId 제외). 첫 캡처가 "이거 진짜"를
 * 잡고, 과매치 표본(추출 자식 "이거 진짜")은 "몰랐어"가 없어 매치 0 이다.
 */
const REGEX_PAYLOAD = {
  pattern: "(.+)\\s+몰랐어",
  score: 1,
  category: "fact",
  polarity: "neutral",
  exampleInput: "이거 진짜 몰랐어",
  exampleExtracted: "이거 진짜",
  description: "~를 몰랐다는 사실",
};

// ── (b) cleanup_submit_proposal ──────────────────────────────────────────────

test("(b) cleanup_submit_proposal 성공 → pending + ledgerRecorded + DB 제안·원장", async () => {
  const nodeId = insertRegexMissed("이거 진짜 몰랐어", "이거 진짜");
  const inputFingerprint = regexFingerprint({ content: "이거 진짜 몰랐어" });
  await connectNoRuns();

  const res = await client.callTool({
    name: "cleanup_submit_proposal",
    arguments: {
      kind: "regex_pattern_add",
      payload: {
        ...REGEX_PAYLOAD,
        sourceNodeId: nodeId,
      },
      candidate: {
        stage: "regexStrengthen",
        targetKey: String(nodeId),
        inputFingerprint,
        stageVersion: CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion,
      },
    },
  });
  expect(res.isError).not.toBe(true);
  const body = toolResultJson(res);
  expect(typeof body.proposalId).toBe("string");
  expect(body.proposalId.startsWith("cp_")).toBe(true);
  expect(body.status).toBe("pending");
  expect(body.ledgerRecorded).toBe(true);

  // DB 에 제안 행.
  const proposalRow = db
    .prepare("SELECT kind, status FROM cleanup_proposals WHERE id = ?")
    .get(body.proposalId) as { kind: string; status: string } | null;
  expect(proposalRow?.kind).toBe("regex_pattern_add");
  expect(proposalRow?.status).toBe("pending");
  // DB 에 원장 completed.
  const led = getStageResult(db, "regex_strengthen", String(nodeId));
  expect(led?.status).toBe("completed");
});

test("(b2) cleanup_submit_proposal 지문 불일치 → isError + 현행 fingerprint JSON 동봉", async () => {
  const nodeId = insertRegexMissed("이거 진짜 몰랐어", "이거 진짜");
  await connectNoRuns();

  const res = await client.callTool({
    name: "cleanup_submit_proposal",
    arguments: {
      kind: "regex_pattern_add",
      payload: {
        ...REGEX_PAYLOAD,
        sourceNodeId: nodeId,
      },
      candidate: {
        stage: "regexStrengthen",
        targetKey: String(nodeId),
        inputFingerprint: "deadbeef-stale",
        stageVersion: CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion,
      },
    },
  });
  expect(res.isError).toBe(true);
  // T8 구조화 — { code, message, details } JSON 봉투. current 는 details.current 로 동봉
  // (클라이언트 AI 재조회 유도 — spec 단락 8).
  const body = toolResultJson(res) as {
    code: string;
    message: string;
    details: { current: { inputFingerprint: string; stageVersion: number } };
  };
  expect(body.code).toBe("STALE_CANDIDATE");
  expect(body.message).toContain("inputFingerprint");
  expect(body.details.current.inputFingerprint).toBe(
    regexFingerprint({ content: "이거 진짜 몰랐어" }),
  );
  // 제안·원장 미기록(거절이라 부수효과 0).
  expect(getStageResult(db, "regex_strengthen", String(nodeId))).toBeNull();
});

// ── (c) cleanup_report_no_finding ────────────────────────────────────────────

test("(c) cleanup_report_no_finding 성공 → completed_noop + 재조회 차단(교차)", async () => {
  const content = "이거 진짜 몰랐어";
  const nodeId = insertRegexMissed(content, "이거 진짜");
  await connectNoRuns();

  const res = await client.callTool({
    name: "cleanup_report_no_finding",
    arguments: {
      stage: "regexStrengthen",
      targetKey: String(nodeId),
      inputFingerprint: regexFingerprint({ content }),
      stageVersion: CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion,
    },
  });
  expect(res.isError).not.toBe(true);
  const body = toolResultJson(res);
  expect(body.recorded).toBe(true);
  expect(body.status).toBe("completed_noop");

  // 교차 검증 — 같은 후보가 cleanup_list_candidates 재회신에서 걸러진다.
  const list = await client.callTool({
    name: "cleanup_list_candidates",
    arguments: { stage: "regexStrengthen" },
  });
  const listBody = toolResultJson(list);
  expect(listBody.candidates.map((c: { targetKey: string }) => c.targetKey)).not.toContain(
    String(nodeId),
  );
});

test("(b3) cleanup_submit_proposal 하네스 탈락 → status rejected + 사유 + 원장 completed_noop + 제안 0", async () => {
  const nodeId = insertRegexMissed("이거 진짜 몰랐어", "이거 진짜");
  const inputFingerprint = regexFingerprint({ content: "이거 진짜 몰랐어" });
  await connectNoRuns();

  const res = await client.callTool({
    name: "cleanup_submit_proposal",
    arguments: {
      kind: "regex_pattern_add",
      // 예문을 잡지 못하는 규칙 — 서버 하네스 자기예문 시험(self_match)에서 떨어진다.
      payload: { ...REGEX_PAYLOAD, pattern: "(.+)\\s+알았어", sourceNodeId: nodeId },
      candidate: {
        stage: "regexStrengthen",
        targetKey: String(nodeId),
        inputFingerprint,
        stageVersion: CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion,
      },
    },
  });
  expect(res.isError).not.toBe(true);
  expect(toolResultJson(res)).toEqual({
    proposalId: null,
    status: "rejected",
    ledgerRecorded: true,
    rejected: { reason: "self_match", detail: "예문 매치 0" },
  });
  const count = db.prepare("SELECT COUNT(*) AS n FROM cleanup_proposals").get() as { n: number };
  expect(count.n).toBe(0);
  expect(getStageResult(db, "regex_strengthen", String(nodeId))?.status).toBe("completed_noop");
});

// ── 이월 e2e — 등록 성공 후 같은 후보 재조회 차단(T9 리뷰 ⚠️) ──────────────────

test("(e2e) submit 성공 후 같은 후보가 list 재회신에서 걸러진다(교차)", async () => {
  const nodeId = insertRegexMissed("이거 진짜 몰랐어", "이거 진짜");
  const inputFingerprint = regexFingerprint({ content: "이거 진짜 몰랐어" });
  await connectNoRuns();

  const submit = await client.callTool({
    name: "cleanup_submit_proposal",
    arguments: {
      kind: "regex_pattern_add",
      payload: { ...REGEX_PAYLOAD, sourceNodeId: nodeId },
      candidate: {
        stage: "regexStrengthen",
        targetKey: String(nodeId),
        inputFingerprint,
        stageVersion: CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion,
      },
    },
  });
  expect(submit.isError).not.toBe(true);

  const list = await client.callTool({
    name: "cleanup_list_candidates",
    arguments: { stage: "regexStrengthen" },
  });
  const listBody = toolResultJson(list);
  expect(listBody.candidates.map((c: { targetKey: string }) => c.targetKey)).not.toContain(
    String(nodeId),
  );
});

// ── 예외 경로 — 공유 함수가 예상 밖 예외를 던져도 SDK 프로토콜 오류로 새지 않는다 ──
// 정상 검증 실패는 outcome 갈래(400/404/409)로 회신되므로, 여기서는 공유 함수 내부의
// DB 조회가 실제로 throw 하는 상황을 실 DB 로 만든다(mock 0): recomputeExternalFingerprint
// 가 SELECT ... FROM knowledge_nodes 를 부르므로, 테이블을 떨어뜨리면 실 SqliteError 가 난다.

test("(예외) cleanup_submit_proposal 공유 함수 throw → isError + 원인 문구(프로토콜 오류 아님)", async () => {
  const nodeId = insertRegexMissed("이거 진짜 몰랐어", "이거 진짜");
  const inputFingerprint = regexFingerprint({ content: "이거 진짜 몰랐어" });
  await connectNoRuns();
  // 지문 재계산 SELECT 대상 테이블을 제거 — 공유 함수 내부에서 실 DB 예외가 난다.
  db.exec("DROP TABLE knowledge_nodes");

  const res = await client.callTool({
    name: "cleanup_submit_proposal",
    arguments: {
      kind: "regex_pattern_add",
      payload: { ...REGEX_PAYLOAD, sourceNodeId: nodeId },
      candidate: {
        stage: "regexStrengthen",
        targetKey: String(nodeId),
        inputFingerprint,
        stageVersion: CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion,
      },
    },
  });
  expect(res.isError).toBe(true);
  const body = toolResultJson(res) as { code: string; message: string };
  expect(body.code).toBe("INTERNAL");
  expect(body.message).toContain("제안 등록 실패");
});

test("(예외) cleanup_report_no_finding 공유 함수 throw → isError + 원인 문구(프로토콜 오류 아님)", async () => {
  const content = "이거 진짜 몰랐어";
  const nodeId = insertRegexMissed(content, "이거 진짜");
  await connectNoRuns();
  db.exec("DROP TABLE knowledge_nodes");

  const res = await client.callTool({
    name: "cleanup_report_no_finding",
    arguments: {
      stage: "regexStrengthen",
      targetKey: String(nodeId),
      inputFingerprint: regexFingerprint({ content }),
      stageVersion: CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion,
    },
  });
  expect(res.isError).toBe(true);
  const body = toolResultJson(res) as { code: string; message: string };
  expect(body.code).toBe("INTERNAL");
  expect(body.message).toContain("무산출 신고 실패");
});

// ── (d) cleanup_run_status ───────────────────────────────────────────────────

test("(d1) cleanup_run_status deps.cleanupRuns 미주입 → isError(비활성 문구)", async () => {
  await connectNoRuns();

  const res = await client.callTool({
    name: "cleanup_run_status",
    arguments: { runId: "any-run" },
  });
  expect(res.isError).toBe(true);
  const body = toolResultJson(res) as { code: string; message: string };
  // T16 — 배선 부재는 고장이 아니라 꺼진 상태라 DISABLED (문구는 그대로).
  expect(body.code).toBe("DISABLED");
  expect(body.message).toContain("cleanup run API 비활성");
});

test("(d2) cleanup_run_status ledger fixture → run 행 JSON / 없는 runId → isError", async () => {
  const ledger = new CleanupRunsLedger(db);
  const started = ledger.startRun({
    trigger: "manual",
    options: {},
    idGen: () => "run-fixture-1",
  });
  // 이 도구는 ledger.getRun 만 부른다 — 나머지는 도구가 안 호출하는 데이터형 stub.
  const cleanupRuns: CleanupRunsRouteDeps = {
    ledger,
    gateReasons: () => [],
    triggerRun: () => "started",
    registerCancel: () => new AbortController().signal,
    cancelRun: () => false,
    isRunning: () => false,
  };
  deps.cleanupRuns = cleanupRuns;

  const inner = new Hono({ strict: false });
  registerMcpRoutes(inner, deps);
  await connectClient(inner);

  const ok = await client.callTool({
    name: "cleanup_run_status",
    arguments: { runId: started.runId },
  });
  expect(ok.isError).not.toBe(true);
  const row = toolResultJson(ok);
  expect(row.runId).toBe("run-fixture-1");
  expect(row.status).toBe("running");
  expect(row.trigger).toBe("manual");

  const missing = await client.callTool({
    name: "cleanup_run_status",
    arguments: { runId: "does-not-exist" },
  });
  expect(missing.isError).toBe(true);
  const missingBody = toolResultJson(missing) as { code: string; message: string };
  expect(missingBody.code).toBe("NOT_FOUND");
  expect(missingBody.message).toContain("run 없음");
});

// ── (f) 실 조립 배선 — createMemoryApi 실 app + SDK tools/list 14종 ─────────────

test("(f) createMemoryApi 실 조립 앱에 SDK 연결 → tools/list 14종 (마운트 배선 근거)", async () => {
  // createMemoryApi 는 실 임베더 + 리랭커 모델을 await load 한다(부팅 비용) — 이 한 케이스만
  // 5초 default 를 넘기므로 명시 타임아웃을 준다(다른 파일과 동시 실행 시 모델 로드 경합).
  const { createMemoryApi } = await import("../server.ts");
  // 설정 — 운영 설정 파일(env MEMORY_SETTINGS_PATH)·비밀값을 읽지 않게 기본값 사본을 넘긴다(백업 폴더도 임시).
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  settings.backup.dir = join(tmpDir, "backups");
  const built = await createMemoryApi({
    dbPath: ":memory:",
    // 첨부 파일 폴더·토큰 파일·설정 파일 — 운영 파일이 아니라 이 케이스의 임시 폴더 아래(afterEach 가 tmpDir 째 지운다, 설계 17.19 D41).
    assetDir: join(tmpDir, "assets"),
    sseTokenFilePath: join(tmpDir, "sse-tokens.json"),
    settingsFilePath: join(tmpDir, "memory-settings.json"),
    // 정적 대시보드는 이 테스트와 무관 — 빈 디렉토리로 비활성.
    staticDir: tmpDir,
    llmProvider: "none",
    settings,
  });

  // createMemoryApi 가 만든 sseTokens 로 인증 게이트를 실제로 태운다(실 조립 경로).
  const outer = new Hono({ strict: false });
  outer.use(
    "*",
    createAuthGate({
      sseTokens: built.sseTokens,
      remoteAddrOf: () => "127.0.0.1",
      getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
    }),
  );
  outer.route("/", built.app);
  server = Bun.serve({ port: 0, fetch: outer.fetch });

  const token = built.sseTokens.issueToken("claude-code");
  const mcpUrl = new URL(`http://127.0.0.1:${server.port}/mcp`);
  client = new Client({ name: "test-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);

  const { tools } = await client.listTools();
  expect(tools.length).toBe(18);
  const names = tools.map((t) => t.name).sort();
  expect(names).toEqual(
    [
      "search_memory",
      "get_memory",
      "list_recent",
      "store_memory",
      "save_decision",
      "save_idea",
      "save_question",
      "save_preference",
      "cleanup_list_candidates",
      "cleanup_submit_proposal",
      "cleanup_report_no_finding",
      "cleanup_run_status",
      "bara_doctor",
      "get_profile",
      "recall_context",
      "update_memory",
      "supersede_memory",
      "retract_memory",
    ].sort(),
  );

  built.shutdown();
}, 30000);

// ── (f) entityRegister 단계 지원 표시 — 펫이 이 두 값으로 서버 지원 여부를 판정한다(Task 19) ──

test("(f) cleanup_list_candidates 입력 스키마: stage 열거에 entityRegister, nodeIds 속성 존재", async () => {
  await connectNoRuns();
  const { tools } = await client.listTools();
  const list = tools.find((t) => t.name === "cleanup_list_candidates")!;
  const props = list.inputSchema.properties as Record<string, { enum?: string[]; type?: string }>;
  expect(props.stage!.enum).toContain("entityRegister");
  expect(props.nodeIds).toBeDefined();
  expect(props.nodeIds!.type).toBe("array");
  const submit = tools.find((t) => t.name === "cleanup_submit_proposal")!;
  const kindEnum = (submit.inputSchema.properties as Record<string, { enum?: string[] }>).kind!.enum;
  expect(kindEnum).toContain("entity_register");
  // metadata_fill 은 외부 통로가 없어 항상 400 이므로 열거하지 않는다.
  expect(kindEnum).not.toContain("metadata_fill");
  // payload 모양은 payload 칸 설명으로 알린다(도구 문안에는 되풀이하지 않는다).
  const payloadDesc = (submit.inputSchema.properties as Record<string, { description?: string }>).payload!.description ?? "";
  for (const needle of ["personLink: {nodeId, personId}", "lensDraft: {typeName, entityId, values", "entityRegister / regexStrengthen"]) {
    expect(payloadDesc).toContain(needle);
  }
  expect(submit.description).toContain("depends on candidate.stage");
  // 서버가 제출 도구를 쓰라고 안내하는 쓰기 가능 scope 에서는 제출 안내가 그대로 있다.
  expect(list.description).toContain("shared.instruction");
});

test("(f2) cleanup_list_candidates entityRegister + nodeIds → 그 메모만, 메모 단위 아닌 단계 + nodeIds → INVALID_INPUT", async () => {
  await store.addNode({ content: "금목서를 키우고 있다", sourceType: "auto_capture" });
  const b = await store.addNode({ content: "보리밥 먹고 싶다", sourceType: "auto_capture" });
  await connectNoRuns();
  const ok = await client.callTool({ name: "cleanup_list_candidates", arguments: { stage: "entityRegister", nodeIds: [b] } });
  expect(ok.isError).not.toBe(true);
  const body = toolResultJson(ok);
  expect(body.candidates.map((c: { targetKey: string }) => c.targetKey)).toEqual([String(b)]);
  expect(typeof body.shared.instruction).toBe("string");

  const bad = await client.callTool({ name: "cleanup_list_candidates", arguments: { stage: "lensDraft", nodeIds: [b] } });
  expect(bad.isError).toBe(true);
  expect((toolResultJson(bad) as { code: string }).code).toBe("INVALID_INPUT");
});

test("(f3) cleanup_submit_proposal entity_register → 서버 판정 결과(autoApplied·status none)", async () => {
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  deps.getSettings = () => settings;
  const memo = await store.addNode({ content: "금목서를 키우고 있다", sourceType: "auto_capture" });
  await connectNoRuns();
  const listed = toolResultJson(await client.callTool({ name: "cleanup_list_candidates", arguments: { stage: "entityRegister", nodeIds: [memo] } }));
  const c = listed.candidates[0];
  const res = await client.callTool({
    name: "cleanup_submit_proposal",
    arguments: {
      kind: "entity_register",
      payload: { nodeId: memo, entities: [{ type: "creature", name: "금목서" }], eventDateText: null, eventDate: null, scheduleTitle: null },
      candidate: { stage: "entityRegister", targetKey: c.targetKey, inputFingerprint: c.inputFingerprint, stageVersion: c.stageVersion },
    },
  });
  expect(res.isError).not.toBe(true);
  expect(toolResultJson(res)).toEqual({ proposalId: null, status: "none", ledgerRecorded: true, autoApplied: 1 });
}, 300_000);

test("(f4) cleanup_submit_proposal entity_register 설정 배선 없음 → DISABLED", async () => {
  delete deps.getSettings; // 기본 deps 는 regex 하네스용 설정 배선을 갖는다 — 이 시험은 그 배선이 없는 서버다.
  const memo = await store.addNode({ content: "금목서를 키우고 있다", sourceType: "auto_capture" });
  await connectNoRuns();
  const listed = toolResultJson(await client.callTool({ name: "cleanup_list_candidates", arguments: { stage: "entityRegister", nodeIds: [memo] } }));
  const c = listed.candidates[0];
  const res = await client.callTool({
    name: "cleanup_submit_proposal",
    arguments: {
      kind: "entity_register",
      payload: { nodeId: memo, entities: [], eventDateText: null, eventDate: null, scheduleTitle: null },
      candidate: { stage: "entityRegister", targetKey: c.targetKey, inputFingerprint: c.inputFingerprint, stageVersion: c.stageVersion },
    },
  });
  expect(res.isError).toBe(true);
  expect((toolResultJson(res) as { code: string }).code).toBe("DISABLED");
});
