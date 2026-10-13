/**
 * classification-filter.test.ts — Phase 11b T6 단위 검증
 *
 * 검증 묶음:
 *   1. parseClassificationFiltersFromSearchParams 양식 4 case
 *      - 빈 searchParams
 *      - 한 가지 filter (filter.character=A)
 *      - 두 category (filter.character=A&filter.style=B)
 *      - 같은 category 두 가지 (filter.character=A&filter.character=B)
 *   2. parseClassificationFiltersFromSearchParams 옛 키 자연 제외
 *      - q / limit / topK / project / polarity 자연 제외
 *   3. toRetrieverFilter 빈 배열 → undefined
 *   4. toRetrieverFilter 같은 category 두 가지 → 별 키 한 가지 한 묶음 보관
 *   5. mergeFilters 옛 body + URL 통합
 *   6. parseClassificationFiltersFromSearchParams 빈 값 / 공백 자연 제외
 *
 * Mock 0 — 순수 함수의 입력·출력 검증만 사용
 * (CLAUDE.md mock 0 정신 = 인터페이스 가짜 구현체 한정 / 함수 stub OK).
 */

import { describe, test, expect } from "bun:test";
import {
  parseClassificationFiltersFromSearchParams,
  toRetrieverFilter,
  mergeFilters,
} from "./classification-filter";

describe("parseClassificationFiltersFromSearchParams", () => {
  test("빈 searchParams → 빈 배열", () => {
    const params = new URLSearchParams("");
    expect(parseClassificationFiltersFromSearchParams(params)).toEqual([]);
  });

  test("한 가지 filter — filter.character=A", () => {
    const params = new URLSearchParams("filter.character=A");
    expect(parseClassificationFiltersFromSearchParams(params)).toEqual([
      { category: "character", value: "A" },
    ]);
  });

  test("두 category — filter.character=A&filter.style=B", () => {
    const params = new URLSearchParams(
      "filter.character=A&filter.style=B",
    );
    expect(parseClassificationFiltersFromSearchParams(params)).toEqual([
      { category: "character", value: "A" },
      { category: "style", value: "B" },
    ]);
  });

  test("같은 category 두 가지 — filter.character=A&filter.character=B", () => {
    const params = new URLSearchParams(
      "filter.character=A&filter.character=B",
    );
    const out = parseClassificationFiltersFromSearchParams(params);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ category: "character", value: "A" });
    expect(out[1]).toEqual({ category: "character", value: "B" });
  });

  test("옛 키 (q / limit / topK / project / polarity) 자연 제외", () => {
    const params = new URLSearchParams(
      "q=hello&limit=10&topK=5&project=foo&polarity=positive&filter.character=A",
    );
    expect(parseClassificationFiltersFromSearchParams(params)).toEqual([
      { category: "character", value: "A" },
    ]);
  });

  test("빈 값 / 공백 자연 제외", () => {
    const params = new URLSearchParams(
      "filter.character=&filter.style=   &filter.review=만화",
    );
    expect(parseClassificationFiltersFromSearchParams(params)).toEqual([
      { category: "review", value: "만화" },
    ]);
  });

  test("category 가 빈 키 (filter.=A) 자연 제외", () => {
    const params = new URLSearchParams("filter.=A&filter.character=B");
    expect(parseClassificationFiltersFromSearchParams(params)).toEqual([
      { category: "character", value: "B" },
    ]);
  });

  test("한글 category·value 통과", () => {
    const params = new URLSearchParams("filter.분류=만화");
    expect(parseClassificationFiltersFromSearchParams(params)).toEqual([
      { category: "분류", value: "만화" },
    ]);
  });
});

describe("toRetrieverFilter", () => {
  test("빈 배열 → undefined (옛 retriever 양식 미적용)", () => {
    expect(toRetrieverFilter([])).toBeUndefined();
  });

  test("한 가지 → 단일 키 매핑", () => {
    expect(toRetrieverFilter([{ category: "character", value: "A" }])).toEqual({
      character: "A",
    });
  });

  test("두 category → 두 키 매핑", () => {
    expect(
      toRetrieverFilter([
        { category: "character", value: "A" },
        { category: "style", value: "B" },
      ]),
    ).toEqual({ character: "A", style: "B" });
  });

  test("같은 category 두 가지 → 별 키로 보관 (Object.values 순회 시 모든 값 등장)", () => {
    const out = toRetrieverFilter([
      { category: "character", value: "A" },
      { category: "character", value: "B" },
    ]);
    expect(out).toBeDefined();
    const values = Object.values(out!);
    expect(values).toContain("A");
    expect(values).toContain("B");
    expect(values).toHaveLength(2);
  });

  test("같은 category 세 가지 → 별 키 세 개로 보관", () => {
    const out = toRetrieverFilter([
      { category: "tag", value: "1" },
      { category: "tag", value: "2" },
      { category: "tag", value: "3" },
    ]);
    expect(out).toBeDefined();
    const values = Object.values(out!);
    expect(values).toHaveLength(3);
    expect(new Set(values)).toEqual(new Set(["1", "2", "3"]));
  });
});

describe("mergeFilters", () => {
  test("둘 다 비어 있으면 → undefined", () => {
    expect(mergeFilters(undefined, [])).toBeUndefined();
    expect(mergeFilters({}, [])).toBeUndefined();
  });

  test("body 만 있음 → body 양식 보존", () => {
    expect(mergeFilters({ review: "만화" }, [])).toEqual({ review: "만화" });
  });

  test("URL 만 있음 → URL 양식 변환", () => {
    expect(
      mergeFilters(undefined, [{ category: "character", value: "A" }]),
    ).toEqual({ character: "A" });
  });

  test("body + URL 통합 — 양쪽 값 모두 등장", () => {
    const out = mergeFilters({ review: "만화" }, [
      { category: "character", value: "A" },
    ]);
    expect(out).toBeDefined();
    const values = Object.values(out!);
    expect(values).toContain("만화");
    expect(values).toContain("A");
    expect(values).toHaveLength(2);
  });

  test("body·URL 같은 category 두 가지 → 별 키 두 개로 보관", () => {
    const out = mergeFilters({ character: "A" }, [
      { category: "character", value: "B" },
    ]);
    expect(out).toBeDefined();
    const values = Object.values(out!);
    expect(values).toContain("A");
    expect(values).toContain("B");
    expect(values).toHaveLength(2);
  });
});
