/**
 * nav-rail.test.ts
 * 세로 아이콘 줄(nav-rail) DOM 골격 + 테마 토글 버튼 동작 검증.
 */
import { registerHappyDom } from "./test-happy-dom.ts";
registerHappyDom();

import { beforeEach, describe, expect, test } from "bun:test";
import { renderNavRail } from "./nav-rail.ts";

beforeEach(() => {
  delete document.documentElement.dataset.theme; // 다크 시작
});

describe("nav-rail 테마 토글", () => {
  test("테마 버튼이 렌더되고 클릭 시 data-theme 가 토글된다", () => {
    const nav = renderNavRail("dashboard");
    const btn = nav.querySelector<HTMLButtonElement>('[data-nav-id="theme"]');
    expect(btn).not.toBeNull();
    btn!.click();
    expect(document.documentElement.dataset.theme).toBe("light");
    btn!.click();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  test("테마 버튼의 aria-pressed 가 현재 테마·클릭에 맞춰 갱신된다", () => {
    const nav = renderNavRail("dashboard");
    const btn = nav.querySelector<HTMLButtonElement>('[data-nav-id="theme"]');
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute("aria-pressed")).toBe("false"); // 다크 시작 → light 아님
    btn!.click();
    expect(btn!.getAttribute("aria-pressed")).toBe("true"); // light 전환
    btn!.click();
    expect(btn!.getAttribute("aria-pressed")).toBe("false"); // dark 복귀
  });

  test("현재 테마가 light 일 때 렌더 시점부터 aria-pressed 가 true 다", () => {
    document.documentElement.dataset.theme = "light";
    const nav = renderNavRail("dashboard");
    const btn = nav.querySelector<HTMLButtonElement>('[data-nav-id="theme"]');
    expect(btn!.getAttribute("aria-pressed")).toBe("true");
  });
});
