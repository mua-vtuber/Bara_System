/**
 * summary-repository.ts — 깊은 패스 둘째 단계 "요약" 저장소 (Phase 7 / Task 6).
 *
 * 권위 spec: docs/decisions/2026-06-05-phase7-summary-stage-spec.md 단락 4.2·7
 * 권위 plan: docs/decisions/2026-06-05-phase7-summary-stage-plan.md Task 6
 *
 * 책임: 청크요약(chunk_summaries) · 관계요약(relation_summaries) 행을 임베딩과 함께
 * 한 트랜잭션으로 저장한다. 한 insert = (1) 요약 행 INSERT → (2) last_insert_rowid() 로
 * summary_rowid 획득 → (3) embedder.embed(summary_text) Float32Array 를 vec0 에 직접
 * 바인딩(수동 직렬화 0 — node-repository.ts:128 패턴 정합) → (4) has_embedding=1 갱신.
 * 셋이 한 트랜잭션이라 vec INSERT 실패 시 요약 행도 롤백된다(고아 임베딩 0).
 *
 * vec0 의 summary_rowid 는 요약 테이블의 *암묵 정수 rowid* 다(PK 가 TEXT summary_id 라
 * rowid 가 따로 매겨진다). 삭제 트리거(chunk_summary_vec_delete 등)도 old.rowid 로 vec
 * 행을 지우므로, 여기서도 last_insert_rowid()(= 새 행의 rowid)를 vec 키로 쓴다.
 *
 * 임베딩은 호출자가 만든 embedder 를 의존으로 받는다(store 가 생성자에서 받은 것과 같은
 * 인스턴스 / 새 통로 0). embed 가 차원이 어긋난 vector 를 내면 loud throw — silent
 * 차원 불일치 저장 금지(EmbeddingDimMismatch 방어).
 */

import type { Database } from "bun:sqlite";
import type { Embedder } from "../../embedding/types.ts";

/** 청크요약 출처 — LLM 생성 / 첫 문단 fallback / 사용자 수정. */
export type ChunkSummaryGeneratedBy = "llm" | "first_paragraph_fallback" | "user_edit";

/** insertChunkSummary 인자 — summary_id 는 호출자가 만든다('cs_'+uuid). */
export interface InsertChunkSummaryArgs {
  summaryId: string;
  parentChunkId: number;
  parentDocumentId: string;
  summaryText: string;
  generatedBy: ChunkSummaryGeneratedBy;
}

/**
 * insertRelationSummary 인자 — confidence 동반(엣지 보류분도 저장 / plan 미세 모호 확정).
 * Task 14 정정: from/to 가 *개념 id*(concept_nodes 'cpt_' / persons 'psn_' TEXT)이고,
 * 멱등·cascade 기준인 source_document_id(documents.document_id)를 함께 받는다(Task 11 스키마).
 */
export interface InsertRelationSummaryArgs {
  summaryId: string;
  fromConceptId: string;
  toConceptId: string;
  relationName: string;
  summaryText: string;
  confidence: number;
  generatedBy: string;
  sourceDocumentId: string;
}

/** 열람·검색 채널이 읽는 청크요약 한 행(camelCase 정규화). */
export interface ChunkSummaryRow {
  summaryId: string;
  parentChunkId: number;
  parentDocumentId: string;
  summaryText: string;
  generatedBy: string;
}

/**
 * 열람·검색 채널이 읽는 관계요약 한 행(엣지 유무·라벨 판정에 confidence 동반).
 * Task 14 정정: from/to 가 개념 id(cpt_/psn_ TEXT) + 멱등·cascade 기준 source_document_id.
 */
export interface RelationSummaryRow {
  summaryId: string;
  fromConceptId: string;
  toConceptId: string;
  relationName: string;
  summaryText: string;
  confidence: number;
  sourceDocumentId: string;
}

/**
 * 요약 행 + 임베딩을 한 트랜잭션으로 다루는 저장소. store facade 가 이 클래스에 위임하고,
 * raw db 핸들은 생성자로 받는다(다른 repository 와 같은 양식). embedder 는 임베딩에만 쓴다.
 */
export class SummaryRepository {
  constructor(
    private readonly db: Database,
    private readonly embedder: Embedder,
  ) {}

  /**
   * 청크요약 한 행을 임베딩과 함께 저장한다(행 + embed + vec + has_embedding=1 한
   * 트랜잭션). 임베딩은 summary_text 로 만든다 — 검색 채널이 요약 문장으로 의미 검색하게.
   *
   * @returns 새 chunk_summaries 행의 summary_rowid(정수 rowid / vec0 키와 동일).
   */
  async insertChunkSummary(args: InsertChunkSummaryArgs): Promise<number> {
    const vector = await this.embedSummary(args.summaryText, `chunk_summary ${args.summaryId}`);
    return this.insertSummaryWithVec({
      vector,
      rowInsertSql: `INSERT INTO chunk_summaries
         (summary_id, parent_chunk_id, parent_document_id, summary_text, generated_by)
       VALUES (?, ?, ?, ?, ?)`,
      rowParams: [
        args.summaryId,
        args.parentChunkId,
        args.parentDocumentId,
        args.summaryText,
        args.generatedBy,
      ],
      vecInsertSql:
        "INSERT INTO chunk_summary_vec (summary_rowid, embedding) VALUES (?, ?)",
      markEmbeddedSql:
        "UPDATE chunk_summaries SET has_embedding = 1 WHERE rowid = ?",
    });
  }

  /**
   * 관계요약 한 행을 임베딩과 함께 저장한다(행 + embed + vec + has_embedding=1 한
   * 트랜잭션). confidence 임계 미만(엣지 보류)이어도 행은 항상 저장한다 — 나중 임계를
   * 내리면 LLM 재호출 0 으로 엣지 승격 가능(plan 미세 모호 확정).
   *
   * @returns 새 relation_summaries 행의 summary_rowid(정수 rowid / vec0 키와 동일).
   */
  async insertRelationSummary(args: InsertRelationSummaryArgs): Promise<number> {
    const vector = await this.embedSummary(args.summaryText, `relation_summary ${args.summaryId}`);
    return this.insertSummaryWithVec({
      vector,
      rowInsertSql: `INSERT INTO relation_summaries
         (summary_id, from_concept_id, to_concept_id, relation_name, summary_text, confidence, generated_by, source_document_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      rowParams: [
        args.summaryId,
        args.fromConceptId,
        args.toConceptId,
        args.relationName,
        args.summaryText,
        args.confidence,
        args.generatedBy,
        args.sourceDocumentId,
      ],
      vecInsertSql:
        "INSERT INTO relation_summary_vec (summary_rowid, embedding) VALUES (?, ?)",
      markEmbeddedSql:
        "UPDATE relation_summaries SET has_embedding = 1 WHERE rowid = ?",
    });
  }

  /**
   * 청크요약·관계요약 공통 저장 골격(audit M-7 minor — 두 insert 의 거의 같은
   * 트랜잭션 골격을 한 곳에 모은다). 한 트랜잭션 안에서 (1) 요약 행 INSERT →
   * (2) last_insert_rowid() 로 새 행의 정수 rowid 획득 → (3) 그 rowid 를 vec0 키로
   * embedding 직접 바인딩 → (4) has_embedding=1 갱신을 한 덩어리로 처리한다.
   * vec INSERT 가 실패하면 요약 행도 함께 롤백된다(고아 임베딩 0). 동작 보존 —
   * 두 메서드가 쓰던 같은 쓰기·같은 트랜잭션 경계·같은 멱등성을 그대로 유지한다.
   *
   * 테이블·칼럼 이름은 호출처의 리터럴 상수만 받는다(SQL injection 가드 — HTTP
   * 입력 금지). placeholder `?` 바인딩 유지. embed 는 트랜잭션 밖에서 미리 끝낸
   * 값(vector)을 받는다 — 트랜잭션 콜백은 동기여야 하므로(bun:sqlite).
   *
   * @returns 새 요약 행의 summary_rowid(정수 rowid / vec0 키와 동일).
   */
  private insertSummaryWithVec(spec: {
    vector: Float32Array;
    rowInsertSql: string;
    rowParams: (string | number)[];
    vecInsertSql: string;
    markEmbeddedSql: string;
  }): number {
    const insertRow = this.db.query(spec.rowInsertSql);
    const insertVec = this.db.query(spec.vecInsertSql);
    const markEmbedded = this.db.query(spec.markEmbeddedSql);

    const tx = this.db.transaction(() => {
      insertRow.run(...spec.rowParams);
      const rowid = Number(
        (this.db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id,
      );
      insertVec.run(rowid, spec.vector);
      markEmbedded.run(rowid);
      return rowid;
    });
    return tx();
  }

  /**
   * 한 청크 노드의 청크요약을 읽는다(열람·검색 채널용). 청크당 멱등이라 한 행만 있으나,
   * 방어적으로 가장 최근 generated_at 한 행을 회신한다. 없으면 null(정직한 빈 결과).
   */
  getChunkSummary(parentChunkId: number): ChunkSummaryRow | null {
    const row = this.db
      .query(
        `SELECT summary_id, parent_chunk_id, parent_document_id, summary_text, generated_by
         FROM chunk_summaries
         WHERE parent_chunk_id = ?
         ORDER BY generated_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(parentChunkId) as
      | {
          summary_id: string;
          parent_chunk_id: number;
          parent_document_id: string;
          summary_text: string;
          generated_by: string;
        }
      | null;
    if (row === null) return null;
    return {
      summaryId: row.summary_id,
      parentChunkId: row.parent_chunk_id,
      parentDocumentId: row.parent_document_id,
      summaryText: row.summary_text,
      generatedBy: row.generated_by,
    };
  }

  /**
   * 한 개념(cpt_/psn_)이 from·to 어느 쪽에든 든 관계요약을 양방향으로 읽는다(열람용
   * "AI 가 찾은 관계" 목록 / Task 16 표시·Task 15 검색이 활용). confidence 도 회신해
   * 호출자가 엣지 유무(보류 라벨) 를 판정한다. 없으면 빈 배열(정직한 빈 결과 — 가짜 채움 0).
   *
   * Task 14 정정: 관계 from/to 가 개념 id(TEXT)로 바뀌어, 옛 노드 id 양방향 조회를 개념 id
   * 양방향 조회로 갈음한다. 검색 결과 노드 → 그 노드의 개념 매핑은 호출자(Task 15·16)가 한다.
   */
  listRelationSummariesForConcept(conceptId: string): RelationSummaryRow[] {
    const rows = this.db
      .query(
        `SELECT summary_id, from_concept_id, to_concept_id, relation_name, summary_text, confidence, source_document_id
         FROM relation_summaries
         WHERE from_concept_id = ? OR to_concept_id = ?
         ORDER BY confidence DESC, rowid ASC`,
      )
      .all(conceptId, conceptId) as {
      summary_id: string;
      from_concept_id: string;
      to_concept_id: string;
      relation_name: string;
      summary_text: string;
      confidence: number;
      source_document_id: string;
    }[];
    return rows.map((r) => ({
      summaryId: r.summary_id,
      fromConceptId: r.from_concept_id,
      toConceptId: r.to_concept_id,
      relationName: r.relation_name,
      summaryText: r.summary_text,
      confidence: r.confidence,
      sourceDocumentId: r.source_document_id,
    }));
  }

  /**
   * summary_text 를 임베딩한다. 빈 텍스트는 호출자(글루)가 미리 거르므로 여기 오면 안
   * 되지만, 차원 불일치는 결정적으로 막는다 — embed 가 dimension 과 다른 길이 vector 를
   * 내면 loud throw(silent 차원 불일치 저장 금지 / context 에 식별자 담음).
   */
  private async embedSummary(text: string, context: string): Promise<Float32Array> {
    const vector = await this.embedder.embed(text);
    if (vector.length !== this.embedder.dimension) {
      throw new Error(
        `SummaryRepository embed dim mismatch: got ${vector.length}, ` +
          `expected ${this.embedder.dimension} (${context})`,
      );
    }
    return vector;
  }
}
