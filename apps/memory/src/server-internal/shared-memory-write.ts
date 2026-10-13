/** Evidence-aware writes shared by MCP and REST; original events are not repeated votes. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { SqliteMemoryStore } from "../db/store.ts";
import { nowKst } from "../db/store-internal/helpers.ts";
import { normalizeProjectId } from "../memory/project-scope.ts";
import { planEntityInput } from "../memory/entity-input-plan.ts";
import { isCurrentMemory, readSharedMemory, sharedMemorySchema } from "../memory/shared-memory-contract.ts";
import { withMemoryMutationLock, withMemoryWriteActivity } from "../memory/shared-memory-mutation-lock.ts";
import { readMemoryVisibility } from "../memory/shared-memory-read.ts";
import {
  findServerOwnedMetadataKey, immediateExtractionArgs, inputSourceOf, prepareImmediateExtraction, saveTextInput,
  type PreparedImmediateExtraction, type SaveTextInputArgs, type SaveTextInputResult,
} from "./save-input.ts";
import { PreparedExtractionMismatchError } from "./save-input-immediate.ts";
import { applyWriteGuard, SecretDetectedError, type WriteGuardOptions } from "./write-guard/write-guard.ts";

// Clients describe evidence, but cannot set lifecycle state, revisions, or author identity.
export const memoryEvidenceSchema = z.object({
  assertionKind: sharedMemorySchema.shape.assertionKind,
  sourceEventId: sharedMemorySchema.shape.sourceEventId,
  claimKey: sharedMemorySchema.shape.claimKey,
  sessionRef: sharedMemorySchema.shape.sessionRef,
  evidenceRefs: sharedMemorySchema.shape.evidenceRefs,
  validFrom: sharedMemorySchema.shape.validFrom,
  validUntil: sharedMemorySchema.shape.validUntil,
}).strict();
export type MemoryEvidenceInput = z.input<typeof memoryEvidenceSchema>;

export class MemoryEvidenceError extends Error {
  readonly code = "INVALID_INPUT";
}

function guardedEvidence(input: MemoryEvidenceInput | undefined, options?: WriteGuardOptions) {
  const guarded: Record<string, unknown> = { ...input };
  for (const [key, value] of Object.entries(guarded)) {
    if (typeof value === "string") guarded[key] = applyWriteGuard(value, options);
  }
  const parsed = memoryEvidenceSchema.safeParse(guarded);
  if (!parsed.success) throw new MemoryEvidenceError(parsed.error.message);
  return parsed.data;
}

const recordedEvidenceSchema = memoryEvidenceSchema.extend({ producer: z.string().nullable().default(null) });
export type MemoryEvidenceRecord = z.output<typeof recordedEvidenceSchema> & { createdAt: string };

/**
 * Rows listMemoryEvidence dropped, by cause (WP-B1-16 / SA-8). Never the row's own content —
 * only a count, so a caller can say "1 ledger entry was omitted" without saying what it held
 * (a malformed row's shape or a credential string would defeat the reason it is safety-dropped).
 */
export interface EvidenceOmitted {
  /** JSON.parse or schema validation failed: the row is not a well-formed evidence record. */
  malformed: number;
  /** The row parsed fine but a field (commonly `producer`) looks like a credential. */
  unsafe: number;
}

export interface ListMemoryEvidenceResult {
  records: MemoryEvidenceRecord[];
  omitted: EvidenceOmitted;
}

/** Return validated event evidence, never raw ledger JSON or credentials from old rows. */
export function listMemoryEvidence(store: SqliteMemoryStore, nodeId: number): ListMemoryEvidenceResult {
  const rows = store.getRawDb().query(`SELECT evidence_json, created_at FROM memory_source_events
    WHERE node_id = ? ORDER BY created_at, rowid`).all(nodeId) as Array<{ evidence_json: string; created_at: string }>;
  const records: MemoryEvidenceRecord[] = [];
  const omitted: EvidenceOmitted = { malformed: 0, unsafe: 0 };
  for (const row of rows) {
    let parsed: z.output<typeof recordedEvidenceSchema>;
    try {
      parsed = recordedEvidenceSchema.parse(JSON.parse(row.evidence_json));
    } catch {
      omitted.malformed += 1;
      continue;
    }
    try {
      const { producer, ...evidence } = parsed;
      records.push({ ...guardedEvidence(evidence), producer: producer === null ? null : applyWriteGuard(producer), createdAt: row.created_at });
    } catch (e) {
      if (e instanceof SecretDetectedError) { omitted.unsafe += 1; continue; }
      omitted.malformed += 1;
    }
  }
  return { records, omitted };
}

function replayResult(id: number, title: string): SaveTextInputResult {
  return {
    kind: "memory", originNodeId: id, nodeIds: [id], chunkNodeIds: [], title,
    extracted: [], bumped: [], immediateExtractionRan: false, entities: [], warnings: [], cacheHit: true,
  };
}

/**
 * Evidence-aware save (MCP store_memory and save_*, REST writes with evidence).
 *
 * WP-B1-08: when the input takes the immediate-extraction branch, the LLM call runs outside
 * the write lock. Outside: validate, skip the LLM for a resend of the same source event,
 * otherwise prepareImmediateExtraction. Inside: validate and check resends again, then
 * saveTextInput(preparedExtraction); a resend or content absorption found there discards
 * the prepared result. Other inputs join the lock queue without awaiting anything first, so
 * call order stays lock order.
 *
 * WP-B1-08R (Minor 1): skipping preparation outside the lock because this looked like a
 * resend is a bet that the lock-side recheck will still call it a resend. If the original
 * memory is deleted while this call waits for the lock (its memory_source_events row goes
 * with it, ON DELETE CASCADE), the recheck no longer finds a resend, and there is no
 * prepared result to fall back on. saveSharedMemoryInputLocked is told that preparation
 * was skipped as a resend bet, so it can refuse instead of calling the LLM inside the lock.
 */
export async function saveSharedMemoryInput(
  store: SqliteMemoryStore,
  args: SaveTextInputArgs,
  evidenceInput?: MemoryEvidenceInput,
): Promise<SaveTextInputResult> {
  return withMemoryWriteActivity(store, () => prepareAndSaveSharedMemoryInput(store, args, evidenceInput));
}

async function prepareAndSaveSharedMemoryInput(
  store: SqliteMemoryStore,
  args: SaveTextInputArgs,
  evidenceInput?: MemoryEvidenceInput,
): Promise<SaveTextInputResult> {
  if (immediateExtractionArgs(args) === null) {
    return withMemoryMutationLock(store, () => saveSharedMemoryInputLocked(store, args, evidenceInput, undefined, false));
  }
  const checked = await checkSharedMemoryInput(store, args, evidenceInput);
  const resent = checked.eventKey !== null && findResentOrigin(store, checked.eventKey, checked) !== null;
  const prepared = resent ? undefined : await prepareImmediateExtraction(store, writeArgs(args, checked));
  return withMemoryMutationLock(store, () => saveSharedMemoryInputLocked(store, args, evidenceInput, prepared, resent));
}

interface CheckedSharedMemoryInput {
  /** Content after the write guard. */
  content: string;
  /** Client metadata without the trusted state it may not set. */
  metadata: Record<string, unknown>;
  evidence: ReturnType<typeof guardedEvidence>;
  projectId: string | null;
  /** Resend key; null without a sourceEventId. */
  eventKey: string | null;
}

/**
 * Input checks, run before preparing (outside the lock) and again before writing (inside),
 * because an evidence memory can be withdrawn in between. Reads only.
 */
async function checkSharedMemoryInput(
  store: SqliteMemoryStore,
  args: SaveTextInputArgs,
  evidenceInput: MemoryEvidenceInput | undefined,
): Promise<CheckedSharedMemoryInput> {
  // Even replay requests must pass the credential guard. Trusted state never travels in
  // free-form metadata: REST routes reject server-owned keys with 400 first; for MCP
  // store_memory a free sharedMemory is replaced by the state built below, and the
  // lineage keys (extracted, extractedTo) are rejected rather than dropped.
  const content = applyWriteGuard(args.content, args.writeGuard);
  const { sharedMemory: _replacedByTrustedState, ...metadata } = args.extraMetadata ?? {};
  const serverOwnedKey = findServerOwnedMetadataKey(metadata);
  if (serverOwnedKey !== undefined) {
    throw new MemoryEvidenceError(`metadata.${serverOwnedKey} is managed by the server`);
  }
  const evidence = guardedEvidence(evidenceInput, args.writeGuard);
  const projectId = normalizeProjectId(args.projectId);
  if (evidence.claimKey && !evidence.sourceEventId) {
    throw new MemoryEvidenceError("claimKey requires sourceEventId");
  }
  if (evidence.validFrom && evidence.validUntil && Date.parse(evidence.validFrom) >= Date.parse(evidence.validUntil)) {
    throw new MemoryEvidenceError("validUntil must be after validFrom");
  }
  const visible = evidence.evidenceRefs?.length ? readMemoryVisibility(store).allowedIds : undefined;
  for (const id of evidence.evidenceRefs ?? []) {
    const reference = await store.getNode(id);
    if (!reference || !isCurrentMemory(reference.metadata) || (visible !== undefined && !visible.has(id))) {
      throw new MemoryEvidenceError(`evidence memory ${id} is missing or inactive`);
    }
    if (reference.projectId !== null && reference.projectId !== projectId) {
      throw new MemoryEvidenceError(`evidence memory ${id} belongs to a different project`);
    }
  }
  if (evidenceInput && planEntityInput(content).mode !== "memory_text") {
    throw new MemoryEvidenceError("evidence requires memory text, not an entity-only update");
  }
  const eventKey = evidence.sourceEventId
    ? createHash("sha256")
      .update(JSON.stringify([projectId, evidence.sourceEventId, evidence.claimKey ?? ""]))
      .digest("hex")
    : null;
  return { content, metadata, evidence, projectId, eventKey };
}

/** The saveTextInput input: preparing and writing use the same content and project. */
function writeArgs(args: SaveTextInputArgs, checked: CheckedSharedMemoryInput): SaveTextInputArgs {
  return { ...args, content: checked.content, projectId: checked.projectId };
}

/**
 * The memory an earlier delivery of this source event already saved: a recorded event, or a
 * new origin whose event recording was interrupted (same sourceEventId and claimKey).
 */
function findResentOrigin(
  store: SqliteMemoryStore,
  eventKey: string,
  checked: CheckedSharedMemoryInput,
): { nodeId: number; recorded: boolean } | null {
  const db = store.getRawDb();
  const recorded = db.query("SELECT node_id FROM memory_source_events WHERE event_key = ?")
    .get(eventKey) as { node_id: number } | null;
  if (recorded) return { nodeId: recorded.node_id, recorded: true };
  const recovered = db.query(`SELECT id AS node_id FROM knowledge_nodes
    WHERE source_type = 'auto_capture' AND project_id IS ? AND json_extract(metadata_json, '$.sharedMemory.sourceEventId') = ?
    AND COALESCE(json_extract(metadata_json, '$.sharedMemory.claimKey'), '') = ? ORDER BY id LIMIT 1`)
    .get(checked.projectId, checked.evidence.sourceEventId ?? null, checked.evidence.claimKey ?? "") as { node_id: number } | null;
  return recovered ? { nodeId: recovered.node_id, recorded: false } : null;
}

async function saveSharedMemoryInputLocked(
  store: SqliteMemoryStore,
  args: SaveTextInputArgs,
  evidenceInput: MemoryEvidenceInput | undefined,
  prepared: PreparedImmediateExtraction | undefined,
  /**
   * WP-B1-08R (Minor 1): preparation outside the lock was skipped because the input looked
   * like a resend at that time. If the recheck below no longer finds a resend, that bet was
   * wrong and there is no prepared result — the immediate-extraction branch must not call
   * the LLM inside the lock as a silent fallback, so it refuses with 409/CONFLICT instead.
   */
  skippedPreparationAsResend: boolean,
): Promise<SaveTextInputResult> {
  const checked = await checkSharedMemoryInput(store, args, evidenceInput);
  const { content, metadata, evidence, projectId } = checked;
  const state = { ...readSharedMemory({}), ...evidence, status: "active" as const, revision: 0 };
  const write = () => saveTextInput(store, {
    ...writeArgs(args, checked),
    extraMetadata: metadata,
    sharedMemory: state,
    ...(prepared !== undefined ? { preparedExtraction: prepared } : {}),
  });
  if (checked.eventKey === null) return write();
  const key = checked.eventKey;

  const db = store.getRawDb();
  const resent = findResentOrigin(store, key, checked);
  if (resent === null && skippedPreparationAsResend && prepared === undefined
    && immediateExtractionArgs(writeArgs(args, checked)) !== null) {
    throw new PreparedExtractionMismatchError(
      "준비 없이 재전송으로 판정해 건너뛴 즉시 추출이 저장 시점에는 재전송이 아니게 되었습니다" +
        "(원래 기억이 잠금을 기다리는 사이 지워짐). 쓰기 잠금 안에서는 LLM 을 부르지 않습니다.",
    );
  }
  if (resent?.recorded) {
    const node = await store.getNode(resent.nodeId);
    if (!node) throw new MemoryEvidenceError("source event points to a missing memory");
    return replayResult(node.id, String(node.metadata.title ?? ""));
  }
  // A new origin already contains its complete original evidence. Recover that
  // evidence and producer after interruption, not the retry's possibly different claims.
  if (resent) {
    const node = (await store.getNode(resent.nodeId))!;
    const originalState = readSharedMemory(node.metadata);
    const originalEvidence = Object.fromEntries(Object.keys(memoryEvidenceSchema.shape)
      .map((field) => [field, originalState[field as keyof typeof originalState]]));
    const original = guardedEvidence(originalEvidence, args.writeGuard);
    db.query("INSERT INTO memory_source_events(event_key,node_id,evidence_json,created_at) VALUES (?,?,?,?)")
      .run(key, node.id, JSON.stringify({ ...original, producer: node.author ?? null }), nowKst());
    return replayResult(node.id, String(node.metadata.title ?? ""));
  }

  const evidenceJson = JSON.stringify({ ...evidence, producer: args.author ?? null });
  // Preserve the repository's existing content/project absorption semantics. An
  // absorbed origin cannot carry a second event in its single sharedMemory object,
  // so event recording and its one reinforcement must be one synchronous commit.
  const existingId = store.nodeRepo.findNodeIdByContentHashSync(content, projectId);
  if (existingId !== null) {
    const node = (await store.getNode(existingId))!;
    // WP-B1-20T design 3.3, 5.1: this save's source row (MCP: save:mcp:<actor>) holds the absorbing
    // node alongside the event row, the same source a new origin would get from saveTextInput. The
    // event row is evidence and the resend key; the source row decides survival.
    const source = inputSourceOf({ ...writeArgs(args, checked), extraMetadata: metadata });
    db.transaction(() => {
      db.query("INSERT INTO memory_source_events(event_key,node_id,evidence_json,created_at) VALUES (?,?,?,?)")
        .run(key, node.id, evidenceJson, nowKst());
      if (isCurrentMemory(node.metadata)) {
        store.nodeRepo.absorbInputSync(node.id, { kind: "source", source });
      } else {
        // A withdrawn memory is not revived (no reinforcement), but it keeps the source row, so
        // this save holds it when its original source is deleted later.
        store.nodeRepo.recordSourceSync(node.id, source);
      }
    })();
    // Historical memories stay withdrawn even when a new event repeats their text.
    return replayResult(node.id, String(node.metadata.title ?? ""));
  }
  const result = await write();
  if (result.originNodeId === null) throw new MemoryEvidenceError("source event did not create a memory");
  db.query("INSERT INTO memory_source_events(event_key,node_id,evidence_json,created_at) VALUES (?,?,?,?)")
    .run(key, result.originNodeId, evidenceJson, nowKst());
  return result;
}
