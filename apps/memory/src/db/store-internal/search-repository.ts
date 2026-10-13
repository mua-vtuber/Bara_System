/**
 * store-internal/search-repository.ts — 검색 메서드 파사드(C1 3분할 위임자).
 *
 * SqliteMemoryStore 가 부르는 검색 메서드의 외부 호출 표면을 그대로 유지하되, 본체는
 * 책임별 자유 함수 파일에 위임한다(C1 분해 — db·embedder 를 인자로 넘긴다):
 *   - search-repo-vec-fts.ts        : 글 벡터 KNN·이미지 vec KNN·FTS5 두 색인 RRF·개념→글 통로
 *   - search-repo-entity-channel.ts : 개념·프로젝트·사람 엔티티 FTS/KNN 채널
 *   - search-repo-node-meta.ts      : 개념 펼침·이미지 캡션·분류 태그·종류·자식→부모·인접 청크
 *   - search-repo-filters.ts        : 후보 축소 통과 Set 필터(polarity·분류·장소·시간·종류 등)
 *
 * 위임은 호출 그래프만 바꾸고 동작은 byte 동일하다(점수식 6파일·RRF 코어 0 변경).
 */

import type { Database } from "bun:sqlite";
import type {
  ConceptNode,
  ConceptRole,
  MemoryType,
  Polarity,
} from "../../memory/types.ts";
import type { Embedder } from "../../embedding/types.ts";
import type { NeighborChunk } from "../../memory/neighbor-chunks.ts";
import type { FtsHit, VectorHit } from "./args-types.ts";
import { loadProjectVocab as loadProjectVocabFn } from "../../memory/project-vocab.ts";
import { computeBM25Cross as computeBM25CrossFn } from "./bm25-cross.ts";
// 후보 축소·필터 책임(polarity·분류 값·글-칸·장소·pending_review·시간 범위·memory_type)
// 은 search-repo-filters.ts 자유 함수로 떼어냈다(3분할 / C1 — db 를 첫 인자로 받는다).
// 아래 같은 이름 메서드가 그 함수에 위임한다(외부 호출 표면 보존·동작 byte 동일).
import * as filters from "./search-repo-filters.ts";
// 노드 메타·개념 조회 책임(개념 펼침·이미지 캡션·분류 태그·종류·자식→부모 역추적·
// 인접 청크)은 search-repo-node-meta.ts 자유 함수로 떼어냈다(3분할 / C1 — db 를 첫
// 인자로 받는다). 아래 같은 이름 메서드가 위임한다(외부 호출 표면 보존·동작 byte 동일).
import * as nodeMeta from "./search-repo-node-meta.ts";
// 엔티티(개념·프로젝트·사람) 검색 채널 책임은 search-repo-entity-channel.ts 자유 함수로
// 떼어냈다(3분할 / C1 — db·embedder 를 인자로 받는다). 아래 같은 이름 메서드가 위임한다
// (외부 호출 표면 보존·동작 byte 동일). 검색 결과가 아니라 자산 글을 끌어올리는 통로다.
import * as entityChannel from "./search-repo-entity-channel.ts";
// 글 벡터 KNN·이미지 vec KNN·FTS5 두 색인 RRF·개념→글 통로(검색 채널 핵심)는
// search-repo-vec-fts.ts 자유 함수로 떼어냈다(3분할 / C1 — db·embedder 를 인자로 받는다).
// 아래 같은 이름 메서드가 위임한다(외부 호출 표면 보존·동작 byte 동일·RRF 코어 불변).
import * as vecFts from "./search-repo-vec-fts.ts";

export class SearchRepository {
  constructor(
    private readonly db: Database,
    private readonly embedder: Embedder,
  ) {}

  // ── Vec0 KNN ──────────────────────────────────────────────────────────

  async getVectorById(nodeId: number): Promise<Float32Array | null> {
    return vecFts.getVectorById(this.db, nodeId);
  }

  async getVectorsByIds(
    ids: readonly number[],
  ): Promise<Map<number, Float32Array>> {
    return vecFts.getVectorsByIds(this.db, ids);
  }

  /**
   * 쿼리 텍스트를 임베딩한 뒤 vec0 KNN 검색을 실행한다.
   * 이미 Float32Array 를 가진 경우 searchByVectorRaw 를 직접 호출한다.
   */
  async searchByVector(query: string, k: number): Promise<VectorHit[]> {
    return vecFts.searchByVector(this.db, this.embedder, query, k);
  }

  /**
   * allowedIds 지정 시 KNN 을 `node_id IN (...) AND k = ?` 로 돌려 k 절단이 통과
   * 집합 안쪽에서 일어나게 한다(T4 필터 pushdown). 미지정 = 현행 경로(회귀 0),
   * 빈 배열 = 통과 0건(정직한 빈 결과) — 상세는 vec-fts 자유 함수 JSDoc.
   */
  async searchByVectorRaw(
    queryVec: Float32Array,
    k: number,
    allowedIds?: readonly number[],
  ): Promise<VectorHit[]> {
    return vecFts.searchByVectorRaw(
      this.db,
      this.embedder,
      queryVec,
      k,
      allowedIds,
    );
  }

  /**
   * 프로젝트 스코프 한정 KNN (T16) — 같은 project_id 노드 안에서만 순위화한다.
   * project_id NULL(무소속)도 하나의 스코프. 저장 시 유사-중복 검사가 다른
   * 프로젝트 기억을 후보로 잡지 않게 하는 통로 — 상세는 vec-fts 자유 함수 JSDoc.
   */
  async searchByVectorInProject(
    queryVec: Float32Array,
    k: number,
    projectId: string | null,
  ): Promise<VectorHit[]> {
    return vecFts.searchByVectorInProject(
      this.db,
      this.embedder,
      queryVec,
      k,
      projectId,
    );
  }

  // ── image_vec KNN (Phase 11b T5) ──────────────────────────────────────
  //
  // 이미지 자산 검색 채널 — query 의 SigLIP text 임베딩으로 image_vec(768-dim
  // cosine) 가상 테이블 KNN 을 돌린다. vec_nodes(bge-m3 텍스트 임베딩) 와는
  // *별개 테이블* — 이미지 자산은 11a T3 에서 SigLIP vision tower 출력으로
  // image_vec 에만 색인되었고, retriever step5_imageVec 가 본 메서드 결과를
  // RRF 채널 한 묶음으로 합류시킨다(RRF 코어 시그니처·동작 0 변경).
  //
  // 옛 image-asset.ts(11a T3)의 INSERT 양식 정합:
  //   `INSERT INTO image_vec (node_id, embedding) VALUES (?, ?)`
  // 호출 양식은 vec_nodes 와 동일(sqlite-vec 단일 가상 테이블 KNN 양식)
  // — `WHERE embedding MATCH ? ORDER BY distance LIMIT ?` + `.all(queryVec, k)`.
  // queryVec 는 Float32Array 그대로 전달(JSON.stringify 양식 X).
  //
  // dim 검증: image_vec 는 768-dim 고정(SigLIP 2 base). 텍스트 embedder.dimension
  // 과 다른 모델이므로 본 메서드는 embedder 의 dim 검증을 *안
  // 거친다* — 768 검증은 호출자(getImageVecCandidates)가 SigLIP text encoder
  // 출력 검증 시점에 이미 거친다.

  async searchImageVec(
    queryVec: Float32Array,
    k: number,
  ): Promise<Array<{ nodeId: number; distance: number }>> {
    return vecFts.searchImageVec(this.db, queryVec, k);
  }

  hasImageVecRows(): boolean {
    return vecFts.hasImageVecRows(this.db);
  }

  // ── FTS5 ──────────────────────────────────────────────────────────────

  /**
   * 텍스트 전문 검색 — 두 색인 RRF rank-union (1.1a T2).
   *
   * (1) unicode61 본색인(knowledge_nodes_fts) — 2글자 한국어 검색어를 보호한다
   *     (커피·도구·형제 등). sanitizeFtsQuery 의 전 토큰 prefix OR-join 이 강점.
   * (2) trigram 보조 색인(knowledge_nodes_trgm) — 3글자 이상 합성어 부분 매치를
   *     더한다("변경이유"·"디스코드"). sanitizeTrigramQuery 가 2글자 이하 토큰을
   *     걸러내므로 검색어가 전부 2글자면 빈 쿼리 → 이 색인 조회를 건너뛴다
   *     (trigram 후보 0개 자연 degrade — 에러 아님).
   *
   * 두 색인 결과를 reciprocalRankFusion 으로 순위 합친다([[retriever-fusion-rrf]]
   * 정신 — 두 BM25 스케일이 다르므로 점수 단순 합산이 아니라 순위 융합). 반환
   * FtsHit.score 는 본색인(unicode61) BM25(-rank)를 그대로 채워 호출처 number
   * 계약을 보존한다 — trigram 만 잡은 노드는 0. 두 색인 모두 빈 결과면 [] 반환
   * (빈 결과 = 정상). 색인 테이블이 없는 schema 누락 상태면 prepare/all 단계에서
   * SQLite 가 던지는 구체 에러를 가리지 않는다(mock/fallback 금지).
   */
  async searchByFts(query: string, limit: number): Promise<FtsHit[]> {
    return vecFts.searchByFts(this.db, query, limit);
  }

  /** MemoryStore 계약 메서드: searchByFts 의 tuple 형 별칭. */
  async ftsSearch(
    query: string,
    limit: number,
  ): Promise<Array<[number, number]>> {
    return vecFts.ftsSearch(this.db, query, limit);
  }

  // ── 개념 펼침 (검색 결과 1단계 — 설계 단락 2.2) ───────────────────────
  //
  // 개념 전용 색인 검색("검색어 → 개념 매칭")·결과 펼침 방식은 1.1 검색 통합
  // 에서 만든다. 1.0b 는 직접 연결 엣지를 *조회*하는 재료까지만.

  /** 한 자산 글에 붙은 개념 + role(node_concept_edges JOIN concept_nodes). */
  async getNodeConcepts(
    nodeId: number,
  ): Promise<Array<{ concept: ConceptNode; role: ConceptRole }>> {
    return nodeMeta.getNodeConcepts(this.db, nodeId);
  }

  /**
   * 여러 글의 개념 *이름* 을 한 질의로(T21 index 모드 entities).
   * 상세는 search-repo-node-meta.getNodeConceptNamesByIds(위임 대상).
   */
  getNodeConceptNamesByIds(nodeIds: readonly number[]): Map<number, string[]> {
    return nodeMeta.getNodeConceptNamesByIds(this.db, nodeIds);
  }

  /**
   * 한 개념의 직접 이웃(concept_edges 1단계)을 weight 와 함께 반환한다.
   * 설계 단락 2.2 — "주술회전" 조회 시 직접 연결 개념(만화·고죠 등) 1단계만.
   * 2단계(만화 아래 원피스)는 안 펼친다.
   *
   * Task 19(2026-06-05 Q15 정밀화): concept_edges 양 끝 FK 제거(Task 18)로 이웃이
   * 사람(persons 'psn_')일 수 있다. 옛 `JOIN concept_nodes` 만 하면 psn_ 이웃이
   * 탈락하던 것을 정정한다 — 이웃 id 를 concept_nodes 와 persons 둘 다에서 LEFT
   * JOIN 으로 풀이한 뒤, persons 쪽으로 풀린 사람 이웃은 display_name 으로
   * ConceptNode 모양 행을 합성해 회신한다. 회신 원소가 개념이든 사람이든 호출자가
   * 같은 형(ConceptNode)으로 1-hop 후보·열람에 합류한다.
   *
   * 사람 이웃의 합성 행: conceptId = person_id('psn_'), name = display_name,
   * 나머지 칸은 사람에 없는 개념 속성이라 정직한 default(태그·분류 플래그 0 /
   * alias 빈 배열 / 설명 null). isTag 등은 "이건 개념이 아니다" 를 false 로 표현한다.
   */
  async getConceptDirectNeighbors(
    conceptId: string,
  ): Promise<Array<{ concept: ConceptNode; weight: number }>> {
    return nodeMeta.getConceptDirectNeighbors(this.db, conceptId);
  }

  /**
   * Phase 11b T7 → T10 정착 — image_asset 노드 한 행의 캡션(user + auto) 회수.
   * 상세는 search-repo-node-meta.getImageCaptions(위임 대상).
   */
  getImageCaptions(nodeId: number): { user: string | null; auto: string | null } {
    return nodeMeta.getImageCaptions(this.db, nodeId);
  }

  /**
   * Phase 11b T7 — image_asset 노드 한 행의 학술 분류 태그(category, value) 회수.
   *
   * 흐름 = 옛 11b T1 (`addClassificationTag`) 양식 거꾸로 추적:
   *   1. `node_concept_edges(role='classification')` — nodeId → value concept
   *   2. `hierarchy_edges(relation='parent_of')` — category → value (source = category, target = value · S0-T4 단일 출처)
   *   3. category concept 이름 + value concept 이름 회수
   *
   * 한 SQL JOIN 으로 묶음 — N+1 회피. role='classification' 한정이라 일반 tag 양식 가족
   * (`#태그`) 은 포함 안 됨 (그 가족은 옛 hashtag-tags 통로 = role='tag').
   *
   * 빈 결과(분류 0개) = 빈 배열(정직 — silent fallback 금지). 테이블 누락은 SQLite
   * 구체 에러를 전파한다.
   *
   * @param nodeId image_asset 노드 id (그 외 source_type 호출 시 의도된 무용 — 빈 배열)
   */
  getImageTaggedWith(nodeId: number): Array<{ category: string; value: string }> {
    return nodeMeta.getImageTaggedWith(this.db, nodeId);
  }

  /**
   * 이 글의 node_concept_edges(role='classification') + hierarchy_edges 를 통해
   * "종류" 카테고리 값 이름을 반환한다(단계6 T1a).
   * 없으면 null. kindCategory 는 호출측에서 주입 (단일 출처 glob-field-apply.ts).
   */
  getNodeKind(nodeId: number, kindCategory: string): string | null {
    return nodeMeta.getNodeKind(this.db, nodeId, kindCategory);
  }

  /**
   * 여러 글의 "종류" 분류 값을 한 쿼리로 가져온다(단계6 T1c·N+1 방지).
   * 종류 링크가 있는 글만 Map 에 담는다 — 없는 id 는 키 자체가 없다(가짜 0 금지).
   * 빈 배열이면 즉시 빈 Map 을 돌려 쿼리 진입을 건너뛴다(SQL injection 면역).
   * 한 글에 종류 엣지가 여럿이면 첫 번째 행만 사용(getNodeKind LIMIT 1 정합).
   */
  getNodeKinds(nodeIds: number[], kindCategory: string): Map<number, string> {
    return nodeMeta.getNodeKinds(this.db, nodeIds, kindCategory);
  }

  /**
   * image_caption 자식 노드 id → 부모 image_asset 노드 id 역추적(11e G2-2 / T4).
   * 상세는 search-repo-node-meta.getImageAssetParentOfCaption(위임 대상).
   */
  getImageAssetParentOfCaption(captionNodeId: number): number | null {
    return nodeMeta.getImageAssetParentOfCaption(this.db, captionNodeId);
  }

  /**
   * llm_extract 자식 노드 id → 부모 원본 노드 id 역추적(입력 통로 통합 Task 4).
   * 상세는 search-repo-node-meta.getRawParentOfExtract(위임 대상).
   */
  getRawParentOfExtract(extractNodeId: number): number | null {
    return nodeMeta.getRawParentOfExtract(this.db, extractNodeId);
  }

  /**
   * 여러 image_caption 자식 → 부모 image_asset 을 한 질의로(T21 index 모드 치환).
   * 상세는 search-repo-node-meta.getImageAssetParentsOfCaptions(위임 대상).
   */
  getImageAssetParentsOfCaptions(
    captionNodeIds: readonly number[],
  ): Map<number, number> {
    return nodeMeta.getImageAssetParentsOfCaptions(this.db, captionNodeIds);
  }

  /**
   * 여러 llm_extract 자식 → 부모 원본을 한 질의로(T21 index 모드 치환).
   * 상세는 search-repo-node-meta.getRawParentsOfExtracts(위임 대상).
   */
  getRawParentsOfExtracts(
    extractNodeIds: readonly number[],
  ): Map<number, number> {
    return nodeMeta.getRawParentsOfExtracts(this.db, extractNodeIds);
  }

  /**
   * 검색 결과 노드의 개념 펼침 (1.1a / 갈래 A 표시 / 1.0b spec 단락 4).
   * direct = 노드에 붙은 개념 / neighbors = 그 개념의 직접 이웃 1단계(weight 동반).
   * 2단계는 안 펼친다. admitNeighborEdge 판정은 search-repo-node-meta(위임 대상) 주석.
   */
  async getNodeConceptExpansion(
    nodeId: number,
    admitNeighborEdge?: nodeMeta.ConceptNeighborEdgeAdmission,
  ): ReturnType<typeof nodeMeta.getNodeConceptExpansion> {
    return nodeMeta.getNodeConceptExpansion(this.db, nodeId, admitNeighborEdge);
  }

  // ── 엔티티(개념·프로젝트·사람) 공통 검색 헬퍼 (M-9) ──────────────────────
  //
  // 개념·프로젝트·사람 세 엔티티의 FTS 매칭과 KNN-by-rowid 풀이는 테이블·칼럼
  // 이름만 다른 같은 구조였다(audit M-9 — "가장 위험" 복붙). 한 헬퍼로 합쳐
  // 발산 자체를 없앤다. 테이블/칼럼 인자는 호출처의 리터럴 상수만 받는다
  // (SQL injection 가드 — HTTP 입력 금지). placeholder `?` 바인딩·dim 검증
  // 에러 prefix·rowid 풀이 순서는 추출 전과 byte 동일.
  // ── 개념 매칭 채널 (1.1a T5 / 갈래 A 매칭) ────────────────────────────
  //
  // 검색어를 개념과 매칭해(글자 + 의미) 후보 개념을 찾고, 그 개념에 연결된
  // 자산 글을 retriever 후보 pool 에 합류시킨다. 개념 노드 자체는 검색 결과로
  // 반환하지 않는다 — 개념은 자산 글을 끌어올리는 신호일 뿐(회귀 함정 4).
  // graceful: 색인이 비면 후보 0개로 자연 degrade(에러 아님). 색인 테이블이
  // 없는 schema 누락 상태면 prepare/all 단계 SQLite 에러를 가리지 않는다.

  /** 검색어 → 개념 글자 매칭(concept_nodes_fts trigram). conceptId + score. */
  async searchConceptsByFts(
    query: string,
    limit: number,
  ): Promise<Array<{ conceptId: string; score: number }>> {
    return entityChannel.searchConceptsByFts(this.db, query, limit);
  }

  /**
   * 검색어 → 개념 의미 매칭(concept_vec KNN). conceptId + distance.
   *
   * vec0 KNN 은 LIMIT(=k) 제약을 가상 테이블 조회에 직접 받아야 한다 —
   * JOIN 으로 감싸면 "LIMIT or 'k = ?' constraint is required" 에러가 난다
   * (sqlite-vec 제약 / searchByVectorRaw 와 동일 단일 테이블 KNN 패턴).
   * 그래서 (1) concept_vec 단독 KNN 으로 rowid+distance 를 뽑고 (2) 그 rowid
   * 를 concept_nodes 에서 concept_id 로 풀어, KNN 거리 순서를 보존해 반환한다.
   * graceful: concept_vec 가 비면 KNN 이 [] 를 돌려준다(에러 아님). 색인
   * 테이블이 없는 schema 누락 상태면 prepare/all 단계 SQLite 에러를 가리지 않는다.
   */
  async searchConceptsByVector(
    queryVec: Float32Array,
    k: number,
  ): Promise<Array<{ conceptId: string; distance: number }>> {
    return entityChannel.searchConceptsByVector(this.db, this.embedder, queryVec, k);
  }

  /**
   * 후보 개념 → node_concept_edges → 연결 자산 글 nodeId(중복 제거 / 개념 매칭 점수 순).
   *
   * DCL-3 수정(1.1b T5): 기존 구현은 DISTINCT node_id 를 DB 삽입 순서로 반환해
   * 개념 매칭이 강한 개념에 연결된 글이 임의 위치에 놓였다. 수정 후 동작:
   *
   *   1. 호출처(retriever)는 conceptIds 를 매칭 점수 순으로 전달한다.
   *   2. 여기서는 개념 순서 우선순위(score = conceptIds 에서의 역 인덱스)를 기반으로
   *      한 글이 여러 개념에 연결된 경우 가장 강한 개념의 순위를 따른다.
   *   3. 그 순서로 limit 개를 잘라 반환한다 — SQL LIMIT 가 정렬을 깨지 않는다.
   *
   * 구현 전략: SQL 단일 패스 + JS 정렬. conceptIds 의 순서(0 = 가장 강함)를 우선순위로
   * 쓰고, 동점 시 더 많은 개념에 연결된 글을 우선한다(폭 넓게 잡힌 글이 더 연관성 높음).
   */
  async getNodesByConcepts(
    conceptIds: readonly string[],
    limit: number,
  ): Promise<number[]> {
    return vecFts.getNodesByConcepts(this.db, conceptIds, limit);
  }

  // ── 프로젝트 어휘 (D8 / spec 5.4) ────────────────────────────────────────
  //
  // retriever 가 db 에 직접 접근하지 않도록 facade 위임 통로를 제공한다
  // ([[code-modularization-completed-2026-05-24]] repository facade 정합).

  /**
   * project_vocabularies 에서 (term → expanded_meaning) 매핑을 읽어 반환한다.
   * 빈 결과(행 0) = 빈 Map(자연 degrade). 테이블 누락은 SQLite 구체 에러를 전파한다.
   */
  loadProjectVocab(projectId: string): Map<string, string> {
    return loadProjectVocabFn(this.db, projectId);
  }

  /**
   * 후보 nodeId 목록에 대해 확장 query 와의 단일-doc BM25 점수를 계산한다
   * (1.1b T4 / spec 5.4). bm25-cross.ts 의 순수 함수를 this.db 와 함께 호출.
   * 후보 0개 = 빈 Map. 매치 없는 nodeId = 0.
   */
  async computeBM25Cross(
    expandedQuery: string,
    nodeIds: readonly number[],
  ): Promise<Map<number, number>> {
    return computeBM25CrossFn(this.db, expandedQuery, nodeIds);
  }

  // ── polarity 한정 query 필터 (D7 / spec 5.5 / 1.1c T3) ────────────────────
  //
  // RRF 합산 *전* 후보 pool 을 줄이는 필터다(retriever 가 채널 hits 를 모은 뒤,
  // fusedRrf 진입 전에 이 메서드로 후보 node_id 를 polarity 일치 노드로 제한한다).
  // RRF 동등 합산 코어(rrf.ts)는 건드리지 않는다 — 입력 후보만 줄인다
  // ([[retriever-fusion-rrf]] 동등 합산 불변 / plan 회귀 함정 1).

  /**
   * 후보 node_id 목록에서 polarity 가 일치하는 것만 남긴 Set 을 반환한다.
   *
   * NULL 처리 규칙(plan Mock Policy / 회귀 함정 4): knowledge_nodes.polarity 가
   * NULL 인 노드는 *제외* 한다. polarity 필터를 *지정한* 호출자는 라벨된 자산만
   * 원하므로, NULL 제외는 데이터 누락 마스킹이 아니라 의도된 필터 의미다. body
   * 에 polarity 칸이 *없을* 때(필터 미적용)는 retriever 가 이 메서드를 아예
   * 호출하지 않는다 — 두 경우(미지정 vs NULL)를 호출 여부로 구분한다.
   *
   * graceful: 후보 중 일치 노드가 0개면 빈 Set(에러 아님 / "그 polarity 라벨
   * 자산 없음" = 정직한 빈 상태). 운영 DB 는 현재 write 경로 0건이라 전 노드
   * polarity = NULL — polarity 필터가 거의 전부를 제외하는 것은 (a) 결정(자동
   * 채움 Phase 6 cleanup-AI)의 알려진 귀결이다. 빈 결과를 fallback 으로 채우지 않는다.
   *
   * 결정적 연산 — LLM 호출 0. 단일 SQL 조회(IN + polarity = ?).
   */
  filterNodeIdsByPolarity(
    nodeIds: readonly number[],
    polarity: Polarity,
  ): Set<number> {
    return filters.filterNodeIdsByPolarity(this.db, nodeIds, polarity);
  }

  // ── 학술 분류 필터 (spec 5.7 / 1.1c T4) ───────────────────────────────────
  //
  // polarity 필터(위)와 같은 정신 — RRF 합산 *전* 후보 pool 을 줄이는 필터다.
  // retriever 가 채널 hits 를 모은 뒤 fusedRrf 진입 전에 이 메서드 결과로
  // 후보 node_id 를 분류 매칭 노드로 교집합 제한한다. RRF 동등 합산 코어
  // (rrf.ts)는 건드리지 않는다 — 입력 후보만 줄인다([[retriever-fusion-rrf]]
  // 동등 합산 불변 / plan 회귀 함정 1).
  //
  // getNodesByConcepts(L325) 와 다른 점: 그 메서드는 입력이 concept_id 목록인데,
  // 여기는 입력이 분류 *값 문자열*(예: '만화' / '흰머리토끼귀')이다. spec 5.7
  // line 542 의 `filter.character=흰머리토끼귀` 에서 key('character')는 분류
  // 키이고 value('흰머리토끼귀')가 분류 값이다. spec 5.7 line 545 + 3.5.5
  // line 333 의 통합 핵심은 분류 *값* 이 concept_nodes.name UNIQUE 로 매칭된다는
  // 것 — `review:만화` 분류 필터 검색 시 `#만화` 해시태그 노드도 같은 `만화`
  // concept 노드를 가리킨다(name UNIQUE 자동 통합 / 갈라짐 없음). 자산 글을
  // 가리키는 것은 *값* concept 노드의 node_concept_edges 이므로, 값 문자열로
  // name UNIQUE 매칭한 뒤 그 concept 의 연결 노드를 회수한다. key 는 매칭에
  // 쓰지 않는다 — 같은 값이 여러 키 아래 있어도 같은 노드라 통합되는 것이
  // spec 3.5 의 핵심 정신이다(여러 filter key 의 AND 교집합은 retriever 가 처리).

  /**
   * 분류 *값 문자열* → concept_nodes.name UNIQUE 조회 → 그 concept 에 연결된
   * 자산 node_id 를 role 무관(classification·tag·mention 전부)으로 회수한 Set.
   *
   * role 무관 매칭(spec 3.5.5 line 333): `#만화` 태그(role='tag')와 `review:만화`
   * 분류(role='classification')가 같은 `만화` concept 노드를 가리키므로, 두 통로로
   * 들어간 자산이 한 query 로 둘 다 잡힌다. name UNIQUE 자동 통합 — 별 traversal
   * 없이 같은 이름 = 같은 노드.
   *
   * 입력 값은 findOrCreateConcept 가 저장 시점에 lowercase 정규화한 name 과
   * 맞추려 toLowerCase().trim() 한다(concept-repository.ts L117/L169 정합).
   *
   * graceful: 값에 매칭되는 concept 가 0개면 빈 Set(에러 아님 / "그 분류로 라벨된
   * 자산 없음" = 정직한 빈 상태 / spec 5.7 Mock Policy). 빈 결과를 fallback 으로
   * 채우지 않는다. concept_nodes / node_concept_edges 테이블이 *없는* schema 누락
   * 상태면 prepare/all 단계 SQLite 가 던지는 구체 에러를 가리지 않는다.
   *
   * 결정적 연산 — LLM 호출 0. 단일 JOIN 조회(name 매칭 → node_id).
   */
  getNodeIdsByConceptName(value: string): Set<number> {
    return filters.getNodeIdsByConceptName(this.db, value);
  }

  // ── 글-칸 매칭 (활용 단계6 T4 / 검색 종류·칸 거름망 캡슐) ──────────────────
  //
  // getNodeIdsByConceptName(위) 의 *글-칸* 짝이다. 다른 점: concept name 이 아니라
  // T3b 가 저장한 metadata_json.fields 안의 (키 → 값) 정확 일치로 매칭한다. 검색
  // 캡슐의 fieldFilters(종류별 칸 selector) 가 이 메서드로 후보를 *축소* 한다 —
  // polarity·분류 filter·dateRange 와 같은 RRF 합산 *전* 통과 Set 통로다(가중치가
  // 아니라 후보 축소). RRF 동등 합산 코어(rrf.ts)는 건드리지 않는다.
  //
  // 구현 양식 = deleteBySource(L186~189) / getNeighborChunks(L1253~1260) 선례 정합:
  // bun:sqlite 가 빌드마다 JSON1(json_extract)을 일관되게 싣지 않으므로, metadata_json
  // 에 키·값 부분 문자열로 거친 LIKE 프리필터를 건 뒤 JSON.parse 로 fields[키] === 값
  // 을 정확 검증한다 — 정확성은 parse 단계에 있다(단일 SQL + JS 검증). T3b 는 fields
  // 값을 trim 해 저장하므로(setGlobField), 입력 키·값도 trim 해 양끝 공백 흔들림을 흡수한다.
  //
  // graceful: 매칭 글 0건이면 빈 Set(에러 아님 / "그 칸값 글 없음" = 정직한 빈 상태).
  // 빈 키·빈 값이면 쿼리 진입 전에 빈 Set(SQL 진입 0). knowledge_nodes 테이블이 *없는*
  // schema 누락 상태면 prepare/all 단계 SQLite 구체 에러를 가리지 않는다.

  /**
   * metadata_json.fields.<키> === <값> 인 글 node_id Set 을 반환한다(T4 fieldFilters).
   * 키·값 trim 후 정확 일치. 빈 키·빈 값·매칭 0건이면 빈 Set(정직한 빈 상태).
   */
  getNodeIdsByMetadataField(key: string, value: string): Set<number> {
    return filters.getNodeIdsByMetadataField(this.db, key, value);
  }

  // ── 장소 소프트 검색 점수 (활용 단계4 T1 / search-field-filter D2) ──────────
  //
  // getNodeIdsByConceptName(위) 의 *장소 소프트* 짝이다. 다른 점 둘:
  //   1. 정확 name 매칭이 아니라 부분일치(`c.name LIKE '%값%'`) — 표기 흔들림
  //      ('강남' 검색이 '강남 A마트' 글)을 통째 탈락시키지 않으려는 것이다(D2).
  //   2. Set 이 아니라 Map<node_id, 0..1 점수> — 후보 *축소* 필터가 아니라 step 9
  //      blended 식에 더하는 *소프트 가산* 신호라서다(T3 가 이 점수를 가중치와 곱한다).
  //
  // 장소 leaf 개념 한정: getNodeIdsByConceptName 은 role 무관 전 개념을 매칭하지만,
  // 여기는 *장소* 로 분류된 leaf 개념만 매칭한다. 장소 판정은 metadata-infer-cycle.ts
  // 의 has_place 두 경로 OR 와 동형이다:
  //   경로1(추론/system) — concept→concept 위계: 잎 개념의 parent_of 부모가
  //     is_classification_key=1 AND name='장소' 인 분류 키.
  //   경로2(직접 입력/direct) — entity_concept_edges role='identity' + entities
  //     type_name='place': place 엔티티 행이 직접 짊어진 잎 개념(단계4 T4 통합 엣지로
  //     이전·옛 place_concept_edges 폐기. 통합 테이블은 종류를 안 담아 entities JOIN 으로
  //     type_name='place' 만 거른다).
  // 두 경로 모두 같은 leaf 로 수렴하므로(place-provenance-flow.ts:135) 출처는 안 읽고
  // 잎 이름만 매칭한다(spec — fieldSources 무관).
  //
  // 점수 규칙(결정적·하드코딩 마법수 0): 매칭 leaf 이름과 검색 값의 *길이 비율* —
  //   score = 정규화값.length / leafName.length (값이 잎 이름 부분문자열일 때 0..1).
  // 정확 일치면 length 가 같아 1.0. 부분 일치('강남' ⊂ '강남 a마트')면 < 1.0 으로
  // 짧을수록(덜 구체적) 낮은 점수다. 한 글이 여러 장소 leaf 에 매달리면 가장 높은
  // 점수(가장 정확한 매칭)를 그 글 점수로 쓴다(Math.max).
  //
  // 매칭 점수 마법수는 search-tuning.ts 가 아니라 이 메서드 내부 결정식이다(T1).
  // search-tuning 의 PLACE_SOFT_BOOST_* 가중치(T3)와 *분리* — 여기는 "얼마나 정확히
  // 매칭됐나"(0..1 신호), 거기는 "그 신호를 점수에 얼마나 실을까"(가중치)다.
  //
  // 값 trim().toLowerCase() 정규화(getNodeIdsByConceptName / concept-repository.ts
  // L117·L169 저장 정규화 정합). 빈 값·매칭 0건이면 빈 Map(에러·fallback 값 0 — 정직).
  // 결정적 연산 — LLM 0. 단일 SQL(두 경로 UNION) + JS 점수 계산.

  /**
   * 장소 leaf 개념 이름 부분일치(+ place 두 경로 OR)로 매칭된 글 node_id 마다
   * 0..1 소프트 가산 점수를 담은 Map 을 반환한다(D2). 정확 일치=1.0, 부분 일치는
   * 매칭 길이 비율(< 1.0). 빈 값·매칭 0건이면 빈 Map(정직한 빈 상태).
   */
  searchPlaceNodeScores(value: string): Map<number, number> {
    return filters.searchPlaceNodeScores(this.db, value);
  }

  /**
   * 저장된 장소 leaf 개념 이름 목록을 DISTINCT 로 반환한다(활용 단계4 T4 / D3).
   *
   * searchPlaceNodeScores(위)의 *목록 짝* — 그 메서드가 한 값으로 매칭 글을 찾는다면,
   * 여기는 자연어 신호 추출(resolvePlaceSignal)이 query 안에서 장소 이름을 찾도록
   * *저장된 장소 이름 전부* 를 회신한다. 같은 장소 판정(has_place 두 경로 OR)을 써서
   * 직접 입력(entity_concept_edges role='identity' + entities type_name='place')·추론
   * (concept 위계) 장소를 모두 포함한다(단계4 T4 통합 엣지 이전·옛 place_concept_edges
   * 폐기) — place 엔티티 행만 보는 단순 목록이 추론 장소를 놓치는 한계를 닫는다(D3 leaf 통로).
   *
   * 회신 이름은 concept_nodes.name(저장 시점 toLowerCase 정규화값)이다. 호출자가
   * query 부분일치에 쓰므로 정렬은 *이름 길이 내림차순*(긴 이름 우선 — 구체적 우선)으로
   * 줘 호출자가 가장 긴 매칭을 먼저 만나게 한다(D3 "가장 긴 이름 우선" 보조).
   *
   * 장소 0건이면 빈 배열(정직한 빈 상태 — 에러 아님). 결정적 연산 — LLM 0. 단일 SQL
   * (두 경로 UNION). 검색마다 1회 호출이라 값싸다(장소 수가 코퍼스 글 수보다 훨씬 작음).
   */
  listPlaceLeafNames(): string[] {
    return filters.listPlaceLeafNames(this.db);
  }

  // ── pending_review 검색 비노출 필터 (6a T9.5 / 사용자 결정 #5) ─────────────
  //
  // polarity·학술 분류 필터(위 둘)와 같은 정신 — RRF 합산 *전* 후보 pool 을 줄이는
  // 필터다. 다른 점은 *무조건* 적용이라는 것: opt-in 이 아니라, 검색 시 항상
  // pending_review=true 노드를 후보에서 뺀다. Level 0 정규식 추출이 3~4점 후보를
  // pending_review atomic 노드로 저장하므로(buildRegexMetadata 의
  // metadata.pending_review:true / score-decision.ts), 검토 전 자산이 검색 결과에
  // 섞이지 않게 한다. Phase 7 cleanup-AI 가 검토를 마치면 이 칸을 지워(또는 false 로
  // 바꿔) 자연 노출된다. RRF 동등 합산 코어(rrf.ts)는 건드리지 않는다 — 입력 후보만
  // 줄인다([[retriever-fusion-rrf]] 동등 합산 불변 / plan 회귀 함정 1).

  /**
   * 후보 node_id 목록에서 pending_review 가 *아닌* 노드만 남긴 Set 을 반환한다.
   *
   * `pending_review=true` 인 노드만 제외한다. metadata 에 칸이 없거나(일반 노드·
   * auto_store regex atomic), `false` 이거나, metadata 가 비어 추출값이 NULL 인
   * 노드는 모두 통과한다(`IS NULL OR != true` 정신).
   *
   * JSON boolean 추출 실측(buildRegexMetadata 의 `pending_review: true` →
   * JSON.stringify → boolean true → metadata_json TEXT): SQLite 의
   * `metadata_json->>'$.pending_review'` 는 JSON boolean true 를 *정수 1* 로
   * 추출한다(문자열 'true' 가 아니다 — `->` 가 'true', `->>` 가 1/0). 그래서
   * 제외 조건은 추출값이 정수 1(=JSON true)인 행이다. false 는 0, 없음·빈
   * metadata 는 NULL 로 추출되어 자연 통과한다.
   *
   * 회귀 0 경로(plan 핵심 acceptance): pending_review 노드가 0건인 DB(6a 전 운영
   * 상태 — write 경로가 이 칸을 안 만들었음)에서는 IN 목록의 모든 행이 NULL/0 으로
   * 추출되어 전 후보가 통과한다 → 후보 pool 이 한 노드도 줄지 않고 기존 검색
   * 결과·점수가 완전히 동일하다.
   *
   * 결정적 연산 — LLM 호출 0. 단일 SQL 조회(IN + metadata_json->> 비교).
   */
  filterOutPendingReview(nodeIds: readonly number[]): Set<number> {
    return filters.filterOutPendingReview(this.db, nodeIds);
  }

  /**
   * filterOutPendingReview 의 전역 변형(T4 pushdown) — 후보 목록 없이 전 노드에서
   * pending_review 가 아닌 id 를 선별한다. 판정 규칙 동일, `id IN` 절만 없다.
   */
  selectNodeIdsNotPendingReview(): Set<number> {
    return filters.selectNodeIdsNotPendingReview(this.db);
  }

  /**
   * filterNodeIdsByPolarity 의 전역 변형(T4 적응형 공급) — 후보 목록 없이 전
   * 노드에서 그 polarity id 를 선별한다. NULL 제외 규칙은 후보형과 동일.
   */
  selectNodeIdsByPolarity(polarity: Polarity): Set<number> {
    return filters.selectNodeIdsByPolarity(this.db, polarity);
  }

  // ── 검색 시간 범위 hard filter (Phase 7 갈래 1 / Task 5) ──────────────────
  //
  // polarity·학술 분류·pending_review 필터(위)와 같은 정신 — RRF 합산 *전* 후보
  // pool 을 줄이는 필터다. retriever 가 채널 hits 를 모은 뒤 fusedRrf 진입 전에
  // 이 메서드 결과로 후보 node_id 를 시간 범위 일치 노드로 교집합 제한한다. RRF
  // 동등 합산 코어(rrf.ts)는 건드리지 않는다 — 입력 후보만 줄인다
  // ([[retriever-fusion-rrf]] 동등 합산 불변).
  //
  // 저장 구간 = [시작, 끝]:
  //   시작 = COALESCE(event_at, created_at) — 사건 시작 우선, 미상이면 등록 시각.
  //   끝   = COALESCE(event_until, event_at, created_at) — 종료 우선, 없으면 시작
  //          (순간 일정), 그것도 없으면 등록 시각.
  // 이 fallback 은 "종료·시작 미상이면 등록 시각이 곧 그 사건 시각" 이라는 정직한
  // 근사이지 누락 마스킹이 아니다 — 저장 구간이 검색 구간과 겹치면 잡고, 안 겹치면
  // 정직하게 뺀다. 순간 일정(event_until NULL)은 끝=시작이라 한 점 검색과 같다.

  filterNodeIdsByDateRange(
    nodeIds: readonly number[],
    since: string,
    until: string,
  ): Set<number> {
    return filters.filterNodeIdsByDateRange(this.db, nodeIds, since, until);
  }

  selectNodeIdsByDateRange(
    since: string,
    until: string,
    limit: number,
  ): Set<number> {
    return filters.selectNodeIdsByDateRange(this.db, since, until, limit);
  }

  /**
   * filterNodeIdsByDateRange 의 전역 변형(T4 pushdown) — 후보 목록 없이 *상한 없이*
   * 겹치는 id 전부를 선별한다. 옆 selectNodeIdsByDateRange 와 달리 limit 이 없는
   * 이유는 통과 집합을 자르면 KNN 후보에서 조용히 누락되기 때문이다(자유 함수 JSDoc).
   */
  selectAllNodeIdsByDateRange(since: string, until: string): Set<number> {
    return filters.selectAllNodeIdsByDateRange(this.db, since, until);
  }

  // ── 같은 문서 인접 청크 조회 (14b T1 / 14.5 토대) ──────────────────────────
  //
  // ingest-document.ts 가 긴 문서를 source_type='document_chunk' 노드 N개로
  // 잘라 저장하며, 각 청크 metadata 에 parentId(=원본 document id)·chunkIndex
  // (0,1,2,...)를 넣는다(ingest-document.ts L75~84). 검색 결과로 한 청크만
  // 나오면 앞뒤 맥락이 끊기므로, 14.5 묶기 조립은 같은 문서의 인접 청크를
  // 함께 보여준다. 이 메서드는 그 토대 — 같은 parentId 의 인접 chunkIndex
  // document_chunk 노드를 조회한다.
  //
  // 중심(centerIndex) 청크는 결과에서 *제외* 한다. 묶기 조립(Task 2)에서 중심
  // 청크는 이미 검색 결과 청크로 들고 있고, 이 메서드 결과를 그 위아래에
  // 인접으로 덧붙이기 때문이다. 그래서 [centerIndex - radius, centerIndex +
  // radius] 범위 중 centerIndex 자신만 빼고 반환한다.

  /**
   * 같은 문서(metadata.parentId)의 인접 chunkIndex document_chunk 노드를
   * chunkIndex 오름차순으로 반환한다. 범위는 [centerIndex - radius,
   * centerIndex + radius] 중 중심(centerIndex)을 제외한 것.
   *
   * 매칭 규칙: source_type='document_chunk' 이고 metadata.parentId 가 인자
   * parentId 와 같고, metadata.chunkIndex 가 위 범위에 들고 centerIndex 가
   * 아닌 노드. parentId 에 청크가 없거나 radius 범위에 인접이 없으면 빈
   * 배열(정직한 빈 상태 — 에러 아님).
   *
   * Implementation note(deleteBySource L170~173 선례 정합): JSON1 의
   * json_extract 가 더 깔끔하지만 bun:sqlite 가 빌드마다 JSON1 을 일관되게
   * 싣지 않는다. 그래서 metadata_json 에 대해 parentId 부분 문자열로 거친
   * LIKE 프리필터를 건 뒤(source_type 은 SQL 에서 직접 필터), JSON.parse 로
   * parentId·chunkIndex 를 검증한다 — 정확성은 parse 단계에 있다. 단일 SQL
   * 조회 + JS 검증/정렬. knowledge_nodes 테이블이 *없는* schema 누락 상태면
   * prepare/all 단계에서 SQLite 가 던지는 구체 에러를 가리지 않는다(빈 배열로
   * 위장하지 않음).
   */
  getNeighborChunks(
    parentId: string,
    centerIndex: number,
    radius: number,
  ): NeighborChunk[] {
    return nodeMeta.getNeighborChunks(this.db, parentId, centerIndex, radius);
  }

  // ── 프로젝트·사람 엔티티 검색 3채널 (1.2 T7 / spec 3.4·5) ────────────────────
  //
  // 프로젝트·사람은 knowledge_nodes 의 INTEGER 자산 글이 *아니다* — 별도 1급
  // 테이블(projects / persons)이다. 그래서 이 메서드들이 돌려주는 hit 자체는
  // 검색 결과로 노출하지 않는다. 엔티티 검색은 *통로(conduit)* 다: 검색어가
  // 한 프로젝트·사람을 짚으면, 그 엔티티에 연결된 *자산 글* 을 후보 pool 로
  // 끌어올린다. 자산 글 합류 규칙(개념 채널과 같은 정신):
  //   - 프로젝트 hit → getNodesByProjectId 로 그 project_id 를 가진 글을 끌어온다
  //     (knowledge_nodes.project_id = 프로젝트 직접 연결).
  //   - 사람 hit → 이미 있는 node_person_edges(getNodesByConcepts 의 psn_ 통로)로
  //     그 사람이 언급·작성한 글을 끌어온다.
  // 실제 후보 합류·RRF 합산은 retriever(Task 8) 책임이다 — 이 task 는 *후보를
  // 만들어내는 통로 메서드* 만 제공하고 점수·합산은 한 줄도 건드리지 않는다
  // ([[retriever-fusion-rrf]] 동등 합산 코어 불변).
  //
  // graceful: 색인이 비면 후보 0개로 자연 degrade(에러 아님). 색인 테이블이
  // 없는 schema 누락 상태면 prepare/all 단계 SQLite 에러를 가리지 않는다.

  /**
   * 검색어 → 프로젝트 글자 매칭. projectId + score(분류 단계4 T7'b).
   *
   * 프로젝트 본체가 전용 projects 테이블에서 범용 entities(type_name='project')로
   * 옮겨졌으므로, 옛 projects_fts 대신 범용 색인 entities_fts 를 MATCH 하고 entities
   * 와 JOIN 해 type_name='project' 끝점만 거른다(시그니처·회신 모양 불변 — 호출처
   * retrieve-channels 무접촉). FTS5 는 vec0 와 달리 JOIN 안 MATCH 를 허용한다.
   * 이름은 projectsFts 이나 *내부는 범용 entities_fts 를 type_name='project' 로 필터*
   * 한다(T7'b 통일 — 옛 projects_fts 를 읽는다고 오해 금지). 호출 의미상 이름 유지이고,
   * 사람 A 의 searchPersonsByFts(persons_fts 전용)와 자연 대칭이다(project 만 entities 합류).
   * graceful: 색인이 비면 빈 배열(정직한 빈 상태). 색인 테이블 누락은 SQLite 에러를
   * 가리지 않는다(mock/fallback 금지).
   */
  async searchProjectsByFts(
    query: string,
    limit: number,
  ): Promise<Array<{ projectId: string; score: number }>> {
    return entityChannel.searchProjectsByFts(this.db, query, limit);
  }

  /**
   * 검색어 → 프로젝트 의미 매칭(entities_vec KNN). projectId + distance(분류 단계4 T7'b).
   *
   * 프로젝트 본체가 범용 entities 로 옮겨져 옛 project_summary_vec 대신 범용 색인
   * entities_vec 를 KNN 한다. vec0 는 JOIN 으로 감싸면 "LIMIT or 'k = ?' constraint is
   * required" 에러가 나므로 (1) entities_vec 단독 KNN 으로 rowid+distance 를 뽑고 (2)
   * 그 rowid 를 entities 에서 type_name='project' 로 걸러 project_id 로 풀어 KNN 거리
   * 순서를 보존해 회신한다. KNN 결과에 다른 종류가 섞여 프로젝트가 밀려날 수 있어 k 의
   * 넉넉한 배수만큼 단독 KNN 으로 끌어온 뒤 프로젝트만 골라 k 개로 자른다(under-return
   * 방지). 이름은 projectsByVector 이나 *내부는 범용 entities_vec 를 type_name='project'
   * 로 필터*한다(T7'b 통일 — 옛 project_summary_vec 를 읽는다고 오해 금지·사람 A 의
   * searchPersonsByVector(person_vec 전용)와 대칭). 시그니처·회신 모양 불변(호출처
   * retrieve-channels 무접촉). 차원은
   * embedder.dimension(글 모델 단일 출처)과 일치해야 한다 — 불일치는 throw(silent
   * fallback 금지). graceful: entities_vec 가 비면 KNN 이 [] 를 돌려준다(에러 아님).
   */
  async searchProjectsByVector(
    queryVec: Float32Array,
    k: number,
  ): Promise<Array<{ projectId: string; distance: number }>> {
    return entityChannel.searchProjectsByVector(this.db, this.embedder, queryVec, k);
  }

  /** 검색어 → 사람 글자 매칭(persons_fts trigram). personId + score. */
  async searchPersonsByFts(
    query: string,
    limit: number,
  ): Promise<Array<{ personId: string; score: number }>> {
    return entityChannel.searchPersonsByFts(this.db, query, limit);
  }

  /**
   * 검색어 → 사람 의미 매칭(person_vec KNN). personId + distance.
   * searchProjectsByVector 와 같은 KNN→rowid 풀이 패턴(person_rowid → persons.rowid
   * → person_id). graceful: person_vec 가 비면 KNN 이 [] 를 돌려준다(에러 아님).
   */
  async searchPersonsByVector(
    queryVec: Float32Array,
    k: number,
  ): Promise<Array<{ personId: string; distance: number }>> {
    return entityChannel.searchPersonsByVector(this.db, this.embedder, queryVec, k);
  }

  /**
   * 한 프로젝트(project_id)에 직접 연결된 자산 글 nodeId 목록을 반환한다.
   *
   * 프로젝트 검색 hit 가 자기에 연결된 글을 후보 pool 로 끌어오는 통로다 —
   * 프로젝트·사람은 INTEGER 자산 글이 *아니므로*, 검색어가 프로젝트를 짚으면
   * 그 프로젝트의 글(knowledge_nodes.project_id 일치)을 후보로 합류시킨다.
   * 사람 쪽 대응 통로는 node_person_edges(getNodesByConcepts 의 psn_ 갈래)다.
   * 실제 합류·RRF 는 retriever(Task 8) — 이 메서드는 통로일 뿐 점수 계산 0.
   *
   * graceful: 그 project_id 글이 0개면 빈 배열(정직한 빈 상태 — 에러 아님).
   * knowledge_nodes 테이블 누락은 SQLite 구체 에러를 전파한다(빈 배열 위장 안 함).
   */
  getNodesByProjectId(projectId: string, limit: number): number[] {
    if (!projectId || limit <= 0) return [];
    const rows = this.db
      .query(
        `SELECT id FROM knowledge_nodes WHERE project_id = ? LIMIT ?`,
      )
      .all(projectId, limit) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  /**
   * 한 프로젝트의 참여자 person_id 목록(프로젝트 → 사람 1-hop /
   * entity_relation_edges(participated_by)). 같은 사람이 여러 번 잡혀도 person_id
   * 1개로 묶는다(DISTINCT). graceful: 참여자 0명이면 빈 배열(에러 아님). 테이블
   * 누락은 SQLite 에러 전파.
   */
  getProjectParticipantPersonIds(projectId: string): string[] {
    if (!projectId) return [];
    const rows = this.db
      .query(
        `SELECT DISTINCT target_id AS person_id FROM entity_relation_edges
          WHERE source_type = 'project' AND source_id = ?
            AND target_type = 'person' AND relation = 'participated_by'`,
      )
      .all(projectId) as Array<{ person_id: string }>;
    return rows.map((r) => r.person_id);
  }

  /**
   * 한 사람이 참여한 프로젝트 project_id 목록(사람 → 프로젝트 1-hop /
   * entity_relation_edges(participated_by) 의 반대 방향). getProjectParticipantPersonIds
   * 와 짝인 양방향 통로다. 같은 사람이 한 프로젝트에 여러 번 잡혀도 project_id
   * 1개로 묶는다(DISTINCT). graceful: 참여 프로젝트 0개면 빈 배열(에러 아님).
   */
  getPersonProjectIds(personId: string): string[] {
    if (!personId) return [];
    const rows = this.db
      .query(
        `SELECT DISTINCT source_id AS project_id FROM entity_relation_edges
          WHERE target_type = 'person' AND target_id = ?
            AND source_type = 'project' AND relation = 'participated_by'`,
      )
      .all(personId) as Array<{ project_id: string }>;
    return rows.map((r) => r.project_id);
  }

  // ── memory_type 한정 query 필터 (1.2 / 1.1c filter 가족 정합) ──────────────
  //
  // polarity·학술 분류·시간 범위 필터(위)와 같은 정신 — RRF 합산 *전* 후보
  // pool 을 줄이는 필터다. retriever 가 채널 hits 를 모은 뒤 fusedRrf 진입 전에
  // 이 메서드 결과로 후보 node_id 를 memory_type 일치 노드로 교집합 제한한다.
  // RRF 동등 합산 코어(rrf.ts)는 건드리지 않는다 — 입력 후보만 줄인다
  // ([[retriever-fusion-rrf]] 동등 합산 불변).

  /**
   * 후보 node_id 목록에서 memory_type 이 일치하는 것만 남긴 Set 을 반환한다.
   *
   * filterNodeIdsByPolarity 의 정확한 짝 — 비교 칼럼만 memory_type 이다.
   * knowledge_nodes.memory_type 은 NOT NULL DEFAULT 'fact' 라 항상 값이 있으므로
   * (polarity 의 NULL 제외 같은 미묘함 없음), 단순히 일치 노드만 통과한다.
   *
   * graceful: 후보 중 일치 노드가 0개면 빈 Set(에러 아님 / "그 종류 자산 없음"
   * = 정직한 빈 상태). 빈 결과를 fallback 으로 채우지 않는다.
   *
   * 결정적 연산 — LLM 호출 0. 단일 SQL 조회(IN + memory_type = ?).
   */
  filterNodeIdsByMemoryType(
    nodeIds: readonly number[],
    memoryType: MemoryType,
  ): Set<number> {
    return filters.filterNodeIdsByMemoryType(this.db, nodeIds, memoryType);
  }

  /**
   * filterNodeIdsByMemoryType 의 전역 변형(T4 pushdown) — 후보 목록 없이 전 노드에서
   * 그 종류 id 를 선별한다. idx_kn_memory_type 커버링 색인을 탄다(실측 0.084 ms/5000행).
   */
  selectNodeIdsByMemoryType(memoryType: MemoryType): Set<number> {
    return filters.selectNodeIdsByMemoryType(this.db, memoryType);
  }
}
