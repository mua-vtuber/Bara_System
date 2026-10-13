/**
 * source-key-delimiter.test.ts — 출처 행 키의 구분자 `:` 를 경계에서 400 으로 막는다(WP-B1-20U 설계 17.18 설계 7, U10f).
 *
 * 메시지 출처 키는 `msg:<platform>:<messageId>` 와 첨부 키 `msg:<platform>:<messageId>:att:<attachmentId>` 다. messageId·
 * 첨부 id·플랫폼에 `:` 가 들면 서로 다른 (메시지, 첨부) 쌍이 같은 키로 섞인다 — messageId `m1:att:a1` 인 글 저장이 메시지
 * `m1` 의 첨부 `a1` 과 같은 키 `msg:discord:m1:att:a1` 이 된다. 그래서 키를 만드는 입력을 받는 모든 경계(POST /memories·
 * append·from-text, POST /ingest 의 sourceMessage, DELETE·PATCH /memories/by-source, MCP store_memory)가 400 으로 막고,
 * 빠진 경계가 있어도 sourceKeyOf 가 마지막 방어로 throw 한다. 문구는 칸 이름만 다르고 모든 경계가 같다. direct_save·
 * restore 키의 `:` 는 대상이 아니다(겹쳐도 "직접 저장이 있다"는 같은 뜻).
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 임시 디렉터리의 실제 AssetStore + 실제 Hono 라우트, MCP 는 루프백 Bun.serve +
 * SDK 클라이언트(mcp/tools-memory.int.test.ts 와 같은 조립). mock 0.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { AssetStore } from "../../assets/asset-store.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { NodeSourceRepository } from "../../db/store-internal/node-source-repository.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { SseTokenStore } from "../../federation/sse-tokens.ts";
import { registerMcpRoutes } from "../../mcp/server.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { sourceKeyOf } from "../../memory/node-sources/source-ref.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { buildMemoryApi } from "../../server.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import { getMemorySettings } from "../../settings/memory-settings.ts";
import { createAuthGate } from "../auth-gate.ts";
import { createBodyLimit } from "../body-limit.ts";
import type { MemoryApiDeps } from "../types.ts";

const PLATFORM = "discord";
const DASHBOARD_SOURCE = "dashboard:manual";
const ATTRIBUTION = { author: "owner", userId: "user-1" };
const JSON_HEADERS = { "content-type": "application/json" };
const NOTE = "캠핑 준비물\n\n텐트와 침낭은 금요일 저녁까지 차에 싣는다. 버너 가스는 두 통 챙긴다.";
const SAVED = "분리수거는 목요일 밤에 내놓는다";
const COLLIDING_ID = "m1:att:a1";

/** 경계마다 같은 문구 — 칸 이름만 다르다(설계 7). */
const delimiterError = (field: "messageId" | "attachmentId" | "platform") =>
  `${field} must not contain ":" (source key delimiter)`;

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
}, 180_000);

interface Harness { app: Hono; db: Database; store: SqliteMemoryStore; deps: MemoryApiDeps; dir: string }
const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "bara-source-key-delimiter-"));
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const assetStore = new AssetStore(dir);
  const settings = getMemorySettings("/nonexistent-default-source-key-delimiter-test", "/nonexistent-default-source-key-delimiter-test.secrets.json");
  const deps: MemoryApiDeps = {
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(), assetStore,
    getSettings: () => settings,
  };
  const h = { app: buildMemoryApi(deps), db, store, deps, dir };
  harnesses.push(h);
  return h;
}

type Json = Record<string, unknown>;
async function call(h: Harness, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await h.app.request(path, {
    method,
    ...(body === undefined ? {} : { headers: JSON_HEADERS, body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() as Json };
}

const count = (db: Database, table: string) => (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
const keysOf = (db: Database, id: number) => (new NodeSourceRepository(db).listSync([id]).get(id) ?? []).map((r) => r.key).sort();

/** 거절된 요청이 아무것도 쓰지 않았는지 — 노드·출처 행 수가 그대로다. */
function snapshot(db: Database) {
  return { nodes: count(db, "knowledge_nodes"), sources: count(db, "memory_node_sources"), documents: count(db, "documents") };
}

describe("재현 — messageId 'm1:att:a1' 글 저장이 메시지 m1 의 첨부 a1 키와 섞인다", () => {
  test("메시지 m1 의 첨부 a1 이 있을 때 같은 키를 만드는 글 저장은 400, 아무것도 쓰지 않는다", async () => {
    const h = makeHarness();
    const attachment = await call(h, "POST", "/ingest", {
      source: DASHBOARD_SOURCE,
      content: { type: "text", data: NOTE, mimeType: "text/plain", originalName: "camp.txt" },
      attribution: ATTRIBUTION,
      sourceMessage: { platform: PLATFORM, messageId: "m1", attachmentId: "a1" },
    });
    expect(attachment.status).toBe(201);
    const documentNode = (attachment.body.nodeIds as number[])[0]!;
    const attachmentKey = sourceKeyOf({ kind: "message", platform: PLATFORM, messageId: "m1", attachmentId: "a1" });
    expect(keysOf(h.db, documentNode)).toEqual([attachmentKey]);
    const before = snapshot(h.db);

    const saved = await call(h, "POST", "/memories", {
      content: NOTE, author: "owner", platform: PLATFORM, metadata: { messageId: COLLIDING_ID, source: "discord-channel" },
    });
    expect(saved).toEqual({ status: 400, body: { error: delimiterError("messageId") } });
    expect(snapshot(h.db)).toEqual(before);
    expect(keysOf(h.db, documentNode)).toEqual([attachmentKey]);
  }, 120_000);
});

describe("저장 경계 — POST /memories · append · from-text", () => {
  test("POST /memories: metadata.messageId 와 metadata.platform 의 ':' 는 400, 쓰기 0", async () => {
    const h = makeHarness();
    for (const [metadata, field] of [
      [{ messageId: "m:1" }, "messageId"],
      [{ messageId: 12, platform: "dis:cord" }, "platform"],
      [{ messageId: "m1", platform: "dis:cord" }, "platform"],
      [{ messageId: "m1", source: "dis:cord-channel" }, "platform"],
    ] as const) {
      const res = await call(h, "POST", "/memories", { content: SAVED, author: "owner", platform: PLATFORM, metadata });
      expect(res).toEqual({ status: 400, body: { error: delimiterError(field) } });
    }
    expect(snapshot(h.db)).toEqual({ nodes: 0, sources: 0, documents: 0 });
  }, 60_000);

  test("POST /memories: messageId 가 없는 직접 저장은 ':' 가 든 채널·작성자도 받는다(direct_save 는 대상 아님)", async () => {
    const h = makeHarness();
    const saved = await call(h, "POST", "/memories", { content: SAVED, author: "own:er", platform: "dash:board" });
    expect(saved.status).toBe(201);
    expect(keysOf(h.db, saved.body.id as number)).toEqual([sourceKeyOf({ kind: "direct_save", channel: "dash:board", actor: "own:er" })]);
  }, 60_000);

  test("POST /memories/:id/append: metadata.messageId 의 ':' 는 400", async () => {
    const h = makeHarness();
    const target = (await call(h, "POST", "/memories", { content: SAVED, author: "owner", platform: "dashboard" })).body.id as number;
    const before = snapshot(h.db);
    const res = await call(h, "POST", `/memories/${target}/append`, {
      content: "덧붙이는 글: 수요일에는 종이만 모은다", author: "owner", platform: PLATFORM, metadata: { messageId: COLLIDING_ID },
    });
    expect(res).toEqual({ status: 400, body: { error: delimiterError("messageId") } });
    expect(snapshot(h.db)).toEqual(before);
  }, 60_000);

  test("POST /memories/from-text: metadata.messageId 의 ':' 는 추출기 준비보다 먼저 400", async () => {
    const h = makeHarness(); // 추출기가 없는 조립 — 맞는 입력이면 503, 오류가 400 이면 추출 이전에 막은 것이다
    const res = await call(h, "POST", "/memories/from-text", {
      text: SAVED, author: "owner", platform: PLATFORM, metadata: { messageId: COLLIDING_ID },
    });
    expect(res).toEqual({ status: 400, body: { error: delimiterError("messageId") } });
    expect(snapshot(h.db)).toEqual({ nodes: 0, sources: 0, documents: 0 });
  }, 60_000);
});

describe("POST /ingest — sourceMessage 의 messageId·attachmentId·platform", () => {
  const ingest = (h: Harness, sourceMessage: Record<string, unknown>) => call(h, "POST", "/ingest", {
    source: DASHBOARD_SOURCE, content: { type: "text", data: NOTE, mimeType: "text/plain", originalName: "camp.txt" },
    attribution: ATTRIBUTION, sourceMessage,
  });

  test("칸마다 정확한 문구로 400, 쓰기 0", async () => {
    const h = makeHarness();
    expect(await ingest(h, { platform: PLATFORM, messageId: COLLIDING_ID }))
      .toEqual({ status: 400, body: { error: delimiterError("messageId") } });
    expect(await ingest(h, { platform: PLATFORM, messageId: "m1", attachmentId: "a:1" }))
      .toEqual({ status: 400, body: { error: delimiterError("attachmentId") } });
    expect(await ingest(h, { platform: "dis:cord", messageId: "m1" }))
      .toEqual({ status: 400, body: { error: delimiterError("platform") } });
    expect(snapshot(h.db)).toEqual({ nodes: 0, sources: 0, documents: 0 });
  }, 60_000);
});

describe("by-source 경계 — DELETE · PATCH /memories/by-source", () => {
  test("DELETE: messageId·platform 의 ':' 는 400", async () => {
    const h = makeHarness();
    expect(await call(h, "DELETE", `/memories/by-source?messageId=${encodeURIComponent(COLLIDING_ID)}&platform=${PLATFORM}`))
      .toEqual({ status: 400, body: { error: delimiterError("messageId") } });
    expect(await call(h, "DELETE", `/memories/by-source?messageId=m1&platform=${encodeURIComponent("dis:cord")}`))
      .toEqual({ status: 400, body: { error: delimiterError("platform") } });
  }, 60_000);

  test("PATCH: messageId·platform·attachmentIds 의 ':' 는 400", async () => {
    const h = makeHarness();
    const patch = (body: Record<string, unknown>) => call(h, "PATCH", "/memories/by-source", body);
    expect(await patch({ messageId: COLLIDING_ID, platform: PLATFORM, content: "고친 글" }))
      .toEqual({ status: 400, body: { error: delimiterError("messageId") } });
    expect(await patch({ messageId: "m1", platform: "dis:cord", content: "고친 글" }))
      .toEqual({ status: 400, body: { error: delimiterError("platform") } });
    expect(await patch({ messageId: "m1", platform: PLATFORM, attachmentIds: ["a1", "a:2"] }))
      .toEqual({ status: 400, body: { error: delimiterError("attachmentId") } });
  }, 60_000);

  test("':' 가 없는 요청은 그대로 처리한다(없는 메시지 DELETE 는 200 빈 결과)", async () => {
    const h = makeHarness();
    const res = await call(h, "DELETE", `/memories/by-source?messageId=m1&platform=${PLATFORM}`);
    expect(res.status).toBe(200);
    expect(res.body.deletedIds).toEqual([]);
  }, 60_000);
});

describe("MCP store_memory — 같은 문구의 도구 오류", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let client: Client | undefined;
  let tokenDir: string | undefined;
  afterAll(async () => {
    await client?.close();
    server?.stop(true);
    if (tokenDir !== undefined) rmSync(tokenDir, { recursive: true, force: true });
  });

  test("metadata.messageId 의 ':' 는 INVALID_INPUT 도구 오류, 저장 0", async () => {
    const h = makeHarness();
    tokenDir = mkdtempSync(join(tmpdir(), "bara-source-key-delimiter-mcp-"));
    const sseTokens = new SseTokenStore(join(tokenDir, "tokens.json"));
    const token = sseTokens.issueToken("claude-code");
    const outer = new Hono({ strict: false });
    outer.use("*", createAuthGate({
      sseTokens, remoteAddrOf: () => "127.0.0.1", getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
    }));
    outer.use("*", createBodyLimit(() => ({
      maxTextBytes: MEMORY_DEFAULTS.security.maxTextBytes, maxAssetBytes: MEMORY_DEFAULTS.security.maxAssetBytes,
    })));
    const inner = new Hono({ strict: false });
    registerMcpRoutes(inner, h.deps);
    outer.route("/", inner);
    server = Bun.serve({ port: 0, fetch: outer.fetch, idleTimeout: 60 });
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));

    const toolError = async (metadata: Record<string, unknown>) => {
      const res = await client!.callTool({ name: "store_memory", arguments: { content: SAVED, metadata } });
      expect(res.isError).toBe(true);
      return JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as { code: string; message: string };
    };
    expect(await toolError({ messageId: COLLIDING_ID })).toEqual({ code: "INVALID_INPUT", message: delimiterError("messageId") });
    expect(await toolError({ messageId: "m1", platform: "dis:cord" })).toEqual({ code: "INVALID_INPUT", message: delimiterError("platform") });
    expect(snapshot(h.db)).toEqual({ nodes: 0, sources: 0, documents: 0 });

    const stored = await client.callTool({ name: "store_memory", arguments: { content: SAVED, metadata: { messageId: "m1", platform: PLATFORM } } });
    expect(stored.isError).not.toBe(true);
  }, 120_000);
});

describe("sourceKeyOf — 빠진 경계의 마지막 방어", () => {
  test("message 키의 messageId·attachmentId·platform 에 ':' 가 있으면 같은 문구로 throw", () => {
    expect(() => sourceKeyOf({ kind: "message", platform: PLATFORM, messageId: COLLIDING_ID })).toThrow(delimiterError("messageId"));
    expect(() => sourceKeyOf({ kind: "message", platform: PLATFORM, messageId: "m1", attachmentId: "a:1" })).toThrow(delimiterError("attachmentId"));
    expect(() => sourceKeyOf({ kind: "message", platform: "dis:cord", messageId: "m1" })).toThrow(delimiterError("platform"));
  });

  test("direct_save·restore 키는 ':' 가 있어도 만든다", () => {
    expect(sourceKeyOf({ kind: "direct_save", channel: "dashboard:manual", actor: "own:er" })).toBe("save:dashboard:manual:own:er");
    expect(sourceKeyOf({ kind: "restore", actor: "own:er" })).toBe("restore:own:er");
  });
});
