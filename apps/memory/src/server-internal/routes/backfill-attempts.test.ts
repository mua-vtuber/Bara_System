/**
 * routes/backfill-attempts — 백필 실패 기록 상태 조회·다시 시도 API (2026-10-14 backfill-retry-ledger spec 5장).
 * 실제 SQLite + 실제 기록 표 + 실제 Hono 앱 + 실제 인증 문(createAuthGate, 실제 토큰 파일). 모델은 부르지 않는다.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { pastCutoffInZone } from "../../db/store-internal/helpers.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { SseTokenStore, type TokenScope } from "../../federation/sse-tokens.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import {
  BACKFILL_ATTEMPTS_RETRY_PATH,
  BACKFILL_ATTEMPTS_STATUS_PATH,
  type BackfillAttemptKind,
  type BackfillAttemptsStatusResponse,
} from "../../memory/backfill-attempts/contract.ts";
import {
  BACKFILL_STATUS_MAX_ITEMS,
  BACKFILL_STATUS_PREVIEW_CHARS,
  BackfillAttemptsLedger,
  type BackfillRetryPolicy,
} from "../../memory/backfill-attempts/ledger.ts";
import { createAuthGate } from "../auth-gate.ts";
import type { MemoryApiDeps } from "../types.ts";
import { registerBackfillAttemptsRoutes } from "./backfill-attempts.ts";

const POLICY: BackfillRetryPolicy = { maxAttempts: 2, retryDelayMin: 30, retryMaxDelayMin: 1440 };
// 기록 시각(fail)과 막힘 판정(candidateIds)이 같은 주입 시계 T0 를 쓴다 — 실제 시각에 의존하지 않는다.
const T0 =Date.UTC(2026, 9, 14, 0, 0, 0);

let db: Database;
let deps: MemoryApiDeps;
let app: Hono;
let ledger: BackfillAttemptsLedger;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const embedder = new Bgem3Embedder();
  const store = new SqliteMemoryStore(db, embedder);
  deps = { store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler() };
  app = new Hono();
  registerBackfillAttemptsRoutes(app, deps);
  ledger = new BackfillAttemptsLedger(db);
});
afterEach(() => db.close());

function insertMemo(content: string): number {
  return Number(
    db.query("INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES (?, 'auto_capture', '2026-10-14 09:00:00')").run(content).lastInsertRowid,
  );
}

function fail(nodeId: number, times = 1, opts: { kind?: BackfillAttemptKind; targetKey?: string; nowMs?: number } = {}): void {
  for (let i = 0; i < times; i += 1) {
    ledger.recordCounted(
      { kind: opts.kind ?? "extraction", targetKey: opts.targetKey ?? String(nodeId), nodeId, fingerprint: "fp", error: `실패 ${nodeId}`, policy: POLICY },
      opts.nowMs ?? T0,
    );
  }
}

function status(kind: string): Promise<Response> {
  return Promise.resolve(app.request(`${BACKFILL_ATTEMPTS_STATUS_PATH}?kind=${encodeURIComponent(kind)}`));
}

function retry(body: unknown): Promise<Response> {
  return Promise.resolve(app.request(BACKFILL_ATTEMPTS_RETRY_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

async function candidateIds(): Promise<number[]> {
  return (await deps.store.getBackfillCandidates({ limit: 10, excludeBlockedAt: pastCutoffInZone(T0) })).map((n) => n.id);
}

describe("GET 상태", () => {
  test("응답 모양 — 대기·멈춤 수, 멈춤 먼저인 목록, 앞부분 60자", async () => {
    const stopped = insertMemo("가".repeat(70));
    const waiting = insertMemo("대기 중인 기억");
    fail(stopped, 2, { nowMs: T0 });
    fail(waiting, 1, { nowMs: T0 + 60_000 });
    const res = await status("extraction");
    expect(res.status).toBe(200);
    const body = (await res.json()) as BackfillAttemptsStatusResponse;
    expect(body).toMatchObject({ kind: "extraction", waitingRetry: 1, stopped: 1, truncated: false });
    expect(body.items.map((i) => [i.nodeId, i.status])).toEqual([[stopped, "terminal_failure"], [waiting, "retryable_failure"]]);
    expect(body.items[0]).toMatchObject({
      targetKey: String(stopped), preview: "가".repeat(BACKFILL_STATUS_PREVIEW_CHARS), attemptCount: 2, lastError: `실패 ${stopped}`, nextRetryAt: null,
    });
    expect(typeof body.items[1]!.nextRetryAt).toBe("string");
  });

  test("다른 종류의 줄은 섞이지 않는다", async () => {
    const id = insertMemo("이미지");
    fail(id, 1, { kind: "caption", targetKey: "a".repeat(64) });
    expect(((await (await status("extraction")).json()) as BackfillAttemptsStatusResponse).items).toEqual([]);
    expect(((await (await status("caption")).json()) as BackfillAttemptsStatusResponse).items.map((i) => i.targetKey)).toEqual(["a".repeat(64)]);
  });

  test("최대 수를 넘으면 그만큼과 truncated=true", async () => {
    db.transaction(() => {
      for (let i = 0; i <= BACKFILL_STATUS_MAX_ITEMS; i += 1) fail(insertMemo(`글 ${i}`));
    })();
    const body = (await (await status("extraction")).json()) as BackfillAttemptsStatusResponse;
    expect(body.items).toHaveLength(BACKFILL_STATUS_MAX_ITEMS);
    expect(body.truncated).toBe(true);
  });

  test("모르는 kind·빠진 kind 는 400 과 이유", async () => {
    const bad = await status("bogus");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'kind 는 extraction | caption 중 하나여야 함 (받은 값: "bogus")' });
    const missing = await app.request(BACKFILL_ATTEMPTS_STATUS_PATH);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "kind 는 extraction | caption 중 하나여야 함 (받은 값: 없음)" });
  });
});

describe("POST 다시 시도", () => {
  test("고른 줄만 지우고 지운 수를 돌려준다 — 다음 주기에 다시 후보가 된다", async () => {
    const a = insertMemo("가");
    const b = insertMemo("나");
    fail(a, 2);
    fail(b, 1);
    expect(await candidateIds()).toEqual([]);
    const res = await retry({ kind: "extraction", targetKeys: [String(a)] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: 1 });
    expect(await candidateIds()).toEqual([a]);
  });

  test("all:true 는 그 종류의 대기·멈춤 줄을 모두 지우고 다른 종류는 남긴다", async () => {
    const a = insertMemo("가");
    const b = insertMemo("나");
    fail(a, 2);
    fail(b, 1);
    fail(a, 1, { kind: "caption", targetKey: "c".repeat(64) });
    expect(await (await retry({ kind: "extraction", all: true })).json()).toEqual({ cleared: 2 });
    expect(ledger.rows("extraction")).toEqual([]);
    expect(ledger.rows("caption")).toHaveLength(1);
  });

  const BAD_BODIES: Array<[string, unknown, string]> = [
    ["JSON 이 아님", "{", "본문이 JSON 이 아님"],
    ["객체가 아님", [1], "본문은 { kind, targetKeys } 또는 { kind, all: true } 객체여야 함"],
    ["모르는 kind", { kind: "x", all: true }, 'kind 는 extraction | caption 중 하나여야 함 (받은 값: "x")'],
    ["targetKeys 와 all 을 함께", { kind: "extraction", targetKeys: ["1"], all: true }, "targetKeys 와 all 은 함께 보낼 수 없음"],
    ["둘 다 없음", { kind: "extraction" }, "targetKeys 또는 all 중 하나가 필요함"],
    ["빈 targetKeys", { kind: "extraction", targetKeys: [] }, "targetKeys 는 비어 있지 않은 배열이어야 함"],
    ["문자열 아닌 원소", { kind: "extraction", targetKeys: [1] }, "targetKeys 의 원소는 모두 빈 문자열이 아닌 문자열이어야 함"],
    ["all 이 true 가 아님", { kind: "extraction", all: false }, "all 은 true 여야 함"],
  ];
  test.each(BAD_BODIES)("잘못된 본문은 400 — %s", async (_name, body, message) => {
    const res = await retry(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: message });
  });
});

describe("권한 — full 토큰만", () => {
  test("read-only·mcp-standard 는 상태·다시 시도 모두 403, full 은 통과", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bara-backfill-auth-"));
    try {
      const tokens = new SseTokenStore(join(dir, "tokens.json"));
      const gated = new Hono({ strict: false });
      gated.use("*", createAuthGate({ sseTokens: tokens, remoteAddrOf: () => "127.0.0.1", getMcpBodyLimit: () => 8 * 1024 * 1024 }));
      registerBackfillAttemptsRoutes(gated, deps);
      const issued = {} as Record<TokenScope, string>;
      for (const scope of ["read-only", "mcp-standard", "full"] as const) {
        issued[scope] = tokens.issueToken(scope, undefined, undefined, scope);
      }
      const call = (scope: TokenScope, path: string, init: RequestInit = {}) =>
        gated.request(path, { ...init, headers: { Authorization: `Bearer ${issued[scope]}`, "content-type": "application/json" } });
      const body = JSON.stringify({ kind: "extraction", all: true });
      for (const scope of ["read-only", "mcp-standard"] as const) {
        expect((await call(scope, `${BACKFILL_ATTEMPTS_STATUS_PATH}?kind=extraction`)).status).toBe(403);
        expect((await call(scope, BACKFILL_ATTEMPTS_RETRY_PATH, { method: "POST", body })).status).toBe(403);
      }
      expect((await call("full", `${BACKFILL_ATTEMPTS_STATUS_PATH}?kind=extraction`)).status).toBe(200);
      expect((await call("full", BACKFILL_ATTEMPTS_RETRY_PATH, { method: "POST", body })).status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
