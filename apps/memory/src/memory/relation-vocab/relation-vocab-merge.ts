/**
 * relation-vocab-merge.ts — 관계명 yaml 기본 씨앗 + DB 사용자 추가분 병합 + 3분법 가드
 * (분류 단계3 T7a · D11·D12 · 종류 명부 merge-classify-vocab 양식 미러).
 *
 * 두 일:
 *   1. mergeRelationVocab — yaml 씨앗 맵 + DB 사용자 관계명 행을 합쳐 동적 관계 태그 키 맵
 *      (`Record<태그키, RelationSpec>`)을 만든다. entity-relation-vocabulary 의
 *      setRelationVocabOverride 가 받는 모양. 빈 DB 면 씨앗 그대로(byte 동일·회귀 0).
 *   2. checkRelationKeyTrichotomyConflict — 새 관계 키가 칸(columnLabels·새 종류 is_column)·
 *      라벨(attributes yaml/DB)·항목 동의어(item_synonym)와 겹치는지 검사하는 순수 함수.
 *      T7a 는 이 검사 함수 + 동행 테스트까지, 라우트 400 회신은 T7b 가 이 함수를 부른다.
 *
 * 순수 함수 — 입력 씨앗 맵을 건드리지 않는다(새 객체를 돌려준다). silent skip 금지:
 * 미등록 source/target 타입·거짓 기본 타입·관계 키 중복은 식별자 담은 명시 에러로 알린다
 * (라우트가 추가 전 검증해 막지만 병합 함수도 방어한다). DB 접근 0 — DB 행은 repo 가 읽어
 * 인자로 넘긴다(concept-type-vocabulary 결합·순환 의존 차단).
 */

import {
  isPlacementType,
  type PlacementTypeName,
} from "../concept-type-vocabulary.ts";
import type { RelationSpec } from "../entity-relation-vocabulary.ts";
import type { SeedRelationSpec } from "./relation-vocab-loader.ts";
import type { RelationNameUserEntryView } from "./relation-name-user-repo.ts";

/** mergeRelationVocab 가 받는 DB 행의 최소 형태(RelationNameUserEntryView 부분집합). */
export interface RelationNameUserEntryLike {
  relationKey: string;
  relationName: string;
  sourceTypes: readonly string[];
  targetTypes: readonly string[];
  defaultTargetType: string;
}

/** RelationNameUserEntryView 가 RelationNameUserEntryLike 를 만족함을 컴파일타임에 묶는다. */
export type _AssertViewIsLike = RelationNameUserEntryView extends RelationNameUserEntryLike
  ? true
  : never;

/**
 * 한 DB 관계명 행을 RelationSpec 으로 검증·변환한다. 빈 키·미등록 source/target 타입·
 * 거짓 기본 타입(targetTypes 밖)·빈 source/target 는 식별자 담은 명시 에러 throw.
 * source/target 타입 유효성은 placementTypeNames() 동적 Set(isPlacementType)으로 본다 —
 * 새 종류(entity_types)도 source/target 가 될 수 있다(D3 정합).
 */
function specFromUserEntry(entry: RelationNameUserEntryLike): {
  key: string;
  spec: RelationSpec;
} {
  const key = entry.relationKey.trim();
  if (!key) {
    throw new Error("relation-vocab-merge: 관계 키가 비어 있음 — 빈 키는 등록할 수 없다");
  }
  const relation = entry.relationName.trim();
  if (!relation) {
    throw new Error(`relation-vocab-merge: '${key}' 의 관계명이 비어 있음 — 빈 관계명은 등록할 수 없다`);
  }
  const sourceTypes = entry.sourceTypes.map((t) => t.trim()).filter((t) => t.length > 0);
  const targetTypes = entry.targetTypes.map((t) => t.trim()).filter((t) => t.length > 0);
  if (sourceTypes.length === 0) {
    throw new Error(`relation-vocab-merge: '${key}' 의 sourceTypes 가 비어 있음 — source 타입이 최소 하나 필요`);
  }
  if (targetTypes.length === 0) {
    throw new Error(`relation-vocab-merge: '${key}' 의 targetTypes 가 비어 있음 — target 타입이 최소 하나 필요`);
  }
  for (const t of [...sourceTypes, ...targetTypes]) {
    if (!isPlacementType(t)) {
      throw new Error(
        `relation-vocab-merge: '${key}' 의 타입 '${t}' 는 등록되지 않은 배치 타입 — 코드 상수 10종 ∪ DB 새 종류만 허용`,
      );
    }
  }
  const defaultTargetType = entry.defaultTargetType.trim();
  if (!targetTypes.includes(defaultTargetType)) {
    throw new Error(
      `relation-vocab-merge: '${key}' 의 defaultTargetType '${defaultTargetType}' 가 targetTypes 안에 없음 (거짓 기본 타입)`,
    );
  }
  return {
    key,
    spec: {
      relation,
      sourceTypes: sourceTypes as PlacementTypeName[],
      targetTypes: targetTypes as PlacementTypeName[],
      defaultTargetType: defaultTargetType as PlacementTypeName,
    },
  };
}

/**
 * yaml 기본 씨앗 맵 + DB 사용자 관계명 행을 합쳐 동적 관계 태그 키 맵을 만든다.
 *
 * - 씨앗 맵은 불변 — 새 객체(`Record<태그키, RelationSpec>`)를 돌려준다.
 * - DB 행마다 specFromUserEntry 로 검증·변환한 뒤 병합한다.
 * - DB 관계 키가 씨앗 키와 겹치면 충돌 throw(silent 덮어쓰기 금지 — 씨앗 키는 코드가
 *   권위라 사용자가 같은 한국어 키를 다른 관계로 재정의 못 한다). 빈 DB 면 씨앗 그대로.
 * - 미등록 source/target·거짓 기본 타입은 specFromUserEntry 가 명시 throw.
 */
export function mergeRelationVocab(
  seed: ReadonlyMap<string, SeedRelationSpec>,
  userEntries: readonly RelationNameUserEntryLike[],
): Record<string, RelationSpec> {
  const merged: Record<string, RelationSpec> = {};
  // 씨앗 먼저 — 씨앗 SeedRelationSpec 은 RelationSpec 과 같은 모양이라 그대로 담는다.
  for (const [key, spec] of seed) {
    merged[key] = {
      relation: spec.relation,
      sourceTypes: spec.sourceTypes,
      targetTypes: spec.targetTypes,
      defaultTargetType: spec.defaultTargetType,
    };
  }

  for (const entry of userEntries) {
    const { key, spec } = specFromUserEntry(entry);
    if (merged[key] !== undefined) {
      throw new Error(
        `relation-vocab-merge: 관계 키 '${key}' 가 기본 씨앗과 겹침 — 씨앗 키(창작자·주인…)는 코드 권위라 재정의 못 함`,
      );
    }
    merged[key] = spec;
  }
  return merged;
}

/**
 * DB 관계명 행 중 source/target 에 *종류 명부에 없는 종류*가 든 고아 행을 갈라낸다 — "쓰기 때
 * 검증"과 "읽기 때 관용"의 이음매(classify 쪽 partitionOrphanClassifyRows 와 같은 정신).
 * mergeRelationVocab 은 미등록 종류를 throw 로 막는 엄격 검증을 그대로 지킨다(관계명 CRUD 라우트가
 * 쓰기 전 prospective 병합으로 막는 근거). 종류가 먼저 지워져 남은 고아 행은 부팅·재병합을 죽이면
 * 안 되므로, 불러오는 쪽(mergeRelationVocabSkippingOrphans)이 이 함수로 거른 뒤 병합한다.
 * 빈 타입 목록·거짓 기본 타입 같은 *다른* 결함은 고아가 아니라 그대로 병합이 throw 한다.
 * 순수 함수 — console 을 안 쓴다(경고는 호출자 몫).
 */
export function partitionOrphanRelationEntries<E extends RelationNameUserEntryLike>(
  userEntries: readonly E[],
): { entries: E[]; orphans: { entry: E; missingTypes: string[] }[] } {
  const entries: E[] = [];
  const orphans: { entry: E; missingTypes: string[] }[] = [];
  for (const entry of userEntries) {
    const missingTypes = [
      ...new Set(
        [...entry.sourceTypes, ...entry.targetTypes]
          .map((t) => t.trim())
          .filter((t) => t.length > 0 && !isPlacementType(t)),
      ),
    ];
    if (missingTypes.length === 0) entries.push(entry);
    else orphans.push({ entry, missingTypes });
  }
  return { entries, orphans };
}

/**
 * 부팅·재병합용 관용 병합 — 고아 관계명 행(종류가 지워진 뒤 남은 행)을 건너뛰고 console.warn 으로
 * 관계 키와 없는 종류를 남긴 뒤 mergeRelationVocab 에 넘긴다. 고아 한 줄이 서버 시작이나 다른 관계명의
 * 병합을 막지 않게 한다. 쓰기 경로는 이 함수가 아니라 엄격한 mergeRelationVocab 를 쓴다.
 */
export function mergeRelationVocabSkippingOrphans(
  seed: ReadonlyMap<string, SeedRelationSpec>,
  userEntries: readonly RelationNameUserEntryLike[],
): Record<string, RelationSpec> {
  const { entries, orphans } = partitionOrphanRelationEntries(userEntries);
  for (const { entry, missingTypes } of orphans) {
    console.warn(
      `[memory-api] 관계 어휘: 관계명 '${entry.relationKey}' 가 등록되지 않은 종류 ` +
        `${missingTypes.map((t) => `'${t}'`).join(", ")} 를 가리켜 건너뜀 — 종류가 지워진 뒤 남은 고아 행. ` +
        `같은 이름으로 종류를 다시 등록하면 다시 적용된다`,
    );
  }
  return mergeRelationVocab(seed, entries);
}

/** 3분법 충돌 한 건 — 어느 갈래(칸/라벨/항목 동의어)와 겹쳤는지. */
export interface RelationKeyConflict {
  kind: "column" | "label" | "item_synonym";
  message: string;
}

/**
 * 새 관계 키가 칸/라벨/항목 동의어와 겹치는지 검사하는 순수 함수(D12 세 검사).
 * 단계2 가 깐 역방향(관계 키를 항목 동의어로 넣으려 하면 400 으로 막는다)의 대칭 — 단계3 은
 * "새 관계명을 칸/라벨/항목 동의어와 안 겹치게" 막는다. 3분법은 두 방향 가드로 닫힌다.
 *
 * 입력은 *현재 등록된* 칸 키·라벨 키·항목 동의어 키 집합(소문자 정규화 전 원본). 라우트(T7b)가
 * registry·yaml/DB·item_synonym 에서 모아 넘기고, 동행 테스트도 같은 함수로 겹침 0 을 본다.
 * 겹치면 RelationKeyConflict, 안 겹치면 null(정직한 통과). 키 비교는 소문자 정규화한다
 * (lookupRelationTag 소문자 조회·라벨 어휘 소문자 매칭 정합 — 대소문자만 다른 충돌도 잡음).
 */
export function checkRelationKeyTrichotomyConflict(
  relationKey: string,
  columnKeys: Iterable<string>,
  labelKeys: Iterable<string>,
  itemSynonymKeys: Iterable<string>,
): RelationKeyConflict | null {
  const target = relationKey.trim().toLowerCase();
  if (!target) return null;

  const colSet = lowerSet(columnKeys);
  if (colSet.has(target)) {
    return {
      kind: "column",
      message: `이미 칸으로 정의됨 — '${relationKey}' 은(는) 칸(정렬·필터 가능) 키라 관계명으로 추가할 수 없습니다`,
    };
  }
  const labelSet = lowerSet(labelKeys);
  if (labelSet.has(target)) {
    return {
      kind: "label",
      message: `이미 라벨로 정의됨 — '${relationKey}' 은(는) 라벨 어휘 키라 관계명으로 추가할 수 없습니다`,
    };
  }
  const itemSet = lowerSet(itemSynonymKeys);
  if (itemSet.has(target)) {
    return {
      kind: "item_synonym",
      message: `이미 항목 동의어로 묶임 — '${relationKey}' 은(는) 항목 동의어 키라 관계명으로 추가할 수 없습니다`,
    };
  }
  return null;
}

function lowerSet(keys: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const k of keys) out.add(k.trim().toLowerCase());
  return out;
}
