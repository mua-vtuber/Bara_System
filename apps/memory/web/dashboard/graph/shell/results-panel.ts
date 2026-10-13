/**
 * web/dashboard/graph/shell/results-panel.ts
 * 우측 검색 결과 패널.
 * CardView 목록을 resultRow 공유 컴포넌트로 나열하고 클릭 시 그래프 포커스로 연결한다.
 */
import { el } from "./dom.ts";
import { resultRow } from "../../ui/result-row.ts";
import type { CardView } from "../../ui/card-view.ts";
import type { ResultSortMode } from "./search/results-panel-sort.ts";

/** @deprecated ResultRow 는 내부 전용이었다. 외부는 CardView 를 사용한다. */
export interface ResultRow {
  nodeId: string;
  label: string;
  score?: number;
}

export interface ResultsPanelHandlers {
  onPick: (nodeId: string) => void;
  /** 현재 활성 정렬 모드. 미전달이면 "relevance"(관련순)·토글이 그 모드로 active. */
  sortMode?: ResultSortMode;
  /** true 면 검색 직후 행들이 아래에서 위로 한 줄씩 나타난다. */
  revealRows?: boolean;
  /**
   * 정렬 토글 클릭 콜백. 없으면 토글 자체를 헤더에 그리지 않는다 —
   * 기존 2-키 호출 renderResultsPanel(views, { onPick }) 은 토글 미표시로 회귀 0.
   * 재정렬·재렌더는 호출부 책임(이 컴포넌트는 콜백만 발화·applyResultsPanelSelection 정신).
   */
  onSortChange?: (mode: ResultSortMode) => void;
}

/** 정렬 토글 라벨 — 문구 단일 출처(하드코딩 0). 결정 5 의 세 정렬 그대로. */
const SORT_LABELS: ReadonlyArray<{ mode: ResultSortMode; label: string }> = [
  { mode: "relevance", label: "관련순" },
  { mode: "recent", label: "최신등록순" },
  { mode: "event", label: "빠른일정순" },
];

/**
 * 우측 결과 패널을 만들어 반환한다.
 * - 각 행: resultRow(view, {onPick}) 공유 컴포넌트.
 * - 결과 0건이면 빈 안내 문구를 정직하게 노출한다(가짜 행 0).
 */
export function renderResultsPanel(
  views: CardView[],
  handlers: ResultsPanelHandlers,
): HTMLElement {
  const activeSort: ResultSortMode = handlers.sortMode ?? "relevance";

  const titleEl = el(
    "span",
    {
      className: "rp-title",
      style: [
        "font-size:var(--fs-xs)",
        "color:var(--text-dim)",
        "text-transform:uppercase",
        "letter-spacing:0.06em",
        "font-family:var(--mono)",
      ].join(";"),
    },
    "검색 결과",
  );

  const headerChildren: HTMLElement[] = [titleEl];

  // 정렬 토글 — onSortChange 가 있을 때만 헤더에 그린다(기존 2-키 호출은 미표시·회귀 0).
  // 정렬은 검색 결과(hitViews)에만 붙는다 — 계산 결과 패널은 renderResultsPanel 을 거치지
  // 않으므로(graph-entry showComputeResult 가 자체 헤더로 그림) 토글이 섞이지 않는다.
  if (handlers.onSortChange) {
    const onSortChange = handlers.onSortChange;
    const sortRow = el("div", { className: "rp-sort", dataset: { rp: "sort" } });
    for (const { mode, label } of SORT_LABELS) {
      const btn = el(
        "button",
        {
          type: "button",
          className: mode === activeSort ? "rp-sort-toggle active" : "rp-sort-toggle",
          dataset: { rpSort: mode },
        },
        label,
      );
      btn.addEventListener("click", () => onSortChange(mode));
      sortRow.appendChild(btn);
    }
    headerChildren.push(sortRow);
  }

  const header = el(
    "div",
    {
      className: "rp-header",
      style: [
        "display:flex",
        "align-items:center",
        "flex-wrap:wrap",
        "gap:6px",
        "padding:8px 10px 6px",
        "border-bottom:1px solid var(--border)",
        "flex-shrink:0",
      ].join(";"),
    },
    ...headerChildren,
  );

  let bodyContent: HTMLElement;
  if (views.length === 0) {
    bodyContent = el(
      "div",
      {
        dataset: { rp: "empty" },
        style: [
          "padding:20px 12px",
          "color:var(--text-dim)",
          "font-size:var(--fs-sm)",
          "text-align:center",
        ].join(";"),
      },
      "결과 없음",
    );
  } else {
    const rows = views.map((view, index) => {
      const row = resultRow(view, { onPick: handlers.onPick });
      if (handlers.revealRows === true) {
        row.classList.add("rp-row--reveal");
        row.style.setProperty("--rp-row-delay", `${Math.min(index * 42, 720)}ms`);
      }
      return row;
    });
    bodyContent = el(
      "div",
      { className: handlers.revealRows === true ? "rp-list rp-list--reveal" : "rp-list" },
      ...rows,
    );
  }

  const body = el(
    "div",
    {
      className: "rp-body",
      style: [
        "flex:1",
        "overflow-y:auto",
        "overflow-x:hidden",
      ].join(";"),
    },
    bodyContent,
  );

  // 위치·폭·표면 스타일은 components.css `.results-panel` 규칙이 단일 출처로 가진다
  // (그래프 위 absolute 오버레이). 여기서는 클래스만 단다.
  return el(
    "aside",
    {
      className: "results-panel",
    },
    header,
    body,
  );
}

/** 검색 요청이 진행 중일 때 우측 결과 패널 자리에 띄우는 로딩 상태. */
export function renderResultsLoadingPanel(): HTMLElement {
  const header = el(
    "div",
    {
      className: "rp-header",
      style: [
        "display:flex",
        "align-items:center",
        "gap:6px",
        "padding:8px 10px 6px",
        "border-bottom:1px solid var(--border)",
        "flex-shrink:0",
      ].join(";"),
    },
    el("span", { className: "rp-title" }, "검색 결과"),
  );
  const body = el(
    "div",
    {
      className: "rp-body rp-body--loading",
      role: "status",
      "aria-live": "polite",
    },
    el("span", { className: "dash-square-loader dash-square-loader--lg", "aria-hidden": "true" }),
    el("span", { className: "rp-loading__text" }, "검색 중"),
  );
  return el("aside", { className: "results-panel" }, header, body);
}

/**
 * 우측 패널 안의 결과 행(.rp-row)에 선택 색(.selected)을 입힌다 — 좌측 memory-panel 의
 * applySelectedClass 와 같은 패턴. data-node-id 가 nodeId 와 일치하는 행 하나만 켜고
 * 나머지는 끈다. nodeId 가 null 이면 전부 끈다(선택 해제). 색 토큰만 바뀔 뿐 콜백을
 * 발화하지 않으므로 좌측과 같은 selectedNodeId 단일 출처를 공유해도 되울림이 없다.
 *
 * panelEl 이 없거나(아직 부착 전) 우측이 숨김(.rp-hidden)이어도 무해하다 — 일치하는
 * 행이 없으면 아무 행도 켜지지 않아 no-op 이 된다.
 */
export function applyResultsPanelSelection(
  panelEl: HTMLElement | null,
  nodeId: string | null,
): void {
  if (!panelEl) return;
  const rows = panelEl.querySelectorAll<HTMLElement>(".rp-row");
  for (const row of rows) {
    const isSel = nodeId != null && row.dataset["nodeId"] === nodeId;
    row.classList.toggle("selected", isSel);
  }
}
