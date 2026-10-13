/** search-result-filter.test.ts — 삭제 후 검색 결과 목록 정직성 필터 검증 (T4 fix). */

import { describe, expect, test } from "bun:test";
import { removeTrashedFromSearch } from "./search-result-filter.ts";
import type { SearchResponse, SearchResult } from "./types.ts";

function hit(id: number): SearchResult {
  return {
    id,
    content: `기억 #${id}`,
    score: 0.5,
    sources: ["vector"],
    components: { vector: 0.5 },
  };
}

function search(ids: number[]): SearchResponse {
  const results = ids.map(hit);
  return { query: "테스트", count: results.length, results };
}

describe("removeTrashedFromSearch", () => {
  test("search 가 없으면(검색 중 아님) null 을 그대로 돌려준다 — no-op", () => {
    expect(removeTrashedFromSearch(null, 1, [])).toBeNull();
  });

  test("trashed id 를 결과에서 제거하고 count 를 맞춘다", () => {
    const s = search([1, 2, 3]);
    const next = removeTrashedFromSearch(s, 2, []);
    expect(next?.results.map((r) => r.id)).toEqual([1, 3]);
    expect(next?.count).toBe(2);
  });

  test("cascade id 들도 함께 제거한다", () => {
    const s = search([1, 2, 3, 4]);
    const next = removeTrashedFromSearch(s, 1, [3, 4]);
    expect(next?.results.map((r) => r.id)).toEqual([2]);
    expect(next?.count).toBe(1);
  });

  test("검색 결과에 없는 id 를 지워도 나머지는 그대로 남는다", () => {
    const s = search([1, 2, 3]);
    const next = removeTrashedFromSearch(s, 99, [98]);
    expect(next?.results.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(next?.count).toBe(3);
  });

  test("제거 대상이 하나도 없으면 원본과 동치인 객체를 돌려준다(참조 재사용 아니어도 무방)", () => {
    const s = search([5, 6]);
    const next = removeTrashedFromSearch(s, 5 + 1000, []);
    expect(next?.results).toEqual(s.results);
    expect(next?.count).toBe(s.count);
  });
});
