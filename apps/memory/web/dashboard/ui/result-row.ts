/**
 * apps/memory/web/dashboard/ui/result-row.ts
 *
 * 검색 결과 한 줄 버튼 컴포넌트.
 * compact 한 줄: 라벨 + (있으면) source 배지 + (있으면) score 칩.
 * 없는 배지·칩은 그리지 않는다.
 */

import { el } from "./dom.ts";
import type { CardView } from "./card-view.ts";
import {
  sourceBadge,
  markerBadge,
  scoreChip,
  eventTimeChip,
  kindBadge,
  displayGraphKindLabel,
  isSameDisplayGraphKind,
} from "./badges.ts";

export interface ResultRowHandlers {
  onPick: (nodeId: string) => void;
}

/**
 * CardView → button.rp-row 요소.
 * click 시 handlers.onPick(view.nodeId) 호출.
 */
export function resultRow(
  view: CardView,
  handlers: ResultRowHandlers,
): HTMLButtonElement {
  const btn = el("button", {
    className: "rp-row",
    dataset: { nodeId: view.nodeId },
    onClick: () => handlers.onPick(view.nodeId),
  }) as HTMLButtonElement;

  // 시간 배지 — 제목 앞(이벤트 날짜 있는 글만).
  if (view.eventAt != null) btn.append(eventTimeChip(view.eventAt, view.eventUntil));
  btn.append(el("span", { className: "rp-row__label" }, view.title));

  const sourceLabels = new Set<string>();
  const appendSource = (source: string): void => {
    if (isSameDisplayGraphKind(source, view.nodeType)) return;
    const label = displayGraphKindLabel(source);
    if (sourceLabels.has(label)) return;
    sourceLabels.add(label);
    btn.append(sourceBadge(source));
  };

  if (view.sourceType != null) appendSource(view.sourceType);
  if (view.sources != null) {
    for (const ch of view.sources) appendSource(ch);
  }
  if (view.markers?.supersedes === true) btn.append(markerBadge("supersedes"));
  if (view.markers?.superseded === true) btn.append(markerBadge("superseded"));
  // 종류 배지 — 점수 앞(분류된 종류 있는 글만·빈 문자열 제외).
  if (view.kind != null && view.kind.length > 0) btn.append(kindBadge(view.kind));
  if (view.score != null) btn.append(scoreChip(view.score));

  return btn;
}
