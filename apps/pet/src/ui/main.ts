import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Feedback, ProgressStage } from "../shared/contracts.ts";
import { restoreAutoStart } from "./autostart-restore.ts";
import { command, errorMessage, native, onPanel, onProgress, onTrayError, request } from "./bridge.ts";
import { renderBubble } from "./bubble.ts";
import { renderCleanup } from "./cleanup.ts";
import { button, element, type Notice } from "./dom.ts";
import { isInstallRunning } from "./error-text.ts";
import { errorFeedback, workingFeedback } from "./feedback-model.ts";
import { installLock } from "./install-lock.ts";
import { messages } from "./messages.ts";
import { renderNotebook } from "./notebook.ts";
import { renderOnboarding } from "./onboarding.ts";
import { readOnboarding, startStep, type OnboardingStep } from "./onboarding-model.ts";
import { keptForInstall } from "./panel-view.ts";
import { renderQuick } from "./quick.ts";
import { renderRecovery } from "./recovery.ts";
import { renderResult } from "./result.ts";
import { renderSettings } from "./settings.ts";
import { renderGuide } from "./guide.ts";
import { readServerUpdate, startupServerUpdateNotice, tunnelPortText } from "./settings-helpers.ts";
import { renderPet } from "./squirrel/pet-view.ts";
import { startupFailureFeedback } from "./startup-failure.ts";
import { observeStartupCheck } from "./startup-check.ts";
import "./style.css";
import "./notebook.css";
import "./self-update.css";
import "./recent-history.css";
import "./guide.css";

const app = document.querySelector<HTMLDivElement>("#app")!;
const view = new URLSearchParams(location.search).get("view") ?? "main";
document.documentElement.dataset.surface = ["pet", "quick", "bubble"].includes(view) ? view : "main";

if (view === "pet") {
  renderPet(app);
} else if (view === "quick") {
  renderQuick(app);
} else if (view === "bubble") {
  renderBubble(app);
} else if (view === "guide") {
  renderGuide(app);
} else {
  const notebook = renderNotebook({
    navigate: show, native,
    drag: () => { if (native) void getCurrentWindow().startDragging().catch(error => notice(errorMessage(error), "error")); },
    minimize: () => { if (native) void getCurrentWindow().minimize().catch(error => notice(errorMessage(error), "error")); },
    close: () => { if (native) void command("hide_panel").catch(error => notice(errorMessage(error), "error")); },
  });
  const { shell, content, status, footer } = notebook;
  const notice: Notice = (message, kind = "info") => { status.dataset.kind = kind; status.textContent = message; };
  const dashboardStatus = element("p", "action-status");
  dashboardStatus.setAttribute("role", "status"); dashboardStatus.hidden = true;
  const dashboard = button(messages.main.openDashboard, async () => {
    dashboard.disabled = true;
    dashboardStatus.hidden = false; dashboardStatus.dataset.kind = "info";
    dashboardStatus.textContent = messages.main.openingDashboard;
    try {
      await command("open_dashboard");
      dashboardStatus.dataset.kind = "success"; dashboardStatus.textContent = messages.main.dashboardOpened;
    } catch (error) {
      // An install still running is not a failure: the dashboard opens once it is done (`INSTALL_RUNNING`).
      dashboardStatus.dataset.kind = isInstallRunning(error) ? "info" : "error"; dashboardStatus.textContent = errorMessage(error);
    } finally { dashboard.disabled = false; }
  }, "button secondary notebook-dashboard");
  const guide = button(messages.guide.open, async () => {
    if (!native) { window.open("?view=guide", "bara-guide"); return; }
    try { await command("open_guide"); } catch (error) { notice(errorMessage(error), "error"); }
  }, "text-button");
  notebook.tools.append(button(messages.feedback.lastAnswer, () => show("answer"), "text-button"), guide, dashboard, dashboardStatus);
  footer.append(button(messages.feedback.openQuickInput, () => openQuick("input"), "button primary"),
    button(messages.feedback.openQuickQuestion, () => openQuick("question"), "button secondary"));
  app.append(shell);
  let dispose = () => {}, renderVersion = 0, firstRunOpened = false;
  /** Where the first-run setup resumes when it opens; decided once at startup from the saved progress. */
  let onboardingStart: OnboardingStep | undefined;
  /** The view on screen, so the host's `pet-panel` (sent each time it brings the panel up) does not draw the setup
   * or the settings a second time. */
  let currentMode: string | null = null;
  /** Opens the first-run setup at `step` in the main window; the window is brought up once per start. */
  function openOnboarding(step: OnboardingStep) {
    onboardingStart = step; show("onboarding");
    if (!firstRunOpened) { firstRunOpened = true; void command("open_panel", { mode: "onboarding" }).catch(() => notice(messages.errors.fallback, "error")); }
  }

  async function openQuick(mode: "input" | "question") {
    if (installLock.running) { notice(messages.installLock.quickRefused); return; }
    try { await command("hide_panel"); await command("open_quick", { mode }); }
    catch (error) { notice(errorMessage(error), "error"); }
  }
  function show(mode: string) {
    if (mode === "input" || mode === "question") { void openQuick(mode); return; }
    // The host sends `pet-panel` whenever it brings the panel up (the tray's "설정", the pet's menu, the echo of
    // `open_panel`), also when the panel already shows that view. The setup and the settings stay as they are, so a
    // step, a form being filled in or a backup's progress is not reset; a result is drawn again, as the latest one.
    // While an install runs in the view on screen, no other view replaces it: the window comes up showing the install.
    if (keptForInstall(currentMode, mode, installLock.running)) { notice(messages.installLock.viewKept(messages.settings.stopSetup)); return; }
    notebook.change(currentMode, mode, () => {
      currentMode = mode;
      const version = ++renderVersion;
      dispose(); dispose = () => {}; content.replaceChildren();
      notice("");
      if (mode === "onboarding") {
        dispose = renderOnboarding(content, notice, onboardingStart ?? "storage", () => {
          onboardingStart = undefined; show("result"); notice(messages.onboarding.done, "success");
          void command("hide_panel").catch(() => {});
        });
      } else if (mode === "settings") {
        dispose = renderSettings(content, notice, () => { void openQuick("input"); }, step => openOnboarding(step));
      } else if (mode === "cleanup") {
        dispose = renderCleanup(content, notice);
      } else if (mode === "recovery") {
        dispose = renderRecovery(content, notice);
      } else {
        const last = mode === "answer";
        const get = last ? "get_last_answer" : "get_feedback";
        void (native ? command<Feedback | null>(get) : Promise.resolve(null)).then(feedback => {
          if (version === renderVersion) dispose = renderResult(content, feedback, notice, () => show("settings"));
        }).catch(error => {
          if (version === renderVersion) { notice(errorMessage(error), "error"); dispose = renderResult(content, null, notice, () => show("settings")); }
        });
      }
    });
  }
  show("result");
  void onPanel(show);
  /** A tray menu command has no window of its own, so its failure goes to the bubble. The status line keeps
   * the text too, with the cause, when the bubble cannot be published. The tray's "대시보드" refused while an install
   * runs (`INSTALL_RUNNING`) is no failure and the bubble has no informational kind, so it is told only as
   * information on the status line; the pet's own "설치 중" notice already shows that the install runs. */
  void onTrayError(error => {
    const text = errorMessage(error);
    if (isInstallRunning(error)) { notice(text, "info"); return; }
    notice(text, "error");
    void command("publish_feedback", { feedback: errorFeedback(crypto.randomUUID(), "input", text) })
      .catch(publishError => notice(messages.quick.bubbleUnpublished(text, errorMessage(publishError)), "error"));
  });
  /** This window is hidden while the pet starts, so a failed startup step also goes to the pet's bubble.
   * A bubble that cannot be published is recorded on the status line with its cause (`text`). */
  function publishStartupFailure(feedback: Feedback, text: string) {
    void command("publish_feedback", { feedback })
      .catch(error => notice(messages.quick.bubbleUnpublished(text, errorMessage(error)), "error"));
  }
  if (native) {
    // The native host starts the startup check as soon as the app starts, whether or not this page ever loads
    // (`src-tauri/src/startup.rs`); this window joins that same run (`startup.check`) and never starts a second one.
    // The check names the step that failed (reading the settings, or checking the connection), so each reaches the
    // status line and the bubble with its own text. A failure of the first-run screen below is not a failed step, so
    // it reaches the status line alone, through the last catch.
    // The check may start the local memory server, and a new version backs the memories up first, which can take
    // minutes: its progress goes to the status line, and the backup also to the pet's bubble (this window is hidden),
    // taken down again once the check connects. A failure replaces the bubble with its own. The update of a remote
    // server the Pet installed (spec 5.3) is shown the same way.
    // The bubbles are this window's only when it takes the report first (`claim_startup_report`); otherwise the
    // check had already ended and the host showed its failure, and this window keeps to its status line.
    const startupRequest = crypto.randomUUID();
    let reportsStartup = false;
    // One bubble for the long startup stages, its text following the stage.
    const bubbleStages = new Set<ProgressStage>(["update-backup", "server-update"]);
    let workBubble = "";
    let bubbleStage: ProgressStage | null = null;
    const stopProgress = onProgress(event => {
      if (event.requestId !== startupRequest) return;
      notice(messages.progress[event.stage]);
      if (!bubbleStages.has(event.stage) || event.stage === bubbleStage || !reportsStartup) return;
      bubbleStage = event.stage;
      workBubble ||= crypto.randomUUID();
      void command("publish_feedback", { feedback: { ...workingFeedback(workBubble, "input", messages.progress[event.stage]), origin: "background" } })
        .catch(() => {});
    });
    const clearWorkBubble = () => {
      if (!workBubble) return;
      void command<Feedback | null>("get_feedback").then(current => current?.id === workBubble ? command("dismiss_feedback") : undefined).catch(() => {});
    };
    // A claim that cannot be made leaves the report to the host, which then shows a failure itself.
    const startup = command<boolean>("claim_startup_report").catch(() => false).then(claimed => {
      reportsStartup = claimed;
      return observeStartupCheck(() => request("startup.check", {}, startupRequest));
    });
    // Once the check has settled, whatever its outcome: puts back the login autostart an older version's uninstaller
    // deleted during an update (`autostart-restore.ts`). Best effort and silent; the settings screen shows the
    // registry's actual state either way.
    void startup.catch(() => {}).then(() => restoreAutoStart({
      readRun: async () => (await request("status", {})).maintenance.run,
      readSavedPreference: async () => (await request("settings.get", {})).autoStart,
      hasEntry: () => command<boolean>("has_autostart_entry"),
      enable: () => command("set_autostart", { enabled: true }),
    }));
    void startup.finally(() => {
      void stopProgress.then(stop => stop()).catch(() => {});
    }).then(check => {
      if (check.kind === "firstRun") {
        openOnboarding("storage"); notice(messages.main.connectStorage);
      } else if (check.kind === "connected") {
        notice(check.message, "success");
        clearWorkBubble();
        // A server update that failed but left the server serving (rolled back, refused, or stopped before it reached
        // the server) is told here; one that left it stopped already failed the check above with its cause. A status
        // that cannot be read is told with its cause too, so a failed update never looks like success. A remote
        // tunnel that could not take its preferred port (Claude Code's bara MCP address) is told first.
        const status = request("status", {});
        void Promise.all([readServerUpdate(() => status, errorMessage),
          status.then(value => tunnelPortText(value.tunnelPort), () => null)]).then(([read, tunnelText]) => {
          if (tunnelText !== null) notice(tunnelText, "info");
          const text = startupServerUpdateNotice(read);
          if (text === null) return;
          notice(text, "error");
          if (reportsStartup) publishStartupFailure({ ...errorFeedback(crypto.randomUUID(), "input", text), origin: "background" }, text);
        }).catch(error => notice(errorMessage(error), "error"));
        // A setup left part-way (storage connected, later steps not finished) resumes where it stopped, but only
        // while the user has not opened another view during the check (that view is not replaced under them).
        const resume = startStep(readOnboarding(), true);
        if (resume !== "done" && currentMode === "result") openOnboarding(resume);
      }
      else {
        notice(check.text, "error");
        if (reportsStartup) publishStartupFailure(startupFailureFeedback(crypto.randomUUID(), check.stage, check.reason), check.text);
      }
    }).catch(error => notice(errorMessage(error), "error"));
  } else notice(messages.errors.desktopOnly);
}
