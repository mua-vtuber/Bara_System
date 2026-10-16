/**
 * apps/memory/web/dashboard/ui/memory-info.ts
 *
 * 기억 상세의 "정보" 블록 — 장소·시각(출처 포함)·작성자·저장 경로를 한곳에 모은다.
 * 의미추출 섹션과 같은 접힘 요소(<details class="node-window__extracts">)·같은 CSS 를 쓰며
 * 기본으로 접혀 있다. 기억 번호(#87)는 접히지 않는 상세 윗줄 배지에 따로 보인다.
 *
 * 값의 출처:
 *   - 장소·시각 출처 = knowledge_nodes.metadata.fieldSources.{place,event_at,event_until}
 *     (direct=직접 입력 / system=추출 / inferred=추론 — memory/field-provenance.ts)
 *   - 작성자 = knowledge_nodes.author, 저장 경로 = knowledge_nodes.platform
 *   - 장소 이름 = GET /memories/:id 의 places/place (memory/node-places.ts)
 * 없는 값은 "없음", 출처 기록이 없는 값은 "출처 기록 없음"으로 정직하게 보인다.
 */

import { el } from "./dom.ts";

export type FieldSourceKey = "direct" | "system" | "inferred";

export interface MemoryInfo {
  /** 장소 이름 전부. 없으면 빈 배열. */
  places: string[];
  placeSource?: FieldSourceKey;
  eventAt?: string | null;
  eventUntil?: string | null;
  eventAtSource?: FieldSourceKey;
  eventUntilSource?: FieldSourceKey;
  author: string;
  platform: string;
}

const FIELD_SOURCE_LABELS: Record<FieldSourceKey, string> = {
  direct: "직접 입력",
  system: "추출",
  inferred: "추론",
};

/**
 * 저장 경로(knowledge_nodes.platform) → 사람이 읽는 이름.
 * 값은 각 저장 통로가 실제로 쓰는 것: MCP_SOURCE "mcp", 펫 source "pet", 대시보드 입력창
 * "dashboard:manual"·REST "dashboard", 디스코드 봇 "discord"·"discord-dm"·"discord-channel".
 * 모르는 값은 그대로 보여 준다.
 */
const PLATFORM_LABELS: Record<string, string> = {
  mcp: "AI 앱(MCP)",
  pet: "펫 앱",
  dashboard: "대시보드",
  "dashboard:manual": "대시보드",
  discord: "디스코드",
  "discord-dm": "디스코드(DM)",
  "discord-channel": "디스코드(채널)",
  api: "외부 API",
};

export function fieldSourceLabel(source: string | undefined): string | undefined {
  return source === "direct" || source === "system" || source === "inferred"
    ? FIELD_SOURCE_LABELS[source]
    : undefined;
}

export function platformLabel(platform: string | null | undefined): string | undefined {
  const raw = typeof platform === "string" ? platform.trim() : "";
  if (raw.length === 0) return undefined;
  return PLATFORM_LABELS[raw.toLowerCase()] ?? raw;
}

function sourceKey(value: unknown): FieldSourceKey | undefined {
  return value === "direct" || value === "system" || value === "inferred" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * GET /memories/:id 의 memory 객체 → MemoryInfo.
 * 목록 응답처럼 작성자·저장 경로·metadata 칸이 아예 없는 요약이면 undefined — 없는 값을
 * "없음"으로 오해하지 않게 한다(상세를 불러온 뒤에만 정보가 생긴다).
 */
export function memoryInfoFromMemory(source: object): MemoryInfo | undefined {
  const memory = source as Record<string, unknown>;
  if (!("author" in memory) && !("platform" in memory) && !("metadata" in memory)) return undefined;
  const sources = isRecord(memory["metadata"]) && isRecord(memory["metadata"]["fieldSources"])
    ? memory["metadata"]["fieldSources"] : {};
  const places = Array.isArray(memory["places"])
    ? memory["places"].filter((p): p is string => typeof p === "string" && p.length > 0)
    : typeof memory["place"] === "string" && memory["place"].length > 0 ? [memory["place"]] : [];
  const str = (v: unknown): string | null | undefined =>
    typeof v === "string" ? v : v === null ? null : undefined;
  return {
    places,
    placeSource: sourceKey(sources["place"]),
    eventAt: str(memory["eventAt"]),
    eventUntil: str(memory["eventUntil"]),
    eventAtSource: sourceKey(sources["event_at"]),
    eventUntilSource: sourceKey(sources["event_until"]),
    author: typeof memory["author"] === "string" ? memory["author"] : "",
    platform: typeof memory["platform"] === "string" ? memory["platform"] : "",
  };
}

const EMPTY = "없음";
const NO_SOURCE = "출처 기록 없음";

function withSource(value: string, label: string | undefined): string {
  return `${value} · ${label ?? NO_SOURCE}`;
}

function placeText(info: MemoryInfo): string {
  if (info.places.length === 0) return EMPTY;
  return withSource(info.places.join(", "), fieldSourceLabel(info.placeSource));
}

function timeText(info: MemoryInfo): string {
  if (!info.eventAt) return EMPTY;
  const start = info.eventAt;
  const startLabel = fieldSourceLabel(info.eventAtSource);
  if (!info.eventUntil) return withSource(start, startLabel);
  const endLabel = fieldSourceLabel(info.eventUntilSource);
  const range = `${start} → ${info.eventUntil}`;
  if (startLabel === endLabel) return withSource(range, startLabel);
  return `${range} · 시작 ${startLabel ?? NO_SOURCE} / 종료 ${endLabel ?? NO_SOURCE}`;
}

/** 정보 행 목록(<dl>). 칸마다 dt(이름)/dd(값) 한 쌍. */
export function memoryInfoList(info: MemoryInfo): HTMLElement {
  const platform = platformLabel(info.platform);
  const rows: Array<[string, string, string | undefined]> = [
    ["장소", placeText(info), undefined],
    ["시각", timeText(info), undefined],
    ["작성자", info.author.trim().length > 0 ? info.author : EMPTY, undefined],
    ["저장 경로", platform ?? EMPTY, platform !== undefined && platform !== info.platform ? info.platform : undefined],
  ];
  return el(
    "dl",
    { className: "memory-info__list" },
    ...rows.map(([label, value, raw]) =>
      el(
        "div",
        { className: "memory-info__row" },
        el("dt", { className: "memory-info__label" }, label),
        el("dd", { className: "memory-info__value", title: raw }, value),
      ),
    ),
  );
}

export interface MemoryInfoSectionOptions {
  /** 이미 가진 정보. 있으면 바로 그린다. */
  info?: MemoryInfo;
  /** 정보가 없을 때 처음 펼치는 순간 한 번 불러온다(실패하면 다음에 펼칠 때 다시 시도). */
  load?: () => Promise<MemoryInfo | undefined>;
}

/**
 * "정보" 접힘 섹션. 의미추출(<details class="node-window__extracts">)과 같은 요소·CSS 를 쓰고
 * 기본은 접힘. info 도 load 도 없으면 null(그릴 정보가 없다).
 */
export function memoryInfoSection(options: MemoryInfoSectionOptions): HTMLElement | null {
  const { info, load } = options;
  if (info === undefined && load === undefined) return null;

  const body = el("div", { className: "memory-info__body" });
  const details = el(
    "details",
    { className: "node-window__extracts memory-info" },
    el("summary", { className: "node-window__extracts-summary" }, "정보"),
    body,
  );

  let loaded = false;
  let loading = false;
  const show = (data: MemoryInfo): void => {
    loaded = true;
    body.replaceChildren(memoryInfoList(data));
  };
  const note = (text: string): void => {
    body.replaceChildren(el("p", { className: "memory-info__note", role: "status" }, text));
  };

  if (info !== undefined) {
    show(info);
    return details;
  }

  details.addEventListener("toggle", () => {
    if (!details.open || loaded || loading || load === undefined) return;
    loading = true;
    note("불러오는 중…");
    void load()
      .then((data) => {
        if (data === undefined) note("정보를 확인할 수 없습니다.");
        else show(data);
      })
      .catch(() => note("정보를 불러오지 못했습니다. 접었다가 다시 펼치면 다시 시도합니다."))
      .finally(() => { loading = false; });
  });
  return details;
}
