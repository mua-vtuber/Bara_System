import { expect, test } from "bun:test";
import { sameViewKept } from "./panel-view.ts";

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
