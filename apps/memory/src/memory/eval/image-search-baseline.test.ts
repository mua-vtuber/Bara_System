/**
 * image-search-baseline.test.ts — Phase 11e T1 (G3 기반): 이미지 합류 *전* 글
 * 검색 기준선 측정 + 이미지 0건 검색 결과 고정.
 *
 * 두 가지를 산출한다(spec §13 G3 / §16 T1 / §9.4 회귀 가드):
 *  1. 글 검색 nDCG·recall 기준선 snapshot — 기존 harness.ts 의 변형 함수
 *     (runHarness / runEnrichedHarness / runRerankerVariant)를 *호출만* 한다.
 *     신규 metric 함수·harness 변형을 만들지 않는다(T1 acceptance).
 *  2. 이미지 0건 검색 결과 고정 — 글만 있는 코퍼스에서 retrieve→reranker 통과
 *     결과(노드 id 순서 + score)를 결정론적 문자열로 직렬화해 단언한다. 이것이
 *     T2(G1 리랭커 이미지 보존) 적용 후 "이미지가 0건인 글-only 검색은 T2 전후
 *     byte 동일" 을 비교할 회귀 기준점이다(spec §2 invariant 2 / §9.4).
 *
 * 실 Bgem3Embedder + 실 bge-reranker + bun:sqlite + :memory: DB — mock 0.
 * 운영 DB(data/bara.sqlite)는 절대 건드리지 않는다(모든 적재는 :memory:).
 * 모델 로드·재정렬이 느려 timeout 넉넉히(600000ms).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../retriever.ts";
import { Reranker } from "../reranker.ts";
import type { RetrievalResult } from "../retriever.ts";
import type { RerankedResult } from "../reranker.ts";
import {
  runHarness,
  runEnrichedHarness,
  runRerankerVariant,
  loadCorpus,
  rerankerMeasuredWin,
  SWEEP_VARIANTS,
  ENRICHED_SWEEP_VARIANTS,
} from "./harness.ts";
import { EVAL_QUERIES } from "../../../test-fixtures/sandbox/eval-queries.ts";

/** flat 글 코퍼스 — 운영 default(full-rrf) 검색을 재는 텍스트 자산. */
const FLAT_CORPUS_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "test-fixtures",
  "sandbox",
  "embedding-corpus.txt",
);

/**
 * flat full-rrf 기준선 floor — final-snapshot.test.ts 의 0.8882 정합(1e-3 여유).
 * 글 검색 기준선이 이 floor 아래로 떨어지면 회귀(이미지 합류 전 기준점 보존).
 */
const FLAT_FULL_RRF_FLOOR = 0.8882 - 1e-3;

/**
 * 측정 창 — final-snapshot / reranker-eval 와 같은 20. 운영 default topKOutput(5)는
 * nDCG 창(20)을 못 채우므로 측정에선 reranker 창을 넓힌다(운영 값은 settings 그대로).
 */
const FLAT_LIMIT = 20;

/**
 * 검색 결과를 byte 비교용 결정론적 문자열로 직렬화한다.
 *
 * 이것은 신규 metric 이 아니라 단순 직렬화다 — 노드 id 순서와 score(고정 소수
 * 12자리)만 한 줄씩 적는다. 부동소수 score 를 toFixed 로 고정해 같은 입력이면
 * 항상 같은 문자열이 나오게 한다. T2(G1) 적용 후 글-only 결과를 같은 직렬화로
 * 만들어 이 기준점과 byte 동일 비교한다(spec §9.4).
 */
function serializeRanking(
  results: ReadonlyArray<RetrievalResult | RerankedResult>,
): string {
  return results
    .map((r) => `${r.node.id}|${r.score.toFixed(12)}|${r.sources.join(",")}`)
    .join("\n");
}

let embedder: Bgem3Embedder;
let reranker: Reranker;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
  reranker = new Reranker({
    model: "onnx-community/bge-reranker-v2-m3-ONNX",
    topKInput: 30,
    topKOutput: 30, // 측정 창 — eval limit(20)보다 커 결과 전체가 회신된다.
    host: "local",
  });
  await reranker.load();
}, 600_000);

afterAll(() => {});

describe("Phase 11e T1 — 글 검색 nDCG·recall 기준선 (기존 harness 재사용)", () => {
  test(
    "flat 글 코퍼스 full-rrf 기준선 snapshot 1개 산출 + floor 게이트",
    async () => {
      // 기존 runHarness 를 호출만 — 신규 측정자 없음.
      const snap = await runHarness(embedder, {
        variants: {
          "vector-only": SWEEP_VARIANTS["vector-only"]!,
          "full-rrf": SWEEP_VARIANTS["full-rrf"]!,
        },
      });

      const vectorOnly = snap.variants.find((v) => v.variant === "vector-only")!;
      const flatFull = snap.variants.find((v) => v.variant === "full-rrf")!;

      console.log(
        `[11e T1 글 기준선 — flat] vector-only ` +
          `nDCG=${vectorOnly.avgNdcg.toFixed(4)} recall=${vectorOnly.avgRecall.toFixed(4)} ` +
          `MRR=${vectorOnly.avgMrr.toFixed(4)}`,
      );
      console.log(
        `[11e T1 글 기준선 — flat] full-rrf ` +
          `nDCG=${flatFull.avgNdcg.toFixed(4)} recall=${flatFull.avgRecall.toFixed(4)} ` +
          `MRR=${flatFull.avgMrr.toFixed(4)}`,
      );

      // 글 검색 기준선이 이미지 합류 전 floor 아래로 떨어지면 안 된다(회귀 가드).
      expect(flatFull.avgNdcg).toBeGreaterThanOrEqual(FLAT_FULL_RRF_FLOOR);
      // 모든 query 가 채점됐다(부분 측정 아님).
      expect(flatFull.perQuery.length).toBe(EVAL_QUERIES.length);
    },
    600_000,
  );

  test(
    "enriched 글 코퍼스 full-rrf+concept 기준선 snapshot 산출",
    async () => {
      // 기존 runEnrichedHarness 를 호출만.
      const snap = await runEnrichedHarness(embedder, {
        variants: {
          "full-rrf+concept": ENRICHED_SWEEP_VARIANTS["full-rrf+concept"]!,
        },
      });
      const enrichedFull = snap.variants.find(
        (v) => v.variant === "full-rrf+concept",
      )!;

      console.log(
        `[11e T1 글 기준선 — enriched] full-rrf+concept ` +
          `nDCG=${enrichedFull.avgNdcg.toFixed(4)} recall=${enrichedFull.avgRecall.toFixed(4)} ` +
          `MRR=${enrichedFull.avgMrr.toFixed(4)}`,
      );

      // 수치가 산출됐다(글 검색이 의미 있는 점수를 낸다).
      expect(enrichedFull.avgNdcg).toBeGreaterThan(0);
      expect(enrichedFull.avgRecall).toBeGreaterThan(0);
    },
    600_000,
  );

  test(
    "flat 글 코퍼스 +reranker 기준선 — 운영 default 대비 measured-win 기록",
    async () => {
      // 모델 부재면 측정 BLOCKED — 가짜 점수 없이 단언으로 드러낸다.
      expect(reranker.available).toBe(true);

      const baselineSnap = await runHarness(embedder, {
        variants: { "full-rrf": SWEEP_VARIANTS["full-rrf"]! },
      });
      const baseline = baselineSnap.variants.find((v) => v.variant === "full-rrf")!;

      // 기존 runRerankerVariant 를 호출만 — full-rrf 결과를 실 cross-encoder 로 재정렬.
      const rerankSnap = await runRerankerVariant(embedder, reranker, {
        variant: "full-rrf+reranker",
        mask: SWEEP_VARIANTS["full-rrf"]!,
        retrievalLimit: FLAT_LIMIT,
      });

      const win = rerankerMeasuredWin(baseline, rerankSnap);
      console.log(
        `[11e T1 글 기준선 — flat +reranker] ` +
          `baseline nDCG=${baseline.avgNdcg.toFixed(4)} → +reranker nDCG=${rerankSnap.avgNdcg.toFixed(4)} ` +
          `recall=${rerankSnap.avgRecall.toFixed(4)} MRR=${rerankSnap.avgMrr.toFixed(4)}`,
      );
      console.log(`[11e T1 글 기준선 — flat +reranker] measured-win: ${win.reason}`);

      // 리랭커가 정답을 창 밖으로 밀어 recall 을 깎지 않는다(글 검색 가드레일).
      expect(rerankSnap.avgRecall).toBeGreaterThanOrEqual(baseline.avgRecall - 1e-9);
      expect(rerankSnap.perQuery.length).toBe(EVAL_QUERIES.length);
    },
    600_000,
  );
});

describe("Phase 11e T1 — 이미지 0건 검색 결과 고정 (T2 회귀 기준점)", () => {
  /**
   * 글만 적재한 :memory: store + retriever 를 만든다. image_asset 노드가 0건이라
   * imageVec 채널은 빈 배열이고(retriever.ts:514 "image_vec 채널이 빈 배열이면
   * 옛 4채널 결과와 수학적 동일"), 검색 결과에 image_asset 이 절대 섞이지 않는다.
   * 이 글-only 결과가 T2(G1) 전후 byte 동일이어야 한다.
   */
  async function buildFlatTextOnly(): Promise<{
    retriever: HybridRetriever;
    close: () => void;
  }> {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    await loadCorpus(store, FLAT_CORPUS_PATH); // 글만 — image_asset 0건.
    const retriever = new HybridRetriever(store, embedder);
    return { retriever, close: () => db.close() };
  }

  test(
    "글-only retrieve 결과가 결정론적이고 image_asset 0건이다 (byte 동일 기준점)",
    async () => {
      const a = await buildFlatTextOnly();
      let serializedA = "";
      const noImageAcrossQueries: boolean[] = [];
      try {
        const lines: string[] = [];
        for (const q of EVAL_QUERIES) {
          const results = await a.retriever.retrieve(q.query, { limit: FLAT_LIMIT });
          // 이미지 0건 — 글만 적재했으니 어떤 결과도 image_asset/image_caption 이 아니다.
          const hasImageNode = results.some(
            (r) =>
              r.node.sourceType === "image_asset" ||
              r.node.sourceType === "image_caption",
          );
          noImageAcrossQueries.push(hasImageNode);
          // imageVec 채널이 후보를 0개 합류했으니 sources 에 imageVec 가 없다.
          const hasImageVecSource = results.some((r) =>
            r.sources.includes("imageVec"),
          );
          noImageAcrossQueries.push(hasImageVecSource);
          lines.push(`### ${q.id} ${q.query}`);
          lines.push(serializeRanking(results));
        }
        serializedA = lines.join("\n");
      } finally {
        a.close();
      }

      // 이미지가 단 한 query 에서도 섞이지 않았다(글-only 검색이라 0건이 옳다).
      expect(noImageAcrossQueries.every((x) => x === false)).toBe(true);

      // 결정론 확인 — 같은 코퍼스·같은 query 를 두 번째 store 로 다시 돌리면 byte 동일.
      const b = await buildFlatTextOnly();
      let serializedB = "";
      try {
        const lines: string[] = [];
        for (const q of EVAL_QUERIES) {
          const results = await b.retriever.retrieve(q.query, { limit: FLAT_LIMIT });
          lines.push(`### ${q.id} ${q.query}`);
          lines.push(serializeRanking(results));
        }
        serializedB = lines.join("\n");
      } finally {
        b.close();
      }

      expect(serializedB).toBe(serializedA);

      // 기준점을 콘솔에 산출 — T2(G1) 후 같은 직렬화와 byte 동일 비교(spec §9.4).
      console.log(
        `[11e T1 이미지 0건 기준점 — retrieve] ${EVAL_QUERIES.length} query / ` +
          `직렬화 길이=${serializedA.length}자 / image_asset·imageVec 0건 / 결정론 OK`,
      );
    },
    600_000,
  );

  test(
    "글-only reranker 통과 결과가 결정론적이고 image_asset 0건이다 (byte 동일 기준점)",
    async () => {
      // 글-only 는 reranker 모델 부재여도 RRF 순서 degrade 라 결정론이 성립한다.
      // 단 본 측정 흐름에선 reranker 가용을 선행 게이트로 본다(부재면 BLOCKED).
      expect(reranker.available).toBe(true);

      async function rankWithReranker(): Promise<string> {
        const ctx = await buildFlatTextOnly();
        try {
          const lines: string[] = [];
          for (const q of EVAL_QUERIES) {
            const rrf = await ctx.retriever.retrieve(q.query, { limit: FLAT_LIMIT });
            const reranked = await reranker.rerank(q.query, rrf);
            // 글-only 라 reranker 가 다루는 후보도 전부 비-이미지여야 한다.
            const hasImageNode = reranked.some(
              (r) =>
                r.node.sourceType === "image_asset" ||
                r.node.sourceType === "image_caption",
            );
            expect(hasImageNode).toBe(false);
            lines.push(`### ${q.id} ${q.query}`);
            lines.push(serializeRanking(reranked));
          }
          return lines.join("\n");
        } finally {
          ctx.close();
        }
      }

      const first = await rankWithReranker();
      const second = await rankWithReranker();

      // reranker 통과 후에도 글-only 결과는 byte 동일(T2 invariant 2 비교 기준점).
      expect(second).toBe(first);

      console.log(
        `[11e T1 이미지 0건 기준점 — reranker 통과] ${EVAL_QUERIES.length} query / ` +
          `직렬화 길이=${first.length}자 / image_asset 0건 / 결정론 OK`,
      );
    },
    600_000,
  );
});
