/**
 * web/dashboard/graph/shell/dashboard-shell.ts
 * 전체 그래프 대시보드 배치 모듈.
 * 세로 아이콘 줄(nav-rail) + 좌측 목록 + 가운데 그래프 + 우측 결과 패널 조합.
 *
 * 세로 줄 링크:
 *   대시보드            — /web/dashboard.html
 *   그래프(현재 강조)   — /web/graph.html
 *   휴지통              — /web/dashboard.html#archive
 *   정리제안            — /web/dashboard.html#proposals
 *   설정                — /web/dashboard/settings.html
 */
import { el } from "./dom.ts";
import { renderNavRail, type NavRailItem } from "../../nav-rail.ts";

export { renderNavRail };
export type { NavRailItem };

export interface ShellParts {
  /** 세로 아이콘 줄 (null 이면 renderNavRail 기본값 사용) */
  rail: HTMLElement | null;
  /** 좌측 기억 목록 */
  left: HTMLElement;
  /** 가운데 그래프 캔버스 컨테이너 */
  center: HTMLElement;
  /** 우측 결과 패널 (null 이면 생략) */
  right: HTMLElement | null;
  /**
   * 입력바. null 이면 생략.
   * shell-center(그래프 화면) 안에 position:absolute 로 떠 있는 카드로 얹는다.
   * 검색 모달(search-modal.ts)이 같은 부모 위에 absolute 로 떠 있는 것과 같은 방식.
   * 떠 있는 위치·카드 스타일은 입력바 element 자체에 적용해서 넘긴다.
   */
  bottom: HTMLElement | null;
}

/**
 * 전체 레이아웃 컨테이너를 만들어 반환한다.
 * 가운데 그래프가 남은 공간을 모두 차지하고,
 * 좌측·우측 패널은 고정 너비로 양쪽에 붙는다.
 * 입력바(bottom)는 그래프 화면(shell-center) 안에 absolute 로 떠서
 * 그래프 위 하단 가운데에 카드처럼 얹힌다.
 */
export function renderShell(parts: ShellParts): HTMLElement {
  const rail = parts.rail ?? renderNavRail("graph");

  // 그래프 화면 자식: 캔버스 + (입력바). 입력바는 자체 absolute 스타일로 떠 있다.
  const centerChildren: HTMLElement[] = [parts.center];
  if (parts.bottom) {
    centerChildren.push(parts.bottom);
  }

  const mainRow = el(
    "div",
    {
      className: "shell-main",
      style: [
        "display:flex",
        "flex:1",
        "overflow:hidden",
        "position:relative",
      ].join(";"),
    },
    parts.left,
    el(
      "div",
      {
        className: "shell-center",
        style: [
          "flex:1",
          "position:relative",
          "overflow:hidden",
          "min-width:0",
        ].join(";"),
      },
      ...centerChildren,
    ),
    ...(parts.right ? [parts.right] : []),
  );

  const contentRow = el(
    "div",
    {
      className: "shell-content-row",
      style: [
        "display:flex",
        "flex-direction:row",
        "flex:1",
        "overflow:hidden",
        "min-height:0",
      ].join(";"),
    },
    rail,
    mainRow,
  );

  return el(
    "div",
    {
      className: "dashboard-shell",
      style: [
        "display:flex",
        "flex-direction:column",
        "width:100%",
        "height:100vh",
        "overflow:hidden",
        "background:var(--bg)",
        "color:var(--text)",
        "font-family:var(--sans)",
      ].join(";"),
    },
    contentRow,
  );
}
