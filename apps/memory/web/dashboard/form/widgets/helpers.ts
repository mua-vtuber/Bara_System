/**
 * Widget helpers (Phase 5.5.2 / spec section 5.1)
 *
 * 라벨 / 도움말 / 에러 컨테이너 생성 공통 함수.
 */

import type { FieldSchema } from "./widget";

export function createLabel(
  key: string,
  schema: FieldSchema,
  required: boolean,
): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "form-label";
  label.textContent = schema.title ?? key;
  if (required) {
    const star = document.createElement("span");
    star.className = "form-required";
    star.textContent = " *";
    label.appendChild(star);
  }
  return label;
}

export function createDescription(text: string): HTMLElement {
  const el = document.createElement("p");
  el.className = "form-description";
  el.textContent = text;
  return el;
}

export function shouldShowDescription(schema: FieldSchema): boolean {
  return schema["x-ui"]?.showDescription === true;
}

export function createErrorContainer(): HTMLElement {
  const el = document.createElement("p");
  el.className = "form-error";
  el.setAttribute("aria-live", "polite");
  return el;
}

export function createFieldWrapper(): HTMLElement {
  const el = document.createElement("div");
  el.className = "form-field";
  return el;
}

export function assemble(
  wrapper: HTMLElement,
  label: HTMLLabelElement,
  input: HTMLElement,
  description?: HTMLElement,
  error?: HTMLElement,
): HTMLElement {
  wrapper.appendChild(label);
  wrapper.appendChild(input);
  if (description) wrapper.appendChild(description);
  if (error) wrapper.appendChild(error);
  return wrapper;
}
