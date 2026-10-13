/**
 * entity-relation-target.ts — 관계 태그 파싱 + target 엔티티 해석
 * (개념 엔티티 타입 체계 4단계 Task 3 · spec 2026-06-09 §5·§6.5 결정 B·§7.2).
 *
 * 글에 손으로 적은 콜론 태그(#키:값) 중 관계 태그(#창작자:아쿠타미)만 골라내고, 그
 * 관계가 가리키는 target 엔티티를 실제 행으로 해석한다. 두 갈래로 나뉜다:
 *
 *   1. parseRelationTags(content) — 순수 함수. parseClassificationTags 산출에서
 *      lookupRelationTag(rawCategory) 가 비-null 인 태그만 골라 {rawKey, value, spec}[]
 *      로 돌려준다. 칸 태그(#생일:)·라벨 태그(#장르:)·일반 분류 태그(#유통기한:)는
 *      관계 키가 아니라 제외된다 — 3단계가 그쪽을 처리한다. 빈 값도 제외.
 *
 *   2. resolveRelationTarget(store, spec, value, sameDocTypeHints) — DB 의존. 관계가
 *      가리키는 target 을 실제 엔티티 행으로 만들거나 찾아 {type, id, name} 으로 돌려준다.
 *      해석에 실패하거나 target 타입이 모호하면 {skipped, reason} — 거짓 엣지를 0 으로
 *      두는 정직한 신호다(silent fallback 금지·reason 에 키·값 식별자 보존).
 *
 * target 해석 규칙(spec §7.2 표 + 사이드카 Task 3 targetResolution):
 *   - 사람 target = createEntityRow("person", value) → 내부적으로 findOrCreatePersonByName.
 *     별명 spec·attribution 축 분리(userId 미각인)는 그 facade 가 처리한다.
 *   - 그 외 target(작품·자료·장소 …) = createEntityRow(type, value) → findOrCreate<Type>
 *     이름 UNIQUE 재사용. 명시 관계 태그는 explicit 의도라 게이트를 거치지 않고 바로 행을
 *     만든다 — 3단계 결정 B(분류 위계 잎 자동 승격 차단)는 *명시 관계 target* 을 막는 게
 *     아니다(#주인:엄마 의 "엄마"는 사람 행으로 만들어 잇는다).
 *   - target 타입이 여럿 가능한 사용자 관계이면 가른다:
 *       ① 같은 글에 같은 값이 명시 타입 태그(#작품:value)로 선언됐으면 그 타입
 *       ② 없으면 spec.defaultTargetType
 *       ③ 그래도 못 가르면 {skipped} (실제로는 ②가 항상 떨어지므로 ③은 방어선).
 *
 * Mock 0 — resolveRelationTarget 은 실제 store(실 SQLite + 실 임베딩)로 통합 검증한다.
 * parseRelationTags 는 순수 함수라 데이터 fixture 로 검증한다.
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import type { PlacementTypeName } from "./concept-type-vocabulary.ts";
import { parseClassificationTags } from "./parsers/classification-tag.ts";
import { lookupRelationTag, type RelationSpec } from "./entity-relation-vocabulary.ts";
import { createEntityRow, type CreatedEntityRow } from "./entity-row-gate.ts";

/** parseRelationTags 한 항목 — 사용자가 적은 키·값 + 그 키가 가리키는 관계 명세. */
export interface ParsedRelationTag {
  /** 사용자가 적은 원본 키(예: '창작자'·'주인'). lookupRelationTag 정규화 전 형태. */
  rawKey: string;
  /** 관계가 가리키는 target 의 이름(예: '아쿠타미'·'엄마'). 빈 값은 파싱 단계에서 제외. */
  value: string;
  /** 이 키가 만드는 관계 명세(관계명·source/target 허용 타입·기본 target 타입). */
  spec: RelationSpec;
}

/**
 * 같은 글에서 명시 타입 태그(#작품:데못죽)로 선언된 (값 → 타입) 힌트 한 항목.
 *
 * target 타입이 여럿 가능한 관계에서, 같은 값이 같은 글 안 다른 곳에서
 * 어떤 타입으로 선언됐는지를 알려 가르기에 쓴다. 이 힌트를 어떻게 모으는지는 Task 4 가
 * wiring 에서 넘겨주고, Task 3 은 받은 힌트로 가르는 순수 로직만 책임진다.
 */
export interface SameDocTypeHint {
  /** 명시 타입 태그가 가리킨 이름(예: '데못죽'). 비교는 trim·소문자 정규화로 한다. */
  value: string;
  /** 그 이름이 선언된 타입(예: 'work'). */
  type: PlacementTypeName;
}

/** resolveRelationTarget 성공 — 실제 만든/찾은 target 엔티티 행 식별자. */
export interface ResolvedRelationTarget {
  /** 해석된 target 타입(예: 'person'·'work'). */
  type: PlacementTypeName;
  /** target 행 id('psn_'·'wrk_' …). */
  id: string;
  /** target 행 canonical 이름. */
  name: string;
}

/** resolveRelationTarget 정직한 건너뜀 — 거짓 엣지 0. reason 에 키·값 식별자 보존. */
export interface SkippedRelationTarget {
  skipped: true;
  /** 사람이 읽을 한국어 사유 — 식별자(키·값) 포함. 환각 금지·실제 분기 근거만 적는다. */
  reason: string;
}

export type RelationTargetResult = ResolvedRelationTarget | SkippedRelationTarget;

/** 결과가 건너뜀인지 가르는 좁히기 헬퍼(소비처 Task 4 가 warn 누적·다음 진행). */
export function isSkippedTarget(
  result: RelationTargetResult,
): result is SkippedRelationTarget {
  return (result as SkippedRelationTarget).skipped === true;
}

/**
 * 글의 콜론 태그 중 관계 태그만 골라 ParsedRelationTag[] 로 돌려주는 순수 함수.
 *
 * parseClassificationTags 가 매긴 콜론 태그 전부에서 rawCategory 로 lookupRelationTag 를
 * 돌려, 비-null(= 관계 키)인 것만 남긴다. 칸/라벨/일반 분류 태그는 lookupRelationTag 가
 * null 을 줘 자연 제외된다 — 칸/라벨과 갈래가 여기서 갈린다(3분법 spec §3).
 *
 * value 가 빈 값이면 제외(이름 없는 target 금지). parseClassificationTags 가 이미 빈
 * value 를 거르지만, 한 단 더 trim 검사를 둬 공백만 든 값도 막는다(정직·거짓 엣지 0).
 */
export function parseRelationTags(content: string): ParsedRelationTag[] {
  const result: ParsedRelationTag[] = [];
  if (!content) return result;

  for (const tag of parseClassificationTags(content)) {
    const spec = lookupRelationTag(tag.rawCategory);
    if (!spec) continue; // 관계 키 아님 — 칸·라벨·일반 분류 태그(3단계가 처리).
    const value = tag.value.trim();
    if (!value) continue; // 빈 값 — 이름 없는 target 금지.
    result.push({ rawKey: tag.rawCategory, value, spec });
  }

  return result;
}

/**
 * 같은 글 명시 타입 힌트에서 이 값이 어떤 타입으로 선언됐는지 찾는다(trim·소문자 동등).
 * 여러 힌트가 같은 값을 서로 다른 타입으로 선언했으면(모순) null — 모호하니 가르지 않는다.
 */
function hintTypeForValue(
  value: string,
  allowedTargetTypes: readonly PlacementTypeName[],
  sameDocTypeHints: readonly SameDocTypeHint[],
): PlacementTypeName | null {
  const lower = value.trim().toLowerCase();
  const allowed = new Set<string>(allowedTargetTypes);
  const matched = new Set<PlacementTypeName>();
  for (const hint of sameDocTypeHints) {
    if (hint.value.trim().toLowerCase() !== lower) continue;
    if (!allowed.has(hint.type)) continue; // 이 관계가 허용하지 않는 타입 힌트는 무시.
    matched.add(hint.type);
  }
  if (matched.size === 1) return [...matched][0]!;
  return null; // 힌트 없음 또는 한 값이 여러 타입(모순) — 가르지 못함.
}

/**
 * 관계가 가리키는 target 을 실제 엔티티 행으로 해석한다.
 *
 * 판정 순서:
 *  1. value 가 빈 값이면 {skipped} (이름 없는 target — 거짓 엣지 0).
 *  2. target 타입이 하나면 그 타입으로 행 해석.
 *  3. target 타입이 여럿이면 가르기: 같은 글 명시 타입 힌트 → spec.defaultTargetType.
 *     기본 타입이 항상 떨어지므로 일반 입력은 ③(완전 모호 skip)까지 가지 않지만,
 *     defaultTargetType 이 허용 타입 밖이면(어휘 정의 오류) {skipped} 로 멈춘다(방어선).
 *
 * 사람 target 은 createEntityRow("person", value) → findOrCreatePersonByName 로 별명
 * spec·userId 미각인이 그대로 적용된다. 그 외 타입은 findOrCreate<Type> 이름 UNIQUE.
 * 명시 관계 태그라 게이트(shouldCreateEntityRow)를 거치지 않고 바로 행을 만든다.
 *
 * @param store 실제 SqliteMemoryStore(실 DB·실 임베딩).
 * @param spec 관계 명세(parseRelationTags 가 매긴 것).
 * @param value target 이름(예: '아쿠타미'). 빈 값이면 skip.
 * @param sameDocTypeHints 같은 글 명시 타입 힌트(Task 4 가 넘겨줌·기본 빈 배열).
 */
export async function resolveRelationTarget(
  store: SqliteMemoryStore,
  spec: RelationSpec,
  value: string,
  sameDocTypeHints: readonly SameDocTypeHint[] = [],
): Promise<RelationTargetResult> {
  const name = value.trim();
  if (!name) {
    return {
      skipped: true,
      reason: `관계 '${spec.relation}' 의 target 값이 비어 있어 해석하지 않는다(이름 없는 target — 거짓 엣지 0)`,
    };
  }

  const targetType = pickTargetType(spec, name, sameDocTypeHints);
  if (targetType === null) {
    return {
      skipped: true,
      reason:
        `관계 '${spec.relation}' 의 target '${name}' 타입이 모호하다 — ` +
        `허용 타입(${spec.targetTypes.join("/")}) 중 같은 글 힌트도 기본 타입(${spec.defaultTargetType})도 ` +
        `가르지 못해 거짓 엣지를 피하려 건너뛴다`,
    };
  }

  const row: CreatedEntityRow = await createEntityRow(store, targetType, name);
  return { type: row.typeName, id: row.id, name: row.name };
}

/**
 * 관계의 target 타입을 가른다(resolveRelationTarget 내부). 단일 타입이면 그 타입,
 * 여럿이면 같은 글 힌트 → 기본 타입. 기본 타입이 허용 밖이면 null(어휘 오류 방어선).
 */
function pickTargetType(
  spec: RelationSpec,
  value: string,
  sameDocTypeHints: readonly SameDocTypeHint[],
): PlacementTypeName | null {
  // 단일 target 타입 — 그 타입으로 바로 해석.
  if (spec.targetTypes.length === 1) {
    return spec.targetTypes[0]!;
  }

  // 여러 target 타입 — ① 같은 글 명시 타입 힌트.
  const hinted = hintTypeForValue(value, spec.targetTypes, sameDocTypeHints);
  if (hinted !== null) return hinted;

  // ② 기본 타입(허용 타입 안일 때만 — 어휘 정의가 어긋나면 ③ null 로 멈춘다).
  if (spec.targetTypes.includes(spec.defaultTargetType)) {
    return spec.defaultTargetType;
  }

  // ③ 못 가름 — 거짓 엣지 0.
  return null;
}
