/**
 * 노드 간격 순수 헬퍼 — Three.js 의존 없음.
 * 노드 크기(size)를 물리 반지름과 무게로 변환하고, 두 노드 사이 최소 거리를 계산한다.
 * force-layout 충돌 패스(Task 3)와 드래그 물리(Task 4)에서 공통으로 사용한다.
 * 모든 튜닝 수치는 GRAPH_RENDER_THEME.nodeSpacing / dragRelax 에서만 읽는다.
 */
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";

/**
 * 노드 크기(size)를 물리 반지름으로 변환한다.
 * radius = size × radiusFactor
 * @param size - 노드 크기 (graph-view-model 의 size 필드, NODE_SIZE.min ~ NODE_SIZE.max)
 * @returns 월드 단위 반지름
 */
export function radiusOfSize(size: number): number {
  return size * GRAPH_RENDER_THEME.nodeSpacing.radiusFactor;
}

/**
 * 노드 크기(size)를 물리 무게로 변환한다.
 * mass = (size / massRefSize) ^ massExp
 * massRefSize 일 때 무게가 정확히 1 이다.
 * @param size - 노드 크기
 * @returns 1 이상 양수 (기준 크기일 때 1, 클수록 커진다)
 */
export function massOfSize(size: number): number {
  const { massRefSize } = GRAPH_RENDER_THEME.nodeSpacing;
  const { massExp } = GRAPH_RENDER_THEME.dragRelax;
  const ratio = Math.max(1e-6, size / massRefSize);
  return Math.pow(ratio, massExp);
}

/**
 * 두 노드 사이 최소 거리를 계산한다.
 * minGap = rA + rB + padding
 * @param rA - 노드 A 의 반지름
 * @param rB - 노드 B 의 반지름
 * @param padding - 두 반지름 합에 더하는 여유 간격
 * @returns 두 노드 중심 사이 최소 거리
 */
export function minGapOf(rA: number, rB: number, padding: number): number {
  return rA + rB + padding;
}
