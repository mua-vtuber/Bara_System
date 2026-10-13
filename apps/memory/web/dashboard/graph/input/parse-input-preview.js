/**
 * parse-input-preview.js — 그래프 입력 미리보기용 순수 파서(클라이언트·S7·결정 2·5).
 *
 * 사용자가 입력창에 치는 동안 글을 실시간으로 인식해 미리보기 패널이 보일 객체로 가른다:
 *   { kind, chain, date, place, amount, hasAmountTag, body }
 *
 * `#키:값` 추출은 서버 코어와 *같은 ② 규칙*을 본다 — 값 경계 = 다음 쉼표/줄바꿈/`#`,
 * 없으면 줄 끝(`/[,\n#]/`·먼저 오는 것). 이 한 규칙으로 (a) 띄어쓰기로 나열한 콜론 태그
 * (`#언어:TypeScript #런타임:Bun`)가 `#` 경계에서 각각 잡히고, (b) 긴 제목
 * (`#소설:데뷔 못 하면 죽는 병 걸림`)은 값 안에 `#` 가 없어 쉼표/줄 끝까지 통째로 읽힌다
 * (잘림 0). 서버 `src/memory/parsers/tag-value-boundary.ts` 의 `extractValueToBoundary`
 * 와 같은 경계이며, `parse-input-preview.test.ts` 가 그 서버 함수와의 동등성을 케이스로
 * 고정한다(드리프트 방지).
 *
 * 키 라우팅(예약 키):
 *   - 날짜/일정시작/일정종료 → date(splitDateRange 로 `~` 분할). 값이 비면 null →
 *     패널이 "못 알아들음" 으로 정직 표시.
 *   - 장소 → place(직접 입력 장소).
 *   - 금액 → amount(가계부 금액 칸). 금액은 전체 입력의 기본 항목이 아니므로
 *     태그가 실제로 있었는지 hasAmountTag 에 따로 남긴다.
 *   - 그 밖의 콜론 태그(사람·소설·작품·가계부 …) → 분류 사슬(chain). 첫 항목의 category 가
 *     종류(kind). 사슬 표시는 "category › value" 순.
 *
 * body = 글에서 모든 `#키:값` 태그 글자를 들어낸 나머지 자유 텍스트(trim).
 *
 * 못 알아들음(No-fallback): 종류가 하나도 없으면 kind=null, 날짜 값이 비면 date=null.
 * null 을 빈칸·가짜값으로 위장하지 않는다 — 패널이 그 null 을 "못 알아들음" 으로 그대로
 * 노출한다. LLM 호출 0·now/DB 의존 0 — 순수 규칙 파서.
 *
 * 날짜 ISO 변환은 여기서 하지 않는다(서버 event-date.ts 가 저장 시점에 함). 미리보기는
 * `~` 로 가른 원문 두 조각(start·end)을 그대로 보여 준다 — 서버와 다른 ISO 결과를 지어내
 * "보인 것과 저장된 것이 다름" 불일치를 만들지 않기 위함(spec §5.2·§9-V4).
 */

import { splitDateRange } from "./preview-date-range.js";

/** 날짜·장소·금액으로 따로 라우팅하는 예약 키. 그 밖의 콜론 태그는 분류 사슬로 떨어진다. */
const DATE_KEYS = new Set(["날짜", "일정시작", "일정종료"]);
const PLACE_KEY = "장소";
const AMOUNT_KEY = "금액";

// `#` + 키(공백 안·colon 안) + `:` — 값은 정규식 캡처가 아니라 쉼표/줄바꿈/`#` 경계로 뽑는다.
// 서버 classification-tag.ts·direct-field-tag.ts 의 키 정규식과 같은 글자 묶음.
const TAG_KEY_REGEX = /#([\p{L}\p{N}_-]+):/gu;

/**
 * valueStart 부터 다음 쉼표/줄바꿈/`#`, 없으면 줄 끝까지 잘라 trim 한다.
 * 서버 `extractValueToBoundary`(tag-value-boundary.ts)와 같은 경계 규칙(② 규칙).
 *
 * @param {string} text        전체 글.
 * @param {number} valueStart  값 시작 인덱스(`:` 바로 뒤).
 * @returns {string}           경계까지의 값(trim).
 */
export function extractValueToBoundary(text, valueStart) {
  const rest = text.slice(valueStart);
  const boundary = rest.search(/[,\n#]/);
  const raw = boundary === -1 ? rest : rest.slice(0, boundary);
  return raw.trim();
}

/**
 * 한 글에서 모든 `#키:값` 을 ② 경계 규칙으로 뽑는다.
 *
 * @param {string} text  사용자 입력 글.
 * @returns {Array<{ key: string, value: string, start: number, end: number }>}
 *          key=콜론 앞 키, value=경계까지 값, start=`#` 위치, end=값 끝 위치(태그 들어내기용).
 */
export function extractTags(text) {
  const out = [];
  if (!text) return out;
  TAG_KEY_REGEX.lastIndex = 0;
  let match;
  while ((match = TAG_KEY_REGEX.exec(text)) !== null) {
    const key = match[1];
    if (!key) continue;
    const valueStart = match.index + match[0].length;
    const rest = text.slice(valueStart);
    const boundary = rest.search(/[,\n#]/);
    const rawLen = boundary === -1 ? rest.length : boundary;
    const value = rest.slice(0, rawLen).trim();
    out.push({
      key,
      value,
      start: match.index,
      end: valueStart + rawLen,
    });
  }
  return out;
}

/**
 * 입력 글을 미리보기 패널이 보일 인식 결과로 가른다(순수 변환).
 *
 * @param {string} text  사용자 입력 글.
 * @returns {{
 *   kind: string | null,
 *   chain: Array<{ category: string, value: string }>,
 *   date: { start: string, end: string | null } | null,
 *   place: string | null,
 *   amount: string | null,
 *   hasAmountTag: boolean,
 *   body: string
 * }}
 *   kind=첫 분류 사슬 category(없으면 null·못 알아들음). chain=분류 태그 순서대로.
 *   date=`#날짜:` 값 `~` 분할(값 비면 null·못 알아들음). place=`#장소:` 값(없으면 null).
 *   amount=`#금액:` 값(없으면 null). hasAmountTag=값이 비어도 `#금액:` 자체가 있었는지.
 *   body=태그 들어낸 나머지 자유 텍스트.
 */
export function parseInputPreview(text) {
  const result = {
    kind: null,
    chain: [],
    date: null,
    place: null,
    amount: null,
    hasAmountTag: false,
    body: "",
  };
  if (!text) return result;

  const tags = extractTags(text);

  for (const tag of tags) {
    if (DATE_KEYS.has(tag.key)) {
      // 값이 비면 못 알아들음(null·가짜값 0). 마지막 날짜 태그가 이긴다(여럿이면 덮어씀).
      result.date = tag.value.length > 0 ? splitDateRange(tag.value) : null;
    } else if (tag.key === PLACE_KEY) {
      result.place = tag.value.length > 0 ? tag.value : null;
    } else if (tag.key === AMOUNT_KEY) {
      result.hasAmountTag = true;
      result.amount = tag.value.length > 0 ? tag.value : null;
    } else if (tag.value.length > 0) {
      // 그 밖의 콜론 태그 → 분류 사슬. 빈 값 태그는 사슬에 안 넣는다(정직).
      result.chain.push({ category: tag.key, value: tag.value });
    }
  }

  // 종류 = 첫 분류 사슬 category. 하나도 없으면 못 알아들음(null).
  result.kind = result.chain.length > 0 ? result.chain[0].category : null;

  // body = 태그 글자를 뒤에서부터 들어낸 나머지(인덱스 밀림 방지) → 쉼표·공백 정리.
  let body = text;
  for (let i = tags.length - 1; i >= 0; i -= 1) {
    body = body.slice(0, tags[i].start) + body.slice(tags[i].end);
  }
  result.body = cleanupBody(body);

  return result;
}

/**
 * 태그를 들어낸 나머지에서 남은 구분자(쉼표·연속 공백·줄 끝 잔여)를 정리한다.
 * 자유 텍스트 본문만 남긴다 — 사용자가 "투블럭 컷트" 처럼 친 부분.
 *
 * @param {string} raw  태그 들어낸 직후 글.
 * @returns {string}    정리한 본문(trim).
 */
export function cleanupBody(raw) {
  return raw
    .replace(/[ \t]*,[ \t]*/g, " ") // 쉼표(앞뒤 공백 포함)를 한 칸으로
    .replace(/[ \t]{2,}/g, " ") // 연속 공백 → 한 칸
    .replace(/[ \t]*\n[ \t]*/g, "\n") // 줄바꿈 둘레 공백 정리
    .trim();
}
