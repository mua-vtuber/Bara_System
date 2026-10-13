/**
 * Password 위젯 + 마스킹 약속 (Phase 5.5.3 / spec section 5.3).
 *
 * 본 위젯은 getPath 응답 안 *마스킹 sentinel* 을 인식하여 placeholder 만
 * 표시한다. 본인이 *새 값을 입력* 할 때만 onChange 로 실제 string 을 전달.
 *
 * sentinel 형태 2종 (spec 5.3 정합):
 *   1) value === null + 상위 객체의 `$masked` 배열에 본 필드 키 포함
 *   2) value === '••••' (1자 이상 마스킹 문자 반복)
 *
 * 동작: value 가 sentinel 이면 input 을 비우고 placeholder "현 값 유지" 표시.
 * 본인이 새 값 입력 시 input.value 가 일반 string 으로 바뀌고 onChange 호출.
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

const MASK_CHAR = "•";
const PLACEHOLDER_TEXT = "현 값 유지";

export function isMaskedValue(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  for (const ch of value) {
    if (ch !== MASK_CHAR) return false;
  }
  return true;
}

export function renderPasswordWidget(ctx: WidgetContext): HTMLElement {
  const wrapper = createFieldWrapper();
  wrapper.dataset.widget = "password";
  wrapper.dataset.path = ctx.path;

  const masked = isMaskedValue(ctx.value);
  if (masked) wrapper.dataset.masked = "true";

  const label = createLabel(ctx.key, ctx.schema, ctx.required ?? false);

  const input = document.createElement("input");
  input.type = "password";
  input.className = "form-input";
  input.name = ctx.path;
  if (masked) {
    input.value = "";
    input.placeholder = PLACEHOLDER_TEXT;
  } else {
    input.value = typeof ctx.value === "string" ? ctx.value : "";
  }
  if (ctx.required && !masked) input.required = true;
  if (typeof ctx.schema.pattern === "string") input.pattern = ctx.schema.pattern;
  if (typeof ctx.schema.minLength === "number") input.minLength = ctx.schema.minLength;
  if (typeof ctx.schema.maxLength === "number") input.maxLength = ctx.schema.maxLength;

  input.addEventListener("input", () => {
    wrapper.dataset.masked = "false";
    ctx.onChange(ctx.path, input.value);
  });

  const description = shouldShowDescription(ctx.schema) && ctx.schema.description
    ? createDescription(ctx.schema.description)
    : undefined;
  const errorEl = createErrorContainer();
  return assemble(wrapper, label, input, description, errorEl);
}
