/**
 * Number 위젯 (Phase 5.5.2 / spec section 5.1).
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

export function renderNumberWidget(ctx: WidgetContext): HTMLElement {
  const wrapper = createFieldWrapper();
  wrapper.dataset.widget = "number";
  wrapper.dataset.path = ctx.path;

  const label = createLabel(ctx.key, ctx.schema, ctx.required ?? false);

  const input = document.createElement("input");
  input.type = "number";
  input.className = "form-input";
  input.name = ctx.path;
  input.value = typeof ctx.value === "number" ? String(ctx.value) : "";
  if (ctx.required) input.required = true;
  if (typeof ctx.schema.minimum === "number") input.min = String(ctx.schema.minimum);
  if (typeof ctx.schema.maximum === "number") input.max = String(ctx.schema.maximum);
  if (ctx.schema.type === "integer") input.step = "1";

  input.addEventListener("input", () => {
    const raw = input.value;
    if (raw === "") {
      ctx.onChange(ctx.path, undefined);
      return;
    }
    const n = Number(raw);
    ctx.onChange(ctx.path, Number.isNaN(n) ? raw : n);
  });

  const description = shouldShowDescription(ctx.schema) && ctx.schema.description
    ? createDescription(ctx.schema.description)
    : undefined;
  const errorEl = createErrorContainer();
  return assemble(wrapper, label, input, description, errorEl);
}
