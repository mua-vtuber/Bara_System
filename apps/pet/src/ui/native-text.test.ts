import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import nativeHost from "../shared/native-host.json";
import { messages } from "./messages.ts";

// The OS error number wording is native-host.json's (`text.startupStatusSuffix`): the host draws it in
// its startup dialog and the screen draws it after a host error. A second copy of the words in the
// screen's messages is how the two used to be able to drift.
test("the screen adds the OS error number with the host catalog's wording", () => {
  const template = nativeHost.text.startupStatusSuffix;
  expect(template).toContain("{status}");
  expect(messages.errors.withStatus("본문", 5)).toBe(`본문${template.replace("{status}", "5")}`);
});

test("messages.ts does not repeat the host catalog's error number wording", () => {
  const wording = nativeHost.text.startupStatusSuffix.replace("{status}", "").replace(/[()]/g, "").trim();
  expect(wording.length).toBeGreaterThan(0);
  const source = readFileSync(join(import.meta.dir, "messages.ts"), "utf8");
  // The doc comment on `withStatus` names the catalog key, not the words, so any hit is a copy.
  expect(source.includes(wording)).toBe(false);
});

// The tray menu text lives only in the host catalog (`src-tauri/src/tray.rs` reads it through `native_host::tray_labels`);
// the toggle item switches between the two pet labels, so they must be distinct.
test("the tray menu has a non-empty label for every item and two distinct pet toggle labels", () => {
  const tray = nativeHost.text.tray;
  expect(Object.keys(tray).sort()).toEqual(["dashboard", "guide", "hidePet", "input", "quit", "recentResult", "search", "settings", "showPet", "status", "statusAttention", "statusQuitting"]);
  for (const label of Object.values(tray)) expect(label.trim()).not.toBe("");
  expect(tray.hidePet).not.toBe(tray.showPet);
  expect(nativeHost.contract.trayErrorEvent).toBe("pet-tray-error");
});
