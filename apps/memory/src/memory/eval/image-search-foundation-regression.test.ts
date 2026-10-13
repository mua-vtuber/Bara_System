/**
 * image-search-foundation-regression.test.ts — image-search-foundation Task 7
 * (c-C1): 검색 코어(post-RRF 출처 boost)를 *바꾸는* 유일한 task 의 측정 게이트.
 *
 * Task 7 은 imageVec 채널 전용 boost(SOURCE_BOOST.imageVec / settings.images.
 * searchSimilarityBoost)를 신설해 "유사 우선, 연결 보조" 를 실현한다. 사용자가
 * 짚은 흠: 유사도 1위인 맞는 이미지가, 유사도는 낮지만 연결성(graph) 점수가 높은
 * 딴 항목에 가산 합산으로 밀려난다. imageVec boost 를 1.0 보다 올려 그 흠을 고친다.
 *
 * 이 파일은 네 가지를 측정·단언한다(dispatch 측정 절차 U4):
 *
 *  1. [C0 게이트] 글 검색 회귀 0 — imageVec boost 변경 *후* flat 글 코퍼스 full-rrf
 *     nDCG 가 T6 기준선 floor 유지(0.8882 는 Granite embedder 시절 실측 / bge-m3
 *     전환 후 2026-07-10 재실측 0.9029 — 상수 주석 참조). 글 노드는 imageVec 채널
 *     기여가 0 이라 구조적으로 불변이어야 한다 — 통과 못 하면 설계 어긋남이다.
 *
 *  2. [C0 게이트] 이미지 0건 글-only snapshot byte 동일 — T6 가 고정한 글-only
 *     검색 결과를, imageVec boost 를 1.0/3.0 두 값으로 돌려도 *서로 byte 동일*
 *     임을 단언한다(글 검색 회귀 0 의 직접 증거 — 글 노드는 imageVec 기여 0).
 *
 *  3. [방식 효과] 이미지 순위 상승 — image_vec rank-1 인 맞는 이미지를, 연결성
 *     점수가 높은 무관 글들과 같은 코퍼스에 두고 imageVec boost 를 1.0/1.5/2.0/3.0
 *     으로 sweep 해 이미지 순위 변화를 측정 표로 남긴다. boost=1.0(중립)은 이미지가
 *     무관 글에 밀리는 흠을 재현하고, boost>1 부터 이미지가 위로 올라옴을 단언한다.
 *
 *  4. [배선 확인] effectiveImageVecBoost 반영 — boost=1.0 이면 변경 전과 동일,
 *     boost>1 이면 이미지 점수만 오르고 무관 글 점수는 불변임을 단언한다.
 *
 * 측정 방식(mock 0 / 데이터 fixture 만):
 *  - 글은 실 Bgem3Embedder 텍스트 임베딩(실제 vector·fts 채널).
 *  - 이미지는 addImageAssetNode 로 적재 — 텍스트 임베딩 NULL + image_vec 행만.
 *    image_vec 행은 *실 SigLIP text encoder* 가 query 를 임베딩한 768-dim
 *    Float32Array 를 그대로 넣는다(데이터 fixture — mock 클래스 아님). 그러면
 *    retriever 가 같은 query 를 SigLIP 으로 임베딩해 cosine KNN 을 돌릴 때 이
 *    이미지가 거리 ~0 인 rank-1 imageVec 후보가 된다(결정론).
 *  - imageVec boost sweep 은 retriever 의 tuning.imageVecBoost 오버라이드로 준다
 *    (운영 경로는 settings.images.searchSimilarityBoost → options.imageVecBoost,
 *    sweep 은 tuning.imageVecBoost — 둘 다 같은 effectiveImageVecBoost 로 모인다).
 *
 * 코어(rrf.ts)는 0줄 변경 — 변경은 retriever 의 post-RRF boost 합산 한 줄
 * (imageVec→전용 boost) + search-tuning 상수 + settings. 봇·concept-repository 무수정.
 *
 * 실 Bgem3Embedder + 실 SigLIP text encoder + bun:sqlite + :memory: DB — mock 0.
 * 운영 DB(data/bara.sqlite)는 절대 건드리지 않는다. 모델 로드가 느려 timeout 넉넉히.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import {
  embedQuerySiglipText,
  loadSiglipTextEncoder,
} from "../../embedding/siglip2-text.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { addImageAssetNode } from "../image-asset.ts";
import { HybridRetriever } from "../retriever.ts";
import type { RetrievalResult } from "../retriever.ts";
import { SOURCE_BOOST } from "../search-tuning.ts";
import { runHarness, loadCorpus, SWEEP_VARIANTS } from "./harness.ts";
import { EVAL_QUERIES } from "./answer-map.ts";

/** flat 글 코퍼스 — 운영 default(full-rrf) 검색을 재는 텍스트 자산(T6 정합). */
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
 * flat full-rrf 기준선 floor — Granite embedder 시절 T6 baseline 0.8882 →
 * 테스트 embedder bge-m3 전환 후 재실측 2026-07-10 avgNdcg 0.9029.
 * floor 0.90(여유 0.003) — 큰 회귀만 잡는다.
 */
const FLAT_FULL_RRF_FLOOR = 0.9;

/**
 * flat recall floor — Granite 시절 만점(1.0) → bge-m3 재실측 2026-07-10
 * avgRecall 0.975. floor 0.97 — magnitude-fusion-regression FLAT_RECALL_FLOOR 정합.
 */
const FLAT_RECALL_FLOOR = 0.97;

/** 측정 창 — T6 baseline 과 같은 20. */
const FLAT_LIMIT = 20;

/** 운영 default — search-tuning SOURCE_BOOST.imageVec. T7 측정 확정값. */
const OPERATIONAL_DEFAULT_BOOST = SOURCE_BOOST.imageVec;

/**
 * 검색 결과를 byte 비교용 결정론적 문자열로 직렬화한다(T6 serializeRanking 정합).
 * 노드 id·score(소수점 12 단위 고정)·sources 만 한 줄씩. T7 적용 후 글-only
 * 결과를 boost 값별로 만들어 서로 byte 동일 비교한다(글 검색 회귀 0 게이트).
 */
function serializeRanking(results: ReadonlyArray<RetrievalResult>): string {
  return results
    .map((r) => `${r.node.id}|${r.score.toFixed(12)}|${r.sources.join(",")}`)
    .join("\n");
}

let embedder: Bgem3Embedder;
let siglipAvailable: boolean;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
  // SigLIP text encoder 로드 — image_vec 후보 측정에 필요(실 모델, mock 0).
  siglipAvailable = await loadSiglipTextEncoder();
}, 600_000);

afterAll(() => {});

// ── 1. C0 게이트: 글 검색 회귀 0 (imageVec boost 변경 후에도 0.8882 동일) ──────

describe("T7 C0 — 글 검색 회귀 0 (imageVec boost 변경 후 글 nDCG floor 유지)", () => {
  test(
    "flat 글 코퍼스 full-rrf nDCG 가 bge-m3 실측 floor(0.90)를 그대로 유지한다",
    async () => {
      // 기존 runHarness 를 호출만 한다 — 운영 default 경로(imageVec boost
      // SOURCE_BOOST.imageVec)에서 글 코퍼스를 돌린다. 글 코퍼스에는 image_asset
      // 노드가 0건이라 imageVec 채널은 빈 배열이고, 글 노드는 imageVec 기여가 0
      // 이라 boost 를 곱해도 가산 delta 가 0 → 글 nDCG 가 구조적으로 불변이어야 한다.
      const snap = await runHarness(embedder, {
        variants: {
          "vector-only": SWEEP_VARIANTS["vector-only"]!,
          "full-rrf": SWEEP_VARIANTS["full-rrf"]!,
        },
      });

      const flatFull = snap.variants.find((v) => v.variant === "full-rrf")!;
      console.log(
        `[T7 C0 — 글 회귀] full-rrf nDCG=${flatFull.avgNdcg.toFixed(4)} ` +
          `recall=${flatFull.avgRecall.toFixed(4)} MRR=${flatFull.avgMrr.toFixed(4)} ` +
          `(imageVec boost ${OPERATIONAL_DEFAULT_BOOST} 운영 default — 글은 imageVec 기여 0)`,
      );

      expect(flatFull.avgNdcg).toBeGreaterThanOrEqual(FLAT_FULL_RRF_FLOOR);
      // Granite 시절 만점(1.0) → bge-m3 재실측 2026-07-10 avgRecall 0.975.
      expect(flatFull.avgRecall).toBeGreaterThanOrEqual(FLAT_RECALL_FLOOR);
      expect(flatFull.perQuery.length).toBe(EVAL_QUERIES.length);
    },
    600_000,
  );
});

// ── 2. C0 게이트: 이미지 0건 글-only snapshot byte 동일 (boost 값 무관) ────────

describe("T7 C0 — 이미지 0건 글-only 검색이 imageVec boost 값과 무관하게 byte 동일", () => {
  /**
   * 글만 적재한 :memory: store + retriever. image_asset 노드 0건이라 imageVec
   * 채널은 빈 배열이고, 모든 글 노드의 imageVec 기여가 0 이다. imageVec boost 를
   * 어떤 값으로 줘도(1.0/3.0) 글 노드 점수는 구조적으로 불변이어야 한다.
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

  /** 모든 EVAL_QUERIES 를 주어진 imageVec boost 로 돌려 직렬화한다. */
  async function serializeAll(
    retriever: HybridRetriever,
    imageVecBoost: number,
  ): Promise<string> {
    const lines: string[] = [];
    for (const q of EVAL_QUERIES) {
      const results = await retriever.retrieve(q.query, {
        limit: FLAT_LIMIT,
        // T7 은 imageVec boost 효과를 *격리* 측정한다 — T4(강도-반영 정밀 재채점)는
        // 직교 가산 채널이라 여기선 precisionStrengthWeight=0 으로 끈다. T4 측정은
        // magnitude-fusion-regression.test.ts 권위. (글-only byte 동일 게이트는
        // precisionStrengthWeight 값과 무관하게 boost 1.0↔3.0 동일이라 영향 없음.)
        tuning: { imageVecBoost, precisionStrengthWeight: 0 },
      });
      lines.push(`### ${q.id} ${q.query}`);
      lines.push(serializeRanking(results));
    }
    return lines.join("\n");
  }

  test(
    "boost=1.0 과 boost=3.0 의 글-only 결과가 byte 동일하다 (글 검색 회귀 0)",
    async () => {
      const ctx = await buildFlatTextOnly();
      try {
        const atNeutral = await serializeAll(ctx.retriever, 1.0);
        const atHigh = await serializeAll(ctx.retriever, 3.0);

        // 글 노드는 imageVec 기여 0 이라 boost 1.0 ↔ 3.0 결과가 byte 동일해야 한다.
        expect(atHigh).toBe(atNeutral);

        // 운영 default(OPERATIONAL_DEFAULT_BOOST)도 같은 글-only 결과여야 한다
        // (글 회귀 0 의 직접 증거).
        const atDefault = await serializeAll(
          ctx.retriever,
          OPERATIONAL_DEFAULT_BOOST,
        );
        expect(atDefault).toBe(atNeutral);

        // 결과에 image_asset·imageVec 가 단 한 건도 섞이지 않았다(글-only 코퍼스).
        const contaminated = atNeutral.includes("imageVec");
        expect(contaminated).toBe(false);

        console.log(
          `[T7 C0 — 글-only byte 동일] ${EVAL_QUERIES.length} query / ` +
            `imageVec boost 1.0=3.0=${OPERATIONAL_DEFAULT_BOOST} 모두 byte 동일 ` +
            `(직렬화 길이=${atNeutral.length}자 / imageVec 0건)`,
        );
      } finally {
        ctx.close();
      }
    },
    600_000,
  );
});

// ── 3. 방식 효과: 이미지 순위 상승 (imageVec boost sweep 측정 표) ──────────────

describe("T7 — imageVec boost sweep: 맞는 이미지가 무관 글 위로 올라온다", () => {
  /** SigLIP image_vec 차원(기준 스키마 image_vec). */
  const SIGLIP_DIM = 768;

  /**
   * sweep 측정값 — dispatch 측정 절차 #3. 1.0(중립)부터 3.0 까지 + 운영 default
   * 후보(1.1) + crossover 근처(2.0~2.5) 를 촘촘히 둬 "이미지가 무관 글 위로 올라오는"
   * 경계 boost 를 측정 표로 드러낸다. default 는 이 표로 사람이 고른다(추측 금지).
   */
  const SWEEP_BOOSTS = [1.0, 1.1, 1.5, 2.0, 2.5, 3.0];

  /** 맞는 이미지를 회수할 한국어 검색어. */
  const QUERY = "노란 후드 입은 캐릭터";

  /**
   * 측정 코퍼스(:memory:, 운영 DB 불변경) — 사용자가 짚은 흠을 정확히 재현한다:
   *  - 맞는 이미지(image_asset) — image_vec = SigLIP(QUERY) 그대로라 retriever 의
   *    imageVec KNN 에서 거리 ~0 rank-1 후보가 된다(결정론). 텍스트 임베딩 NULL —
   *    오직 imageVec *단일 채널* 로만 회수된다(RRF 기여 1/(60+2)≈0.0159 한 갈래).
   *    사용자가 말한 "유사도 1위인 맞는 답".
   *  - 연결성 높은 딴 항목 N개 — QUERY 와 글자가 일부 겹쳐(vector·fts 채널 약하게
   *    합류) graph BFS seed 가 되고, 그 seed 가 한 개념 클러스터를 끌어와 graph·
   *    concept 채널까지 *여러 채널* 에 합류한다. RRF 는 채널별 기여를 합산하므로,
   *    이 다채널 합산이 이미지의 단일채널 RRF 보다 커져 boost=1.0(중립)에서 이미지를
   *    밀어낸다 — 사용자가 짚은 "유사도는 낮지만 연결성 점수가 높아 맞는 답이 밀림".
   *    imageVec boost 를 올리면 이미지의 imageVec 기여에 가산 delta 가 붙어 이 흠을
   *    고친다("유사 우선, 연결 보조").
   *
   * addImageAssetNode / addNode / findOrCreateTagConcept / addNodeConceptEdge 는
   * 운영 store API 그대로 — 우회 0.
   */
  /** 연결성 높은 딴 항목 후보 글 — QUERY 와 글자가 겹쳐 다채널 합류한다. */
  const DISTRACTOR_CONTENTS = [
    "노란 우비를 입은 친구 이야기를 적은 일기",
    "후드 티 쇼핑 후기를 정리한 메모",
    "캐릭터 굿즈 수집 목록 정리",
    "노란 가방을 산 날의 기록",
    "겨울 후드 코디 정리 노트",
  ];

  /**
   * @param distractorCount 연결성 높은 딴 항목 개수. 1 = 사용자가 짚은 흠의
   *   현실 사례("맞는 이미지가 연결성 높은 *딴 한 항목* 에 밀림"). 5 = 연결성
   *   클러스터가 두꺼운 스트레스 사례. default 결정은 현실 사례(1) 기준,
   *   스트레스 사례는 방식이 더 두꺼운 연결성에서도 동작함을 보인다.
   */
  async function buildSweepCorpus(distractorCount: number): Promise<{
    store: SqliteMemoryStore;
    retriever: HybridRetriever;
    db: ReturnType<typeof openMemoryDatabase>;
    imageNodeId: number;
    distractorIds: number[];
    close: () => void;
  }> {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);

    // 맞는 이미지의 image_vec = SigLIP(QUERY) — retriever 의 imageVec KNN 이 같은
    // QUERY 를 SigLIP 으로 임베딩하므로 거리 ~0 rank-1 후보가 된다(데이터 fixture).
    const queryImageVec = await embedQuerySiglipText(QUERY);
    if (!queryImageVec || queryImageVec.length !== SIGLIP_DIM) {
      throw new Error(
        `SigLIP text encoder 가 QUERY 임베딩을 못 냈다(len=${queryImageVec?.length ?? "null"}) — 측정 불가`,
      );
    }
    const imageNodeId = addImageAssetNode(db, {
      content: "노란 후드 캐릭터 일러스트 자산",
      embedding: queryImageVec,
      assetSha256: "t7-sweep-image-asset",
    });

    // 연결성 높은 딴 항목 — QUERY 와 글자("노란"·"후드"·"캐릭터")가 겹쳐 vector·fts
    // 채널에 약하게 합류한다. 그 합류가 graph BFS seed 가 되어 아래 개념 클러스터를
    // 끌어오므로 graph·concept 채널까지 다채널로 합산돼, 이미지의 단일채널 RRF 보다
    // 점수가 높아진다(흠 재현). 이미지보다 유사도(의미)는 낮지만 연결성이 높은 상태.
    const distractorIds: number[] = [];
    for (const content of DISTRACTOR_CONTENTS.slice(0, distractorCount)) {
      distractorIds.push(await store.addNode({ content }));
    }

    // 딴 항목들을 두 개념('일상기록'·'노란색')에 동시 연결 → graph BFS 가 seed
    // 에서 1-hop 으로 클러스터를 회수하고 concept 채널도 합류한다(연결성 부풀림).
    const themeA = await store.findOrCreateTagConcept("일상기록");
    const themeB = await store.findOrCreateTagConcept("노란색");
    for (const id of distractorIds) {
      await store.addNodeConceptEdge(id, themeA, "tag", "user_input", id);
      await store.addNodeConceptEdge(id, themeB, "tag", "user_input", id);
    }

    const retriever = new HybridRetriever(store, embedder);
    return {
      store,
      retriever,
      db,
      imageNodeId,
      distractorIds,
      close: () => db.close(),
    };
  }

  /** 한 코퍼스에서 boost 값별 측정 표를 만든다(이미지 순위·점수 + 무관 글 1위 점수). */
  async function measureSweep(
    label: string,
    distractorCount: number,
  ): Promise<
    Array<{
      boost: number;
      imageRank: number;
      imageScore: number;
      topDistractorScore: number;
    }>
  > {
    const ctx = await buildSweepCorpus(distractorCount);
    try {
      const table: Array<{
        boost: number;
        imageRank: number;
        imageScore: number;
        topDistractorScore: number;
      }> = [];
      for (const boost of SWEEP_BOOSTS) {
        const results = await ctx.retriever.retrieve(QUERY, {
          limit: FLAT_LIMIT,
          // imageVec boost 효과 격리 — T4 정밀 강도(직교 채널)는 0 으로 끈다(위 주석).
          tuning: { imageVecBoost: boost, precisionStrengthWeight: 0 },
        });
        const imageIdx = results.findIndex((r) => r.node.id === ctx.imageNodeId);
        const topDistractor = results
          .filter((r) => ctx.distractorIds.includes(r.node.id))
          .reduce(
            (max, r) => (r.score > max ? r.score : max),
            Number.NEGATIVE_INFINITY,
          );
        table.push({
          boost,
          imageRank: imageIdx === -1 ? -1 : imageIdx + 1,
          imageScore: results[imageIdx]?.score ?? Number.NaN,
          topDistractorScore: topDistractor,
        });
      }

      // 측정 표 산출 — 메인이 사용자에게 (c) 최종 default 를 확인받을 근거.
      console.log(`[T7 imageVec boost sweep 측정 표 — ${label}] query="${QUERY}"`);
      console.log(
        "  boost | imageRank | imageScore | topDistractorScore | 이미지>무관글",
      );
      for (const row of table) {
        const wins = row.imageScore > row.topDistractorScore;
        console.log(
          `  ${row.boost.toFixed(2)}  |    ${row.imageRank === -1 ? "X" : row.imageRank}      | ` +
            `${row.imageScore.toFixed(6)} | ${row.topDistractorScore.toFixed(6)} | ${wins ? "예" : "아니오"}`,
        );
      }
      // crossover boost(이미지가 무관 글을 처음 넘는 boost) 산출.
      const cross = table.find((r) => r.imageScore > r.topDistractorScore);
      console.log(
        `  → crossover boost (이미지>무관글 최초): ${cross ? cross.boost.toFixed(2) : "없음(>3.0)"}`,
      );
      return table;
    } finally {
      ctx.close();
    }
  }

  /** 한 측정 표의 공통 불변식 단언(방식 효과 + 무관 글 불변). */
  function assertSweepInvariants(
    table: Array<{
      boost: number;
      imageRank: number;
      imageScore: number;
      topDistractorScore: number;
    }>,
  ): void {
    // 맞는 이미지는 어떤 boost 값에서도 결과에 합류한다(imageVec rank-1 후보).
    for (const row of table) expect(row.imageRank).toBeGreaterThan(0);
    const neutral = table.find((r) => r.boost === 1.0)!;
    const highest = table[table.length - 1]!;
    // boost 가 오를수록 이미지 점수가 단조 증가(가산 delta = imageVecContrib ×
    // (boost-1) 이 boost 에 선형 증가 / 무관 글은 imageVec 기여 0 이라 불변).
    for (let i = 1; i < table.length; i++) {
      expect(table[i]!.imageScore).toBeGreaterThan(table[i - 1]!.imageScore);
    }
    // 무관 글 1위 점수는 boost 와 무관하게 불변(무관 글은 imageVec 기여 0).
    for (const row of table) {
      expect(row.topDistractorScore).toBeCloseTo(neutral.topDistractorScore, 9);
    }
    // boost 가 충분히 오르면 이미지가 무관 글 위로 올라온다(흠 해소 / 방식 효과).
    expect(highest.imageScore).toBeGreaterThan(highest.topDistractorScore);
    expect(highest.imageRank).toBeLessThanOrEqual(neutral.imageRank);
  }

  test(
    "현실 사례(딴 한 항목): boost 가 오를수록 맞는 이미지가 무관 글 위로 올라온다 (측정 표)",
    async () => {
      if (!siglipAvailable) {
        throw new Error(
          "SigLIP text encoder 미로드 — image_vec 채널 측정 불가(이 테스트는 실 모델 의존). " +
            "모델 다운로드 후 재실행 필요(silent skip 금지 — 정직한 실패).",
        );
      }
      // 현실 사례(딴 한 항목 / distractorCount=1) — default 결정 기준.
      const realistic = await measureSweep("현실 사례 — 딴 1 항목", 1);
      assertSweepInvariants(realistic);

      // 운영 default 가 현실 사례에서 이미지를 무관 글 위로 회수하는지 단언한다
      // (search-tuning SOURCE_BOOST.imageVec 확정값 검증 — 측정으로 고른 값).
      const atDefault = realistic.find(
        (r) => Math.abs(r.boost - OPERATIONAL_DEFAULT_BOOST) < 1e-9,
      );
      expect(atDefault).toBeDefined();
      expect(atDefault!.imageScore).toBeGreaterThan(atDefault!.topDistractorScore);
      console.log(
        `[T7 현실 사례 — 운영 default ${OPERATIONAL_DEFAULT_BOOST}] ` +
          `이미지 rank ${atDefault!.imageRank} / score ${atDefault!.imageScore.toFixed(6)} ` +
          `> 무관 글 1위 ${atDefault!.topDistractorScore.toFixed(6)} (흠 해소 확인)`,
      );

      // 스트레스 사례(딴 5 항목 클러스터) — 방식이 더 두꺼운 연결성에서도 동작함을
      // 보인다(default 결정 기준 아님 — 참고용 측정 표). highest boost 에서 회수됨.
      const stress = await measureSweep("스트레스 사례 — 딴 5 항목 클러스터", 5);
      assertSweepInvariants(stress);
    },
    600_000,
  );

  test(
    "운영 경로(options.imageVecBoost) default 값에서 맞는 이미지가 무관 글 위로 올라온다",
    async () => {
      if (!siglipAvailable) {
        throw new Error(
          "SigLIP text encoder 미로드 — 측정 불가(정직한 실패).",
        );
      }
      // 현실 사례(딴 한 항목) — search 라우트가 쓰는 운영 경로(options.imageVecBoost)를
      // 직접 검증한다(sweep tuning 이 아니라 settings 경유 칸과 같은 통로).
      const ctx = await buildSweepCorpus(1);
      try {
        // 운영 경로 검증 — tuning 없이 options.imageVecBoost(운영 default 와 같은 값)로
        // 줘도 같은 effectiveImageVecBoost 로 모인다. 여기서는 운영 default 값을
        // 명시 전달해 "운영에서 이미지가 무관 글 위로 회수됨" 을 단언한다.
        const results = await ctx.retriever.retrieve(QUERY, {
          limit: FLAT_LIMIT,
          imageVecBoost: OPERATIONAL_DEFAULT_BOOST,
        });
        const imageIdx = results.findIndex(
          (r) => r.node.id === ctx.imageNodeId,
        );
        const imageScore = results[imageIdx]?.score ?? Number.NaN;
        const topDistractor = results
          .filter((r) => ctx.distractorIds.includes(r.node.id))
          .reduce(
            (max, r) => (r.score > max ? r.score : max),
            Number.NEGATIVE_INFINITY,
          );

        console.log(
          `[T7 운영 default ${OPERATIONAL_DEFAULT_BOOST}] 이미지 rank=${imageIdx + 1} ` +
            `score=${imageScore.toFixed(6)} vs 무관 글 1위 score=${topDistractor.toFixed(6)}`,
        );

        expect(imageIdx).toBeGreaterThanOrEqual(0);
        // 운영 default 가 사용자가 짚은 흠을 고친다 — 이미지가 무관 글 위로 올라온다.
        expect(imageScore).toBeGreaterThan(topDistractor);
      } finally {
        ctx.close();
      }
    },
    600_000,
  );
});

// ── 4. 배선 확인: effectiveImageVecBoost 가 실제로 반영된다 ───────────────────

describe("T7 — effectiveImageVecBoost 배선: boost=1.0 중립 / boost>1 이미지만 상승", () => {
  const SIGLIP_DIM = 768;
  const QUERY = "파란 모자 쓴 강아지";

  /** 맞는 이미지 + 무관 글 한 개만 둔 최소 코퍼스. */
  async function buildMinimal(): Promise<{
    retriever: HybridRetriever;
    imageNodeId: number;
    db: ReturnType<typeof openMemoryDatabase>;
    close: () => void;
  }> {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    const queryImageVec = await embedQuerySiglipText(QUERY);
    if (!queryImageVec || queryImageVec.length !== SIGLIP_DIM) {
      throw new Error("SigLIP text encoder 미가용 — 배선 측정 불가");
    }
    const imageNodeId = addImageAssetNode(db, {
      content: "파란 모자 강아지 그림 자산",
      embedding: queryImageVec,
      assetSha256: "t7-wiring-image-asset",
    });
    await store.addNode({ content: "오늘 날씨가 흐렸다" });
    const retriever = new HybridRetriever(store, embedder);
    return { retriever, imageNodeId, db, close: () => db.close() };
  }

  test(
    "tuning.imageVecBoost / options.imageVecBoost 가 같은 effectiveImageVecBoost 로 모인다",
    async () => {
      if (!siglipAvailable) {
        throw new Error("SigLIP text encoder 미로드 — 배선 측정 불가(정직한 실패).");
      }
      const ctx = await buildMinimal();
      try {
        const scoreAt = async (
          via: "tuning" | "options",
          boost: number,
        ): Promise<number> => {
          const opts =
            via === "tuning"
              ? { limit: FLAT_LIMIT, tuning: { imageVecBoost: boost } }
              : { limit: FLAT_LIMIT, imageVecBoost: boost };
          const results = await ctx.retriever.retrieve(QUERY, opts);
          const r = results.find((x) => x.node.id === ctx.imageNodeId);
          if (!r) throw new Error("맞는 이미지가 결과에 없다 — imageVec 채널 미동작");
          return r.score;
        };

        // boost=1.0 — 변경 전과 동일(가산 delta = imageVecContrib × 0 = 0).
        const tuning1 = await scoreAt("tuning", 1.0);
        const options1 = await scoreAt("options", 1.0);
        // tuning 경로와 options 경로가 같은 boost 면 같은 점수(같은 effectiveImageVecBoost).
        expect(options1).toBeCloseTo(tuning1, 9);

        // boost=2.0 — 이미지 점수가 boost=1.0 대비 오른다(전용 boost 반영).
        const tuning2 = await scoreAt("tuning", 2.0);
        const options2 = await scoreAt("options", 2.0);
        expect(options2).toBeCloseTo(tuning2, 9);
        expect(tuning2).toBeGreaterThan(tuning1);

        console.log(
          `[T7 배선] tuning boost 1.0→2.0: ${tuning1.toFixed(6)}→${tuning2.toFixed(6)} / ` +
            `options 경로 동일(${options1.toFixed(6)}=${tuning1.toFixed(6)}, ` +
            `${options2.toFixed(6)}=${tuning2.toFixed(6)})`,
        );
      } finally {
        ctx.close();
      }
    },
    600_000,
  );
});
