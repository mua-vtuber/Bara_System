/**
 * 홈 "자동 정리" 칸(2026-10-10 spec 7.2·7.3) — 지금 정리하기 + 최근 자동 등록과 되돌리기.
 * 서버 실패는 빈 상태로 바꾸지 않고 사유와 함께 오류로 보인다.
 */
import { el } from "../ui/dom.ts";
import { DashboardApiError, getCleanupRun, getCleanupRunAvailability, listEntityRegisterRecords, revertEntityRegisterRecord, startCleanupRun } from "./dashboard-api.ts";
import { ENTITY_REGISTER_STRINGS as S } from "./entity-register-strings.ts";
import type { CleanupRunView, EntityRegisterRevertResult, RecentAutoRegisterItem } from "./types.ts";

/** 진행 상태를 다시 읽는 간격. */
export const RUN_POLL_INTERVAL_MS = 2000;

/** 이미 되돌려졌거나 요청이 맞지 않는 응답 — 실패가 아니라 "이미 처리됨" 으로 보인다. */
const ALREADY_PROCESSED_STATUSES: readonly number[] = [400, 409];

export interface AutoRegisterPanel { root: HTMLElement; refresh(): Promise<void> }

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function revertSummary(r: EntityRegisterRevertResult): string[] {
  const parts: string[] = [];
  if (r.removedAlias) parts.push(S.revertRemovedAlias(r.removedAlias));
  if (r.deletedRow) parts.push(S.revertDeletedRow(r.deletedRow.typeName, r.deletedRow.id));
  if (r.keptRowReason) parts.push(S.revertKeptRow(r.keptRowReason));
  if (r.trashedScheduleNodeId !== null) parts.push(S.revertTrashedSchedule(r.trashedScheduleNodeId));
  if (r.clearedMemoDate !== null) parts.push(S.revertClearedMemoDate(r.clearedMemoDate));
  return parts;
}

export function createAutoRegisterPanel(opts: { onChanged?: () => void; sleep?: (ms: number) => Promise<void>; newKey?: () => string } = {}): AutoRegisterPanel {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const newKey = opts.newKey ?? (() => crypto.randomUUID());
  const button = el("button", { className: "au-btn au-btn--ghost au-btn--small auto-register-run", type: "button" }, S.runButton);
  const availabilityLine = el("p", { className: "auto-register-status auto-register-availability" });
  const status = el("p", { className: "auto-register-status auto-register-progress", "aria-live": "polite" });
  const results = el("ul", { className: "auto-register-results" });
  const notice = el("p", { className: "auto-register-notice", "aria-live": "polite" });
  const list = el("ul", { className: "auto-register-list" });
  // 칸이 화면 폭 전체를 쓰므로 왼쪽은 실행·결과, 오른쪽은 최근 자동 등록으로 나눈다(좁은 화면은 위아래).
  const root = el("div", { className: "auto-register" },
    el("div", { className: "auto-register-run" },
      el("div", { className: "auto-register-run-row" }, button, availabilityLine, status), results),
    el("div", { className: "auto-register-recent" },
      el("h3", { className: "auto-register-subtitle" }, S.recentTitle), notice, list),
  );
  let running = false;

  async function loadAvailability(): Promise<void> {
    availabilityLine.textContent = S.checking;
    button.disabled = true;
    try {
      const a = await getCleanupRunAvailability();
      button.disabled = !a.available || running;
      availabilityLine.textContent = a.available ? "" : S.unavailable(a.reasons);
    } catch (e) {
      availabilityLine.textContent = S.unavailable([message(e)]);
    }
  }

  function renderResults(run: CleanupRunView): void {
    const stopReason = run.aggregates?.stopReason;
    results.replaceChildren(...(run.aggregates?.stageAggregates ?? []).flatMap((s) => [
      el("li", {}, s.autoApplied !== undefined
        ? S.stageResult(s.stage, s.autoApplied, s.proposed ?? 0, s.failures, s.alreadyProcessed ?? 0)
        : S.stageResultPlain(s.stage, s.completed, s.failures)),
      ...(s.failureReasons ?? []).map((r) => el("li", { className: "auto-register-failure" }, r)),
    ]), ...(stopReason ? [el("li", { className: "auto-register-failure" }, S.stopReason(stopReason))] : []));
  }

  async function loadRecent(): Promise<void> {
    try {
      const page = await listEntityRegisterRecords();
      list.replaceChildren(...(page.records.length > 0 ? page.records.map(renderRecord) : [el("li", { className: "auto-register-empty" }, S.emptyRecent)]));
    } catch (e) {
      list.replaceChildren(el("li", { className: "auto-register-error" }, S.listFailed(message(e))));
    }
  }

  function renderRecord(item: RecentAutoRegisterItem): HTMLElement {
    const revert = el("button", { className: "au-btn au-btn--ghost au-btn--small auto-register-revert", type: "button" }, S.revertButton);
    const note = el("span", { className: "auto-register-note" });
    revert.addEventListener("click", () => {
      revert.disabled = true;
      note.textContent = S.reverting;
      void revertEntityRegisterRecord(item.id)
        .then(async (res) => {
          notice.textContent = S.revertDone(revertSummary(res.result));
          await loadRecent();
          opts.onChanged?.();
        })
        .catch(async (e) => {
          if (e instanceof DashboardApiError && ALREADY_PROCESSED_STATUSES.includes(e.status)) {
            notice.textContent = S.alreadyProcessed(message(e));
            await loadRecent();
            return;
          }
          revert.disabled = false;
          note.textContent = S.revertFailed(message(e));
        });
    });
    return el("li", { className: "auto-register-item" },
      el("div", { className: "auto-register-head" },
        el("strong", {}, `${S.itemKind(item.itemKind)} · ${item.name}${item.date ? ` (${item.date})` : ""}`), revert, note),
      el("blockquote", { className: "auto-register-memo", title: S.fromMemo }, item.memoContent ?? S.noMemo),
    );
  }

  /** 끝날 때까지 상태를 읽는다. 읽기가 실패하면 pollFailed 를 보이고 멈춘다(run 은 서버에서 계속될 수 있다). */
  async function pollUntilDone(runId: string): Promise<boolean> {
    for (;;) {
      let view: CleanupRunView;
      try {
        view = await getCleanupRun(runId);
      } catch (e) {
        status.textContent = S.pollFailed(message(e));
        return false;
      }
      if (view.status !== "running") {
        status.textContent = S.finished(view.status);
        renderResults(view);
        return true;
      }
      await sleep(RUN_POLL_INTERVAL_MS);
    }
  }

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    button.disabled = true;
    results.replaceChildren();
    notice.textContent = "";
    status.textContent = S.running;
    try {
      let runId: string;
      try {
        runId = (await startCleanupRun(newKey())).runId;
      } catch (e) {
        status.textContent = S.startFailed(message(e));
        return;
      }
      if (await pollUntilDone(runId)) {
        await loadRecent();
        opts.onChanged?.();
      }
    } finally {
      running = false;
      await loadAvailability();
    }
  }

  button.addEventListener("click", () => { void run(); });

  return {
    root,
    refresh: async () => { await Promise.all([loadAvailability(), loadRecent()]); },
  };
}
