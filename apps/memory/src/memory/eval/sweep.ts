/**
 * memory/eval/sweep.ts — 검색 상수 sweep runner (1.1b T5).
 *
 * BLEND_SWEEP_GRID × GRAPH_BOOST_SWEEP_GRID × {floor on/off} 조합마다
 * runHarness(flat) 를 돌려 avgNdcg/avgRecall/avgMrr 점수표를 산출한다.
 *
 * ## measured-win gate
 *
 * pickBest 는 flat full-rrf avgNdcg 최대 cell 을 선택한다. best 가 spec default
 * (blend 0.7/0.3 또는 floor-중립 / graph 0.96 / floor off)보다 높을 때만 새
 * 상수 채택을 권고한다. 동률·하락이면 현 default 유지(DCL-5 보수적 기준).
 *
 * ## 야심찬 목표
 *
 * vector-only 기준선 0.9272 를 넘으면 best 를 권고. 못 넘어도 floor 위 최선 권고.
 *
 * ## rrf.ts / harness.ts 계약
 *
 * 모든 점수 계산은 runHarness 에 위임 — 이 모듈은 grid 탐색 + 결과 집계만.
 * LLM 호출 0. 결정적 연산.
 */

import type { Embedder } from "../../embedding/types.ts";
import {
  runHarness,
  runEnrichedHarness,
  ENRICHED_SWEEP_VARIANTS,
  type VariantSnapshot,
} from "./harness.ts";
import type { RetrieveTuning } from "../retriever.ts";
import {
  BLEND_SWEEP_GRID,
  GRAPH_BOOST_SWEEP_GRID,
} from "../search-tuning.ts";

// ── 타입 정의 ─────────────────────────────────────────────────────────────

/** 한 조합(blend + graphBoost + floor)의 측정 결과. */
export interface SweepCell {
  /** blend 가중치 [rrfWeight, bm25Weight]. */
  blend: [number, number];
  /** SOURCE_BOOST.graph 오버라이드 값. */
  graphBoost: number;
  /** missing-rank floor on/off. */
  floor: boolean;
  /** flat full-rrf variant 의 avgNdcg. */
  flatFullRrfNdcg: number;
  /** flat full-rrf variant 의 avgRecall. */
  flatFullRrfRecall: number;
  /** flat full-rrf variant 의 avgMrr. */
  flatFullRrfMrr: number;
}

/**
 * 핵심 3 조합의 enriched 교차측정 — full-rrf+concept variant 의 avgNdcg.
 *
 * full 60 조합 enriched sweep 은 하지 않는다(아래 runSweep 주석 참조 —
 * enriched recall 포화 + nDCG 잡음으로 cell 변별 불가). default(중립) 조합이
 * enriched 를 깎지 않는지 spec 조합과 교차 확인하는 spot-check 용도다.
 */
export interface EnrichedSpot {
  /** default(중립) 조합의 full-rrf+concept avgNdcg. */
  default: number;
  /** spec(0.7/0.3, graph 0.96) 조합의 full-rrf+concept avgNdcg. */
  spec: number;
  /** best(flat 최대 nDCG) 조합의 full-rrf+concept avgNdcg. */
  best: number;
}

/** 전체 sweep 산출물. */
export interface SweepReport {
  /** 모든 조합 셀. */
  cells: SweepCell[];
  /** flatFullRrfNdcg 최대 셀. */
  best: SweepCell;
  /**
   * spec default 셀 — blend 0.7/0.3 · graphBoost 0.96 · floor off.
   * flat 코퍼스에서 반증됐으나 T5 재검증 대상(DCL-5).
   */
  specDefaultCell: SweepCell;
  /**
   * 운영 floor-중립 셀 — blend 1.0/0.0 · graphBoost 1.00 · floor off.
   * T4 DCL-5 운영 default. best 가 이 셀보다 높을 때만 채택 권고.
   */
  defaultCell: SweepCell;
  /**
   * 핵심 3 조합(default/spec/best)의 enriched full-rrf+concept nDCG 교차측정.
   * plan AC4 "flat + enriched" 보정 — 채택 조합이 enriched 를 깎지 않음 확인.
   */
  enrichedSpot: EnrichedSpot;
}

// ── spec default / 운영 default 식별자 ───────────────────────────────────

/** spec 직감 default tuning (flat 반증됨 — T5 재검증). */
export const SPEC_DEFAULT_TUNING: RetrieveTuning = {
  blend: { rrf: 0.7, bm25: 0.3 },
  graphBoost: 0.96,
  missingRankFloor: false,
};

/** 운영 floor-중립 default (DCL-5 검증값). */
export const OPS_DEFAULT_TUNING: RetrieveTuning = {
  blend: { rrf: 1.0, bm25: 0.0 },
  graphBoost: 1.00,
  missingRankFloor: false,
};

// ── 내부 헬퍼 ─────────────────────────────────────────────────────────────

/** flat full-rrf variant 의 VariantSnapshot 에서 한 셀 점수를 추출한다. */
function extractFullRrfScores(variants: VariantSnapshot[]): {
  ndcg: number;
  recall: number;
  mrr: number;
} {
  const v = variants.find((x) => x.variant === "full-rrf");
  if (!v) {
    throw new Error("sweep: runHarness 결과에 full-rrf variant 없음 — SWEEP_VARIANTS 확인 필요");
  }
  return { ndcg: v.avgNdcg, recall: v.avgRecall, mrr: v.avgMrr };
}

/** 한 tuning 조합으로 flat harness 를 실행해 SweepCell 을 반환한다. */
async function runCell(
  embedder: Embedder,
  blend: [number, number],
  graphBoost: number,
  floor: boolean,
): Promise<SweepCell> {
  const tuning: RetrieveTuning = {
    blend: { rrf: blend[0], bm25: blend[1] },
    graphBoost,
    missingRankFloor: floor,
  };
  const snap = await runHarness(embedder, {
    variants: { "full-rrf": { vector: true, fts: true, graph: true, concept: false } },
    tuning,
  });
  const scores = extractFullRrfScores(snap.variants);
  return {
    blend,
    graphBoost,
    floor,
    flatFullRrfNdcg: scores.ndcg,
    flatFullRrfRecall: scores.recall,
    flatFullRrfMrr: scores.mrr,
  };
}

/**
 * 한 SweepCell 조합의 tuning 으로 enriched harness 를 돌려 full-rrf+concept
 * variant 의 avgNdcg 를 추출한다. 핵심 3 조합 교차측정 전용(spot-check).
 */
async function runEnrichedSpot(embedder: Embedder, cell: SweepCell): Promise<number> {
  const tuning: RetrieveTuning = {
    blend: { rrf: cell.blend[0], bm25: cell.blend[1] },
    graphBoost: cell.graphBoost,
    missingRankFloor: cell.floor,
  };
  const snap = await runEnrichedHarness(embedder, {
    variants: ENRICHED_SWEEP_VARIANTS,
    tuning,
  });
  const v = snap.variants.find((x) => x.variant === "full-rrf+concept");
  if (!v) {
    throw new Error(
      "sweep: enriched 결과에 full-rrf+concept variant 없음 — ENRICHED_SWEEP_VARIANTS 확인 필요",
    );
  }
  return v.avgNdcg;
}

// ── 공개 API ──────────────────────────────────────────────────────────────

/**
 * BLEND_SWEEP_GRID × GRAPH_BOOST_SWEEP_GRID × {floor on/off} 전체를 flat 코퍼스로
 * 탐색해 SweepReport 를 산출한다. 추가로 핵심 3 조합(default/spec/best)만
 * enriched 코퍼스로 교차측정한다.
 *
 * 실행 시간 안내: bge-m3 로드 + flat harness 1회 ≈ 3~8초. flat 조합 수 =
 * len(BLEND_SWEEP_GRID) × len(GRAPH_BOOST_SWEEP_GRID) × 2 = 6×5×2 = 60회 +
 * spec/default flat 2회 + enriched spot 3회. 전체 ≈ 4~10분. sweep.test.ts 에서
 * timeout 을 넉넉히 설정한다(180000ms 이상).
 *
 * ## flat 전수 / enriched spot-check 비대칭 이유
 *
 * flat 코퍼스는 60 조합 전수 탐색한다 — vector-only 0.9272 > full-rrf 0.8882 로
 * 채널·blend 조정의 변별이 측정에 잡힌다. 반면 enriched 코퍼스는 60 조합 전수
 * sweep 을 하지 않는다: enriched recall 이 이미 1.0 으로 포화됐고(34 노드 / 4
 * query), nDCG 는 bge-m3 동점 임베딩이 RRF 동점 순서를 뒤집는 잡음에
 * 노출돼 cell 간 변별이 불가하다 — 60 조합을 다 돌려도 결론을 못 바꾼다.
 * 그래서 enriched 는 핵심 3 조합(default 중립 / spec 0.7-0.3-graph0.96 / best)만
 * 돌려 "채택 조합이 enriched 를 깎지 않음" 을 교차 확인한다. 최종 enriched
 * snapshot 의 권위는 T6 final-snapshot 에 둔다.
 *
 * 주의: flat 셀의 concept 채널은 flat 코퍼스에 개념이 적재되지 않아 항상 0
 * 기여이므로 concept=false 로 고정해 flat 기준선과 동일 조건을 유지한다.
 * enriched spot 은 ENRICHED_SWEEP_VARIANTS 로 full-rrf+concept(개념 ON)을 잰다.
 */
export async function runSweep(embedder: Embedder): Promise<SweepReport> {
  const cells: SweepCell[] = [];

  for (const blend of BLEND_SWEEP_GRID) {
    for (const graphBoost of GRAPH_BOOST_SWEEP_GRID) {
      for (const floor of [false, true]) {
        const cell = await runCell(embedder, blend, graphBoost, floor);
        cells.push(cell);
      }
    }
  }

  if (cells.length === 0) {
    throw new Error("sweep: 조합 셀이 0개 — BLEND_SWEEP_GRID / GRAPH_BOOST_SWEEP_GRID 확인 필요");
  }

  // best = flatFullRrfNdcg 최대 셀.
  const best = cells.reduce((a, b) => (b.flatFullRrfNdcg > a.flatFullRrfNdcg ? b : a));

  // spec default 셀 — grid 에 없을 수 있으므로 직접 실행.
  const specDefaultCell = await runCell(
    embedder,
    [SPEC_DEFAULT_TUNING.blend!.rrf, SPEC_DEFAULT_TUNING.blend!.bm25],
    SPEC_DEFAULT_TUNING.graphBoost!,
    SPEC_DEFAULT_TUNING.missingRankFloor ?? false,
  );

  // 운영 default 셀 — grid 에 있을 경우 재사용, 없으면 직접 실행.
  const foundDefault = cells.find(
    (c) =>
      c.blend[0] === OPS_DEFAULT_TUNING.blend!.rrf &&
      c.blend[1] === OPS_DEFAULT_TUNING.blend!.bm25 &&
      c.graphBoost === OPS_DEFAULT_TUNING.graphBoost &&
      !c.floor,
  );
  const defaultCell =
    foundDefault ??
    (await runCell(
      embedder,
      [OPS_DEFAULT_TUNING.blend!.rrf, OPS_DEFAULT_TUNING.blend!.bm25],
      OPS_DEFAULT_TUNING.graphBoost!,
      false,
    ));

  // 핵심 3 조합 enriched 교차측정 — full-rrf+concept avgNdcg(개념 ON).
  const enrichedSpot: EnrichedSpot = {
    default: await runEnrichedSpot(embedder, defaultCell),
    spec: await runEnrichedSpot(embedder, specDefaultCell),
    best: await runEnrichedSpot(embedder, best),
  };

  return { cells, best, specDefaultCell, defaultCell, enrichedSpot };
}

/**
 * measured-win gate — best 가 defaultCell 보다 높으면 채택 권고를 반환한다.
 * 동률(허용오차 1e-9 이내) 또는 하락이면 현 default 유지 권고.
 *
 * ## 비교 기준점이 운영 default(중립)인 이유 (DCL-5 귀결)
 *
 * plan AC3 문구는 spec default(blend 0.7/0.3 = nDCG 0.7967)와 비교하라고 적었으나,
 * 그 문구는 DCL-5 이전에 작성된 낡은 기준이다. DCL-5 가 운영 default 를 중립
 * (blend 1.0/0.0 = nDCG 0.8882)으로 바꾼 뒤, 게이트의 의미는 "지금 출시 중인
 * 동작보다 측정상 나을 때만 상수를 바꾼다" 가 된다. spec default(0.7967)를
 * 기준 삼으면 0.7967 보다 높지만 현행 0.8882 보다 낮은 조합(예 0.85)을 "채택"해
 * 회귀를 부른다. 운영 default(0.8882) 기준이 더 안전하다 — 진짜 win(현행보다 높음)
 * 은 두 기준 모두 채택하므로 놓치지 않는다.
 */
export function pickBest(report: SweepReport): {
  adopt: boolean;
  best: SweepCell;
  defaultCell: SweepCell;
  reason: string;
} {
  const { best, defaultCell } = report;
  const gain = best.flatFullRrfNdcg - defaultCell.flatFullRrfNdcg;

  if (gain > 1e-9) {
    return {
      adopt: true,
      best,
      defaultCell,
      reason:
        `measured-win: best(blend ${best.blend[0]}/${best.blend[1]}, ` +
        `graphBoost ${best.graphBoost}, floor ${best.floor}) ` +
        `nDCG ${best.flatFullRrfNdcg.toFixed(4)} > ` +
        `default nDCG ${defaultCell.flatFullRrfNdcg.toFixed(4)} ` +
        `(+${gain.toFixed(4)})`,
    };
  }

  return {
    adopt: false,
    best,
    defaultCell,
    reason:
      `measured-win gate 미통과: best nDCG ${best.flatFullRrfNdcg.toFixed(4)} ≤ ` +
      `default nDCG ${defaultCell.flatFullRrfNdcg.toFixed(4)} ` +
      `(delta ${gain.toFixed(4)}). 운영 default(floor-중립) 유지.`,
  };
}
