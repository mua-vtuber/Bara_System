/**
 * retrieve-assemble — retrieve() 노드별 점수 조립 순수 함수(L7 분해).
 *
 * retrieve() step 9 루프가 노드마다 돌던 점수 조립(출처 boost·BM25 blend·정밀 강도·
 * 장소 가산·recency/importance/mention/supersede 결합)을 순수 함수로 떼어냈다. 입력은
 * 노드별 raw 신호 + 가중치 const 한 묶음, 출력은 finalScore 와 component 점수다. 부작용
 * 없음(store·DB 접근 0). retrieve() 가 노드마다 이 함수를 부르고 그 결과로 RetrievalResult
 * 를 조립한다.
 *
 * 동작 보존(behavior-preserving): 식·결합 순서·분기(placeScore 두 갈래)는 옛 루프와 byte
 * 동일하다. IEEE754 결합 순서를 바꾸지 않으려 placeBonus 유무 두 갈래를 그대로 유지한다.
 * RRF 점수식 코어(rrf.ts·scoring.ts·search-tuning.ts·calibration.ts·reranker.ts·
 * retrieve-channels.ts)는 한 글자도 안 건드린다 — 이 함수는 이미 계산된 값을 결합만 한다.
 */

import {
  MENTION_BOOST_CAP,
  SUPERSEDE_PENALTY,
  W_RECENCY,
  W_IMPORTANCE,
  PLACE_SOFT_BOOST_WEIGHT,
  PLACE_SOFT_BOOST_CAP,
} from "./retrieve-constants.ts";

/** 정밀 강도 결합 방식(설계 §4.2 D-N1). retrieve-config 의 effectivePrecisionMode 값. */
export type PrecisionMode = "max" | "sum" | "weighted-rrf";

/**
 * 한 노드의 점수 조립에 필요한 raw 신호 + 가중치. retrieve() 가 노드마다 채운다.
 * 노드 무관 const(MENTION_BOOST_* 등)는 이 함수가 직접 import 하므로 입력에 없다 —
 * retrieve() 가 read 하던 것과 같은 const 단일 출처를 그대로 읽는다.
 */
export interface NodeScoreInputs {
  /** 통합 RRF(boost 미적용) — 기존 W_RRF 기준값. */
  rrfScore: number;
  /** 채널별 단독 RRF 기여(floor 적용 후). */
  bm25Contrib: number;
  vectorContrib: number;
  graphContrib: number;
  conceptContrib: number;
  imageVecContrib: number;
  /** 출처 boost 계수(effective*). */
  effectiveBm25Boost: number;
  effectiveVectorBoost: number;
  effectiveGraphBoost: number;
  effectiveConceptBoost: number;
  effectiveImageVecBoost: number;
  /** BM25 cross blend. */
  effectiveRrfBlendWeight: number;
  effectiveBm25CrossWeight: number;
  bm25Cross: number;
  /** 정밀 강도(T4) — 보정 강도 + λ + 방식. */
  calVec: number;
  calImg: number;
  effectivePrecisionMode: PrecisionMode;
  effectivePrecisionWeight: number;
  /** recency / importance / mention / supersede. */
  recency: number;
  effectiveImportance: number;
  mentionCount: number;
  /**
   * 재언급 1회당 검색 점수 가산량(post-RRF). settings.search.mentionBoost 노브가
   * retrieve-config 를 거쳐 흘러 들어온다(P3 G3-d). 운영 default 는
   * MENTION_BOOST_PER_COUNT(0.05)와 같은 값이라 노브를 안 바꾸면 회귀 0.
   * mentionCount 와 곱하고 MENTION_BOOST_CAP 으로 상한한다(CAP 은 노브 없는 모듈 상수).
   */
  mentionBoostPerCount: number;
  isSuperseded: boolean;
  /**
   * 장소 칸 소프트 가산 점수(0..1) — placeValue 지정 시에만 number, 미지정이면 undefined.
   * undefined 면 placeBonus 항 자체가 빠진 옛 else 갈래 식을 쓴다(IEEE754 결합 순서 보존).
   */
  placeScore: number | undefined;
}

/** 한 노드 점수 조립 결과 — retrieve() 가 RetrievalResult.components 로 옮겨 담는다. */
export interface NodeScoreResult {
  finalScore: number;
  boostedRrf: number;
  mentionBoost: number;
  supersedePenalty: number;
  precisionStrengthScore: number;
}

/**
 * 한 노드의 finalScore 와 component 점수를 조립한다(retrieve() step 9 루프 본체 byte 동일).
 *
 * 절차(옛 루프와 식·순서 동일):
 *   boostedRrf = rrfScore + Σ(채널 기여 × (boost - 1))
 *   blendedRrf = rrfBlendWeight × boostedRrf + bm25CrossWeight × bm25Cross
 *   precisionStrength = max/sum/weighted-rrf(calVec, calImg) × λ
 *   blended = blendedRrf + precisionStrength + W_RECENCY·recency + W_IMPORTANCE·importance
 *             + mentionBoost (+ placeBonus, placeScore 지정 시에만)
 *   finalScore = blended × supersedePenalty
 */
export function assembleNodeScore(inputs: NodeScoreInputs): NodeScoreResult {
  const mentionBoost = Math.min(
    MENTION_BOOST_CAP,
    inputs.mentionBoostPerCount * inputs.mentionCount,
  );
  const supersedePenalty = inputs.isSuperseded ? SUPERSEDE_PENALTY : 1.0;

  const boostedRrf =
    inputs.rrfScore +
    inputs.bm25Contrib * (inputs.effectiveBm25Boost - 1) +
    inputs.vectorContrib * (inputs.effectiveVectorBoost - 1) +
    inputs.graphContrib * (inputs.effectiveGraphBoost - 1) +
    inputs.conceptContrib * (inputs.effectiveConceptBoost - 1) +
    inputs.imageVecContrib * (inputs.effectiveImageVecBoost - 1);

  const blendedRrf =
    inputs.effectiveRrfBlendWeight * boostedRrf +
    inputs.effectiveBm25CrossWeight * inputs.bm25Cross;

  let precisionStrength: number;
  if (inputs.effectivePrecisionMode === "sum") {
    precisionStrength = inputs.calVec + inputs.calImg;
  } else if (inputs.effectivePrecisionMode === "weighted-rrf") {
    precisionStrength =
      inputs.vectorContrib * inputs.calVec +
      inputs.imageVecContrib * inputs.calImg;
  } else {
    // "max" (default) — 강한 단일 매치 우세.
    precisionStrength = Math.max(inputs.calVec, inputs.calImg);
  }
  const precisionStrengthScore =
    inputs.effectivePrecisionWeight * precisionStrength;

  // placeScore 지정 유무 두 갈래 — 0 더하기로 IEEE754 결합 순서를 바꾸지 않으려 분기.
  let blended: number;
  if (inputs.placeScore !== undefined) {
    const placeBonus = Math.min(
      PLACE_SOFT_BOOST_CAP,
      PLACE_SOFT_BOOST_WEIGHT * inputs.placeScore,
    );
    blended =
      blendedRrf +
      precisionStrengthScore +
      W_RECENCY * inputs.recency +
      W_IMPORTANCE * inputs.effectiveImportance +
      mentionBoost +
      placeBonus;
  } else {
    blended =
      blendedRrf +
      precisionStrengthScore +
      W_RECENCY * inputs.recency +
      W_IMPORTANCE * inputs.effectiveImportance +
      mentionBoost;
  }
  const finalScore = blended * supersedePenalty;

  return {
    finalScore,
    boostedRrf,
    mentionBoost,
    supersedePenalty,
    precisionStrengthScore,
  };
}
