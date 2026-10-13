import type { AiDiscovery, AiProbeResult, AiProvider, CleanupProvider, PublicSettings } from "../shared/contracts.ts";
import { DEFAULT_AI_URLS } from "../shared/contracts.ts";
import { errorMessage, native, request } from "./bridge.ts";
import { checkListedModels, cleanupProviderOptions, cleanupUsesAnswerServer, keyStillApplies, modelOptions, sameAiServer, serverChoices, slotStatus, suggestedModel, type SlotStatus } from "./ai-settings-model.ts";
import { button, element, field, input, select, type Notice } from "./dom.ts";
import { messages } from "./messages.ts";
import { aiUrlForProvider } from "./settings-helpers.ts";

/** The answer AI and cleanup AI settings: find the AI running on this PC, pick a program and a model from
 * lists (address and model name typed by hand only under "advanced"), and show for each slot whether it is
 * saved and, separately, whether it can actually be used. Used by the settings screen; built as its own
 * part so the first-run setup can reuse it. */
export interface AiSettingsView {
  element: HTMLElement;
  populate(settings: PublicSettings): void;
  /** The saved settings could not be read; the controls stay disabled. */
  loadFailed(text: string): void;
  /** Whether either slot has edits not saved yet. */
  dirty(): boolean;
  /** Saves both slots and checks them, as "AI 설정 저장" does; true once the settings were saved. */
  save(): Promise<boolean>;
  dispose(): void;
}

export function renderAiSettings(notice: Notice): AiSettingsView {
  let live = true, ready = !native, busy = false;
  /** Unsaved edits of each slot. A cleanup AI that follows the answer AI's server is not edited by a change
   * of that server; only its status line says it must be checked again. */
  let answerDirty = false, cleanupDirty = false;
  let models: string[] = [];
  /** Whether `models` came from a server this screen actually asked; before that a saved model is not called missing. */
  let listed = false;
  let discovery: AiDiscovery | null = null;
  /** The answer AI as last saved, and whether an API key is stored for it (bound to that provider and address). */
  let saved = { provider: "none", baseUrl: "", hasAiKey: false };
  /** Checks still running, cancelled when the screen closes (a Claude Code or Codex check runs external programs). */
  const checks = new Set<string>();
  const root = element("details", "settings-details"); root.append(element("summary", "", messages.settings.aiHeading));

  const find = button(messages.settings.findAi, findAi);
  const discoveryStatus = element("p", "hint");
  const choiceList = element("div", "stack-actions");

  const aiProvider = select([["none", messages.settings.noAiSearch], ["ollama", messages.settings.ollamaThisPc], ["openai-compatible", messages.settings.compatibleApi]], "none");
  const modelSelect = select(modelOptions([], ""), "");
  const aiUrl = input("url", DEFAULT_AI_URLS.ollama, messages.settings.aiAddress);
  const aiModel = input("text", "", messages.settings.modelName);
  const aiKey = input("password", "", messages.settings.optionalApiKey);
  const loadModels = button(messages.settings.loadModels, loadModelsAtAddress);
  const advanced = element("details", "settings-details"); advanced.append(element("summary", "", messages.settings.aiAdvanced));
  advanced.append(field(messages.settings.aiAddress, aiUrl), field(messages.settings.modelName, aiModel), field(messages.settings.apiKey, aiKey), loadModels);
  const keyStatus = element("p", "hint"); keyStatus.hidden = true;
  const answerStatus = statusLine();

  const cleanupProvider = select(cleanupProviderOptions(null), "none");
  const cleanupModel = input("text", "", messages.settings.defaultModel);
  const cleanupModels = element("datalist"); cleanupModels.id = `cleanup-models-${crypto.randomUUID()}`;
  cleanupModel.setAttribute("list", cleanupModels.id);
  const cleanupStatus = statusLine();

  const save = button(messages.settings.saveAi, () => { void saveAll(); }, "button primary");
  const saveStatus = statusLine(native ? messages.settings.aiLoading : "");

  root.append(find, discoveryStatus, choiceList,
    field(messages.settings.answerAi, aiProvider), field(messages.settings.model, modelSelect), keyStatus, advanced,
    labelled(messages.settings.answerStatusLabel, answerStatus),
    field(messages.settings.cleanupAi, cleanupProvider, messages.settings.cleanupProviderHint), field(messages.settings.cleanupModel, cleanupModel), cleanupModels,
    labelled(messages.settings.cleanupStatusLabel, cleanupStatus),
    save, saveStatus);

  function statusLine(text = ""): HTMLParagraphElement {
    const line = element("p", "action-status", text); line.setAttribute("role", "status"); line.setAttribute("aria-live", "polite");
    return line;
  }
  function labelled(label: string, line: HTMLElement): HTMLElement {
    const box = element("div", "field"); box.append(element("span", "field-label", label), line); return box;
  }
  function show(line: HTMLElement, status: SlotStatus | { text: string; kind: SlotStatus["kind"] }) {
    if (!live) return;
    line.textContent = status.text; line.dataset.kind = status.kind;
  }
  function setBusy(value: boolean) {
    busy = value;
    for (const control of [find, aiProvider, modelSelect, aiUrl, aiModel, aiKey, loadModels, cleanupProvider, cleanupModel, save, ...choiceList.querySelectorAll("button")])
      control.disabled = !ready || busy;
  }
  function renderModels() {
    const current = aiModel.value.trim();
    modelSelect.replaceChildren(...modelOptions(models, current, listed).map(([value, label]) => { const option = element("option", "", label); option.value = value; return option; }));
    modelSelect.value = current;
    // Suggestions for the cleanup model only when the cleanup AI runs on the answer AI's server.
    const suggestions = cleanupUsesAnswerServer(cleanupProvider.value as CleanupProvider) ? models : [];
    cleanupModels.replaceChildren(...suggestions.map(model => { const option = element("option"); option.value = model; return option; }));
  }
  function setModels(next: string[], fromServer: boolean) { models = next; listed = fromServer; renderModels(); }
  /** The stored key belongs to the saved provider and address only; say so as soon as the screen points elsewhere. */
  function renderKeyStatus() {
    const keyKept = saved.hasAiKey && keyStillApplies({ provider: aiProvider.value, baseUrl: aiUrl.value }, saved);
    aiKey.placeholder = keyKept ? messages.settings.savedApiKey : messages.settings.optionalApiKey;
    keyStatus.hidden = !saved.hasAiKey || keyKept;
    keyStatus.textContent = keyStatus.hidden ? "" : messages.settings.keyNotForThisServer;
  }
  /** A server-kind cleanup AI follows the answer AI's server, so changing that server changes it too. */
  function answerServerChanged() {
    renderKeyStatus();
    if (cleanupUsesAnswerServer(cleanupProvider.value as CleanupProvider)) show(cleanupStatus, slotStatus(false, null));
  }
  function renderCleanupProviders() {
    const value = cleanupProvider.value;
    cleanupProvider.replaceChildren(...cleanupProviderOptions(discovery).map(([key, label]) => { const option = element("option", "", label); option.value = key; return option; }));
    cleanupProvider.value = value;
  }
  function markAnswerDirty() { answerDirty = true; show(answerStatus, slotStatus(false, null)); }
  function markCleanupDirty() { cleanupDirty = true; show(cleanupStatus, slotStatus(false, null)); }

  async function findAi() {
    if (!ready || busy) return;
    setBusy(true); show(discoveryStatus, { text: messages.settings.findingAi, kind: "info" });
    try {
      const found = await request("ai.discover", {});
      if (!live) return;
      discovery = found; renderCleanupProviders();
      const choices = serverChoices(found);
      choiceList.replaceChildren(...choices.map(choice => button(choice.label, () => {
        if (!ready || busy) return;
        const sameServer = sameAiServer({ provider: aiProvider.value, baseUrl: aiUrl.value }, choice);
        aiProvider.value = choice.provider;
        // Keep the address as the user saved it when it is the same server under another loopback name.
        if (!sameServer) { aiUrl.value = choice.baseUrl; aiKey.value = ""; }
        aiModel.value = suggestedModel(choice.models, sameServer ? aiModel.value.trim() : "");
        setModels(choice.models, true); markAnswerDirty();
        if (!sameServer) answerServerChanged();
        show(discoveryStatus, { text: messages.settings.pickedServer(choice.label), kind: "info" });
      })));
      show(discoveryStatus, { text: choices.length ? messages.settings.foundAi : messages.settings.foundNoAi, kind: choices.length ? "info" : "error" });
    } catch (error) { show(discoveryStatus, { text: errorMessage(error), kind: "error" }); }
    finally { if (live) setBusy(false); }
  }

  async function persist(includeCleanup: boolean): Promise<PublicSettings> {
    const result = await request("settings.save", {
      ai: { provider: aiProvider.value as AiProvider, baseUrl: aiUrl.value.trim(), model: aiModel.value.trim() },
      ...(includeCleanup ? { cleanup: { provider: cleanupProvider.value as CleanupProvider, model: cleanupModel.value.trim() } } : {}),
      ...(aiKey.value ? { aiKey: aiKey.value } : {}),
    });
    if (live) applySaved(result, includeCleanup);
    return result;
  }
  function applySaved(value: PublicSettings, includeCleanup: boolean) {
    aiProvider.value = value.ai.provider; aiUrl.value = value.ai.baseUrl; aiModel.value = value.ai.model;
    saved = { provider: value.ai.provider, baseUrl: value.ai.baseUrl, hasAiKey: value.hasAiKey };
    aiKey.value = ""; renderKeyStatus(); answerDirty = false;
    if (includeCleanup) { cleanupProvider.value = value.cleanup.provider; cleanupModel.value = value.cleanup.model; cleanupDirty = false; }
    renderModels();
  }

  /** Checks one slot with the saved settings. A failed check is shown on that slot's line, never as a failed save. */
  async function check(target: "answer" | "cleanup", line: HTMLElement): Promise<AiProbeResult | null> {
    show(line, { text: messages.settings.checkingAi, kind: "info" });
    const id = crypto.randomUUID(); checks.add(id);
    try {
      const result = await request("ai.probe", { target }, id);
      show(line, slotStatus(true, result, target === "answer" || cleanupProvider.value !== "none"));
      return result;
    } catch (error) {
      show(line, { text: messages.settings.slotNotUsable(errorMessage(error)), kind: "error" });
      return null;
    } finally { checks.delete(id); }
  }

  async function saveAll(): Promise<boolean> {
    if (!ready || busy) return false;
    setBusy(true); show(saveStatus, { text: messages.settings.aiSaving, kind: "info" });
    try {
      await persist(true);
      if (!live) return true;
      show(saveStatus, { text: messages.settings.aiSaved, kind: "success" }); notice(messages.settings.aiSaved, "success");
      const [answer] = await Promise.all([check("answer", answerStatus), check("cleanup", cleanupStatus)]);
      if (live && answer && checkListedModels(answer)) setModels(answer.models, true);
      return true;
    } catch (error) {
      if (live) { show(saveStatus, { text: errorMessage(error), kind: "error" }); notice(errorMessage(error), "error"); }
      return false;
    } finally { if (live) setBusy(false); }
  }

  /** "Advanced": save the answer AI at a typed address and list that server's models. The cleanup slot is
   * left as it is on screen (saved only by "AI 설정 저장"). */
  async function loadModelsAtAddress() {
    if (!ready || busy) return;
    setBusy(true); show(saveStatus, { text: messages.settings.aiSaving, kind: "info" });
    try {
      await persist(false);
      if (!live) return;
      const text = cleanupDirty ? messages.settings.answerAiSavedCleanupPending : messages.settings.answerAiSaved;
      show(saveStatus, { text, kind: "success" });
      // The saved cleanup slot may run on this server too: check it again unless its own edits are unsaved.
      const cleanupFollows = cleanupUsesAnswerServer(cleanupProvider.value as CleanupProvider) && !cleanupDirty;
      const [result] = await Promise.all([check("answer", answerStatus), cleanupFollows ? check("cleanup", cleanupStatus) : null]);
      if (!live || !result) return;
      if (!checkListedModels(result)) return;
      const suggested = suggestedModel(result.models, aiModel.value.trim());
      if (suggested !== aiModel.value.trim()) { aiModel.value = suggested; markAnswerDirty(); }
      setModels(result.models, true);
    } catch (error) {
      if (live) { show(saveStatus, { text: errorMessage(error), kind: "error" }); notice(errorMessage(error), "error"); }
    } finally { if (live) setBusy(false); }
  }

  aiProvider.addEventListener("change", () => {
    aiUrl.value = aiUrlForProvider(aiProvider.value as AiProvider, aiUrl.value);
    setModels([], false); answerServerChanged();
  });
  modelSelect.addEventListener("change", () => { aiModel.value = modelSelect.value; renderModels(); markAnswerDirty(); });
  aiModel.addEventListener("input", () => renderModels());
  aiUrl.addEventListener("input", () => { setModels([], false); answerServerChanged(); });
  cleanupProvider.addEventListener("change", () => renderModels());
  for (const control of [aiProvider, aiUrl, aiModel, aiKey]) control.addEventListener("input", markAnswerDirty);
  for (const control of [cleanupProvider, cleanupModel]) control.addEventListener("input", markCleanupDirty);
  setBusy(false);

  return {
    element: root,
    populate(settings) {
      applySaved(settings, true);
      show(answerStatus, slotStatus(true, null)); show(cleanupStatus, slotStatus(true, null));
      ready = true; setBusy(false); show(saveStatus, { text: messages.settings.aiLoaded, kind: "success" });
    },
    loadFailed(text) { show(saveStatus, { text, kind: "error" }); },
    dirty: () => answerDirty || cleanupDirty,
    save: saveAll,
    dispose() {
      live = false;
      for (const requestId of checks) void request("operation.cancel", { requestId }).catch(() => {});
    },
  };
}
