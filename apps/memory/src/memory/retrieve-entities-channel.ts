/**
 * memory/retrieve-entities-channel.ts — 새 종류 엔티티 검색 별 통로(분류 단계3 T5·D14).
 *
 * 새 종류(사용자가 화면으로 더한 11번째 이후 종류)의 엔티티를 *엔티티 자체* 로
 * 찾아 회신한다. 글 검색 retriever.retrieve() 의 RRF 에 합류하지 *않는다* — 세
 * 곳에서 깨지기 때문이다(plan §실측 공백):
 *   - 공백 1: rrf.ts 의 reciprocalRankFusion 은 number[](정수 nodeId)만 받는데
 *             엔티티 식별자는 entity_id(문자열)다.
 *   - 공백 2: RetrievalResult.node 가 MemoryNode(knowledge_nodes 행)에 묶여 있어
 *             entities 행을 끼우면 search.ts·graph.ts 소비처가 전부 깨진다.
 *   - 공백 3: 기존 10종은 엔티티 행으로 검색에 안 뜨고 연결된 글/개념으로 뜬다.
 *
 * 그래서 활용 단계5 POST /compute 가 택한 *별 통로* 양식을 미러한다 — 점수식
 * 6파일(rrf·retrieve-channels·search-tuning·scoring·reranker·calibration)과
 * retriever.ts 를 import 조차 안 한다. 문자열 키 RRF 를 여기 자체 보유한다.
 *
 * RRF 수식은 rrf.ts 와 *같다*(1/(k+rank+1)·k=60). 다른 점은 키가 number 가
 * 아니라 string(entity_id)이라는 것뿐이다 — 키 타입만 다르므로 rrf.ts 글자
 * 동결(retriever.invariant.test.ts)을 안 깬다. rrf.ts 를 import 해 정수 버전을
 * 쓰면 문자열 키를 못 넣어(공백 1) 그대로는 재사용 불가다.
 *
 * silent fallback 금지 — 새 종류 0개·매칭 0건이면 빈 배열(정직한 빈 상태).
 * 차원 불일치·색인 누락 같은 실패는 entities-repository 가 loud throw 하고 이
 * 채널은 가리지 않는다(에러 전파).
 */

import type {
  EntitiesRepository,
  EntityFtsHit,
  EntityVectorHit,
  UserEntity,
} from "../db/store-internal/entities-repository.ts";

/**
 * 문자열 키 RRF 의 dampening 상수. rrf.ts 의 RRF_K(=60)와 같은 값·같은 의미다.
 * 별 통로라 rrf.ts 를 import 하지 않고 같은 값을 둔다(D14-2 — 키만 string 이라
 * 글자 동결을 안 깬다). 두 상수가 발산하면 새 종류 검색 순위가 글 검색과 어긋나니
 * 값을 바꿀 일이 생기면 rrf.ts·여기를 함께 본다.
 */
export const ENTITY_RRF_K = 60;

/**
 * 순위에 든 엔티티 하나를 회신해도 되는지 판정한다(WP-B1-03 — 검색 부가 출력 출처 판정).
 * false 면 그 엔티티를 빼고 다음 순위가 그 자리를 채운다. 판정은 회신 자리를 채울
 * 후보에만 묻는다 — 상위 limit 밖이라 어차피 안 보였을 후보에는 묻지 않는다.
 */
export type EntityHitAdmission = (entityId: string) => boolean;

/** 새 종류 검색 한 건(POST /search 응답 entityHits 원소·D14-1). */
export interface EntitySearchHit {
  /** entity_id(문자열·prefix + UUID). */
  id: string;
  typeName: string;
  name: string;
  koName: string | null;
  /** 문자열 키 RRF 누적 점수(높을수록 잘 맞음). */
  score: number;
}

/**
 * 문자열 키 Reciprocal Rank Fusion(rrf.ts reciprocalRankFusion 의 문자열 키
 * 짝). 각 ranking 은 순위대로 정렬된 entity_id 목록이고, 위치(0-based)가
 * 1/(k+rank+1) 로 기여한다. entity_id → 누적 점수 Map 을 회신한다.
 *
 * 수식·k 기본값은 rrf.ts 와 byte 동일(1/(k+i+1)·k=60) — 키 타입만 string 이다.
 */
function reciprocalRankFusionByEntityId(
  rankings: ReadonlyArray<readonly string[]>,
  k: number = ENTITY_RRF_K,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const ranking of rankings) {
    for (let i = 0; i < ranking.length; i++) {
      const id = ranking[i] as string;
      // +1 so the 1st-place hit yields 1/(k+1), matching the literature.
      const contrib = 1 / (k + i + 1);
      out.set(id, (out.get(id) ?? 0) + contrib);
    }
  }
  return out;
}

/**
 * 새 종류 엔티티 검색 — entities_fts BM25 + entities_vec KNN 두 결과를 문자열 키
 * RRF 로 *엔티티끼리만* 합산해 EntitySearchHit[] 를 회신한다(분류 단계3 T5·D14).
 *
 * 글 검색과 키 공간이 분리돼 있어 retriever.retrieve()·rrf.ts·점수식 6파일을
 * 호출조차 안 한다. 두 색인이 다 비면(새 종류 0개) 빈 배열을 회신한다 —
 * search.ts 가 그대로 entityHits: [] 로 직렬화하고 글 results 는 byte 동일하다.
 *
 * @param repo     범용 본체 repo(store.entitiesRepo) — 검색·메타 조회 단일 출처.
 * @param query    검색어 텍스트(entities_fts BM25 입력).
 * @param queryVec 쿼리 임베딩(entities_vec KNN 입력). 호출자가 글 모델 embedder
 *                 로 1회 만들어 넘긴다(차원 = EMBEDDING_DIMENSIONS 단일 출처).
 * @param limit    회신 상한(각 색인 후보 수이자 최종 결과 상한).
 * @param admit    출처 판정(WP-B1-03). 주면 판정에 걸린 엔티티를 빼고 다음 순위로
 *                 채운다. 안 주면 모든 엔티티를 받는다(판정 도입 전과 같은 회신).
 */
export async function retrieveEntities(
  repo: EntitiesRepository,
  query: string,
  queryVec: number[],
  limit: number,
  admit?: EntityHitAdmission,
): Promise<EntitySearchHit[]> {
  if (limit <= 0) return [];

  const ftsHits: EntityFtsHit[] = repo.searchEntitiesByFts(query, limit);
  const vecHits: EntityVectorHit[] = repo.searchEntitiesByVector(queryVec, limit);
  if (ftsHits.length === 0 && vecHits.length === 0) return [];

  // 두 색인 순위를 문자열 키 RRF 로 합쳐 단일 정렬(두 점수 스케일이 달라 합산 X·
  // 순위 융합). BM25 는 score 높을수록 잘 맞으니 그 순서 그대로, KNN 은 distance
  // 작을수록 잘 맞으니 그 순서 그대로(둘 다 이미 잘 맞는 순으로 정렬돼 옴).
  const fused = reciprocalRankFusionByEntityId([
    ftsHits.map((h) => h.entityId),
    vecHits.map((h) => h.entityId),
  ]);

  // 합산 점수 내림차순. 동점은 Map 삽입 순서(첫 등장 색인 순위) 보존. 상위 limit 자리를
  // 순서대로 채운다 — 출처 판정에 걸린 엔티티는 자리를 차지하지 않고 다음 순위가 채운다.
  const ranked = [...fused.entries()].sort(([, a], [, b]) => b - a);

  const out: EntitySearchHit[] = [];
  let slots = 0;
  for (const [entityId, score] of ranked) {
    if (slots >= limit) break;
    // 엔티티 메타(typeName·name·koName)는 repo.get 으로 채운다. 합산에 떴는데
    // 메타가 없으면(검색·삭제 경쟁 같은 데이터 이상) 정직하게 뺀다 — 가짜 메타를
    // 합성하지 않는다(No-fallback). 정상 흐름에선 색인과 본체가 한 트랜잭션이라
    // 항상 메타가 있다. 메타 없는 행도 판정 도입 전처럼 자기 자리를 차지한다.
    const meta: UserEntity | null = await repo.get(entityId);
    if (!meta) {
      slots += 1;
      continue;
    }
    if (admit !== undefined && !admit(entityId)) continue;
    slots += 1;
    out.push({
      id: meta.id,
      typeName: meta.typeName,
      name: meta.name,
      koName: meta.koName,
      score,
    });
  }
  return out;
}
