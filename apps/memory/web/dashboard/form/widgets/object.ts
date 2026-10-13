/**
 * Object 위젯 (Phase 5.5.2 / spec section 5.1) — 중첩 그룹 (접기 가능).
 *
 * 본 위젯은 *컨테이너만 제공* — 자식 필드 렌더링은 form-renderer (S5) 의
 * 재귀 처리가 담당. 접기/펼치기는 native `details/summary` 요소로.
 */

import {
  createDescription,
  createErrorContainer,
  createFieldWrapper,
  createLabel,
  shouldShowDescription,
} from "./helpers";
import type { WidgetContext } from "./widget";

export interface ObjectWidgetExtras {
  /** 자식 필드 렌더링 — form-renderer 가 본 콜백을 넘김. */
  renderChildren: (parent: HTMLElement) => void;
  /** details 의 초기 open 상태 — 디폴트 = true (펼쳐서 시작). */
  openByDefault?: boolean;
}

export function renderObjectWidget(
  ctx: WidgetContext,
  extras: ObjectWidgetExtras,
): HTMLElement {
  const wrapper = createFieldWrapper();
  wrapper.dataset.widget = "object";
  wrapper.dataset.path = ctx.path;

  const details = document.createElement("details");
  details.className = "form-object";
  if (extras.openByDefault !== false) details.open = true;

  const summary = document.createElement("summary");
  summary.className = "form-object-summary";
  summary.appendChild(createLabel(ctx.key, ctx.schema, ctx.required ?? false));
  details.appendChild(summary);

  const childContainer = document.createElement("div");
  childContainer.className = "form-object-children";
  extras.renderChildren(childContainer);
  details.appendChild(childContainer);

  wrapper.appendChild(details);
  if (shouldShowDescription(ctx.schema) && ctx.schema.description) {
    wrapper.appendChild(createDescription(ctx.schema.description));
  }
  wrapper.appendChild(createErrorContainer());
  return wrapper;
}
