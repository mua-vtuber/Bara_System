/**
 * 백필 주기 가드 — 실제 SQLite + 실제 기록 표 (2026-10-14 backfill-retry-ledger spec 4.3·4.5).
 * 시간 판단은 모두 주입한 시계(NOW_MS) 하나로 돈다.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database as SqliteDatabase, type Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDatabase } from "../../db/migrations.ts";
import type { BackfillAttemptKind } from "../../db/store-internal/backfill-attempts-sql.ts";
import { pastCutoffInZone } from "../../db/store-internal/helpers.ts";
import { LlmRequestError } from "../../llm/errors.ts";
import { BackfillCycleGuard, formatRetrySummary } from "./cycle-guard.ts";
import { BackfillAttemptsLedger, type BackfillRetryPolicy } from "./ledger.ts";

const POLICY: BackfillRetryPolicy = { maxAttempts: 2, retryDelayMin: 30, retryMaxDelayMin: 1440 };
const PREFIX = "[guard.test]";
const TIMEOUT_MESSAGE = "Ollama /api/chat timeout (80ms 초과)";
/** 주기 시작 시각(epoch ms) — 모든 시간 판단이 이 시계 하나로 돈다. */
const NOW_MS = Date.UTC(2026, 9, 14, 0, 0, 0);

let db: Database;
let ledger: BackfillAttemptsLedger;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 8 });
  ledger = new BackfillAttemptsLedger(db);
});
afterEach(() => db.close());

function insertNodeIn(target: Database): number {
  return Number(
    target.query("INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES ('글', 'auto_capture', '2026-10-14 09:00:00')").run().lastInsertRowid,
  );
}

function insertNode(): number {
  return insertNodeIn(db);
}

function guardFor(kind: BackfillAttemptKind = "extraction"): BackfillCycleGuard {
  return new BackfillCycleGuard({ ledger, kind, policy: POLICY, logPrefix: PREFIX, clock: () => NOW_MS });
}

function target(nodeId: number, fingerprint = "fp") {
  return { targetKey: String(nodeId), nodeId, fingerprint, label: `node ${nodeId}` };
}

function llmError(status: number | null, timedOut: boolean, message: string): LlmRequestError {
  return new LlmRequestError({ provider: "ollama", message, status, code: null, retryAfterMs: null, timedOut });
}

function lines(spy: ReturnType<typeof spyOn>): string[] {
  return spy.mock.calls.map((call: unknown[]) => call.map(String).join(" "));
}

describe("실패 기록", () => {
  test("시간 초과를 상한까지 세면 멈춤이 되고 멈춤 줄을 한 번만 남긴다", () => {
    const id = insertNode();
    const errors = spyOn(console, "error");
    try {
      const guard = guardFor();
      expect(guard.recordFailure(target(id), llmError(null, true, TIMEOUT_MESSAGE))).toBe("continue");
      expect(guard.recordFailure(target(id), llmError(null, true, TIMEOUT_MESSAGE))).toBe("continue");
      expect(lines(errors).filter((l) => l.includes("stopped for"))).toEqual([
        `${PREFIX} backfill stopped for node ${id} after 2 attempts: ${TIMEOUT_MESSAGE}`,
      ]);
      expect(guard.summary()).toEqual({ retryWait: 0, stopped: 1, cycleStopped: null });
    } finally {
      errors.mockRestore();
    }
  });

  test("캡션 종류는 멈춤 줄 머리가 caption backfill 이다", () => {
    const id = insertNode();
    const errors = spyOn(console, "error");
    try {
      const guard = guardFor("caption");
      const ref = { targetKey: "a".repeat(64), nodeId: id, fingerprint: "fp", label: `node ${id} (asset aaa)` };
      guard.recordFailure(ref, new Error("빈 캡션"));
      guard.recordFailure(ref, new Error("빈 캡션"));
      expect(lines(errors)).toContain(`${PREFIX} caption backfill stopped for node ${id} (asset aaa) after 2 attempts: 빈 캡션`);
    } finally {
      errors.mockRestore();
    }
  });

  test.each([429, 503])("%i 는 기록하지 않고 계속한다", (status) => {
    const id = insertNode();
    const guard = guardFor();
    expect(guard.recordFailure(target(id), llmError(status, false, `status ${status}`))).toBe("continue");
    expect(ledger.rows("extraction")).toEqual([]);
    expect(guard.summary().cycleStopped).toBeNull();
  });

  test("연결 실패는 기록 없이 주기 중단(connection)", () => {
    const id = insertNode();
    const errors = spyOn(console, "error");
    try {
      const guard = guardFor();
      expect(guard.recordFailure(target(id), llmError(null, false, "네트워크 실패"))).toBe("stop");
      expect(ledger.rows("extraction")).toEqual([]);
      expect(guard.summary()).toEqual({ retryWait: 0, stopped: 0, cycleStopped: "connection" });
      expect(lines(errors).some((l) => l.includes("cycle stopped (connection)"))).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  test("401 은 기록 없이 주기 중단(config)하고 로그에 설정 문제라고 남긴다", () => {
    const id = insertNode();
    const errors = spyOn(console, "error");
    try {
      const guard = guardFor();
      expect(guard.recordFailure(target(id), llmError(401, false, "unauthorized"))).toBe("stop");
      expect(guard.summary().cycleStopped).toBe("config");
      expect(lines(errors).some((l) => l.includes("설정 문제(HTTP 401)"))).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  test("오류 문장의 키 모양은 가려서 남긴다", () => {
    const id = insertNode();
    guardFor().recordFailure(target(id), new Error("bad key sk-ant-abcdef1234567890"));
    const row = ledger.get("extraction", String(id))!;
    expect(row.lastError).not.toContain("sk-ant-");
    expect(row.lastError).toContain("[가림]");
  });

  test("recordSuccess 는 그 대상 줄만 지운다", () => {
    const a = insertNode();
    const b = insertNode();
    const guard = guardFor();
    guard.recordFailure(target(a), new Error("e"));
    guard.recordFailure(target(b), new Error("e"));
    guard.recordSuccess(String(a), `node ${a}`);
    expect(ledger.rows("extraction").map((r) => r.nodeId)).toEqual([b]);
  });

  test("센 실패의 마지막 시도·다음 시도 시각은 주입한 시계에서 계산한다", () => {
    const id = insertNode();
    guardFor().recordFailure(target(id), new Error("e"));
    const row = ledger.get("extraction", String(id))!;
    expect(row.lastAttemptAt).toBe(pastCutoffInZone(NOW_MS));
    expect(row.nextRetryAt).toBe(pastCutoffInZone(NOW_MS + POLICY.retryDelayMin * 60_000));
  });

  test("막힘 기준 시각은 생성 때 값으로 고정되고, 다음 시도 시각은 실패 순간의 시계에서 계산한다", () => {
    const id = insertNode();
    let clockMs = NOW_MS;
    const guard = new BackfillCycleGuard({ ledger, kind: "extraction", policy: POLICY, logPrefix: PREFIX, clock: () => clockMs });
    const FAILURE_OFFSET_MS = 45 * 60_000;
    clockMs += FAILURE_OFFSET_MS; // 주기가 길어져 실패가 주기 시작 45분 뒤에 났다
    guard.recordFailure(target(id), new Error("e"));
    expect(guard.now).toBe(pastCutoffInZone(NOW_MS));
    const row = ledger.get("extraction", String(id))!;
    expect(row.lastAttemptAt).toBe(pastCutoffInZone(NOW_MS + FAILURE_OFFSET_MS));
    expect(row.nextRetryAt).toBe(pastCutoffInZone(NOW_MS + FAILURE_OFFSET_MS + POLICY.retryDelayMin * 60_000));
  });
});

describe("주기 시작 정리(reconcile)", () => {
  test("후보가 아니면 지우고, 지문이 다르면 지우고, 같으면 남긴다 — 다른 종류는 건드리지 않는다", async () => {
    const gone = insertNode();
    const edited = insertNode();
    const same = insertNode();
    const setup = guardFor();
    setup.recordFailure(target(gone, "fp-gone"), new Error("e"));
    setup.recordFailure(target(edited, "fp-old"), new Error("e"));
    setup.recordFailure(target(same, "fp-same"), new Error("e"));
    guardFor("caption").recordFailure({ targetKey: "sha", nodeId: gone, fingerprint: "x", label: "c" }, new Error("e"));

    const current = new Map<number, string | null>([[gone, null], [edited, "fp-new"], [same, "fp-same"]]);
    const result = await guardFor().reconcile(async (row) => current.get(row.nodeId) ?? null);
    expect(result).toEqual({ pruned: 1, fingerprintCleared: 1 });
    expect(ledger.rows("extraction").map((r) => r.nodeId)).toEqual([same]);
    expect(ledger.rows("caption")).toHaveLength(1);
  });

  test("now 는 주입한 시계를 설정 시간대 문자열로 바꾼 값이다", () => {
    expect(guardFor().now).toBe(pastCutoffInZone(NOW_MS));
  });
});

describe("요약 줄", () => {
  test("주기 중단이 없으면 두 수만, 있으면 사유를 덧붙인다", () => {
    expect(formatRetrySummary({ retryWait: 1, stopped: 2, cycleStopped: null })).toBe("retry-wait 1, stopped 2");
    expect(formatRetrySummary({ retryWait: 0, stopped: 0, cycleStopped: "config" })).toBe("retry-wait 0, stopped 0, cycle-stopped(config)");
    expect(formatRetrySummary({ retryWait: 0, stopped: 0, cycleStopped: "ledger_write_failed" })).toBe(
      "retry-wait 0, stopped 0, cycle-stopped(ledger_write_failed)",
    );
  });
});

describe("기록 표 쓰기 실패(ledger_write_failed)", () => {
  test("다른 연결이 쓰기 잠금을 쥐고 있어 기록이 실패하면 크게 알리고 주기를 멈춘다", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-lock-"));
    const path = join(dir, "lock.db");
    const main = openMemoryDatabase(path, { embeddingDim: 8 });
    const other = new SqliteDatabase(path);
    const errors = spyOn(console, "error");
    try {
      main.run("PRAGMA busy_timeout = 0");
      const id = insertNodeIn(main);
      const lockedLedger = new BackfillAttemptsLedger(main);
      const guard = new BackfillCycleGuard({ ledger: lockedLedger, kind: "extraction", policy: POLICY, logPrefix: PREFIX, clock: () => NOW_MS });
      other.run("BEGIN IMMEDIATE");
      expect(guard.recordFailure(target(id), new Error("원래 실패 문장"))).toBe("stop");
      expect(guard.summary().cycleStopped).toBe("ledger_write_failed");
      other.run("ROLLBACK");
      expect(lockedLedger.rows("extraction")).toEqual([]);
      const logged = lines(errors).join("\n");
      expect(logged).toContain(`node ${id}`);
      expect(logged).toContain("원래 실패 문장");
      expect(logged).toMatch(/database is locked|SQLITE_BUSY/i);
    } finally {
      errors.mockRestore();
      other.close();
      main.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("성공 뒤 지난 줄 지우기가 잠금으로 실패하면 던지지 않고 크게 알리며 주기를 멈추고 줄은 그대로 남는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-lock-"));
    const path = join(dir, "lock.db");
    const main = openMemoryDatabase(path, { embeddingDim: 8 });
    const other = new SqliteDatabase(path);
    const errors = spyOn(console, "error");
    try {
      const id = insertNodeIn(main);
      const lockedLedger = new BackfillAttemptsLedger(main);
      const guard = new BackfillCycleGuard({ ledger: lockedLedger, kind: "extraction", policy: POLICY, logPrefix: PREFIX, clock: () => NOW_MS });
      expect(guard.recordFailure(target(id), new Error("이전 실패"))).toBe("continue");
      main.run("PRAGMA busy_timeout = 0");
      other.run("BEGIN IMMEDIATE");
      expect(() => guard.recordSuccess(String(id), `node ${id}`)).not.toThrow();
      expect(guard.isStopped).toBe(true);
      expect(guard.summary().cycleStopped).toBe("ledger_write_failed");
      other.run("ROLLBACK");
      expect(lockedLedger.rows("extraction")).toHaveLength(1);
      const logged = lines(errors).join("\n");
      expect(logged).toContain(`node ${id}`);
      expect(logged).toContain("저장은 성공했지만");
      expect(logged).toMatch(/database is locked|SQLITE_BUSY/i);
    } finally {
      errors.mockRestore();
      other.close();
      main.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
