/**
 * source-type-prefix.ts — W10 검색 결과 자산 종류 prefix 양식 단일 출처.
 *
 * Phase 6b T11(W10) = 결정 기록 task. spec
 * `docs/decisions/2026-05-24-phase6-llm-independence-core-spec(...).md`
 * 단락 12.1 의 prefix 양식(5 종류)을 코드 상수 + 순수 매핑 함수로 정착시킨다.
 *
 * 이 모듈이 정의하는 것:
 *   검색 결과에 *어떤 자산 종류*인지(atomic / 문서 chunk / 이미지 캡션 /
 *   관계 요약 / chunk 요약)를 사용자에게 즉시 보여주는 표시용 prefix.
 *
 * 저장 시점의 source_type(`'auto_capture'` / `'user_explicit'` — 메모리가
 * 어떻게 들어왔는가)과는 다른 개념이다(그쪽은 db/store-internal/args-types.ts
 * 의 `SourceType`). 충돌을 피하려고 여기서는 `ResultSourceType` 라고 부른다.
 *
 * 5 종류 중 현재 데이터가 있는 것은 `atomic` 뿐이고 나머지는 후속 Phase 산출이다:
 *   - document_chunk  -> Phase 14(문서 단위 입력)
 *   - image_caption   -> Phase 11(이미지 메모리)
 *   - relation_summary / chunk_summary -> Phase 7/14(요약 산출)
 * W10 은 앞을 보는 결정이라 5 종류를 지금 모두 정의해, Phase 8/11/14/7 이 같은
 * 단일 출처를 가져다 쓰도록 한다.
 *
 * Phase 8 cross-ref(spec 12.2): 실제 UI 표시(색상·아이콘·레이아웃·클릭 펼침·
 * 검색 필터·그래프 시각화) = Phase 8 권위(대시보드 확장). 검색 응답이 prefix
 * 칸을 실어 나를지 여부도 Phase 8 결정. 이 모듈은 양식 상수 + 매핑 함수만 정착시켜
 * Phase 8 이 import 하도록 둔다.
 */

/** 검색 결과 표시용 자산 종류 키. 저장 시점 `SourceType` 과 별개 개념이다. */
export type ResultSourceType =
  | "atomic"
  | "document_chunk"
  | "image_caption"
  | "relation_summary"
  | "chunk_summary";

/**
 * spec 12.1 의 prefix 양식 단일 출처. 5 종류 prefix 를 여기 한곳에 모은다
 * (흩어진 하드코딩 금지 / i18n 준비). Phase 8 이 표시할 때 이 상수를 읽는다.
 */
export const SOURCE_TYPE_PREFIX: Readonly<Record<ResultSourceType, string>> = {
  atomic: "[atomic]",
  document_chunk: "[document_chunk]",
  image_caption: "[image_caption]",
  relation_summary: "[relation_summary]",
  chunk_summary: "[chunk_summary]",
} as const;

/** 정의된 5 종류의 순서 목록(반복 검증·UI 열거용). */
export const RESULT_SOURCE_TYPES: ReadonlyArray<ResultSourceType> = Object.keys(
  SOURCE_TYPE_PREFIX,
) as ResultSourceType[];

/**
 * 자산 종류 -> 표시 prefix 순수 매핑.
 *
 * 정의된 5 종류면 spec 12.1 양식의 prefix 를 그대로 돌려준다.
 * 미지의 종류는 빈 문자열을 돌려준다 — 가짜 라벨을 지어내지 않는다.
 * (Phase 8 이 표시 정밀화 시점에 미지 처리 양식을 더 다듬을 수 있다.)
 */
export function formatSourceTypePrefix(sourceType: string): string {
  if (Object.prototype.hasOwnProperty.call(SOURCE_TYPE_PREFIX, sourceType)) {
    return SOURCE_TYPE_PREFIX[sourceType as ResultSourceType];
  }
  return "";
}
