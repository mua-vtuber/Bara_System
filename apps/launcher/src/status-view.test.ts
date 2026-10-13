import { expect, test } from "bun:test";
import * as view from "./status-view.ts";

test("setup failure remains visible after refreshed process status and permits retry", () => {
  expect(typeof view.launcherView).toBe("function");
  const result = view.launcherView({ needsSetup: true, running: false, busy: false, progress: "", error: "모델 준비 실패", hasExistingSettings: false });
  expect(result.error).toBe("모델 준비 실패");
  expect(result.setupDisabled).toBe(false);
  expect(result.openDisabled).toBe(true);
});

test("long setup disables competing actions and keeps current progress visible", () => {
  const result = view.launcherView({ needsSetup: false, running: true, busy: true, progress: "모델 다운로드 중", error: "", hasExistingSettings: false });
  expect(result.status).toBe("모델 다운로드 중");
  expect(result.setupDisabled).toBe(true);
  expect(result.openDisabled).toBe(true);
});

// WP-B2-06R — the keep-current-AI-settings button appears only while setup is
// needed and a previous settings file exists to keep; otherwise there is
// nothing to keep, so the button must stay hidden.
test("keep-current button shows only when setup is needed and a previous settings file exists", () => {
  const withPrevious = view.launcherView({ needsSetup: true, running: false, busy: false, progress: "", error: "", hasExistingSettings: true });
  expect(withPrevious.keepCurrentVisible).toBe(true);

  const firstInstall = view.launcherView({ needsSetup: true, running: false, busy: false, progress: "", error: "", hasExistingSettings: false });
  expect(firstInstall.keepCurrentVisible).toBe(false);

  const setupNotNeeded = view.launcherView({ needsSetup: false, running: true, busy: false, progress: "", error: "", hasExistingSettings: true });
  expect(setupNotNeeded.keepCurrentVisible).toBe(false);
});
