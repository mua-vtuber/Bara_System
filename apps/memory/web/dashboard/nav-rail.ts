import { el } from "./ui/dom.ts";
import { setTheme } from "./ui/theme-switch.ts";

/** 세로 줄 항목 식별자. */
export type NavRailItem = "dashboard" | "graph" | "archive" | "proposals" | "settings";

const NAV_RAIL_ITEMS: Array<{
  id: NavRailItem;
  label: string;
  href: string;
  icon: "dashboard" | "graph" | "archive" | "spark" | "settings";
  sectionStart?: boolean;
}> = [
  { id: "dashboard", label: "대시보드",  href: "/web/dashboard.html",                icon: "dashboard" },
  { id: "graph",     label: "그래프",    href: "/web/graph.html",                   icon: "graph" },
  { id: "archive",   label: "휴지통",    href: "/web/dashboard.html#archive",       icon: "archive", sectionStart: true },
  { id: "proposals", label: "정리 제안", href: "/web/dashboard.html#proposals",     icon: "spark" },
  { id: "settings",  label: "설정",      href: "/web/dashboard/settings.html",      icon: "settings" },
];

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  return node;
}

function navIcon(kind: (typeof NAV_RAIL_ITEMS)[number]["icon"]): HTMLElement {
  const span = el("span", { className: "nr-icon", "aria-hidden": "true" });
  const svg = svgEl("svg", { viewBox: "0 0 24 24", focusable: "false" });
  const addPath = (d: string): void => { svg.appendChild(svgEl("path", { d })); };
  const addRect = (attrs: Record<string, string>): void => { svg.appendChild(svgEl("rect", attrs)); };
  const addCircle = (attrs: Record<string, string>): void => { svg.appendChild(svgEl("circle", attrs)); };
  const addLine = (attrs: Record<string, string>): void => { svg.appendChild(svgEl("line", attrs)); };

  if (kind === "dashboard") {
    addRect({ x: "4", y: "4", width: "6.5", height: "6.5", rx: "1.2" });
    addRect({ x: "13.5", y: "4", width: "6.5", height: "6.5", rx: "1.2" });
    addRect({ x: "4", y: "13.5", width: "6.5", height: "6.5", rx: "1.2" });
    addRect({ x: "13.5", y: "13.5", width: "6.5", height: "6.5", rx: "1.2" });
  } else if (kind === "graph") {
    addCircle({ cx: "6", cy: "12", r: "2.4" });
    addCircle({ cx: "17.5", cy: "6.5", r: "2.4" });
    addCircle({ cx: "17.5", cy: "17.5", r: "2.4" });
    addLine({ x1: "8.2", y1: "10.9", x2: "15.3", y2: "7.6" });
    addLine({ x1: "8.2", y1: "13.1", x2: "15.3", y2: "16.4" });
    addLine({ x1: "17.5", y1: "8.9", x2: "17.5", y2: "15.1" });
  } else if (kind === "archive") {
    addPath("M5 7h14");
    addPath("M9 7V5.4h6V7");
    addPath("M7 9l.7 10h8.6L17 9");
    addPath("M10 11.2v5.4");
    addPath("M14 11.2v5.4");
  } else if (kind === "spark") {
    addPath("M12 3.8l1.4 4.1 4.2 1.4-4.2 1.4L12 14.8l-1.4-4.1-4.2-1.4 4.2-1.4z");
    addPath("M6.4 15.2l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z");
    addPath("M17.2 14.6l.8 2.1 2 .7-2 .7-.8 2.1-.7-2.1-2.1-.7 2.1-.7z");
  } else {
    addCircle({ cx: "12", cy: "12", r: "3.1" });
    addPath("M12 3.8v2.1");
    addPath("M12 18.1v2.1");
    addPath("M3.8 12h2.1");
    addPath("M18.1 12h2.1");
    addPath("M6.2 6.2l1.5 1.5");
    addPath("M16.3 16.3l1.5 1.5");
    addPath("M17.8 6.2l-1.5 1.5");
    addPath("M7.7 16.3l-1.5 1.5");
  }

  span.appendChild(svg);
  return span;
}

/** 테마 토글 버튼 아이콘 — 해/달 겸용(원 + 4방향 광선). */
function themeIcon(): HTMLElement {
  const span = el("span", { className: "nr-icon", "aria-hidden": "true" });
  const svg = svgEl("svg", { viewBox: "0 0 24 24", focusable: "false" });
  const addPath = (d: string): void => { svg.appendChild(svgEl("path", { d })); };
  const addCircle = (attrs: Record<string, string>): void => { svg.appendChild(svgEl("circle", attrs)); };

  addCircle({ cx: "12", cy: "12", r: "4" });
  addPath("M12 3v2.5");
  addPath("M12 18.5V21");
  addPath("M3 12h2.5");
  addPath("M18.5 12H21");

  span.appendChild(svg);
  return span;
}

/**
 * 세로 아이콘 줄을 만들어 반환한다.
 * current 에 해당하는 항목은 active 클래스로 강조한다.
 */
export function renderNavRail(current: NavRailItem): HTMLElement {
  const items = NAV_RAIL_ITEMS.map((item) => {
    const isActive = item.id === current;
    const props: Record<string, unknown> = {
      href: item.href,
      title: item.label,
      "aria-label": item.label,
      className: [
        "nr-item",
        isActive ? "active" : "",
        item.sectionStart ? "nr-item--section-start" : "",
      ].filter(Boolean).join(" "),
      dataset: { navId: item.id },
    };
    if (isActive) props["aria-current"] = "page";

    return el(
      "a",
      props,
      navIcon(item.icon),
      el("span", { className: "nr-label", "aria-hidden": "true" }, item.id === "dashboard" ? "홈" : item.label),
    );
  });

  const themeBtn = el("button", {
    className: "nr-item nr-theme",
    type: "button",
    title: "테마 전환",
    "aria-label": "테마 전환",
    "aria-pressed": document.documentElement.dataset.theme === "light" ? "true" : "false",
    dataset: { navId: "theme" },
    onClick: (event: Event) => {
      const isLight = document.documentElement.dataset.theme === "light";
      setTheme(isLight ? "dark" : "light");
      (event.currentTarget as HTMLButtonElement).setAttribute("aria-pressed", isLight ? "false" : "true");
    },
  }, themeIcon(), el("span", { className: "nr-label", "aria-hidden": "true" }, "테마"));
  const spacer = el("span", { className: "nr-spacer", "aria-hidden": "true" });

  return el(
    "nav",
    {
      className: "nav-rail",
      "aria-label": "주 메뉴",
    },
    ...items,
    spacer,
    themeBtn,
  );
}
