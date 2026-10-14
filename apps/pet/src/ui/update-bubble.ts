import { command, errorMessage, onProgress, request } from "./bridge.ts";
import { button, element } from "./dom.ts";
import { messages } from "./messages.ts";
import {
  modeOnInstallFailed, modeOnLaunching, modeOnProgress, modeOnYes, updateBubbleView, type BubbleMode, type UpdateMode,
} from "./update-bubble-model.ts";

/** How the update card reads and changes the bubble's one mode (`bubble.ts` owns it). */
export interface UpdateBubbleHooks { mode(): BubbleMode; apply(next: BubbleMode): void }
export interface UpdateCard { element: HTMLElement; render(mode: UpdateMode): void }

/** The update bubble (spec 6.1, 6.2): the notice, which opens the question when clicked; the question with [네] and
 * [아니오]; the download's progress; the failure with its cause. "Yes" asks the host to hold the bubble for the
 * download, downloads and checks the installer in the service, and asks the host to run it, which quits the app. */
export function mountUpdateCard(hooks: UpdateBubbleHooks): UpdateCard {
  const card = element("div", "feedback-card update-card");
  card.hidden = true;
  const summary = element("p", "feedback-summary");
  const yes = button(messages.selfUpdate.yes, () => install(), "update-yes");
  const no = button(messages.selfUpdate.no, () => close(), "update-no");
  const actions = element("div", "update-actions");
  actions.append(no, yes);
  card.append(summary, actions);
  // One install runs at a time here, whatever the mode says; the host also starts only one installer per run.
  let installing = false;

  const update = (): UpdateMode | null => { const mode = hooks.mode(); return mode.kind === "update" ? mode : null; };
  const failWith = (version: string, text: string) => hooks.apply(modeOnInstallFailed(hooks.mode(), version, text));

  async function openConfirm(): Promise<void> {
    const mode = update();
    if (mode === null || mode.phase !== "notice") return;
    try { await command<boolean>("show_update_bubble", { phase: "confirm", version: mode.version }); }
    catch (error) { failWith(mode.version, messages.selfUpdate.openFailed(errorMessage(error))); }
  }
  async function close(): Promise<void> {
    const mode = update();
    try { await command("set_update_bubble", { phase: "closed" }); }
    catch (error) { if (mode !== null) failWith(mode.version, messages.selfUpdate.closeFailed(errorMessage(error))); }
  }
  async function install(): Promise<void> {
    if (installing) return;
    const next = modeOnYes(hooks.mode());
    if (next === null) return;
    installing = true;
    try {
      hooks.apply(next);
      const version = next.version;
      // A refused "busy" (the host's bubble state moved on) ends here: nothing is downloaded or started.
      try { await command("set_update_bubble", { phase: "busy" }); }
      catch (error) { failWith(version, messages.selfUpdate.failed(errorMessage(error))); return; }
      const requestId = crypto.randomUUID();
      let stop: () => void = () => {};
      try {
        stop = await onProgress((event) => { if (event.requestId === requestId) hooks.apply(modeOnProgress(hooks.mode(), event.stage, event.detail)); });
        const result = await request("selfUpdate.install", { version }, requestId);
        hooks.apply(modeOnLaunching(hooks.mode()));
        await command("launch_update_installer", { path: result.installer });
      } catch (error) {
        const text = messages.selfUpdate.failed(errorMessage(error));
        failWith(version, text);
        await command("set_update_bubble", { phase: "failed" })
          .catch((hostError: unknown) => failWith(version, messages.selfUpdate.stateFailed(text, errorMessage(hostError))));
      } finally {
        stop();
      }
    } finally {
      installing = false;
    }
  }

  card.addEventListener("click", (event) => { if (event.target !== yes && event.target !== no) void openConfirm(); });
  card.addEventListener("keydown", (event) => {
    if (event.target === card && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); void openConfirm(); }
  });

  return {
    element: card,
    render(mode) {
      const view = updateBubbleView(mode);
      summary.textContent = view.summary;
      actions.hidden = !view.answers;
      yes.disabled = no.disabled = mode.starting;
      card.dataset.clickable = String(view.opensConfirm);
      if (view.opensConfirm) {
        card.setAttribute("role", "button"); card.tabIndex = 0; card.setAttribute("aria-label", messages.selfUpdate.cardLabel);
      } else {
        card.removeAttribute("role"); card.removeAttribute("tabindex"); card.removeAttribute("aria-label");
      }
    },
  };
}
