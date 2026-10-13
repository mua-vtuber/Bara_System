import { el } from "../ui/dom.ts";
import { listArchivePage } from "./dashboard-api.ts";
import { renderArchiveItem } from "./archive-item.ts";

/** 읽은 카드는 복구 결과와 함께 유지하고, 커서로 아직 읽지 않은 기억을 이어 본다. */
export function renderArchiveList(onRestored: () => Promise<void>): HTMLElement {
  const count = el("p", {className: "dash-secondary-count"});
  const cards = el("div", {className: "dash-secondary-list"});
  const status = el("p", {role: "status", "aria-live": "polite"});
  const more = el("button", {type: "button", className: "au-btn au-btn--ghost", dataset: {archiveMore: "true"}}, "더 보기") as HTMLButtonElement;
  const root = el("div", {}, count, cards, status, more);
  const seen = new Set<number>();
  let cursor: string | null = null;
  let busy = false;
  let revision = 0;

  async function restored(): Promise<void> {
    const requestRevision = ++revision;
    const [, page] = await Promise.all([onRestored(), listArchivePage(1)]);
    if (requestRevision === revision) count.textContent = "휴지통 " + page.total + "건";
  }
  async function load(): Promise<void> {
    if (busy) return;
    busy = true;
    more.disabled = true;
    status.textContent = "휴지통을 불러오는 중입니다…";
    const readRevision = revision;
    try {
      const page = await listArchivePage(50, cursor ?? undefined);
      for (const item of page.archive) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        cards.append(renderArchiveItem(item, restored));
      }
      cursor = page.nextCursor;
      if (readRevision === revision) count.textContent = "휴지통 " + page.total + "건";
      if (seen.size === 0) cards.textContent = "휴지통이 비어 있습니다.";
      more.hidden = cursor === null;
      more.textContent = "더 보기";
      status.textContent = "";
    } catch (error) {
      status.textContent = "목록을 불러오지 못했습니다. " + (error instanceof Error ? error.message : String(error));
      more.hidden = false;
      more.textContent = "다시 불러오기";
    } finally {
      busy = false;
      more.disabled = false;
    }
  }
  more.addEventListener("click", () => void load());
  void load();
  return root;
}
