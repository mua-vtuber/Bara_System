/**
 * 기억 전체 초기화가 MCP 호출 횟수 표(v52)를 비우는지 (2026-10-21 spec 7.1·P9, A-T8 보강).
 * stats-repository.reset.test.ts 는 파일 DB 라 Windows 에서 임시 폴더 삭제(EBUSY)로 실패하므로, 메모리 DB 로 이 표만 따로 확인한다.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { StatsRepository } from "../db/store-internal/stats-repository.ts";
import { McpUsageRecorder } from "./usage-recorder.ts";

let db: Database;
beforeEach(() => { db = openMemoryDatabase(":memory:", { embeddingDim: 1024 }); });
afterEach(() => db.close());

test("resetAllMemory 는 mcp_tool_usage_daily 를 비우고 boundary 에 센다", () => {
  const recorder = new McpUsageRecorder(() => db);
  recorder.record({ client: "claude-code", kind: "tool", name: "search_memory", outcome: "ok" });
  recorder.record({ client: "claude-code", kind: "handshake", name: "initialize", outcome: "ok" });
  const count = () => (db.query("SELECT COUNT(*) AS c FROM mcp_tool_usage_daily").get() as { c: number }).c;
  expect(count()).toBe(2);

  const summary = new StatsRepository(db, new Bgem3Embedder()).resetAllMemory();

  expect(count()).toBe(0);
  expect(summary.boundary).toBeGreaterThanOrEqual(2);
});
