/**
 * memories-edit.trust.test.ts — 편집 라우트의 행위자 신뢰 경계·reason 비밀값
 * 관문·분류 전용 편집 (WP-B1-05: SA-1, PS-0).
 *
 * WP-B1-04 가 저장 라우트(POST /memories 등)에 세운 resolveRestWriter 규칙을
 * 편집 라우트(PATCH /memories/:id · /by-source, POST /:id/tags)의 editor·
 * editSource 에도 적용했는지, reason 에도 저장과 같은 write-guard 비밀값 관문이
 * 도는지, document 같은 본문 잠금 노드에서도 capture(분류) 만 바꾸는 편집은
 * 통과하는지를 실제 HTTP 요청으로 확인한다.
 *
 * 구성: Bun.serve loopback + fetch → createAuthGate(SseTokenStore 임시 파일) →
 * buildMemoryApi 라우트 → bun:sqlite(:memory:) + Bgem3Embedder. mock 0.
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
import { SseTokenStore } from "../../federation/sse-tokens.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import { buildMemoryApi } from "../../server.ts";
import { createAuthGate } from "../auth-gate.ts";
import { readSharedMemory } from "../../memory/shared-memory-contract.ts";

const STANDARD_ID = "ai-standard";
const FULL_ID = "discord-bot";
/** AWS 액세스 키 ID 양식 — detectSecret 이 값으로 확실히 잡는 고정 패턴(fixture, 실제 키 아님). */
const FAKE_AWS_KEY = "AKIAABCDEFGHIJKLMNOP";

type Scope = "standard" | "full" | "none";
type Json = Record<string, unknown>;

let embedder: Bgem3Embedder;
let dir: string;
let db: Database;
let store: SqliteMemoryStore;
let settings: MemorySettings;
let server: ReturnType<typeof Bun.serve>;
const tokens = {} as Record<Exclude<Scope, "none">, string>;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bara-edit-trust-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  const inner = buildMemoryApi({
    store,
    retriever: new HybridRetriever(store, embedder),
    assembler: new ContextAssembler(),
    getSettings: () => settings,
  });
  const sseTokens = new SseTokenStore(join(dir, "tokens.json"));
  tokens.standard = sseTokens.issueToken(STANDARD_ID, undefined, undefined, "mcp-standard");
  tokens.full = sseTokens.issueToken(FULL_ID, undefined, undefined, "full");
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
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function request(
  scope: Scope,
  method: "PATCH" | "POST",
  path: string,
  body: Json,
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (scope !== "none") headers.authorization = `Bearer ${tokens[scope]}`;
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

function countRevisions(nodeId: number): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM memory_revisions WHERE old_node_id = ?").get(nodeId) as { n: number }
  ).n;
}

interface EditRoute {
  name: string;
  request(target: number, extra: Json): { path: string; body: Json };
}

const EDIT_ROUTES: EditRoute[] = [
  {
    name: "PATCH /memories/:id",
    request: (target, extra) => ({
      path: `/memories/${target}`,
      body: { content: "행위자 신뢰 경계를 확인하는 수정 본문", ...extra },
    }),
  },
  {
    name: "PATCH /memories/by-source",
    request: (_target, extra) => ({
      path: "/memories/by-source",
      body: { messageId: "trust-msg-1", platform: "discord", content: "행위자 신뢰 경계를 확인하는 by-source 본문", ...extra },
    }),
  },
  {
    name: "POST /memories/:id/tags",
    request: (target, extra) => ({
      path: `/memories/${target}/tags`,
      body: { tag: "trustcheck", ...extra },
    }),
  },
];

describe("제한 토큰의 편집 행위자는 토큰 adapterId로 고정 (SA-1)", () => {
  for (const route of EDIT_ROUTES) {
    test(`${route.name} — editor:"ai-a" 사칭 → 403, 노드 무변경`, async () => {
      const id = await store.addNode({
        content: "원본 기억",
        sourceType: "auto_capture",
        platform: "discord",
        metadata: { messageId: "trust-msg-1", source: "discord" },
      });
      const { path, body } = route.request(id, { editor: "ai-a" });
      const reply = await request("standard", route.name.startsWith("POST") ? "POST" : "PATCH", path, body);
      expect(reply.status).toBe(403);
      expect(reply.body).toEqual({ code: "FORBIDDEN", error: "제한 토큰은 editor를 지정할 수 없습니다" });
      expect(countRevisions(id)).toBe(0);
    });

    test(`${route.name} — editor 생략 → 수정 이력 editor가 토큰 adapterId`, async () => {
      const id = await store.addNode({
        content: "원본 기억",
        sourceType: "auto_capture",
        platform: "discord",
        metadata: { messageId: "trust-msg-1", source: "discord" },
      });
      const { path, body } = route.request(id, {});
      const reply = await request("standard", route.name.startsWith("POST") ? "POST" : "PATCH", path, body);
      expect(reply.status).toBe(200);
      const revisions = await store.getRevisionsForNode(id);
      expect(revisions.length).toBeGreaterThan(0);
      expect(revisions[0]!.editor).toBe(STANDARD_ID);
    });

    test(`${route.name} — full 토큰은 editor 신고를 그대로 사용(대시보드·봇 호환 보존)`, async () => {
      const id = await store.addNode({
        content: "원본 기억",
        sourceType: "auto_capture",
        platform: "discord",
        metadata: { messageId: "trust-msg-1", source: "discord" },
      });
      const { path, body } = route.request(id, { editor: "discord-owner" });
      const reply = await request("full", route.name.startsWith("POST") ? "POST" : "PATCH", path, body);
      expect(reply.status).toBe(200);
      const revisions = await store.getRevisionsForNode(id);
      expect(revisions[0]!.editor).toBe("discord-owner");
    });
  }

  test("PATCH /memories/:id — editSource 사칭 → 403, 노드 무변경", async () => {
    const id = await store.addNode({ content: "원본 기억" });
    const reply = await request("standard", "PATCH", `/memories/${id}`, {
      content: "editSource 사칭 시도",
      editSource: "다른출처",
    });
    expect(reply.status).toBe(403);
    expect(reply.body).toEqual({ code: "FORBIDDEN", error: "제한 토큰은 editSource를 지정할 수 없습니다" });
    expect(countRevisions(id)).toBe(0);
  });

  test("PATCH /memories/:id — 제한 토큰의 editSource 생략 시 이력이 api로 고정", async () => {
    const id = await store.addNode({ content: "원본 기억" });
    const reply = await request("standard", "PATCH", `/memories/${id}`, { content: "editSource 기본값 확인" });
    expect(reply.status).toBe(200);
    const revisions = await store.getRevisionsForNode(id);
    expect(revisions[0]!.editSource).toBe("api");
  });
});

describe("편집 reason도 저장과 같은 비밀값 관문을 탄다 (SA-1)", () => {
  test("PATCH /memories/:id — reason에 비밀값 → 400, 노드 무변경", async () => {
    const id = await store.addNode({ content: "원본 기억" });
    const reply = await request("full", "PATCH", `/memories/${id}`, {
      content: "정상 본문 수정",
      reason: `사유: ${FAKE_AWS_KEY}`,
    });
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe("SECRET_DETECTED");
    const node = (await store.getNode(id))!;
    expect(node.content).toBe("원본 기억");
    expect(countRevisions(id)).toBe(0);
  });

  test("PATCH /memories/by-source — reason에 비밀값 → 400, 노드 무변경", async () => {
    const id = await store.addNode({
      content: "원본 기억",
      sourceType: "auto_capture",
      platform: "discord",
      metadata: { messageId: "trust-msg-secret", source: "discord" },
    });
    const reply = await request("full", "PATCH", "/memories/by-source", {
      messageId: "trust-msg-secret",
      platform: "discord",
      content: "정상 본문 수정",
      reason: `사유: ${FAKE_AWS_KEY}`,
    });
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe("SECRET_DETECTED");
    const node = (await store.getNode(id))!;
    expect(node.content).toBe("원본 기억");
    expect(countRevisions(id)).toBe(0);
  });

  // QA Medium(WP-B1-05R) — normalizePlainTagInput 의 형식 검증(letters/digits/
  // underscore, max 64)은 GitHub 개인 토큰 모양(`ghp_` + 영숫자 20자 이상)과
  // 겹친다. 태그 라우트가 reason·content 와 같은 write-guard 를 타지 않으면
  // 토큰이 그대로 본문("#ghp_...")과 revision 사유("tag added: #ghp_...")에
  // 남는다.
  test("POST /memories/:id/tags — GitHub 토큰 모양 태그 → 400, 본문·이력 무변경", async () => {
    const id = await store.addNode({ content: "원본 기억" });
    const ghostToken = "ghp_" + "a".repeat(36);
    const reply = await request("full", "POST", `/memories/${id}/tags`, {
      tag: ghostToken,
    });
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe("SECRET_DETECTED");
    const node = (await store.getNode(id))!;
    expect(node.content).toBe("원본 기억");
    expect(countRevisions(id)).toBe(0);
  });
});

describe("분류 전용 편집은 본문 잠금 노드도 통과한다 (PS-0)", () => {
  test("document 노드에 capture만 PATCH → 200, 분류 변경, 본문·revision 외 변화 없음", async () => {
    const id = await store.addNode({
      content: "업로드된 문서 본문은 직접 수정 불가",
      sourceType: "document",
    });
    const before = (await store.getNode(id))!;
    const revisionBefore = readSharedMemory(before.metadata).revision;
    const vectorBefore = await store.getVectorById(id);

    const reply = await request("full", "PATCH", `/memories/${id}`, {
      capture: { kind: "decision", source: "user" },
      expectedRevision: 0,
    });
    expect(reply.status).toBe(200);
    const body = reply.body as { changed: boolean; revision: { newContent: string } | null; memory: { content: string; metadata: { capture?: unknown } } };
    expect(body.changed).toBe(true);
    expect(body.memory.content).toBe(before.content);
    expect(body.memory.metadata.capture).toEqual({ kind: "decision", source: "user" });
    // 응답에 실린 revision 스냅샷도 본문이 안 바뀌었다는 사실을 담고 있어야 한다.
    expect(body.revision?.newContent).toBe(before.content);

    const after = (await store.getNode(id))!;
    expect(after.content).toBe(before.content);
    // QA Medium(WP-B1-05R) — 분류 전용 편집도 editNodeContent 를 타므로 revision
    // 카운터는 편집마다 오르는 기존 계약대로 +1 된다(node-repo-lifecycle-mixin.ts
    // `state.revision + 1` — 본문 변경 여부와 무관). 본문 주장이 안 바뀌었으니
    // 저장된 벡터는 재임베딩 없이 그대로인지를 실제 store 를 통해 확인한다.
    const revisionAfter = readSharedMemory(after.metadata).revision;
    expect(revisionAfter).toBe(revisionBefore + 1);
    const vectorAfter = await store.getVectorById(id);
    expect(vectorAfter).toEqual(vectorBefore);
  });

  test("document 노드에 content PATCH → 여전히 409(본문 직접 수정은 계속 막음)", async () => {
    const id = await store.addNode({ content: "업로드된 문서 본문", sourceType: "document" });
    const reply = await request("full", "PATCH", `/memories/${id}`, {
      content: "본문을 직접 고치려는 시도",
      expectedRevision: 0,
    });
    expect(reply.status).toBe(409);
  });

  test("image_asset 노드에 capture만 PATCH → 200, 본문 불변", async () => {
    const id = await store.addNode({ content: "이미지 설명 본문", sourceType: "image_asset" });
    const reply = await request("full", "PATCH", `/memories/${id}`, {
      capture: { kind: "idea", source: "ai" },
      expectedRevision: 0,
    });
    expect(reply.status).toBe(200);
    const after = (await store.getNode(id))!;
    expect(after.content).toBe("이미지 설명 본문");
    expect(after.metadata.capture).toEqual({ kind: "idea", source: "ai" });
  });
});
