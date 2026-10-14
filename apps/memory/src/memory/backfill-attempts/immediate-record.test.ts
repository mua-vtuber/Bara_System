/**
 * memory/backfill-attempts/immediate-record.ts 시험 — 저장 직후 추출의 잘림을 기록 표에 멈춤으로 쓴다
 * (2026-10-14 speed-step1 spec 4.2). 실제 SQLite 를 쓰고 시각은 주입한 값이다(mock 0).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { extractionTargetKey } from "../../db/store-internal/backfill-attempts-sql.ts";
import { pastCutoffInZone } from "../../db/store-internal/helpers.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { ExtractionOutputTruncatedError } from "../extractor-internal/response-errors.ts";
import { extractionFingerprint } from "./fingerprint.ts";
import { recordImmediateTruncation } from "./immediate-record.ts";
import { BackfillAttemptsLedger } from "./ledger.ts";
import { inspectExtractionAttempt } from "./targets.ts";

const LLM_NAME = "ollama:test-model";
const IDENTITY = { llmName: LLM_NAME, maxOutputTokens: 1024 };
const NOW_MS = Date.UTC(2026, 9, 14, 3, 0, 0);
const CONTENT = "#회의 3번째 회의에서 예산을 정했다. 다음 주에는 일정표를 다시 본다.";

let db: Database;
let store: SqliteMemoryStore;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, new Bgem3Embedder());
});
afterEach(() => db.close());

function insertNode(content: string): number {
  return Number(
    db.query("INSERT INTO knowledge_nodes (content, source_type) VALUES (?, 'auto_capture')").run(content).lastInsertRowid,
  );
}

function truncatedError(): ExtractionOutputTruncatedError {
  return new ExtractionOutputTruncatedError({ llmName: LLM_NAME, maxOutputTokens: 1024, outputTokens: 1024, attempt: "first" });
}

describe("recordImmediateTruncation", () => {
  test("terminal_failure 한 줄을 백필과 같은 targetKey·지문으로 쓴다", () => {
    const id = insertNode(CONTENT);
    recordImmediateTruncation(store, { nodeId: id, nodeContent: CONTENT, identity: IDENTITY, error: truncatedError() }, NOW_MS);
    const row = new BackfillAttemptsLedger(db).get("extraction", extractionTargetKey(id));
    expect(row).toMatchObject({
      kind: "extraction", nodeId: id, status: "terminal_failure", attemptCount: 1, nextRetryAt: null,
      inputFingerprint: extractionFingerprint(IDENTITY, CONTENT),
      lastAttemptAt: pastCutoffInZone(NOW_MS),
    });
    expect(row!.lastError).toContain("출력 한도");
  });

  test("오류 문장의 키 모양은 가려서 쓴다", () => {
    const id = insertNode(CONTENT);
    recordImmediateTruncation(
      store,
      { nodeId: id, nodeContent: CONTENT, identity: IDENTITY, error: new Error("실패 Bearer abcdefghijklmnopqrstuvwxyz0123456789") },
      NOW_MS,
    );
    const row = new BackfillAttemptsLedger(db).get("extraction", extractionTargetKey(id))!;
    expect(row.lastError).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  test("다음 백필 주기의 reconcile 이 쓴 줄을 지우지 않는다(지문이 백필 계산값과 같다)", async () => {
    const id = insertNode(CONTENT);
    recordImmediateTruncation(store, { nodeId: id, nodeContent: CONTENT, identity: IDENTITY, error: truncatedError() }, NOW_MS);
    const row = new BackfillAttemptsLedger(db).get("extraction", extractionTargetKey(id))!;
    expect(await inspectExtractionAttempt(store, IDENTITY, row)).toBe(row.inputFingerprint);
  });

  test("같은 한도의 reconcile 은 지우지 않고, 다른 한도의 identity 로 계산한 지문은 다르다", async () => {
    const id = insertNode(CONTENT);
    recordImmediateTruncation(store, { nodeId: id, nodeContent: CONTENT, identity: IDENTITY, error: truncatedError() }, NOW_MS);
    const row = new BackfillAttemptsLedger(db).get("extraction", extractionTargetKey(id))!;
    expect(await inspectExtractionAttempt(store, { ...IDENTITY }, row)).toBe(row.inputFingerprint);
    expect(await inspectExtractionAttempt(store, { ...IDENTITY, maxOutputTokens: 2048 }, row)).not.toBe(row.inputFingerprint);
    expect(extractionFingerprint({ ...IDENTITY, maxOutputTokens: 2048 }, CONTENT)).not.toBe(row.inputFingerprint);
  });
});
