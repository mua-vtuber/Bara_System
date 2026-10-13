/**
 * server-internal/routes/search.reranker.test.ts — POST /search 리랭커 wiring 검증 (6b T6).
 *
 * R5 wiring 검증 항목 (spec 10.2.3 캐시↔리랭커 순서 / 11.1.1 운영 최종 점수 상위 N):
 *   1. reranker 주입(가용) — 검색 결과가 cross-encoder 적합도 순으로 재정렬되고,
 *      각 결과에 components.rerankerScore 가 붙는다(상위 topK_output 한도).
 *   2. reranker 미주입(deps.reranker=undefined) — 결과·점수가 캐시/RRF 순서 그대로
 *      (재정렬 단계 skip / 회귀 0). 이게 pre-6b 동작과 byte 동일.
 *   3. 캐시 ↔ 리랭커 순서 — 캐시에 보관되는 값은 *리랭커 이전* RRF 결과다. 같은
 *      query 2회 호출 시 리랭커가 매번 다시 도는지(=캐시 뒤 단계인지) 확인한다.
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder + 실 Reranker(cross-encoder) + 실
 * SearchCache. mock 없음(프로젝트 CLAUDE.md). 실제 모델 로드는 첫 1회 캐시
 * 다운로드 ~13초라 넉넉한 timeout 를 둔다.
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
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { SearchCache } from "../../memory/search-cache.ts";
import { Reranker, type RerankerConfig } from "../../memory/reranker.ts";
import type { MemoryApiDeps } from "../types.ts";
import { buildMemoryApi } from "../../server.ts";

const MODEL_LOAD_TIMEOUT_MS = 180_000;
const E2E_TIMEOUT_MS = 120_000;

/** Task 1 settings default 와 같은 운영 값. host 'local' 한 갈래. */
const REAL_CONFIG: RerankerConfig = {
  model: "onnx-community/bge-reranker-v2-m3-ONNX",
  topKInput: 30,
  topKOutput: 5,
  host: "local",
};

let embedder: Bgem3Embedder;
let realReranker: Reranker;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
  realReranker = new Reranker(REAL_CONFIG);
  await realReranker.load();
}, MODEL_LOAD_TIMEOUT_MS);
afterAll(() => {});

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
  searchCache: SearchCache;
  /** reranker.rerank 실제 호출 횟수 — 캐시 뒤 단계인지 판정용. */
  rerankCalls: () => number;
}

interface SearchResultRow {
  id: number;
  content: string;
  score: number;
  sources: string[];
  components: Record<string, number>;
  concepts: { direct: unknown[]; neighbors: unknown[] };
}
interface SearchResponse {
  query: string;
  count: number;
  results: SearchResultRow[];
}

/**
 * deps.reranker 주입 여부를 인자로 받는 harness. 주입 시 실제 Reranker 의
 * rerank 를 감싸 호출 횟수만 센다(반환값·동작은 원본 그대로 — counting spy,
 * 가짜 구현체 아님). reranker=undefined 면 재정렬 단계 자체가 없는 옛 흐름.
 */
function makeHarness(withReranker: boolean): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const searchCache = new SearchCache();

  let calls = 0;
  let reranker: Reranker | undefined;
  if (withReranker) {
    const realRerank = realReranker.rerank.bind(realReranker);
    realReranker.rerank = ((query, candidates) => {
      calls += 1;
      return realRerank(query, candidates);
    }) as typeof realReranker.rerank;
    reranker = realReranker;
  }

  const deps: MemoryApiDeps = { store, retriever, assembler, searchCache };
  if (reranker) deps.reranker = reranker;
  const app = buildMemoryApi(deps);
  return { app, db, store, searchCache, rerankCalls: () => calls };
}

async function postSearch(
  h: Harness,
  payload: Record<string, unknown>,
): Promise<SearchResponse> {
  const res = await h.app.request("/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SearchResponse;
}

async function ingestCorpus(h: Harness): Promise<void> {
  // query "고양이 사료 추천" 에 대해 적합도가 뚜렷이 갈리는 자산을 적재한다.
  // RRF 글자/의미 매칭과 cross-encoder 적합도가 다르게 줄 세울 여지가 있어
  // 재정렬 효과를 관찰할 수 있다.
  await h.store.addNode({ content: "고양이에게 어떤 사료를 먹이면 좋을지 추천을 받았다" });
  await h.store.addNode({ content: "강아지 산책을 매일 아침 30분씩 시킨다" });
  await h.store.addNode({ content: "고양이가 좋아하는 장난감을 새로 샀다" });
  await h.store.addNode({ content: "사료 가격이 최근 많이 올라서 부담된다" });
  await h.store.addNode({ content: "오늘 점심으로 김치찌개를 먹었다" });
}

// ── (2) 회귀 0 — reranker 미주입이면 재정렬 단계 skip ───────────────────────

describe("POST /search — reranker 미주입 = RRF 순서 그대로(회귀 0 / 6b T6)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness(false);
    await ingestCorpus(h);
  });
  afterEach(() => {
    h.db.close();
  });

  test(
    "reranker=undefined — 결과가 캐시 없는 직접 retrieve(RRF) 와 동일",
    async () => {
      // 캐시 없는 직접 retrieve 기준선(같은 자산을 별도 store 에 적재).
      const db2 = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
      const store2 = new SqliteMemoryStore(db2, embedder);
      await store2.addNode({ content: "고양이에게 어떤 사료를 먹이면 좋을지 추천을 받았다" });
      await store2.addNode({ content: "강아지 산책을 매일 아침 30분씩 시킨다" });
      await store2.addNode({ content: "고양이가 좋아하는 장난감을 새로 샀다" });
      await store2.addNode({ content: "사료 가격이 최근 많이 올라서 부담된다" });
      await store2.addNode({ content: "오늘 점심으로 김치찌개를 먹었다" });
      const directRetriever = new HybridRetriever(store2, embedder);
      const direct = await directRetriever.retrieve("고양이 사료 추천", { limit: 10 });

      const viaRoute = await postSearch(h, { query: "고양이 사료 추천", limit: 10 });

      // 재정렬 단계가 없으므로 라우트 결과 = RRF 순서·점수 그대로.
      expect(viaRoute.results.map((r) => r.id)).toEqual(direct.map((r) => r.node.id));
      expect(viaRoute.results.map((r) => r.score)).toEqual(direct.map((r) => r.score));
      // 재정렬 안 했으므로 rerankerScore 칸이 없다.
      for (const r of viaRoute.results) {
        expect(r.components.rerankerScore).toBeUndefined();
      }
      db2.close();
    },
    E2E_TIMEOUT_MS,
  );
});

// ── (1) reranker 가용 — 재정렬 + rerankerScore 부착 ─────────────────────────

describe("POST /search — reranker 가용 = cross-encoder 재정렬(6b T6)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness(true);
    await ingestCorpus(h);
  });
  afterEach(() => {
    h.db.close();
  });

  test(
    "reranker 주입 — 결과에 rerankerScore 부착 + 상위 topK_output 한도",
    async () => {
      const body = await postSearch(h, { query: "고양이 사료 추천", limit: 10 });

      // 재정렬됐으므로 모든 결과에 cross-encoder 적합도(rerankerScore)가 붙는다.
      expect(body.results.length).toBeGreaterThan(0);
      // topK_output(5) 한도 — 입력이 5건이라 최대 5.
      expect(body.results.length).toBeLessThanOrEqual(REAL_CONFIG.topKOutput);
      for (const r of body.results) {
        expect(typeof r.components.rerankerScore).toBe("number");
        expect(r.components.rerankerScore).toBeGreaterThanOrEqual(0);
        expect(r.components.rerankerScore).toBeLessThanOrEqual(1);
      }
      // rerankerScore 내림차순 정렬 확인(재정렬 키).
      const scores = body.results.map((r) => r.components.rerankerScore!);
      const sorted = [...scores].sort((a, b) => b - a);
      expect(scores).toEqual(sorted);
      // 적합도 1위는 사료 추천 직접 매칭 자산이어야 한다(cross-encoder 적합도).
      expect(body.results[0]!.content).toContain("사료");

      console.log(
        `[6b T6 E2E] reranker 가용 → 1위 rerankerScore=${body.results[0]!.components.rerankerScore} ` +
          `(${body.results[0]!.content.slice(0, 20)}...)`,
      );
    },
    E2E_TIMEOUT_MS,
  );

  test(
    "캐시 ↔ 리랭커 순서 — 캐시는 리랭커 이전 결과 보관 / 리랭커는 매 호출 가동(캐시 뒤 단계)",
    async () => {
      const first = await postSearch(h, { query: "고양이 사료 추천", limit: 10 });
      expect(h.rerankCalls()).toBe(1);

      // 같은 query 재호출 — RRF 결과는 캐시 hit(retriever 안 돔)이지만, 리랭커는
      // 캐시 뒤 단계라 다시 가동한다(캐시에 든 건 리랭커 이전 결과 / spec 10.2.3).
      const second = await postSearch(h, { query: "고양이 사료 추천", limit: 10 });
      expect(h.rerankCalls()).toBe(2);

      // 같은 입력 → 같은 재정렬 결과(결정적).
      expect(second.results.map((r) => r.id)).toEqual(first.results.map((r) => r.id));
      expect(second.results.map((r) => r.components.rerankerScore)).toEqual(
        first.results.map((r) => r.components.rerankerScore),
      );
    },
    E2E_TIMEOUT_MS,
  );
});
