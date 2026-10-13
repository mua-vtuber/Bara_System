import "../../test-setup-dom";
import { afterEach, expect, test } from "bun:test";
import { readCleanupExtraValue, renderCleanupExtra, type CleanupIntervalRow } from "./settings-cleanup-extra.ts";
import { CLEANUP_EXTRA_LABELS } from "./settings-cleanup-extra-labels.ts";

afterEach(() => document.body.replaceChildren());

/** The interval row in the same shape the cleanup AI slot hands over (real DOM). */
function intervalRow(): CleanupIntervalRow {
  const label = document.createElement("label"); label.textContent = "정리 주기(일)";
  const unit = document.createTextNode(CLEANUP_EXTRA_LABELS.intervalUnitInterval);
  const input = document.createElement("div"); input.append(document.createElement("input"), unit);
  const row = document.createElement("div"); row.append(label, input);
  return { row, label, input, unit };
}

const pick = (row: HTMLElement, value: "interval" | "on_save") => {
  const radio = row.querySelector<HTMLInputElement>(`input[value=${value}]`)!;
  radio.checked = true;
  radio.dispatchEvent(new Event("change"));
};

test("the trigger is a 기간마다 / 바로 choice next to the interval label, starting from the saved value", () => {
  const interval = intervalRow();
  const extra = renderCleanupExtra({ trigger: "interval", autoApply: true }, interval);
  document.body.append(interval.row, extra.element);
  const head = interval.row.querySelector(".cleanup-trigger-head")!;
  expect(head.contains(interval.label)).toBe(true);
  expect(head.querySelector<HTMLInputElement>("input[value=interval]")!.checked).toBe(true);
  expect(extra.getTrigger()).toBe("interval");
  pick(interval.row, "on_save");
  expect(extra.getTrigger()).toBe("on_save");
  expect(document.querySelector("select")).toBeNull();
});

test("바로 keeps the day field, changes its unit text and shows the warning about the Pet", () => {
  const interval = intervalRow();
  renderCleanupExtra({ trigger: "interval", autoApply: true }, interval);
  const warning = interval.row.querySelector<HTMLElement>(".cleanup-trigger-warning")!;
  expect(warning.hidden).toBe(true);
  pick(interval.row, "on_save");
  expect(warning.hidden).toBe(false);
  expect(warning.textContent).toBe(CLEANUP_EXTRA_LABELS.onSaveWarning);
  expect(interval.unit.textContent).toBe(CLEANUP_EXTRA_LABELS.intervalUnitOnSave);
  expect(interval.row.contains(interval.input)).toBe(true);
  pick(interval.row, "interval");
  expect(warning.hidden).toBe(true);
  expect(interval.unit.textContent).toBe(CLEANUP_EXTRA_LABELS.intervalUnitInterval);
});

test("a saved 바로 shows the warning and the changed unit text from the start", () => {
  const interval = intervalRow();
  const extra = renderCleanupExtra({ trigger: "on_save", autoApply: true }, interval);
  expect(extra.getTrigger()).toBe("on_save");
  expect(interval.row.querySelector<HTMLElement>(".cleanup-trigger-warning")!.hidden).toBe(false);
  expect(interval.unit.textContent).toBe(CLEANUP_EXTRA_LABELS.intervalUnitOnSave);
});

test("auto-apply shows one checkbox with one line of help and is read back", () => {
  const extra = renderCleanupExtra({ trigger: "interval", autoApply: true }, intervalRow());
  const box = extra.element.querySelector<HTMLInputElement>("input[type=checkbox]")!;
  expect(box.checked).toBe(true);
  expect([...extra.element.querySelectorAll("p")].map((p) => p.textContent)).toEqual([CLEANUP_EXTRA_LABELS.autoApplyHelp]);
  box.checked = false;
  box.dispatchEvent(new Event("change"));
  expect(extra.getAutoApply()).toBe(false);
});

test("readCleanupExtraValue reads both values and throws naming the key when one is missing", () => {
  const ok = { llm: { cleanup: { trigger: "on_save" } }, cleanupDeepPass: { entityRegister: { autoApply: false } } };
  expect(readCleanupExtraValue(ok)).toEqual({ trigger: "on_save", autoApply: false });
  expect(() => readCleanupExtraValue({ llm: { cleanup: {} }, cleanupDeepPass: { entityRegister: { autoApply: true } } }))
    .toThrow("llm.cleanup.trigger");
  expect(() => readCleanupExtraValue({ llm: { cleanup: { trigger: "interval" } }, cleanupDeepPass: {} }))
    .toThrow("cleanupDeepPass.entityRegister.autoApply");
});
