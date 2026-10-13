/**
 * Boolean 위젯 (Phase 5.5.2 / spec section 5.1).
 */

import {
  createDescription,
  createErrorContainer,
  createFieldWrapper,
  createLabel,
  shouldShowDescription,
} from "./helpers";
import type { WidgetContext } from "./widget";

export function renderBooleanWidget(ctx: WidgetContext): HTMLElement {
  const wrapper = createFieldWrapper();
  wrapper.dataset.widget = "boolean";
  wrapper.dataset.path = ctx.path;

  const label = createLabel(ctx.key, ctx.schema, ctx.required ?? false);
  const toggleRow = document.createElement("div");
  toggleRow.className = "form-toggle-row";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "form-toggle";
  input.name = ctx.path;
  input.checked = ctx.value === true;

  input.addEventListener("change", () => {
    ctx.onChange(ctx.path, input.checked);
  });

  toggleRow.appendChild(input);
  toggleRow.appendChild(label);

  wrapper.appendChild(toggleRow);
  if (shouldShowDescription(ctx.schema) && ctx.schema.description) {
    wrapper.appendChild(createDescription(ctx.schema.description));
  }
  wrapper.appendChild(createErrorContainer());
  return wrapper;
}
