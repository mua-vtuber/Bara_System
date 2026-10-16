/**
 * entity-register/proposal.ts — 정리 제안 entity_register(spec 6장). 메모 하나당 제안 하나.
 * 승인은 applyMemoChanges(자동 반영과 같은 함수)로 하고, 항목별 결과는 렌즈 초안과 같은
 * cleanup_proposal_item_journal 에 남긴다. 적용 직전에 메모·기존 항목을 다시 확인한다.
 *
 * 승인은 일부만 반영하지 않는다: applyMemoChanges 가 거부하면(그 사이 일정이 생기거나 바뀜 등) 이번
 * 승인의 어떤 쓰기(무시 기록 포함)도 남기지 않고, 제안을 오래된 제안으로 보고 사유를 돌려준다.
 * 항목 하나만 오래된 경우(같은 이름이 생김·연결 대상이 사라짐)는 그 항목만 failed 다.
 */
import type { SqliteMemoryStore } from "../../../db/store.ts";
import type { CleanupProposal, CleanupProposalsRepository } from "../../../db/store-internal/cleanup-proposals-repository.ts";
import { entityRegisterFingerprint } from "../stage-fingerprint.ts";
import { withMemoryMutationLock } from "../../shared-memory-mutation-lock.ts";
import {
  applyMemoChanges, EntityRegisterApplyRefusedError, type EntityApplication, type MemoDateApplication, type ScheduleApplication,
} from "./apply.ts";
import { readMemoEventAt, readOriginalMemo } from "./candidate-query.ts";
import { ENTITY_REGISTER_KIND, ENTITY_REGISTER_LIMITS } from "./constants.ts";
import { parseIsoDate } from "./date-check.ts";
import { nameKey, normalizeName } from "./name-match.ts";
import {
  MEMO_DATE_IGNORE_NAME_KEY, SCHEDULE_IGNORE_NAME_KEY, type EntityRegisterRecordsRepository, type IgnoreKind,
} from "./records-repository.ts";
import type { EntityRegisterOption, MemoDateProposeReason, MemoJudgement, ProposeReason, ScheduleProposeReason } from "./types.ts";

export const SCHEDULE_ITEM_KEY = "schedule";
/** 메모 날짜 채우기 제안 항목 키(2026-10-16 yearless-date-cleanup spec 3.7). */
export const MEMO_DATE_ITEM_KEY = "memo_date";
export function entityItemKey(index: number): string {
  return `entity:${index}`;
}

export interface EntityRegisterProposalItem { itemKey: string; type: string; name: string; reason: ProposeReason; options: EntityRegisterOption[] }
export interface ScheduleProposalItem {
  itemKey: typeof SCHEDULE_ITEM_KEY; reason: ScheduleProposeReason; title: string; date: string | null; dateText: string; existingScheduleNodeId: number | null;
}
export interface MemoDateProposalItem { itemKey: typeof MEMO_DATE_ITEM_KEY; reason: MemoDateProposeReason; date: string | null; dateText: string }
export interface AutoAppliedNote { type: string; name: string; action: "linked" | "created" | "schedule" | "memo_date" }
export interface EntityRegisterProposalPayload {
  nodeId: number; inputFingerprint: string; stageVersion: number; runId: string | null;
  items: EntityRegisterProposalItem[]; schedule: ScheduleProposalItem | null; autoApplied: AutoAppliedNote[];
  /**
   * 메모 날짜 제안. 새로 만드는 제안에는 늘 있다(없으면 null). 이 기능 이전에 만들어져 대기 중인 제안에는 칸이 없다 —
   * 그 제안이 실제로 그 항목을 갖지 않았다는 뜻이라 memoDateItemOf 가 null 로 읽는다(값 위조 아님).
   */
  memoDate?: MemoDateProposalItem | null;
}

const MEMO_DATE_PROPOSE_REASONS: ReadonlySet<string> = new Set<MemoDateProposeReason>(["relative", "mismatch", "auto_apply_off"]);

/** 제안의 메모 날짜 항목 — 칸이 없는 옛 제안은 "메모 날짜 항목 없음"(spec 3.7). */
export function memoDateItemOf(payload: EntityRegisterProposalPayload): MemoDateProposalItem | null {
  return Object.hasOwn(payload, "memoDate") ? (payload.memoDate ?? null) : null;
}

export function buildEntityRegisterProposal(
  j: MemoJudgement,
  meta: { inputFingerprint: string; stageVersion: number; runId: string | null; autoApplied: AutoAppliedNote[] },
): EntityRegisterProposalPayload | null {
  const items: EntityRegisterProposalItem[] = [];
  for (const d of j.entities) {
    if (d.action !== "propose") continue;
    items.push({ itemKey: entityItemKey(items.length), type: d.type, name: d.name, reason: d.reason, options: d.options });
  }
  const s = j.schedule;
  const schedule: ScheduleProposalItem | null = s.action === "propose"
    ? { itemKey: SCHEDULE_ITEM_KEY, reason: s.reason, title: s.title, date: s.date, dateText: s.dateText, existingScheduleNodeId: s.existingScheduleNodeId }
    : null;
  const m = j.memoDate;
  const memoDate: MemoDateProposalItem | null = m.action === "propose"
    ? { itemKey: MEMO_DATE_ITEM_KEY, reason: m.reason, date: m.date, dateText: m.dateText }
    : null;
  if (items.length === 0 && schedule === null && memoDate === null) return null;
  return { nodeId: j.nodeId, ...meta, items, schedule, memoDate };
}

export function insertEntityRegisterProposal(proposals: CleanupProposalsRepository, payload: EntityRegisterProposalPayload): string {
  // 같은 메모의 대기 중 옛 제안은 새 제안으로 대체된다(중복 방지 D9) — 상태 needs_revision, 넣기와 한 트랜잭션.
  return proposals.insertSupersedingPendingByNode(ENTITY_REGISTER_KIND, payload.nodeId, payload as unknown as Record<string, unknown>);
}

const isNullableString = (v: unknown): boolean => v === null || typeof v === "string";

/** 승인이 그대로 믿고 쓰는 선택지 칸을 모두 본다(어긋나면 적용 전에 400). */
function isValidOption(raw: unknown): boolean {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return false;
  switch (o.kind) {
    case "link_existing":
      return typeof o.targetId === "string" && o.targetId.length > 0 && typeof o.targetName === "string" && typeof o.addAlias === "boolean";
    case "create":
      return typeof o.name === "string" && o.name.length > 0 && isNullableString(o.aliasFromMemo);
    case "ignore":
      return true;
    default:
      return false;
  }
}

export function validateEntityRegisterPayload(payload: Record<string, unknown>): { ok: true } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message: `entity_register payload 어긋남 — ${message}` });
  if (!Number.isInteger(payload.nodeId) || (payload.nodeId as number) < 1) return bad("nodeId 는 양의 정수여야 함");
  if (typeof payload.inputFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(payload.inputFingerprint)) return bad("inputFingerprint 는 64자리 hex");
  if (!Number.isInteger(payload.stageVersion)) return bad("stageVersion 은 정수여야 함");
  if (!isNullableString(payload.runId)) return bad("runId 는 문자열 또는 null 이어야 함");
  if (!Array.isArray(payload.items)) return bad("items 는 배열이어야 함");
  for (const [i, raw] of (payload.items as unknown[]).entries()) {
    const item = raw as Partial<EntityRegisterProposalItem> | null;
    if (item?.itemKey !== entityItemKey(i) || typeof item.type !== "string" || typeof item.name !== "string" || !Array.isArray(item.options) || item.options.length === 0) {
      return bad(`items[${i}] 형식(itemKey·type·name·options)`);
    }
    const badOption = item.options.findIndex((o) => !isValidOption(o));
    if (badOption >= 0) return bad(`items[${i}].options[${badOption}] 형식(kind 와 그 칸)`);
  }
  const s = payload.schedule as Partial<ScheduleProposalItem> | null | undefined;
  if (s !== null) {
    if (
      s === undefined || s.itemKey !== SCHEDULE_ITEM_KEY || typeof s.title !== "string" || typeof s.dateText !== "string" ||
      !isNullableString(s.date) || !(s.existingScheduleNodeId === null || Number.isInteger(s.existingScheduleNodeId))
    ) {
      return bad("schedule 형식(itemKey·title·date·dateText·existingScheduleNodeId)");
    }
  }
  // 칸이 없으면 이 기능 이전의 제안 — 메모 날짜 항목 없음으로 받는다. 칸이 있는데 모양이 틀리면 400.
  if (Object.hasOwn(payload, "memoDate") && payload.memoDate !== null) {
    const md = payload.memoDate as Partial<MemoDateProposalItem> | undefined;
    if (
      md === undefined || md.itemKey !== MEMO_DATE_ITEM_KEY || typeof md.reason !== "string" || !MEMO_DATE_PROPOSE_REASONS.has(md.reason) ||
      typeof md.dateText !== "string" || !isNullableString(md.date)
    ) {
      return bad("memoDate 형식(itemKey·reason·date·dateText)");
    }
  }
  if (!Array.isArray(payload.autoApplied)) return bad("autoApplied 는 배열이어야 함");
  return { ok: true };
}

type EntityRegisterItemGroup = "entities" | "schedule" | "memo_date";

export function listEntityRegisterItems(payload: Record<string, unknown>): Array<{ itemKey: string; group: EntityRegisterItemGroup; key: string; value: unknown }> {
  const p = payload as unknown as EntityRegisterProposalPayload;
  const out: Array<{ itemKey: string; group: EntityRegisterItemGroup; key: string; value: unknown }> =
    p.items.map((item) => ({ itemKey: item.itemKey, group: "entities", key: item.name, value: item }));
  if (p.schedule) out.push({ itemKey: SCHEDULE_ITEM_KEY, group: "schedule", key: p.schedule.title, value: p.schedule });
  const memoDate = memoDateItemOf(p);
  if (memoDate) out.push({ itemKey: MEMO_DATE_ITEM_KEY, group: "memo_date", key: memoDate.dateText, value: memoDate });
  return out;
}

export type EntityRegisterChoice =
  | { kind: "option"; optionIndex: number }
  | { kind: "schedule"; accept: true; date: string; title: string }
  | { kind: "schedule"; accept: false }
  | { kind: "memo_date"; accept: true; date: string }
  | { kind: "memo_date"; accept: false };

const NO_CHOICE_MESSAGE = "고른 항목 없음 — choices 에 하나 이상 골라야 함";

export class EntityRegisterChoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityRegisterChoiceError";
  }
}

export function parseEntityRegisterChoices(body: unknown, payload: EntityRegisterProposalPayload): Map<string, EntityRegisterChoice> {
  const raw = (body as { choices?: unknown } | null)?.choices;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new EntityRegisterChoiceError("choices 는 { 항목키: 선택 } 객체여야 함");
  const out = new Map<string, EntityRegisterChoice>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = value as Record<string, unknown> | null;
    if (key === SCHEDULE_ITEM_KEY && payload.schedule) {
      if (v?.accept === false) { out.set(key, { kind: "schedule", accept: false }); continue; }
      const title = typeof v?.title === "string" ? normalizeName(v.title) : "";
      if (v?.accept !== true || typeof v.date !== "string" || !parseIsoDate(v.date) || !title || title.length > ENTITY_REGISTER_LIMITS.titleMaxChars) {
        throw new EntityRegisterChoiceError(`${key}: { accept: true, date: "YYYY-MM-DD", title } 또는 { accept: false } 여야 함`);
      }
      out.set(key, { kind: "schedule", accept: true, date: v.date, title });
      continue;
    }
    if (key === MEMO_DATE_ITEM_KEY && memoDateItemOf(payload)) {
      if (v?.accept === false) { out.set(key, { kind: "memo_date", accept: false }); continue; }
      if (v?.accept !== true || typeof v.date !== "string" || !parseIsoDate(v.date)) {
        throw new EntityRegisterChoiceError(`${key}: { accept: true, date: "YYYY-MM-DD"(실제 날짜) } 또는 { accept: false } 여야 함`);
      }
      out.set(key, { kind: "memo_date", accept: true, date: v.date });
      continue;
    }
    const item = payload.items.find((i) => i.itemKey === key);
    if (!item) throw new EntityRegisterChoiceError(`${key}: 이 제안에 없는 항목`);
    const idx = v?.optionIndex;
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= item.options.length) {
      throw new EntityRegisterChoiceError(`${key}: optionIndex 는 0~${item.options.length - 1} 정수여야 함`);
    }
    out.set(key, { kind: "option", optionIndex: idx });
  }
  if (out.size === 0) throw new EntityRegisterChoiceError(NO_CHOICE_MESSAGE);
  return out;
}

export interface EntityRegisterApprovalItem { itemKey: string; status: "applied" | "skipped" | "failed"; detail: string | null }
export interface EntityRegisterApprovalResult {
  status: "applied" | "partially_applied" | "needs_revision"; appliedCount: number; items: EntityRegisterApprovalItem[]; staleReason: string | null;
}

const NOT_CHOSEN_DETAIL = "사용자가 고르지 않음";
const IGNORED_DETAIL = "무시로 기록";

async function nameExists(store: SqliteMemoryStore, type: string, name: string): Promise<boolean> {
  if (type === "person") {
    const found = await store.findPersonByNameOrAlias(name);
    return found.person !== null || found.ambiguous;
  }
  const found = await store.entitiesRepo.findByNameOrAlias(type, name);
  return found.entity !== null || found.ambiguous;
}

async function targetExists(store: SqliteMemoryStore, type: string, id: string): Promise<boolean> {
  if (type === "person") return (await store.getPerson(id)) !== null;
  const entity = await store.entitiesRepo.get(id);
  return entity !== null && entity.typeName === type;
}

/** judgeProposalStatus(cleanup-external/proposal-items.ts)와 같은 기준. */
function statusOf(items: EntityRegisterApprovalItem[]): EntityRegisterApprovalResult["status"] {
  const applied = items.filter((i) => i.status === "applied").length;
  if (applied === 0) return "needs_revision";
  return applied === items.length ? "applied" : "partially_applied";
}

type PendingIgnore = { itemKey: string; kind: IgnoreKind; key: string };

const MEMO_DATE_ALREADY_SET_DETAIL = "메모 날짜가 이미 채워져 있음 — 제안이 오래됨";

/** 처리하려던 제안이 그 사이 다른 요청(승인·거절)으로 이미 처리됨 — 잠금 안에서 다시 읽어 판정한다. */
export class EntityRegisterProposalNotPendingError extends Error {
  constructor(proposalId: string, status: string) {
    super(`entity_register 제안 ${proposalId} 은 이미 처리됨 — status: ${status}`);
    this.name = "EntityRegisterProposalNotPendingError";
  }
}

/** 잠금 안에서 제안을 다시 읽는다 — 동시에 들어온 승인·거절 중 먼저 잠금을 잡은 쪽만 처리한다. */
function requirePending(proposals: CleanupProposalsRepository, proposalId: string): CleanupProposal {
  const current = proposals.findById(proposalId);
  if (!current) throw new Error(`entity_register 제안 ${proposalId} 가 없음`);
  if (current.status !== "pending") throw new EntityRegisterProposalNotPendingError(proposalId, current.status);
  return current;
}

/**
 * 승인 — 전체를 메모리 쓰기 잠금 안에서 한다(applyMemoChanges 의 잠금은 다시 들어간다). 갈래:
 *   - 고른 항목 없음 → EntityRegisterChoiceError(쓰기 전, 제안은 pending 그대로)
 *   - 이미 처리된 제안 → EntityRegisterProposalNotPendingError(쓰기 전)
 *   - 메모 삭제·내용 변경, applyMemoChanges 의 EntityRegisterApplyRefusedError → 오래된 제안으로 needs_revision
 *   - 그 밖의 오류(DB·임베딩 실패) → 그대로 올린다. 쓰기 트랜잭션은 되돌려졌고 제안은 pending 이다.
 */
export async function approveEntityRegisterProposal(args: {
  store: SqliteMemoryStore; proposals: CleanupProposalsRepository; records: EntityRegisterRecordsRepository;
  proposal: CleanupProposal; choices: Map<string, EntityRegisterChoice>;
}): Promise<EntityRegisterApprovalResult> {
  const { store, proposals, records, choices } = args;
  return withMemoryMutationLock(store, async () => {
    if (choices.size === 0) throw new EntityRegisterChoiceError(NO_CHOICE_MESSAGE);
    const proposal = requirePending(proposals, args.proposal.id);
    const payload = proposal.payload as unknown as EntityRegisterProposalPayload;
    const memoDateItem = memoDateItemOf(payload);
    const keys = [
      ...payload.items.map((i) => i.itemKey),
      ...(payload.schedule ? [SCHEDULE_ITEM_KEY] : []),
      ...(memoDateItem ? [MEMO_DATE_ITEM_KEY] : []),
    ];
    // 무시 기록·원장·상태를 한 트랜잭션으로 — 반쪽 기록(무시만 남고 상태는 pending)을 남기지 않는다.
    const finish = (items: EntityRegisterApprovalItem[], staleReason: string | null, ignores: PendingIgnore[]): EntityRegisterApprovalResult => {
      const status = statusOf(items);
      store.getRawDb().transaction(() => {
        for (const ig of ignores) records.addIgnore(payload.nodeId, ig.kind, ig.key, "ignored");
        for (const it of items) proposals.recordJournalEntry(proposal.id, it.itemKey, it.status, it.detail);
        proposals.updateStatus(proposal.id, status);
      })();
      return { status, appliedCount: items.filter((i) => i.status === "applied").length, items, staleReason };
    };

    const memo = readOriginalMemo(store.getRawDb(), payload.nodeId);
    if (memo === null || entityRegisterFingerprint(memo) !== payload.inputFingerprint) {
      const reason = memo === null
        ? "메모가 지워졌거나 원본 메모가 아니어서 적용할 수 없음 — 오래된 제안"
        : "제안 이후 메모 내용이 바뀌어 적용을 거부 — 다음 정리 때 다시 판정";
      return finish(keys.map((k) => ({ itemKey: k, status: "skipped", detail: reason })), reason, []);
    }

    const results = new Map<string, EntityRegisterApprovalItem>();
    const ignores: PendingIgnore[] = [];
    const entityApps: Array<{ itemKey: string; app: EntityApplication }> = [];
    for (const item of payload.items) {
      const choice = choices.get(item.itemKey);
      if (!choice || choice.kind !== "option") { results.set(item.itemKey, { itemKey: item.itemKey, status: "skipped", detail: NOT_CHOSEN_DETAIL }); continue; }
      const option = item.options[choice.optionIndex]!;
      if (option.kind === "ignore") {
        ignores.push({ itemKey: item.itemKey, kind: "entity", key: nameKey(item.name) });
        continue;
      }
      if (option.kind === "link_existing" && !(await targetExists(store, item.type, option.targetId))) {
        results.set(item.itemKey, { itemKey: item.itemKey, status: "failed", detail: `'${option.targetName}' 이(가) 사라져 연결할 수 없음 — 제안이 오래됨` });
        continue;
      }
      if (option.kind === "create" && (await nameExists(store, item.type, option.name))) {
        results.set(item.itemKey, { itemKey: item.itemKey, status: "failed", detail: `같은 이름 '${option.name}' 이(가) 이미 생김 — 제안이 오래됨` });
        continue;
      }
      entityApps.push({
        itemKey: item.itemKey,
        app: option.kind === "create"
          ? { memoName: item.name, type: item.type, action: { kind: "create", name: option.name, aliasFromMemo: option.aliasFromMemo } }
          : { memoName: item.name, type: item.type, action: { kind: "link", targetId: option.targetId, targetName: option.targetName, addAlias: option.addAlias } },
      });
    }

    let schedule: ScheduleApplication | null = null;
    if (payload.schedule) {
      const choice = choices.get(SCHEDULE_ITEM_KEY);
      if (!choice || choice.kind !== "schedule") results.set(SCHEDULE_ITEM_KEY, { itemKey: SCHEDULE_ITEM_KEY, status: "skipped", detail: NOT_CHOSEN_DETAIL });
      else if (!choice.accept) ignores.push({ itemKey: SCHEDULE_ITEM_KEY, kind: "schedule", key: SCHEDULE_IGNORE_NAME_KEY });
      else schedule = { title: choice.title, date: choice.date, dateText: payload.schedule.dateText, replaceNodeId: payload.schedule.existingScheduleNodeId };
    }

    let memoDate: MemoDateApplication | null = null;
    if (memoDateItem) {
      const choice = choices.get(MEMO_DATE_ITEM_KEY);
      if (!choice || choice.kind !== "memo_date") results.set(MEMO_DATE_ITEM_KEY, { itemKey: MEMO_DATE_ITEM_KEY, status: "skipped", detail: NOT_CHOSEN_DETAIL });
      else if (!choice.accept) ignores.push({ itemKey: MEMO_DATE_ITEM_KEY, kind: "memo_date", key: MEMO_DATE_IGNORE_NAME_KEY });
      else {
        const current = readMemoEventAt(store.getRawDb(), payload.nodeId);
        if (current.found && current.eventAt !== null) {
          results.set(MEMO_DATE_ITEM_KEY, { itemKey: MEMO_DATE_ITEM_KEY, status: "failed", detail: MEMO_DATE_ALREADY_SET_DETAIL });
        } else {
          memoDate = { date: choice.date, dateText: memoDateItem.dateText };
        }
      }
    }

    if (entityApps.length > 0 || schedule !== null || memoDate !== null) {
      try {
        const outcome = await applyMemoChanges(
          { store, records, memo, runId: payload.runId, proposalId: proposal.id, decidedBy: "approved" },
          { entities: entityApps.map((e) => e.app), schedule, memoDate },
        );
        for (const { itemKey, app } of entityApps) {
          const skip = outcome.skipped.find((s) => s.memoName === app.memoName && s.type === app.type);
          results.set(itemKey, skip ? { itemKey, status: "failed", detail: skip.reason } : { itemKey, status: "applied", detail: null });
        }
        if (schedule) results.set(SCHEDULE_ITEM_KEY, { itemKey: SCHEDULE_ITEM_KEY, status: "applied", detail: null });
        if (memoDate) {
          results.set(MEMO_DATE_ITEM_KEY, outcome.memoDateRecordId !== null
            ? { itemKey: MEMO_DATE_ITEM_KEY, status: "applied", detail: null }
            : { itemKey: MEMO_DATE_ITEM_KEY, status: "failed", detail: MEMO_DATE_ALREADY_SET_DETAIL });
        }
      } catch (e) {
        if (!(e instanceof EntityRegisterApplyRefusedError)) throw e;
        // 거부는 항목 행·별칭·엣지·일정·기록을 남기지 않는다(쓰기 트랜잭션 전이거나 그 안에서 되돌려짐). 다만
        // 트랜잭션 전에 확보한 새 identity 개념 행은 남을 수 있다(apply.ts 머리 주석의 알려진 한계).
        // 무시 선택도 기록하지 않는다 — 이번 승인은 통째로 거부되고, 사용자는 사유를 보고 새 제안에서 다시 고른다.
        const reason = `적용 직전 확인에서 거부(전체 취소) — 오래된 제안: ${e.message}`;
        for (const { itemKey } of entityApps) results.set(itemKey, { itemKey, status: "failed", detail: reason });
        if (schedule) results.set(SCHEDULE_ITEM_KEY, { itemKey: SCHEDULE_ITEM_KEY, status: "failed", detail: reason });
        if (memoDate) results.set(MEMO_DATE_ITEM_KEY, { itemKey: MEMO_DATE_ITEM_KEY, status: "failed", detail: reason });
        for (const ig of ignores) results.set(ig.itemKey, { itemKey: ig.itemKey, status: "failed", detail: reason });
        return finish(keys.map((k) => results.get(k)!), reason, []);
      }
    }
    for (const ig of ignores) results.set(ig.itemKey, { itemKey: ig.itemKey, status: "applied", detail: IGNORED_DETAIL });
    return finish(keys.map((k) => results.get(k)!), null, ignores);
  });
}

/**
 * 거절 — 사람이 보고 거절했으므로 제안의 모든 이름·일정을 무시 기록으로 남겨 다시 묻지 않는다.
 * 승인과 같은 잠금 안에서 상태를 다시 읽고, 무시 기록과 상태 변경을 한 트랜잭션으로 쓴다.
 */
export async function rejectEntityRegisterProposal(args: {
  store: SqliteMemoryStore; proposals: CleanupProposalsRepository; records: EntityRegisterRecordsRepository; proposal: CleanupProposal;
}): Promise<void> {
  const { store, proposals, records } = args;
  await withMemoryMutationLock(store, async () => {
    const proposal = requirePending(proposals, args.proposal.id);
    const payload = proposal.payload as unknown as EntityRegisterProposalPayload;
    store.getRawDb().transaction(() => {
      for (const item of payload.items) records.addIgnore(payload.nodeId, "entity", nameKey(item.name), "ignored");
      if (payload.schedule) records.addIgnore(payload.nodeId, "schedule", SCHEDULE_IGNORE_NAME_KEY, "ignored");
      if (memoDateItemOf(payload)) records.addIgnore(payload.nodeId, "memo_date", MEMO_DATE_IGNORE_NAME_KEY, "ignored");
      proposals.updateStatus(proposal.id, "rejected");
    })();
  });
}
