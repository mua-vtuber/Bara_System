/**
 * apps/memory/web/dashboard/ui/result-row.ts
 *
 * 검색 결과 한 줄 버튼 컴포넌트.
 * compact 한 줄: 라벨 + (있으면) source 배지. score 는 줄 툴팁(title)으로만 보인다.
 * 없는 배지·칩은 그리지 않는다.
 */

import { el } from "./dom.ts";
import { memoryNumberChip } from "./memory-number.ts";
import type { CardView } from "./card-view.ts";
import {
  sourceBadge,
  markerBadge,
  formatScore,
  eventTimeChip,
  kindBadge,
  displayGraphKindLabel,
  isSameDisplayGraphKind,
} from "./badges.ts";

const SCORE_TOOLTIP_PREFIX = "검색 점수";

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
  // 기억 번호 — 제목 뒤 작고 흐리게(정리 제안의 "기억 #N" 과 같은 번호).
  if (view.memoryId != null) btn.append(memoryNumberChip(view.memoryId));

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
  // 종류 배지 — 분류된 종류 있는 글만·빈 문자열 제외. 출처 배지와 같은 라벨이면
  // ("프로젝트" 채널로 찾은 "프로젝트" 종류 글) 한 번만 보인다.
  if (view.kind != null && view.kind.length > 0 &&
    !sourceLabels.has(displayGraphKindLabel(view.kind))) {
    btn.append(kindBadge(view.kind));
  }
  // 검색 점수 — 한 줄 목록에서는 제목 자리를 차지하지 않게 마우스를 올렸을 때만 보인다.
  // 점수와 구성 요소는 상세 화면에 그대로 남는다.
  if (view.score != null) btn.title = `${SCORE_TOOLTIP_PREFIX} ${formatScore(view.score)}`;

  return btn;
}
