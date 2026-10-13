/**
 * entity-input-plan.ts — 저장 전 입력 모드 판정.
 *
 * 본문이 없고 콜론 해시태그가 엔티티 선언/속성만 표현하면 글 노드를 만들지 않고
 * 엔티티 프로필 패치로 처리한다. 판정은 순수 함수이며, 실제 row/edge 쓰기는
 * save-input orchestration 이 담당한다.
 */

import { parseTags } from "./tag-extractor.ts";
import { parseClassificationTags } from "./parsers/classification-tag.ts";
import { parseHashtagEntities } from "./parsers/hashtag-entity-parser.ts";
import {
  groupTypeDeclarations,
  excludeDirectInputDeclarations,
} from "./type-declaration-grouping.ts";

export type EntityInputMode =
  | "memory_text"
  | "entity_patch"
  | "schedule_occurrence";

export interface EntityInputPlan {
  mode: EntityInputMode;
  reason: string;
}

/**
 * 입력을 글 저장 또는 엔티티 프로필 패치로 분류한다.
 *
 * entity_patch 조건:
 *  - 콜론 해시태그 제거 후 본문이 비어 있음
 *  - 콜론 없는 평면 태그가 없음(`#만화` only 기존 글 저장 보존)
 *  - 깨진 예약 태그/글 노드 전용 날짜 필드가 없음
 *    (단, 본문 없는 일정 1개 + 날짜는 schedule_occurrence)
 *  - 사람/프로젝트/배치 타입 선언 중 하나가 있음
 *
 * 직접 `#장소:강남 A마트` 는 글의 장소 칸이므로 memory_text 로 남긴다. 단,
 * `#장소:병원 #병원:피부과` 처럼 `excludeDirectInputDeclarations` 뒤에도 place 그룹이
 * 남는 사슬 입력은 장소 엔티티 계층이라 entity_patch 대상이 될 수 있다.
 */
export function planEntityInput(content: string): EntityInputPlan {
  const parsedTags = parseTags(content);
  if (parsedTags.cleanContent.trim().length > 0) {
    return { mode: "memory_text", reason: "본문 있음" };
  }

  if (parsedTags.tags.length > 0) {
    return { mode: "memory_text", reason: "콜론 없는 평면 태그 입력" };
  }

  const colonTags = parseClassificationTags(content);
  if (colonTags.length === 0) {
    return { mode: "memory_text", reason: "엔티티 콜론 태그 없음" };
  }

  const parsed = parseHashtagEntities(content);
  if (parsed.errors.length > 0) {
    return { mode: "memory_text", reason: "깨진 예약 태그 있음" };
  }

  const groups = excludeDirectInputDeclarations(
    groupTypeDeclarations(content),
    content,
  );
  const scheduleGroups = groups.filter((g) => g.type === "schedule");
  const hasDateField = parsed.directFields.some(
    (f) => f.column === "event_at" || f.column === "event_until",
  );
  if (
    hasDateField &&
    groups.length === 1 &&
    scheduleGroups.length === 1 &&
    scheduleGroups[0]!.declValues.length === 1
  ) {
    return { mode: "schedule_occurrence", reason: "본문 없는 일정 발생 입력" };
  }

  if (parsed.directFields.length > 0) {
    return { mode: "memory_text", reason: "글 노드 전용 날짜 필드 있음" };
  }

  const hasDirectPlaceOnly =
    parsed.placeFields.length > 0 && !groups.some((g) => g.type === "place");
  if (hasDirectPlaceOnly) {
    return { mode: "memory_text", reason: "글 노드 전용 직접 장소 필드 있음" };
  }

  const hasEntityTarget =
    parsed.personDeclarations.length > 0 ||
    parsed.projectDeclarations.length > 0 ||
    groups.length > 0;
  if (!hasEntityTarget) {
    return { mode: "memory_text", reason: "붙일 엔티티 대상 없음" };
  }

  return { mode: "entity_patch", reason: "본문 없는 엔티티 정보 입력" };
}
