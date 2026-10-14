/**
 * 추출 백필 한 주기 + 실패 기록 (2026-10-14 backfill-retry-ledger spec 4.5·7장).
 *
 * Ollama 자리에 진짜 로컬 HTTP 서버(provider-stand-in, Bun.serve)를 세우고 실제 OllamaClient·MemoryExtractor·SQLite 로
 * 주기를 돈다(mock 클래스 0). 실패 경로만 보므로 임베더는 싣지 않는다 — 성공은 LLM 을 부르지 않는 태그만 있는 원문으로 확인한다.
 * 시각은 전부 주입한 시계 하나(clockMs)로 움직인다 — 시험이 실제 시각에 기대지 않는다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { EXTRACTED_PATH, EXTRACTION_DONE } from "../../db/store-internal/extraction-state-sql.ts";
import { pastCutoffInZone } from "../../db/store-internal/helpers.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { OllamaClient } from "../../llm/ollama-client.ts";
import { startBackfillScheduler, type BackfillCycleSummary } from "../../scheduler.ts";
import { startProviderStandIn, type ProviderStandIn } from "../../test-utils/provider-stand-in.ts";
import { MemoryExtractor } from "../extractor.ts";
import { EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT } from "../extractor-output-limit.ts";
import { extractionFingerprint } from "./fingerprint.ts";
import { BackfillAttemptsLedger, type BackfillRetryPolicy } from "./ledger.ts";

const POLICY: BackfillRetryPolicy = { maxAttempts: 2, retryDelayMin: 30, retryMaxDelayMin: 1440 };
const TIMEOUT_MS = 80;
const MODEL = "test-model";
const DEFAULT_LIMIT = EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT;
const identityOf = (llmName: string, maxOutputTokens = DEFAULT_LIMIT) => ({ llmName, maxOutputTokens });
const LOG_PREFIX = "[extraction-cycle.test]";
const MINUTE_MS = 60_000;
/** 시험의 시작 시각 — 고정값(실제 시각과 무관). */
const CLOCK_START_MS = Date.UTC(2026, 9, 14, 0, 0, 0);
/** 첫 대기(30분)를 넘기는 간격. */
const PAST_FIRST_DELAY_MS = (POLICY.retryDelayMin + 1) * MINUTE_MS;
const TEN_DAYS_MS = 10 * 24 * 60 * MINUTE_MS;
/** 짧은 단일 의미 건너뛰기(shouldSkipExtraction)에 걸리지 않게 문장 둘로 쓴다. */
const memo = (n: number) => `${n}번째 회의에서 예산을 정했다. 다음 주에는 일정표를 다시 본다.`;

let standIn: ProviderStandIn;
beforeAll(() => { standIn = startProviderStandIn(); });
afterAll(() => standIn.stop());

let db: Database;
let embedder: Bgem3Embedder;
let store: SqliteMemoryStore;
let ledger: BackfillAttemptsLedger;
let clockMs: number;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  embedder = new Bgem3Embedder();
  store = new SqliteMemoryStore(db, embedder);
  ledger = new BackfillAttemptsLedger(db);
  clockMs = CLOCK_START_MS;
});
afterEach(() => {
  standIn.requests.length = 0;
  standIn.reply = () => ({ status: 404, body: "not found" });
  db.close();
});

function insertMemo(content: string, createdAt = "2026-10-14 09:00:00"): number {
  return Number(
    db.query("INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES (?, 'auto_capture', ?)").run(content, createdAt).lastInsertRowid,
  );
}

function extractorAt(baseUrl: string, model = MODEL, maxOutputTokens?: number): MemoryExtractor {
  return new MemoryExtractor(new OllamaClient({ baseUrl, model, timeoutMs: TIMEOUT_MS }), store, embedder, maxOutputTokens === undefined ? {} : { maxOutputTokens });
}

async function tick(extractor: MemoryExtractor, batchSize = 5): Promise<BackfillCycleSummary> {
  const handle = startBackfillScheduler(extractor, store, {
    intervalMs: 60_000, batchSize, logPrefix: LOG_PREFIX, retry: { policy: POLICY }, now: () => clockMs,
  });
  try {
    return await handle.tickNow();
  } finally {
    await handle.stop();
  }
}

function chatRequests(): number {
  return standIn.requests.filter((r) => r.path === "/api/chat").length;
}

function closedPortUrl(): string {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const url = `http://127.0.0.1:${server.port}`;
  void server.stop(true);
  return url;
}

/** 시계 지금 시각에 센 실패를 times 번 심는다. */
function seedFailures(nodeId: number, content: string, times: number, identity = identityOf(`ollama:${MODEL}`)): void {
  for (let i = 0; i < times; i += 1) {
    ledger.recordCounted({
      kind: "extraction", targetKey: String(nodeId), nodeId,
      fingerprint: extractionFingerprint(identity, content), error: "이전 실패", policy: POLICY,
    }, clockMs);
  }
}

describe("세는 실패 — 시간 초과", () => {
  test("센다 → 다음 주기에 빠진다 → 시각이 지나면 다시 후보 → 상한에서 멈춘다", async () => {
    standIn.reply = () => ({ hang: true });
    const id = insertMemo(memo(1));
    const extractor = extractorAt(standIn.origin);
    const errors = spyOn(console, "error");
    try {
      const first = await tick(extractor);
      expect(first).toMatchObject({ candidatesFound: 1, failures: 1, retry: { retryWait: 1, stopped: 0, cycleStopped: null } });
      expect(ledger.get("extraction", String(id))).toMatchObject({
        status: "retryable_failure", attemptCount: 1,
        lastError: `Ollama /api/chat timeout (${TIMEOUT_MS}ms 초과)`,
        inputFingerprint: extractionFingerprint(identityOf(`ollama:${MODEL}`), memo(1)),
      });

      expect((await tick(extractor)).candidatesFound).toBe(0);
      expect(chatRequests()).toBe(1);

      clockMs += PAST_FIRST_DELAY_MS;
      const second = await tick(extractor);
      expect(second).toMatchObject({ candidatesFound: 1, failures: 1, retry: { retryWait: 0, stopped: 1, cycleStopped: null } });
      expect(ledger.get("extraction", String(id))).toMatchObject({ status: "terminal_failure", attemptCount: 2, nextRetryAt: null });
      const stopLines = errors.mock.calls.map((c: unknown[]) => c.map(String).join(" ")).filter((l: string) => l.includes("backfill stopped for node"));
      expect(stopLines).toEqual([
        `${LOG_PREFIX} backfill stopped for node ${id} after 2 attempts: Ollama /api/chat timeout (${TIMEOUT_MS}ms 초과)`,
      ]);

      clockMs += TEN_DAYS_MS;
      expect((await tick(extractor)).candidatesFound).toBe(0);
    } finally {
      errors.mockRestore();
    }
  });

  test("다음 시도 시각은 주기 시작이 아니라 실패한 순간부터 센다(긴 주기 중간의 실패)", async () => {
    const FAILURE_OFFSET_MS = 45 * MINUTE_MS;
    standIn.reply = () => {
      clockMs += FAILURE_OFFSET_MS; // 이 후보의 LLM 호출이 오래 걸려 시계가 주기 시작보다 45분 흘렀다
      return { hang: true };
    };
    const id = insertMemo(memo(1));
    const errors = spyOn(console, "error");
    try {
      await tick(extractorAt(standIn.origin));
    } finally {
      errors.mockRestore();
    }
    const row = ledger.get("extraction", String(id))!;
    const failureAtMs = CLOCK_START_MS + FAILURE_OFFSET_MS;
    expect(row.lastAttemptAt).toBe(pastCutoffInZone(failureAtMs));
    expect(row.nextRetryAt).toBe(pastCutoffInZone(failureAtMs + POLICY.retryDelayMin * MINUTE_MS));
    expect(row.nextRetryAt).not.toBe(pastCutoffInZone(CLOCK_START_MS + POLICY.retryDelayMin * MINUTE_MS));
  });

  test("주기 요약 줄에 retry-wait·stopped 가 붙는다", async () => {
    standIn.reply = () => ({ hang: true });
    insertMemo(memo(1));
    const logs = spyOn(console, "log");
    try {
      await tick(extractorAt(standIn.origin));
      const cycleLine = logs.mock.calls.map((c: unknown[]) => c.map(String).join(" ")).find((l: string) => l.startsWith(`${LOG_PREFIX} cycle:`));
      expect(cycleLine).toContain("retry-wait 1, stopped 0");
    } finally {
      logs.mockRestore();
    }
  });
});

describe("출력 한도에 잘림 — 첫 번에 멈춤", () => {
  const TRUNCATED_BODY = { message: { role: "assistant", content: "[{\"content\":\"잘" }, done_reason: "length", prompt_eval_count: 10, eval_count: 4096 };

  test("한 주기에 멈춤이 되고 같은 주기의 다른 후보는 처리되며, 하루 뒤에도 요청이 가지 않는다", async () => {
    standIn.reply = () => ({ body: TRUNCATED_BODY });
    const cut = insertMemo(memo(1), "2026-10-14 09:00:00");
    const other = insertMemo("#회의", "2026-10-14 09:01:00"); // LLM 을 부르지 않는 태그만 있는 원문
    const extractor = extractorAt(standIn.origin);
    const errors = spyOn(console, "error");
    try {
      const first = await tick(extractor);
      expect(first).toMatchObject({ candidatesFound: 2, processed: 1, failures: 1, retry: { retryWait: 0, stopped: 1, cycleStopped: null } });
      const row = ledger.get("extraction", String(cut))!;
      expect(row).toMatchObject({ status: "terminal_failure", attemptCount: 1, nextRetryAt: null });
      expect(row.lastError).toContain("출력 한도");
      expect(ledger.get("extraction", String(other))).toBeNull();
      expect(errors.mock.calls.some((c: unknown[]) =>
        c.map(String).join(" ").includes(`stopped immediately for node ${cut} (output_truncated)`))).toBe(true);
      expect(chatRequests()).toBe(1);

      // 노드는 추출 완료가 아니다.
      const extracted = db
        .query(`SELECT metadata_json ->> ? AS done FROM knowledge_nodes WHERE id = ?`)
        .get(EXTRACTED_PATH, cut) as { done: number | null };
      expect(extracted.done).not.toBe(EXTRACTION_DONE);

      clockMs += 24 * 60 * MINUTE_MS;
      expect((await tick(extractor)).candidatesFound).toBe(0);
      expect(chatRequests()).toBe(1);

      // 기록 표에서 줄을 지우면(다시 시도) 다음 주기에 다시 후보가 된다.
      expect(ledger.clear("extraction", String(cut))).toBe(true);
      expect((await tick(extractor)).candidatesFound).toBe(1);
      expect(chatRequests()).toBe(2);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("형식 두 번 깨짐 — 보통 실패로 센다", () => {
  const GARBLED_BODY = { message: { role: "assistant", content: "JSON 이 아닌 답" }, done_reason: "stop" };

  test("센 실패(retryable)로 기록되고 추출 완료가 아니며, 간격 뒤 다시 시도되고 maxAttempts 번째에 멈춘다", async () => {
    standIn.reply = () => ({ body: GARBLED_BODY });
    const id = insertMemo(memo(1));
    const extractor = extractorAt(standIn.origin);
    const errors = spyOn(console, "error");
    try {
      const first = await tick(extractor);
      expect(first).toMatchObject({ candidatesFound: 1, processed: 0, failures: 1, retry: { retryWait: 1, stopped: 0, cycleStopped: null } });
      const row = ledger.get("extraction", String(id))!;
      expect(row).toMatchObject({ status: "retryable_failure", attemptCount: 1 });
      expect(row.lastError).toContain("두 번 모두 읽지 못했습니다");
      expect(chatRequests()).toBe(2); // 첫 요청 + 재요청

      const extracted = db
        .query(`SELECT metadata_json ->> ? AS done FROM knowledge_nodes WHERE id = ?`)
        .get(EXTRACTED_PATH, id) as { done: number | null };
      expect(extracted.done).not.toBe(EXTRACTION_DONE);

      expect((await tick(extractor)).candidatesFound).toBe(0); // 간격 안에는 후보가 아니다
      expect(chatRequests()).toBe(2);

      clockMs += PAST_FIRST_DELAY_MS;
      const second = await tick(extractor);
      expect(second).toMatchObject({ candidatesFound: 1, failures: 1, retry: { retryWait: 0, stopped: 1 } });
      expect(ledger.get("extraction", String(id))).toMatchObject({ status: "terminal_failure", attemptCount: POLICY.maxAttempts, nextRetryAt: null });
      expect(errors.mock.calls.some((c: unknown[]) =>
        c.map(String).join(" ").includes(`backfill stopped for node ${id} after ${POLICY.maxAttempts} attempts`))).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("주기 중단·세지 않음", () => {
  test("연결 거부(닫힌 포트)면 주기를 멈추고 아무것도 기록하지 않으며 남은 후보를 건드리지 않는다", async () => {
    insertMemo(memo(1), "2026-10-14 09:00:00");
    insertMemo(memo(2), "2026-10-14 09:01:00");
    const summary = await tick(extractorAt(closedPortUrl()));
    expect(summary).toMatchObject({
      candidatesFound: 2, processed: 0, failures: 1, retry: { retryWait: 0, stopped: 0, cycleStopped: "connection" },
    });
    expect(ledger.rows("extraction")).toEqual([]);
  });

  test("404(모델 없음)는 설정 문제로 주기를 멈추고 기록하지 않는다", async () => {
    standIn.reply = () => ({ status: 404, body: { error: "model not found" } });
    insertMemo(memo(1), "2026-10-14 09:00:00");
    insertMemo(memo(2), "2026-10-14 09:01:00");
    const errors = spyOn(console, "error");
    try {
      const summary = await tick(extractorAt(standIn.origin));
      expect(summary).toMatchObject({ failures: 1, retry: { cycleStopped: "config" } });
      expect(ledger.rows("extraction")).toEqual([]);
      expect(errors.mock.calls.some((c: unknown[]) => c.map(String).join(" ").includes("설정 문제(HTTP 404)"))).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  test("429 는 세지 않고 다음 후보로 넘어가며 다음 주기에 다시 시도한다", async () => {
    standIn.reply = () => ({ status: 429, body: { error: "busy" } });
    insertMemo(memo(1), "2026-10-14 09:00:00");
    insertMemo(memo(2), "2026-10-14 09:01:00");
    const extractor = extractorAt(standIn.origin);
    expect(await tick(extractor)).toMatchObject({ candidatesFound: 2, failures: 2, retry: { cycleStopped: null } });
    expect(ledger.rows("extraction")).toEqual([]);
    expect((await tick(extractor)).candidatesFound).toBe(2);
  });
});

describe("후보 고르기·성공·정리", () => {
  test("막힌 대상이 있어도 batchSize 만큼 다른 후보를 고른다", async () => {
    standIn.reply = () => ({ hang: true });
    const a = insertMemo(memo(1), "2026-10-14 09:00:00");
    const b = insertMemo(memo(2), "2026-10-14 09:01:00");
    const c = insertMemo(memo(3), "2026-10-14 09:02:00");
    seedFailures(a, memo(1), 1);
    expect((await tick(extractorAt(standIn.origin), 2)).candidatesFound).toBe(2);
    expect(ledger.get("extraction", String(b))!.attemptCount).toBe(1);
    expect(ledger.get("extraction", String(c))!.attemptCount).toBe(1);
    expect(ledger.get("extraction", String(a))!.lastError).toBe("이전 실패");
  });

  test("성공하면 지난 실패 줄을 지운다(LLM 을 부르지 않는 태그만 있는 원문)", async () => {
    const id = insertMemo("#회의");
    seedFailures(id, "#회의", 1);
    clockMs += PAST_FIRST_DELAY_MS;
    const summary = await tick(extractorAt(standIn.origin));
    expect(summary).toMatchObject({ processed: 1, failures: 0 });
    expect(ledger.get("extraction", String(id))).toBeNull();
    expect(chatRequests()).toBe(0);
  });

  test("기억을 고치면 지문이 바뀌어 멈춤이 풀리고 다시 후보가 된다", async () => {
    standIn.reply = () => ({ hang: true });
    const id = insertMemo(memo(1));
    seedFailures(id, memo(1), POLICY.maxAttempts);
    expect(ledger.get("extraction", String(id))!.status).toBe("terminal_failure");
    db.query("UPDATE knowledge_nodes SET content = ? WHERE id = ?").run(memo(9), id);
    expect((await tick(extractorAt(standIn.origin))).candidatesFound).toBe(1);
    expect(ledger.get("extraction", String(id))).toMatchObject({
      attemptCount: 1, inputFingerprint: extractionFingerprint(identityOf(`ollama:${MODEL}`), memo(9)),
    });
  });

  test("추출 모델을 바꾸면 지문이 바뀌어 멈춤이 풀린다", async () => {
    standIn.reply = () => ({ hang: true });
    const id = insertMemo(memo(1));
    seedFailures(id, memo(1), POLICY.maxAttempts);
    expect((await tick(extractorAt(standIn.origin, "other-model"))).candidatesFound).toBe(1);
    expect(ledger.get("extraction", String(id))!.attemptCount).toBe(1);
  });

  test("이미 추출된 원문의 줄은 주기 시작 때 지운다", async () => {
    const id = insertMemo(memo(1));
    seedFailures(id, memo(1), POLICY.maxAttempts);
    await store.markNodeExtracted(id, []);
    expect((await tick(extractorAt(standIn.origin))).candidatesFound).toBe(0);
    expect(ledger.rows("extraction")).toEqual([]);
  });
});

describe("출력 한도를 바꾸면 멈춘 기억을 다음 주기에 다시 시도한다 (output-limit spec 6장)", () => {
  const TRUNCATED_BODY = { message: { role: "assistant", content: "[{\"content\":\"잘" }, done_reason: "length", prompt_eval_count: 10, eval_count: 1024 };
  const GARBLED_BODY = { message: { role: "assistant", content: "JSON 이 아닌 답" }, done_reason: "stop" };
  const OK_BODY = {
    message: { role: "assistant", content: JSON.stringify([{ content: "예산을 정했다", memoryType: "fact", importance: 0.8 }]) },
    done_reason: "stop", prompt_eval_count: 10, eval_count: 20,
  };
  const reconcileLines = (logs: { mock: { calls: unknown[][] } }) =>
    logs.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.includes("extraction ledger reconcile"));
  const requestedLimits = () =>
    standIn.requests.filter((r) => r.path === "/api/chat").map((r) => (r.body as { options: { num_predict: number } }).options.num_predict);

  test("1024 로 잘려 멈춤 -> 같은 1024 는 줄 유지·요청 없음·로그 없음 -> 2048 은 줄 지우고 같은 주기에 2048 로 다시 요청해 추출 완료", async () => {
    await embedder.load();
    standIn.reply = () => ({ body: TRUNCATED_BODY });
    const id = insertMemo(memo(1));
    const errors = spyOn(console, "error");
    const logs = spyOn(console, "log");
    try {
      await tick(extractorAt(standIn.origin, MODEL, 1024));
      expect(ledger.get("extraction", String(id))).toMatchObject({
        status: "terminal_failure", attemptCount: 1,
        inputFingerprint: extractionFingerprint(identityOf(`ollama:${MODEL}`, 1024), memo(1)),
      });
      expect(requestedLimits()).toEqual([1024]);

      logs.mockClear();
      expect((await tick(extractorAt(standIn.origin, MODEL, 1024))).candidatesFound).toBe(0);
      expect(ledger.get("extraction", String(id))).not.toBeNull();
      expect(chatRequests()).toBe(1);
      expect(reconcileLines(logs)).toEqual([]);

      standIn.reply = () => ({ body: OK_BODY });
      logs.mockClear();
      const summary = await tick(extractorAt(standIn.origin, MODEL, 2048));
      expect(reconcileLines(logs)).toEqual([`${LOG_PREFIX} extraction ledger reconcile: pruned=0 fingerprintCleared=1`]);
      expect(summary).toMatchObject({ candidatesFound: 1, failures: 0 });
      expect(requestedLimits()).toEqual([1024, 2048]);
      expect(ledger.get("extraction", String(id))).toBeNull();
      const extracted = db
        .query(`SELECT metadata_json ->> ? AS done FROM knowledge_nodes WHERE id = ?`)
        .get(EXTRACTED_PATH, id) as { done: number | null };
      expect(extracted.done).toBe(EXTRACTION_DONE);
    } finally {
      errors.mockRestore();
      logs.mockRestore();
    }
  });

  test("잘림이 아닌 센 실패(형식 두 번 깨짐) 줄도 한도가 바뀌면 지워져 횟수 1부터 다시 센다 (약점 6.1 ①)", async () => {
    standIn.reply = () => ({ body: GARBLED_BODY });
    const id = insertMemo(memo(1));
    const errors = spyOn(console, "error");
    const logs = spyOn(console, "log");
    try {
      await tick(extractorAt(standIn.origin, MODEL, 1024));
      expect(ledger.get("extraction", String(id))).toMatchObject({ status: "retryable_failure", attemptCount: 1 });

      // 한도 1024 그대로면 다음 시도가 2번째가 되지만, 한도 2048 이면 줄이 지워져 다시 1 부터 센다.
      clockMs += PAST_FIRST_DELAY_MS;
      logs.mockClear();
      await tick(extractorAt(standIn.origin, MODEL, 2048));
      expect(reconcileLines(logs)).toEqual([`${LOG_PREFIX} extraction ledger reconcile: pruned=0 fingerprintCleared=1`]);
      expect(ledger.get("extraction", String(id))).toMatchObject({
        status: "retryable_failure", attemptCount: 1,
        inputFingerprint: extractionFingerprint(identityOf(`ollama:${MODEL}`, 2048), memo(1)),
      });
    } finally {
      errors.mockRestore();
      logs.mockRestore();
    }
  });
});
