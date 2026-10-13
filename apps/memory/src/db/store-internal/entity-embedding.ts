/**
 * store-internal/entity-embedding.ts — 엔티티(사람·프로젝트) 요약 임베딩 적재 공통 헬퍼.
 *
 * person-repository 의 applyPersonEmbedding ↔ project-repository 의
 * applyProjectEmbedding 은 "row 조회 → 임베딩 입력 본문 고르기 → embed → dim 검증
 * → DELETE+INSERT vec" 흐름이 같았다(audit M-9 복붙). 한 곳에서 검증 로직을
 * 고치면 나머지가 조용히 발산하는 위험을 없애려고 한 헬퍼로 합친다.
 *
 * 동작 보존 — 회신값(true)·dim 검증 에러 메시지·not-found 메시지·DELETE+INSERT
 * 순서는 추출 전과 byte 동일. 엔티티별로 다른 부분(SELECT 칼럼·본문 고르기·에러
 * 메시지·테이블 이름)은 config 로 받는다. 테이블/칼럼 이름은 호출처의 리터럴
 * 상수만 넘긴다(SQL injection 가드 — HTTP 입력 금지). placeholder `?` 바인딩 유지.
 *
 * silent fallback 금지 — 임베딩 모델이 없거나 throw 하면 그대로 throw(거짓 성공
 * 안 만듦). 미존재 id·차원 불일치·빈 입력 모두 구체 에러 throw.
 */

import type { Database } from "bun:sqlite";
import type { Embedder } from "../../embedding/types.ts";

/**
 * 엔티티 임베딩 적재의 엔티티별 차이를 담는 config.
 *
 * @param TRow SELECT 한 행의 모양(엔티티마다 칼럼이 다르다).
 */
export interface EntityEmbeddingConfig<TRow> {
  /** SELECT 문 — `rowid AS rid` + 본문 후보 칼럼들. `WHERE <idColumn> = ?` 로 끝난다. */
  selectSql: string;
  /** vec 가상 테이블 이름(리터럴 상수). DELETE+INSERT 대상. */
  vecTable: string;
  /** vec 테이블의 rowid 참조 칼럼 이름(리터럴 상수). */
  vecRowidColumn: string;
  /** 미존재 id 일 때 throw 할 메시지(byte 동일 보존). */
  notFoundMessage: (id: string) => string;
  /** row → 임베딩 입력 본문. 비면 자기 고유 에러를 throw 한다(엔티티별 메시지 보존). */
  pickText: (row: TRow, id: string) => string;
  /** dim 불일치 메시지(byte 동일 보존 — 엔티티별 prefix·id suffix 다름). */
  dimMismatchMessage: (got: number, expected: number, id: string) => string;
}

/**
 * 엔티티 요약 임베딩을 만들어 vec 테이블에 적재한다(DELETE+INSERT upsert).
 * 적재에 성공하면 true. person_vec / project_summary_vec 둘 다 UPDATE/INSERT
 * 트리거가 없어(기준 스키마) 적재를 DELETE+INSERT 로 직접 관리한다.
 */
export async function applyEntityEmbedding<TRow extends { rid: number }>(
  db: Database,
  embedder: Embedder,
  id: string,
  config: EntityEmbeddingConfig<TRow>,
): Promise<boolean> {
  const row = db.query(config.selectSql).get(id) as TRow | null;
  if (!row) {
    throw new Error(config.notFoundMessage(id));
  }

  const text = config.pickText(row, id);

  const vec = await embedder.embed(text);
  if (vec.length !== embedder.dimension) {
    throw new Error(config.dimMismatchMessage(vec.length, embedder.dimension, id));
  }

  db.run(`DELETE FROM ${config.vecTable} WHERE ${config.vecRowidColumn} = ?`, [
    row.rid,
  ]);
  db.run(
    `INSERT INTO ${config.vecTable}(${config.vecRowidColumn}, embedding) VALUES (?, ?)`,
    [row.rid, vec],
  );
  return true;
}
