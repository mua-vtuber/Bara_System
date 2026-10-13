/**
 * input-idempotency-e2e.test.ts — P0-A 입력 멱등성 전 경로 acceptance(T6).
 *
 * spec(docs/decisions/2026-07-02-input-idempotency-spec.md) §8 Completion Criteria 를
 * 실제 라우트(POST /memories, POST /ingest) + 실제 bun:sqlite + 실제 Bgem3Embedder
 * 로 증명한다. mock 없음. immediate LLM 추출은 default OFF 라 plain 경로로 흐른다
 * (Ollama 무관). 이미지 노드는 addImageAssetNode 직접 호출로 텍스트 흡수 비오염만 확인.
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
import type { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { HybridRetriever } from "../memory/retriever.ts";
import { ContextAssembler } from "../memory/context-assembler.ts";
import { buildMemoryApi } from "../server.ts";
import { getMemorySettings } from "../settings/memory-settings.ts";
import { AssetStore } from "../assets/asset-store.ts";
import { addImageAssetNode } from "../memory/image-asset.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

let db: Database;
let store: SqliteMemoryStore;
let app: Hono;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bara-idem-e2e-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const settings = getMemorySettings("/nonexistent-default-idempotency-e2e", "/nonexistent-default-idempotency-e2e.secrets.json");
  const assetStore = new AssetStore(dir);
  app = buildMemoryApi({
    store,
    retriever,
    assembler,
    assetStore,
    getSettings: () => settings,
  });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function count(sql: string): number {
  return (db.prepare(sql).get() as { c: number }).c;
}

async function postMemory(content: string): Promise<Response> {
  return app.request("/memories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, platform: "discord" }),
  });
}

async function postIngestText(content: string): Promise<Response> {
  return app.request("/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "dashboard:manual",
      content: { type: "text", data: content },
    }),
  });
}

describe("P0-A e2e — POST /memories 멱등(Completion Criteria 1~3)", () => {
  test("기준 1·2 — 같은 글 2회 → 각 테이블 1행 + 둘째 cacheHit + mention_count 0→1", async () => {
    const content = "e2e 멱등 검증용 메모 문장";
    const r1 = await postMemory(content);
    const j1 = (await r1.json()) as { id: number; cacheHit: boolean };
    expect(r1.status).toBe(201);
    expect(j1.cacheHit).toBe(false);

    const r2 = await postMemory(content);
    const j2 = (await r2.json()) as { id: number; cacheHit: boolean };
    expect(r2.status).toBe(201);
    expect(j2.cacheHit).toBe(true);
    // 봇 호환 — id 칸은 기존 노드 id(첫 노드).
    expect(j2.id).toBe(j1.id);

    // 각 테이블 1행(중복 축적 0).
    expect(count("SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(1);
    expect(count("SELECT COUNT(*) AS c FROM vec_nodes")).toBe(1);
    expect(
      count(
        "SELECT COUNT(*) AS c FROM knowledge_nodes_fts WHERE knowledge_nodes_fts MATCH '메모'",
      ),
    ).toBe(1);
    expect(count("SELECT COUNT(*) AS c FROM knowledge_nodes_trgm")).toBe(1);

    // mention_count 0→1.
    const row = db
      .prepare("SELECT mention_count FROM knowledge_nodes WHERE id = ?")
      .get(j1.id) as { mention_count: number };
    expect(row.mention_count).toBe(1);
  });

  test("기준 3 — 다른 글은 여전히 별 노드(회귀 0)", async () => {
    await postMemory("첫 e2e 글");
    const r2 = await postMemory("둘째 e2e 다른 글");
    const j2 = (await r2.json()) as { cacheHit: boolean };
    expect(j2.cacheHit).toBe(false);
    expect(count("SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(2);
  });
});

describe("P0-A e2e — POST /ingest(text) 멱등(Completion Criteria 4)", () => {
  test("같은 짧은 글 2회 → 노드 1행 + 둘째 cacheHit", async () => {
    const content = "ingest 텍스트 멱등 검증 문장";
    const r1 = await postIngestText(content);
    const j1 = (await r1.json()) as {
      ok: boolean;
      originNodeId: number;
      cacheHit: boolean;
    };
    expect(r1.status).toBe(201);
    expect(j1.cacheHit).toBe(false);

    const r2 = await postIngestText(content);
    const j2 = (await r2.json()) as {
      originNodeId: number;
      cacheHit: boolean;
    };
    expect(r2.status).toBe(201);
    expect(j2.cacheHit).toBe(true);
    expect(j2.originNodeId).toBe(j1.originNodeId);
    expect(count("SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(1);
  });

  test("기준 4 — 같은 긴 글 2회 → origin·청크 모두 흡수(중복 0)", async () => {
    // 기본 tokenCap(2000)보다 긴 글을 만들어 청크가 생기게 한다. 서로 다른 문장을
    // 여러 개 이어 청크가 서로 흡수되지 않게(각 청크 content 가 다르게) 만든다.
    const sentences = Array.from(
      { length: 60 },
      (_, i) =>
        `문장 번호 ${i} 는 서로 다른 내용을 담아 청크가 개별 노드로 남도록 충분히 길게 작성한 서술입니다.`,
    );
    const content = sentences.join("\n\n");

    const r1 = await postIngestText(content);
    const j1 = (await r1.json()) as {
      originNodeId: number;
      chunkNodeIds: number[];
      cacheHit: boolean;
    };
    expect(r1.status).toBe(201);
    expect(j1.chunkNodeIds.length).toBeGreaterThan(0);
    const nodesAfterFirst = count("SELECT COUNT(*) AS c FROM knowledge_nodes");

    const r2 = await postIngestText(content);
    const j2 = (await r2.json()) as {
      originNodeId: number;
      cacheHit: boolean;
    };
    expect(j2.cacheHit).toBe(true);
    expect(j2.originNodeId).toBe(j1.originNodeId);
    // origin 흡수 → saveChunks skip → 청크 재생성 0. 노드 수 불변.
    expect(count("SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(
      nodesAfterFirst,
    );
    expect(count("SELECT COUNT(*) AS c FROM vec_nodes")).toBe(nodesAfterFirst);
  });
});

describe("P0-A e2e — 이미지 노드 비오염(Completion Criteria 7)", () => {
  test("image_asset 노드는 content_hash NULL, 텍스트 흡수에 안 걸린다", () => {
    // 같은 자산 글로 두 번 이미지 노드를 만든다 — 텍스트 멱등이 이들을 흡수하면
    // 안 된다(image_asset 은 addNode 통로가 아니라 addImageAssetNode 전용 통로).
    const args = {
      content: "고양이 일러스트 (assetSha256=abc123)",
      embedding: null,
      assetSha256: "abc123",
    };
    const id1 = addImageAssetNode(db, args);
    const id2 = addImageAssetNode(db, { ...args, assetSha256: "abc456" });
    expect(id2).not.toBe(id1);
    // 두 이미지 노드 모두 content_hash NULL.
    const rows = db
      .query(
        "SELECT content_hash FROM knowledge_nodes WHERE source_type = 'image_asset'",
      )
      .all() as Array<{ content_hash: string | null }>;
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.content_hash === null)).toBe(true);

    // 같은 자산 글을 텍스트 경로(addNode)로 넣으면 별 텍스트 노드가 되고, 이미지
    // 노드(content_hash NULL)를 흡수하지 않는다(NULL 은 흡수 조회에 안 걸린다).
    // → 텍스트 노드는 새로 생기고, 이미지 노드 2개는 그대로.
    return store.addNode({ content: args.content }).then((textId) => {
      expect(textId).not.toBe(id1);
      expect(textId).not.toBe(id2);
      expect(count("SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(3);
    });
  });
});
