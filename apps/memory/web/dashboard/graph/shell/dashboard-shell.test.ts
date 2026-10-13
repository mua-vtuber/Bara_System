/**
 * dashboard-shell.test.ts — 그래프 화면 제일 좌측 navigation rail DOM 골격 검증.
 * happy-dom 실제 DOM 으로 대시보드/그래프 왕복 아이콘과 active 상태를 본다.
 */
import "../../../../test-setup-dom";
import { test, expect } from "bun:test";
import { renderNavRail } from "./dashboard-shell.ts";

test("renderNavRail — 대시보드와 그래프 아이콘 링크를 포함한다", () => {
  const rail = renderNavRail("graph");
  const links = [...rail.querySelectorAll<HTMLAnchorElement>("a.nr-item")];

  expect(links.map((link) => link.getAttribute("aria-label"))).toEqual([
    "대시보드",
    "그래프",
    "휴지통",
    "정리 제안",
    "설정",
  ]);
  expect(links[0]?.getAttribute("href")).toBe("/web/dashboard.html");
  expect(links[1]?.getAttribute("href")).toBe("/web/graph.html");
  expect(links[2]?.getAttribute("href")).toBe("/web/dashboard.html#archive");
  expect(links[3]?.getAttribute("href")).toBe("/web/dashboard.html#proposals");
  expect(links[0]?.querySelector("svg")).not.toBeNull();
  expect(links[1]?.querySelector("svg")).not.toBeNull();
});

test("renderNavRail — 현재 화면만 active와 aria-current를 가진다", () => {
  const rail = renderNavRail("graph");
  const active = rail.querySelector<HTMLAnchorElement>(".nr-item.active");

  expect(active?.dataset["navId"]).toBe("graph");
  expect(active?.getAttribute("aria-current")).toBe("page");
  expect(
    rail.querySelector<HTMLAnchorElement>('[data-nav-id="dashboard"]')?.hasAttribute("aria-current"),
  ).toBe(false);
});

test("renderNavRail — 설정 화면 active 상태도 같은 메뉴 정의를 쓴다", () => {
  const rail = renderNavRail("settings");
  const active = rail.querySelector<HTMLAnchorElement>(".nr-item.active");

  expect(active?.dataset["navId"]).toBe("settings");
  expect(active?.getAttribute("href")).toBe("/web/dashboard/settings.html");
  expect(
    rail.querySelector<HTMLAnchorElement>('[data-nav-id="graph"]')?.hasAttribute("aria-current"),
  ).toBe(false);
});
