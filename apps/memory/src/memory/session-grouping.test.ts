/**
 * session-grouping.test.ts — 갈래 2 순수 함수 검증.
 *
 * 데이터 fixture 만 쓴다(mock 객체 0) — 입력 배열을 넣고 출력 세션을 검증한다.
 * 핵심: 익은 세션 경계 3 케이스(정확히 G 분 전 / G 분 직전=미성숙 / G 분 직후=익음)
 * + 세션 경계(작성자·간격) + 섞인 세션 추림.
 */

import { describe, expect, test } from "bun:test";
import {
  groupSessions,
  pickMixedSessions,
  pickRipeSessions,
  type SessionNode,
} from "./session-grouping.ts";

/** 분을 밀리초로. 테스트 시각 계산 가독성용. */
function min(m: number): number {
  return m * 60_000;
}

/** 한 노드 fixture 작성 헬퍼 — 기본 메타 없음. */
function node(
  id: number,
  author: string,
  createdAtMs: number,
  meta: { place?: boolean; eventAt?: boolean } = {},
): SessionNode {
  return {
    id,
    author,
    createdAtMs,
    hasPlace: meta.place ?? false,
    hasEventAt: meta.eventAt ?? false,
  };
}

describe("groupSessions — 세션 경계(작성자·간격)", () => {
  const G = 180; // 기본 세션 간격(분).

  test("(1) 빈 입력 → 빈 배열", () => {
    expect(groupSessions([], G)).toEqual([]);
  });

  test("(2) 같은 작성자 + 간격 G 이내 연속 → 한 세션", () => {
    const base = Date.UTC(2026, 5, 1, 10, 0, 0);
    const nodes = [
      node(1, "alice", base),
      node(2, "alice", base + min(60)),
      node(3, "alice", base + min(120)),
    ];
    const sessions = groupSessions(nodes, G);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.nodes.map((n) => n.id)).toEqual([1, 2, 3]);
  });

  test("(3) 같은 작성자 + 간격 > G → 세션 끊김", () => {
    const base = Date.UTC(2026, 5, 1, 10, 0, 0);
    const nodes = [
      node(1, "alice", base),
      node(2, "alice", base + min(60)),
      // 직전과 G+1 분 떨어짐 → 새 세션.
      node(3, "alice", base + min(60) + min(G + 1)),
    ];
    const sessions = groupSessions(nodes, G);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.nodes.map((n) => n.id)).toEqual([1, 2]);
    expect(sessions[1]!.nodes.map((n) => n.id)).toEqual([3]);
  });

  test("(4) 간격이 정확히 G 분 → 같은 세션(경계 포함)", () => {
    const base = Date.UTC(2026, 5, 1, 10, 0, 0);
    const nodes = [
      node(1, "alice", base),
      node(2, "alice", base + min(G)), // 정확히 G → 안 끊김.
    ];
    const sessions = groupSessions(nodes, G);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.nodes.map((n) => n.id)).toEqual([1, 2]);
  });

  test("(5) 작성자가 다르면 같은 시각이라도 다른 세션", () => {
    const base = Date.UTC(2026, 5, 1, 10, 0, 0);
    const nodes = [
      node(1, "alice", base),
      node(2, "bob", base + min(1)),
      node(3, "alice", base + min(2)),
    ];
    const sessions = groupSessions(nodes, G);
    // alice 두 노드는 한 세션(간격 2분), bob 한 노드는 별 세션 → 총 2.
    expect(sessions).toHaveLength(2);
    const byAuthor = new Map(
      sessions.map((s) => [s.nodes[0]!.author, s.nodes.map((n) => n.id)]),
    );
    expect(byAuthor.get("alice")).toEqual([1, 3]);
    expect(byAuthor.get("bob")).toEqual([2]);
  });

  test("(6) 입력 순서가 뒤섞여도 createdAtMs 오름차순으로 정렬", () => {
    const base = Date.UTC(2026, 5, 1, 10, 0, 0);
    const nodes = [
      node(3, "alice", base + min(120)),
      node(1, "alice", base),
      node(2, "alice", base + min(60)),
    ];
    const sessions = groupSessions(nodes, G);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.nodes.map((n) => n.id)).toEqual([1, 2, 3]);
  });
});

describe("pickRipeSessions — 익은 세션 경계 3 케이스", () => {
  const G = 180;
  const base = Date.UTC(2026, 5, 1, 10, 0, 0);

  // 한 노드짜리 세션으로 마지막 글 시각 = base 를 만든다.
  const oneSession = groupSessions([node(1, "alice", base)], G);

  test("(경계 A) 마지막 글이 정확히 G 분 전 → 익음(포함)", () => {
    // now == 마지막 글 + G → 경계 포함.
    const now = base + min(G);
    const ripe = pickRipeSessions(oneSession, G, now);
    expect(ripe).toHaveLength(1);
  });

  test("(경계 B) 마지막 글이 G 분 직전(아직 G 안 지남) → 미성숙(제외)", () => {
    // now == 마지막 글 + G - 1ms → 아직 안 익음.
    const now = base + min(G) - 1;
    const ripe = pickRipeSessions(oneSession, G, now);
    expect(ripe).toHaveLength(0);
  });

  test("(경계 C) 마지막 글이 G 분 직후(G 지남) → 익음(포함)", () => {
    // now == 마지막 글 + G + 1ms → 익음.
    const now = base + min(G) + 1;
    const ripe = pickRipeSessions(oneSession, G, now);
    expect(ripe).toHaveLength(1);
  });

  test("(혼합) 진행 중 세션은 빠지고 닫힌 세션만 남음", () => {
    // 닫힌 세션(마지막 글 한참 전) + 진행 중 세션(방금 글) 두 개.
    const closed = node(1, "alice", base);
    const ongoingLast = base + min(1000); // 한참 뒤 다른 작성자(끊김 보장).
    const ongoing = node(2, "bob", ongoingLast);
    const sessions = groupSessions([closed, ongoing], G);
    // now = ongoing 글 직후(아직 G 안 지남) → ongoing 미성숙 / closed 익음.
    const now = ongoingLast + min(1);
    const ripe = pickRipeSessions(sessions, G, now);
    expect(ripe).toHaveLength(1);
    expect(ripe[0]!.nodes[0]!.id).toBe(1);
  });

  test("(세션 끝 글 기준) 마지막 글만 보고 익음 판정 — 앞 글은 무관", () => {
    // 한 세션 안 첫 글은 한참 전, 마지막 글은 아직 G 안 지남 → 세션 전체 미성숙.
    const first = node(1, "alice", base);
    const last = node(2, "alice", base + min(60));
    const sessions = groupSessions([first, last], G);
    expect(sessions).toHaveLength(1);
    const now = base + min(60) + min(G) - 1; // last + G 직전.
    expect(pickRipeSessions(sessions, G, now)).toHaveLength(0);
  });
});

describe("pickMixedSessions — 섞인 세션 추림", () => {
  const G = 180;
  const base = Date.UTC(2026, 5, 1, 10, 0, 0);

  function sessionOf(nodes: SessionNode[]) {
    return groupSessions(nodes, G);
  }

  test("(1) 메타 있음 ≥1 + 없음 ≥1 → 추려짐", () => {
    const nodes = [
      node(1, "alice", base, { place: true }),
      node(2, "alice", base + min(10)),
    ];
    const mixed = pickMixedSessions(sessionOf(nodes));
    expect(mixed).toHaveLength(1);
  });

  test("(2) 전부 메타 있음 → 제외(전파할 빈 칸 없음)", () => {
    const nodes = [
      node(1, "alice", base, { place: true }),
      node(2, "alice", base + min(10), { eventAt: true }),
    ];
    expect(pickMixedSessions(sessionOf(nodes))).toHaveLength(0);
  });

  test("(3) 전부 메타 없음 → 제외(전파해 줄 근거 없음)", () => {
    const nodes = [
      node(1, "alice", base),
      node(2, "alice", base + min(10)),
    ];
    expect(pickMixedSessions(sessionOf(nodes))).toHaveLength(0);
  });

  test("(4) event_at 만 있어도 '메타 있음' 으로 침", () => {
    const nodes = [
      node(1, "alice", base, { eventAt: true }),
      node(2, "alice", base + min(10)),
    ];
    expect(pickMixedSessions(sessionOf(nodes))).toHaveLength(1);
  });

  test("(5) 여러 세션 중 섞인 것만 추려짐", () => {
    // 세션 X(섞임) + 세션 Y(전부 빔) 두 개.
    const xNodes = [
      node(1, "alice", base, { place: true }),
      node(2, "alice", base + min(10)),
    ];
    const yNodes = [
      node(3, "bob", base + min(1000)),
      node(4, "bob", base + min(1010)),
    ];
    const sessions = groupSessions([...xNodes, ...yNodes], G);
    const mixed = pickMixedSessions(sessions);
    expect(mixed).toHaveLength(1);
    expect(mixed[0]!.nodes.map((n) => n.id).sort()).toEqual([1, 2]);
  });
});
