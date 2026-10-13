/**
 * search-repo-vec-fts — vec0 KNN·FTS5 검색 채널 + 개념→글 통로 자유 함수
 * (search-repository 3분할 / C1).
 *
 * SearchRepository 의 "검색 채널" 핵심(글 벡터 KNN·이미지 vec KNN·FTS5 두 색인 RRF·
 * 개념 후보→연결 자산 글 통로)을 db·embedder 를 인자로 받는 자유 함수로 떼어냈다. 이들이
 * retriever 의 벡터·글자·개념 채널 hits 를 만든다. RRF 코어(rrf.ts)는 호출만 하고 시그니처·
 * 동작 0 변경 — 두 FTS 색인 순위 융합·개념 후보 순서 보존이 이 채널의 책임이다.
 *
 * 동작 보존(behavior-preserving): 함수 본체·SQL·dim 검증 에러·RRF 호출·정렬은 옛 클래스
 * 메서드와 byte 동일하다(this.db → db·this.embedder → embedder 치환만). SearchRepository
 * 의 같은 이름 메서드가 위임한다(외부 호출 표면 보존).
 */

import type { Database } from "bun:sqlite";
import type { Embedder } from "../../embedding/types.ts";
import type { FtsHit, VectorHit } from "./args-types.ts";
import { sanitizeFtsQuery, sanitizeTrigramQuery } from "./fts.ts";
import { reciprocalRankFusion } from "../../memory/rrf.ts";
import { ENTITY_TYPE_METAS } from "./entity-type-registry.ts";

// ── Vec0 KNN ──────────────────────────────────────────────────────────

export async function getVectorById(
  db: Database,
  nodeId: number,
): Promise<Float32Array | null> {
  const row = db
    .query("SELECT embedding FROM vec_nodes WHERE node_id = ?")
    .get(nodeId) as { embedding: Uint8Array } | null;
  if (!row) return null;
  return new Float32Array(
    row.embedding.buffer,
    row.embedding.byteOffset,
    row.embedding.byteLength / 4,
  );
}

export async function getVectorsByIds(
  db: Database,
  ids: readonly number[],
): Promise<Map<number, Float32Array>> {
  const result = new Map<number, Float32Array>();
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    // dynamic SQL: placeholder count varies, keep prepare()
    .prepare(
      `SELECT node_id, embedding FROM vec_nodes WHERE node_id IN (${placeholders})`,
    )
    .all(...ids) as Array<{ node_id: number; embedding: Uint8Array }>;
  for (const row of rows) {
    result.set(
      row.node_id,
      new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      ),
    );
  }
  return result;
}

/**
 * 쿼리 텍스트를 임베딩한 뒤 vec0 KNN 검색을 실행한다.
 * 이미 Float32Array 를 가진 경우 searchByVectorRaw 를 직접 호출한다.
 */
export async function searchByVector(
  db: Database,
  embedder: Embedder,
  query: string,
  k: number,
): Promise<VectorHit[]> {
  const queryVec = await embedder.embed(query);
  return searchByVectorRaw(db, embedder, queryVec, k);
}

/**
 * 통과 집합 적응형 공급의 **조각 크기** — vec0 KNN 한 질의가 받을 수 있는 k 상류
 * 하드 상한과 같은 값이다(실측 2026-08-03 / T4 (B) 재정 단일 출처).
 *
 * 상류 제약: `k = 4097` 또는 `LIMIT 4097` 은 `k value in knn query too large,
 * provided 4097 and the limit is 4096` 로 **질의 자체가 거부된다**. `k = ?` 와
 * `LIMIT ?` 가 같은 벽을 쓴다. 그래서 통과 집합이 이보다 크면 한 질의로 전부
 * 순위화할 수 없고, 이 크기로 조각내 조각마다 `k = 조각 크기` 로 물어야 한다
 * (searchByVectorRaw 의 조각 루프 — 조각마다 `|조각| <= k` 전제조건이 성립한다).
 *
 * 이 값은 *라우팅 임계가 아니다*. 통과 집합이 얼마나 크든 전 구간을 조각 합집합으로
 * 처리한다 — 크기에 따라 다른 경로로 내리지 않는다. 조각 수만 `ceil(|pass|/4096)`
 * 으로 늘 뿐이고, 회수는 크기와 무관하게 구조적으로 보장된다. 옛 구현이 이 값을
 * "넘으면 사후 필터" 임계로 썼다가 불승인됐다: 그 근거였던 "크면 선택도가 넓다"는
 * *상대* 선택도 실측이지 절대 크기의 성질이 아니어서(코퍼스 10만·통과 5천이면 선택도
 * 5%), 코퍼스가 자랄수록 조용히 미달하는 계열의 결함이 된다.
 *
 * 조각이 늘 때 비용(코퍼스 40000행 / dim 1024 / 3회 평균):
 *
 *   무필터 현행 k=20            41.3 ms
 *   |pass| =   100 (1조각)      18.4 ms   ← 마스크 스캔이 전역 스캔보다 싸다
 *   |pass| =  1000 (1조각)      19.6 ms
 *   |pass| =  4096 (1조각)      24.6 ms
 *   |pass| =  8000 (2조각)      48.5 ms   (현행의 1.2배)
 *   |pass| = 30000 (8조각)     194.7 ms   (현행의 4.7배)
 *
 * 조각 수에 선형이고 유계다 — 거리 계산 총량은 통과 집합 1회 스캔과 같다. 거대 통과
 * 집합 필터 검색은 드물게만 일어나므로, 그때만 지불하는 정직한 비용으로 본다(D-D 정합).
 *
 * 조각당 파라미터가 4096 을 넘지 않아 SQLite 바인딩 변수 벽(실측 약 65533 — IN(65000)
 * OK / IN(65534) 실패)에는 구조적으로 닿지 않는다.
 */
export const VEC0_MAX_K = 4096;

/**
 * vec0 KNN — **프로젝트 스코프 한정** 변형 (T16 수정 1회차).
 *
 * `searchByVectorRaw` 는 코퍼스 전체를 본다. 저장 시 유사-중복 검사(D-A)처럼
 * "같은 프로젝트 안에서만" 견줘야 하는 호출자는 그대로 쓰면 안 된다 — 다른
 * 프로젝트의 기억까지 후보로 잡아, 같은 글을 두 번째 프로젝트에 남기는 것이
 * 막히고 남의 프로젝트 노드 id·본문 발췌가 회신에 실려 나간다(기억 경계 유출).
 *
 * 스코프를 **SQL 안 서브쿼리**로 건다. `allowedIds` 통로로 같은 일을 하려면
 * 호출자가 프로젝트의 노드 id 를 전부 SELECT 해 배열로 만들어 넘겨야 하는데,
 * 그건 프로젝트 크기에 비례하는 낭비이고 4096 조각 루프까지 돈다. 여기서는
 * 바인딩 파라미터 하나로 끝난다(D-D 더 싼 쪽).
 *
 * `project_id` NULL(무소속)도 하나의 스코프다 — SQLite 에서 `= NULL` 은 항상
 * UNKNOWN 이라 `IS NULL` 로 갈라야 한다(addNodeIdempotent 흡수 키와 같은 규칙).
 *
 * 회수 보장(2026-08-03 본 PC 실측): 외부 프로젝트 노드 80건이 전역 상위를
 * 전부 차지하고 대상 프로젝트 통과 집합이 30건(=|pass| > k)인 상황에서도
 * `k = 1` 질의가 대상 프로젝트의 진짜 유사-중복을 정확히 회수했다. sqlite-vec
 * 가 이 형태에서 IN 제약을 스캔 중에 적용하기 때문이다. 통과 0건이면 빈 결과를
 * 돌려준다(정직한 "비교 대상 없음" — 무필터로 넓히지 않는다).
 */
export async function searchByVectorInProject(
  db: Database,
  embedder: Embedder,
  queryVec: Float32Array,
  k: number,
  projectId: string | null,
): Promise<VectorHit[]> {
  if (k <= 0) return [];
  if (queryVec.length !== embedder.dimension) {
    throw new Error(
      `searchByVectorInProject dim mismatch: got ${queryVec.length}, expected ${embedder.dimension}`,
    );
  }
  const rows = (
    projectId === null
      ? db
          .query(
            `SELECT node_id, distance FROM vec_nodes
               WHERE embedding MATCH ?
                 AND node_id IN (SELECT id FROM knowledge_nodes WHERE project_id IS NULL)
                 AND k = ?`,
          )
          .all(queryVec, k)
      : db
          .query(
            `SELECT node_id, distance FROM vec_nodes
               WHERE embedding MATCH ?
                 AND node_id IN (SELECT id FROM knowledge_nodes WHERE project_id = ?)
                 AND k = ?`,
          )
          .all(queryVec, projectId, k)
  ) as Array<{ node_id: number; distance: number }>;
  return rows.map((r) => ({ nodeId: r.node_id, distance: r.distance }));
}

/**
 * vec0 KNN — 선택적 통과 집합 적응형 공급(T4 재판정 계약).
 *
 * `allowedIds` 를 주면 KNN 을 `node_id IN (...) AND k = ?` 형태로 돌린다. 단
 * **이 IN 은 pre-filter 가 아니다** — 2026-08-03 실측(sqlite-vec v0.1.9)에서
 * `|통과 집합| <= k` 일 때만 통과 집합 안에서 절단되고, 그보다 크면 전역 상위 k 를
 * 먼저 뽑은 뒤 IN 으로 거른다(= 사후 필터와 동일한 회수 손실). 경계는 코퍼스
 * 100~5000 전 구간에서 정확히 k 였다.
 *
 * 그래서 이 함수는 **전제조건을 스스로 성립시킨다**: 통과 집합을 VEC0_MAX_K 이하
 * 조각으로 나눠, 각 조각을 `k = 조각 크기` 로 질의한다. 조각마다 `|pass| == k` 가
 * 되어 그 조각 전체가 순위와 함께 회신되므로, 조각들을 합쳐 거리로 정렬하면 통과
 * 집합 전체의 정확한 순위가 된다. 실측 검증: 코퍼스 20000·통과 6666(2조각)에서
 * 상위 20 이 전수 계산 정답과 **완전 일치**.
 *
 * 호출자는 여기서 받은 결과를 상위 vectorK 로 자른다 — 이 함수는 통과 집합 전체를
 * 거리 오름차순으로 돌려준다(절단은 의미론상 호출자 몫).
 *
 * 세 상태를 반드시 구분한다:
 *   - `undefined`  = 필터 미지정 → 현행 `ORDER BY distance LIMIT ?` 그대로(회귀 0).
 *   - `[]`(빈 배열) = 필터가 걸렸으나 통과 0건 → `[]` 회신. 정직한 빈 결과이지
 *                     "필터 없음"이 아니다. 뭉개면 필터를 통째로 무시하는 버그가 된다.
 *   - 그 외        = 그 id 집합 안에서만 순위화.
 *
 * 상류 결함 우회: 원소가 **1개** 인 IN 목록은 빈 결과를 낸다(같은 id 를 두 번 적으면
 * 정상 회신 — 실측 확인). 조각 크기가 1 이면 id 를 2회 기재해 우회한다. vec0 가
 * 회신 행을 rowid 로 유일화하므로 중복 행이 생기지 않는다(실측: uniq == rows).
 */
export async function searchByVectorRaw(
  db: Database,
  embedder: Embedder,
  queryVec: Float32Array,
  k: number,
  allowedIds?: readonly number[],
): Promise<VectorHit[]> {
  if (k <= 0) return [];
  if (queryVec.length !== embedder.dimension) {
    throw new Error(
      `searchByVectorRaw dim mismatch: got ${queryVec.length}, expected ${embedder.dimension}`,
    );
  }
  if (allowedIds !== undefined) {
    // 통과 0건 = 정직한 빈 결과(미지정과 구분 — 위 JSDoc).
    if (allowedIds.length === 0) return [];
    const hits: VectorHit[] = [];
    // 조각 루프 — **운영 가동 경로다**(2026-08-03 (B) 재정 이후). 필터가 걸린 모든
    // 검색이 여기를 지나며, 통과 집합이 VEC0_MAX_K 를 넘으면 조각이 2개 이상 돈다.
    // 옛 구현은 큰 통과 집합을 retriever 단에서 사후 필터로 내려보내 이 여러-조각
    // 갈래가 실제로는 안 돌았는데(검토 Important 지적), 그 라우팅이 제거돼 지금은
    // 크기와 무관하게 전 구간이 이 루프로 처리된다 — "쓰이지 않는 예비 능력" 아님.
    for (let offset = 0; offset < allowedIds.length; offset += VEC0_MAX_K) {
      const chunk = allowedIds.slice(offset, offset + VEC0_MAX_K);
      // 원소 1개 IN 상류 결함 우회 — 같은 id 2회 기재(위 JSDoc).
      const bound = chunk.length === 1 ? [chunk[0]!, chunk[0]!] : chunk;
      const placeholders = bound.map(() => "?").join(",");
      // dynamic SQL: placeholder count varies, keep prepare(). id 는 바인딩 값이라
      // SQL 주입 표면이 아니다(자리표시자만 문자열로 조립).
      //
      // k = 조각 크기 → `|pass| <= k` 전제조건 성립 → 조각 전체가 순위화 회신.
      // `k = ?` 는 sqlite-vec 정식 KNN 표기(문서·issue #96).
      const rows = db
        .prepare(
          `SELECT node_id, distance FROM vec_nodes
             WHERE embedding MATCH ? AND node_id IN (${placeholders}) AND k = ?`,
        )
        .all(queryVec, ...bound, chunk.length) as Array<{
        node_id: number;
        distance: number;
      }>;
      for (const r of rows) {
        hits.push({ nodeId: r.node_id, distance: r.distance });
      }
    }
    // 조각별 순위를 하나로 합친다 — 거리 오름차순이 통과 집합 전체의 정확한 순위.
    // 조각이 하나면 이미 정렬돼 있어 이 sort 가 순서를 안 바꾼다(안정 정렬).
    hits.sort((a, b) => a.distance - b.distance);
    return hits;
  }
  const rows = db
    .query(
      `SELECT node_id, distance FROM vec_nodes
         WHERE embedding MATCH ?
         ORDER BY distance LIMIT ?`,
    )
    .all(queryVec, k) as Array<{ node_id: number; distance: number }>;
  return rows.map((r) => ({ nodeId: r.node_id, distance: r.distance }));
}

// ── image_vec KNN (Phase 11b T5) ──────────────────────────────────────
//
// 이미지 자산 검색 채널 — query 의 SigLIP text 임베딩으로 image_vec(768-dim
// cosine) 가상 테이블 KNN 을 돌린다. vec_nodes 와는 별개 테이블 — dim 검증은
// 호출자(getImageVecCandidates)가 SigLIP text encoder 출력 검증 시점에 이미
// 거치므로 본 함수는 embedder dim 검증을 안 거친다(768 고정).

export async function searchImageVec(
  db: Database,
  queryVec: Float32Array,
  k: number,
): Promise<Array<{ nodeId: number; distance: number }>> {
  if (k <= 0) return [];
  const rows = db
    .query(
      `SELECT node_id, distance FROM image_vec
         WHERE embedding MATCH ?
         ORDER BY distance LIMIT ?`,
    )
    .all(queryVec, k) as Array<{ node_id: number; distance: number }>;
  return rows.map((r) => ({ nodeId: r.node_id, distance: r.distance }));
}

export function hasImageVecRows(db: Database): boolean {
  const row = db
    .query("SELECT node_id FROM image_vec LIMIT 1")
    .get() as { node_id: number } | null;
  return row !== null;
}

// ── FTS5 ──────────────────────────────────────────────────────────────

/**
 * 텍스트 전문 검색 — 두 색인 RRF rank-union (1.1a T2).
 *
 * (1) unicode61 본색인(knowledge_nodes_fts) — 2글자 한국어 검색어를 보호한다.
 * (2) trigram 보조 색인(knowledge_nodes_trgm) — 3글자 이상 합성어 부분 매치.
 * 두 색인 결과를 reciprocalRankFusion 으로 순위 합친다([[retriever-fusion-rrf]]).
 * FtsHit.score 는 본색인(unicode61) BM25(-rank)를 그대로 채운다 — trigram 만 잡은
 * 노드는 0. 두 색인 모두 빈 결과면 [](빈 결과 = 정상). 색인 테이블 누락은 SQLite
 * 구체 에러를 가리지 않는다(mock/fallback 금지).
 */
export async function searchByFts(
  db: Database,
  query: string,
  limit: number,
): Promise<FtsHit[]> {
  if (limit <= 0) return [];

  // (1) unicode61 본색인 — 2글자 검색어 보호. 현행 정리 규칙 그대로.
  const uniQuery = sanitizeFtsQuery(query);
  const uniRows = uniQuery
    ? (db
        .query(
          `SELECT rowid, rank FROM knowledge_nodes_fts
             WHERE knowledge_nodes_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(uniQuery, limit) as Array<{ rowid: number; rank: number }>)
    : [];

  // (2) trigram 보조 색인 — 3글자+ 합성어 부분 매치. 전부 2글자면 빈 쿼리 → 생략.
  const trgmQuery = sanitizeTrigramQuery(query);
  const trgmRows = trgmQuery
    ? (db
        .query(
          `SELECT rowid, rank FROM knowledge_nodes_trgm
             WHERE knowledge_nodes_trgm MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(trgmQuery, limit) as Array<{ rowid: number; rank: number }>)
    : [];

  if (uniRows.length === 0 && trgmRows.length === 0) return [];

  // (3) 두 색인 순위를 RRF 로 합쳐 단일 정렬(두 BM25 스케일이 달라 합산 X).
  const fused = reciprocalRankFusion([
    uniRows.map((r) => r.rowid),
    trgmRows.map((r) => r.rowid),
  ]);

  // (4) FtsHit.score 는 본색인 BM25(-rank) 보존 — 없으면(trigram 만 잡음) 0.
  const uniScore = new Map(uniRows.map((r) => [r.rowid, -r.rank] as const));
  return [...fused.keys()]
    .slice(0, limit)
    .map((nodeId) => ({ nodeId, score: uniScore.get(nodeId) ?? 0 }));
}

/** MemoryStore 계약 메서드: searchByFts 의 tuple 형 별칭. */
export async function ftsSearch(
  db: Database,
  query: string,
  limit: number,
): Promise<Array<[number, number]>> {
  const hits = await searchByFts(db, query, limit);
  return hits.map((h) => [h.nodeId, h.score]);
}

// ── 개념 후보 → 연결 자산 글 통로 (1.1b T5 / DCL-3) ────────────────────

/**
 * 후보 개념 → node_concept_edges → 연결 자산 글 nodeId(중복 제거 / 개념 매칭 점수 순).
 *
 * DCL-3 수정(1.1b T5): conceptIds 는 매칭 점수 순으로 전달된다. 한 글이 여러 개념에
 * 연결되면 가장 강한 개념의 순위를 따르고, 동점 시 더 많은 개념에 연결된 글을 우선한다.
 * SQL 단일 패스 + JS 정렬 — SQL LIMIT 가 정렬을 깨지 않는다.
 *
 * 펼친 후보에 사람(psn_)·8 타입 엔티티 행 id 가 섞일 수 있어, 사람은 node_person_edges,
 * 엔티티 행은 entity_concept_edges(identity)→node_concept_edges 로 글에 닿는다(별칭으로
 * conceptRank 정렬을 한 흐름으로 묶음). 각 갈래 후보가 0개면 rows 가 안 변해 회귀 0.
 */
export async function getNodesByConcepts(
  db: Database,
  conceptIds: readonly string[],
  limit: number,
): Promise<number[]> {
  if (conceptIds.length === 0 || limit <= 0) return [];
  const placeholders = conceptIds.map(() => "?").join(",");
  // 한 글이 여러 개념에 연결될 수 있으므로 DISTINCT 없이 전체 조회 — JS 에서 정렬.
  // concept_id 도 SELECT 해서 어떤 개념 순위(conceptIds 인덱스)가 최강인지 판단한다.
  // relation-reader 는 공통 inventory/read view 이고, 여기는 ranked batch expansion 이라
  // IN 절·conceptRank·matchCount 를 한 덩어리로 유지해야 검색 점수식이 흔들리지 않는다.
  const rows = db
    // dynamic SQL: placeholder count varies, keep prepare()
    .prepare(
      `SELECT node_id, concept_id FROM node_concept_edges
         WHERE concept_id IN (${placeholders})`,
    )
    .all(...conceptIds) as Array<{ node_id: number; concept_id: string }>;

  // Task 19: 펼친 개념 후보에 사람(persons 'psn_') id 가 섞일 수 있다 — 사람의 글
  // 연결은 node_person_edges 에 있으므로 'psn_' 후보를 그쪽에서도 조회해 합류한다.
  // person_id 를 concept_id 칸으로 별칭해 아래 conceptRank 정렬이 한 흐름으로 돌게 한다.
  // psn_ 후보가 0개면 이 조회를 건너뛰어 옛 동작과 byte 동일하다(회귀 0).
  const personIds = conceptIds.filter((id) => id.startsWith("psn_"));
  if (personIds.length > 0) {
    const personPlaceholders = personIds.map(() => "?").join(",");
    const personRows = db
      // dynamic SQL: placeholder count varies, keep prepare()
      .prepare(
        `SELECT node_id, person_id AS concept_id FROM node_person_edges
           WHERE person_id IN (${personPlaceholders})`,
      )
      .all(...personIds) as Array<{ node_id: number; concept_id: string }>;
    rows.push(...personRows);
  }

  // S2-T2: 펼친 자식 후보에 8 타입 엔티티 행 id 가 섞일 수 있다 — 행은 자기 node_id
  // 가 없으므로 identity 엣지로 위계 잎 개념을 거쳐 그 행을 언급한 글 node_id 에 닿는다.
  // 분류 단계4 T4 — identity 엣지가 범용 entity_concept_edges 에 모여 한 쿼리로 모든
  // 8 타입 행 id 를 조회한다. id prefix 판정만 ENTITY_TYPE_METAS 단일 출처. 행 id 가
  // 0 개면 rows 가 안 변해 회귀 0.
  const entityPrefixes = ENTITY_TYPE_METAS.map((m) => m.idPrefix);
  const entityRowIds = conceptIds.filter((id) =>
    entityPrefixes.some((p) => id.startsWith(p)),
  );
  if (entityRowIds.length > 0) {
    const rowPlaceholders = entityRowIds.map(() => "?").join(",");
    // identity concept -> node_concept_edges JOIN 은 검색 후보를 글 node_id 로 푸는
    // 점수 경로라 relation-reader 로 분리하지 않는다(후보 순위/중복 집계 보존).
    const entityRows = db
      // dynamic SQL: placeholder count varies, keep prepare()
      .prepare(
        `SELECT nce.node_id, ece.entity_id AS concept_id
             FROM entity_concept_edges ece
             JOIN node_concept_edges nce ON nce.concept_id = ece.concept_id
            WHERE ece.role = 'identity' AND ece.entity_id IN (${rowPlaceholders})`,
      )
      .all(...entityRowIds) as Array<{ node_id: number; concept_id: string }>;
    rows.push(...entityRows);
  }

  if (rows.length === 0) return [];

  // conceptId → 순위(0 = 가장 강함). 낮은 인덱스 = 더 강한 매칭.
  const conceptRank = new Map(conceptIds.map((id, i) => [id, i]));

  // node_id 별로 (최소 개념 순위, 연결 개념 수) 집계.
  const nodeStats = new Map<number, { bestRank: number; matchCount: number }>();
  for (const row of rows) {
    const rank = conceptRank.get(row.concept_id) ?? conceptIds.length;
    const existing = nodeStats.get(row.node_id);
    if (!existing) {
      nodeStats.set(row.node_id, { bestRank: rank, matchCount: 1 });
    } else {
      nodeStats.set(row.node_id, {
        bestRank: Math.min(existing.bestRank, rank),
        matchCount: existing.matchCount + 1,
      });
    }
  }

  // 정렬: (1) 최강 개념 순위 오름차순(낮을수록 강함), (2) 연결 개념 수 내림차순.
  return [...nodeStats.entries()]
    .sort(([, a], [, b]) => {
      if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
      return b.matchCount - a.matchCount;
    })
    .slice(0, limit)
    .map(([nodeId]) => nodeId);
}
