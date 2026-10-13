/**
 * entity-attribute-wiring.ts — 1급 엔티티 행의 칸/라벨/identity 채우기
 * (개념 엔티티 타입 체계 3단계 Task 4, spec §3 3분법·§5·§6.6).
 *
 * Task 3 이 끝 고유명 1급 행(works·intakes …)을 만든 뒤, 그 행에 걸린 속성 태그
 * (`#유통기한:2026-07-01`·`#장르:판타지`·`#주소:...`)를 spec §3 3분법으로 가른다:
 *
 * 각 키를 네 갈래로 가른다(spec §3 3분법 = 칸/라벨/관계, 그리고 알 수 없는 키):
 *  1. 칸(고유 사실)  = 키가 entity-type-registry 의 columnLabels(칸 어휘)에 있으면 칸 —
 *                    1단계 facade update<Type>(id, { <camel>: 값 }) 의 own 칸 경로로
 *                    갱신한다(예 섭취 '유통기한' → intakes.expires_at).
 *  2. 라벨(공유 특성) = 키가 그 타입의 *라벨 어휘*(2단계 getTypeAttributes − columnLabels
 *                    칸 어휘 − RELATION_TAG_KEYS 관계 키)에 있으면 라벨 — value 를 개념으로
 *                    findOrCreateConcept 한 뒤 addEntityConceptEdge has_attribute 로 잇는다
 *                    (예 작품 '장르:판타지' → work_concept_edges has_attribute(판타지)).
 *  3. 관계 키(다른 행) = 키가 RELATION_TAG_KEYS(창작자·주인 등)면 칸도 라벨도 아니라
 *                    명시 skip 한다 — 작품→사람 created_by 같은 엔티티 행 ↔ 행 엣지는
 *                    wireEntityRelations(Task 4)가 entity_relation_edges 에 세운다. 여기서
 *                    라벨로 만들면 `#창작자:아쿠타미` 가 작품→"아쿠타미" 라벨로 새어 3분법이
 *                    깨진다(4단계 부분 B 경계 수정).
 *  4. 알 수 없는 키  = 칸·라벨 어휘·관계 키 어느 쪽도 아니면(예 '생일'·오타·임의 키)
 *                    건너뛰고 결과 skipped 에 사유를 남긴다. 라벨로 보내지 않는다 — 생일 같은
 *                    고유 값이 라벨 개념이 되면 같은 값의 무관 개체가 검색으로 묶여 3분법이 깨진다.
 *
 * 칸 어휘 단일 출처 = registry columnLabels, 라벨 어휘 단일 출처 = 2단계 getTypeAttributes
 * (둘 다 이 파일에 하드코딩 0). 알 수 없는 키만 정직하게 건너뛴다(silent drop 금지 —
 * 아래 결과 reason 에 사유를 남긴다).
 *
 * 환각 금지 규칙:
 *  - 미입력 칸은 건드리지 않는다 — update<Type> 의 own 인자에 *준 키만* 넣어, 안 준 칸은
 *    facade 가 SET 절에서 빼므로 NULL 그대로 남는다(빈 채로 두는 게 정직).
 *  - 알 수 없는 키는 정직하게 건너뛰고 결과(skipped)에 키·사유를 남긴다.
 *  - 미존재 엔티티 id 는 facade update<Type> 가 null 을 돌려준다 — 이 경우 칸 갱신을
 *    "0개 처리"로 위장하지 않고 식별자와 함께 loud throw 한다(spec/CLAUDE.md "실패 ≠ 빈 결과").
 *
 * identity 엣지(linkEntityIdentity)는 글이 언급한 개념 ↔ 엔티티 행을
 * `role='identity'`(Task 1 repository)로 잇는다. 위계 단일 출처 재설계 뒤 역할이 *위계 잎
 * 지목 → 검색 mention 링크·identity JOIN 키* 로 바뀌었다(검색·관계 검색·그래프 노드 합류가
 * 이 엣지로 엔티티 행에 닿는다). 칸·라벨 채우기 뒤 마지막에 부른다. 개념 id 해소는 호출
 * 측이 미리 한다.
 *
 * 사람·프로젝트는 이 파일이 다루지 않는다 — 기존 wireHashtagEntities(공통 인프라 1.2)가
 * 사람·프로젝트 칸/라벨을 이미 처리한다. 이 모듈은 신규 8 타입(EntityTypeName) 전용이다.
 *
 * Task 5 오케스트레이션이 행 생성(Task 3) 뒤 applyEntityAttributes·linkEntityIdentity 를
 * 부른다 — 이 Task 는 그 함수 토대만 만든다(입력 통로 합류는 Task 5).
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import {
  getEntityTypeMeta,
  type EntityTypeName,
} from "../db/store-internal/entity-type-registry.ts";
import { getTypeAttributes, getCanonicalItemKey } from "./concept-type-vocabulary.ts";
import { relationTagKeySet } from "./entity-relation-vocabulary.ts";
import type { Provenance } from "./provenance-vocabulary.ts";

/** 한 속성 태그 — `#키:값` 한 쌍(예: 키='유통기한', value='2026-07-01'). */
export interface EntityAttributeTag {
  /** 한국어 속성 태그 키(예: '유통기한'·'장르'·'주소'). */
  key: string;
  /** 그 키의 값(예: '2026-07-01'·'판타지'·'서울시 ...'). */
  value: string;
}

/** 건너뛴 속성 태그 한 건 — 키와 사람이 읽을 한국어 사유(silent drop 금지). */
export interface SkippedAttribute {
  key: string;
  value: string;
  reason: string;
}

/** applyEntityAttributes 결과 — 칸 갱신·라벨 엣지·건너뜀을 정직하게 분리해 돌려준다. */
export interface ApplyAttributesResult {
  /** 전용 칸으로 갱신한 속성 키 목록(예: ['유통기한']). */
  columnKeys: string[];
  /** has_attribute 엣지를 새로 만든 라벨 개념 id 목록(멱등 — 중복은 안 셈). */
  labelConceptIds: string[];
  /** 알 수 없는 키라 건너뛴 속성 — 키·값·사유. */
  skipped: SkippedAttribute[];
}

/**
 * 신규 8 타입(EntityTypeName)인지 런타임 확인 — 사람·프로젝트나 오타 타입은 식별자와
 * 함께 loud throw 한다. getEntityTypeMeta 가 이미 미등록 타입에 throw 하지만, 사람·
 * 프로젝트는 EntityTypeName 이 아니므로 여기서 명시 메시지로 막아 의도(8 타입 전용)를
 * 코드로 드러낸다(silent drop 금지).
 */
function assertEntityType(typeName: string): asserts typeName is EntityTypeName {
  const KNOWN: EntityTypeName[] = [
    "creature",
    "thing",
    "intake",
    "usable",
    "work",
    "material",
    "place",
    "schedule",
  ];
  if (!(KNOWN as string[]).includes(typeName)) {
    throw new Error(
      `entity-attribute-wiring: '${typeName}' 은(는) 신규 8 타입(${KNOWN.join(", ")}) 이 ` +
        `아니다 — 사람·프로젝트 칸/라벨은 wireHashtagEntities(공통 인프라 1.2)가 전담한다`,
    );
  }
}

/**
 * camelCase facade 인자 이름을 전용 칸 schema 칼럼 이름(snake_case)으로 바꾼다 — 단계4 T4
 * 가 전용 테이블 칼럼을 범용 본체 entity_attributes(is_column=1)로 옮길 때 쓸 stable
 * attr_key 다(결정 1·spec §4.1 expires_at·usage_instructions·topic·address·event_at).
 * 현 8 타입의
 * 모든 ownColumn.name 은 camelToSnake(camelField) 와 정확히 일치한다 — applyOwnColumns 가
 * meta.ownColumns 로 검증해 드리프트를 loud 로 잡는다(하드코딩 8-case map 회피).
 */
function camelToSnake(camel: string): string {
  return camel.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

/**
 * 한 타입·id 의 전용 칸을 범용 본체 entity_attributes(is_column=1)에 채운다 — 단계4 T4 가
 * 전용 테이블 흡수 뒤 store.updateX(own) 위임을 범용 setAttribute 로 바꾼 통로(결정 1).
 *
 * own 은 camelCase facade 인자(예 {expiresAt: '2026-07-01'})다. 각 키를 meta.ownColumns 의
 * schema 칼럼 이름(snake_case·expires_at)으로 풀어 setAttribute(id, col, value, isColumn=true)
 * 로 저장한다. is_column=true 라 ent_attr_* 트리거가 합성 색인 본문에 합류시켜 옛 전용 칸이
 * 검색에 기여하던 동작을 보존한다(검색 동등성). camelToSnake 가 ownColumn.name 과 안 맞으면
 * loud throw(레지스트리·코드 드리프트 조기 발견·silent drop 금지). setAttribute 가 미존재 id
 * 면 자체적으로 loud throw 한다(행 생성 뒤에 불러야 한다·환각 0).
 */
function applyOwnColumns(
  store: SqliteMemoryStore,
  typeName: EntityTypeName,
  entityId: string,
  own: Record<string, string>,
): void {
  const meta = getEntityTypeMeta(typeName);
  const validColumns = new Set(meta.ownColumns.map((c) => c.name));
  if (validColumns.size === 0) {
    // creature·thing·work 는 전용 칸이 없다 — 칸 경로로 들어올 수 없다.
    throw new Error(
      `entity-attribute-wiring: '${typeName}' 은(는) 전용 칸이 없어 칸 갱신을 부를 수 없다 ` +
        `(ownColumns 비어 있음 — 호출 흐름 버그)`,
    );
  }
  for (const [camelField, value] of Object.entries(own)) {
    const column = camelToSnake(camelField);
    if (!validColumns.has(column)) {
      throw new Error(
        `entity-attribute-wiring: '${typeName}' 의 칸 '${camelField}'(→${column})이 ownColumns ` +
          `(${[...validColumns].join(", ")})에 없다 — columnLabels·레지스트리 드리프트`,
      );
    }
    store.entitiesRepo.setAttribute(entityId, column, value, true);
  }
}

/**
 * 한 엔티티 행에 걸린 속성 태그를 spec §3 3분법으로 칸/라벨에 채운다.
 *
 * 가르기:
 *  1. registry columnLabels(칸 어휘)에 키가 있으면 → 전용 칸(own 에 모아 한 번에 update<Type>).
 *  2. 라벨 어휘(getTypeAttributes − columnLabels − RELATION_TAG_KEYS 차집합)에 키가 있으면
 *     → value 개념(findOrCreateConcept) + has_attribute 엣지(addEntityConceptEdge).
 *  2.5. 관계 키(RELATION_TAG_KEYS: 창작자·주인 등) → 칸·라벨이 아닌 관계라 명시 skip
 *       (관계 엣지는 wireEntityRelations 가 entity_relation_edges 에 세운다·4단계 부분 B).
 *  3. 칸·라벨 어휘·관계 키 어느 쪽도 아닌 알 수 없는 키 → 건너뛰고 skipped 에 사유 기록.
 *  4. value 가 빈 값이면 칸·라벨 둘 다 만들지 않고 건너뛴다(빈 값은 정보가 아니다).
 *
 * 같은 키가 여러 번 오면 칸은 마지막 값으로 덮어쓰고(전용 칸은 한 값), 라벨은 멱등이라
 * 중복 엣지가 안 생긴다. 알 수 없는 키·빈 값은 결과 skipped 에 사유와 함께 남긴다.
 *
 * @param store      실제 SqliteMemoryStore(실 DB·실 임베딩).
 * @param typeName   신규 8 타입 이름. 사람·프로젝트·오타는 loud throw.
 * @param entityId   채울 1급 엔티티 행 id(Task 3 가 만든 id). 미존재면 칸 갱신 시 loud throw.
 * @param attributeTags `#키:값` 속성 태그 목록.
 * @returns 칸 키·라벨 개념 id·건너뛴 속성을 분리한 결과.
 */
export async function applyEntityAttributes(
  store: SqliteMemoryStore,
  typeName: string,
  entityId: string,
  attributeTags: EntityAttributeTag[],
  provenance: Provenance,
  sourceNodeId: number | null,
): Promise<ApplyAttributesResult> {
  assertEntityType(typeName);
  const meta = getEntityTypeMeta(typeName);

  const result: ApplyAttributesResult = {
    columnKeys: [],
    labelConceptIds: [],
    skipped: [],
  };

  // 1) 칸으로 갈 키를 모은다(camelCase own 인자). 한 번에 update<Type> 를 부른다.
  const own: Record<string, string> = {};
  for (const tag of attributeTags) {
    const key = tag.key.trim();
    const value = tag.value.trim();
    const camelField = meta.columnLabels[key];
    if (camelField === undefined) continue; // 칸 아님 — 2) 라벨 단계에서 다시 본다.
    if (!value) {
      result.skipped.push({
        key,
        value: tag.value,
        reason: `'${key}' 칸 값이 비어 있어 채우지 않는다(빈 값은 정보가 아니다·NULL 유지)`,
      });
      continue;
    }
    own[camelField] = value;
    if (!result.columnKeys.includes(key)) result.columnKeys.push(key);
  }
  if (Object.keys(own).length > 0) {
    applyOwnColumns(store, typeName, entityId, own);
  }

  // 라벨 어휘 = 2단계 getTypeAttributes − columnLabels(칸 어휘) − RELATION_TAG_KEYS(관계 키).
  //
  // 3분법(spec §3)은 칸/라벨/관계 셋이다. Task 2 가 yaml attributes 에 관계 키(창작자·
  // 주인·관련사람·관련장소·가족·친구)도 넣었으므로, attributes − 칸 만 빼면 관계 키가 라벨
  // 어휘에 섞여 `#창작자:아쿠타미` 가 작품→"아쿠타미" 라벨 엣지(has_attribute)로 새 버린다 —
  // 창작자는 *관계*(작품→사람 created_by)여야 한다. 그래서 관계 키를 한 번 더 뺀다(단일 출처
  // = entity-relation-vocabulary.relationTagKeySet). 관계 키는 아래 루프가 명시 skip 하고,
  // 실제 관계 엣지는 wireEntityRelations(Task 4)가 세운다(이 함수는 관계를 손대지 않는다).
  const relationKeys = relationTagKeySet();
  const labelVocab = new Set(
    getTypeAttributes(typeName).filter(
      (k) => meta.columnLabels[k] === undefined && !relationKeys.has(k),
    ),
  );

  // 2)·3) 칸이 아닌 키 → 라벨 어휘면 라벨 엣지, 아니면 건너뜀(skipped 에 사유).
  for (const tag of attributeTags) {
    const key = tag.key.trim();
    const value = tag.value.trim();
    if (meta.columnLabels[key] !== undefined) continue; // 이미 칸으로 처리.
    if (!key) {
      result.skipped.push({
        key: tag.key,
        value: tag.value,
        reason: "속성 태그 키가 비어 있어 칸·라벨 어느 쪽으로도 보내지 않는다",
      });
      continue;
    }
    // 항목 동의어 정규화(단계2) — 라벨 매칭 *직전* 에 동의어 키를 대표키로 바꾼다.
    // `#닉네임:철수` 의 '닉네임' 이 '별명'(라벨) 동의어면 '별명' 으로 합류해 같은 라벨로
    // 떨어진다. 미등록 동의어면 입력 그대로(no-op). 관계 키는 정규화 *전후 모두* 막아야 3분법
    // 경계가 유지된다 — 동의어가 우연히 관계 키 대표값을 가리켜도 라벨로 새지 않게.
    const canonicalKey = getCanonicalItemKey(typeName, key);
    // 2.5) 관계 키(창작자·주인 등) → 라벨로 만들지 않고 명시 skip 한다(3분법 핵심).
    //      칸도 라벨도 아니고 *관계*다 — 작품→사람 created_by 같은 엔티티 행 ↔ 행 엣지는
    //      wireEntityRelations(Task 4)가 entity_relation_edges 에 세운다. 여기서 라벨 엣지로
    //      만들면 `#창작자:아쿠타미` 가 작품→"아쿠타미" has_attribute 로 새어 3분법이 깨진다.
    //      관계 동의어는 entity-relation-vocabulary 가 전담하므로 raw·canonical 둘 다 막는다.
    if (relationKeys.has(key) || relationKeys.has(canonicalKey)) {
      result.skipped.push({
        key,
        value: tag.value,
        reason: `'${key}' 은(는) 관계 키라 칸·라벨이 아닌 관계 wiring(wireEntityRelations)이 처리한다 — applyEntityAttributes 는 라벨 엣지로 만들지 않는다(3분법: 칸/라벨/관계)`,
      });
      continue;
    }
    // 3) 칸도 라벨 어휘도 아닌 알 수 없는 키 → 라벨로 보내지 않고 건너뛴다(3분법 위반·노이즈 방지).
    //    생일처럼 전용 칸 없는 고유 사실이 여기로 정직하게 빠진다(silent drop 금지).
    //    정규화한 canonicalKey 로 라벨 어휘를 본다(동의어 키도 대표키 라벨로 인식).
    if (!labelVocab.has(canonicalKey)) {
      result.skipped.push({
        key,
        value: tag.value,
        reason: `'${key}' 은(는) ${typeName} 의 칸 어휘도 라벨 어휘(attributes)도 아니라 라벨로 만들지 않는다(고유 값을 라벨로 묶으면 3분법이 깨진다)`,
      });
      continue;
    }
    if (!value) {
      result.skipped.push({
        key,
        value: tag.value,
        reason: `'${key}' 라벨 값이 비어 있어 라벨 개념을 만들지 않는다(빈 값은 정보가 아니다)`,
      });
      continue;
    }
    // 2) 라벨 어휘에 있는 키만 라벨로 — value 를 개념으로 만들고 has_attribute 엣지로 잇는다.
    const conceptId = await store.findOrCreateConcept(value, { isTag: true });
    store.addEntityConceptEdge(
      typeName,
      entityId,
      conceptId,
      "has_attribute",
      provenance,
      sourceNodeId,
    );
    if (!result.labelConceptIds.includes(conceptId)) {
      result.labelConceptIds.push(conceptId);
    }
  }

  return result;
}

/**
 * 글이 언급한 개념 ↔ 엔티티 행을 `role='identity'` 엣지로 잇는다 — 검색 mention 링크.
 *
 * 역할 재정의(위계 단일 출처 재설계) — 옛날엔 이 엣지가 "이 엔티티 행 = 이 위계 잎
 * 개념"이라는 *위계 잎 지목*이었다. 위계가 hierarchy_edges 로 단일화되며 위계 잎은
 * 엔티티 행이 직접 맡는다(개념을 거치지 않음). 그래서 이 엣지는 더 이상 위계를 짊어지지
 * 않고, *검색이 엔티티 행에 닿는 mention 링크 + identity JOIN 키* 로 쓰인다:
 *  - 검색(search-repository.ts role='identity' JOIN) — 검색어가 잡은 개념에서 그 개념과
 *    같은 이름의 엔티티 행을 해소해 그 행을 언급한 글에 도달(§7.2 옵션 b 글 도달 경로).
 *  - 엔티티 관계 검색(entity-relation-edge-repository role='identity' JOIN) — 검색어→행 매칭.
 *  - 그래프 노드 합류(graph-augment identity 역조회) — 단일 배치 행을 화면에 띄움(§6.3.5).
 *
 * 칸·라벨 채우기 뒤 마지막에 부른다. 개념 id 해소(같은 이름 concept_node 찾기)는 호출
 * 측이 미리 한다 — 이 함수는 받은 id 를 addEntityConceptEdge 로 멱등하게 잇기만 한다.
 *
 * @param store         실제 SqliteMemoryStore.
 * @param typeName      신규 8 타입 이름. 사람·프로젝트·오타는 loud throw.
 * @param entityId      엔티티 행 id.
 * @param leafConceptId 글이 언급한 개념 id(호출 측이 해소). 빈 값이면 loud throw.
 * @returns 새 엣지를 만들었으면 true, 이미 있었으면 false(멱등).
 */
export function linkEntityIdentity(
  store: SqliteMemoryStore,
  typeName: string,
  entityId: string,
  leafConceptId: string,
  provenance: Provenance,
  sourceNodeId: number | null,
): boolean {
  assertEntityType(typeName);
  if (!leafConceptId.trim()) {
    throw new Error(
      `entity-attribute-wiring: identity 엣지의 위계 잎 개념 id 가 비어 있다 ` +
        `(${typeName} 행 '${entityId}' — 호출 측이 잎 개념을 먼저 해소해야 한다)`,
    );
  }
  return store.addEntityConceptEdge(
    typeName,
    entityId,
    leafConceptId,
    "identity",
    provenance,
    sourceNodeId,
  );
}
