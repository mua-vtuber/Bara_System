/**
 * lang/profile-loader.ts — 언어 프로파일(lang/<code>.yaml) 로더 (P3 G5-c).
 *
 * lang/<code>.yaml 을 읽어 검증·컴파일 완료 LanguageProfile 로 변환한다.
 * 판정·파싱 로직은 소비 모듈(compute-intent / search-cues / short-text-gate /
 * event-date) TS 에 남고, 여기는 언어 의존 데이터만 공급한다.
 *
 * 실패 정책 — synonym-dictionary.ts 선례(필수 파일): 프로파일은 앱과 함께
 * 배포되는 **필수 파일**이라 파일 없음도 형식 어긋남도 어느 파일·어느 칸인지
 * 명시한 구체 에러로 throw 한다(silent fallback 금지). search-cues-loader.ts
 * 의 "파일 없음 = 자연 degrade" 는 *사용자 확장* 파일 얘기라 여기 적용하지
 * 않는다 — 같은 이유로 readYamlMapping(missing 을 degrade 신호로 합침)도
 * 안 쓴다(yaml-mapping.ts 머리 주석의 synonym-dictionary 분리 근거와 동일).
 *
 * 정규식 표기는 regex-l0 관례(patterns-loader.ts) 답습: yaml 에 더블 백슬래시
 * ("\\s")로 적힌 패턴이 parse 후 단일("\s")로 환원되고, 그 문자열을 new RegExp
 * 로 컴파일한다(컴파일 실패 = 구체 에러). 플래그가 필요한 패턴은
 * { pattern, flags } 매핑으로 적어 동일하게 컴파일한다(go_connector 의 "g" 등).
 *
 * 경로 해석: 소비 모듈들이 최상위 export 상수(RELATION_CUE_REGEX 등)를 모듈
 * 로드 시점에 초기화해야 해서 server.ts 부팅 주입(search-cues.yaml 방식)을
 * 탈 수 없다 — 대신 같은 메커니즘(join + import.meta.dir)으로 이 파일 옆의
 * <code>.yaml 을 해석한다. 테스트도 같은 경로로 로드된다.
 *
 * 언어 선택 골격: DEFAULT_LANGUAGE_CODE("ko") 한 곳. lang/en.yaml 을 같은 칸
 * 구성으로 추가하고 이 상수(또는 후속 settings 노브)만 바꾸면 다른 언어가
 * 붙는다 — settings 노브 신설은 G5-c 범위 밖이라 여기서는 상수 골격만 둔다.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type {
  ComputeIntentProfile,
  EntityRegisterProfile,
  EventDateProfile,
  LanguageProfile,
  MatchOffsetPatternEntry,
  OffsetPatternEntry,
  SearchCuesProfile,
  ShortTextGateProfile,
} from "./language-profile.ts";

/** 에러 메시지 접두어 — 어느 로더가 낸 에러인지 식별. */
const LABEL = "lang-profile";

/** default 언어 코드 — 언어 선택 골격의 단일 지점. */
export const DEFAULT_LANGUAGE_CODE = "ko";

/** <code>.yaml 경로 — 이 파일 옆(src/memory/lang/)에서 해석한다. */
export function languageProfilePath(code: string): string {
  return join(import.meta.dir, `${code}.yaml`);
}

/** field 칸의 정규식 컴파일. 실패는 칸·패턴·파일을 명시한 구체 에러. */
function compileRegex(pattern: string, flags: string, field: string, path: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    throw new Error(
      `${LABEL}: '${field}' 정규식 컴파일 실패 "${pattern}" (${path}): ${(e as Error).message}`,
    );
  }
}

/**
 * 패턴 칸 하나를 RegExp 로. 값은 정규식 문자열(플래그 없음) 또는
 * { pattern, flags } 매핑(플래그 필요 시). 그 외 형식은 칸 명시 구체 에러.
 */
function toRegex(value: unknown, field: string, path: string): RegExp {
  if (typeof value === "string" && value.length > 0) {
    return compileRegex(value, "", field, path);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (typeof o.pattern !== "string" || o.pattern.length === 0) {
      throw new Error(`${LABEL}: '${field}.pattern' 칸 누락/형식 어긋남 (${path})`);
    }
    const flags = o.flags ?? "";
    if (typeof flags !== "string") {
      throw new Error(`${LABEL}: '${field}.flags' 칸이 문자열이 아님 (${path})`);
    }
    return compileRegex(o.pattern, flags, field, path);
  }
  throw new Error(`${LABEL}: '${field}' 칸 누락/형식 어긋남 (${path})`);
}

/** 패턴 목록 칸. 비지 않은 목록이 아니면 칸 명시 구체 에러. */
function toRegexList(value: unknown, field: string, path: string): RegExp[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${LABEL}: '${field}' 칸이 비지 않은 목록이 아님 (${path})`);
  }
  return value.map((item, i) => toRegex(item, `${field}[${i}]`, path));
}

/** 문자열 칸. 비지 않은 문자열이 아니면 칸 명시 구체 에러. */
function toNonEmptyString(value: unknown, field: string, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${LABEL}: '${field}' 칸 누락/형식 어긋남 (${path})`);
  }
  return value;
}

/** 정수 칸. 유한 정수가 아니면 칸 명시 구체 에러. */
function toInteger(value: unknown, field: string, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${LABEL}: '${field}' 칸이 정수가 아님 (${path})`);
  }
  return value;
}

/** { pattern, offset } 항목 목록 칸(상대 날짜 토큰류). */
function toOffsetEntries(value: unknown, field: string, path: string): OffsetPatternEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${LABEL}: '${field}' 칸이 비지 않은 목록이 아님 (${path})`);
  }
  return value.map((item, i) => {
    const f = `${field}[${i}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`${LABEL}: '${f}' 항목이 매핑이 아님 (${path})`);
    }
    const o = item as Record<string, unknown>;
    return {
      regex: toRegex(o.pattern, `${f}.pattern`, path),
      offset: toInteger(o.offset, `${f}.offset`, path),
    };
  });
}

/**
 * 문자열 → 정수 매핑 칸(요일 테이블·한정어 오프셋). 값 범위(min..max)가
 * 주어지면 벗어나는 값도 칸 명시 구체 에러.
 */
function toIntegerMap(
  value: unknown,
  field: string,
  path: string,
  range?: { min: number; max: number },
): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${LABEL}: '${field}' 칸이 매핑이 아님 (${path})`);
  }
  const out: Record<string, number> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const f = `${field}.${key}`;
    const n = toInteger(v, f, path);
    if (range && (n < range.min || n > range.max)) {
      throw new Error(`${LABEL}: '${f}' 값 ${n} 이 범위(${range.min}..${range.max}) 밖 (${path})`);
    }
    out[key] = n;
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`${LABEL}: '${field}' 매핑이 비어 있음 (${path})`);
  }
  return out;
}

/** { pattern, offsets: 매치문자열→정수 } 항목 목록 칸(해 토큰류). */
function toMatchOffsetEntries(
  value: unknown,
  field: string,
  path: string,
): MatchOffsetPatternEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${LABEL}: '${field}' 칸이 비지 않은 목록이 아님 (${path})`);
  }
  return value.map((item, i) => {
    const f = `${field}[${i}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`${LABEL}: '${f}' 항목이 매핑이 아님 (${path})`);
    }
    const o = item as Record<string, unknown>;
    return {
      regex: toRegex(o.pattern, `${f}.pattern`, path),
      offsetByMatch: toIntegerMap(o.offsets, `${f}.offsets`, path),
    };
  });
}

/** 문자열 목록 칸. 비지 않은 목록이고 항목마다 비지 않은 문자열이어야 한다. */
function toNonEmptyStringList(value: unknown, field: string, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${LABEL}: ${field} 는 비어 있지 않은 문자열 목록이어야 함 (${path})`);
  }
  return value.map((item, i) => toNonEmptyString(item, `${field}[${i}]`, path));
}

/** 최상위 단락 칸. 매핑이 아니면 단락 명시 구체 에러. */
function requireSection(
  root: Record<string, unknown>,
  name: string,
  path: string,
): Record<string, unknown> {
  const v = root[name];
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`${LABEL}: '${name}' 단락 누락/매핑 아님 (${path})`);
  }
  return v as Record<string, unknown>;
}

function parseComputeIntent(root: Record<string, unknown>, path: string): ComputeIntentProfile {
  const s = requireSection(root, "compute_intent", path);
  const re = (key: string) => toRegex(s[key], `compute_intent.${key}`, path);
  return {
    logIntent: re("log_intent"),
    timelineIntent: re("timeline_intent"),
    countIntent: re("count_intent"),
    listIntent: re("list_intent"),
    numericIntent: re("numeric_intent"),
  };
}

function parseSearchCues(root: Record<string, unknown>, path: string): SearchCuesProfile {
  const s = requireSection(root, "search_cues", path);
  const re = (key: string) => toRegex(s[key], `search_cues.${key}`, path);
  return {
    relationCue: re("relation_cue"),
    topicCue: re("topic_cue"),
  };
}

function parseShortTextGate(root: Record<string, unknown>, path: string): ShortTextGateProfile {
  const s = requireSection(root, "short_text_gate", path);
  const re = (key: string) => toRegex(s[key], `short_text_gate.${key}`, path);
  return {
    clauseConnectors: toRegexList(s.clause_connectors, "short_text_gate.clause_connectors", path),
    goConnector: re("go_connector"),
    reportedSpeechGo: re("reported_speech_go"),
    terminatorPunctuation: re("terminator_punctuation"),
    sentenceFinal: re("sentence_final"),
    multiFactSignals: toRegexList(s.multi_fact_signals, "short_text_gate.multi_fact_signals", path),
  };
}

function parseEventDate(root: Record<string, unknown>, path: string): EventDateProfile {
  const s = requireSection(root, "event_date", path);
  const n = "event_date";
  const re = (key: string) => toRegex(s[key], `${n}.${key}`, path);
  return {
    rollingWindow: re("rolling_window"),
    absYmd: re("abs_ymd"),
    absYmdNumeric: re("abs_ymd_numeric"),
    absMd: re("abs_md"),
    absMdSlash: re("abs_md_slash"),
    absYm: re("abs_ym"),
    dayOffsets: toOffsetEntries(s.day_offsets, `${n}.day_offsets`, path),
    daysAgo: re("days_ago"),
    daysLater: re("days_later"),
    weekOffsets: toOffsetEntries(s.week_offsets, `${n}.week_offsets`, path),
    // getDay 값 테이블 — 0(일)..6(토) 밖은 프로파일 오류.
    weekdayGetday: toIntegerMap(s.weekday_getday, `${n}.weekday_getday`, path, { min: 0, max: 6 }),
    weekday: re("weekday"),
    weekdayQualifierOffsets: toIntegerMap(
      s.weekday_qualifier_offsets,
      `${n}.weekday_qualifier_offsets`,
      path,
    ),
    monthOffsets: toOffsetEntries(s.month_offsets, `${n}.month_offsets`, path),
    monthDay: re("month_day"),
    yearOffsets: toMatchOffsetEntries(s.year_offsets, `${n}.year_offsets`, path),
    hourMinute: re("hour_minute"),
    colonTime: re("colon_time"),
    meridiemAm: toNonEmptyString(s.meridiem_am, `${n}.meridiem_am`, path),
    meridiemPm: toNonEmptyString(s.meridiem_pm, `${n}.meridiem_pm`, path),
  };
}

/**
 * 언어 프로파일 yaml 한 장을 읽어 컴파일 완료 LanguageProfile 로 변환한다.
 *
 * 필수 파일이라 파일 없음(ENOENT)·읽기 실패·yaml 파싱 실패·빈 파일·칸 누락·
 * 형식 어긋남·정규식 컴파일 실패 전부 어느 파일·어느 칸인지 명시한 구체
 * 에러로 throw 한다(silent fallback 금지).
 */
export function loadLanguageProfile(path: string): LanguageProfile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `${LABEL}: 필수 언어 프로파일 파일 없음 (${path}) — lang/<code>.yaml 은 앱과 함께 배포되는 필수 파일이다`,
      );
    }
    throw new Error(`${LABEL}: 파일을 읽지 못함 (${path}): ${(e as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (e) {
    throw new Error(`${LABEL}: yaml 파싱 실패 (${path}): ${(e as Error).message}`);
  }
  if (parsed === null || parsed === undefined) {
    throw new Error(`${LABEL}: 필수 언어 프로파일이 비어 있음 (${path})`);
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${LABEL}: 최상위가 매핑이 아님 (${path})`);
  }
  const root = parsed as Record<string, unknown>;

  return {
    code: toNonEmptyString(root.lang, "lang", path),
    computeIntent: parseComputeIntent(root, path),
    searchCues: parseSearchCues(root, path),
    shortTextGate: parseShortTextGate(root, path),
    eventDate: parseEventDate(root, path),
    entityRegister: parseEntityRegister(root, path),
  };
}

function parseEntityRegister(root: Record<string, unknown>, path: string): EntityRegisterProfile {
  const section = requireSection(root, "entity_register", path);
  const suffixes = toNonEmptyStringList(section.honorific_suffixes, "entity_register.honorific_suffixes", path);
  const finalConsonant = toNonEmptyStringList(
    section.final_consonant_suffixes,
    "entity_register.final_consonant_suffixes",
    path,
  );
  const outside = finalConsonant.filter((s) => !suffixes.includes(s));
  if (outside.length > 0) {
    throw new Error(
      `${LABEL}: entity_register.final_consonant_suffixes 의 ${outside.join(", ")} 가 honorific_suffixes 에 없음 (${path})`,
    );
  }
  return {
    honorificSuffixes: [...suffixes].sort((a, b) => b.length - a.length),
    finalConsonantSuffixes: finalConsonant,
  };
}

/** default 프로파일 캐시 — 소비 모듈 4개가 한 번 로드한 것을 공유한다. */
let cachedDefault: LanguageProfile | undefined;

/**
 * default 언어(DEFAULT_LANGUAGE_CODE) 프로파일 — 1회 로드 후 캐시.
 *
 * 소비 모듈 4개가 모듈 로드 시점에 호출하므로, 프로파일 결함은 부팅·테스트
 * 로드에서 즉시 loud fail 한다(운영 중간에 조용히 어긋나는 일 없음).
 */
export function getLanguageProfile(): LanguageProfile {
  if (cachedDefault === undefined) {
    cachedDefault = loadLanguageProfile(languageProfilePath(DEFAULT_LANGUAGE_CODE));
  }
  return cachedDefault;
}
