/**
 * magnitude-fusion-baseline.test.ts — 강도-반영 융합 plan Task 1 (T1, 측정 토대).
 *
 * 이 task 는 검색 코어(retriever.ts / rrf.ts / search-tuning.ts)를 *한 줄도*
 * 바꾸지 않는다 — 변경 *전* 상태(boost 2.5 운영 default)를 측정으로 고정해, 회수/
 * 정밀 2단계 재설계를 시작하는 이후 task 들의 회귀 게이트로 삼는다. 설계 권위 =
 * docs/decisions/2026-06-01-magnitude-aware-fusion-design.md.
 *
 * harness 는 retriever.retrieve 를 직접 부른다 → 리랭커(search.ts 의 POST-RRF
 * cross-encoder)·VLM 캡션을 통과하지 않는다. 그러므로 이 파일의 모든 측정은
 * **리랭커-off = 무-LLM 토대 정확성**(설계 §7 불변식 1)을 잰다. 보강(리랭커/VLM)이
 * 정확성을 올릴 *전제* 가 아니라 cosine 보정 수학만으로 성립하는지를 고정한다.
 *
 * 세 가지를 측정·단언한다:
 *
 *  1. 현 동작 snapshot — "노란후드" 검색(retriever.retrieve, 리랭커-off)에서
 *     분별 코퍼스 각 항목의 점수·순위를 `노드id|score|sources` 로 직렬화하고,
 *     **현재(boost 2.5) 노란옷(중간 강도 이미지)이 노란후드(강한 매치)를
 *     이기는지/아슬아슬한지를 사실로 기록한다** — 이게 이후 task 가 뒤집을 대상.
 *
 *  2. 글 nDCG baseline — image-search-foundation-baseline 양식 그대로, 기존
 *     runHarness 를 *호출만* 해 flat 글 코퍼스 full-rrf nDCG floor 를 단언한다
 *     (리랭커-off / 0.8882 는 Granite embedder 시절 실측, bge-m3 재실측 floor 는
 *     상수 주석 참조). 회수/정밀 재배치가 글 검색을 깨면 이 게이트가 먼저 잡는다.
 *
 *  3. graph-hop 합류 — query 로 직접 안 닿고 연결 엣지로만 닿는 정답이 현재 검색
 *     결과에 합류함을 단언한다(설계 §7 불변식 3 — graph-hop 보존).
 *
 * 측정 방식(mock 클래스 0 / 데이터 fixture 만):
 *  - 글은 실 Bgem3Embedder 텍스트 임베딩(실제 vector·fts 채널).
 *  - 이미지는 addImageAssetNode 로 적재 — image_vec 행에 **실 SigLIP text encoder**
 *    가 임베딩한 768-dim Float32Array 를 넣는다(데이터 fixture — mock 아님). 강한
 *    매치 이미지는 image_vec=SigLIP(QUERY) 그대로라 거리 ~0 rank-1 후보가 되고,
 *    중간 강도 이미지는 image_vec=SigLIP("노란 옷 ...") 라 같은 QUERY 와 cosine 이
 *    자연스레 더 낮다(인코더가 산출한 진짜 강도 차이 — 임의 조작 0).
 *  - 신규 측정자(새 harness·새 nDCG 구현)는 만들지 않는다 — 기존 harness.ts 의
 *    runHarness / loadCorpus / SWEEP_VARIANTS 와 metrics.ts 를 재사용한다.
 *
 * 실 Bgem3Embedder + 실 SigLIP text encoder + bun:sqlite + :memory: DB — mock 0.
 * 운영 DB(data/bara.sqlite)는 절대 건드리지 않는다(모든 적재는 :memory:). 코어
 * (rrf.ts / search-tuning.ts / retriever.ts)·봇은 0줄 변경 — 이 파일만 추가한다.
 * 모델 로드가 느려 timeout 넉넉히(600000ms).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import {
  embedQuerySiglipText,
  loadSiglipTextEncoder,
} from "../../embedding/siglip2-text.ts";
import { SIGLIP2_DIM } from "../../embedding/siglip2.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { addImageAssetNode } from "../image-asset.ts";
import { HybridRetriever } from "../retriever.ts";
import type { RetrievalResult } from "../retriever.ts";
import { SOURCE_BOOST } from "../search-tuning.ts";
import { runHarness, SWEEP_VARIANTS } from "./harness.ts";
import { EVAL_QUERIES } from "./answer-map.ts";

/**
 * flat full-rrf 기준선 floor — Granite embedder 시절 실측 0.8882(image-search-
 * foundation T6 / 11e baseline) → 테스트 embedder bge-m3 전환 후 재실측
 * 2026-07-10 avgNdcg 0.9029. floor 0.90(여유 0.003) — 글 검색이 이 floor 아래로
 * 떨어지면 회귀(회수/정밀 재배치가 글 검색을 건드렸다는 신호 — 이후 task 의
 * 회귀 게이트가 비교할 baseline).
 */
const FLAT_FULL_RRF_FLOOR = 0.9;

/**
 * flat recall floor — Granite 시절 만점(1.0) → bge-m3 재실측 2026-07-10
 * avgRecall 0.975. floor 0.97 — magnitude-fusion-regression FLAT_RECALL_FLOOR 정합.
 */
const FLAT_RECALL_FLOOR = 0.97;

/** 측정 창 — image-search-foundation / 11e baseline 과 같은 20. */
const FLAT_LIMIT = 20;

/** 운영 default — search-tuning SOURCE_BOOST.imageVec(현재 2.5 — 변경 전 상태). */
const OPERATIONAL_DEFAULT_BOOST = SOURCE_BOOST.imageVec;

/** 분별 코퍼스의 핵심 검색어 — 사용자가 짚은 "노란후드" 케이스. */
const QUERY = "노란 후드 입은 캐릭터";

/**
 * 검색 결과를 byte 비교용 결정론적 문자열로 직렬화한다(11e/T6/T7 serializeRanking
 * 정합). 노드 id·score(소수점 12 단위 고정)·sources 만 한 줄씩. 부동소수 score 를
 * toFixed 로 고정해 같은 입력이면 항상 같은 문자열이 나온다 — 이후 task 가 정밀
 * 재정렬 후 같은 직렬화로 만들어 이 기준점과 비교한다.
 */
function serializeRanking(results: ReadonlyArray<RetrievalResult>): string {
  return results
    .map((r) => `${r.node.id}|${r.score.toFixed(12)}|${r.sources.join(",")}`)
    .join("\n");
}

let embedder: Bgem3Embedder;
let siglipAvailable: boolean;

// 교차 확인용 전역 — 현 동작 snapshot 테스트가 "강한 매치 cosine > 중간 강도
// cosine" 을 인코더 산출 사실로 단언하는 데 쓴다(측정 토대 자족성 확인용 — 운영
// 코드 미노출, 테스트 파일 안에서만 쓴다).
let strongImageVecGlobal: Float32Array;
let midImageVecGlobal: Float32Array;
let queryVecGlobal: Float32Array;

/** 두 L2-정규화 벡터의 cosine(내적). SigLIP 출력은 이미 L2 정규화라 내적=cosine. */
function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
  // SigLIP text encoder 로드 — image_vec 후보 측정에 필요(실 모델, mock 0).
  siglipAvailable = await loadSiglipTextEncoder();

  // 교차 확인용 임베딩 산출 — 강한 매치는 QUERY 그대로, 중간 강도는 "노란 옷 ..."
  // 라 같은 QUERY 와 cosine 이 더 낮다(인코더 산출 진짜 강도 차이 — 임의 조작 0).
  if (siglipAvailable) {
    const q = await embedQuerySiglipText(QUERY);
    const strong = await embedQuerySiglipText(QUERY);
    const mid = await embedQuerySiglipText("노란 옷을 입은 사람 사진");
    if (
      !q ||
      !strong ||
      !mid ||
      q.length !== SIGLIP2_DIM ||
      strong.length !== SIGLIP2_DIM ||
      mid.length !== SIGLIP2_DIM
    ) {
      throw new Error("SigLIP text encoder 교차확인 임베딩 산출 실패 — 측정 불가");
    }
    queryVecGlobal = q;
    strongImageVecGlobal = strong;
    midImageVecGlobal = mid;
  }
}, 600_000);

afterAll(() => {});

// ── 분별 fixture 코퍼스 구성(:memory:, 운영 DB 불변경) ────────────────────────
//
// 설계 §8 의 "노란후드 > 노란옷" 케이스를 그대로 재현한다. 다섯 갈래:
//   (1) 글 노드 "노란후드 ..."        — vector·fts 강한 매치(QUERY 어휘 다수 포함).
//   (2) 이미지 노드 "노란옷"          — image_vec=SigLIP("노란 옷 ...") → QUERY 와
//                                       cosine 중간 강도(인코더 산출 진짜 강도).
//   (3) 이미지 노드 "노란후드"        — image_vec=SigLIP(QUERY) 그대로 → 거리 ~0
//                                       rank-1 강한 매치.
//   (4) 다채널 무관 글 N개            — QUERY 와 글자가 약하게 겹쳐 vector·fts·graph·
//                                       concept 여러 채널에 합류(합산 이점만 큰 항목).
//   (5) graph-hop seed/정답          — seed 는 QUERY 와 무관한 별 query 어휘로 직접
//                                       잡히고, 정답은 연결 엣지로만 닿는다.
//
// addImageAssetNode / addNode / findOrCreateTagConcept / addNodeConceptEdge /
// addEdge 는 운영 store API 그대로 — 우회 0. 이미지 임베딩만 768-dim Float32Array
// 데이터 fixture(실 SigLIP 산출 — mock 클래스 아님).

interface DiscriminationCorpus {
  retriever: HybridRetriever;
  /** (3) 강한 매치 이미지 — image_vec=SigLIP(QUERY). */
  strongImageId: number;
  /** (2) 중간 강도 이미지 — image_vec=SigLIP("노란 옷 ..."). */
  midImageId: number;
  /** (1) 강한 매치 글 — QUERY 어휘 다수 포함. */
  strongTextId: number;
  /** (4) 다채널 무관 글 id 들. */
  distractorIds: number[];
  /** (5) graph-hop seed(직접 잡힘) / 정답(연결로만 닿음). */
  graphHopSeedId: number;
  graphHopAnswerId: number;
  close: () => void;
}

/** 연결성 높은 무관 글 — QUERY 와 글자가 약하게 겹쳐 다채널 합류한다(흠 재현). */
const DISTRACTOR_CONTENTS = [
  "노란 우비를 입은 친구 이야기를 적은 일기",
  "후드 티 쇼핑 후기를 정리한 메모",
  "캐릭터 굿즈 수집 목록 정리",
  "노란 가방을 산 날의 기록",
  "겨울 후드 코디 정리 노트",
];

async function buildDiscriminationCorpus(): Promise<DiscriminationCorpus> {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);

  // (1) 강한 매치 글 — QUERY 의 핵심 어휘("노란"·"후드"·"캐릭터")를 다수 담아
  //     vector·fts 채널에서 강하게 잡힌다.
  const strongTextId = await store.addNode({
    content: "노란 후드를 입은 캐릭터를 그린 일러스트 감상문",
  });

  // (3) 강한 매치 이미지 — image_vec = SigLIP(QUERY) 그대로. retriever 가 같은
  //     QUERY 를 SigLIP 으로 임베딩해 cosine KNN 을 돌리면 거리 ~0 rank-1 이 된다.
  const strongImageVec = await embedQuerySiglipText(QUERY);
  if (!strongImageVec || strongImageVec.length !== SIGLIP2_DIM) {
    throw new Error(
      `SigLIP text encoder 가 강한 매치 이미지 임베딩을 못 냈다` +
        `(len=${strongImageVec?.length ?? "null"}) — 측정 불가`,
    );
  }
  const strongImageId = addImageAssetNode(db, {
    content: "노란 후드 캐릭터 일러스트 자산",
    embedding: strongImageVec,
    assetSha256: "magfusion-strong-image",
  });

  // (2) 중간 강도 이미지 — image_vec = SigLIP("노란 옷 ...") 라 같은 QUERY 와의
  //     cosine 이 (3) 보다 자연스레 낮다(인코더가 산출한 진짜 강도 차이 — "노란"은
  //     겹치되 "후드/캐릭터" 어휘가 빠져 의미가 약하게 닿는다). 임의 조작 0.
  const midImageVec = await embedQuerySiglipText("노란 옷을 입은 사람 사진");
  if (!midImageVec || midImageVec.length !== SIGLIP2_DIM) {
    throw new Error(
      `SigLIP text encoder 가 중간 강도 이미지 임베딩을 못 냈다` +
        `(len=${midImageVec?.length ?? "null"}) — 측정 불가`,
    );
  }
  const midImageId = addImageAssetNode(db, {
    content: "노란 옷 캐릭터 그림 자산",
    embedding: midImageVec,
    assetSha256: "magfusion-mid-image",
  });

  // (4) 다채널 무관 글 — QUERY 와 글자가 약하게 겹쳐 vector·fts 에 합류하고, 그
  //     합류가 graph BFS seed 가 되어 아래 개념 클러스터를 끌어와 graph·concept
  //     채널까지 다채널로 합산된다(합산 이점만 큰 항목 — 설계 §8.1 흠 재현).
  const distractorIds: number[] = [];
  for (const content of DISTRACTOR_CONTENTS) {
    distractorIds.push(await store.addNode({ content }));
  }
  // 두 개념('일상기록'·'노란색')에 동시 연결 → graph BFS 1-hop 클러스터 + concept
  // 채널 합류로 연결성을 부풀린다(image-search-foundation T7 distractor 양식 정합).
  const themeA = await store.findOrCreateTagConcept("일상기록");
  const themeB = await store.findOrCreateTagConcept("노란색");
  for (const id of distractorIds) {
    await store.addNodeConceptEdge(id, themeA, "tag", "user_input", id);
    await store.addNodeConceptEdge(id, themeB, "tag", "user_input", id);
  }

  // (5) graph-hop — seed 는 QUERY 와 무관한 별 어휘("백업 일정")로 직접 잡히고,
  //     정답은 QUERY·seed query 어느 쪽으로도 직접 안 닿고 related_to 엣지로만
  //     도달된다(enriched 코퍼스 theme_change→theme_reason 양식 정합). 강한 유사도
  //     매치가 있는 본 코퍼스에서도 graph-hop 정답이 검색에 합류함을 본다(§7 불변식 3).
  const graphHopSeedId = await store.addNode({
    content: "메인 작업 테마를 새 배색으로 교체했다",
  });
  const graphHopAnswerId = await store.addNode({
    content: "오래 들여다봐도 눈이 덜 시린 차분한 색이 필요했기 때문이다",
  });
  await store.addEdge({
    sourceId: graphHopSeedId,
    targetId: graphHopAnswerId,
    relation: "related_to",
    provenance: "user_input",
    sourceNodeId: null,
    weight: 0.8,
  });

  const retriever = new HybridRetriever(store, embedder);
  return {
    retriever,
    strongImageId,
    midImageId,
    strongTextId,
    distractorIds,
    graphHopSeedId,
    graphHopAnswerId,
    close: () => db.close(),
  };
}

// ── 1. 현 동작 snapshot — "노란후드" 검색에서 노란옷 vs 노란후드 순위 사실 기록 ──

describe("T1 — 분별 코퍼스 현 동작 snapshot (boost 2.5 / 리랭커-off 무-LLM 토대)", () => {
  test(
    "'노란후드' 검색에서 강한/중간 강도 이미지·강한 글·다채널 무관 글의 현재 순위를 기록한다",
    async () => {
      if (!siglipAvailable) {
        throw new Error(
          "SigLIP text encoder 미로드 — image_vec 채널 측정 불가(이 테스트는 실 모델 의존). " +
            "모델 다운로드 후 재실행 필요(silent skip 금지 — 정직한 실패).",
        );
      }
      const ctx = await buildDiscriminationCorpus();
      try {
        // 운영 default(boost 2.5) 경로 — 리랭커 없이 retriever.retrieve 직접 호출.
        const results = await ctx.retriever.retrieve(QUERY, {
          limit: FLAT_LIMIT,
        });

        const rankOf = (id: number): number => {
          const idx = results.findIndex((r) => r.node.id === id);
          return idx === -1 ? -1 : idx + 1;
        };
        const scoreOf = (id: number): number =>
          results.find((r) => r.node.id === id)?.score ?? Number.NaN;

        const strongImageRank = rankOf(ctx.strongImageId);
        const midImageRank = rankOf(ctx.midImageId);
        const strongTextRank = rankOf(ctx.strongTextId);
        const strongImageScore = scoreOf(ctx.strongImageId);
        const midImageScore = scoreOf(ctx.midImageId);
        const strongTextScore = scoreOf(ctx.strongTextId);
        const topDistractorScore = results
          .filter((r) => ctx.distractorIds.includes(r.node.id))
          .reduce(
            (max, r) => (r.score > max ? r.score : max),
            Number.NEGATIVE_INFINITY,
          );

        // 결정론적 snapshot 직렬화 — 이후 task 가 정밀 재정렬 후 비교할 기준점.
        const snapshot = serializeRanking(results);

        console.log(
          `[T1 현 동작 snapshot] query="${QUERY}" / 운영 default boost=${OPERATIONAL_DEFAULT_BOOST} / 리랭커-off`,
        );
        console.log(
          `  강한 매치 이미지(노란후드, id=${ctx.strongImageId}) rank=${strongImageRank} score=${strongImageScore.toFixed(6)}`,
        );
        console.log(
          `  중간 강도 이미지(노란옷, id=${ctx.midImageId}) rank=${midImageRank} score=${midImageScore.toFixed(6)}`,
        );
        console.log(
          `  강한 매치 글(노란후드 글, id=${ctx.strongTextId}) rank=${strongTextRank} score=${strongTextScore.toFixed(6)}`,
        );
        console.log(
          `  다채널 무관 글 1위 score=${topDistractorScore.toFixed(6)}`,
        );
        console.log(`  snapshot 직렬화 길이=${snapshot.length}자`);

        // ── 변경 전 상태 사실 기록 — 이게 이후 task 가 뒤집을 대상이다 ──
        // 강도가 다른 두 이미지가 모두 image_vec=SigLIP(query)·SigLIP("노란옷")로
        // 적재돼 같은 imageVec 채널에서 회수된다. 현재(boost 2.5) 코어는 imageVec
        // 채널 *순위* 에 boost 를 곱하므로, 강한 매치(거리 ~0 rank-1)와 중간 강도
        // (rank-2)가 같은 boost 를 받는다. 둘의 순위·점수 사실을 기록한다.
        const midBeatsStrong =
          midImageScore > strongImageScore ? "이긴다" : "진다";
        const closeCall =
          Math.abs(midImageScore - strongImageScore) < 1e-6 ? " (아슬아슬/동률)" : "";
        console.log(
          `  → 현재 노란옷(중간) vs 노란후드(강한): 노란옷이 ${midBeatsStrong}${closeCall} ` +
            `(score 차이 ${(midImageScore - strongImageScore).toFixed(6)})`,
        );
        const midBeatsDistractor =
          midImageScore > topDistractorScore ? "이긴다" : "진다";
        console.log(
          `  → 현재 노란옷(중간 강도) vs 다채널 무관 글: 노란옷이 ${midBeatsDistractor}`,
        );

        // 두 이미지·강한 글·무관 글이 모두 결과에 합류했다(부분 측정 아님).
        expect(strongImageRank).toBeGreaterThan(0);
        expect(midImageRank).toBeGreaterThan(0);
        expect(strongTextRank).toBeGreaterThan(0);
        expect(Number.isFinite(topDistractorScore)).toBe(true);

        // 사실 단언 — 강한 매치 이미지(거리 ~0)는 중간 강도 이미지 이상 점수다.
        // 같은 imageVec 채널에서 rank-1(강한) vs rank-2(중간)라 boost 를 같이 받아도
        // RRF 순위 기여가 강한 쪽이 크다. 이건 *현재* 동작 사실이며, 이후 task 가
        // 깨면 안 되는 방향(강한 매치 우세)이 이미 이 채널 안에서 성립함을 기록한다.
        expect(strongImageScore).toBeGreaterThanOrEqual(midImageScore);

        // 두 임베딩의 진짜 강도 차이가 실재함을 교차 확인 — 강한 매치는 QUERY 그대로,
        // 중간 강도는 "노란 옷 ..." 라 QUERY 와 cosine 이 더 낮다(인코더 산출 사실).
        const strongCos = dot(strongImageVecGlobal, queryVecGlobal);
        const midCos = dot(midImageVecGlobal, queryVecGlobal);
        console.log(
          `  → image_vec cosine(QUERY 대비): 강한 매치 ${strongCos.toFixed(4)} > 중간 강도 ${midCos.toFixed(4)} ` +
            `(인코더 산출 진짜 강도 차이 — 임의 조작 0)`,
        );
        expect(strongCos).toBeGreaterThan(midCos);
      } finally {
        ctx.close();
      }
    },
    600_000,
  );
});

// ── 2. 글 nDCG baseline (기존 harness 재사용 / 리랭커-off) ────────────────────

describe("T1 — 글 검색 nDCG baseline (회수/정밀 재배치 회귀 게이트)", () => {
  test(
    "flat 글 코퍼스 full-rrf nDCG 가 bge-m3 실측 floor(0.90)를 유지한다 (리랭커-off)",
    async () => {
      // 기존 runHarness 를 호출만 — 신규 측정자 0(image-search-foundation T6 양식).
      // harness 는 retriever.retrieve 를 직접 부르므로 리랭커-off 측정이다.
      const snap = await runHarness(embedder, {
        variants: {
          "vector-only": SWEEP_VARIANTS["vector-only"]!,
          "full-rrf": SWEEP_VARIANTS["full-rrf"]!,
        },
      });

      const vectorOnly = snap.variants.find((v) => v.variant === "vector-only")!;
      const flatFull = snap.variants.find((v) => v.variant === "full-rrf")!;

      console.log(
        `[T1 글 baseline — flat / 리랭커-off] vector-only ` +
          `nDCG=${vectorOnly.avgNdcg.toFixed(4)} recall=${vectorOnly.avgRecall.toFixed(4)} ` +
          `MRR=${vectorOnly.avgMrr.toFixed(4)}`,
      );
      console.log(
        `[T1 글 baseline — flat / 리랭커-off] full-rrf ` +
          `nDCG=${flatFull.avgNdcg.toFixed(4)} recall=${flatFull.avgRecall.toFixed(4)} ` +
          `MRR=${flatFull.avgMrr.toFixed(4)} (이후 task 회귀 게이트)`,
      );

      // 회수/정밀 재배치가 글 검색을 깨면 이 floor 가 먼저 잡는다(설계 §7 불변식 4).
      expect(flatFull.avgNdcg).toBeGreaterThanOrEqual(FLAT_FULL_RRF_FLOOR);
      // 글 검색 recall floor 유지(이미지 합류가 글 정답을 창 밖으로 안 밀어냄).
      // Granite 시절 만점(1.0) → bge-m3 재실측 2026-07-10 avgRecall 0.975.
      expect(flatFull.avgRecall).toBeGreaterThanOrEqual(FLAT_RECALL_FLOOR);
      // 모든 query 가 채점됐다(부분 측정 아님).
      expect(flatFull.perQuery.length).toBe(EVAL_QUERIES.length);
    },
    600_000,
  );
});

// ── 3. graph-hop 합류 — 연결로만 닿는 정답이 현재 검색에 합류한다(§7 불변식 3) ──

describe("T1 — graph-hop 정답 합류 (강한 유사도 매치가 있어도 연결로만 닿는 답 보존)", () => {
  test(
    "graph-hop 정답이 seed query 검색 결과에 graph 채널로 합류한다",
    async () => {
      if (!siglipAvailable) {
        throw new Error(
          "SigLIP text encoder 미로드 — 분별 코퍼스 적재 불가(정직한 실패).",
        );
      }
      const ctx = await buildDiscriminationCorpus();
      try {
        // seed 의 어휘("테마 교체 배색")로 검색하면 seed 가 vector·fts 로 직접
        // 잡히고, related_to 엣지로 1-hop 연결된 정답이 graph 채널로 합류한다.
        // 정답 글(변경 *이유*)에는 seed query 어휘가 없어 graph 채널 없이는 못 닿는다
        // (enriched 코퍼스 theme_change→theme_reason graph-hop 양식 정합 / EQ5).
        const seedQuery = "작업 테마 배색 교체";

        // 좁은 vectorK 로 측정한다. 본 코퍼스는 노드가 10개뿐이라 DEFAULT_VECTOR_K
        // (=20) 로는 vector KNN 이 *모든* 노드(무관 정답 글 포함)를 후보로 회수해
        // graph-hop 메커니즘이 직접 vector 매치에 가려진다(enriched 코퍼스가 40+
        // distractor 로 vector 슬롯을 채워 theme_reason 을 창 밖으로 밀어내는 것과
        // 같은 격리를 작은 코퍼스에선 좁은 vectorK 로 만든다). vectorK=2 면 vector
        // 후보는 seed 와 가장 가까운 2개뿐이라 무관 정답 글이 빠지고, 정답은 오직
        // graph BFS(seed→related_to 1-hop)로만 회수된다 — graph 채널 순기여를 격리.
        const NARROW_VECTOR_K = 2;

        // (가) graph 채널 ON — 정답이 graph BFS 로 회수되는지 본다.
        const withGraph = await ctx.retriever.retrieve(seedQuery, {
          limit: FLAT_LIMIT,
          vectorK: NARROW_VECTOR_K,
          ftsLimit: NARROW_VECTOR_K,
        });
        // (나) graph 채널 OFF 대조군 — 같은 좁은 창에서 정답이 사라짐을 본다
        //      (정답 회수의 원인이 graph 채널 단 하나임을 격리 — §7 불변식 3).
        const withoutGraph = await ctx.retriever.retrieve(seedQuery, {
          limit: FLAT_LIMIT,
          vectorK: NARROW_VECTOR_K,
          ftsLimit: NARROW_VECTOR_K,
          channelMask: {
            vector: true,
            fts: true,
            graph: false,
            concept: true,
            imageVec: true,
          },
        });

        const seed = withGraph.find((r) => r.node.id === ctx.graphHopSeedId);
        const answer = withGraph.find((r) => r.node.id === ctx.graphHopAnswerId);
        const answerNoGraph = withoutGraph.find(
          (r) => r.node.id === ctx.graphHopAnswerId,
        );

        console.log(
          `[T1 graph-hop] query="${seedQuery}" / vectorK=${NARROW_VECTOR_K} (리랭커-off)`,
        );
        console.log(
          `  seed(id=${ctx.graphHopSeedId}) 합류=${seed !== undefined} ` +
            `sources=[${seed?.sources.join(",") ?? "없음"}]`,
        );
        console.log(
          `  graph 채널 ON: graph-hop 정답(id=${ctx.graphHopAnswerId}) 합류=${answer !== undefined} ` +
            `sources=[${answer?.sources.join(",") ?? "없음"}] ` +
            `score=${answer?.score.toFixed(6) ?? "없음"}`,
        );
        console.log(
          `  graph 채널 OFF(대조): graph-hop 정답 합류=${answerNoGraph !== undefined} ` +
            `(graph 끄면 사라져야 graph 채널 순기여가 격리됨)`,
        );

        // seed 가 직접 잡힌다(vector·fts 채널 — graph BFS seed 자격).
        expect(seed).toBeDefined();
        // graph 채널 ON 이면 graph-hop 정답이 검색 결과에 합류한다(§7 불변식 3).
        expect(answer).toBeDefined();
        // 정답의 합류 원인에 graph 채널이 포함된다(연결로만 닿았음을 직접 확인).
        expect(answer!.sources).toContain("graph");
        // graph 채널을 끄면(같은 좁은 창) 정답이 사라진다 — 회수 원인이 graph 단 하나.
        expect(answerNoGraph).toBeUndefined();
      } finally {
        ctx.close();
      }
    },
    600_000,
  );
});
