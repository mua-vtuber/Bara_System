import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTER_DATA_DIR_ENV, botDataPath } from "./data-dir.ts";
import { putBotSettings } from "./settings-store.ts";
import { loadAdapterToken, saveAdapterToken } from "./adapter-token-store.ts";
import { loadOrCreateAdminToken } from "./admin-token-store.ts";
import { ScheduleReminderLedger } from "./schedule-reminder-store.ts";

const KEYS = [ADAPTER_DATA_DIR_ENV, "BOT_SETTINGS_PATH", "BOT_ADAPTER_TOKEN_PATH", "BOT_ADMIN_TOKEN_PATH"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bot-data-"));
  for (const key of KEYS) delete process.env[key];
  process.env[ADAPTER_DATA_DIR_ENV] = dir;
});
afterEach(() => {
  for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  rmSync(dir, { recursive: true, force: true });
});

test("without the variable the data files stay under data/", () => {
  expect(botDataPath("bot-settings.json", {})).toBe("data/bot-settings.json");
  expect(botDataPath("bot-settings.json", { [ADAPTER_DATA_DIR_ENV]: "   " })).toBe("data/bot-settings.json");
});

test("an absolute folder holds the data files", () => {
  expect(botDataPath("bot-settings.json", { [ADAPTER_DATA_DIR_ENV]: dir })).toBe(join(dir, "bot-settings.json"));
});

test("a relative folder stops with the variable's name", () => {
  expect(() => botDataPath("bot-settings.json", { [ADAPTER_DATA_DIR_ENV]: "adapters/discord/data" })).toThrow(ADAPTER_DATA_DIR_ENV);
});

test("all four bot files land in the adapter data folder", () => {
  putBotSettings({});
  saveAdapterToken({ adapterId: "discord", endpoint: "http://127.0.0.1:3001", token: "t".repeat(40), requestId: "r1", pickupSecret: "p".repeat(32) });
  loadOrCreateAdminToken();
  new ScheduleReminderLedger().markSent("k", "2026-10-08T00:00:00.000Z");
  for (const name of ["bot-settings.json", "bot-adapter-token.json", "bot-admin-token.json", "bot-schedule-reminders.json"])
    expect({ name, present: existsSync(join(dir, name)) }).toEqual({ name, present: true });
  expect(loadAdapterToken()?.adapterId).toBe("discord");
});

test("a file's own variable still wins over the data folder", () => {
  process.env.BOT_SETTINGS_PATH = join(dir, "elsewhere.json");
  putBotSettings({});
  expect(existsSync(join(dir, "elsewhere.json"))).toBe(true);
  expect(existsSync(join(dir, "bot-settings.json"))).toBe(false);
});
