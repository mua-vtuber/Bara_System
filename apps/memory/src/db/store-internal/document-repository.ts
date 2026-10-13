/**
 * store-internal/document-repository.ts — documents CRUD + chunk_count 유지.
 *
 * 한 자산(sha256)에 문서 메타를 붙인다. document_id 는 'doc_' + uuid.
 * created_at / updated_at 은 1.2 T13(spec 10.1)에서 다른 코어 테이블과 같은 TEXT
 * datetime(nowKst 'YYYY-MM-DD HH:MM:SS')으로 통일했다. asset_files FK 검증은
 * SQLite 제약이 담당.
 *
 * Phase 14a T5 / spec 단락 2.
 */

import type { Database } from "bun:sqlite";
import type { DocumentParseStatus } from "../../memory/document-parse-status.ts";
import { nowKst } from "./helpers.ts";
import { activeSql, claimAwaitsExtractionSql } from "./extraction-state-sql.ts";
import {
  NOT_MERGED_ELSEWHERE_SQL,
  countNotOwnedRecordsSync,
  getDocumentRecordPlacementSync,
  type DocumentRecordPlacement,
} from "./document-record-placement.ts";

export type { DocumentRecordPlacement, NotOwnedPlacement } from "./document-record-placement.ts";

export interface DocumentRow {
  documentId: string;
  assetSha256: string;
  title: string;
  documentType: string;
  chunkCount: number;
  hasSummary: number;
  hasExtracted: number;
  sourceMetadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentOcrCandidateRow extends DocumentRow {
  parseStatus: DocumentParseStatus;
}

export type DocumentListOrder = "newest" | "oldest";

/** 문서 추출 진행 집계 — /api/documents/:id/status 응답의 extraction 칸 형태 그대로. */
export interface DocumentExtractionProgress {
  totalChunks: number;
  completedChunks: number;
}

type DocumentSqlRow = {
  document_id: string;
  asset_sha256: string;
  title: string;
  document_type: string;
  chunk_count: number;
  has_summary: number;
  has_extracted: number;
  source_metadata: string;
  created_at: string;
  updated_at: string;
};

export class DocumentRepository {
  constructor(private readonly db: Database) {}

  private newDocumentId(): string {
    return `doc_${crypto.randomUUID()}`;
  }

  /**
   * 문서 메타 row 를 생성한다. document_id = 'doc_' + uuid 로 반환.
   * created_at / updated_at = nowKst()(TEXT datetime). chunk_count = 0 시작.
   * sourceMetadata 미지정 시 {} 저장. 실패는 SQLite 구체 에러로 전파.
   */
  createDocument(args: {
    assetSha256: string;
    title: string;
    documentType: string;
    sourceMetadata?: Record<string, unknown>;
  }): string {
    const docId = this.newDocumentId();
    const now = nowKst();
    const metaJson = JSON.stringify(args.sourceMetadata ?? {});
    this.db
      .query(
        `INSERT INTO documents
           (document_id, asset_sha256, title, document_type,
            chunk_count, has_summary, has_extracted,
            source_metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?)`,
      )
      .run(docId, args.assetSha256, args.title, args.documentType, metaJson, now, now);
    return docId;
  }

  /**
   * chunk_count 를 갱신하고 updated_at 을 현재 시각으로 올린다.
   * document_id 가 없으면 SQLite 는 조용히 0 rows 를 갱신한다 — 호출자가
   * 존재 여부를 먼저 검증해야 한다(silent fallback 은 이 계층의 책임이 아님).
   */
  setChunkCount(documentId: string, count: number): void {
    this.db
      .query(
        `UPDATE documents SET chunk_count = ?, updated_at = ? WHERE document_id = ?`,
      )
      .run(count, nowKst(), documentId);
  }

  /**
   * document_id 로 문서 메타를 반환한다. 없으면 null.
   * source_metadata 는 JSON.parse 해 객체로 반환한다.
   * 테이블 접근 실패는 SQLite 구체 에러로 전파(silent fallback 금지).
   */
  getDocument(documentId: string): DocumentRow | null {
    const row = this.db
      .query("SELECT * FROM documents WHERE document_id = ?")
      .get(documentId) as DocumentSqlRow | null;

    if (!row) return null;

    return this.rowToDocument(row);
  }

  /**
   * OCR/파싱 대기 상태인 문서를 최신순으로 반환한다. 상태 권위는
   * documents.source_metadata.parse.status 이며, JSON1 로 먼저 좁혀 과한 row scan 을 피한다.
   * 자기 노드가 아닌 곳에 놓인 기록(placement absorbed·legacy_merged)은 뺀다 — 글자 인식 결과를 붙일 자기 문서 노드가
   * 없다. 같은 파일로 합쳐진 기록은 주인 기록이 결과를 받고, 옛 버전이 잘못 합친 기록은 다시 올려야 따로 저장된다.
   * 빼지 않으면 서버 OCR·컴패니언 후보 목록에 영원히 남는다. 뺀 건수는 countNotOwnedRecordsByParseStatuses 가 센다.
   * 쪽 넘김(offset)·정렬은 그대로라 서버 OCR 후보 조회가 쪽 단위로 끝까지 볼 수 있다.
   */
  listDocumentsByParseStatuses(
    statuses: readonly DocumentParseStatus[],
    limit: number = 100,
    order: DocumentListOrder = "newest",
    /** 앞에서 건너뛸 행 수 — 서버 OCR 후보 조회가 대상 아닌 문서에 막히지 않게 쪽 단위로 넘겨 본다. */
    offset: number = 0,
  ): DocumentOcrCandidateRow[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    const orderBy =
      order === "oldest"
        ? "updated_at ASC, created_at ASC"
        : "updated_at DESC, created_at DESC";
    const rows = this.db
      .prepare(
        `SELECT *
           FROM documents
          WHERE source_metadata ->> '$.parse.status' IN (${placeholders})
            AND ${NOT_MERGED_ELSEWHERE_SQL}
          ORDER BY ${orderBy}, document_id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...statuses, limit, offset) as DocumentSqlRow[];

    return rows.map((row) => {
      const doc = this.rowToDocument(row);
      const parseStatus = doc.sourceMetadata.parse as { status: DocumentParseStatus };
      return { ...doc, parseStatus: parseStatus.status };
    });
  }

  /** 후보 목록이 빼는 기록 수 — 같은 파일로 합쳐짐 / 옛 버전의 잘못된 합침(document-record-placement.ts). */
  countNotOwnedRecordsByParseStatuses(statuses: readonly DocumentParseStatus[]): { absorbed: number; legacyMerged: number } {
    return countNotOwnedRecordsSync(this.db, statuses);
  }

  /** 기록이 놓인 곳(document-record-placement.ts). 읽기 전용. */
  getDocumentRecordPlacement(documentId: string): DocumentRecordPlacement {
    return getDocumentRecordPlacementSync(this.db, documentId);
  }

  /**
   * document_id 를 metadata 로 가진 원본 document 노드 id 를 찾는다.
   * OCR 적용은 같은 문서 노드를 갱신해야 하므로, 없으면 호출자가 409/500 으로 처리한다.
   */
  findDocumentNodeId(documentId: string): number | null {
    const row = this.db
      .query(
        `SELECT id
           FROM knowledge_nodes
          WHERE source_type = 'document'
            AND metadata_json ->> '$.documentId' = ?
          ORDER BY id ASC
          LIMIT 1`,
      )
      .get(documentId) as { id: number } | null;
    return row?.id ?? null;
  }

  /**
   * 문서의 추출 진행 집계 — WP-B1-24. `totalChunks` = active 청크 수, `completedChunks` =
   * 그중 현재 본문 주장을 이미 추출한 수(claimAwaitsExtractionSql 이 false 인 청크). 편집으로
   * 철회된(lineage-invalidated) 청크는 active 가 아니라 두 집계 모두에서 빠진다 — 백필 후보
   * 판정(getBackfillCandidates)과 같은 SQL 조각을 써서 "완료"의 뜻을 한 곳에서 정한다.
   * 읽기 전용(SELECT 뿐, total_changes() 불변).
   */
  getDocumentExtractionProgress(documentId: string): DocumentExtractionProgress {
    const alias = "chunk";
    const row = this.db
      .query(
        `SELECT
            COALESCE(SUM(CASE WHEN ${activeSql(alias)} THEN 1 ELSE 0 END), 0) AS totalChunks,
            COALESCE(SUM(CASE WHEN ${activeSql(alias)} AND NOT ${claimAwaitsExtractionSql(alias)}
              THEN 1 ELSE 0 END), 0) AS completedChunks
           FROM knowledge_nodes ${alias}
          WHERE ${alias}.source_type = 'document_chunk'
            AND ${alias}.metadata_json ->> '$.parentId' = ?`,
      )
      .get(documentId) as { totalChunks: number; completedChunks: number };
    return row;
  }

  /** 해당 문서의 기존 document_chunk 노드 id 를 chunkIndex 순서로 반환한다. */
  listDocumentChunkNodeIds(documentId: string): number[] {
    const rows = this.db
      .query(
        `SELECT id
           FROM knowledge_nodes
          WHERE source_type = 'document_chunk'
            AND metadata_json ->> '$.parentId' = ?
          ORDER BY CAST(metadata_json ->> '$.chunkIndex' AS INTEGER) ASC, id ASC`,
      )
      .all(documentId) as { id: number }[];
    return rows.map((row) => row.id);
  }

  /**
   * OCR 결과 적용 뒤 documents row 의 canonical 자산과 metadata/cache 칸을 갱신한다.
   * downstream 산출물이 없는 문서에만 호출자가 진입하므로 has_summary/has_extracted 는
   * 새 canonical 기준으로 0 에 맞춘다.
   */
  updateDocumentAfterOcr(args: {
    documentId: string;
    assetSha256: string;
    chunkCount: number;
    sourceMetadata: Record<string, unknown>;
  }): boolean {
    const result = this.db
      .query(
        `UPDATE documents
            SET asset_sha256 = ?,
                chunk_count = ?,
                has_summary = 0,
                has_extracted = 0,
                source_metadata = ?,
                updated_at = ?
          WHERE document_id = ?`,
      )
      .run(
        args.assetSha256,
        args.chunkCount,
        JSON.stringify(args.sourceMetadata),
        nowKst(),
        args.documentId,
      ) as { changes: number };
    return result.changes > 0;
  }

  /** 문서 source_metadata 만 갱신한다. 상태/lease/failure metadata 변경에 사용한다. */
  updateDocumentSourceMetadata(args: {
    documentId: string;
    sourceMetadata: Record<string, unknown>;
  }): boolean {
    const result = this.db
      .query(
        `UPDATE documents
            SET source_metadata = ?,
                updated_at = ?
          WHERE document_id = ?`,
      )
      .run(JSON.stringify(args.sourceMetadata), nowKst(), args.documentId) as {
      changes: number;
    };
    return result.changes > 0;
  }

  /**
   * source_metadata 가 호출자가 읽은 값과 같을 때만 갱신한다.
   * OCR job claim 경합에서 같은 후보를 두 worker 가 동시에 잡는 일을 줄인다.
   */
  updateDocumentSourceMetadataIfCurrent(args: {
    documentId: string;
    currentSourceMetadata: Record<string, unknown>;
    nextSourceMetadata: Record<string, unknown>;
  }): boolean {
    const result = this.db
      .query(
        `UPDATE documents
            SET source_metadata = ?,
                updated_at = ?
          WHERE document_id = ?
            AND source_metadata = ?`,
      )
      .run(
        JSON.stringify(args.nextSourceMetadata),
        nowKst(),
        args.documentId,
        JSON.stringify(args.currentSourceMetadata),
      ) as { changes: number };
    return result.changes > 0;
  }

  /**
   * 문서 기록(documents 행)을 지운다 — 그 기록의 주인 노드가 영구 삭제될 때만 부른다(WP-B1-20U 설계 17.17 D28,
   * asset-release.ts). 반환: 그 기록이 가리키던 sha(asset_sha256·parse.originalAssetSha256·parse.canonicalAssetSha256,
   * 중복 제거). 행이 없으면 null. 요약·발굴 산출은 외래 키 ON DELETE CASCADE 로 함께 지워진다.
   */
  deleteDocumentSync(documentId: string): string[] | null {
    const row = this.db
      .query("DELETE FROM documents WHERE document_id = ? RETURNING asset_sha256, source_metadata")
      .get(documentId) as { asset_sha256: string; source_metadata: string } | null;
    if (!row) return null;
    const parse = (JSON.parse(row.source_metadata) as { parse?: Record<string, unknown> }).parse ?? {};
    const shas = [row.asset_sha256, parse.originalAssetSha256, parse.canonicalAssetSha256]
      .filter((sha): sha is string => typeof sha === "string" && sha.length > 0);
    return [...new Set(shas)];
  }

  private rowToDocument(row: DocumentSqlRow): DocumentRow {
    return {
      documentId: row.document_id,
      assetSha256: row.asset_sha256,
      title: row.title,
      documentType: row.document_type,
      chunkCount: row.chunk_count,
      hasSummary: row.has_summary,
      hasExtracted: row.has_extracted,
      sourceMetadata: JSON.parse(row.source_metadata) as Record<string, unknown>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
