/**
 * retrieve-assemble 단위 테스트 — assembleNodeScore 순수 함수(L7 분해).
 *
 * 순수 데이터 입력→출력 검증(인터페이스 mock 없음). retrieve() 루프가 노드마다 돌던
 * 점수 결합식을 떼어낸 함수라, 식·결합 순서·placeScore 두 갈래 분기를 직접 단언한다.
 * 가중치 const(MENTION_BOOST_*·W_RECENCY 등)는 함수가 직접 import 하므로 테스트도 같은
 * 단일 출처에서 읽어 기대값을 손계산한다(매직 넘버 고정 회피).
 */

import { describe, expect, test } from "bun:test";
import { assembleNodeScore, type NodeScoreInputs } from "./retrieve-assemble.ts";
import {
  MENTION_BOOST_PER_COUNT,
  MENTION_BOOST_CAP,
  SUPERSEDE_PENALTY,
  W_RECENCY,
  W_IMPORTANCE,
  PLACE_SOFT_BOOST_WEIGHT,
  PLACE_SOFT_BOOST_CAP,
} from "./retrieve-constants.ts";

/** 모든 boost=1·blendWeight=1·정밀/cross/place 0 인 중립 입력(식이 rrfScore 로 환원). */
function neutralInputs(over: Partial<NodeScoreInputs> = {}): NodeScoreInputs {
  return {
    rrfScore: 0.5,
    bm25Contrib: 0.1,
    vectorContrib: 0.2,
    graphContrib: 0.05,
    conceptContrib: 0.03,
    imageVecContrib: 0.0,
    effectiveBm25Boost: 1,
    effectiveVectorBoost: 1,
    effectiveGraphBoost: 1,
    effectiveConceptBoost: 1,
    effectiveImageVecBoost: 1,
    effectiveRrfBlendWeight: 1,
    effectiveBm25CrossWeight: 0,
    bm25Cross: 0,
    calVec: 0,
    calImg: 0,
    effectivePrecisionMode: "max",
    effectivePrecisionWeight: 0,
    recency: 0,
    effectiveImportance: 0,
    mentionCount: 0,
    // P3 G3-d — 재언급 가산량은 이제 입력으로 받는다(모듈 상수 직접 import 제거).
    // 중립 기본값은 운영 default 와 같은 MENTION_BOOST_PER_COUNT 로 둬, 노브를 안
    // 넘긴 손계산 테스트가 옛 동작과 같은 값을 검증한다(회귀 0).
    mentionBoostPerCount: MENTION_BOOST_PER_COUNT,
    isSuperseded: false,
    placeScore: undefined,
    ...over,
  };
}

describe("assembleNodeScore (pure)", () => {
  test("중립 입력(boost=1·가중치 0)이면 finalScore = rrfScore", () => {
    const r = assembleNodeScore(neutralInputs());
    expect(r.boostedRrf).toBeCloseTo(0.5, 12); // boost-1=0 이라 채널 delta 0
    expect(r.finalScore).toBeCloseTo(0.5, 12);
    expect(r.supersedePenalty).toBe(1.0);
    expect(r.mentionBoost).toBe(0);
    expect(r.precisionStrengthScore).toBe(0);
  });

  test("출처 boost — boostedRrf = rrfScore + Σ(채널기여 ×(boost-1))", () => {
    const r = assembleNodeScore(
      neutralInputs({
        effectiveBm25Boost: 2, // +0.1×1
        effectiveVectorBoost: 1.5, // +0.2×0.5
        effectiveGraphBoost: 3, // +0.05×2
      }),
    );
    const expected = 0.5 + 0.1 * 1 + 0.2 * 0.5 + 0.05 * 2;
    expect(r.boostedRrf).toBeCloseTo(expected, 12);
    expect(r.finalScore).toBeCloseTo(expected, 12);
  });

  test("BM25 cross blend — blendWeight·crossWeight 결합", () => {
    const r = assembleNodeScore(
      neutralInputs({
        effectiveRrfBlendWeight: 0.7,
        effectiveBm25CrossWeight: 0.3,
        bm25Cross: 2.0,
      }),
    );
    // boostedRrf = 0.5(boost 1 이라 delta 0)
    const expected = 0.7 * 0.5 + 0.3 * 2.0;
    expect(r.finalScore).toBeCloseTo(expected, 12);
  });

  test("정밀 강도 max(default) — λ × max(calVec, calImg)", () => {
    const r = assembleNodeScore(
      neutralInputs({
        calVec: 0.4,
        calImg: 0.9,
        effectivePrecisionMode: "max",
        effectivePrecisionWeight: 0.5,
      }),
    );
    expect(r.precisionStrengthScore).toBeCloseTo(0.5 * 0.9, 12);
    expect(r.finalScore).toBeCloseTo(0.5 + 0.5 * 0.9, 12);
  });

  test("정밀 강도 sum — λ × (calVec + calImg)", () => {
    const r = assembleNodeScore(
      neutralInputs({
        calVec: 0.4,
        calImg: 0.9,
        effectivePrecisionMode: "sum",
        effectivePrecisionWeight: 0.5,
      }),
    );
    expect(r.precisionStrengthScore).toBeCloseTo(0.5 * (0.4 + 0.9), 12);
  });

  test("정밀 강도 weighted-rrf — λ × (vecContrib·calVec + imgContrib·calImg)", () => {
    const r = assembleNodeScore(
      neutralInputs({
        vectorContrib: 0.2,
        imageVecContrib: 0.3,
        calVec: 0.4,
        calImg: 0.9,
        effectivePrecisionMode: "weighted-rrf",
        effectivePrecisionWeight: 1,
      }),
    );
    expect(r.precisionStrengthScore).toBeCloseTo(0.2 * 0.4 + 0.3 * 0.9, 12);
  });

  test("mentionBoost — per-count × count, CAP 으로 상한", () => {
    // CAP 미적용 구간: count × PER_COUNT < CAP 인 작은 count 로 선형성 확인.
    const smallCount = 1;
    const r1 = assembleNodeScore(neutralInputs({ mentionCount: smallCount }));
    expect(r1.mentionBoost).toBeCloseTo(MENTION_BOOST_PER_COUNT * smallCount, 12);
    expect(r1.mentionBoost).toBeLessThan(MENTION_BOOST_CAP); // 아직 CAP 안 닿음
    // CAP 적용 구간: 충분히 큰 count 면 CAP 으로 잘린다.
    const huge = Math.ceil(MENTION_BOOST_CAP / MENTION_BOOST_PER_COUNT) + 100;
    const r2 = assembleNodeScore(neutralInputs({ mentionCount: huge }));
    expect(r2.mentionBoost).toBe(MENTION_BOOST_CAP);
  });

  test("mentionBoostPerCount 노브 반영 — 입력값이 가산량을 바꾼다(P3 G3-d)", () => {
    // settings.search.mentionBoost 노브가 이 입력으로 흘러온다. 같은 mentionCount
    // 에서 per-count 값을 올리면 가산량이 비례해 커진다(노브가 실제로 점수에 반영됨).
    const count = 1;
    const low = assembleNodeScore(
      neutralInputs({ mentionCount: count, mentionBoostPerCount: 0.02 }),
    );
    const high = assembleNodeScore(
      neutralInputs({ mentionCount: count, mentionBoostPerCount: 0.08 }),
    );
    expect(low.mentionBoost).toBeCloseTo(0.02 * count, 12);
    expect(high.mentionBoost).toBeCloseTo(0.08 * count, 12);
    expect(high.mentionBoost).toBeGreaterThan(low.mentionBoost);
    // finalScore 에도 그 차이가 그대로 반영된다(가산 항이므로 차이 = per-count 차이).
    expect(high.finalScore - low.finalScore).toBeCloseTo((0.08 - 0.02) * count, 12);
  });

  test("mentionBoostPerCount default = MENTION_BOOST_PER_COUNT 면 회귀 0", () => {
    // 운영 default(0.05)를 명시로 넘긴 결과와, neutralInputs 기본(같은 상수)을 쓴
    // 결과가 byte 동일 — settings default 를 안 바꾼 검색이 도입 전과 같음을 실증.
    const count = 2;
    const explicit = assembleNodeScore(
      neutralInputs({
        mentionCount: count,
        mentionBoostPerCount: MENTION_BOOST_PER_COUNT,
      }),
    );
    const viaDefault = assembleNodeScore(neutralInputs({ mentionCount: count }));
    expect(explicit.mentionBoost).toBe(viaDefault.mentionBoost);
    expect(explicit.finalScore).toBe(viaDefault.finalScore);
  });

  test("supersede penalty — isSuperseded 면 finalScore × SUPERSEDE_PENALTY", () => {
    const r = assembleNodeScore(neutralInputs({ isSuperseded: true }));
    expect(r.supersedePenalty).toBe(SUPERSEDE_PENALTY);
    expect(r.finalScore).toBeCloseTo(0.5 * SUPERSEDE_PENALTY, 12);
  });

  test("recency/importance 가중 합산", () => {
    const r = assembleNodeScore(
      neutralInputs({ recency: 0.8, effectiveImportance: 0.6 }),
    );
    const expected = 0.5 + W_RECENCY * 0.8 + W_IMPORTANCE * 0.6;
    expect(r.finalScore).toBeCloseTo(expected, 12);
  });

  test("placeScore undefined(else 갈래) — placeBonus 항이 식에서 빠진다", () => {
    const r = assembleNodeScore(
      neutralInputs({ placeScore: undefined, recency: 0.3 }),
    );
    expect(r.finalScore).toBeCloseTo(0.5 + W_RECENCY * 0.3, 12);
  });

  test("placeScore 지정 — placeBonus = min(CAP, WEIGHT × score) 가산", () => {
    const r = assembleNodeScore(
      neutralInputs({ placeScore: 1.0, recency: 0.3 }),
    );
    const placeBonus = Math.min(PLACE_SOFT_BOOST_CAP, PLACE_SOFT_BOOST_WEIGHT * 1.0);
    expect(r.finalScore).toBeCloseTo(0.5 + W_RECENCY * 0.3 + placeBonus, 12);
  });

  test("placeScore=0 지정 — placeBonus 0 이라 else 갈래와 같은 점수", () => {
    const withZero = assembleNodeScore(neutralInputs({ placeScore: 0, recency: 0.3 }));
    const without = assembleNodeScore(neutralInputs({ placeScore: undefined, recency: 0.3 }));
    expect(withZero.finalScore).toBeCloseTo(without.finalScore, 12);
  });
});
