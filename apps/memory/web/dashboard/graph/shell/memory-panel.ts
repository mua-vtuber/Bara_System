/**
 * web/dashboard/graph/shell/memory-panel.ts
 * 좌측 부유 기억목록 패널의 DOM 골격(브랜드·상태줄·라벨·탭·목록·빈 상태).
 * 색·간격은 ui/tokens.css 토큰만, class 는 components.css 의 .memory-panel/.mp-* 어휘.
 * 인라인 색 0 — 레이아웃·class 만 여기서 조립한다(el 헬퍼 사용, React 아님).
 *
 * 공개 API(MemoryPanel):
 *   render(rows)            — 현재 탭의 목록 행을 다시 그린다.
 *   setSelected(nodeId|null)— 선택 항목에 selected 클래스를 켠다(색은 --list-selected-bg 토큰).
 *   setCounts(nodeCount, edgeCount) — 상태줄 노드·엣지 수 갱신.
 *   root                    — 좌측 셸에 붙일 element. 셸 래퍼(.left-shell)이며
 *                             그 안에 패널 본체(.memory-panel)와 접기 탭(.mp-toggle)을 담는다.
 *                             접으면 본체만 숨고 탭은 셸에 남아 다시 펼칠 진입점이 된다(§4).
 */
import { el } from "./dom.ts";
import { memoryNumberChip } from "../../ui/memory-number.ts";
import type {
  MemoryListItem,
  MemoryListRow,
  MemoryPanelTab,
} from "./memory-panel-data.ts";
import { countItems } from "./memory-panel-data.ts";

export interface MemoryPanelHandlers {
  /** 목록 항목 클릭 — 그래프 선택+모달 연동은 Stage 3 가 이 콜백에 배선한다. */
  onPick: (nodeId: string) => void;
  /** 탭 전환 — 호출부가 같은 VM 으로 다시 정렬해 render 한다. */
  onTab: (tab: MemoryPanelTab) => void;
}

export interface MemoryPanel {
  root: HTMLElement;
  render: (rows: MemoryListRow[]) => void;
  setSelected: (nodeId: string | null) => void;
  setCounts: (nodeCount: number, edgeCount: number) => void;
  setCollapsed: (collapsed: boolean) => void;
}

const TAB_DEFS: Array<{ id: MemoryPanelTab; label: string }> = [
  { id: "recent", label: "최근기억" },
  { id: "schedule", label: "일정" },
  { id: "accessed", label: "최근열람" },
];

/** 노드 종류를 짧은 한글 표기로 — 항목 보조 라벨용(없는 type 은 그대로 표시). */
function typeLabel(type: MemoryListItem["type"]): string {
  if (type === "memory") return "";
  if (type === "document") return "문서";
  if (type === "image") return "이미지";
  return String(type);
}

/** 목록 항목 한 줄(.mp-item) — 클릭 가능한 button. data-node-id 로 선택 색을 켠다. */
function renderItem(
  row: MemoryListItem,
  onPick: (nodeId: string) => void,
): HTMLElement {
  const typeText = row.badge ?? typeLabel(row.type);
  const typeEl =
    typeText.length > 0
      ? el("span", { className: "mp-item__type" }, typeText)
      : null;

  return el(
    "button",
    {
      type: "button",
      className: "mp-item",
      dataset: { nodeId: row.nodeId },
      title: row.label,
      onclick: () => onPick(row.nodeId),
    },
    el("span", { className: "mp-item__label" }, row.label),
    row.memoryId != null ? memoryNumberChip(row.memoryId) : null,
    typeEl,
    el("span", { className: "mp-stat" }, row.stat),
  );
}

/** "지난" 구분 행(.mp-divider) — 비클릭 헤더. */
function renderDivider(label: string): HTMLElement {
  return el("div", { className: "mp-divider" }, label);
}

/**
 * 패널을 만들어 반환한다. 초기 상태:
 *   상태줄 "노드 0 · 엣지 0", 목록 빈 상태("기억 없음"), 활성 탭은 최근기억.
 */
export function createMemoryPanel(
  handlers: MemoryPanelHandlers,
  options: { collapsed?: boolean } = {},
): MemoryPanel {
  let activeTab: MemoryPanelTab = "recent";
  let selectedId: string | null = null;

  // ── 브랜드 ─────────────────────────────────────────────────────────────────
  const brand = el(
    "div",
    { className: "mp-brand" },
    el("span", { className: "mp-brand__name" }, "Bara System"),
    el("span", { className: "mp-brand__sub" }, "MEMORY MODULE"),
  );

  // ── 상태줄 — 노드·엣지 수 ─────────────────────────────────────────────────
  const nodeCountEl = el("span", { className: "mp-status__count" }, "노드 0");
  const edgeCountEl = el("span", { className: "mp-status__count" }, "엣지 0");
  const status = el(
    "div",
    { className: "mp-status" },
    nodeCountEl,
    el("span", { className: "mp-status__sep" }, "·"),
    edgeCountEl,
  );

  // ── "기억 목록 N" 라벨 ─────────────────────────────────────────────────────
  const titleEl = el("div", { className: "mp-title" }, "기억 목록 0");

  // ── 탭 3개 ─────────────────────────────────────────────────────────────────
  const tabEls = new Map<MemoryPanelTab, HTMLElement>();
  const tabs = el(
    "div",
    { className: "mp-tabs" },
    ...TAB_DEFS.map((def) => {
      const tabEl = el(
        "button",
        {
          type: "button",
          className: def.id === activeTab ? "mp-tab on" : "mp-tab",
          dataset: { tab: def.id },
          onclick: () => {
            if (activeTab === def.id) return;
            activeTab = def.id;
            for (const [id, e] of tabEls) {
              e.className = id === activeTab ? "mp-tab on" : "mp-tab";
            }
            handlers.onTab(def.id);
          },
        },
        def.label,
      );
      tabEls.set(def.id, tabEl);
      return tabEl;
    }),
  );

  // ── 목록 본체 ──────────────────────────────────────────────────────────────
  const listBody = el("div", { className: "mp-list" });

  const head = el("div", { className: "mp-head" }, brand, status, titleEl, tabs);
  const panelBody = el("aside", { className: "memory-panel" }, head, listBody);

  // ── 접기 탭(.mp-toggle) — 셸 오른쪽 모서리에 세로 가운데로 튀어나온다(§4 Q4) ──
  // 토글은 패널 본체가 아니라 셸 래퍼(.left-shell)에 붙어, 본체가 숨어도 화면에 남는다.
  // 클릭하면 셸에 collapsed 를 토글하고 화살표를 ◀/▶ 로 뒤집는다.
  const toggleArrow = el("span", { className: "mp-toggle__arrow", "aria-hidden": "true" }, "◀");
  const toggleBtn = el(
    "button",
    {
      type: "button",
      className: "mp-toggle",
      onclick: () => setCollapsed(!root.classList.contains("collapsed")),
    },
    toggleArrow,
  );

  // 셸 래퍼 — 패널 본체 + 접기 탭을 함께 담는다. left-shell 이 position:absolute 라
  // (캔버스 위 오버레이) 그 자신이 토글의 containing block 이 되어, 토글의 right:-28px 가
  // 셸 오른쪽 모서리 기준이 된다(접힘 시엔 .collapsed .mp-toggle 가 left:0 으로 보정).
  const root = el("div", { className: "left-shell" }, panelBody, toggleBtn);

  function setCollapsed(collapsed: boolean): void {
    // 숨는 목록 안의 포커스만 회수한다. 화면 크기 변경 중 검색/입력 포커스는 유지한다.
    if (collapsed && panelBody.contains(document.activeElement)) toggleBtn.focus();
    root.classList.toggle("collapsed", collapsed);
    panelBody.toggleAttribute("inert", collapsed);
    panelBody.setAttribute("aria-hidden", String(collapsed));
    toggleArrow.textContent = collapsed ? "▶" : "◀";
    toggleBtn.setAttribute("aria-expanded", String(!collapsed));
    const label = collapsed ? "기억 목록 펼치기" : "기억 목록 접기";
    toggleBtn.setAttribute("aria-label", label);
    toggleBtn.title = label;
  }
  setCollapsed(options.collapsed ?? false);

  // ── 렌더 ───────────────────────────────────────────────────────────────────
  function render(rows: MemoryListRow[]): void {
    listBody.replaceChildren();
    const itemCount = countItems(rows);
    titleEl.textContent = `기억 목록 ${itemCount}`;

    if (itemCount === 0) {
      // 빈 상태 — 가짜 행을 만들지 않고 정직하게 "기억 없음"을 그린다(§6).
      listBody.appendChild(el("div", { className: "mp-empty" }, "기억 없음"));
      return;
    }

    for (const row of rows) {
      if (row.kind === "divider") {
        listBody.appendChild(renderDivider(row.label));
      } else {
        listBody.appendChild(renderItem(row, handlers.onPick));
      }
    }
    // 다시 그린 뒤 현재 선택 색을 복원한다(목록에 있으면).
    applySelectedClass();
  }

  // ── 선택 색(selected 클래스) ───────────────────────────────────────────────
  // 색 자체는 S3-A 의 --list-selected-bg 로 살아나지만, 켜고 끄는 단일 진입점은 지금 만든다.
  function applySelectedClass(): void {
    const items = Array.from(listBody.querySelectorAll<HTMLElement>(".mp-item"));
    for (const item of items) {
      const isSel = selectedId != null && item.dataset["nodeId"] === selectedId;
      item.classList.toggle("selected", isSel);
    }
  }

  function setSelected(nodeId: string | null): void {
    selectedId = nodeId;
    applySelectedClass();
  }

  // ── 상태줄 갱신 ────────────────────────────────────────────────────────────
  function setCounts(nodeCount: number, edgeCount: number): void {
    nodeCountEl.textContent = `노드 ${nodeCount}`;
    edgeCountEl.textContent = `엣지 ${edgeCount}`;
  }

  // 초기 빈 상태를 한 번 그린다(첫 loadOverview 전 흐름 유지·§6 로딩).
  render([]);

  return { root, render, setSelected, setCounts, setCollapsed };
}
