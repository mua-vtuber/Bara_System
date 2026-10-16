/**
 * web/dashboard/graph/graph-entry.ts
 * 그래프 화면 진입점.
 *
 * 부팅 흐름:
 *   GET /graph/overview → buildOverviewViewModel → computeRadialLayout → controller.applyData
 *
 * 검색 흐름:
 *   search-modal onSearch → runGraphSearch → POST /graph/search → buildSearchViewModel
 *   → computeRadialLayout + controller.applyData + controller.applyFocus + renderResultsPanel + renderTop3
 *
 * 노드 클릭:
 *   controller.onNodeClick → actOnNode(3-상태) → NodeWindowManager open/focus/close → syncWindows
 *
 * 좌측 기억목록 패널:
 *   createMemoryPanel — 브랜드·상태줄·"기억 목록 N"·탭 3개·목록. 탭 전환 시 같은 VM 으로 재정렬.
 *   onPick → controller.focusNode(Stage 3 가 그래프 선택+모달 연동을 더 배선).
 *
 * 하단:
 *   mountIngestForm (runtime import /web/dashboard/ingest-form.js) 재활용
 *   저장 성공(onIngested) → /graph/overview 재로드 + 전체 조망 카메라 프레이밍
 *
 * 모든 API 호출은 apiFetch 경유 (토큰 주입).
 * 브라우저에 최종 로드되는 파일은 bun build 산출 .js 하나.
 */

import { initTheme } from "../ui/theme-switch.ts";
initTheme();

import { apiFetch } from "../api-fetch.ts";

import {
  buildOverviewViewModel,
  buildSearchViewModel,
} from "./graph-adapter-live.ts";

import { buildDegreeMap, nodeSizeOf } from "./render/nodes.ts";
import { radiusOfSize } from "./layout/spacing.ts";
import type {
  GraphOverviewResponse,
  GraphSearchApiResponse,
} from "./graph-adapter-live.ts";
import {
  collapseExpansionKeysForNode,
  expansionDescendantNodeIdsForKeys,
  expansionKeyForGraphNode,
} from "./derived-expansion.ts";

import { computeRadialLayout } from "./layout/radial-layout.ts";
import { SEARCH_RADIAL_LAYOUT } from "./layout/search-layout.ts";
import { GRAPH_RENDER_THEME } from "./graph-theme.ts";
import { GraphController } from "./render/graph-controller.ts";
import { createTop3Layer } from "./render/top3-float.ts";

import { renderShell } from "./shell/dashboard-shell.ts";
import { createMemoryPanel } from "./shell/memory-panel.ts";
import type { MemoryPanel } from "./shell/memory-panel.ts";
import { buildDateOccurrenceRows, buildMemoryListRows } from "./shell/memory-panel-data.ts";
import type {
  DateOccurrence,
  DateOccurrencesResponse,
  MemoryPanelTab,
} from "./shell/memory-panel-data.ts";
import { renderSearchModal } from "./shell/search/search-modal.ts";
import type { SearchModalSearchPayload } from "./shell/search/search-modal.ts";
import { createEntityTypeFieldPicker } from "./shell/entity-type-field-picker.ts";
import { mountComputePanel } from "./shell/search/compute-panel.ts";
import { el } from "./shell/dom.ts";
import {
  renderResultsPanel,
  renderResultsLoadingPanel,
  applyResultsPanelSelection,
} from "./shell/results-panel.ts";
import { sortCardViews } from "./shell/search/results-panel-sort.ts";
import type { ResultSortMode } from "./shell/search/results-panel-sort.ts";
import {
  NodeWindowManager,
  MAX_NODE_WINDOWS,
  resolveNodeClickAction,
  type NodeWindow,
} from "./shell/node-window.ts";
import {
  createNodeWindowView,
  nodeWindowIdsNeedingRefresh,
  skipNodeWindowTypewriter,
  type NodeWindowEditRequest,
  type NodeWindowTagRequest,
  type NodeWindowTrashRequest,
} from "./shell/node-window-view.ts";
import { createHoverTip } from "./shell/node-hover-tip.ts";

import { fromGraphHit, fromGraphNode } from "../ui/card-view.ts";
import { memoryCard } from "../ui/memory-card.ts";
import { memoryInfoFromMemory, type MemoryInfo } from "../ui/memory-info.ts";
import type { CardView } from "../ui/card-view.ts";

import type { DashboardGraphViewModel, GraphNode } from "./graph-view-model.ts";

// ── 검색 limit 상수 ─────────────────────────────────────────────────────────
const SEARCH_RESULT_LIMIT = 20 as const;

// ── 라이브 성장(2a) 끄기 스위치 ──────────────────────────────────────────────
// false 면 SSE 구독을 아예 시작하지 않는다(가만히 봐도 자라는 라이브 연출이 통째로 꺼짐).
// "가만히 봐도 자란다"가 사용자가 꼽은 핵심이라 default true(plan default 제안 정합).
const LIVE_GROWTH_ENABLED = true as const;

// SSE 이벤트 타입 — 서버 EVENT_TYPES 와 같은 snake_case 문자열(브라우저엔 서버 모듈을
// import 하지 않으므로 web 쪽에 직접 둔다. 서버 상수명이 바뀌면 이 값도 같이 갱신).
const SSE_EVENT_GRAPH_CHANGED = "graph_changed" as const;
const SSE_EVENT_GRAPH_MERGE = "graph_merge" as const;
const SSE_EVENT_GRAPH_EMERGE = "graph_emerge" as const;

// ── SSE 신호 payload 모양(서버 event-bus.ts JSDoc 계약과 같은 모양) ──────────
interface GraphMergePayload {
  from: string;
  into: string;
}
interface GraphEmergePayload {
  nodeId: string;
  fromSources: string[];
}
interface SseTokenResponse {
  adapterId: string;
  token: string;
}

// ── escapeHtml: ingest-form 에 넘기는 XSS 방어 유틸 ────────────────────────
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── 진입점 ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mountRoot = document.getElementById("graph-root");
  if (!mountRoot) {
    throw new Error("graph-entry: #graph-root 요소를 찾을 수 없습니다.");
  }
  // 레일·좌우 목록과 중앙 폼이 함께 들어갈 수 없는 폭에서는 목록을 접어 시작한다.
  const narrowViewport = window.matchMedia("(max-width: 1279px)");

  // 뷰모델·레이아웃 캐시
  let currentVm: DashboardGraphViewModel = {
    nodes: [],
    edges: [],
    clusters: [],
    stats: { totalNodes: 0, totalEdges: 0 },
    recent: [],
  };
  let scheduleTargetNodes = new Map<string, GraphNode>();
  // ── 라이브 박자 규칙(2a·spec 7절) ──────────────────────────────────────────
  // overview 화면이면 라이브 신호를 즉시 적용하고, 검색 결과를 보는 중(isSearchMode)에는
  // 들어온 신호를 pendingLiveSignals 에 쌓았다가 overview 로 돌아올 때 한 번에 적용한다.
  // (검색 결과를 보는 도중 노드가 움직여 사용자가 보던 화면이 흔들리지 않게 한다.)
  let isSearchMode = false;
  // 지금 화면에 떠 있는 Top3 카드의 노드 id 집합. 그 노드엔 hover 요약 팁을 띄우지 않는다
  // (이미 카드가 있어 중복·겹침이라). 검색마다 갱신, overview 복귀 시 비운다.
  let top3NodeIds = new Set<string>();
  const pendingLiveSignals: Array<() => void> = [];
  // overview refresh 가 연속 입력·SSE 로 겹칠 수 있다. 늦게 도착한 옛 응답이 최신 정렬을
  // 덮어쓰지 못하게 요청 순번으로 최신 응답만 반영한다.
  let overviewLoadSeq = 0;
  // 입력 저장 직후엔 다음 overview 반영 시 카메라를 전체 조망으로 맞춘다.
  // 저장 후 직접 reload 와 SSE graph_changed reload 가 겹쳐도 최신 응답이 이 플래그를 소비한다.
  let overviewFrameRequested = false;
  const expandedOverviewNodeIds = new Set<string>();

  function requestOverviewCameraFrame(): void {
    overviewFrameRequested = true;
  }

  function overviewEndpoint(): string {
    if (expandedOverviewNodeIds.size === 0) return "/graph/overview";
    const expanded = [...expandedOverviewNodeIds].join(",");
    return `/graph/overview?expand=${encodeURIComponent(expanded)}`;
  }

  const KNOWN_GRAPH_NODE_TYPES: ReadonlySet<GraphNode["type"]> = new Set([
    "project",
    "concept",
    "person",
    "document",
    "document_chunk",
    "image",
    "image_caption",
    "llm_extract",
    "decision",
    "tag",
    "memory",
    "unknown",
    "creature",
    "thing",
    "intake",
    "usable",
    "work",
    "material",
    "place",
    "schedule",
    "classification_key",
    "entity_group",
  ]);

  function graphNodeTypeOf(type: string): GraphNode["type"] {
    return KNOWN_GRAPH_NODE_TYPES.has(type as GraphNode["type"])
      ? (type as GraphNode["type"])
      : "unknown";
  }

  function syntheticNodeFromOccurrence(occ: DateOccurrence): GraphNode {
    const detail = [
      occ.columnKey ? `${occ.columnKey}: ${occ.originalDateText ?? occ.date}` : null,
      occ.endDateTime ? `종료: ${occ.endDateTime}` : null,
    ].filter((v): v is string => v !== null);
    return {
      id: occ.target.nodeId,
      sourceId: occ.target.id,
      type: graphNodeTypeOf(occ.target.type),
      sourceType: occ.target.type,
      label: occ.target.label,
      snippet: detail.length > 0 ? detail.join(" · ") : occ.title,
      eventAt: occ.dateTime ?? occ.date,
      meta: { dateOccurrence: occ },
    };
  }

  /** 라이브 신호 1건을 박자 규칙에 맞춰 처리한다 — overview 면 즉시, 검색 중이면 큐에 쌓는다. */
  function dispatchLiveSignal(apply: () => void): void {
    if (isSearchMode) pendingLiveSignals.push(apply);
    else apply();
  }

  /** overview 로 돌아올 때 쌓아 둔 라이브 신호를 순서대로 비우며 적용한다. */
  function flushPendingLiveSignals(): void {
    const queued = pendingLiveSignals.splice(0, pendingLiveSignals.length);
    for (const apply of queued) apply();
  }

  // ── 상세 창 관리(다중 모달·재클릭 3-상태) ──────────────────────────────────
  // 데스크톱은 최대 4개를 나란히 띄워 노드를 비교하고, 모바일(좁은 화면)은 1개만 띄운다.
  // 클릭은 모두 actOnNode 한 진입점을 거친다 — 창이 없으면 열고, 묻혀 있으면 맨 앞으로,
  // 이미 맨 앞이면 닫는다(resolveNodeClickAction 의 3-상태 규칙).
  const isMobile = window.innerWidth <= 800;
  const nodeWindowMgr = new NodeWindowManager(isMobile ? 1 : MAX_NODE_WINDOWS);
  const windowEls = new Map<string, HTMLElement>();
  const windowElVersions = new Map<string, number>();
  let windowRenderVersion = 0;

  function bumpWindowRenderVersion(): void {
    windowRenderVersion++;
  }

  async function editNodeFromWindow(req: NodeWindowEditRequest): Promise<void> {
    const resp = await apiFetch(`/memories/${req.sourceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: req.content,
        reason: req.reason,
        source: "dashboard",
        editor: "dashboard",
      }),
    });
    if (!resp.ok) {
      let detail = `${resp.status}`;
      try {
        const body = (await resp.json()) as { error?: string };
        detail = body.error ?? detail;
      } catch {
        detail = await resp.text().catch(() => detail);
      }
      throw new Error(detail);
    }

    await loadOverview();
    invalidateWindowElement(req.nodeId);
    syncWindows();
  }

  /**
   * 노드 창의 삭제 버튼 — 원문(sourceId)을 휴지통으로 옮긴다(영구 삭제 아님).
   * 파생 건수 미리보기는 상세의 metadata.extractedTo 길이(추정치) — 실제 이동 건수는
   * POST /trash 응답(cascadeTrashedIds)이 확정한다(추정/실측 구분·spec 3). 확인 취소는
   * 정상 반환(cancel)이고, 창 비활성화·재활성화는 호출부(node-window-view.ts)가 맡는다.
   *
   * 성공 경로는 actOnNode 의 "close" 분기(§표준 닫기)가 하는 정리를 그대로 미러링한다 —
   * 파생 확장 자식 창(closeExpansionDescendantWindows)과 선택 해제. actOnNode 를 직접
   * 호출하지 않는 이유는 그 함수의 collapseExpandedOverviewNodes 가 내부에서 별도
   * loadOverview().then(...) 을 fire-and-forget 으로 발화해, 이 함수가 이미 호출하는
   * loadOverview 와 순서 보장 없이 경합하기 때문이다(닫기→재조회→무효화→동기화 순서가
   * 깨짐). 대신 collapseKeys 계산과 expandedOverviewNodeIds 정리만 직접 하고, 화면
   * 재조회는 아래 기존 loadOverview 한 번에 맡긴다(중복 호출 방지).
   */
  async function trashNodeFromWindow(req: NodeWindowTrashRequest): Promise<void> {
    // 파생 건수 미리보기 조회 — 실패(HTTP 오류·네트워크 예외 둘 다)를 approx=0 으로
    // 세탁하지 않는다. previewOk=false 면 "약 N건" 대신 확인 실패를 있는 그대로 드러내는
    // 문구를 쓴다(No-fallback 원칙 — 실패가 데이터로 둔갑하면 자식 5건짜리 글이 "약 0건"
    // 으로 보여 사용자가 안전하다고 오판한다). previewOk=true 이고 배열이 없거나 빈
    // 배열이면 그건 조회가 성공한 진짜 0건이라 approx=0 그대로 표시한다.
    let approx = 0;
    let previewOk = false;
    try {
      const detailResp = await apiFetch(`/memories/${req.sourceId}`);
      if (detailResp.ok) {
        const detail = (await detailResp.json()) as {
          memory?: { metadata?: { extractedTo?: unknown } };
        };
        const list = detail.memory?.metadata?.extractedTo;
        if (Array.isArray(list)) approx = list.length;
        previewOk = true;
      }
    } catch (err) {
      console.error("[graph-entry] 삭제 파생 건수 미리보기 조회 오류:", err);
    }
    const ok = globalThis.confirm(
      previewOk
        ? `이 기억을 휴지통으로 옮긴다 (파생 항목 약 ${approx}건 포함).\n휴지통에서 복원 가능, 보존 기간이 지나면 자동 영구 삭제.\n\n진행할까?`
        : "이 기억을 휴지통으로 옮긴다 (파생 항목 수 확인 실패 — 있으면 함께 이동).\n휴지통에서 복원 가능, 보존 기간이 지나면 자동 영구 삭제.\n\n진행할까?",
    );
    if (!ok) return;

    const resp = await apiFetch(`/memories/${req.sourceId}/trash`, { method: "POST" });
    if (!resp.ok) {
      let detail = `${resp.status}`;
      try {
        const body = (await resp.json()) as { error?: string };
        detail = body.error ?? detail;
      } catch {
        detail = await resp.text().catch(() => detail);
      }
      throw new Error(detail);
    }

    const collapseKeys = collapseExpansionKeysForNode(currentVm, req.nodeId, expandedOverviewNodeIds);
    nodeWindowMgr.close(req.nodeId);
    closeExpansionDescendantWindows(collapseKeys, req.nodeId);
    if (selectedNodeId === req.nodeId) {
      controller.clearSelection();
      setSelectionEverywhere(null);
    }
    for (const key of collapseKeys) expandedOverviewNodeIds.delete(key);

    await loadOverview();
    invalidateWindowElement(req.nodeId);
    syncWindows();
  }

  async function addTagFromWindow(req: NodeWindowTagRequest): Promise<void> {
    const resp = await apiFetch(`/memories/${req.sourceId}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag: req.tag,
        source: "dashboard",
        editor: "dashboard",
      }),
    });
    if (!resp.ok) {
      let detail = `${resp.status}`;
      try {
        const body = (await resp.json()) as { error?: string };
        detail = body.error ?? detail;
      } catch {
        detail = await resp.text().catch(() => detail);
      }
      throw new Error(detail);
    }

    await loadOverview();
    invalidateWindowElement(req.nodeId);
    syncWindows();
  }

  /** 큰 모달 초기 위치 — 화면 가운데 근처에서 인덱스별로 조금씩 어긋나게(계단식). */
  function nextWindowPos(index: number): { x: number; y: number } {
    const width = isMobile ? window.innerWidth - 24 : Math.min(480, window.innerWidth - 96);
    const height = isMobile ? window.innerHeight - 24 : Math.min(560, window.innerHeight - 96);
    const off = (index % 4) * 28;
    const baseX = isMobile ? 12 : (window.innerWidth - width) / 2 - 42;
    const baseY = isMobile ? 12 : (window.innerHeight - height) / 2 + 22;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    return {
      x: clamp(Math.round(baseX + off), 8, Math.max(8, window.innerWidth - width - 8)),
      y: clamp(Math.round(baseY + off), 8, Math.max(8, window.innerHeight - height - 8)),
    };
  }

  /** 노드 창의 "정보" 블록 — 처음 펼칠 때 GET /memories/:id 로 작성자·저장 경로·출처를 읽는다. */
  async function loadMemoryInfoForWindow(sourceId: number): Promise<MemoryInfo | undefined> {
    const resp = await apiFetch(`/memories/${sourceId}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = (await resp.json()) as { memory?: object };
    return body.memory ? memoryInfoFromMemory(body.memory) : undefined;
  }

  function createWindowElement(w: NodeWindow): HTMLElement {
    return createNodeWindowView({
      vm: currentVm,
      nodeId: w.nodeId,
      pos: w.pos,
      animateContent: true,
      onClose: () => actOnNode(w.nodeId, "close"),
      onFocus: () => { nodeWindowMgr.focus(w.nodeId); syncWindows(); },
      onJumpNode: (targetNodeId) => openOrFocusNode(targetNodeId),
      onEditNode: editNodeFromWindow,
      onAddTag: addTagFromWindow,
      onTrashNode: trashNodeFromWindow,
      onLoadMemoryInfo: loadMemoryInfoForWindow,
      onMove: (p) => {
        nodeWindowMgr.move(w.nodeId, p);
        const e = windowEls.get(w.nodeId);
        if (e) { e.style.left = p.x + "px"; e.style.top = p.y + "px"; }
      },
    });
  }

  function invalidateWindowElement(nodeId: string): void {
    const old = windowEls.get(nodeId);
    if (!old) return;
    // 타이핑 중인 창을 제거할 땐 타이머를 즉시 끝낸다 — 떨어져 나간 DOM 에
    // setTimeout 체인이 계속 textContent 를 쓰는 잔존 작업을 남기지 않는다.
    skipNodeWindowTypewriter(old);
    old.remove();
    windowEls.delete(nodeId);
    windowElVersions.delete(nodeId);
  }

  /**
   * manager.list() 와 DOM Map 을 맞춘다 — 사라진 창의 DOM 은 제거하고, 남은 각 창에 z·위치를
   * 적용하며, DOM 이 아직 없거나 VM 재로드 뒤 오래된 창이면 현재 데이터로 새로 만든다.
   */
  function syncWindows(): void {
    const live = new Set(nodeWindowMgr.list().map((w) => w.nodeId));
    controller.autoRotation.setDetailOpen(live.size > 0);
    for (const id of [...windowEls.keys()]) {
      if (!live.has(id)) invalidateWindowElement(id);
    }
    for (const w of nodeWindowMgr.list()) {
      let elx = windowEls.get(w.nodeId);
      if (elx && windowElVersions.get(w.nodeId) !== windowRenderVersion) {
        invalidateWindowElement(w.nodeId);
        elx = undefined;
      }
      if (!elx) {
        elx = createWindowElement(w);
        windowEls.set(w.nodeId, elx);
        windowElVersions.set(w.nodeId, windowRenderVersion);
        document.body.appendChild(elx);
      }
      elx.style.zIndex = String(100 + w.z);
      elx.style.left = w.pos.x + "px";
      elx.style.top = w.pos.y + "px";
    }
  }

  function closeExpansionDescendantWindows(collapseKeys: ReadonlySet<string>, closedNodeId: string): void {
    if (collapseKeys.size === 0) return;
    for (const childNodeId of expansionDescendantNodeIdsForKeys(currentVm, collapseKeys)) {
      if (childNodeId === closedNodeId) continue;
      nodeWindowMgr.close(childNodeId);
      invalidateWindowElement(childNodeId);
      if (selectedNodeId === childNodeId) {
        controller.clearSelection();
        setSelectionEverywhere(null);
      }
    }
  }

  function collapseExpandedOverviewNodes(collapseKeys: ReadonlySet<string>, focusNodeId: string): void {
    let changed = false;
    for (const key of collapseKeys) {
      if (expandedOverviewNodeIds.delete(key)) changed = true;
    }
    if (!changed || isSearchMode) return;

    loadOverview()
      .then(() => {
        if (selectedNodeId && !currentVm.nodes.some((n) => n.id === selectedNodeId)) {
          controller.clearSelection();
          setSelectionEverywhere(null);
        }
        if (currentVm.nodes.some((n) => n.id === focusNodeId)) {
          controller.focusCameraOnNode(focusNodeId);
        }
        syncWindows();
      })
      .catch((err) =>
        console.error("[graph-entry] 파생 노드 접힘 오류:", err),
      );
  }

  /**
   * 노드 클릭/목록 클릭/모달 X 의 단일 진입점 — 3-상태 규칙으로 열기/맨앞/닫기를 가른다.
   * forced="close" 면 판정 없이 닫는다(모달 X 버튼 전용).
   * - 닫기: 창을 없애고, 그 노드가 "선택"(고정 라벨+좌·우 강조+포커스)이었으면 선택도 해제.
   * - 열기/맨앞: 그 노드를 가장 최근에 연/끌어올린 노드로 보고 선택을 그 노드에 맞춘다.
   */
  function actOnNode(nodeId: string, forced?: "close"): void {
    const action = forced ?? resolveNodeClickAction(nodeWindowMgr.list(), nodeId);
    if (action === "close") {
      if (forced !== "close" && skipNodeWindowTypewriter(windowEls.get(nodeId) ?? null)) {
        return;
      }
      const collapseKeys = collapseExpansionKeysForNode(currentVm, nodeId, expandedOverviewNodeIds);
      nodeWindowMgr.close(nodeId);
      closeExpansionDescendantWindows(collapseKeys, nodeId);
      syncWindows();
      if (selectedNodeId === nodeId) { controller.clearSelection(); setSelectionEverywhere(null); }
      collapseExpandedOverviewNodes(collapseKeys, nodeId);
      return;
    }
    if (action === "open") nodeWindowMgr.open(nodeId, nextWindowPos(nodeWindowMgr.list().length));
    else {
      nodeWindowMgr.focus(nodeId);
      invalidateWindowElement(nodeId);
    }
    syncWindows();
    controller.focusNode(nodeId);
    setSelectionEverywhere(nodeId);
    revealDerivedChildrenFor(nodeId);
  }

  /** 관련 노드 링크 전용 — 기존 3-상태 토글과 달리 같은 노드를 눌러도 닫지 않는다. */
  function openOrFocusNode(nodeId: string): void {
    const isOpen = nodeWindowMgr.list().some((w) => w.nodeId === nodeId);
    if (isOpen) {
      nodeWindowMgr.focus(nodeId);
      invalidateWindowElement(nodeId);
    } else {
      nodeWindowMgr.open(nodeId, nextWindowPos(nodeWindowMgr.list().length));
    }
    syncWindows();
    controller.focusNode(nodeId);
    setSelectionEverywhere(nodeId);
    revealDerivedChildrenFor(nodeId);
  }

  function revealDerivedChildrenFor(nodeId: string): void {
    if (isSearchMode) return;
    const expandKey = expansionKeyForGraphNode(currentVm.nodes.find((n) => n.id === nodeId));
    if (!expandKey || expandedOverviewNodeIds.has(expandKey)) return;
    expandedOverviewNodeIds.add(expandKey);
    loadOverview()
      .then(() => {
        controller.focusNode(nodeId);
        setSelectionEverywhere(nodeId);
        syncWindows();
      })
      .catch((err) =>
        console.error("[graph-entry] 파생 노드 펼침 오류:", err),
      );
  }

  // ── selection 단일 출처 진입점(§5.3) ───────────────────────────────────────
  // 좌측 목록 항목 클릭은 그래프 노드 직접 클릭과 같은 흐름을 탄다 — actOnNode 한 진입점이
  // 3-상태(열기/맨앞/닫기)를 가르고, 열기·맨앞이면 그 노드를 비추며(카메라+selectedId) 좌·우
  // 목록에 선택 색을 입힌다. setSelectionEverywhere·focusNode 둘 다 onPick 콜백을 발화하지
  // 않으므로 항목 클릭이 다시 selectNodeFromPanel 을 부르는 되울림(무한 콜백)이 없다.
  function selectNodeFromPanel(nodeId: string): void {
    const synthetic = scheduleTargetNodes.get(nodeId);
    if (synthetic && !currentVm.nodes.some((n) => n.id === nodeId)) {
      currentVm = { ...currentVm, nodes: [...currentVm.nodes, synthetic] };
      bumpWindowRenderVersion();
    }
    actOnNode(nodeId);
  }

  // ── 선택 색 단일 출처(좌·우 패널 공유·§5.3·§B-2) ───────────────────────────
  // 현재 선택된 노드 id 하나를 graph-entry 가 들고 있다가, 선택이 바뀔 때마다 좌측 목록과
  // 우측 결과 패널 두 곳에 같은 id 로 선택 색을 입힌다. 좌측 setSelected·우측
  // applyResultsPanelSelection 둘 다 클래스만 토글하고 onPick 콜백을 발화하지 않으므로
  // 한 진입점에서 둘을 함께 켜도 되울림(무한 콜백)이 없다. 우측은 검색마다 새로 그려지는데
  // (renderResultsPanel→replaceWith), 새 패널을 붙인 직후 이 id 로 다시 칠해 선택 색을
  // 복원한다(좌측 render 후 applySelectedClass 복원과 같은 방식).
  let selectedNodeId: string | null = null;

  /** 좌·우 패널에 같은 선택 id 를 입힌다(단일 출처). null 이면 양쪽 선택 색을 끈다. */
  function setSelectionEverywhere(nodeId: string | null): void {
    selectedNodeId = nodeId;
    memoryPanel.setSelected(nodeId);
    applyResultsPanelSelection(rightPanel, nodeId);
  }

  // ── 그래프 컨테이너 ────────────────────────────────────────────────────────
  const canvasContainer = document.createElement("div");
  canvasContainer.style.cssText = "width:100%;height:100%;position:relative";
  // 성운 레이어를 깐다(graph.html .graph-stage::before). 인라인 스타일은 그대로 둔다.
  canvasContainer.className = "graph-stage";

  // ── 검색 모달 ──────────────────────────────────────────────────────────────
  let rightPanel: HTMLElement | null = null;

  // ── 우측 결과 정렬 상태(S6·결정 5) ─────────────────────────────────────────
  // 마지막 검색이 끌어온 CardView 목록과 현재 정렬 모드를 graph-entry 가 보관한다. 정렬
  // 토글을 누르면 보관한 hitViews 를 클라이언트에서 재정렬해 우측 패널을 다시 그릴 뿐,
  // /graph/search 를 다시 호출하지 않는다(서버 무재호출·spec §8.1). 계산 결과 패널은
  // renderResultsPanel 을 거치지 않으므로(showComputeResult 자체 헤더) 정렬과 섞이지 않는다.
  let resultSortMode: ResultSortMode = "relevance";
  let lastHitViews: CardView[] = [];

  function replaceRightPanel(panel: HTMLElement): void {
    if (!rightPanel) return;
    if (narrowViewport.matches) memoryPanel.setCollapsed(true);
    rightPanel.replaceWith(panel);
    rightPanel = panel;
  }

  /**
   * 보관한 hitViews 를 현재 정렬 모드로 재정렬해 우측 결과 패널을 그린다(검색·정렬 공유 경로).
   * 행 클릭은 좌·우 단일 출처 흐름(selectNodeFromPanel)을 타고, 정렬 토글은 applySort 를 부른다.
   * 그린 직후 현재 선택 색을 다시 입혀 검색·정렬 후에도 선택이 유지된다(§B-2 양식).
   */
  function renderHitsPanel(): void {
    if (!rightPanel) return;
    const sorted = sortCardViews(lastHitViews, resultSortMode);
    const newPanel = renderResultsPanel(sorted, {
      onPick: (nodeId) => selectNodeFromPanel(nodeId),
      sortMode: resultSortMode,
      revealRows: true,
      onSortChange: (mode) => applySort(mode),
    });
    // 검색을 했으니 우측 패널을 표시한다(결과 0건이어도 빈 안내가 뜬다·§5).
    replaceRightPanel(newPanel);
    // 새로 그린 우측 패널에 현재 선택 색을 다시 입힌다(검색·정렬 후에도 선택 유지·§B-2).
    // 선택한 노드가 결과에 없으면 어느 행도 안 켜진다(no-op·일치만 켠다).
    applyResultsPanelSelection(rightPanel, selectedNodeId);
  }

  /**
   * 정렬 토글 콜백 — 정렬 모드를 갈고 보관한 hitViews 를 재정렬해 패널을 다시 그린다.
   * 서버를 다시 호출하지 않는다(클라이언트 재정렬·spec §8.1·결정 5).
   */
  function applySort(mode: ResultSortMode): void {
    resultSortMode = mode;
    renderHitsPanel();
  }

  function showSearchLoadingPanel(): void {
    if (!rightPanel) return;
    const panel = renderResultsLoadingPanel();
    replaceRightPanel(panel);
  }

  /**
   * 검색 모달 검색 payload 로 /graph/search 를 호출하고 그래프·우측 패널·Top3 를 갱신한다.
   * body 에는 payload 의 kind·subcategory(→filter)·since·until 을 값 있을 때만 합류한다 —
   * 넷 다 비면 옛 { query, limit } 호출과 같은 body 가 된다(백엔드 회귀 0·T3 정합).
   * subcategory 는 filter:{subcategory: 갈래값} 으로 보낸다 — retriever 는 키 이름을 무시하고
   * 값(갈래)을 개념 이름으로 매칭해 그 갈래 분류 링크가 있는 글만 통과시킨다(S7).
   * 옛 검색 오버레이 onSearch 클로저 본체를 그대로 옮긴 흐름(buildSearchViewModel·applyData·
   * applyFocus·hitViews·renderResultsPanel·applyResultsPanelSelection·top3).
   */
  async function runGraphSearch(payload: SearchModalSearchPayload): Promise<void> {
    // 검색 결과를 보는 동안엔 라이브 신호를 보류한다(박자 규칙) — 화면이 흔들리지 않게.
    isSearchMode = true;
    // 진행 중 overview refresh 가 검색 화면을 뒤늦게 덮지 못하게 무효화한다.
    overviewLoadSeq++;
    lastHitViews = [];
    top3Layer.clear();
    top3NodeIds = new Set();
    showSearchLoadingPanel();
    try {
      const body: Record<string, unknown> = {
        query: payload.query,
        limit: SEARCH_RESULT_LIMIT,
      };
      if (payload.kind) body["kind"] = payload.kind;
      if (payload.subcategory) body["filter"] = { subcategory: payload.subcategory };
      if (payload.since) body["since"] = payload.since;
      if (payload.until) body["until"] = payload.until;

      const resp = await apiFetch("/graph/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => String(resp.status));
        throw new Error(`검색 실패 (${resp.status}): ${detail}`);
      }
      const data = (await resp.json()) as GraphSearchApiResponse;
      const vm = buildSearchViewModel(data);
      currentVm = vm;
      bumpWindowRenderVersion();
      const degree = buildDegreeMap(vm.edges);
      const radii = new Map(vm.nodes.map((n) => [n.id, radiusOfSize(nodeSizeOf(n, degree.get(n.id) ?? 0))]));
      const positions = computeRadialLayout(vm.nodes, vm.edges, SEARCH_RADIAL_LAYOUT, radii);
      controller.applyData(vm, positions, { source: "search" });
      if (vm.search) {
        controller.applyFocus(vm.search);

        // 우측 결과 패널 갱신 — fromGraphHit 로 CardView 변환
        const hitViews: CardView[] = vm.search.hits.flatMap((hit) => {
          const node = vm.nodes.find((n) => n.id === hit.nodeId);
          if (!node) return []; // 노드 없으면 정직하게 건너뜀
          return [fromGraphHit(node, hit)];
        });

        // 새 검색 결과를 정렬 상태와 함께 보관하고(정렬 토글이 이 목록을 재정렬), 현재 모드로
        // 우측 패널을 그린다(§8.1). 행 클릭은 selectNodeFromPanel 단일 출처 흐름을 탄다(§B-2).
        lastHitViews = hitViews;
        renderHitsPanel();
        if (hitViews[0]) openOrFocusNode(hitViews[0].nodeId);

        // Top3 카드 — fromGraphHit 로 CardView 변환
        const top3Views: CardView[] = vm.search.top3.flatMap((ref) => {
          const node = vm.nodes.find((n) => n.id === ref.nodeId);
          if (!node) return []; // 노드 없으면 정직하게 건너뜀
          return [fromGraphHit(node, ref)];
        });
        top3NodeIds = new Set(top3Views.map((v) => v.nodeId));
        top3Layer.render(top3Views, (nodeId) => {
          actOnNode(nodeId);
        });
      }
    } catch (err) {
      console.error("[graph-entry] 검색 오류:", err);
      // 검색 실패 — 결과가 안 그려졌으니 overview 상태로 되돌린다(라이브 신호 보류 무한 고정 방지).
      isSearchMode = false;
    }
  }

  /**
   * 계산 결과를 우측 결과 패널에 표시한다(검색 hitViews 와 안 섞이는 별 경로).
   * 우측 패널을 "계산 결과" 헤더 + 결과 노드 body 로 갈아끼운다 — 검색 패널과 같은 자리를
   * 공유하되, 계산은 CardView 목록이 아니라 compute-tab 의 결과 노드(헤더·헤드라인·정직한
   * 부가 줄)를 그대로 받는다(세 경우 가름은 compute-tab.js 가 이미 정직하게 처리·응답 가공 0).
   */
  function showComputeResult(nodes: HTMLElement[]): void {
    if (!rightPanel) { console.error("[graph-entry] 계산 결과 표시 실패 — rightPanel 미초기화"); return; }
    const header = el("div", { className: "rp-header rp-compute-header" },
      el("span", { className: "rp-title" }, "계산 결과"));
    const body = el("div", { className: "rp-body rp-compute-body" }, ...nodes);
    const panel = el("aside", { className: "results-panel" }, header, body);
    replaceRightPanel(panel);
    // 계산 결과는 노드 선택과 무관하므로 우측 선택 색을 끈다(검색 행 selection 잔상 제거).
    applyResultsPanelSelection(rightPanel, null);
  }

  /**
   * 계산 실패를 우측 결과 패널에 정직하게 드러낸다(빈 위장 0·No-fallback).
   * localizeComputeError 산출(한국어 문구·원문 안 가림)을 받아 .rp-compute-error 로 보인다.
   */
  function showComputeError(message: string): void {
    if (!rightPanel) { console.error("[graph-entry] 계산 결과 표시 실패 — rightPanel 미초기화"); return; }
    const header = el("div", { className: "rp-header rp-compute-header" },
      el("span", { className: "rp-title" }, "계산 결과"));
    const body = el("div", { className: "rp-body rp-compute-body" },
      el("div", { className: "rp-compute-error" }, message));
    const panel = el("aside", { className: "results-panel" }, header, body);
    replaceRightPanel(panel);
  }

  // 종류 드롭다운 + 동적 칸 위젯(공용 picker·검색 모드). load() 가 종류 목록을 한 번 읽는다.
  // 실패 시 정직하게 드러내고 멈춘다(빈 종류 목록으로 위장하지 않음·No-fallback).
  const searchPicker = createEntityTypeFieldPicker({ apiBase: "", mode: "search" });
  searchPicker.load().catch((err: unknown) => {
    console.error("[graph-entry] 검색 모달 종류 목록 로드 오류:", err);
    // 빈 드롭다운으로 위장하지 않고 화면에 오류를 드러낸다(No-fallback·ingest-form.js 와 같은 양식).
    // search 모드는 fieldsEl 을 검색 모달에 안 붙이므로(하위분류로 대체), picker 의 전용 errorEl
    // (filterRow 에 항상 붙어 있는 자리)에 표시해야 사용자가 본다. 종류가 없는 건지 로드가
    // 실패한 건지 사용자가 구분할 수 있게 메시지로 드러낸다.
    searchPicker.showLoadError(
      `종류 목록을 불러오지 못했습니다: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  const overlayResult = renderSearchModal({
    picker: searchPicker,
    onSearch: (payload) => {
      void runGraphSearch(payload);
    },
    onCompute: () => {
      /* 계산 경로는 compute-panel 이 computeSlot 안에서 자체 버튼·postCompute 로 돈다 —
         search-modal 의 onCompute 콜백 통로는 쓰지 않는다(검색 경로 runGraphSearch 와 분리). */
    },
  });

  canvasContainer.appendChild(overlayResult.root);

  // ── 계산 탭 배선(compute-panel·검색 경로와 분리) ──────────────────────────
  // 검색 모달 [계산] 탭의 computeSlot 에 연산·숫자칸·분모 UI 를 마운트한다. 종류·숫자형 칸은
  // 검색과 같은 searchPicker 를 공유하고(공용 picker), 기간 두 칸도 검색·계산이 공유하는
  // 필터 행 값을 그대로 읽는다 — overlayResult.getPeriod() 가 기간 칸 두 개를 읽어 돌려준다.
  // 검색어도 같은 검색 입력칸을 공유한다 — overlayResult.getQueryText() 가 입력칸 값을 읽어
  // 돌려주고, 계산 버튼이 그 검색어(없으면 종류값)로 query 를 채워 /compute 의 query 필수
  // 게이트를 통과한다(빈 query 400 버그 차단).
  // 셀렉터 문자열은 search-modal 한 곳에만 둔다(compute-panel·graph-entry 는 DOM 을 직접 모른다·의존 방향 일방).
  mountComputePanel({
    slot: overlayResult.computeSlot,
    picker: searchPicker,
    apiBase: "",
    getPeriod: () => overlayResult.getPeriod(),
    getQueryText: () => overlayResult.getQueryText(),
    onResult: (nodes) => showComputeResult(nodes),
    onError: (message) => showComputeError(message),
  });

  // 검색 해제 → overview 복귀 + 카메라 전체 조망 복귀를 한 흐름으로 묶는다.
  // loadOverview 가 top3 를 끄고 우측 결과패널을 다시 숨기며(rp-hidden), 그 뒤
  // resetCameraToOverview 로 검색 때 확대됐던 카메라를 한 걸음 물린다.
  // ✕(지우기)와 빈 입력 Enter 가 같은 흐름에서 같이 들어와도 두 번 돌지 않게,
  // isSearchMode 를 동기적으로 먼저 내려 중복 트리거를 막는다.
  function returnToOverview(): void {
    if (!isSearchMode) return;
    isSearchMode = false;
    loadOverview()
      .then(() => controller.resetCameraToOverview())
      .catch((err) =>
        console.error("[graph-entry] overview 복귀 오류:", err),
      );
  }

  // 빈 입력 Enter → overview 복귀(박자 규칙 트리거).
  const searchInput = overlayResult.root.querySelector<HTMLInputElement>('input[type="search"]');
  searchInput?.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && searchInput.value.trim().length === 0) {
      returnToOverview();
    }
  });
  // 검색창 기본 ✕(지우기) 클릭 → type=search 의 네이티브 "search" 이벤트가 발화한다.
  // 값이 비워진 채 검색 중이었으면 overview 로 돌아간다(top3·결과패널·카메라 함께 복귀).
  searchInput?.addEventListener("search", () => {
    if (searchInput.value.trim().length === 0) returnToOverview();
  });

  // ── overview 재취득 함수(refreshGraph) ─────────────────────────────────────
  // 최초 로드·저장 후 재로드·graph_changed 수신·검색→overview 복귀가 모두 부른다. overview
  // 데이터를 다시 받아 applyData(diff 기반 전환)로 그래프가 자란다(2a 라이브 성장). 이름은
  // loadOverview 그대로 두되 역할은 "그래프를 정식 overview 데이터로 다시 받아 갱신"이다.
  let didFrameInitialOverview = false;
  async function loadOverview(): Promise<void> {
    const seq = ++overviewLoadSeq;
    try {
      const resp = await apiFetch(overviewEndpoint());
      if (!resp.ok) {
        const detail = await resp.text().catch(() => String(resp.status));
        throw new Error(`overview 로드 실패 (${resp.status}): ${detail}`);
      }
      const data = (await resp.json()) as GraphOverviewResponse;
      if (seq !== overviewLoadSeq) return;
      const vm = buildOverviewViewModel(data);
      const prevVm = currentVm;
      currentVm = vm;
      // 열린 창 전부를 재생성(본문 재타이핑)하지 않는다 — 창이 그리는 내용 서명
      // (노드 본문·메타·경로·관련 링크)이 실제로 달라진 창만 골라 무효화하고,
      // 서명 그대로인 창은 DOM 그대로 살아남는다(graph_changed 라이브 재로드가
      // 매번 모든 창을 갈아엎던 동작 제거).
      for (const nodeId of nodeWindowIdsNeedingRefresh(prevVm, vm, windowEls.keys())) {
        invalidateWindowElement(nodeId);
      }
      // 무효화한(내용 바뀐) 창은 그 자리에서 새 VM 내용으로 즉시 다시 만든다 —
      // 다음 상호작용까지 창이 사라진 채 남지 않게 한다.
      syncWindows();
      const degree = buildDegreeMap(vm.edges);
      const radii = new Map(vm.nodes.map((n) => [n.id, radiusOfSize(nodeSizeOf(n, degree.get(n.id) ?? 0))]));
      const positions = computeRadialLayout(vm.nodes, vm.edges, GRAPH_RENDER_THEME.radialLayout, radii);
      controller.applyData(vm, positions, { source: "overview" });
      const shouldFrameOverview = !didFrameInitialOverview || overviewFrameRequested;
      if (shouldFrameOverview) {
        didFrameInitialOverview = true;
        overviewFrameRequested = false;
        controller.resetCameraToOverview();
      }

      // overview 화면으로 돌아온 셈이라 검색 모드를 내리고, 보류해 둔 라이브 신호를 비운다(박자 규칙).
      isSearchMode = false;
      flushPendingLiveSignals();
      top3Layer.clear();
      top3NodeIds = new Set();
      // overview(검색 안 한 상태)에서는 우측 결과 패널을 숨긴다(검색했을 때만 표시·§5).
      // 초기 첫 loadOverview 에서도 숨겨지는데 이건 의도(초기 숨김)와 일치한다.
      rightPanel?.classList.add("rp-hidden");

      // 좌측 기억목록 패널 갱신 — 현재 탭으로 다시 정렬해 그린다.
      await rebuildMemoryPanel(vm);
    } catch (err) {
      console.error("[graph-entry] overview 로드 오류:", err);
    }
  }

  // ── 좌측 기억목록 패널 ─────────────────────────────────────────────────────
  // 패널은 VM 노드 전체에서 글(memory/document/image)만 골라 현재 탭 기준으로 정렬한다.
  // 탭은 패널이 보유하고, 누르면 같은 VM 으로 다시 정렬한다(서버 재요청 없음).
  let activePanelTab: MemoryPanelTab = "recent";

  async function fetchDateOccurrences(): Promise<DateOccurrencesResponse> {
    const resp = await apiFetch("/api/date-occurrences?days=90&pastDays=90&limit=80");
    if (!resp.ok) {
      const detail = await resp.text().catch(() => String(resp.status));
      throw new Error(`date-occurrences 로드 실패 (${resp.status}): ${detail}`);
    }
    return (await resp.json()) as DateOccurrencesResponse;
  }

  /** 현재 탭·VM 으로 목록 행을 다시 그리고 노드·엣지 수를 갱신한다. */
  async function rebuildMemoryPanel(vm: DashboardGraphViewModel): Promise<void> {
    const tabAtStart = activePanelTab;
    if (tabAtStart === "schedule") {
      try {
        const occurrences = await fetchDateOccurrences();
        if (activePanelTab !== tabAtStart) return;
        scheduleTargetNodes = new Map(
          [...occurrences.upcoming, ...occurrences.past].map((occ) => [
            occ.target.nodeId,
            syntheticNodeFromOccurrence(occ),
          ]),
        );
        memoryPanel.render(buildDateOccurrenceRows(occurrences));
      } catch (err) {
        console.error("[graph-entry] 날짜 발생 항목 로드 오류:", err);
        if (activePanelTab !== tabAtStart) return;
        scheduleTargetNodes = new Map();
        memoryPanel.render([]);
      }
    } else {
      const rows = buildMemoryListRows(vm.nodes, activePanelTab, new Date());
      memoryPanel.render(rows);
    }
    memoryPanel.setCounts(vm.nodes.length, vm.edges.length);
  }

  // 패널 생성 — onPick 은 controller 를 늦게 참조하는 클로저라 controller 선언 전에 만들어도
  // 호출 시점(사용자 클릭)엔 controller 가 있다(기존 left-list 와 같은 패턴). 그래프 선택+모달
  // 양방향 연동은 Stage 3 가 이 onPick 에 더 배선한다.
  const memoryPanel: MemoryPanel = createMemoryPanel({
    // 항목 클릭 → 그래프 비춤 + 큰 모달 + 선택 색(단일 출처 selectNodeFromPanel·§5.3 ①②③).
    onPick: (nodeId) => selectNodeFromPanel(nodeId),
    onTab: (tab) => {
      activePanelTab = tab;
      void rebuildMemoryPanel(currentVm);
    },
  }, { collapsed: narrowViewport.matches });

  // ── 우측 결과 패널 초기 상태 (빈 결과·숨김) ──────────────────────────────
  // 평소엔 숨기고 검색했을 때만 보인다(§5). DOM 자리는 유지하되 rp-hidden 으로 가린다
  // (onSearch 가 replaceWith 로 갱신하므로 자리만 유지하면 된다).
  const initialRightPanel = renderResultsPanel([], {
    onPick: (nodeId: string) => selectNodeFromPanel(nodeId),
  });
  initialRightPanel.classList.add("rp-hidden");
  rightPanel = initialRightPanel;

  // ── 하단 입력 폼 컨테이너 ─────────────────────────────────────────────────
  // 그래프 화면(shell-center) 안에 absolute 로 떠서 화면 하단 가운데에 카드처럼 얹는다.
  // 검색 모달(search-modal.ts)이 같은 부모 위에 absolute 로 떠 있는 것과 같은 방식.
  // 색·간격은 .graph-bottom-bar CSS 한 곳에서 토큰으로 적용한다.
  const bottomBar = document.createElement("div");
  bottomBar.className = "graph-bottom-bar";

  // ── 쉘 조립 ───────────────────────────────────────────────────────────────
  const shell = renderShell({
    rail: null,
    left: memoryPanel.root,
    center: canvasContainer,
    right: initialRightPanel,
    bottom: bottomBar,
  });

  mountRoot.appendChild(shell);

  // 폼이 줄바꿈되거나 계산/첨부 칸이 늘어나도 좁은 화면의 목록은 두 폼 사이에 둔다.
  const updatePanelInsets = (): void => {
    shell.style.setProperty("--graph-panel-top", `${overlayResult.root.offsetHeight + 24}px`);
    shell.style.setProperty("--graph-panel-bottom", `${bottomBar.offsetHeight + 32}px`);
  };
  const formResizeObserver = new ResizeObserver(updatePanelInsets);
  formResizeObserver.observe(overlayResult.root);
  formResizeObserver.observe(bottomBar);
  updatePanelInsets();
  narrowViewport.addEventListener("change", () => {
    if (narrowViewport.matches) memoryPanel.setCollapsed(true);
  });

  // ── Three.js 컨트롤러 초기화 ──────────────────────────────────────────────
  // canvasContainer 가 DOM 에 붙은 뒤에 초기화해야 renderer 크기 정합.
  const controller = new GraphController(canvasContainer);
  const top3Layer = createTop3Layer(canvasContainer, {
    getNodeScreenPosition: (id) => controller.getNodeScreenPosition(id),
    onFrame: (cb) => controller.onFrame(cb),
  });

  // 호버 요약 팁 — 마우스가 올라간 노드 옆에 작은 카드를 띄워 그 노드를 따라가게 한다.
  const hoverTip = createHoverTip(canvasContainer, {
    getNodeScreenPosition: (id) => controller.getNodeScreenPosition(id),
    onFrame: (cb) => controller.onFrame(cb),
  });
  controller.onHoverNode((nodeId) => {
    // 그 노드의 큰 상세 모달이 이미 열려 있으면 팁을 띄우지 않는다(중복 방지).
    // 모달이 여럿이라 windowEls 에 그 nodeId 창이 있는지로 가른다.
    // Top3 노드는 이미 떠 있는 카드가 있어 hover 팁을 띄우지 않는다(중복·위치 겹침 방지).
    if (nodeId == null || windowEls.has(nodeId) || top3NodeIds.has(nodeId)) {
      hoverTip.hide();
      return;
    }
    const node = currentVm.nodes.find((n) => n.id === nodeId);
    if (!node) {
      hoverTip.hide();
      return;
    }
    hoverTip.show(nodeId, memoryCard(fromGraphNode(node), "hover"));
  });

  // 그래프 노드 직접 클릭 → 3-상태(열기/맨앞/닫기) 단일 경로. 좌·우 목록 클릭과 같은 흐름.
  controller.onNodeClick((nodeId) => actOnNode(nodeId));

  // 창발(2d) 목표 노드가 아직 화면에 없을 때, controller 가 가짜 위치를 추정하지 않고 정식
  // overview 데이터를 다시 받으려고 부르는 콜백 — refreshGraph(=loadOverview)를 넘긴다.
  controller.onRefreshGraph(() => loadOverview());

  // ── 하단 폼: ingest-form.js 런타임 import ────────────────────────────────
  // ingest-form.js 는 브라우저 ESM 으로 사전 빌드된 파일이라 TS 번들에 포함하지 않고
  // 런타임에 /web/dashboard/ingest-form.js 로 동적 import 한다.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ingestFormUrl: string = "/web/dashboard/ingest-form.js";
  // TS 는 런타임 절대 URL import 를 타입 해석 못 하므로 Promise<any> 로 받는다.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  (import(/* @ts-ignore */ ingestFormUrl) as Promise<{ mountIngestForm?: (ctx: unknown) => void }>)
    .then((mod) => {
      if (typeof mod.mountIngestForm !== "function") {
        throw new Error("ingest-form.js: mountIngestForm 함수를 찾을 수 없습니다.");
      }
      mod.mountIngestForm({
        mountEl: bottomBar,
        apiBase: "",
        escapeHtml,
        // ui/dom.ts el 헬퍼를 주입한다(S8). ingest-form.js 는 빌드 없는 브라우저 ES 모듈이라
        // .ts 인 ui/dom.ts 를 직접 import 못 하므로, 미리보기 패널·칸 자동 표시 노드 조립에
        // 쓸 el 을 호출부가 넘긴다(ingest-preview·compute-tab 의 el 주입 선례와 같은 양식).
        el,
        onIngested: () => {
          requestOverviewCameraFrame();
          loadOverview().catch((e) =>
            console.error("[graph-entry] 저장 후 overview 재로드 오류:", e),
          );
        },
      });
    })
    .catch((err: unknown) => {
      console.error("[graph-entry] ingest-form 로드 오류:", err);
      const msg = document.createElement("p");
      msg.style.cssText = "color:var(--text-dim);font-size:var(--fs-sm);margin:4px 0";
      msg.textContent = `입력 폼 로드 실패: ${err instanceof Error ? err.message : String(err)}`;
      bottomBar.appendChild(msg);
    });

  // ── 초기 overview 로드 ────────────────────────────────────────────────────
  await loadOverview();

  // ── 라이브 성장 SSE 구독(2a·박자 규칙) ────────────────────────────────────
  // 끄기 스위치가 켜져 있을 때만 구독을 시작한다(꺼져 있으면 라이브 연출 통째 OFF).
  if (LIVE_GROWTH_ENABLED) {
    await subscribeLiveGrowth({
      controller,
      dispatchLiveSignal,
      refreshGraph: () => loadOverview(),
    });
  }
}

// ── SSE 구독 배선(2a·Task 8) ─────────────────────────────────────────────────

/**
 * 대시보드가 토큰을 받아 EventSource 로 /events/stream 을 듣고, 세 라이브 신호를 박자 규칙에
 * 맞춰 처리한다. 브라우저 EventSource 를 쓴다(봇의 fetch 스트림 파서를 베끼지 않는다).
 *  - graph_changed → refreshGraph(overview 재취득+applyData 로 자란다).
 *  - graph_merge   → controller.applyMerge(from, into)(흡수 연출).
 *  - graph_emerge  → controller.applyEmerge(nodeId, fromSources)(수렴+탄생 연출).
 * 연결 끊김은 EventSource 기본 자동 재연결에 맡기고, onerror 는 console 로 드러낸다(silent 금지).
 */
async function subscribeLiveGrowth(ctx: {
  controller: GraphController;
  dispatchLiveSignal: (apply: () => void) => void;
  refreshGraph: () => Promise<void>;
}): Promise<void> {
  const { controller, dispatchLiveSignal, refreshGraph } = ctx;

  // 토큰을 한 번 받아 EventSource query(?token=)로 넘긴다(EventSource 는 커스텀 헤더를 못 붙인다).
  const tokenResp = await apiFetch("/dashboard/sse-token");
  if (!tokenResp.ok) {
    const detail = await tokenResp.text().catch(() => String(tokenResp.status));
    // 토큰을 못 받으면 라이브 구독을 시작하지 않는다 — 정직하게 드러내고 멈춘다(가짜로 잇지 않음).
    console.error(`[graph-entry] SSE 토큰 발급 실패 (${tokenResp.status}): ${detail}`);
    return;
  }
  const { token } = (await tokenResp.json()) as SseTokenResponse;

  const source = new EventSource(`/events/stream?token=${encodeURIComponent(token)}`);

  source.addEventListener(SSE_EVENT_GRAPH_CHANGED, () => {
    // 새 글이 저장됐다는 신호 — overview 를 다시 받아 그래프가 자란다. 박자 규칙을 거친다.
    dispatchLiveSignal(() => {
      refreshGraph().catch((e: unknown) =>
        console.error("[graph-entry] graph_changed refreshGraph 오류:", e),
      );
    });
  });

  source.addEventListener(SSE_EVENT_GRAPH_MERGE, (ev: MessageEvent) => {
    const payload = parseSsePayload<GraphMergePayload>(ev.data, "graph_merge");
    if (!payload) return;
    dispatchLiveSignal(() => controller.applyMerge(payload.from, payload.into));
  });

  source.addEventListener(SSE_EVENT_GRAPH_EMERGE, (ev: MessageEvent) => {
    const payload = parseSsePayload<GraphEmergePayload>(ev.data, "graph_emerge");
    if (!payload) return;
    dispatchLiveSignal(() => controller.applyEmerge(payload.nodeId, payload.fromSources));
  });

  source.onerror = (ev: Event): void => {
    // EventSource 는 끊기면 스스로 다시 잇는다 — 막지 않고 사실만 드러낸다(silent 금지).
    console.error("[graph-entry] SSE 연결 오류(자동 재연결 시도 중):", ev);
  };
}

/** SSE data 필드 JSON 을 파싱한다. 깨졌으면 null 을 돌리고 console 에 드러낸다(silent 금지). */
function parseSsePayload<T>(data: string, label: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch (err) {
    console.error(`[graph-entry] ${label} payload 파싱 오류:`, err, data);
    return null;
  }
}

main().catch((err: unknown) => {
  console.error("[graph-entry] 초기화 오류:", err);
  const root = document.getElementById("graph-root");
  if (root) {
    const p = document.createElement("p");
    p.style.cssText = "color:var(--text-dim,#aaa);padding:32px;font-family:sans-serif";
    p.textContent = `그래프 초기화 오류: ${
      err instanceof Error ? err.message : String(err)
    }`;
    root.appendChild(p);
  }
});
