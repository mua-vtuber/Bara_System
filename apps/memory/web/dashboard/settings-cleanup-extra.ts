/**
 * 정리 AI 칸에 붙는 조각 — 정리 시점(llm.cleanup.trigger)을 정리 주기 줄 옆의 "기간마다 / 바로" 선택으로,
 * 확실한 것은 바로 반영(cleanupDeepPass.entityRegister.autoApply)을 체크로 보인다. 값 저장은 settings.ts 의
 * renderCleanupMemorySection 이 이 핸들에서 읽어 한 번에 보낸다.
 *
 * "바로"(on_save)는 정리 주기를 대신하지 않고 더한다 — 메모 저장 직후 항목·일정 등록과 사람 연결을 하고,
 * 정규식 강화·요약은 계속 정리 주기대로 돈다. 그래서 "바로"에서도 일수 칸은 남기고 단위 글만 바꾼다.
 */
import { el } from "./ui/dom.ts";
import { CLEANUP_EXTRA_LABELS as L } from "./settings-cleanup-extra-labels.ts";

export type CleanupTrigger = "interval" | "on_save";
export interface CleanupExtraValue { trigger: CleanupTrigger; autoApply: boolean }

/** 정리 AI 슬롯(renderCleanupSection)이 내주는 정리 주기 줄. */
export interface CleanupIntervalRow { row: HTMLElement; label: HTMLLabelElement; input: HTMLElement; unit: Text }

export interface CleanupExtraHandle {
  element: HTMLElement;
  getTrigger(): CleanupTrigger;
  getAutoApply(): boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** 설정 전체 값에서 이 조각이 쓰는 두 값을 읽는다. 값이 없거나 형이 틀리면 키 이름을 담아 던진다. */
export function readCleanupExtraValue(settings: Record<string, unknown>): CleanupExtraValue {
  const trigger = asRecord(asRecord(settings.llm).cleanup).trigger;
  if (trigger !== "interval" && trigger !== "on_save") throw new Error(L.invalidTrigger(String(trigger)));
  const autoApply = asRecord(asRecord(settings.cleanupDeepPass).entityRegister).autoApply;
  if (typeof autoApply !== "boolean") throw new Error(L.invalidAutoApply(String(autoApply)));
  return { trigger, autoApply };
}

function triggerRadio(value: CleanupTrigger, text: string, checked: boolean): { label: HTMLElement; radio: HTMLInputElement } {
  const radio = el("input", { type: "radio", name: "llm-cleanup-trigger", value, id: `llm-cleanup-trigger-${value}` });
  radio.checked = checked;
  return { label: el("label", { className: "cleanup-trigger-choice", for: radio.id }, radio, text), radio };
}

/** 정리 주기 줄 머리에 "기간마다 / 바로"를 붙이고, 고른 시점에 따라 단위 글과 겹침 안내를 바꾼다. */
export function renderCleanupExtra(current: CleanupExtraValue, interval: CleanupIntervalRow): CleanupExtraHandle {
  const onInterval = triggerRadio("interval", L.triggerInterval, current.trigger === "interval");
  const onSave = triggerRadio("on_save", L.triggerOnSave, current.trigger === "on_save");
  const choices = el("div", { className: "cleanup-trigger-choices", role: "radiogroup", "aria-label": L.triggerGroupLabel },
    onInterval.label, onSave.label);
  const head = el("div", { className: "cleanup-trigger-head" });
  interval.row.insertBefore(head, interval.label);
  head.append(interval.label, choices);
  const warning = el("p", { className: "memory-info-note cleanup-trigger-warning", role: "note" }, L.onSaveWarning);
  interval.row.appendChild(warning);

  const getTrigger = (): CleanupTrigger => (onSave.radio.checked ? "on_save" : "interval");
  const sync = () => {
    const immediate = getTrigger() === "on_save";
    interval.unit.textContent = immediate ? L.intervalUnitOnSave : L.intervalUnitInterval;
    warning.hidden = !immediate;
  };
  onInterval.radio.addEventListener("change", sync);
  onSave.radio.addEventListener("change", sync);
  sync();

  const autoApply = el("input", { type: "checkbox", id: "cleanup-entity-register-auto-apply" });
  autoApply.checked = current.autoApply;
  const element = el("div", { className: "llm-extra-row cleanup-extra" },
    el("label", { className: "cleanup-extra-check" }, autoApply, L.autoApplyLabel),
    el("p", { className: "memory-info-note" }, L.autoApplyHelp),
  );
  return { element, getTrigger, getAutoApply: () => autoApply.checked };
}
