/**
 * Text + textarea 위젯 (Phase 5.5.2 / spec section 5.1).
 *
 * password 위젯은 별도 모듈 (`./password.ts`, S6 / 5.5.3) — 마스킹 약속
 * (spec section 5.3) 이 본 모듈과 무관하기 때문. 본 모듈은 *기본 입력만*.
 */

import {
  assemble,
  createDescription,
  createErrorContainer,
  createFieldWrapper,
  createLabel,
  shouldShowDescription,
} from "./helpers";
import type { WidgetContext } from "./widget";

function widgetVariant(ctx: WidgetContext): "text" | "textarea" {
  const w = ctx.schema["x-ui"]?.widget;
  if (w === "textarea") return "textarea";
  return "text";
}

export function renderTextWidget(ctx: WidgetContext): HTMLElement {
  const variant = widgetVariant(ctx);
  const wrapper = createFieldWrapper();
  wrapper.dataset.widget = variant;
  wrapper.dataset.path = ctx.path;

  const label = createLabel(ctx.key, ctx.schema, ctx.required ?? false);

  let input: HTMLInputElement | HTMLTextAreaElement;
  if (variant === "textarea") {
    const ta = document.createElement("textarea");
    ta.rows = 4;
    input = ta;
  } else {
    const i = document.createElement("input");
    i.type = "text";
    input = i;
  }
  input.className = "form-input";
  input.name = ctx.path;
  input.value = typeof ctx.value === "string" ? ctx.value : "";
  if (ctx.required) input.required = true;
  if (typeof ctx.schema.pattern === "string" && input instanceof HTMLInputElement) {
    input.pattern = ctx.schema.pattern;
  }
  if (typeof ctx.schema.minLength === "number") input.minLength = ctx.schema.minLength;
  if (typeof ctx.schema.maxLength === "number") input.maxLength = ctx.schema.maxLength;

  input.addEventListener("input", () => {
    ctx.onChange(ctx.path, input.value);
  });

  const description = shouldShowDescription(ctx.schema) && ctx.schema.description
    ? createDescription(ctx.schema.description)
    : undefined;
  const errorEl = createErrorContainer();
  return assemble(wrapper, label, input, description, errorEl);
}
