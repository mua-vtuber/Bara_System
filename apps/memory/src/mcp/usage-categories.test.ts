/**
 * mcp/usage-categories — 분류 맵의 키가 실제 tools/list 이름과 같은지 (2026-10-21 spec 7.2, A-T4).
 * 실제 MCP 서버(전체 권한)를 SDK 클라이언트로 열어 목록을 받는다. 도구는 부르지 않아 모델이 필요 없다.
 * 연결을 시작하면 기록기가 연결 시작 1회를 기록하므로, 실제 마이그레이션을 거친 메모리 DB 를 준다.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openMemoryDatabase } from "../db/migrations.ts";
import { EMBEDDING_DIMENSIONS } from "../embedding/factory.ts";
import type { MemoryApiDeps } from "../server-internal/types.ts";
import { buildBaraMcpServer } from "./server.ts";
import { McpUsageRecorder } from "./usage-recorder.ts";
import { TOOL_USAGE_CATEGORIES, TOOL_USAGE_CATEGORY } from "./usage-categories.ts";

async function listedToolNames(): Promise<string[]> {
  const db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"] });
  const usage = new McpUsageRecorder(() => db);
  const server = buildBaraMcpServer({ deps: {} as unknown as MemoryApiDeps, adapterId: "t", scope: "full", usage });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "t", version: "0.0.1" });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  // 목록 조회는 도구 호출이 아니라 세지 않고, 연결 시작만 1회 기록된다(기록 실패 없음).
  const rows = db.query("SELECT kind, name, calls FROM mcp_tool_usage_daily").all();
  expect(rows).toEqual([{ kind: "handshake", name: "initialize", calls: 1 }]);
  expect(usage.health().writeFailures).toBe(0);
  db.close();
  return tools.map((t) => t.name);
}

describe("도구 분류 맵", () => {
  test("키 집합이 실제 tools/list 이름 집합과 같다", async () => {
    const listed = (await listedToolNames()).sort();
    expect(Object.keys(TOOL_USAGE_CATEGORY).sort()).toEqual(listed);
  });

  test("값은 모두 알려진 분류다", () => {
    for (const category of Object.values(TOOL_USAGE_CATEGORY)) {
      expect(TOOL_USAGE_CATEGORIES).toContain(category);
    }
  });
});
