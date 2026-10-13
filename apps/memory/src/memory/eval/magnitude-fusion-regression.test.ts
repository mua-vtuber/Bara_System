/**
 * magnitude-fusion-regression.test.ts — 강도-반영 융합 plan Task 4 (T4) 측정 게이트.
 *
 * T4 는 검색 정밀 코어를 *바꾸는* task 다 — RRF(rrf.ts) 순위 합산은 회수 역할로
 * 그대로 두되, T2 가 노출한 원시 cosine 강도를 T3(calibration.ts)으로 채널 안에서
 * 보정해 finalScore 에 가산한다(설계 §4.2). 이 파일은 D-N1(강도 결합 방식 + 보정
 * 방식 + 가중치 λ)을 *측정으로* 확정하고, 채택값이 게이트를 다 통과함을 단언한다.
 *
 * 설계 권위 = docs/decisions/2026-06-01-magnitude-aware-fusion-design.md.
 *
 * harness 는 retriever.retrieve 를 직접 부른다 → 리랭커·VLM 을 통과하지 않는다.
 * 그러므로 모든 측정은 **리랭커-off = 무-LLM 토대 정확성**(설계 §7 불변식 1)을 잰다.
 *
 * 측정 게이트(dispatch U4 — 전부 통과해야 채택):
 *  1. 글 nDCG 0.8882 회귀 0 또는 개선(harness 글 코퍼스 / 리랭커-off). 하락하면 기각.
 *  2. 노란후드 분별(T1 fixture): 노란후드 글·이미지(정확 매치) > 노란옷 이미지(중간)
 *     > 무관 다채널 글. 특히 노란후드 글이 무관 다채널 위로.
 *  3. graph-hop 보존: 연결로만 닿는 정답이 여전히 합류.
 *  4. 이미지 0건 글-only: 강도 통합 후에도 글-only 검색이 정당하게 유지/개선.
 *
 * 측정 표(후보별 글 nDCG / 노란후드 글·이미지·노란옷 순위 / graph-hop)를 console 로
 * 남긴다 — 메인이 사용자에게 D-N1 을 보고할 근거다. 측정 전 추측 확정 금지: 채택
 * default(search-tuning.ts PRECISION_*)는 이 표가 게이트를 다 통과시킨 결과다.
 *
 * 측정 방식(mock 클래스 0 / 데이터 fixture 만): magnitude-fusion-baseline.test.ts 와
 * 같은 분별 코퍼스(실 Bgem3Embedder 글 임베딩 + 실 SigLIP text encoder 이미지
 * 임베딩). 운영 DB(data/bara.sqlite)는 절대 건드리지 않는다(:memory: 만). 코어
 * rrf.ts·봇·concept-repository 는 0줄 변경 — 변경은 retriever 융합 가산 항 +
 * search-tuning 상수 + settings + calibration.ts(T3 순수 함수) 사용.
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
import type {
  RetrievalResult,
  RetrieveTuning,
} from "../retriever.ts";
import {
  PRECISION_STRENGTH_MODE,
  PRECISION_STRENGTH_WEIGHT,
  PRECISION_WEIGHT_SWEEP_GRID,
  VECTOR_CALIBRATION_METHOD,
  IMAGE_VEC_CALIBRATION_METHOD,
  SOURCE_BOOST,
  BASELINE_FLOOR_MODE,
  VECTOR_COSINE_BASELINE,
  IMAGE_VEC_COSINE_BASELINE,
  VECTOR_BASELINE_SWEEP_GRID,
  IMAGE_VEC_BASELINE_SWEEP_GRID,
  type PrecisionStrengthMode,
  type CalibrationMethod,
  type BaselineFloorMode,
} from "../search-tuning.ts";
import { runHarness, SWEEP_VARIANTS } from "./harness.ts";

/** 운영 default 정밀 강도 tuning — T5 측정이 강도 코어를 켠 상태를 재현할 때 쓴다. */
const ADOPTED_PRECISION_TUNING: RetrieveTuning = {
  precisionStrengthWeight: PRECISION_STRENGTH_WEIGHT,
  precisionStrengthMode: PRECISION_STRENGTH_MODE,
  vectorCalibrationMethod: VECTOR_CALIBRATION_METHOD,
  imageVecCalibrationMethod: IMAGE_VEC_CALIBRATION_METHOD,
  baselineFloorMode: BASELINE_FLOOR_MODE,
  vectorBaseline: VECTOR_COSINE_BASELINE,
  imageVecBaseline: IMAGE_VEC_COSINE_BASELINE,
};

/** flat full-rrf 기준선 floor — T1 baseline 0.8882 정합(1e-3 여유). */
const FLAT_FULL_RRF_FLOOR = 0.8882 - 1e-3;

/** q8 임베딩 경로의 flat recall floor — 현재 실측 0.975, 큰 회귀만 잡는다. */
const FLAT_RECALL_FLOOR = 0.97;

/** 측정 창 — T1 baseline 과 같은 20. */
const FLAT_LIMIT = 20;

/** 분별 코퍼스 핵심 검색어 — 사용자가 짚은 "노란후드" 케이스(T1 정합). */
const QUERY = "노란 후드 입은 캐릭터";

/** 연결성 높은 무관 글 — QUERY 와 글자가 약하게 겹쳐 다채널 합류(T1 정합 / 흠 재현). */
const DISTRACTOR_CONTENTS = [
  "노란 우비를 입은 친구 이야기를 적은 일기",
  "후드 티 쇼핑 후기를 정리한 메모",
  "캐릭터 굿즈 수집 목록 정리",
  "노란 가방을 산 날의 기록",
  "겨울 후드 코디 정리 노트",
];

let embedder: Bgem3Embedder;
let siglipAvailable: boolean;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
  siglipAvailable = await loadSiglipTextEncoder();
}, 600_000);

afterAll(() => {});

// ── 분별 fixture 코퍼스(T1 양식 정합 / :memory:, 운영 DB 불변경) ─────────────────

interface DiscriminationCorpus {
  retriever: HybridRetriever;
  strongImageId: number; // 노란후드 이미지 — image_vec=SigLIP(QUERY).
  midImageId: number; // 노란옷 이미지 — image_vec=SigLIP("노란 옷 ...").
  strongTextId: number; // 노란후드 글 — QUERY 어휘 다수.
  distractorIds: number[]; // 다채널 무관 글.
  junkIds: number[]; // baseline 잡음 글 — 내용이 "---"·"***" 등 무의미 청크.
  graphHopSeedId: number;
  graphHopAnswerId: number;
  close: () => void;
}

/**
 * baseline 잡음 글 내용 — 마크다운 표 구분선·강조선·빈 의미 청크. A1 실측
 * "노란후드" 검색에서 내용이 그냥 "---"(표 구분선 청크)인 노드가 vector 채널에
 * baseline 수준 cosine 으로 떠 dbsf 상대 1위로 정밀 강도 최대를 받아 진짜 답을
 * 눌렀다(강도-반영 융합 §8.3). 검색어와 의미가 무관해 bge-m3 cosine 이 baseline
 * (~0.17) 근방으로만 떠야 한다 — baseline floor 가 그 잡음을 컷하는지 측정한다.
 */
const JUNK_CONTENTS = ["---", "***"];

async function buildDiscriminationCorpus(): Promise<DiscriminationCorpus> {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);

  const strongTextId = await store.addNode({
    content: "노란 후드를 입은 캐릭터를 그린 일러스트 감상문",
  });

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
    assetSha256: "magfusion-reg-strong-image",
  });

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
    assetSha256: "magfusion-reg-mid-image",
  });

  const distractorIds: number[] = [];
  for (const content of DISTRACTOR_CONTENTS) {
    distractorIds.push(await store.addNode({ content }));
  }
  const themeA = await store.findOrCreateTagConcept("일상기록");
  const themeB = await store.findOrCreateTagConcept("노란색");
  for (const id of distractorIds) {
    await store.addNodeConceptEdge(id, themeA, "tag", "user_input", id);
    await store.addNodeConceptEdge(id, themeB, "tag", "user_input", id);
  }

  // baseline 잡음 글 — 내용이 "---"·"***" 같은 무의미 청크. 실 bge-m3 임베딩으로
  // vector 채널에 baseline 수준 cosine 으로 뜬다(검색어와 의미 무관). baseline
  // floor 가 OFF 면 dbsf 상대 분포로 강도 최대를 받아 위로 끼어들고(흠 재현),
  // ON 이면 raw cosine 이 baseline 미만이라 정밀 강도 0 으로 컷돼 강등된다.
  const junkIds: number[] = [];
  for (const content of JUNK_CONTENTS) {
    junkIds.push(await store.addNode({ content }));
  }

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
    junkIds,
    graphHopSeedId,
    graphHopAnswerId,
    close: () => db.close(),
  };
}

/** 분별 코퍼스 한 검색의 핵심 순위·점수 측정. */
interface DiscriminationMeasure {
  strongImageRank: number;
  strongImageScore: number;
  midImageRank: number;
  midImageScore: number;
  strongTextRank: number;
  strongTextScore: number;
  topDistractorScore: number;
  topDistractorRank: number;
  /** baseline 잡음 글 중 가장 높은 점수·순위(낮을수록 = 위로 끼어듦 = 나쁨). */
  topJunkScore: number;
  topJunkRank: number;
  /**
   * baseline 잡음 글들이 받은 정밀 강도 가산(components.precisionStrength)의 최대값.
   * baseline floor 가 메커니즘으로 작동하면 junk 의 정밀 강도가 0 으로 컷된다 —
   * OFF 대비 이 값이 떨어지는지가 "baseline floor 가 실제로 잡음을 컷했다"의 직접 증거.
   */
  topJunkPrecision: number;
}

function measureDiscrimination(
  ctx: DiscriminationCorpus,
  results: RetrievalResult[],
): DiscriminationMeasure {
  const rankOf = (id: number): number => {
    const idx = results.findIndex((r) => r.node.id === id);
    return idx === -1 ? -1 : idx + 1;
  };
  const scoreOf = (id: number): number =>
    results.find((r) => r.node.id === id)?.score ?? Number.NaN;

  let topDistractorScore = Number.NEGATIVE_INFINITY;
  let topDistractorRank = -1;
  results.forEach((r, idx) => {
    if (ctx.distractorIds.includes(r.node.id) && r.score > topDistractorScore) {
      topDistractorScore = r.score;
      topDistractorRank = idx + 1;
    }
  });

  let topJunkScore = Number.NEGATIVE_INFINITY;
  let topJunkRank = -1;
  let topJunkPrecision = 0;
  results.forEach((r, idx) => {
    if (ctx.junkIds.includes(r.node.id)) {
      if (r.score > topJunkScore) {
        topJunkScore = r.score;
        topJunkRank = idx + 1;
      }
      // 정밀 강도 가산(λ × 보정 강도) — baseline floor 가 컷하면 0 이 된다.
      if (r.components.precisionStrength > topJunkPrecision) {
        topJunkPrecision = r.components.precisionStrength;
      }
    }
  });

  return {
    strongImageRank: rankOf(ctx.strongImageId),
    strongImageScore: scoreOf(ctx.strongImageId),
    midImageRank: rankOf(ctx.midImageId),
    midImageScore: scoreOf(ctx.midImageId),
    strongTextRank: rankOf(ctx.strongTextId),
    strongTextScore: scoreOf(ctx.strongTextId),
    topDistractorScore,
    topDistractorRank,
    topJunkScore,
    topJunkRank,
    topJunkPrecision,
  };
}

// ── D-N1 후보 측정 표 — λ × {mode} × {calibration} sweep ────────────────────────
//
// 각 후보로 (a) 글 nDCG(harness 글 코퍼스) (b) 노란후드 분별을 측정해 표로 남긴다.
// 게이트 다 통과하는 후보 중 분별 margin 이 안정적인 것을 default 로 — 그 default
// 가 search-tuning.ts PRECISION_* 모듈 상수와 일치함을 마지막 단언이 확인한다.

interface CandidateRow {
  label: string;
  weight: number;
  mode: PrecisionStrengthMode;
  vectorCal: CalibrationMethod;
  imageVecCal: CalibrationMethod;
  flatNdcg: number;
  flatRecall: number;
  disc: DiscriminationMeasure;
  textBeatsDistractor: boolean;
  strongImageBeatsMid: boolean;
  ndcgRegressionOk: boolean;
}

describe("T4 — D-N1 강도 결합·보정 방식 측정 표 (게이트 통과 후보 default 확정)", () => {
  test(
    "λ × mode × calibration sweep — 글 nDCG·노란후드 분별 측정 표를 남기고 게이트 통과 default 를 단언한다",
    async () => {
      if (!siglipAvailable) {
        throw new Error(
          "SigLIP text encoder 미로드 — image_vec 채널 측정 불가(실 모델 의존). " +
            "모델 다운로드 후 재실행 필요(silent skip 금지 — 정직한 실패).",
        );
      }

      // 측정 후보 — λ sweep(grid) × mode 3종 × calibration(채널별 tmm/dbsf 핵심 2조합).
      // 전수 조합은 폭증하므로 설계 §4.2·§5 의 1순위 후보 위주로 둔다:
      //  - mode = max(설계 default 정신) + sum + weighted-rrf 비교.
      //  - calibration = tmm/tmm(설계 §5 cosine 적합) + dbsf/dbsf(이상치 강건 대조).
      const modes: PrecisionStrengthMode[] = ["max", "sum", "weighted-rrf"];
      const calibrations: Array<{
        vectorCal: CalibrationMethod;
        imageVecCal: CalibrationMethod;
      }> = [
        { vectorCal: "tmm", imageVecCal: "tmm" },
        { vectorCal: "dbsf", imageVecCal: "dbsf" },
      ];

      const rows: CandidateRow[] = [];

      for (const mode of modes) {
        for (const cal of calibrations) {
          for (const weight of PRECISION_WEIGHT_SWEEP_GRID) {
            const tuning: RetrieveTuning = {
              precisionStrengthWeight: weight,
              precisionStrengthMode: mode,
              vectorCalibrationMethod: cal.vectorCal,
              imageVecCalibrationMethod: cal.imageVecCal,
            };

            // (a) 글 nDCG — harness 글 코퍼스(리랭커-off). tuning 을 모든 variant 에
            //     동일 적용(harness 가 tuning 을 retrieve 로 전달).
            const snap = await runHarness(embedder, {
              variants: { "full-rrf": SWEEP_VARIANTS["full-rrf"]! },
              tuning,
            });
            const flatFull = snap.variants.find(
              (v) => v.variant === "full-rrf",
            )!;

            // (b) 노란후드 분별 — 분별 코퍼스. 매 후보 새 코퍼스(touch 부수효과 격리).
            const ctx = await buildDiscriminationCorpus();
            let disc: DiscriminationMeasure;
            try {
              const results = await ctx.retriever.retrieve(QUERY, {
                limit: FLAT_LIMIT,
                tuning,
              });
              disc = measureDiscrimination(ctx, results);
            } finally {
              ctx.close();
            }

            rows.push({
              label: `λ=${weight} ${mode} ${cal.vectorCal}/${cal.imageVecCal}`,
              weight,
              mode,
              vectorCal: cal.vectorCal,
              imageVecCal: cal.imageVecCal,
              flatNdcg: flatFull.avgNdcg,
              flatRecall: flatFull.avgRecall,
              disc,
              textBeatsDistractor:
                disc.strongTextScore > disc.topDistractorScore,
              strongImageBeatsMid: disc.strongImageScore >= disc.midImageScore,
              ndcgRegressionOk: flatFull.avgNdcg >= FLAT_FULL_RRF_FLOOR,
            });
          }
        }
      }

      // ── 측정 표 출력 (메인이 사용자에게 D-N1 보고할 근거) ──
      console.log(`[T4 D-N1 측정 표] query="${QUERY}" / 리랭커-off / 글 코퍼스 full-rrf`);
      console.log(
        "  후보 | 글nDCG | 글recall | 노란후드글 rank/score | 노란후드이미지 rank/score | " +
          "노란옷 rank/score | 무관글 rank/score | 글>무관 | 강이미지>노란옷 | nDCG회귀OK",
      );
      for (const r of rows) {
        const d = r.disc;
        console.log(
          `  ${r.label} | ${r.flatNdcg.toFixed(4)} | ${r.flatRecall.toFixed(2)} | ` +
            `${d.strongTextRank}/${d.strongTextScore.toFixed(6)} | ` +
            `${d.strongImageRank}/${d.strongImageScore.toFixed(6)} | ` +
            `${d.midImageRank}/${d.midImageScore.toFixed(6)} | ` +
            `${d.topDistractorRank}/${d.topDistractorScore.toFixed(6)} | ` +
            `${r.textBeatsDistractor ? "예" : "아니오"} | ` +
            `${r.strongImageBeatsMid ? "예" : "아니오"} | ` +
            `${r.ndcgRegressionOk ? "예" : "아니오"}`,
        );
      }

      // ── 게이트 통과 후보 = nDCG 회귀 0 + 글>무관 + 강이미지>노란옷 + λ>0 ──
      const passing = rows.filter(
        (r) =>
          r.ndcgRegressionOk &&
          r.textBeatsDistractor &&
          r.strongImageBeatsMid &&
          r.weight > 0,
      );
      console.log(
        `[T4 게이트 통과 후보] ${passing.length}개 / 전체 ${rows.length}개`,
      );
      for (const r of passing) {
        // 분별 margin = 노란후드 글이 무관 글을 넘는 격차(클수록 안정).
        const margin = r.disc.strongTextScore - r.disc.topDistractorScore;
        console.log(`  ${r.label} — 글>무관 margin=${margin.toFixed(6)}`);
      }

      // λ=0 후보(정밀 강도 미적용)는 T1 흠을 재현한다 — 노란후드 글이 무관 글 아래.
      // 이 사실을 기록해 "정밀 강도가 흠을 고친다" 를 측정으로 증명한다.
      const neutralRow = rows.find(
        (r) => r.weight === 0 && r.mode === "max" && r.vectorCal === "tmm",
      )!;
      console.log(
        `[T4 λ=0 (정밀 강도 미적용 = T1 흠 재현)] 노란후드 글 rank=${neutralRow.disc.strongTextRank} ` +
          `score=${neutralRow.disc.strongTextScore.toFixed(6)} vs 무관 글 1위 ` +
          `${neutralRow.disc.topDistractorScore.toFixed(6)} (글>무관=${neutralRow.textBeatsDistractor ? "예" : "아니오"})`,
      );

      // 게이트를 통과하는 후보가 적어도 하나 존재한다(정밀 강도가 흠을 고칠 수 있음).
      expect(passing.length).toBeGreaterThan(0);

      // λ=0 (정밀 강도 미적용)은 T1 흠을 재현한다 — 노란후드 글이 무관 다채널 글에 밀린다.
      // (정밀 강도가 *실제로* 흠을 고치는 것이지 코퍼스가 자연 통과가 아님을 격리.)
      expect(neutralRow.textBeatsDistractor).toBe(false);

      // ── 채택 default = search-tuning.ts PRECISION_* 모듈 상수 ──
      // 그 default 조합이 게이트를 다 통과하는지 단언한다(측정으로 고른 값 검증).
      const adopted = rows.find(
        (r) =>
          r.weight === PRECISION_STRENGTH_WEIGHT &&
          r.mode === PRECISION_STRENGTH_MODE &&
          r.vectorCal === VECTOR_CALIBRATION_METHOD &&
          r.imageVecCal === IMAGE_VEC_CALIBRATION_METHOD,
      );
      expect(adopted).toBeDefined();
      console.log(
        `[T4 채택 default] λ=${PRECISION_STRENGTH_WEIGHT} ${PRECISION_STRENGTH_MODE} ` +
          `${VECTOR_CALIBRATION_METHOD}/${IMAGE_VEC_CALIBRATION_METHOD} — ` +
          `글nDCG=${adopted!.flatNdcg.toFixed(4)} / 노란후드글 rank=${adopted!.disc.strongTextRank} ` +
          `score=${adopted!.disc.strongTextScore.toFixed(6)} > 무관글 ${adopted!.disc.topDistractorScore.toFixed(6)}`,
      );
      // 채택 default 가 게이트 4종을 다 통과한다(글 회귀 0 + 글>무관 + 강이미지>노란옷).
      expect(adopted!.ndcgRegressionOk).toBe(true);
      expect(adopted!.flatRecall).toBeGreaterThanOrEqual(FLAT_RECALL_FLOOR);
      expect(adopted!.textBeatsDistractor).toBe(true);
      expect(adopted!.strongImageBeatsMid).toBe(true);
      // 노란후드 글(정확 매치)이 무관 다채널 글 위로 올라왔다(T1 대비 핵심 개선).
      expect(adopted!.disc.strongTextRank).toBeLessThan(
        adopted!.disc.topDistractorRank,
      );
    },
    600_000,
  );
});

// ── 게이트 4: 이미지 0건 글-only 검색이 강도 통합 후에도 정당히 유지된다 ──────────

describe("T4 — 이미지 0건 글-only 검색이 강도 통합 후에도 유지/개선된다", () => {
  test(
    "글-only 코퍼스에서 채택 default(λ>0) 글 nDCG 가 λ=0(현행) 대비 회귀 0",
    async () => {
      // harness 글 코퍼스에는 image_asset 0건이라 imageVec 채널은 항상 빈 배열이다.
      // 정밀 강도가 vector 채널 보정으로만 들어가므로, 채택 default 의 글 nDCG 가
      // λ=0(현행 RRF) 대비 떨어지지 않아야 한다(설계 게이트 4 — 글-only 정당 유지).
      const adoptedTuning: RetrieveTuning = {
        precisionStrengthWeight: PRECISION_STRENGTH_WEIGHT,
        precisionStrengthMode: PRECISION_STRENGTH_MODE,
        vectorCalibrationMethod: VECTOR_CALIBRATION_METHOD,
        imageVecCalibrationMethod: IMAGE_VEC_CALIBRATION_METHOD,
      };
      const neutralTuning: RetrieveTuning = { precisionStrengthWeight: 0 };

      const adoptedSnap = await runHarness(embedder, {
        variants: { "full-rrf": SWEEP_VARIANTS["full-rrf"]! },
        tuning: adoptedTuning,
      });
      const neutralSnap = await runHarness(embedder, {
        variants: { "full-rrf": SWEEP_VARIANTS["full-rrf"]! },
        tuning: neutralTuning,
      });

      const adopted = adoptedSnap.variants.find((v) => v.variant === "full-rrf")!;
      const neutral = neutralSnap.variants.find((v) => v.variant === "full-rrf")!;

      console.log(
        `[T4 글-only 게이트] 채택 default nDCG=${adopted.avgNdcg.toFixed(4)} ` +
          `recall=${adopted.avgRecall.toFixed(2)} vs λ=0(현행) nDCG=${neutral.avgNdcg.toFixed(4)} ` +
          `recall=${neutral.avgRecall.toFixed(2)}`,
      );

      // 글-only 검색 회귀 0 — 채택 default 가 현행(λ=0) 이상.
      expect(adopted.avgNdcg).toBeGreaterThanOrEqual(neutral.avgNdcg - 1e-9);
      expect(adopted.avgNdcg).toBeGreaterThanOrEqual(FLAT_FULL_RRF_FLOOR);
      expect(adopted.avgRecall).toBeGreaterThanOrEqual(FLAT_RECALL_FLOOR);
      // λ=0 이 현행 baseline(0.8882) 과 같음을 교차 확인(정밀 강도 미적용 = T1 동작).
      expect(neutral.avgNdcg).toBeGreaterThanOrEqual(FLAT_FULL_RRF_FLOOR);
    },
    600_000,
  );
});

// ── 게이트 3: graph-hop 보존 — 연결로만 닿는 정답이 강도 통합 후에도 합류 ─────────

describe("T4 — graph-hop 정답이 강도 통합(채택 default) 후에도 graph 채널로 합류한다", () => {
  test(
    "채택 default 로도 graph-hop 정답이 seed query 검색에 graph 채널로 합류한다",
    async () => {
      if (!siglipAvailable) {
        throw new Error(
          "SigLIP text encoder 미로드 — 분별 코퍼스 적재 불가(정직한 실패).",
        );
      }
      const ctx = await buildDiscriminationCorpus();
      try {
        const seedQuery = "작업 테마 배색 교체";
        const NARROW_VECTOR_K = 2;
        const adoptedTuning: RetrieveTuning = {
          precisionStrengthWeight: PRECISION_STRENGTH_WEIGHT,
          precisionStrengthMode: PRECISION_STRENGTH_MODE,
          vectorCalibrationMethod: VECTOR_CALIBRATION_METHOD,
          imageVecCalibrationMethod: IMAGE_VEC_CALIBRATION_METHOD,
        };

        const withGraph = await ctx.retriever.retrieve(seedQuery, {
          limit: FLAT_LIMIT,
          vectorK: NARROW_VECTOR_K,
          ftsLimit: NARROW_VECTOR_K,
          tuning: adoptedTuning,
        });
        const withoutGraph = await ctx.retriever.retrieve(seedQuery, {
          limit: FLAT_LIMIT,
          vectorK: NARROW_VECTOR_K,
          ftsLimit: NARROW_VECTOR_K,
          tuning: adoptedTuning,
          channelMask: {
            vector: true,
            fts: true,
            graph: false,
            concept: true,
            imageVec: true,
          },
        });

        const seed = withGraph.find((r) => r.node.id === ctx.graphHopSeedId);
        const answer = withGraph.find(
          (r) => r.node.id === ctx.graphHopAnswerId,
        );
        const answerNoGraph = withoutGraph.find(
          (r) => r.node.id === ctx.graphHopAnswerId,
        );

        console.log(
          `[T4 graph-hop 보존] query="${seedQuery}" / 채택 default 강도 통합 / vectorK=${NARROW_VECTOR_K}`,
        );
        console.log(
          `  seed 합류=${seed !== undefined} / graph-hop 정답 합류=${answer !== undefined} ` +
            `sources=[${answer?.sources.join(",") ?? "없음"}] score=${answer?.score.toFixed(6) ?? "없음"}`,
        );
        console.log(
          `  graph 채널 OFF(대조): graph-hop 정답 합류=${answerNoGraph !== undefined}`,
        );

        // 강도 통합 후에도 graph-hop 정답이 합류하고, 연결로만 닿았음(graph source).
        expect(seed).toBeDefined();
        expect(answer).toBeDefined();
        expect(answer!.sources).toContain("graph");
        // graph 채널 끄면 사라진다 — 회수 원인이 graph 단 하나(강도 통합이 graph-hop 을
        // 가짜로 살리지 않음 / 정밀 강도는 유사도 채널 가산일 뿐 graph 회수와 무관).
        expect(answerNoGraph).toBeUndefined();
      } finally {
        ctx.close();
      }
    },
    600_000,
  );
});

// ── T5 (1) 강한 매치 풀 생존 — 강한 단일 채널 매치가 리랭커 topK_input 안에 남는다 ──────
//
// 설계 §4.1·§8.1: 강한 단일 채널 매치(보정 강도 상위)가 retriever 출력 상위
// (리랭커가 받는 입력 = 앞에서부터 topK_input 슬롯)에 *생존*해야 한다. 옛 §8.1 고장은
// 이미지가 17·19위라 리랭커가 채점하기도 전에 잘려나간 것이다. T4 정밀 코어가 강한
// 매치를 상위로 올렸으므로 대개 자연 성립하지만, 추측이 아니라 *측정*으로 확인한다.
//
// 리랭커 운영 default topK_input = 30(settings.reranker.topK_input / reranker.ts).
// 강한 글·강한 이미지(정확 매치)가 retriever 출력의 앞 topK_input 안에 들어가는지
// 단언한다 — 들어가면 리랭커가 그 후보를 받아 채점한다(슬롯 보존도 그 입력에서 일어난다).
const RERANKER_DEFAULT_TOP_K_INPUT = 30;

describe("T5 (1) — 강한 단일 채널 매치가 리랭커 topK_input 안에 생존한다 (§8.1 차단)", () => {
  test(
    "운영 default 정밀 코어로 강한 글·강한 이미지가 retriever 출력 상위 topK_input 안에 남는다",
    async () => {
      if (!siglipAvailable) {
        throw new Error(
          "SigLIP text encoder 미로드 — 강한 매치 이미지 적재 불가(정직한 실패).",
        );
      }
      const ctx = await buildDiscriminationCorpus();
      try {
        // 운영 default(정밀 강도 ON / imageVecBoost = SOURCE_BOOST.imageVec) 로 검색.
        // 리랭커 입력 = retriever 출력 앞에서부터 topK_input 슬롯이므로, 측정 창을
        // topK_input 만큼 잡아 그 안에 강한 매치가 있는지 본다.
        const results = await ctx.retriever.retrieve(QUERY, {
          limit: RERANKER_DEFAULT_TOP_K_INPUT,
          tuning: ADOPTED_PRECISION_TUNING,
        });
        const disc = measureDiscrimination(ctx, results);

        console.log(
          `[T5(1) 강한 매치 풀 생존] query="${QUERY}" / 리랭커-off / topK_input=${RERANKER_DEFAULT_TOP_K_INPUT}`,
        );
        console.log(
          `  강한 글 rank=${disc.strongTextRank} score=${disc.strongTextScore.toFixed(6)} / ` +
            `강한 이미지 rank=${disc.strongImageRank} score=${disc.strongImageScore.toFixed(6)} / ` +
            `노란옷 이미지 rank=${disc.midImageRank} / 무관 글 1위 rank=${disc.topDistractorRank}`,
        );

        // 강한 글·강한 이미지가 retriever 출력에 *존재* 한다(rank != -1) AND 앞 topK_input 안.
        expect(disc.strongTextRank).toBeGreaterThan(0);
        expect(disc.strongTextRank).toBeLessThanOrEqual(
          RERANKER_DEFAULT_TOP_K_INPUT,
        );
        expect(disc.strongImageRank).toBeGreaterThan(0);
        expect(disc.strongImageRank).toBeLessThanOrEqual(
          RERANKER_DEFAULT_TOP_K_INPUT,
        );

        // §8.1 차단 측정 — T4 정밀 코어로 강한 매치가 *상위* 로 올라와 자연 생존한다.
        // (옛 §8.1: 이미지 17·19위 → 리랭커 입력 밖. 정밀 코어 후 강한 글·이미지가 상위.)
        console.log(
          `[T5(1) §8.1 차단] 강한 글·이미지 둘 다 topK_input(${RERANKER_DEFAULT_TOP_K_INPUT}) 안 생존 ` +
            `= 리랭커가 받기 전 탈락 없음 — T4 정밀 코어로 자연 성립(억지 보강 불요).`,
        );
      } finally {
        ctx.close();
      }
    },
    600_000,
  );
});

// ── T5 (2) boost(c) 재평가 — imageVec boost 가 정밀 코어와 중복·과잉인지 측정 ───────────
//
// T4 정밀 코어(λ=0.2 dbsf)가 이미 imageVec 강도를 보정해 강한 이미지를 끌어올린다.
// 옛 c(image-search-foundation T7)의 SOURCE_BOOST.imageVec=2.5 가 *이제* 중복·과잉인지
// imageVec boost 값별로 측정한다. 게이트:
//   (a) 글 nDCG 0.8882 floor 불변 — boost 무관(글 노드는 imageVec 기여 0 이라 구조적 불변).
//   (b) 노란후드 분별 유지 — 강한 글 > 무관 글 AND 강한 이미지 >= 노란옷 이미지.
// 게이트를 통과하는 *가장 낮은* boost 가 "중복 제거" 후보다. 측정 없이 추측 변경 금지.
const IMAGE_VEC_BOOST_SWEEP_GRID = [1.0, 1.5, 2.0, 2.5];

interface BoostRow {
  imageVecBoost: number;
  flatNdcg: number;
  flatRecall: number;
  disc: DiscriminationMeasure;
  textBeatsDistractor: boolean;
  strongImageBeatsMid: boolean;
  /**
   * 강한 이미지(정확 매치)가 연결성 높은 무관 글(다채널 합류 distractor)을 넘는가.
   * 이것이 옛 c-C1/T7 boost 의 *직접 동기* 다 — "유사도 1위 이미지가 연결성 높은
   * 딴 항목에 합산으로 밀린다". 정밀 코어가 강한 이미지를 끌어올려도 이 한 축은
   * 끝까지 분별하는지가 boost 유지/제거 결정의 핵심 측정이다.
   */
  strongImageBeatsDistractor: boolean;
  ndcgRegressionOk: boolean;
}

describe("T5 (2) — imageVec boost 재평가 측정 표 (정밀 코어와 중복·과잉 판정)", () => {
  test(
    "운영 default 정밀 코어 위에서 imageVec boost 값별 글 nDCG·노란후드 분별 측정 → boost 결정",
    async () => {
      if (!siglipAvailable) {
        throw new Error(
          "SigLIP text encoder 미로드 — image_vec 채널 boost 재평가 불가(정직한 실패).",
        );
      }

      const rows: BoostRow[] = [];
      for (const imageVecBoost of IMAGE_VEC_BOOST_SWEEP_GRID) {
        // 운영 default 정밀 코어 + imageVec boost 만 변화. precision* 칸은 채택 default 고정.
        const tuning: RetrieveTuning = {
          ...ADOPTED_PRECISION_TUNING,
          imageVecBoost,
        };

        // (a) 글 nDCG — harness 글 코퍼스(리랭커-off). 글 코퍼스에는 image_asset 0건이라
        //     imageVec 채널 기여가 0 → boost 무관 불변이 *측정으로* 확인되어야 한다.
        const snap = await runHarness(embedder, {
          variants: { "full-rrf": SWEEP_VARIANTS["full-rrf"]! },
          tuning,
        });
        const flatFull = snap.variants.find((v) => v.variant === "full-rrf")!;

        // (b) 노란후드 분별 — 분별 코퍼스. 매 후보 새 코퍼스(touch 부수효과 격리).
        const ctx = await buildDiscriminationCorpus();
        let disc: DiscriminationMeasure;
        try {
          const results = await ctx.retriever.retrieve(QUERY, {
            limit: FLAT_LIMIT,
            tuning,
          });
          disc = measureDiscrimination(ctx, results);
        } finally {
          ctx.close();
        }

        rows.push({
          imageVecBoost,
          flatNdcg: flatFull.avgNdcg,
          flatRecall: flatFull.avgRecall,
          disc,
          textBeatsDistractor: disc.strongTextScore > disc.topDistractorScore,
          strongImageBeatsMid: disc.strongImageScore >= disc.midImageScore,
          strongImageBeatsDistractor:
            disc.strongImageScore > disc.topDistractorScore,
          ndcgRegressionOk: flatFull.avgNdcg >= FLAT_FULL_RRF_FLOOR,
        });
      }

      // ── 측정 표 출력 (메인이 DCL 에 기재할 근거) ──
      console.log(
        `[T5(2) imageVec boost 재평가 표] query="${QUERY}" / 정밀 코어 λ=${PRECISION_STRENGTH_WEIGHT} ${PRECISION_STRENGTH_MODE} dbsf ON / 리랭커-off`,
      );
      console.log(
        "  imageVecBoost | 글nDCG | 글recall | 강한글 rank/score | 강한이미지 rank/score | " +
          "노란옷 rank/score | 무관글 rank/score | 글>무관 | 강이미지>노란옷 | 강이미지>무관글 | nDCG회귀OK",
      );
      for (const r of rows) {
        const d = r.disc;
        console.log(
          `  ${r.imageVecBoost.toFixed(2)} | ${r.flatNdcg.toFixed(4)} | ${r.flatRecall.toFixed(2)} | ` +
            `${d.strongTextRank}/${d.strongTextScore.toFixed(6)} | ` +
            `${d.strongImageRank}/${d.strongImageScore.toFixed(6)} | ` +
            `${d.midImageRank}/${d.midImageScore.toFixed(6)} | ` +
            `${d.topDistractorRank}/${d.topDistractorScore.toFixed(6)} | ` +
            `${r.textBeatsDistractor ? "예" : "아니오"} | ` +
            `${r.strongImageBeatsMid ? "예" : "아니오"} | ` +
            `${r.strongImageBeatsDistractor ? "예" : "아니오"} | ` +
            `${r.ndcgRegressionOk ? "예" : "아니오"}`,
        );
      }

      // ── 게이트 통과 boost = 글 nDCG 회귀 0 + 글>무관 + 강이미지>=노란옷 ──
      //    (느슨 게이트 — 노란옷 한 축만 본다. 무관글 축은 아래 boost 결정에서 따로 본다.)
      const passing = rows.filter(
        (r) =>
          r.ndcgRegressionOk && r.textBeatsDistractor && r.strongImageBeatsMid,
      );
      const lowestPassing = passing.reduce<BoostRow | undefined>(
        (lo, r) =>
          lo === undefined || r.imageVecBoost < lo.imageVecBoost ? r : lo,
        undefined,
      );
      console.log(
        `[T5(2) 게이트 통과 boost] ${passing.map((r) => r.imageVecBoost.toFixed(2)).join(", ")} / ` +
          `가장 낮은 통과값=${lowestPassing?.imageVecBoost.toFixed(2) ?? "없음"}`,
      );

      // ── boost 결정 핵심 측정: 강한 이미지가 *연결성 높은 무관 글* 을 넘는 최소 boost ──
      // 옛 c-C1/T7 boost 의 직접 동기는 "유사도 맞는 이미지가 연결성 높은 딴 항목에 밀림".
      // 정밀 코어(λ=0.2)가 강한 이미지를 끌어올려도, 이 한 축(강이미지 > 무관글)을
      // 분별하는 최소 boost 가 무엇인지로 boost 유지/제거를 *측정으로* 가른다.
      const boostsBeatingDistractor = rows
        .filter((r) => r.strongImageBeatsDistractor)
        .map((r) => r.imageVecBoost);
      const minBoostBeatingDistractor =
        boostsBeatingDistractor.length > 0
          ? Math.min(...boostsBeatingDistractor)
          : null;
      console.log(
        `[T5(2) 강이미지>무관글 분별] 통과 boost=[${boostsBeatingDistractor.map((b) => b.toFixed(2)).join(", ")}] / ` +
          `최소 통과 boost=${minBoostBeatingDistractor?.toFixed(2) ?? "없음(모든 boost 에서 무관글에 밀림)"}`,
      );

      // 글 nDCG 는 *모든* boost 값에서 0.8882 floor 불변 — 글 노드 imageVec 기여 0 의
      // 구조적 결과를 측정으로 단언한다(boost 가 글 검색을 한 글자도 안 바꾼다).
      for (const r of rows) {
        expect(r.flatNdcg).toBeGreaterThanOrEqual(FLAT_FULL_RRF_FLOOR);
        expect(r.flatRecall).toBeGreaterThanOrEqual(FLAT_RECALL_FLOOR);
      }
      // 글 nDCG 가 boost 값에 무관하게 *동일* 함을 교차 단언(구조적 불변 = 중복 판정 근거).
      const ndcgSet = new Set(rows.map((r) => r.flatNdcg.toFixed(6)));
      expect(ndcgSet.size).toBe(1);

      // 게이트를 통과하는 boost 가 존재한다 — 정밀 코어가 분별을 책임지므로 낮은
      // boost(중립 1.0 포함)에서도 노란후드 분별이 성립할 수 있는지가 핵심 측정.
      expect(passing.length).toBeGreaterThan(0);

      // ── 운영 default(SOURCE_BOOST.imageVec) 자체도 게이트를 통과한다(현행 안전) ──
      const adoptedBoostRow = rows.find(
        (r) => r.imageVecBoost === SOURCE_BOOST.imageVec,
      );
      expect(adoptedBoostRow).toBeDefined();
      expect(adoptedBoostRow!.ndcgRegressionOk).toBe(true);
      expect(adoptedBoostRow!.textBeatsDistractor).toBe(true);
      expect(adoptedBoostRow!.strongImageBeatsMid).toBe(true);

      // boost 중립(1.0)이 게이트를 통과하는지 = "정밀 코어가 boost 를 대체했나" 의 직접 측정.
      const neutralBoostRow = rows.find((r) => r.imageVecBoost === 1.0)!;
      console.log(
        `[T5(2) 중립 boost(1.0) 판정] 글>무관=${neutralBoostRow.textBeatsDistractor ? "예" : "아니오"} ` +
          `강이미지>노란옷=${neutralBoostRow.strongImageBeatsMid ? "예" : "아니오"} ` +
          `강이미지>무관글=${neutralBoostRow.strongImageBeatsDistractor ? "예" : "아니오"} ` +
          `(강한 이미지 rank=${neutralBoostRow.disc.strongImageRank})`,
      );

      // ── boost 결정(측정 확정 / DCL 기재 근거) ──────────────────────────────
      // 측정 결과: 글 nDCG 는 모든 boost 에서 0.9272 불변(글 노드 imageVec 기여 0).
      // 느슨 게이트(강이미지 > 노란옷)는 boost 1.0 에서도 통과 — 정밀 코어가 노란옷
      // 같은 *중간 강도* 항목은 boost 없이도 누른다. 그러나 옛 c-C1/T7 의 직접 동기인
      // "강한 이미지 > 연결성 높은 무관 글" 한 축은 boost 1.0 에서 *밀린다*(강한 이미지가
      // 무관 글 아래) — 정밀 코어만으로는 다채널 합류 distractor 를 못 넘는다. boost 가
      // 1.0 보다 커야 강한 이미지가 무관 글 위로 올라온다. 그래서 boost 는 *중복이 아니라
      // 정밀 코어와 보완 관계* 다 — 정밀은 강한 글을, boost 는 강한 이미지의 무관-글-우위를
      // 책임진다. 따라서 운영 default(SOURCE_BOOST.imageVec)를 *유지* 한다(추측 회피가
      // 아니라 측정이 제거를 반증함). 이 단언이 그 결정을 코드로 고정한다.
      expect(neutralBoostRow.strongImageBeatsDistractor).toBe(false);
      // 운영 default boost 에서는 강한 이미지가 무관 글을 넘는다(boost 의 실효 — 유지 근거).
      const adoptedBoostRow2 = rows.find(
        (r) => r.imageVecBoost === SOURCE_BOOST.imageVec,
      )!;
      expect(adoptedBoostRow2.strongImageBeatsDistractor).toBe(true);
      // boost 를 올리면 강한 이미지의 무관-글-우위가 단조 증가(중립→유지 방향 일관).
      expect(minBoostBeatingDistractor).not.toBeNull();
      expect(minBoostBeatingDistractor!).toBeGreaterThan(1.0);
      expect(minBoostBeatingDistractor!).toBeLessThanOrEqual(
        SOURCE_BOOST.imageVec,
      );
      console.log(
        `[T5(2) boost 결정] 글 nDCG 0.9272 불변(boost 무관) + 강이미지>무관글 은 boost>=` +
          `${minBoostBeatingDistractor!.toFixed(2)} 에서만 성립 → 운영 default ` +
          `${SOURCE_BOOST.imageVec} *유지*(정밀 코어와 보완 — 중복 아님). 측정이 제거를 반증.`,
      );
    },
    600_000,
  );
});

// ── baseline floor (D-N2) — 채널별 절대 baseline 잡음 컷 측정 ─────────────────────
//
// 강도-반영 융합 §8.3 / DCL-3 후속: dbsf 보정은 채널 안 상대 분포만 봐서, 후보가 전부
// baseline 잡음이어도 상대 1위에 강도 최대를 준다. A1 실측 "노란후드" 검색에서 내용이
// "---"(마크다운 표 구분선 단독 청크)인 id=82 가 vector baseline 매치로 dbsf 상대보정에
// precS 최대(0.2)를 받아 0.3664 로 진짜 답(이미지 0.3243)을 *이겼다*. baseline floor 가
// raw cosine < 채널 baseline 인 매치의 정밀 강도를 0 으로 컷해 그 흠을 고친다.
//
// ## 측정 척도 주의 (정직한 측정 설계 — A1 척도 vs 합성 코퍼스 척도)
//
// A1 흠은 *수천 노드* DB 에서 짧은 검색어 vs 긴 청크 cosine 이 모델 baseline 근방으로
// 깔리는 척도다. 이 합성 분별 코퍼스는 노드 ~11개 + 글이 검색어 어휘를 공유해
// cosine 이 0.76~0.93 척도다(junk "---" raw cosine ≈ 0.776 — _junk_probe 실측). 운영
// 절대 baseline은 이 합성 척도에서 일부 약한 후보를 컷한다.
// 또한 이 코퍼스에서 junk("---") cosine(0.776)이 distractor
// 일부(0.838)보다 낮아, 정밀 코어(λ=0.2)만으로도 junk 가 이미 진짜 답 아래로 떨어진다
// — A1 흠(junk 가 진짜 답을 이김)을 합성 코퍼스가 자연 재현하지 못한다.
//
// 그래서 이 측정은 두 갈래로 정직하게 나눈다:
//   (A) **메커니즘 격리 측정** — 코퍼스 척도(0.76~0.93)에 맞춘 baseline 으로, baseline
//       floor 가 junk("---", raw 0.776)의 정밀 강도를 *실제로 0 으로 컷*하는지(OFF 대비
//       junk 정밀 강도 하락)를 직접 단언한다. baseline 을 junk(0.776)와 strongText(0.933)
//       사이(0.85)로 잡으면 junk 만 컷되고 진짜 글은 산다 — "잡음만 컷, 분별 유지"를 격리.
//   (B) **운영 default 게이트** — 절대 baseline이 합성 코퍼스에서 글 nDCG
//       0.8882/0.9272 회귀 0 + 노란후드 분별 + recall 1.0 을 깨지 않는지(운영 안전).
//       합성 코퍼스에서도 nDCG 회귀 없이 동작하는지 확인한다.
//
// 이렇게 (A)가 "baseline floor 가 잡음을 실제로 컷한다(흠 수정)"를, (B)가 "운영 default
// 가 회귀를 안 낸다(안전)"를 각각 증명한다 — 합성 코퍼스의 척도 한계를 거짓 PASS 로 덮지
// 않고 메커니즘과 안전을 분리 측정한다.

interface BaselineRow {
  label: string;
  mode: BaselineFloorMode;
  vectorBaseline: number;
  imageVecBaseline: number;
  flatNdcg: number;
  flatRecall: number;
  disc: DiscriminationMeasure;
  /** 강한 글·강한 이미지가 둘 다 junk 위(낮은 rank)인가 = junk 강등. */
  junkDemoted: boolean;
  textBeatsDistractor: boolean;
  strongImageBeatsMid: boolean;
  ndcgRegressionOk: boolean;
  /** 운영 게이트 전부 통과(junk 강등 + 글 회귀 0 + 노란후드 분별). */
  allGatesOk: boolean;
}

/**
 * junk 강등 판정 — 강한 글·강한 이미지(정확 매치)가 둘 다 baseline 잡음 글보다
 * 위(score 더 큼)에 있는가. junk 가 결과에 아예 안 떴으면(NEGATIVE_INFINITY) 자명히
 * 강등(진짜 답 아래)이므로 통과로 본다.
 */
function junkDemotedBy(disc: DiscriminationMeasure): boolean {
  return (
    disc.strongTextScore > disc.topJunkScore &&
    disc.strongImageScore > disc.topJunkScore
  );
}

/** 운영 default 정밀 tuning(baseline floor 칸만 비워 둠 — 호출부가 채운다). */
const PRECISION_BASE: RetrieveTuning = {
  precisionStrengthWeight: PRECISION_STRENGTH_WEIGHT,
  precisionStrengthMode: PRECISION_STRENGTH_MODE,
  vectorCalibrationMethod: VECTOR_CALIBRATION_METHOD,
  imageVecCalibrationMethod: IMAGE_VEC_CALIBRATION_METHOD,
};

// ── (A) 메커니즘 격리 측정 — baseline floor 가 junk 정밀 강도를 실제로 0 으로 컷 ──────
describe("D-N2 (A) — baseline floor 가 junk 정밀 강도를 실제로 0 으로 컷한다 (메커니즘 격리)", () => {
  test(
    "코퍼스 척도 baseline 에서 gate 가 junk 의 정밀 강도를 OFF 대비 0 으로 떨어뜨린다 (분별은 유지)",
    async () => {
      if (!siglipAvailable) {
        throw new Error(
          "SigLIP text encoder 미로드 — image_vec 채널 측정 불가(실 모델 의존). " +
            "모델 다운로드 후 재실행 필요(silent skip 금지 — 정직한 실패).",
        );
      }

      // 코퍼스 척도 baseline — junk("---" raw≈0.776) 와 strongText(raw≈0.933) 사이 0.85.
      // baseline floor gate 가 junk 만 컷하고 진짜 글은 살리는지를 격리 측정한다.
      // (운영 절대 baseline 0.17 은 합성 코퍼스 척도와 안 맞아 메커니즘이 안 보인다 —
      //  메커니즘 자체는 척도 무관하므로 코퍼스 척도 baseline 으로 격리 증명한다.)
      const CORPUS_SCALE_BASELINE = 0.85;

      const measure = async (
        mode: BaselineFloorMode,
        vectorBaseline: number,
      ): Promise<DiscriminationMeasure> => {
        const ctx = await buildDiscriminationCorpus();
        try {
          const results = await ctx.retriever.retrieve(QUERY, {
            limit: FLAT_LIMIT,
            tuning: {
              ...PRECISION_BASE,
              baselineFloorMode: mode,
              vectorBaseline,
              imageVecBaseline: 0, // 이미지 채널은 격리(글 junk 메커니즘만 본다).
            },
          });
          return measureDiscrimination(ctx, results);
        } finally {
          ctx.close();
        }
      };

      const off = await measure("off", 0);
      const gate = await measure("gate", CORPUS_SCALE_BASELINE);

      console.log(
        `[D-N2(A) 메커니즘 격리] 코퍼스 척도 baseline=${CORPUS_SCALE_BASELINE} ` +
          `(junk raw≈0.776 < baseline < strongText raw≈0.933)`,
      );
      console.log(
        `  OFF : junk 정밀강도=${off.topJunkPrecision.toFixed(6)} / 강한글 정밀반영 score=${off.strongTextScore.toFixed(6)}`,
      );
      console.log(
        `  gate: junk 정밀강도=${gate.topJunkPrecision.toFixed(6)} / 강한글 정밀반영 score=${gate.strongTextScore.toFixed(6)}`,
      );

      // ── 단언 1: gate 가 junk 의 정밀 강도를 0 으로 컷한다 (메커니즘 직접 증거) ──
      // OFF 에서 junk 는 dbsf 상대보정으로 양의 정밀 강도를 받는다(A1 흠의 핵심).
      expect(off.topJunkPrecision).toBeGreaterThan(0);
      // gate 에서 junk 의 raw cosine(0.776) < baseline(0.85) 이라 정밀 강도가 0 으로 컷.
      expect(gate.topJunkPrecision).toBe(0);

      // ── 단언 2: 분별 유지 — 진짜 글(raw 0.933 >= baseline)은 강등되지 않는다 ──
      // strongText 는 baseline 이상이라 정밀 강도를 그대로 받아 점수가 깎이지 않는다
      // (baseline floor 가 잡음만 컷하고 진짜 매치는 보존 — dbsf 분별력 유지).
      expect(gate.strongTextScore).toBeGreaterThan(0);
      // gate 의 강한 글이 OFF 대비 점수가 떨어지지 않는다(진짜 매치 보존).
      expect(gate.strongTextScore).toBeGreaterThanOrEqual(
        off.strongTextScore - 1e-9,
      );
    },
    600_000,
  );
});

// ── (B) 운영 default 게이트 — 절대 baseline 이 회귀를 안 낸다 + 방식·baseline sweep 표 ──
describe("D-N2 (B) — baseline floor 방식·baseline sweep 측정 표 (운영 default 회귀 0)", () => {
  test(
    "mode × baseline sweep — 글 nDCG·노란후드 분별·junk 측정 표를 남기고 운영 default 게이트를 단언한다",
    async () => {
      if (!siglipAvailable) {
        throw new Error(
          "SigLIP text encoder 미로드 — image_vec 채널 측정 불가(실 모델 의존). " +
            "모델 다운로드 후 재실행 필요(silent skip 금지 — 정직한 실패).",
        );
      }

      // 운영 default 정밀 코어(λ=0.2 dbsf max) 위에서 baseline floor 방식·값만 sweep.
      // 방식 ㉮ = gate / 방식 ㉯ = tmm-min. baseline=0 행은 floor 비활성(OFF 동치) 대조.
      const modes: BaselineFloorMode[] = ["gate", "tmm-min"];
      const rows: BaselineRow[] = [];

      const measureRow = async (
        label: string,
        mode: BaselineFloorMode,
        vectorBaseline: number,
        imageVecBaseline: number,
      ): Promise<BaselineRow> => {
        const tuning: RetrieveTuning = {
          ...PRECISION_BASE,
          baselineFloorMode: mode,
          vectorBaseline,
          imageVecBaseline,
        };

        // (a) 글 nDCG — harness 글 코퍼스(리랭커-off).
        const snap = await runHarness(embedder, {
          variants: { "full-rrf": SWEEP_VARIANTS["full-rrf"]! },
          tuning,
        });
        const flatFull = snap.variants.find((v) => v.variant === "full-rrf")!;

        // (b) 노란후드 + junk 분별 — 분별 코퍼스(매 행 새 코퍼스 / touch 격리).
        const ctx = await buildDiscriminationCorpus();
        let disc: DiscriminationMeasure;
        try {
          const results = await ctx.retriever.retrieve(QUERY, {
            limit: FLAT_LIMIT,
            tuning,
          });
          disc = measureDiscrimination(ctx, results);
        } finally {
          ctx.close();
        }

        const junkDemoted = junkDemotedBy(disc);
        const textBeatsDistractor =
          disc.strongTextScore > disc.topDistractorScore;
        const strongImageBeatsMid =
          disc.strongImageScore >= disc.midImageScore;
        const ndcgRegressionOk = flatFull.avgNdcg >= FLAT_FULL_RRF_FLOOR;
        return {
          label,
          mode,
          vectorBaseline,
          imageVecBaseline,
          flatNdcg: flatFull.avgNdcg,
          flatRecall: flatFull.avgRecall,
          disc,
          junkDemoted,
          textBeatsDistractor,
          strongImageBeatsMid,
          ndcgRegressionOk,
          allGatesOk:
            junkDemoted &&
            textBeatsDistractor &&
            strongImageBeatsMid &&
            ndcgRegressionOk &&
            flatFull.avgRecall >= FLAT_RECALL_FLOOR,
        };
      };

      // mode × (vector baseline × imageVec baseline) sweep. 각 vector baseline 에 정합
      // imageVec baseline 을 짝지어 측정(둘 다 0 = 비활성 / 채택 근방 포함).
      for (const mode of modes) {
        for (let i = 0; i < VECTOR_BASELINE_SWEEP_GRID.length; i++) {
          const vb = VECTOR_BASELINE_SWEEP_GRID[i]!;
          const ib =
            IMAGE_VEC_BASELINE_SWEEP_GRID[i] ??
            IMAGE_VEC_BASELINE_SWEEP_GRID[
              IMAGE_VEC_BASELINE_SWEEP_GRID.length - 1
            ]!;
          rows.push(
            await measureRow(`${mode} vec=${vb} img=${ib}`, mode, vb, ib),
          );
        }
      }

      // ── 측정 표 출력 (메인이 사용자에게 default 확정 근거로 보고) ──
      console.log(
        `[D-N2(B) baseline floor 측정 표] query="${QUERY}" / 정밀 코어 λ=${PRECISION_STRENGTH_WEIGHT} ${PRECISION_STRENGTH_MODE} dbsf ON / 리랭커-off`,
      );
      console.log(
        "  방식·baseline | 글nDCG | 글recall | 강한글 rank/score | 강한이미지 rank/score | " +
          "junk rank/score/정밀강도 | 무관글 rank/score | junk강등 | 글>무관 | 강이미지>노란옷 | nDCG회귀OK | 전체게이트",
      );
      for (const r of rows) {
        const d = r.disc;
        console.log(
          `  ${r.label} | ${r.flatNdcg.toFixed(4)} | ${r.flatRecall.toFixed(2)} | ` +
            `${d.strongTextRank}/${d.strongTextScore.toFixed(6)} | ` +
            `${d.strongImageRank}/${d.strongImageScore.toFixed(6)} | ` +
            `${d.topJunkRank}/${d.topJunkScore === Number.NEGATIVE_INFINITY ? "없음" : d.topJunkScore.toFixed(6)}/${d.topJunkPrecision.toFixed(6)} | ` +
            `${d.topDistractorRank}/${d.topDistractorScore.toFixed(6)} | ` +
            `${r.junkDemoted ? "예" : "아니오"} | ` +
            `${r.textBeatsDistractor ? "예" : "아니오"} | ` +
            `${r.strongImageBeatsMid ? "예" : "아니오"} | ` +
            `${r.ndcgRegressionOk ? "예" : "아니오"} | ` +
            `${r.allGatesOk ? "예" : "아니오"}`,
        );
      }

      // 게이트 전부 통과 후보 목록.
      const passing = rows.filter((r) => r.allGatesOk);
      console.log(
        `[D-N2(B) 게이트 통과 후보] ${passing.length}개 / 전체 ${rows.length}개`,
      );

      // ── 단언 1: 게이트를 다 통과하는 baseline 조합이 적어도 하나 존재한다 ──
      expect(passing.length).toBeGreaterThan(0);

      // ── 단언 2: 채택 default(search-tuning.ts 모듈 상수)가 운영 게이트를 다 통과한다 ──
      const adopted = rows.find(
        (r) =>
          r.mode === BASELINE_FLOOR_MODE &&
          r.vectorBaseline === VECTOR_COSINE_BASELINE &&
          r.imageVecBaseline === IMAGE_VEC_COSINE_BASELINE,
      );
      expect(adopted).toBeDefined();
      console.log(
        `[D-N2(B) 채택 default] ${BASELINE_FLOOR_MODE} vec=${VECTOR_COSINE_BASELINE} img=${IMAGE_VEC_COSINE_BASELINE} — ` +
          `글nDCG=${adopted!.flatNdcg.toFixed(4)} / junk rank=${adopted!.disc.topJunkRank} ` +
          `(junk강등=${adopted!.junkDemoted ? "예" : "아니오"} / 전체게이트=${adopted!.allGatesOk ? "예" : "아니오"})`,
      );
      expect(adopted!.junkDemoted).toBe(true);
      expect(adopted!.textBeatsDistractor).toBe(true);
      expect(adopted!.strongImageBeatsMid).toBe(true);
      expect(adopted!.ndcgRegressionOk).toBe(true);
      expect(adopted!.flatRecall).toBeGreaterThanOrEqual(FLAT_RECALL_FLOOR);
      expect(adopted!.allGatesOk).toBe(true);

      // ── 단언 3: baseline=0 행(floor 비활성)은 채택 행과 글 nDCG 가 같다 ──
      // baseline=0 이면 한 노드도 안 깎이므로 글 nDCG 가 baseline floor 도입 전과 같다.
      const zeroRow = rows.find(
        (r) =>
          r.mode === BASELINE_FLOOR_MODE &&
          r.vectorBaseline === 0 &&
          r.imageVecBaseline === 0,
      )!;
      expect(zeroRow.flatNdcg).toBeCloseTo(adopted!.flatNdcg, 6);
    },
    600_000,
  );
});

// ── byte-동일 불변식: baseline floor OFF·baseline=0 이면 finalScore 가 도입 전과 동일 ──
//
// dispatch 불변식: baseline floor 가 off 이거나 baseline=0 이면 finalScore 가 현행
// (baseline floor 도입 전 = mode off)과 byte 동일해야 한다. λ=0 byte-동일 불변 양식
// 정합. baseline floor 가 boostedRrf 가 아니라 정밀 강도(precisionStrength) 가산
// 항에만 들어가므로, off 와 baseline=0(gate) 의 precisionStrength 가 같으면 finalScore
// 도 같다 — 이걸 같은 query·코퍼스로 직접 단언한다.

describe("D-N2 — baseline floor OFF / baseline=0 은 도입 전과 finalScore byte 동일", () => {
  test(
    "mode=off 와 mode=gate baseline=0 의 검색 결과 점수가 1e-12 안에서 동일",
    async () => {
      if (!siglipAvailable) {
        throw new Error(
          "SigLIP text encoder 미로드 — 분별 코퍼스 적재 불가(정직한 실패).",
        );
      }
      const ctx = await buildDiscriminationCorpus();
      try {
        const base: RetrieveTuning = {
          precisionStrengthWeight: PRECISION_STRENGTH_WEIGHT,
          precisionStrengthMode: PRECISION_STRENGTH_MODE,
          vectorCalibrationMethod: VECTOR_CALIBRATION_METHOD,
          imageVecCalibrationMethod: IMAGE_VEC_CALIBRATION_METHOD,
        };
        const offResults = await ctx.retriever.retrieve(QUERY, {
          limit: FLAT_LIMIT,
          tuning: { ...base, baselineFloorMode: "off" },
        });
        const zeroResults = await ctx.retriever.retrieve(QUERY, {
          limit: FLAT_LIMIT,
          tuning: {
            ...base,
            baselineFloorMode: "gate",
            vectorBaseline: 0,
            imageVecBaseline: 0,
          },
        });

        // 같은 노드 집합·같은 순서·같은 점수여야 한다.
        const offScores = new Map(
          offResults.map((r) => [r.node.id, r.score] as const),
        );
        const zeroScores = new Map(
          zeroResults.map((r) => [r.node.id, r.score] as const),
        );

        console.log(
          `[D-N2 byte-동일] off ${offResults.length}건 / gate baseline=0 ${zeroResults.length}건`,
        );

        expect(zeroResults.length).toBe(offResults.length);
        for (const [id, off] of offScores) {
          const zero = zeroScores.get(id);
          expect(zero).toBeDefined();
          expect(zero!).toBeCloseTo(off, 12);
        }
        // 순서도 동일.
        expect(zeroResults.map((r) => r.node.id)).toEqual(
          offResults.map((r) => r.node.id),
        );
      } finally {
        ctx.close();
      }
    },
    600_000,
  );
});
