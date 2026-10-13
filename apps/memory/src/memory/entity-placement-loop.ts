/**
 * entity-placement-loop.ts — 타입별 배치 루프 facade(G5-a 분해).
 *
 * 옛 단일 파일이 1409줄로 800줄 하드 상한을 넘겨, 책임 경계로
 * entity-placement-loop-internal/ 하위 모듈에 코드를 옮겼다(선례 store.ts →
 * store-internal 분해). 동작은 0 변화 — 코드 이동만이다(로직·시그니처·산출 그대로).
 * 공개 export 심볼은 이름 그대로 이 facade 가 재노출하므로 호출처
 * (entity-placement-wiring·hashtag-entity-wiring·classify-vocab 등)는 무변경이다.
 *
 * 하위 모듈 경계:
 *   - placement-result.ts       — EntityPlacementResult 계약·appendChainStopWarning 경고.
 *   - chain-structure.ts        — 콜론 사슬 구조 추적 순수 함수(중간 마디·leaf 추적·진입점·
 *                                 forward sub-content·project 사슬 소비 키).
 *   - candidate-attributes.ts   — 끝 고유명 후보·속성 태그·타입 힌트·속성 어휘 키 추출.
 *   - consumed-scopes.ts        — 사람·프로젝트·work 경로 소비분 재현(겹침 0 제외 집합).
 *   - row-and-alias.ts          — 1급 행 생성·별칭 등록·사람 글 작품 연결.
 *   - place-entity-type.ts      — placeOneEntityType(신규 8 타입 배치 본체).
 *   - place-user-entity-type.ts — placeOneUserEntityType(사용자 새 종류 배치 본체).
 */

export type { EntityPlacementResult } from "./entity-placement-loop-internal/placement-result.ts";
export { appendChainStopWarning } from "./entity-placement-loop-internal/placement-result.ts";
export type { GroupDecl } from "./entity-placement-loop-internal/chain-structure.ts";
export {
  isMidChainNode,
  resolveChainLeafValue,
  chainEntriesOf,
  buildForwardChainSubContent,
  projectChainConsumedKeys,
} from "./entity-placement-loop-internal/chain-structure.ts";
export {
  isEntityType,
  extractCandidateName,
  lastCategoryOf,
  detectSameSubcategoryExtras,
  buildTypeAttributeKeys,
} from "./entity-placement-loop-internal/candidate-attributes.ts";
export {
  entityConsumedRawCategories,
  workPairKey,
  workConsumedClassificationPairs,
} from "./entity-placement-loop-internal/consumed-scopes.ts";
export {
  createRowForPlacement,
  connectPersonDocWork,
} from "./entity-placement-loop-internal/row-and-alias.ts";
export { placeOneEntityType } from "./entity-placement-loop-internal/place-entity-type.ts";
export { placeOneUserEntityType } from "./entity-placement-loop-internal/place-user-entity-type.ts";
