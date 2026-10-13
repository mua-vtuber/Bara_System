/**
 * web/dashboard/ui/theme-switch.test.ts
 * data-theme 토글 + localStorage 저장 + OS 기본값 단위 테스트.
 * happy-dom 이 localStorage·matchMedia 를 전역에 제공한다.
 */
import { registerHappyDom } from "../test-happy-dom.ts";
registerHappyDom();

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { setTheme, initTheme } from "./theme-switch.ts";

// 원본 matchMedia 참조 — 각 테스트 후 복원용
const originalMatchMedia = globalThis.matchMedia;

// 각 테스트 전 상태 초기화
beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

// 각 테스트 후 matchMedia 원복
afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).matchMedia = originalMatchMedia;
});

// ──────────────────────────────────────────────
// setTheme
// ──────────────────────────────────────────────
describe("setTheme", () => {
  test("light → dataset.theme = 'light' + localStorage 'light' 저장", () => {
    setTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("bara.theme")).toBe("light");
  });

  test("dark → dataset.theme 제거(undefined) + localStorage 'dark' 저장", () => {
    // 먼저 light 로 세팅 후 dark 로 되돌림
    document.documentElement.dataset.theme = "light";
    setTheme("dark");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem("bara.theme")).toBe("dark");
  });
});

// ──────────────────────────────────────────────
// initTheme — localStorage 우선
// ──────────────────────────────────────────────
describe("initTheme — localStorage 저장값 우선", () => {
  test("저장값 'light' → light 반환 + dataset.theme = 'light'", () => {
    localStorage.setItem("bara.theme", "light");
    const result = initTheme();
    expect(result).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  test("저장값 'dark' → dark 반환 + dataset.theme 제거", () => {
    localStorage.setItem("bara.theme", "dark");
    // initTheme 전 dataset 이 light 로 남아있더라도 제거돼야 함
    document.documentElement.dataset.theme = "light";
    const result = initTheme();
    expect(result).toBe("dark");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  test("저장값이 유효하지 않은 문자열이면 무시하고 OS 폴백 → dark(기본)", () => {
    localStorage.setItem("bara.theme", "invalid-value");
    // matchMedia 를 dark 반환(matches: false)으로 고정
    (globalThis as unknown as Record<string, unknown>).matchMedia = (q: string) => ({
      matches: false,
      media: q,
    });
    const result = initTheme();
    expect(result).toBe("dark");
  });
});

// ──────────────────────────────────────────────
// initTheme — 저장값 없음 + matchMedia
// ──────────────────────────────────────────────
describe("initTheme — 저장값 없을 때 matchMedia 적용", () => {
  test("저장값 없음 + matchMedia light → light", () => {
    // 전역 matchMedia 를 단순 함수로 교체해 라이트 OS 환경을 흉내낸다.
    // (가짜 인터페이스 클래스 없이 단순 객체 반환 — afterEach 에서 복원)
    (globalThis as unknown as Record<string, unknown>).matchMedia = (q: string) => ({
      matches: q === "(prefers-color-scheme: light)",
      media: q,
    });

    const result = initTheme();
    expect(result).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  test("저장값 없음 + matchMedia dark(기본) → dark", () => {
    // matchMedia 를 다크(matches: false)로 고정
    (globalThis as unknown as Record<string, unknown>).matchMedia = (q: string) => ({
      matches: false,
      media: q,
    });
    const result = initTheme();
    expect(result).toBe("dark");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
