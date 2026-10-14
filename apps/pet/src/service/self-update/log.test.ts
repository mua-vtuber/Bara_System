import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SELF_UPDATE } from "../../shared/self-update.ts";
import { SelfUpdateLog } from "./log.ts";

const at = () => new Date("2026-10-14T03:00:00.000Z");
const logFile = () => join(mkdtempSync(join(tmpdir(), "bara-self-update-log-")), SELF_UPDATE.logFileName);

test("each write appends one line with the time, the code and the sentence on one line", async () => {
  const file = logFile();
  const log = new SelfUpdateLog(file, at);
  await log.write("SELF_UPDATE_HTTP", "첫 줄\n둘째 줄");
  await log.write("SELF_UPDATE_NETWORK", "끊김");
  expect(readFileSync(file, "utf8")).toBe("2026-10-14T03:00:00.000Z SELF_UPDATE_HTTP 첫 줄 둘째 줄\n2026-10-14T03:00:00.000Z SELF_UPDATE_NETWORK 끊김\n");
  expect(log.error).toBeNull();
});

test("past the size limit the older half is dropped and the newest line kept", async () => {
  const file = logFile();
  const log = new SelfUpdateLog(file, at);
  const sentence = "x".repeat(200);
  for (let index = 0; index < 400; index++) await log.write("SELF_UPDATE_HTTP", `${index} ${sentence}`);
  expect(statSync(file).size).toBeLessThanOrEqual(SELF_UPDATE.logMaxBytes);
  const text = readFileSync(file, "utf8");
  expect(text.endsWith(`399 ${sentence}\n`)).toBe(true);
  expect(text).not.toContain(` 0 ${sentence}`);
});

test("two writes fired together across the size limit both survive", async () => {
  const file = logFile();
  const filler = `${at().toISOString()} SELF_UPDATE_HTTP ${"y".repeat(100)}\n`;
  // Fill to just under the limit so the first new line fits and the second one forces the trim.
  const count = Math.floor((SELF_UPDATE.logMaxBytes - 200) / Buffer.byteLength(filler, "utf8"));
  writeFileSync(file, filler.repeat(count));
  const log = new SelfUpdateLog(file, at);
  const big = "z".repeat(150);
  await Promise.all([log.write("SELF_UPDATE_HTTP", `first ${big}`), log.write("SELF_UPDATE_NETWORK", `second ${big}`)]);
  const text = readFileSync(file, "utf8");
  expect(text).toContain(`first ${big}\n`);
  expect(text.endsWith(`second ${big}\n`)).toBe(true);
  expect(statSync(file).size).toBeLessThanOrEqual(SELF_UPDATE.logMaxBytes);
  expect(log.error).toBeNull();
});

test("a log that cannot be written keeps the first cause instead of staying silent", async () => {
  const file = logFile();
  mkdirSync(file); // a folder where the file should be: every write fails
  const log = new SelfUpdateLog(file, at);
  await log.write("SELF_UPDATE_HTTP", "실패");
  expect(log.error).not.toBeNull();
});
