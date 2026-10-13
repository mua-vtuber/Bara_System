/**
 * entity-register/candidate-query.ts — 이 단계 후보 메모 고르기(spec 3장 2번).
 * 대상은 사용자가 쓴 원본 메모만이다(파생·조각·정규식 조각·#일정: 노드·빈 본문·철회된 기억 제외).
 * 지문은 메모 본문 + 작성일. 결과 원장으로 이미 처리했거나 처리 불가로 확정된 메모를 거른다.
 * 원장 거름이 SQL 밖(지문 계산)이라, 앞쪽이 모두 처리된 경우에도 상한을 채우도록 id 순으로 쪽 단위로 훑는다.
 */
import type { Database } from "bun:sqlite";
import { entityRegisterFingerprint } from "../stage-fingerprint.ts";
import { filterCandidatesByLedger } from "../stage-results-ledger.ts";
import { AUTO_CAPTURE_SOURCE_TYPE, isCurrentMemory, isDerivedShaped } from "../../shared-memory-contract.ts";
import { ENTITY_REGISTER_LEDGER_STAGE, ENTITY_REGISTER_LIMITS, SCHEDULE_OCCURRENCE_KEY } from "./constants.ts";
import type { EntityRegisterMemo } from "./types.ts";

export interface EntityRegisterCandidateRow extends EntityRegisterMemo {
  targetKey: string;
  inputFingerprint: string;
  stageVersion: number;
}

interface RawMemo { id: number; content: string; created_at: string; source_type: string; metadata_json: string }

function parseMetadata(raw: string, id: number): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw === "" ? "{}" : raw);
  } catch {
    throw new Error(`entity-register 후보: knowledge_nodes.id=${id} metadata_json 을 읽을 수 없음`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`entity-register 후보: knowledge_nodes.id=${id} metadata_json 이 객체가 아님`);
  }
  return value as Record<string, unknown>;
}

function isOriginalMemo(row: RawMemo): boolean {
  if (row.content.trim().length === 0) return false;
  const metadata = parseMetadata(row.metadata_json, row.id);
  if (isDerivedShaped(row.source_type, metadata)) return false;
  if (metadata[SCHEDULE_OCCURRENCE_KEY] === true) return false;
  return isCurrentMemory(metadata);
}

export function readOriginalMemo(db: Database, nodeId: number): { nodeId: number; content: string; createdAt: string } | null {
  const row = db
    .query("SELECT id, content, created_at, source_type, metadata_json FROM knowledge_nodes WHERE id = ? AND source_type = ?")
    .get(nodeId, AUTO_CAPTURE_SOURCE_TYPE) as RawMemo | null;
  if (!row || !isOriginalMemo(row)) return null;
  return { nodeId: row.id, content: row.content, createdAt: row.created_at };
}

export function listAlreadyLinkedNames(db: Database, nodeId: number): string[] {
  const rows = db
    .query(
      `SELECT p.display_name AS name FROM node_person_edges e JOIN persons p ON p.person_id = e.person_id
        WHERE e.node_id = ?1 AND e.relation = 'mentions'
       UNION
       SELECT c.name FROM node_concept_edges e JOIN concept_nodes c ON c.concept_id = e.concept_id
        WHERE e.node_id = ?1 AND e.role IN ('tag', 'classification')
       UNION
       SELECT en.name FROM node_concept_edges e
         JOIN entity_concept_edges ec ON ec.concept_id = e.concept_id AND ec.role = 'identity'
         JOIN entities en ON en.entity_id = ec.entity_id
        WHERE e.node_id = ?1`,
    )
    .all(nodeId) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function toCandidate(row: RawMemo, stageVersion: number): EntityRegisterCandidateRow {
  return {
    nodeId: row.id,
    content: row.content,
    createdAt: row.created_at,
    alreadyLinked: [],
    targetKey: String(row.id),
    inputFingerprint: entityRegisterFingerprint({ content: row.content, createdAt: row.created_at }),
    stageVersion,
  };
}

export function collectEntityRegisterCandidates(args: {
  db: Database;
  stageVersion: number;
  limit: number;
  nodeIds?: readonly number[];
  now?: string;
}): EntityRegisterCandidateRow[] {
  const { db, stageVersion, limit } = args;
  const select = "SELECT id, content, created_at, source_type, metadata_json FROM knowledge_nodes";
  const pick = (rows: RawMemo[]) =>
    filterCandidatesByLedger(db, ENTITY_REGISTER_LEDGER_STAGE, rows.filter(isOriginalMemo).map((r) => toCandidate(r, stageVersion)), args.now);

  let picked: EntityRegisterCandidateRow[];
  if (args.nodeIds !== undefined) {
    if (args.nodeIds.length === 0) return [];
    const marks = args.nodeIds.map(() => "?").join(",");
    const rows = db
      .query(`${select} WHERE source_type = ? AND id IN (${marks}) ORDER BY id`)
      .all(AUTO_CAPTURE_SOURCE_TYPE, ...args.nodeIds) as RawMemo[];
    picked = pick(rows).slice(0, limit);
  } else {
    picked = [];
    let afterId = 0;
    const page = ENTITY_REGISTER_LIMITS.candidateScanPageSize;
    while (picked.length < limit) {
      const rows = db
        .query(`${select} WHERE source_type = ? AND id > ? ORDER BY id LIMIT ?`)
        .all(AUTO_CAPTURE_SOURCE_TYPE, afterId, page) as RawMemo[];
      if (rows.length === 0) break;
      afterId = rows[rows.length - 1]!.id;
      picked.push(...pick(rows));
    }
    picked = picked.slice(0, limit);
  }
  return picked.map((row) => ({ ...row, alreadyLinked: listAlreadyLinkedNames(db, row.nodeId) }));
}
