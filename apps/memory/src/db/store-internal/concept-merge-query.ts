/**
 * store-internal/concept-merge-query.ts — 개념 별칭 검출·합류 재연결 DB 루틴.
 *
 * ConceptRepository 에서 떼어낸, db(+embedder)만 받아 도는 DB 질의 두 갈래다:
 *   - findSimilarConceptsQuery: concept_vec ANN 으로 의미 가까운 기존 개념 검출(D2).
 *   - repointConceptInFkZeroTables: 합류 source 개념 끝점을 target 으로 재연결.
 * ConceptRepository 본체를 작게 유지하기 위해 분리했을 뿐 로직은 옮기기 전과 동일하다.
 */

import type { Database } from "bun:sqlite";
import type { Embedder } from "../../embedding/types.ts";
import {
  filterAliasCandidates,
  CONCEPT_ALIAS_THRESHOLD,
  type AliasCandidate,
  type AnnConceptRow,
} from "../../memory/concept-alias-detect.ts";

/**
 * D2 — concept_vec ANN 으로 의미가 가까운 기존 개념을 찾는다(Phase 6b T8 / spec 8.3).
 *
 * conceptRowid 개념의 임베딩(concept_vec 에 이미 적재된 값을 그대로 읽음 — 재임베딩
 * 안 함, 0 LLM 호출)으로 concept_vec KNN 을 돌려 cosine(= 1 − distance) ≥ threshold
 * 인 후보를 cosine 내림차순으로 반환한다. self(자기 자신) 제외 + 같은 이름 제외
 * (같은 이름은 name UNIQUE 로 findOrCreateConcept 가 이미 자동 합류 — 사용자 결정 1).
 *
 * vec0 KNN 은 LIMIT(=k) 제약을 가상 테이블 조회에 직접 받아야 한다(searchConceptsByVector
 * 와 같은 단일 테이블 KNN 패턴) — JOIN 으로 감싸면 sqlite-vec 제약 에러. 그래서
 * (1) concept_vec 단독 KNN 으로 rowid+distance 를 뽑고 (2) 그 rowid 를 concept_nodes
 * 에서 concept_id+name 으로 푼 뒤 (3) 순수 모듈 filterAliasCandidates 로 가린다.
 *
 * concept_vec 에 임베딩이 없는 rowid 면 구체 에러 throw — silent fallback 금지.
 * KNN 은 자기 자신을 포함하므로 limit 이 정확히 limit 개의 "다른" 후보를 보장하도록
 * KNN 단계는 limit+여유 1 만큼 더 가져온다(self + 같은 이름이 KNN 상위를 차지할 수 있음).
 */
export async function findSimilarConceptsQuery(
  db: Database,
  conceptRowid: number,
  threshold: number = CONCEPT_ALIAS_THRESHOLD,
  limit = 10,
): Promise<AliasCandidate[]> {
  // (1) 기준 개념의 임베딩을 concept_vec 에서 그대로 읽는다(재임베딩 X).
  const vecRow = db
    .query("SELECT embedding FROM concept_vec WHERE concept_rowid = ?")
    .get(conceptRowid) as { embedding: Uint8Array } | null;
  if (!vecRow) {
    throw new Error(
      `findSimilarConcepts: no concept_vec embedding for concept_rowid=${conceptRowid}`,
    );
  }
  const queryVec = new Float32Array(
    vecRow.embedding.buffer,
    vecRow.embedding.byteOffset,
    vecRow.embedding.byteLength / 4,
  );

  // 기준 개념의 이름(같은 이름 제외용).
  const selfRow = db
    .query("SELECT name FROM concept_nodes WHERE rowid = ?")
    .get(conceptRowid) as { name: string } | null;
  if (!selfRow) {
    throw new Error(
      `findSimilarConcepts: no concept_nodes row for rowid=${conceptRowid}`,
    );
  }

  // (2) concept_vec 단독 KNN. self + 같은 이름이 KNN 상위를 차지할 수 있어
  //     limit 보다 넉넉히(+2) 가져온 뒤 순수 필터가 정확히 limit 으로 자른다.
  const knnLimit = Math.max(1, limit) + 2;
  const knn = db
    .query(
      `SELECT concept_rowid, distance FROM concept_vec
       WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
    )
    .all(queryVec, knnLimit) as Array<{ concept_rowid: number; distance: number }>;
  if (knn.length === 0) return [];

  // (3) rowid → concept_id + name 풀이.
  const placeholders = knn.map(() => "?").join(",");
  const idRows = db
    // dynamic SQL: placeholder count varies, keep prepare()
    .prepare(
      `SELECT rowid, concept_id, name FROM concept_nodes WHERE rowid IN (${placeholders})`,
    )
    .all(...knn.map((r) => r.concept_rowid)) as Array<{
    rowid: number;
    concept_id: string;
    name: string;
  }>;
  const metaByRowid = new Map(idRows.map((r) => [r.rowid, r]));

  const rows: AnnConceptRow[] = knn
    .map((r) => {
      const meta = metaByRowid.get(r.concept_rowid);
      if (!meta) return null;
      return {
        conceptRowid: r.concept_rowid,
        conceptId: meta.concept_id,
        name: meta.name,
        distance: r.distance,
      };
    })
    .filter((r): r is AnnConceptRow => r !== null);

  return filterAliasCandidates(rows, {
    selfRowid: conceptRowid,
    selfName: selfRow.name,
    threshold,
    limit,
  });
}

/**
 * 개념 한 개를 가리키는 끝점을 다른 개념 id 로 갈아끼우는, FK 0 다형 엣지 테이블
 * 전용 재연결 헬퍼(합류 source 삭제 직전 호출 — mergeConceptAlias 의 extraTxWork
 * 안 같은 트랜잭션). concept_edges 는 단일 칸 FK·전용 재연결을 호출처가 이미
 * 처리하므로 여기서 다루지 않는다 — 이 헬퍼는 위계·관계 단일 출처로 옮겨진 뒤
 * CASCADE 가 안 닿는 두 테이블만 책임진다:
 *   - hierarchy_edges       — 위계(parent_of) 단일 출처.
 *   - entity_relation_edges — cross-type 관계 단일 출처.
 *
 * 끝점 종류 구분: 두 테이블 다 (source_type, source_id) + (target_type, target_id)
 * 네 칸으로 다형 끝점을 담는다. 개념 끝점은 source_type/target_type = 'concept' +
 * 끝점 id 칸에 bare concept_id(prefix 없음, classification-flow CONCEPT_TYPE 양식).
 * 같은 id 칸이 person('psn_')·8 타입 행 id 도 담으므로, *_type = 'concept' 인 행만
 * 정확히 골라 갈아끼운다 — 종류 칼럼이 끝점 종류를 명확히 가른다(id 충돌 위험 차단).
 *
 * concept_edges 와 같은 정리 양식:
 *   1. UPDATE OR IGNORE 로 oldId 끝점(해당 종류='concept')을 newId 로 옮긴다.
 *      PK 충돌(같은 끝점 쌍·relation 이 이미 존재)은 OR IGNORE 가 건너뛴다.
 *   2. 자기 루프(양 끝이 같은 concept)와, OR IGNORE 가 못 옮겨 oldId 로 남은 잔존
 *      행을 DELETE 로 정리한다 — 끊긴 끝점·중복 0. 자기 루프 절은 이번 재연결로
 *      생긴 것(source_id ∈ {oldId, newId})만 좁혀 지운다 — 무관한 기존 Z↔Z 자기
 *      루프는 보존한다.
 *
 * 정적 SQL 이라 db.query() 캐시를 쓴다. 두 테이블 양식이 동일해 한 내부 루틴으로
 * 처리한다(중복 구현 0).
 */
export function repointConceptInFkZeroTables(
  db: Database,
  oldId: string,
  newId: string,
): void {
  for (const table of ["hierarchy_edges", "entity_relation_edges"] as const) {
    // (1) source/target 끝점 중 'concept' 종류로 oldId 를 가리키는 행만 newId 로.
    db
      .query(
        `UPDATE OR IGNORE ${table} SET source_id = ?
         WHERE source_type = 'concept' AND source_id = ?`,
      )
      .run(newId, oldId);
    db
      .query(
        `UPDATE OR IGNORE ${table} SET target_id = ?
         WHERE target_type = 'concept' AND target_id = ?`,
      )
      .run(newId, oldId);
    // (2) 자기 루프(양 끝이 같은 concept)와 OR IGNORE 로 못 옮겨 oldId 로 남은
    //     잔존 끝점을 정리한다 — 끊긴/중복 엣지 0. 자기 루프 절은 이번 재연결로
    //     생긴 것(oldId·newId 관련)만 좁혀 지운다 — source→target 직접 위계가
    //     UPDATE 후 newId↔newId 가 됐거나 한쪽이 안 옮겨져 oldId 가 남은 행. 이번
    //     합치기와 무관한 기존 자기 루프(Z↔Z)는 건드리지 않는다(데이터 무결성).
    //     자기 루프는 source_id = target_id 라 source_id 한쪽만 IN 검사로 충분하다.
    db
      .query(
        `DELETE FROM ${table}
         WHERE (source_type = 'concept' AND source_id = ?)
            OR (target_type = 'concept' AND target_id = ?)
            OR (source_type = 'concept' AND target_type = 'concept'
                AND source_id = target_id
                AND source_id IN (?, ?))`,
      )
      .run(oldId, oldId, oldId, newId);
  }
}
