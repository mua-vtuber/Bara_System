/**
 * entity-register/revert.ts — 자동 등록 되돌리기(spec 7.3, 확인 필요 1번 사용자 결정).
 *
 * 한 기록을 되돌리면 쓰기 잠금 + 한 트랜잭션 안에서 차례로:
 *   1. 항목 기록이면 기록에 적힌 메모 연결(이 회차가 만든 엣지)만 지운다. 그 사이 사용자가 붙인 다른 연결은 다른 행이라 남는다.
 *   2. 일정 기록이면 일정 노드를 휴지통으로 보낸다(selected_only). 일정 노드의 연결은 먼저 지우지 않고 휴지통 이동에 맡긴다
 *      (노드 행이 지워질 때 ON DELETE CASCADE 로 함께 사라진다 — 휴지통은 노드만 보관하고 연결은 보관하지 않는다).
 *   3. 이 회차가 만든 사람·항목 행은 남은 연결·사실이 하나도 없을 때만 지운다. 사람·항목 행에는 휴지통이 없어서,
 *      지우기 전 행 내용(항목은 entity_attributes 행 포함)을 기록의 deletedRowSnapshot 에 남긴다. 남은 것이 있으면
 *      행은 두고 keptRowReason 에 이유를 적는다.
 *      - 같은 메모의 다른 살아 있는 자동 등록 기록이 적어 둔 연결(예: 같은 회차의 일정 노드 → 사람)은 세지 않는다.
 *        그 연결은 그 기록을 되돌릴 때 함께 사라지므로, 세면 어느 순서로 되돌려도 행이 영영 남는다.
 *   4. identity 엣지(항목 행 → identity 개념)는 다른 메모가 그 개념을 아직 가리키면 남긴다 — 사용자가 붙인
 *      메모 연결이 항목에 닿는 길이 그 엣지이기 때문이다. 행을 지울 때는 함께 지운다.
 *   5. 행을 남기면 이 회차가 그 행에 더한 별칭(detail.aliasAdded)만 뺀다. 원래 있던 별칭은 그대로다.
 *   6. 기록을 reverted 로 바꾸고 (메모, 이름) 무시 기록(reason=reverted)을 남겨 같은 이름이 다시 자동 등록되지 않게 한다.
 *
 * 메모 날짜 기록(memo_date_filled)은 위 갈래 대신 revertMemoDate 로 메모 날짜만 다룬다(이 회차가 채운 값 그대로일 때만 지움).
 *
 * 원본 메모가 영구 삭제된 기록도 되돌릴 수 있다 — 메모 연결은 메모와 함께 이미 사라졌고(지울 연결 0개),
 * 만든 행은 같은 규칙으로 처리한다. 무시 기록 표는 메모 FK 가 없어 그대로 남는다(v48).
 */
import type { Database } from "bun:sqlite";
import type { SqliteMemoryStore } from "../../../db/store.ts";
import { EN_ALIASES_ATTR_KEY, KO_ALIASES_ATTR_KEY } from "../../../db/store-internal/entities-repository.ts";
import { toNfc } from "../../nfc.ts";
import { withMemoryMutationLock } from "../../shared-memory-mutation-lock.ts";
import { runImmediateTransactionAsync } from "./apply-transaction.ts";
import { readMemoEventAt } from "./candidate-query.ts";
import { nameKey } from "./name-match.ts";
import {
  MEMO_DATE_IGNORE_NAME_KEY, SCHEDULE_IGNORE_NAME_KEY, type EntityRegisterRecord, type EntityRegisterRecordDetail, type EntityRegisterRecordsRepository, type RecordedEdge,
} from "./records-repository.ts";

const PERSON_TYPE = "person";
const ERROR_PREFIX = "entity-register 되돌리기";
/** 이 단계가 만드는 항목 행은 이 칸들을 모두 NULL 로 둔다(entities-repository insertEntity) — 값이 있으면 사용자가 채운 사실이다. */
const ENTITY_FACT_COLUMNS = ["ko_name", "medium", "created_by", "external_refs"] as const;

/** 되돌리기 거부 — 기록 없음(404) 또는 이미 되돌림(409). 라우트가 status 를 그대로 응답 코드로 쓴다. */
export class EntityRegisterRevertError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(`${ERROR_PREFIX}: ${message}`);
    this.name = "EntityRegisterRevertError";
  }
}

export interface RevertResult {
  recordId: number;
  /** 실제로 사라진 연결 수(메모·일정 연결 + identity 엣지). 메모와 함께 이미 사라진 연결은 세지 않는다. */
  removedEdges: number;
  deletedRow: { typeName: string; id: string } | null;
  keptRowReason: string | null;
  /** 남긴 행에서 뺀, 이 회차가 더한 별칭. 뺄 것이 없었거나 행을 지웠으면 null. */
  removedAlias: string | null;
  trashedScheduleNodeId: number | null;
  /** 메모 날짜 기록을 되돌려 지운 날짜. 지우지 않았거나(그 사이 바뀜·메모 없음) 메모 날짜 기록이 아니면 null. */
  clearedMemoDate: string | null;
}

/**
 * 메모 날짜 기록 되돌리기(2026-10-16 yearless-date-cleanup spec 3.8). 메모 날짜가 이 기록이 채운 값 그대로(날짜 부분 같음 +
 * 출처 inferred)일 때만 지운다. 사용자가 고쳤거나(direct) 다른 경로가 그 사이 썼으면 지우지 않고 keptRowReason 칸에
 * 이유를 적는다(칸 이름은 "행을 남긴 이유"지만 옛 기록 읽기를 깨지 않으려 이 칸을 함께 쓴다). 메모가 영구 삭제됐으면 지울 것이 없다.
 */
async function revertMemoDate(
  store: SqliteMemoryStore, record: EntityRegisterRecord, detail: EntityRegisterRecordDetail,
): Promise<{ cleared: string | null; keptReason: string | null }> {
  const date = record.detail.date;
  if (date === null) throw new Error(`${ERROR_PREFIX}: 메모 날짜 기록 ${record.id} 에 날짜(detail.date)가 없음`);
  const current = readMemoEventAt(store.getRawDb(), record.sourceNodeId);
  if (!current.found) return { cleared: null, keptReason: null };
  if (current.eventAt !== null && current.eventAt.slice(0, 10) === date && current.source === "inferred") {
    if (!(await store.clearEventAt(record.sourceNodeId, "inferred"))) {
      throw new Error(`${ERROR_PREFIX}: 메모 ${record.sourceNodeId} 의 날짜 ${date} 를 지우지 못함`);
    }
    return { cleared: date, keptReason: null };
  }
  const keptReason = `메모 날짜가 그 사이 바뀌어 지우지 않음(출처 ${current.source ?? "기록 없음"}, 값 ${current.eventAt ?? "없음"})`;
  detail.keptRowReason = keptReason;
  return { cleared: null, keptReason };
}

type IdentityEdge = Extract<RecordedEdge, { table: "entity_concept_edges" }>;
type NodeEdge = Exclude<RecordedEdge, IdentityEdge>;

function edgeKey(e: RecordedEdge): string {
  switch (e.table) {
    case "node_person_edges":
      return `${e.table}\u001f${e.nodeId}\u001f${e.personId}\u001f${e.relation}`;
    case "node_concept_edges":
      return `${e.table}\u001f${e.nodeId}\u001f${e.conceptId}\u001f${e.role}`;
    case "entity_concept_edges":
      return `${e.table}\u001f${e.entityId}\u001f${e.conceptId}\u001f${e.role}`;
  }
}

function count(db: Database, sql: string, ...params: Array<string | number>): number {
  return (db.query(sql).get(...params) as { n: number }).n;
}

function nodeEdgeExists(db: Database, e: NodeEdge): boolean {
  if (e.table === "node_person_edges") {
    return db.query("SELECT 1 FROM node_person_edges WHERE node_id = ? AND person_id = ? AND relation = ?").get(e.nodeId, e.personId, e.relation) !== null;
  }
  return db.query("SELECT 1 FROM node_concept_edges WHERE node_id = ? AND concept_id = ? AND role = ?").get(e.nodeId, e.conceptId, e.role) !== null;
}

function deleteNodeEdge(db: Database, e: NodeEdge): number {
  if (e.table === "node_person_edges") {
    return db.query("DELETE FROM node_person_edges WHERE node_id = ? AND person_id = ? AND relation = ?").run(e.nodeId, e.personId, e.relation).changes;
  }
  return db.query("DELETE FROM node_concept_edges WHERE node_id = ? AND concept_id = ? AND role = ?").run(e.nodeId, e.conceptId, e.role).changes;
}

function deleteIdentityEdge(db: Database, e: IdentityEdge): number {
  return db.query("DELETE FROM entity_concept_edges WHERE entity_id = ? AND concept_id = ? AND role = ?").run(e.entityId, e.conceptId, e.role).changes;
}

/** 남은 연결을 셀 때 쓰는 문맥 — 같은 메모의 다른 살아 있는 기록이 적어 둔 연결 키. */
interface ReferenceScope { sameMemoKeys: ReadonlySet<string> }

/** 개념을 가리키는 메모 연결을 다른 메모 것과 같은 메모 다른 기록 것으로 나눠 센다. */
function conceptMentions(db: Database, conceptId: string, scope: ReferenceScope): { other: number; sameMemo: number } {
  const rows = db.query("SELECT node_id, role FROM node_concept_edges WHERE concept_id = ?").all(conceptId) as Array<{ node_id: number; role: string }>;
  let sameMemo = 0;
  for (const r of rows) {
    if (scope.sameMemoKeys.has(edgeKey({ table: "node_concept_edges", nodeId: r.node_id, conceptId, role: r.role as "mention" }))) sameMemo++;
  }
  return { other: rows.length - sameMemo, sameMemo };
}

interface References { reasons: string[]; sameMemoLinks: number }

function commonReferences(db: Database, typeName: string, id: string, reasons: string[]): void {
  const relation = count(db, "SELECT COUNT(*) AS n FROM entity_relation_edges WHERE (source_type = ?1 AND source_id = ?2) OR (target_type = ?1 AND target_id = ?2)", typeName, id);
  const hierarchy = count(db, "SELECT COUNT(*) AS n FROM hierarchy_edges WHERE (source_type = ?1 AND source_id = ?2) OR (target_type = ?1 AND target_id = ?2)", typeName, id);
  const summaries = count(db, "SELECT COUNT(*) AS n FROM relation_summaries WHERE from_concept_id = ?1 OR to_concept_id = ?1", id);
  if (relation > 0) reasons.push(`관계 연결 ${relation}개`);
  if (hierarchy > 0) reasons.push(`위계 연결 ${hierarchy}개`);
  if (summaries > 0) reasons.push(`관계 요약 ${summaries}개`);
}

function personReferences(db: Database, id: string, scope: ReferenceScope): References {
  const reasons: string[] = [];
  commonReferences(db, PERSON_TYPE, id, reasons);
  const memoRows = db.query("SELECT node_id, relation FROM node_person_edges WHERE person_id = ?").all(id) as Array<{ node_id: number; relation: string }>;
  const sameMemoLinks = memoRows.filter((r) =>
    scope.sameMemoKeys.has(edgeKey({ table: "node_person_edges", nodeId: r.node_id, personId: id, relation: r.relation as "mentions" })),
  ).length;
  const memos = memoRows.length - sameMemoLinks;
  const labels = count(db, "SELECT COUNT(*) AS n FROM concept_edges WHERE source_concept_id = ?1 OR target_concept_id = ?1", id);
  const facts = count(
    db,
    `SELECT COUNT(*) AS n FROM persons WHERE person_id = ? AND (birthday IS NOT NULL OR address IS NOT NULL OR gender IS NOT NULL
       OR attributes_json != '{}' OR (external_refs IS NOT NULL AND external_refs != '{}'))`,
    id,
  );
  if (memos > 0) reasons.push(`다른 메모 연결 ${memos}개`);
  if (labels > 0) reasons.push(`라벨 연결 ${labels}개`);
  if (facts > 0) reasons.push("사람 사실(생일·주소·성별·외부 계정·기타 칸)");
  return { reasons, sameMemoLinks };
}

/** ownIdentity = 이 기록이 만든 identity 엣지 — 행과 함께 지울 대상이라 남은 연결로 세지 않는다. */
function entityReferences(db: Database, typeName: string, id: string, ownIdentity: IdentityEdge[], scope: ReferenceScope): References {
  const reasons: string[] = [];
  commonReferences(db, typeName, id, reasons);
  const own = new Set(ownIdentity.map(edgeKey));
  const conceptEdges = (db.query("SELECT concept_id, role FROM entity_concept_edges WHERE entity_id = ?").all(id) as Array<{ concept_id: string; role: string }>)
    .map((e) => ({ conceptId: e.concept_id, role: e.role, key: edgeKey({ table: "entity_concept_edges", entityId: id, conceptId: e.concept_id, role: e.role as "identity" }) }));
  let sameMemoLinks = conceptEdges.filter((e) => scope.sameMemoKeys.has(e.key)).length;
  const otherConceptEdges = conceptEdges.filter((e) => !own.has(e.key) && !scope.sameMemoKeys.has(e.key)).length;
  let memos = 0;
  for (const conceptId of new Set(conceptEdges.filter((e) => e.role === "identity").map((e) => e.conceptId))) {
    const m = conceptMentions(db, conceptId, scope);
    memos += m.other;
    sameMemoLinks += m.sameMemo;
  }
  const attrs = count(db, "SELECT COUNT(*) AS n FROM entity_attributes WHERE entity_id = ? AND attr_key NOT IN (?, ?)", id, KO_ALIASES_ATTR_KEY, EN_ALIASES_ATTR_KEY);
  const row = db.query(`SELECT ${ENTITY_FACT_COLUMNS.join(", ")} FROM entities WHERE entity_id = ?`).get(id) as Record<string, string | null> | null;
  const filled = row ? ENTITY_FACT_COLUMNS.filter((c) => row[c] !== null && row[c] !== "{}") : [];
  if (memos > 0) reasons.push(`다른 메모 연결 ${memos}개`);
  if (otherConceptEdges > 0) reasons.push(`개념 연결 ${otherConceptEdges}개`);
  if (attrs > 0) reasons.push(`칸·라벨 ${attrs}개`);
  if (filled.length > 0) reasons.push(`항목 사실(${filled.join("·")})`);
  return { reasons, sameMemoLinks };
}

function nodeExists(db: Database, nodeId: number): boolean {
  return db.query("SELECT 1 FROM knowledge_nodes WHERE id = ?").get(nodeId) !== null;
}

/** 일정 노드를 휴지통으로 — 연결은 노드 행과 함께 사라지므로 미리 지우지 않고, 사라질 기록 연결 수만 센다. */
async function trashSchedule(store: SqliteMemoryStore, record: EntityRegisterRecord): Promise<{ nodeId: number | null; removedEdges: number }> {
  const db = store.getRawDb();
  const nodeId = record.detail.scheduleNodeId;
  if (nodeId === null) throw new Error(`${ERROR_PREFIX}: 일정 기록 ${record.id} 에 일정 노드 id 가 없음`);
  // 사용자가 이미 휴지통에 보냈거나 지운 일정이면 옮길 것이 없다 — 결과에 null 로 정직하게 남긴다.
  if (!nodeExists(db, nodeId)) return { nodeId: null, removedEdges: 0 };
  const removedEdges = record.detail.edges.filter((e): e is NodeEdge => e.table !== "entity_concept_edges" && nodeEdgeExists(db, e)).length;
  const trashed = await store.trashNodes([nodeId], "selected_only");
  if (!trashed.movedIds.includes(nodeId)) throw new Error(`${ERROR_PREFIX}: 일정 노드 ${nodeId} 를 휴지통으로 옮기지 못함`);
  return { nodeId, removedEdges };
}

function snapshotAndDeleteRow(db: Database, row: { typeName: string; id: string }): Record<string, unknown> {
  const isPerson = row.typeName === PERSON_TYPE;
  const [table, key] = isPerson ? ["persons", "person_id"] : ["entities", "entity_id"];
  const found = db.query(`SELECT * FROM ${table} WHERE ${key} = ?`).get(row.id) as Record<string, unknown> | null;
  if (!found) throw new Error(`${ERROR_PREFIX}: 지울 ${row.typeName} 행 ${row.id} 가 없음`);
  const snapshot = isPerson
    ? found
    : { ...found, entity_attributes: db.query("SELECT attr_key, attr_value, is_column FROM entity_attributes WHERE entity_id = ? ORDER BY attr_key").all(row.id) };
  db.query(`DELETE FROM ${table} WHERE ${key} = ?`).run(row.id);
  return snapshot;
}

/** 남긴 행에서 이 회차가 더한 별칭만 뺀다(NFC 비교). 행이 그 사이 사라졌으면 뺄 것이 없다(null). */
async function removeAddedAlias(store: SqliteMemoryStore, added: NonNullable<EntityRegisterRecordDetail["aliasAdded"]>): Promise<string | null> {
  const alias = toNfc(added.alias).trim();
  if (added.typeName === PERSON_TYPE) {
    const before = await store.getPerson(added.id);
    if (!before || !before.aliases.some((a) => toNfc(a).trim() === alias)) return null;
    await store.removePersonAlias(added.id, alias);
    return alias;
  }
  const entity = await store.entitiesRepo.get(added.id);
  if (!entity) return null;
  const kept = entity.koAliases.filter((a) => toNfc(a).trim() !== alias);
  if (kept.length === entity.koAliases.length) return null;
  store.entitiesRepo.setKoAliases(added.id, kept);
  return alias;
}

export async function revertEntityRegisterRecord(
  store: SqliteMemoryStore,
  records: EntityRegisterRecordsRepository,
  recordId: number,
): Promise<RevertResult> {
  const db = store.getRawDb();
  return withMemoryMutationLock(store, async () => {
    // 상태 확인도 잠금 안에서 — 두 요청이 같은 기록을 동시에 되돌리면 뒤의 요청은 여기서 409 를 받는다.
    const record = records.get(recordId);
    if (!record) throw new EntityRegisterRevertError(`자동 등록 기록 ${recordId} 없음`, 404);
    if (record.status !== "active") throw new EntityRegisterRevertError(`자동 등록 기록 ${recordId} 은(는) 이미 되돌림`, 409);
    const scope: ReferenceScope = {
      sameMemoKeys: new Set(records.listActiveForMemo(record.sourceNodeId).filter((r) => r.id !== record.id).flatMap((r) => r.detail.edges.map(edgeKey))),
    };

    return runImmediateTransactionAsync(db, async (): Promise<RevertResult> => {
      if (record.itemKind === "memo_date_filled") {
        const detail: EntityRegisterRecordDetail = { ...record.detail };
        const memoDate = await revertMemoDate(store, record, detail);
        if (!records.markReverted(recordId, detail)) throw new EntityRegisterRevertError(`자동 등록 기록 ${recordId} 은(는) 이미 되돌림`, 409);
        // 다음에 단계 버전이 올라 다시 처리돼도 같은 날짜를 다시 채우지 않게 한다.
        records.addIgnore(record.sourceNodeId, "memo_date", MEMO_DATE_IGNORE_NAME_KEY, "reverted");
        return {
          recordId, removedEdges: 0, deletedRow: null, keptRowReason: memoDate.keptReason, removedAlias: null,
          trashedScheduleNodeId: null, clearedMemoDate: memoDate.cleared,
        };
      }
      const identityEdges = record.detail.edges.filter((e): e is IdentityEdge => e.table === "entity_concept_edges");
      let removed = 0;
      let trashedScheduleNodeId: number | null = null;
      if (record.itemKind === "schedule_created") {
        const trashed = await trashSchedule(store, record);
        trashedScheduleNodeId = trashed.nodeId;
        removed += trashed.removedEdges;
      } else {
        for (const e of record.detail.edges) if (e.table !== "entity_concept_edges") removed += deleteNodeEdge(db, e);
      }

      const detail: EntityRegisterRecordDetail = { ...record.detail };
      let deletedRow: RevertResult["deletedRow"] = null;
      const row = record.detail.createdRow;
      const refs = row === null
        ? null
        : row.typeName === PERSON_TYPE ? personReferences(db, row.id, scope) : entityReferences(db, row.typeName, row.id, identityEdges, scope);
      if (row && refs && refs.reasons.length === 0) {
        for (const e of identityEdges) removed += deleteIdentityEdge(db, e);
        detail.deletedRowSnapshot = snapshotAndDeleteRow(db, row);
        deletedRow = row;
      } else {
        for (const e of identityEdges) {
          const m = conceptMentions(db, e.conceptId, scope);
          // 행을 남길 때는 같은 메모의 살아 있는 일정 노드도 이 identity 개념으로 항목에 닿으므로 그것까지 세어 엣지를 남긴다
          // (남긴 사람이 일정 연결을 그대로 갖는 것과 같은 규칙).
          const mentions = row ? m.other + m.sameMemo : m.other;
          if (mentions === 0) removed += deleteIdentityEdge(db, e);
        }
        if (refs) {
          const sameMemoNote = refs.sameMemoLinks > 0
            ? ` (같은 메모의 다른 자동 등록 연결 ${refs.sameMemoLinks}개는 그 기록을 되돌릴 때 함께 사라지므로 세지 않음)`
            : "";
          detail.keptRowReason = `다른 연결이 있어 행은 남김: ${refs.reasons.join(", ")}${sameMemoNote}`;
        }
      }
      const removedAlias = deletedRow === null && record.detail.aliasAdded !== null ? await removeAddedAlias(store, record.detail.aliasAdded) : null;

      if (!records.markReverted(recordId, detail)) throw new EntityRegisterRevertError(`자동 등록 기록 ${recordId} 은(는) 이미 되돌림`, 409);
      if (record.itemKind === "schedule_created") records.addIgnore(record.sourceNodeId, "schedule", SCHEDULE_IGNORE_NAME_KEY, "reverted");
      else records.addIgnore(record.sourceNodeId, "entity", nameKey(record.name), "reverted");
      return { recordId, removedEdges: removed, deletedRow, keptRowReason: detail.keptRowReason, removedAlias, trashedScheduleNodeId, clearedMemoDate: null };
    });
  });
}
