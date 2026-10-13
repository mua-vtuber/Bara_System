/**
 * search-params — POST /search body 파싱·검증 헬퍼 모음(C1 분해).
 *
 * search.ts 라우트가 body 칸을 retriever 옵션으로 흘리기 전에 거치던 방어 파싱
 * (polarity·memoryType·filter·kind·fieldFilters·place·dateRange)을 한 파일로 모았다.
 * 전부 순수 함수(store·Hono 의존 0) — 입력 unknown → 검증된 값 또는 undefined. 라우트
 * 핸들러를 얇게 만들고 파싱 규칙을 한 곳에 모은다. resolvePlaceSignal(store 의존)은
 * search.ts 에 남아 외부 import 표면(search.test.ts·compute.ts 참조)을 보존한다.
 *
 * 동작 보존: 함수 본체·정규식·trim 규칙은 옛 search.ts 와 byte 동일하다(이동만).
 */

import type { Polarity, MemoryType } from "../../memory/types.ts";
import { eventDateRange, type EventDateRange } from "../../memory/event-date.ts";

/** body.polarity 가 유효한 Polarity enum 문자열일 때만 그 값, 아니면 undefined. */
export function parsePolarity(raw: unknown): Polarity | undefined {
  return raw === "positive" || raw === "negative" || raw === "neutral"
    ? raw
    : undefined;
}

/** MemoryType enum 멤버 — parseMemoryType 의 단일 출처(검색 입구 검증용). */
const MEMORY_TYPES: readonly MemoryType[] = [
  "fact",
  "preference",
  "triple",
  "insight",
  "episode",
];

/**
 * memory_type 한정 필터 파싱(공통 인프라 1.2 / 통일 원칙). 유효한 MemoryType enum
 * 문자열일 때만 그 값, 아니면 undefined(필터 미적용 = 전 후보 통과 / 도입 전 동작
 * 불변). polarity 방어 패턴 그대로 — camelCase(memoryType)·snake_case(memory_type)
 * 둘 다 받아 호출자 표기 차이를 흡수한다. retriever 가 RRF 합산 *전* 후보를 줄인다
 * (가중치 변경 아님 — RRF 코어 불변).
 */
export function parseMemoryType(raw: unknown): MemoryType | undefined {
  return typeof raw === "string" &&
    (MEMORY_TYPES as readonly string[]).includes(raw)
    ? (raw as MemoryType)
    : undefined;
}

/**
 * body.filter 가 객체일 때, 값이 공백 제거 후 1자 이상 문자열인 항목만 추려
 * (분류 키 → 분류 값) 매핑을 만든다. 유효 항목이 0개면 undefined 를 돌려
 * 라우트가 필터를 통째로 건너뛰게 한다(필터 미적용 = 1.1b 동작 불변).
 * project 칸과 같은 방어 패턴 — 비객체·빈 값은 조용히 무시한다.
 */
export function parseFilter(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim().length > 0) {
      out[key] = value.trim();
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * body.kind 가 문자열이고 공백 제거 후 1자 이상이면 그 값(trim)을, 아니면 undefined 를
 * 돌린다(활용 단계6 T4 종류 캡슐). project·place 와 같은 방어 패턴 — 비문자열·빈 값이면
 * 라우트가 kind 를 retriever 에 안 넘겨 종류 필터 미적용(미전달 = 미적용 = 도입 전
 * byte 동일). kind 는 후보를 *축소* 하는 하드 필터라 빈 값이 "전부 통과" 가 된다.
 */
export function parseKind(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0
    ? raw.trim()
    : undefined;
}

/**
 * body.fieldFilters 가 배열이고 각 항목이 객체이며 key·value 가 공백 제거 후 1자
 * 이상 문자열인 것만 추려 `{key,value}` 목록을 만든다(활용 단계6 T4 칸 캡슐). 유효
 * 항목이 0개면 undefined 를 돌려 라우트가 필터를 통째로 건너뛰게 한다(필터 미적용 =
 * 도입 전 동작 불변). filter 칸과 같은 방어 패턴 — 비배열·무효 항목은 조용히 무시한다.
 */
export function parseFieldFilters(
  raw: unknown,
): Array<{ key: string; value: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Array<{ key: string; value: string }> = [];
  for (const it of raw) {
    if (it && typeof it === "object" && !Array.isArray(it)) {
      const rec = it as Record<string, unknown>;
      const key = typeof rec.key === "string" ? rec.key.trim() : "";
      const value = typeof rec.value === "string" ? rec.value.trim() : "";
      if (key && value) out.push({ key, value });
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * body.place 가 문자열이고 공백 제거 후 1자 이상이면 그 값을, 아니면 undefined 를
 * 돌린다(활용 단계4 T2 / search-field-filter D6). project·filter 와 같은 방어 패턴 —
 * 비문자열·빈 값이면 라우트가 placeValue 를 retriever 에 안 넘겨 장소 가산 미적용
 * (미전달 = 미적용 = 도입 전 byte 동일). 장소 소프트 가산은 후보를 안 줄이는 *가산점*
 * 이라 빈 값이 "전부 통과" 가 아니라 "가산 0" 이 된다(하드 필터와 다른 의미).
 */
export function parsePlace(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  return undefined;
}

/**
 * 이미지 유사도 검색 채널 토글. true 또는 문자열 true/1 일 때만 켠다.
 * 미지정 기본값은 OFF 이다. 이미지가 있는 DB에서 모든 일반 검색이 SigLIP text
 * tower 를 자동 로드해 메모리를 크게 잡아먹는 것을 막고, 이미지 전용 검색 UI가
 * 명시적으로 요청할 때만 image_vec 채널을 실행한다.
 */
export function parseImageSearch(raw: unknown): boolean {
  return raw === true || raw === "true" || raw === "1";
}

/** ISO 날짜(YYYY-MM-DD) 양식 검사 — 명시 since/until 파라미터 방어용. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 검색 시간 범위 해석(Phase 7 갈래 1 / Task 5). 우선순위:
 *   1. 명시 파라미터 body.since/until 이 둘 다 유효 ISO 날짜면 그대로 사용.
 *   2. 아니면 검색어 query 에서 eventDateRange(query, now) 로 닫힌 시간 표현 자동 추출.
 *   3. 둘 다 없으면 undefined — 필터 미적용(전 후보 통과 / 회귀 0).
 *
 * 명시 파라미터는 "딱 이 범위" 라는 호출자 의도라 query 자동 추출보다 우선한다.
 * 한쪽만 유효한 절반 입력은 닫힌 구간이 아니므로 명시 통로를 건너뛰고 자동 추출로
 * 넘어간다(에러 아님 — query 에 시간 표현이 있으면 거기서 잡힌다 / 정직한 graceful).
 * now 는 호출 시점 현재 시각(상대 표현 "지난주" 의 기준점).
 */
export function resolveDateRange(
  rawSince: unknown,
  rawUntil: unknown,
  query: string,
  now: Date,
): EventDateRange | undefined {
  if (
    typeof rawSince === "string" &&
    ISO_DATE.test(rawSince) &&
    typeof rawUntil === "string" &&
    ISO_DATE.test(rawUntil)
  ) {
    return { since: rawSince, until: rawUntil };
  }
  return eventDateRange(query, now) ?? undefined;
}
