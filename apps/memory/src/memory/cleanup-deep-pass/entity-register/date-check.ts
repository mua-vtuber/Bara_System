/**
 * entity-register/date-check.ts — 일정 날짜 판정(spec 4.5). 순수 함수.
 * 날짜 형식 패턴은 lang/ko.yaml event_date 가 단일 출처다(abs_ymd·abs_md·abs_md_slash·day_offsets·
 * hour_minute·colon_time). 상대 표현은 정리가 도는 날이 아니라 메모 작성일 기준으로 계산한다.
 * 기존 extractEventDate 에는 의존하지 않는다(spec 4.5 — "다음 달 15일" 오류와 무관하게).
 */
import type { EventDateProfile } from "../../lang/language-profile.ts";

export type DateCheck = "auto" | "relative" | "mismatch";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(value: string): { y: number; m: number; d: number } | null {
  const m = ISO_DATE.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

/** createdAt("YYYY-MM-DD HH:MM:SS")의 날짜에 days 를 더한 "YYYY-MM-DD". 날짜 부분이 깨졌으면 throw. */
export function addDaysToCreatedAt(createdAt: string, days: number): string {
  const base = parseIsoDate(createdAt.slice(0, 10));
  if (!base) throw new Error(`entity-register: 메모 작성일 형식이 아님(createdAt=${createdAt})`);
  const t = new Date(Date.UTC(base.y, base.m - 1, base.d + days));
  return t.toISOString().slice(0, 10);
}

function removeAll(text: string, pattern: RegExp): string {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  return text.replace(global, " ");
}

/** 표현이 날 단어 하나(+시각)만으로 이뤄졌으면 그 오프셋, 아니면 null. */
function dayWordOffset(text: string, profile: EventDateProfile): number | null {
  let rest = text;
  let found: number | null = null;
  for (const { regex, offset } of profile.dayOffsets) {
    const m = regex.exec(rest);
    if (!m) continue;
    if (found !== null) return null;
    found = offset;
    rest = rest.replace(m[0], " ");
  }
  if (found === null) return null;
  rest = removeAll(removeAll(rest, profile.hourMinute), profile.colonTime);
  return rest.trim().length === 0 ? found : null;
}

/** 날짜 부분과 시각(시·분, 콜론 시각)을 걷어낸 뒤에도 숫자가 남는가. */
function hasLeftoverDigits(text: string, profile: EventDateProfile): boolean {
  const rest = removeAll(removeAll(text, profile.hourMinute), profile.colonTime);
  return /\d/.test(rest);
}

export function checkScheduleDate(args: {
  dateText: string;
  aiDate: string;
  createdAt: string;
  profile: EventDateProfile;
}): DateCheck {
  const ai = parseIsoDate(args.aiDate);
  if (!ai) return "mismatch";
  const ymd = args.profile.absYmd.exec(args.dateText);
  if (ymd) {
    return Number(ymd[1]) === ai.y && Number(ymd[2]) === ai.m && Number(ymd[3]) === ai.d ? "auto" : "mismatch";
  }
  const md = args.profile.absMd.exec(args.dateText) ?? args.profile.absMdSlash.exec(args.dateText);
  if (md) {
    // 연도가 따로 적힌 표현("2006/9/28", "06년 9월 28일")은 연도까지 맞는지 코드가 못 가린다 — 사람 확인으로 보낸다.
    if (hasLeftoverDigits(args.dateText.replace(md[0], " "), args.profile)) return "relative";
    return Number(md[1]) === ai.m && Number(md[2]) === ai.d ? "auto" : "mismatch";
  }
  const offset = dayWordOffset(args.dateText, args.profile);
  if (offset !== null) return addDaysToCreatedAt(args.createdAt, offset) === args.aiDate ? "auto" : "mismatch";
  return "relative";
}
