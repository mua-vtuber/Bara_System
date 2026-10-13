/**
 * entity-register/records-repository.ts — 자동 등록 기록(entity_register_records)·무시 기록
 * (entity_register_ignores) 접근. raw db 핸들 위 직접 SQL(stage-results-ledger.ts 관례).
 *
 * detail_json 은 되돌리기가 그대로 믿고 쓰는 값이라, 읽을 때 일곱 칸의 모양을 모두 검사하고 어긋나면
 * 행 id·칸 이름을 담은 오류로 멈춘다(빈 값으로 채워 넘기지 않는다). 메서드 입력도 DB 에 닿기 전에 검사한다.
 */
import type { Database } from "bun:sqlite";
import { nowKst } from "../../../db/store-internal/helpers.ts";
import { ENTITY_REGISTER_LEDGER_STAGE } from "./constants.ts";
import type { ActiveSchedule, RecordDecidedBy, RecordItemKind } from "./types.ts";

export type RecordedEdge =
  | { table: "node_person_edges"; nodeId: number; personId: string; relation: "mentions" }
  | { table: "node_concept_edges"; nodeId: number; conceptId: string; role: "mention" }
  | { table: "entity_concept_edges"; entityId: string; conceptId: string; role: "identity" };

export interface EntityRegisterRecordDetail {
  edges: RecordedEdge[];
  createdRow: { typeName: string; id: string } | null;
  aliasAdded: { typeName: string; id: string; alias: string } | null;
  scheduleNodeId: number | null;
  date: string | null;
  deletedRowSnapshot: Record<string, unknown> | null;
  keptRowReason: string | null;
}

export interface NewEntityRegisterRecord {
  runId: string | null;
  proposalId: string | null;
  sourceNodeId: number;
  itemKind: RecordItemKind;
  targetType: string;
  targetId: string;
  name: string;
  decidedBy: RecordDecidedBy;
  detail: EntityRegisterRecordDetail;
}

export interface EntityRegisterRecord extends NewEntityRegisterRecord {
  id: number;
  stage: string;
  status: "active" | "reverted";
  createdAt: string;
  revertedAt: string | null;
}

export type IgnoreKind = "entity" | "schedule";
/** 일정 무시는 이름이 없어 빈 키 하나로 둔다. */
export const SCHEDULE_IGNORE_NAME_KEY = "";

export function emptyRecordDetail(): EntityRegisterRecordDetail {
  return { edges: [], createdRow: null, aliasAdded: null, scheduleNodeId: null, date: null, deletedRowSnapshot: null, keptRowReason: null };
}

interface RawRecord {
  id: number; stage: string; run_id: string | null; proposal_id: string | null; source_node_id: number;
  item_kind: string; target_type: string; target_id: string; name: string; decided_by: string;
  status: string; detail_json: string; created_at: string; reverted_at: string | null;
}

/** 일정 기록의 target_id 는 일정 노드 id 를 담은 양의 정수 글자다. */
const INTEGER_ID_PATTERN = /^[1-9][0-9]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isString = (v: unknown): v is string => typeof v === "string";
const isInteger = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function isRecordedEdge(value: unknown): value is RecordedEdge {
  if (!isPlainObject(value)) return false;
  switch (value.table) {
    case "node_person_edges":
      return isInteger(value.nodeId) && isString(value.personId) && value.relation === "mentions";
    case "node_concept_edges":
      return isInteger(value.nodeId) && isString(value.conceptId) && value.role === "mention";
    case "entity_concept_edges":
      return isString(value.entityId) && isString(value.conceptId) && value.role === "identity";
    default:
      return false;
  }
}

/** 칸이 있고 null 이거나 검사를 통과해야 한다 — 칸이 빠진 것은 null 과 다르게 형식 오류다. */
function nullableField(obj: Record<string, unknown>, key: string, check: (v: unknown) => boolean): boolean {
  return Object.hasOwn(obj, key) && (obj[key] === null || check(obj[key]));
}

function parseDetail(raw: string, id: number): EntityRegisterRecordDetail {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw new Error(`entity_register_records.id=${id} detail_json 을 읽을 수 없음: ${e instanceof Error ? e.message : String(e)}`);
  }
  const fail = (field: string): never => {
    throw new Error(`entity_register_records.id=${id} detail_json 형식 오류: ${field}`);
  };
  if (!isPlainObject(value)) return fail("root");
  if (!Array.isArray(value.edges)) return fail("edges");
  value.edges.forEach((edge, i) => {
    if (!isRecordedEdge(edge)) fail(`edges[${i}]`);
  });
  if (!nullableField(value, "createdRow", (v) => isPlainObject(v) && isString(v.typeName) && isString(v.id))) fail("createdRow");
  if (!nullableField(value, "aliasAdded", (v) => isPlainObject(v) && isString(v.typeName) && isString(v.id) && isString(v.alias))) {
    fail("aliasAdded");
  }
  if (!nullableField(value, "scheduleNodeId", isInteger)) fail("scheduleNodeId");
  if (!nullableField(value, "date", isString)) fail("date");
  if (!nullableField(value, "deletedRowSnapshot", isPlainObject)) fail("deletedRowSnapshot");
  if (!nullableField(value, "keptRowReason", isString)) fail("keptRowReason");
  return {
    edges: value.edges as RecordedEdge[],
    createdRow: value.createdRow as EntityRegisterRecordDetail["createdRow"],
    aliasAdded: value.aliasAdded as EntityRegisterRecordDetail["aliasAdded"],
    scheduleNodeId: value.scheduleNodeId as number | null,
    date: value.date as string | null,
    deletedRowSnapshot: value.deletedRowSnapshot as Record<string, unknown> | null,
    keptRowReason: value.keptRowReason as string | null,
  };
}

function toRecord(r: RawRecord): EntityRegisterRecord {
  return {
    id: r.id, stage: r.stage, runId: r.run_id, proposalId: r.proposal_id, sourceNodeId: r.source_node_id,
    itemKind: r.item_kind as RecordItemKind, targetType: r.target_type, targetId: r.target_id, name: r.name,
    decidedBy: r.decided_by as RecordDecidedBy, status: r.status as "active" | "reverted",
    detail: parseDetail(r.detail_json, r.id), createdAt: r.created_at, revertedAt: r.reverted_at,
  };
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`entity_register: ${field} 는 양의 정수여야 함 (받은 값: ${value})`);
}

function requireNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`entity_register: ${field} 는 0 이상의 정수여야 함 (받은 값: ${value})`);
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`entity_register: ${field} 가 비어 있음`);
}

export class EntityRegisterRecordsRepository {
  constructor(private readonly db: Database) {}

  insert(record: NewEntityRegisterRecord): number {
    requirePositiveInteger(record.sourceNodeId, "sourceNodeId");
    requireNonEmpty(record.targetId, "targetId");
    requireNonEmpty(record.name, "name");
    this.db
      .query(
        `INSERT INTO entity_register_records
           (stage, run_id, proposal_id, source_node_id, item_kind, target_type, target_id, name, decided_by, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ENTITY_REGISTER_LEDGER_STAGE, record.runId, record.proposalId, record.sourceNodeId, record.itemKind,
        record.targetType, record.targetId, record.name, record.decidedBy, JSON.stringify(record.detail), nowKst(),
      );
    return (this.db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  }

  get(id: number): EntityRegisterRecord | null {
    const row = this.db.query("SELECT * FROM entity_register_records WHERE id = ?").get(id) as RawRecord | null;
    return row ? toRecord(row) : null;
  }

  listActive(opts: { decidedBy: RecordDecidedBy; limit: number; offset: number }): {
    records: Array<EntityRegisterRecord & { memoContent: string | null }>;
    total: number;
  } {
    requirePositiveInteger(opts.limit, "limit");
    requireNonNegativeInteger(opts.offset, "offset");
    const rows = this.db
      .query(
        `SELECT r.*, kn.content AS memo_content FROM entity_register_records r
           LEFT JOIN knowledge_nodes kn ON kn.id = r.source_node_id
          WHERE r.status = 'active' AND r.decided_by = ?
          ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
      )
      .all(opts.decidedBy, opts.limit, opts.offset) as Array<RawRecord & { memo_content: string | null }>;
    const total = (this.db
      .query("SELECT COUNT(*) AS n FROM entity_register_records WHERE status = 'active' AND decided_by = ?")
      .get(opts.decidedBy) as { n: number }).n;
    return { records: rows.map((r) => ({ ...toRecord(r), memoContent: r.memo_content })), total };
  }

  listActiveForMemo(sourceNodeId: number): EntityRegisterRecord[] {
    requirePositiveInteger(sourceNodeId, "sourceNodeId");
    return (this.db
      .query("SELECT * FROM entity_register_records WHERE source_node_id = ? AND status = 'active' ORDER BY id")
      .all(sourceNodeId) as RawRecord[]).map(toRecord);
  }

  activeScheduleForMemo(sourceNodeId: number): (ActiveSchedule & { recordId: number }) | null {
    requirePositiveInteger(sourceNodeId, "sourceNodeId");
    // CAST 는 "12abc" 를 12 로 읽어 엉뚱한 노드에 붙으므로, 조인 전에 target_id 모양을 먼저 본다.
    const scheduleRows = this.db
      .query(
        `SELECT id, target_id FROM entity_register_records
          WHERE source_node_id = ? AND item_kind = 'schedule_created' AND status = 'active'`,
      )
      .all(sourceNodeId) as Array<{ id: number; target_id: string }>;
    for (const r of scheduleRows) {
      if (!INTEGER_ID_PATTERN.test(r.target_id)) {
        throw new Error(`entity_register_records.id=${r.id} 일정 기록의 target_id 가 노드 id(양의 정수)가 아님: ${JSON.stringify(r.target_id)}`);
      }
    }
    const row = this.db
      .query(
        `SELECT r.id AS record_id, kn.id AS node_id, kn.event_at AS event_at, kn.content AS content
           FROM entity_register_records r JOIN knowledge_nodes kn ON kn.id = CAST(r.target_id AS INTEGER)
          WHERE r.source_node_id = ? AND r.item_kind = 'schedule_created' AND r.status = 'active'
            AND kn.event_at IS NOT NULL
          ORDER BY r.id DESC LIMIT 1`,
      )
      .get(sourceNodeId) as { record_id: number; node_id: number; event_at: string; content: string } | null;
    if (!row) return null;
    return { recordId: row.record_id, nodeId: row.node_id, date: row.event_at.slice(0, 10), title: row.content };
  }

  markReverted(id: number, detail: EntityRegisterRecordDetail): boolean {
    const result = this.db
      .query("UPDATE entity_register_records SET status = 'reverted', reverted_at = ?, detail_json = ? WHERE id = ? AND status = 'active'")
      .run(nowKst(), JSON.stringify(detail), id);
    return result.changes > 0;
  }

  addIgnore(sourceNodeId: number, kind: IgnoreKind, nameKey: string, reason: "ignored" | "reverted"): void {
    requirePositiveInteger(sourceNodeId, "sourceNodeId");
    this.db
      .query(
        `INSERT INTO entity_register_ignores (source_node_id, kind, name_key, reason, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_node_id, kind, name_key) DO UPDATE SET reason = excluded.reason`,
      )
      .run(sourceNodeId, kind, nameKey, reason, nowKst());
  }

  ignoredNameKeys(sourceNodeId: number): Set<string> {
    requirePositiveInteger(sourceNodeId, "sourceNodeId");
    const rows = this.db
      .query("SELECT name_key FROM entity_register_ignores WHERE source_node_id = ? AND kind = 'entity'")
      .all(sourceNodeId) as Array<{ name_key: string }>;
    return new Set(rows.map((r) => r.name_key));
  }

  isScheduleIgnored(sourceNodeId: number): boolean {
    requirePositiveInteger(sourceNodeId, "sourceNodeId");
    return this.db
      .query("SELECT 1 FROM entity_register_ignores WHERE source_node_id = ? AND kind = 'schedule' LIMIT 1")
      .get(sourceNodeId) !== null;
  }
}
