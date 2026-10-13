/**
 * person-hierarchy-wiring.ts — 사람 분류 위계 편입 (spec 2026-06-14 D5).
 *
 * person 으로 분류된 explicit 콜론 사슬(`#가족:엄마`·`#관계:가족 #가족:엄마`)일 때
 * "사람 루트 → 분류(가족)" parent_of 를 세운다. 사람 행(persons 테이블) 생성은 기존
 * wireHashtagEntities 가 전담한다 — 이 모듈은 위계만 더하고 행을 만들지 않는다(이중 처리 0).
 * 검증된 linkSubcategoryToTypeRoot(장소·작품과 같은 코드)를 그대로 재사용한다.
 *
 * 통로 분담 — `#가족:엄마` 의 두 단(사람→가족, 가족→엄마)을 누가 세우나:
 *  - 사람→가족: 이 모듈이 linkSubcategoryToTypeRoot 로 세운다(타입 루트 진입).
 *  - 가족→엄마: 입력 통로의 1.5단계(wireGeneralClassification)가 콜론 태그 `#가족:엄마`
 *    에서 이미 세운다. "가족"은 예약 키도(loadReservedKeys 밖) 타입 지시 키도(synonyms 는
 *    사람·인물·관계) 아니라 4 갈래로 떨어져 addClassificationTag("가족","엄마")가 돈다.
 *    이 모듈도 같은 가족→엄마 를 멱등으로 한 번 더 보강한다 — addClassificationTag 가
 *    INSERT OR IGNORE·ON CONFLICT MAX 라 1.5단계와 겹쳐도 중복 0 이고, 이 모듈만 단독으로
 *    불려도(테스트·향후 회귀) 사슬이 끊기지 않는다. "엄마"는 분류 사슬 끝 사람 이름
 *    (candidateName)으로, classifier 의 matched 산출에서 뽑는다.
 *
 * 소유자 관계 엣지 폐기 — 옛 양식은 분류가 관계 키(가족·친구)이면 소유자(나) ↔ 매달린 대상 사람
 * 사이에 family_of/friend_of 관계 엣지(entity_relation_edges)를 세웠다. 사용자 결정으로 이 소유자
 * 관계 엣지 생성을 폐기한다 — 위계(사람>가족>막내>이몽룡)가 가족·친구 관계를 이미 표현해 중복이고,
 * 사람이 검색 seed 가 아니라 검색에도 안 쓰여 시각·검색 둘 다 위계가 대체하기 때문이다. 가족·친구는
 * 여전히 *위계 사슬 키*로 작동하고(lookupRelationTag 로 친족 동의어 표준형 통일·사슬 키 판정), 단지
 * 소유자와 직접 잇는 관계 엣지만 안 만든다. created_by(작품→작가) 같은 8 타입 cross-type 관계는
 * entity_relation_edges 에 그대로 선다(이 폐기는 소유자 family_of/friend_of 한정).
 *
 * 소급 이동 + 친족 동의어 — 먼저 `#엄마` 로 사람 루트 직속에 생긴 사람을, 나중 `#가족:엄마`
 * (또는 `#가족:어머니`) 입력 시 가족 아래로 완전 이동한다(spec D3). 사람 루트 → 그 사람 이름
 * 직속 parent_of 를 떼고(removeParentOfEdge·멱등), 아래 위계 단계가 사람 → 가족 → 엄마 사슬을
 * 새로 세운다. 친족 호칭은 canonicalKinship 으로 표준형 통일한다(어머니·모친 → 엄마) — 단
 * *알려진 관계 어휘(가족·친구) 분류 안에서만* 적용한다(D9). 위계 잎·관계 target·소급 조회를
 * 모두 같은 candidate 값으로 맞춰, `#가족:어머니` 로 적어도 기존 "엄마" 한 사람으로 모인다.
 * 자유 분류(`#관계:대웅님가족 #대웅님가족:어머니`)는 표준형을 적용하지 않고 원본("어머니")을
 * 둔다 — 표준형으로 모으면 내 엄마와 타인 어머니가 이름 UNIQUE "엄마" 한 노드로 섞이는데(과잉
 * 연결), 자유 분류 경계가 그 섞임을 막아야 하기 때문이다(D9). 동명이인 2명+ 모호면 거짓 이동
 * 0 으로 소급을 건너뛰고 경고한다. 소급은 입력 시점 즉시 돈다(정리 깊은 패스 대기 아님).
 *
 * silent fallback 금지 — person explicit 이 아니거나 분류가 없으면(단일 `#사람:이름`)
 * 위계 0 을 정직히 돌려준다(빈 결과 ≠ 실패). project 는 이 모듈 밖이다(호출처가 person
 * 갈래에서만 부른다·기존 제외 유지).
 *
 * 잎 → 사람 매달기(S1-T1) — 사용자가 속성을 *따로* 적으면(`#사람:성춘향 #관계:가족 #가족:엄마`)
 * `#사람:성춘향` 가 첫 콜론이라 subcategory 가 null 이 돼 분류 통로가 일찍 끝난다. person-relation-
 * chain 의 순수 함수(extractRelationChains·extractPersonDeclarations·decidePersonAttachment)로
 * 관계 사슬과 사람 선언을 따로 뽑아 사람 → 가족 → 엄마 단을 세우고, 사람 1명 + 역할 잎 1개면
 * 엄마(개념) → 성춘향(person 행) 위계 엣지를 hierarchy_edges 에 직접 쓴다(그림자 성춘향 개념 0·
 * spec §2·§5.3). 옛 그림자 사람 이름 개념·라벨 흡수는 폐기한다(과흡수 회귀의 뿌리·spec §11).
 *
 * RRF 코어·새 스키마 0 — classifier·linkSubcategoryToTypeRoot·linkLeafToTypeRoot·
 * addClassificationTag(개념↔개념 위계 → hierarchy_edges)·canonicalKinship 사전을 재사용하고,
 * 잎→사람 위계만 addReducedHierarchyEdge(concept→person·단일 출처 테이블)로 쓴다.
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import {
  classifyEntityTypeDeterministic,
  type EntityTypeClassification,
} from "./entity-type-classifier.ts";
import {
  linkSubcategoryToTypeRoot,
  linkLeafToTypeRoot,
  ensureTypeRootConcept,
  linkClassificationPair,
} from "./entity-hierarchy-wiring.ts";
import { lookupRelationTag } from "./entity-relation-vocabulary.ts";
import { canonicalKinship } from "./kinship-synonyms.ts";
import { parseClassificationTags } from "./parsers/classification-tag.ts";
import {
  extractRelationChains,
  extractPersonDeclarations,
  decidePersonAttachment,
  type RelationChain,
} from "./person-relation-chain.ts";
import type { Provenance } from "./provenance-vocabulary.ts";

/** wirePersonHierarchy 의 반환값 — 호출처(입력 통로) 로그·디버깅용. */
export interface PersonHierarchyResult {
  /** 새로 호출한 위계 연결 수(사람→가족·가족→엄마 보강 호출 합). */
  hierarchyEdges: number;
  /** 정직한 경고(미반영·건너뜀 사유). */
  warnings: string[];
}

/**
 * classification.matched(`rawCategory:value`)에서 사슬 끝 사람 이름(value)을 뽑는다.
 *
 * entity-placement-wiring 의 extractCandidateName 과 같은 규칙이다 — person 모듈
 * 자족성을 위해 작은 헬퍼를 따로 둔다(큰 파일 export 변경 회피·드리프트는 같은 matched
 * 형식 계약으로 막는다). explicit 분류의 matched 만 끝 값이 의미 있다. matched 가
 * 없거나(seed/llm·none) 콜론이 없으면 빈 문자열(정직).
 */
export function extractPersonCandidateName(
  classification: EntityTypeClassification,
): string {
  if (classification.source !== "explicit") return "";
  const matched = classification.matched;
  if (!matched) return "";
  const colon = matched.indexOf(":");
  if (colon < 0) return "";
  return matched.slice(colon + 1).trim();
}

/**
 * person explicit 콜론 사슬이면 "사람 루트 → 분류" 위계를 세운다(spec D5).
 *
 * person 이 아니거나 explicit 신호가 아니면 위계 0(정직) — 콜론 없는 평면 나열(`#가족
 * #엄마`)이나 seed/llm 판정은 위계를 새로 만들지 않는다(입력 통로 불변식 I1 정합).
 * 분류가 없으면(단일 `#사람:민수`) 사람 루트 진입 분류가 없어 위계 0 이다 — 그 사람 행은
 * wireHashtagEntities 가 만들고 검색 1급으로 잡는다(이 모듈 책임 밖).
 *
 * @param store        실제 SqliteMemoryStore(실 DB·실 임베딩).
 * @param originNodeId 분류 신호가 나온 글 노드 id — addClassificationTag 가 이 글을
 *                     분류 키·잎에 classification role 로 잇는다(기존 양식 그대로).
 * @param content      글 본문(태그 포함 원문). 여기서 classifier 로 다시 판정한다.
 * @returns 위계 결과(로그·디버깅용).
 */
export async function wirePersonHierarchy(
  store: SqliteMemoryStore,
  originNodeId: number | null,
  content: string,
  provenance: Provenance = originNodeId === null ? "user_input" : "hashtag",
): Promise<PersonHierarchyResult> {
  const result: PersonHierarchyResult = { hierarchyEdges: 0, warnings: [] };

  const classification = classifyEntityTypeDeterministic(content ?? "");
  if (
    classification.typeName !== "person" ||
    classification.source !== "explicit"
  ) {
    // person explicit 아님 — 위계 안 세움(정직·빈 결과 ≠ 실패).
    return result;
  }

  if (!classification.subcategory) {
    // `#사람:X` 가 첫 콜론 매치라 subcategory 가 null 인 갈래(`#사람:성춘향 #관계:가족
    // #가족:엄마`·`#사람:X #관계:엄마`). 분류 통로가 여기서 일찍 끝나 위계가 안 섰다. Task 1·2
    // 순수 함수로 관계 사슬을 따로 뽑아 사람 → 가족 → 엄마 단을 세우고, 사람 1명 + 역할 1개면
    // 잎 → 사람(엄마 → 성춘향)까지 매단다. 사슬이 없으면(단일 `#사람:민수`) 위계 0(정직).
    await wireRelationChains(store, originNodeId, content, result, provenance);
    return result;
  }

  // 분류가 알려진 관계 어휘(가족·친구)인지 먼저 가른다 — 친족 동의어 표준형 통일의 적용
  // 경계다(D9). `#가족:어머니` 는 표준형 "엄마"로 모으고, 자유 분류(`#대웅님가족:어머니`)는
  // 원본 "어머니"를 둔다(과잉 연결 차단). 이 판정은 위계 잎 이름에만 쓴다 — 소유자 관계 엣지
  // (family_of/friend_of)는 위계가 가족·친구를 이미 표현해 중복이라 만들지 않는다(사용자 결정).
  const relSpec = lookupRelationTag(classification.subcategory);
  const isKnownRelationSubcat =
    !!relSpec &&
    (relSpec.relation === "family_of" || relSpec.relation === "friend_of");

  // 사슬 끝 사람 이름을 정한다. 관계 어휘(가족·친구) 분류 안에서만 친족 동의어 표준형으로
  // 통일한다(어머니 → 엄마) — `#가족:어머니` 로 적어도 내 "엄마" 한 사람으로 모인다. 자유
  // 분류(`#관계:대웅님가족 #대웅님가족:어머니`)는 원본 그대로 둔다 — 표준형으로 모으면 내
  // 엄마와 타인 어머니가 이름 UNIQUE "엄마" 한 노드로 섞인다(D9 과잉 연결). 자유 분류 경계가
  // 그 섞임을 막아야 하므로 동의어를 적용하지 않는다. candidate 는 *위계 잎*(가족 → 엄마)과
  // 소급 조회에 쓴다.
  const rawCandidate = extractPersonCandidateName(classification);
  const candidate = isKnownRelationSubcat
    ? canonicalKinship(rawCandidate)
    : rawCandidate;

  // 소급 이동(D3) — 위계를 세우기 *전에* 사람 루트 직속 엣지를 떼어낸다. `#엄마` 로 먼저
  // 생긴 사람이 사람 루트 직속에 매달려 있으면, 아래 위계가 가족 아래로 새로 매달기 전에
  // 직속을 제거해 "완전 이동"을 만든다(직속·가족 둘 다 매달린 이중 부모 차단). 직속 엣지가
  // 없으면 removeParentOfEdge 가 0 행 no-op 이라 안전하다(소급의 핵심은 직속 제거 자체가
  // 아니라 같은 사람을 가족 아래로 새로 매다는 것 — 직속이 있을 때만 제거가 의미를 가진다).
  await reparentPersonUnderSubcategory(store, candidate, result);

  // 사람 루트(사람) → 첫 분류(가족) parent_of. 검증된 타입 루트 진입 코드 재사용·멱등.
  await linkSubcategoryToTypeRoot(
    store,
    originNodeId,
    "person",
    classification.subcategory,
    provenance,
  );
  result.hierarchyEdges += 1;

  // 가족 → 엄마(사슬 끝 사람 표준형 이름) 보강 — 1.5단계 wireGeneralClassification 이 콜론
  // 태그 `#가족:엄마` 에서 이미 세우지만, 이 모듈만 단독으로 불려도 사슬이 끊기지 않게
  // 멱등으로 한 번 더 건다(addClassificationTag INSERT OR IGNORE·ON CONFLICT MAX 라 중복 0).
  // candidate 가 빈 문자열이면(사슬이 분류에서 끝남) 잎 단을 못 세운다 — 정직히 건너뛴다.
  // 관계 어휘 분류면 candidate 가 표준형이라 `#가족:어머니` 입력도 "엄마" 잎 한 노드로 모이고,
  // 자유 분류면 원본이라 "어머니" 잎이 그대로 선다(D9 — 자유 분류는 친족 동의어 미적용).
  if (candidate) {
    await linkClassificationPair(
      store,
      originNodeId,
      classification.subcategory,
      candidate,
      provenance,
    );
    result.hierarchyEdges += 1;
  }

  // 잎 → 사람 매달기(E1~E4) — `#가족:엄마 … #사람:성춘향` 처럼 사람 선언이 *함께* 적힌 글이면
  // 엄마 → 성춘향 한 단을 더 매단다. subcategory 가 있는 이 갈래는 위에서 사람 → 가족 → 엄마
  // 사슬을 이미 세웠으니, 여기서는 잎 → 사람 매달기만 더한다. 사람 0·역할 0 이면 정직히 건너뛴다.
  // 소유자 관계 엣지(family_of/friend_of)는 만들지 않는다 — 위계(사람>가족>막내>이몽룡)가 가족·
  // 친구 관계를 이미 표현해 중복이고 검색 seed 도 아니라, 위계가 시각·검색을 대체한다(사용자 결정).
  await attachPersonToRoleLeaf(store, originNodeId, content, result, provenance);

  return result;
}

/**
 * `#사람:X` 가 첫 콜론이라 subcategory 가 null 인 갈래에서 관계 사슬 위계를 세운다(E1~E3).
 *
 * Task 1 의 extractRelationChains 가 `#관계:가족 #가족:엄마`(또는 `#관계:엄마`)에서 분류 단
 * (가족)과 끝 잎(엄마)을 뽑는다. 사슬마다:
 *  - 중간 분류 단이 있으면(가족) 사람 → 가족(linkSubcategoryToTypeRoot) + 가족 → 엄마
 *    (addClassificationTag)를 세운다 — 4단 위계.
 *  - 중간 단이 없으면(E3 `#관계:엄마`) 사람 → 엄마(linkLeafToTypeRoot) 한 단만 세운다.
 *
 * 친족 동의어는 *알려진 관계 어휘(가족·친구) 분류 안에서만* 표준형으로 통일한다(D9). 분류 단이
 * 관계 어휘면 그 잎(어머니)을 표준형(엄마)으로 모으고, 자유 분류·관계 지붕(관계)이면 원본을
 * 둔다 — 내 엄마와 타인 어머니가 한 노드로 섞이는 과잉 연결을 막는다.
 *
 * 사슬 위계를 다 세운 뒤 attachPersonToRoleLeaf 로 잎 → 사람(엄마 → 성춘향)을 매단다. 소유자
 * 관계 엣지(family_of/friend_of)는 만들지 않는다 — 위계가 가족·친구 관계를 이미 표현해 중복이라
 * 없앤다(사용자 결정). 사슬이 없으면(단일 `#사람:민수`) 아무것도 안 하고 정직히 끝난다.
 *
 * 개념↔개념 단(사람→가족·가족→엄마·사람→엄마)은 linkSubcategoryToTypeRoot·addClassificationTag·
 * linkLeafToTypeRoot 가 hierarchy_edges(concept→concept)에 쓴다(S0-T4 통로·무변경). 잎→사람만
 * attachPersonToRoleLeaf 가 person 행 직접 위계 엣지로 세운다(그림자 성춘향 개념 0).
 */
async function wireRelationChains(
  store: SqliteMemoryStore,
  originNodeId: number | null,
  content: string,
  result: PersonHierarchyResult,
  provenance: Provenance,
): Promise<void> {
  const tags = parseClassificationTags(content ?? "");
  const chains = extractRelationChains(tags);
  if (chains.length === 0) return; // 관계 사슬 없음 — 단일 `#사람:이름`(위계 0·정직).

  for (const chain of chains) {
    const leaf = canonicalLeafForChain(chain);
    if (!leaf) continue; // 잎이 비면 세울 단이 없다(정직).

    if (chain.category) {
      // 사람 → 분류 단(가족) parent_of — 검증된 타입 루트 진입 코드 재사용·멱등.
      await linkSubcategoryToTypeRoot(store, originNodeId, "person", chain.category, provenance);
      result.hierarchyEdges += 1;
      // 분류 단(가족) → 잎(엄마) parent_of — addClassificationTag INSERT OR IGNORE·멱등.
      await linkClassificationPair(
        store,
        originNodeId,
        chain.category,
        leaf,
        provenance,
      );
      result.hierarchyEdges += 1;
    } else {
      // 중간 단 없음(E3) — 잎(엄마)을 사람 루트 직속에 매단다.
      await linkLeafToTypeRoot(store, originNodeId, "person", leaf, provenance);
      result.hierarchyEdges += 1;
    }
  }

  // 잎 → 사람 매달기(엄마 → 성춘향) — 사람 1명 + 역할 1개일 때만. 소유자 관계 엣지
  // (family_of/friend_of)는 만들지 않는다 — 위계(사람>가족>막내>이몽룡)가 가족·친구 관계를 이미
  // 표현해 중복이라 없앤다(사용자 결정·위계가 시각·검색을 대체).
  await attachPersonToRoleLeaf(store, originNodeId, content, result, provenance);
}

/**
 * 관계 사슬의 끝 잎을 *분류 단이 알려진 관계 어휘(가족·친구)일 때만* 친족 표준형으로 통일한다(D9).
 *
 * 분류 단(category)이 가족·친구면 그 잎(어머니)을 표준형(엄마)으로 모은다 — `#가족:어머니` 도 내
 * "엄마" 한 노드로 합류한다. 분류 단이 없거나(E3·관계 지붕에서 잎으로 바로) 자유 분류면 원본을
 * 둔다 — 표준형으로 모으면 내 엄마와 타인 어머니가 이름 UNIQUE "엄마" 한 노드로 섞인다(과잉 연결).
 * subcategory 갈래의 isKnownRelationSubcat 판정과 같은 경계를 사슬 단에도 그대로 적용한다.
 */
function canonicalLeafForChain(chain: RelationChain): string {
  const rawLeaf = chain.leaf.trim();
  if (!rawLeaf || !chain.category) return rawLeaf;
  const relSpec = lookupRelationTag(chain.category.trim());
  const isKnownRelation =
    !!relSpec &&
    (relSpec.relation === "family_of" || relSpec.relation === "friend_of");
  return isKnownRelation ? canonicalKinship(rawLeaf) : rawLeaf;
}

/**
 * 사람 1명 + 서로 다른 역할 잎 1개면 잎(엄마 개념) → 사람 행(성춘향) 위계 엣지를 매단다(E1~E4).
 *
 * S1-T1(위계 단일 출처) — 옛 양식은 addClassificationTag(origin, 엄마, "성춘향")로 *그림자 사람
 * 이름 개념*("성춘향" isClassificationValue)을 잎 아래 매달았다. 그 그림자 개념이 라벨 흡수 과흡수
 * 회귀의 뿌리라 폐기한다. 새 양식은 person 행을 직접 위계 잎으로 잇는다 — 엄마(개념) → 성춘향
 * (person 행) parent_of 를 hierarchy_edges 에 직접 쓴다(target_type='person'·그림자 성춘향 0).
 *
 * Task 2 의 decidePersonAttachment 가 모호(사람 둘 이상·역할 둘 이상)면 매달지 않고 경고만
 * 돌려준다(거짓 연결 0 = E4). 같은 이름을 두 번 적은 글(`#사람:성춘향 #사람:성춘향`)은 정규화
 * 이름 기준으로 dedupe 해 1명으로 본다 — 같은 사람을 두 번 적은 자연 입력을 거짓 거부하지 않는다.
 * 서로 다른 이름 둘이면 dedupe 후에도 2명이라 모호로 남는다.
 *
 * 매달기 잎(decision.attach.leaf)은 decidePersonAttachment 가 사슬 잎에서 뽑은 값이다 — 위
 * wireRelationChains 가 canonicalLeafForChain 으로 세운 잎과 같은 표준형 경계를 타야 같은 노드로
 * 모인다. 그래서 사슬과 같은 표준형을 입힌 chains 를 넘긴다(아래). 사람 행 생성은
 * wireHashtagEntities 책임(불변·H8) — 여기선 findPersonByNameOrAlias 로 기존 행을 찾기만 한다.
 * 행 미생성·동명이인 모호면 거짓 연결 0 으로 건너뛰고 경고한다(silent 0). 위계 매달기만 하고
 * 끝낸다 — 소유자 관계 엣지(family_of/friend_of)는 만들지 않는다(위계가 관계를 표현·사용자 결정).
 */
async function attachPersonToRoleLeaf(
  store: SqliteMemoryStore,
  originNodeId: number | null,
  content: string,
  result: PersonHierarchyResult,
  provenance: Provenance,
): Promise<void> {
  const tags = parseClassificationTags(content ?? "");
  // 사슬 잎을 표준형으로 통일한 사본으로 매달기 잎을 결정한다 — 위계가 세운 잎 노드와 일치시킨다.
  const chains = extractRelationChains(tags).map((c) => ({
    ...c,
    leaf: canonicalLeafForChain(c),
  }));
  // 같은 정규화 이름은 1명으로 본다(같은 사람 두 번 = 1명·거짓 거부 0). 서로 다른 이름은 그대로.
  const persons = dedupePersonNames(extractPersonDeclarations(tags));

  const decision = decidePersonAttachment(persons, chains);
  for (const warning of decision.warnings) result.warnings.push(warning);
  if (!decision.attach) return; // 매달 대상 없음·모호 — 정직히 끝낸다(경고는 이미 담겼다).

  // 잎(엄마) 개념 보장 — 부모 끝점. findOrCreateConcept 가 잎과 같은 표준형·isClassificationValue
  // 개념을 보장한다(위계가 이미 세운 그 잎 개념과 같은 노드로 모인다·이름 UNIQUE).
  const leafConceptId = await store.findOrCreateConcept(decision.attach.leaf, {
    isClassificationValue: true,
  });

  // 사람 행 해소 — 행 생성은 wireHashtagEntities 책임(H8·불변). 여기선 기존 행을 찾기만 한다.
  const lookup = await store.findPersonByNameOrAlias(decision.attach.person);
  if (lookup.ambiguous) {
    // 같은 이름 2명+ — 어느 사람 행을 매달지 못 정한다(거짓 연결 0).
    result.warnings.push(
      `'${decision.attach.person}' 동명이인 모호 — 잎→사람 매달기 건너뜀`,
    );
    return;
  }
  if (!lookup.person) {
    // 사람 행이 아직 없다(wireHashtagEntities 가 안 만든 입력) — 거짓 연결 0 으로 건너뛴다.
    result.warnings.push(
      `'${decision.attach.person}' 사람 행 미생성 — 잎→사람 매달기 건너뜀`,
    );
    return;
  }

  // 엄마(개념) → 성춘향(person 행) parent_of 위계 엣지를 hierarchy_edges 에 직접 쓴다.
  // 그림자 성춘향 개념 0 — person 행이 직접 위계 잎이다(spec §2·§5.3). 멱등(INSERT OR IGNORE).
  store.addReducedHierarchyEdge({
    sourceType: "concept",
    sourceId: leafConceptId,
    targetType: "person",
    targetId: lookup.person.personId,
    provenance,
    sourceNodeId: originNodeId,
    weight: 0.9,
  });
  store.pruneHierarchyShortcutParentsOf({
    type: "person",
    id: lookup.person.personId,
  });
  result.hierarchyEdges += 1;
}

/**
 * 사람 이름 목록을 정규화 이름 기준으로 dedupe 한다 — 같은 사람을 두 번 적은 자연 입력을
 * 1명으로 본다(거짓 거부 0). 공백 정리·trim 한 값이 같으면 한 사람으로 묶고, 다르면 둘로 둔다.
 * 적힌 순서는 보존한다(첫 등장 우선).
 */
function dedupePersonNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const key = name.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * 표준형 이름의 사람을 사람 루트 직속에서 떼어낸다 — 소급 완전 이동의 직속 해제 단계(D3).
 *
 * `#엄마` 로 먼저 등록된 사람이 사람 루트 직속(사람 → 엄마 parent_of)에 매달려 있으면,
 * 나중 `#가족:엄마` 입력 시 가족 아래로 새로 매달기 전에 그 직속을 떼어 이중 부모(직속 +
 * 가족)를 막는다. 기존 사람을 findPersonByNameOrAlias 로 확인해 *실재할 때만* 직속을 뗀다 —
 * 그래야 처음 보는 이름(소급 대상 없음)에 헛 삭제를 안 한다. 동명이인 2명+ 모호면 어느
 * 사람을 옮길지 못 정해 거짓 이동 0 으로 건너뛰고 경고한다.
 *
 * removeParentOfEdge 는 멱등(직속이 없으면 0 행 no-op)이라, `#엄마` 단독이 사람 루트 직속을
 * 실제로 만들지 않는 경로(평면 개념·사람 행만)라도 안전하다 — 이 경우 직속 해제는 no-op 이고
 * 소급의 실질은 아래 위계 단계가 같은 사람을 가족 아래로 새로 매다는 것이 된다.
 *
 * @param candidate 사슬 끝 사람 이름(관계 어휘 분류면 표준형·자유 분류면 원본). 빈 문자열이면 즉시 끝낸다.
 */
async function reparentPersonUnderSubcategory(
  store: SqliteMemoryStore,
  candidate: string,
  result: PersonHierarchyResult,
): Promise<void> {
  if (!candidate) return; // 사슬이 분류에서 끝나 옮길 대상 이름이 없다(정직).

  const existing = await store.findPersonByNameOrAlias(candidate);
  if (existing.ambiguous) {
    // 같은 이름 2명+ — 어느 사람을 옮길지 못 정한다(거짓 이동 0).
    result.warnings.push(`'${candidate}' 동명이인 모호 — 소급 이동 건너뜀`);
    return;
  }
  if (!existing.person) return; // 처음 보는 이름 — 소급 대상 없음(헛 삭제 0).

  // 사람 루트 → 그 사람 이름 개념 직속 parent_of 를 뗀다. nameConceptId 는 위계 잎과 같은
  // 개념(같은 표준형 이름·isClassificationValue)이라 직속 제거 대상과 새 위계 잎이 일치한다.
  // S0-T4(위계 단일 출처) — 그 직속 엣지는 addClassificationTag 가 hierarchy_edges 에
  // 쓰므로(양 끝 개념), 직속 제거도 같은 테이블에서 떼낸다. 옛 concept_edges 에서 떼면
  // 빈 테이블 no-op 이라 직속이 안 떨어져 이중 부모가 남는다(라이브 결함).
  const personRootId = await ensureTypeRootConcept(store, "person");
  const nameConceptId = await store.findOrCreateConcept(candidate, {
    isClassificationValue: true,
  });
  // 직속 없으면 0 행 no-op(멱등).
  store.removeHierarchyEdge("concept", personRootId, "concept", nameConceptId);
}
