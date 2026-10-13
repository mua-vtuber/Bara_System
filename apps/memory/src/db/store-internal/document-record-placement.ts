/**
 * store-internal/document-record-placement.ts — 문서 기록(documents 행)이 그래프의 어느 노드에 놓였는지 판정.
 *
 * 기준은 주인 표(document_record_owners, 설계 17.18 D32)와 주인 노드·주인 기록이다. 판정은 넷 + 하나:
 *   - own: 자기 문서 노드(metadata.documentId 가 이 기록)가 살아 있다.
 *   - trashed: 자기 문서 노드가 휴지통에 있다.
 *   - absorbed: 같은 내용으로 다른 노드에 합쳐졌다 — 그 노드의 결과를 함께 쓰는 정상 상태.
 *       - 글자가 없는 기록(OCR_INCOMPLETE_PARSE_STATUSES — 글자 인식 대기·파싱 실패·글자 인식 실패·암호): 주인이 문서
 *         노드이고 그 문서의 원본 sha 가 이 기록의 원본 sha 와 같을 때만 — 같은 파일을 같은 이름으로 다시 올린 경우다.
 *       - 그 밖(글자가 있는 기록, 또는 parse 상태가 없는 옛 기록 — 2026-07-01 이전 저장분): 본문이 같은 노드에 합쳐짐
 *         (의도된 중복 제거, 설계 §2.1). 상태가 없는 기록은 recordStatus=null 로 두어 문구가 아는 것만 말하게 한다.
 *   - legacy_merged: 글자가 없는 기록인데 위 조건이 안 맞는다. 옛 버전이 대기 본문을 파일 이름 한 줄로 채워, 이름만
 *     같은 다른 파일이나 같은 글의 기억에 잘못 합쳐 둔 기록이다. 이 기록 자신의 내용은 읽힌 적이 없고 결과를 붙일
 *     노드도 없다 — 같은 파일을 다시 올리면 지금 대기 본문(이름 + 상태 + sha 세 줄)이 옛 본문과 달라 따로 저장된다.
 *   - missing: 주인 행이 없거나 주인 노드가 두 표 어디에도 없다(저장 진행 중이거나 시작 정리가 다룰 끊긴 기록).
 *
 * 노드 번호는 살아 있는 표·휴지통 표에서 같다. 조회는 모두 기본 키 조회다(읽기 전용).
 */

import type { Database } from "bun:sqlite";
import {
  OCR_INCOMPLETE_PARSE_STATUSES,
  isDocumentParseStatus,
  type DocumentParseStatus,
} from "../../memory/document-parse-status.ts";

export type DocumentRecordPlacement =
  | { kind: "own"; nodeId: number }
  | { kind: "trashed"; nodeId: number }
  | {
      kind: "absorbed";
      ownerNodeId: number;
      /** 주인 노드가 문서 노드면 그 노드의 기록 id, 평범한 기억이면 null. */
      ownerDocumentId: string | null;
      /** 주인 기록의 parse 상태 — 함께 쓸 결과가 있는지 정직하게 알리는 데 쓴다. 주인이 기억이거나 기록이 없으면 null. */
      ownerParseStatus: DocumentParseStatus | null;
      /** 이 기록 자신의 parse 상태. 상태 칸이 없는 옛 기록이면 null(그때 문구는 결과를 함께 쓴다고도, 읽힌 적 없다고도 하지 않는다). */
      recordStatus: DocumentParseStatus | null;
      ownerInTrash: boolean;
    }
  | { kind: "legacy_merged"; ownerNodeId: number; ownerDocumentId: string | null; ownerInTrash: boolean }
  | { kind: "missing" };

/** 자기 노드가 아닌 곳에 놓인 기록 — OCR 결과를 붙일 수 없다. */
export type NotOwnedPlacement = Extract<DocumentRecordPlacement, { kind: "absorbed" | "legacy_merged" }>;

/** 글자가 없는 상태 — 이 상태의 기록만 "같은 파일인지" 를 원본 sha 로 따진다. 단일 출처 document-parse-status.ts. */
const TEXTLESS_STATUSES: ReadonlySet<DocumentParseStatus> = new Set(OCR_INCOMPLETE_PARSE_STATUSES);

/**
 * 주인 노드가 이 기록 자신의 문서 노드가 아닌 기록을 빼는 조건(absorbed·legacy_merged 둘 다). 바깥 질의의 documents
 * 별칭이 `documents` 여야 한다. 두 경우 모두 결과를 붙일 자기 노드가 없어 OCR 후보가 될 수 없다.
 */
function ownedSql(nodeTable: "knowledge_nodes" | "knowledge_nodes_archive"): string {
  return `NOT EXISTS (
            SELECT 1 FROM document_record_owners o
              JOIN ${nodeTable} n ON n.id = o.node_id
             WHERE o.document_id = documents.document_id
               AND (n.source_type <> 'document' OR (n.metadata_json ->> '$.documentId') IS NOT documents.document_id))`;
}
export const NOT_MERGED_ELSEWHERE_SQL = `${ownedSql("knowledge_nodes")}
            AND ${ownedSql("knowledge_nodes_archive")}`;

interface RecordFacts {
  status: DocumentParseStatus | null;
  originalSha256: string | null;
}

function recordFacts(db: Database, documentId: string): RecordFacts | null {
  const row = db
    .query(
      `SELECT source_metadata ->> '$.parse.status' AS status,
              COALESCE(source_metadata ->> '$.parse.originalAssetSha256', asset_sha256) AS original
         FROM documents WHERE document_id = ?`,
    )
    .get(documentId) as { status: unknown; original: unknown } | null;
  if (row === null) return null;
  return {
    status: isDocumentParseStatus(row.status) ? row.status : null,
    originalSha256: typeof row.original === "string" ? row.original : null,
  };
}

/** 기록이 놓인 곳 — 모듈 주석 참조. */
export function getDocumentRecordPlacementSync(db: Database, documentId: string): DocumentRecordPlacement {
  const owner = db
    .query("SELECT node_id FROM document_record_owners WHERE document_id = ?")
    .get(documentId) as { node_id: number } | null;
  if (owner === null) return { kind: "missing" };
  for (const table of ["knowledge_nodes", "knowledge_nodes_archive"] as const) {
    const node = db
      .query(`SELECT source_type, metadata_json ->> '$.documentId' AS document_id FROM ${table} WHERE id = ?`)
      .get(owner.node_id) as { source_type: string; document_id: unknown } | null;
    if (node === null) continue;
    const inTrash = table === "knowledge_nodes_archive";
    const ownerDocumentId =
      node.source_type === "document" && typeof node.document_id === "string" ? node.document_id : null;
    if (ownerDocumentId === documentId) {
      return inTrash ? { kind: "trashed", nodeId: owner.node_id } : { kind: "own", nodeId: owner.node_id };
    }
    const self = recordFacts(db, documentId);
    const ownerRecord = ownerDocumentId !== null ? recordFacts(db, ownerDocumentId) : null;
    const recordStatus = self?.status ?? null;
    const textless = recordStatus !== null && TEXTLESS_STATUSES.has(recordStatus);
    const sameFile =
      ownerRecord !== null &&
      self?.originalSha256 != null &&
      ownerRecord.originalSha256 === self.originalSha256;
    if (!textless || sameFile) {
      return {
        kind: "absorbed",
        ownerNodeId: owner.node_id,
        ownerDocumentId,
        ownerParseStatus: ownerRecord?.status ?? null,
        recordStatus,
        ownerInTrash: inTrash,
      };
    }
    return { kind: "legacy_merged", ownerNodeId: owner.node_id, ownerDocumentId, ownerInTrash: inTrash };
  }
  return { kind: "missing" };
}

/** 후보 목록에서 빠진(자기 노드가 아닌 곳에 놓인) 기록 수 — 같은 파일로 합쳐짐 / 옛 버전의 잘못된 합침으로 나눈다. */
export function countNotOwnedRecordsSync(
  db: Database,
  statuses: readonly DocumentParseStatus[],
): { absorbed: number; legacyMerged: number } {
  const counts = { absorbed: 0, legacyMerged: 0 };
  if (statuses.length === 0) return counts;
  const placeholders = statuses.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT document_id FROM documents
        WHERE source_metadata ->> '$.parse.status' IN (${placeholders})
          AND NOT (${NOT_MERGED_ELSEWHERE_SQL})`,
    )
    .all(...statuses) as Array<{ document_id: string }>;
  for (const row of rows) {
    const placement = getDocumentRecordPlacementSync(db, row.document_id);
    if (placement.kind === "absorbed") counts.absorbed += 1;
    else if (placement.kind === "legacy_merged") counts.legacyMerged += 1;
  }
  return counts;
}
