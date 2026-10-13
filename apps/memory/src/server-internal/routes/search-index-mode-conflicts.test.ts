/**
 * search-index-mode-conflicts.test.ts — index 모드의 열린 충돌 표시 (WP-B1-10).
 *
 * search-index-mode.test.ts 가 이미 800줄 하드 한도를 넘어 있어(규칙: 이미 초과한
 * 파일은 키우지 않는다) 이 WP-B1-10S(Medium 5)가 이 검증을 별도 작은 파일로 분리한다.
 * harness 구성은 search-index-mode.test.ts 의 makeHarness/seed 와 같은 양식(실 SQLite +
 * 실 Bgem3Embedder + 실 HybridRetriever, mock 객체 0)을 이 파일 안에서 다시 구성한다 —
 * search-index-mode-origin-marks.test.ts 의 선례와 같은 중복 허용(같은 헬퍼를 여러
 * 파일이 재사용하도록 export 하는 리팩터는 이 WP 범위 밖).
 *
 * recall_context 가 내부적으로 index 모드를 쓰고 instructions 가 AI 에게 index 를 먼저
 * 보라고 안내하므로, 이 표면도 열린 충돌을 놓치면 안 된다. 옛 "6칸만" 계약(search-index-mode.test.ts
 * 의 "index 회신 형태" describe)을 지키기 위해 conflicts 는 실제로 열린 충돌이 있을 때만
 * 싣는다(없으면 칸 자체 생략).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import { runSearchPipeline } from "./search-service.ts";
import type { MemoryApiDeps } from "../types.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

/** search-index-mode.test.ts 와 같은 코퍼스(실측 cosine 확인된 조합). */
const CORPUS = [
  "지난 주말에 친구들과 한강에서 자전거를 탔다",
  "냉장고에 우유가 떨어져서 마트에 들러야 한다",
  "회사 회의에서 다음 분기 예산안을 논의했다",
  "고양이가 새벽 세 시에 울어서 잠을 설쳤다",
  "새로 산 키보드의 타건감이 아주 좋다",
];
const ANSWERABLE = "자전거";

interface Harness {
  db: Database;
  store: SqliteMemoryStore;
  deps: MemoryApiDeps;
}

function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  const deps: MemoryApiDeps = { store, retriever, assembler, getSettings: () => settings };
  return { db, store, deps };
}

async function seed(h: Harness): Promise<void> {
  for (const content of CORPUS) await h.store.addNode({ content });
}

interface IndexItem {
  id: number;
  conflicts?: number[];
}
interface SearchResponse {
  results: IndexItem[];
}

async function searchAiPath(h: Harness, payload: Record<string, unknown>): Promise<SearchResponse> {
  const response = await runSearchPipeline(h.deps, payload, new URLSearchParams(), { applyResultFloor: true });
  return response as unknown as SearchResponse;
}

describe("index 모드 — 열린 충돌 표시는 있을 때만 칸을 싣는다(WP-B1-10)", () => {
  let h: Harness;
  afterEach(() => h.db.close());

  test("충돌이 없는 통상 코퍼스는 6칸 계약 그대로 — conflicts 칸이 아예 없다", async () => {
    h = makeHarness();
    await seed(h);
    const idx = await searchAiPath(h, { query: ANSWERABLE, limit: 20, responseMode: "index" });
    for (const item of idx.results) {
      expect(Object.keys(item).sort()).toEqual(
        ["date", "entities", "id", "memoryType", "oneLine", "score"].sort(),
      );
      expect(item).not.toHaveProperty("conflicts");
    }
  });

  test("아직 해소되지 않은 충돌 상대가 있으면 그 id가 conflicts에 실린다", async () => {
    h = makeHarness();
    const oldId = await h.store.addNode({ content: "자전거는 파란색이다" });
    const newId = await h.store.addNode({
      content: "자전거는 빨간색이다",
      metadata: { sharedMemory: { status: "disputed", revision: 0, assertionKind: "unknown" } },
    });
    await h.store.addEdge({ sourceId: newId, targetId: oldId, relation: "contradicts", provenance: "system", sourceNodeId: newId, weight: 0.9 });

    const idx = await searchAiPath(h, { query: ANSWERABLE, limit: 20, responseMode: "index" });
    const byId = new Map(idx.results.map((r) => [r.id, r.conflicts]));
    expect(byId.get(oldId)).toEqual([newId]);
    // 6칸 + conflicts 7칸만 — 다른 full 전용 칸은 여전히 없다.
    const item = idx.results.find((r) => r.id === oldId)!;
    expect(Object.keys(item).sort()).toEqual(
      ["conflicts", "date", "entities", "id", "memoryType", "oneLine", "score"].sort(),
    );
  });

  test("해소되면 conflicts 칸이 다시 사라진다", async () => {
    h = makeHarness();
    const oldId = await h.store.addNode({ content: "자전거는 파란색이다" });
    const newId = await h.store.addNode({
      content: "자전거는 빨간색이다",
      metadata: { sharedMemory: { status: "disputed", revision: 0, assertionKind: "unknown" } },
    });
    await h.store.addEdge({ sourceId: newId, targetId: oldId, relation: "contradicts", provenance: "system", sourceNodeId: newId, weight: 0.9 });
    await h.store.db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify({ sharedMemory: { status: "retracted", revision: 1, assertionKind: "unknown" } }), newId);

    const idx = await searchAiPath(h, { query: ANSWERABLE, limit: 20, responseMode: "index" });
    const item = idx.results.find((r) => r.id === oldId)!;
    expect(item).not.toHaveProperty("conflicts");
  });
});
