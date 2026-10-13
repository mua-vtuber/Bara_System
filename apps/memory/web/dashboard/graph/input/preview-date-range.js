/**
 * preview-date-range.js — `#날짜:` 값 안 `~` 기간 분할(클라이언트 미리보기·S7·결정 5).
 *
 * 서버 `src/memory/date-range-split.ts` 의 `splitDateRange` 와 *같은 규칙*을 브라우저
 * ES 모듈로 다시 쓴 단일 출처다. 빌드 도구 없이 브라우저가 그대로 읽는 .js 라 코어
 * `.ts` 를 직접 import 할 수 없어 같은 로직을 여기 둔다 — 두 산출이 어긋나지 않게
 * `preview-date-range.test.ts` 가 서버 `splitDateRange` 와의 동등성을 케이스로 고정한다
 * (드리프트 방지).
 *
 * 값은 S1(방식 ②)이 이미 쉼표/`#`/줄 끝까지 통째로 읽어 넘긴다 — 여기선 첫 `~` 로
 * 한 번만 가른다. 앞=시작·뒤=끝. `~` 없으면 end=null(정직한 단일 날짜·가짜값 0).
 *
 * @param {string} value  `#날짜:` 값(예: "6월 28일 ~ 6월 30일").
 * @returns {{ start: string, end: string | null }}  앞=start·뒤=end(없으면 null).
 */
export function splitDateRange(value) {
  const idx = value.indexOf("~");
  if (idx === -1) return { start: value.trim(), end: null };
  return {
    start: value.slice(0, idx).trim(),
    end: value.slice(idx + 1).trim(),
  };
}
