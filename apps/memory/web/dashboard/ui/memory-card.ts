/**
 * apps/memory/web/dashboard/ui/memory-card.ts
 *
 * CardView 를 받아 카드 HTML 요소를 만든다.
 * mode 로 밀도를 조절한다: top3 / list / detail / hover.
 * 없는 칸은 요소 자체를 만들지 않는다.
 */

import { el } from "./dom.ts";
import type { CardView } from "./card-view.ts";
import {
  sourceBadge,
  markerBadge,
  scoreChip,
  tagChip,
  eventTimeChip,
  kindBadge,
  componentChips,
  scheduleLineText,
  displayGraphKindLabel,
  isSameDisplayGraphKind,
} from "./badges.ts";

type CardMode = "top3" | "list" | "detail" | "hover";

const MARKER_KEYS = ["important", "uncertain", "supersedes", "superseded"] as const;
type MarkerKey = (typeof MARKER_KEYS)[number];

/** markers 에서 true 인 항목만 배지 배열로 반환한다. */
function activeMarkerBadges(markers: CardView["markers"]): HTMLElement[] {
  if (markers == null) return [];
  return MARKER_KEYS.filter((k): boolean => markers[k as MarkerKey] === true).map(
    (k) => markerBadge(k as MarkerKey),
  );
}

/** badges 줄(.card__badges) — sourceType·sources·markers·score 를 한 줄에 담는다. 전부 없으면 null. */
function buildBadgesRow(view: CardView): HTMLElement | null {
  const items: HTMLElement[] = [];
  const sourceLabels = new Set<string>();

  function addSource(source: string): void {
    if (isSameDisplayGraphKind(source, view.nodeType)) return;
    const label = displayGraphKindLabel(source);
    if (sourceLabels.has(label)) return;
    sourceLabels.add(label);
    items.push(sourceBadge(source));
  }

  if (view.sourceType != null) addSource(view.sourceType);
  if (view.sources != null) {
    for (const ch of view.sources) addSource(ch);
  }
  items.push(...activeMarkerBadges(view.markers));
  if (view.score != null) items.push(scoreChip(view.score));

  if (items.length === 0) return null;
  return el("div", { className: "card__badges" }, ...items);
}

function buildKickerRow(view: CardView): HTMLElement | null {
  const items: HTMLElement[] = [];
  if (view.eventAt != null) items.push(eventTimeChip(view.eventAt, view.eventUntil));
  if (view.kind != null && view.kind.length > 0) items.push(kindBadge(view.kind));
  if (view.nodeType != null && view.nodeType.length > 0) {
    items.push(el("span", { className: "chip card__node-type" }, displayGraphKindLabel(view.nodeType)));
  }
  if (items.length === 0) return null;
  return el("div", { className: "card__kicker" }, ...items);
}

function buildComponentsRow(view: CardView): HTMLElement | null {
  const chips = componentChips(view.components);
  if (chips.length === 0) return null;
  return el(
    "div",
    { className: "card__components", title: "검색 점수 구성" },
    el("span", { className: "card__components-label" }, "점수 근거"),
    ...chips,
  );
}

function buildMatchRow(view: CardView): HTMLElement | null {
  if (view.matchReason == null || view.matchReason.length === 0) return null;
  return el(
    "div",
    { className: "card__match" },
    ...view.matchReason.slice(0, 2).map((reason) => el("span", {}, reason)),
  );
}

/**
 * CardView → 카드 HTML 요소.
 *
 * - top3 / list : title + snippet(있으면) + badges(있으면)
 * - detail      : 위 + tags(있으면) + date(있으면)
 * - hover       : 종류 줄(있으면) + 본문. snippet 이 없을 때만 title 로 대체한다.
 */
export function memoryCard(view: CardView, mode: CardMode): HTMLElement {
  const card = el("div", { className: `card card--${mode}` });

  if (mode === "hover") {
    const kicker = buildKickerRow(view);
    if (kicker != null) card.append(kicker);
    card.append(el("div", { className: "card__snippet" }, view.snippet ?? view.title));
    return card;
  }

  const kicker = buildKickerRow(view);
  if (kicker != null) card.append(kicker);

  // title — 항상
  card.append(el("div", { className: "card__title" }, view.title));

  // snippet — 있으면
  if (view.snippet != null) {
    card.append(el("div", { className: "card__snippet" }, view.snippet));
  }

  // badges 줄 — 있는 항목만 담아 null 아닌 경우에만 추가
  const badgesRow = buildBadgesRow(view);
  if (badgesRow != null) card.append(badgesRow);

  const componentsRow = buildComponentsRow(view);
  if (componentsRow != null) card.append(componentsRow);

  const matchRow = buildMatchRow(view);
  if (matchRow != null) card.append(matchRow);

  // detail 전용: tags, 일정, date
  if (mode === "detail") {
    if (view.tags != null && view.tags.length > 0) {
      const tagRow = el("div", { className: "card__tags" }, ...view.tags.map(tagChip));
      card.append(tagRow);
    }
    // 일정 — eventAt 있으면 '일정: 시작 → 종료'(종료 없으면 시작만). date 줄 앞.
    if (view.eventAt != null) {
      const text = scheduleLineText(view.eventAt, view.eventUntil);
      card.append(el("div", { className: "card__schedule" }, text));
    }
    if (view.date != null) {
      card.append(el("div", { className: "card__date" }, view.date));
    }
  }

  return card;
}
