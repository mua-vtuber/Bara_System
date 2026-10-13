/**
 * neighbor-chunks 묶기 조립 테스트 (Phase 14b T2 / 14.5).
 *
 * 순수 후처리 모듈 검증 — DB·store·임베딩 의존 0. 데이터 fixture(청크 배열)를
 * 입력해 출력을 단언한다(CLAUDE.md 테스트 정책 — mock 객체 금지, fixture 허용).
 *
 * 검증 축:
 *  ① 한도가 크면 인접 청크 전부 묶인다.
 *  ② 한도가 작으면 중심 기준 앞·뒤 번갈아 greedy 로 일부만 묶고 넘기 직전 멈춘다.
 *  ③ parentId(또는 chunkIndex) 없는 입력 → 빈 neighbors + documentRef: null.
 *  ④ maxContextTokens 0 이하 → 빈 neighbors(절제 극단도 정직).
 *
 * 토큰 경계는 estimateTokens 로 직접 계산해 단언한다(새 추정기 만들지 않음).
 */

import { describe, expect, test } from "bun:test";

import {
  assembleNeighborContext,
  DEFAULT_MAX_CONTEXT_TOKENS,
} from "./neighbor-chunks.ts";
import { estimateTokens } from "./token-counter.ts";

/** chunkIndex 만 다른 인접 청크 fixture 한 묶음을 만든다. */
function makeNeighbors(
  entries: Array<{ id: number; chunkIndex: number; content: string }>,
): Array<{ id: number; chunkIndex: number; content: string }> {
  return entries;
}

describe("assembleNeighborContext — 묶기 조립", () => {
  test("① 한도가 크면 인접 청크 전부 묶인다 (chunkIndex 오름차순)", () => {
    const center = { content: "중심 청크 내용 가나다", parentId: "doc-1", chunkIndex: 2 };
    const neighbors = makeNeighbors([
      { id: 10, chunkIndex: 0, content: "앞앞 청크" },
      { id: 11, chunkIndex: 1, content: "앞 청크" },
      { id: 12, chunkIndex: 3, content: "뒤 청크" },
      { id: 13, chunkIndex: 4, content: "뒤뒤 청크" },
    ]);

    const out = assembleNeighborContext({
      center,
      neighbors,
      maxContextTokens: 100000,
    });

    expect(out.documentRef).toEqual({ parentId: "doc-1", centerIndex: 2 });
    // 인접 전부 + chunkIndex 오름차순.
    expect(out.neighbors.map((n) => n.chunkIndex)).toEqual([0, 1, 3, 4]);
    expect(out.neighbors.map((n) => n.id)).toEqual([10, 11, 12, 13]);
  });

  test("② 한도가 작으면 앞·뒤 번갈아 greedy 로 일부만 묶고 넘기 직전 멈춘다", () => {
    // 각 인접 청크를 동일 토큰 크기로 둔다 — 번갈아 순서를 결정적으로 검증.
    // "가나다라마" = CJK 5글자 → estimateTokens = 10 토큰.
    const unit = "가나다라마";
    const unitTokens = estimateTokens(unit);
    expect(unitTokens).toBe(10);

    const center = { content: "중심", parentId: "doc-9", chunkIndex: 5 };
    const neighbors = makeNeighbors([
      { id: 1, chunkIndex: 3, content: unit }, // 앞앞 (거리 2)
      { id: 2, chunkIndex: 4, content: unit }, // 앞   (거리 1)
      { id: 3, chunkIndex: 6, content: unit }, // 뒤   (거리 1)
      { id: 4, chunkIndex: 7, content: unit }, // 뒤뒤 (거리 2)
    ]);

    // 한도 = 정확히 청크 2개분(20) — 3개째(30)를 넘기 직전 멈춘다.
    const out = assembleNeighborContext({
      center,
      neighbors,
      maxContextTokens: unitTokens * 2,
    });

    // 번갈아: 거리 1 앞(4) → 거리 1 뒤(6) → (다음은 한도 초과라 멈춤).
    // 묶인 둘은 최종 chunkIndex 오름차순 정렬로 회신.
    expect(out.neighbors.map((n) => n.chunkIndex)).toEqual([4, 6]);
    expect(out.documentRef).toEqual({ parentId: "doc-9", centerIndex: 5 });

    // 누적 토큰이 한도를 넘지 않음을 단언.
    const total = out.neighbors.reduce(
      (sum, n) => sum + estimateTokens(n.content),
      0,
    );
    expect(total).toBeLessThanOrEqual(unitTokens * 2);
  });

  test("②-b 한 칸만 들어갈 한도면 가장 가까운 한 칸(앞 우선)만 묶는다", () => {
    const unit = "가나다라마";
    const unitTokens = estimateTokens(unit);

    const center = { content: "중심", parentId: "doc-9", chunkIndex: 5 };
    const neighbors = makeNeighbors([
      { id: 2, chunkIndex: 4, content: unit }, // 거리 1 앞
      { id: 3, chunkIndex: 6, content: unit }, // 거리 1 뒤
    ]);

    // 한도 = 청크 1개분 — 두 번째를 넘기 직전 멈춤. 번갈아 시작은 앞쪽.
    const out = assembleNeighborContext({
      center,
      neighbors,
      maxContextTokens: unitTokens,
    });

    expect(out.neighbors.map((n) => n.chunkIndex)).toEqual([4]);
  });

  test("③ parentId 없는 입력 → 빈 neighbors + documentRef null", () => {
    const out = assembleNeighborContext({
      center: { content: "일반 메모리 노드", parentId: null, chunkIndex: null },
      neighbors: [{ id: 1, chunkIndex: 0, content: "딸린 게 있어도" }],
      maxContextTokens: 100000,
    });
    expect(out.neighbors).toEqual([]);
    expect(out.documentRef).toBeNull();
  });

  test("③-b chunkIndex 없는 입력 → 빈 neighbors + documentRef null", () => {
    const out = assembleNeighborContext({
      center: { content: "노드", parentId: "doc-1", chunkIndex: null },
      neighbors: [{ id: 1, chunkIndex: 0, content: "x" }],
      maxContextTokens: 100000,
    });
    expect(out.neighbors).toEqual([]);
    expect(out.documentRef).toBeNull();
  });

  test("④ maxContextTokens 0 이하 → 빈 neighbors (documentRef 는 유효 청크라 채움)", () => {
    const center = { content: "중심", parentId: "doc-1", chunkIndex: 2 };
    const neighbors = makeNeighbors([
      { id: 1, chunkIndex: 1, content: "앞" },
      { id: 2, chunkIndex: 3, content: "뒤" },
    ]);

    const zero = assembleNeighborContext({ center, neighbors, maxContextTokens: 0 });
    expect(zero.neighbors).toEqual([]);
    expect(zero.documentRef).toEqual({ parentId: "doc-1", centerIndex: 2 });

    const neg = assembleNeighborContext({ center, neighbors, maxContextTokens: -5 });
    expect(neg.neighbors).toEqual([]);
  });

  test("빈 인접 배열 → 빈 neighbors + 유효 documentRef", () => {
    const out = assembleNeighborContext({
      center: { content: "중심", parentId: "doc-7", chunkIndex: 0 },
      neighbors: [],
      maxContextTokens: 100000,
    });
    expect(out.neighbors).toEqual([]);
    expect(out.documentRef).toEqual({ parentId: "doc-7", centerIndex: 0 });
  });

  test("maxContextTokens 생략 시 DEFAULT_MAX_CONTEXT_TOKENS(2000) 적용", () => {
    expect(DEFAULT_MAX_CONTEXT_TOKENS).toBe(2000);
    const center = { content: "중심", parentId: "doc-1", chunkIndex: 1 };
    const neighbors = makeNeighbors([
      { id: 1, chunkIndex: 0, content: "앞 작은 청크" },
      { id: 2, chunkIndex: 2, content: "뒤 작은 청크" },
    ]);
    // 작은 청크 둘 → 2000 안에 전부 들어감.
    const out = assembleNeighborContext({ center, neighbors });
    expect(out.neighbors.map((n) => n.chunkIndex)).toEqual([0, 2]);
  });
});
