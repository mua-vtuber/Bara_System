/**
 * 백필 실패 기록 모듈 — 실제 SQLite + 실제 마이그레이션(v50) (2026-10-14 backfill-retry-ledger spec 4.1·4.4·5장).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { pastCutoffInZone } from "../../db/store-internal/helpers.ts";
import type { BackfillAttemptKind } from "../../db/store-internal/backfill-attempts-sql.ts";
import {
  BACKFILL_RETRY_BACKOFF_FACTOR,
  BACKFILL_STATUS_MAX_ITEMS,
  BACKFILL_STATUS_PREVIEW_CHARS,
  BackfillAttemptsLedger,
  backfillRetryDelayMinutes,
  type BackfillRetryPolicy,
} from "./ledger.ts";

const POLICY: BackfillRetryPolicy = { maxAttempts: 5, retryDelayMin: 30, retryMaxDelayMin: 1440 };
const MINUTE_MS = 60_000;
const T0 = Date.UTC(2026, 9, 14, 0, 0, 0);

let db: Database;
let ledger: BackfillAttemptsLedger;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 8 });
  ledger = new BackfillAttemptsLedger(db);
});
afterEach(() => db.close());

function insertNode(content = "글"): number {
  return Number(
    db.query("INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES (?, 'auto_capture', '2026-10-14 09:00:00')").run(content).lastInsertRowid,
  );
}

function counted(nodeId: number, opts: { fingerprint?: string; error?: string; nowMs?: number; kind?: BackfillAttemptKind; targetKey?: string } = {}) {
  return ledger.recordCounted(
    {
      kind: opts.kind ?? "extraction",
      targetKey: opts.targetKey ?? String(nodeId),
      nodeId,
      fingerprint: opts.fingerprint ?? "fp",
      error: opts.error ?? "timeout",
      policy: POLICY,
    },
    opts.nowMs ?? T0,
  );
}

describe("간격 — min(시작 x 4^(n-1), 최대)", () => {
  test("기본값이면 30분 → 2시간 → 8시간 → 24시간 → 24시간", () => {
    expect(BACKFILL_RETRY_BACKOFF_FACTOR).toBe(4);
    expect([1, 2, 3, 4, 5].map((n) => backfillRetryDelayMinutes(n, POLICY))).toEqual([30, 120, 480, 1440, 1440]);
  });

  test("시도 횟수가 1 미만 정수가 아니면 칸 이름을 대며 멈춘다", () => {
    expect(() => backfillRetryDelayMinutes(0, POLICY)).toThrow("attemptCount");
    expect(() => backfillRetryDelayMinutes(1.5, POLICY)).toThrow("attemptCount");
  });
});

describe("세는 실패 기록", () => {
  test("첫 실패는 1회·30분 뒤, 같은 지문의 두 번째는 2회·2시간 뒤", () => {
    const id = insertNode();
    expect(counted(id, { error: "e1" })).toEqual({
      status: "retryable_failure", attemptCount: 1, nextRetryAt: pastCutoffInZone(T0 + 30 * MINUTE_MS),
    });
    expect(counted(id, { error: "e2" })).toEqual({
      status: "retryable_failure", attemptCount: 2, nextRetryAt: pastCutoffInZone(T0 + 120 * MINUTE_MS),
    });
    expect(ledger.get("extraction", String(id))).toMatchObject({
      nodeId: id, inputFingerprint: "fp", attemptCount: 2, lastError: "e2", lastAttemptAt: pastCutoffInZone(T0),
    });
  });

  test("상한(maxAttempts)에 닿으면 멈춤이 되고 다음 시도 시각은 NULL", () => {
    const id = insertNode();
    for (let i = 1; i < POLICY.maxAttempts; i += 1) counted(id);
    expect(counted(id)).toEqual({ status: "terminal_failure", attemptCount: POLICY.maxAttempts, nextRetryAt: null });
  });

  test("지문이 바뀌면 1 부터 다시 센다", () => {
    const id = insertNode();
    counted(id, { fingerprint: "old" });
    counted(id, { fingerprint: "old" });
    expect(counted(id, { fingerprint: "new" }).attemptCount).toBe(1);
    expect(ledger.get("extraction", String(id))!.inputFingerprint).toBe("new");
  });
});

function terminal(nodeId: number, opts: { fingerprint?: string; error?: string; nowMs?: number } = {}) {
  return ledger.recordTerminal(
    {
      kind: "extraction", targetKey: String(nodeId), nodeId,
      fingerprint: opts.fingerprint ?? "fp", error: opts.error ?? "잘림",
    },
    opts.nowMs ?? T0,
  );
}

describe("즉시 멈춤 기록(recordTerminal)", () => {
  test("첫 기록은 멈춤·1회·다음 시도 시각 NULL", () => {
    const id = insertNode();
    expect(terminal(id)).toEqual({ status: "terminal_failure", attemptCount: 1, nextRetryAt: null });
    expect(ledger.get("extraction", String(id))).toMatchObject({
      status: "terminal_failure", attemptCount: 1, nextRetryAt: null, lastError: "잘림", lastAttemptAt: pastCutoffInZone(T0),
    });
  });

  test("같은 지문이면 횟수 +1, 다른 지문이면 1", () => {
    const id = insertNode();
    terminal(id, { fingerprint: "a" });
    expect(terminal(id, { fingerprint: "a" }).attemptCount).toBe(2);
    expect(terminal(id, { fingerprint: "b" }).attemptCount).toBe(1);
    expect(ledger.get("extraction", String(id))!.inputFingerprint).toBe("b");
  });

  test("이미 대기 줄이던 대상이 멈춤으로 바뀐다(같은 지문이면 횟수는 이어서 센다)", () => {
    const id = insertNode();
    counted(id);
    expect(ledger.get("extraction", String(id))!.status).toBe("retryable_failure");
    expect(terminal(id)).toEqual({ status: "terminal_failure", attemptCount: 2, nextRetryAt: null });
    expect(ledger.get("extraction", String(id))).toMatchObject({ status: "terminal_failure", nextRetryAt: null });
  });

  test("counts()·status() 가 멈춤으로 센다", () => {
    const id = insertNode();
    terminal(id);
    expect(ledger.counts("extraction")).toEqual({ waitingRetry: 0, stopped: 1 });
    expect(ledger.status("extraction")).toMatchObject({ stopped: 1, waitingRetry: 0 });
    expect(ledger.status("extraction").items[0]).toMatchObject({ status: "terminal_failure", nextRetryAt: null });
  });
});

describe("지우기·세기", () => {
  test("clear 는 그 종류의 그 줄만 지우고, 다른 종류의 같은 열쇠는 남긴다", () => {
    const id = insertNode();
    counted(id, { kind: "extraction", targetKey: "k" });
    counted(id, { kind: "caption", targetKey: "k" });
    expect(ledger.clear("extraction", "k")).toBe(true);
    expect(ledger.clear("extraction", "k")).toBe(false);
    expect(ledger.get("caption", "k")).not.toBeNull();
  });

  test("clearTargets 는 고른 줄만, clearKind 는 그 종류 줄만 지운다", () => {
    const a = insertNode();
    const b = insertNode();
    const c = insertNode();
    counted(a);
    counted(b);
    counted(c);
    counted(a, { kind: "caption", targetKey: "sha-a" });
    expect(ledger.clearTargets("extraction", [String(a), String(b), "없는-열쇠"])).toBe(2);
    expect(ledger.rows("extraction").map((r) => r.nodeId)).toEqual([c]);
    expect(ledger.clearKind("extraction")).toBe(1);
    expect(ledger.rows("caption")).toHaveLength(1);
  });

  test("counts 는 종류별 대기·멈춤 수", () => {
    const a = insertNode();
    const b = insertNode();
    counted(a);
    for (let i = 0; i < POLICY.maxAttempts; i += 1) counted(b);
    expect(ledger.counts("extraction")).toEqual({ waitingRetry: 1, stopped: 1 });
    expect(ledger.counts("caption")).toEqual({ waitingRetry: 0, stopped: 0 });
  });
});

describe("상태 목록", () => {
  test("멈춤 먼저, 그다음 대기를 마지막 시도 최신 순으로, 앞부분은 60자", () => {
    const stopped = insertNode("가".repeat(70));
    const older = insertNode("오래된 대기");
    const newer = insertNode("최근 대기");
    for (let i = 0; i < POLICY.maxAttempts; i += 1) counted(stopped, { nowMs: T0 });
    counted(older, { nowMs: T0 + MINUTE_MS });
    counted(newer, { nowMs: T0 + 2 * MINUTE_MS });
    const status = ledger.status("extraction");
    expect(status).toMatchObject({ kind: "extraction", waitingRetry: 2, stopped: 1, truncated: false });
    expect(status.items.map((i) => i.nodeId)).toEqual([stopped, newer, older]);
    expect(status.items[0]).toEqual({
      targetKey: String(stopped), nodeId: stopped, preview: "가".repeat(BACKFILL_STATUS_PREVIEW_CHARS),
      attemptCount: POLICY.maxAttempts, lastError: "timeout", lastAttemptAt: pastCutoffInZone(T0),
      status: "terminal_failure", nextRetryAt: null,
    });
  });

  test("최대 수를 넘으면 그만큼만 담고 truncated=true", () => {
    db.transaction(() => {
      for (let i = 0; i <= BACKFILL_STATUS_MAX_ITEMS; i += 1) counted(insertNode(`글 ${i}`));
    })();
    const status = ledger.status("extraction");
    expect(status.items).toHaveLength(BACKFILL_STATUS_MAX_ITEMS);
    expect(status.truncated).toBe(true);
    expect(status.waitingRetry).toBe(BACKFILL_STATUS_MAX_ITEMS + 1);
  });
});
