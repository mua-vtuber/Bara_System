import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const COMPONENTS_CSS = readFileSync(
  new URL("./components.css", import.meta.url),
  "utf8",
);

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(COMPONENTS_CSS);
  return match?.[1] ?? "";
}

describe("components.css", () => {
  test("좌우 메뉴 행은 기본/호버/선택 글자색 토큰을 쓴다", () => {
    expect(cssBlock(".rp-row")).toContain("color: var(--text-soft)");
    expect(cssBlock(".rp-row:hover")).toContain("color: var(--text)");
    expect(cssBlock(".rp-row.selected")).toContain("color: var(--text-on-selected)");
    expect(cssBlock(".rp-row.selected")).toContain("border-radius: 0");
    expect(cssBlock(".rp-row.selected")).toContain("font-weight: 600");
    expect(cssBlock(".rp-row__label")).toContain("color: inherit");

    expect(cssBlock(".mp-item")).toContain("color: var(--text-soft)");
    expect(cssBlock(".mp-item:hover")).toContain("color: var(--text)");
    expect(cssBlock(".mp-item.selected")).toContain("color: var(--text-on-selected)");
    expect(cssBlock(".mp-item.selected")).toContain("font-weight: 600");
    expect(cssBlock(".mp-item__label")).toContain("color: inherit");
    expect(cssBlock(".mp-item__type")).toContain("color: inherit");
    expect(cssBlock(".mp-stat")).toContain("color: inherit");
  });

  test("그래프 rail 비선택 아이콘은 기본 글자색 토큰을 쓴다", () => {
    expect(cssBlock(".nr-item")).toContain("color: var(--text)");
  });

  test("큰 모달 내용 본문은 기본 텍스트 토큰을 쓴다", () => {
    expect(cssBlock(".node-window__content")).toContain("color: var(--text)");
    expect(cssBlock(".node-window__snippet")).toContain("color: inherit");
    expect(cssBlock(".node-window__snippet--typing::after")).toContain("background: var(--accent)");
  });

  test("대시보드 상세 타이핑 커서는 accent 토큰을 쓴다", () => {
    expect(cssBlock(".node-detail__snippet--typing")).toContain("cursor: pointer");
    expect(cssBlock(".node-detail__snippet--typing::after")).toContain("background: var(--accent)");
  });

  test("검색 연출 클래스는 토큰 기반 색과 모션을 쓴다", () => {
    expect(cssBlock(".rp-body--loading")).toContain("justify-content: center");
    expect(cssBlock(".rp-body--loading")).toContain("color: var(--text-dim)");
    expect(cssBlock(".rp-list--reveal .rp-row--reveal")).toContain("animation: rp-row-rise");
    expect(cssBlock(".dash-square-loader")).toContain("var(--au-grad)");
    expect(cssBlock(".dash-square-loader")).toContain("animation: dash-square-loader-spin");
  });

  test("큰 모달은 헤더를 고정하고 본문만 스크롤한다", () => {
    expect(cssBlock(".node-window")).toContain("display: flex");
    expect(cssBlock(".node-window")).toContain("overflow: hidden");
    expect(cssBlock(".node-window__head")).toContain("flex: 0 0 auto");
    expect(cssBlock(".node-window__body")).toContain("overflow-y: auto");
  });

  test("기억 번호와 정보 블록은 토큰 색만 쓴다", () => {
    expect(cssBlock(".memory-no")).toContain("color: var(--text-dim)");
    expect(cssBlock(".memory-info__label")).toContain("color: var(--text-dim)");
    expect(cssBlock(".memory-info__value")).toContain("color: var(--text-soft)");
    for (const sel of [".memory-no", ".memory-info__row", ".memory-info__label", ".memory-info__value"]) {
      expect(cssBlock(sel)).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
    }
  });
});
