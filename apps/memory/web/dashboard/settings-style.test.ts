import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const SETTINGS_HTML = readFileSync(
  new URL("./settings.html", import.meta.url),
  "utf8",
);

function inlineStyleCss(html: string): string {
  return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)]
    .map((match) => match[1] ?? "")
    .join("\n");
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function cssBlocks(selector: string, css: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "g"))]
    .map((match) => match[1] ?? "");
}

describe("settings.html style tokens", () => {
  test("연결 진단의 긴 경로는 원인과 조치 문단에서도 줄바꿈한다", () => {
    const css = stripCssComments(inlineStyleCss(SETTINGS_HTML));
    expect(cssBlocks(".connection-diagnostics", css).join("\n")).toContain("overflow-wrap: anywhere");
  });
  test("공유 대시보드 토큰 스타일시트를 먼저 로드한다", () => {
    expect(SETTINGS_HTML).toContain('/web/dashboard/ui/tokens.css');
    expect(SETTINGS_HTML).toContain('/web/dashboard/ui/components.css');
    expect(SETTINGS_HTML).toContain('/web/dashboard/ui/forms.css');
  });

  test("설정 페이지 전역 좌측 rail 은 유지한다", () => {
    const css = stripCssComments(inlineStyleCss(SETTINGS_HTML));

    expect(SETTINGS_HTML).toContain("settings-nav-rail");
    expect(SETTINGS_HTML).toContain("settings-app-shell");
    expect(css).toContain(".settings-nav-rail");
    expect(css).toContain(".settings-app-shell");
  });

  test("--settings-* 별칭 토큰 레이어는 완전히 제거됐다 (Task 13)", () => {
    const css = stripCssComments(inlineStyleCss(SETTINGS_HTML));

    expect(css).not.toMatch(/--settings-/);
  });

  test("인라인 색상은 raw literal 대신 토큰(또는 danger 버튼 대비용 순수 흰색)에서 파생한다", () => {
    const css = stripCssComments(inlineStyleCss(SETTINGS_HTML));
    const rawColorLiterals = css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ?? [];
    // frame.css .au-btn--danger 선례와 동일한 흰 텍스트 리터럴만 예외 허용.
    const unexpected = rawColorLiterals.filter((literal) => literal !== "#ffffff");

    expect(unexpected).toEqual([]);
  });

  test("설정 콘텐츠를 감싸는 tab-panel 은 시각 박스를 만들지 않는다", () => {
    const css = stripCssComments(inlineStyleCss(SETTINGS_HTML));
    const tabPanelCss = cssBlocks(".tab-panel", css).join("\n");

    expect(tabPanelCss).toContain("background: transparent");
    expect(tabPanelCss).toContain("border: 0");
    expect(tabPanelCss).toContain("box-shadow: none");
    expect(tabPanelCss).not.toContain("background: var(--bg-elev)");
    expect(tabPanelCss).not.toContain("box-shadow: var(--panel-glow)");
    expect(css).not.toContain(".tab-panel,\n      .llm-section");
  });

  test("설정 내부 메뉴 배경은 bg-elev 토큰을 쓴다", () => {
    const css = stripCssComments(inlineStyleCss(SETTINGS_HTML));
    const menuCss = cssBlocks(".memory-settings-nav", css).join("\n");

    expect(menuCss).toContain("background: var(--bg-elev)");
    expect(menuCss).not.toContain("background: var(--bg-card)");
  });

  test("오른쪽 설정 콘텐츠 박스도 bg-elev 토큰을 쓴다", () => {
    const css = stripCssComments(inlineStyleCss(SETTINGS_HTML));
    const formObjectCss = cssBlocks(".form-object", css).join("\n");
    const formObjectChildrenCss = cssBlocks(".form-object-children", css).join("\n");

    expect(formObjectCss).toContain("background: var(--bg-elev)");
    expect(formObjectCss).toContain("border: 1px solid var(--border)");
    expect(formObjectCss).not.toContain("background: var(--bg-card)");
    expect(formObjectChildrenCss).toContain("border-left: 0");
  });
});
