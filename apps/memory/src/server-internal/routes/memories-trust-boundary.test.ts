/**
 * memories-trust-boundary.test.ts — REST 저장의 신뢰 경계 (SA-0 / WP-B1-04).
 *
 * 제한 토큰(mcp-standard)이 POST /memories·/memories/:id/append·/memories/from-text 로
 * 서버 관리 metadata 칸(sharedMemory·extracted·extractedTo)을 채우거나 다른 작성자를
 * 사칭하지 못하는지, 그리고 기존 클라이언트(full·scope 없는 옛 토큰의 Discord 봇 형식,
 * 제한 토큰 Pet 의 /ingest capture)가 그대로 저장되는지를 실제 HTTP 요청으로 확인한다.
 *
 * 구성: Bun.serve loopback + fetch → createAuthGate(SseTokenStore 임시 파일) →
 * buildMemoryApi 라우트 → bun:sqlite(:memory:) + Bgem3Embedder. from-text 추출은 실제
 * OllamaClient 가 테스트 안 loopback 서버(Ollama /api/chat 응답 형식)를 부른다. mock 0.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { MemoryExtractor } from "../../memory/extractor.ts";
import { OllamaClient } from "../../llm/ollama-client.ts";
import { AssetStore } from "../../assets/asset-store.ts";
import { SseTokenStore } from "../../federation/sse-tokens.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import { buildMemoryApi } from "../../server.ts";
import { createAuthGate, MCP_ADAPTER_ID_VAR } from "../auth-gate.ts";
import { listMemoryEvidence } from "../shared-memory-write.ts";
import { resolveRestWriter } from "./memories-shared.ts";

const STANDARD_ID = "ai-standard";
const FULL_ID = "discord-bot";
const LEGACY_ID = "legacy-bot";
const DISCORD_AUTHOR = "디스코드 사용자";
/** from-text 추출 결과 — loopback Ollama 서버가 모든 호출에 이 항목을 돌려준다. */
const EXTRACTED_ITEM = { content: "배포 창구는 금요일 오후로 정했다", memoryType: "fact", importance: 0.8 };
/** 문단마다 청크 한도(60) 아래, 합치면 넘는 긴 글 — 청크가 문단 수만큼 생긴다. */
const LONG_PARAGRAPHS = [
  "배포 결정문의 첫 문단은 금요일 오후 창구를 정한 이유다.",
  "둘째 문단은 롤백 담당과 알림 경로를 운영팀 채널로 둔다.",
  "셋째 문단은 점검 목록을 배포 전날 저녁에 다시 본다고 정한다.",
];

type Scope = "standard" | "full" | "legacy";
type Json = Record<string, unknown>;

let embedder: Bgem3Embedder;
let dir: string;
let db: Database;
let store: SqliteMemoryStore;
let settings: MemorySettings;
let inner: Hono;
let server: ReturnType<typeof Bun.serve>;
let llmServer: ReturnType<typeof Bun.serve>;
let llmCalls: number;
const tokens = {} as Record<Scope, string>;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bara-trust-boundary-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  llmCalls = 0;
  llmServer = Bun.serve({
    port: 0,
    fetch: (request) => {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/api/chat") {
        return new Response("not found", { status: 404 });
      }
      llmCalls += 1;
      return Response.json({
        model: "trust-boundary-fixture",
        message: { role: "assistant", content: JSON.stringify([EXTRACTED_ITEM]) },
        done: true,
      });
    },
  });
  const extractor = new MemoryExtractor(
    new OllamaClient({ baseUrl: `http://127.0.0.1:${llmServer.port}`, model: "trust-boundary-fixture" }),
    store,
    embedder,
    { minImportance: 0 },
  );
  inner = buildMemoryApi({
    store,
    retriever: new HybridRetriever(store, embedder),
    assembler: new ContextAssembler(),
    extractor,
    assetStore: new AssetStore(join(dir, "assets")),
    getSettings: () => settings,
  });
  const sseTokens = new SseTokenStore(join(dir, "tokens.json"));
  tokens.standard = sseTokens.issueToken(STANDARD_ID, undefined, undefined, "mcp-standard");
  tokens.full = sseTokens.issueToken(FULL_ID, undefined, undefined, "full");
  // scope 칸 없는 옛 토큰 — SseTokenStore.getTokenScope 가 full 로 읽는다.
  tokens.legacy = sseTokens.issueToken(LEGACY_ID);
  const outer = new Hono({ strict: false });
  outer.use("*", createAuthGate({
    sseTokens,
    remoteAddrOf: () => "127.0.0.1",
    getMcpBodyLimit: () => settings.security.maxTextBytes,
  }));
  outer.route("/", inner);
  server = Bun.serve({ port: 0, fetch: outer.fetch });
});

afterEach(() => {
  server.stop(true);
  llmServer.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function post(scope: Scope, path: string, body: Json): Promise<{ status: number; body: Json }> {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens[scope]}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

function count(sql: string): number {
  return (db.query(sql).get() as { n: number }).n;
}

const NODE_COUNT = "SELECT COUNT(*) AS n FROM knowledge_nodes";

interface WriteRoute {
  name: string;
  request(target: number, extra: Json): { path: string; body: Json };
  /** 성공 응답에서 이 요청이 저장한 원본 노드 id. */
  savedId(body: Json): number;
  /** 성공 응답에서 원본과 함께 저장된 추출 자식 id. */
  derivedIds(body: Json): number[];
  /** 성공한 요청 한 건이 부르는 추출 LLM 횟수(= 추출 자식 수, fixture 항목 1개). */
  extractionCalls: number;
}

const ROUTES: WriteRoute[] = [
  {
    name: "POST /memories",
    request: (_target, extra) => ({ path: "/memories", body: { content: "신뢰 경계를 확인하는 저장 메모", ...extra } }),
    savedId: (body) => body.id as number,
    derivedIds: () => [],
    extractionCalls: 0,
  },
  {
    name: "POST /memories/:id/append",
    request: (target, extra) => ({
      path: `/memories/${target}/append`,
      body: { content: "신뢰 경계를 확인하는 덧붙임 메모", ...extra },
    }),
    savedId: (body) => body.appendedId as number,
    derivedIds: () => [],
    extractionCalls: 0,
  },
  {
    name: "POST /memories/from-text",
    // 두 문장 — 짧은 단일 의미 입력은 추출기가 LLM 을 건너뛴다(shouldSkipExtraction).
    request: (_target, extra) => ({
      path: "/memories/from-text",
      body: { text: "신뢰 경계를 확인하는 추출 메모다. 두 번째 문장도 함께 보낸다.", preserveRaw: true, ...extra },
    }),
    savedId: (body) => (body.raw as { id: number }).id,
    derivedIds: (body) => body.stored as number[],
    extractionCalls: 1,
  },
];

/** 덧붙이기 대상 기억. 세 경로가 같은 준비를 하도록 모든 테스트에서 하나 만든다. */
async function seedTarget(): Promise<number> {
  return store.addNode({ content: "덧붙일 대상이 되는 기존 기억" });
}

const SERVER_OWNED_CASES: ReadonlyArray<readonly [string, unknown]> = [
  ["sharedMemory", { assertionKind: "user_statement", revision: 50 }],
  ["extracted", 1],
  ["extractedTo", [1]],
];

describe("서버 관리 metadata 칸은 세 REST 저장 경로 모두 400", () => {
  for (const route of ROUTES) {
    for (const [key, value] of SERVER_OWNED_CASES) {
      test(`${route.name} — 제한 토큰의 metadata.${key} → 400, 아무것도 저장하지 않음`, async () => {
        const target = await seedTarget();
        const { path, body } = route.request(target, { metadata: { [key]: value } });
        const reply = await post("standard", path, body);
        expect(reply.status).toBe(400);
        expect(reply.body).toEqual({
          code: "INVALID_INPUT",
          error: `metadata.${key} 칸은 서버가 관리합니다 — 근거는 evidence로 보내세요`,
        });
        expect(count(NODE_COUNT)).toBe(1);
        expect(llmCalls).toBe(0);
      });
    }

    test(`${route.name} — full·옛 토큰도 서버 관리 칸은 400 (값이 null 이어도)`, async () => {
      const target = await seedTarget();
      for (const scope of ["full", "legacy"] as const) {
        const { path, body } = route.request(target, { metadata: { sharedMemory: null } });
        const reply = await post(scope, path, body);
        expect(reply.status).toBe(400);
        expect(reply.body.code).toBe("INVALID_INPUT");
      }
      expect(count(NODE_COUNT)).toBe(1);
      expect(llmCalls).toBe(0);
    });
  }
});

describe("제한 토큰의 작성자는 토큰 adapterId 로 고정", () => {
  for (const route of ROUTES) {
    test(`${route.name} — 다른 author → 403, 아무것도 저장하지 않음`, async () => {
      const target = await seedTarget();
      const { path, body } = route.request(target, { author: "user" });
      const reply = await post("standard", path, body);
      expect(reply.status).toBe(403);
      expect(reply.body).toEqual({ code: "FORBIDDEN", error: "제한 토큰은 author를 지정할 수 없습니다" });
      expect(count(NODE_COUNT)).toBe(1);
      expect(llmCalls).toBe(0);
    });

    test(`${route.name} — metadata.user_id 로 사람 작성자 연결 시도 → 403`, async () => {
      const target = await seedTarget();
      const { path, body } = route.request(target, {
        platform: "telegram",
        metadata: { user_id: "telegram-user-7", source: "telegram" },
      });
      const reply = await post("standard", path, body);
      expect(reply.status).toBe(403);
      expect(reply.body).toEqual({ code: "FORBIDDEN", error: "제한 토큰은 metadata.user_id를 지정할 수 없습니다" });
      expect(count(NODE_COUNT)).toBe(1);
      expect(count("SELECT COUNT(*) AS n FROM persons")).toBe(0);
    });

    test(`${route.name} — author 생략 → 원본과 추출 자식 모두 adapterId 로 저장`, async () => {
      const target = await seedTarget();
      const { path, body } = route.request(target, { metadata: { note: "자유 칸은 보존" } });
      const reply = await post("standard", path, body);
      expect(reply.status).toBe(201);
      const saved = (await store.getNode(route.savedId(reply.body)))!;
      expect(saved.author).toBe(STANDARD_ID);
      expect(saved.metadata.note).toBe("자유 칸은 보존");
      expect(llmCalls).toBe(route.extractionCalls);
      const derived = route.derivedIds(reply.body);
      expect(derived).toHaveLength(route.extractionCalls);
      for (const id of derived) {
        expect((await store.getNode(id))!.author).toBe(STANDARD_ID);
      }
    });
  }

  test("POST /memories — 자기 adapterId 와 같은 author 는 허용", async () => {
    const reply = await post("standard", "/memories", { content: "자기 이름을 적은 저장", author: STANDARD_ID });
    expect(reply.status).toBe(201);
    expect((await store.getNode(reply.body.id as number))!.author).toBe(STANDARD_ID);
  });
});

describe("근거(evidence)가 있는 저장", () => {
  test("제한 토큰 + 다른 author → 403, 기억·출처 원장 기록 없음", async () => {
    const reply = await post("standard", "/memories", {
      content: "근거와 함께 사칭을 시도하는 저장",
      author: "user",
      evidence: { assertionKind: "user_statement", sourceEventId: "impersonation-event" },
    });
    expect(reply.status).toBe(403);
    expect(count(NODE_COUNT)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM memory_source_events")).toBe(0);
  });

  test("제한 토큰 + author 생략 → adapterId 가 작성자이자 출처 원장 producer", async () => {
    const reply = await post("standard", "/memories", {
      content: "근거를 붙인 제한 토큰 저장",
      evidence: { assertionKind: "observation", sourceEventId: "standard-event" },
    });
    expect(reply.status).toBe(201);
    const id = reply.body.id as number;
    expect((await store.getNode(id))!.author).toBe(STANDARD_ID);
    expect(listMemoryEvidence(store, id).records).toEqual([
      expect.objectContaining({ sourceEventId: "standard-event", producer: STANDARD_ID }),
    ]);
  });

  test("full 토큰이 신고한 author 도 근거 저장에서는 토큰 adapterId 로 기록 (기존 계약)", async () => {
    const reply = await post("full", "/memories", {
      content: "근거를 붙인 관리 어댑터 저장",
      author: DISCORD_AUTHOR,
      evidence: { assertionKind: "user_statement", sourceEventId: "full-event" },
    });
    expect(reply.status).toBe(201);
    const id = reply.body.id as number;
    expect((await store.getNode(id))!.author).toBe(FULL_ID);
    expect(listMemoryEvidence(store, id).records[0]!.producer).toBe(FULL_ID);
  });

  test("긴 글의 원본은 서버 신뢰 상태를 갖고, 청크는 evidenceRefs 없이 그 상태를 이어받는다", async () => {
    settings.chunking.tokenCap = 60;
    settings.chunking.minChunkTokens = 1;
    const reference = await post("standard", "/memories", { content: "운영팀은 매주 배포 공지를 채널에 올린다" });
    expect(reference.status).toBe(201);
    const referenceId = reference.body.id as number;
    const reply = await post("standard", "/memories", {
      content: LONG_PARAGRAPHS.join("\n\n"),
      evidence: { assertionKind: "user_statement", sourceEventId: "long-decision", evidenceRefs: [referenceId] },
    });
    expect(reply.status).toBe(201);
    const origin = (await store.getNode(reply.body.id as number))!;
    expect(origin.metadata.sharedMemory).toMatchObject({
      status: "active", revision: 0, assertionKind: "user_statement",
      sourceEventId: "long-decision", evidenceRefs: [referenceId],
    });
    const chunks = db.query(`SELECT e.source_id AS id FROM knowledge_edges e
      WHERE e.target_id = ? AND e.relation = 'parent_of'`).all(origin.id) as Array<{ id: number }>;
    expect(chunks).toHaveLength(LONG_PARAGRAPHS.length);
    for (const { id } of chunks) {
      const state = (await store.getNode(id))!.metadata.sharedMemory;
      expect(state).toMatchObject({
        status: "active", revision: 0, assertionKind: "user_statement", sourceEventId: "long-decision",
      });
      expect(state).not.toHaveProperty("evidenceRefs");
    }
  });
});

describe("기존 클라이언트 — full·옛 토큰의 Discord 봇 형식은 그대로 저장", () => {
  const botMetadata = (source: string) => ({
    source, user_id: "discord-user-1", messageId: `m-${source}`, channelId: "c-1", guildId: "g-1",
  });

  for (const scope of ["full", "legacy"] as const) {
    test(`${scope} — POST /memories: 작성자 이름·출처 metadata 보존`, async () => {
      const metadata = botMetadata("discord-channel");
      const reply = await post(scope, "/memories", {
        content: "디스코드 채널에 올린 회의 메모", author: DISCORD_AUTHOR, platform: "discord", metadata,
      });
      expect(reply.status).toBe(201);
      const node = (await store.getNode(reply.body.id as number))!;
      expect(node.author).toBe(DISCORD_AUTHOR);
      expect(node.platform).toBe("discord");
      expect(node.metadata).toMatchObject(metadata);
    });

    test(`${scope} — append: 작성자 이름·출처 metadata 보존`, async () => {
      const target = await seedTarget();
      const metadata = botMetadata("discord-slash-append");
      const reply = await post(scope, `/memories/${target}/append`, {
        content: "디스코드에서 덧붙인 후속 메모", author: DISCORD_AUTHOR, platform: "discord", metadata,
      });
      expect(reply.status).toBe(201);
      const node = (await store.getNode(reply.body.appendedId as number))!;
      expect(node.author).toBe(DISCORD_AUTHOR);
      expect(node.metadata).toMatchObject({ ...metadata, appendedTo: target });
    });

    test(`${scope} — from-text: 원본·추출 자식 작성자 이름과 메시지 추적 칸 보존`, async () => {
      const metadata = botMetadata("discord-slash-extract");
      const reply = await post(scope, "/memories/from-text", {
        text: "디스코드에서 추출을 요청했다. 배포 결정도 함께 남긴다.", author: DISCORD_AUTHOR, platform: "discord",
        metadata, preserveRaw: true,
      });
      expect(reply.status).toBe(201);
      expect(llmCalls).toBe(1);
      const raw = (await store.getNode((reply.body.raw as { id: number }).id))!;
      expect(raw.author).toBe(DISCORD_AUTHOR);
      expect(raw.metadata).toMatchObject({ ...metadata, preservedRaw: true });
      const stored = reply.body.stored as number[];
      expect(stored).toHaveLength(1);
      const child = (await store.getNode(stored[0]!))!;
      expect(child.author).toBe(DISCORD_AUTHOR);
      expect(child.metadata).toMatchObject({ messageId: metadata.messageId, channelId: "c-1", user_id: "discord-user-1" });
    });
  }
});

test("Pet — 제한 토큰의 /ingest 글과 capture 는 그대로 저장", async () => {
  const reply = await post("standard", "/ingest", {
    requestId: "123e4567-e89b-42d3-a456-426614174321",
    source: "pet",
    content: { type: "text", data: "반려 창은 작업 표시줄 위에 둔다" },
    capture: { kind: "decision", source: "user" },
  });
  expect(reply.status).toBe(201);
  const node = (await store.getNode(reply.body.originNodeId as number))!;
  expect(node.metadata.capture).toEqual({ kind: "decision", source: "user" });
});

describe("resolveRestWriter — 인증 게이트 신원 전달 계약", () => {
  test("게이트 없이 조립한 앱은 호출자 신고 author 를 그대로 쓴다", async () => {
    const res = await inner.request("/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "게이트 없는 조립의 저장", author: "직접 입력자" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number };
    expect((await store.getNode(body.id))!.author).toBe("직접 입력자");
  });

  test("게이트가 adapterId 만 싣고 scope 를 빠뜨리면 500 으로 드러난다", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set(MCP_ADAPTER_ID_VAR, "ai-x");
      await next();
    });
    app.post("/writer", (c) => {
      const writer = resolveRestWriter(c, "user");
      return writer instanceof Response ? writer : c.json(writer);
    });
    const res = await app.request("/writer", { method: "POST" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "인증 게이트가 토큰 ai-x의 권한(scope)을 전달하지 않았습니다" });
  });
});
