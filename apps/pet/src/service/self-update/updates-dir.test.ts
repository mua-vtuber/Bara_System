import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceError } from "../errors.ts";
import { junction } from "../test-utils/junction.ts";
import { clearUpdates, prepareUpdatesDir, updatesDir } from "./updates-dir.ts";

const windowsOnly = test.skipIf(process.platform !== "win32");

test("every entry inside the updates folder is removed and nothing next to it", async () => {
  const data = mkdtempSync(join(tmpdir(), "bara-updates-"));
  const dir = updatesDir(data);
  mkdirSync(join(dir, "nested"), { recursive: true });
  writeFileSync(join(dir, "Bara.Pet_0.1.9_x64-setup.exe"), "old");
  writeFileSync(join(dir, "Bara.Pet_0.1.9_x64-setup.exe.partial"), "half");
  writeFileSync(join(dir, "nested", "x"), "x");
  writeFileSync(join(data, "pet-settings.json"), "{}");
  expect(await clearUpdates(dir)).toEqual([]);
  expect(readdirSync(dir)).toEqual([]);
  expect(existsSync(join(data, "pet-settings.json"))).toBe(true);
});

test("a missing updates folder is nothing to clean", async () => {
  expect(await clearUpdates(join(mkdtempSync(join(tmpdir(), "bara-updates-")), "updates"))).toEqual([]);
});

windowsOnly("an updates folder that is a junction is neither entered nor written", async () => {
  const data = mkdtempSync(join(tmpdir(), "bara-updates-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "bara-elsewhere-"));
  writeFileSync(join(elsewhere, "keep.txt"), "keep");
  junction(updatesDir(data), elsewhere);
  expect((await clearUpdates(updatesDir(data))).map((failure) => failure.code)).toEqual(["SELF_UPDATE_DIR_LINK"]);
  expect(existsSync(join(elsewhere, "keep.txt"))).toBe(true);
  const refused = await prepareUpdatesDir(updatesDir(data)).then(() => null, (error: unknown) => error);
  expect(refused).toBeInstanceOf(ServiceError);
  expect((refused as ServiceError).code).toBe("SELF_UPDATE_DIR_LINK");
});

windowsOnly("a junction inside the updates folder is removed without touching what it points to", async () => {
  const data = mkdtempSync(join(tmpdir(), "bara-updates-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "bara-elsewhere-"));
  writeFileSync(join(elsewhere, "keep.txt"), "keep");
  mkdirSync(updatesDir(data));
  junction(join(updatesDir(data), "link"), elsewhere);
  expect(await clearUpdates(updatesDir(data))).toEqual([]);
  expect(readdirSync(updatesDir(data))).toEqual([]);
  expect(existsSync(join(elsewhere, "keep.txt"))).toBe(true);
});
