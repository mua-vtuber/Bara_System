import { expect, test } from "bun:test";
import { ADAPTERS, adapterSource, adapterStartFile } from "./adapter-registry.ts";

test("the discord adapter is the bot app with its settings file", () => {
  expect(adapterSource("discord")).toEqual({ dir: "apps/bot-discord", settingsFile: "bot-settings.json" });
  expect(Object.keys(ADAPTERS)).toEqual(["discord"]);
});

test("an unknown adapter name stops and lists the known names", () => {
  let failure: { code?: string; message?: string } = {};
  try { adapterSource("slack"); } catch (error) { failure = error as typeof failure; }
  expect(failure.code).toBe("ADAPTER_UNKNOWN");
  expect(failure.message).toContain("discord");
});

test("the start file is the one `bun run <file>` in scripts.start names", () => {
  expect(adapterStartFile({ scripts: { start: "bun run src/index.ts" } }, "discord")).toBe("src/index.ts");
  for (const bad of [{}, { scripts: {} }, { scripts: { start: "node src/index.js" } }, { scripts: { start: "bun run ../x.ts" } }]) {
    expect(() => adapterStartFile(bad, "discord")).toThrow();
  }
});
