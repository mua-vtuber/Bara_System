/**
 * web/dashboard/graph/shell/memory-panel-data.ts
 * 좌측 기억목록 패널의 순수 로직 — 필터·세 정렬·상대 시각·탭 매핑·VM→목록항목 변환.
 * DOM 을 만들지 않는다(memory-panel.ts 가 이 결과를 받아 그린다). 단위 테스트 대상.
 */
import type { GraphNode } from "../graph-view-model.ts";
import { displayTitleForNode } from "../../ui/hashtag-display.ts";
import { memoryNumberFromNodeKey } from "../../ui/memory-number.ts";

/** 패널이 다루는 정렬 탭. */
export type MemoryPanelTab = "recent" | "schedule" | "accessed";

/** 목록 한 줄을 그리는 데 필요한 값. divider 는 "지난" 구분 행(비클릭). */
export interface MemoryListItem {
  kind: "item";
  nodeId: string;
  /** 기억 번호(knowledge_nodes.id). 글 노드("node:N")만 있다. */
  memoryId?: number;
  label: string;
  /** 노드 종류(글/문서/이미지) — 보조 종류 표기용. */
  type: GraphNode["type"] | string;
  /** type 대신 직접 표시할 짧은 배지. 일정 발생 항목이 role 을 표시할 때 쓴다. */
  badge?: string;
  /** 우측 보조 시각 표기. 탭별로 상대 시각 또는 절대 날짜. 값 없으면 "—". */
  stat: string;
}

/** 일정 탭에서 다가오는 일정과 지난 일정을 가르는 구분 행. */
export interface MemoryListDivider {
  kind: "divider";
  label: string;
}

export type MemoryListRow = MemoryListItem | MemoryListDivider;

export interface DateOccurrenceTarget {
  nodeId: string;
  type: string;
  id: string | number;
  label: string;
}

export interface DateOccurrence {
  kind: "event" | "birthday" | "column_date";
  date: string;
  dateTime?: string;
  endDateTime?: string;
  columnKey?: string;
  role: "event" | "birthday" | "expiration" | "generic";
  title: string;
  target: DateOccurrenceTarget;
  originalDateText?: string;
}

export interface DateOccurrencesResponse {
  upcoming: DateOccurrence[];
  past: DateOccurrence[];
  window: {
    today: string;
    until: string;
    pastSince: string;
    days: number;
    pastDays: number;
  };
  generatedAt: string;
}

/**
 * 목록에 넣을 글 노드 type 의 허용 집합(§5.4 단일 출처).
 * 제외 목록을 나열하지 않고 이 집합에 드는지로만 판정한다.
 */
export const MEMORY_LIST_TYPES: ReadonlySet<GraphNode["type"]> = new Set([
  "memory",
  "document",
  "image",
]);

/** 목록 상한 — 훑기용이라 전체 나열이 목적이 아니다(§5.5). */
export const MEMORY_LIST_LIMIT = 40 as const;

/**
 * 세 정렬 기준이 의미 있는 글 노드만 목록에 넣는다(§5.4).
 * 허용 집합(memory/document/image)에 드는지로 판정.
 */
export function isMemoryListNode(node: GraphNode): boolean {
  return MEMORY_LIST_TYPES.has(node.type);
}

/**
 * ISO 시각 문자열을 밀리초로 바꾼다. 없거나 깨지면 null(정렬에서 뒤로 밀거나 제외).
 * 가짜 값(0·오늘)으로 채우지 않는다.
 */
function parseTime(iso: string | undefined): number | null {
  if (iso == null || iso.length === 0) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * id 내림차순 비교 — 동률(같은 정렬값)일 때 최신 글이 위로 오게 하는 안정 보조 키.
 * id 는 "node:42" 처럼 접두사+숫자라 문자열 비교로도 일관된 순서를 준다.
 */
function compareIdDesc(a: GraphNode, b: GraphNode): number {
  if (a.id < b.id) return 1;
  if (a.id > b.id) return -1;
  return 0;
}

/**
 * 시각 키(내림차순) 정렬 — 값 있는 항목이 위, 없는 항목은 뒤로.
 * 같은 값이면 id 내림차순으로 안정 정렬한다.
 */
function sortByTimeDesc(
  nodes: GraphNode[],
  pick: (n: GraphNode) => string | undefined,
): GraphNode[] {
  return [...nodes].sort((a, b) => {
    const ta = parseTime(pick(a));
    const tb = parseTime(pick(b));
    if (ta == null && tb == null) return compareIdDesc(a, b);
    if (ta == null) return 1; // a 를 뒤로
    if (tb == null) return -1; // b 를 뒤로
    if (tb !== ta) return tb - ta; // 최신이 위
    return compareIdDesc(a, b);
  });
}

/** 로컬 자정(00:00) 밀리초 — "오늘" 경계. 시각이 아니라 날짜 단위 비교(§5.5). */
export function localMidnight(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** 최근기억 — createdAt 내림차순(§5.5). */
export function sortRecent(nodes: GraphNode[]): GraphNode[] {
  return sortByTimeDesc(nodes, (n) => n.createdAt);
}

/** 최근열람 — lastAccessedAt 내림차순(§5.5). */
export function sortAccessed(nodes: GraphNode[]): GraphNode[] {
  return sortByTimeDesc(nodes, (n) => n.lastAccessedAt);
}

/** 일정 정렬 결과 — 다가오는 묶음·지난 묶음을 따로 돌려준다(구분 행은 호출부가 끼운다). */
export interface ScheduleSplit {
  upcoming: GraphNode[];
  past: GraphNode[];
}

/**
 * 일정(§5.5) — eventAt 있는 글만. 다가오는 일정(eventAt >= 오늘)은 오름차순(가까운 미래가 위),
 * 지난 일정(eventAt < 오늘)은 내림차순(가장 최근에 지난 것이 위). 오늘 경계는 로컬 자정.
 * eventAt 없는 글은 제외(가짜 값으로 채우지 않는다).
 */
export function splitSchedule(nodes: GraphNode[], now: Date): ScheduleSplit {
  const today = localMidnight(now);
  const upcoming: GraphNode[] = [];
  const past: GraphNode[] = [];
  for (const node of nodes) {
    const ev = parseTime(node.eventAt);
    if (ev == null) continue; // 일정 탭에서 제외
    if (ev >= today) upcoming.push(node);
    else past.push(node);
  }
  upcoming.sort((a, b) => {
    const ea = parseTime(a.eventAt)!;
    const eb = parseTime(b.eventAt)!;
    if (ea !== eb) return ea - eb; // 가까운 미래가 위(오름차순)
    return compareIdDesc(a, b);
  });
  past.sort((a, b) => {
    const ea = parseTime(a.eventAt)!;
    const eb = parseTime(b.eventAt)!;
    if (eb !== ea) return eb - ea; // 가장 최근에 지난 것이 위(내림차순)
    return compareIdDesc(a, b);
  });
  return { upcoming, past };
}

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * 상대 시각 표기(§5.6) — "방금"/"N분 전"/"N시간 전"/"N일 전". 값 없거나 깨지면 "—".
 * 가짜 시각을 만들지 않는다. 미래 시각은 "방금"으로 접는다(상대 표기 탭은 과거만 의미).
 */
export function relativeTimeLabel(iso: string | undefined, now: Date): string {
  const t = parseTime(iso);
  if (t == null) return "—";
  const diff = now.getTime() - t;
  if (diff < MS_PER_MINUTE) return "방금";
  if (diff < MS_PER_HOUR) return `${Math.floor(diff / MS_PER_MINUTE)}분 전`;
  if (diff < MS_PER_DAY) return `${Math.floor(diff / MS_PER_HOUR)}시간 전`;
  return `${Math.floor(diff / MS_PER_DAY)}일 전`;
}

/**
 * 절대 날짜 표기(§5.6·일정 탭) — "YYYY-MM-DD". 값 없거나 깨지면 "—".
 * 로컬 날짜로 그린다(자정 경계와 같은 기준).
 */
export function absoluteDateLabel(iso: string | undefined): string {
  const t = parseTime(iso);
  if (t == null) return "—";
  const d = new Date(t);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 글 노드 한 개를 목록 항목으로 바꾼다(보조 표기는 탭에 따라 다르다). */
function toItem(node: GraphNode, stat: string): MemoryListItem {
  return {
    kind: "item",
    nodeId: node.id,
    memoryId: memoryNumberFromNodeKey(node.id),
    label: displayTitleForNode(node),
    type: node.type,
    stat,
  };
}

function occurrenceBadge(occ: DateOccurrence): string {
  if (occ.role === "event") return "일정";
  if (occ.role === "expiration") return "만료";
  if (occ.role === "birthday") return "생일";
  return occ.columnKey ?? "날짜";
}

function occurrenceToItem(occ: DateOccurrence): MemoryListItem {
  return {
    kind: "item",
    nodeId: occ.target.nodeId,
    memoryId: memoryNumberFromNodeKey(occ.target.nodeId),
    label: occ.title,
    type: occ.target.type,
    badge: occurrenceBadge(occ),
    stat: occ.date,
  };
}

/** 새 날짜 발생 API 응답을 일정탭 목록 행으로 바꾼다. 미래는 API 정렬 그대로, 과거도 API 정렬 그대로 쓴다. */
export function buildDateOccurrenceRows(resp: DateOccurrencesResponse): MemoryListRow[] {
  const rows: MemoryListRow[] = [];
  for (const occ of resp.upcoming) rows.push(occurrenceToItem(occ));
  if (resp.past.length > 0) {
    rows.push({ kind: "divider", label: "지난" });
    for (const occ of resp.past) rows.push(occurrenceToItem(occ));
  }
  return rows;
}

/**
 * VM 노드 전체를 현재 탭 기준으로 필터·정렬해 목록 행 배열을 만든다(§5.4~5.6).
 * - 최근기억·최근열람: 상대 시각 표기, 40개 상한.
 * - 일정: 다가오는 일정 위 + "지난" 구분 행 + 지난 일정, 글 40개 상한(구분 행은 수에 안 셈).
 */
export function buildMemoryListRows(
  nodes: GraphNode[],
  tab: MemoryPanelTab,
  now: Date,
): MemoryListRow[] {
  const pool = nodes.filter(isMemoryListNode);

  if (tab === "recent") {
    return sortRecent(pool)
      .slice(0, MEMORY_LIST_LIMIT)
      .map((n) => toItem(n, relativeTimeLabel(n.createdAt, now)));
  }

  if (tab === "accessed") {
    return sortAccessed(pool)
      .slice(0, MEMORY_LIST_LIMIT)
      .map((n) => toItem(n, relativeTimeLabel(n.lastAccessedAt, now)));
  }

  // schedule — 다가오는 + "지난" 구분 행 + 지난. 글 40개를 센다(구분 행 제외).
  const { upcoming, past } = splitSchedule(pool, now);
  const rows: MemoryListRow[] = [];
  let count = 0;
  for (const n of upcoming) {
    if (count >= MEMORY_LIST_LIMIT) break;
    rows.push(toItem(n, absoluteDateLabel(n.eventAt)));
    count += 1;
  }
  if (past.length > 0 && count < MEMORY_LIST_LIMIT) {
    rows.push({ kind: "divider", label: "지난" });
    for (const n of past) {
      if (count >= MEMORY_LIST_LIMIT) break;
      rows.push(toItem(n, absoluteDateLabel(n.eventAt)));
      count += 1;
    }
  }
  return rows;
}

/** 행 배열에서 클릭 가능한 항목(글) 수를 센다 — "기억 목록 N" 라벨용(구분 행 제외). */
export function countItems(rows: MemoryListRow[]): number {
  let n = 0;
  for (const row of rows) if (row.kind === "item") n += 1;
  return n;
}
