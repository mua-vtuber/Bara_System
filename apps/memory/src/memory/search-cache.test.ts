/**
 * search-cache.test.ts — RRF 검색 결과 캐시 순수 모듈 (Phase 6b R4 / T2).
 *
 * 순수 함수·순수 자료구조 검증(데이터 입력→출력) — mock 0. 캐시 값은 실제
 * RetrievalResult 모양 fixture 를 직접 작성해 입력한다(인터페이스 가짜 구현체
 * 없음). TTL 만료는 캐시 생성자에 짧은 ttlMs 를 주입해 검증하고, LRU 축출은
 * bound 를 작게 주입해 가장 오래된 칸이 빠지는지 확인한다.
 *
 * 핵심 단언:
 *   (a) reranker 상태만 바뀌어도 키가 달라진다(spec 10.2.2 — 토글 시 stale 회피).
 *   (b) TTL 만료 후 get 은 undefined 를 돌려주고 그 칸을 삭제한다.
 *   (c) invalidateAll 후 size 는 0.
 *   (d) LRU bound 초과 시 가장 오래 전에 넣은 칸이 축출된다.
 */
import { describe, expect, test } from "bun:test";
import type { RetrievalResult } from "./retriever.ts";
import {
  SearchCache,
  buildCacheKey,
  type CachedSearch,
  type SearchCacheKeyInput,
} from "./search-cache.ts";

// ── fixtures (데이터 입력→출력 — 인터페이스 가짜 구현체 없음) ──────────────────

/** 최소 RetrievalResult fixture. reranker *이전* 점수 결과 한 칸. */
function makeResult(id: number, score: number): RetrievalResult {
  return {
    node: {
      id,
      content: `노드 ${id}`,
      memoryType: "fact",
      sourceType: "user_explicit",
      author: "tester",
      platform: "test",
      importance: 0.5,
      confidence: 0.9,
      createdAt: "2026-05-27T00:00:00Z",
      updatedAt: null,
      lastAccessedAt: "2026-05-27T00:00:00Z",
      accessCount: 0,
      mentionCount: 0,
      lastMentionedAt: null,
      metadata: {},
      polarity: null,
      eventAt: null,
      eventUntil: null,
      projectId: null,
    },
    score,
    sources: ["vector", "fts"],
    components: {
      rrf: score,
      boostedRrf: score,
      bm25Cross: 0,
      recency: 0,
      importance: 0.5,
      mentionBoost: 0,
      supersedePenalty: 1.0,
      precisionStrength: 0,
      cueGraphBoost: 1.0,
    },
  };
}

/**
 * T10 — CachedSearch.stats 가 required 로 바뀌어(SearchCache 는 in-process Map 이라
 * 재시작 시 항상 비므로 optional 일 이유가 없다) 이 파일의 모든 캐시 값 fixture 가
 * stats 를 함께 담아야 한다. 이 helper 로 한 곳에서 채운다 — 이 테스트 파일은
 * SearchCache 순수 자료구조(TTL·LRU·키 식별) 검증이 목적이라 stats 실제 숫자는
 * 임의값으로 충분하다(retriever 통합 stats 정확성은 retriever.test.ts / search-service
 * 통합 테스트가 검증).
 */
function makeCached(results: RetrievalResult[]): CachedSearch {
  return { results, stats: { totalFound: results.length, afterFiltering: results.length } };
}

/** 기준 캐시 키 입력 — 각 테스트가 한 요소만 바꿔 키 차이를 본다. */
function baseKeyInput(): SearchCacheKeyInput {
  return {
    query: "테스트 질의",
    channels: { vector: true, fts: true, graph: true, concept: true },
    weights: { rrf: 0.7, bm25: 0.3 },
    polarity: undefined,
    projectId: undefined,
    include: [],
    reranker: { enabled: false, topK_input: 30, topK_output: 10 },
    dbRevision: 1,
    // 라우트가 결과를 가르는 12칸(M10·T3) — 미지정 옵션은 undefined(buildCacheKey 가
    // null 로 고정 토큰화). limit·contextBudget 는 필수 칸이라 기준값을 둔다.
    limit: 10,
    contextBudget: 0,
    imageSearch: false,
    imageVecBoost: undefined,
    precisionStrengthWeight: undefined,
    baselineFloorMode: undefined,
    baselineVectorCosine: undefined,
    baselineImageVecCosine: undefined,
    dateRange: undefined,
    memoryType: undefined,
    placeValue: undefined,
    kind: undefined,
    fieldFilters: undefined,
    fallbackPass: undefined,
  };
}

/**
 * 옛 suffix 방식 키 생성기(M10·T3 회귀 증명용 — 데이터 fixture 함수, 인터페이스
 * 가짜 구현체 아님).
 *
 * T3 이전 라우트는 buildCacheKey 의 8요소 직렬화 뒤에 12개 식별 값을 파이프 문자열
 * suffix 로 이어 붙였다(search.ts:443 옛 한 줄). 이 함수는 그 옛 합성식을 그대로
 * 재현한다. 8요소 부분은 옛 buildCacheKey 의 normalized 구조(키 이름 q·ch·w·pol·
 * proj·inc·rr·rev / undefined 칸은 ?? null)를 stableStringify 로 직렬화한 그 모양이고,
 * 거기에 옛 suffix 를 붙인다.
 *
 * 증명 목표: 두 방식이 같은 *동치류* 를 만든다 = 임의의 입력 쌍 (A,B)에 대해
 *   legacyKey(A)===legacyKey(B)  ⟺  buildCacheKey(A)===buildCacheKey(B).
 * 절대 문자열이 같을 필요는 없다(suffix vs 구조체라 형태는 다르다) — 어떤 두 입력을
 * 같다고/다르다고 판정하는지(hit/miss)가 같으면 캐시 동작이 동일하다.
 */
function legacyKey(input: SearchCacheKeyInput): string {
  // 옛 8요소 — 옛 buildCacheKey 의 식별값을 고정 순서 객체로 결정적 직렬화한다.
  // 절대 문자열 재현이 목적이 아니라 동치류 판별이 목적이라(아래 describe 설명),
  // 8칸을 빠짐없이·결정적으로 직렬화하기만 하면 된다(채널·가중치·reranker 는 칸
  // 작성 순서가 고정이라 JSON.stringify 가 결정적). undefined 칸은 ?? null 로 고정.
  const core = JSON.stringify({
    q: input.query.trim().toLowerCase(),
    ch: {
      vector: input.channels.vector,
      fts: input.channels.fts,
      graph: input.channels.graph,
      concept: input.channels.concept,
    },
    w: { rrf: input.weights.rrf, bm25: input.weights.bm25 },
    pol: input.polarity ?? null,
    proj: input.projectId ?? null,
    inc: [...input.include].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    rr: {
      enabled: input.reranker.enabled,
      topK_input: input.reranker.topK_input,
      topK_output: input.reranker.topK_output,
    },
    rev: input.dbRevision,
  });
  // 옛 suffix(search.ts:443) — 12개 식별 값 + 폴백 패스(옛 '|fb:1').
  const ff = input.fieldFilters
    ? input.fieldFilters
        .map((f) => `${f.key}=${f.value}`)
        .sort()
        .join(",")
    : "none";
  const suffix =
    `|limit:${input.limit}|ctx:${input.contextBudget}` +
    `|imgSearch:${input.imageSearch ? "1" : "0"}` +
    `|imgBoost:${input.imageVecBoost ?? "default"}` +
    `|precW:${input.precisionStrengthWeight ?? "default"}` +
    `|blMode:${input.baselineFloorMode ?? "default"}` +
    `|blVec:${input.baselineVectorCosine ?? "default"}` +
    `|blImg:${input.baselineImageVecCosine ?? "default"}` +
    `|dr:${input.dateRange ? `${input.dateRange.since}~${input.dateRange.until}` : "none"}` +
    `|mtype:${input.memoryType ?? "none"}` +
    `|place:${input.placeValue ?? "none"}` +
    `|kind:${input.kind ?? "none"}` +
    `|ff:${ff}` +
    (input.fallbackPass ? "|fb:1" : "");
  return core + suffix;
}

describe("buildCacheKey — 21차원 결정적 직렬화", () => {
  test("같은 입력 → 같은 키", () => {
    expect(buildCacheKey(baseKeyInput())).toBe(buildCacheKey(baseKeyInput()));
  });

  test("query 정규화 — 앞뒤 공백·대소문자 무시 후 같은 키", () => {
    const a = { ...baseKeyInput(), query: "  Hello World  " };
    const b = { ...baseKeyInput(), query: "hello world" };
    expect(buildCacheKey(a)).toBe(buildCacheKey(b));
  });

  test("(a) reranker.enabled 만 바뀌어도 키가 달라진다", () => {
    const off = baseKeyInput();
    const on = {
      ...baseKeyInput(),
      reranker: { enabled: true, topK_input: 30, topK_output: 10 },
    };
    expect(buildCacheKey(off)).not.toBe(buildCacheKey(on));
  });

  test("reranker.topK_input / topK_output 가 바뀌어도 키가 달라진다", () => {
    const base = baseKeyInput();
    const diffInput = {
      ...base,
      reranker: { enabled: false, topK_input: 50, topK_output: 10 },
    };
    const diffOutput = {
      ...base,
      reranker: { enabled: false, topK_input: 30, topK_output: 5 },
    };
    expect(buildCacheKey(base)).not.toBe(buildCacheKey(diffInput));
    expect(buildCacheKey(base)).not.toBe(buildCacheKey(diffOutput));
  });

  test("dbRevision 이 바뀌면 키가 달라진다", () => {
    const a = baseKeyInput();
    const b = { ...baseKeyInput(), dbRevision: 2 };
    expect(buildCacheKey(a)).not.toBe(buildCacheKey(b));
  });

  test("channels / weights / polarity / projectId / include 각각 키에 반영", () => {
    const base = buildCacheKey(baseKeyInput());
    expect(
      buildCacheKey({
        ...baseKeyInput(),
        channels: { vector: false, fts: true, graph: true, concept: true },
      }),
    ).not.toBe(base);
    expect(
      buildCacheKey({ ...baseKeyInput(), weights: { rrf: 0.5, bm25: 0.5 } }),
    ).not.toBe(base);
    expect(
      buildCacheKey({ ...baseKeyInput(), polarity: "positive" }),
    ).not.toBe(base);
    expect(
      buildCacheKey({ ...baseKeyInput(), projectId: "proj-a" }),
    ).not.toBe(base);
    expect(
      buildCacheKey({ ...baseKeyInput(), include: ["만화"] }),
    ).not.toBe(base);
  });

  test("객체 키 순서가 달라도 같은 키 (정렬 후 직렬화)", () => {
    const a: SearchCacheKeyInput = {
      ...baseKeyInput(),
      channels: { vector: true, fts: true, graph: true, concept: true },
      weights: { rrf: 0.7, bm25: 0.3 },
    };
    // 같은 의미인데 객체 리터럴 작성 순서만 뒤집은 입력.
    const b: SearchCacheKeyInput = {
      ...baseKeyInput(),
      channels: { concept: true, graph: true, fts: true, vector: true },
      weights: { bm25: 0.3, rrf: 0.7 },
    };
    expect(buildCacheKey(a)).toBe(buildCacheKey(b));
  });

  test("include 원소 순서가 달라도 같은 키 (정렬 후 직렬화)", () => {
    const a = { ...baseKeyInput(), include: ["만화", "애니"] };
    const b = { ...baseKeyInput(), include: ["애니", "만화"] };
    expect(buildCacheKey(a)).toBe(buildCacheKey(b));
  });
});

// ── M10·T3: 라우트 식별 12칸 + 폴백 패스 각각이 키를 가른다 ────────────────────
// 옛 suffix 시절엔 새 식별 값을 더할 때 합성 한 줄을 잊으면 서로 다른 검색이 같은
// 키로 충돌해 캐시 오적중이 났다. 구조체 통일 후 12칸 각각이 키에 반영됨을 빠짐없이
// 증명한다(plan T3 AC3 — "한 식별 값만 다르면 키가 달라진다를 12개 값 각각 확인").
describe("buildCacheKey — 라우트 식별 12칸 + 폴백 패스 각각이 키를 가른다", () => {
  test("limit 만 바뀌어도 키가 달라진다", () => {
    expect(buildCacheKey(baseKeyInput())).not.toBe(
      buildCacheKey({ ...baseKeyInput(), limit: 50 }),
    );
  });

  test("contextBudget 만 바뀌어도 키가 달라진다", () => {
    expect(buildCacheKey(baseKeyInput())).not.toBe(
      buildCacheKey({ ...baseKeyInput(), contextBudget: 2000 }),
    );
  });

  test("imageVecBoost 만 바뀌어도 키가 달라진다", () => {
    expect(buildCacheKey(baseKeyInput())).not.toBe(
      buildCacheKey({ ...baseKeyInput(), imageVecBoost: 1.5 }),
    );
  });

  test("imageVecBoost 0 과 미지정(undefined)은 다른 키 (0 은 유효 오버라이드)", () => {
    // ?? null 은 nullish 병합이라 0 은 살아남고 undefined 만 null 이 된다. 0(boost
    // 끔)과 미지정(retriever default)은 검색 점수가 다를 수 있어 다른 키여야 한다.
    expect(buildCacheKey({ ...baseKeyInput(), imageVecBoost: 0 })).not.toBe(
      buildCacheKey({ ...baseKeyInput(), imageVecBoost: undefined }),
    );
  });

  test("precisionStrengthWeight 만 바뀌어도 키가 달라진다", () => {
    expect(buildCacheKey(baseKeyInput())).not.toBe(
      buildCacheKey({ ...baseKeyInput(), precisionStrengthWeight: 0.3 }),
    );
  });

  test("baselineFloorMode 만 바뀌어도 키가 달라진다", () => {
    expect(buildCacheKey(baseKeyInput())).not.toBe(
      buildCacheKey({ ...baseKeyInput(), baselineFloorMode: "tmm-min" }),
    );
  });

  test("baselineVectorCosine 만 바뀌어도 키가 달라진다", () => {
    expect(buildCacheKey(baseKeyInput())).not.toBe(
      buildCacheKey({ ...baseKeyInput(), baselineVectorCosine: 0.5 }),
    );
  });

  test("baselineImageVecCosine 만 바뀌어도 키가 달라진다", () => {
    expect(buildCacheKey(baseKeyInput())).not.toBe(
      buildCacheKey({ ...baseKeyInput(), baselineImageVecCosine: 0.1 }),
    );
  });

  test("dateRange 만 바뀌어도 키가 달라진다", () => {
    expect(buildCacheKey(baseKeyInput())).not.toBe(
      buildCacheKey({
        ...baseKeyInput(),
        dateRange: { since: "2026-01-01", until: "2026-01-31" },
      }),
    );
  });

  test("dateRange 의 since/until 한쪽만 달라도 키가 달라진다", () => {
    const a = {
      ...baseKeyInput(),
      dateRange: { since: "2026-01-01", until: "2026-01-31" },
    };
    const b = {
      ...baseKeyInput(),
      dateRange: { since: "2026-01-01", until: "2026-02-28" },
    };
    expect(buildCacheKey(a)).not.toBe(buildCacheKey(b));
  });

  test("memoryType 만 바뀌어도 키가 달라진다", () => {
    expect(buildCacheKey(baseKeyInput())).not.toBe(
      buildCacheKey({ ...baseKeyInput(), memoryType: "preference" }),
    );
  });

  test("placeValue 만 바뀌어도 키가 달라진다", () => {
    expect(buildCacheKey(baseKeyInput())).not.toBe(
      buildCacheKey({ ...baseKeyInput(), placeValue: "강남" }),
    );
  });

  test("kind 만 바뀌어도 키가 달라진다", () => {
    expect(buildCacheKey(baseKeyInput())).not.toBe(
      buildCacheKey({ ...baseKeyInput(), kind: "creature" }),
    );
  });

  test("fieldFilters 만 바뀌어도 키가 달라진다", () => {
    expect(buildCacheKey(baseKeyInput())).not.toBe(
      buildCacheKey({
        ...baseKeyInput(),
        fieldFilters: [{ key: "장르", value: "공포" }],
      }),
    );
  });

  test("fieldFilters 원소 순서가 달라도 같은 키 (정렬 후 직렬화)", () => {
    const a = {
      ...baseKeyInput(),
      fieldFilters: [
        { key: "장르", value: "공포" },
        { key: "갈래", value: "액션" },
      ],
    };
    const b = {
      ...baseKeyInput(),
      fieldFilters: [
        { key: "갈래", value: "액션" },
        { key: "장르", value: "공포" },
      ],
    };
    expect(buildCacheKey(a)).toBe(buildCacheKey(b));
  });

  test("fieldFilters 값(value)이 달라지면 키가 달라진다", () => {
    const a = {
      ...baseKeyInput(),
      fieldFilters: [{ key: "장르", value: "공포" }],
    };
    const b = {
      ...baseKeyInput(),
      fieldFilters: [{ key: "장르", value: "액션" }],
    };
    expect(buildCacheKey(a)).not.toBe(buildCacheKey(b));
  });

  test("fallbackPass 만 바뀌어도 키가 달라진다 (옛 '|fb:1' 흡수)", () => {
    // 1차(좁힌) 검색과 0건 폴백(칸 제거) 검색이 다른 키로 가야 섞이지 않는다(D6).
    expect(buildCacheKey(baseKeyInput())).not.toBe(
      buildCacheKey({ ...baseKeyInput(), fallbackPass: true }),
    );
  });
});

// ── M10·T3: 옛 suffix 방식 ↔ 새 구조체 방식 hit/miss 판정 동등성 ──────────────
// plan T3 AC3 핵심. 두 방식의 절대 키 문자열은 다르지만(suffix 합성 vs 구조체
// 직렬화), 어떤 두 입력을 같다고/다르다고 판정하는지(= 캐시 hit/miss 동치류)는
// 같아야 한다. 임의의 입력 쌍 (A,B)에 대해
//   legacyKey(A)===legacyKey(B)  ⟺  buildCacheKey(A)===buildCacheKey(B)
// 를 입력 변형 목록 전 쌍에 대해 확인한다. 한 변형이라도 한쪽 방식만 키를 가르면
// (옛 suffix 누락 같은 결함) 이 동등성이 깨진다.
describe("buildCacheKey ↔ 옛 suffix 방식 hit/miss 판정 동등성", () => {
  // 21개 식별 차원을 한 칸씩 바꾼 입력 변형 목록 + 순서 무관 변형 + 폴백 패스 변형.
  // base 와 같은 칸(예: 같은 dateRange 두 표현)도 일부 섞어 "같다고 판정" 도 본다.
  function variants(): SearchCacheKeyInput[] {
    return [
      baseKeyInput(),
      { ...baseKeyInput() }, // base 와 동일(같다고 판정돼야 함)
      { ...baseKeyInput(), query: "  테스트 질의  " }, // 정규화 후 base 와 동일
      { ...baseKeyInput(), query: "다른 질의" },
      {
        ...baseKeyInput(),
        channels: { vector: false, fts: true, graph: true, concept: true },
      },
      { ...baseKeyInput(), weights: { rrf: 0.5, bm25: 0.5 } },
      { ...baseKeyInput(), polarity: "positive" },
      { ...baseKeyInput(), projectId: "proj-a" },
      { ...baseKeyInput(), include: ["만화"] },
      { ...baseKeyInput(), include: ["애니", "만화"] }, // 정렬로 ["만화","애니"]와 동일
      { ...baseKeyInput(), include: ["만화", "애니"] },
      {
        ...baseKeyInput(),
        reranker: { enabled: true, topK_input: 30, topK_output: 10 },
      },
      { ...baseKeyInput(), dbRevision: 2 },
      { ...baseKeyInput(), limit: 50 },
      { ...baseKeyInput(), contextBudget: 2000 },
      { ...baseKeyInput(), imageSearch: true },
      { ...baseKeyInput(), imageVecBoost: 1.5 },
      { ...baseKeyInput(), imageVecBoost: 0 }, // 0 ≠ undefined
      { ...baseKeyInput(), precisionStrengthWeight: 0.3 },
      { ...baseKeyInput(), baselineFloorMode: "tmm-min" },
      { ...baseKeyInput(), baselineFloorMode: "off" },
      { ...baseKeyInput(), baselineVectorCosine: 0.5 },
      { ...baseKeyInput(), baselineImageVecCosine: 0.1 },
      {
        ...baseKeyInput(),
        dateRange: { since: "2026-01-01", until: "2026-01-31" },
      },
      {
        ...baseKeyInput(),
        dateRange: { since: "2026-01-01", until: "2026-02-28" },
      },
      { ...baseKeyInput(), memoryType: "preference" },
      { ...baseKeyInput(), placeValue: "강남" },
      { ...baseKeyInput(), kind: "creature" },
      {
        ...baseKeyInput(),
        fieldFilters: [{ key: "장르", value: "공포" }],
      },
      {
        ...baseKeyInput(),
        fieldFilters: [
          { key: "장르", value: "공포" },
          { key: "갈래", value: "액션" },
        ],
      },
      {
        ...baseKeyInput(),
        fieldFilters: [
          { key: "갈래", value: "액션" },
          { key: "장르", value: "공포" },
        ],
      }, // 위와 순서만 다름 — 둘 다 같다고 판정돼야 함
      { ...baseKeyInput(), fallbackPass: true },
    ];
  }

  test("전 입력 쌍에서 두 방식의 hit/miss 판정(같음/다름)이 일치한다", () => {
    const vs = variants();
    for (let i = 0; i < vs.length; i++) {
      for (let j = 0; j < vs.length; j++) {
        const legacySame = legacyKey(vs[i]!) === legacyKey(vs[j]!);
        const structSame = buildCacheKey(vs[i]!) === buildCacheKey(vs[j]!);
        // 두 방식이 같은 동치류 — 한쪽만 같다고/다르다고 판정하면 FAIL(누락 결함).
        expect(structSame).toBe(legacySame);
      }
    }
  });

  test("같은 입력은 두 방식 모두 같은 키 (hit)", () => {
    const a = baseKeyInput();
    const b = { ...baseKeyInput() };
    expect(legacyKey(a)).toBe(legacyKey(b));
    expect(buildCacheKey(a)).toBe(buildCacheKey(b));
  });

  test("12칸 각 변형은 두 방식 모두 base 와 다른 키 (miss)", () => {
    const base = baseKeyInput();
    const diffs: SearchCacheKeyInput[] = [
      { ...base, limit: 50 },
      { ...base, contextBudget: 2000 },
      { ...base, imageSearch: true },
      { ...base, imageVecBoost: 1.5 },
      { ...base, precisionStrengthWeight: 0.3 },
      { ...base, baselineFloorMode: "tmm-min" },
      { ...base, baselineVectorCosine: 0.5 },
      { ...base, baselineImageVecCosine: 0.1 },
      { ...base, dateRange: { since: "2026-01-01", until: "2026-01-31" } },
      { ...base, memoryType: "preference" },
      { ...base, placeValue: "강남" },
      { ...base, kind: "creature" },
      { ...base, fieldFilters: [{ key: "장르", value: "공포" }] },
    ];
    for (const d of diffs) {
      expect(legacyKey(d)).not.toBe(legacyKey(base));
      expect(buildCacheKey(d)).not.toBe(buildCacheKey(base));
    }
  });
});

describe("SearchCache — TTL + LRU + invalidate", () => {
  test("set → get 같은 키면 동일 결과 반환 (캐시 hit)", () => {
    const cache = new SearchCache();
    const key = buildCacheKey(baseKeyInput());
    const value: CachedSearch = makeCached([makeResult(1, 0.9), makeResult(2, 0.5)]);
    cache.set(key, value);
    const got = cache.get(key);
    expect(got).toBeDefined();
    expect(got).toBe(value);
    expect(got!.results).toHaveLength(2);
    expect(got!.results[0]!.score).toBe(0.9);
  });

  test("reranker 토글로 키가 바뀌면 캐시 miss", () => {
    const cache = new SearchCache();
    const offKey = buildCacheKey(baseKeyInput());
    cache.set(offKey, makeCached([makeResult(1, 0.9)]));
    const onKey = buildCacheKey({
      ...baseKeyInput(),
      reranker: { enabled: true, topK_input: 30, topK_output: 10 },
    });
    expect(cache.get(onKey)).toBeUndefined();
    expect(cache.get(offKey)).toBeDefined();
  });

  test("(b) TTL 만료 후 get 은 undefined + 칸 삭제", async () => {
    const cache = new SearchCache({ ttlMs: 20 });
    const key = buildCacheKey(baseKeyInput());
    cache.set(key, makeCached([makeResult(1, 0.9)]));
    expect(cache.get(key)).toBeDefined();
    expect(cache.size).toBe(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(cache.get(key)).toBeUndefined();
    // 만료 칸은 get 시점에 삭제된다 — size 가 줄어야 한다.
    expect(cache.size).toBe(0);
  });

  test("(c) invalidateAll 후 size 0 + 모든 키 miss", () => {
    const cache = new SearchCache();
    cache.set(buildCacheKey(baseKeyInput()), makeCached([makeResult(1, 0.9)]));
    cache.set(
      buildCacheKey({ ...baseKeyInput(), dbRevision: 2 }),
      makeCached([makeResult(2, 0.5)]),
    );
    expect(cache.size).toBe(2);
    cache.invalidateAll();
    expect(cache.size).toBe(0);
    expect(cache.get(buildCacheKey(baseKeyInput()))).toBeUndefined();
  });

  test("(d) LRU bound 초과 시 가장 오래 전에 넣은 칸 축출", () => {
    const cache = new SearchCache({ maxEntries: 2 });
    const k1 = buildCacheKey({ ...baseKeyInput(), query: "q1" });
    const k2 = buildCacheKey({ ...baseKeyInput(), query: "q2" });
    const k3 = buildCacheKey({ ...baseKeyInput(), query: "q3" });
    cache.set(k1, makeCached([makeResult(1, 0.9)]));
    cache.set(k2, makeCached([makeResult(2, 0.5)]));
    expect(cache.size).toBe(2);
    // 세 번째 칸 추가 — bound 초과로 가장 오래된 k1 이 빠진다.
    cache.set(k3, makeCached([makeResult(3, 0.3)]));
    expect(cache.size).toBe(2);
    expect(cache.get(k1)).toBeUndefined();
    expect(cache.get(k2)).toBeDefined();
    expect(cache.get(k3)).toBeDefined();
  });

  test("get 으로 최근 사용 칸은 LRU 에서 늦게 축출 (재삽입 갱신)", () => {
    const cache = new SearchCache({ maxEntries: 2 });
    const k1 = buildCacheKey({ ...baseKeyInput(), query: "q1" });
    const k2 = buildCacheKey({ ...baseKeyInput(), query: "q2" });
    const k3 = buildCacheKey({ ...baseKeyInput(), query: "q3" });
    cache.set(k1, makeCached([makeResult(1, 0.9)]));
    cache.set(k2, makeCached([makeResult(2, 0.5)]));
    // k1 을 다시 읽어 최근 사용으로 끌어올린다.
    expect(cache.get(k1)).toBeDefined();
    // k3 추가 → 이제 가장 오래된 칸은 k2 다.
    cache.set(k3, makeCached([makeResult(3, 0.3)]));
    expect(cache.get(k1)).toBeDefined();
    expect(cache.get(k2)).toBeUndefined();
    expect(cache.get(k3)).toBeDefined();
  });

  test("같은 키 재 set 은 칸 수를 늘리지 않고 값을 갱신", () => {
    const cache = new SearchCache();
    const key = buildCacheKey(baseKeyInput());
    cache.set(key, makeCached([makeResult(1, 0.9)]));
    cache.set(key, makeCached([makeResult(2, 0.5)]));
    expect(cache.size).toBe(1);
    expect(cache.get(key)!.results[0]!.node.id).toBe(2);
  });

  test("기본 TTL·bound 상수가 spec 값(60초 / 200칸)으로 노출된다", () => {
    expect(SearchCache.DEFAULT_TTL_MS).toBe(60_000);
    expect(SearchCache.DEFAULT_MAX_ENTRIES).toBe(200);
  });
});
