/**
 * entity-placement-wiring.ts — 개념 엔티티 타입 배치 오케스트레이션 + 입력 통로 합류
 * (개념 엔티티 타입 체계 3단계 Task 5, spec §11.2-3·§5).
 *
 * Task 2·3·4 의 토대 함수를 한 흐름으로 묶는다. 입력 통로가 origin 노드 하나와 글 본문을
 * 넘기면 이 모듈이:
 *   1. classifyEntityType 으로 어느 배치 타입인지 판정한다(1단 명시 태그 → 2단 분류 폴더 단어 →
 *      LLM 단은 default OFF·null 주입). 기타(none)나 person/project 면 신규 8 타입 배치를
 *      하지 않고 정직하게 끝낸다(이 통로는 신규 8 타입 전용 — 사람·프로젝트는 기존
 *      wireHashtagEntities 가 전담).
 *   2. subcategory 가 있으면 linkSubcategoryToTypeRoot(Task 2)로 `타입 루트 → 분류 키`
 *      parent_of 를 더한다. 기존 wireHashtagConcepts 가 만든 `분류 키 → 끝 값`(동물 → 고양이)
 *      위에 `생물 → 동물` 을 얹어 `생물 → 동물 → 고양이` 사슬을 완결한다(멱등이라 중복 0).
 *   3. 끝 고유명 후보(명시 타입 태그 값)와 그에 동반한 속성 태그를 글에서 뽑아
 *      shouldCreateEntityRow(Task 3) 게이트를 돌린다. 통과하면 createEntityRowIfNeeded 로
 *      1급 행을 만든다(결정 A·B — 분류 단어·일반명사는 행 X).
 *   4. 행이 생기면 applyEntityAttributes(Task 4)로 칸/라벨을 채운다. 위계 잎은 *엔티티 행
 *      자체*다 — 부모(분류 잎 개념 또는 타입 루트) → 엔티티 행 id parent_of 를 hierarchy_edges
 *      에 직접 쓴다(S2-T1·위계 단일 출처 spec §2·§5.2·그림자 잎 위계 0). 옛 그림자 잎 개념
 *      위계·흡수는 폐기한다. 글↔개념 mention(node_concept_edges classification)과 행↔잎-개념
 *      identity(linkEntityIdentity)는 검색 JOIN 키·글 도달 경로라 유지한다(§7.2 옵션 b).
 *
 * 태그 파싱은 새 파서를 만들지 않고 기존 산출을 그대로 받는다 — classifyEntityType 안의
 * parseClassificationTags(콜론 `#키:값` 파서)와 같은 산출을 여기서도 parseClassificationTags
 * 로 받아 끝 고유명 후보·속성 태그를 구성한다. 어느 태그가 "타입 선언 태그"인지는 분류기가
 * 돌려준 matched(`rawCategory:value` 형식)로 식별하고, 나머지 분류 태그를 속성 태그로 본다.
 *
 * silent fallback 금지 — 타입이 안 걸리면 EntityPlacementResult.typeName 을 null 로 정직하게
 * 돌려주고 아무것도 만들지 않는다(거짓 배치 0). 실패는 Safe 래퍼가 origin id·사유와 함께
 * warn 으로 남기고 원본 글은 보존한다(원본은 입력 통로가 이미 저장했다 — 유실 0).
 *
 * RRF 코어·새 스키마·새 테이블 0 — Task 1~4 산출과 기존 인프라(parseClassificationTags·
 * addClassificationTag·facade findOrCreate)만 재사용한다.
 *
 * 진입부/오케스트레이션(이 파일) + 타입별 배치 루프 헬퍼(entity-placement-loop.ts)로 나눠
 * 두었다(A-cleanup·800줄 상한). 이 파일은 루프 헬퍼를 단방향으로 import 한다(순환 0).
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import type { AutoCleanupTriggerHandle } from "./auto-cleanup-trigger.ts";
import type { LlmClient } from "../llm/types.ts";
import {
  classifyEntityTypeDeterministic,
  isTypeIndicatorKey,
  type EntityTypeClassification,
} from "./entity-type-classifier.ts";
import {
  groupTypeDeclarations,
  excludeDirectInputDeclarations,
} from "./type-declaration-grouping.ts";
import { subcategoryToTypeMap } from "./concept-type-vocabulary.ts";
import { resolveInheritedType } from "./inherited-type-lookup.ts";
import {
  getTypeAttributes,
  getTypeColumns,
  type PlacementTypeName,
} from "./concept-type-vocabulary.ts";
import { lookupRelationTag } from "./entity-relation-vocabulary.ts";
import { parseRelationTags } from "./entity-relation-target.ts";
import { wirePersonHierarchy } from "./person-hierarchy-wiring.ts";
import { linkClassificationPair } from "./entity-hierarchy-wiring.ts";
import { parseClassificationTags } from "./parsers/classification-tag.ts";
import { loadReservedKeys } from "./parsers/hashtag-reserved-keys.ts";
import { getEntityTypeMeta } from "../db/store-internal/entity-type-registry.ts";
import { parseHashtagEntities } from "./parsers/hashtag-entity-parser.ts";
import type { Provenance } from "./provenance-vocabulary.ts";
import {
  appendChainStopWarning,
  buildForwardChainSubContent,
  buildTypeAttributeKeys,
  chainEntriesOf,
  connectPersonDocWork,
  createRowForPlacement,
  detectSameSubcategoryExtras,
  entityConsumedRawCategories,
  extractCandidateName,
  isEntityType,
  isMidChainNode,
  lastCategoryOf,
  placeOneEntityType,
  placeOneUserEntityType,
  workConsumedClassificationPairs,
  workPairKey,
  type EntityPlacementResult,
} from "./entity-placement-loop.ts";

export type { EntityPlacementResult } from "./entity-placement-loop.ts";

/** wireEntityPlacement 의 추가 옵션. */
export interface WireEntityPlacementOptions {
  /**
   * 3단 분류의 LLM 단 클라이언트 — *구조만 남긴 예약 칸*이다(2026-06-26 D 단계 L2 동결).
   *
   * 결정 동결 = "구조만 남김"(토글 배선 안 함):
   *   - wireEntityPlacement 함수 안은 모든 분류를 classifyEntityTypeDeterministic
   *     (결정적 1·2단)으로만 돌린다. 이 llm 값을 *읽지 않는다* — 넘겨도 inert 다.
   *   - 그래서 throwing llm 을 넘겨도 이 경로는 LLM 을 부르지 않는다(아래 L2 테스트가
   *     이 inert 성을 회귀로 고정한다). 거짓 toggle 로 오인되지 않게 명시한다.
   * 왜 결정적만:
   *   1. 입력 통로 합류 — 글 입력마다 LLM 분류를 부르면 매 입력이 LLM 왕복만큼
   *      느려진다. 검색·저장 흐름을 LLM 지연에 묶지 않는다(graceful degradation·
   *      모든 LLM opt-in 정합).
   *   2. 켤 settings 표면이 아직 없다 — 실 토글은 settings schema 칸 신설이 필요한데
   *      그 영토(settings·memory-schema)는 별 작업 범위다. 칸 없이 파라미터만
   *      배선하면 "켤 수 있는 척" 하는 거짓 toggle 이 된다.
   *   3. LLM 3단 자체는 죽지 않았다 — classifyEntityType(entity-type-classifier.ts)이
   *      opt-in 구현·테스트를 보유한다. 미래에 settings 토글이 생기면 그 호출처가
   *      classifyEntityType 을 직접 부른다(이 칸은 그 합류점 예약).
   */
  llm?: LlmClient | null;
  /**
   * 배치가 무언가 만들었을 때(위계·행·칸·라벨) 송출할 데이터 변동 trigger.
   * 미지정 시 no-op. wireHashtagConcepts 의 'hashtag-concept-added' 양식과 정합.
   */
  trigger?: AutoCleanupTriggerHandle;
  /** 관계/위계 출처. origin 노드 없는 엔티티 프로필 패치는 user_input. */
  provenance?: Provenance;
}

/**
 * 한 글의 일반 분류 콜론 태그(`#동물:고양이`)를 위계로 세운다 — Task 7(DCL-7).
 *
 * 글 입력 통로는 콜론 분류 태그를 위계로 안 만든다(parseTags 가 콜론을 버리고,
 * addClassificationTag 는 글 입력 경로에 없었다). 그래서 `#생물:동물 #동물:고양이` 를 글로 쳐도
 * `생물 → 동물`(타입 배치)만 생기고 `동물 → 고양이` 잎 단이 빠져 사용자 요구 "생물>동물>고양이가
 * 글 입력만으로 생긴다"가 미충족이었다. 이 단계가 그 잎 단을 메운다.
 *
 * 각 `#키:값` 을 네 갈래로 *겹침 0* 으로 가른다(단일 출처 재사용·하드코딩 0):
 *  1. 사람·프로젝트 경로가 *이 글에서 실제로 소비하는* 키(entityConsumedRawCategories)
 *     → 건너뜀. 예약 키(사람·생일·닉네임)뿐 아니라 그 글에 사람/프로젝트 대상이 있어
 *     소비되는 라벨 키(직업·회사와 project.attributes 에 남은 키)까지 포함한다. 대상이 없어 소비 안 되는
 *     라벨은 이 집합에 없으니 4 갈래로 갈 수 있다(정확히 겹침 0 — Task 7 보정).
 *  2. 타입 지시 키(생물·작품 등 — isTypeIndicatorKey, classifier typeIndicatorMap 단일 출처)
 *     → 건너뜀. 타입 배치(linkSubcategoryToTypeRoot)가 `타입 루트 → subcategory` 한 단을
 *     이미 세운다(예 `#생물:동물` → 생물 → 동물). subcategory 진입 키(동물)는 *타입 지시 키가
 *     아니라* 4 갈래로 가야 `동물 → 고양이` 잎 단이 세워진다(narrow 판정 — §isTypeIndicatorKey).
 *  3. 분류된 타입의 속성 키(장르·유통기한 등 — getTypeAttributes ∪ columnLabels) → 건너뜀.
 *     속성은 Task 5 의 칸/라벨 경로(applyEntityAttributes)가 이미 소비한다 — 일반 분류로도
 *     가면 같은 태그가 라벨과 위계로 이중 처리된다(겹침 0 위반). 그래서 속성 키를 뺀다.
 *  4. 나머지 일반 분류 콜론 태그 → store.addClassificationTag(rawCategory, value) 로 위계
 *     (weight 0.9·INSERT OR IGNORE 멱등·reflow 재사용 — 새 엣지 종류·새 테이블 0).
 *
 * DCL-4 정합 — 이 위계도 사용자가 명시한 콜론 태그(`#키:값`)에서만 생긴다(평면 글 씨앗 자동
 * 배치 아님). rawCategory 로 위계 키를 만든다(category 의 이미지 동의어 정규화(작품→series)
 * 우회 — classifier·타입 배치와 같은 규칙). 빈 키·빈 값은 parseClassificationTags 가 이미 거른다.
 *
 * 글당 1회 — 일반 분류 위계는 타입 독립이라 타입 그룹 루프 밖에서 한 번만 돈다(P4-A2).
 * 속성 제외(3 갈래)는 이 글에 배치된 *모든* 타입의 속성 키 합집합으로 넓힌다 — placedTypes
 * 에 사람+작품이 둘 다 들어오면 두 타입의 속성 어휘를 모두 빼 이중 처리 0 을 지킨다.
 *
 * 4-pre) 작품으로 등록되는 (매체, 이름) 쌍은 맨이름 그림자(개념+위계+멘션)를 안 만든다 —
 * `#소설:괴담` 이 store.addClassificationTag("소설","괴담") 으로 흘러 이름 UNIQUE 공유 맨이름
 * "괴담" 개념을 만들면 두 매체 글(소설·웹툰)이 한 노드 아래 엉킨다. work 행이 위계 잎·분리
 * 잎 개념으로 글을 지므로(§7.2 옵션 b·P3-leaf), 그 쌍은 일반 분류 위계로 중복 산출하지 않는다.
 * 제외 집합 excludedWorkPairs 는 work 배치와 같은 사슬 추적으로 진입부가 미리 뽑는다(드리프트 0).
 * 같은 매체 다른 값(`#소설:다른것`)은 제외 대상이 아니라 정상 그림자를 받는다.
 *
 * @param placedTypes 이 글에서 배치된 타입들(타입 그룹 루프가 모은 type 목록). 신규 8 타입만
 *                    속성 소비 대상이라 person/project 는 합집합에 안 보탠다(속성 칸/라벨 없음).
 * @param excludedWorkPairs work 가 소비하는 (매체, 이름) 쌍 키 집합 — 그 쌍 콜론 태그는 맨이름
 *                    그림자를 안 만들고 건너뛴다(workPairKey 단일 출처로 비교).
 * @returns 새로 호출한 addClassificationTag 횟수(로그·디버깅용).
 */
async function wireGeneralClassification(
  store: SqliteMemoryStore,
  originNodeId: number | null,
  content: string,
  placedTypes: PlacementTypeName[],
  excludedWorkPairs: Set<string>,
  provenance: Provenance,
): Promise<number> {
  // 1 갈래 단일 출처 — 사람·프로젝트 경로가 이 글에서 실제로 소비하는 키(맥락 의존 라벨 포함).
  const consumedByEntity = await entityConsumedRawCategories(store, content);

  // 3 갈래 — 이 글에 배치된 타입들의 속성 키(라벨 어휘 + 칸 어휘) 합집합을 빼둔다. 8 타입은
  // 물론 사용자가 화면으로 더한 *새 종류*(user 종류)의 칸도 포함한다 — 새 종류 글
  // `#가계부:배달 #금액:17000` 에서 '금액' 이 칸 어휘인데도 여기서 안 빠지면, 그 콜론 태그가
  // store.addClassificationTag("금액","17000") 으로 흘러 `금액→17000` 별개 분류 노드 쌍을
  // 만들어 entities 칸 저장과 이중이 된다(plan 2026-06-28 G5 문제1a). 타입별 속성 권위:
  //   · 8 타입 — getEntityTypeMeta(t).columnLabels(칸 권위) ∪ getTypeAttributes(t)(라벨 어휘).
  //   · user 종류 — getTypeColumns(t)(칸 권위·단계3 T8) ∪ getTypeAttributes(t). getEntityTypeMeta
  //     는 8 타입 레지스트리 전용이라 user 종류엔 throw 하므로 부르지 않는다(placeOneUserEntityType
  //     이 :432-434 에서 쓰는 getTypeColumns ∪ getTypeAttributes 와 같은 출처 — 칸/라벨 가름의
  //     단일 출처를 공유해 드리프트 0). 사람+작품 혼합 글이면 두 타입 모두에서 속성 키를 모아
  //     `#직업:`(person)·`#장르:`(work) 어느 쪽도 일반 분류 위계로 새지 않게 한다. person/project
  //     는 속성 소비 대상이 아니라 합집합에 안 보탠다(속성은 타입 칸/라벨 경로 전담). 배치 타입이
  //     없으면 빈 집합(전부 후보).
  const attrKeys = new Set<string>();
  for (const t of placedTypes) {
    if (isEntityType(t)) {
      const meta = getEntityTypeMeta(t);
      for (const k of getTypeAttributes(t)) attrKeys.add(k.toLowerCase());
      for (const k of Object.keys(meta.columnLabels)) attrKeys.add(k.toLowerCase());
    } else if (store.entityTypeRegistryDb.isUserEntityType(t)) {
      for (const k of getTypeAttributes(t)) attrKeys.add(k.toLowerCase());
      for (const k of getTypeColumns(t)) attrKeys.add(k.toLowerCase());
    }
    // person/project 는 속성 칸/라벨 어휘가 없어 합집합에 안 보탠다(무변).
  }

  let edges = 0;
  for (const tag of parseClassificationTags(content ?? "")) {
    const rawKey = tag.rawCategory.trim();
    const lowerRaw = rawKey.toLowerCase();
    // 1) 사람·프로젝트 경로가 이 글에서 실제로 소비하는 키(예약 키 + 소비된 라벨 키) — 전담.
    if (consumedByEntity.has(lowerRaw)) continue;
    // 2) 타입 지시 키(생물·작품) — 타입 배치가 전담.
    if (isTypeIndicatorKey(rawKey)) continue;
    // 2.5) 관계 키(주인·창작자 등) — 관계 wiring 이 전담. #주인:김철수 가
    //      주인→김철수 일반 분류 위계로 새면 relation source 해석이 깨진다.
    if (lookupRelationTag(rawKey) !== null) continue;
    // 3) 분류된 타입의 속성 키(장르·유통기한) — Task 5 칸/라벨이 전담(이중 처리 차단).
    if (attrKeys.has(lowerRaw)) continue;
    // 4-pre) 작품으로 등록되는 (매체, 이름) 쌍은 맨이름 그림자를 안 만든다 — work 행이 위계 잎·
    //        분리 잎 개념이 멘션을 진다(§7.2 옵션 b·P3-leaf 후속). 같은 매체 다른 값은 통과.
    if (excludedWorkPairs.has(workPairKey(rawKey, tag.value))) continue;
    // 4) 나머지 일반 분류 콜론 태그 → 위계(동물 → 고양이).
    await linkClassificationPair(
      store,
      originNodeId,
      tag.rawCategory,
      tag.value,
      provenance,
    );
    edges += 1;
  }
  return edges;
}

/**
 * 타입 미상 콜론 키에 등록 타입을 이어받아 배치한다 — P1(얼룩이) 합류(C2).
 *
 * 타입 그룹이 0개(명시 타입 선언 없는 글)일 때만 부른다. 그 글의 콜론 태그(`#고양이:얼룩이`)
 * 중 *타입 미상 키*(타입 지시 키도 분류 진입 키도 아닌 키 — 예 "고양이")를 골라
 * resolveInheritedType(store, 키) 로 그 키가 매달린 타입 위계를 역조회한다(C1). 까망이 글이
 * 세운 생물 > 동물 > 고양이 위계 덕에 "고양이" 가 creature 위계의 잎이면 얼룩이도 creature
 * 행으로 이어받는다.
 *
 *  - 상속 성공(type !== null && !ambiguous): 그 키:값을 상속 타입 선언으로 보고
 *    placeOneEntityType 에 넘긴다. classification 의 subcategory·categoryChain 을 *그 키*("고양이")
 *    로 채워 placeOneEntityType 의 잎 매달기 로직(부모 = 마지막 분류 단)이 얼룩이를 "고양이" 개념
 *    잎으로 정확히 매단다(생물 > 동물 > 고양이 > 얼룩이). source='explicit'·matched='키:값' 이라
 *    extractCandidateName 이 값(얼룩이)을 뽑고 H8 게이트 결정 A 가 행을 만든다.
 *  - 모호(ambiguous): 상속 보류 + 식별자 포함 경고만 남긴다(거짓 타입 0).
 *  - 미등록(type null && !ambiguous): 아무것도 안 한다 — 기존 기타 글 동작 그대로(회귀 0).
 *
 * 명시 타입 선언이 있는 글은 호출처가 groups.length > 0 갈래로 가 이 경로를 안 탄다(중복 0).
 *
 * 한 글에 타입 미상 키가 여럿이면 각각 역조회·각각 배치한다(사슬이면 잎 값이 candidate·키가
 * 부모). 사슬 머리(키가 다른 태그의 값으로 안 쓰이는 키)만 상속 대상으로 골라, 사슬 중간 키
 * (`#동물:고양이` 의 동물 — 미등록이면 자연히 거름)가 잎을 중복 배치하지 않게 한다.
 *
 * @returns 상속으로 배치를 시도한 키 수(0이면 상속 대상 없음·기타 글 그대로).
 */
async function wireInheritedTypePlacement(
  store: SqliteMemoryStore,
  originNodeId: number | null,
  content: string,
  result: EntityPlacementResult,
  provenance: Provenance,
): Promise<number> {
  const subcatMap = subcategoryToTypeMap();
  const tags = parseClassificationTags(content ?? "");

  // 글 전체 콜론 태그의 값 집합(소문자) — 사슬 중간 키(키가 다른 태그의 값)를 거른다.
  const valuesInContent = new Set<string>();
  for (const tag of tags) {
    const v = tag.value.trim().toLowerCase();
    if (v) valuesInContent.add(v);
  }

  let attempted = 0;
  const seenKeys = new Set<string>(); // 같은 키 둘+ 중복 역조회 차단(첫 등장만).
  for (const tag of tags) {
    const rawKey = tag.rawCategory.trim();
    const lowerKey = rawKey.toLowerCase();
    if (!rawKey || !tag.value.trim()) continue;
    // 타입 지시 키(생물·작품)·분류 진입 키(동물·소설)는 타입 미상이 아니다 — 명시 분류 경로.
    if (isTypeIndicatorKey(rawKey) || subcatMap.has(lowerKey)) continue;
    // 사슬 머리만 — 키가 다른 콜론 태그의 값으로 쓰이면 사슬 중간이라 머리가 잎까지 탄다.
    if (valuesInContent.has(lowerKey)) continue;
    if (seenKeys.has(lowerKey)) continue;
    seenKeys.add(lowerKey);

    const inherited = await resolveInheritedType(store, rawKey);
    if (inherited.ambiguous) {
      result.warnings.push(
        `'${rawKey}' 가 여러 타입에 등록돼 상속 보류 — ${inherited.reason ?? "모호"}`,
      );
      continue;
    }
    if (inherited.type === null) continue; // 미등록 — 기타 글 그대로(회귀 0).

    attempted += 1;
    // 상속 타입 선언으로 본 classification 을 구성한다. 마지막 분류 단 = 그 키("고양이")라
    // placeOneEntityType 의 잎 매달기가 부모를 "고양이" 개념으로 잡는다(생물>동물>고양이>얼룩이).
    const classification: EntityTypeClassification = {
      typeName: inherited.type,
      subcategory: rawKey,
      confidence: 1.0,
      source: "explicit",
      matched: `${rawKey}:${tag.value}`,
      chainStop: {
        reason: "leaf",
        depth: 1,
        visitedKeys: [lowerKey],
      },
      categoryChain: [rawKey],
    };
    // subContent = 이 키:값 한 줄 — buildCandidateAndAttributes 가 값(얼룩이)을 후보로 뽑는다.
    const subContent = `#${rawKey}:${tag.value}`;
    // 상속 타입을 결과에 담는다(그룹 루프가 result.typeName 을 set 하는 자리를 상속 경로가
    // 직접 진다 — placeOneEntityType 은 result.typeName 을 안 건드린다). 마지막 상속 키 기준.
    result.typeName = inherited.type;
    result.subcategory = rawKey;
    await placeOneEntityType(
      store,
      originNodeId,
      content,
      classification,
      subContent,
      result,
      provenance,
    );
  }
  return attempted;
}

interface RelationSourceCandidate {
  rawCategory: string;
  value: string;
}

function intersectRelationSourceTypes(
  relationTags: ReturnType<typeof parseRelationTags>,
): PlacementTypeName[] {
  let current: Set<PlacementTypeName> | null = null;
  for (const tag of relationTags) {
    const allowed = tag.spec.sourceTypes.filter((t) => isEntityType(t));
    const allowedSet = new Set<PlacementTypeName>(allowed);
    if (current === null) {
      current = allowedSet;
      continue;
    }
    current = new Set([...current].filter((t) => allowedSet.has(t)));
  }
  return [...(current ?? new Set<PlacementTypeName>())];
}

function relationSourceCandidates(
  content: string,
  sourceType: PlacementTypeName,
): RelationSourceCandidate[] {
  const reservedKeys = new Set(
    Object.keys(loadReservedKeys()).map((k) => k.trim().toLowerCase()),
  );
  const sourceAttributeKeys = buildTypeAttributeKeys(sourceType);
  const candidates: RelationSourceCandidate[] = [];

  for (const tag of parseClassificationTags(content ?? "")) {
    const rawKey = tag.rawCategory.trim();
    const lowerKey = rawKey.toLowerCase();
    const value = tag.value.trim();
    if (!rawKey || !value) continue;
    if (lookupRelationTag(rawKey) !== null) continue;
    if (reservedKeys.has(lowerKey)) continue;
    if (sourceAttributeKeys.has(lowerKey)) continue;
    candidates.push({ rawCategory: rawKey, value });
  }

  return candidates;
}

async function wireRelationDrivenSourcePromotion(
  store: SqliteMemoryStore,
  originNodeId: number | null,
  content: string,
  result: EntityPlacementResult,
  provenance: Provenance,
): Promise<number> {
  const relationTags = parseRelationTags(content);
  if (relationTags.length === 0) return 0;

  const sourceTypes = intersectRelationSourceTypes(relationTags);
  if (sourceTypes.length !== 1) {
    result.warnings.push(
      `관계 source 타입이 ${sourceTypes.length}개라 자동 승격 보류 ` +
        `(관계 키: ${relationTags.map((t) => t.rawKey).join(", ")})`,
    );
    return 0;
  }

  const sourceType = sourceTypes[0]!;
  const candidates = relationSourceCandidates(content, sourceType);
  if (candidates.length !== 1) {
    result.warnings.push(
      `관계 source 후보가 ${candidates.length}개라 자동 승격 보류 ` +
        `(source 타입 '${sourceType}', 후보: ${
          candidates.map((c) => `#${c.rawCategory}:${c.value}`).join(", ") || "없음"
        })`,
    );
    return 0;
  }

  const candidate = candidates[0]!;
  const classification: EntityTypeClassification = {
    typeName: sourceType,
    subcategory: candidate.rawCategory,
    confidence: 1.0,
    source: "explicit",
    matched: `${candidate.rawCategory}:${candidate.value}`,
    chainStop: {
      reason: "leaf",
      depth: 1,
      visitedKeys: [candidate.rawCategory.trim().toLowerCase()],
    },
    categoryChain: [candidate.rawCategory],
  };

  result.typeName = sourceType;
  result.subcategory = candidate.rawCategory;
  await placeOneEntityType(
    store,
    originNodeId,
    content,
    classification,
    `#${candidate.rawCategory}:${candidate.value}`,
    result,
    provenance,
  );
  return 1;
}

/**
 * 한 글의 타입 배치를 묶어 돌린다 — 타입별로 갈라 각 타입마다 배치를 한 번씩 돈다(P4-A2).
 *
 * 옛 흐름은 classifyEntityType 한 번으로 *한 타입*만 잡아, 사람+작품 혼합 글에서 첫 매치
 * (person)로 글 전체를 판정하고 `#작품:` 선언이 사라졌다(근본 문제). 새 흐름은
 * groupTypeDeclarations 로 글의 타입 선언을 타입별 그룹으로 갈라, 각 그룹·선언 값마다 배치를
 * 한 번씩 돌린다 — 사람+작품 글이 person 위계 + work 행 둘 다 만든다.
 *
 *  - 일반 분류 위계(wireGeneralClassification)는 타입 독립이라 루프 밖에서 글당 1회만 돈다
 *    (그룹마다 반복하면 중복). 속성 제외는 이 글에 배치된 모든 타입의 합집합으로 넓힌다.
 *  - person 그룹 → wirePersonHierarchy(위계만). 행·라벨·mentions 는 입력 통로
 *    wireHashtagEntities 가 전담한다(역할 경계·이중 처리 0).
 *  - project 그룹 → 제외(기존 변동 0).
 *  - 8 타입 그룹 → 선언 값마다 placeOneEntityType. 단 같은 *분류 키* 둘+(`#웹툰:A #웹툰:B`)는
 *    첫째만 행·둘째+ 미반영 경고(옵션 A·기존 (나) 동작 보존). 같은 *타입 지시 키* 둘
 *    (`#작품:데못죽 #작품:괴담`)은 각각 별개 행(P4 — 분류 키가 아니라 둘 다 고유 작품).
 *
 * result.typeName·subcategory 는 *마지막 그룹*의 판정을 담는다(단일 타입 글에서 옛 단일 동작과
 * 동치 — 그룹이 하나뿐이면 그 타입). entityId 는 마지막 생성 행. 반환 형은 불변(호출처 무수정).
 * 멱등 — 모든 하위 단계가 멱등이라 같은 글로 두 번 불러도 중복 0.
 *
 * @param store        실제 SqliteMemoryStore(실 DB·실 임베딩).
 * @param originNodeId 분류 신호가 나온 글 노드 id — 위계 연결이 이 글을 분류 키에 잇는다.
 * @param content      글 본문(태그 포함 원문). 여기서 다시 파싱한다(wireHashtagConcepts 양식).
 * @param options      llm(예약 칸·이 경로는 안 읽음·L2 동결)·trigger.
 * @returns 배치 결과(로그·디버깅용).
 */
export async function wireEntityPlacement(
  store: SqliteMemoryStore,
  originNodeId: number | null,
  content: string,
  options: WireEntityPlacementOptions = {},
): Promise<EntityPlacementResult> {
  const provenance = options.provenance ?? (originNodeId === null ? "user_input" : "hashtag");
  const result: EntityPlacementResult = {
    typeName: null,
    subcategory: null,
    hierarchyEdges: 0,
    entityRowCreated: false,
    entityId: null,
    columnsApplied: 0,
    labelsApplied: 0,
    relationEdges: [],
    warnings: [],
    entities: [],
  };

  // 1) 타입 선언을 타입별 그룹으로 가른다(A1 순수 함수·단일 출처 맵). 빈 배열이면 기타 글.
  //    직접 입력 칸 갈래(place ∪ node_field) reserved key 로 선언된 콜론 태그는 타입 배치에서
  //    뺀다 — 그 키(`#장소`)는 직접 입력 파서(쉼표 경계·setPlace)가 전담한다(라이브 결함 수정:
  //    `#장소:강남 A마트` 의 콜론 잘림 "강남" 유령 차단). isTypeIndicatorKey·yaml 은 안
  //    건드린다(글 본문 분류 영향 0) — 입력 통로 콜론 배치만 제외한다.
  const groups = excludeDirectInputDeclarations(
    groupTypeDeclarations(content),
    content,
  );

  // 1.1) 사람 주체 글 판정(P4 재정의·글 주체) — 글에 명시 `#사람:` 선언이 있으면 사람 주체 글이다.
  //      그러면 `#작품:` 은 새 work 행을 만들지 않고, 같은 글의 사람을 작가로 보아 기존 동명+작가
  //      작품에 글→작품 연결만 세운다(행 생성 경로 우회·H8 0 diff). 작가 후보 = `#사람:` 첫 값.
  //      personDeclarations 가 명시 `#사람:` 선언 신호다(라벨·콜론 없는 이름 아님 — 명시 선언만).
  const personDecls = parseHashtagEntities(content).personDeclarations;
  const personDeclared = personDecls.length > 0;
  const personDocAuthor = personDeclared ? (personDecls[0]?.trim() ?? "") : "";

  // 글 전체 콜론 태그의 값 집합(소문자) — 사슬 진입점 판정에 쓴다(키가 다른 태그의 값이면 사슬 중간).
  const valuesInContent = new Set<string>();
  for (const tag of parseClassificationTags(content ?? "")) {
    const v = tag.value.trim().toLowerCase();
    if (v) valuesInContent.add(v);
  }

  // 1.5) 일반 분류 콜론 위계(Task 7 / DCL-7)는 타입 독립이라 루프 밖 글당 1회. 속성 제외는
  //      이 글에 배치된 모든 타입의 합집합으로 넓힌다 — `#직업:`(person)·`#장르:`(work) 둘 다
  //      이중 처리 0. 타입 선언이 없어도(기타 글) 명시 콜론 분류 태그면 위계를 받는다(DCL-4).
  const placedTypes = groups.map((g) => g.type);
  // 작품으로 등록되는 (매체, 이름) 쌍은 일반 분류 위계가 맨이름 그림자를 안 만들게 제외한다
  // (P3-leaf 후속·A안 형태 (a)). work 배치와 같은 사슬 추적으로 미리 뽑아 드리프트 0.
  const excludedWorkPairs = workConsumedClassificationPairs(content);
  result.hierarchyEdges += await wireGeneralClassification(
    store,
    originNodeId,
    content,
    placedTypes,
    excludedWorkPairs,
    provenance,
  );

  // 2) 타입 그룹이 없으면(명시 타입 선언 없는 글) — 타입 상속 경로를 먼저 시도한다(P1·C2).
  //    `#고양이:얼룩이` 처럼 타입 미상 콜론 키지만 그 키가 이미 등록된 타입 위계의 잎이면
  //    그 타입을 이어받아 배치한다. 상속도 안 되면(미등록) 일반 분류 위계 신호만 남기고
  //    끝낸다(기타 글·빈 결과 ≠ 실패).
  if (groups.length === 0) {
    await wireInheritedTypePlacement(
      store,
      originNodeId,
      content,
      result,
      provenance,
    );
    if (!result.entityRowCreated && result.relationEdges.length === 0) {
      await wireRelationDrivenSourcePromotion(
        store,
        originNodeId,
        content,
        result,
        provenance,
      );
    }
    if (
      result.hierarchyEdges > 0 ||
      result.entityRowCreated ||
      result.relationEdges.length > 0
    ) {
      options.trigger?.emit("hashtag-concept-added");
    }
    return result;
  }

  // 3) 타입 그룹마다 배치를 한 번씩 돈다.
  let connectedWorks = 0; // P4 사람 글 → 기존 작품 연결 mention 수(SSE trigger 신호용).
  for (const group of groups) {
    result.typeName = group.type; // 마지막 그룹 판정을 담는다(단일 타입 글 = 옛 동작 동치).

    if (group.type === "person") {
      // person — 위계만 편입한다(사람 루트 → 분류 parent_of). 행·라벨·mentions 는 입력 통로
      // wireHashtagEntities 가 전담(역할 경계·이중 처리 0). 글 원문으로 위계를 본다.
      const ph = await wirePersonHierarchy(
        store,
        originNodeId,
        content,
        provenance,
      );
      result.hierarchyEdges += ph.hierarchyEdges;
      result.warnings.push(...ph.warnings);
      continue;
    }
    // 단계3 T4 — 사용자가 화면으로 더한 *새 종류*(기존 10종 밖 DB 종류)는 전용 헬퍼
    // placeOneUserEntityType 으로 분기한다(기존 8 타입 placeOneEntityType 경로 byte 동일).
    // 새 종류 판정 = store.entityTypeRegistryDb.isUserEntityType(코드 상수 밖 + DB 명부에
    // 있음). 8 타입 entries 루프와 *같은 사슬 진입점 추출·분류기 태우기* 를 쓰되, 행 생성·
    // 위계·라벨은 범용 본체(entities)로 간다. attrKeys 는 새 종류 속성 어휘(라벨 getTypeAttributes
    // ∪ 칸 getTypeColumns·단계3 T8)로 짓는다 — buildTypeAttributeKeys 는 8 타입 전용(isEntityType
    // false 면 빈 집합)이라 새 종류 속성·칸 태그가 sub-content 에 합류하도록 여기서 직접 모은다.
    // 칸 키를 빼면 `#구입일:값` 이 sub-content 에 안 들어와 placeOneUserEntityType 의 칸 가름이
    // 못 본다(칸값이 색인에서 통째로 빠지는 결함) — 라벨·칸 둘 다 모아야 입력 가름이 닿는다.
    //
    // 단계3(콜론 사슬 구조 배치 D5) — project 도 이 새 종류 통로로 합류시킨다. project 는
    // entities 단일 모델(identity 없음·spec §11 D6 대안 A 정합)이라 8 타입 이중 표현(단계4)을
    // 안 건드리고 루트 개념·위계 사슬·끝-실체 leaf 를 받는다. project 는 STATIC 종류라
    // isUserEntityType=false 라서 명시 합류 조건을 더한다(spec §12 단계3·§9 D5). getTypeColumns
    // ("project") 는 빈 배열·getTypeAttributes("project")=[참여자] 정상 반환이라
    // 새 종류 attrKeys 짜기가 그대로 동작한다. 행 생성은 findOrCreateEntity("project",name) 이
    // 옛 findOrCreateProject 와 name UNIQUE 로 같은 prj_ 행을 공유한다(멱등·충돌 0). 글↔project
    // 연결(setNodeProjectId·project_id 칸)은 옛 통로(wireHashtagEntities)가 단일 책임 유지.
    if (
      store.entityTypeRegistryDb.isUserEntityType(group.type) ||
      group.type === "project"
    ) {
      const attrKeys = new Set<string>();
      for (const k of getTypeAttributes(group.type)) attrKeys.add(k.toLowerCase());
      for (const k of getTypeColumns(group.type)) attrKeys.add(k.toLowerCase());
      const entries = chainEntriesOf(group, valuesInContent);
      if (entries.length === 0) {
        // 진입점 0 — 순환 사슬이라 머리가 없다. 분류기에 글을 한 번 태워 경고만 남긴다
        // (silent 차단·행은 placeOneUserEntityType 의 빈 후보 게이트가 막는다).
        const cls = classifyEntityTypeDeterministic(content);
        if (cls.typeName !== group.type) continue;
        const subContent = content;
        await placeOneUserEntityType(
          store,
          originNodeId,
          content,
          cls,
          subContent,
          result,
          provenance,
        );
        result.subcategory = cls.subcategory;
        continue;
      }
      const placedSubcategoryValues = new Set<string>(); // 그룹 안 (나) 중복 가드.
      for (const entry of entries) {
        const subContent = buildForwardChainSubContent(entry, content, attrKeys);
        const classification = classifyEntityTypeDeterministic(subContent);
        // 새 종류 그룹의 분류 산출 typeName 이 그 새 종류가 아니면(어휘 이상) 방어적 건너뜀.
        if (classification.typeName !== group.type) continue;
        // (나) 같은 분류 키 둘+ — 마지막 분류 단 기준 첫째만 행(옵션 A·기존 동작 보존).
        const lastCategory = lastCategoryOf(classification);
        if (lastCategory) {
          const subKey = lastCategory.trim().toLowerCase();
          if (placedSubcategoryValues.has(subKey)) continue;
          placedSubcategoryValues.add(subKey);
        }
        await placeOneUserEntityType(
          store,
          originNodeId,
          content,
          classification,
          subContent,
          result,
          provenance,
        );
        result.subcategory = classification.subcategory;
        // (나) 미반영 경고 — 같은 마지막 분류 단 둘째+ 값을 정직히 알린다(기존 양식 미러).
        if (lastCategory) {
          const extras = detectSameSubcategoryExtras(content, lastCategory);
          if (extras.length > 0) {
            const head = extractCandidateName(classification) || entry.value.trim();
            result.warnings.push(
              `같은 분류 '${lastCategory}' 에 둘 이상 — ` +
                `'${extras.join("', '")}' 미반영(첫째 '${head}' 만 엔티티)`,
            );
          }
        }
      }
      continue; // 새 종류 배치 완료 — 8 타입 경로(아래)를 우회한다.
    }

    // P4 재정의(글 주체) — 사람 주체 글의 work 선언은 행을 만들지 않고 기존 동명+작가 작품에
    // 연결만 한다. work 한정(Q3-3) — 다른 8 타입(creature 등)은 personDeclared 와 무관하게
    // 기존 배치 그대로다. 작가 미입력 작품 글(`#작품:괴담` 사람 선언 없음)은 personDeclared=false
    // 라 이 갈래를 안 타고 아래 기존 배치로 간다(행 생성·무변).
    if (originNodeId !== null && group.type === "work" && personDeclared) {
      // 행 생성 경로와 *같은* 사슬 진입점 판정(chainEntriesOf)·잎 후보 추출을 태워 연결 대상을
      // 가린다 — raw declValues 를 그대로 쓰면 사슬 양식(`#작품:소설 #소설:괴담`)에서 매체 토큰
      // ('소설' — work subcategory 키)도 declValues 에 합류해 거짓 경고가 난다. 진입점에서
      // forward 로 잎까지 분류기를 태워 candidateName(제목 '괴담')만 연결 대상으로 삼는다
      // (드리프트 0 — 행 생성 경로가 매체 토큰을 거르는 그 방식 재사용). 독립 선언
      // (`#작품:데못죽 #작품:괴담`)은 각각 잎이라 둘 다 연결 대상이 된다.
      const attrKeys = buildTypeAttributeKeys(group.type);
      const entries = chainEntriesOf(group, valuesInContent);
      const seenWorkNames = new Set<string>();
      for (const entry of entries) {
        const subContent = buildForwardChainSubContent(entry, content, attrKeys);
        const classification = classifyEntityTypeDeterministic(subContent);
        if (classification.source !== "explicit") continue;
        const workName = extractCandidateName(classification).trim();
        if (!workName) continue; // 사슬이 분류에서 끝나 잎 제목이 없음 — 연결 대상 아님(거짓 경고 0).
        const key = workName.toLowerCase();
        if (seenWorkNames.has(key)) continue;
        seenWorkNames.add(key);
        connectedWorks += await connectPersonDocWork(
          store,
          originNodeId,
          workName,
          personDocAuthor,
          result,
        );
      }
      continue; // 행 생성 경로(아래)를 우회한다 — 사람 글 work 는 연결만(H8 0 diff).
    }

    // 8 타입 그룹 — *사슬 진입점* 선언마다 배치한다. 사슬 연결 선언(`#작품:소설 #소설:데못죽`)은
    // 한 엔티티라 머리(작품:소설) 한 번만 배치하고 분류기가 잎까지 forward 로 탄다. 독립 선언
    // (`#작품:데못죽 #작품:괴담`)은 각각 별개 행(P4). 같은 분류 키 둘+(`#웹툰:A #웹툰:B`)는
    // 첫째만(옵션 A·기존 (나) 보존).
    const attrKeys = buildTypeAttributeKeys(group.type);
    const entries = chainEntriesOf(group, valuesInContent);

    if (entries.length === 0) {
      // 진입점 0 — 순환 사슬(`#작품:소설 #소설:작품`)이라 머리가 없다. 분류기에 글을 한 번
      // 태워 depth-or-cycle 경고만 남긴다(silent 차단·행은 게이트가 막는다·기존 동작 보존).
      const cls = classifyEntityTypeDeterministic(content);
      if (cls.typeName !== group.type) continue;
      result.subcategory = cls.subcategory;
      const candidate =
        cls.source === "explicit" ? extractCandidateName(cls) : "";
      // group.type 은 위에서 person/project 를 거른 뒤라 항상 신규 8 타입이다(방어 가드).
      const createdRow = isEntityType(group.type)
        ? await createRowForPlacement(
            store,
            group.type,
            candidate,
            cls,
            false,
            content,
            isMidChainNode(candidate, content),
          )
        : null;
      if (createdRow) {
        result.entityRowCreated = true;
        result.entityId = createdRow.id;
      }
      if (cls.chainStop?.reason === "depth-or-cycle") {
        result.warnings.push(
          "사슬이 비정상으로 길거나 순환 — 결과가 의도와 다를 수 있음" +
            ` (추적 경로: ${cls.chainStop.visitedKeys.join(" → ")})`,
        );
      } else {
        appendChainStopWarning(result, cls, candidate);
      }
      continue;
    }

    const placedSubcategoryValues = new Set<string>(); // 그룹 안 (나) 중복 가드(소문자 분류 키).
    for (const entry of entries) {
      // 이 진입점에서 forward 로 이어지는 사슬 전체 + 이 타입 속성을 담은 sub-content 를 짓고
      // 분류기에 태운다(잎까지 traceColonChain 이 탄다).
      const subContent = buildForwardChainSubContent(entry, content, attrKeys);
      const classification = classifyEntityTypeDeterministic(subContent);
      if (
        classification.typeName === null ||
        !isEntityType(classification.typeName)
      ) {
        continue; // 그룹 타입과 어긋나면(어휘 이상) 방어적으로 건너뛴다.
      }

      // (나) 같은 분류 키 둘+ — 분류 진입 키(`#웹툰:`)로 들어온 선언은 마지막 분류 단 기준
      // 첫째만 행을 만든다. 둘째+ 는 미반영 경고만(옵션 A·기존 동작). 타입 지시 키(`#작품:`)로
      // 들어온 선언은 subcategory 가 null 이라 이 가드를 안 타고 각각 별개 행이 된다(P4).
      const lastCategory = lastCategoryOf(classification);
      if (lastCategory) {
        const subKey = lastCategory.trim().toLowerCase();
        if (placedSubcategoryValues.has(subKey)) {
          // 같은 마지막 분류로 들어온 둘째 진입점 — 행을 안 만든다(첫째만 엔티티).
          continue;
        }
        placedSubcategoryValues.add(subKey);
      }

        await placeOneEntityType(
          store,
          originNodeId,
          content,
          classification,
          subContent,
          result,
          provenance,
        );
      // 마지막으로 본 그룹의 subcategory 를 담는다(단일 타입 글 = 옛 단일 동작 동치).
      result.subcategory = classification.subcategory;

      // (나) 미반영 경고 — 같은 마지막 분류 단(`#피부과:한빛의원 #피부과:서울의원`) 아래 둘째+
      // 값을 글 전체에서 찾아 정직히 알린다(silent 차단·기존 detectSameSubcategoryExtras 동작
      // 보존). 한 사슬 안 같은 분류 둘(forward 가 첫째만 탐) + 별개 진입점 둘 다 여기서 잡힌다.
      if (lastCategory) {
        const extras = detectSameSubcategoryExtras(content, lastCategory);
        if (extras.length > 0) {
          const head = extractCandidateName(classification) || entry.value.trim();
          result.warnings.push(
            `같은 분류 '${lastCategory}' 에 둘 이상 — ` +
              `'${extras.join("', '")}' 미반영(첫째 '${head}' 만 엔티티)`,
          );
        }
      }
    }
  }

  if (
    result.hierarchyEdges > 0 ||
    result.entityRowCreated ||
    result.relationEdges.length > 0 ||
    connectedWorks > 0
  ) {
    options.trigger?.emit("hashtag-concept-added");
  }
  return result;
}

/**
 * wireEntityPlacement 를 실패 격리해 가동한다 — wireHashtagConceptsSafe 양식.
 *
 * 배치 실패(분류·위계·행·칸/라벨 어디서 throw 든)는 삼키지 않고 origin id·사유와 함께 warn
 * 후 진행한다 — origin 노드 저장은 입력 통로가 이미 끝냈으므로 원본 유실 0(silent fallback
 * 금지 정신: 실패를 "0개 배치"로 위장하지 않고 사유를 warn 에 남긴다 — CLAUDE.md
 * "실패 ≠ 빈 결과"). 타입 배치 실패가 입력 저장을 통째 깨지 않게 격리한다.
 *
 * @param label warn 메시지 출처 라벨(호출 통로 식별 — 예: 'saveTextInput').
 * @param llm   LLM 단 클라이언트 — 예약 칸. wireEntityPlacement 가 안 읽는다(L2 동결·
 *              결정적 1·2단만). 입력 통로는 안 넘기거나 null 을 넘긴다.
 */
export async function wireEntityPlacementSafe(
  store: SqliteMemoryStore,
  originNodeId: number | null,
  content: string,
  trigger: AutoCleanupTriggerHandle | undefined,
  label: string,
  llm?: LlmClient | null,
  provenance?: Provenance,
): Promise<void> {
  try {
    await wireEntityPlacement(store, originNodeId, content, {
      llm,
      trigger,
      provenance,
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    const originLabel = originNodeId === null ? "origin 없음" : `원본 ${originNodeId}`;
    console.warn(
      `[${label}] 엔티티 타입 배치 실패 (${errMsg}) — ${originLabel}, ` +
        `타입 배치(위계·행·칸/라벨) 누락`,
    );
  }
}
