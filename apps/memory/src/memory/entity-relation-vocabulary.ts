/**
 * entity-relation-vocabulary.ts — 통합 cross-type 관계명 + 한국어 관계 태그 키 단일 출처
 * (4단계 Task 2 · 분류 단계3 T7a 동적화 · spec 2026-06-09 §7.2 표 / 2026-06-24 §7.2).
 *
 * 한 곳에 모으는 세 가지(전부 동적 reader — 코드 상수 씨앗 ∪ DB 사용자 추가분):
 *   1. 관계명 화이트리스트 — 기본 씨앗 7개(relation_vocabulary.yaml / 코드 상수 검증용
 *      SEED_RELATION_NAMES) ∪ DB 사용자 추가 관계명. 미등록 관계명은 여전히 loud throw.
 *   2. 관계 태그 키 → RelationSpec 매핑 — 기본 씨앗(창작자·주인…) ∪ DB 사용자 키.
 *      사용자가 #창작자:아쿠타미 라 적으면 이 매핑이 work→person created_by 엣지로 가는
 *      길을 정한다(3단계 Task 3 가 소비).
 *   3. lookupRelationTag / relationTagKeySet / assertRelationName — 위 둘을 읽는 접근 함수.
 *
 * 동결 해제(분류 단계3 T7a · 확정 2=B): 옛 ENTITY_RELATION_NAMES 기본 씨앗 `as const` 동결을
 * 풀어 *기본 씨앗 + DB 사용자 추가분 병합*으로 동적화했다. 코드 상수 SEED_RELATION_NAMES·
 * SEED_RELATION_TAG_KEYS 는 *기본 씨앗 검증용*으로 남아(동행 테스트가
 * yaml 씨앗 == 코드 상수 대조), 런타임 화이트리스트는 모듈 캐시(override)가 들고 있다.
 * 주입 전(server 부팅·CRUD 전)에는 코드 상수 씨앗만 본다 — 빈 DB·미부팅 byte 동일.
 *
 * 타입 이름(work·material·creature·schedule·usable·intake·person·project·place 그리고
 * 새 종류)은 새로 적지 않고 concept-type-vocabulary 의 PlacementTypeName(= entity-type-
 * registry 8 타입 + person·project + DB 새 종류)을 단일 출처로 본다. 새 관계명의 source/
 * target 가 새 종류일 수 있어, 병합이 placementTypeNames() 동적 Set 으로 검증한다(D3 정합).
 *
 * 칸/라벨/관계 3분법(spec §3): 한 타입의 속성 태그 키는 칸(columnLabels·registry)·라벨키·
 * 관계(관계 태그 키) 셋으로 갈린다. 겹침 0·관계 키 누락 0 은 동행 테스트가 가드한다 — 새
 * 관계명 추가 후에도(D12). 라우트 400 충돌 가드는 T7b 가 라우트에 단다.
 *
 * 이 모듈은 DB 접근 0 — 모듈 캐시를 라우트·부팅이 주입한다(concept-type-vocabulary 의
 * setEntityTypeOverride 양식 미러·DB 결합·순환 의존 차단). unknown 관계명·unknown 타입은
 * 가리지 않고 식별자와 함께 loud throw(silent fallback 금지).
 */

import type { PlacementTypeName } from "./concept-type-vocabulary.ts";

/**
 * 기본 씨앗 관계명 7개 — relation_vocabulary.yaml 의 relations 절과 같은 7개를 코드
 * 상수로도 둬, 동행 테스트가 yaml 씨앗 == 코드 상수를 대조해 회귀 0 을 가드한다.
 *
 *   created_by      작품 → 사람          (창작자)
 *   owned_by        생물 → 사람          (주인)
 *   related_person  일정/사용물/섭취 → 사람 (관련사람)
 *   located_at      일정 → 장소          (관련장소)
 *   participated_by 프로젝트 → 사람       (참여자)
 *   family_of       사람 → 사람          (가족)
 *   friend_of       사람 → 사람          (친구)
 */
export const SEED_RELATION_NAMES = [
  "created_by",
  "owned_by",
  "related_person",
  "located_at",
  "participated_by",
  "family_of",
  "friend_of",
] as const;

/**
 * 옛 이름 호환 별칭. 옛 코드·테스트가 ENTITY_RELATION_NAMES 로 씨앗을 참조했다 —
 * 같은 배열을 가리키게 둬 import 깨짐 0(동결 해제는 *추가 통로*이지 씨앗 삭제 아님).
 */
export const ENTITY_RELATION_NAMES = SEED_RELATION_NAMES;

/**
 * 컴파일타임 관계명 타입은 기본 씨앗 7개 union 으로 둔다(정적 씨앗 컴파일타임 안전 유지).
 * 사용자가 화면으로 더한 새 관계명은 union 멤버가 아니라 `string` 으로 흐르고,
 * *런타임 동적 화이트리스트*(assertRelationName)가 게이트한다 — concept-type-vocabulary 의
 * PlacementTypeName 비대칭과 같은 의도된 설계다.
 */
export type EntityRelationName = (typeof SEED_RELATION_NAMES)[number];

/** 관계 태그 한 키의 명세 — 관계명 + source/target 허용 타입 + target 기본 타입. */
export interface RelationSpec {
  /** 이 키가 만드는 관계명(씨앗 7개 ∪ DB 새 관계명). */
  relation: string;
  /** 이 관계를 걸 수 있는 source(글 주체) 타입들. source 타입이 여기 없으면 wiring 이 skip. */
  sourceTypes: readonly PlacementTypeName[];
  /** target(가리키는 대상) 으로 허용되는 타입들. 여럿이면 같은 글 힌트·기본 타입으로 가른다. */
  targetTypes: readonly PlacementTypeName[];
  /**
   * target 타입이 여럿일 때 힌트 없이도 떨어지는 기본 target 타입.
   * 단일 target 타입이면 그 타입 자신과 같다(3단계 resolveRelationTarget 가 소비).
   */
  defaultTargetType: PlacementTypeName;
}

/**
 * created_by(작품→사람) 단일 spec. 창작자·제작자·작가·만든사람 네 동의어 키가 같은 객체를
 * 참조한다 — 한 spec 만 두고 네 키가 가리키게 해서 정의를 한 곳에 모은다(중복 정의 0).
 */
const CREATED_BY_SPEC: RelationSpec = {
  relation: "created_by",
  sourceTypes: ["work"],
  targetTypes: ["person"],
  defaultTargetType: "person",
};

/**
 * 기본 씨앗 한국어 관계 태그 키 → RelationSpec(spec §7.2 표). relation_vocabulary.yaml 의
 * tag_keys 절과 같은 10개 키(기본 7 관계 + 창작자 동의어 3개). 코드 상수로도 둬, 동행
 * 테스트가 yaml 씨앗 == 코드 상수를 대조한다(회귀 0). 런타임 화이트리스트는 이 씨앗 ∪ DB
 * (모듈 캐시 activeTagKeys)다 — 이 상수는 주입 전 fallback 이자 검증 기준선이다.
 *
 * 키는 사용자가 #키:값 으로 적는 한국어 그대로. lookupRelationTag 가 소문자 정규화 후
 * 조회한다(parseTags 의 captured.toLowerCase() 정합 — 한국어는 변동 0·영어만 소문자화).
 */
export const SEED_RELATION_TAG_KEYS: Readonly<Record<string, RelationSpec>> = {
  창작자: CREATED_BY_SPEC,
  제작자: CREATED_BY_SPEC,
  작가: CREATED_BY_SPEC,
  만든사람: CREATED_BY_SPEC,
  주인: {
    relation: "owned_by",
    sourceTypes: ["creature"],
    targetTypes: ["person"],
    defaultTargetType: "person",
  },
  참여자: {
    relation: "participated_by",
    sourceTypes: ["project"],
    targetTypes: ["person"],
    defaultTargetType: "person",
  },
  관련사람: {
    relation: "related_person",
    sourceTypes: ["schedule", "usable", "intake"],
    targetTypes: ["person"],
    defaultTargetType: "person",
  },
  관련장소: {
    relation: "located_at",
    sourceTypes: ["schedule"],
    targetTypes: ["place"],
    defaultTargetType: "place",
  },
  가족: {
    relation: "family_of",
    sourceTypes: ["person"],
    targetTypes: ["person"],
    defaultTargetType: "person",
  },
  친구: {
    relation: "friend_of",
    sourceTypes: ["person"],
    targetTypes: ["person"],
    defaultTargetType: "person",
  },
} as const;

/**
 * 옛 이름 호환 별칭. 옛 소비처(entity-attribute-wiring·entity-relation-target·테스트)가
 * RELATION_TAG_KEYS 로 씨앗을 직접 참조했다 — 같은 객체를 가리키게 둔다. *동적*
 * 화이트리스트(씨앗 ∪ DB)가 필요한 소비처는 relationTagKeySet()·lookupRelationTag() 함수를
 * 쓴다(아래). 이 상수 직접 참조는 *씨앗만* 보는 정적 통로다(동행 테스트 기준선·하위 호환).
 */
export const RELATION_TAG_KEYS = SEED_RELATION_TAG_KEYS;

/**
 * 런타임 활성 관계 태그 키 맵(씨앗 ∪ DB 주입). 주입 전(null)이면 lookupRelationTag·
 * relationTagKeySet 이 SEED_RELATION_TAG_KEYS 만 본다 — 빈 DB·미부팅 byte 동일. server
 * 부팅·관계명 CRUD 시점에 setRelationVocabOverride 가 병합본(씨앗 ∪ DB)을 얹는다.
 */
let activeTagKeys: Readonly<Record<string, RelationSpec>> | null = null;
/** 소문자 정규화 키 → RelationSpec 조회 맵 캐시. 주입·reset 시 null 로 무효화. */
let normalizedLookupCache: Map<string, RelationSpec> | null = null;
/** 활성 관계명 화이트리스트 Set 캐시(씨앗 7개 ∪ DB 관계명). 주입·reset 시 null 로 무효화. */
let relationNameSetCache: Set<string> | null = null;

/** 현재 활성 태그 키 맵(주입본 또는 씨앗 fallback). 동적 reader 의 단일 출처. */
function currentTagKeys(): Readonly<Record<string, RelationSpec>> {
  return activeTagKeys ?? SEED_RELATION_TAG_KEYS;
}

/**
 * 소문자 정규화한 키 → RelationSpec 조회 맵을 빌드·캐시한다. 현재 활성 태그 키 맵을 한 번
 * 펼친다. 현재 키는 전부 한국어라 소문자화가 키를 안 바꾸지만, 외부 fork 가 영어 관계 키를
 * 대문자로 적어도 조회가 #Creator ≡ #creator 로 한 갈래에 모이게 한다.
 */
function normalizedLookup(): Map<string, RelationSpec> {
  if (normalizedLookupCache) return normalizedLookupCache;
  normalizedLookupCache = new Map(
    Object.entries(currentTagKeys()).map(([k, spec]) => [k.toLowerCase(), spec]),
  );
  return normalizedLookupCache;
}

/**
 * 활성 관계명 화이트리스트 Set 을 빌드·캐시한다. 기본 씨앗 7개 ∪ 활성 태그 키들이 만드는
 * 관계명(DB 새 관계명 포함). 씨앗을 항상 더해, 주입본에 어떤 씨앗 키가 빠져도(있을 수
 * 없지만 방어) 기존 관계명이 늘 통과한다(회귀 0).
 */
function relationNameSet(): Set<string> {
  if (relationNameSetCache) return relationNameSetCache;
  const set = new Set<string>(SEED_RELATION_NAMES);
  for (const spec of Object.values(currentTagKeys())) set.add(spec.relation);
  relationNameSetCache = set;
  return set;
}

/**
 * 병합본(씨앗 ∪ DB 사용자 추가분)을 모듈 캐시에 주입한다(setEntityTypeOverride 양식 미러).
 * server 부팅·관계명 CRUD 후 relation-vocab-merge 산출 병합 맵을 얹고, 파생 캐시
 * (normalizedLookupCache·relationNameSetCache)를 무효화한다(추가·삭제 즉시 반영). null·
 * undefined 주입은 씨앗 fallback 복귀(미부팅 거동). 이 함수는 classifier 2차 캐시를 안
 * 건드린다 — 라우트가 resetClassifierCache 와 함께 부른다(2-reset / 단계1·2 양식).
 */
export function setRelationVocabOverride(
  merged: Readonly<Record<string, RelationSpec>> | null,
): void {
  activeTagKeys = merged;
  normalizedLookupCache = null;
  relationNameSetCache = null;
}

/**
 * 파생 캐시만 비운다(주입 데이터 activeTagKeys 는 남기고). 다음 normalizedLookup·
 * relationNameSet 이 현재 활성 맵으로 재빌드한다. 종류 명부 resetConceptTypeVocabularyCache
 * 가 파생 캐시만 비우는 양식 미러 — 명부 자체 비움은 setRelationVocabOverride(null) 몫.
 */
export function resetRelationVocabCache(): void {
  normalizedLookupCache = null;
  relationNameSetCache = null;
}

/**
 * 주어진 문자열이 활성 관계명(씨앗 7개 ∪ DB 새 관계명)인지 단언한다. 아니면 식별자와 함께
 * loud throw — repository·wiring 이 엣지를 쓰기 직전 unknown 관계를 가리지 않고 멈춘다
 * (silent fallback 금지·동결 해제 후에도 미등록 관계명은 막힌다).
 */
export function assertRelationName(name: string): asserts name is EntityRelationName {
  if (!relationNameSet().has(name)) {
    throw new Error(
      `entity-relation-vocabulary: unknown relation name '${name}' — 허용 관계명: ${[...relationNameSet()].join(", ")}`,
    );
  }
}

/** 관계 태그 키 집합(원본 키·씨앗 ∪ DB). 3분법 분할 가드·파서가 빠르게 갈래를 가른다. */
export function relationTagKeySet(): Set<string> {
  return new Set(Object.keys(currentTagKeys()));
}

/**
 * 원본 키(사용자가 적은 #키)를 소문자 정규화해 RelationSpec 을 찾는다(씨앗 ∪ DB).
 * 관계 키가 아니면 null(칸·라벨·다른 태그라는 정직한 신호 — 거짓 매칭 0).
 *
 * 소문자화는 parseTags 의 captured.toLowerCase() 와 같은 규칙이다.
 */
export function lookupRelationTag(rawKey: string): RelationSpec | null {
  if (!rawKey) return null;
  return normalizedLookup().get(rawKey.toLowerCase()) ?? null;
}
