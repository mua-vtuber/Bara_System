import { initTheme } from "./ui/theme-switch.ts";
initTheme();

import { mountIngestForm } from "./ingest-form.js";
import { renderNavRail, type NavRailItem } from "./nav-rail.ts";
import { el } from "./ui/dom.ts";
import { resultRow } from "./ui/result-row.ts";
import { memoryNumberFromNodeKey, parseMemoryNumberQuery } from "./ui/memory-number.ts";
import { memoryInfoFromMemory } from "./ui/memory-info.ts";
import { nodeDetail, skipNodeDetailTypewriter } from "./ui/node-detail.ts";
import { buildEditControls } from "./graph/shell/node-window-view.ts";
import { showToast } from "./form/toast.ts";
import type { CardView, ImagePreview } from "./ui/card-view.ts";
import { fromGraphNode, fromSearchHit } from "./ui/card-view.ts";
import { createEntityTypeFieldPicker } from "./graph/shell/entity-type-field-picker.ts";
import { renderSearchModal } from "./graph/shell/search/search-modal.ts";
import type { SearchModalSearchPayload } from "./graph/shell/search/search-modal.ts";
import { mountComputePanel } from "./graph/shell/search/compute-panel.ts";
import { renderMiniGraph } from "./home/mini-graph.ts";
import {
  getDateOccurrences,
  getGraphOverview,
  getLatest,
  getMemoryDetail,
  editMemory,
  getStats,
  listCleanupProposals,
  searchMemories,
} from "./home/dashboard-api.ts";
import { detailTrashControl } from "./home/detail-trash-control.ts";
import { removeTrashedFromSearch } from "./home/search-result-filter.ts";
import { memoryIdFromSearch, pageFromLocation } from "./home/memory-link.ts";
import { renderArchiveList } from "./home/archive-list.ts";
import { renderCleanupProposal } from "./home/cleanup-proposal.ts";
import { createAutoRegisterPanel, type AutoRegisterPanel } from "./home/auto-register-panel.ts";
import { ENTITY_REGISTER_STRINGS } from "./home/entity-register-strings.ts";
import type {
  DashboardPage,
  DashboardSelection,
  DashboardSearchOptions,
  DashboardStats,
  DateOccurrence,
  DateOccurrencesResponse,
  GraphOverviewResponse,
  MemoriesResponse,
  MemorySummary,
  SearchResponse,
  SearchResult,
  SelectionSource,
} from "./home/types.ts";
import type { GraphNode } from "./graph/graph-view-model.ts";

const root = document.getElementById("dashboard-root");
const navHost = document.getElementById("app-nav-rail");
if (!root) throw new Error("dashboard-root not found");

interface DashboardDom {
  autoRegister: AutoRegisterPanel;
  status: HTMLElement;
  searchInput: HTMLInputElement;
  searchClear: HTMLButtonElement;
  listTitle: HTMLElement;
  memoryList: HTMLElement;
  scheduleList: HTMLElement;
  detail: HTMLElement;
  graph: HTMLElement;
  ingest: HTMLElement;
  mainPage: HTMLElement;
  archivePage: HTMLElement;
  proposalsPage: HTMLElement;
  archiveList: HTMLElement;
  proposalsList: HTMLElement;
}

type DashboardComputeState =
  | { kind: "result"; nodes: HTMLElement[] }
  | { kind: "error"; message: string };

interface DashboardState {
  page: DashboardPage;
  stats: DashboardStats | null;
  latest: MemorySummary[];
  search: SearchResponse | null;
  searchFeedback: { kind: "loading" } | { kind: "error"; message: string } | null;
  compute: DashboardComputeState | null;
  schedule: DateOccurrencesResponse | null;
  graph: GraphOverviewResponse | null;
  newGraphNodeIds: Set<string>;
  selected: DashboardSelection;
  detailRequestId: number;
  searchRequestId: number;
  skipDetailAnimationForNodeId: string | null;
}

const state: DashboardState = {
  page: "main",
  stats: null,
  latest: [],
  search: null,
  searchFeedback: null,
  compute: null,
  schedule: null,
  graph: null,
  newGraphNodeIds: new Set(),
  selected: { kind: "none" },
  detailRequestId: 0,
  searchRequestId: 0,
  skipDetailAnimationForNodeId: null,
};

const dom = buildShell();
root.replaceChildren(dom.mainPage, dom.archivePage, dom.proposalsPage);

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function nodeIdForMemory(id: number): string {
  return `node:${id}`;
}

function memoryIdFromNodeId(nodeId: string): number | null {
  const raw = nodeId.startsWith("node:") ? nodeId.slice("node:".length) : nodeId;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function compactText(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

function titleFromContent(content: string): string {
  const first = content.split("\n").find((line) => line.trim().length > 0)?.trim();
  if (!first) return "제목 없는 메모리";
  return compactText(first, 52);
}

const MARKDOWN_SOURCE_TYPES = new Set(["document", "document_section", "document_chunk"]);

function shouldRenderAsMarkdown(memory: MemorySummary): boolean {
  const source = memory.sourceType ?? memory.memoryType;
  return source != null && MARKDOWN_SOURCE_TYPES.has(source);
}

function stringMetadataValue(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberMetadataValue(metadata: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function imagesFromMemory(memory: MemorySummary): ImagePreview[] | undefined {
  const images: ImagePreview[] = [];
  const ownAssetSha = stringMetadataValue(memory.metadata, "asset_sha256");
  if ((memory.sourceType ?? memory.memoryType) === "image_asset" && ownAssetSha) {
    images.push({
      nodeId: memory.id,
      assetSha256: ownAssetSha,
      thumbSha256: stringMetadataValue(memory.metadata, "thumb_sha256"),
      width: numberMetadataValue(memory.metadata, "width"),
      height: numberMetadataValue(memory.metadata, "height"),
      mime: stringMetadataValue(memory.metadata, "mime"),
      alt: titleFromContent(memory.content),
    });
  }
  for (const image of memory.imageAttachments ?? []) {
    images.push({
      nodeId: image.nodeId,
      assetSha256: image.assetSha256,
      thumbSha256: image.thumbSha256,
      width: image.width,
      height: image.height,
      mime: image.mime,
      alt: image.originalName ?? titleFromContent(image.content),
    });
  }
  return images.length > 0 ? images : undefined;
}

function memoryToCardView(memory: MemorySummary, score?: number): CardView {
  const renderMarkdown = shouldRenderAsMarkdown(memory);
  return {
    nodeId: nodeIdForMemory(memory.id),
    memoryId: memory.id,
    title: titleFromContent(memory.content),
    snippet: renderMarkdown ? memory.content : compactText(memory.content, 420),
    nodeType: memory.sourceType ?? memory.memoryType ?? "memory",
    sourceType: memory.sourceType ?? memory.memoryType,
    score,
    date: memory.createdAt,
    eventAt: memory.eventAt ?? undefined,
    eventUntil: memory.eventUntil ?? undefined,
    kind: memory.kind ?? undefined,
    renderMode: renderMarkdown ? "markdown" : undefined,
    images: imagesFromMemory(memory),
    info: memoryInfoFromMemory(memory),
    markers: {
      important: typeof memory.importance === "number" && memory.importance >= 0.8,
      uncertain: typeof memory.confidence === "number" && memory.confidence < 0.6,
    },
  };
}

function searchToCardView(result: SearchResult): CardView {
  return {
    ...fromSearchHit(result),
    nodeId: nodeIdForMemory(result.id),
    renderMode: shouldRenderAsMarkdown(result) ? "markdown" : undefined,
  };
}

function occurrenceToCardView(occ: DateOccurrence): CardView {
  return {
    nodeId: occ.target.nodeId,
    memoryId: memoryNumberFromNodeKey(occ.target.nodeId),
    title: occ.title || occ.target.label,
    snippet: [occ.dateTime ?? occ.date, occ.originalDateText].filter(Boolean).join(" · "),
    nodeType: occ.target.type,
    sourceType: occ.kind,
    date: occ.date,
    eventAt: occ.dateTime ?? occ.date,
    eventUntil: occ.endDateTime,
    tags: [occ.role, occ.columnKey].filter((v): v is string => typeof v === "string"),
  };
}

function buildShell(): DashboardDom {
  const searchPicker = createEntityTypeFieldPicker({ apiBase: "", mode: "search" });
  void searchPicker.load().catch((err: unknown) => {
    console.error("[dashboard] 검색 종류 목록 로드 오류:", err);
    searchPicker.showLoadError(
      `종류 목록을 불러오지 못했습니다: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  const searchModal = renderSearchModal({
    picker: searchPicker,
    onSearch: (payload) => {
      void runSearch(payload);
    },
    onCompute: () => {
      state.searchRequestId += 1;
      state.searchFeedback = null;
      // 계산 버튼과 API 호출은 compute-panel 이 computeSlot 안에서 처리한다.
    },
  });
  searchModal.root.classList.add("dash-search-modal");
  searchModal.root.setAttribute("role", "search");
  const searchInputEl = searchModal.root.querySelector<HTMLInputElement>('input[type="search"]');
  if (!searchInputEl) throw new Error("dashboard search input not found");
  const searchInput = searchInputEl;
  searchInput.id = "dashboard-search";
  searchInput.placeholder = "찾을 기억을 입력하세요 (#번호로 바로 열기)";

  const searchClear = el("button", {
    className: "dash-icon-button",
    type: "button",
    title: "검색 초기화",
    "aria-label": "검색 초기화",
  }, "×") as HTMLButtonElement;
  searchModal.root.querySelector<HTMLElement>(".so-input-row")?.append(searchClear);

  mountComputePanel({
    slot: searchModal.computeSlot,
    picker: searchPicker,
    apiBase: "",
    getPeriod: () => searchModal.getPeriod(),
    getQueryText: () => searchModal.getQueryText(),
    onResult: (nodes) => {
      state.searchRequestId += 1;
      state.searchFeedback = null;
      state.compute = { kind: "result", nodes };
      state.search = null;
      if (state.selected.kind === "memory" && state.selected.source === "search") {
        state.selected = { kind: "none" };
      }
      renderAll();
    },
    onError: (message) => {
      state.searchRequestId += 1;
      state.searchFeedback = null;
      state.compute = { kind: "error", message };
      state.search = null;
      renderAll();
    },
  });

  const status = el("div", { className: "dash-status" }, "대시보드 로딩 중...");
  const listTitle = el("h2", {}, "목록");
  const memoryList = panelList("목록");
  const scheduleList = panelList("일정");
  const detail = el("div", { className: "dash-detail" }, emptyState("항목을 선택하면 내용이 표시됩니다."));
  detail.addEventListener("pointerdown", () => {
    skipNodeDetailTypewriter(detail);
  });
  const graph = el("div", { className: "mini-graph" });
  const autoRegister = createAutoRegisterPanel({ onChanged: () => renderAll() });
  const ingest = el("div", { id: "ingest-mount", className: "dash-ingest" });

  const graphExpand = el("a", {
    className: "au-btn au-btn--ghost au-btn--small dash-graph-expand",
    href: "/web/graph.html",
    title: "그래프 전체화면",
  }, "전체화면");

  const mainPage = el(
    "section",
    { className: "dash-page dash-page--main" },
    el(
      "div",
      { className: "dash-topbar" },
      el("div", { className: "dash-brand" },
        el("div", {}, el("h1", {}, "바라 메모리"), el("span", {}, "dashboard")),
        el("button", {
          className: "au-btn au-btn--ghost au-btn--small dash-new-memory",
          type: "button",
          onClick: () => {
            const input = ingest.querySelector<HTMLTextAreaElement>("textarea");
            input?.scrollIntoView({ block: "center", behavior: "auto" });
            input?.focus({ preventScroll: true });
          },
        }, "메모 쓰기")),
      searchModal.root,
      status,
    ),
    el(
      "div",
      { className: "dash-grid" },
      el("section", { className: "dash-panel dash-panel--input" }, panelHeader("새 메모"), ingest),
      el("section", { className: "dash-panel dash-panel--list" }, panelHeader(listTitle), memoryList),
      el("section", { className: "dash-panel dash-panel--detail" }, panelHeader("내용보기"), detail),
      el("section", { className: "dash-panel dash-panel--schedule" }, panelHeader("일정목록"), scheduleList),
      el("section", { className: "dash-panel dash-panel--autoreg" }, panelHeader(ENTITY_REGISTER_STRINGS.panelTitle), autoRegister.root),
      el("section", { className: "dash-panel dash-panel--graph" }, graph, graphExpand),
    ),
  );

  const archiveList = el("div", { className: "dash-secondary-list" }, loadingState("휴지통 로딩 중..."));
  const archivePage = secondaryPage(
    "archive",
    "휴지통",
    "삭제한 기억을 확인하고 복구할 수 있습니다. 보관 기간이 지나면 영구 삭제됩니다.",
    archiveList,
  );

  const proposalsList = el("div", { className: "dash-secondary-list" }, loadingState("정리 제안 로딩 중..."));
  const proposalsPage = secondaryPage(
    "proposals",
    "정리 제안",
    "AI가 제안한 변경 내용을 확인하고, 적용할 내용을 직접 선택하세요.",
    proposalsList,
  );

  function clearSearchSurface(): void {
    state.searchRequestId += 1;
    state.searchFeedback = null;
    searchInput.value = "";
    state.search = null;
    state.compute = null;
    if (state.selected.kind === "memory" && state.selected.source === "search") {
      state.detailRequestId += 1;
      state.selected = { kind: "none" };
    }
    renderAll();
    searchInput.focus();
  }

  searchClear.addEventListener("click", clearSearchSurface);
  searchInput.addEventListener("search", () => {
    if (searchInput.value.trim().length === 0) clearSearchSurface();
  });
  searchInput.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" && searchInput.value.trim().length === 0) {
      clearSearchSurface();
    }
  });

  mountIngestForm({
    mountEl: ingest,
    apiBase: "",
    escapeHtml,
    el,
    onIngested: () => void refreshAfterIngest(),
  });

  return {
    status,
    searchInput,
    searchClear,
    listTitle,
    memoryList,
    scheduleList,
    detail,
    graph,
    autoRegister,
    ingest,
    mainPage,
    archivePage,
    proposalsPage,
    archiveList,
    proposalsList,
  };
}

function panelHeader(title: string | HTMLElement): HTMLElement {
  return el(
    "header",
    { className: "dash-panel__header" },
    typeof title === "string" ? el("h2", {}, title) : title,
  );
}

function panelList(label: string): HTMLElement {
  return el("div", { className: "dash-list", role: "list", "aria-label": label });
}

function secondaryPage(kind: DashboardPage, title: string, hint: string, content: HTMLElement): HTMLElement {
  return el(
    "section",
    { className: "dash-page dash-page--secondary", dataset: { page: kind }, hidden: "true" },
    el(
      "div",
      { className: "dash-secondary-head" },
      el("div", {}, el("h1", {}, title), el("p", {}, hint)),
      el("a", { className: "au-btn au-btn--ghost au-btn--small", href: "/web/dashboard.html" }, "대시보드"),
    ),
    content,
  );
}

function renderNav(): void {
  const current: NavRailItem =
    state.page === "archive" ? "archive" :
    state.page === "proposals" ? "proposals" :
    "dashboard";
  navHost?.replaceChildren(renderNavRail(current));
}

function renderPage(): void {
  dom.mainPage.hidden = state.page !== "main";
  dom.archivePage.hidden = state.page !== "archive";
  dom.proposalsPage.hidden = state.page !== "proposals";
  renderNav();
}

function pageFromHash(): DashboardPage {
  return pageFromLocation(location.search, location.hash);
}

/** 자동 정리 칸이 지금 화면에 나와 있는가 — 숨겨졌다가 다시 보일 때만 그 칸을 새로 읽는다. */
let autoRegisterVisible = false;

async function switchPage(page: DashboardPage): Promise<void> {
  state.page = page;
  renderPage();
  // 자동 정리 칸은 처음 열 때와 다시 보일 때만 읽는다(그 뒤는 칸이 자기 동작 — 정리 끝·되돌리기 — 뒤에 스스로
  // 읽는다). renderAll 마다 읽으면 메모를 누를 때마다 요청이 나가고, 되돌리기 실패 문구가 지워진다.
  const autoRegisterNowVisible = page === "main";
  if (autoRegisterNowVisible && !autoRegisterVisible) void dom.autoRegister.refresh();
  autoRegisterVisible = autoRegisterNowVisible;
  if (page === "archive") await renderArchive();
  if (page === "proposals") await renderProposals();
}

function renderStatus(): void {
  const stats = state.stats;
  const chips = [
    ["메모리", stats?.totalMemories],
    ["7일", stats?.memoriesLast7Days],
    ["관계", stats?.totalEdges],
  ];
  dom.status.replaceChildren(
    ...chips.map(([label, value]) =>
      el("span", { className: "dash-status__chip" }, `${label} `, el("strong", {}, value ?? "—")),
    ),
  );
}

function setListState(host: HTMLElement, node: HTMLElement): void {
  host.replaceChildren(node);
}

/** svg 엘리먼트 생성 헬퍼 — nav-rail.ts 의 svgEl 과 동일 패턴(이 파일 전용 사본). */
function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  return node;
}

/** 빈 상태 일러스트 — archive: 빈 육각 보관함 + 별 하나 / proposals: 대기 별 3개. */
function emptyStateArt(kind: "archive" | "proposals"): HTMLElement {
  const wrap = el("span", { className: "dash-empty__art", "aria-hidden": "true" });
  const svg = svgEl("svg", {
    viewBox: "0 0 64 64",
    width: "64",
    height: "64",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.5",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    focusable: "false",
  });
  const addPath = (d: string): void => { svg.appendChild(svgEl("path", { d })); };
  const addPolygon = (points: string): void => { svg.appendChild(svgEl("polygon", { points })); };

  if (kind === "archive") {
    // 빈 육각 보관함
    addPolygon("32,10 50,20 50,44 32,54 14,44 14,20");
    addPath("M14 20 L32 30 L50 20");
    addPath("M32 30 L32 54");
    // 별 하나
    addPath("M46 12 L47.2 15.2 L50.6 15.4 L47.9 17.6 L48.8 20.9 L46 19 L43.2 20.9 L44.1 17.6 L41.4 15.4 L44.8 15.2 Z");
  } else {
    // 대기하는 별 3개 (크기 다양)
    addPath("M20 14 L21.6 18.4 L26.2 18.7 L22.6 21.6 L23.9 26.1 L20 23.5 L16.1 26.1 L17.4 21.6 L13.8 18.7 L18.4 18.4 Z");
    addPath("M42 26 L43 28.6 L45.7 28.8 L43.6 30.6 L44.3 33.3 L42 31.7 L39.7 33.3 L40.4 30.6 L38.3 28.8 L41 28.6 Z");
    addPath("M30 40 L30.7 42 L32.8 42.1 L31.1 43.4 L31.7 45.4 L30 44.2 L28.3 45.4 L28.9 43.4 L27.2 42.1 L29.3 42 Z");
  }

  wrap.appendChild(svg);
  return wrap;
}

function emptyState(text: string, kind?: "archive" | "proposals"): HTMLElement {
  if (!kind) {
    return el("div", { className: "dash-empty" }, text);
  }
  return el("div", { className: "dash-empty" }, emptyStateArt(kind), el("p", {}, text));
}

function loadingState(text: string): HTMLElement {
  return el(
    "div",
    { className: "dash-loading", role: "status" },
    el("span", { className: "dash-square-loader dash-square-loader--sm", "aria-hidden": "true" }),
    el("span", {}, text),
  );
}

function searchLoadingState(): HTMLElement {
  return el(
    "div",
    { className: "dash-loading dash-search-loading rp-body--loading", role: "status" },
    el("span", { className: "dash-square-loader dash-square-loader--lg", "aria-hidden": "true" }),
    el("span", { className: "rp-loading__text" }, "검색 중"),
  );
}

function errorState(text: string): HTMLElement {
  return el("div", { className: "dash-error" }, text);
}

function selectedMemoryId(): number | null {
  return state.selected.kind === "memory" ? state.selected.memoryId : null;
}

function renderRows(
  host: HTMLElement,
  views: Array<{ id: number; view: CardView; source: SelectionSource }>,
  emptyText: string,
  options: { revealRows?: boolean } = {},
): void {
  const revealRows = options.revealRows === true && views.length > 0;
  host.classList.toggle("rp-list--reveal", revealRows);
  if (views.length === 0) {
    setListState(host, emptyState(emptyText));
    return;
  }
  const current = selectedMemoryId();
  host.replaceChildren(
    ...views.map(({ id, view, source }, index) => {
      const row = resultRow(view, {
        onPick: () => void selectMemory(id, source, view),
      });
      if (revealRows) {
        row.classList.add("rp-row--reveal");
        row.style.setProperty("--rp-row-delay", `${Math.min(index * 55, 720)}ms`);
      }
      if (current === id) row.classList.add("selected");
      return row;
    }),
  );
}

function renderMemoryList(): void {
  if (state.searchFeedback) {
    dom.listTitle.textContent = "검색결과";
    dom.memoryList.setAttribute("aria-label", "검색 결과");
    setListState(dom.memoryList, state.searchFeedback.kind === "loading"
      ? searchLoadingState() : errorState(state.searchFeedback.message));
    return;
  }
  if (state.compute) {
    dom.listTitle.textContent = "계산결과";
    dom.memoryList.setAttribute("aria-label", "계산 결과");
    dom.memoryList.classList.remove("rp-list--reveal");
    if (state.compute.kind === "error") {
      setListState(dom.memoryList, errorState(state.compute.message));
      return;
    }
    setListState(
      dom.memoryList,
      el("div", { className: "dash-compute-result" }, ...state.compute.nodes),
    );
    return;
  }

  if (state.search) {
    dom.listTitle.textContent = "검색결과";
    dom.memoryList.setAttribute("aria-label", "검색 결과");
    renderRows(
      dom.memoryList,
      state.search.results.map((hit) => ({
        id: hit.id,
        view: searchToCardView(hit),
        source: "search",
      })),
      "검색 결과가 없습니다.",
      { revealRows: true },
    );
    return;
  }

  dom.listTitle.textContent = "목록";
  dom.memoryList.setAttribute("aria-label", "목록");
  renderRows(
    dom.memoryList,
    state.latest.map((memory) => ({
      id: memory.id,
      view: memoryToCardView(memory),
      source: "latest",
    })),
    "최근 메모리가 없습니다.",
  );
}

function renderSchedule(): void {
  const schedule = state.schedule;
  if (!schedule) {
    setListState(dom.scheduleList, loadingState("일정 로딩 중..."));
    return;
  }
  const rows: HTMLElement[] = [];
  const appendOccurrence = (occ: DateOccurrence): void => {
    const id = typeof occ.target.id === "number" ? occ.target.id : memoryIdFromNodeId(occ.target.nodeId);
    const view = occurrenceToCardView(occ);
    const row = resultRow(view, {
      onPick: () => {
        if (id != null) void selectMemory(id, "schedule", view);
      },
    });
    if (id != null && selectedMemoryId() === id) row.classList.add("selected");
    rows.push(row);
  };
  for (const occ of schedule.upcoming) appendOccurrence(occ);
  if (schedule.past.length > 0) rows.push(el("div", { className: "dash-list-divider" }, "지난"));
  for (const occ of schedule.past) appendOccurrence(occ);
  dom.scheduleList.replaceChildren(...(rows.length > 0 ? rows : [emptyState("일정 항목이 없습니다.")]));
}

async function handleMemoryTrashed(
  memoryId: number,
  result: { trashed: number; cascadeTrashedIds: number[] },
): Promise<void> {
  if (state.selected.kind === "memory" && state.selected.memoryId === memoryId) {
    state.selected = { kind: "none" };
  }
  // refreshCoreData 는 stats/latest/schedule/graph 만 재조회하고 검색 결과는 건드리지
  // 않는다 — 검색 중이던 화면에 삭제된 행이 그대로 남는 정직성 문제를 막기 위해
  // 로컬 필터로 별도 반영한다(재검색 아님 — search-result-filter.ts 주석 참조).
  state.search = removeTrashedFromSearch(state.search, memoryId, result.cascadeTrashedIds);
  await refreshCoreData();
}

function renderDetail(): void {
  if (state.selected.kind === "none") {
    dom.detail.replaceChildren(emptyState("항목을 선택하면 내용이 표시됩니다."));
    return;
  }
  const selectedNodeId = state.selected.graphNodeId;
  const animateContent = state.skipDetailAnimationForNodeId !== selectedNodeId;
  const children: HTMLElement[] = [
    nodeDetail(state.selected.view ?? {
      nodeId: state.selected.graphNodeId,
      title: "선택한 항목",
    }, { animateContent }),
  ];
  if (state.selected.kind === "memory") {
    const selected = state.selected;
    const memoryId = state.selected.memoryId;
    if (selected.memory) {
      const shared = selected.memory.metadata?.["sharedMemory"] as { revision?: unknown } | undefined;
      const revision = typeof shared?.revision === "number" && Number.isSafeInteger(shared.revision) && shared.revision >= 0
        ? shared.revision : 0;
      const edit = buildEditControls({
        id: selected.graphNodeId, sourceId: memoryId, type: "memory",
        sourceType: selected.memory.sourceType ?? selected.memory.memoryType,
        label: selected.view?.title ?? "기억", snippet: selected.memory.content,
      }, async (request) => {
        const result = await editMemory(memoryId, request.content, revision, request.reason);
        if (state.selected.kind === "memory" && state.selected.memoryId === memoryId) {
          // 수정 응답에는 장소 칸이 없다 — 정보 블록이 "장소 없음"으로 뒤바뀌지 않게 이전 값을 잇는다.
          const edited = {
            ...result.memory,
            place: result.memory.place ?? state.selected.memory?.place,
            places: result.memory.places ?? state.selected.memory?.places,
          };
          state.selected = {
            ...state.selected, memory: edited, metadata: edited.metadata,
            view: { ...memoryToCardView(edited), snippet: edited.content },
          };
          renderDetail();
        }
        showToast("기억을 수정했습니다.", "success");
        try { await refreshCoreData(true); }
        catch { showToast("수정은 완료됐지만 목록 갱신에 실패했습니다. 화면을 새로 불러오세요.", "error"); }
      });
      if (edit) children.push(edit);
      else children.push(el("p", {}, "문서·이미지 원본은 직접 수정할 수 없습니다. 검색 가능한 텍스트나 파생 기억을 수정하세요."));
    }
    children.push(detailTrashControl({
      memoryId,
      metadata: state.selected.metadata,
      onTrashed: (result) => handleMemoryTrashed(memoryId, result),
    }));
  }
  dom.detail.replaceChildren(...children);
  if (!animateContent) state.skipDetailAnimationForNodeId = null;
}

function renderGraph(): void {
  renderMiniGraph(dom.graph, {
    overview: state.graph,
    selection: state.selected,
    newNodeIds: state.newGraphNodeIds,
    onPickNode: (node) => void selectGraphNode(node),
  });
}

function renderAll(): void {
  renderStatus();
  renderMemoryList();
  renderSchedule();
  renderDetail();
  renderGraph();
}

async function selectMemory(
  memoryId: number,
  source: SelectionSource,
  seedView?: CardView,
): Promise<void> {
  if (state.selected.kind === "memory" && state.selected.memoryId === memoryId) {
    if (skipNodeDetailTypewriter(dom.detail)) {
      state.skipDetailAnimationForNodeId = nodeIdForMemory(memoryId);
      return;
    }
  }
  const graphNodeId = nodeIdForMemory(memoryId);
  if (state.skipDetailAnimationForNodeId !== graphNodeId) {
    state.skipDetailAnimationForNodeId = null;
  }
  state.selected = {
    kind: "memory",
    memoryId,
    graphNodeId,
    source,
    view: seedView ?? memoryToCardView({ id: memoryId, content: `#${memoryId}` }),
  };
  renderAll();

  const requestId = ++state.detailRequestId;
  dom.detail.append(loadingState("상세 불러오는 중..."));
  try {
    const detail = await getMemoryDetail(memoryId);
    if (requestId !== state.detailRequestId) return;
    const memory = detail.memory;
    state.selected = {
      kind: "memory",
      memoryId,
      graphNodeId,
      source,
      view: { ...memoryToCardView(memory), snippet: memory.content },
      metadata: memory.metadata,
      memory,
    };
    renderAll();
  } catch (error) {
    if (requestId !== state.detailRequestId) return;
    dom.detail.replaceChildren(errorState(`상세 로딩 실패: ${(error as Error).message}`));
  }
}

async function selectGraphNode(node: GraphNode): Promise<void> {
  if (state.selected.kind === "graph-node" && state.selected.graphNodeId === node.id) {
    if (skipNodeDetailTypewriter(dom.detail)) {
      state.skipDetailAnimationForNodeId = node.id;
      return;
    }
  }
  const memoryId =
    typeof node.sourceId === "number" ? node.sourceId : memoryIdFromNodeId(node.id);
  if (memoryId != null) {
    await selectMemory(memoryId, "mini-graph", fromGraphNode(node));
    return;
  }
  state.selected = {
    kind: "graph-node",
    graphNodeId: node.id,
    source: "mini-graph",
    view: fromGraphNode(node),
  };
  renderAll();
}

function searchOptionsFromPayload(payload: SearchModalSearchPayload): DashboardSearchOptions {
  const options: DashboardSearchOptions = { limit: 24 };
  if (payload.kind) options.kind = payload.kind;
  if (payload.subcategory) options.subcategory = payload.subcategory;
  if (payload.since) options.since = payload.since;
  if (payload.until) options.until = payload.until;
  return options;
}

async function runSearch(payload: SearchModalSearchPayload): Promise<void> {
  const requestId = ++state.searchRequestId;
  const query = payload.query.trim();
  if (!query) {
    state.searchFeedback = null;
    state.search = null;
    state.compute = null;
    if (state.selected.kind === "memory" && state.selected.source === "search") {
      state.detailRequestId += 1;
      state.selected = { kind: "none" };
    }
    renderAll();
    dom.searchInput.focus();
    return;
  }
  // "#87" 만 입력하면 검색 대신 그 번호의 기억을 연다(정리 제안의 "기억 #87" 과 같은 번호).
  const memoryNumber = parseMemoryNumberQuery(query);
  if (memoryNumber !== null) {
    state.search = null;
    state.compute = null;
    state.searchFeedback = null;
    renderAll();
    await selectMemory(memoryNumber, "search");
    return;
  }
  state.search = null;
  state.compute = null;
  state.searchFeedback = { kind: "loading" };
  dom.listTitle.textContent = "검색결과";
  if (state.selected.kind === "memory" && state.selected.source === "search") {
    state.detailRequestId += 1;
    state.selected = { kind: "none" };
    renderDetail();
  }
  dom.memoryList.setAttribute("aria-label", "검색 결과");
  dom.memoryList.classList.remove("rp-list--reveal");
  setListState(dom.memoryList, searchLoadingState());
  try {
    state.compute = null;
    const result = await searchMemories(query, searchOptionsFromPayload(payload));
    if (requestId !== state.searchRequestId) return;
    state.search = result;
    state.searchFeedback = null;
    renderAll();
    const first = state.search.results[0];
    if (first && state.selected.kind === "none") {
      await selectMemory(first.id, "search", searchToCardView(first));
    }
  } catch (error) {
    if (requestId !== state.searchRequestId) return;
    state.searchFeedback = { kind: "error", message: `검색 실패: ${(error as Error).message}` };
    renderMemoryList();
  }
}

async function refreshCoreData(throwOnError = false): Promise<void> {
  if (!state.search && !state.compute && !state.searchFeedback) {
    dom.memoryList.replaceChildren(loadingState("최근 메모리 로딩 중..."));
  }
  dom.scheduleList.replaceChildren(loadingState("일정 로딩 중..."));
  dom.graph.replaceChildren(loadingState("그래프 로딩 중..."));

  const [statsRes, latestRes, scheduleRes, graphRes] = await Promise.allSettled([
    getStats(),
    getLatest(30),
    getDateOccurrences(),
    getGraphOverview(120),
  ]);

  if (statsRes.status === "fulfilled") state.stats = statsRes.value;
  else dom.status.replaceChildren(errorState(`상태 로딩 실패: ${statsRes.reason}`));

  if (latestRes.status === "fulfilled") {
    const body: MemoriesResponse = latestRes.value;
    state.latest = body.memories ?? [];
  } else {
    dom.memoryList.replaceChildren(errorState(`최근 목록 실패: ${latestRes.reason}`));
  }

  if (scheduleRes.status === "fulfilled") state.schedule = scheduleRes.value;
  else dom.scheduleList.replaceChildren(errorState(`일정 실패: ${scheduleRes.reason}`));

  if (graphRes.status === "fulfilled") {
    const previousNodeIds = new Set(state.graph?.nodes.map((node) => node.id) ?? []);
    const nextGraph = graphRes.value;
    state.newGraphNodeIds = state.graph
      ? new Set(nextGraph.nodes.filter((node) => !previousNodeIds.has(node.id)).map((node) => node.id))
      : new Set();
    state.graph = nextGraph;
  } else {
    state.newGraphNodeIds = new Set();
    dom.graph.replaceChildren(errorState(`그래프 실패: ${graphRes.reason}`));
  }

  renderAll();
  if (throwOnError && [statsRes, latestRes, scheduleRes, graphRes].some((result) => result.status === "rejected")) {
    throw new Error("기억 목록을 새로 불러오지 못했습니다.");
  }
}

async function refreshAfterIngest(): Promise<void> {
  const beforeTop = state.latest[0]?.id ?? null;
  await refreshCoreData();
  const newest = state.latest[0];
  if (newest && newest.id !== beforeTop) {
    await selectMemory(newest.id, "latest", memoryToCardView(newest));
  }
}

async function renderArchive(): Promise<void> {
  dom.archiveList.replaceChildren(renderArchiveList(() => refreshCoreData(true)));
}

async function renderProposals(): Promise<void> {
  const count = el("div", { className: "dash-secondary-count" });
  const cards = el("div", { className: "dash-secondary-list" });
  const status = el("p", { className: "proposal-list-status", role: "status" });
  const more = el("button", { className: "au-btn au-btn--ghost", type: "button" }, "더 보기");
  const loadedIds = new Set<string>();
  const pendingIds = new Set<string>();
  let loading = false;
  let revision = 0;

  const updateCount = (total: number): void => {
    count.textContent = `검토 대기 ${total}건`;
    more.hidden = pendingIds.size >= total;
  };

  async function onChanged(id: string): Promise<void> {
    if (pendingIds.delete(id)) revision += 1;
    // 처리 결과 카드는 남겨 두고 목록 갱신만 수행한다. 재시도도 읽기 요청만 보낸다.
    const [, remaining] = await Promise.all([refreshCoreData(true), listCleanupProposals(1)]);
    updateCount(remaining.total);
  }

  async function loadMore(): Promise<void> {
    if (loading) return;
    loading = true;
    more.disabled = true;
    status.textContent = "정리 제안을 불러오는 중입니다…";
    status.classList.remove("dash-error");
    try {
      // 대기 목록은 승인·거절 때 줄어든다. 이전 offset을 재사용하면 아직 못 본
      // 항목을 건너뛰므로 처음부터 ID를 대조해 새 항목 20개를 찾는다.
      let offset = 0;
      let added = 0;
      let exhausted = false;
      let total = 0;
      while (added < 20 && !exhausted) {
        const readRevision = revision;
        const body = await listCleanupProposals(100, offset);
        if (revision !== readRevision) { offset = 0; continue; }
        total = body.total;
        for (const proposal of body.proposals) {
          if (loadedIds.has(proposal.id)) continue;
          loadedIds.add(proposal.id);
          pendingIds.add(proposal.id);
          cards.append(renderCleanupProposal(proposal, onChanged));
          if (++added === 20) break;
        }
        offset += body.proposals.length;
        exhausted = body.proposals.length === 0 || offset >= body.total;
      }
      if (loadedIds.size === 0) cards.replaceChildren(emptyState("대기 중인 정리 제안이 없습니다.", "proposals"));
      updateCount(total);
      if (added < 20 && exhausted) more.hidden = true;
      status.textContent = "";
      more.textContent = "더 보기";
    } catch (error) {
      status.textContent = `제안을 불러오지 못했습니다. ${(error as Error).message}`;
      status.classList.add("dash-error");
      more.hidden = false;
      more.textContent = "다시 불러오기";
    } finally {
      loading = false;
      more.disabled = false;
    }
  }
  more.addEventListener("click", () => void loadMore());
  dom.proposalsList.replaceChildren(count, cards, status, more);
  await loadMore();
}

window.addEventListener("hashchange", () => void switchPage(pageFromHash()));

void (async function boot() {
  await switchPage(pageFromHash());
  await refreshCoreData();
  const linkedMemoryId = memoryIdFromSearch(location.search);
  if (linkedMemoryId !== null) {
    await switchPage("main");
    await selectMemory(linkedMemoryId, "latest");
  }
})();
