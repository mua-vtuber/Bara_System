/**
 * entity-row-gate.ts — 끝 고유명 1급 엔티티 행 생성 게이트
 * (개념 엔티티 타입 체계 3단계 Task 3, spec §6.5 결정 A·B).
 *
 * 끝 고유명(예: `#작품:데못죽` 의 "데못죽", `#고양이:나비` 의 "나비")을 전용 엔티티
 * 행(works·creatures …)으로 만들지 말지를 사용자 확정 결정 A·D 대로 가른다. 게이트는
 * 순수 판정만 하고(`shouldCreateEntityRow`), 통과 시 행 생성은 1단계 facade
 * `findOrCreate<Type>` 위임으로 처리한다(`createEntityRowIfNeeded`).
 *
 * 결정 A — "정보를 적거나 타입을 밝힐 때만." 명시 타입 태그(source === 'explicit')로
 * 구체 대상을 가리키거나, 그 항목에 속성 태그가 함께 걸렸을 때(hasAttributes)만 행을
 * 만든다. 순수 위계 분류 단어(소설·동물 = subcategories)는 행을 안 만든다 — 위계 잎
 * concept_node 로만 산다.
 *
 * 결정 D(2026-06-27 사용자 결정·M7) — "명시 선언이면 끝 고유명을 1급 행으로." source ===
 * 'explicit' 면 행을 만든다. 단 *분류 폴더 단어*(matchesSubcategory·name === subcategory)는
 * explicit 여도 계속 막는다 — "소설"처럼 이름이 그 타입의 분류 폴더 자체면 1급 행으로 만들
 * 때 폴더와 충돌해 위계가 꼬이므로, 폴더 단어는 위계 잎 concept_node 로만 남긴다.
 *   - 결정 D 는 모든 종류에 똑같이 적용된다 — 콜론 타입 선언(`#작품:봄`)뿐 아니라 직접 입력
 *     장소(`#장소:서울`·place-provenance-flow)도 명시 선언이면 1급 행을 만든다
 *     (2026-06-27 사용자 결정·옛 장소 C-1 "일반명사 장소는 안 승격" 폐기).
 *
 * (2026-06-27 콜론 사슬 구조 배치 spec §6-B·단계1 D2) 옛 결정 B(일반명사 씨앗 가드)는
 * seeds 전수 제거로 함께 사라졌다 — 비-explicit 경로에서 이름이 일반명사 씨앗이면 행을
 * 안 만들던 보수 가드가 없어진다. 비-explicit 거짓 카드 차단은 후속 단계2(구조 기준
 * 중간 마디 차단)가 대신한다.
 *
 * 어휘 조회는 2단계 `concept-type-vocabulary` 로더(getTypeSubcategories)를 단일 출처로
 * 재사용한다 — 어휘 목록을 이 파일에 하드코딩하지 않는다. 타입→facade 메서드 매핑도 한
 * switch 단일 출처로 모은다(분기 흩기 금지).
 *
 * silent fallback 금지 — 게이트 false 는 "행을 안 만듦"의 정직한 결과지 실패 위장이
 * 아니다(createEntityRowIfNeeded 는 그때 null 을 돌려준다). 알 수 없는 타입 이름은
 * 식별자와 함께 loud throw 한다.
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import type { ClassificationSource } from "./entity-type-classifier.ts";
import {
  placementTypeNames,
  isPlacementType,
  getTypeSubcategories,
  type PlacementTypeName,
} from "./concept-type-vocabulary.ts";

/**
 * 항목·일정 자동 등록 단계(2026-10-10 spec 5장) 전용 출처. spec 4장 판정(본문에 글자 그대로 있음·
 * 무시 기록 아님·기존 같은 이름 없음)을 통과한 이름만 이 값으로 들어온다. 결정 D 의 명시 선언과
 * 같이 1급 행을 만들되, 사슬 중간 마디·분류 폴더 단어 검사는 그대로 받는다. 이 값을 쓰는 곳은
 * entity-register/apply.ts 하나다(entity-row-gate.test.ts 가 소스를 훑어 지킨다).
 */
export const ENTITY_REGISTER_GATE_SOURCE = "cleanup_entity_register" as const;
export type EntityRowGateSource = ClassificationSource | typeof ENTITY_REGISTER_GATE_SOURCE;

/** shouldCreateEntityRow 입력 — 분류기 산출 일부 + 속성 부착 여부. */
export interface EntityRowGateArgs {
  /** 배치 타입 이름(예: 'work'). 알 수 없는 이름은 loud throw. */
  typeName: PlacementTypeName;
  /** 끝 고유명 후보(예: '데못죽', '나비'). 분류 폴더 단어와 겹침을 이 이름으로 검사. */
  candidateName: string;
  /**
   * 분류 단계 출처 — 'explicit'(명시 태그)일 때만 결정 A 의 타입 표명으로 본다.
   * ENTITY_REGISTER_GATE_SOURCE 는 자동 등록 단계 전용(명시 선언과 같은 생성 분기).
   */
  source: EntityRowGateSource;
  /** 이 항목에 속성 태그(#장르:·#창작자: 등)가 함께 걸렸나 — 걸리면 결정 A 통과. */
  hasAttributes: boolean;
  /** 분류기가 함께 돌려준 분류 키(소설·동물 등). 끝 고유명이면 보통 null. */
  subcategory: string | null;
  /**
   * 구조 신호 — candidateName 이 같은 글에서 다른 콜론 태그의 키로 다시 쓰이는 *사슬 중간
   * 마디*인가(뒤에 콜론이 더 이어짐·2026-06-27 단계2 D1·§6-B). true 면 어휘와 무관하게
   * 개념 폴더라 1급 행 0(I2). 두 통로(콜론 사슬·직접 입력 장소)가 isMidChainNode 단일
   * 출처로 같은 값을 채운다. 선택 필드 — 미설정(undefined)이면 false 와 같이 본다(구조
   * 신호 없는 옛 호출 하위 호환).
   */
  isMidChainNode?: boolean;
}

/** 게이트 판정 — create + 사람이 읽을 한국어 사유(환각 금지·실제 분기 근거만 적는다). */
export interface EntityRowGateResult {
  create: boolean;
  reason: string;
}

function assertPlacementType(
  typeName: string,
): asserts typeName is PlacementTypeName {
  if (!isPlacementType(typeName)) {
    throw new Error(
      `entity-row-gate: 알 수 없는 배치 타입 '${typeName}' — ` +
        `등록된 배치 타입(${placementTypeNames().join(", ")}) 중 하나여야 한다`,
    );
  }
}

/** 후보 이름이 그 타입의 분류 어휘(subcategories)와 겹치는지(소문자 동등). */
function matchesSubcategory(typeName: PlacementTypeName, name: string): boolean {
  const lower = name.trim().toLowerCase();
  return getTypeSubcategories(typeName).some((sc) => sc.toLowerCase() === lower);
}

/**
 * 끝 고유명을 1급 엔티티 행으로 만들지 결정 A·D + 구조 신호로 가르는 순수 함수.
 *
 * 판정 순서(빈 이름 → 구조 우선 → 어휘 폴더 → 명시 선언 → 속성·2026-06-27 단계2 §6-B):
 *  1. candidateName 이 빈 값이면 false(이름 없는 행 금지·모호).
 *  2. (구조 우선) isMidChainNode 면 false — candidateName 이 같은 글에서 다른 콜론 태그의
 *     키로 다시 쓰이는 *사슬 중간 마디*(뒤에 콜론이 더 이어짐)다. 어휘 등록 여부와 무관하게
 *     개념 폴더로 두고 1급 행은 안 만든다(I2). 어휘 빈 종류(장소 등)의 중간 누수를 막는
 *     핵심 — place.subcategories=[] 라 어휘 가드를 못 거치는 "병원" 도 여기서 막힌다.
 *  3. 결정 D — candidateName 이 그 타입의 분류 폴더 단어(subcategories: 소설·동물)와
 *     겹치면 false. 폴더 단어는 위계 잎 concept_node 로만 두고 1급 행은 안 만든다 —
 *     명시 선언(explicit)이어도 못 이긴다(폴더와 충돌 차단).
 *  4. 결정 D — candidateName 이 분류 키와 같은 단어면(candidateName === subcategory)
 *     분류 폴더 단어라 false(이중 안전). 이것도 explicit 가 못 이긴다.
 *  5. 결정 D(2026-06-27 M7) — source === 'explicit' 면 행 생성(true). 분류 폴더 단어·중간
 *     마디(2·3·4 에서 먼저 막힘)만 아니면 끝 고유명 1급 행을 만든다.
 *  6. 결정 A — hasAttributes 면(속성 태그로 정보를 적었으면) 행 생성(true).
 *  7. 그 외(seed/llm/none + 속성 없음)는 모호 → false(보수).
 *
 * (2026-06-27 §6-B 충돌 해소 ①) 구조 2단계를 어휘 3·4단계보다 *먼저* 둔다 — 구조가
 * "중간 마디" 라고 말하면 어휘 무관하게 행 0 이라야 어휘 빈 종류 누수가 차단된다.
 *
 * (2026-06-27 콜론 사슬 구조 배치 spec §6-B·단계1 D2) 옛 결정 B(일반명사 씨앗 가드 —
 * 비-explicit 경로에서 이름이 일반명사 씨앗이면 행 0)는 seeds 제거로 함께 사라졌다.
 * 비-explicit 거짓 카드 차단 역할은 단계2 구조 기준(중간 마디 차단)이 대신한다.
 */
export function shouldCreateEntityRow(
  args: EntityRowGateArgs,
): EntityRowGateResult {
  const { typeName, candidateName, source, hasAttributes, subcategory } = args;
  assertPlacementType(typeName);

  const name = candidateName.trim();
  if (!name) {
    return { create: false, reason: "후보 이름이 비어 있어 행을 만들지 않는다(모호)" };
  }

  // (구조 우선·2026-06-27 단계2 §6-B) 사슬 중간 마디면 어휘 무관하게 1급 행 X — 뒤에 콜론이
  // 더 이어지는 개념 폴더라 위계 잎으로만 둔다(I2). 어휘 빈 종류 누수 차단의 핵심.
  if (args.isMidChainNode === true) {
    return {
      create: false,
      reason: `'${name}' 은(는) 사슬 중간 마디(뒤에 콜론이 더 이어짐)라 개념 폴더로 두고 1급 행 안 만듦(I2)`,
    };
  }

  // 결정 D — 분류 폴더 단어와 겹치면 explicit 여도 1급 행 X(폴더 충돌 차단·위계 잎 유지).
  if (matchesSubcategory(typeName, name)) {
    return {
      create: false,
      reason: `'${name}' 은(는) ${typeName} 의 분류 단어(subcategory)라 위계 잎 개념으로만 두고 1급 행은 만들지 않는다(명시 선언도 폴더 단어는 못 이긴다)`,
    };
  }
  // 결정 D — candidateName 이 분류 키와 같은 단어면(candidateName === subcategory) 분류 폴더 단어라 행 X(이중 안전·explicit 도 못 이김).
  if (subcategory && name.toLowerCase() === subcategory.trim().toLowerCase()) {
    return {
      create: false,
      reason: `'${name}' 은(는) 분류 키와 같은 단어라 위계 잎 개념으로만 두고 1급 행은 만들지 않는다(명시 선언도 폴더 단어는 못 이긴다)`,
    };
  }

  // 결정 D(2026-06-27 M7) — 명시 타입 태그면 행 생성. 분류 폴더 단어(위에서 먼저 막힘)만
  // 아니면 끝 고유명 1급 행을 만든다. 콜론 타입 선언·직접 입력 장소 모두 같은 규칙
  // (옛 장소 C-1 폐기·2026-06-27 사용자 결정).
  if (source === "explicit") {
    return {
      create: true,
      reason: `명시 타입 태그로 '${name}' 을(를) 구체 대상으로 가리켜 ${typeName} 1급 행을 만든다(결정 D)`,
    };
  }
  if (source === ENTITY_REGISTER_GATE_SOURCE) {
    return {
      create: true,
      reason: `정리 AI 항목 등록 판정을 통과한 '${name}' 을(를) ${typeName} 1급 행으로 만든다(2026-10-10 spec 5장)`,
    };
  }

  // 결정 A — 속성 태그가 함께 걸렸으면(정보를 적었으면) 행 생성.
  if (hasAttributes) {
    return {
      create: true,
      reason: `'${name}' 에 속성 태그가 함께 걸려 정보를 적은 것으로 보고 ${typeName} 1급 행을 만든다(결정 A)`,
    };
  }

  // 그 외 — 타입 표명도 속성 부착도 없어 모호. 보수적으로 행 X.
  return {
    create: false,
    reason: `'${name}' 은(는) 명시 타입 태그도 속성 부착도 없어 모호 — 거짓 엔티티 방지로 행을 만들지 않는다(보수)`,
  };
}

/**
 * 게이트가 만든 1급 엔티티 행 식별자 — 타입별 id 칸 이름이 달라(personId·projectId·
 * 8 타입은 id) 호출 측이 한 형태로 받도록 정규화한다. 행을 안 만들면 null.
 */
export interface CreatedEntityRow {
  /** 만든 행의 id('wrk_'·'psn_'·'prj_' …). */
  id: string;
  /** 만든 행의 canonical 이름. */
  name: string;
  /** 만든 타입(입력 typeName 그대로). */
  typeName: PlacementTypeName;
}

/**
 * 게이트를 통과시킨 끝 고유명을 1급 엔티티 행으로 만들거나 찾아 돌려준다.
 *
 * source·hasAttributes·subcategory 정보 없이 단순히 "이 타입·이름의 행을 보장"하는
 * 헬퍼다 — 게이트 판정(shouldCreateEntityRow)은 호출 측(Task 5 오케스트레이션)이 미리
 * 돌려 통과한 경우에만 이 함수를 부른다. 그래서 여기서는 게이트를 다시 평가하지 않고
 * 타입→facade 메서드 매핑만 한 switch 단일 출처로 처리한다.
 *
 * person·project 는 1단계 8 타입과 facade 메서드가 다르므로 별 분기로
 * findOrCreatePersonByName·findOrCreateProject 를 부른다. 8 타입은 findOrCreate<Type>
 * 가 공통 양식(EntityBase.id)이라 한 갈래로 모아 매핑한다.
 *
 * 알 수 없는 타입 이름은 식별자와 함께 loud throw(silent drop 금지). 멱등 — 같은
 * 타입·이름으로 다시 불러도 facade findOrCreate 가 name UNIQUE 로 같은 행을 돌려준다.
 *
 * @param store    실제 SqliteMemoryStore(실 DB·실 임베딩).
 * @param typeName 배치 타입 이름. 알 수 없는 이름은 loud throw.
 * @param name     끝 고유명. 빈 값이면 facade 가 그대로 처리(8 타입은 행 생성·person/project 양식).
 * @returns 만든 행의 정규화 식별자(id·name·typeName).
 */
export async function createEntityRow(
  store: SqliteMemoryStore,
  typeName: string,
  name: string,
): Promise<CreatedEntityRow> {
  assertPlacementType(typeName);
  // 사람·프로젝트는 단계4 흡수 대상이 아니라 전용 통로(별칭 칸·status·external_refs 구조가
  // 달라 별 repository 전담)를 그대로 쓴다. 정적 8 타입은 전용 facade 가 사라져 범용 본체
  // entitiesRepo.findOrCreateEntity 한 통로로 모은다(단계4 T4·결정 1~4·8-case switch 제거).
  if (typeName === "person") {
    const person = await store.findOrCreatePersonByName(name);
    return { id: person.personId, name: person.displayName, typeName };
  }
  if (typeName === "project") {
    const project = await store.findOrCreateProject({ name });
    return { id: project.projectId, name: project.name, typeName };
  }
  const entity = await store.entitiesRepo.findOrCreateEntity(typeName, name);
  return { id: entity.id, name: entity.name, typeName };
}

/**
 * 게이트 + 행 생성을 한 번에 묶는 편의 함수 — 게이트를 통과하면 createEntityRow 로 행을
 * 만들어 돌려주고, 불통과면 null 을 돌려준다(행 안 만듦·정직).
 *
 * Task 5 오케스트레이션이 끝 고유명 후보를 이 함수에 넣어 행 생성을 위임한다. 게이트
 * 불통과의 null 은 실패가 아니라 "결정 A·B 상 행을 만들지 않는 게 맞다"는 정직한 결과다.
 *
 * @returns 게이트 통과 시 만든 행, 불통과 시 null.
 */
export async function createEntityRowIfNeeded(
  store: SqliteMemoryStore,
  args: EntityRowGateArgs,
): Promise<CreatedEntityRow | null> {
  const gate = shouldCreateEntityRow(args);
  if (!gate.create) return null;
  return createEntityRow(store, args.typeName, args.candidateName);
}
