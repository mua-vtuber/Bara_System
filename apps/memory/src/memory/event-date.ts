/**
 * event-date.ts — 한국어 시간 표현 → 사건이 가리키는 ISO 날짜(YYYY-MM-DD) 변환.
 *
 * 등록 시각(now)을 기준으로, 문장이 가리키는 *그* 날짜(과거 사건 포함)를
 * 닫힌 ISO 날짜로 풀어낸다. 후속 Task 의 event_at 칸을 자동으로 채우거나
 * 검색어의 시간 표현을 풀 때 재사용한다.
 *
 * protect-until.ts 와의 차이(절대 섞지 말 것):
 *  - protect-until 은 "보호 만료용 — 후보 중 가장 먼 *미래* 선택, 과거 무시".
 *  - event-date 는 "문장이 가리키는 *그* 날짜(과거 포함) — 가장 구체적인 표현
 *    우선". 표현 목록은 참고하되 선택 규칙이 정반대다.
 *
 * 정규식 1단(확실한 것)만 처리한다. 애매한 표현은 null 을 반환해 정직하게
 * "시간 표현 없음/애매" 를 알린다(LLM 2단은 후속 Task 가 합류). null 은
 * 빈 값으로 실패를 위장하는 fallback 이 아니라, 닫힌 날짜가 없다는 정직한 결과다.
 *
 * 2층 구조:
 *  1. 언어 프로파일(lang/<code>.yaml) — 언어 의존 토큰(정규식·어휘 매핑)을
 *     데이터로 외부화(P3 G5-c). 개별 토큰의 근거 설명은 lang/ko.yaml 주석.
 *  2. 언어 중립 계산 코어(toIso/addDays/mondayOfWeek/...) — "주 시작이
 *     월요일로 주어지면 지난주 월요일을 계산" 식으로 언어와 무관.
 *
 * 완전한 언어 전환 스위치(settings.language 등)는 의도적으로 만들지 않는다
 * (골격만 — profile-loader.ts 의 DEFAULT_LANGUAGE_CODE 한 곳이 언어를 정한다).
 */
import { getLanguageProfile } from "./lang/profile-loader.ts";
import type { MatchOffsetPatternEntry } from "./lang/language-profile.ts";

// ── 지역 상수 ───────────────────────────────────────────────────────────────

/** 주의 시작 요일. 1 = 월요일(getDay 기준: 0=일,1=월,...,6=토). */
const WEEK_START = 1;

// ── 언어 중립 계산 코어 ──────────────────────────────────────────────────────

/** 로컬 시간 기준 ISO 날짜(YYYY-MM-DD). toISOString 의 UTC 시프트를 피한다. */
function toIso(year: number, month1: number, day: number): string {
  // month1 은 1-indexed. Date 로 정규화해 월말 넘침(예: 2월 30일)을 보정한다.
  const d = new Date(year, month1 - 1, day);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** Date 를 로컬 날짜 기준 ISO 로. */
function dateToIso(d: Date): string {
  return toIso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** now 의 자정(시·분·초 제거)으로 정규화한 새 Date. */
function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** n 일 더한(또는 뺀) 날짜. 로컬 시간 기준. */
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/**
 * now 가 속한 주의 시작 요일(weekStart) 날짜를 반환.
 * weekStart=1(월요일)이고 now 가 수요일이면 그 주 월요일을 돌려준다.
 */
function startOfWeek(now: Date, weekStart: number): Date {
  const base = startOfDay(now);
  // getDay: 0=일..6=토. weekStart 부터 며칠 지났는지(0..6) 계산.
  const offset = (base.getDay() - weekStart + 7) % 7;
  return addDays(base, -offset);
}

/** now 가 속한 달의 1일. */
function startOfMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** baseMonthStart 에서 monthDelta 달 이동한 달의 1일(연말·연초 경계 자동 보정). */
function addMonthsToStart(monthStart: Date, monthDelta: number): Date {
  return new Date(monthStart.getFullYear(), monthStart.getMonth() + monthDelta, 1);
}

/** monthStart(어떤 달의 1일)가 속한 달의 마지막 날. 다음 달 0일 = 이번 달 말일. */
function endOfMonth(monthStart: Date): Date {
  // Date 의 day=0 은 전 달 말일로 정규화된다 — 다음 달 1일의 하루 전.
  return new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
}

// ── 언어 토큰(언어 의존 — lang/<code>.yaml 프로파일 공급) ────────────────────
//
// 아래 상수들은 옛 KO_TOKENS 테이블의 프로파일 형태다. 패턴·오프셋·어휘 매핑의
// 개별 근거 설명(오매칭 방지 lookahead 등)은 lang/ko.yaml 주석으로 옮겼다.

/** 언어 프로파일의 시간 표현 단락 — 모듈 로드 시 1회 로드(로더 캐시 공유). */
const DATE_TOKENS = getLanguageProfile().eventDate;

/**
 * 굴러가는(열린) 창 표현. 닫힌 날짜가 아니라서 매칭되면 null 로 빠진다.
 * "지난주"(닫힌 표현)와 안 섞이게 *맨 앞에서 먼저* 검사한다.
 * 예: "지난 7일", "최근 일주일", "최근 3일".
 */
const ROLLING_WINDOW = DATE_TOKENS.rollingWindow;

/** 절대 날짜 표현 정규식 — YYYY년 M월 D일 / M월 D일(연도 없음) / M/D. */
const ISO_YMD_DATETIME =
  /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::\d{2})?)?(?!\d)/;
const ABS_YMD = DATE_TOKENS.absYmd;
const ABS_MD = DATE_TOKENS.absMd;
const ABS_MD_SLASH = DATE_TOKENS.absMdSlash;

/**
 * 절대 *달* 표현(일 없음) — "5월" / "2026년 5월". 기간(span) 표현이라
 * eventDateRange 전용이다(extractEventDate 는 점 날짜만 다뤄 안 쓴다).
 * ABS_MD(일 포함)보다 *뒤에* 검사해야 "5월 25일" 이 점으로 잡힌다.
 */
const ABS_YM = DATE_TOKENS.absYm;

/** 상대 일 단위 토큰 → now 자정 기준 일 오프셋. */
const DAY_OFFSETS = DATE_TOKENS.dayOffsets;

/** "N일 전" / "N일 후". 캡처 그룹 1 = 숫자. */
const DAYS_AGO = DATE_TOKENS.daysAgo;
const DAYS_LATER = DATE_TOKENS.daysLater;

/** 주 단위 토큰 → 주 오프셋(0=이번주, -1=지난주, +1=다음주). */
const WEEK_OFFSETS = DATE_TOKENS.weekOffsets;

/**
 * 요일 이름 → getDay 값(0=일,1=월,...,6=토). 정규식이 아니라 단순 테이블 —
 * 매처가 "요일" 글자를 반드시 포함해 매칭하므로 "5월" 같은 표현은 오매칭 안 된다.
 */
const WEEKDAY_GETDAY = DATE_TOKENS.weekdayGetday;

/**
 * 요일 표현 정규식. 한정어(지난주/이번주/다음주/지난/저번/금주/담주) + "X요일".
 * 그룹 1 = 한정어(없을 수 있음), 그룹 2 = 요일 글자(월~일).
 */
const WEEKDAY = DATE_TOKENS.weekday;

/**
 * 요일 한정어(공백 제거 후) → 주 오프셋. 여기 없는 한정어("지난"/"저번" —
 * 주 글자 없음)는 가장 최근 과거 그 요일로 떨어진다(matchWeekday).
 */
const WEEKDAY_QUALIFIER_OFFSETS = DATE_TOKENS.weekdayQualifierOffsets;

/** 달 단위 토큰 → 달 오프셋. */
const MONTH_OFFSETS = DATE_TOKENS.monthOffsets;

/**
 * 해 단위 토큰 → 매치 문자열별 해 오프셋. 옛 resolver 함수("매치가 재작년이면
 * -2, 아니면 -1")를 offsets 매핑 데이터로 편 것 — 첫 매치 위치·순서 의미론은
 * matchYear/matchYearRange 가 그대로 보존한다.
 */
const YEAR_OFFSETS = DATE_TOKENS.yearOffsets;

// ── 시각 토큰(언어 의존) + 시각 변환 코어 ────────────────────────────────────
//
// 활용 단계2 ①: 날짜에 더해 "같은 날 안의 시각"을 살린다. 분 단위까지·초·timezone
// 미부착·로컬(T<HH>:<MM>). 시각이 애매하면(범위 밖·매칭 없음) null 로 빠져 시각을
// 지어내지 않는다(extractEventDate 의 "애매하면 null" 철학 정합).

/** 오전/오후 한정어 + 시 + (분). 그룹 1=오전·오후(없을 수 있음)·2=시·3=분(없을 수 있음). */
const HOUR_MINUTE = DATE_TOKENS.hourMinute;

/** 콜론 시각 HH:MM. 그룹 1=시·2=분. 앞뒤 숫자 차단으로 날짜 슬래시·연속 숫자 오인 방지. */
const COLON_TIME = DATE_TOKENS.colonTime;

/**
 * 한국어/콜론 시각 표현을 "HH:MM"(0-패딩)으로 변환. 범위 밖·매칭 없음은 null.
 * 12→24시: 오후면 +12(단 12시는 그대로), 오전 12시는 00 보정. 콜론 표기는 그대로.
 * 분 없으면 :00. 시>23·분>59 는 null(거짓 시각 미생성).
 */
function extractTimeOfDay(text: string): string | null {
  const colon = COLON_TIME.exec(text);
  if (colon) {
    const h = parseInt(colon[1]!, 10);
    const m = parseInt(colon[2]!, 10);
    if (h > 23 || m > 59) return null;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  const hm = HOUR_MINUTE.exec(text);
  if (hm) {
    const meridiem = hm[1];
    let h = parseInt(hm[2]!, 10);
    const m = hm[3] ? parseInt(hm[3], 10) : 0;
    if (h > 23 || m > 59) return null;
    // 12시간 → 24시간 보정 — 오전/오후 어휘는 프로파일 meridiem_am/pm 과 비교.
    if (meridiem === DATE_TOKENS.meridiemPm && h < 12) h += 12;
    else if (meridiem === DATE_TOKENS.meridiemAm && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  return null;
}

// ── 단계별 추출(언어 의존 매칭 → 언어 중립 계산) ─────────────────────────────

function matchAbsolute(text: string, now: Date): string | null {
  const iso = matchIsoDateTime(text);
  if (iso) return iso.date;
  const ymd = ABS_YMD.exec(text);
  if (ymd) {
    const year = parseInt(ymd[1]!, 10);
    const month = parseInt(ymd[2]!, 10);
    const day = parseInt(ymd[3]!, 10);
    if (isValidMonthDay(month, day)) return toIso(year, month, day);
  }
  const md = ABS_MD.exec(text);
  if (md) {
    const month = parseInt(md[1]!, 10);
    const day = parseInt(md[2]!, 10);
    if (isValidMonthDay(month, day)) return toIso(now.getFullYear(), month, day);
  }
  const slash = ABS_MD_SLASH.exec(text);
  if (slash) {
    const month = parseInt(slash[1]!, 10);
    const day = parseInt(slash[2]!, 10);
    if (isValidMonthDay(month, day)) return toIso(now.getFullYear(), month, day);
  }
  return null;
}

function matchIsoDateTime(text: string): { date: string; time: string | null } | null {
  const match = ISO_YMD_DATETIME.exec(text);
  if (!match) return null;
  const year = parseInt(match[1]!, 10);
  const month = parseInt(match[2]!, 10);
  const day = parseInt(match[3]!, 10);
  const d = new Date(year, month - 1, day);
  if (
    d.getFullYear() !== year ||
    d.getMonth() + 1 !== month ||
    d.getDate() !== day
  ) {
    return null;
  }
  const date = toIso(year, month, day);
  const rawHour = match[4];
  const rawMinute = match[5];
  if (rawHour === undefined || rawMinute === undefined) {
    return { date, time: null };
  }
  const hour = parseInt(rawHour, 10);
  const minute = parseInt(rawMinute, 10);
  if (hour > 23 || minute > 59) return null;
  return {
    date,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

function isValidMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function matchRelativeDay(text: string, now: Date): string | null {
  const agoM = DAYS_AGO.exec(text);
  if (agoM) return dateToIso(addDays(startOfDay(now), -parseInt(agoM[1]!, 10)));
  const laterM = DAYS_LATER.exec(text);
  if (laterM) return dateToIso(addDays(startOfDay(now), parseInt(laterM[1]!, 10)));
  for (const { regex, offset } of DAY_OFFSETS) {
    if (regex.test(text)) return dateToIso(addDays(startOfDay(now), offset));
  }
  return null;
}

function matchWeek(text: string, now: Date): string | null {
  for (const { regex, offset } of WEEK_OFFSETS) {
    if (regex.test(text)) {
      const thisMonday = startOfWeek(now, WEEK_START);
      return dateToIso(addDays(thisMonday, offset * 7));
    }
  }
  return null;
}

/**
 * 요일 한정어 한 주 안의 그 요일 날짜를 푼다(언어 중립 계산).
 * weekOffset: 0=이번주, -1=지난주, +1=다음주. targetGetDay: 0=일..6=토.
 * 주 시작(월요일, WEEK_START)에서 그 요일까지의 오프셋을 더한다.
 */
function weekdayInWeek(now: Date, weekOffset: number, targetGetDay: number): Date {
  const monday = addDays(startOfWeek(now, WEEK_START), weekOffset * 7);
  // 월요일 기준 그 요일까지의 일수: (targetGetDay - WEEK_START + 7) % 7.
  const dayOffset = (targetGetDay - WEEK_START + 7) % 7;
  return addDays(monday, dayOffset);
}

/**
 * 한정어 없는 "X요일"·"지난 X요일"·"저번 X요일" — now 이하에서 가장 최근의
 * 그 요일(now 가 그 요일이면 오늘). event-date 의 "과거 사건 우선" 철학 정합
 * (protect-until 의 미래 선택과 정반대 — 절대 섞지 말 것).
 */
function mostRecentWeekday(now: Date, targetGetDay: number): Date {
  const base = startOfDay(now);
  const daysBack = (base.getDay() - targetGetDay + 7) % 7;
  return addDays(base, -daysBack);
}

/**
 * 요일 표현을 닫힌 ISO 날짜로. 한정어가 주(지난주/이번주/다음주)면 그 주의 그 요일,
 * 한정어가 없거나 "지난"/"저번" 이면 now 이하 가장 최근의 그 요일.
 * matchWeek 보다 앞에 배치해 "다음주 금요일" 이 주(월요일)로 먼저 잡히지 않게 한다.
 */
function matchWeekday(text: string, now: Date): string | null {
  const m = WEEKDAY.exec(text);
  if (!m) return null;
  const targetGetDay = WEEKDAY_GETDAY[m[2]!];
  if (targetGetDay === undefined) {
    // weekday 패턴 캡처 2와 weekday_getday 매핑이 어긋난 프로파일 오류 —
    // 값을 지어내지 않고 loud throw(silent fallback 금지).
    throw new Error(
      `lang-profile: event_date.weekday_getday 에 요일 "${m[2]}" 항목 없음 — weekday 패턴과 매핑 어긋남`,
    );
  }
  const qualifier = m[1];
  if (qualifier) {
    const q = qualifier.replace(/\s+/g, "");
    const weekOffset = WEEKDAY_QUALIFIER_OFFSETS[q];
    // 주를 지시하는 한정어(지난주/이번주/다음주류)면 그 주의 그 요일.
    if (weekOffset !== undefined) return dateToIso(weekdayInWeek(now, weekOffset, targetGetDay));
    // 그 외 한정어("지난"/"저번" — 주 글자 없음) → 가장 최근 과거 그 요일.
  }
  return dateToIso(mostRecentWeekday(now, targetGetDay));
}

function matchMonth(text: string, now: Date): string | null {
  for (const { regex, offset } of MONTH_OFFSETS) {
    if (regex.test(text)) {
      return dateToIso(addMonthsToStart(startOfMonth(now), offset));
    }
  }
  return null;
}

/**
 * 해 토큰 매치 문자열의 오프셋. 프로파일 offsets 매핑에 없는 매치는 패턴과
 * 매핑이 어긋난 프로파일 오류라 loud throw(값을 지어내지 않는다).
 */
function yearOffsetOf(entry: MatchOffsetPatternEntry, matched: string): number {
  const offset = entry.offsetByMatch[matched];
  if (offset === undefined) {
    throw new Error(
      `lang-profile: event_date.year_offsets 패턴 "${entry.regex.source}" 의 offsets 에 매치 "${matched}" 항목 없음`,
    );
  }
  return offset;
}

function matchYear(text: string, now: Date): string | null {
  for (const entry of YEAR_OFFSETS) {
    const m = entry.regex.exec(text);
    if (m) return toIso(now.getFullYear() + yearOffsetOf(entry, m[0]), 1, 1);
  }
  return null;
}

// ── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * 한국어 시간 표현을 등록 시각(now) 기준 ISO 날짜(YYYY-MM-DD)로 변환.
 *
 * 우선순위(가장 구체적인 것 우선): 절대 > 상대 일 > 주 > 달 > 해.
 * 굴러가는(열린) 창 표현("지난 7일" 등)은 닫힌 날짜가 아니라서 맨 앞에서
 * null 로 컷한다. 매칭이 전혀 없어도 null.
 *
 * now 는 반드시 인자로 주입한다(테스트 결정성 — Date.now()/new Date() 호출
 * 금지). 모든 날짜 계산은 로컬 시간 기준.
 */
export function extractEventDate(text: string, now: Date): string | null {
  // 굴러가는 창 표현이면 닫힌 날짜가 아니므로 먼저 null 로 빠진다.
  if (ROLLING_WINDOW.test(text)) return null;

  return (
    matchAbsolute(text, now) ??
    matchRelativeDay(text, now) ??
    matchWeekday(text, now) ??
    matchWeek(text, now) ??
    matchMonth(text, now) ??
    matchYear(text, now)
  );
}

/**
 * 날짜 + 한국어 시각을 등록 시각(now) 기준 ISO 로 변환.
 *
 * extractEventDate 로 날짜를 풀고, extractTimeOfDay 로 시각을 푼다.
 *  - 날짜 + 시각 → "YYYY-MM-DDT<HH>:<MM>"
 *  - 날짜만(시각 애매/없음) → "YYYY-MM-DD"(extractEventDate 와 동일)
 *  - 날짜 없이 시각만 → "<오늘>T<HH>:<MM>"(사용자가 시각만 던지면 오늘 그 시각)
 *  - 날짜·시각 둘 다 없음 → null(정직 — 닫힌 일시 없음)
 *
 * 시각은 분 단위까지·초·timezone 미부착·로컬. 시각이 애매하면 시각 없이 날짜만
 * (거짓 시각 미생성). extractEventDate 의 시그니처·반환은 안 건드린다.
 * now 는 반드시 인자로 주입한다(테스트 결정성 — Date.now()/new Date() 금지).
 */
export function extractEventDateTime(text: string, now: Date): string | null {
  const iso = matchIsoDateTime(text);
  if (iso) {
    return iso.time === null ? iso.date : `${iso.date}T${iso.time}`;
  }
  const date = extractEventDate(text, now);
  const time = extractTimeOfDay(text);
  if (date === null) {
    if (time === null) return null;
    return `${dateToIso(startOfDay(now))}T${time}`;
  }
  if (time === null) return date;
  return `${date}T${time}`;
}

// ── 검색 시간 범위(닫힌 구간) ────────────────────────────────────────────────
//
// Phase 7 갈래 1 활용 — 검색어의 닫힌 시간 표현을 [since, until] 한 쌍의 ISO
// 날짜로 푼다. 점(point) 표현("5월 25일")은 그 하루({25,25}), 기간(span) 표현
// ("지난주"·"5월"·"작년")은 시작~끝({월요일,일요일} / {1일,말일} / {1월1일,12월31일}).
// 검색은 이 범위로 COALESCE(event_at, created_at) 후보를 *딱 거른다*(hard filter)
// — RRF 점수식은 안 건드리고 후보만 줄인다([[retriever-fusion-rrf]] 동등 합산 불변).
//
// 닫힌 표현만 푼다. 굴러가는(열린) 창("지난 7일")·매칭 없음은 null — extractEventDate
// 와 같은 정직 규칙(null 은 "닫힌 날짜 없음" 이지 실패 위장 fallback 이 아니다).

/** 검색 시간 범위 한 쌍 — since·until 둘 다 ISO 날짜(YYYY-MM-DD), 경계 포함. */
export interface EventDateRange {
  /** 구간 시작(이 날 포함). */
  since: string;
  /** 구간 끝(이 날 포함). 점 표현이면 since 와 같다. */
  until: string;
}

/** 점(하루) 표현 — since=until=같은 날. extractEventDate 의 점 매처를 재사용. */
function pointRange(iso: string): EventDateRange {
  return { since: iso, until: iso };
}

/** 주 span — now 가 가리키는 주(월요일~일요일). offset: 0=이번주, -1=지난주. */
function matchWeekRange(text: string, now: Date): EventDateRange | null {
  for (const { regex, offset } of WEEK_OFFSETS) {
    if (regex.test(text)) {
      const monday = addDays(startOfWeek(now, WEEK_START), offset * 7);
      const sunday = addDays(monday, 6);
      return { since: dateToIso(monday), until: dateToIso(sunday) };
    }
  }
  return null;
}

/**
 * 달 span — 절대 달("5월"·"2026년 5월") 또는 상대 달("지난달"). 1일~말일.
 * 절대 달이 상대 달보다 우선(더 구체적). 절대 달은 ABS_YM 으로 잡되 "5월 25일"
 * (일 포함)은 lookahead 로 제외해 점 매처가 가져가게 한다.
 */
function matchMonthRange(text: string, now: Date): EventDateRange | null {
  const ym = ABS_YM.exec(text);
  if (ym) {
    const year = ym[1] ? parseInt(ym[1], 10) : now.getFullYear();
    const month = parseInt(ym[2]!, 10);
    if (month >= 1 && month <= 12) {
      const start = new Date(year, month - 1, 1);
      return { since: dateToIso(start), until: dateToIso(endOfMonth(start)) };
    }
  }
  for (const { regex, offset } of MONTH_OFFSETS) {
    if (regex.test(text)) {
      const start = addMonthsToStart(startOfMonth(now), offset);
      return { since: dateToIso(start), until: dateToIso(endOfMonth(start)) };
    }
  }
  return null;
}

/** 해 span — "작년"·"올해"·"내년". 1월 1일~12월 31일. */
function matchYearRange(text: string, now: Date): EventDateRange | null {
  for (const entry of YEAR_OFFSETS) {
    const m = entry.regex.exec(text);
    if (m) {
      const year = now.getFullYear() + yearOffsetOf(entry, m[0]);
      return { since: toIso(year, 1, 1), until: toIso(year, 12, 31) };
    }
  }
  return null;
}

/**
 * 검색어의 닫힌 시간 표현을 [since, until] ISO 날짜 한 쌍으로 변환.
 *
 * 우선순위(가장 구체적인 것 우선): 절대 날짜(점) > 상대 일(점) > 주(span) >
 * 달(span) > 해(span). 점 표현은 since=until 한 날, span 표현은 시작~끝.
 * 굴러가는(열린) 창("지난 7일")·매칭 없음은 null(닫힌 구간 없음 — 정직).
 *
 * now 는 반드시 인자로 주입한다(테스트 결정성). 모든 계산은 로컬 시간 기준.
 * 점 매처(절대·상대 일)는 extractEventDate 와 같은 코어 헬퍼를 재사용한다 —
 * 한 표현이 점이면 그 하루가 곧 [그날, 그날] 구간이다.
 */
export function eventDateRange(text: string, now: Date): EventDateRange | null {
  // 굴러가는 창이면 닫힌 구간이 아니므로 먼저 null 로 빠진다(extractEventDate 정합).
  if (ROLLING_WINDOW.test(text)) return null;

  // 점 표현(절대 날짜·상대 일·요일) — extractEventDate 의 점 매처 그대로 재사용.
  // 요일("금요일")은 닫힌 하루라 점 표현이다. 주 span(matchWeekRange) 보다 앞에서
  // 잡아 "금요일" 검색이 그 하루 구간으로 풀리게 한다.
  const point =
    matchIsoDateTime(text)?.date ??
    matchAbsolute(text, now) ??
    matchRelativeDay(text, now) ??
    matchWeekday(text, now);
  if (point) return pointRange(point);

  // span 표현 — 주 > 달 > 해 순(점이 없을 때만).
  return (
    matchWeekRange(text, now) ??
    matchMonthRange(text, now) ??
    matchYearRange(text, now)
  );
}
