/**
 * results-panel.test.ts — 우측 결과 패널 렌더·클릭·빈 상태 검증.
 * happy-dom 을 전역 등록한 뒤 renderResultsPanel 순수 DOM 조립을 검사한다.
 *
 * renderResultsPanel 은 CardView[] 를 받는다(title 칸 사용).
 */
import "../../../../test-setup-dom";
import { test, expect } from "bun:test";
import {
  renderResultsPanel,
  renderResultsLoadingPanel,
  applyResultsPanelSelection,
} from "./results-panel";
import type { CardView } from "../../ui/card-view";

test("결과 행이 data-node-id 를 가지고 클릭 시 onPick 호출", () => {
  const picked: string[] = [];
  const views: CardView[] = [
    { nodeId: "node:1", title: "결과 A", score: 0.91 },
    { nodeId: "node:2", title: "결과 B", score: 0.85 },
  ];
  const panel = renderResultsPanel(views, { onPick: (id) => picked.push(id) });
  const rows = panel.querySelectorAll("[data-node-id]");
  expect(rows.length).toBe(2);
  (rows[0] as HTMLElement).click();
  expect(picked).toEqual(["node:1"]);
});

test("두 번째 행 클릭 시 두 번째 nodeId 전달", () => {
  const picked: string[] = [];
  const views: CardView[] = [
    { nodeId: "hit:X", title: "갑" },
    { nodeId: "hit:Y", title: "을" },
  ];
  const panel = renderResultsPanel(views, { onPick: (id) => picked.push(id) });
  const rows = panel.querySelectorAll("[data-node-id]");
  (rows[1] as HTMLElement).click();
  expect(picked).toEqual(["hit:Y"]);
});

test("결과 0건 — 행 0, 빈 안내 노출", () => {
  const panel = renderResultsPanel([], { onPick: () => {} });
  expect(panel.querySelectorAll("[data-node-id]").length).toBe(0);
  const empty = panel.querySelector("[data-rp=empty]");
  expect(empty).not.toBeNull();
  expect((empty as HTMLElement).textContent?.length ?? 0).toBeGreaterThan(0);
});

test("score 있는 행 — 점수 텍스트 포함", () => {
  const views: CardView[] = [{ nodeId: "n:1", title: "점수 있음", score: 0.754 }];
  const panel = renderResultsPanel(views, { onPick: () => {} });
  expect(panel.textContent).toContain("0.754");
});

test("score 없는 행 — 정상 렌더(빈 score 컬럼 없음)", () => {
  const views: CardView[] = [{ nodeId: "n:2", title: "점수 없음" }];
  const panel = renderResultsPanel(views, { onPick: () => {} });
  const rows = panel.querySelectorAll("[data-node-id]");
  expect(rows.length).toBe(1);
});

test("revealRows=true — 결과 행마다 순차 등장 클래스와 delay 를 붙인다", () => {
  const views: CardView[] = [
    { nodeId: "n:1", title: "첫째" },
    { nodeId: "n:2", title: "둘째" },
  ];
  const panel = renderResultsPanel(views, { onPick: () => {}, revealRows: true });
  const rows = panel.querySelectorAll<HTMLElement>(".rp-row");
  expect(panel.querySelector(".rp-list--reveal")).not.toBeNull();
  expect(rows[0]?.classList.contains("rp-row--reveal")).toBe(true);
  expect(rows[1]?.style.getPropertyValue("--rp-row-delay")).toBe("42ms");
});

test("renderResultsLoadingPanel — 검색 중 네모 로더를 중앙 상태로 렌더한다", () => {
  const panel = renderResultsLoadingPanel();
  expect(panel.classList.contains("results-panel")).toBe(true);
  expect(panel.querySelector(".dash-square-loader.dash-square-loader--lg")).not.toBeNull();
  expect(panel.querySelector(".rp-peanut")).toBeNull();
  expect(panel.querySelector(".rp-body--loading")?.getAttribute("role")).toBe("status");
  expect(panel.textContent).toContain("검색 중");
});

// ── applyResultsPanelSelection — 우측 선택 색 토글(좌측 setSelected 와 같은 단일 출처) ──

test("applyResultsPanelSelection — 일치 행 하나만 selected, 나머지 해제", () => {
  const views: CardView[] = [
    { nodeId: "node:1", title: "가" },
    { nodeId: "node:2", title: "나" },
  ];
  const panel = renderResultsPanel(views, { onPick: () => {} });
  applyResultsPanelSelection(panel, "node:2");
  const byId = (id: string) =>
    panel.querySelector<HTMLElement>(`.rp-row[data-node-id="${id}"]`);
  expect(byId("node:2")?.classList.contains("selected")).toBe(true);
  expect(byId("node:1")?.classList.contains("selected")).toBe(false);
});

test("applyResultsPanelSelection — null 이면 모든 행 선택 해제", () => {
  const views: CardView[] = [
    { nodeId: "node:1", title: "가" },
    { nodeId: "node:2", title: "나" },
  ];
  const panel = renderResultsPanel(views, { onPick: () => {} });
  applyResultsPanelSelection(panel, "node:1");
  applyResultsPanelSelection(panel, null);
  const selected = panel.querySelectorAll(".rp-row.selected");
  expect(selected.length).toBe(0);
});

test("applyResultsPanelSelection — 재렌더 후 새 패널에 선택 색 다시 입힘(검색 후 복원)", () => {
  // 검색 흐름: 새 패널을 그린 뒤 현재 selectedNodeId 로 다시 칠한다.
  const first = renderResultsPanel([{ nodeId: "node:7", title: "글" }], {
    onPick: () => {},
  });
  applyResultsPanelSelection(first, "node:7");
  // 같은 노드를 담은 새 패널(재검색 결과)을 그리고 같은 id 로 복원한다.
  const second = renderResultsPanel([{ nodeId: "node:7", title: "글" }], {
    onPick: () => {},
  });
  applyResultsPanelSelection(second, "node:7");
  expect(
    second
      .querySelector<HTMLElement>('.rp-row[data-node-id="node:7"]')
      ?.classList.contains("selected"),
  ).toBe(true);
});

test("applyResultsPanelSelection — 선택 노드가 새 결과에 없으면 no-op(아무 행도 안 켜짐)", () => {
  const panel = renderResultsPanel([{ nodeId: "node:1", title: "가" }], {
    onPick: () => {},
  });
  applyResultsPanelSelection(panel, "node:없음");
  expect(panel.querySelectorAll(".rp-row.selected").length).toBe(0);
});

test("applyResultsPanelSelection — panelEl null 이면 무해(throw 없음)", () => {
  expect(() => applyResultsPanelSelection(null, "node:1")).not.toThrow();
});

test("applyResultsPanelSelection — 결과 0건(.rp-row 없음) 패널에도 무해", () => {
  const panel = renderResultsPanel([], { onPick: () => {} });
  expect(() => applyResultsPanelSelection(panel, "node:1")).not.toThrow();
  expect(panel.querySelectorAll(".rp-row.selected").length).toBe(0);
});

// ── 정렬 토글(S6) — onSortChange 가 있을 때만 헤더에 토글, 클릭 시 그 모드로 콜백 ──

test("onSortChange 미전달 — 헤더에 정렬 토글 없음(기존 2-키 호출 회귀 0)", () => {
  const panel = renderResultsPanel([{ nodeId: "n:1", title: "글" }], { onPick: () => {} });
  expect(panel.querySelectorAll("[data-rp-sort]").length).toBe(0);
});

test("onSortChange 전달 — 세 토글이 헤더에 뜨고 sortMode 가 active", () => {
  const panel = renderResultsPanel([{ nodeId: "n:1", title: "글" }], {
    onPick: () => {},
    sortMode: "recent",
    onSortChange: () => {},
  });
  const toggles = panel.querySelectorAll<HTMLElement>("[data-rp-sort]");
  expect(toggles.length).toBe(3);
  const active = panel.querySelector<HTMLElement>('[data-rp-sort="recent"]');
  expect(active?.classList.contains("active")).toBe(true);
  // 다른 두 토글은 active 아님
  expect(panel.querySelector<HTMLElement>('[data-rp-sort="relevance"]')?.classList.contains("active")).toBe(false);
  expect(panel.querySelector<HTMLElement>('[data-rp-sort="event"]')?.classList.contains("active")).toBe(false);
});

test("sortMode 미전달이되 onSortChange 전달 — 기본 relevance 가 active", () => {
  const panel = renderResultsPanel([{ nodeId: "n:1", title: "글" }], {
    onPick: () => {},
    onSortChange: () => {},
  });
  expect(panel.querySelector<HTMLElement>('[data-rp-sort="relevance"]')?.classList.contains("active")).toBe(true);
});

test("정렬 토글 클릭 — 그 모드로 onSortChange 발화", () => {
  const seen: string[] = [];
  const panel = renderResultsPanel([{ nodeId: "n:1", title: "글" }], {
    onPick: () => {},
    sortMode: "relevance",
    onSortChange: (m) => seen.push(m),
  });
  panel.querySelector<HTMLButtonElement>('[data-rp-sort="event"]')!.click();
  panel.querySelector<HTMLButtonElement>('[data-rp-sort="recent"]')!.click();
  expect(seen).toEqual(["event", "recent"]);
});

test("정렬 토글 클릭 — onPick 은 발화하지 않음(정렬과 행 선택 분리)", () => {
  let picked = 0;
  const panel = renderResultsPanel([{ nodeId: "n:1", title: "글" }], {
    onPick: () => { picked++; },
    onSortChange: () => {},
  });
  panel.querySelector<HTMLButtonElement>('[data-rp-sort="event"]')!.click();
  expect(picked).toBe(0);
});
