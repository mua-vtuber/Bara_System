import { el } from "../ui/dom.ts";
import { memoryNumberChip } from "../ui/memory-number.ts";
import { DashboardApiError, getMemoryDetail, restoreArchiveItem } from "./dashboard-api.ts";
import type { ArchiveItem } from "./types.ts";

export function renderArchiveItem(item: ArchiveItem, onRestored: () => Promise<void>): HTMLElement {
  const status = el("p", { className: "archive-item-status", role: "status", "aria-live": "polite" });
  const restore = el("button", { className: "au-btn au-btn--small", type: "button" }, "복구");
  const refresh = el("button", { className: "au-btn au-btn--ghost au-btn--small", type: "button" }, "목록 새로고침");
  refresh.hidden = true;
  const row = el("article", { className: "dash-secondary-row archive-item", "aria-busy": "false" },
    el("div", { className: "archive-item-body" },
      el("p", { className: "archive-item-content" }, item.content || `기억 #${item.id}`),
      memoryNumberChip(item.id),
      item.archivedAt ? el("span", {}, `휴지통 이동: ${item.archivedAt}`) : null,
      status),
    el("div", { className: "dash-secondary-actions" }, restore, refresh));
  let busy = false;
  let restored = false;

  async function refreshAfterRestore(): Promise<void> {
    refresh.disabled = true;
    try {
      await onRestored();
      status.textContent = "복구했습니다. 대시보드에서 기억을 확인할 수 있습니다.";
      status.dataset.state = "success";
      refresh.hidden = true;
    } catch {
      status.textContent = "복구는 완료됐지만 목록을 새로 불러오지 못했습니다. 복구를 다시 실행할 필요는 없습니다.";
      status.dataset.state = "error";
      refresh.hidden = false;
      refresh.textContent = "목록 새로고침";
    } finally {
      refresh.disabled = false;
    }
  }

  restore.addEventListener("click", () => {
    if (busy || restored) return;
    busy = true;
    restore.disabled = true;
    restore.textContent = "복구 중…";
    row.setAttribute("aria-busy", "true");
    status.textContent = "기억을 복구 중입니다…";
    status.dataset.state = "pending";
    void (async () => {
      try {
        await restoreArchiveItem(item.id);
      } catch (error) {
        status.textContent = `복구 결과를 확인하지 못했습니다. 중복 요청을 피하려면 먼저 상태를 확인하세요. ${error instanceof Error ? error.message : String(error)}`;
        status.dataset.state = "error";
        restore.textContent = "결과 확인 필요";
        refresh.textContent = "복구 결과 확인";
        refresh.hidden = false;
        return;
      } finally {
        busy = false;
        row.setAttribute("aria-busy", "false");
      }
      restored = true;
      restore.textContent = "복구 완료";
      status.textContent = "복구했습니다. 목록을 갱신하는 중입니다…";
      await refreshAfterRestore();
    })();
  });
  refresh.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    refresh.disabled = true;
    row.setAttribute("aria-busy", "true");
    void (async () => {
      try {
        if (!restored) {
          status.textContent = "복구 상태를 확인하는 중입니다…";
          await getMemoryDetail(item.id);
          restored = true;
          restore.textContent = "복구 완료";
        }
        await refreshAfterRestore();
      } catch (error) {
        if (error instanceof DashboardApiError && error.status === 404) {
          status.textContent = "기억이 아직 복구되지 않았습니다. 다시 복구하거나 휴지통 목록을 새로 확인하세요.";
          restore.textContent = "다시 복구";
          restore.disabled = false;
          refresh.hidden = true;
        } else {
          status.textContent = `복구 결과를 확인하지 못했습니다. 연결을 확인한 뒤 다시 확인하세요. ${error instanceof Error ? error.message : String(error)}`;
        }
        status.dataset.state = "error";
      } finally {
        busy = false;
        refresh.disabled = false;
        row.setAttribute("aria-busy", "false");
      }
    })();
  });
  return row;
}
