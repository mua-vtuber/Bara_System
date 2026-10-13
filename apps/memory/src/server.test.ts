/**
 * memory-api integration tests via Hono's `app.request()`.
 *
 * Same policy as the rest of the suite: real SqliteMemoryStore + real
 * Bgem3Embedder, no mocks. Tests share one embedder instance so the model
 * only loads once.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { AssetStore } from "./assets/asset-store.ts";
import { Bgem3Embedder } from "./embedding/bge-m3.ts";
import { openMemoryDatabase } from "./db/migrations.ts";
import { SqliteMemoryStore } from "./db/store.ts";
import { HybridRetriever } from "./memory/retriever.ts";
import { ContextAssembler } from "./memory/context-assembler.ts";
import { FENCE_CLOSE_TAG, FENCE_OPEN_TAG } from "./memory/context-fence.ts";
import { buildMemoryApi } from "./server.ts";
import { APP_VERSION } from "./version.ts";
import { createAuthGate } from "./server-internal/auth-gate.ts";
import { SseTokenStore } from "./federation/sse-tokens.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
}

function makeHarness(assetStore?: AssetStore): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const app = buildMemoryApi({ store, retriever, assembler, assetStore });
  return { app, db, store };
}

async function json(res: Response): Promise<unknown> {
  return res.json();
}

// ── /health ─────────────────────────────────────────────────────────────

describe("GET /health", () => {
  test("returns ok and the app version the release record is checked against", async () => {
    const h = makeHarness();
    const res = await h.app.request("/health");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toEqual({ ok: true, version: APP_VERSION });
    h.db.close();
  });
});

test("GET /client-info exposes the stable client contract without settings", async () => {
  const h = makeHarness();
  try {
    const res = await h.app.request("/client-info");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      protocolVersion: 1, version: APP_VERSION,
      captureKinds: ["idea", "decision", "question", "preference", "task", "information"],
      capabilities: ["ingest-receipts", "capture", "memory-deeplink", "cleanup-proposals", "editable-memory-body"],
    });
  } finally { h.db.close(); }
});

describe("information capture with an mcp-standard token", () => {
  let h: Harness;
  let dir: string;
  let app: Hono;
  let headers: Record<string, string>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bara-information-capture-"));
    h = makeHarness(new AssetStore(dir));
    const tokens = new SseTokenStore(join(dir, "tokens.json"));
    const token = tokens.issueToken("pet", undefined, undefined, "mcp-standard");
    headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    app = new Hono();
    app.use("*", createAuthGate({
      sseTokens: tokens,
      remoteAddrOf: () => "127.0.0.1",
      getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
    }));
    app.route("/", h.app);
  });
  afterEach(() => {
    h.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("saves information capture metadata on the ingest origin", async () => {
    const capture = { kind: "information", source: "user" };
    const content = "오늘 도서관에서 무인 대출기를 처음 사용했다";
    const saved = await app.request("/ingest", {
      method: "POST", headers,
      body: JSON.stringify({ source: "pet", content: { type: "text", data: content }, capture }),
    });
    expect(saved.status).toBe(201);
    const { originNodeId } = await saved.json() as { originNodeId: number };
    const read = await app.request(`/memories/${originNodeId}`, { headers });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ memory: { content, metadata: { capture } } });
    expect((await h.store.getNode(originNodeId))?.metadata.capture).toEqual(capture);
  });

  test("capture-only PATCH accepts information while preserving the body, tags and memory type", async () => {
    const content = "도서관 방문 기록\n\n#기록";
    const id = await h.store.addNode({
      content, memoryType: "episode",
      metadata: { tags: ["기록"], capture: { kind: "idea", source: "user" } },
    });
    const capture = { kind: "information", source: "user" };
    const patched = await app.request(`/memories/${id}`, {
      method: "PATCH", headers,
      body: JSON.stringify({ expectedRevision: 0, capture }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ changed: true, memory: { id, content, memoryType: "episode", metadata: { tags: ["기록"], capture } } });
    expect(await h.store.getNode(id)).toMatchObject({ content, memoryType: "episode", metadata: { tags: ["기록"], capture } });
    expect(await h.store.getRevisionsForNode(id)).toHaveLength(1);
  });
});

// ── POST /memories ──────────────────────────────────────────────────────

describe("POST /memories", () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => { h.db.close(); });

  test("stores a memory and returns id + node", async () => {
    const res = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "오늘 꿈에서 호랑이 봤음" }),
    });
    expect(res.status).toBe(201);
    const body = (await json(res)) as { id: number; node: { content: string } };
    expect(body.id).toBeGreaterThan(0);
    expect(body.node.content).toBe("오늘 꿈에서 호랑이 봤음");
  });

  test("rejects empty content", async () => {
    const res = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects missing content", async () => {
    const res = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("rejects invalid JSON", async () => {
    const res = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  test("persists metadata when provided", async () => {
    const res = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "디스코드에서 들어옴",
        metadata: { source: "discord", channelId: "12345" },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await json(res)) as {
      id: number;
      node: { metadata: Record<string, unknown> };
    };
    // 입력 통로 통합 Task 6 (D1) — /memories 도 saveTextInput 위임이라 원본 노드에
    // metadata.title(첫 줄 앞 50글자)이 합류한다(/ingest 텍스트 분기와 같은 규칙).
    // 봇·외부 SDK 가 보낸 칸(source/channelId)은 extraMetadata 로 그대로 보존된다.
    expect(body.node.metadata.source).toBe("discord");
    expect(body.node.metadata.channelId).toBe("12345");
    expect(body.node.metadata.title).toBe("디스코드에서 들어옴");
  });

  test("clamps importance to [0, 1]", async () => {
    const res = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "테스트", importance: 5 }),
    });
    const body = (await json(res)) as { node: { importance: number } };
    expect(body.node.importance).toBe(1);
  });

  test("accepts known memoryType, ignores unknown", async () => {
    const ok = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "선호 정보", memoryType: "preference" }),
    });
    const okBody = (await json(ok)) as { node: { memoryType: string } };
    expect(okBody.node.memoryType).toBe("preference");

    const bad = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "이상한 타입", memoryType: "invalid" }),
    });
    const badBody = (await json(bad)) as { node: { memoryType: string } };
    expect(badBody.node.memoryType).toBe("fact"); // 기본값으로 fallback
  });
});

// ── POST /search ────────────────────────────────────────────────────────

describe("POST /search", () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => { h.db.close(); });

  async function ingest(content: string): Promise<number> {
    const res = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const body = (await json(res)) as { id: number };
    return body.id;
  }

  test("returns retrieved memories sorted by score", async () => {
    const coffee = await ingest("철수는 커피를 좋아한다");
    await ingest("자동차를 새로 샀다");
    await ingest("오늘 비가 왔다");

    const res = await h.app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "커피", limit: 5 }),
    });
    expect(res.status).toBe(200);
    const body = (await json(res)) as {
      query: string;
      count: number;
      results: Array<{ id: number; content: string; score: number }>;
    };
    expect(body.query).toBe("커피");
    expect(body.count).toBeGreaterThanOrEqual(1);
    expect(body.results[0]!.id).toBe(coffee);
    // Sorted
    for (let i = 1; i < body.results.length; i++) {
      expect(body.results[i - 1]!.score).toBeGreaterThanOrEqual(
        body.results[i]!.score,
      );
    }
  });

  test("rejects empty query", async () => {
    const res = await h.app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns assembled context block when contextBudget > 0", async () => {
    await ingest("A 카페에서 라떼 마심");
    await ingest("B 카페에서 아메리카노 마심");

    const res = await h.app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "카페",
        limit: 5,
        contextBudget: 500,
      }),
    });
    const body = (await json(res)) as {
      context?: {
        memoryBlock: string;
        tokensUsed: number;
        memoriesIncluded: number;
      };
    };
    expect(body.context).toBeDefined();
    // T12 — assembled block is wrapped in the injection fence at reply time;
    // the [관련 기억] header lives inside it.
    expect(body.context!.memoryBlock).toContain(FENCE_OPEN_TAG);
    expect(body.context!.memoryBlock).toContain(FENCE_CLOSE_TAG);
    expect(body.context!.memoryBlock).toContain("[관련 기억]");
    expect(body.context!.memoriesIncluded).toBeGreaterThanOrEqual(1);
  });

  test("omits context block when budget is 0", async () => {
    await ingest("샘플");
    const res = await h.app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "샘플", limit: 3 }),
    });
    const body = (await json(res)) as { context?: unknown };
    expect(body.context).toBeUndefined();
  });
});

// ── GET /memories (recent) ──────────────────────────────────────────────

describe("GET /memories?recent=N", () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => { h.db.close(); });

  test("returns most-recent memories in descending creation order", async () => {
    for (const c of ["첫째", "둘째", "셋째", "넷째"]) {
      await h.app.request("/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: c }),
      });
    }
    const res = await h.app.request("/memories?recent=3");
    expect(res.status).toBe(200);
    const body = (await json(res)) as {
      count: number;
      memories: Array<{ content: string }>;
    };
    expect(body.count).toBe(3);
    expect(body.memories[0]!.content).toBe("넷째");
    expect(body.memories[1]!.content).toBe("셋째");
    expect(body.memories[2]!.content).toBe("둘째");
  });

  test("default limit is 10", async () => {
    for (let i = 0; i < 15; i++) {
      await h.app.request("/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `m${i}` }),
      });
    }
    const res = await h.app.request("/memories");
    const body = (await json(res)) as { count: number };
    expect(body.count).toBe(10);
  });

  test("empty store returns empty list", async () => {
    const res = await h.app.request("/memories");
    const body = (await json(res)) as { count: number; memories: unknown[] };
    expect(body.count).toBe(0);
    expect(body.memories).toEqual([]);
  });
});

// ── GET /memories/:id ───────────────────────────────────────────────────

describe("GET /memories/:id", () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => { h.db.close(); });

  test("returns the memory by id", async () => {
    const created = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "단건 조회" }),
    });
    const { id } = (await json(created)) as { id: number };
    const res = await h.app.request(`/memories/${id}`);
    expect(res.status).toBe(200);
    const body = (await json(res)) as { memory: { id: number; content: string } };
    expect(body.memory.id).toBe(id);
    expect(body.memory.content).toBe("단건 조회");
  });

  test("404 for unknown id", async () => {
    const res = await h.app.request("/memories/99999");
    expect(res.status).toBe(404);
  });

  test("400 for non-numeric id", async () => {
    const res = await h.app.request("/memories/abc");
    expect(res.status).toBe(400);
  });
});

// ── POST /memories/batch-get (T22 / spec C) ─────────────────────────────

describe("POST /memories/batch-get", () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => { h.db.close(); });

  async function store(content: string): Promise<number> {
    const res = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const { id } = (await json(res)) as { id: number };
    return id;
  }

  async function batchGet(ids: unknown): Promise<Response> {
    return h.app.request("/memories/batch-get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
  }

  test("found 메모리 전체 + 요청 순서 보존 + full get_memory 형태(imageAttachments 포함)", async () => {
    const idA = await store("배치 조회 A");
    const idB = await store("배치 조회 B");
    const idC = await store("배치 조회 C");

    // 요청 순서를 id 삽입 순서와 다르게 섞는다 — getNodesByIds 의 IN() 쿼리는
    // 순서를 보존하지 않으므로, 재정렬 로직이 없으면 이 시험이 깨진다.
    const res = await batchGet([idC, idA, idB]);
    expect(res.status).toBe(200);
    const body = (await json(res)) as {
      memories: Array<{ id: number; content: string; imageAttachments: unknown[] }>;
      notFound: number[];
    };
    expect(body.memories.map((m) => m.id)).toEqual([idC, idA, idB]);
    expect(body.memories.map((m) => m.content)).toEqual([
      "배치 조회 C",
      "배치 조회 A",
      "배치 조회 B",
    ]);
    expect(body.memories.every((m) => Array.isArray(m.imageAttachments))).toBe(true);
    expect(body.notFound).toEqual([]);
  });

  test("존재하지 않는 id 는 notFound 에 정직하게 담긴다(조용한 누락 금지)", async () => {
    const idA = await store("배치 조회 존재");
    const res = await batchGet([idA, 999999, 888888]);
    expect(res.status).toBe(200);
    const body = (await json(res)) as {
      memories: Array<{ id: number }>;
      notFound: number[];
    };
    expect(body.memories.map((m) => m.id)).toEqual([idA]);
    expect(body.notFound).toEqual([999999, 888888]);
  });

  test("ids 빈 배열 → 400", async () => {
    const res = await batchGet([]);
    expect(res.status).toBe(400);
  });

  test("ids 누락 → 400", async () => {
    const res = await h.app.request("/memories/batch-get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("ids 에 문자열/음수 섞이면 → 400", async () => {
    const idA = await store("배치 조회 방어");
    const bad = await batchGet([idA, "not-a-number"]);
    expect(bad.status).toBe(400);
    const neg = await batchGet([idA, -1]);
    expect(neg.status).toBe(400);
  });

  test("상한(100) 초과 → 400, 상한 그대로는 통과", async () => {
    const overCap = Array.from({ length: 101 }, (_, i) => i + 1);
    const overRes = await batchGet(overCap);
    expect(overRes.status).toBe(400);

    const id = await store("배치 조회 상한 확인");
    const atCap = [id, ...Array.from({ length: 99 }, (_, i) => 10_000_000 + i)];
    expect(atCap.length).toBe(100);
    const atCapRes = await batchGet(atCap);
    expect(atCapRes.status).toBe(200);
  });
});

// ── PATCH /memories/:id + POST /memories/:id/append ─────────────────────

describe("memory edit/append", () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => { h.db.close(); });

  test("returns an editable body while preserving tagged raw content and metadata", async () => {
    const id = await h.store.addNode({ content: "원문\n\n#중요 #프로젝트:바라", metadata: { tags: ["중요", "프로젝트:바라"] } });
    const res = await h.app.request(`/memories/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { memory: { content: string; editableContent: string; metadata: { tags: string[] } } };
    expect(body.memory.content).toBe("원문\n\n#중요 #프로젝트:바라");
    expect(body.memory.editableContent).toBe("원문");
    expect(body.memory.metadata.tags).toEqual(["중요", "프로젝트:바라"]);
  });

  test("PATCH changes or clears capture with a revision while preserving content and tags", async () => {
    const id = await h.store.addNode({ content: "원문\n\n#중요", metadata: { tags: ["중요"] } });
    const patch = (body: unknown) => h.app.request(`/memories/${id}`, { method: "PATCH",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await patch({ expectedRevision: 0, capture: { kind: "auto", source: "ai" } })).status).toBe(400);
    expect((await patch({ expectedRevision: 0, capture: { kind: "idea", source: "user" } })).status).toBe(200);
    expect((await h.store.getNode(id))?.metadata.capture).toEqual({ kind: "idea", source: "user" });
    expect((await patch({ expectedRevision: 1, capture: { kind: "task", source: "ai" } })).status).toBe(409);
    expect((await h.store.getNode(id))?.metadata.capture).toEqual({ kind: "idea", source: "user" });
    expect((await h.store.getNode(id))?.content).toBe("원문\n\n#중요");
    expect((await patch({ expectedRevision: 0, capture: null })).status).toBe(409);
    expect((await patch({ expectedRevision: 1, capture: null })).status).toBe(200);
    expect((await h.store.getNode(id))?.metadata.capture).toBeUndefined();
    expect((await h.store.getNode(id))?.metadata.tags).toEqual(["중요"]);
    expect((await h.store.getRevisionsForNode(id)).length).toBe(2);
  });

  test("PATCH keeps the same id and records a revision snapshot", async () => {
    const created = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "수정 전 메모" }),
    });
    const { id } = (await json(created)) as { id: number };

    const edited = await h.app.request(`/memories/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "수정 후 메모",
        reason: "오탈자",
        editor: "tester",
        source: "api",
      }),
    });

    expect(edited.status).toBe(200);
    const body = (await json(edited)) as {
      changed: boolean;
      memory: { id: number; content: string; updatedAt: string | null };
      revision: {
        oldNodeId: number;
        newNodeId: number;
        oldContent: string | null;
        newContent: string | null;
        editor: string | null;
        editSource: string | null;
      };
    };
    expect(body.changed).toBe(true);
    expect(body.memory).toMatchObject({ id, content: "수정 후 메모" });
    expect(body.memory.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(body.revision).toMatchObject({
      oldNodeId: id,
      newNodeId: id,
      oldContent: "수정 전 메모",
      newContent: "수정 후 메모",
      editor: "tester",
      editSource: "api",
    });

    const fetched = await h.app.request(`/memories/${id}`);
    const fetchedBody = (await json(fetched)) as { memory: { content: string; updatedAt: string | null } };
    expect(fetchedBody.memory.content).toBe("수정 후 메모");
    expect(fetchedBody.memory.updatedAt).toBe(body.memory.updatedAt);
  });

  test("PATCH keeps hidden hashtags and treats unchanged visible text as no-op", async () => {
    const id = await h.store.addNode({
      content: "같은 내용\n\n#중요 #프로젝트:바라",
    });

    const edited = await h.app.request(`/memories/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "같은 내용" }),
    });

    expect(edited.status).toBe(200);
    const body = (await json(edited)) as { changed: boolean; revision: unknown };
    expect(body.changed).toBe(false);
    expect(body.revision).toBeNull();
    expect(await h.store.getRevisionsForNode(id)).toEqual([]);
    expect((await h.store.getNode(id))?.content).toBe("같은 내용\n\n#중요 #프로젝트:바라");
  });

  test("PATCH rejects new hashtags in edited body", async () => {
    const id = await h.store.addNode({ content: "본문" });

    const edited = await h.app.request(`/memories/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "본문 #새태그" }),
    });

    expect(edited.status).toBe(400);
    const body = (await json(edited)) as { error: string };
    expect(body.error).toContain("hashtags");
    expect((await h.store.getNode(id))?.content).toBe("본문");
  });

  test("PATCH edits only visible body and preserves existing hidden tag tokens", async () => {
    const id = await h.store.addNode({
      content: "수정 전 메모\n\n#중요 #프로젝트:바라",
    });

    const edited = await h.app.request(`/memories/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "수정 후 메모", reason: "본문 정정" }),
    });

    expect(edited.status).toBe(200);
    const body = (await json(edited)) as {
      changed: boolean;
      memory: { content: string; updatedAt: string | null };
      revision: { oldContent: string | null; newContent: string | null };
    };
    expect(body.changed).toBe(true);
    expect(body.memory.content).toBe("수정 후 메모\n\n#중요 #프로젝트:바라");
    expect(body.memory.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(body.revision.oldContent).toBe("수정 전 메모\n\n#중요 #프로젝트:바라");
    expect(body.revision.newContent).toBe("수정 후 메모\n\n#중요 #프로젝트:바라");
  });

  test("POST /memories/:id/tags adds a plain tag through the separated tag route", async () => {
    const id = await h.store.addNode({ content: "태그 대상" });

    const tagged = await h.app.request(`/memories/${id}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag: "#중요", editor: "tester", source: "dashboard" }),
    });

    expect(tagged.status).toBe(200);
    const body = (await json(tagged)) as {
      changed: boolean;
      tag: string;
      memory: { content: string; updatedAt: string | null };
      revision: { oldContent: string | null; newContent: string | null; editSource: string | null };
    };
    expect(body.changed).toBe(true);
    expect(body.tag).toBe("중요");
    expect(body.memory.content).toBe("태그 대상\n\n#중요");
    expect(body.memory.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(body.revision.oldContent).toBe("태그 대상");
    expect(body.revision.newContent).toBe("태그 대상\n\n#중요");
    expect(body.revision.editSource).toBe("dashboard");

    const edge = h.db
      .query(
        `SELECT cn.name AS name, nce.role AS role, nce.provenance AS provenance
           FROM node_concept_edges nce
           JOIN concept_nodes cn ON cn.concept_id = nce.concept_id
          WHERE nce.node_id = ?`,
      )
      .get(id) as { name: string; role: string; provenance: string } | null;
    expect(edge).toEqual({ name: "중요", role: "tag", provenance: "hashtag" });
  });

  test("POST /memories/:id/tags is a no-op for duplicate tags", async () => {
    const id = await h.store.addNode({ content: "태그 대상\n\n#중요" });

    const tagged = await h.app.request(`/memories/${id}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag: "중요" }),
    });

    expect(tagged.status).toBe(200);
    const body = (await json(tagged)) as { changed: boolean; revision: unknown };
    expect(body.changed).toBe(false);
    expect(body.revision).toBeNull();
    expect((await h.store.getNode(id))?.content).toBe("태그 대상\n\n#중요");
    expect(await h.store.getRevisionsForNode(id)).toEqual([]);
  });

  test("POST /memories/:id/tags rejects colon tags and mixed text", async () => {
    const id = await h.store.addNode({ content: "태그 대상" });

    const colon = await h.app.request(`/memories/${id}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag: "#프로젝트:바라" }),
    });
    const mixed = await h.app.request(`/memories/${id}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag: "중요 태그" }),
    });

    expect(colon.status).toBe(400);
    expect(mixed.status).toBe(400);
    expect((await h.store.getNode(id))?.content).toBe("태그 대상");
  });

  test("PATCH rejects file-backed source nodes", async () => {
    const id = await h.store.addNode({
      content: "문서 원본",
      sourceType: "document",
    });

    const edited = await h.app.request(`/memories/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "직접 수정 시도" }),
    });

    expect(edited.status).toBe(409);
  });

  test("append creates a new node and links it to the target", async () => {
    const created = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "대상 메모" }),
    });
    const { id } = (await json(created)) as { id: number };

    const appended = await h.app.request(`/memories/${id}/append`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "추가 기록", author: "tester", platform: "api" }),
    });

    expect(appended.status).toBe(201);
    const body = (await json(appended)) as {
      targetId: number;
      appendedId: number;
      node: { content: string } | null;
    };
    expect(body.targetId).toBe(id);
    expect(body.appendedId).not.toBe(id);
    expect(body.node?.content).toBe("추가 기록");

    const edge = h.db
      .prepare(
        `SELECT source_id, target_id, relation, provenance, source_node_id
         FROM knowledge_edges
         WHERE source_id = ? AND target_id = ? AND relation = 'links_to'`,
      )
      .get(body.appendedId, id) as {
        source_id: number;
        target_id: number;
        relation: string;
        provenance: string;
        source_node_id: number | null;
      } | null;
    expect(edge).toMatchObject({
      source_id: body.appendedId,
      target_id: id,
      relation: "links_to",
      provenance: "user_input",
      source_node_id: body.appendedId,
    });
  });
});

// ── DELETE /memories/:id ────────────────────────────────────────────────

describe("DELETE /memories/:id", () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => { h.db.close(); });

  test("deletes the memory", async () => {
    const created = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "삭제 대상" }),
    });
    const { id } = (await json(created)) as { id: number };

    const del = await h.app.request(`/memories/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const after = await h.app.request(`/memories/${id}`);
    expect(after.status).toBe(404);
  });

  test("404 when deleting unknown id", async () => {
    const res = await h.app.request("/memories/99999", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

// ── GET /stats ──────────────────────────────────────────────────────────

describe("GET /stats", () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => { h.db.close(); });

  test("returns zero counts on empty store", async () => {
    const res = await h.app.request("/stats");
    const body = (await json(res)) as {
      totalMemories: number;
      memoriesLast7Days: number;
      totalEdges: number;
    };
    expect(body.totalMemories).toBe(0);
    expect(body.memoriesLast7Days).toBe(0);
    expect(body.totalEdges).toBe(0);
  });

  test("reflects inserted memories", async () => {
    for (let i = 0; i < 3; i++) {
      await h.app.request("/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `m${i}` }),
      });
    }
    const res = await h.app.request("/stats");
    const body = (await json(res)) as {
      totalMemories: number;
      memoriesLast7Days: number;
    };
    expect(body.totalMemories).toBe(3);
    expect(body.memoriesLast7Days).toBe(3);
  });
});

// ── DELETE /memories/by-source — 메시지 삭제 동기화 ──────────────────────

describe("DELETE /memories/by-source", () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => { h.db.close(); });

  test("messageId 일치 노드만 삭제", async () => {
    const r1 = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "디스코드 메모 A",
        metadata: { source: "discord-channel", messageId: "msg-A" },
      }),
    });
    const { id: idA } = (await json(r1)) as { id: number };

    const r2 = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "디스코드 메모 B",
        metadata: { source: "discord-channel", messageId: "msg-B" },
      }),
    });
    const { id: idB } = (await json(r2)) as { id: number };

    const del = await h.app.request(
      "/memories/by-source?messageId=msg-A&platform=discord",
      { method: "DELETE" },
    );
    expect(del.status).toBe(200);
    const body = (await json(del)) as {
      deletedCount: number;
      deletedIds: number[];
    };
    expect(body.deletedCount).toBe(1);
    expect(body.deletedIds).toEqual([idA]);

    // 다른 메시지는 보존
    const afterA = await h.app.request(`/memories/${idA}`);
    expect(afterA.status).toBe(404);
    const afterB = await h.app.request(`/memories/${idB}`);
    expect(afterB.status).toBe(200);
  });

  test("매칭 없으면 200 + deletedCount 0", async () => {
    const res = await h.app.request(
      "/memories/by-source?messageId=nope",
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    const body = (await json(res)) as { deletedCount: number };
    expect(body.deletedCount).toBe(0);
  });

  test("messageId 누락 시 400", async () => {
    const res = await h.app.request("/memories/by-source", {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
  });

  test("messageId 공백 문자열만 → 400", async () => {
    const res = await h.app.request(
      "/memories/by-source?messageId=%20",
      { method: "DELETE" },
    );
    expect(res.status).toBe(400);
  });

  test("platform 필터: 다른 플랫폼 노드는 보존", async () => {
    const dc = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "디스코드",
        metadata: { source: "discord-dm", messageId: "same-id" },
      }),
    });
    const { id: idDc } = (await json(dc)) as { id: number };

    const tg = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "텔레그램",
        metadata: { source: "telegram-private", messageId: "same-id" },
      }),
    });
    const { id: idTg } = (await json(tg)) as { id: number };

    const del = await h.app.request(
      "/memories/by-source?messageId=same-id&platform=discord",
      { method: "DELETE" },
    );
    const body = (await json(del)) as { deletedIds: number[] };
    expect(body.deletedIds).toEqual([idDc]);

    const tgAfter = await h.app.request(`/memories/${idTg}`);
    expect(tgAfter.status).toBe(200);
  });
});

// ── GET /archive + POST /archive/:id/restore ────────────────────────────

describe("GET /archive + POST /archive/:id/restore", () => {
  test("archive 노드 목록 + 복구 가능", async () => {
    const h = makeHarness();

    const id = await h.store.addNode({ content: "휴지통 테스트", importance: 0.2 });
    await h.store.trashNodes([id], "cascade");

    const listRes = await h.app.request("/archive");
    expect(listRes.status).toBe(200);
    const listBody = (await json(listRes)) as { archive: Array<{ id: number }> };
    expect(listBody.archive).toHaveLength(1);
    expect(listBody.archive[0]!.id).toBe(id);

    const restoreRes = await h.app.request(`/archive/${id}/restore`, { method: "POST" });
    expect(restoreRes.status).toBe(200);
    const restoreBody = (await json(restoreRes)) as { restored: { id: number; content: string } };
    expect(restoreBody.restored.id).toBe(id);
    expect(restoreBody.restored.content).toBe("휴지통 테스트");

    // 복구 후 메인 DB에 존재
    expect(await h.store.getNode(id)).not.toBeNull();

    h.db.close();
  });

  test("POST /archive/:id/restore: 없는 id → 404", async () => {
    const h = makeHarness();
    const res = await h.app.request("/archive/99999/restore", { method: "POST" });
    expect(res.status).toBe(404);
    h.db.close();
  });

  test("POST /archive/:id/restore: 비정수 id → 400", async () => {
    const h = makeHarness();
    const res = await h.app.request("/archive/abc/restore", { method: "POST" });
    expect(res.status).toBe(400);
    h.db.close();
  });
});

// ── GET /evolver/activity ────────────────────────────────────────────────

describe("GET /evolver/activity", () => {
  test("최근 활동 로그 반환", async () => {
    const h = makeHarness();

    await h.store.logAutoCleanupActivity({
      clusterEdgesAdded: 2,
      nodesArchived: 1,
    });

    const res = await h.app.request("/evolver/activity?limit=5");
    expect(res.status).toBe(200);
    const body = (await json(res)) as { activity: Array<{ clusterEdgesAdded: number }> };
    expect(body.activity).toHaveLength(1);
    expect(body.activity[0]!.clusterEdgesAdded).toBe(2);

    h.db.close();
  });

  test("빈 로그 → 빈 배열 반환", async () => {
    const h = makeHarness();
    const res = await h.app.request("/evolver/activity");
    expect(res.status).toBe(200);
    const body = (await json(res)) as { activity: unknown[] };
    expect(body.activity).toEqual([]);
    h.db.close();
  });
});

// ── GET /admin/trash/soon-to-purge — Phase 5.7.3 W4 ──────────────────────

describe("GET /admin/trash/soon-to-purge", () => {
  function setArchivedAtDaysAgo(db: Database, id: number, daysAgo: number): void {
    const ts = new Date(Date.now() - daysAgo * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    db.prepare("UPDATE knowledge_nodes_archive SET archived_at = ? WHERE id = ?").run(ts, id);
  }

  test("빈 휴지통 → items: [] + days/retentionDays 정합", async () => {
    const h = makeHarness();
    const res = await h.app.request("/admin/trash/soon-to-purge?days=7");
    expect(res.status).toBe(200);
    const body = (await json(res)) as {
      days: number;
      retentionDays: number;
      items: unknown[];
    };
    expect(body.days).toBe(7);
    expect(body.retentionDays).toBe(30); // schema default
    expect(body.items).toEqual([]);
    h.db.close();
  });

  test("25일 archive 노드 → items 안 한 줄 + nodesPurged 영구 삭제 흐름과 분리", async () => {
    const h = makeHarness();
    const id = await h.store.addNode({ content: "임박 노드", importance: 0.2 });
    await h.store.trashNodes([id], "cascade");
    setArchivedAtDaysAgo(h.db, id, 25); // 25 + 7 = 32 > 30 → 임박 윈도우 안

    const res = await h.app.request("/admin/trash/soon-to-purge?days=7");
    expect(res.status).toBe(200);
    const body = (await json(res)) as {
      days: number;
      retentionDays: number;
      items: Array<{ id: number }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.id).toBe(id);
    h.db.close();
  });

  test("days 미지정 시 default = 7", async () => {
    const h = makeHarness();
    const res = await h.app.request("/admin/trash/soon-to-purge");
    expect(res.status).toBe(200);
    const body = (await json(res)) as { days: number };
    expect(body.days).toBe(7);
    h.db.close();
  });

  test("days=-1 → 400 + error 메시지", async () => {
    const h = makeHarness();
    const res = await h.app.request("/admin/trash/soon-to-purge?days=-1");
    expect(res.status).toBe(400);
    const body = (await json(res)) as { error: string };
    expect(body.error).toContain("days");
    h.db.close();
  });

  test("days=NaN (비숫자) → 400", async () => {
    const h = makeHarness();
    const res = await h.app.request("/admin/trash/soon-to-purge?days=abc");
    expect(res.status).toBe(400);
    h.db.close();
  });

  test("days > retentionDays → 400", async () => {
    const h = makeHarness();
    const res = await h.app.request("/admin/trash/soon-to-purge?days=99");
    expect(res.status).toBe(400);
    const body = (await json(res)) as { error: string };
    expect(body.error).toContain("retentionDays");
    h.db.close();
  });
});

// ── POST /cleanup — extractor 없으면 503 ────────────────────────────────

describe("POST /cleanup (no extractor)", () => {
  test("returns 503 with explanation when extractor missing", async () => {
    const h = makeHarness();
    const res = await h.app.request("/cleanup", { method: "POST" });
    expect(res.status).toBe(503);
    const body = (await json(res)) as { error: string };
    expect(body.error).toContain("extractor");
    h.db.close();
  });
});

// ── POST /memories/from-text — extractor 없으면 503 ──────────────────────

describe("POST /memories/from-text (no extractor)", () => {
  test("returns 503 when extractor missing", async () => {
    const h = makeHarness();
    const res = await h.app.request("/memories/from-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "테스트" }),
    });
    expect(res.status).toBe(503);
    h.db.close();
  });
});

// ── preserveRaw + protectUntil — store 레벨 통합 ──────────────────────────
// server.ts의 preserveRaw 분기는 real extractor(LLM 필요)가 있어야 HTTP로
// 검증 가능. 대신 server.ts가 실제로 수행하는 store.addNode + protectUntil
// 합산 패턴을 store 레벨에서 직접 검증 — LLM 없이도 동작.

import { extractProtectUntil } from "./memory/protect-until.ts";

describe("preserveRaw 노드 + protectUntil — store 레벨 통합", () => {
  test("시간 표현 있는 본문 → store에 저장된 rawNode에 protectUntil 채워짐", async () => {
    const h = makeHarness();

    const rawText = "2027년 3월 말 발표 예정이다";
    const rawProtectUntil = extractProtectUntil(rawText);
    expect(rawProtectUntil).toBe("2027-03-31");

    const rawNodeId = await h.store.addNode({
      content: rawText,
      sourceType: "auto_capture",
      importance: 0.4,
      confidence: 1.0,
      metadata: {
        preservedRaw: true,
        extractedTo: [],
        ...(rawProtectUntil ? { protectUntil: rawProtectUntil } : {}),
      },
    });

    const node = await h.store.getNode(rawNodeId);
    expect(node).not.toBeNull();
    expect((node!.metadata as Record<string, unknown>).protectUntil).toBe("2027-03-31");
    expect((node!.metadata as Record<string, unknown>).preservedRaw).toBe(true);

    h.db.close();
  });
});

// ── Static dashboard serving ────────────────────────────────────────────

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("static dashboard serving", () => {
  let tmpDir: string;

  function makeStaticHarness(): {
    app: Hono;
    db: Database;
    cleanup: () => void;
  } {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    const retriever = new HybridRetriever(store, embedder);
    const assembler = new ContextAssembler();
    const app = buildMemoryApi({ store, retriever, assembler, staticDir: tmpDir });
    return {
      app,
      db,
      cleanup: () => db.close(),
    };
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bara-web-test-"));
    writeFileSync(
      join(tmpDir, "index.html"),
      "<!doctype html><title>dashboard</title><body>hi</body>",
    );
    writeFileSync(join(tmpDir, "extra.txt"), "static asset");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("GET / returns the dashboard HTML", async () => {
    const h = makeStaticHarness();
    const res = await h.app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type") ?? "").toContain("text/html");
    const text = await res.text();
    expect(text).toContain("dashboard");
    h.cleanup();
  });

  test("GET /web/extra.txt serves static asset", async () => {
    const h = makeStaticHarness();
    const res = await h.app.request("/web/extra.txt");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("static asset");
    h.cleanup();
  });

  test("missing static file returns 404", async () => {
    const h = makeStaticHarness();
    const res = await h.app.request("/web/does-not-exist");
    expect(res.status).toBe(404);
    h.cleanup();
  });

  test("path traversal attempt is blocked", async () => {
    const h = makeStaticHarness();
    // Try to escape via encoded ../ — Hono normalizes but we also guard explicitly.
    const res = await h.app.request("/web/..%2F..%2Fetc%2Fpasswd");
    // Either 404 (path normalized + miss) or 400 (rejected). Both are acceptable.
    expect([400, 404]).toContain(res.status);
    h.cleanup();
  });

  test("API endpoints still work alongside static serving", async () => {
    const h = makeStaticHarness();
    const post = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "static + api coexist" }),
    });
    expect(post.status).toBe(201);

    const recent = await h.app.request("/memories?recent=5");
    const body = (await recent.json()) as { count: number };
    expect(body.count).toBe(1);
    h.cleanup();
  });

  test("server without staticDir option leaves / unrouted (404)", async () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    const retriever = new HybridRetriever(store, embedder);
    const assembler = new ContextAssembler();
    const app = buildMemoryApi({ store, retriever, assembler }); // no staticDir
    const res = await app.request("/");
    expect(res.status).toBe(404);
    db.close();
  });

  // Phase 5.5.5 S9 회귀 가드 (2026-05-18). 옛 createMemoryApi default
  // staticDir은 `apps/web/` 를 가리켜 `apps/memory/web/dashboard/settings.html`
  // 이 404로 떨어졌다. default가 실제 디스크의 web 디렉토리 — 그 안에
  // 체크인된 첫 화면 shell + 대시보드/그래프/설정 HTML — 까지 닿는지 명시 검증.
  test("default staticDir resolves to apps/memory/web with checked-in assets", async () => {
    const { resolve } = await import("node:path");
    const { existsSync } = await import("node:fs");
    // src/server.test.ts → src/ 기준 ../web 이 default staticDir
    // (server.ts createMemoryApi 정착 위치와 동일 해석).
    const defaultStaticDir = resolve(import.meta.dir, "..", "web");
    expect(existsSync(defaultStaticDir)).toBe(true);
    expect(existsSync(resolve(defaultStaticDir, "index.html"))).toBe(true);
    expect(existsSync(resolve(defaultStaticDir, "dashboard.html"))).toBe(true);
    expect(existsSync(resolve(defaultStaticDir, "graph.html"))).toBe(true);
    expect(
      existsSync(resolve(defaultStaticDir, "dashboard", "settings.html")),
    ).toBe(true);
  });
});

// ── POST /admin/reset-memory — 데이터 초기화 (위험 영역) ──────────────────

describe("POST /admin/reset-memory", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("confirm 토큰 없으면 400 + 데이터 보존", async () => {
    const id = await h.store.addNode({ content: "보존 메모", importance: 0.5 });

    const res = await h.app.request("/admin/reset-memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const node = await h.store.getNode(id);
    expect(node).not.toBeNull();
  });

  test("confirm 토큰 오타면 400 + 데이터 보존", async () => {
    await h.store.addNode({ content: "보존 메모", importance: 0.5 });

    const res = await h.app.request("/admin/reset-memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "reset all memory" }),
    });

    expect(res.status).toBe(400);
    const stats = await h.store.getStats();
    expect(stats.totalMemories).toBe(1);
  });

  test("올바른 confirm 토큰 → 200 + deleted counts + DB 비움", async () => {
    const a = await h.store.addNode({ content: "메모 A", importance: 0.5 });
    const b = await h.store.addNode({ content: "메모 B", importance: 0.5 });
    await h.store.addEdge({ sourceId: a, targetId: b, relation: "related_to", weight: 0.5 ,
    provenance: "user_input",
    sourceNodeId: null,
});

    const res = await h.app.request("/admin/reset-memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "RESET ALL MEMORY" }),
    });

    expect(res.status).toBe(200);
    // deleted = 묶음 집계(ResetMemoryCounts §7.2) — 핵심 3칸 + 그룹 합 + 총합.
    const body = (await json(res)) as {
      message: string;
      deleted: {
        knowledgeNodes: number;
        knowledgeEdges: number;
        knowledgeNodesArchive: number;
        entities: number;
        entityEdges: number;
        summaries: number;
        conceptsAndPersons: number;
        assets: number;
        logs: number;
        boundary: number;
        totalRowsDeleted: number;
      };
    };
    expect(body.deleted.knowledgeNodes).toBe(2);
    expect(body.deleted.knowledgeEdges).toBe(1);
    expect(body.deleted.totalRowsDeleted).toBe(3); // 노드 2 + 엣지 1

    const stats = await h.store.getStats();
    expect(stats.totalMemories).toBe(0);
    expect(stats.totalEdges).toBe(0);
  });

  test("invalid JSON body → 400", async () => {
    const res = await h.app.request("/admin/reset-memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });
});

// ── POST /memories — Phase 5.7.2 W2 mode='immediate' 자동 트리거 분기 ──────
//
// 가짜 Ollama 서버 (Bun.serve) + 실제 OllamaClient + 실제 MemoryExtractor +
// 실제 SqliteMemoryStore + 실제 Bgem3Embedder 통합 흐름.
//
// CLAUDE.md "테스트 정책" 정합 — LlmClient 인터페이스 가짜 구현은 만들지
// 않는다. 옛 통합 테스트 흐름과 동일하게 OllamaClient 진짜 인스턴스 + 가짜
// Ollama HTTP 서버가 `/api/chat` 응답을 송출. 옛 mock-실제 전환 잠재 버그
// 우회 (mock 객체가 prod 안에 잔존 위험 0).

import { MemoryExtractor } from "./memory/extractor.ts";
import { OllamaClient } from "./llm/ollama-client.ts";
import { Hono as HonoCtor } from "hono";
import type { MemorySettings } from "./settings/memory-settings.ts";
import { MEMORY_DEFAULTS } from "./settings/memory-schema.ts";

/** 한 테스트 안에서 LLM 응답을 갈음할 수 있도록 mutable container 사용. */
interface FakeOllamaState {
  /** 다음 `/api/chat` 호출이 던질 응답 본문 (LLM extractor 의 JSON 배열 문자열). */
  nextContent: string;
  /** true 면 다음 호출이 500 으로 떨어짐 — extractor 실패 fallback 검증용. */
  nextError: boolean;
  /** 가동 횟수 누적 — 호출 검증용. */
  callCount: number;
}

function buildFakeOllamaServer(state: FakeOllamaState): ReturnType<typeof Bun.serve> {
  const app = new HonoCtor();
  app.post("/api/chat", async (c) => {
    state.callCount += 1;
    if (state.nextError) {
      return c.json({ error: "fake-ollama 의도된 실패" }, 500);
    }
    return c.json({
      model: "fake-extractor-model",
      message: { role: "assistant", content: state.nextContent },
      done: true,
    });
  });
  return Bun.serve({ port: 0, fetch: app.fetch });
}

interface ExtractorHarness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
  ollamaServer: ReturnType<typeof Bun.serve>;
  fakeState: FakeOllamaState;
  settings: MemorySettings;
}

/**
 * settings 객체 한 벌 구성. mode 갈음 가능하게 인자로 받음.
 * MEMORY_DEFAULTS structuredClone — getMemorySettings(filePath) 가 부재 시
 * cloneDefaults 반환하는 흐름과 동일 결과.
 */
function buildSettings(mode: "immediate" | "backfill", enabled = true): MemorySettings {
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  settings.llm.extractor.enabled = enabled;
  settings.llm.extractor.mode = mode;
  return settings;
}

function makeExtractorHarness(opts: {
  mode: "immediate" | "backfill";
  enabled?: boolean;
  withExtractor?: boolean;
}): ExtractorHarness {
  const fakeState: FakeOllamaState = {
    nextContent: "[]",
    nextError: false,
    callCount: 0,
  };
  const ollamaServer = buildFakeOllamaServer(fakeState);

  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();

  let extractor: MemoryExtractor | undefined;
  if (opts.withExtractor !== false) {
    const llm = new OllamaClient({
      baseUrl: `http://127.0.0.1:${ollamaServer.port}`,
      model: "fake-extractor-model",
    });
    extractor = new MemoryExtractor(llm, store, embedder, {
      // duplicateSim 을 충분히 높게 잡아 raw + atomic 자식 사이 dedup 충돌을
      // 차단 — extract-first 순서 검증이 본 테스트의 주된 목적.
      duplicateSim: 0.999,
      minImportance: 0,
    });
  }

  const settings = buildSettings(opts.mode, opts.enabled ?? true);

  const app = buildMemoryApi({
    store,
    retriever,
    assembler,
    extractor,
    getSettings: () => settings,
  });

  return { app, db, store, ollamaServer, fakeState, settings };
}

describe("POST /memories — Phase 5.7.2 W2 mode 분기", () => {
  let h: ExtractorHarness;
  let warnSpy: { calls: string[]; restore: () => void };

  function captureConsoleWarn(): { calls: string[]; restore: () => void } {
    const calls: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      calls.push(args.map(String).join(" "));
    };
    return {
      calls,
      restore: () => {
        console.warn = original;
      },
    };
  }

  afterEach(() => {
    if (warnSpy) warnSpy.restore();
    if (h) {
      h.ollamaServer.stop(true);
      h.db.close();
    }
  });

  test("mode='immediate' + extractor 가용 + 정상 → atomic 자식 N + raw 1 + merged_into 엣지 N", async () => {
    h = makeExtractorHarness({ mode: "immediate" });
    warnSpy = captureConsoleWarn();
    // 가짜 LLM 이 atomic 두 항목 반환.
    h.fakeState.nextContent = JSON.stringify([
      { content: "사용자는 김치찌개를 좋아한다", memoryType: "preference", importance: 0.6 },
      { content: "오늘 점심에 김치찌개를 먹었다", memoryType: "episode", importance: 0.5 },
    ]);

    const res = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "오늘 점심에 김치찌개를 먹었고 맛있었다" }),
    });
    expect(res.status).toBe(201);
    const body = (await json(res)) as {
      id: number;
      extracted: number[];
      bumped: number[];
      extractor: { provider: string };
      node: { content: string; metadata: Record<string, unknown> };
    };

    // 응답 shape 검증 — immediate 갈래 한정 신규 칸 (extracted/bumped/extractor).
    expect(body.id).toBeGreaterThan(0);
    expect(body.extractor.provider).toContain("fake-extractor-model");
    expect(body.extracted.length).toBe(2);
    expect(body.bumped.length).toBe(0);
    expect(body.node.content).toBe("오늘 점심에 김치찌개를 먹었고 맛있었다");
    // 입력 통로 통합 Task 6 — saveTextInput 위임이라 원본은 extracted:1 + extractedTo
    // 로 마킹한다(옛 preservedRaw 칸 대신 getBackfillCandidates 미추출 판정과 짝).
    // regexL0 미주입이라 extractedTo = LLM atomic ids 와 동일.
    expect(body.node.metadata.extracted).toBe(1);
    expect(body.node.metadata.extractedTo).toEqual(body.extracted);

    // store 내부 검증 — raw + atomic 자식 + merged_into 엣지 세 항목.
    const rawNode = await h.store.getNode(body.id);
    expect(rawNode).not.toBeNull();
    expect(rawNode!.sourceType).toBe("auto_capture");

    for (const childId of body.extracted) {
      const childNode = await h.store.getNode(childId);
      expect(childNode).not.toBeNull();
      expect(childNode!.sourceType).toBe("llm_extract");

      // child → raw merged_into 엣지 한 줄씩 확보됐는지. getNeighbors 가
      // 양방향 반환 → relation + 방향 (sourceId/targetId) 둘 다 검증.
      const edges = await h.store.getNeighbors(childId);
      const mergedIntoEdges = edges.filter(
        (e) =>
          e.relation === "merged_into" &&
          e.sourceId === childId &&
          e.targetId === body.id,
      );
      expect(mergedIntoEdges.length).toBe(1);
    }

    // 가짜 LLM 호출 가동 1회 (extractor.extractAndStore 안 LLM 호출 1회).
    expect(h.fakeState.callCount).toBe(1);
    // 정상 갈래 = warn 로그 0 (silent fallback 정황 X).
    expect(warnSpy.calls).toEqual([]);
  });

  test("mode='immediate' + extractor 가용 + extractor 실패 → raw 만 fallback + 명시 warn 로그", async () => {
    h = makeExtractorHarness({ mode: "immediate" });
    warnSpy = captureConsoleWarn();
    // 가짜 Ollama 가 500 송출 → OllamaClient 가 throw → extractor 가 throw.
    h.fakeState.nextError = true;

    const res = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "extractor 실패해서 원본만 저장했다" }),
    });
    expect(res.status).toBe(201);
    const body = (await json(res)) as {
      id: number;
      node: { content: string; metadata: Record<string, unknown> };
      extracted?: unknown;
      extractor?: unknown;
    };

    // 응답 shape = backfill 갈래와 동일 (extracted/extractor 칸 부재).
    expect(body.id).toBeGreaterThan(0);
    expect(body.extracted).toBeUndefined();
    expect(body.extractor).toBeUndefined();
    expect(body.node.content).toBe("extractor 실패해서 원본만 저장했다");
    // 원본만 저장 정합 — 추출 마킹(extracted) 없음 (plain fallback 갈래).
    expect(body.node.metadata.extracted).toBeUndefined();

    // 명시 warn 로그 가동 1회 + 사유 메시지 포함 (saveTextInput 위임 후 메시지).
    expect(warnSpy.calls.length).toBe(1);
    expect(warnSpy.calls[0]).toContain("mode='immediate' extractor");
    expect(warnSpy.calls[0]).toContain("원본만 저장 fallback");

    // store 내부 검증 — 노드 1개만 (atomic 자식 0).
    const stats = await h.store.getStats();
    expect(stats.totalMemories).toBe(1);
  });

  test("mode='immediate' + extractor 미가용 (deps.extractor 미주입) → raw 만 fallback + 명시 warn 로그", async () => {
    h = makeExtractorHarness({ mode: "immediate", withExtractor: false });
    warnSpy = captureConsoleWarn();

    const res = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "extractor 미가용 시나리오" }),
    });
    expect(res.status).toBe(201);
    const body = (await json(res)) as {
      id: number;
      node: { content: string };
      extracted?: unknown;
    };

    expect(body.id).toBeGreaterThan(0);
    expect(body.extracted).toBeUndefined();
    expect(body.node.content).toBe("extractor 미가용 시나리오");

    // 입력 통로 통합 Task 6 — extractor 미가용은 graceful 비활성(추출기 옵션 OFF)이라
    // saveTextInput 의 wantsImmediate 가 false 가 되어 원본만 저장한다. 추출 *실패* 가
    // 아니라 추출기가 *없는* 상태라 경고 없이 정상 진행(silent fallback 아님 — 추출은
    // 본래 옵션 기능). /ingest 텍스트 분기와 같은 graceful 동작.
    expect(warnSpy.calls).toEqual([]);

    // 가짜 LLM 호출 가동 0 (extractor 자체가 미주입).
    expect(h.fakeState.callCount).toBe(0);

    // store 내부 검증 — 노드 1개만.
    const stats = await h.store.getStats();
    expect(stats.totalMemories).toBe(1);
  });

  test("mode='backfill' → 옛 흐름 그대로 (raw 만 저장 + 응답 shape 옛 그대로)", async () => {
    h = makeExtractorHarness({ mode: "backfill" });
    warnSpy = captureConsoleWarn();
    // 가짜 LLM 응답을 채워둬도 호출 안 들어가야 한다 — 회귀 가드.
    h.fakeState.nextContent = JSON.stringify([
      { content: "이건 호출되면 안 됨", memoryType: "fact", importance: 0.9 },
    ]);

    const res = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "backfill 갈래 옛 흐름" }),
    });
    expect(res.status).toBe(201);
    const body = (await json(res)) as {
      id: number;
      node: { content: string; metadata: Record<string, unknown> };
      extracted?: unknown;
      extractor?: unknown;
    };

    // 응답 shape — backfill 갈래는 옛 { id, node } 그대로.
    expect(body.id).toBeGreaterThan(0);
    expect(body.extracted).toBeUndefined();
    expect(body.extractor).toBeUndefined();
    expect(body.node.content).toBe("backfill 갈래 옛 흐름");
    expect(body.node.metadata.preservedRaw).toBeUndefined();

    // 가짜 LLM 호출 가동 0 — backfill 갈래는 extract-first 통로 사용 안 함.
    expect(h.fakeState.callCount).toBe(0);
    // warn 로그 0.
    expect(warnSpy.calls).toEqual([]);

    // store 노드 1개.
    const stats = await h.store.getStats();
    expect(stats.totalMemories).toBe(1);
  });

  test("extractor.enabled=false → mode='immediate' 무관 옛 흐름 (raw 만)", async () => {
    h = makeExtractorHarness({ mode: "immediate", enabled: false });
    warnSpy = captureConsoleWarn();

    const res = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "extractor enabled=false 시나리오" }),
    });
    expect(res.status).toBe(201);
    const body = (await json(res)) as {
      id: number;
      node: { content: string };
      extracted?: unknown;
    };

    expect(body.id).toBeGreaterThan(0);
    expect(body.extracted).toBeUndefined();

    // enabled=false = 옛 흐름 = LLM 호출 0 + warn 로그 0.
    expect(h.fakeState.callCount).toBe(0);
    expect(warnSpy.calls).toEqual([]);

    const stats = await h.store.getStats();
    expect(stats.totalMemories).toBe(1);
  });
});

// ── Phase 5.7.2 W5 — mode 분기 통합 흐름 (E2E: POST → DB → /search) ─────────
//
// W2 산출 단위 5건은 POST /memories 응답 + DB 노드 검증까지 다룬다. W5 통합
// 2건은 그 위에 *검색 통로 잡힘* 흐름까지 한 사이클 검증한다 (POST → DB →
// /search). 옛 W2 헬퍼 (FakeOllamaState / buildFakeOllamaServer /
// makeExtractorHarness / buildSettings) 그대로 재활용 — embedder 인스턴스
// 한 벌 공유 + mock 클래스 0 (CLAUDE.md "테스트 정책" 정합).
//
// 통합 1 = mode='immediate' E2E — POST 한 통로 → atomic 자식 N + raw 1 +
//          merged_into 엣지 N 저장. /search 호출 시 atomic 자식은 부모 raw 로
//          접혀(입력 통로 통합 Task 4 / spec §5 D8) raw 한 노드만 대표로 노출.
// 통합 2 = mode='backfill' E2E — POST 한 통로 → raw 1 만 → /search 호출 시
//          raw 만 잡힘 (atomic 0 — scheduler cron 미가동 자연).
describe("POST /memories — Phase 5.7.2 W5 mode 분기 통합 흐름", () => {
  let h: ExtractorHarness;

  afterEach(() => {
    if (h) {
      h.ollamaServer.stop(true);
      h.db.close();
    }
  });

  test("mode='immediate' E2E — POST → DB (raw + atomic + merged_into) → /search 시 atomic 은 부모 raw 로 접힘", async () => {
    h = makeExtractorHarness({ mode: "immediate" });
    // 가짜 LLM 이 점심 + 김치찌개 두 atomic 항목 반환.
    h.fakeState.nextContent = JSON.stringify([
      {
        content: "사용자는 김치찌개를 좋아한다",
        memoryType: "preference",
        importance: 0.6,
      },
      {
        content: "오늘 점심에 김치찌개를 먹었다",
        memoryType: "episode",
        importance: 0.5,
      },
    ]);

    // ── 1) POST /memories — 봇 어댑터 single-path 정합 호출 패턴 ─────────
    const postRes = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "오늘 점심에 김치찌개를 먹었고 맛있었다",
        author: "Tanier",
        platform: "discord",
        metadata: { messageId: "w5-immediate-001", source: "discord" },
      }),
    });
    expect(postRes.status).toBe(201);

    const postBody = (await json(postRes)) as {
      id: number;
      extracted: number[];
      bumped: number[];
      extractor: { provider: string };
      node: {
        content: string;
        sourceType: string;
        metadata: Record<string, unknown>;
      };
    };

    // 응답 shape — immediate 갈래 신규 칸 (extracted/bumped/extractor) 포함.
    expect(postBody.id).toBeGreaterThan(0);
    expect(postBody.extractor.provider).toContain("fake-extractor-model");
    expect(postBody.extracted.length).toBe(2);
    expect(postBody.bumped.length).toBe(0);
    expect(postBody.node.content).toBe("오늘 점심에 김치찌개를 먹었고 맛있었다");
    expect(postBody.node.sourceType).toBe("auto_capture");
    // 입력 통로 통합 Task 6 — saveTextInput 위임 마킹(extracted:1 + extractedTo).
    expect(postBody.node.metadata.extracted).toBe(1);
    expect(postBody.node.metadata.extractedTo).toEqual(postBody.extracted);
    // 봇이 보낸 metadata.messageId 는 extraMetadata 로 원본 노드에 보존 — deleteBySource 짝.
    expect(postBody.node.metadata.messageId).toBe("w5-immediate-001");

    // ── 2) DB 검증 — raw 1 + atomic 2 + merged_into 엣지 2 ───────────────
    const rawNode = await h.store.getNode(postBody.id);
    expect(rawNode).not.toBeNull();
    expect(rawNode!.sourceType).toBe("auto_capture");

    for (const childId of postBody.extracted) {
      const childNode = await h.store.getNode(childId);
      expect(childNode).not.toBeNull();
      expect(childNode!.sourceType).toBe("llm_extract");

      const edges = await h.store.getNeighbors(childId);
      const mergedIntoEdges = edges.filter(
        (e) =>
          e.relation === "merged_into" &&
          e.sourceId === childId &&
          e.targetId === postBody.id,
      );
      expect(mergedIntoEdges.length).toBe(1);
    }

    const stats = await h.store.getStats();
    expect(stats.totalMemories).toBe(3); // raw 1 + atomic 2

    // ── 3) /search "점심" — atomic 자식은 부모 raw 로 접혀 표시(입력 통로 통합 Task 4) ─
    // 옛 5.7.2 흐름은 atomic 자식이 검색 결과에 직접 떴지만, Task 4(spec §5 / D8)부터
    // atomic 자식(llm_extract)은 merged_into 엣지로 부모 raw 에 접혀 결과에 안 남고
    // 부모 한 노드만 대표로 노출된다. atomic 의 검색 매칭(recall)은 그대로라 — 검색이
    // atomic 글을 매칭하면 그 점수를 부모 raw 가 승계해 raw 가 결과에 오른다. 저장은
    // 불변(위 2단계가 raw 1 + atomic 2 + merged_into 2 를 이미 확인).
    const searchRes = await h.app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "점심", limit: 10 }),
    });
    expect(searchRes.status).toBe(200);

    const searchBody = (await json(searchRes)) as {
      query: string;
      count: number;
      results: Array<{
        id: number;
        content: string;
        score: number;
        sourceType: string;
      }>;
    };
    expect(searchBody.query).toBe("점심");

    const hitIds = new Set(searchBody.results.map((r) => r.id));
    // raw 노드 (postBody.id) 가 검색 결과에 포함 — atomic 매칭이 부모로 접혀 올라온다.
    expect(hitIds.has(postBody.id)).toBe(true);
    // atomic 자식은 결과에 직접 안 남는다(부모로 접힘 / 도배 방지).
    const atomicHits = postBody.extracted.filter((id) => hitIds.has(id));
    expect(atomicHits.length).toBe(0);
    // llm_extract source_type 항목이 응답에 전혀 없다(전부 부모로 치환됨).
    expect(searchBody.results.some((r) => r.sourceType === "llm_extract")).toBe(
      false,
    );

    // 가짜 LLM 호출 가동 1회 (extractor.extractAndStore 안 LLM 한 통로).
    expect(h.fakeState.callCount).toBe(1);
  });

  test("mode='backfill' E2E — POST → DB (raw 1 만) → /search 시 raw 만 잡힘 (atomic 0)", async () => {
    h = makeExtractorHarness({ mode: "backfill" });
    // 가짜 LLM 응답 채워둬도 호출 들어가면 안 됨 — backfill 갈래 가드.
    h.fakeState.nextContent = JSON.stringify([
      {
        content: "이건 호출되면 안 됨 — backfill 갈래 가드",
        memoryType: "fact",
        importance: 0.9,
      },
    ]);

    // ── 1) POST /memories — 같은 어댑터 호출 패턴 (mode 무관 한 통로) ────
    const postRes = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "오늘 점심 김치찌개 먹었다",
        author: "Tanier",
        platform: "discord",
        metadata: { messageId: "w5-backfill-001", source: "discord" },
      }),
    });
    expect(postRes.status).toBe(201);

    const postBody = (await json(postRes)) as {
      id: number;
      node: {
        content: string;
        sourceType: string;
        metadata: Record<string, unknown>;
      };
      extracted?: unknown;
      extractor?: unknown;
    };

    // 응답 shape = 옛 { id, node } 그대로 (extracted/extractor 칸 부재).
    expect(postBody.id).toBeGreaterThan(0);
    expect(postBody.extracted).toBeUndefined();
    expect(postBody.extractor).toBeUndefined();
    expect(postBody.node.content).toBe("오늘 점심 김치찌개 먹었다");
    expect(postBody.node.metadata.messageId).toBe("w5-backfill-001");
    // backfill 갈래 = raw 만 저장 (preservedRaw 칸 부재 — 옛 흐름 그대로).
    expect(postBody.node.metadata.preservedRaw).toBeUndefined();

    // ── 2) DB 검증 — 노드 1개만 (atomic 0) ──────────────────────────────
    const stats = await h.store.getStats();
    expect(stats.totalMemories).toBe(1);

    // 가짜 LLM 호출 가동 0 — backfill 갈래는 extract-first 통로 진입 X.
    expect(h.fakeState.callCount).toBe(0);

    // ── 3) /search "점심" — raw 만 잡힘 (atomic 0) ───────────────────────
    // 통합 2 의 종착점 — scheduler cron 미가동 시점에 검색 잡힘 범위가
    // raw 한 항목으로 한정된다 (30분 cron 후에야 atomic 분해 — 옛 흐름 정합).
    const searchRes = await h.app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "점심", limit: 10 }),
    });
    expect(searchRes.status).toBe(200);

    const searchBody = (await json(searchRes)) as {
      count: number;
      results: Array<{ id: number; content: string }>;
    };

    // 검색 결과 = 1건 (raw 노드 한 항목만, atomic 0 정합).
    expect(searchBody.count).toBe(1);
    expect(searchBody.results[0]!.id).toBe(postBody.id);
    expect(searchBody.results[0]!.content).toBe("오늘 점심 김치찌개 먹었다");
  });
});
