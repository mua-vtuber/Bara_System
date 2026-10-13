/**
 * Array 위젯 (Phase 5.5.2 / spec section 5.1) — 반복 행 추가/삭제.
 *
 * 본 위젯은 *문자열 / 숫자 배열만 직접 렌더링*. 객체 배열은 본 시점에서
 * *각 행을 단순 input 으로* 처리 — 객체 형태는 form-renderer (S5) 의
 * 재귀 처리에 위임한다.
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

export function renderArrayWidget(ctx: WidgetContext): HTMLElement {
  const wrapper = createFieldWrapper();
  wrapper.dataset.widget = "array";
  wrapper.dataset.path = ctx.path;

  const label = createLabel(ctx.key, ctx.schema, ctx.required ?? false);
  const list = document.createElement("ul");
  list.className = "form-array";

  const items: unknown[] = Array.isArray(ctx.value) ? [...ctx.value] : [];
  const itemType = ctx.schema.items?.type ?? "string";

  function emit(): void {
    ctx.onChange(ctx.path, [...items]);
  }

  function renderRow(index: number): HTMLElement {
    const row = document.createElement("li");
    row.className = "form-array-row";
    row.dataset.index = String(index);

    const input = document.createElement("input");
    input.type = itemType === "number" || itemType === "integer" ? "number" : "text";
    input.className = "form-input";
    input.value = items[index] === undefined ? "" : String(items[index]);
    input.addEventListener("input", () => {
      const raw = input.value;
      items[index] =
        itemType === "number" || itemType === "integer"
          ? raw === ""
            ? undefined
            : Number(raw)
          : raw;
      emit();
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "form-array-remove";
    removeBtn.textContent = "삭제";
    removeBtn.addEventListener("click", () => {
      items.splice(index, 1);
      rebuild();
      emit();
    });

    row.appendChild(input);
    row.appendChild(removeBtn);
    return row;
  }

  function rebuild(): void {
    list.innerHTML = "";
    items.forEach((_, i) => list.appendChild(renderRow(i)));
  }

  rebuild();

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "form-array-add";
  addBtn.textContent = "추가";
  addBtn.addEventListener("click", () => {
    items.push(itemType === "number" || itemType === "integer" ? 0 : "");
    rebuild();
    emit();
  });

  const inner = document.createElement("div");
  inner.appendChild(list);
  inner.appendChild(addBtn);

  const description = shouldShowDescription(ctx.schema) && ctx.schema.description
    ? createDescription(ctx.schema.description)
    : undefined;
  const errorEl = createErrorContainer();
  return assemble(wrapper, label, inner, description, errorEl);
}
