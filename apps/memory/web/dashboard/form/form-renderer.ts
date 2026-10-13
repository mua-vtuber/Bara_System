/**
 * Form Renderer (Phase 5.5.2 / spec section 5).
 *
 * 자동 폼 메인 — 스키마 재귀 처리 + 위젯 디스패치 + 검증 + 값 수집 +
 * 의존성 변경 시 재렌더링.
 *
 * Phase 5.5.3 확장 (S6 + S7):
 *   - password 위젯 별도 디스패치 + 마스킹 약속 (`originalValue` + collectChangedFields)
 *   - dynamic-enum 위젯 + actions 렌더링 (`appContext` 옵션)
 */

import type { FieldSchema, WidgetContext } from "./widgets/widget";
import { renderTextWidget } from "./widgets/text";
import { renderPasswordWidget } from "./widgets/password";
import { renderNumberWidget } from "./widgets/number";
import { renderBooleanWidget } from "./widgets/boolean";
import { renderEnumWidget } from "./widgets/enum";
import { renderArrayWidget } from "./widgets/array";
import { renderObjectWidget } from "./widgets/object";
import { renderDynamicEnumWidget } from "./widgets/dynamic-enum";
import { renderActions, type ManifestAction } from "./actions";
import { collectChangedFields } from "./masking";
import { validate, type ValidationError } from "./validator";
import {
  getActiveProperties,
  type ConditionalSchema,
} from "./dependency";

type Schema = FieldSchema & ConditionalSchema;

export interface RenderFormOptions {
  schema: Schema;
  initialValue: Record<string, unknown>;
  onSubmit?: (value: Record<string, unknown>) => void | Promise<void>;
  /**
   * getPath 응답 원본 (마스킹 sentinel 포함). 본 옵션이 있으면 submit 시
   * 변경된 필드만 PUT body 로 추출 (password 마스킹 약속, spec 5.3/6.4).
   * 없으면 전체 값을 onSubmit 에 전달.
   */
  originalValue?: Record<string, unknown>;
  /**
   * 어댑터 매니페스트 컨텍스트 — dynamic-enum 위젯 + actions 버튼이 사용.
   * 없으면 본 둘 다 동작 안 함.
   */
  appContext?: { endpoint: string; actions: ManifestAction[] };
}

export interface RenderedForm {
  element: HTMLFormElement;
  /** 현재 값 스냅샷 반환. */
  getValue: () => Record<string, unknown>;
  /** 현재 값 검증 결과. */
  validate: () => ValidationError[];
  /** 외부에서 값 통째 교체 (예: getPath 응답으로 새로 채우기). */
  setValue: (next: Record<string, unknown>) => void;
}

function setByPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const tokens = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((t) => t.length > 0);
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < tokens.length - 1; i++) {
    const tok = tokens[i]!;
    const next = cursor[tok];
    if (typeof next !== "object" || next === null) {
      cursor[tok] = {};
    }
    cursor = cursor[tok] as Record<string, unknown>;
  }
  const last = tokens[tokens.length - 1]!;
  if (value === undefined) {
    delete cursor[last];
  } else {
    cursor[last] = value;
  }
}

function getByPath(
  source: Record<string, unknown>,
  path: string,
): unknown {
  const tokens = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((t) => t.length > 0);
  let cursor: unknown = source;
  for (const tok of tokens) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[tok];
  }
  return cursor;
}

function pickWidgetVariant(schema: FieldSchema): string {
  const w = schema["x-ui"]?.widget;
  if (w) return w;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return "enum";
  switch (schema.type) {
    case "boolean":
      return "boolean";
    case "number":
    case "integer":
      return "number";
    case "array":
      return "array";
    case "object":
      return "object";
    default:
      return "text";
  }
}

function shouldInlineObject(schema: FieldSchema): boolean {
  return schema.type === "object" && schema["x-ui"]?.widget === "inline-object";
}

function dispatchWidget(
  ctx: WidgetContext,
  renderChildren?: (parent: HTMLElement) => void,
  appContext?: { endpoint: string; actions: ManifestAction[] },
): HTMLElement {
  const variant = pickWidgetVariant(ctx.schema);
  switch (variant) {
    case "password":
      return renderPasswordWidget(ctx);
    case "textarea":
    case "text":
      return renderTextWidget(ctx);
    case "dynamic-enum": {
      const actionId = ctx.schema["x-ui"]?.actionId;
      if (!appContext || !actionId) {
        throw new Error(
          `dynamic-enum 위젯 '${ctx.path}' 가 동작하려면 appContext + actionId 가 필요`,
        );
      }
      const action = appContext.actions.find((a) => a.id === actionId);
      if (!action) {
        throw new Error(
          `dynamic-enum 위젯 '${ctx.path}' 의 actionId='${actionId}' 가 매니페스트 actions 에 없음`,
        );
      }
      return renderDynamicEnumWidget(ctx, {
        action,
        endpoint: appContext.endpoint,
      });
    }
    case "number":
      return renderNumberWidget(ctx);
    case "boolean":
      return renderBooleanWidget(ctx);
    case "select":
    case "enum":
      return renderEnumWidget(ctx);
    case "array":
      return renderArrayWidget(ctx);
    case "object":
      return renderObjectWidget(ctx, {
        renderChildren: renderChildren ?? (() => {}),
      });
    default:
      return renderTextWidget(ctx);
  }
}

export function renderForm(options: RenderFormOptions): RenderedForm {
  const form = document.createElement("form");
  form.className = "form-root";
  form.noValidate = true;

  let value: Record<string, unknown> = JSON.parse(
    JSON.stringify(options.initialValue ?? {}),
  );

  function rebuild(): void {
    form.innerHTML = "";
    renderObjectFields(form, options.schema, "", value);

    const errorRoot = document.createElement("div");
    errorRoot.className = "form-root-errors";
    form.appendChild(errorRoot);

    // actions 버튼 묶음 — `returns: 'enum'` 액션은 dynamic-enum 위젯이 자체 흡수
    // 하므로 외부 버튼에서는 중복 노출 안 함.
    if (options.appContext && options.appContext.actions.length > 0) {
      const nonEnumActions = options.appContext.actions.filter(
        (a) => a.returns !== "enum",
      );
      if (nonEnumActions.length > 0) {
        form.appendChild(
          renderActions(
            nonEnumActions,
            options.appContext.endpoint,
            () => value,
          ),
        );
      }
    }

    if (options.onSubmit) {
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.className = "form-submit";
      submit.textContent = "저장";
      form.appendChild(submit);
      form.addEventListener("submit", (ev: SubmitEvent) => {
        ev.preventDefault();
        const errors = validate(options.schema, value).errors;
        if (errors.length > 0) {
          showErrors(errors);
          return;
        }
        const payload = options.originalValue
          ? collectChangedFields(options.originalValue, value, options.schema)
          : value;
        void options.onSubmit?.(payload);
      });
    }
  }

  function onChange(path: string, next: unknown): void {
    setByPath(value, path, next);
    // 의존성이 있는 스키마는 변경 시 *전체 재렌더링* (단순 일관 전략).
    const needsRebuild = schemaHasConditional(options.schema);
    if (needsRebuild) rebuild();
  }

  function renderObjectFields(
    parent: HTMLElement,
    schema: Schema,
    basePath: string,
    valueRef: unknown,
  ): void {
    const objValue =
      typeof valueRef === "object" && valueRef !== null
        ? (valueRef as Record<string, unknown>)
        : {};
    const active = getActiveProperties(schema, objValue);
    const requiredFields = new Set(schema.required ?? []);

    for (const [key, childSchema] of Object.entries(active)) {
      const path = basePath === "" ? key : `${basePath}.${key}`;
      const childValue = getByPath(value, path);
      if (shouldInlineObject(childSchema)) {
        renderObjectFields(parent, childSchema as Schema, path, childValue);
        continue;
      }
      const ctx: WidgetContext = {
        key,
        path,
        schema: childSchema,
        value: childValue,
        onChange,
        required: requiredFields.has(key),
      };
      const el = dispatchWidget(
        ctx,
        (innerParent) => {
          renderObjectFields(innerParent, childSchema as Schema, path, childValue);
        },
        options.appContext,
      );
      parent.appendChild(el);
    }
  }

  function showErrors(errors: ValidationError[]): void {
    const root = form.querySelector(".form-root-errors");
    if (root) {
      root.textContent = errors
        .map((e) => `${e.path}: ${e.message}`)
        .join("\n");
    }
    // 각 필드별 인라인 에러 — path 로 form-field 를 찾아 .form-error 텍스트 갱신.
    for (const err of errors) {
      const field = form.querySelector(
        `.form-field[data-path="${cssEscape(err.path)}"]`,
      );
      const errEl = field?.querySelector(".form-error");
      if (errEl) errEl.textContent = err.message;
    }
  }

  rebuild();

  return {
    element: form,
    getValue: () => JSON.parse(JSON.stringify(value)),
    validate: () => validate(options.schema, value).errors,
    setValue: (next) => {
      value = JSON.parse(JSON.stringify(next));
      rebuild();
    },
  };
}

function schemaHasConditional(schema: Schema): boolean {
  if (schema.if || schema.dependentSchemas) return true;
  if (schema.properties) {
    for (const c of Object.values(schema.properties)) {
      if (schemaHasConditional(c as Schema)) return true;
    }
  }
  return false;
}

function cssEscape(value: string): string {
  return value.replace(/(["\\\[\]])/g, "\\$1");
}
