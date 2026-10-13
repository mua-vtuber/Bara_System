import { expect, test } from "bun:test";
import type { BackupResult, ProgressStage, RestoreResult } from "../shared/contracts.ts";
import { attachOrder, JobFollower, type JobPorts, type JobView } from "./backup-jobs.ts";

interface Sent { method: string; params: Record<string, unknown>; id?: string }

/** A bridge stand-in: every request is recorded and stays open until the test settles it by its id. */
function bridge() {
  const sent: Sent[] = [];
  const open = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();
  let next = 0;
  const ports: JobPorts = {
    request(method, params, id) {
      sent.push({ method, params, ...(id ? { id } : {}) });
      if (method === "backup.cancel" || method === "operation.cancel") return Promise.resolve({ cancelled: true });
      return new Promise((resolve, reject) => open.set(id!, { resolve, reject }));
    },
    newId: () => `r${++next}`,
    now: () => 1_000,
  };
  return { ports, sent, settle: (id: string, value: unknown) => open.get(id)!.resolve(value), fail: (id: string, error: unknown) => open.get(id)!.reject(error) };
}

function view<T>() {
  const seen: string[] = [];
  const stages: ProgressStage[] = [];
  const view: JobView<T> = {
    running: (startedAt) => seen.push(`running ${startedAt}`),
    stage: (stage) => { stages.push(stage); seen.push(`stage ${stage}`); },
    done: (result) => seen.push(`done ${JSON.stringify(result)}`),
    failed: (error) => seen.push(`failed ${(error as { code?: string }).code}`),
    ended: () => seen.push("ended"),
  };
  return { view, seen, stages };
}

const RESULT: RestoreResult = { backupName: "b", kind: "manual", memories: 3, archived: 0, attachments: 1, beforeFolder: "C:\\before", resumed: false };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a screen that goes away ends only its wait: the restore is never cancelled for it", async () => {
  const b = bridge();
  const v = view<RestoreResult>();
  const follower = new JobFollower<RestoreResult>("restore", b.ports, v.view);
  const waiting = follower.start({ id: "x" });
  expect(follower.busy).toBe(true);
  expect(b.sent).toEqual([{ method: "backup.restore", params: { id: "x" }, id: "r1" }]);
  follower.progress({ requestId: "r1", stage: "restore-data" });
  follower.dispose();
  // The only thing sent is the end of this screen's own wait; never `backup.cancel`.
  expect(b.sent.slice(1)).toEqual([{ method: "operation.cancel", params: { requestId: "r1" } }]);
  b.fail("r1", { code: "CANCELLED", message: "x" });
  await waiting;
  // A gone screen shows nothing more, and later progress does not reach it.
  follower.progress({ requestId: "r1", stage: "restore-switch" });
  expect(v.seen).toEqual(["running 1000", "stage restore-data"]);
});

test("a screen opened again joins the running restore, shows its stage and time at once, then its result", async () => {
  const b = bridge();
  const v = view<RestoreResult>();
  const follower = new JobFollower<RestoreResult>("restore", b.ports, v.view);
  const startedAt = "2026-10-07T00:00:00.000Z";
  const joined = follower.attach({ state: "running", startedAt, stage: "models", detail: { part: 1, parts: 2, loaded: 5, total: 10 } });
  expect(b.sent).toEqual([{ method: "backup.join", params: { kind: "restore" }, id: "r1" }]);
  expect(v.seen).toEqual([`running ${Date.parse(startedAt)}`, "stage models"]);
  // Progress of other requests is not this screen's.
  follower.progress({ requestId: "other", stage: "answer" });
  follower.progress({ requestId: "r1", stage: "restore-data" });
  b.settle("r1", RESULT);
  await joined;
  expect(v.seen.slice(2)).toEqual(["stage restore-data", `done ${JSON.stringify(RESULT)}`, "ended"]);
  expect(follower.busy).toBe(false);
});

test("a screen opened after the job ended shows how it ended, and nothing is joined", async () => {
  const b = bridge();
  const done = view<BackupResult>();
  const result: BackupResult = { folder: "C:\\b", folderName: "b", memories: 1, attachments: 0 };
  await new JobFollower<BackupResult>("export", b.ports, done.view).attach({ state: "done", startedAt: "a", endedAt: "b", result });
  expect(done.seen).toEqual([`done ${JSON.stringify(result)}`]);
  const failed = view<RestoreResult>();
  await new JobFollower<RestoreResult>("restore", b.ports, failed.view)
    .attach({ state: "failed", startedAt: "a", endedAt: "b", error: { code: "RESTORE_FAILED", message: "m" } });
  expect(failed.seen).toEqual(["failed RESTORE_FAILED"]);
  await new JobFollower<RestoreResult>("restore", b.ports, failed.view).attach(null);
  expect(b.sent).toEqual([]);
});

test("the screen's \"중단\" stops the job itself, and the wait ends as cancelled", async () => {
  const b = bridge();
  const v = view<BackupResult>();
  const follower = new JobFollower<BackupResult>("export", b.ports, v.view);
  const waiting = follower.start({});
  expect(b.sent[0]).toEqual({ method: "backup.export", params: {}, id: "r1" });
  await follower.cancel();
  expect(b.sent[1]).toEqual({ method: "backup.cancel", params: { kind: "export" } });
  b.fail("r1", { code: "CANCELLED", message: "m" });
  await waiting;
  expect(v.seen).toEqual(["running 1000", "failed CANCELLED", "ended"]);
  // A screen that waits for nothing has no wait to end when it goes away.
  follower.dispose();
  await flush();
  expect(b.sent.length).toBe(2);
});

test("the status line ends on what matters now: ended jobs first, earlier ends first, a running job last", () => {
  const ended = (endedAt: string) => ({ state: "done" as const, startedAt: endedAt, endedAt, result: {} });
  const running = { state: "running" as const, startedAt: "2026-10-07T00:00:00.000Z", stage: null };
  expect(attachOrder({ export: null, restore: null })).toEqual([]);
  expect(attachOrder({ export: running, restore: ended("2026-10-07T01:00:00.000Z") })).toEqual(["restore", "export"]);
  expect(attachOrder({ export: ended("2026-10-07T02:00:00.000Z"), restore: ended("2026-10-07T01:00:00.000Z") })).toEqual(["restore", "export"]);
  expect(attachOrder({ export: null, restore: running })).toEqual(["restore"]);
});
