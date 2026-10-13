/**
 * compute-numeric-aggregate.ts — 수치 합계·평균 집계기 (단계6b).
 *
 * 단계5 resolveComputeCandidates 가 좁힌 후보 글들의 지정 숫자형 칸 값(글자)을
 * parseNumericFieldValue 로 읽어 SUM·AVG 를 낸다. 못 읽는 값은 제외 + excludedCount
 * 로 센다(0 변환 금지). 세 경우(진짜 0 / 칸 부재 / 못 읽는 값 제외)를 구분 산출한다.
 * 후보 좁히기·정렬은 안 한다 — 칸 추출 + 합산/나누기만. LLM 0·결정적.
 */
import type { SqliteMemoryStore } from "../db/store.ts";
import { parseNumericFieldValue } from "./numeric-field-parse.ts";

/** AVG 분모 B 시간 단위. 분모 A(글당)는 count 로 별 표기. */
export type AvgDivisorUnit = "day" | "week" | "month" | "year";

/** 평균 일수 환산 상수(분모 B 주·달·해). 그레고리력 평균(윤년 분산 흡수). */
const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 30.4375; // 365.25 / 12
const DAYS_PER_YEAR = 365.25;

/** ISO 날짜(YYYY-MM-DD) 한 쌍을 달력 일수(경계 포함·일 차이+1)로. */
function calendarDays(since: string, until: string): number {
  const a = new Date(`${since}T00:00:00.000Z`).getTime();
  const b = new Date(`${until}T00:00:00.000Z`).getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * 분모 B(기간 전체) 시간 단위 수를 since~until 에서 도출한다(안 쓴 날도 0 포함·
 * 달력 일수 기준·spec §5.3). day=달력 일수, week=÷7, month=÷30.4375, year=÷365.25.
 * 주·달·해는 평균 일수 분모라 소수일 수 있다(이번달 30일 → 달수 ≈0.9856).
 */
export function divisorForRange(
  since: string,
  until: string,
  unit: AvgDivisorUnit,
): number {
  const days = calendarDays(since, until);
  switch (unit) {
    case "day": return days;
    case "week": return days / DAYS_PER_WEEK;
    case "month": return days / DAYS_PER_MONTH;
    case "year": return days / DAYS_PER_YEAR;
  }
}

/** AVG 분모 B 입력(기간 단위 평균). 미지정이면 분모 A(글당). */
export interface AvgDivisorOpts {
  unit: AvgDivisorUnit;
  since: string;
  until: string;
}

/**
 * 좁혀진 글들의 지정 숫자형 칸 값을 SUM·AVG 낸다(단계6b). getNodesByIds 로
 * 실체화한 뒤 각 글 metadata.fields[field] 를 parseNumericFieldValue 로 읽는다.
 * 못 읽는 값은 제외 + excludedCount. 칸 값이 0건이면 numericFieldPresent:false
 * (0 위장 아님). AVG 분모 = avgDivisor 미지정이면 읽힌 건수(A), 지정이면
 * divisorForRange(B). 분모 0(읽힌 건수 0 or 일수 0)이면 value 미산출(NaN 회피).
 * readCount = 숫자로 읽힌 건수(count 는 총 글 수라 둘이 다르다 — 전부 못 읽으면
 * count>0·readCount=0). UI 가 "읽을 수 있는 값 없음"을 readCount 로 판단한다(C1).
 */
export async function computeNumericAggregate(
  store: SqliteMemoryStore,
  nodeIds: Set<number>,
  field: string,
  kind: "sum" | "avg",
  avgDivisor?: AvgDivisorOpts,
): Promise<{
  kind: "sum" | "avg";
  count: number;
  readCount: number;
  value?: number;
  numericFieldPresent: boolean;
  excludedCount: number;
  avgDivisor?: number;
  avgDivisorKind?: "count" | AvgDivisorUnit;
}> {
  const nodes = await store.getNodesByIds([...nodeIds]);
  let sum = 0;
  let read = 0;
  let excluded = 0;
  for (const node of nodes) {
    const fields = (node.metadata as { fields?: Record<string, unknown> }).fields;
    const raw = fields?.[field];
    if (typeof raw !== "string" || raw.trim().length === 0) continue; // 칸 미입력 — 부재
    const n = parseNumericFieldValue(raw);
    if (n === null) { excluded += 1; continue; }                       // 못 읽음 — 제외
    sum += n;
    read += 1;
  }
  const numericFieldPresent = read > 0 || excluded > 0;
  // 칸 부재(읽힌 값·제외 둘 다 0) → value 미산출(0 위장 아님). read=0 이라 readCount:0.
  if (!numericFieldPresent) {
    return { kind, count: nodes.length, readCount: read, numericFieldPresent: false, excludedCount: 0 };
  }
  if (kind === "sum") {
    return { kind, count: nodes.length, readCount: read, value: sum, numericFieldPresent: true, excludedCount: excluded };
  }
  // avg — 분모 A(읽힌 건수) 또는 분모 B(기간 단위 수).
  const divisor = avgDivisor
    ? divisorForRange(avgDivisor.since, avgDivisor.until, avgDivisor.unit)
    : read;
  const divisorKind: "count" | AvgDivisorUnit = avgDivisor ? avgDivisor.unit : "count";
  // 분모 0 이면 value 미산출(NaN/Infinity 회피·정직).
  if (divisor <= 0) {
    return { kind, count: nodes.length, readCount: read, numericFieldPresent: true, excludedCount: excluded, avgDivisor: divisor, avgDivisorKind: divisorKind };
  }
  return {
    kind, count: nodes.length, readCount: read, value: sum / divisor,
    numericFieldPresent: true, excludedCount: excluded,
    avgDivisor: divisor, avgDivisorKind: divisorKind,
  };
}
