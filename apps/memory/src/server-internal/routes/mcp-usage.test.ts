/**
 * routes/mcp-usage + summarizeMcpUsage — 요약 순수 함수(fixture 줄)와 실제 SQLite·실제 Hono·실제 인증 문 위의 라우트
 * (2026-10-21 mcp-usage-and-guidance spec 9.1, A-T5). 모델은 부르지 않는다.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { SseTokenStore, type TokenScope } from "../../federation/sse-tokens.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { TOOL_USAGE_CATEGORY } from "../../mcp/usage-categories.ts";
import { McpUsageRecorder } from "../../mcp/usage-recorder.ts";
import { summarizeMcpUsage, type McpUsageRow } from "../../mcp/usage-summary.ts";
import { createAuthGate } from "../auth-gate.ts";
import type { MemoryApiDeps } from "../types.ts";
import {
  MCP_USAGE_MAX_RANGE_DAYS,
  MCP_USAGE_NOT_COUNTED,
  MCP_USAGE_PATH,
  registerMcpUsageRoutes,
  validateUsageRange,
  type McpUsageResponse,
} from "./mcp-usage.ts";

const row = (day: string, client: string, kind: "tool" | "handshake", name: string, outcome: "ok" | "error", calls: number): McpUsageRow =>
  ({ day, client, kind, name, outcome, calls });

describe("summarizeMcpUsage", () => {
  const rows: McpUsageRow[] = [
    row("2026-10-21", "claude-code", "handshake", "initialize", "ok", 4),
    row("2026-10-21", "claude-code", "tool", "search_memory", "ok", 3),
    row("2026-10-21", "claude-code", "tool", "get_memory", "error", 1),
    row("2026-10-21", "claude-code", "tool", "store_memory", "ok", 2),
    row("2026-10-22", "claude-code", "tool", "store_memory", "ok", 2),
    row("2026-10-22", "claude-code", "tool", "mystery_tool", "ok", 5),
    row("2026-10-21", "pet", "handshake", "initialize", "ok", 1),
    row("2026-10-21", "pet", "tool", "cleanup_run_status", "ok", 2),
  ];
  const [claude, pet] = summarizeMcpUsage(rows, TOOL_USAGE_CATEGORY);

  test("클라이언트별로 활동일·연결 시작·분류별 횟수·오류를 센다", () => {
    expect(claude).toMatchObject({ client: "claude-code", activeDays: 2, handshakes: 4, errors: 1 });
    expect(claude!.calls).toEqual({ recall: 4, save: 4, correct: 0, cleanup: 0, diagnose: 0, guide: 0 });
  });

  test("비율: 저장 1회당 찾기, 찾기가 있던 날 비율, 연결 시작당 찾기", () => {
    expect(claude!.recallPerSave).toBe(1);
    expect(claude!.recallDayShare).toBe(0.5); // 이틀 중 첫날만 찾기가 있었다.
    expect(claude!.recallPerHandshake).toBe(1);
    expect(claude!.guidePerHandshake).toBe(0);
  });

  test("분모가 0 이면 0 이 아니라 null 이다", () => {
    expect(pet).toMatchObject({ client: "pet", recallPerSave: null, guidePerHandshake: 0 });
    const noHandshake = summarizeMcpUsage([row("2026-10-21", "x", "tool", "store_memory", "ok", 1)], TOOL_USAGE_CATEGORY)[0]!;
    expect(noHandshake.recallPerHandshake).toBeNull();
    expect(noHandshake.guidePerHandshake).toBeNull();
    expect(noHandshake.recallDayShare).toBe(0);
    expect(summarizeMcpUsage([], TOOL_USAGE_CATEGORY)).toEqual([]);
  });

  test("분류 맵에 없는 도구는 어느 분류에도 세지 않고 이름을 알린다", () => {
    expect(claude!.uncategorized).toEqual(["mystery_tool"]);
    expect(Object.values(claude!.calls).reduce((a, b) => a + b, 0)).toBe(8); // mystery_tool 5회 제외
  });
});

describe("validateUsageRange", () => {
  test("올바른 기간은 그대로 돌려준다", () => {
    expect(validateUsageRange("2026-10-01", "2026-10-21")).toEqual({ from: "2026-10-01", to: "2026-10-21" });
    expect(validateUsageRange("2026-10-21", "2026-10-21")).toEqual({ from: "2026-10-21", to: "2026-10-21" });
  });

  test.each([
    [undefined, "2026-10-21", "from"],
    ["2026-10-01", undefined, "to"],
    ["10/01/2026", "2026-10-21", "from"],
    ["2026-02-30", "2026-10-21", "from"],
    ["2026-10-01", "2026-13-01", "to"],
  ])("형식·달력이 틀리면 이유 문장 (%s, %s)", (from, to, which) => {
    const result = validateUsageRange(from, to);
    expect(typeof result).toBe("string");
    expect((result as string).startsWith(`${which} 값은 `)).toBe(true);
  });

  test("from > to 와 366일 초과는 거절, 366일은 허용", () => {
    expect(validateUsageRange("2026-10-21", "2026-10-01")).toContain("늦을 수 없음");
    expect(validateUsageRange("2025-10-20", "2026-10-21")).toContain(`최대 ${MCP_USAGE_MAX_RANGE_DAYS}일`); // 양끝 포함 367일
    expect(typeof validateUsageRange("2025-10-21", "2026-10-21")).toBe("object"); // 양끝 포함 366일
  });
});

describe("GET /api/mcp-usage", () => {
  let tmpDir: string;
  let db: Database;
  let app: Hono;
  let sseTokens: SseTokenStore;
  let recorder: McpUsageRecorder;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bara-mcp-usage-route-"));
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const embedder = new Bgem3Embedder();
    const store = new SqliteMemoryStore(db, embedder);
    const deps: MemoryApiDeps = { store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler() };
    sseTokens = new SseTokenStore(join(tmpDir, "tokens.json"));
    recorder = new McpUsageRecorder(() => db);
    app = new Hono();
    app.use("*", createAuthGate({ sseTokens, remoteAddrOf: () => "127.0.0.1", getMcpBodyLimit: () => 1_000_000 }));
    registerMcpUsageRoutes(app, deps, recorder);
    db.run(`INSERT INTO mcp_tool_usage_daily (day, client, kind, name, outcome, calls) VALUES
      ('2026-10-20', 'claude-code', 'tool', 'search_memory', 'ok', 2),
      ('2026-10-21', 'claude-code', 'tool', 'store_memory', 'ok', 1),
      ('2026-10-21', 'claude-code', 'handshake', 'initialize', 'ok', 1),
      ('2026-09-01', 'claude-code', 'tool', 'search_memory', 'ok', 9)`);
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function get(query: string, scope: TokenScope = "full"): Promise<Response> {
    const token = sseTokens.issueToken(`reader-${scope}`, undefined, undefined, scope);
    return Promise.resolve(app.request(`${MCP_USAGE_PATH}${query}`, { headers: { authorization: `Bearer ${token}` } }));
  }

  test("full 토큰: 기간 안의 줄만 담고 표 전체 줄 수·분류·요약·고정 안내를 싣는다", async () => {
    const res = await get("?from=2026-10-01&to=2026-10-31");
    expect(res.status).toBe(200);
    const body = (await res.json()) as McpUsageResponse;
    expect(body.range).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(body.rows.map((r) => `${r.day} ${r.name}`)).toEqual([
      "2026-10-20 search_memory", "2026-10-21 initialize", "2026-10-21 store_memory",
    ]);
    expect(body.totalRowsInTable).toBe(4);
    expect(body.categories).toEqual({ ...TOOL_USAGE_CATEGORY });
    expect(body.summary).toHaveLength(1);
    expect(body.summary[0]).toMatchObject({ client: "claude-code", activeDays: 2, handshakes: 1, recallPerSave: 2 });
    expect(body.notCounted).toEqual([...MCP_USAGE_NOT_COUNTED]);
  });

  test("counterHealth 에 기록 실패가 같은 응답으로 실린다", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    recorder.record({ client: undefined, kind: "tool", name: "t", outcome: "ok" });
    log.mockRestore();
    const body = (await (await get("?from=2026-10-01&to=2026-10-31")).json()) as McpUsageResponse;
    expect(body.counterHealth.writeFailures).toBe(1);
    expect(body.counterHealth.lastError).toContain("adapterId");
  });

  test("기간이 틀리면 400 과 이유, 기본값으로 채우지 않는다", async () => {
    for (const query of ["", "?from=2026-10-01", "?from=2026-10-21&to=2026-10-01", "?from=2020-01-01&to=2026-10-31"]) {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(typeof ((await res.json()) as { error: string }).error).toBe("string");
    }
  });

  test.each(["mcp-standard", "read-only"] as const)("%s 토큰은 403", async (scope) => {
    const res = await get("?from=2026-10-01&to=2026-10-31", scope);
    expect(res.status).toBe(403);
  });

  test("저장소가 주입되지 않으면 503 과 이유, 숫자를 지어내지 않는다", async () => {
    const bare = new Hono();
    bare.use("*", createAuthGate({ sseTokens, remoteAddrOf: () => "127.0.0.1", getMcpBodyLimit: () => 1_000_000 }));
    registerMcpUsageRoutes(bare, {} as unknown as MemoryApiDeps, recorder);
    const token = sseTokens.issueToken("reader-no-store", undefined, undefined, "full");
    const res = await bare.request(`${MCP_USAGE_PATH}?from=2026-10-01&to=2026-10-31`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
    expect("rows" in body).toBe(false);
  });

  test("토큰이 없으면 거절된다", async () => {
    const res = await app.request(`${MCP_USAGE_PATH}?from=2026-10-01&to=2026-10-31`);
    expect(res.status).toBe(401);
  });
});
