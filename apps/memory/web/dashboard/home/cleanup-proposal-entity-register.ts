/**
 * entity_register 제안 카드의 항목별 선택(2026-10-10 spec 6장·7.3). 항목마다 선택지 하나(라디오),
 * 일정은 등록/무시와 날짜·제목 고치기, 메모 날짜는 채우기/무시와 날짜 고치기(2026-10-16 yearless-date-cleanup spec 3.7).
 * 고르지 않은 항목은 서버가 "사용자가 고르지 않음"으로 남긴다.
 * 메모 이름·사유는 모두 텍스트 노드로만 그린다.
 */
import { displayGraphKindLabel } from "../ui/badges.ts";
import { el } from "../ui/dom.ts";
import type { DashboardApiError } from "./dashboard-api.ts";
import { ENTITY_REGISTER_STRINGS as S } from "./entity-register-strings.ts";
import type { CleanupProposalDetail } from "./types.ts";

type Option =
  | { kind: "link_existing"; targetId: string; targetName: string; addAlias: boolean }
  | { kind: "create"; name: string; aliasFromMemo: string | null }
  | { kind: "ignore" };
interface Item { itemKey: string; type: string; name: string; reason: string; options: Option[] }
interface Schedule { itemKey: string; reason: string; title: string; date: string | null; dateText: string }
interface MemoDate { itemKey: string; reason: string; date: string | null; dateText: string }
/** memoDate 칸이 없는 옛 제안(이 기능 이전)은 메모 날짜 항목이 없다. */
interface Payload { items: Item[]; schedule: Schedule | null; memoDate?: MemoDate | null; autoApplied: Array<{ type: string; name: string; action: string }> }

export interface EntityRegisterReview {
  root: HTMLElement;
  hasChoice(): boolean;
  choices(): Record<string, unknown>;
  /** 일정을 등록으로 골랐는데 날짜·제목이 올바르지 않으면 안내 문구, 아니면 null. */
  validationError(): string | null;
  setDisabled(v: boolean): void;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** 서버의 "이미 처리된 proposal" 400 문구(사전 검사). 락 안 409 와 같이 "이미 처리됨"으로 보인다. */
const ALREADY_PROCESSED_PATTERN = /이미 처리/;

function isRealDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function optionText(option: Option, memoName: string): string {
  if (option.kind === "link_existing") return S.optionLink(option.targetName, option.addAlias, memoName);
  if (option.kind === "create") return S.optionCreate(option.name, option.aliasFromMemo);
  return S.optionIgnore;
}

/** 승인 요청이 거절·실패했을 때의 안내. recheck=true 면 이미 처리됐을 수 있어 서버 상태를 다시 읽어야 한다. */
export function entityRegisterApproveError(error: DashboardApiError): { message: string; recheck: boolean } {
  if (error.status === 409 || (error.status === 400 && ALREADY_PROCESSED_PATTERN.test(error.message))) {
    return { message: S.alreadyProcessed(error.message), recheck: true };
  }
  if (error.status >= 500) return { message: S.approveFailed(error.status, error.message), recheck: false };
  return { message: S.approveRefused(error.message), recheck: false };
}

export function createEntityRegisterReview(proposal: CleanupProposalDetail, onChange: () => void): EntityRegisterReview {
  const payload = proposal.payload as unknown as Payload;
  const applied = new Set(proposal.journal.filter((j) => j.status === "applied").map((j) => j.itemKey));
  const inputs: Array<{ input: HTMLInputElement; locked: boolean }> = [];
  const root = el("div", { className: "proposal-entity-register" });
  // 같은 화면에 카드가 여럿 열려도 라디오 묶음이 섞이지 않도록 제안 id 로 묶음 이름을 가른다.
  const group = (itemKey: string): string => `${proposal.id}::${itemKey}`;
  const track = (input: HTMLInputElement, locked: boolean): void => {
    input.disabled = locked;
    inputs.push({ input, locked });
  };

  for (const item of payload.items) {
    const done = applied.has(item.itemKey);
    const fieldset = el("fieldset", { className: "proposal-items" },
      el("legend", {}, `${S.itemHeading(displayGraphKindLabel(item.type), item.name)}${done ? S.alreadyApplied : ""}`),
      el("p", { className: "proposal-help" }, S.reasonLabels[item.reason] ?? item.reason));
    item.options.forEach((option, index) => {
      const radio = el("input", { type: "radio", name: group(item.itemKey), value: String(index) });
      radio.addEventListener("change", onChange);
      track(radio, done);
      fieldset.append(el("label", { className: "proposal-item" }, radio, optionText(option, item.name)));
    });
    root.append(fieldset);
  }

  let date: HTMLInputElement | null = null;
  let title: HTMLInputElement | null = null;
  if (payload.schedule) {
    const s = payload.schedule;
    const done = applied.has(s.itemKey);
    const accept = el("input", { type: "radio", name: group(s.itemKey), value: "accept" });
    const ignore = el("input", { type: "radio", name: group(s.itemKey), value: "ignore" });
    date = el("input", { type: "date" });
    date.value = s.date ?? "";
    title = el("input", { type: "text" });
    title.value = s.title;
    for (const i of [accept, ignore, date, title]) {
      i.addEventListener("change", onChange);
      i.addEventListener("input", onChange);
      track(i, done);
    }
    root.append(el("fieldset", { className: "proposal-items" },
      el("legend", {}, s.dateText),
      el("p", { className: "proposal-help" }, S.scheduleReasonLabels[s.reason] ?? s.reason),
      el("label", { className: "proposal-item" }, accept, S.scheduleAccept),
      el("label", { className: "proposal-item" }, ignore, S.scheduleIgnore),
      el("label", {}, S.scheduleDate, date),
      el("label", {}, S.scheduleTitleLabel, title)));
  }

  const memoDate = payload.memoDate ?? null;
  let memoDateInput: HTMLInputElement | null = null;
  if (memoDate) {
    const done = applied.has(memoDate.itemKey);
    const accept = el("input", { type: "radio", name: group(memoDate.itemKey), value: "accept" });
    const ignore = el("input", { type: "radio", name: group(memoDate.itemKey), value: "ignore" });
    memoDateInput = el("input", { type: "date" });
    memoDateInput.value = memoDate.date ?? "";
    for (const i of [accept, ignore, memoDateInput]) {
      i.addEventListener("change", onChange);
      i.addEventListener("input", onChange);
      track(i, done);
    }
    root.append(el("fieldset", { className: "proposal-items" },
      el("legend", {}, `${S.memoDateHeading(memoDate.dateText)}${done ? S.alreadyApplied : ""}`),
      el("p", { className: "proposal-help" }, S.memoDateReasonLabels[memoDate.reason] ?? memoDate.reason),
      el("label", { className: "proposal-item" }, accept, S.memoDateAccept),
      el("label", { className: "proposal-item" }, ignore, S.memoDateIgnore),
      el("label", {}, S.memoDateLabel, memoDateInput)));
  }

  if (payload.autoApplied.length > 0) {
    root.append(el("h4", {}, S.autoAppliedTitle), el("ul", {}, ...payload.autoApplied.map((a) => el("li", {}, S.autoAppliedRow(a.name, a.action)))));
  }
  if (proposal.status === "pending") root.append(el("p", { className: "proposal-help proposal-reject-notice" }, S.rejectNotice));

  // 라디오 상태는 추적해 둔 입력에서 직접 읽는다(선택자 결과 캐시에 기대지 않는다).
  const checked = (name: string): HTMLInputElement | null =>
    inputs.find(({ input }) => input.type === "radio" && input.name === group(name) && input.checked)?.input ?? null;
  return {
    root,
    hasChoice: () =>
      payload.items.some((i) => checked(i.itemKey) !== null) ||
      (payload.schedule !== null && checked(payload.schedule.itemKey) !== null) ||
      (memoDate !== null && checked(memoDate.itemKey) !== null),
    choices() {
      const out: Record<string, unknown> = {};
      for (const item of payload.items) {
        const c = checked(item.itemKey);
        if (c) out[item.itemKey] = { optionIndex: Number(c.value) };
      }
      if (payload.schedule) {
        const c = checked(payload.schedule.itemKey);
        if (c?.value === "accept") out[payload.schedule.itemKey] = { accept: true, date: date!.value, title: title!.value.trim() };
        if (c?.value === "ignore") out[payload.schedule.itemKey] = { accept: false };
      }
      if (memoDate) {
        const c = checked(memoDate.itemKey);
        if (c?.value === "accept") out[memoDate.itemKey] = { accept: true, date: memoDateInput!.value };
        if (c?.value === "ignore") out[memoDate.itemKey] = { accept: false };
      }
      return out;
    },
    validationError() {
      if (payload.schedule && checked(payload.schedule.itemKey)?.value === "accept") {
        if (!isRealDate(date!.value)) return S.invalidDate;
        if (title!.value.trim() === "") return S.titleRequired;
      }
      if (memoDate && checked(memoDate.itemKey)?.value === "accept" && !isRealDate(memoDateInput!.value)) return S.invalidMemoDate;
      return null;
    },
    setDisabled(v) {
      for (const entry of inputs) entry.input.disabled = v || entry.locked;
    },
  };
}
