/**
 * memory-panel.test.ts — 좌측 기억목록 패널 DOM 골격 검증(happy-dom).
 * 머리(브랜드·상태줄·라벨·탭)·목록 렌더·빈 상태·탭 전환 콜백·setCounts·setSelected
 * 색 토글을 검사한다. Mock 클래스 없음 — createMemoryPanel 실제 DOM 만 본다.
 */
import "../../../../test-setup-dom";
import { test, expect } from "bun:test";
import { createMemoryPanel } from "./memory-panel.ts";
import type { MemoryListRow } from "./memory-panel-data.ts";

function items(...rows: MemoryListRow[]): MemoryListRow[] {
  return rows;
}

test("머리 — 브랜드·상태줄·라벨·탭 3개를 그린다", () => {
  const panel = createMemoryPanel({ onPick: () => {}, onTab: () => {} });
  expect(panel.root.querySelector(".mp-brand__name")?.textContent).toBe("Bara System");
  expect(panel.root.querySelector(".mp-brand__sub")?.textContent).toBe("MEMORY MODULE");
  expect(panel.root.querySelector(".mp-status")).not.toBeNull();
  expect(panel.root.querySelector(".mp-title")?.textContent).toBe("기억 목록 0");
  const tabs = panel.root.querySelectorAll(".mp-tab");
  expect(tabs.length).toBe(3);
  expect([...tabs].map((t) => t.textContent)).toEqual(["최근기억", "일정", "최근열람"]);
});

test("초기 상태 — 빈 목록('기억 없음') + 노드·엣지 수", () => {
  const panel = createMemoryPanel({ onPick: () => {}, onTab: () => {} });
  expect(panel.root.querySelector(".mp-empty")?.textContent).toBe("기억 없음");
  const counts = [...panel.root.querySelectorAll(".mp-status__count")].map((e) => e.textContent);
  expect(counts).toEqual(["노드 0", "엣지 0"]);
  expect(panel.root.querySelector(".mp-status__live")).toBeNull();
});

test("render — 항목·구분 행을 그리고 '기억 목록 N' 을 글 수로 갱신", () => {
  const panel = createMemoryPanel({ onPick: () => {}, onTab: () => {} });
  panel.render(
    items(
      { kind: "item", nodeId: "node:1", label: "다가오는 글", type: "memory", stat: "2026-06-25" },
      { kind: "divider", label: "지난" },
      { kind: "item", nodeId: "node:2", label: "지난 글", type: "document", stat: "2026-06-10" },
    ),
  );
  expect(panel.root.querySelectorAll(".mp-item").length).toBe(2);
  expect(panel.root.querySelector(".mp-divider")?.textContent).toBe("지난");
  expect(panel.root.querySelector(".mp-title")?.textContent).toBe("기억 목록 2");
  expect(panel.root.querySelector(".mp-empty")).toBeNull();
  // 종류 표기 — 기본 memory 는 보조 라벨을 생략하고, 문서/이미지만 표시한다.
  const types = [...panel.root.querySelectorAll(".mp-item__type")].map((e) => e.textContent);
  expect(types).toEqual(["문서"]);
});

test("항목 — data-node-id 를 달고 클릭 시 onPick 호출", () => {
  const picked: string[] = [];
  const panel = createMemoryPanel({ onPick: (id) => picked.push(id), onTab: () => {} });
  panel.render(
    items({ kind: "item", nodeId: "mem:42", label: "테스트", type: "memory", stat: "방금" }),
  );
  const item = panel.root.querySelector<HTMLElement>(".mp-item");
  expect(item?.dataset["nodeId"]).toBe("mem:42");
  item?.click();
  expect(picked).toEqual(["mem:42"]);
});

test("탭 전환 — on 클래스가 옮겨가고 onTab 콜백이 불린다", () => {
  const tabs: string[] = [];
  const panel = createMemoryPanel({ onPick: () => {}, onTab: (t) => tabs.push(t) });
  const scheduleTab = panel.root.querySelector<HTMLElement>('[data-tab="schedule"]');
  scheduleTab?.click();
  expect(tabs).toEqual(["schedule"]);
  expect(scheduleTab?.classList.contains("on")).toBe(true);
  // 기본(최근기억) 탭의 on 은 꺼졌다.
  expect(
    panel.root.querySelector('[data-tab="recent"]')?.classList.contains("on"),
  ).toBe(false);
});

test("탭 전환 — 같은 탭 재클릭은 콜백을 다시 부르지 않는다", () => {
  const tabs: string[] = [];
  const panel = createMemoryPanel({ onPick: () => {}, onTab: (t) => tabs.push(t) });
  const recentTab = panel.root.querySelector<HTMLElement>('[data-tab="recent"]');
  recentTab?.click(); // 이미 활성 — no-op
  expect(tabs).toEqual([]);
});

test("setCounts — 노드·엣지 수 갱신", () => {
  const panel = createMemoryPanel({ onPick: () => {}, onTab: () => {} });
  panel.setCounts(12, 34);
  const counts = [...panel.root.querySelectorAll(".mp-status__count")].map((e) => e.textContent);
  expect(counts).toEqual(["노드 12", "엣지 34"]);
});

test("setSelected — 해당 항목에 selected 클래스, null 이면 모두 해제", () => {
  const panel = createMemoryPanel({ onPick: () => {}, onTab: () => {} });
  panel.render(
    items(
      { kind: "item", nodeId: "node:1", label: "가", type: "memory", stat: "방금" },
      { kind: "item", nodeId: "node:2", label: "나", type: "memory", stat: "1일 전" },
    ),
  );
  panel.setSelected("node:2");
  const byId = (id: string) =>
    panel.root.querySelector<HTMLElement>(`.mp-item[data-node-id="${id}"]`);
  expect(byId("node:2")?.classList.contains("selected")).toBe(true);
  expect(byId("node:1")?.classList.contains("selected")).toBe(false);
  panel.setSelected(null);
  expect(byId("node:2")?.classList.contains("selected")).toBe(false);
});

test("setSelected — render 후에도 선택 색이 복원된다", () => {
  const panel = createMemoryPanel({ onPick: () => {}, onTab: () => {} });
  panel.render(
    items({ kind: "item", nodeId: "node:9", label: "글", type: "memory", stat: "방금" }),
  );
  panel.setSelected("node:9");
  // 같은 노드가 다시 그려지면 selected 가 유지돼야 한다(applySelectedClass 복원).
  panel.render(
    items({ kind: "item", nodeId: "node:9", label: "글", type: "memory", stat: "방금" }),
  );
  expect(
    panel.root
      .querySelector<HTMLElement>('.mp-item[data-node-id="node:9"]')
      ?.classList.contains("selected"),
  ).toBe(true);
});

test("셸 래퍼 — root 는 .left-shell 이고 본체(.memory-panel)와 접기 탭(.mp-toggle)을 담는다", () => {
  const panel = createMemoryPanel({ onPick: () => {}, onTab: () => {} });
  expect(panel.root.classList.contains("left-shell")).toBe(true);
  // 본체와 토글 탭이 셸의 직계 자식이라, 본체를 숨겨도 토글은 셸에 남는다.
  expect(panel.root.querySelector(":scope > .memory-panel")).not.toBeNull();
  expect(panel.root.querySelector(":scope > .mp-toggle")).not.toBeNull();
});

test("접기 토글 — 클릭하면 collapsed 클래스·화살표(◀/▶)가 뒤집힌다", () => {
  const panel = createMemoryPanel({ onPick: () => {}, onTab: () => {} });
  const toggle = panel.root.querySelector<HTMLElement>(".mp-toggle");
  const arrow = panel.root.querySelector<HTMLElement>(".mp-toggle__arrow");
  // 펼침 초기 상태 — collapsed 없음·◀·aria-expanded=true.
  expect(panel.root.classList.contains("collapsed")).toBe(false);
  expect(arrow?.textContent).toBe("◀");
  expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  // 한 번 클릭 → 접힘.
  toggle?.click();
  expect(panel.root.classList.contains("collapsed")).toBe(true);
  expect(arrow?.textContent).toBe("▶");
  expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  // 다시 클릭 → 펼침.
  toggle?.click();
  expect(panel.root.classList.contains("collapsed")).toBe(false);
  expect(arrow?.textContent).toBe("◀");
  expect(toggle?.getAttribute("aria-expanded")).toBe("true");
});

test("접힌 패널 — 목록만 inert/aria-hidden 이며 펼치기 버튼은 계속 접근 가능하다", () => {
  const panel = createMemoryPanel({
    onPick: () => {}, onTab: () => {},
  }, { collapsed: true });
  const body = panel.root.querySelector<HTMLElement>(".memory-panel")!;
  const toggle = panel.root.querySelector<HTMLButtonElement>(".mp-toggle")!;
  expect(body.hasAttribute("inert")).toBe(true);
  expect(body.getAttribute("aria-hidden")).toBe("true");
  expect(toggle.closest("[inert]")).toBeNull();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.getAttribute("aria-label")).toBe("기억 목록 펼치기");

  toggle.click();
  expect(body.hasAttribute("inert")).toBe(false);
  expect(body.getAttribute("aria-hidden")).toBe("false");
  expect(toggle.getAttribute("aria-label")).toBe("기억 목록 접기");
  panel.setCollapsed(true);
  expect(body.hasAttribute("inert")).toBe(true);
});

test("접기 — 목록 안의 포커스만 토글로 돌려주고 다른 입력의 포커스는 유지한다", () => {
  const panel = createMemoryPanel({ onPick: () => {}, onTab: () => {} });
  const input = document.createElement("input");
  document.body.append(panel.root, input);
  const toggle = panel.root.querySelector<HTMLButtonElement>(".mp-toggle")!;
  const tab = panel.root.querySelector<HTMLButtonElement>(".mp-tab")!;
  try {
    tab.focus();
    expect(document.activeElement).toBe(tab);
    panel.setCollapsed(true);
    expect(document.activeElement).toBe(toggle);
    panel.setCollapsed(false);
    input.focus();
    panel.setCollapsed(true);
    expect(document.activeElement).toBe(input);
  } finally {
    panel.root.remove();
    input.remove();
  }
});

test("render — 기억 번호가 있는 항목은 #N 을 흐린 보조 표기로 그리고 없으면 그리지 않는다", () => {
  const panel = createMemoryPanel({ onPick: () => {}, onTab: () => {} });
  panel.render(
    items(
      { kind: "item", nodeId: "node:87", memoryId: 87, label: "번호 있는 글", type: "memory", stat: "방금" },
      { kind: "item", nodeId: "person:p", label: "번호 없는 항목", type: "person", stat: "방금" },
    ),
  );
  const [withNo, without] = [...panel.root.querySelectorAll(".mp-item")];
  expect(withNo!.querySelector(".memory-no")?.textContent).toBe("#87");
  expect(without!.querySelector(".memory-no")).toBeNull();
});
