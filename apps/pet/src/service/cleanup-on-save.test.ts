import { expect, test } from "bun:test";
import { messages } from "../ui/messages.ts";
import { CleanupOnSave, cleanupOnSaveTarget, type CleanupOnSaveSettings } from "./cleanup-on-save.ts";

const result = { submitted: 1, noFinding: 0, skipped: 0, audience: "", failures: [] };
const settings = (on: boolean, provider: "claude" | "none" = "claude"): (() => Promise<CleanupOnSaveSettings>) => async () => ({ cleanupOnSave: on, cleanup: { provider, model: "" } });
const tick = () => new Promise((r) => setTimeout(r, 0));

test("off by default: saving starts nothing", async () => {
  const calls: number[] = [];
  const onSave = new CleanupOnSave(settings(false), { runForMemo: async (id) => { calls.push(id); return result; } });
  onSave.start(5);
  await tick();
  expect(calls).toEqual([]);
  expect(onSave.last()).toBeNull();
});

test("when on, the save returns first and the cleanup result is kept for the settings screen", async () => {
  let release!: () => void;
  const onSave = new CleanupOnSave(settings(true), { runForMemo: () => new Promise((r) => { release = () => r(result); }) });
  onSave.start(5);
  await tick();
  expect(onSave.last()).toBeNull();
  release();
  await tick();
  expect(onSave.last()).toMatchObject({ memoryId: 5, outcome: "done" });
});

test("a failure is recorded with its reason and does not throw into the save", async () => {
  const onSave = new CleanupOnSave(settings(true), { runForMemo: async () => { throw new Error("CLI 없음"); } });
  expect(() => onSave.start(6)).not.toThrow();
  await tick();
  await tick();
  expect(onSave.last()).toMatchObject({ memoryId: 6, outcome: "failed", detail: expect.stringContaining("CLI 없음") });
});

test("an unreadable settings file is recorded as a failure instead of an unhandled rejection", async () => {
  const onSave = new CleanupOnSave(async () => { throw new Error("설정 읽기 실패"); }, { runForMemo: async () => result });
  expect(() => onSave.start(7)).not.toThrow();
  await tick();
  await tick();
  expect(onSave.last()).toMatchObject({ memoryId: 7, outcome: "failed", detail: expect.stringContaining("설정 읽기 실패") });
});

test("no cleanup AI chosen is shown as skipped with its reason", async () => {
  const onSave = new CleanupOnSave(settings(true, "none"), { runForMemo: async () => result });
  onSave.start(8);
  await tick();
  await tick();
  expect(onSave.last()).toMatchObject({ memoryId: 8, outcome: "skipped" });
});

test("a run where every stage was skipped (older server) is a visible failure with the server's reason, and a result from an older server without a failures list still counts", async () => {
  const skipped = { submitted: 0, noFinding: 0, skipped: 2, audience: "", failures: [{ stage: "entityRegister" as const, code: "SERVER_STAGE_UNSUPPORTED", message: "서버가 이 정리 단계를 지원하지 않아요." }] };
  const a = new CleanupOnSave(settings(true), { runForMemo: async () => skipped });
  a.start(9);
  await tick();
  await tick();
  expect(a.last()).toMatchObject({ memoryId: 9, outcome: "failed", detail: "서버가 이 정리 단계를 지원하지 않아요." });
  const b = new CleanupOnSave(settings(true), { runForMemo: async () => ({ ...result, failures: undefined }) as never });
  b.start(10);
  await tick();
  await tick();
  expect(b.last()).toMatchObject({ memoryId: 10, outcome: "done" });
});

const abortable = (onSignal?: (s: AbortSignal) => void) => (_id: number, s: AbortSignal) =>
  new Promise<typeof result>((_r, reject) => { onSignal?.(s); s.addEventListener("abort", () => reject(new Error("중단됨"))); });

test("close aborts a running cleanup, is not recorded as a time-out failure, and later starts do nothing", async () => {
  let signal!: AbortSignal;
  const calls: number[] = [];
  const onSave = new CleanupOnSave(settings(true), { runForMemo: (id, s) => { calls.push(id); return abortable((x) => { signal = x; })(id, s); } });
  onSave.start(11);
  await tick();
  await tick();
  onSave.close();
  expect(signal.aborted).toBe(true);
  await tick();
  expect(onSave.last()).toBeNull();
  onSave.start(12);
  await tick();
  expect(calls).toEqual([11]);
});

test("the time limit stops a run and records the time-out reason", async () => {
  const onSave = new CleanupOnSave(settings(true), { runForMemo: abortable() }, () => new Date(), 5);
  onSave.start(13);
  await new Promise((r) => setTimeout(r, 40));
  expect(onSave.last()).toMatchObject({ memoryId: 13, outcome: "failed", detail: messages.settings.cleanupOnSaveTimedOut });
});

test("overlapping starts run one at a time in save order", async () => {
  const order: string[] = [];
  const releases: Array<() => void> = [];
  const onSave = new CleanupOnSave(settings(true), { runForMemo: (id) => { order.push(`begin ${id}`); return new Promise((r) => { releases.push(() => { order.push(`end ${id}`); r(result); }); }); } });
  onSave.start(1); onSave.start(2); onSave.start(3);
  await tick(); await tick();
  expect(order).toEqual(["begin 1"]);
  releases[0]!(); await tick(); await tick();
  expect(order).toEqual(["begin 1", "end 1", "begin 2"]);
  releases[1]!(); await tick(); await tick();
  releases[2]!(); await tick(); await tick();
  expect(order).toEqual(["begin 1", "end 1", "begin 2", "end 2", "begin 3", "end 3"]);
});

test("a memo already queued or running is not queued again, but can be after it finished", async () => {
  const calls: number[] = [];
  let release!: () => void;
  const onSave = new CleanupOnSave(settings(true), { runForMemo: (id) => { calls.push(id); return new Promise((r) => { release = () => r(result); }); } });
  onSave.start(4); onSave.start(4);
  await tick(); await tick();
  onSave.start(4);
  release(); await tick(); await tick();
  expect(calls).toEqual([4]);
  onSave.start(4);
  await tick(); await tick();
  expect(calls).toEqual([4, 4]);
  release(); await tick();
});

test("a later success does not erase an earlier failure", async () => {
  let fail = true;
  const onSave = new CleanupOnSave(settings(true), { runForMemo: async () => { if (fail) throw new Error("첫 실패"); return result; } });
  onSave.start(20);
  await tick(); await tick();
  fail = false;
  onSave.start(21);
  await tick(); await tick();
  expect(onSave.report()).toMatchObject({ latest: { memoryId: 21, outcome: "done" }, lastFailure: { memoryId: 20, outcome: "failed", detail: expect.stringContaining("첫 실패") } });
});

test("a save starts cleanup only for a saved normal memo; a missing resultType still counts, an entity patch and an unsaved result do not", () => {
  const memory = { id: 31, content: "x" };
  expect(cleanupOnSaveTarget({ state: "saved", requestId: "r", memory })).toBe(31);
  expect(cleanupOnSaveTarget({ state: "saved", requestId: "r", memory, resultType: "memory" })).toBe(31);
  expect(cleanupOnSaveTarget({ state: "saved", requestId: "r", memory, resultType: "entity_patch" })).toBeNull();
  expect(cleanupOnSaveTarget({ state: "saved", requestId: "r" })).toBeNull();
  expect(cleanupOnSaveTarget({ state: "pending", requestId: "r", memory })).toBeNull();
  expect(cleanupOnSaveTarget({ state: "rejected", requestId: "r", memory })).toBeNull();
});

test("start returns at once while the cleanup is still running, and never calls it when the setting is off", async () => {
  let ran = 0;
  let release!: () => void;
  const hang = { runForMemo: () => { ran++; return new Promise<typeof result>((r) => { release = () => r(result); }); } };
  const on = new CleanupOnSave(settings(true), hang);
  expect(on.start(40)).toBeUndefined();
  const off = new CleanupOnSave(settings(false), hang);
  off.start(41);
  await tick(); await tick();
  expect(ran).toBe(1);
  release(); await tick();
});

