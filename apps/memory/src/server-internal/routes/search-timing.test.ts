/**
 * search-timing.test.ts — [search-timing] 한 줄 형식 검증 (speed-step1 spec 5.2).
 *
 * 순수 함수 시험이다: 정해 둔 레코드(데이터 fixture)를 넣어 줄 글을 확인한다.
 */

import { describe, expect, test } from "bun:test";
import type { RetrieveStageTimings } from "../../memory/stage-timer.ts";
import type { RerankStats } from "../../memory/reranker.ts";
import {
  SEARCH_TIMING_LOG_PREFIX,
  formatSearchTimingLine,
  type SearchTimingRecord,
} from "./search-timing.ts";

const FRESH_TIMINGS: RetrieveStageTimings = {
  prepMs: 2,
  embedMs: 41,
  embedCacheHit: false,
  planMs: 3,
  vectorFtsMs: 120,
  conceptMs: 35,
  imageVecMs: 0,
  projectMs: 8,
  personMs: 6,
  graphMs: 40,
  scoreMs: 520,
  touchMs: 12,
  totalMs: 800,
};

const SCORED: RerankStats = {
  scored: true,
  pairs: 10,
  seqLen: 512,
  tokenizeMs: 15,
  inferMs: 4280,
};

const NOT_SCORED: RerankStats = {
  scored: false,
  pairs: 0,
  seqLen: null,
  tokenizeMs: null,
  inferMs: null,
};

function fullRecord(over: Partial<SearchTimingRecord> = {}): SearchTimingRecord {
  return {
    totalMs: 5512,
    floorOn: true,
    queryChars: 18,
    resultCount: 5,
    retrievalMs: 812,
    passes: [{ pass: "strict", cacheHit: false, ms: 810, timings: FRESH_TIMINGS }],
    ancillaryMs: 3,
    rerank: { ms: 4300, stats: SCORED },
    floorMs: 0,
    tail: {
      kind: "full",
      enrichMs: 60,
      postMs: 210,
      entity: null,
      assembleMs: null,
    },
    ...over,
  };
}

describe("formatSearchTimingLine", () => {
  test("머리말 상수는 [search-timing]", () => {
    expect(SEARCH_TIMING_LOG_PREFIX).toBe("[search-timing]");
  });

  test("full + 캐시 miss + 리랭커 채점 + entity 건너뜀 — spec 5.2 예시 줄", () => {
    expect(formatSearchTimingLine(fullRecord())).toBe(
      "[search-timing] total=5512ms mode=full floor=on queryChars=18 results=5 " +
        "retrieval=812ms[strict cache=miss prep=2ms embed=41ms(hit=no) plan=3ms vecfts=120ms " +
        "concept=35ms image=0ms project=8ms person=6ms graph=40ms score=520ms touch=12ms] " +
        "ancillary=3ms rerank=4300ms[scored=yes pairs=10 seqLen=512 tokenize=15ms infer=4280ms] " +
        "floor=0ms enrich=60ms post=210ms entity=-[skipped] assemble=-",
    );
  });

  test("캐시 hit — 단계 칸은 전부 -", () => {
    const line = formatSearchTimingLine(
      fullRecord({
        passes: [{ pass: "strict", cacheHit: true, ms: 1, timings: null }],
      }),
    );
    expect(line).toContain(
      "retrieval=812ms[strict cache=hit prep=- embed=-(hit=-) plan=- vecfts=- " +
        "concept=- image=- project=- person=- graph=- score=- touch=-]",
    );
  });

  test("embed 캐시 적중(hit=yes) 과 retriever 가 돌지 않은 단계(null)는 -", () => {
    const line = formatSearchTimingLine(
      fullRecord({
        passes: [
          {
            pass: "strict",
            cacheHit: false,
            ms: 9,
            timings: {
              ...FRESH_TIMINGS,
              embedMs: 0,
              embedCacheHit: true,
              scoreMs: null,
              touchMs: null,
            },
          },
        ],
      }),
    );
    expect(line).toContain("embed=0ms(hit=yes)");
    expect(line).toContain("score=- touch=-]");
  });

  test("relaxed 2-pass — pass 마다 대괄호 한 묶음", () => {
    const line = formatSearchTimingLine(
      fullRecord({
        passes: [
          { pass: "strict", cacheHit: true, ms: 1, timings: null },
          { pass: "relaxed", cacheHit: false, ms: 700, timings: FRESH_TIMINGS },
        ],
      }),
    );
    expect(line).toContain("[strict cache=hit");
    expect(line).toContain("] [relaxed cache=miss prep=2ms");
  });

  test("리랭커 꺼짐은 rerank=-[off]", () => {
    expect(formatSearchTimingLine(fullRecord({ rerank: null }))).toContain(
      "ancillary=3ms rerank=-[off] floor=0ms",
    );
  });

  test("리랭커가 있지만 채점 안 함(scored=no) — 길이·시간은 -", () => {
    const line = formatSearchTimingLine(
      fullRecord({ rerank: { ms: 2, stats: NOT_SCORED } }),
    );
    expect(line).toContain(
      "rerank=2ms[scored=no pairs=0 seqLen=- tokenize=- infer=-]",
    );
  });

  test("floor 꺼짐은 floor=off", () => {
    expect(formatSearchTimingLine(fullRecord({ floorOn: false }))).toContain(
      "mode=full floor=off ",
    );
  });

  test("entity 가 돌았으면 entity=Nms[embed=Nms], 조립했으면 assemble=Nms", () => {
    const line = formatSearchTimingLine(
      fullRecord({
        tail: {
          kind: "full",
          enrichMs: 60,
          postMs: 210,
          entity: { ms: 90, embedMs: 70 },
          assembleMs: 4,
        },
      }),
    );
    expect(line).toContain("entity=90ms[embed=70ms] assemble=4ms");
  });

  test("index 갈래 — mode=index, enrich·post·entity·assemble 대신 index 칸", () => {
    const line = formatSearchTimingLine(
      fullRecord({ tail: { kind: "index", indexMs: 25 } }),
    );
    expect(line).toContain("mode=index");
    expect(line).toEndWith("floor=0ms index=25ms");
    expect(line).not.toContain("enrich=");
    expect(line).not.toContain("entity=");
  });

  test("줄바꿈이 없다", () => {
    expect(formatSearchTimingLine(fullRecord())).not.toContain("\n");
  });
});
