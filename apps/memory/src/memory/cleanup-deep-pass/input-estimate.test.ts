/**
 * input-estimate.test.ts — 입력 토큰 추정 + microbatch 순수 함수 검증 (spec 4.A-6).
 *
 * 전부 순수 함수라 데이터 fixture 입력·출력만 본다(mock 객체 0). 검증 축:
 *   - 추정 결정론: 같은 입력 = 같은 추정, 문자 수 비율·메시지 오버헤드 계산.
 *   - 호출당 상한 판정: 안/초과 + splittable 신호.
 *   - 자연 경계 분할: 문단·줄 경계, 경계 없으면 원문 하나.
 *   - 분할 가능 여부: 모든 조각이 상한 안이면 true, 한 조각이라도 초과면 false.
 *   - microbatch: 추정 합이 상한 안에 묶이는지 + 단독 초과는 oversized.
 */

import { expect, test } from "bun:test";
import type { ChatMessage } from "../../llm/types.ts";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  PER_MESSAGE_OVERHEAD_TOKENS,
  canSplitUnderCap,
  classifyPerCallInput,
  estimateMessagesTokens,
  estimateTextTokens,
  splitIntoMicrobatches,
  splitTextOnNaturalBoundaries,
} from "./input-estimate.ts";

// ── 텍스트·메시지 추정 ────────────────────────────────────────────────────────

test("estimateTextTokens — 문자 수 / 비율 올림, 빈 문자열 0", () => {
  expect(estimateTextTokens("")).toBe(0);
  // 10 글자 / 2.5 = 4.
  expect(estimateTextTokens("0123456789")).toBe(Math.ceil(10 / CHARS_PER_TOKEN_ESTIMATE));
  // 부분 토큰도 한 토큰으로 올림(과소 추정 회피).
  expect(estimateTextTokens("12345678901")).toBe(Math.ceil(11 / CHARS_PER_TOKEN_ESTIMATE));
});

test("estimateTextTokens — 결정론: 같은 입력 같은 추정", () => {
  const s = "한글 메모 내용 예시 문장입니다";
  expect(estimateTextTokens(s)).toBe(estimateTextTokens(s));
});

test("estimateMessagesTokens — 본문 추정 합 + 메시지당 오버헤드", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "0123456789" }, // 4
    { role: "user", content: "0123456789" }, // 4
  ];
  const expected =
    estimateTextTokens("0123456789") * 2 + PER_MESSAGE_OVERHEAD_TOKENS * 2;
  expect(estimateMessagesTokens(messages)).toBe(expected);
});

// ── 호출당 상한 판정 ──────────────────────────────────────────────────────────

test("classifyPerCallInput — 상한 안이면 fits, 초과면 splittable 실어 회신", () => {
  expect(classifyPerCallInput(100, 200, true)).toEqual({
    fits: true,
    estimatedTokens: 100,
  });
  // 경계값(같으면 fits).
  expect(classifyPerCallInput(200, 200, false)).toEqual({
    fits: true,
    estimatedTokens: 200,
  });
  expect(classifyPerCallInput(300, 200, true)).toEqual({
    fits: false,
    estimatedTokens: 300,
    splittable: true,
  });
  expect(classifyPerCallInput(300, 200, false)).toEqual({
    fits: false,
    estimatedTokens: 300,
    splittable: false,
  });
});

// ── 자연 경계 분할 ────────────────────────────────────────────────────────────

test("splitTextOnNaturalBoundaries — 빈 줄(문단) 경계로 쪼갬", () => {
  const text = "첫 문단입니다.\n\n둘째 문단입니다.\n\n셋째 문단.";
  const parts = splitTextOnNaturalBoundaries(text, 1000);
  expect(parts).toEqual(["첫 문단입니다.", "둘째 문단입니다.", "셋째 문단."]);
});

test("splitTextOnNaturalBoundaries — 큰 문단은 줄 단위로 더 쪼갬", () => {
  // maxChars 5 보다 긴 문단 → 줄 경계로 분해.
  const text = "가나다라마바사\n아자차카타파하";
  const parts = splitTextOnNaturalBoundaries(text, 5);
  expect(parts).toEqual(["가나다라마바사", "아자차카타파하"]);
});

test("splitTextOnNaturalBoundaries — 경계 없으면 원문 하나", () => {
  const text = "쪼갤경계없는한줄";
  expect(splitTextOnNaturalBoundaries(text, 3)).toEqual([text]);
});

// ── 분할 가능 여부(모든 조각 상한 안) ─────────────────────────────────────────

test("canSplitUnderCap — 문단들이 상한 안이면 true", () => {
  // 각 문단 10 글자 → 4 토큰. 오버헤드 2 → 조각당 6 토큰. 상한 8 이면 전부 안.
  const text = "0123456789\n\n0123456789";
  expect(canSplitUnderCap(text, 8, 2)).toBe(true);
});

test("canSplitUnderCap — 쪼개도 여전히 초과인 조각 있으면 false", () => {
  // 경계 없는 한 줄 20 글자 → 8 토큰 + 오버헤드 2 = 10, 상한 6 초과. 분할해도 조각 하나뿐.
  const text = "01234567890123456789";
  expect(canSplitUnderCap(text, 6, 2)).toBe(false);
});

test("canSplitUnderCap — 오버헤드가 상한 이상이면 false(본문 자리 0)", () => {
  expect(canSplitUnderCap("0123456789\n\n0123456789", 4, 4)).toBe(false);
});

// ── 토큰 인지 microbatch ──────────────────────────────────────────────────────

test("splitIntoMicrobatches — 추정 합이 상한 안에 들도록 묶는다", () => {
  // 원소 4개 각 3 토큰, 오버헤드 2, 상한 8 → 그룹당 최대 (8-2)/3 = 2 원소.
  const items = [{ t: 3 }, { t: 3 }, { t: 3 }, { t: 3 }];
  const { batches, oversized } = splitIntoMicrobatches(items, {
    fixedOverheadTokens: 2,
    perCallCap: 8,
    tokensOf: (i) => i.t,
  });
  expect(oversized).toEqual([]);
  expect(batches.length).toBe(2);
  expect(batches[0]).toEqual([{ t: 3 }, { t: 3 }]);
  expect(batches[1]).toEqual([{ t: 3 }, { t: 3 }]);
  // 각 그룹 추정 합(오버헤드 포함) 상한 안 검증.
  for (const b of batches) {
    const sum = 2 + b.reduce((a, i) => a + i.t, 0);
    expect(sum).toBeLessThanOrEqual(8);
  }
});

test("splitIntoMicrobatches — 단독으로도 상한 초과인 원소는 oversized", () => {
  const items = [{ t: 3 }, { t: 20 }, { t: 3 }];
  const { batches, oversized } = splitIntoMicrobatches(items, {
    fixedOverheadTokens: 2,
    perCallCap: 8,
    tokensOf: (i) => i.t,
  });
  expect(oversized).toEqual([{ t: 20 }]);
  // 나머지 둘은 한 그룹(2 + 3 + 3 = 8 = 상한).
  expect(batches).toEqual([[{ t: 3 }, { t: 3 }]]);
});

test("splitIntoMicrobatches — maxItemsPerBatch 를 주면 입력 상한 안이어도 원소 수 상한에서 그룹을 닫는다", () => {
  // 입력 상한은 넉넉(100)하지만 원소 수 상한 2 → [1,2] [3,4] [5].
  const items = [1, 2, 3, 4, 5].map((id) => ({ id, t: 1 }));
  const { batches, oversized } = splitIntoMicrobatches(items, {
    fixedOverheadTokens: 0,
    perCallCap: 100,
    tokensOf: (i) => i.t,
    maxItemsPerBatch: 2,
  });
  expect(oversized).toEqual([]);
  expect(batches.map((b) => b.map((i) => i.id))).toEqual([[1, 2], [3, 4], [5]]);
});

test("splitIntoMicrobatches — maxItemsPerBatch 가 1 이상 정수가 아니면 던진다", () => {
  for (const bad of [0, -1, 1.5]) {
    expect(() =>
      splitIntoMicrobatches([{ t: 1 }], {
        fixedOverheadTokens: 0,
        perCallCap: 10,
        tokensOf: (i) => i.t,
        maxItemsPerBatch: bad,
      }),
    ).toThrow(/원소 수 상한/);
  }
});

test("splitIntoMicrobatches — 빈 입력이면 그룹·oversized 둘 다 빈 목록", () => {
  const { batches, oversized } = splitIntoMicrobatches([], {
    fixedOverheadTokens: 2,
    perCallCap: 8,
    tokensOf: () => 1,
  });
  expect(batches).toEqual([]);
  expect(oversized).toEqual([]);
});

test("splitIntoMicrobatches — 순서 보존", () => {
  const items = [{ id: 1, t: 5 }, { id: 2, t: 5 }, { id: 3, t: 5 }];
  const { batches } = splitIntoMicrobatches(items, {
    fixedOverheadTokens: 0,
    perCallCap: 5,
    tokensOf: (i) => i.t,
  });
  // 각 원소가 상한 꽉 채워 그룹 하나씩, 순서대로.
  expect(batches.map((b) => b.map((i) => i.id))).toEqual([[1], [2], [3]]);
});
