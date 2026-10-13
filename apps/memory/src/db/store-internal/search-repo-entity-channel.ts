/**
 * search-repo-entity-channel — 엔티티(개념·프로젝트·사람) 검색 채널 자유 함수
 * (search-repository 3분할 / C1).
 *
 * SearchRepository 의 "엔티티 검색 채널" 책임을 db·embedder 를 인자로 받는 자유 함수로
 * 떼어냈다. 개념·프로젝트·사람 세 엔티티의 FTS 매칭·KNN-by-rowid 풀이가 모인다. 이들이
 * 돌려주는 hit 자체는 검색 결과로 노출하지 않는다 — 검색어가 한 엔티티를 짚으면 그에
 * 연결된 자산 글을 후보 pool 로 끌어올리는 *통로(conduit)* 다. 실제 합류·RRF 합산은
 * retriever 책임이라 이 함수들은 후보를 만드는 통로일 뿐 점수 계산 0(RRF 코어 불변).
 *
 * 동작 보존(behavior-preserving): 함수 본체·SQL·placeholder 바인딩·dim 검증 에러
 * prefix·rowid 풀이 순서는 옛 클래스 메서드와 byte 동일하다(this.db → db·this.embedder
 * → embedder 치환만). SearchRepository 의 같은 이름 메서드가 위임한다(외부 표면 보존).
 */

import type { Database } from "bun:sqlite";
import type { Embedder } from "../../embedding/types.ts";
import { sanitizeFtsQuery } from "./fts.ts";
import { reciprocalRankFusion } from "../../memory/rrf.ts";
import { PROJECT_TYPE_NAME } from "./project-repository.ts";

// ── 엔티티(개념·프로젝트·사람) 공통 검색 헬퍼 (M-9) ──────────────────────
//
// 개념·프로젝트·사람 세 엔티티의 FTS 매칭과 KNN-by-rowid 풀이는 테이블·칼럼
// 이름만 다른 같은 구조였다(audit M-9 — "가장 위험" 복붙). 한 헬퍼로 합쳐
// 발산 자체를 없앤다. 테이블/칼럼 인자는 호출처의 리터럴 상수만 받는다
// (SQL injection 가드 — HTTP 입력 금지). placeholder `?` 바인딩·dim 검증
// 에러 prefix·rowid 풀이 순서는 추출 전과 byte 동일.

/**
 * 엔티티 FTS 매칭 공통 헬퍼 — trigram 보조 색인 + unicode61 본색인 두 색인을 RRF 로
 * 합쳐 `{ id, score }` 를 회신한다(S5 / searchByFts 두 색인 RRF 선례).
 *
 * (1) unicode61 본색인(<uniTable>) — 2글자 한국어 이름('바라'·'민수'·'커피')을 보호한다.
 *     sanitizeFtsQuery 의 prefix `*` OR-join 이 정확·조사 흡수 매치를 낸다(실측 확정).
 * (2) trigram 보조 색인(<trgmTable>) — 3글자+ 합성어 부분매치('커피추출도구' 안 '추출도구')를
 *     더한다. 두 색인 모두 sanitizeFtsQuery 로 정리한다(entity 채널 현행 부분매치 동작 보존 —
 *     knowledge_nodes 의 sanitizeTrigramQuery 와 다르나, entity trigram 은 원래 prefix `*` 로
 *     3글자+ 부분매치를 하고 있었으므로 그 규칙을 유지해 회귀 0).
 *
 * 두 색인 결과를 rowid 로 reciprocalRankFusion 순위 합침([[retriever-fusion-rrf]] — 두
 * BM25 스케일이 달라 점수 단순 합산이 아니라 순위 융합). score 는 unicode61 본색인
 * BM25(-rank)를 우선 채우고(searchByFts 양식 — 없으면 trigram -rank, 둘 다 없으면 0),
 * rowid → id 풀이로 회신한다. 호출처가 id 를 자기 키(conceptId/personId 등)로 매핑한다.
 * 두 색인 모두 빈 결과면 [](빈 결과 = 정상). 색인 테이블 누락은 SQLite 구체 에러를
 * 가리지 않는다(mock/fallback 금지).
 */
export function entityFtsSearch(
  db: Database,
  trgmTable: string,
  uniTable: string,
  idColumn: string,
  query: string,
  limit: number,
): Array<{ id: string; score: number }> {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized || limit <= 0) return [];

  // (1) unicode61 본색인 — 2글자 검색어 보호.
  const uniRows = db
    // dynamic SQL: table/column names vary per entity, keep prepare()
    .prepare(
      `SELECT rowid, ${idColumn}, rank FROM ${uniTable}
         WHERE ${uniTable} MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(sanitized, limit) as Array<Record<string, string | number>>;

  // (2) trigram 보조 색인 — 3글자+ 합성어 부분매치.
  const trgmRows = db
    // dynamic SQL: table/column names vary per entity, keep prepare()
    .prepare(
      `SELECT rowid, ${idColumn}, rank FROM ${trgmTable}
         WHERE ${trgmTable} MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(sanitized, limit) as Array<Record<string, string | number>>;

  if (uniRows.length === 0 && trgmRows.length === 0) return [];

  // (3) 두 색인 순위를 rowid 로 RRF 합침(두 BM25 스케일이 달라 합산 X). rowid → id·score
  //     풀이용 Map — uniScore 우선, 없으면 trgm score. rowid 는 standalone entity FTS 라
  //     entity 행 rowid 와 정합(트리거가 rowid = entity.rowid 로 적재).
  const uniScore = new Map(uniRows.map((r) => [r.rowid as number, -(r.rank as number)] as const));
  const trgmScore = new Map(trgmRows.map((r) => [r.rowid as number, -(r.rank as number)] as const));
  const idByRowid = new Map<number, string>();
  for (const r of uniRows) idByRowid.set(r.rowid as number, r[idColumn] as string);
  for (const r of trgmRows) idByRowid.set(r.rowid as number, r[idColumn] as string);

  const fused = reciprocalRankFusion([
    uniRows.map((r) => r.rowid as number),
    trgmRows.map((r) => r.rowid as number),
  ]);

  return [...fused.keys()]
    .slice(0, limit)
    .map((rowid) => ({
      id: idByRowid.get(rowid) as string,
      score: uniScore.get(rowid) ?? trgmScore.get(rowid) ?? 0,
    }));
}

/**
 * 엔티티 KNN-by-rowid 공통 헬퍼 — (1) vec0 가상 테이블 단독 KNN 으로
 * rowid + distance 를 뽑고 (2) 그 rowid 를 base 테이블에서 id 로 풀어 KNN
 * 거리 순서를 보존해 `{ id, distance }` 를 회신한다. JOIN 으로 감싸면 vec0 의
 * "LIMIT or 'k = ?' constraint is required" 에러가 나므로 두 단계로 나눈다.
 * graceful: vec 가 비면 KNN 이 [] 를 돌려준다(에러 아님). 색인 테이블 누락은
 * prepare/all 단계 SQLite 에러를 가리지 않는다.
 */
export function entityKnnByVector(
  db: Database,
  embedder: Embedder,
  label: string,
  vecTable: string,
  vecIdColumn: string,
  baseTable: string,
  baseIdColumn: string,
  queryVec: Float32Array,
  k: number,
): Array<{ id: string; distance: number }> {
  if (k <= 0) return [];
  if (queryVec.length !== embedder.dimension) {
    throw new Error(
      `${label} dim mismatch: got ${queryVec.length}, expected ${embedder.dimension}`,
    );
  }
  const knn = db
    // dynamic SQL: table/column names vary per entity, keep prepare()
    .prepare(
      `SELECT ${vecIdColumn}, distance FROM ${vecTable}
         WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
    )
    .all(queryVec, k) as Array<Record<string, number>>;
  if (knn.length === 0) return [];

  const placeholders = knn.map(() => "?").join(",");
  const idRows = db
    // dynamic SQL: placeholder count varies, keep prepare()
    .prepare(
      `SELECT rowid, ${baseIdColumn} FROM ${baseTable} WHERE rowid IN (${placeholders})`,
    )
    .all(...knn.map((r) => r[vecIdColumn] as number)) as Array<
    Record<string, string | number>
  >;
  const idByRowid = new Map(
    idRows.map((r) => [r.rowid as number, r[baseIdColumn] as string]),
  );

  // KNN 거리 순서 보존 — rowid → id 풀이 후 같은 순서로.
  return knn
    .map((r) => ({
      id: idByRowid.get(r[vecIdColumn] as number),
      distance: r.distance as number,
    }))
    .filter((r): r is { id: string; distance: number } => r.id !== undefined);
}

// ── 개념 매칭 채널 (1.1a T5 / 갈래 A 매칭) ────────────────────────────

/**
 * 검색어 → 개념 글자 매칭(concept_nodes_fts trigram + concept_nodes_uni unicode61 RRF).
 * conceptId + score. unicode61 이 2글자('커피')를, trigram 이 3글자+ 합성어 부분매치를 맡는다(S5).
 */
export function searchConceptsByFts(
  db: Database,
  query: string,
  limit: number,
): Array<{ conceptId: string; score: number }> {
  return entityFtsSearch(
    db,
    "concept_nodes_fts",
    "concept_nodes_uni",
    "concept_id",
    query,
    limit,
  ).map((r) => ({ conceptId: r.id, score: r.score }));
}

/**
 * 검색어 → 개념 의미 매칭(concept_vec KNN). conceptId + distance.
 * vec0 KNN 은 LIMIT(=k) 제약을 가상 테이블 조회에 직접 받아야 한다(searchByVectorRaw
 * 와 동일 단일 테이블 KNN 패턴). graceful: concept_vec 가 비면 KNN 이 [](에러 아님).
 */
export function searchConceptsByVector(
  db: Database,
  embedder: Embedder,
  queryVec: Float32Array,
  k: number,
): Array<{ conceptId: string; distance: number }> {
  return entityKnnByVector(
    db,
    embedder,
    "searchConceptsByVector",
    "concept_vec",
    "concept_rowid",
    "concept_nodes",
    "concept_id",
    queryVec,
    k,
  ).map((r) => ({ conceptId: r.id, distance: r.distance }));
}

// ── 프로젝트·사람 엔티티 검색 (1.2 T7 / 분류 단계4 T7'b) ──────────────────

/**
 * 검색어 → 프로젝트 글자 매칭. projectId + score(분류 단계4 T7'b).
 * 프로젝트 본체가 전용 projects 에서 범용 entities(type_name='project')로 옮겨져
 * 범용 색인 entities_fts 를 MATCH 하고 entities 와 JOIN 해 type_name='project' 끝점만
 * 거른다(시그니처·회신 모양 불변). graceful: 색인이 비면 빈 배열(정직한 빈 상태).
 */
export function searchProjectsByFts(
  db: Database,
  query: string,
  limit: number,
): Array<{ projectId: string; score: number }> {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized || limit <= 0) return [];

  // 프로젝트는 범용 entities(type_name='project')에 산다 — entities_fts(trigram)·
  // entities_uni(unicode61) 두 색인을 각각 MATCH 하고 entities 와 JOIN 해 project 끝점만
  // 거른다. FTS5 는 vec0 와 달리 JOIN 안 MATCH 를 허용한다. (S5) unicode61 이 2글자
  // ('바라' 프로젝트)를, trigram 이 3글자+ 합성어 부분매치를 맡는다. entityFtsSearch 와
  // 같은 두 색인 RRF 융합이되, 프로젝트는 type_name JOIN 필터가 필요해 별도 구현이다.
  const rowsFor = (ftsTable: string): Array<{ rowid: number; project_id: string; rank: number }> =>
    db
      // dynamic SQL: ftsTable 은 호출처 리터럴 상수(SQL injection 무관 — HTTP 입력 아님).
      .prepare(
        `SELECT e.rowid AS rowid, f.entity_id AS project_id, f.rank AS rank
             FROM ${ftsTable} f
             JOIN entities e ON e.entity_id = f.entity_id
            WHERE ${ftsTable} MATCH ? AND e.type_name = ?
            ORDER BY f.rank LIMIT ?`,
      )
      .all(sanitized, PROJECT_TYPE_NAME, limit) as Array<{
      rowid: number;
      project_id: string;
      rank: number;
    }>;

  const uniRows = rowsFor("entities_uni");
  const trgmRows = rowsFor("entities_fts");
  if (uniRows.length === 0 && trgmRows.length === 0) return [];

  // 두 색인 순위를 entities.rowid 로 RRF 합침. score 는 unicode61 본색인 -rank 우선
  // (없으면 trigram -rank, 둘 다 없으면 0). rowid → project_id·score 풀이(entityFtsSearch 양식).
  const uniScore = new Map(uniRows.map((r) => [r.rowid, -r.rank] as const));
  const trgmScore = new Map(trgmRows.map((r) => [r.rowid, -r.rank] as const));
  const idByRowid = new Map<number, string>();
  for (const r of uniRows) idByRowid.set(r.rowid, r.project_id);
  for (const r of trgmRows) idByRowid.set(r.rowid, r.project_id);

  const fused = reciprocalRankFusion([
    uniRows.map((r) => r.rowid),
    trgmRows.map((r) => r.rowid),
  ]);

  return [...fused.keys()]
    .slice(0, limit)
    .map((rowid) => ({
      projectId: idByRowid.get(rowid) as string,
      score: uniScore.get(rowid) ?? trgmScore.get(rowid) ?? 0,
    }));
}

/**
 * 검색어 → 프로젝트 의미 매칭(entities_vec KNN). projectId + distance(분류 단계4 T7'b).
 * 범용 색인 entities_vec 를 KNN 하고 (1) entities_vec 단독 KNN rowid+distance (2) 그
 * rowid 를 entities 에서 type_name='project' 로 걸러 project_id 풀이. 다른 종류가 KNN
 * 상위를 차지해 프로젝트가 k 밖으로 밀리는 일을 막으려 넉넉한 배수만큼 끌어와 프로젝트만
 * 골라 k 개로 자른다(under-return 방지). 차원은 embedder.dimension 일치해야 한다 —
 * 불일치는 throw(silent fallback 금지). graceful: entities_vec 가 비면 KNN 이 [].
 */
export function searchProjectsByVector(
  db: Database,
  embedder: Embedder,
  queryVec: Float32Array,
  k: number,
): Array<{ projectId: string; distance: number }> {
  if (k <= 0) return [];
  if (queryVec.length !== embedder.dimension) {
    throw new Error(
      `searchProjectsByVector dim mismatch: got ${queryVec.length}, expected ${embedder.dimension}`,
    );
  }
  // 다른 종류가 KNN 상위를 차지해 프로젝트가 k 밖으로 밀리는 일을 막으려 넉넉히
  // 끌어온다(프로젝트·전체 엔티티 규모가 작아 비용 무시 가능). 4배 + 32 는 작은
  // 코퍼스에서 사실상 entities_vec 전체를 덮는 여유.
  const fetchK = k * 4 + 32;
  const knn = db
    .query(
      `SELECT entity_rowid, distance FROM entities_vec
          WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
    )
    .all(queryVec, fetchK) as Array<{
    entity_rowid: number;
    distance: number;
  }>;
  if (knn.length === 0) return [];

  const placeholders = knn.map(() => "?").join(",");
  const idRows = db
    // dynamic SQL: placeholder count varies, keep prepare()
    .prepare(
      `SELECT rowid, entity_id FROM entities
          WHERE type_name = ? AND rowid IN (${placeholders})`,
    )
    .all(PROJECT_TYPE_NAME, ...knn.map((r) => r.entity_rowid)) as Array<{
    rowid: number;
    entity_id: string;
  }>;
  const idByRowid = new Map(idRows.map((r) => [r.rowid, r.entity_id]));

  // KNN 거리 순서 보존 — 프로젝트 행만 골라 같은 순서로, k 개까지.
  const out: Array<{ projectId: string; distance: number }> = [];
  for (const r of knn) {
    const projectId = idByRowid.get(r.entity_rowid);
    if (projectId === undefined) continue; // 비-프로젝트 종류는 정직하게 뺀다.
    out.push({ projectId, distance: r.distance });
    if (out.length >= k) break;
  }
  return out;
}

/**
 * 검색어 → 사람 글자 매칭(persons_fts trigram + persons_uni unicode61 RRF). personId + score.
 * unicode61 이 2글자('민수')를, trigram 이 3글자+ 합성어 부분매치를 맡는다(S5).
 */
export function searchPersonsByFts(
  db: Database,
  query: string,
  limit: number,
): Array<{ personId: string; score: number }> {
  return entityFtsSearch(
    db,
    "persons_fts",
    "persons_uni",
    "person_id",
    query,
    limit,
  ).map((r) => ({ personId: r.id, score: r.score }));
}

/**
 * 검색어 → 사람 의미 매칭(person_vec KNN). personId + distance.
 * searchProjectsByVector 와 같은 KNN→rowid 풀이 패턴(person_rowid → persons.rowid
 * → person_id). graceful: person_vec 가 비면 KNN 이 [](에러 아님).
 */
export function searchPersonsByVector(
  db: Database,
  embedder: Embedder,
  queryVec: Float32Array,
  k: number,
): Array<{ personId: string; distance: number }> {
  return entityKnnByVector(
    db,
    embedder,
    "searchPersonsByVector",
    "person_vec",
    "person_rowid",
    "persons",
    "person_id",
    queryVec,
    k,
  ).map((r) => ({ personId: r.id, distance: r.distance }));
}
