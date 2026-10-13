/**
 * SearchMixin — 검색 채널 위임 묶음(facade 분해 C2/store).
 * SearchRepository 위임이 대부분 + 새 종류 검색 facade(EntitiesRepository) +
 * addImageCaption 글루(NodeRepository/EdgeRepository/db). 동작 무변경.
 */

import type {
  ConceptNode,
  ConceptRole,
  MemoryType,
  Polarity,
} from "../../memory/types.ts";
import type {
  EntityFtsHit,
  EntityVectorHit,
  UserEntity,
} from "../store-internal/entities-repository.ts";
import type { FtsHit, VectorHit } from "../store-internal/args-types.ts";
import * as nodeMeta from "../store-internal/search-repo-node-meta.ts";
import type {
  ConceptNeighborEdgeAdmission,
  ImageCaptionCandidates,
} from "../store-internal/search-repo-node-meta.ts";
import { KIND_CATEGORY } from "../../memory/glob-field-apply.ts";
import type { NeighborChunk } from "../../memory/neighbor-chunks.ts";
import type { Constructor, StoreInternals } from "./base.ts";

export function SearchMixin<TBase extends Constructor<StoreInternals>>(
  Base: TBase,
) {
  return class SearchMixed extends Base {
    // ── Vec0 KNN — SearchRepository 위임 ─────────────────────────────────

    async getVectorById(nodeId: number): Promise<Float32Array | null> {
      return this.searchRepo.getVectorById(nodeId);
    }

    async getVectorsByIds(
      ids: readonly number[],
    ): Promise<Map<number, Float32Array>> {
      return this.searchRepo.getVectorsByIds(ids);
    }

    /**
     * Vector search by query text. Embeds the query first, then runs vec0
     * KNN. Use `searchByVectorRaw` if you already have a Float32Array.
     */
    async searchByVector(query: string, k: number): Promise<VectorHit[]> {
      return this.searchRepo.searchByVector(query, k);
    }

    /**
     * vec0 KNN — 선택적 필터 pushdown(T4). allowedIds 를 주면 KNN 이
     * `node_id IN (...) AND k = ?` 형태로 돌아 k 절단이 통과 집합 *안쪽* 에서
     * 일어난다(정답이 전역 상위 k 밖이라 사후 필터가 빈 결과를 내던 결함 해소).
     * 미지정 = 현행 경로(회귀 0) / 빈 배열 = 통과 0건(정직한 빈 결과) — 두 상태를
     * 반드시 구분한다. 상세는 search-repo-vec-fts.ts searchByVectorRaw JSDoc.
     */
    async searchByVectorRaw(
      queryVec: Float32Array,
      k: number,
      allowedIds?: readonly number[],
    ): Promise<VectorHit[]> {
      return this.searchRepo.searchByVectorRaw(queryVec, k, allowedIds);
    }

    /**
     * 프로젝트 스코프 한정 vec0 KNN (T16) — 같은 project_id 안에서만 순위화.
     * project_id NULL(무소속)도 하나의 스코프다. 저장 시 유사-중복 검사가
     * 다른 프로젝트 기억을 후보로 잡아 경계를 넘지 않게 하는 통로.
     */
    async searchByVectorInProject(
      queryVec: Float32Array,
      k: number,
      projectId: string | null,
    ): Promise<VectorHit[]> {
      return this.searchRepo.searchByVectorInProject(queryVec, k, projectId);
    }

    /**
     * image_vec(768-dim SigLIP 2 cosine) KNN — Phase 11b T5.
     * SigLIP text 임베딩으로 이미지 자산 후보를 뽑는다. retriever
     * step5_imageVec → getImageVecCandidates → 본 메서드 통로.
     */
    async searchImageVec(
      queryVec: Float32Array,
      k: number,
    ): Promise<Array<{ nodeId: number; distance: number }>> {
      return this.searchRepo.searchImageVec(queryVec, k);
    }

    hasImageVecRows(): boolean {
      return this.searchRepo.hasImageVecRows();
    }

    // ── FTS5 — SearchRepository 위임 ─────────────────────────────────────

    /**
     * Full-text search by content. Sanitizes the query first (see
     * `sanitizeFtsQuery`) to avoid FTS5 syntax errors on arbitrary user text.
     * Returns `[nodeId, score]` pairs where score is the negated BM25 rank
     * (higher = better).
     */
    async searchByFts(query: string, limit: number): Promise<FtsHit[]> {
      return this.searchRepo.searchByFts(query, limit);
    }

    /** MemoryStore contract method: tuple-shaped alias of `searchByFts`. */
    async ftsSearch(
      query: string,
      limit: number,
    ): Promise<Array<[number, number]>> {
      return this.searchRepo.ftsSearch(query, limit);
    }

    // ── 새 종류 검색 facade — EntitiesRepository 위임(분류 단계3 T5·D14-2) ──────
    //
    // 새 종류 엔티티(entities_fts·entities_vec)의 문자열 키 검색이다. 글 검색
    // searchByFts/searchByVector(정수 nodeId)와 키 공간이 분리돼 있어 짝 타입
    // EntityFtsHit/EntityVectorHit(문자열 entity_id)를 회신한다. RRF 합산은 server
    // 층 retrieve-entities-channel.ts 가 한다 — store(db 층)가 그 채널(memory 층)을
    // import 하면 db→memory→db 순환이 되므로(rrf.ts 의존 방향 주석 정합) store 는
    // 검색 두 메서드만 위임하고 합산은 위 server 층이 호출한다.

    /** 새 종류 entities_fts BM25 — 문자열 entity_id 키. SearchRepository 가 아닌 EntitiesRepository 위임. */
    searchEntitiesByFts(query: string, limit: number): EntityFtsHit[] {
      return this.entitiesRepo.searchEntitiesByFts(query, limit);
    }

    /** 새 종류 entities_vec KNN — 문자열 entity_id 키. queryVec 차원은 글 모델 단일 출처. */
    searchEntitiesByVector(queryVec: number[], k: number): EntityVectorHit[] {
      return this.entitiesRepo.searchEntitiesByVector(queryVec, k);
    }

    /** 새 종류 본체 칸 키(is_column=1 attr_key) DISTINCT 목록 — 3분법 칸 충돌 검사용(T7b). */
    listEntityColumnKeys(): string[] {
      return this.entitiesRepo.listColumnKeys();
    }

    /**
     * 종류 무관 범용 단건 조회(분류 단계4 T4·결정 3) — 옛 8타입 getX 위임을 한 통로로 모은다.
     * entitiesRepo.get(id) 으로 위임한다. typeName 은 호출처 의도를 코드로 드러내고 그래프
     * switch 수렴을 돕는 매개변수일 뿐, 조회 키는 entity_id 단독이다(id 전역 UNIQUE).
     * 미존재 id 면 null. 회신 view 는 medium·createdBy·koAliases 까지 포함한다(전용 테이블
     * 흡수로 종류별 고유 칸이 범용 view 에 노출됨).
     */
    async getEntity(_typeName: string, id: string): Promise<UserEntity | null> {
      return this.entitiesRepo.get(id);
    }

    /**
     * 쿼리 텍스트를 글 모델 embedder 로 임베딩한 Float32Array → number[] 로 회신한다
     * (분류 단계3 T5). 새 종류 검색 별 통로(retrieve-entities-channel)가 entities_vec
     * KNN 입력으로 쓴다 — server 층은 embedder 핸들이 없고 store 가 단일 출처라
     * 여기로 위임한다. 차원은 EMBEDDING_DIMENSIONS 단일 출처(하드코딩 0).
     */
    async embedQuery(query: string): Promise<number[]> {
      const vec = await this.embedder.embed(query);
      return Array.from(vec);
    }

    /**
     * 이 글의 "종류" 분류 값을 반환한다(T1a). 없으면 null.
     * KIND_CATEGORY 는 glob-field-apply.ts 단일 출처.
     */
    getNodeKind(nodeId: number): string | null {
      return this.searchRepo.getNodeKind(nodeId, KIND_CATEGORY);
    }

    /**
     * 여러 글의 "종류" 분류 값을 한 쿼리로 가져온다(단계6 T1c·N+1 방지).
     * KIND_CATEGORY 는 glob-field-apply.ts 단일 출처.
     */
    getNodeKinds(nodeIds: number[]): Map<number, string> {
      return this.searchRepo.getNodeKinds(nodeIds, KIND_CATEGORY);
    }

    /** 한 자산 글에 붙은 개념 + role. */
    async getNodeConcepts(
      nodeId: number,
    ): Promise<Array<{ concept: ConceptNode; role: ConceptRole }>> {
      return this.searchRepo.getNodeConcepts(nodeId);
    }

    /** 한 개념의 직접 이웃 개념(1단계) + weight. */
    async getConceptDirectNeighbors(
      conceptId: string,
    ): Promise<Array<{ concept: ConceptNode; weight: number }>> {
      return this.searchRepo.getConceptDirectNeighbors(conceptId);
    }

    /**
     * 검색 결과 노드의 개념 펼침 — direct + 이웃 1단계(weight) (1.1a T6).
     * admitNeighborEdge 를 주면 이웃 엣지를 출처로 거르고 빠진 항목 수를 함께 준다
     * (WP-B1-03 검색 부가 출력 판정). 상세 = search-repo-node-meta.getNodeConceptExpansion.
     */
    async getNodeConceptExpansion(
      nodeId: number,
      admitNeighborEdge?: ConceptNeighborEdgeAdmission,
    ) {
      return this.searchRepo.getNodeConceptExpansion(nodeId, admitNeighborEdge);
    }

    /**
     * 여러 글의 개념 이름을 한 질의로 모아 nodeId → 이름 배열(T21 index 모드 entities).
     * 개념 없는 글은 Map 에 키 없음(호출자가 빈 배열로 떨어뜨린다 — 가짜 항목 0).
     * 상세 = search-repo-node-meta.getNodeConceptNamesByIds JSDoc.
     */
    getNodeConceptNamesByIds(nodeIds: readonly number[]): Map<number, string[]> {
      return this.searchRepo.getNodeConceptNamesByIds(nodeIds);
    }

    /**
     * image_asset 노드 한 행의 캡션(user + auto) 회수 (11b T7 / T10 정착).
     * 자식 image_caption 노드 source_type + metadata.parentId 매칭. user/auto 구분은
     * metadata.captionRole = 'user' | 'auto'. 자식 노드 0건 시 둘 다 null 정직 회수.
     * 상세 = SearchRepository.getImageCaptions JSDoc.
     */
    getImageCaptions(nodeId: number): { user: string | null; auto: string | null } {
      return this.searchRepo.getImageCaptions(nodeId);
    }

    // ── 검색 부가 출력 출처 판정용 조회(WP-B1-03) ────────────────────────────
    // SearchRepository(search-repository.ts)는 파일 상한 800줄을 이미 넘어 위임 메서드를
    // 더 늘리지 않는다. 아래 두 조회는 그 파일이 하던 위임과 같은 방식으로 자유 함수
    // (search-repo-node-meta.ts)에 db 를 넘겨 바로 위임한다 — 조회 본체는 한 곳뿐이다.

    /**
     * image_asset 캡션 후보를 역할별 최신순으로(노드 id 동반). 검색이 허용된 가장 최신
     * 캡션을 고르는 재료다. 상세 = search-repo-node-meta.getImageCaptionCandidates.
     */
    getImageCaptionCandidates(nodeId: number): ImageCaptionCandidates {
      return nodeMeta.getImageCaptionCandidates(this.db, nodeId);
    }

    /**
     * 부모 id → llm_extract 자식 id 목록을 한 질의로(청크요약 출처 판정). 자식 없는 부모는
     * Map 에 키 없음. 상세 = search-repo-node-meta.getLlmExtractChildIds.
     */
    getLlmExtractChildIds(parentIds: readonly number[]): Map<number, number[]> {
      return nodeMeta.getLlmExtractChildIds(this.db, parentIds);
    }

    /**
     * Phase 11b T10 — VLM 자동 캡션 자식 노드 추가 + parent_of 엣지 + images.has_caption_auto=1.
     *
     * 흐름:
     *  1. NodeRepository.addNode 한 줄 — source_type='image_caption' + content=caption 글 +
     *     metadata.parentId + metadata.captionRole + metadata.asset_sha256. bge-m3 텍스트
     *     임베딩 + vec_nodes 자연 합류 (NodeRepository.addNode 통로).
     *  2. 캡션은 이미지의 파생이다(WP-B1-20T 설계 5.1·D7 — 사용자 캡션 포함). provenance derived
     *     parent_of 로 넘겨, 자식 caption → 부모 image_asset 계보 엣지를 저장소 흡수 규칙이 노드
     *     INSERT 와 같은 트랜잭션에서 쓴다(같은 본문 노드에 흡수되면 그 노드 → 이미지 엣지).
     *  3. images 테이블 has_caption_auto=1 갱신 (captionRole='auto' 한정 — user 양식은 별 칸).
     *     images row 부재 (단위 테스트 양식) 시 UPDATE 가 0 row 영향 — 무해 통과.
     *
     * captionRole='user' 갈래 (사용자 직접 작성 캡션) 흐름은 옵션 — has_caption_auto 갱신
     * 안 하고 노드·엣지 한 묶음 등록. 옛 spec 11.5 안 'auto' 와 'user' 두 양식 분기 정합.
     */
    async addImageCaption(args: {
      parentNodeId: number;
      assetSha256: string;
      caption: string;
      captionRole: "auto" | "user";
    }): Promise<number> {
      const captionNodeId = await this.nodeRepo.addNode({
        content: args.caption,
        memoryType: "fact",
        sourceType: "image_caption",
        importance: 0.5,
        confidence: 0.7,
        platform: "",
        author: "",
        metadata: {
          parentId: args.parentNodeId,
          captionRole: args.captionRole,
          asset_sha256: args.assetSha256,
        },
        provenance: {
          kind: "derived",
          parentId: args.parentNodeId,
          relation: "parent_of",
          edgeProvenance: args.captionRole === "user" ? "user_input" : "image",
        },
      });
      if (args.captionRole === "auto") {
        this.db
          .prepare(
            "UPDATE images SET has_caption_auto = 1 WHERE asset_sha256 = ?",
          )
          .run(args.assetSha256);
      }
      return captionNodeId;
    }

    /**
     * image_asset 노드 한 행의 학술 분류 태그(category, value) 회수 (11b T7).
     * 옛 11b T1 `addClassificationTag` 양식 거꾸로 추적 — role='classification' 한정.
     * 상세 = SearchRepository.getImageTaggedWith JSDoc.
     */
    getImageTaggedWith(nodeId: number): Array<{ category: string; value: string }> {
      return this.searchRepo.getImageTaggedWith(nodeId);
    }

    /**
     * Phase 11e G2-2 (T4) — image_caption 자식 노드 id → 부모 image_asset 노드 id 역추적.
     * parent_of 엣지(자식 → 부모)를 권위로 추적하고 부모가 실제 image_asset 인지 검증한다.
     * 부모 없음(고아 캡션)·부모가 이미지 아님 = null(가짜 부모 안 만듦 — No-fallback).
     * 상세 = SearchRepository.getImageAssetParentOfCaption JSDoc.
     */
    getImageAssetParentOfCaption(captionNodeId: number): number | null {
      return this.searchRepo.getImageAssetParentOfCaption(captionNodeId);
    }

    /**
     * 입력 통로 통합 Task 4 — llm_extract 자식 노드 id → 부모 원본 노드 id 역추적.
     * merged_into 엣지(자식 → 부모)를 권위로 추적하고 부모가 표시 가능한 원본 종류인지
     * 검증한다. 부모 없음·부모가 자식 종류 = null(가짜 부모 안 만듦 — No-fallback).
     * 상세 = SearchRepository.getRawParentOfExtract JSDoc.
     */
    getRawParentOfExtract(extractNodeId: number): number | null {
      return this.searchRepo.getRawParentOfExtract(extractNodeId);
    }

    /**
     * 여러 image_caption 자식 → 부모 image_asset 을 한 질의로(T21 index 모드 치환).
     * 고아 자식은 Map 에 키 없음(가짜 부모 0 — 단건판과 같은 판정 규칙).
     */
    getImageAssetParentsOfCaptions(
      captionNodeIds: readonly number[],
    ): Map<number, number> {
      return this.searchRepo.getImageAssetParentsOfCaptions(captionNodeIds);
    }

    /**
     * 여러 llm_extract 자식 → 부모 원본을 한 질의로(T21 index 모드 치환).
     * 고아 자식은 Map 에 키 없음(가짜 부모 0 — 단건판과 같은 판정 규칙).
     */
    getRawParentsOfExtracts(
      extractNodeIds: readonly number[],
    ): Map<number, number> {
      return this.searchRepo.getRawParentsOfExtracts(extractNodeIds);
    }

    /** 검색어 → 개념 글자 매칭(concept_nodes_fts). conceptId + score (1.1a T5). */
    async searchConceptsByFts(
      query: string,
      limit: number,
    ): Promise<Array<{ conceptId: string; score: number }>> {
      return this.searchRepo.searchConceptsByFts(query, limit);
    }

    /** 검색어 → 개념 의미 매칭(concept_vec KNN). conceptId + distance (1.1a T5). */
    async searchConceptsByVector(
      queryVec: Float32Array,
      k: number,
    ): Promise<Array<{ conceptId: string; distance: number }>> {
      return this.searchRepo.searchConceptsByVector(queryVec, k);
    }

    /** 후보 개념 → 연결 자산 글 nodeId(중복 제거 / 자산 글만 — 1.1a T5). */
    async getNodesByConcepts(
      conceptIds: readonly string[],
      limit: number,
    ): Promise<number[]> {
      return this.searchRepo.getNodesByConcepts(conceptIds, limit);
    }

    /**
     * 후보 node_id 중 polarity 가 일치하는 것만 Set 으로 반환(D7 / spec 5.5 / 1.1c T3).
     * NULL 라벨 노드는 제외(라벨된 자산만 — 의도된 필터 의미). RRF 합산 전 후보 축소용.
     */
    filterNodeIdsByPolarity(
      nodeIds: readonly number[],
      polarity: Polarity,
    ): Set<number> {
      return this.searchRepo.filterNodeIdsByPolarity(nodeIds, polarity);
    }

    /**
     * 분류 값 문자열 → concept_nodes.name UNIQUE → 연결 자산 node_id Set
     * (학술 분류 필터 / spec 5.7 / 1.1c T4). role 무관 매칭(tag·classification·
     * mention 전부) — `#만화` 태그와 `review:만화` 분류가 같은 `만화` concept
     * 노드라 한 query 로 둘 다 잡힌다. RRF 합산 전 후보 교집합 축소용.
     * 매칭 concept 0개 = 빈 Set(정직한 빈 상태). 테이블 누락은 SQLite 구체 에러 전파.
     */
    getNodeIdsByConceptName(value: string): Set<number> {
      return this.searchRepo.getNodeIdsByConceptName(value);
    }

    /**
     * metadata_json.fields.<키> === <값> 인 글 node_id Set(활용 단계6 T4 / 검색 칸
     * 거름망 캡슐). getNodeIdsByConceptName 의 *글-칸* 짝 — concept name 이 아니라
     * T3b 가 저장한 글-칸(키 → 값) 정확 일치로 매칭한다. 검색 캡슐 fieldFilters 가
     * RRF 합산 전 후보를 *축소* 하는 통과 Set 통로(가중치 아님). 키·값 trim 후 정확
     * 일치. 빈 키·빈 값·매칭 0건이면 빈 Set(정직한 빈 상태). RRF 코어·점수식 미접촉.
     */
    getNodeIdsByMetadataField(key: string, value: string): Set<number> {
      return this.searchRepo.getNodeIdsByMetadataField(key, value);
    }

    /**
     * 장소 leaf 개념 이름 부분일치(+ place 두 경로 OR) → 글 node_id 별 0..1 소프트
     * 점수 Map(활용 단계4 T1 / search-field-filter D2). getNodeIdsByConceptName 의
     * *장소 소프트* 짝 — 정확 name·Set 이 아니라 LIKE 부분일치·Map(가산용)이다.
     * '강남' 검색이 '강남 A마트' 글을 점수<1.0 으로 잡아 표기 흔들림을 살린다.
     * 직접 입력(entity_concept_edges role='identity' + entities type_name='place')·추론
     * (concept 위계) 두 통로 모두 매칭(단계4 T4 통합 엣지 이전·옛 place_concept_edges 폐기).
     * 빈 값·매칭 0건이면 빈 Map(정직한 빈 상태). RRF 코어·점수식 미접촉(소프트 신호만).
     */
    searchPlaceNodeScores(value: string): Map<number, number> {
      return this.searchRepo.searchPlaceNodeScores(value);
    }

    /**
     * 저장된 장소 leaf 개념 이름 목록(DISTINCT·이름 길이 내림차순)을 반환한다(활용
     * 단계4 T4 / D3). 자연어 신호 추출(resolvePlaceSignal)이 query 안에서 장소 이름을
     * 부분일치로 찾도록 *저장 장소 이름 전부* 를 회신한다. has_place 두 경로 OR 라
     * 직접 입력·추론 장소를 모두 포함(places 행만 보는 listPlaces 한계 보완). 장소
     * 0건이면 빈 배열(정직한 빈 상태). RRF 코어·점수식 미접촉(읽기 전용 조회).
     */
    listPlaceLeafNames(): string[] {
      return this.searchRepo.listPlaceLeafNames();
    }

    /**
     * 후보 node_id 중 pending_review 가 *아닌* 것만 Set 으로 반환(6a T9.5 / 결정 #5).
     * Level 0 정규식 3~4점 검토 대기 자산(metadata.pending_review=true)을 검색 후보에서
     * 항상 뺀다 — opt-in 아님. 칸 없음·false·NULL 은 통과. RRF 합산 전 후보 축소용.
     * pending_review 0건이면 한 노드도 안 줄어 검색 결과·점수 동일(회귀 0).
     */
    filterOutPendingReview(nodeIds: readonly number[]): Set<number> {
      return this.searchRepo.filterOutPendingReview(nodeIds);
    }

    /**
     * filterOutPendingReview 의 전역 변형(T4 벡터 채널 필터 pushdown) — 후보 목록
     * 없이 전 노드에서 pending_review 가 아닌 id 를 선별한다. pushdown 은 채널을
     * 돌리기 *전* 에 통과 집합을 알아야 하므로 후보를 받는 짝으로는 계산이 불가능하다.
     * 판정 규칙(칸 없음·false·NULL 통과 / true 만 제외)은 후보형과 글자 동일.
     */
    selectNodeIdsNotPendingReview(): Set<number> {
      return this.searchRepo.selectNodeIdsNotPendingReview();
    }

    /**
     * filterNodeIdsByPolarity 의 전역 변형(T4 통과 집합 적응형 공급) — 후보 목록
     * 없이 전 노드에서 그 polarity id 를 선별한다. NULL 라벨 제외 규칙은 후보형과
     * 글자 동일(라벨된 자산만 — 의도된 필터 의미).
     */
    selectNodeIdsByPolarity(polarity: Polarity): Set<number> {
      return this.searchRepo.selectNodeIdsByPolarity(polarity);
    }

    /**
     * 후보 node_id 중 COALESCE(event_at, created_at) 가 [since, until] 닫힌 구간에
     * 드는 것만 Set 으로 반환(Phase 7 갈래 1 / Task 5). 검색어의 닫힌 시간 표현
     * ("지난주"·"5월")을 eventDateRange 가 푼 범위로 후보를 거른다. event_at 미상이면
     * created_at 으로 fallback(정직한 근사). 상한은 date(until,'+1 day') 미만으로
     * created_at 의 시각 성분까지 포함한다. RRF 합산 전 후보 교집합 축소용 — RRF
     * 동등 합산 코어는 불변([[retriever-fusion-rrf]]).
     */
    filterNodeIdsByDateRange(
      nodeIds: readonly number[],
      since: string,
      until: string,
    ): Set<number> {
      return this.searchRepo.filterNodeIdsByDateRange(nodeIds, since, until);
    }

    /**
     * 저장 구간이 [since, until] 닫힌 구간과 겹치는 글 node_id 를 후보 없이 전
     * 노드에서 직접 선별한 Set 으로 반환한다(활용 단계5 T2 / compute-path D3).
     * filterNodeIdsByDateRange 의 출발 집합 짝 — 계산 경로에서 칸이 날짜 하나뿐일
     * 때 후보 자체를 만든다. limit 으로 집계 폭주를 가드(가장 최근 글부터). 범위
     * 일치 0개면 빈 Set(정직한 빈 상태). RRF 코어·점수식 미접촉(읽기 전용 조회).
     */
    selectNodeIdsByDateRange(
      since: string,
      until: string,
      limit: number,
    ): Set<number> {
      return this.searchRepo.selectNodeIdsByDateRange(since, until, limit);
    }

    /**
     * filterNodeIdsByDateRange 의 전역 변형(T4 pushdown) — 후보 목록 없이 *상한 없이*
     * 겹치는 id 전부를 선별한다. 바로 위 selectNodeIdsByDateRange 와 이름이 비슷하지만
     * limit 유무가 결정적 차이다: 저쪽은 계산 경로의 출발 집합이라 "최근 N개"로 잘라도
     * 되지만, pushdown 통과 집합은 자르면 그 id 가 KNN 후보에서 조용히 사라진다.
     */
    selectAllNodeIdsByDateRange(since: string, until: string): Set<number> {
      return this.searchRepo.selectAllNodeIdsByDateRange(since, until);
    }

    /**
     * 같은 문서(metadata.parentId)의 인접 chunkIndex document_chunk 노드를
     * chunkIndex 오름차순으로 반환(14b T1 / 14.5 토대). 범위는 [centerIndex -
     * radius, centerIndex + radius] 중 중심(centerIndex) 제외 — 묶기 조립이
     * 중심 청크를 이미 검색 결과로 들고 있어 인접만 위아래로 덧붙이기 위함.
     * source_type='document_chunk' 만 매칭. 없는 parentId·인접 0개 = 빈 배열
     * (정직한 빈 상태). 테이블 누락은 SQLite 구체 에러를 전파한다.
     */
    getNeighborChunks(
      parentId: string,
      centerIndex: number,
      radius: number,
    ): NeighborChunk[] {
      return this.searchRepo.getNeighborChunks(parentId, centerIndex, radius);
    }

    // ── 프로젝트·사람 엔티티 검색 3채널 (1.2 T7) ─────────────────────────────────
    // 엔티티 hit 는 검색 결과로 노출하지 않는다 — 연결 자산 글을 후보 pool 로
    // 끌어오는 *통로* 다. 실제 합류·RRF 는 retriever(Task 8). 상세 = SearchRepository.

    /** 검색어 → 프로젝트 글자 매칭(범용 entities_fts·type_name='project' 필터·T7'b). projectId + score. */
    async searchProjectsByFts(
      query: string,
      limit: number,
    ): Promise<Array<{ projectId: string; score: number }>> {
      return this.searchRepo.searchProjectsByFts(query, limit);
    }

    /** 검색어 → 프로젝트 의미 매칭(범용 entities_vec KNN·type_name='project' 필터·T7'b). projectId + distance. */
    async searchProjectsByVector(
      queryVec: Float32Array,
      k: number,
    ): Promise<Array<{ projectId: string; distance: number }>> {
      return this.searchRepo.searchProjectsByVector(queryVec, k);
    }

    /** 검색어 → 사람 글자 매칭(persons_fts). personId + score (1.2 T7). */
    async searchPersonsByFts(
      query: string,
      limit: number,
    ): Promise<Array<{ personId: string; score: number }>> {
      return this.searchRepo.searchPersonsByFts(query, limit);
    }

    /** 검색어 → 사람 의미 매칭(person_vec KNN). personId + distance (1.2 T7). */
    async searchPersonsByVector(
      queryVec: Float32Array,
      k: number,
    ): Promise<Array<{ personId: string; distance: number }>> {
      return this.searchRepo.searchPersonsByVector(queryVec, k);
    }

    /**
     * 한 프로젝트(project_id)에 직접 연결된 자산 글 nodeId 목록(1.2 T7). 프로젝트
     * 검색 hit 가 자기 글(knowledge_nodes.project_id 일치)을 후보로 끌어오는 통로.
     * 글 0개 = 빈 배열(정직한 빈 상태). 테이블 누락은 SQLite 구체 에러 전파.
     */
    getNodesByProjectId(projectId: string, limit: number): number[] {
      return this.searchRepo.getNodesByProjectId(projectId, limit);
    }

    /**
     * 한 프로젝트의 참여자 person_id 목록(프로젝트 → 사람 1-hop / 1.2 T7).
     * getPersonProjectIds 와 짝인 양방향 통로. 참여자 0명 = 빈 배열.
     */
    getProjectParticipantPersonIds(projectId: string): string[] {
      return this.searchRepo.getProjectParticipantPersonIds(projectId);
    }

    /**
     * 한 사람이 참여한 프로젝트 project_id 목록(사람 → 프로젝트 1-hop / 1.2 T7).
     * getProjectParticipantPersonIds 의 반대 방향. 참여 프로젝트 0개 = 빈 배열.
     */
    getPersonProjectIds(personId: string): string[] {
      return this.searchRepo.getPersonProjectIds(personId);
    }

    /**
     * 후보 node_id 중 memory_type 이 일치하는 것만 Set 으로 반환(1.2 / 1.1c filter 가족).
     * filterNodeIdsByPolarity 의 짝 — 비교 칼럼만 memory_type. NOT NULL DEFAULT 'fact'
     * 라 NULL 미묘함 없음. RRF 합산 전 후보 교집합 축소용 — RRF 동등 합산 코어 불변.
     */
    filterNodeIdsByMemoryType(
      nodeIds: readonly number[],
      memoryType: MemoryType,
    ): Set<number> {
      return this.searchRepo.filterNodeIdsByMemoryType(nodeIds, memoryType);
    }

    /**
     * filterNodeIdsByMemoryType 의 전역 변형(T4 pushdown) — 후보 목록 없이 전
     * 노드에서 그 종류 id 를 선별한다. idx_kn_memory_type 커버링 색인을 타서 세
     * 전역 조회 중 가장 싸다(실측 0.084 ms / 5000행).
     */
    selectNodeIdsByMemoryType(memoryType: MemoryType): Set<number> {
      return this.searchRepo.selectNodeIdsByMemoryType(memoryType);
    }

    /**
     * project_vocabularies 에서 (term → expanded_meaning) 매핑을 읽는다(D8 / spec 5.4).
     * retriever 가 db 를 직접 접근하지 않도록 이 facade 통로를 쓴다.
     * 빈 결과 = 빈 Map(자연 degrade). 테이블 누락은 SQLite 구체 에러를 전파한다.
     */
    loadProjectVocab(projectId: string): Map<string, string> {
      return this.searchRepo.loadProjectVocab(projectId);
    }

    /**
     * 후보 nodeId 목록에 대해 확장 query 와의 단일-doc BM25 점수를 계산한다
     * (1.1b T4 / spec 5.4). retriever 가 db 를 직접 접근하지 않도록 이 facade
     * 통로를 쓴다. 후보 0개 = 빈 Map. 매치 없는 nodeId = 0.
     */
    async computeBM25Cross(
      expandedQuery: string,
      nodeIds: readonly number[],
    ): Promise<Map<number, number>> {
      return this.searchRepo.computeBM25Cross(expandedQuery, nodeIds);
    }
  };
}
