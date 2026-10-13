/**
 * search-index-mode-origin-marks.test.ts — index 모드의 원문 계보 표시 (WP-B1-10R).
 *
 * search-index-mode.test.ts 가 이미 800줄 하드 한도를 넘어 있어(규칙: 이미 초과한
 * 파일은 키우지 않는다) 이 WP 의 새 검증을 별도 작은 파일로 분리한다. harness 구성은
 * search-index-mode.test.ts 의 makeHarness/seed 와 같은 양식(실 SQLite + 실 Bgem3Embedder +
 * 실 HybridRetriever, mock 객체 0)을 이 파일 안에서 다시 구성한다 — 같은 헬퍼를 다른
 * 파일이 재사용하도록 export 하는 리팩터는 이 WP 범위 밖이라 중복을 허용한다.
 *
 * full 모드의 originMarks 표시(search-post-process.test.ts 선례 없음 — full 모드는
 * tools-shared-memory.int.test.ts 의 MCP 통합 시험이 담당)와 같은 값을, index 모드가
 * 옛 "6칸만" 계약을 지키며(있을 때만 칸을 싣는다) 그대로 노출하는지 확인한다.
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
  originMarks?: { openConflicts: number[]; supersededClaims: Array<{ childId: number; replacementId: number }> };
}
interface SearchResponse {
  results: IndexItem[];
}

async function searchAiPath(h: Harness, payload: Record<string, unknown>): Promise<SearchResponse> {
  const response = await runSearchPipeline(h.deps, payload, new URLSearchParams(), { applyResultFloor: true });
  return response as unknown as SearchResponse;
}

describe("index 모드 — 원문 계보 표시는 있을 때만 칸을 싣는다(WP-B1-10R)", () => {
  let h: Harness;
  afterEach(() => h.db.close());

  test("원문에서 추출된 자식이 supersede되면 원문 항목에 originMarks 칸이 실린다", async () => {
    h = makeHarness();
    const origin = await h.store.addNode({ content: "자전거는 파란색이다" });
    const child = await h.store.addNode({
      content: "자전거 색은 파랑입니다", sourceType: "llm_extract",
      metadata: { sharedMemory: { assertionKind: "ai_inference" } },
    });
    await h.store.addEdge({ sourceId: child, targetId: origin, relation: "merged_into", provenance: "system", sourceNodeId: child, weight: 1 });
    const replacement = await h.store.addNode({ content: "자전거는 빨간색이다" });
    await h.store.db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify({ sharedMemory: { status: "superseded", revision: 1, assertionKind: "ai_inference", supersededBy: replacement } }), child);

    const idx = await searchAiPath(h, { query: ANSWERABLE, limit: 20, responseMode: "index" });
    const item = idx.results.find((r) => r.id === origin)!;
    expect(item.originMarks).toEqual({ openConflicts: [], supersededClaims: [{ childId: child, replacementId: replacement }] });
  });

  test("자식이 없는 통상 코퍼스는 originMarks 칸이 아예 없다", async () => {
    h = makeHarness();
    await seed(h);
    const idx = await searchAiPath(h, { query: ANSWERABLE, limit: 20, responseMode: "index" });
    for (const item of idx.results) {
      expect(item).not.toHaveProperty("originMarks");
    }
  });
});
