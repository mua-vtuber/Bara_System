/**
 * placement-result.ts — 배치 결과 계약·사슬 멈춤 경고(entity-placement-loop 에서 분리·G5-a).
 *
 * entity-placement-loop.ts 가 1409줄로 800줄 하드 상한을 넘겨 책임 경계로 하위 모듈에
 * 코드를 옮겼다(동작 0 변화 — 코드 이동만). 이 모듈은 배치 통로 전체가 공유하는 결과
 * 구조체(EntityPlacementResult)와, 행을 안 만든 갈래의 정직한 경고 헬퍼
 * (appendChainStopWarning)를 모은다 — 배치 본체·행 생성·wiring 이 모두 이 계약을 본다.
 */

import type { PlacementTypeName } from "../concept-type-vocabulary.ts";
import type { CreatedRelationEdge } from "../entity-relation-wiring.ts";
import type { EntityTypeClassification } from "../entity-type-classifier.ts";

/** wireEntityPlacement 의 반환값 — 호출처(입력 통로) 로그·디버깅용(spec/plan 정의). */
export interface EntityPlacementResult {
  /** 배치된 타입(기타·person/project 건너뜀이면 null). */
  typeName: PlacementTypeName | null;
  /** 위계 진입 분류 키(없으면 null). */
  subcategory: string | null;
  /** 새로 세운 타입↔분류 parent_of 위계 호출 수(linkSubcategoryToTypeRoot 가동 횟수). */
  hierarchyEdges: number;
  /** 1급 행을 만들었나(결정 A·B 게이트 통과). */
  entityRowCreated: boolean;
  /** 만든/찾은 엔티티 행 id(행 없으면 null). */
  entityId: string | null;
  /** 이번 배치가 만진 엔티티 행 목록(응답 요약용). */
  entities?: Array<{ typeName: string; id: string }>;
  /** 채운 전용 칸 수. */
  columnsApplied: number;
  /** 붙인 라벨 엣지 수. */
  labelsApplied: number;
  /**
   * 세운 관계 엣지(작품→사람 created_by 등 — 4단계 Task 4). 행이 생겼을 때만 채워진다.
   * 멱등이라 이미 있던 엣지는 여기 안 들어온다(새로 만든 것만). 행이 없으면 빈 배열.
   */
  relationEdges: CreatedRelationEdge[];
  /** 정직한 경고(모호·미반영·건너뜀 사유). */
  warnings: string[];
}

/**
 * 행을 안 만든 갈래에서 사슬 추적 멈춤 사유를 result.warnings 로 정직히 알린다 —
 * (다) 게이트 ①·③ 경고(2026-06-12 콜론 사슬 자동 배치). silent 차단이 목적이라,
 * 왜 행이 안 생겼는지 사람이 읽을 한국어 사유를 남긴다(환각 금지·실제 분기만 적는다).
 *
 *  - ① ended-in-category — 사슬이 분류에서 끝나 candidateName 이 빈 문자열. 행 게이트가
 *    빈 이름으로 행을 안 만든다. "이름 후보를 못 찾음" 경고.
 *  - ③ candidateName 이 분류 단어·일반명사 씨앗 — 게이트 결정 A·B 가 막음. candidateName
 *    이 비어 있지 않은데 행이 null 이면 이 갈래다. "분류 단어가 이름 자리에" 경고.
 *
 * depth-or-cycle 인데 행이 안 생긴 경우(빈 후보 등)도 ①·③ 사유로 함께 알린다 — 행이
 * 생긴 depth-or-cycle 경고는 호출처가 별도로 남긴다(이중 경고 0).
 */
export function appendChainStopWarning(
  result: EntityPlacementResult,
  classification: EntityTypeClassification,
  candidateName: string,
): void {
  if (classification.source !== "explicit") return;
  if (candidateName.trim() === "") {
    // 사슬이 분류에서 끝나 고유명을 못 만남(빈 후보) — ① ended-in-category.
    const sub = classification.subcategory ?? "(분류 미상)";
    result.warnings.push(
      `이름 후보를 못 찾음 — 사슬이 분류 '${sub}' 에서 끝나 엔티티 행을 만들지 않음`,
    );
    return;
  }
  // candidateName 이 있는데 행이 null — ③ 분류 단어·일반명사 씨앗이 이름 자리에 와 게이트가 막음.
  result.warnings.push(
    `분류 단어가 이름 자리에 — '${candidateName}' 은(는) 분류·일반명사라 행 미생성(사슬을 잘못 적었을 수 있음)`,
  );
}
