/**
 * 저장 직후 추출(immediate 갈래)의 추출 실패 경로 (2026-10-14 speed-step1 spec 4.2·4.4 표).
 *
 *   - 출력 한도에 잘림 → 원문 저장 + 경고 + 기록 표에 terminal_failure 한 줄, 이어지는 백필 주기는 그 노드로 요청을 보내지 않는다.
 *   - 형식 두 번 깨짐 → 원문 저장 + 경고, 기록 표 0줄, 추출 표시 없음(백필 후보로 남아 보통 규칙으로 센다).
 *
 * save-input.test.ts 가 이미 800줄 상한에 가까워 새 파일로 둔다. Ollama 자리에는 진짜 로컬 HTTP 서버를 세우고(mock 클래스 0)
 * 실제 OllamaClient·MemoryExtractor·SQLite 로 돈다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { extractionTargetKey } from "../db/store-internal/backfill-attempts-sql.ts";
import { EXTRACTED_PATH } from "../db/store-internal/extraction-state-sql.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { OllamaClient } from "../llm/ollama-client.ts";
import { extractionFingerprint } from "../memory/backfill-attempts/fingerprint.ts";
import { BackfillAttemptsLedger } from "../memory/backfill-attempts/ledger.ts";
import { MemoryExtractor } from "../memory/extractor.ts";
import { startBackfillScheduler } from "../scheduler.ts";
import type { MemorySettings } from "../settings/memory-settings.ts";
import { startProviderStandIn, type ProviderStandIn } from "../test-utils/provider-stand-in.ts";
import { saveTextInput } from "./save-input.ts";
import { EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT } from "../memory/extractor-output-limit.ts";

const MODEL = "test-model";
const LLM_NAME = `ollama:${MODEL}`;
const IDENTITY = { llmName: LLM_NAME, maxOutputTokens: EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT };
const POLICY = { maxAttempts: 3, retryDelayMin: 30, retryMaxDelayMin: 1440 };
const CONTENT = "3번째 회의에서 예산을 정했다. 다음 주에는 일정표를 다시 본다.";
const TRUNCATED_BODY = {
  message: { role: "assistant", content: "[{\"content\":\"잘" }, done_reason: "length", prompt_eval_count: 10, eval_count: 4096,
};
const GARBLED_BODY = { message: { role: "assistant", content: "죄송하지만 JSON 으로 답할 수 없습니다" }, done_reason: "stop" };

function immediateSlot(): MemorySettings["llm"]["extractor"] {
  return {
    enabled: true, provider: "ollama", ollamaUrl: "http://127.0.0.1:11434", ollamaModel: MODEL,
    anthropicApiKey: "", anthropicModel: "", openaiBaseUrl: "http://127.0.0.1:1234/v1", openaiModel: "",
    openaiApiKey: "", gptApiKey: "", gptModel: "", geminiApiKey: "", geminiModel: "",
    mode: "immediate", minImportance: 0.3, forceJsonFormat: false, timeoutMs: 5000, maxOutputTokens: EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT,
    backfill: { intervalMin: 30, batchSize: 10, minImportance: 0, ...POLICY },
  };
}

let standIn: ProviderStandIn;
let embedder: Bgem3Embedder;
beforeAll(async () => {
  standIn = startProviderStandIn();
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => standIn.stop());

let db: Database;
let store: SqliteMemoryStore;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
});
afterEach(() => {
  standIn.requests.length = 0;
  standIn.reply = () => ({ status: 404, body: "not found" });
  db.close();
});

function extractor(maxOutputTokens?: number): MemoryExtractor {
  return new MemoryExtractor(new OllamaClient({ baseUrl: standIn.origin, model: MODEL, timeoutMs: 5000 }), store, embedder, maxOutputTokens === undefined ? {} : { maxOutputTokens });
}

function chatRequests(): number {
  return standIn.requests.filter((r) => r.path === "/api/chat").length;
}

async function save(ex: MemoryExtractor) {
  return saveTextInput(store, {
    content: CONTENT, source: "dashboard:manual", chunking: { tokenCap: 2000 },
    extractor: ex, extractorSettings: immediateSlot(),
  });
}

function extractedMark(nodeId: number): number | null {
  return (db.query(`SELECT metadata_json ->> ? AS done FROM knowledge_nodes WHERE id = ?`).get(EXTRACTED_PATH, nodeId) as { done: number | null }).done;
}

describe("저장 직후 추출 — 출력 한도에 잘림", () => {
  test("원문 저장 + 경고 + 기록 표 멈춤 한 줄, 이어지는 백필은 그 노드로 요청을 보내지 않는다", async () => {
    standIn.reply = () => ({ body: TRUNCATED_BODY });
    const ex = extractor();
    const warn = spyOn(console, "warn");
    try {
      const result = await save(ex);
      expect(result.immediateExtractionRan).toBe(false);
      expect(result.extracted).toEqual([]);
      const origin = await store.getNode(result.originNodeId!);
      expect(origin?.content).toBe(CONTENT);
      expect(extractedMark(result.originNodeId!)).toBeNull();
      expect(warn.mock.calls.some((c: unknown[]) => c.map(String).join(" ").includes("출력 한도"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
    expect(chatRequests()).toBe(1); // 잘림은 같은 요청을 다시 보내지 않는다

    const id = (db.query("SELECT id FROM knowledge_nodes WHERE content = ?").get(CONTENT) as { id: number }).id;
    const row = new BackfillAttemptsLedger(db).get("extraction", extractionTargetKey(id));
    expect(row).toMatchObject({
      status: "terminal_failure", attemptCount: 1, nextRetryAt: null, nodeId: id,
      inputFingerprint: extractionFingerprint(IDENTITY, CONTENT),
    });
    expect(row!.lastError).toContain("출력 한도");
    expect(new BackfillAttemptsLedger(db).rows("extraction")).toHaveLength(1);

    // 백필 한 주기 — 후보에서 빠지고 요청이 가지 않는다.
    const handle = startBackfillScheduler(ex, store, {
      intervalMs: 60_000, batchSize: 5, logPrefix: "[immediate-test]", retry: { policy: POLICY }, now: () => Date.now(),
    });
    try {
      expect(await handle.tickNow()).toMatchObject({ candidatesFound: 0, failures: 0 });
    } finally {
      await handle.stop();
    }
    expect(chatRequests()).toBe(1);
    expect(new BackfillAttemptsLedger(db).get("extraction", extractionTargetKey(id))?.status).toBe("terminal_failure");
  });

  test("기록 표 쓰기가 실패해도 원문 저장은 유지되고 원래 오류와 쓰기 오류를 함께 남긴다", async () => {
    standIn.reply = () => ({ body: TRUNCATED_BODY });
    db.exec("DROP TABLE backfill_attempts");
    const errors = spyOn(console, "error");
    const warn = spyOn(console, "warn");
    try {
      const result = await save(extractor());
      expect((await store.getNode(result.originNodeId!))?.content).toBe(CONTENT);
      const lines = errors.mock.calls.map((c: unknown[]) => c.map(String).join(" "));
      expect(lines.some((l: string) => l.includes("출력 한도") && l.includes("backfill_attempts"))).toBe(true);
    } finally {
      errors.mockRestore();
      warn.mockRestore();
    }
  });
});

describe("저장 직후 추출 — 출력 한도가 기록 줄 지문에 든다 (output-limit spec 6장)", () => {
  function backfillTick(ex: MemoryExtractor) {
    const handle = startBackfillScheduler(ex, store, {
      intervalMs: 60_000, batchSize: 5, logPrefix: "[immediate-test]", retry: { policy: POLICY }, now: () => Date.now(),
    });
    return handle.tickNow().finally(() => handle.stop());
  }

  test("지문 = extractionFingerprint(extractor.attemptIdentity, 원문). 같은 추출기 백필은 줄 유지·요청 없음, 한도가 다른 추출기 백필은 줄을 지우고 다시 시도한다", async () => {
    standIn.reply = () => ({ body: TRUNCATED_BODY });
    const ex = extractor(1024);
    const warn = spyOn(console, "warn");
    try {
      const result = await save(ex);
      const id = result.originNodeId!;
      const row = new BackfillAttemptsLedger(db).get("extraction", extractionTargetKey(id))!;
      expect(row.inputFingerprint).toBe(extractionFingerprint(ex.attemptIdentity, CONTENT));
      expect(ex.attemptIdentity.maxOutputTokens).toBe(1024);
      expect(chatRequests()).toBe(1);

      expect(await backfillTick(ex)).toMatchObject({ candidatesFound: 0, failures: 0 });
      expect(chatRequests()).toBe(1);
      expect(new BackfillAttemptsLedger(db).get("extraction", extractionTargetKey(id))?.status).toBe("terminal_failure");

      // 한도가 다른 추출기 - 줄이 지워지고 그 노드를 다시 시도한다(여기서는 또 잘리므로 새 한도 지문으로 다시 멈춘다).
      const other = extractor(2048);
      const errors = spyOn(console, "error");
      try {
        expect(await backfillTick(other)).toMatchObject({ candidatesFound: 1 });
      } finally {
        errors.mockRestore();
      }
      expect(chatRequests()).toBe(2);
      expect(new BackfillAttemptsLedger(db).get("extraction", extractionTargetKey(id))).toMatchObject({
        status: "terminal_failure", inputFingerprint: extractionFingerprint(other.attemptIdentity, CONTENT),
      });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("저장 직후 추출 — NFD 입력", () => {
  test("NFD 본문이 잘려도 기록 줄의 지문이 저장된(NFC) 본문 기준이라 다음 백필이 줄을 지우지 않고 요청도 없다", async () => {
    const nfd = CONTENT.normalize("NFD");
    expect(nfd).not.toBe(CONTENT);
    standIn.reply = () => ({ body: TRUNCATED_BODY });
    const ex = extractor();
    const result = await saveTextInput(store, {
      content: nfd, source: "dashboard:manual", chunking: { tokenCap: 2000 },
      extractor: ex, extractorSettings: immediateSlot(),
    });
    const id = result.originNodeId!;
    expect((await store.getNode(id))?.content).toBe(CONTENT);
    const before = new BackfillAttemptsLedger(db).get("extraction", extractionTargetKey(id))!;
    expect(before.inputFingerprint).toBe(extractionFingerprint(IDENTITY, CONTENT));
    expect(chatRequests()).toBe(1);

    const handle = startBackfillScheduler(ex, store, {
      intervalMs: 60_000, batchSize: 5, logPrefix: "[immediate-test]", retry: { policy: POLICY }, now: () => Date.now(),
    });
    try {
      expect(await handle.tickNow()).toMatchObject({ candidatesFound: 0, failures: 0 });
    } finally {
      await handle.stop();
    }
    expect(chatRequests()).toBe(1);
    expect(new BackfillAttemptsLedger(db).get("extraction", extractionTargetKey(id))?.status).toBe("terminal_failure");
  });
});

describe("저장 직후 추출 — 형식 두 번 깨짐", () => {
  test("원문 저장 + 경고, 기록 표 0줄, 추출 표시 없음(백필 후보로 남는다)", async () => {
    standIn.reply = () => ({ body: GARBLED_BODY });
    const warn = spyOn(console, "warn");
    let originId: number;
    try {
      const result = await save(extractor());
      originId = result.originNodeId!;
      expect(result.immediateExtractionRan).toBe(false);
      expect(result.extracted).toEqual([]);
      expect((await store.getNode(originId))?.content).toBe(CONTENT);
      expect(warn.mock.calls.some((c: unknown[]) => c.map(String).join(" ").includes("두 번 모두 읽지 못했습니다"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
    expect(chatRequests()).toBe(2); // 첫 요청 + 재요청
    expect(new BackfillAttemptsLedger(db).rows("extraction")).toEqual([]);
    expect(extractedMark(originId)).toBeNull();
    const candidates = await store.getBackfillCandidates({ limit: 10 });
    expect(candidates.map((c) => c.id)).toContain(originId);
  });
});
