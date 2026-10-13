/**
 * Memory Core Settings Schema — 타입 정의 (C2/schema 분해 2026-06-27).
 *
 * memory-schema.ts 의 schema 형태 인터페이스만 떼어낸 파일. 런타임 값은 없고
 * FieldSchema / SubGroupSchema / GroupSchema / UiWidgetHint 타입 4개만 담는다.
 * memory-schema-groups-*.ts 와 memory-schema.ts 가 이 타입을 import 한다.
 */

/** UI 위젯 힌트 — 폼 렌더러가 패스워드 마스킹 / dynamic-enum / select 갈래 분기를 식별. */
export type UiWidgetHint =
  | { widget: "password" }
  | { widget: "select" }
  | { widget: "multi-select" }
  | {
      widget: "dynamic-enum";
      actionId: string;
      labelField: string;
      valueField: string;
    };

/** 한 필드의 schema 항목 — title/description/default 한글 포함이 규칙. */
export interface FieldSchema {
  type: "string" | "number" | "integer" | "boolean" | "array";
  title: string;
  description: string;
  default: unknown;
  enum?: readonly string[];
  format?: "uri";
  /** 문자열 검증 정규식 — Phase 5.7.3 W1 trashManagement.cronTime HH:MM 검증 정합. */
  pattern?: string;
  minimum?: number;
  maximum?: number;
  /**
   * Phase 6a T10 — array 타입 원소 schema. extractor.regex.langs 처럼 문자열
   * 배열을 표현. items.enum 이 있으면 다중 선택 후보 목록 (폼 multi-select).
   */
  items?: {
    type: "string";
    enum?: readonly string[];
  };
  "x-ui"?: UiWidgetHint;
}

/**
 * 한 sub-object 슬롯의 schema (Phase 5.6 W5 — llm.extractor / llm.cleanup +
 * Phase 5.7.1 W1 — llm.extractor.backfill 한 단계 더 깊은 sub-object 포함 +
 * Phase 11b T11 — llm.vision (VLM) 3번째 슬롯 추가).
 * group 안에 또 한 겹 들어가는 object property 를 표현.
 */
export interface SubGroupSchema {
  type: "object";
  title: string;
  description: string;
  properties: Record<string, FieldSchema | SubGroupSchema>;
  required: readonly string[];
}

/**
 * 한 그룹의 schema 항목 — properties + required.
 * Phase 5.6 W5 — properties 값으로 FieldSchema 또는 SubGroupSchema (sub-object 슬롯)
 * 둘 다 허용. 단순 필드 그룹 (db / autoCleanup / trashManagement / search /
 * valueDecay) 은 FieldSchema 만, `llm` 한 그룹은 SubGroupSchema (extractor +
 * cleanup + vision) 만 사용.
 */
export interface GroupSchema {
  type: "object";
  title: string;
  description: string;
  properties: Record<string, FieldSchema | SubGroupSchema>;
  required: readonly string[];
}
