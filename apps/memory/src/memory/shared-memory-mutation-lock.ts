import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "bun:sqlite";

type DatabaseOwner = { getRawDb(): Database } | { readonly db: Database };
const queues = new WeakMap<Database, Promise<void>>();
const preparing = new WeakMap<Database, number>();
interface MutationLease { active: boolean }
const held = new AsyncLocalStorage<ReadonlyMap<Database, MutationLease>>();

/** Includes queued writes: reset must not reuse IDs before an older write finishes. */
export function memoryMutationsPending(owner: DatabaseOwner): boolean {
  const db = "getRawDb" in owner ? owner.getRawDb() : owner.db;
  return queues.has(db) || preparing.has(db);
}

/** Track a complete prepare-and-write operation without serializing its LLM call.
 * The reset guard must cover the gap between preparation and joining the write queue.
 */
export async function withMemoryWriteActivity<T>(owner: DatabaseOwner, work: () => Promise<T>): Promise<T> {
  const db = "getRawDb" in owner ? owner.getRawDb() : owner.db;
  preparing.set(db, (preparing.get(db) ?? 0) + 1);
  try {
    return await work();
  } finally {
    const remaining = preparing.get(db)! - 1;
    if (remaining === 0) preparing.delete(db);
    else preparing.set(db, remaining);
  }
}

/** Detached background work must acquire its own lease, even before ours ends. */
export function outsideMemoryMutationContext<T>(work: () => T): T {
  return held.exit(work);
}

/**
 * One server database has one async write queue. The lock spans embedding and
 * post-write wiring as well as SQL, so a retraction cannot race a new dependent
 * write. Nested service/repository calls reuse the lock. Reads do not acquire it.
 * node:async_hooks is supported by Bun; no separate runtime dependency is needed.
 */
export async function withMemoryMutationLock<T>(owner: DatabaseOwner, work: () => Promise<T>): Promise<T> {
  const db = "getRawDb" in owner ? owner.getRawDb() : owner.db;
  const inherited = held.getStore();
  if (inherited?.get(db)?.active) return work();
  const previous = queues.get(db) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  queues.set(db, tail);
  await previous;
  const lease: MutationLease = { active: true };
  try {
    return await held.run(new Map([...(inherited ?? []), [db, lease]]), work);
  } finally {
    // Detached promises/timers inherit ALS references. Their ancestor's completed
    // lease must not authorize them to bypass a later owner's queue.
    lease.active = false;
    release();
    if (queues.get(db) === tail) queues.delete(db);
  }
}
