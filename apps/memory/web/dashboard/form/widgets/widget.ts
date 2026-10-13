/**
 * Widget interface (Phase 5.5.2 / spec section 5.1)
 *
 * 본 모듈 자동 폼 위젯들의 일관 시그니처. 각 위젯이 본 인터페이스를 따르고,
 * form-renderer (S5) 가 본 시그니처로 디스패치한다.
 */

/** JSON Schema 일부 타입 (본 모듈이 활용하는 부분만 추출). */
export interface FieldSchema {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  required?: string[];
  items?: FieldSchema;
  properties?: Record<string, FieldSchema>;
  /** 본 모듈 확장 (spec section 5.1). */
  "x-ui"?: {
    widget?:
      | "text"
      | "textarea"
      | "password"
      | "number"
      | "boolean"
      | "select"
      | "enum"
      | "dynamic-enum"
      | "inline-object";
    enumLabels?: Record<string, string>;
    showDescription?: boolean;
    actionId?: string;
    labelField?: string;
    valueField?: string;
  };
}

/** onChange 콜백 — path 는 점 표기법 (예: `evolver.threshold`). */
export type OnChange = (path: string, value: unknown) => void;

/** 위젯 일관 시그니처. */
export interface WidgetContext {
  key: string;
  path: string;
  schema: FieldSchema;
  value: unknown;
  onChange: OnChange;
  required?: boolean;
}

export type WidgetRenderer = (ctx: WidgetContext) => HTMLElement;
