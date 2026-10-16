/**
 * memory-panel-data.test.ts — 좌측 기억목록 패널 순수 로직 검증.
 * 필터·세 정렬·일정 미래/과거 가르기·상대 시각·탭 매핑을 데이터 fixture 로 검사한다.
 * Mock 클래스 없음 — GraphNode 데이터를 직접 넣어 출력만 본다.
 */
import { test, expect } from "bun:test";
import type { GraphNode } from "../graph-view-model.ts";
import {
  MEMORY_LIST_TYPES,
  isMemoryListNode,
  sortRecent,
  sortAccessed,
  splitSchedule,
  localMidnight,
  relativeTimeLabel,
  absoluteDateLabel,
  buildDateOccurrenceRows,
  buildMemoryListRows,
  countItems,
} from "./memory-panel-data.ts";

/** 최소 GraphNode fixture — 테스트가 쓰는 필드만 채우고 나머지는 기본값. */
function node(partial: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    type: "memory",
    label: partial.id,
    ...partial,
  } as GraphNode;
}

// ── 필터 ──────────────────────────────────────────────────────────────────────
test("isMemoryListNode — memory/document/image 만 통과, 나머지 제외", () => {
  expect(isMemoryListNode(node({ id: "a", type: "memory" }))).toBe(true);
  expect(isMemoryListNode(node({ id: "b", type: "document" }))).toBe(true);
  expect(isMemoryListNode(node({ id: "c", type: "image" }))).toBe(true);
  for (const t of [
    "concept",
    "tag",
    "classification_key",
    "entity_group",
    "person",
    "project",
    "creature",
    "work",
    "document_chunk",
    "image_caption",
    "llm_extract",
    "decision",
    "unknown",
  ] as const) {
    expect(isMemoryListNode(node({ id: t, type: t }))).toBe(false);
  }
});

test("MEMORY_LIST_TYPES 는 정확히 세 type 단일 출처", () => {
  expect(MEMORY_LIST_TYPES.size).toBe(3);
  expect([...MEMORY_LIST_TYPES].sort()).toEqual(["document", "image", "memory"]);
});

// ── 최근기억 정렬 ─────────────────────────────────────────────────────────────
test("sortRecent — createdAt 내림차순(최신 위), 없는 값은 뒤로", () => {
  const out = sortRecent([
    node({ id: "node:1", createdAt: "2026-06-10T00:00:00Z" }),
    node({ id: "node:2", createdAt: "2026-06-18T00:00:00Z" }),
    node({ id: "node:3" }), // createdAt 없음 → 뒤로
    node({ id: "node:4", createdAt: "2026-06-14T00:00:00Z" }),
  ]);
  expect(out.map((n) => n.id)).toEqual(["node:2", "node:4", "node:1", "node:3"]);
});

test("sortRecent — 같은 createdAt 이면 id 내림차순 안정 정렬", () => {
  const out = sortRecent([
    node({ id: "node:10", createdAt: "2026-06-10T00:00:00Z" }),
    node({ id: "node:20", createdAt: "2026-06-10T00:00:00Z" }),
  ]);
  expect(out.map((n) => n.id)).toEqual(["node:20", "node:10"]);
});

// ── 최근열람 정렬 ─────────────────────────────────────────────────────────────
test("sortAccessed — lastAccessedAt 내림차순, 없는 값은 뒤로", () => {
  const out = sortAccessed([
    node({ id: "node:1", lastAccessedAt: "2026-06-01T00:00:00Z" }),
    node({ id: "node:2" }),
    node({ id: "node:3", lastAccessedAt: "2026-06-15T00:00:00Z" }),
  ]);
  expect(out.map((n) => n.id)).toEqual(["node:3", "node:1", "node:2"]);
});

// ── 일정 미래/과거 가르기 ─────────────────────────────────────────────────────
test("splitSchedule — 다가오는 일정 오름차순·지난 일정 내림차순·없는 값 제외", () => {
  const now = new Date("2026-06-18T12:00:00Z");
  const { upcoming, past } = splitSchedule(
    [
      node({ id: "node:past1", eventAt: "2026-06-10T00:00:00Z" }),
      node({ id: "node:up1", eventAt: "2026-06-25T00:00:00Z" }),
      node({ id: "node:up2", eventAt: "2026-06-20T00:00:00Z" }),
      node({ id: "node:none" }), // eventAt 없음 → 제외
      node({ id: "node:past2", eventAt: "2026-06-15T00:00:00Z" }),
    ],
    now,
  );
  // 다가오는 — 가까운 미래가 위(오름차순)
  expect(upcoming.map((n) => n.id)).toEqual(["node:up2", "node:up1"]);
  // 지난 — 가장 최근 지난 것이 위(내림차순)
  expect(past.map((n) => n.id)).toEqual(["node:past2", "node:past1"]);
});

test("splitSchedule — '오늘' 경계는 로컬 자정(당일 일정은 다가오는 쪽)", () => {
  const now = new Date(2026, 5, 18, 23, 0, 0); // 로컬 6/18 23:00
  const todayMidnightIso = new Date(2026, 5, 18, 0, 0, 0).toISOString();
  const { upcoming, past } = splitSchedule(
    [node({ id: "node:today", eventAt: todayMidnightIso })],
    now,
  );
  // 오늘 자정 == 경계라 다가오는(>=)에 든다 — 시각이 지났어도 날짜 단위 비교라 당일은 미래.
  expect(upcoming.map((n) => n.id)).toEqual(["node:today"]);
  expect(past.length).toBe(0);
});

test("localMidnight — 시·분·초를 떼고 그날 00:00 을 돌려준다", () => {
  const now = new Date(2026, 5, 18, 14, 37, 5);
  const mid = new Date(localMidnight(now));
  expect(mid.getHours()).toBe(0);
  expect(mid.getMinutes()).toBe(0);
  expect(mid.getDate()).toBe(18);
});

// ── 상대 시각 ─────────────────────────────────────────────────────────────────
test("relativeTimeLabel — 방금/분/시간/일 전, 없으면 —", () => {
  const now = new Date("2026-06-18T12:00:00Z");
  expect(relativeTimeLabel("2026-06-18T11:59:30Z", now)).toBe("방금");
  expect(relativeTimeLabel("2026-06-18T11:30:00Z", now)).toBe("30분 전");
  expect(relativeTimeLabel("2026-06-18T09:00:00Z", now)).toBe("3시간 전");
  expect(relativeTimeLabel("2026-06-15T12:00:00Z", now)).toBe("3일 전");
  expect(relativeTimeLabel(undefined, now)).toBe("—");
  expect(relativeTimeLabel("not-a-date", now)).toBe("—");
});

// ── 절대 날짜 ─────────────────────────────────────────────────────────────────
test("absoluteDateLabel — YYYY-MM-DD, 없으면 —", () => {
  const iso = new Date(2026, 5, 25, 9, 0, 0).toISOString(); // 로컬 6/25
  expect(absoluteDateLabel(iso)).toBe("2026-06-25");
  expect(absoluteDateLabel(undefined)).toBe("—");
  expect(absoluteDateLabel("broken")).toBe("—");
});

// ── 탭 매핑(buildMemoryListRows) ──────────────────────────────────────────────
test("buildMemoryListRows recent — 필터+createdAt 정렬+상대 표기", () => {
  const now = new Date("2026-06-18T12:00:00Z");
  const rows = buildMemoryListRows(
    [
      node({ id: "node:1", type: "memory", createdAt: "2026-06-10T00:00:00Z" }),
      node({ id: "node:c", type: "concept", createdAt: "2026-06-18T00:00:00Z" }), // 제외
      node({ id: "node:2", type: "document", createdAt: "2026-06-17T00:00:00Z" }),
    ],
    "recent",
    now,
  );
  expect(rows.map((r) => (r.kind === "item" ? r.nodeId : `div:${r.label}`)))
    .toEqual(["node:2", "node:1"]);
  expect(countItems(rows)).toBe(2);
});

test("buildMemoryListRows recent — 목록 제목에서 해시태그를 숨긴다", () => {
  const now = new Date("2026-06-18T12:00:00Z");
  const rows = buildMemoryListRows(
    [
      node({
        id: "node:tagged",
        type: "memory",
        label: "#아이디어 #작품:소설, 그래프 제목 정리",
        snippet: "#아이디어 #작품:소설, 그래프 제목 정리",
        createdAt: "2026-06-17T00:00:00Z",
      }),
    ],
    "recent",
    now,
  );
  expect(rows[0]).toMatchObject({
    kind: "item",
    label: "그래프 제목 정리",
  });
});

test("buildMemoryListRows schedule — 다가오는 + '지난' 구분 행 + 지난", () => {
  const now = new Date("2026-06-18T12:00:00Z");
  const rows = buildMemoryListRows(
    [
      node({ id: "node:up", type: "memory", eventAt: "2026-06-25T00:00:00Z" }),
      node({ id: "node:past", type: "memory", eventAt: "2026-06-10T00:00:00Z" }),
      node({ id: "node:noev", type: "memory" }), // 일정 탭 제외
    ],
    "schedule",
    now,
  );
  expect(rows.length).toBe(3);
  expect(rows[0]).toMatchObject({ kind: "item", nodeId: "node:up" });
  expect(rows[1]).toMatchObject({ kind: "divider", label: "지난" });
  expect(rows[2]).toMatchObject({ kind: "item", nodeId: "node:past" });
  // 구분 행은 항목 수에 안 센다.
  expect(countItems(rows)).toBe(2);
});

test("buildDateOccurrenceRows — 새 날짜 API 응답을 일정탭 행과 역할 배지로 바꾼다", () => {
  const rows = buildDateOccurrenceRows({
    upcoming: [
      {
        kind: "column_date",
        role: "expiration",
        title: "우유 유통기한",
        date: "2026-07-01",
        columnKey: "유통기한",
        target: { nodeId: "entity:intake:itk_1", type: "intake", id: "itk_1", label: "우유" },
      },
      {
        kind: "birthday",
        role: "birthday",
        title: "민수 생일",
        date: "2026-07-10",
        target: { nodeId: "person:psn_1", type: "person", id: "psn_1", label: "민수" },
      },
    ],
    past: [
      {
        kind: "event",
        role: "event",
        title: "지난 회의",
        date: "2026-06-15",
        target: { nodeId: "node:7", type: "memory", id: 7, label: "지난 회의" },
      },
    ],
    window: {
      today: "2026-06-30",
      until: "2026-07-30",
      pastSince: "2026-05-31",
      days: 30,
      pastDays: 30,
    },
    generatedAt: "2026-06-30T00:00:00.000Z",
  });

  expect(rows).toEqual([
    {
      kind: "item",
      nodeId: "entity:intake:itk_1",
      label: "우유 유통기한",
      type: "intake",
      badge: "만료",
      stat: "2026-07-01",
    },
    {
      kind: "item",
      nodeId: "person:psn_1",
      label: "민수 생일",
      type: "person",
      badge: "생일",
      stat: "2026-07-10",
    },
    { kind: "divider", label: "지난" },
    {
      kind: "item",
      nodeId: "node:7",
      memoryId: 7,
      label: "지난 회의",
      type: "memory",
      badge: "일정",
      stat: "2026-06-15",
    },
  ]);
});

test("buildMemoryListRows schedule — 지난 일정 없으면 구분 행 없음", () => {
  const now = new Date("2026-06-18T12:00:00Z");
  const rows = buildMemoryListRows(
    [node({ id: "node:up", type: "memory", eventAt: "2026-06-25T00:00:00Z" })],
    "schedule",
    now,
  );
  expect(rows.length).toBe(1);
  expect(rows.some((r) => r.kind === "divider")).toBe(false);
});

test("buildMemoryListRows schedule — 다가오는 일정 없으면 구분 행 + 지난만", () => {
  const now = new Date("2026-06-18T12:00:00Z");
  const rows = buildMemoryListRows(
    [node({ id: "node:past", type: "memory", eventAt: "2026-06-10T00:00:00Z" })],
    "schedule",
    now,
  );
  expect(rows[0]).toMatchObject({ kind: "divider", label: "지난" });
  expect(rows[1]).toMatchObject({ kind: "item", nodeId: "node:past" });
});

test("buildMemoryListRows accessed — lastAccessedAt 정렬+상대 표기", () => {
  const now = new Date("2026-06-18T12:00:00Z");
  const rows = buildMemoryListRows(
    [
      node({ id: "node:1", type: "memory", lastAccessedAt: "2026-06-01T00:00:00Z" }),
      node({ id: "node:2", type: "image", lastAccessedAt: "2026-06-17T00:00:00Z" }),
    ],
    "accessed",
    now,
  );
  expect(rows.map((r) => (r.kind === "item" ? r.nodeId : "div"))).toEqual([
    "node:2",
    "node:1",
  ]);
});

test("buildMemoryListRows — 상한 40개(구분 행은 글 수에 안 셈)", () => {
  const now = new Date("2026-06-18T12:00:00Z");
  const many: GraphNode[] = [];
  for (let i = 0; i < 60; i += 1) {
    many.push(
      node({
        id: `node:${String(i).padStart(3, "0")}`,
        type: "memory",
        createdAt: new Date(2026, 0, i + 1).toISOString(),
      }),
    );
  }
  const rows = buildMemoryListRows(many, "recent", now);
  expect(countItems(rows)).toBe(40);
});

test("빈 입력 — 모든 탭에서 행 0개", () => {
  const now = new Date("2026-06-18T12:00:00Z");
  for (const tab of ["recent", "schedule", "accessed"] as const) {
    const rows = buildMemoryListRows([], tab, now);
    expect(rows.length).toBe(0);
    expect(countItems(rows)).toBe(0);
  }
});

test("buildMemoryListRows — 글 노드 항목은 기억 번호(node:N 의 N)를 싣는다", () => {
  const now = new Date("2026-06-18T12:00:00Z");
  const rows = buildMemoryListRows(
    [node({ id: "node:87", type: "memory", createdAt: "2026-06-18T11:00:00Z" })],
    "recent",
    now,
  );
  expect(rows[0]).toMatchObject({ kind: "item", nodeId: "node:87", memoryId: 87 });
});
