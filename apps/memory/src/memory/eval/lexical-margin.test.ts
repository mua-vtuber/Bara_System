/**
 * lexical-margin.test.ts — margin 지표 순수 함수 검증 (일치성 검색 재설계 GM).
 *
 * 이 테스트가 존재하는 이유 = nDCG(computeNdcg)는 group-first-hit 이라 정답이 1위면
 * nDCG=1.0 으로 포화한다. 글 6케이스가 전부 nDCG 1.0 인 것은 "정확일치가 1위"라는
 * 뜻이지 "개선 여지가 없다"는 뜻이 아니다 — 정답과 top-distractor 의 점수 격차
 * (margin)를 못 본다. GB(글 회귀 감시)·IM(그림 글자항 값어치)은 둘 다 미세 순위/격차
 * 변화를 재야 하므로 margin 지표가 필요하다.
 *
 * margin = (정답 노드 최고 score) − (top-distractor score).
 *  - margin > 0 : 정답이 최상위 오답보다 위(보장). 값이 클수록 여유.
 *  - margin < 0 : 정답이 최상위 오답보다 아래(회귀).
 *  - 정답 미회수 : -Infinity(회수 실패 — 순위가 아니라 회수 문제 신호).
 *
 * 순수 함수 — retrieve 결과 배열(node.id + score) + id 집합 입력, 부작용 0. mock
 * 객체 0 — 데이터 fixture(가짜 결과 배열)로만 검증(CLAUDE.md 테스트 정책 정합).
 */
import { describe, expect, test } from "bun:test";
import { scoreMargin, type MarginScorable } from "./lexical-margin.ts";

/** 데이터 fixture — retrieve 결과 한 줄을 흉내낸 순수 데이터(인터페이스 구현 아님). */
function row(id: number, score: number): MarginScorable {
  return { node: { id }, score };
}

describe("GM — scoreMargin 순수 함수", () => {
  test("정답 1위 + distractor 2위 → 양수 margin(정답score − distractorScore)", () => {
    const results = [row(10, 0.9), row(20, 0.7), row(30, 0.5)];
    // 정답 = 10(1위 0.9). 나머지 중 최고 오답 = 20(0.7). margin = 0.2.
    const m = scoreMargin(results, new Set([10]));
    expect(m).toBeCloseTo(0.2);
  });

  test("정답이 distractor 아래 → 음수 margin(회귀 신호)", () => {
    const results = [row(20, 0.8), row(10, 0.6), row(30, 0.4)];
    // 정답 = 10(0.6). 최고 오답 = 20(0.8). margin = -0.2.
    const m = scoreMargin(results, new Set([10]));
    expect(m).toBeCloseTo(-0.2);
  });

  test("정답 미회수(결과에 없음) → -Infinity(회수 실패)", () => {
    const results = [row(20, 0.8), row(30, 0.4)];
    const m = scoreMargin(results, new Set([99]));
    expect(m).toBe(-Infinity);
  });

  test("정답 여러 개면 그중 최고 score 를 정답 대표로 쓴다", () => {
    const results = [row(20, 0.9), row(10, 0.7), row(11, 0.5), row(30, 0.3)];
    // 정답 = {10,11}. 정답 최고 = 10(0.7). 최고 오답 = 20(0.9). margin = -0.2.
    const m = scoreMargin(results, new Set([10, 11]));
    expect(m).toBeCloseTo(-0.2);
  });

  test("distractor 가 하나도 없으면(전부 정답) → +Infinity(비교 대상 없음)", () => {
    const results = [row(10, 0.9), row(11, 0.7)];
    const m = scoreMargin(results, new Set([10, 11]));
    expect(m).toBe(Infinity);
  });

  test("distractorIds 명시 → 그 집합의 최고 score 만 top-distractor 로 본다", () => {
    const results = [row(10, 0.9), row(20, 0.8), row(30, 0.7), row(40, 0.6)];
    // 정답 = 10(0.9). distractor 를 {30,40} 로 한정 → 최고 = 30(0.7). margin = 0.2.
    // (20 은 정답도 distractor 도 아니라 무시됨 — 지정 distractor 만 비교)
    const m = scoreMargin(results, new Set([10]), new Set([30, 40]));
    expect(m).toBeCloseTo(0.2);
  });

  test("distractorIds 명시했으나 결과에 하나도 없으면 → +Infinity", () => {
    const results = [row(10, 0.9), row(20, 0.8)];
    const m = scoreMargin(results, new Set([10]), new Set([88, 99]));
    expect(m).toBe(Infinity);
  });

  test("빈 결과 배열 + 정답 있음 → -Infinity(정답 미회수)", () => {
    const m = scoreMargin([], new Set([10]));
    expect(m).toBe(-Infinity);
  });
});
