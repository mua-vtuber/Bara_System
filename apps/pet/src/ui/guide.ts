import { getCurrentWindow } from "@tauri-apps/api/window";
import { native, errorMessage } from "./bridge.ts";
import { button, element } from "./dom.ts";
import { messages } from "./messages.ts";
import { renderNotebook } from "./notebook.ts";

/** A local, read-only book. It does not load settings or contact the memory service. */
export function renderGuide(root: HTMLElement) {
  const copy = messages.guide;
  document.title = copy.title;
  const windowAction = (action: () => Promise<void>) => {
    if (native) void action().catch(error => {
      notebook.status.dataset.kind = "error";
      notebook.status.textContent = errorMessage(error);
    });
  };
  const notebook = renderNotebook({
    title: copy.title, navigationLabel: copy.navigation,
    tabs: copy.pages.map(page => [page.id, page.label] as const),
    navigate: show, native,
    drag: () => windowAction(() => getCurrentWindow().startDragging()),
    minimize: () => windowAction(() => getCurrentWindow().minimize()),
    close: () => windowAction(() => getCurrentWindow().hide()),
  });
  notebook.shell.classList.add("guide");
  notebook.tools.append(element("p", "guide-companion", copy.companion));
  const previous = button(copy.previous, () => show(copy.pages[index - 1].id), "button secondary");
  const next = button(copy.next, () => show(copy.pages[index + 1].id), "button secondary");
  const pageCount = element("span", "guide-page-count");
  notebook.footer.append(previous, pageCount, next);
  root.append(notebook.shell);
  let index = 0;
  let current: string | null = null;

  function show(id: string) {
    const nextIndex = copy.pages.findIndex(page => page.id === id);
    if (nextIndex < 0 || current === id) return;
    const wasNavigating = current !== null;
    notebook.change(current, id, () => {
      index = nextIndex;
      current = id;
      const page = copy.pages[index];
      const heading = element("h1", "notebook-page-title", page.title);
      heading.tabIndex = -1;
      notebook.content.replaceChildren(heading, element("p", "guide-intro", page.intro));
      for (const section of page.sections) {
        const block = element("section", "guide-section");
        block.append(element("h2", "", section.title), element("p", "", section.body));
        if (section.steps) {
          const steps = element("ol", "guide-steps");
          for (const step of section.steps) steps.append(element("li", "", step));
          block.append(steps);
        }
        if (section.example) {
          const example = element("figure", "guide-example");
          example.append(element("figcaption", "", copy.example), element("p", "", section.example));
          block.append(example);
        }
        if (section.path) {
          const path = element("ol", "guide-path"); path.setAttribute("aria-label", copy.hierarchy);
          for (const part of section.path) path.append(element("li", "", part));
          block.append(path);
        }
        if (section.comparison) {
          const comparison = element("dl", "guide-comparison");
          for (const entry of section.comparison) {
            const row = element("div");
            row.append(element("dt", "", entry.label), element("dd", "", entry.text));
            comparison.append(row);
          }
          block.append(comparison);
        }
        if (section.note) block.append(element("p", "guide-note", section.note));
        notebook.content.append(block);
      }
      previous.disabled = index === 0;
      next.disabled = index === copy.pages.length - 1;
      pageCount.textContent = copy.pageCount(index + 1, copy.pages.length);
      if (wasNavigating) heading.focus({ preventScroll: true });
    });
  }
  show(copy.pages[0].id);
}
