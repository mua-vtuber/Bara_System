/**
 * booster-match 순수 함수 테스트 — Phase 6 spec 단락 3.4.
 *
 * data fixture (BoosterDef[] 직접 생성 → 출력 검증) 방식만 사용한다.
 * builtin 상수에 의존하지 않고 순수 함수 입출력만 확인한다 (인터페이스 mock 없음).
 */

import { describe, expect, test } from "bun:test";
import type { BoosterDef } from "./types.ts";
import { matchBoosters, sumBoosterScore } from "./booster-match.ts";

/** spec 단락 3.4 예시에 나오는 단어를 직접 생성한 fixture. */
const FIXTURE: BoosterDef[] = [
  { word: "앞으로", score: 3, lang: "ko", enabled: true },
  { word: "임시", score: -2, lang: "ko", enabled: true },
  { word: "ㅋㅋ", score: -1, lang: "ko", enabled: true },
  { word: "계속", score: 3, lang: "ko", enabled: true },
];

describe("matchBoosters", () => {
  test("spec 3.4 예시 1 — 결정 신호 단어 1개 검출", () => {
    const hits = matchBoosters("앞으로 Bun 런타임으로 결정했어", FIXTURE);
    expect(hits).toEqual([{ word: "앞으로", score: 3 }]);
    expect(sumBoosterScore(hits)).toBe(3);
  });

  test("spec 3.4 예시 2 — 부정 신호 + 잡담 신호 단어 2개 검출", () => {
    const hits = matchBoosters("이거 임시로 SQLite 쓰기로 했어 ㅋㅋ", FIXTURE);
    expect(hits).toEqual([
      { word: "임시", score: -2 },
      { word: "ㅋㅋ", score: -1 },
    ]);
    expect(sumBoosterScore(hits)).toBe(-3);
  });

  test("같은 단어가 여러 번 나와도 1회만 합산한다 (Set dedup)", () => {
    const hits = matchBoosters("앞으로 앞으로 앞으로 계속 간다", FIXTURE);
    expect(hits).toEqual([
      { word: "앞으로", score: 3 },
      { word: "계속", score: 3 },
    ]);
    expect(sumBoosterScore(hits)).toBe(6);
  });

  test("검출 단어가 없으면 빈 목록 + 합 0", () => {
    const hits = matchBoosters("그냥 평범한 문장입니다", FIXTURE);
    expect(hits).toEqual([]);
    expect(sumBoosterScore(hits)).toBe(0);
  });
});

describe("sumBoosterScore", () => {
  test("빈 목록 합은 0", () => {
    expect(sumBoosterScore([])).toBe(0);
  });

  test("양수·음수 혼합 합산", () => {
    const hits = [
      { word: "앞으로", score: 3 },
      { word: "임시", score: -2 },
      { word: "ㅋㅋ", score: -1 },
    ];
    expect(sumBoosterScore(hits)).toBe(0);
  });
});
