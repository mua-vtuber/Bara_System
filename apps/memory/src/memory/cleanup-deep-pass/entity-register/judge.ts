/**
 * entity-register/judge.ts — spec 4장 판정. AI 확신도가 아니라 코드 검사로 자동/제안/버림을 가른다(D3).
 * DB 를 모른다 — 기존 이름 색인·무시 기록·이미 연결된 이름·살아 있는 일정을 입력으로 받는다.
 */
import { getLanguageProfile } from "../../lang/profile-loader.ts";
import type { EntityRegisterProfile, EventDateProfile } from "../../lang/language-profile.ts";
import { ENTITY_REGISTER_LIMITS } from "./constants.ts";
import { checkScheduleDate, parseIsoDate } from "./date-check.ts";
import { entryNames, exactMatches, nameKey, normalizeName, similarMatches, splitHonorific } from "./name-match.ts";
import type {
  ActiveSchedule, EntityDecision, EntityNameIndex, EntityRegisterAiResult, EntityRegisterMemo,
  EntityRegisterOption, MemoJudgement, NameIndexEntry, ProposeReason, ScheduleDecision,
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
  return { nodeId: input.memo.nodeId, entities, schedule: judgeSchedule(input, content) };
}
