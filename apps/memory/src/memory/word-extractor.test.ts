/**
 * word-extractor 테스트. 실제 Kiwi 형태소 분석기(lang/korean-tokenizer.ts)로
 * 검증한다 — Mock 없음. 입력 텍스트 → 형태소 토큰 → 빈도 집계의 매핑을 본다.
 *
 * 2026-06-12 Task 1: 옛 음절 통째 정규식 토큰화를 Kiwi 형태소로 교체했다.
 * 조사·어미가 흡수돼 "커피를/커피가" 가 "커피" 한 토큰으로 모이고, 같은
 * 단어의 docCount 가 분산되지 않고 합산된다.
 */

import { describe, expect, test } from "bun:test";
import {
  countWordFrequency,
  DEFAULT_STOPWORDS,
  extractWords,
} from "./word-extractor.ts";

describe("extractWords — 형태소 토큰화", () => {
  test("빈 문자열 → 빈 배열", async () => {
    expect(await extractWords("")).toEqual([]);
  });

  test("명사만 추출 (구두점 제거)", async () => {
    expect(await extractWords("커피, 라테! 그리고 카푸치노?")).toEqual([
      "커피",
      "라테",
      "카푸치노",
    ]);
  });

  test("영어 토큰 lowercase normalize ('and' 는 default stopword 라 걸림)", async () => {
    expect(await extractWords("React and TYPESCRIPT")).toEqual([
      "react",
      "typescript",
    ]);
  });

  test("한국어 + 영어 혼합 — 명사·영문 살리고 어미 흡수", async () => {
    // "공부함" → 명사 어근 "공부" (동사화 접사 '하'·명사형 어미 'ㅁ' 흡수).
    // "오늘" 은 default stopword 라 걸러진다.
    expect(await extractWords("오늘 React 공부함")).toEqual(["react", "공부"]);
  });

  test("영문+숫자가 형태소 단위로 살아남는다", async () => {
    expect(await extractWords("python3 버전 311")).toEqual([
      "python",
      "버전",
      "311",
    ]);
  });

  test("이모지는 기호로 갈려 버려지고 명사만 남는다", async () => {
    const result = await extractWords("커피🍵라테 사이");
    expect(result).toContain("커피");
    expect(result).toContain("라테");
    expect(result).toContain("사이");
    expect(result.some((w) => w.includes("🍵"))).toBe(false);
  });

  test("같은 명사 반복은 그대로 보존", async () => {
    expect(await extractWords("커피 커피 커피")).toEqual([
      "커피",
      "커피",
      "커피",
    ]);
  });
});

describe("extractWords — 조사 흡수", () => {
  test("조사가 붙은 명사가 조사 떼고 토큰이 된다", async () => {
    // "커피와" 의 조사 '와' 가 흡수돼 "커피" 로 모인다. ('차' 는 1자라
    // 기본 minLength=2 에서 제외, '좋아함' 은 용언이라 흡수 — 명사만 남는다.)
    const result = await extractWords("나는 커피와 차를 좋아함");
    expect(result).toContain("커피");
    expect(result).not.toContain("커피와");
  });

  test("조사 종류가 달라도 같은 명사로 모인다", async () => {
    const result = await extractWords("커피를 커피가 커피는 커피에");
    expect(result).toEqual(["커피", "커피", "커피", "커피"]);
  });
});

describe("extractWords — 옵션", () => {
  test("minLength=3 이면 2자 명사 토큰 제외", async () => {
    // "커피"(2자)·"차"(1자) 제외, "카푸치노"(4자) 통과.
    const result = await extractWords("커피와 카푸치노를 마심", {
      minLength: 3,
    });
    expect(result).toContain("카푸치노");
    expect(result).not.toContain("커피");
  });

  test("DEFAULT_STOPWORDS 가 한국어/영어 둘 다 거른다", async () => {
    const result = await extractWords("나는 커피와 the bean 그리고 차");
    expect(result).not.toContain("그리고");
    expect(result).not.toContain("the");
    expect(result).toContain("커피");
    expect(result).toContain("bean");
  });

  test("커스텀 stopwords 가 default 를 완전 대체 (병합 아님)", async () => {
    // custom 으로 '라테' 만 거른다. default 에 없는 '라테' 가 custom 으로
    // 걸리고, default 에 있던 단어는 custom 으로 대체돼 더는 걸리지 않는다.
    const custom = new Set(["라테"]);
    const result = await extractWords("커피 라테 카푸치노", {
      stopwords: custom,
    });
    expect(result).toContain("커피");
    expect(result).toContain("카푸치노");
    expect(result).not.toContain("라테");
  });

  test("DEFAULT_STOPWORDS 자체 sanity — 일상어 일부 포함", () => {
    expect(DEFAULT_STOPWORDS.has("그리고")).toBe(true);
    expect(DEFAULT_STOPWORDS.has("the")).toBe(true);
    expect(DEFAULT_STOPWORDS.has("이것")).toBe(true);
  });
});

describe("countWordFrequency — 집계", () => {
  test("빈 입력 → 빈 결과", async () => {
    expect(await countWordFrequency([])).toEqual([]);
    expect(await countWordFrequency(["", "", ""])).toEqual([]);
  });

  test("단일 문서 — totalCount=1, docCount=1", async () => {
    const result = await countWordFrequency(["커피"]);
    expect(result).toEqual([{ word: "커피", totalCount: 1, docCount: 1 }]);
  });

  test("한 문서 안 반복 → totalCount 누적, docCount=1", async () => {
    const result = await countWordFrequency(["커피 커피 커피"]);
    expect(result).toEqual([{ word: "커피", totalCount: 3, docCount: 1 }]);
  });

  test("조사 흡수 후 같은 명사가 docCount 로 합산된다", async () => {
    // 옛 음절 토큰화면 "커피를"·"커피가"·"커피는" 이 별개라 docCount 가
    // 분산됐다. Kiwi 형태소로 모두 "커피" 한 토큰이 돼 docCount=3 으로 합산.
    const docs = ["커피를 마심", "커피가 좋음", "커피는 향"];
    const result = await countWordFrequency(docs);
    const coffee = result.find((r) => r.word === "커피");
    expect(coffee).toEqual({ word: "커피", totalCount: 3, docCount: 3 });
  });

  test("여러 문서 동일 단어 → docCount 분리 측정", async () => {
    const docs = ["커피 마심", "다른 커피 또", "차 마심"];
    const result = await countWordFrequency(docs);
    const coffee = result.find((r) => r.word === "커피");
    expect(coffee).toEqual({ word: "커피", totalCount: 2, docCount: 2 });
  });

  test("minDocFreq 필터 — 한 문서에만 나온 단어 제외", async () => {
    const docs = ["커피 라테", "커피 카푸치노", "에스프레소"];
    const result = await countWordFrequency(docs, { minDocFreq: 2 });
    expect(result.map((r) => r.word)).toEqual(["커피"]);
  });

  test("정렬: docCount DESC → totalCount DESC → word ASC", async () => {
    const docs = [
      "사과 사과 바나나", // 사과 2/1, 바나나 1/1
      "사과 바나나", // 사과 3/2, 바나나 2/2
      "포도", // 포도 1/1
      "포도 포도", // 포도 3/2
    ];
    const result = await countWordFrequency(docs);
    expect(result[0]).toEqual({ word: "사과", totalCount: 3, docCount: 2 });
    expect(result[1]).toEqual({ word: "포도", totalCount: 3, docCount: 2 });
    expect(result[2]).toEqual({ word: "바나나", totalCount: 2, docCount: 2 });
  });

  test("emerge 임계 시뮬레이션 — 조사 흡수로 docCount ≥ 5 통과", async () => {
    // 조사가 다 달라도 형태소 흡수로 "커피" 한 단어로 모여 docCount=5.
    const docs = [
      "커피를 마심",
      "커피가 좋음",
      "커피는 향",
      "오늘 커피에",
      "또 커피와",
      "라테 한 잔",
    ];
    const candidates = await countWordFrequency(docs, { minDocFreq: 5 });
    expect(candidates.map((r) => r.word)).toEqual(["커피"]);
  });
});
