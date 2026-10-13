/**
 * web/dashboard/graph/shell/search/search-modal.ts
 * 그래프 상단 검색 모달 — 옛 검색 오버레이를 흡수·확장한다(spec §7.1).
 * [검색][계산] 탭 행 + 필터 행(공용 picker + 하위분류 + 기간 date 두 칸) + 입력 행.
 * onSearch(검색)·onCompute(계산) 콜백을 분리해 계산이 검색 코드에 안 섞인다(회귀 안전).
 * 레이아웃 클래스(.so-tab-row·.so-filter-row·.so-date·.so-input-row)는 forms.css 가 입힌다.
 */
import { el } from "../dom.ts";
import type { FieldPicker } from "../entity-type-field-picker.ts";

export interface SearchModalSearchPayload {
  query: string;
  mode: "search";
  kind?: string;
  /** 하위분류 단일 갈래(S7) — 검색이 filter 값으로 보낸다. 빈 선택이면 키 없음. */
  subcategory?: string;
  since?: string;
  until?: string;
}

export interface SearchModalComputePayload {
  query?: string;
  kind?: string;
  op: string;
  field?: string;
  divisor?: string;
  since?: string;
  until?: string;
}

export interface SearchModalHandlers {
  picker: FieldPicker;
  onSearch: (payload: SearchModalSearchPayload) => void;
  onCompute: (payload: SearchModalComputePayload) => void;
}

export interface SearchModalResult {
  root: HTMLElement;
  /** 계산 탭 패널을 끼울 컨테이너(T5 compute-panel 이 채운다). */
  computeSlot: HTMLElement;
  getActiveMode: () => "search" | "compute";
  /** 검색·계산이 공유하는 기간 두 칸의 현재 값. trim 후 빈 값이면 키를 뺀다. */
  getPeriod: () => { since?: string; until?: string };
  /** 검색 입력칸의 현재 검색어(계산 탭이 query 를 채울 때 읽는다·getPeriod 와 같은 양식). */
  getQueryText: () => string;
}

export function renderSearchModal(handlers: SearchModalHandlers): SearchModalResult {
  const { picker, onSearch } = handlers;
  let activeMode: "search" | "compute" = "search";

  // ── 탭 행 ──
  const searchTab = el(
    "button",
    { type: "button", className: "query-tab active", dataset: { soTab: "search" } },
    "검색",
  ) as HTMLButtonElement;
  const computeTab = el(
    "button",
    { type: "button", className: "query-tab", dataset: { soTab: "compute" } },
    "계산",
  ) as HTMLButtonElement;
  const tabRow = el("div", { className: "so-tab-row query-tabs" }, searchTab, computeTab);

  // ── 필터 행 (picker + 하위분류 + 기간 두 칸) ──
  // filterRow(종류 picker + 하위분류 + 기간)는 검색·계산 두 모드가 공유한다 — 계산 탭도
  // 같은 종류·기간으로 좁힌다(기간 값을 onCompute 로 잇는 배선은 T5 compute-panel 이 한다).
  const sinceEl = el("input", {
    type: "date",
    className: "so-date",
    dataset: { soSince: "1" },
    "aria-label": "기간 시작",
  }) as HTMLInputElement;
  const untilEl = el("input", {
    type: "date",
    className: "so-date",
    dataset: { soUntil: "1" },
    "aria-label": "기간 끝",
  }) as HTMLInputElement;
  // 칸 입력 자리에 하위분류 단일 드롭다운을 끼운다(S7·사용자 결정 — 검색 탭 칸 입력 제거).
  // ingest 칸 입력(picker.fieldsEl)·계산 탭 숫자칸은 그대로다(검색 탭만 하위분류로 대체).
  // picker.errorEl 도 같이 붙인다 — search 모드는 fieldsEl 을 안 붙이므로, 종류 목록 로드
  // 실패를 사용자가 보려면 항상 화면에 붙는 이 자리에 에러가 떠야 한다(No-fallback·평소 :empty 숨김).
  const filterRow = el(
    "div",
    { className: "so-filter-row" },
    picker.selectEl,
    picker.subcategorySelectEl,
    sinceEl,
    el("span", { className: "ingest-event-sep" }, "~"),
    untilEl,
    picker.errorEl,
  );

  // ── 입력 행 (검색 input + 버튼) — 옛 검색 오버레이 입력 한 줄을 흡수 ──
  const input = el("input", {
    type: "search",
    placeholder: "검색 (예: 어제 꿈 / 친구 이름 / 일정)",
    autocomplete: "off",
    className: "so-input",
  }) as HTMLInputElement;
  const searchBtn = el(
    "button",
    { type: "button", className: "so-search-btn", dataset: { soSearchBtn: "1" } },
    "검색",
  ) as HTMLButtonElement;
  const inputRow = el("div", { className: "so-input-row" }, input, searchBtn);

  // ── 계산 패널 자리(T5 가 채운다) — 검색 모드면 숨김 ──
  const computeSlot = el("div", { className: "so-compute-slot", style: "display:none" });

  function buildSearchPayload(): SearchModalSearchPayload | null {
    const q = input.value.trim();
    if (q.length === 0) return null;
    const payload: SearchModalSearchPayload = { query: q, mode: "search" };
    const kind = picker.getKind();
    if (kind) payload.kind = kind;
    // 하위분류 단일 갈래(S7) — 고른 갈래만 합류(빈 선택이면 키 없음). 칸 입력은 검색 탭에서 빠졌다.
    const sub = picker.getSubcategory();
    if (sub) payload.subcategory = sub;
    const since = sinceEl.value.trim();
    if (since) payload.since = since;
    const until = untilEl.value.trim();
    if (until) payload.until = until;
    return payload;
  }

  function triggerSearch(): void {
    const payload = buildSearchPayload();
    if (payload) onSearch(payload);
  }

  // 기간 두 칸의 현재 값 — 셀렉터 문자열은 search-modal 한 곳에만 두고, 호출부(검색·계산)는
  // 이 메서드로만 읽는다(DOM 셀렉터 결합 제거).
  function getPeriod(): { since?: string; until?: string } {
    const since = sinceEl.value.trim();
    const until = untilEl.value.trim();
    return {
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
    };
  }

  // 검색 입력칸의 현재 검색어 — 셀렉터·DOM 결합을 search-modal 한 곳에만 두고, 계산 탭은
  // 이 메서드로만 읽는다(getPeriod 와 같은 양식·compute-panel 은 input DOM 을 직접 모른다).
  function getQueryText(): string {
    return input.value.trim();
  }

  searchBtn.addEventListener("click", triggerSearch);
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") triggerSearch();
  });

  function setMode(mode: "search" | "compute"): void {
    activeMode = mode;
    searchTab.classList.toggle("active", mode === "search");
    computeTab.classList.toggle("active", mode === "compute");
    computeSlot.style.display = mode === "compute" ? "" : "none";
    // 계산 탭에서는 검색 입력 행을 숨긴다. filterRow(종류 picker + 기간)는 일부러 그대로 둔다 —
    // 검색·계산 두 모드가 공유하는 좁힘 조건이기 때문(기간을 onCompute 로 잇는 배선은 compute-panel 몫).
    inputRow.style.display = mode === "compute" ? "none" : "";
    // 하위분류 드롭다운은 검색 전용이다(S7·사용자 결정 — 계산은 하위분류 안 씀). 계산 탭에서는
    // 숨겨 종류·기간만 공유하는 좁힘 조건으로 둔다(계산 경로는 picker.getSubcategory 를 안 읽는다).
    picker.subcategorySelectEl.style.display = mode === "compute" ? "none" : "";
  }
  searchTab.addEventListener("click", () => setMode("search"));
  computeTab.addEventListener("click", () => setMode("compute"));

  const root = el(
    "div",
    { className: "search-modal" },
    tabRow,
    filterRow,
    inputRow,
    computeSlot,
  );

  return { root, computeSlot, getActiveMode: () => activeMode, getPeriod, getQueryText };
}
