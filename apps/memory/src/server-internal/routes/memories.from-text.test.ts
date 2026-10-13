/**
 * memories.from-text.test.ts — POST /memories/from-text 태그 wiring 합류 (메인 결정 2).
 *
 * from-text 는 외부 어댑터 통로(봇 `/extract` 슬래시 → preserveRaw=true)라 saveTextInput
 * 을 안 거쳐 입력 시점 wiring 을 못 받았다. 이 통로로 들어온 `#태그` 도 그래프로 묶이게
 * origin 노드(rawNodeId, preserveRaw 일 때) 직후에 wireHashtagConcepts 를 1회 한다.
 * 추출 경로는 skipHashtagWiring=true 라 태그 wiring 을 안 하므로 정확히 1회다(중복 0).
 *
 * from-text 는 추출이 먼저 성공해야 rawNodeId 단계에 도달한다(extractAndStore 가 try
 * 블록 첫 줄 — 추출 실패 시 500 + rawNodeId 미생성). 그래서 이 검증은 실제 추출이
 * 돌아야 의미가 있어 Ollama 가동을 확인하고 미가동이면 skip 한다.
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder + 실 MemoryExtractor(OllamaClient). mock 0.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi } from "../../server.ts";
import { MemoryExtractor } from "../../memory/extractor.ts";
import { OllamaClient } from "../../llm/ollama-client.ts";
import type { LlmClient } from "../../llm/types.ts";

let embedder: Bgem3Embedder;
let ollamaUp = false;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(3000),
    });
    ollamaUp = res.ok;
  } catch {
    ollamaUp = false;
  }
});
afterAll(() => {});

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
}

describe("POST /memories/from-text — 태그 wiring 합류 (메인 결정 2)", () => {
  let h: Harness;

  function makeHarness(): Harness {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    const retriever = new HybridRetriever(store, embedder);
    const assembler = new ContextAssembler();
    const llm = new OllamaClient({
      baseUrl: "http://127.0.0.1:11434",
      model: "exaone3.5:32b",
    });
    const extractor = new MemoryExtractor(llm, store, embedder);
    const app = buildMemoryApi({ store, retriever, assembler, extractor });
    return { app, db, store };
  }

  function makeFixtureHarness(): Harness {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    const retriever = new HybridRetriever(store, embedder);
    const assembler = new ContextAssembler();
    const llm: LlmClient = {
      name: "fixture:from-text-project",
      chat: async () =>
        JSON.stringify([
          {
            content: "from-text 경로는 project_id를 자식에 보존한다",
            memoryType: "fact",
            importance: 0.8,
          },
        ]),
    };
    const extractor = new MemoryExtractor(llm, store, embedder);
    const app = buildMemoryApi({ store, retriever, assembler, extractor });
    return { app, db, store };
  }

  afterEach(() => {
    if (h) h.db.close();
  });

  async function postFromText(
    app: Hono,
    body: Record<string, unknown>,
  ): Promise<{ status: number; rawId: number | null }> {
    const res = await app.request("/memories/from-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json()) as { raw: { id: number } | null };
    return { status: res.status, rawId: parsed.raw ? parsed.raw.id : null };
  }

  test("preserveRaw=true #태그 글 → origin 노드에 태그 개념·엣지 1회", async () => {
    if (!ollamaUp) {
      console.warn("[from-text.test] Ollama 미가동 — from-text 태그 wiring 테스트 skip");
      return;
    }
    h = makeHarness();
    // FEW_SHOT_EXAMPLES 와 다른 어휘(duplicate-quirk 회피). 태그 2개.
    const { status, rawId } = await postFromText(h.app, {
      text: "#만화 #주술회전 고조가 죽었어",
      author: "owner",
      platform: "discord",
      preserveRaw: true,
    });
    expect(status).toBe(201);
    expect(rawId).not.toBeNull();

    // origin 노드(rawNodeId)에 태그 개념 2개 연결.
    const tagEdges = await h.store.listNodeConceptEdges({
      nodeId: rawId!,
      role: "tag",
    });
    expect(tagEdges).toHaveLength(2);
    // 콜론 없는 순수 나열은 위계(parent_of)를 만들지 않는다(spec §4.1 I1) —
    // 두 태그 다 잎이라 origin 에 둘 다 붙고, 태그끼리 위계 엣지는 0개.
    const tagConceptIds = new Set(tagEdges.map((t) => t.conceptId));
    const hierarchy = await h.store.listConceptEdges({ relation: "parent_of" });
    const tagHierarchy = hierarchy.filter(
      (e) => tagConceptIds.has(e.sourceConceptId) || tagConceptIds.has(e.targetConceptId),
    );
    expect(tagHierarchy).toHaveLength(0);

    // origin content 는 원문(태그 포함) 보존.
    const origin = await h.store.getNode(rawId!);
    expect(origin?.content).toBe("#만화 #주술회전 고조가 죽었어");

    // 별 본문 노드(source='tag_body')를 만들지 않는다.
    const bodyCount = (
      h.db
        .prepare(
          "SELECT COUNT(*) as c FROM knowledge_nodes WHERE metadata_json->>'$.source' = 'tag_body'",
        )
        .get() as { c: number }
    ).c;
    expect(bodyCount).toBe(0);
  }, 120_000);

  test("preserveRaw=true projectId → raw 원본과 추출 자식 project_id 일치", async () => {
    h = makeFixtureHarness();
    const res = await h.app.request("/memories/from-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "from-text 경로는 원본과 자식의 프로젝트를 맞춘다. 두 노드 모두 같은 스코프다.",
        author: "owner",
        platform: "test",
        preserveRaw: true,
        projectId: " prj_from_text ",
      }),
    });
    const body = (await res.json()) as {
      stored: number[];
      raw: { id: number } | null;
    };

    expect(res.status).toBe(201);
    expect(body.raw).not.toBeNull();
    expect(body.stored).toHaveLength(1);
    expect((await h.store.getNode(body.raw!.id))?.projectId).toBe("prj_from_text");
    expect((await h.store.getNode(body.stored[0]!))?.projectId).toBe("prj_from_text");
  }, 120_000);

  test("태그만 입력 → LLM 원문 fallback 없이 raw만 저장하고 추출 완료 마킹", async () => {
    h = makeFixtureHarness();
    const res = await h.app.request("/memories/from-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "#만화",
        author: "owner",
        platform: "test",
        preserveRaw: true,
      }),
    });
    const body = (await res.json()) as {
      stored: number[];
      items: unknown[];
      raw: { id: number } | null;
    };

    expect(res.status).toBe(201);
    expect(body.stored).toEqual([]);
    expect(body.items).toEqual([]);
    expect(body.raw).not.toBeNull();

    const raw = await h.store.getNode(body.raw!.id);
    expect(raw?.content).toBe("#만화");
    expect(raw?.metadata).toMatchObject({
      preservedRaw: true,
      extracted: 1,
      extractedTo: [],
    });
    const llmChildren = (
      h.db
        .prepare("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE source_type = 'llm_extract'")
        .get() as { n: number }
    ).n;
    expect(llmChildren).toBe(0);
  }, 120_000);

  test("같은 #태그 글을 from-text 로 2회 → 개념 노드 1개(idempotent, 중복 0)", async () => {
    if (!ollamaUp) {
      console.warn("[from-text.test] Ollama 미가동 — idempotent 테스트 skip");
      return;
    }
    h = makeHarness();

    const r1 = await postFromText(h.app, {
      text: "#만화 첫 메모",
      author: "owner",
      preserveRaw: true,
    });
    const r2 = await postFromText(h.app, {
      text: "#만화 둘째 메모",
      author: "owner",
      preserveRaw: true,
    });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    // 개념 노드 '만화' 1개뿐(idempotent upsert).
    const conceptCount = (
      h.db.prepare("SELECT COUNT(*) as c FROM concept_nodes").get() as {
        c: number;
      }
    ).c;
    expect(conceptCount).toBe(1);

    // 두 origin 이 같은 개념을 가리킨다(각 origin 에 tag 엣지 1개).
    const e1 = await h.store.listNodeConceptEdges({ nodeId: r1.rawId!, role: "tag" });
    const e2 = await h.store.listNodeConceptEdges({ nodeId: r2.rawId!, role: "tag" });
    expect(e1).toHaveLength(1);
    expect(e2).toHaveLength(1);
    expect(e1[0]!.conceptId).toBe(e2[0]!.conceptId);
  }, 120_000);
});
