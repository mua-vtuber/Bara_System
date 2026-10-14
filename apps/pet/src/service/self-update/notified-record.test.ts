import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SELF_UPDATE } from "../../shared/self-update.ts";
import { ServiceError } from "../errors.ts";
import { NotifiedRecord, notifiedRecordPath } from "./notified-record.ts";

// Real files in a scratch data folder; the only stand-in is a rename that fails, to show a failed write keeps the old record.
const scratch = () => mkdtempSync(join(tmpdir(), "bara-notified-"));
async function failure(run: Promise<unknown>): Promise<ServiceError> {
  const caught = await run.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(ServiceError);
  return caught as ServiceError;
}

test("no record yet reads as nothing notified", async () => {
  expect(await new NotifiedRecord(notifiedRecordPath(scratch())).read()).toBeNull();
});

test("the record is written before the first-run setup made the settings file", async () => {
  const dir = scratch();
  const record = new NotifiedRecord(notifiedRecordPath(dir));
  await record.write("0.1.9");
  expect(existsSync(join(dir, "pet-settings.json"))).toBe(false);
  expect(JSON.parse(readFileSync(record.file, "utf8"))).toEqual({ format: SELF_UPDATE.recordFormat, notifiedVersion: "0.1.9" });
  expect(await new NotifiedRecord(record.file).read()).toBe("0.1.9");
});

test("a write leaves only the new record, no temporary file", async () => {
  const dir = scratch();
  const record = new NotifiedRecord(notifiedRecordPath(dir));
  await record.write("0.1.9");
  await Promise.all([record.write("0.1.10"), record.write("0.1.11")]);
  expect(readdirSync(dir)).toEqual([SELF_UPDATE.recordFileName]);
  expect(await record.read()).toBe("0.1.11");
});

test("a write that cannot replace the file keeps the old record and leaves no temporary file", async () => {
  const dir = scratch();
  await new NotifiedRecord(notifiedRecordPath(dir)).write("0.1.9");
  const refusing = new NotifiedRecord(notifiedRecordPath(dir), async () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
  const error = await failure(refusing.write("0.1.10"));
  expect(error.code).toBe("SELF_UPDATE_RECORD_SAVE_FAILED");
  expect(error.publicMessage).toContain(notifiedRecordPath(dir));
  expect(readdirSync(dir)).toEqual([SELF_UPDATE.recordFileName]);
  expect(await refusing.read()).toBe("0.1.9");
});

test("a record that is not JSON is reported, never read as nothing", async () => {
  const dir = scratch();
  writeFileSync(notifiedRecordPath(dir), "{\"format\":1,\"notifiedVer");
  const error = await failure(new NotifiedRecord(notifiedRecordPath(dir)).read());
  expect(error.code).toBe("SELF_UPDATE_RECORD_INVALID");
  expect(error.publicMessage).toContain(notifiedRecordPath(dir));
});

test("a record of an unknown shape is reported", async () => {
  const dir = scratch();
  for (const value of [[], { format: 2, notifiedVersion: "0.1.9" }, { format: 1, notifiedVersion: "latest" }, { format: 1 },
    { format: 1, notifiedVersion: "0.1.9", extra: true }, "0.1.9"]) {
    writeFileSync(notifiedRecordPath(dir), JSON.stringify(value));
    expect((await failure(new NotifiedRecord(notifiedRecordPath(dir)).read())).code).toBe("SELF_UPDATE_RECORD_INVALID");
  }
});

test("a record that cannot be read is reported with its cause", async () => {
  const dir = scratch();
  mkdirSync(notifiedRecordPath(dir)); // a folder where the file should be: reading fails with an I/O error
  const error = await failure(new NotifiedRecord(notifiedRecordPath(dir)).read());
  expect(error.code).toBe("SELF_UPDATE_RECORD_UNREADABLE");
  expect(error.publicMessage).toContain("원인:");
});

test("only a release version is recorded, and a refused one leaves the file untouched", async () => {
  const dir = scratch();
  const record = new NotifiedRecord(notifiedRecordPath(dir));
  await record.write("0.1.9");
  expect((await failure(record.write("v0.1.10"))).code).toBe("SELF_UPDATE_VERSION_INVALID");
  expect(await record.read()).toBe("0.1.9");
});
