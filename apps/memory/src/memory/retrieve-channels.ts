/**
 * retrieve-channels — HybridRetriever 채널 수집 자유 함수(H-3 분해 후속).
 *
 * retrieve() 가 부르던 채널 수집 4개(개념·image_vec·프로젝트·사람)를 클래스 private
 * 메서드에서 store 를 첫 인자로 받는 export 자유 함수로 옮겼다. retriever.ts 가 800줄
 * 하드 천장을 넘어 채널 로직을 별도 파일로 분리한다 — 점수 조립 루프는 안 건드린다.
 *
 * 동작 보존(behavior-preserving): 함수 본체 로직·주석은 옛 메서드와 byte 동일하다
 * (this.store → store 치환만). 동작 0 변경. RRF 점수식 코어(rrf.ts·scoring.ts·
 * search-tuning.ts·calibration.ts)는 한 글자도 안 건드린다.
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import type { ResolvedRetrieveConfig } from "./retrieve-config.ts";
import { getImageVecCandidates } from "./image-vec-channel.ts";
import { embedQuerySiglipText } from "../embedding/siglip2-text.ts";
import {
  DEFAULT_CONCEPT_FTS_LIMIT,
  DEFAULT_CONCEPT_VECTOR_K,
  DEFAULT_CONCEPT_NODE_LIMIT,
  PARENT_OF_EXPANSION_MIN_WEIGHT,
  PARENT_OF_EXPANSION_LIMIT,
  ENTITY_RELATION_EXPANSION_LIMIT,
  DEFAULT_PROJECT_FTS_LIMIT,
  DEFAULT_PROJECT_VECTOR_K,
  DEFAULT_PERSON_FTS_LIMIT,
  DEFAULT_PERSON_VECTOR_K,
  DEFAULT_PROJECT_NODE_LIMIT,
} from "./retrieve-constants.ts";

/**
 * 개념 채널 수집(H-3 분해 — 옛 retrieve() step 3.5 블록 byte 동일). query → 개념
 * (글자+의미 매칭) → llm_relation 1-hop 펼침 + has_attribute 사람 펼침 + parent_of
 * transitive 펼침 → 연결 자산 글. store 접근이 필요해 store 를 첫 인자로 받는다.
 * mask.concept 가 false 면 빈 배열을 회신한다(옛 `if (mask.concept)` 가드 양식).
 *
 * 개념 글자 채널 = ftsQuery(baseQuery+synonym 확장) / 개념 의미 채널 = queryVec
 * (baseQuery 임베딩 = project 확장 포함 / synonym 은 합류 X). graceful: 개념 색인이
 * 비면 후보 0개로 자연 degrade.
 *
 * DCL-3 수정(T5): 개념 후보를 매칭 점수 순으로 정렬해 getNodesByConcepts 에 전달한다.
 * 글자 먼저(rank = score 내림차순) + 의미 보강(distance 오름차순). Set 대신 점수
 * 가중 정렬로 합집합을 구성해 개념 매칭 강도를 보존한다.
 */
export async function collectConceptChannel(
  store: SqliteMemoryStore,
  ftsQuery: string,
  queryVec: Float32Array,
  config: ResolvedRetrieveConfig,
): Promise<number[]> {
  if (!config.mask.concept) return [];

  // project expansion 이 두 채널 다 합류하는 것은 spec 5.4 의 의도된 동작.
  const [cFts, cVec] = await Promise.all([
    store.searchConceptsByFts(ftsQuery, DEFAULT_CONCEPT_FTS_LIMIT),
    store.searchConceptsByVector(queryVec, DEFAULT_CONCEPT_VECTOR_K),
  ]);

  // DCL-3: 개념 후보를 매칭 점수 순으로 정렬해 합집합 구성.
  // 점수 표준화: FTS score(높을수록 강함) / Vec distance(낮을수록 강함).
  // 글자 채널 우선, 글자에 없는 의미 채널 뒤에 추가(중복 제거).
  // 이미 cFts/cVec 각각이 내부적으로 점수 순 정렬됨 → 그 순서를 유지.
  const conceptIdSet = new Set<string>();
  const conceptIdsOrdered: string[] = [];
  for (const h of cFts) {
    if (!conceptIdSet.has(h.conceptId)) {
      conceptIdSet.add(h.conceptId);
      conceptIdsOrdered.push(h.conceptId);
    }
  }
  for (const h of cVec) {
    if (!conceptIdSet.has(h.conceptId)) {
      conceptIdSet.add(h.conceptId);
      conceptIdsOrdered.push(h.conceptId);
    }
  }

  // Phase 7 둘째 단계 Task 15 — 개념 채널 llm_relation 1-hop 펼침(후보 pool 확장 /
  // RRF 코어 0줄). 강한 모델이 발굴해 concept_edges 에 relation='llm_relation' 으로
  // 넣은 관계 엣지를 따라, 검색어가 직접 잡은 개념(conceptIdsOrdered)의 1-hop 이웃
  // 개념도 후보 개념에 더한다. getConnectedNodes BFS 는 knowledge_edges 만 보므로
  // 개념 엣지 자동 합류가 안 통한다 — 이 개념 채널 한 단계 펼침이 spec §4.4·§5.2 의
  // 실제 검색 합류 좌표다. parent_of 위계는 따라가지 않는다(llm_relation 한정 / 갈래
  // 분리). 이웃은 getNodesByConcepts 에 더해 글 노드로 풀린다 — 즉 *합산 전*
  // 후보 pool 만 커진다(가중치 아님).
  //
  // Task 19(2026-06-05 Q15) 합류 완료: 이웃이 사람(psn_)이면 getLlmRelationNeighbor
  // ConceptIds 가 그 psn_ id 를 그대로 회신하고(Task 18 FK 완화 정합), getNodesBy
  // Concepts 가 psn_ 후보를 node_person_edges 로도 풀어 사람 끝 글 노드까지 후보
  // pool 에 합류한다. 즉 1-hop 펼침이 사람·개념 양 끝을 모두 따라간다. 펼친 이웃
  // 0건이면 conceptIdsOrdered 가 안 변해 검색 결과·점수·순서가 펼침 도입 전과 byte
  // 동일하다(회귀 0 핵심).
  //
  // 직접 매칭 개념만 펼침의 seed 로 쓴다(1-hop 한도 — 펼친 이웃을 다시 펼치지 않음).
  // conceptIdSet 중복 가드로 이미 후보인 개념·다른 seed 가 가리킨 같은 이웃이 두 번
  // 안 더해진다(순서 보존 = 직접 매칭 먼저 / 1-hop 이웃 뒤).
  const directMatchedConceptIds = [...conceptIdsOrdered];
  for (const seedConceptId of directMatchedConceptIds) {
    const neighbors =
      store.getLlmRelationNeighborConceptIds(seedConceptId);
    for (const neighborId of neighbors) {
      if (!conceptIdSet.has(neighborId)) {
        conceptIdSet.add(neighborId);
        conceptIdsOrdered.push(neighborId);
      }
    }
  }

  // 1.2 T8 (spec 5.6) — 직업·회사 같은 공유 특성("개발자")은 *개념 채널* 을
  // 통해 사람 끝으로 펼친다. 검색어가 직접 잡은 개념(directMatchedConceptIds)에
  // has_attribute 로 이어진 사람들(getPersonsByAttributeConcept → psn_ id)을
  // 후보 개념 목록에 더한다. getNodesByConcepts 가 psn_ id 를 node_person_edges
  // 로 풀어 그 사람들의 글을 후보 글 노드에 합류한다(Task 19 psn_ 통로 재활용).
  // 즉 "개발자" 개념에 닿는 검색이 그 라벨을 가진 사람들의 글을 끌어온다.
  //
  // 이 합류는 llm_relation 1-hop 펼침(getLlmRelationNeighborConceptIds)과 갈래가
  // 분리된다 — 그쪽은 LLM 이 발굴한 의미 관계라 불변식 그대로 두고(회귀 함정 3),
  // has_attribute 는 별도 통로로 더한다. 직접 매칭 개념만 seed 로 쓴다(1-hop
  // 한도). has_attribute 사람 0명이면 conceptIdsOrdered 가 안 변해 검색 결과가
  // 펼침 도입 전과 byte 동일하다(회귀 0). conceptIdSet 중복 가드로 같은 psn_ id
  // 가 두 번 안 더해진다.
  for (const seedConceptId of directMatchedConceptIds) {
    const attrPersonIds =
      store.getPersonsByAttributeConcept(seedConceptId);
    for (const personId of attrPersonIds) {
      if (!conceptIdSet.has(personId)) {
        conceptIdSet.add(personId);
        conceptIdsOrdered.push(personId);
      }
    }
  }

  // spec §4.1 A2·A3 — 콜론 위계 parent_of transitive 펼침(후보 pool 확장 / RRF
  // 코어 0줄). 검색어가 직접 잡은 개념(directMatchedConceptIds)을 seed 로,
  // getHierarchyChildrenTransitive 가 weight ≥ 0.7 인 parent_of 자식을 사슬 끝까지
  // (downward only) BFS 깊이 순으로 회신한다. 그 순서를 그대로 conceptIdsOrdered
  // 뒤에 더해 가까운 자식이 먼저·먼 자식이 뒤로 가게 한다 — getNodesByConcepts 의
  // 매칭 강도 정렬(DCL-3)이 순서로만 깊이 감쇠를 만든다(A3 / 가중치 채널 신설 0).
  // 메서드 한 번 호출로 transitive 를 책임지므로 retriever 는 직접 매칭만 seed 로
  // 건다(펼친 자식을 다시 seed 로 안 씀). conceptIdSet 중복 가드로 이미 후보인
  // 개념·다른 펼침(llm_relation·has_attribute)이 가리킨 같은 개념이 두 번 안
  // 더해진다. 펼친 자식 0건이면 conceptIdsOrdered 가 안 변해 검색 결과·점수·순서가
  // 펼침 도입 전과 byte 동일하다(회귀 0 — 기존 두 펼침 불변식 양식 그대로).
  const parentChildren = store.getHierarchyChildrenTransitive(
    directMatchedConceptIds,
    PARENT_OF_EXPANSION_MIN_WEIGHT,
    PARENT_OF_EXPANSION_LIMIT,
  );
  for (const childId of parentChildren) {
    if (!conceptIdSet.has(childId)) {
      conceptIdSet.add(childId);
      conceptIdsOrdered.push(childId);
    }
  }

  // getNodesByConcepts 에 점수 순 conceptIds 를 전달 — DB 내부에서 이 순서로
  // 개념 매칭 강도를 기반한 정렬을 수행(DCL-3 수정 완료).
  const conceptNodeIds = await store.getNodesByConcepts(
    conceptIdsOrdered,
    DEFAULT_CONCEPT_NODE_LIMIT,
  );

  // 4단계 Task 5 — 엔티티 관계 1-hop 펼침(후보 pool 확장 / RRF 코어 0줄). 위
  // llm_relation·has_attribute·parent_of 펼침과 같은 지점·같은 방식이다(가중치 채널
  // 신설 아님 — getNodesByConcepts 가 푼 글 노드 뒤에 관계 이웃 글을 *더한다*).
  //
  // 검색어가 직접 잡은 개념(directMatchedConceptIds)을 identity 로 가진 엔티티 행을
  // seed 로 뽑아(getEntitySeedsByConcepts), 그 seed 에서 entity_relation_edges 로
  // 이어진 target + 같은 target 을 공유하는 다른 source 의 글을 끌어온다(깊이 1 고정).
  // 예: '데못죽' 검색 → 작품 행 wrk_demotjuk seed → created_by 아쿠타미(target) →
  // 같은 아쿠타미를 가진 주술회전(다른 source) → 주술회전 글이 후보 pool 에 합류.
  //
  // seed 직접 매칭 글(conceptNodeIds)이 앞·관계 이웃 글이 뒤로 가 매칭 강도가 자연히
  // 약화한다(가중치 조작 0). 직접 잡은 개념에 엔티티 행이 안 걸리거나 관계 이웃이
  // 0개면 conceptNodeIds 가 그대로라 검색 결과·점수·순서가 펼침 도입 전과 byte
  // 동일하다(회귀 0 핵심 — 기존 세 펼침 불변식 양식 그대로). 중복 글은 제거한다.
  const relationSeeds = store.getEntitySeedsByConcepts(directMatchedConceptIds);
  if (relationSeeds.length === 0) return conceptNodeIds;

  const relatedNodeIds = store.getRelatedEntityNodeIds(
    relationSeeds,
    ENTITY_RELATION_EXPANSION_LIMIT,
  );
  if (relatedNodeIds.length === 0) return conceptNodeIds;

  const seenNode = new Set(conceptNodeIds);
  const merged = [...conceptNodeIds];
  for (const id of relatedNodeIds) {
    if (seenNode.has(id)) continue;
    seenNode.add(id);
    merged.push(id);
  }
  return merged;
}

/**
 * image_vec 채널 수집(H-3 분해 — 옛 retrieve() step 3.7 블록 byte 동일). Phase 11b
 * T5. SigLIP text encoder 로 검색어 임베딩 후 image_vec(768-dim cosine) KNN 으로
 * 이미지 자산 후보를 뽑는다. 모델 미가용 / 빈 검색어 = null 회신 → 빈 후보 → RRF
 * 안 0 기여(graceful degrade / disabled-state — silent fallback X). mask.imageVec
 * 가 끄면 빈 후보 + 빈 magnitude 를 회신한다(옛 `if (maskImageVec)` 가드 양식).
 * graph seed 와 무관한 독립 채널. query 는 *원본* 사용(synonym·project expansion
 * 미합류) — SigLIP 임베딩 공간은 자연어 의미 기반이라 동의어 확장이 별 의미 없고,
 * ftsQuery 안 trigram 토큰 같은 신호가 섞이면 매칭 흐려진다.
 *
 * magnitude 맵은 *반드시* 회신한다 — 후처리 루프의 imageVecMagnitude(vectorRaw
 * Cosine 짝)와 survivingImageVecMag 가 읽는다. T2(강도-반영 융합)의 원시 cosine
 * 강도 노출: getImageVecCandidates 가 이미 distance → score(= 1 - distance =
 * cosine 강도 / image-vec-channel.ts:26)로 변환해 두므로 nodeId 만 남기기 *전*
 * candidate.score 를 그대로 맵에 보존한다. *이 task 는 데이터만 노출한다 — 점수
 * 계산엔 안 쓴다(T4 가 정밀 점수에 사용).*
 */
export async function collectImageVecChannel(
  store: SqliteMemoryStore,
  query: string,
  config: ResolvedRetrieveConfig,
): Promise<{ ids: number[]; magnitude: Map<number, number> }> {
  const imageVecMagnitude = new Map<number, number>();
  if (!config.mask.imageVec) {
    return { ids: [], magnitude: imageVecMagnitude };
  }
  if (!store.hasImageVecRows()) {
    return { ids: [], magnitude: imageVecMagnitude };
  }
  const siglipQueryVec = await embedQuerySiglipText(query);
  const candidates = await getImageVecCandidates(
    store,
    siglipQueryVec,
    config.imageVecK,
  );
  for (const c of candidates) imageVecMagnitude.set(c.nodeId, c.score);
  return { ids: candidates.map((c) => c.nodeId), magnitude: imageVecMagnitude };
}

/**
 * 프로젝트 엔티티 채널 수집(H-3 분해 — 옛 retrieve() step 3.8 블록 byte 동일).
 * 1.2 T8. 검색어 → 프로젝트(글자+의미 매칭) → 그 프로젝트의 글(getNodesByProjectId)
 * + 참여자 글(getProjectParticipantPersonIds → 그 psn_ id 를 getNodesByConcepts 가
 * node_person_edges 로 풀이). graph seed 와 무관한 독립 채널 — concept·imageVec
 * 양식 정합. 글자 채널은 ftsQuery, 의미 채널은 queryVec(baseQuery 임베딩) 사용.
 * mask.project 가 끄면 빈 배열을 회신한다(옛 `if (maskProject)` 가드 양식).
 * graceful: projects 색인이 비면 후보 0개로 자연 degrade(silent fallback X — 빈
 * 색인이 정직한 빈 결과). 빈 배열이면 RRF 안 0 기여라 검색 결과가 도입 전과 byte
 * 동일하다(회귀 0).
 */
export async function collectProjectChannel(
  store: SqliteMemoryStore,
  ftsQuery: string,
  queryVec: Float32Array,
  config: ResolvedRetrieveConfig,
): Promise<number[]> {
  if (!config.mask.project) return [];

  const [pFts, pVec] = await Promise.all([
    store.searchProjectsByFts(ftsQuery, DEFAULT_PROJECT_FTS_LIMIT),
    store.searchProjectsByVector(queryVec, DEFAULT_PROJECT_VECTOR_K),
  ]);
  // 글자·의미 매칭 프로젝트 id 합집합(중복 제거 / 순서 = 글자 먼저).
  const projectIdSet = new Set<string>();
  for (const h of pFts) projectIdSet.add(h.projectId);
  for (const h of pVec) projectIdSet.add(h.projectId);

  // 프로젝트 → 자기 글 + 참여자 글. 참여자 psn_ id 는 getNodesByConcepts 가
  // node_person_edges 로 풀어 사람 끝 글까지 합류한다(개념 채널 psn_ 통로 재활용).
  const projectNodeIdSet = new Set<number>();
  const participantPersonIds: string[] = [];
  const participantSeen = new Set<string>();
  for (const projectId of projectIdSet) {
    for (const nodeId of store.getNodesByProjectId(
      projectId,
      DEFAULT_PROJECT_NODE_LIMIT,
    )) {
      projectNodeIdSet.add(nodeId);
    }
    for (const personId of store.getProjectParticipantPersonIds(
      projectId,
    )) {
      if (!participantSeen.has(personId)) {
        participantSeen.add(personId);
        participantPersonIds.push(personId);
      }
    }
  }
  if (participantPersonIds.length > 0) {
    for (const nodeId of await store.getNodesByConcepts(
      participantPersonIds,
      DEFAULT_PROJECT_NODE_LIMIT,
    )) {
      projectNodeIdSet.add(nodeId);
    }
  }
  return [...projectNodeIdSet];
}

/**
 * 사람 엔티티 채널 수집(H-3 분해 — 옛 retrieve() step 3.9 블록 byte 동일). 1.2 T8.
 * 검색어 → 사람(글자+의미 매칭) → 그 사람의 글(node_person_edges, getNodesByConcepts
 * 의 psn_ 통로) + 참여 프로젝트 글(getPersonProjectIds → getNodesByProjectId).
 * 프로젝트 채널의 거울. 직업·회사 같은 공유 특성("개발자")은 *개념 채널* 의
 * has_attribute 갈래로 들어가니 이 사람 채널은 사람 *이름·요약* 매칭만 담당한다
 * (spec 5.6 갈래 분리). mask.person 이 끄면 빈 배열을 회신한다(옛 `if (maskPerson)`
 * 가드 양식). 빈 색인 = 후보 0개(자연 degrade) → 빈 배열이면 RRF 안 0 기여라 검색
 * 결과가 도입 전과 byte 동일하다(회귀 0).
 */
export async function collectPersonChannel(
  store: SqliteMemoryStore,
  ftsQuery: string,
  queryVec: Float32Array,
  config: ResolvedRetrieveConfig,
): Promise<number[]> {
  if (!config.mask.person) return [];

  const [psnFts, psnVec] = await Promise.all([
    store.searchPersonsByFts(ftsQuery, DEFAULT_PERSON_FTS_LIMIT),
    store.searchPersonsByVector(queryVec, DEFAULT_PERSON_VECTOR_K),
  ]);
  // 글자·의미 매칭 사람 id 합집합(중복 제거 / 순서 = 글자 먼저).
  const personIdSet = new Set<string>();
  for (const h of psnFts) personIdSet.add(h.personId);
  for (const h of psnVec) personIdSet.add(h.personId);

  const personNodeIdSet = new Set<number>();
  // 사람의 글 = node_person_edges(getNodesByConcepts 가 psn_ id 를 그쪽으로 풀이).
  const matchedPersonIds = [...personIdSet];
  if (matchedPersonIds.length > 0) {
    for (const nodeId of await store.getNodesByConcepts(
      matchedPersonIds,
      DEFAULT_PROJECT_NODE_LIMIT,
    )) {
      personNodeIdSet.add(nodeId);
    }
  }
  // 사람 → 참여 프로젝트 글.
  const personProjectIds = new Set<string>();
  for (const personId of personIdSet) {
    for (const projectId of store.getPersonProjectIds(personId)) {
      personProjectIds.add(projectId);
    }
  }
  for (const projectId of personProjectIds) {
    for (const nodeId of store.getNodesByProjectId(
      projectId,
      DEFAULT_PROJECT_NODE_LIMIT,
    )) {
      personNodeIdSet.add(nodeId);
    }
  }
  return [...personNodeIdSet];
}
