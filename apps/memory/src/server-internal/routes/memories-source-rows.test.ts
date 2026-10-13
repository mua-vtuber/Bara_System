/**
 * memories-source-rows.test.ts — 실제 REST·MCP 저장이 기억 노드의 출처 행을 남긴다(WP-B1-20T T2).
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 실제 Hono 라우트(인증 관문 포함, Bun.serve 루프백) + 실제 MCP
 * 서버·클라이언트(StreamableHTTP). 출처 행은 실제 NodeSourceRepository 로 읽는다.
 *
 *  - POST /memories Discord 모양 두 건(같은 본문, 다른 messageId) → 행 {M1, M2}. 같은 메시지 재전송은
 *    행·언급·metadata 를 바꾸지 않는다.
 *  - 일정 입력(본문 없는 #일정 + #날짜)이 같은 일정명 노드에 흡수돼도 행이 남는다.
 *  - MCP store_memory 가 같은 본문에 흡수되면 save:mcp:<adapterId> 행과 출처 사건 행이 함께 남는다.
 *    근거 없는 흡수와 새 MCP 기억도 행을 남긴다.
 *  - 철회된 기억에 같은 본문의 근거 있는 AI 저장이 흡수되면 행은 남기되 되살리지 않는다(설계 5.1).
 *  - H2: 클라이언트 metadata 의 깨진 absorbedInputs 칸은 저장(201)도 출처 삭제(200)도 막지 않는다.
 *    삭제 결과는 출처 행 기준이다(T4, 설계 5.3): 다른 메시지 행이 남은 노드는 keptIds 로 남고, 마지막
 *    메시지까지 지우면 지워진다.
 *  - 휴지통 복원(T4, 설계 5.4): 되돌릴 출처 행이 없는 노드는 복원을 요청한 토큰 행위자의
 *    restore:<adapterId> 행을 받는다(호출자 신고가 아니라 인증 토큰에서 정한다).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { NodeSourceRepository } from "../../db/store-internal/node-source-repository.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { readSharedMemory } from "../../memory/shared-memory-contract.ts";
import { sourceKeyOf } from "../../memory/node-sources/source-ref.ts";
import { SseTokenStore } from "../../federation/sse-tokens.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import { createAuthGate } from "../auth-gate.ts";
import { registerMcpRoutes } from "../../mcp/server.ts";
import { registerMemoriesRoutes } from "./memories.ts";
import { registerArchiveRoutes } from "./archive.ts";

const PLATFORM = "discord";
const DISCORD_SOURCE = "discord-channel";
const OWNER = "owner";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let dir: string;
let db: Database;
let store: SqliteMemoryStore;
let server: ReturnType<typeof Bun.serve>;
let tokens: SseTokenStore;
/** 0 = ai-a, 1 = ai-b */
let clients: Client[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bara-source-rows-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  tokens = new SseTokenStore(join(dir, "tokens.json"));
  const app = new Hono({ strict: false });
  app.use("*", createAuthGate({
    sseTokens: tokens,
    remoteAddrOf: () => "127.0.0.1",
    getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
  }));
  const deps = { store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler() };
  registerMcpRoutes(app, deps);
  registerMemoriesRoutes(app, deps);
  registerArchiveRoutes(app, deps);
  server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 60 });
  clients = [];
  for (const name of ["ai-a", "ai-b"]) {
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.issueToken(name)}` } },
    }));
    clients.push(client);
  }
});

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  server.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function callTool(client: number, name: string, args: Record<string, unknown>) {
  const result = await clients[client]!.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { error: result.isError === true, data: JSON.parse(content[0]!.text) };
}

/** Discord 봇 토큰(전체 권한)으로 부르는 REST 요청. adapterId 를 주면 그 이름의 전체 권한 토큰을 쓴다. */
async function rest(method: string, path: string, body?: unknown, adapterId = "discord-bot"): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${tokens.issueToken(adapterId)}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Discord 봇 buildBaseMetadata 모양 그대로 저장한다. */
async function saveDiscord(content: string, messageId: string, extra: Record<string, unknown> = {}) {
  const response = await rest("POST", "/memories", {
    content, platform: PLATFORM, author: OWNER, force: true,
    metadata: { messageId, channelId: "channel-1", guildId: "guild-1", source: DISCORD_SOURCE, ...extra },
  });
  expect(response.status).toBe(201);
  return (await response.json() as { id: number }).id;
}

const messageKey = (messageId: string) => sourceKeyOf({ kind: "message", platform: PLATFORM, messageId });
const mcpKey = (adapterId: string) => sourceKeyOf({ kind: "direct_save", channel: "mcp", actor: adapterId });

function sourceKeys(id: number): string[] {
  return new NodeSourceRepository(db).listSync([id]).get(id)!.map((row) => row.key);
}

function nodeState(id: number): { mentions: number; metadataJson: string } {
  const row = db.query("SELECT mention_count, metadata_json FROM knowledge_nodes WHERE id = ?").get(id) as {
    mention_count: number; metadata_json: string;
  };
  return { mentions: row.mention_count, metadataJson: row.metadata_json };
}

function eventProducers(id: number): unknown[] {
  return (db.query("SELECT evidence_json FROM memory_source_events WHERE node_id = ? ORDER BY rowid").all(id) as Array<{
    evidence_json: string;
  }>).map((row) => (JSON.parse(row.evidence_json) as { producer: unknown }).producer);
}

describe("POST /memories — 메시지 출처 행", () => {
  test("같은 본문의 두 메시지는 한 노드에 행 {M1, M2} 를 남기고, 재전송은 아무것도 바꾸지 않는다", async () => {
    const content = "배포 창구는 금요일 오후로 정했다";
    const id = await saveDiscord(content, "msg-1");
    expect(sourceKeys(id)).toEqual([messageKey("msg-1")]);
    const afterFirst = nodeState(id);

    expect(await saveDiscord(content, "msg-2")).toBe(id);
    expect(sourceKeys(id)).toEqual([messageKey("msg-1"), messageKey("msg-2")]);
    expect(nodeState(id)).toEqual({ mentions: afterFirst.mentions + 1, metadataJson: afterFirst.metadataJson });

    const afterSecond = nodeState(id);
    expect(await saveDiscord(content, "msg-1")).toBe(id);
    expect(sourceKeys(id)).toEqual([messageKey("msg-1"), messageKey("msg-2")]);
    expect(nodeState(id)).toEqual(afterSecond);
  }, 60_000);

  test("일정 입력이 같은 일정명 노드에 흡수돼도 메시지 행이 남는다", async () => {
    const id = await saveDiscord("#일정:치과 #날짜:내일", "msg-schedule-1");
    expect((await store.getNode(id))!.content).toBe("치과");
    expect(await saveDiscord("#일정:치과 #날짜:내일", "msg-schedule-2")).toBe(id);
    expect(sourceKeys(id)).toEqual([messageKey("msg-schedule-1"), messageKey("msg-schedule-2")]);
  }, 60_000);
});

describe("MCP 저장 — save:mcp:<adapterId> 출처 행", () => {
  test("같은 본문에 흡수되면 출처 사건 행과 함께 행이 남고, 근거 없는 흡수·새 기억도 행을 남긴다", async () => {
    const content = "운영 회의록은 공유 드라이브에 둔다";
    const id = await saveDiscord(content, "msg-shared");

    const withEvidence = await callTool(0, "store_memory", {
      content, evidence: { assertionKind: "user_statement", sourceEventId: "conversation-1:message-3" },
    });
    expect(withEvidence.error).toBe(false);
    expect(withEvidence.data.id).toBe(id);
    expect(sourceKeys(id)).toEqual([messageKey("msg-shared"), mcpKey("ai-a")]);
    expect(eventProducers(id)).toEqual(["ai-a"]);

    const withoutEvidence = await callTool(1, "store_memory", { content });
    expect(withoutEvidence.data.id).toBe(id);
    expect(sourceKeys(id)).toEqual([messageKey("msg-shared"), mcpKey("ai-a"), mcpKey("ai-b")]);

    const fresh = await callTool(0, "store_memory", { content: "새 프로젝트 이름은 은하수다", force: true });
    expect(fresh.error).toBe(false);
    expect(fresh.data.id).not.toBe(id);
    expect(sourceKeys(fresh.data.id)).toEqual([mcpKey("ai-a")]);
  }, 60_000);

  test("철회된 기억에 흡수된 근거 있는 AI 저장은 행만 남기고 되살리지 않는다(설계 5.1)", async () => {
    const content = "사용자는 짧은 답변을 원한다";
    const saved = await callTool(0, "store_memory", { content });
    const id = saved.data.id as number;
    const retracted = await callTool(0, "retract_memory", { id, expectedRevision: 0, requestId: "withdraw-1" });
    expect(retracted.error).toBe(false);
    const before = nodeState(id);

    const again = await callTool(1, "store_memory", {
      content, evidence: { assertionKind: "user_statement", sourceEventId: "conversation-2:message-1" },
    });
    expect(again.error).toBe(false);
    expect(again.data.id).toBe(id);
    expect(sourceKeys(id)).toEqual([mcpKey("ai-a"), mcpKey("ai-b")]);
    expect(eventProducers(id)).toEqual(["ai-b"]);
    const after = await store.getNode(id);
    expect(after!.mentionCount).toBe(before.mentions);
    expect(readSharedMemory(after!.metadata).status).toBe("retracted");
  }, 60_000);
});

describe("H2 — 클라이언트 metadata 의 absorbedInputs 칸은 서버 판정에 쓰이지 않는다", () => {
  test("깨진 absorbedInputs 값이 든 저장은 201 이고, 이어지는 출처 삭제는 500 없이 동작한다", async () => {
    const first = await saveDiscord("첫째 기억은 깨진 칸을 가진다", "msg-h2-a", { absorbedInputs: "x" });
    const secondText = "둘째 기억도 깨진 칸을 가진다";
    const second = await saveDiscord(secondText, "msg-h2-b", { absorbedInputs: { independent: -1 } });
    // 깨진 칸을 가진 노드에 같은 본문이 흡수돼도 저장이 막히지 않는다(예전에는 여기서 500).
    expect(await saveDiscord(secondText, "msg-h2-c", { absorbedInputs: "x" })).toBe(second);
    expect(sourceKeys(second)).toEqual([messageKey("msg-h2-b"), messageKey("msg-h2-c")]);

    const deleteFirst = await rest("DELETE", `/memories/by-source?messageId=msg-h2-a&platform=${PLATFORM}`);
    expect(deleteFirst.status).toBe(200);
    expect(await deleteFirst.json()).toMatchObject({
      deletedCount: 1, deletedIds: [first], derivedDeletedIds: [], keptIds: [], archivePurgedIds: [],
    });
    expect(await store.getNode(first)).toBeNull();

    const deleteSecond = await rest("DELETE", `/memories/by-source?messageId=msg-h2-b&platform=${PLATFORM}`);
    expect(deleteSecond.status).toBe(200);
    // 다른 메시지(msg-h2-c)의 행이 노드를 붙잡는다 — 지운 메시지의 행만 빠진다.
    expect(await deleteSecond.json()).toMatchObject({ deletedCount: 0, deletedIds: [], keptIds: [second] });
    expect(sourceKeys(second)).toEqual([messageKey("msg-h2-c")]);

    const deleteThird = await rest("DELETE", `/memories/by-source?messageId=msg-h2-c&platform=${PLATFORM}`);
    expect(deleteThird.status).toBe(200);
    expect(await deleteThird.json()).toMatchObject({ deletedIds: [second], keptIds: [] });
    expect(await store.getNode(second)).toBeNull();
  }, 60_000);
});

describe("휴지통 복원 — restore 출처 행 (설계 5.4)", () => {
  test("되돌릴 출처 행이 없는 노드는 복원한 토큰 행위자의 restore 행을 받고, 출처 행이 있던 노드는 그 행을 되찾는다", async () => {
    const origin = await saveDiscord("복원 시험 원문은 금요일 회의록이다", "msg-restore");
    // 원문의 파생(계보 부모만 있고 출처 행 없음) — 실제 저장소 출처 기록(derived provenance)으로 만든다.
    const child = await store.addNode({
      content: "금요일 회의록에서 뽑은 사실", sourceType: "llm_extract",
      provenance: { kind: "derived", parentId: origin, relation: "merged_into", edgeProvenance: "system" },
    });
    expect(sourceKeys(child)).toEqual([]);

    const trashed = await rest("POST", `/memories/${origin}/trash`);
    expect(trashed.status).toBe(200);
    expect(await trashed.json()).toEqual({ trashed: origin, cascadeTrashedIds: [child] });

    const restoredChild = await rest("POST", `/archive/${child}/restore`, undefined, "dashboard-owner");
    expect(restoredChild.status).toBe(200);
    expect(sourceKeys(child)).toEqual([sourceKeyOf({ kind: "restore", actor: "dashboard-owner" })]);

    const restoredOrigin = await rest("POST", `/archive/${origin}/restore`, undefined, "dashboard-owner");
    expect(restoredOrigin.status).toBe(200);
    expect(sourceKeys(origin)).toEqual([messageKey("msg-restore")]);
  }, 60_000);
});
