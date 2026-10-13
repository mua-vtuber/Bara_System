/**
 * web/dashboard/graph/shell/search/results-panel-sort.ts
 * CardView 전용 결과 정렬(함정 B). memory-panel-data.ts 정렬 함수는 GraphNode 를 받고
 * lastAccessedAt 등 CardView 에 없는 칸을 써 재사용 못 한다(spec §3.3·§8).
 * 세 모드: 관련순(입력 순서 유지)·최신등록순(date 내림)·빠른일정순(eventAt 오름·없는 글 맨 뒤·필터링 안 함).
 */
import type { CardView } from "../../../ui/card-view.ts";

export type ResultSortMode = "relevance" | "recent" | "event";

/** ISO 시각 → ms. 없거나 깨지면 null(정렬에서 뒤로·가짜 0 안 채움). */
function parseTime(iso: string | undefined): number | null {
  if (iso == null || iso.length === 0) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** nodeId 비교 — 동률 안정 정렬 보조 키. */
function compareId(a: CardView, b: CardView): number {
  if (a.nodeId < b.nodeId) return -1;
  if (a.nodeId > b.nodeId) return 1;
  return 0;
}

/** 원본 불변. mode 별 새 배열 반환. */
export function sortCardViews(views: CardView[], mode: ResultSortMode): CardView[] {
  if (mode === "relevance") return [...views]; // 입력 순서 유지(서버 점수순)

  if (mode === "recent") {
    return [...views].sort((a, b) => {
      const ta = parseTime(a.date);
      const tb = parseTime(b.date);
      if (ta == null && tb == null) return compareId(a, b);
      if (ta == null) return 1; // a 뒤로
      if (tb == null) return -1; // b 뒤로
      if (tb !== ta) return tb - ta; // 최신 위(내림차순)
      return compareId(a, b);
    });
  }

  // event — eventAt 오름차순(가까운 미래 위). 없는 글은 맨 뒤로(제외하지 않음·결정 5).
  return [...views].sort((a, b) => {
    const ea = parseTime(a.eventAt);
    const eb = parseTime(b.eventAt);
    if (ea == null && eb == null) return compareId(a, b);
    if (ea == null) return 1; // a 뒤로(목록엔 남음)
    if (eb == null) return -1; // b 뒤로
    if (ea !== eb) return ea - eb; // 가까운 미래 위(오름차순)
    return compareId(a, b);
  });
}
