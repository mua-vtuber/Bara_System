/**
 * tag-autocomplete.test.ts — # 태그 자동완성 위젯 단위 검증 (그래프 입력 S6 / 결정 3).
 *
 * 검증 정신 — mock 0:
 *   순수 함수(filterSuggestions·extractActiveTagPrefix)는 fixture 입력으로, DOM 산출
 *   (드롭다운 렌더·빈 상태·non-blocking)은 happy-dom 전역 위에서 검증한다. 후보 주입은
 *   setSuggestionsForTest 데이터 통로를 쓴다 — 인터페이스 mock 구현체가 아니다(정책).
 *   비2xx 경로만 global fetch 를 임시로 갈아 끼워 load() 의 추천-끔 동작을 본다(부수효과 검증).
 *
 * 검증 갈래:
 *   1) filterSuggestions — AC 예시 ["작업컴퓨터","치과"]+"작업" → ["작업컴퓨터"]. 빈 접두 = 전체.
 *   2) extractActiveTagPrefix — caret 앞 `#토큰` 추출. 태그 입력 아니면 null. `#` 직후면 "".
 *   3) refresh — `#작업` 친 입력에서 드롭다운이 일치 후보로 채워진다.
 *   4) 빈 상태 — 새 값(치과) 끝까지 치면 일치 0 → 드롭다운 안 뜸(가짜 항목 0).
 *   5) non-blocking — 비2xx 응답이면 추천만 꺼지고(available=false) 입력값은 그대로 편집된다.
 */

import "../../../../test-setup-dom";
import { afterEach, expect, test } from "bun:test";
import {
  createTagAutocomplete,
  extractActiveTagPrefix,
  filterSuggestions,
} from "./tag-autocomplete.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// 1) filterSuggestions — AC 명시 예시
test("filterSuggestions — 접두 일치만(AC 예시)", () => {
  expect(filterSuggestions(["작업컴퓨터", "치과"], "작업")).toEqual(["작업컴퓨터"]);
});

test("filterSuggestions — 빈 접두면 전체 통과(거르지 않는다)", () => {
  expect(filterSuggestions(["작업컴퓨터", "치과"], "")).toEqual(["작업컴퓨터", "치과"]);
  expect(filterSuggestions(["작업컴퓨터", "치과"], "   ")).toEqual(["작업컴퓨터", "치과"]);
});

test("filterSuggestions — 영문 태그는 대소문자 무시 일치", () => {
  expect(filterSuggestions(["macbook", "mouse"], "MAC")).toEqual(["macbook"]);
});

// 2) extractActiveTagPrefix — caret 앞 활성 태그 접두
test("extractActiveTagPrefix — caret 앞 #토큰을 뽑는다", () => {
  const text = "회의 메모 #작업컴";
  expect(extractActiveTagPrefix(text, text.length)).toBe("작업컴");
});

test("extractActiveTagPrefix — # 직후면 빈 문자열(전체 후보 신호)", () => {
  const text = "메모 #";
  expect(extractActiveTagPrefix(text, text.length)).toBe("");
});

test("extractActiveTagPrefix — 태그 입력 중 아니면 null", () => {
  expect(extractActiveTagPrefix("그냥 평범한 글", 7)).toBeNull();
  // 태그 뒤 공백을 친 직후는 토큰이 끝났으므로 null.
  expect(extractActiveTagPrefix("#작업 ", 4)).toBeNull();
});

// 3) refresh — #작업 입력에서 드롭다운이 일치 후보로 채워진다
test("refresh — #작업 입력 중이면 일치 후보 드롭다운이 뜬다", () => {
  const inputEl = document.createElement("input");
  const ac = createTagAutocomplete({ apiBase: "", inputEl });
  ac.setSuggestionsForTest(["작업컴퓨터", "작업실", "치과"]);

  inputEl.value = "메모 #작업";
  inputEl.selectionStart = inputEl.value.length;
  ac.refresh();

  expect(ac.listEl.hidden).toBe(false);
  expect(ac.getVisibleSuggestions()).toEqual(["작업컴퓨터", "작업실"]);
});

// 4) 빈 상태 — 새 값을 끝까지 치면 일치 0 → 드롭다운 안 뜸(가짜 항목 0)
test("빈 상태 — 일치 후보 0이면 드롭다운이 안 뜬다", () => {
  const inputEl = document.createElement("input");
  const ac = createTagAutocomplete({ apiBase: "", inputEl });
  ac.setSuggestionsForTest(["작업컴퓨터"]);

  inputEl.value = "메모 #치과"; // 저장된 후보에 없는 새 값
  inputEl.selectionStart = inputEl.value.length;
  ac.refresh();

  expect(ac.listEl.hidden).toBe(true);
  expect(ac.getVisibleSuggestions()).toEqual([]);
});

// 5) non-blocking — 비2xx 응답이면 추천만 꺼지고 입력은 그대로 편집된다
test("비2xx 응답 — 추천만 끄고(available=false) 입력은 안 막는다", async () => {
  // /dashboard/sse-token → 토큰, /api/tag-suggest → 503 으로 갈아 끼운다(추천 데이터 통로 실패).
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/dashboard/sse-token")) {
      return new Response(JSON.stringify({ token: "t" }), { status: 200 });
    }
    return new Response("store 미주입", { status: 503 });
  }) as typeof fetch;

  const inputEl = document.createElement("input");
  const ac = createTagAutocomplete({ apiBase: "", inputEl });
  await ac.load();

  // 추천은 꺼진다(503 = 정직한 비활성). 드롭다운은 안 뜬다.
  expect(ac.isAvailable()).toBe(false);

  // 핵심 — 추천 실패가 입력을 막지 않는다. 사용자가 # 토큰을 마저 쳐도 값이 그대로 들어가고
  // refresh 는 조용히 숨김만 유지한다(예외 없이 통과).
  inputEl.value = "메모 #작업컴";
  inputEl.selectionStart = inputEl.value.length;
  ac.refresh();
  expect(inputEl.value).toBe("메모 #작업컴"); // 입력값 무사
  expect(ac.listEl.hidden).toBe(true); // 추천만 꺼짐
});
