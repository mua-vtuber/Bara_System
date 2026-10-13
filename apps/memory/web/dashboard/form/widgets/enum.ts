/**
 * Enum 드롭다운 위젯 (Phase 5.5.2 / spec section 5.1).
 *
 * `x-ui.enumLabels` 가 있으면 각 값을 한글 라벨로 표시. 본 위젯은 *정적
 * enum* 만 다룬다. 런타임 옵션은 별도 `dynamic-enum` 위젯 (S7 / 5.5.3).
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

export function renderEnumWidget(ctx: WidgetContext): HTMLElement {
  const wrapper = createFieldWrapper();
  wrapper.dataset.widget = "enum";
  wrapper.dataset.path = ctx.path;

  const label = createLabel(ctx.key, ctx.schema, ctx.required ?? false);
  const select = document.createElement("select");
  select.className = "form-select";
  select.name = ctx.path;

  const enumLabels = ctx.schema["x-ui"]?.enumLabels ?? {};
  const options = ctx.schema.enum ?? [];

  if (!ctx.required) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "— 선택 —";
    select.appendChild(empty);
  }
  for (const opt of options) {
    const optEl = document.createElement("option");
    const valueStr = String(opt);
    optEl.value = valueStr;
    optEl.textContent = enumLabels[valueStr] ?? valueStr;
    if (ctx.value === opt) optEl.selected = true;
    select.appendChild(optEl);
  }

  select.addEventListener("change", () => {
    const v = select.value;
    if (v === "" && !ctx.required) {
      ctx.onChange(ctx.path, undefined);
      return;
    }
    const matched = options.find((o) => String(o) === v);
    ctx.onChange(ctx.path, matched ?? v);
  });

  const description = shouldShowDescription(ctx.schema) && ctx.schema.description
    ? createDescription(ctx.schema.description)
    : undefined;
  const errorEl = createErrorContainer();
  return assemble(wrapper, label, select, description, errorEl);
}
