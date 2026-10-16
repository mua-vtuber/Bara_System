/**
 * entity-register/judge.ts — spec 4장 판정. AI 확신도가 아니라 코드 검사로 자동/제안/버림을 가른다(D3).
 * DB 를 모른다 — 기존 이름 색인·무시 기록·이미 연결된 이름·살아 있는 일정을 입력으로 받는다.
 */
import { getLanguageProfile } from "../../lang/profile-loader.ts";
import type { EntityRegisterProfile, EventDateProfile } from "../../lang/language-profile.ts";
import { ENTITY_REGISTER_LIMITS } from "./constants.ts";
import { checkScheduleDate, isYearlessAbsoluteText, parseIsoDate } from "./date-check.ts";
import { entryNames, exactMatches, nameKey, normalizeName, similarMatches, splitHonorific } from "./name-match.ts";
import type {
  ActiveSchedule, EntityDecision, EntityNameIndex, EntityRegisterAiResult, EntityRegisterMemo,
  EntityRegisterOption, MemoDateDecision, MemoEventAtState, MemoJudgement, NameIndexEntry, ProposeReason, ScheduleDecision,
} from "./types.ts";

export interface JudgeProfile {
  entityRegister: EntityRegisterProfile;
  eventDate: EventDateProfile;
}

export interface JudgeInput {
  memo: EntityRegisterMemo;
  result: EntityRegisterAiResult;
  index: EntityNameIndex;
  allowedTypes: ReadonlySet<string>;
  /** 이 메모에서 무시·되돌린 이름의 nameKey. */
  ignoredNames: ReadonlySet<string>;
  scheduleIgnored: boolean;
  activeSchedule: ActiveSchedule | null;
  /** 원본 메모의 현재 event_at 칸(출처 무관). 행이 없으면 found:false. */
  memoEventAt: MemoEventAtState;
  /** 이 메모에서 메모 날짜를 거절했거나 되돌렸는가. */
  memoDateIgnored: boolean;
  autoApply: boolean;
  profile: JudgeProfile;
}

export function judgeProfileFromLanguage(): JudgeProfile {
  const lang = getLanguageProfile();
  return { entityRegister: lang.entityRegister, eventDate: lang.eventDate };
}

const IGNORE: EntityRegisterOption = { kind: "ignore" };

function linkOption(target: NameIndexEntry, memoName: string): EntityRegisterOption {
  const key = nameKey(memoName);
  return {
    kind: "link_existing",
    targetId: target.id,
    targetName: target.name,
    addAlias: !entryNames(target).some((n) => nameKey(n) === key),
  };
}

function propose(type: string, name: string, reason: ProposeReason, options: EntityRegisterOption[]): EntityDecision {
  return { action: "propose", type, name, reason, options };
}

function judgeEntity(input: JudgeInput, content: string, linked: ReadonlySet<string>, type: string, name: string): EntityDecision {
  if (!input.allowedTypes.has(type)) return { action: "discard", type, name, reason: "unknown_type" };
  if (!name || name.length > ENTITY_REGISTER_LIMITS.nameMaxChars) return { action: "discard", type, name, reason: "invalid_name" };
  if (!content.includes(name)) return { action: "discard", type, name, reason: "not_in_text" };
  const key = nameKey(name);
  if (input.ignoredNames.has(key)) return { action: "discard", type, name, reason: "ignored" };
  if (linked.has(key)) return { action: "discard", type, name, reason: "already_linked" };

  const entries = input.index.byType.get(type) ?? [];
  const exact = exactMatches(entries, name);
  if (exact.length === 1) {
    const target = exact[0]!;
    return input.autoApply
      ? { action: "auto_link", type, name, target }
      : propose(type, name, "auto_apply_off", [linkOption(target, name), IGNORE]);
  }
  if (exact.length > 1) return propose(type, name, "homonym", [...exact.map((t) => linkOption(t, name)), IGNORE]);

  const minChars = ENTITY_REGISTER_LIMITS.minSimilarNameChars;
  const similar = similarMatches(entries, name, input.profile.entityRegister, minChars);
  if (similar.length > 0) {
    return propose(type, name, "similar", [
      ...similar.map((t) => linkOption(t, name)),
      { kind: "create", name, aliasFromMemo: null },
      IGNORE,
    ]);
  }
  const split = splitHonorific(name, input.profile.entityRegister, minChars);
  if (split) {
    return propose(type, name, "honorific", [
      { kind: "create", name: split.base, aliasFromMemo: name },
      { kind: "create", name, aliasFromMemo: null },
      IGNORE,
    ]);
  }
  return input.autoApply
    ? { action: "auto_create", type, name }
    : propose(type, name, "auto_apply_off", [{ kind: "create", name, aliasFromMemo: null }, IGNORE]);
}

function judgeSchedule(input: JudgeInput, content: string): ScheduleDecision {
  if (input.scheduleIgnored) return { action: "none", reason: "ignored" };
  const r = input.result;
  const dateText = r.eventDateText ? normalizeName(r.eventDateText) : "";
  if (!dateText || !r.eventDate) return { action: "none", reason: "no_date" };
  if (!content.includes(dateText)) return { action: "none", reason: "date_text_not_in_text" };
  const title = r.scheduleTitle ? normalizeName(r.scheduleTitle) : "";
  const titleOk = title.length > 0 && title.length <= ENTITY_REGISTER_LIMITS.titleMaxChars;
  const date = parseIsoDate(r.eventDate) ? r.eventDate : null;
  const base = { title: titleOk ? title : "", date, dateText };

  const active = input.activeSchedule;
  if (active) {
    if (active.date === r.eventDate) return { action: "none", reason: "already_registered" };
    return { action: "propose", reason: "replace_existing", ...base, title: titleOk ? title : active.title, existingScheduleNodeId: active.nodeId };
  }
  if (!titleOk) return { action: "propose", reason: "title_invalid", ...base, existingScheduleNodeId: null };
  const check = checkScheduleDate({ dateText, aiDate: r.eventDate, createdAt: input.memo.createdAt, profile: input.profile.eventDate });
  if (check === "auto") {
    return input.autoApply
      ? { action: "auto", title, date: r.eventDate, dateText }
      : { action: "propose", reason: "auto_apply_off", ...base, existingScheduleNodeId: null };
  }
  return { action: "propose", reason: check === "relative" ? "relative" : "mismatch", ...base, existingScheduleNodeId: null };
}

/**
 * 원본 메모의 event_at 채우기(yearless-date-cleanup spec 3.3). 일정 판정과 독립이다 — 일정 제목이 없어도,
 * 과거형 메모여도 같은 규칙으로 본다. 연도는 코드가 확인하지 않고 AI 가 문맥으로 정한 값을 쓴다.
 * 위에서부터 처음 맞는 줄을 따른다. 연도 없는 절대 날짜 표현만 다룬다(그 밖은 저장 경로 몫 — 6번).
 */
export function judgeMemoDate(input: JudgeInput, content: string): MemoDateDecision {
  if (!input.memoEventAt.found) return { action: "none", reason: "memo_missing" };
  if (input.memoEventAt.eventAt !== null) return { action: "none", reason: "already_set" };
  if (input.memoDateIgnored) return { action: "none", reason: "ignored" };
  const r = input.result;
  const dateText = r.eventDateText ? normalizeName(r.eventDateText) : "";
  if (!dateText || !r.eventDate) return { action: "none", reason: "no_date" };
  if (!content.includes(dateText)) return { action: "none", reason: "date_text_not_in_text" };
  if (!isYearlessAbsoluteText(dateText, input.profile.eventDate)) return { action: "none", reason: "not_yearless" };
  const check = checkScheduleDate({ dateText, aiDate: r.eventDate, createdAt: input.memo.createdAt, profile: input.profile.eventDate });
  if (check === "auto") {
    return input.autoApply
      ? { action: "auto", date: r.eventDate, dateText }
      : { action: "propose", reason: "auto_apply_off", date: r.eventDate, dateText };
  }
  // 날짜 칸은 AI 날짜가 실제 날짜일 때만 미리 채운다(일정 제안과 같은 규칙).
  const date = parseIsoDate(r.eventDate) ? r.eventDate : null;
  return { action: "propose", reason: check, date, dateText };
}

export function judgeMemo(input: JudgeInput): MemoJudgement {
  const content = normalizeName(input.memo.content);
  const linked = new Set(input.memo.alreadyLinked.map(nameKey));
  const seen = new Set<string>();
  const entities: EntityDecision[] = [];
  for (const raw of input.result.entities) {
    const type = raw.type.trim();
    const name = normalizeName(raw.name);
    const dedupe = `${type}\u001f${nameKey(name)}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    entities.push(judgeEntity(input, content, linked, type, name));
  }
  return {
    nodeId: input.memo.nodeId,
    entities,
    schedule: judgeSchedule(input, content),
    memoDate: judgeMemoDate(input, content),
  };
}
