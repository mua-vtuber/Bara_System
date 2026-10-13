/**
 * 문서 OCR 원장 — 실제 SQLite + 실제 마이그레이션(v49) (2026-10-11 document-ocr spec T4).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS, openMemoryDatabase, runMigrations } from "../../db/migrations.ts";
import { DocumentOcrLedger, pageDecision } from "./ledger.ts";

const DIM = 8;
let db: Database;
let ledger: DocumentOcrLedger;

function insertDocument(target: Database, tag: string, parseStatus = "needs_ocr"): string {
  const sha = `sha_ocr_${tag}`;
  target.prepare(
    `INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, first_imported_at) VALUES (?, 'document', ?, 1, 1)`,
  ).run(sha, `/assets/${sha}.pdf`);
  const docId = `doc_${tag}`;
  target.prepare(
    `INSERT INTO documents (document_id, asset_sha256, title, document_type, source_metadata, created_at, updated_at)
     VALUES (?, ?, ?, 'pdf', ?, '2026-10-11 00:00:00', '2026-10-11 00:00:00')`,
  ).run(docId, sha, `문서 ${tag}`, JSON.stringify({ parse: { status: parseStatus, method: "tier1", originalAssetSha256: sha, warnings: [] } }));
  return docId;
}

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
  ledger = new DocumentOcrLedger(db);
});
afterEach(() => db.close());

describe("v49 마이그레이션", () => {
  const ocrTables = (target: Database) =>
    (target.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'document_ocr_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);

  test("새 DB 에 두 표가 생긴다", () => {
    expect(ocrTables(db)).toEqual(["document_ocr_daily_usage", "document_ocr_page_results"]);
  });

  test("기존 v48 DB 도 같은 up() 으로 올라간다", () => {
    const old = new Database(":memory:");
    sqliteVec.load(old);
    old.run("PRAGMA foreign_keys = ON");
    runMigrations(old, MIGRATIONS.filter((m) => m.version < 49), DIM);
    expect(ocrTables(old)).toEqual([]);
    runMigrations(old, MIGRATIONS, DIM);
    expect(ocrTables(old)).toEqual(["document_ocr_daily_usage", "document_ocr_page_results"]);
    old.close();
  });

  test("상태 CHECK 는 모르는 값을 거절한다", () => {
    const doc = insertDocument(db, "check");
    expect(() =>
      db.run(
        `INSERT INTO document_ocr_page_results (document_id, page_index, page_count, input_fingerprint, status, updated_at)
         VALUES (?, 0, 1, 'f', 'bogus', 'x')`,
        [doc],
      ),
    ).toThrow("CHECK constraint failed");
  });
});

describe("상태 전이", () => {
  test("성공은 시도 수를 0 으로 되돌리고 사용량이 없으면 NULL 로 남긴다", () => {
    const doc = insertDocument(db, "ok");
    ledger.recordDeterministic(doc, 0, 2, "fp", "잘림", 3, "2026-10-11 01:00:00");
    ledger.recordCompleted(doc, 0, 2, "fp", "# 쪽 1", null);
    const [row] = ledger.rowsForDocument(doc);
    expect(row!.status).toBe("completed");
    expect(row!.attemptCount).toBe(0);
    expect(row!.markdown).toBe("# 쪽 1");
    expect(row!.inputTokens).toBeNull();
    expect(row!.outputTokens).toBeNull();
    ledger.recordCompleted(doc, 1, 2, "fp", "쪽 2", { inputTokens: 1700, outputTokens: 900 });
    expect(ledger.rowsForDocument(doc)[1]!.outputTokens).toBe(900);
  });

  test("일시 실패는 몇 번이 돼도 terminal 이 되지 않고 시도 수가 늘지 않는다", () => {
    const doc = insertDocument(db, "tr");
    for (let i = 0; i < 10; i += 1) ledger.recordTransient(doc, 0, 1, "fp", "503", "2026-10-11 01:00:00");
    const [row] = ledger.rowsForDocument(doc);
    expect(row!.status).toBe("retryable_failure");
    expect(row!.attemptCount).toBe(0);
    expect(row!.nextRetryAt).toBe("2026-10-11 01:00:00");
  });

  test("결정적 실패는 상한에서 terminal, 재시도 시각을 비운다", () => {
    const doc = insertDocument(db, "det");
    expect(ledger.recordDeterministic(doc, 0, 1, "fp", "잘림", 3, "t1")).toEqual({ status: "retryable_failure", attemptCount: 1 });
    expect(ledger.recordDeterministic(doc, 0, 1, "fp", "잘림", 3, "t2")).toEqual({ status: "retryable_failure", attemptCount: 2 });
    expect(ledger.recordDeterministic(doc, 0, 1, "fp", "잘림", 3, "t3")).toEqual({ status: "terminal_failure", attemptCount: 3 });
    expect(ledger.rowsForDocument(doc)[0]!.nextRetryAt).toBeNull();
  });

  test("지문이 바뀌면 시도 수를 1 부터 다시 센다", () => {
    const doc = insertDocument(db, "fpchange");
    ledger.recordDeterministic(doc, 0, 1, "fpA", "e", 3, "t");
    ledger.recordDeterministic(doc, 0, 1, "fpA", "e", 3, "t");
    expect(ledger.recordDeterministic(doc, 0, 1, "fpB", "e", 3, "t").attemptCount).toBe(1);
  });

  test("pageDecision — 처리/재사용/대기/terminal, 지문 변경은 다시 평가", () => {
    const doc = insertDocument(db, "dec");
    const now = "2026-10-11 10:00:00";
    expect(pageDecision(null, "fp", now)).toBe("process");
    ledger.recordCompleted(doc, 0, 3, "fp", "a", null);
    ledger.recordTransient(doc, 1, 3, "fp", "429", "2026-10-11 10:30:00");
    ledger.recordDeterministic(doc, 2, 3, "fp", "e", 1, "x");
    const [done, waiting, terminal] = ledger.rowsForDocument(doc);
    expect(pageDecision(done!, "fp", now)).toBe("reuse_completed");
    expect(pageDecision(waiting!, "fp", now)).toBe("wait_retry");
    expect(pageDecision(waiting!, "fp", "2026-10-11 10:30:01")).toBe("process");
    expect(pageDecision(terminal!, "fp", now)).toBe("terminal");
    expect(pageDecision(terminal!, "fp-new", now)).toBe("process");
    expect(pageDecision(done!, "fp-new", now)).toBe("process");
  });
});

describe("하루 사용량·정리·삭제", () => {
  test("하루 호출 수는 원자적으로 1씩 오르고 날짜별로 따로 센다", () => {
    expect(ledger.dailyCalls("2026-10-11")).toBe(0);
    expect(ledger.incrementDailyCalls("2026-10-11")).toBe(1);
    expect(ledger.incrementDailyCalls("2026-10-11")).toBe(2);
    expect(ledger.incrementDailyCalls("2026-10-12")).toBe(1);
    expect(ledger.dailyCalls("2026-10-11")).toBe(2);
  });

  test("문서를 영구 삭제하면 원장 행도 함께 지워진다(CASCADE)", () => {
    const doc = insertDocument(db, "del");
    ledger.recordCompleted(doc, 0, 1, "fp", "a", null);
    db.run("DELETE FROM documents WHERE document_id = ?", [doc]);
    expect(ledger.rowsForDocument(doc)).toEqual([]);
  });

  test("clearDocument·pruneNonCandidateDocuments — 후보가 아닌 문서 행만 지운다", () => {
    const keep = insertDocument(db, "keep", "ocr_failed");
    const done = insertDocument(db, "done", "ocr_succeeded");
    ledger.recordCompleted(keep, 0, 1, "fp", "a", null);
    ledger.recordCompleted(done, 0, 1, "fp", "a", null);
    expect(ledger.pruneNonCandidateDocuments(["needs_ocr", "parse_failed", "ocr_failed"])).toBe(1);
    expect(ledger.rowsForDocument(keep).length).toBe(1);
    expect(ledger.rowsForDocument(done)).toEqual([]);
    ledger.clearDocument(keep);
    expect(ledger.rowsForDocument(keep)).toEqual([]);
  });

  test("queueSummary — 대기·terminal 문서 수와 진행 쪽 수", () => {
    const a = insertDocument(db, "qa");
    const b = insertDocument(db, "qb");
    ledger.recordCompleted(a, 0, 3, "fp", "x", null);
    ledger.recordTransient(a, 1, 3, "fp", "503", "t");
    ledger.recordDeterministic(b, 0, 1, "fp", "e", 1, "t");
    expect(ledger.queueSummary()).toEqual({
      waitingRetry: 1,
      terminal: 1,
      inProgress: [{ documentId: a, completedPages: 1, pageCount: 3 }],
    });
  });
});
