import { RPC_METHODS, type RpcMethod } from "../shared/contracts.ts";
import { messages } from "../ui/messages.ts";
import { serviceError } from "./errors.ts";

/** "입력한 메모 바로 정리" 한 번의 시간 한도 — 정리 AI 호출 2회(항목 등록·사람 연결) + MCP 왕복. */
export const CLEANUP_ON_SAVE_TIMEOUT_MS = 120_000;

/** Guards against a code defect hanging forever, not against a slow-but-healthy operation.
 * Sized above the worst legitimate case this WP could find: two SSH reconnects plus a
 * save -> classify -> update round trip (~6 minutes; see the fix plan's "남는 위험" note). */
export const OPERATION_SAFETY_CEILING_MS = 15 * 60_000;

/** Every method the service can dispatch, including the native-host-only `dashboard.link`
 * (see `router.ts` `needsServer`/`connectionOperations`), maps to a ceiling policy. `null`
 * means "no ceiling" — the operation already has its own step limits and a user-facing
 * cancel button, so an artificial total cap would only cut off a legitimately long run. */
export type CeilingPolicy = number | null;
/** Every method that starts the local memory server (`connection.test`, a memory request, `install.local`) can run
 * the update gate's pre-update backup first, which a large store takes longer than this ceiling for. The ceiling
 * still applies: the backup runs on the gate's own signal (`maintenance/upgrade.ts` `UpdateGate`), so a ceiling or a
 * cancel ends only that request's wait, the backup goes on and the next request joins it. Only quitting stops it,
 * and each backup step carries its own limit (30 minutes for the snapshot and the check, 60 for the export). */
/** `startup.check` only waits for the startup check, which carries `connection.test`'s ceiling itself (`router.ts`
 * `startupCheck`), so every caller receives the check's own outcome rather than a second, racing timeout. */
/** `backup.restore` recomputes every search vector of the store, which takes longer than the ceiling for a large
 * one; each of its steps has its own limit (`restore.ts`) and the settings screen's "중단" ends it. `backup.join`
 * only waits for such a job (`background-job.ts`), as `backup.export` and `backup.restore` do for the one they start. */
/** `selfUpdate.install` downloads a 200 MB installer, which a slow line takes longer than the ceiling for; the
 * download stops itself after `SELF_UPDATE.downloadStallMs` without a byte (`self-update/download.ts`) and runs on its
 * own signal, so only quitting ends it. */
const UNBOUNDED_BY_USER_CANCEL: ReadonlySet<RpcMethod | "dashboard.link"> = new Set([
  "install.local", "install.remote", "cleanup.run", "backup.export", "backup.restore", "backup.join", "startup.check",
  "selfUpdate.install",
]);
export const OPERATION_CEILINGS: ReadonlyMap<RpcMethod | "dashboard.link", CeilingPolicy> = new Map(
  [...RPC_METHODS, "dashboard.link" as const].map((method) =>
    [method, UNBOUNDED_BY_USER_CANCEL.has(method) ? null : OPERATION_SAFETY_CEILING_MS] as const),
);

export function ceilingFor(method: RpcMethod | "dashboard.link"): CeilingPolicy {
  const policy = OPERATION_CEILINGS.get(method);
  if (policy === undefined) throw new Error(`no ceiling policy registered for method "${method}"`);
  return policy;
}

/** Run `work` against a signal derived from `signal`, and additionally abort that derived
 * signal — not the caller's own `signal` — once `ceilingMs` elapses. A parent cancellation
 * (the caller's `signal` firing) is left for the caller to distinguish, exactly as before this
 * WP; only the ceiling's own expiry is reported here, as `OPERATION_TIMEOUT`.
 *
 * The ceiling guards against a code defect that ignores its own cancellation signal, so it
 * must not itself wait on `work` to notice that signal and unwind. Once `ceilingMs` elapses
 * this races ahead and rejects with `OPERATION_TIMEOUT` immediately; `work` is only asked (via
 * `ceiling.abort()`) to stop, not awaited for confirmation that it did. Its eventual settlement
 * is swallowed so an unhandled rejection never surfaces after this call has already returned. */
export function runWithCeiling<T>(work: (signal: AbortSignal) => Promise<T>,
  ceilingMs: CeilingPolicy, signal: AbortSignal): Promise<T> {
  if (ceilingMs === null) return work(signal);
  const ceiling = new AbortController();
  const combined = AbortSignal.any([signal, ceiling.signal]);
  const settled = work(combined);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      ceiling.abort();
      reject(serviceError("OPERATION_TIMEOUT", messages.rpc.operationTimeout));
    }, ceilingMs);
    settled.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); if (!ceiling.signal.aborted) reject(error); },
    ).catch(() => {});
  });
}
