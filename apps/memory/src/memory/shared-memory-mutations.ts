import { createHash } from "node:crypto";
import type { SqliteMemoryStore } from "../db/store.ts";
import type { KnowledgeNodeRow } from "../db/store-internal/row-types.ts";
import { nowKst, rowToNode } from "../db/store-internal/helpers.ts";
import type { MemoryNode } from "./types.ts";
import { readSharedMemory, isCurrentMemory, sharedMemorySchema } from "./shared-memory-contract.ts";
import { SharedMemoryMutationError } from "./shared-memory-mutation-error.ts";
import { invalidateSharedMemoryDerivatives } from "./shared-memory-invalidation.ts";
import { toNfc } from "./nfc.ts";
import { withMemoryMutationLock } from "./shared-memory-mutation-lock.ts";
import { readMemoryVisibility } from "./shared-memory-read.ts";
import { listOpenConflicts } from "./open-conflicts.ts";

export { SharedMemoryMutationError } from "./shared-memory-mutation-error.ts";
export type { SharedMemoryMutationErrorCode } from "./shared-memory-mutation-error.ts";

export interface SharedMemoryMutationArgs {
  nodeId: number;
  expectedRevision: number;
  requestId: string;
  actor: string;
  reason?: string;
}
export interface UpdateSharedMemoryArgs extends SharedMemoryMutationArgs { content: string }
export interface SupersedeSharedMemoryArgs extends SharedMemoryMutationArgs { replacementId: number }
export interface SharedMemoryMutationResult {
  node: MemoryNode;
  revision: number;
  affectedNodeIds: number[];
  replayed: boolean;
  /**
   * WP-B1-10(B1-08R Minor 2) — supersede 로 채택된 기억에 아직 해소되지 않은 충돌 상대가
   * 남아 있으면 그 id 목록. 예: N 이 A·B 둘과 contradicts 로 이어져 있을 때
   * supersede_memory(A -> N) 로 N 을 채택해도 N-B 관계는 여전히 열려 있다 — 호출자(AI)가
   * 이 칸으로 남은 확인이 있음을 사용자에게 전할 수 있다. supersede 가 아니거나 남은 충돌이
   * 없으면 빈 배열.
   */
  openConflicts: number[];
}
type Operation = "update" | "retract" | "supersede";
type MutationInput = SharedMemoryMutationArgs & { content?: string; replacementId?: number };

function validate(args: MutationInput, operation: Operation): void {
  if (!Number.isSafeInteger(args.nodeId) || args.nodeId <= 0 ||
      !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0 ||
      typeof args.requestId !== "string" || !args.requestId.trim() || args.requestId.length > 200 ||
      typeof args.actor !== "string" || !args.actor.trim() || args.actor.length > 200 ||
      (args.reason !== undefined && typeof args.reason !== "string")) {
    throw new SharedMemoryMutationError("INVALID_INPUT", "nodeId, expectedRevision, requestId and actor are required");
  }
  if (operation === "update" && (typeof args.content !== "string" || !args.content.trim())) {
    throw new SharedMemoryMutationError("INVALID_INPUT", "content must be a non-empty string", args.nodeId);
  }
  if (operation === "supersede" && (!Number.isSafeInteger(args.replacementId) || args.replacementId! <= 0 || args.replacementId === args.nodeId)) {
    throw new SharedMemoryMutationError("INVALID_INPUT", "replacementId must identify another memory", args.nodeId);
  }
}

function readNode(store: SqliteMemoryStore, id: number): MemoryNode {
  const row = store.db.query("SELECT * FROM knowledge_nodes WHERE id = ?").get(id) as KnowledgeNodeRow | null;
  if (!row) throw new SharedMemoryMutationError("NOT_FOUND", `memory ${id} not found`, id);
  return rowToNode(row);
}

function replay(
  store: SqliteMemoryStore, args: MutationInput, hash: string, operation: Operation,
): SharedMemoryMutationResult | null {
  const row = store.db.query("SELECT actor, payload_hash, result_json FROM memory_mutations WHERE request_id = ?")
    .get(args.requestId) as { actor: string; payload_hash: string; result_json: string } | null;
  if (!row) return null;
  if (row.actor !== args.actor || row.payload_hash !== hash) {
    throw new SharedMemoryMutationError("CONFLICT", "requestId was already used for another mutation", args.nodeId);
  }
  const saved = JSON.parse(row.result_json) as SharedMemoryMutationResult;
  // openConflicts 는 "지금" 남은 열린 충돌이라 저장된 값을 그대로 재생하면 거짓이 될 수 있다
  // (재생 뒤 다른 mutation 이 또 다른 상대를 새로 열거나 닫았을 수 있다). supersede 재생이면
  // 채택된 기억(args.replacementId)의 현재 상태를 다시 계산한다 — 이 트랜잭션(또는 그 밖)의
  // 최신 DB 상태를 그대로 읽으므로 저장 시점 값보다 정직하다. supersede 가 아니면 애초에
  // 이 칸이 항상 빈 배열이었다(mutate 참고).
  const openConflicts = operation === "supersede"
    ? listOpenConflicts(store.db, [args.replacementId!]).get(args.replacementId!) ?? []
    : [];
  return { ...saved, openConflicts, replayed: true };
}

/**
 * 충돌 후보 채택(SL-3). 대체 기억이 disputed 이면, 충돌 검사가 이 대상과의 충돌로 표시한
 * 후보(대체 기억 -> 대상 contradicts 엣지)일 때만 active 로 되돌리고(revision+1) true 를
 * 돌려준다 — 사용자가 확인한 충돌을 supersede 한 번으로 해소한다. 다른 이유로 disputed 인
 * 기억(다른 기억과의 충돌 후보, 형식이 깨진 sharedMemory)은 대체 기억이 될 수 없다.
 * disputed 가 아니면 아무것도 하지 않는다. 호출자의 변경 트랜잭션 안에서 부른다.
 */
function adoptDisputedReplacement(store: SqliteMemoryStore, nodeId: number, replacementId: number): boolean {
  const replacement = readNode(store, replacementId);
  const state = readSharedMemory(replacement.metadata);
  if (state.status !== "disputed") return false;
  const linked = store.db.query(`SELECT 1 FROM knowledge_edges
    WHERE source_id = ? AND target_id = ? AND relation = 'contradicts' LIMIT 1`).get(replacementId, nodeId);
  if (!linked || !sharedMemorySchema.safeParse(replacement.metadata.sharedMemory).success) {
    throw new SharedMemoryMutationError("INVALID_INPUT",
      `disputed replacement ${replacementId} is not a conflict candidate of memory ${nodeId}; ` +
        "only a disputed memory linked to it by a contradicts edge can replace it", nodeId);
  }
  store.db.query("UPDATE knowledge_nodes SET metadata_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify({ ...replacement.metadata, sharedMemory: { ...state, status: "active", revision: state.revision + 1 } }),
      nowKst(), replacementId);
  return true;
}

function validateReplacement(store: SqliteMemoryStore, node: MemoryNode, replacementId: number): void {
  const replacement = readNode(store, replacementId);
  const visibleIds = readMemoryVisibility(store).allowedIds;
  if (visibleIds && !visibleIds.has(node.id)) {
    throw new SharedMemoryMutationError("INVALID_INPUT", "only a current memory can be replaced", node.id);
  }
  if (node.projectId !== replacement.projectId || (visibleIds && !visibleIds.has(replacementId))) {
    throw new SharedMemoryMutationError("INVALID_INPUT", "replacement must be current and in the same project", node.id);
  }
  // Edges point replacement -> old. Adding replacementId -> node.id must not
  // close an existing path node.id -> replacementId, including legacy edges.
  const cycle = store.db.query(`WITH RECURSIVE descendants(id) AS (
    SELECT target_id FROM knowledge_edges WHERE source_id = ? AND relation = 'supersedes'
    UNION SELECT e.target_id FROM knowledge_edges e JOIN descendants d ON e.source_id = d.id WHERE e.relation = 'supersedes'
  ) SELECT 1 FROM descendants WHERE id = ? LIMIT 1`).get(node.id, replacementId);
  if (cycle) throw new SharedMemoryMutationError("INVALID_INPUT", "replacement would create a cycle", node.id);
}

async function mutate(store: SqliteMemoryStore, input: MutationInput, operation: Operation): Promise<SharedMemoryMutationResult> {
  validate(input, operation);
  const args = { ...input, ...(operation === "update" ? { content: toNfc(input.content!) } : {}) };
  const hash = createHash("sha256").update(JSON.stringify({
    operation, nodeId: args.nodeId, expectedRevision: args.expectedRevision,
    actor: args.actor, content: args.content ?? null, replacementId: args.replacementId ?? null,
    reason: args.reason ?? null,
  })).digest("hex");
  const saved = replay(store, args, hash, operation);
  if (saved) return saved;
  // Reject missing nodes before embedding, but re-read and CAS after it. There
  // are no awaits between the authoritative read and ledger commit below.
  readNode(store, args.nodeId);
  const vector = operation === "update" ? await store.embedder.embed(args.content!) : undefined;
  const result = store.db.transaction((): SharedMemoryMutationResult => {
    const retried = replay(store, args, hash, operation);
    if (retried) return retried;
    const old = readNode(store, args.nodeId);
    const state = readSharedMemory(old.metadata);
    if (state.revision !== args.expectedRevision) {
      throw new SharedMemoryMutationError("CONFLICT", "memory changed since it was read", args.nodeId, state.revision);
    }
    if (state.status === "superseded") {
      throw new SharedMemoryMutationError("INVALID_INPUT", "superseded memory is historical; change its replacement instead", args.nodeId);
    }
    let adoptedReplacement = false;
    if (operation === "supersede") {
      if (!isCurrentMemory(old.metadata)) throw new SharedMemoryMutationError("INVALID_INPUT", "only a current memory can be replaced", args.nodeId);
      // 채택한 충돌 후보는 active 가 된 뒤 아래 가시성·같은 프로젝트 검사를 똑같이 받는다.
      // 검사에 걸리면 트랜잭션이 채택까지 되돌린다.
      adoptedReplacement = adoptDisputedReplacement(store, old.id, args.replacementId!);
      validateReplacement(store, old, args.replacementId!);
    }
    let node = old;
    let affectedNodeIds: number[] | undefined;
    if (operation === "update") {
      if (node.sourceType === "document" || node.sourceType === "image_asset") {
        throw new SharedMemoryMutationError("INVALID_INPUT", "edit derived text instead of an asset node", node.id);
      }
      const edited = store.nodeRepo.editNodeContentPrepared({
        nodeId: args.nodeId, content: args.content!, expectedRevision: args.expectedRevision,
        editor: args.actor, editSource: "shared_memory", reason: args.reason,
      }, vector!)!;
      node = edited.node;
      affectedNodeIds = edited.affectedNodeIds;
    }
    const nextState = {
      ...state, revision: state.revision + 1,
      status: operation === "retract" ? "retracted" : operation === "supersede" ? "superseded" : "active",
    };
    // The client's own decision replaces a lineage invalidation record (invalidatedBy and its revision row).
    delete nextState.invalidatedBy;
    delete nextState.invalidatedByRevision;
    delete nextState.supersededBy;
    if (operation === "supersede") nextState.supersededBy = args.replacementId;
    store.db.query("UPDATE knowledge_nodes SET metadata_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify({ ...node.metadata, sharedMemory: nextState }), nowKst(), node.id);
    if (operation === "supersede") {
      store.db.query(`INSERT OR IGNORE INTO knowledge_edges
        (source_id, target_id, relation, provenance, source_node_id, weight, created_at)
        VALUES (?, ?, 'supersedes', 'user_input', ?, 1, ?)`)
        .run(args.replacementId!, node.id, args.replacementId!, nowKst());
    }
    // An update's revision row is written by editNodeContentPrepared, which also invalidated its derivatives.
    let revisionId: number | undefined;
    if (operation !== "update") {
      const revisionRow = store.db.query(`INSERT INTO memory_revisions
        (old_node_id, new_node_id, revision_type, reason, old_content, new_content, editor, edit_source, created_at)
        VALUES (?, ?, 'manual', ?, ?, ?, ?, 'shared_memory', ?)
        RETURNING id`)
        .get(node.id, args.replacementId ?? node.id, args.reason ?? operation, old.content,
          operation === "supersede" ? readNode(store, args.replacementId!).content : old.content, args.actor, nowKst()) as { id: number };
      revisionId = revisionRow.id;
    }
    // WP-B1-20U 설계 17.7 — 철회한 파생에 이 철회·대체의 이력 행 id 를 적는다(update 는 위 편집이 적었다).
    affectedNodeIds ??= [node.id, ...invalidateSharedMemoryDerivatives(store.db, old, revisionId)];
    if (adoptedReplacement) affectedNodeIds.push(args.replacementId!);
    if (operation === "supersede" && readMemoryVisibility(store).allowedIds?.has(args.replacementId!) === false) {
      throw new SharedMemoryMutationError("INVALID_INPUT", "replacement depends on the source being replaced", node.id);
    }
    // WP-B1-10(B1-08R Minor 2) — 채택된 대체 기억(args.replacementId)이 다른 옛 기억과도
    // contradicts 로 남아 있으면 그 id 를 회신에 실어 호출자가 사용자에게 남은 확인을
    // 알릴 수 있게 한다. 이 트랜잭션 안의 최신 쓰기(위 UPDATE 들)를 그대로 본다.
    const openConflicts = operation === "supersede"
      ? listOpenConflicts(store.db, [args.replacementId!]).get(args.replacementId!) ?? []
      : [];
    const committed: SharedMemoryMutationResult = {
      node: readNode(store, node.id), revision: nextState.revision, affectedNodeIds, replayed: false,
      openConflicts,
    };
    store.db.query(`INSERT INTO memory_mutations (request_id, node_id, actor, payload_hash, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(args.requestId, node.id, args.actor, hash, JSON.stringify(committed), nowKst());
    return committed;
  })();
  if (!result.replayed) {
    store.nodeRepo.bumpDbRevision();
    store.nodeRepo.autoCleanupTrigger?.emit("node-edited");
  }
  return result;
}

export function updateSharedMemory(store: SqliteMemoryStore, args: UpdateSharedMemoryArgs): Promise<SharedMemoryMutationResult> {
  return withMemoryMutationLock(store, () => mutate(store, args, "update"));
}
export function retractSharedMemory(store: SqliteMemoryStore, args: SharedMemoryMutationArgs): Promise<SharedMemoryMutationResult> {
  return withMemoryMutationLock(store, () => mutate(store, args, "retract"));
}
export function supersedeSharedMemory(store: SqliteMemoryStore, args: SupersedeSharedMemoryArgs): Promise<SharedMemoryMutationResult> {
  return withMemoryMutationLock(store, () => mutate(store, args, "supersede"));
}
