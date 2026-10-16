import { expect, test } from "bun:test";
import { keptForInstall, sameViewKept } from "./panel-view.ts";

test("the settings and the setup shown again are kept; a result is drawn again; another view replaces them", () => {
  expect(sameViewKept("settings", "settings")).toBe(true);
  expect(sameViewKept("onboarding", "onboarding")).toBe(true);
  // A bubble clicked during a restore asks for the result: the settings give way, which ends only their waits.
  expect(sameViewKept("settings", "result")).toBe(false);
  expect(sameViewKept("result", "result")).toBe(false);
  expect(sameViewKept("answer", "answer")).toBe(false);
  expect(sameViewKept("result", "settings")).toBe(false);
  expect(sameViewKept("settings", "onboarding")).toBe(false);
});

test("while an install runs in the view on screen, every other view waits; the same view and a free window go on", () => {
  // The pet's menu and the tray's "설정" during an install the setup started: the setup's storage step stays.
  expect(keptForInstall("onboarding", "settings", true)).toBe(true);
  // A result bubble or a notebook tab during an install the settings started: the settings stay.
  expect(keptForInstall("settings", "result", true)).toBe(true);
  expect(keptForInstall("settings", "cleanup", true)).toBe(true);
  // The same view asked again is left to `sameViewKept`, which keeps the setup and the settings anyway.
  expect(keptForInstall("settings", "settings", true)).toBe(false);
  // Nothing is drawn yet, or no install runs: the window switches as before.
  expect(keptForInstall(null, "result", true)).toBe(false);
  expect(keptForInstall("onboarding", "settings", false)).toBe(false);
});
