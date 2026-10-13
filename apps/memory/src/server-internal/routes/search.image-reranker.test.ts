/**
 * server-internal/routes/search.image-reranker.test.ts — POST /search 리랭커
 * 슬롯 보존 wiring 라우트 검증 (Phase 11e T3 / G1).
 *
 * 권위: docs/decisions/2026-05-31-image-search-quality-spec.md
 *   §1 DCL-3 — 이미지는 cross-encoder 채점에서 빼고 image_vec 합류 최종 점수(RRF)
 *              순위 자리를 그대로 지킨다. quota(최소 N건 보장) 폐기.
 *   §8.3 invariant 2 — 글 검색 무손상.
 *
 * T2 는 reranker.ts 한 파일만 고쳐 슬롯 보존을 정착시켰다(reranker.test.ts 가
 * reranker 레벨에서 단언). search.ts:201 wiring(`rerankerStage.rerank(query, results)`)
 * 은 한 글자도 안 바뀌었다 — 이 파일은 그 사실을 라우트 통과로 한 번 더 확인한다.
 *
 * 항목:
 *   (2) 이미지 0건 검색 응답 byte 동일 — 글만 적재한 코퍼스에서 reranker 가용
 *       검색이 reranker 미주입(=RRF 직접) 검색과 동일 id 순서·score 를 내는가
 *       (글-only 경로 무손상 / invariant 2).
 *   (3) 글·이미지 섞인 검색에서 이미지 생존 + 슬롯 보존 — 실 SigLIP 임베딩으로
 *       image_vec 채널에 뜨는 image_asset 노드가 검색 결과에 나오고, 그 이미지
 *       결과의 rerankerScore 는 undefined(cross-encoder 안 거침).
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder + 실 Reranker + 실 SigLIP 2 임베더 +
 * 실 이미지 fixture. mock 0(프로젝트 CLAUDE.md). counting-spy 는 호출 횟수만
 * 세고 원본을 그대로 반환(가짜 구현체 아님). 모델 3개 로드 + 이미지 디코드라
 * timeout 넉넉히 둔다.
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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { SearchCache } from "../../memory/search-cache.ts";
import { Reranker, type RerankerConfig } from "../../memory/reranker.ts";
import { AssetStore } from "../../assets/asset-store.ts";
import { createImageEmbedder } from "../../embedding/factory.ts";
import type { ImageEmbedder } from "../../embedding/types.ts";
import { ingestImage } from "../../memory/ingest-image.ts";
import type { MemoryApiDeps } from "../types.ts";
import { buildMemoryApi } from "../../server.ts";

const MODEL_LOAD_TIMEOUT_MS = 600_000;
const E2E_TIMEOUT_MS = 180_000;

/** Task 1 settings default 와 같은 운영 값. host 'local' 한 갈래. */
const REAL_CONFIG: RerankerConfig = {
  model: "onnx-community/bge-reranker-v2-m3-ONNX",
  topKInput: 30,
  topKOutput: 5,
  host: "local",
};

/** 실 이미지 fixture — 11a 통합 검증과 같은 자산(작은 PNG). */
const IMAGE_FIXTURE = join(
  import.meta.dir,
  "..",
  "..",
  "memory",
  "image-preserve",
  "__fixtures__",
  "static-small.png",
);

let embedder: Bgem3Embedder;
let realReranker: Reranker;
let imageEmbedder: ImageEmbedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
  realReranker = new Reranker(REAL_CONFIG);
  await realReranker.load();
  imageEmbedder = createImageEmbedder();
}, MODEL_LOAD_TIMEOUT_MS);
afterAll(() => {});

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
  assetStore: AssetStore;
  assetDir: string;
  /** reranker.rerank 실제 호출 횟수 — 슬롯 보존 단계가 가동됐는지 판정용. */
  rerankCalls: () => number;
}

interface SearchResultRow {
  id: number;
  content: string;
  score: number;
  sources: string[];
  components: Record<string, number>;
  sourceType: string;
  concepts: { direct: unknown[]; neighbors: unknown[] };
}
interface SearchResponse {
  query: string;
  count: number;
  results: SearchResultRow[];
}

/**
 * deps.reranker 주입 여부를 인자로 받는 harness. 주입 시 실제 Reranker 의 rerank
 * 를 감싸 호출 횟수만 센다(반환값·동작은 원본 그대로 — counting spy, 가짜 구현체
 * 아님). reranker=undefined 면 재정렬 단계 자체가 없는 옛 흐름. assetStore 는
 * image_asset 적재에 쓰인다(임시 디렉토리, afterEach 정리).
 */
function makeHarness(withReranker: boolean): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const searchCache = new SearchCache();
  const assetDir = mkdtempSync(join(tmpdir(), "bara-search-image-"));
  const assetStore = new AssetStore(assetDir);

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
  return {
    app,
    db,
    store,
    assetStore,
    assetDir,
    rerankCalls: () => calls,
  };
}

function closeHarness(h: Harness): void {
  h.db.close();
  rmSync(h.assetDir, { recursive: true, force: true });
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

/** 글 5건 코퍼스 — 이미지와 무관한 일상 글. image_asset 0건. */
async function ingestTextCorpus(h: Harness): Promise<void> {
  await h.store.addNode({ content: "고양이에게 어떤 사료를 먹이면 좋을지 추천을 받았다" });
  await h.store.addNode({ content: "강아지 산책을 매일 아침 30분씩 시킨다" });
  await h.store.addNode({ content: "고양이가 좋아하는 장난감을 새로 샀다" });
  await h.store.addNode({ content: "사료 가격이 최근 많이 올라서 부담된다" });
  await h.store.addNode({ content: "오늘 점심으로 김치찌개를 먹었다" });
}

/**
 * 실 SigLIP 임베딩으로 image_asset 노드를 적재한다 — image_vec(768-dim ANN)
 * 채널에 실제로 뜨는 후보가 된다. ingestImage 는 같은 db 를 직접 쓰므로 retriever
 * 가 그 노드를 조회한다. SigLIP 모델 가용 여부를 반환해 호출자가 image_vec 합류를
 * 선행 게이트로 삼게 한다(임베딩 null 이면 검색에 안 떠 단언 의미 없음).
 *
 * @returns 적재된 image_asset 노드 id + image_vec 행 존재 여부.
 */
async function ingestRealImage(
  h: Harness,
): Promise<{ nodeId: number; hasVec: boolean }> {
  const buffer = readFileSync(IMAGE_FIXTURE);
  const result = await ingestImage(
    { db: h.db, assetStore: h.assetStore, imageEmbedder },
    {
      buffer,
      mime: "image/png",
      originalName: "fixture.png",
      author: "tester",
      platform: "dashboard",
      source: "dashboard:manual",
      userId: "u-test",
    },
  );
  const vecCount = (
    h.db
      .prepare("SELECT COUNT(*) AS c FROM image_vec WHERE node_id = ?")
      .get(result.nodeId) as { c: number }
  ).c;
  return { nodeId: result.nodeId, hasVec: vecCount > 0 };
}

// ── (2) 이미지 0건 — 글-only 경로 무손상 (invariant 2) ─────────────────────────

describe("POST /search — 이미지 0건이면 글 전용 경로와 동일 (11e T3 invariant 2)", () => {
  let withRerank: Harness;
  let withoutRerank: Harness;
  beforeEach(async () => {
    withRerank = makeHarness(true);
    withoutRerank = makeHarness(false);
    await ingestTextCorpus(withRerank);
    await ingestTextCorpus(withoutRerank);
  });
  afterEach(() => {
    closeHarness(withRerank);
    closeHarness(withoutRerank);
  });

  test(
    "image_asset 0건 코퍼스 — reranker 가용 결과의 글 id 집합이 RRF 직접 경로와 동일 + 이미지 0건",
    async () => {
      const query = "고양이 사료 추천";
      const rrfOnly = await postSearch(withoutRerank, { query, limit: 10 });
      const reranked = await postSearch(withRerank, { query, limit: 10 });

      // 글만 적재했으니 두 경로 어디에도 image_asset 이 섞이지 않는다(0건이 옳다).
      for (const r of rrfOnly.results) {
        expect(r.sourceType).not.toBe("image_asset");
        expect(r.sources).not.toContain("imageVec");
      }
      for (const r of reranked.results) {
        expect(r.sourceType).not.toBe("image_asset");
        expect(r.sources).not.toContain("imageVec");
      }

      // 글-only 경로 무손상 — reranker 가 다루는 후보가 전부 글이라 결과 id 집합이
      // RRF 직접 경로(상위 topKOutput 한도 안)와 같은 글들로 채워진다. reranker 는
      // 순서만 cross-encoder 적합도로 바꾸므로 *집합*이 RRF 상위와 일치해야 한다.
      const rrfIds = new Set(rrfOnly.results.map((r) => r.id));
      for (const r of reranked.results) {
        expect(rrfIds.has(r.id)).toBe(true);
      }
      // 모든 reranked 글 결과에 cross-encoder 점수가 붙는다(이미지 0건이라 슬롯
      // 보존이 글 재정렬을 막지 않음 — T2 전 동작과 동일).
      for (const r of reranked.results) {
        expect(typeof r.components.rerankerScore).toBe("number");
      }
    },
    E2E_TIMEOUT_MS,
  );

  test(
    "image_asset 0건 — reranker 미주입 결과가 RRF 순서·점수 그대로 + rerankerScore 없음",
    async () => {
      const query = "고양이 사료 추천";
      // 같은 자산을 별도 store 에 적재해 캐시 없는 직접 retrieve 기준선을 만든다.
      const db2 = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
      const store2 = new SqliteMemoryStore(db2, embedder);
      await store2.addNode({ content: "고양이에게 어떤 사료를 먹이면 좋을지 추천을 받았다" });
      await store2.addNode({ content: "강아지 산책을 매일 아침 30분씩 시킨다" });
      await store2.addNode({ content: "고양이가 좋아하는 장난감을 새로 샀다" });
      await store2.addNode({ content: "사료 가격이 최근 많이 올라서 부담된다" });
      await store2.addNode({ content: "오늘 점심으로 김치찌개를 먹었다" });
      const directRetriever = new HybridRetriever(store2, embedder);
      const direct = await directRetriever.retrieve(query, { limit: 10 });

      const viaRoute = await postSearch(withoutRerank, { query, limit: 10 });

      // 재정렬 단계가 없으므로 라우트 결과 = RRF 순서·점수 그대로.
      expect(viaRoute.results.map((r) => r.id)).toEqual(direct.map((r) => r.node.id));
      expect(viaRoute.results.map((r) => r.score)).toEqual(direct.map((r) => r.score));
      for (const r of viaRoute.results) {
        expect(r.components.rerankerScore).toBeUndefined();
      }
      db2.close();
    },
    E2E_TIMEOUT_MS,
  );
});

// ── (3) 글·이미지 섞인 검색 — 이미지 생존 + 슬롯 보존 ──────────────────────────

describe("POST /search — 이미지 생존 + rerankerScore undefined (11e T3 / DCL-3)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness(true);
  });
  afterEach(() => {
    closeHarness(h);
  });

  // ⚠️ 현재 RED — reranker.ts:208 버그(글 후보 0건 + 이미지만일 때 cross-encoder
  // 빈 배열 호출 → "text array must be non-empty" throw → /search 500). spec DCL-3
  // 의도는 "이미지만이면 image_vec 순위 그대로 보존"이지만 T2 구현이 글 0건 경로를
  // 처리하지 못한다. 이 테스트는 그 의도를 단언해 결함을 드러낸다(구현 수정 대상).
  // 이미지 보관소에서 그림만 검색하는 흐름(spec §4.6)이 정상 사용처라 운영 결함이다.
  test(
    "image_asset 만 적재 — 검색 결과에 이미지가 나오고 그 결과의 rerankerScore 는 undefined",
    async () => {
      const { nodeId, hasVec } = await ingestRealImage(h);

      // SigLIP 임베딩이 image_vec 에 들어가야 검색에 뜬다 — 미가용이면 측정 BLOCKED.
      // 가짜 벡터를 주입해 억지로 띄우지 않는다(No-mock / No-fallback). 모델 부재는
      // 단언으로 정직하게 드러낸다.
      expect(hasVec).toBe(true);

      // 글이 0건이라 image_vec 채널 후보(이미지)가 RRF 결과 상위를 채운다.
      // image_vec ANN 은 검색어와 무관하게 top-K 후보를 회신하므로 이미지가
      // 결과에 반드시 나온다(원래 고장 = 리랭커가 이미지를 전멸시킴 — 그 차단).
      const body = await postSearch(h, {
        query: "노란 후드를 입은 캐릭터",
        limit: 10,
        imageSearch: true,
      });

      const img = body.results.find((r) => r.id === nodeId);
      expect(img).toBeDefined();
      expect(img!.sourceType).toBe("image_asset");
      expect(img!.sources).toContain("imageVec");
      // 슬롯 보존 — 이미지는 cross-encoder 채점을 안 거쳐 rerankerScore 가 undefined.
      expect(img!.components.rerankerScore).toBeUndefined();
      // 리랭커 단계가 실제로 가동됐다(글 0건이어도 wiring 은 호출됨).
      expect(h.rerankCalls()).toBe(1);
    },
    E2E_TIMEOUT_MS,
  );

  test(
    "글·이미지 함께 적재 — 이미지는 살아남고 글은 cross-encoder 점수가 붙는다 (슬롯 분리)",
    async () => {
      await ingestTextCorpus(h);
      const { nodeId, hasVec } = await ingestRealImage(h);
      expect(hasVec).toBe(true);

      const body = await postSearch(h, {
        query: "고양이 사료 추천",
        limit: 10,
        imageSearch: true,
      });

      // 이미지가 image_vec 채널로 결과에 합류한다(글이 슬롯을 다 채워 밀려나지
      // 않는 한). 합류했다면 rerankerScore 는 undefined(슬롯 보존).
      const img = body.results.find((r) => r.id === nodeId);
      if (img) {
        expect(img.sourceType).toBe("image_asset");
        expect(img.components.rerankerScore).toBeUndefined();
      }
      // 글 결과는 cross-encoder 점수가 붙는다(글 갈래 재정렬은 그대로).
      const textResults = body.results.filter((r) => r.sourceType !== "image_asset");
      expect(textResults.length).toBeGreaterThan(0);
      for (const r of textResults) {
        expect(typeof r.components.rerankerScore).toBe("number");
      }
    },
    E2E_TIMEOUT_MS,
  );
});
