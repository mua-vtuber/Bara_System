import type { PublicSettings } from "../shared/contracts.ts";
import { renderAiSettings } from "./ai-settings.ts";
import { slotStatus, type SlotStatus } from "./ai-settings-model.ts";
import { command, errorMessage, native, request } from "./bridge.ts";
import { button, element, type Notice } from "./dom.ts";
import { messages } from "./messages.ts";
import { createStepScope } from "./onboarding-lifecycle.ts";
import { nextStep, ONBOARDING_KEY, ONBOARDING_STEPS, previousStep, record, stepNumber, type OnboardingStep } from "./onboarding-model.ts";
import { renderAutoStart, renderConnection } from "./settings.ts";

/** Saving progress only decides where the setup resumes; a failure is reported but never stops it. */
function writeOnboarding(step: OnboardingStep | "done", notice: Notice): void {
  try { localStorage.setItem(ONBOARDING_KEY, JSON.stringify(record(step))); }
  catch { notice(messages.onboarding.progressNotSaved, "error"); }
}

/** The first-run setup: where to keep memories → which AI → a check of each part → pet or tray only.
 * Each step reuses the settings screen's own parts, so the two never drift apart. `finished` runs after the
 * last step. "나중에 하기" finishes it at any step; an unfinished setup resumes at the next start or from the
 * settings screen's "처음 설정 이어 하기". */
export function renderOnboarding(host: HTMLElement, notice: Notice, start: OnboardingStep, finished: () => void): () => void {
  host.replaceChildren();
  let live = true, dispose = () => {};
  const scope = createStepScope();
  const heading = element("div", "composer-intro");
  const title = element("h1"); const progress = element("p", "muted");
  // Leaving is always possible: the setup is marked finished and every part stays in the settings screen.
  const later = button(messages.onboarding.skipSetup, () => { notice(messages.onboarding.laterNotice); go("done"); }, "text-button");
  heading.append(title, progress, later);
  const body = element("div", "onboarding-step");
  const actions = element("div", "stack-actions");
  host.append(heading, body, actions);

  function go(step: OnboardingStep | "done") {
    if (!live) return;
    const isCurrent = scope.enter();
    writeOnboarding(step, notice);
    dispose(); dispose = () => {}; body.replaceChildren(); actions.replaceChildren();
    if (step === "done") { live = false; finished(); return; }
    title.textContent = messages.onboarding.titles[step];
    progress.textContent = messages.onboarding.progress(stepNumber(step), ONBOARDING_STEPS.length, messages.onboarding.intros[step]);
    const back = previousStep(step);
    if (back) actions.append(button(messages.onboarding.back, () => { if (isCurrent()) go(back); }));
    if (step === "storage") storageStep(isCurrent);
    else if (step === "ai") aiStep(isCurrent);
    else if (step === "check") checkStep(isCurrent);
    else displayStep(isCurrent);
  }
  const next = (step: OnboardingStep, isCurrent: () => boolean) => () => { if (isCurrent()) go(nextStep(step)); };

  function withSettings(isCurrent: () => boolean, use: (settings: PublicSettings) => void, failed: (text: string) => void) {
    if (!native) return;
    void request("settings.get", {}).then(value => { if (isCurrent()) use(value); })
      .catch(error => { if (isCurrent()) { failed(errorMessage(error)); notice(errorMessage(error), "error"); } });
  }

  function storageStep(isCurrent: () => boolean) {
    const connection = renderConnection(notice, next("storage", isCurrent));
    body.append(connection.element); dispose = () => connection.dispose();
    withSettings(isCurrent, value => connection.populate(value), () => {});
  }

  function aiStep(isCurrent: () => boolean) {
    const ai = renderAiSettings(notice);
    (ai.element as HTMLDetailsElement).open = true;
    body.append(ai.element, element("p", "hint", messages.onboarding.aiLater));
    dispose = () => ai.dispose();
    withSettings(isCurrent, value => ai.populate(value), text => ai.loadFailed(text));
    // A program or model picked but not saved would be lost on leaving the step, so "다음" saves it first and
    // moves on only once the save succeeded (a failed save stays here with its cause shown).
    const forward = button(messages.onboarding.next, async () => {
      if (!isCurrent()) return;
      if (ai.dirty()) { forward.disabled = true; const saved = await ai.save(); if (isCurrent()) forward.disabled = false; if (!saved) return; }
      next("ai", isCurrent)();
    }, "button primary");
    actions.append(forward);
  }

  function checkStep(isCurrent: () => boolean) {
    const lines = new Map<"storage" | "answer" | "cleanup", HTMLParagraphElement>();
    for (const [key, label] of [["storage", messages.onboarding.storageLabel], ["answer", messages.settings.answerStatusLabel], ["cleanup", messages.settings.cleanupStatusLabel]] as const) {
      const line = element("p", "action-status"); line.setAttribute("role", "status");
      const box = element("div", "field"); box.append(element("span", "field-label", label), line);
      body.append(box); lines.set(key, line);
    }
    const show = (key: "storage" | "answer" | "cleanup", status: SlotStatus) => {
      const line = lines.get(key)!; if (!isCurrent()) return;
      line.textContent = status.text; line.dataset.kind = status.kind;
    };
    // One check at a time; leaving the step cancels what is still running (a Claude Code or Codex check runs
    // external programs, and a pending connection test would keep the service busy for the next step).
    const running = new Set<string>();
    dispose = () => { for (const requestId of running) void request("operation.cancel", { requestId }).catch(() => {}); };
    const tracked = <T>(run: (id: string) => Promise<T>): Promise<T> => {
      const id = crypto.randomUUID(); running.add(id);
      return run(id).finally(() => running.delete(id));
    };
    const recheck = button(messages.onboarding.recheck, () => { void check(); });
    async function check() {
      if (running.size > 0 || !isCurrent()) return;
      recheck.disabled = true;
      for (const key of lines.keys()) show(key, { text: messages.onboarding.checking, kind: "info" });
      try {
        const settings = await tracked(id => request("settings.get", {}, id)).catch(() => null);
        if (!isCurrent()) return;
        const storage = tracked(id => request("connection.test", {}, id))
          .then(result => show("storage", { text: result.message, kind: result.connected ? "success" : "error" }))
          .catch(error => show("storage", { text: errorMessage(error), kind: "error" }));
        const slot = (target: "answer" | "cleanup", chosen: boolean) => !chosen
          ? Promise.resolve(show(target, { text: messages.onboarding.later, kind: "info" }))
          : tracked(id => request("ai.probe", { target }, id))
            .then(result => show(target, slotStatus(true, result)))
            .catch(error => show(target, { text: messages.settings.slotNotUsable(errorMessage(error)), kind: "error" }));
        await Promise.all([storage,
          slot("answer", settings?.ai.provider !== "none"),
          slot("cleanup", settings?.cleanup.provider !== "none")]);
      } finally { if (isCurrent()) recheck.disabled = false; }
    }
    actions.append(recheck, button(messages.onboarding.next, next("check", isCurrent), "button primary"));
    if (native) void check();
  }

  function displayStep(isCurrent: () => boolean) {
    let mode: "pet" | "tray" = "pet";
    const choices = element("div", "install-choices");
    const options = new Map<"pet" | "tray", HTMLButtonElement>();
    for (const [key, name, description] of [["pet", messages.onboarding.showPet, messages.onboarding.showPetDescription], ["tray", messages.onboarding.trayOnly, messages.onboarding.trayOnlyDescription]] as const) {
      const choice = button("", () => pick(key), "install-choice");
      choice.append(element("strong", "", name), element("span", "", description));
      options.set(key, choice); choices.append(choice);
    }
    function pick(value: "pet" | "tray") {
      mode = value;
      for (const [key, choice] of options) choice.setAttribute("aria-pressed", String(key === mode));
    }
    pick(mode);
    if (native) void command<string>("get_display_mode").then(current => { if (isCurrent() && (current === "pet" || current === "tray")) pick(current); }).catch(() => {});
    const autoStart = renderAutoStart(notice);
    dispose = () => autoStart.dispose();
    body.append(choices, element("p", "hint", messages.onboarding.trayHint), autoStart.element);
    withSettings(isCurrent, value => autoStart.populate(value), () => {});
    const finish = button(messages.onboarding.finish, async () => {
      if (!isCurrent()) return;
      finish.disabled = true;
      try { if (native) await command("set_display_mode", { mode }); if (isCurrent()) go("done"); }
      catch (error) { if (isCurrent()) notice(errorMessage(error), "error"); }
      finally { if (isCurrent()) finish.disabled = false; }
    }, "button primary");
    actions.append(finish);
  }

  go(start);
  return () => { live = false; scope.invalidate(); dispose(); };
}
