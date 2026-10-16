import { button, element } from "./dom.ts";
import { messages } from "./messages.ts";
import { sameViewKept } from "./panel-view.ts";

/** Rendering and service requests happen synchronously; only the page's visual transition is replaceable.
 * There are no cloned controls, delayed renders or animation-completion callbacks to outlive a view. */
export function createNotebookTransition(start: () => () => void) {
  let stop: (() => void) | undefined;
  const cancel = () => { const previous = stop; stop = undefined; previous?.(); };
  return {
    change(current: string | null, next: string, render: () => void, reducedMotion = false): boolean {
      if (current !== null && sameViewKept(current, next)) return false;
      cancel();
      render();
      if (current !== null && current !== next && !reducedMotion) {
        try { stop = start(); } catch { /* Visual effects must never prevent navigation. */ }
      }
      return true;
    },
    cancel,
  };
}

export function renderNotebook(actions: {
  navigate(mode: string): void;
  drag(): void;
  minimize(): void;
  close(): void;
  native: boolean;
  title?: string;
  navigationLabel?: string;
  tabs?: readonly (readonly [string, string])[];
}) {
  const shell = element("div", "notebook");
  shell.style.setProperty("--notebook-tab-image", `url("${new URL("assets/notebook/index-tab.png", document.baseURI).href}")`);
  const paper = element("img", "notebook-paper");
  paper.src = new URL("assets/notebook/notebook-shell.png", document.baseURI).href;
  paper.alt = ""; paper.draggable = false;
  const header = element("header", "notebook-header");
  const brand = element("div", "notebook-brand");
  const icon = element("img", "app-icon");
  icon.src = new URL("assets/app-icon.png", document.baseURI).href; icon.alt = ""; icon.draggable = false;
  brand.append(icon, element("strong", "", actions.title ?? messages.common.title));
  const controls = element("div", "notebook-window-controls");
  for (const [symbol, label, action] of [
    ["−", messages.main.minimizeWindow, actions.minimize],
    ["×", messages.common.close, actions.close],
  ] as const) {
    const control = button(symbol, action, "notebook-window-button");
    control.setAttribute("aria-label", label); control.title = actions.native ? label : messages.errors.desktopOnly;
    control.disabled = !actions.native;
    controls.append(control);
  }
  header.append(brand, controls);
  // The spiral rings are part of the paper raster, so a bare strip over them moves the window like the title row.
  const binding = element("div", "notebook-binding"); binding.setAttribute("aria-hidden", "true");
  const startDrag = (event: PointerEvent) => {
    if (event.button === 0 && !(event.target as HTMLElement).closest("button")) actions.drag();
  };
  header.addEventListener("pointerdown", startDrag);
  binding.addEventListener("pointerdown", startDrag);
  const tabs = element("nav", "notebook-tabs"); tabs.setAttribute("aria-label", actions.navigationLabel ?? messages.main.navigationLabel);
  const tabButtons = new Map<string, HTMLButtonElement>();
  for (const [mode, title] of actions.tabs ?? [
    ["result", messages.feedback.resultHeading], ["recovery", messages.feedback.recovery],
    ["cleanup", messages.feedback.cleanup], ["settings", messages.main.settingsButton],
  ] as const) {
    const tab = button(title, () => actions.navigate(mode), "notebook-tab");
    tab.dataset.page = mode; tab.setAttribute("aria-controls", "notebook-page");
    tabs.append(tab); tabButtons.set(mode, tab);
  }
  const tools = element("div", "notebook-tools");
  const pages = element("div", "notebook-page-stack");
  const content = element("main", "notebook-page"); content.id = "notebook-page"; content.tabIndex = -1;
  pages.append(content);
  const status = element("div", "notebook-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const footer = element("footer", "notebook-footer");
  shell.append(paper, binding, header, tools, tabs, pages, status, footer);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const transition = createNotebookTransition(() => {
    if (typeof content.animate !== "function") return () => {};
    const animation = content.animate([
      { transform: "translateY(8px) scale(.995)", opacity: .8 },
      { transform: "translateY(0) scale(1)", opacity: 1 },
    ], { duration: 200, easing: "cubic-bezier(.2,.7,.3,1)" });
    return () => animation.cancel();
  });
  reducedMotion.addEventListener("change", () => { if (reducedMotion.matches) transition.cancel(); });
  window.addEventListener("pagehide", transition.cancel);
  return {
    shell, tools, content, status, footer,
    change(current: string | null, next: string, render: () => void) {
      return transition.change(current, next, () => {
        shell.dataset.page = next;
        const selected = next === "answer" ? "result" : next === "onboarding" ? "settings" : next;
        for (const [mode, tab] of tabButtons) tab.setAttribute("aria-current", mode === selected ? "page" : "false");
        content.scrollTop = 0;
        render();
      }, reducedMotion.matches);
    },
  };
}
