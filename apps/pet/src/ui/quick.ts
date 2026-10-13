import { connectionAudience, type Feedback } from "../shared/contracts.ts";
import { command, errorMessage, native, onProgress, onQuick, request } from "./bridge.ts";
import { DRAFT_EVENT, activeSaves, beginSubmission, finishSubmission, readDraft, readSubmissions, writeDraft } from "./drafts.ts";
import { button, element } from "./dom.ts";
import { answerFeedback, canShowProgress, errorFeedback, failedClassificationReason, mergeIncomingDraft, quickLengthError, reserveOperation, savedFeedback, storageAccessFailed, storageAccessSucceeded, storageOutboxRead, switchQuickMode, workingFeedback, type OperationState, type QuickMode, type QuickModeState, type StorageAccess, type StorageNotices } from "./feedback-model.ts";
import { labels, messages } from "./messages.ts";
import { loadQuickMode, quickSendState } from "./quick-model.ts";
import { completeDraft, nextDraft, shouldSend } from "./state.ts";

export function renderQuick(host: HTMLElement): () => void {
  host.replaceChildren();
  let state: QuickModeState = { mode: "input", content: "", requestId: "" };
  let busy = false, composing = false, live = true;
  let operation: OperationState | null = null;
  let submittedDraftId = "", activeMode: QuickMode | null = null, activeAudience = "";
  let eventVersion = 0;
  let unlistenQuick: (() => void) | undefined, unlistenProgress: (() => void) | undefined;
  let feedbackQueue: Promise<void> = Promise.resolve();
  let initialStorageFailure: { access: StorageAccess; error: unknown } | null = null;
  let storageNotices: StorageNotices = {};
  let initialAccess: StorageAccess = "readDraft";
  try { const draft = readDraft(); state = { ...state, content: draft.content, requestId: draft.requestId }; initialAccess = "readSubmissions"; readSubmissions(); }
  catch (error) { initialStorageFailure = { access: initialAccess, error }; }

  const strip = element("div", "quick-strip");
  const modes = element("div", "quick-modes"); modes.setAttribute("role", "group"); modes.setAttribute("aria-label", messages.main.navigationLabel);
  const inputMode = button(messages.quick.input, () => setMode("input"), "quick-mode");
  const questionMode = button(messages.quick.question, () => setMode("question"), "quick-mode");
  modes.append(inputMode, questionMode);
  const area = element("textarea", "quick-field"); area.rows = 2; area.value = state.content;
  const send = button(messages.quick.send, submit, "quick-send");
  const liveStatus = element("span", "visually-hidden"); liveStatus.setAttribute("role", "status"); liveStatus.setAttribute("aria-live", "polite");
  strip.append(modes, area, send); host.append(strip, liveStatus);

  /** A draft storage failure (readDraft/readSubmissions/writeDraft/finishSubmission) is shown in the
   * feedback bubble (PW-0): the fixed 480x82 strip has no room for another visible line. `liveStatus`
   * carries the same cause for screen readers, and one broken store publishes one bubble per distinct
   * cause instead of one per keystroke. Sending input stays blocked while `storageNotices` holds any
   * failing access (`updateButton`). */
  function reportStorageFailure(access: StorageAccess, error: unknown) {
    const failure = storageAccessFailed(storageNotices, access, errorMessage(error));
    storageNotices = failure.notices;
    liveStatus.textContent = failure.text;
    if (failure.publish) void publishOrRecord(errorFeedback(crypto.randomUUID(), state.mode, failure.text), failure.text);
  }
  /** The access worked: a failure it had is over, so the same cause is published again if it returns. */
  function storageWorked(access: StorageAccess) { storageNotices = storageAccessSucceeded(storageNotices, access); }
  if (initialStorageFailure) reportStorageFailure(initialStorageFailure.access, initialStorageFailure.error);

  function queueFeedback(feedback: Feedback): Promise<void> {
    if (!native) return Promise.resolve();
    feedbackQueue = feedbackQueue.catch(() => {}).then(() => command("publish_feedback", { feedback }));
    return feedbackQueue;
  }
  /** Publish `feedback` to the bubble without ever rejecting. When the bubble cannot be shown,
   * `liveStatus` keeps what it should have said (`text`) and why it failed, so a failed publish is
   * never dropped silently. */
  function publishOrRecord(feedback: Feedback, text: string): Promise<void> {
    return queueFeedback(feedback).catch(error => { liveStatus.textContent = messages.quick.bubbleUnpublished(text, errorMessage(error)); });
  }
  function focusField() { requestAnimationFrame(() => { if (live && document.visibilityState === "visible") area.focus(); }); }
  function updateButton() {
    let unresolved = false;
    try { const pending = readSubmissions(); unresolved = pending.length > 0; storageNotices = storageOutboxRead(storageNotices, pending.length); }
    catch (error) { reportStorageFailure("readSubmissions", error); }
    const { disabled, title } = quickSendState({ mode: state.mode, busy, hasText: !!area.value.trim(), notices: storageNotices, activeSaves: activeSaves.size, unresolved });
    send.disabled = disabled; send.title = title;
  }
  function setMode(mode: QuickMode) {
    const before = state.requestId;
    state = switchQuickMode(state, mode, submittedDraftId, crypto.randomUUID());
    if (state.requestId !== before) {
      try { writeDraft({ content: state.content, requestId: state.requestId }); storageWorked("writeDraft"); document.dispatchEvent(new Event(DRAFT_EVENT)); }
      catch (error) { reportStorageFailure("writeDraft", error); }
    }
    inputMode.setAttribute("aria-pressed", String(mode === "input"));
    questionMode.setAttribute("aria-pressed", String(mode === "question"));
    area.placeholder = mode === "input" ? messages.quick.inputPlaceholder : messages.quick.questionPlaceholder;
    area.setAttribute("aria-label", mode === "input" ? messages.quick.inputLabel : messages.quick.questionLabel);
    updateButton(); focusField();
  }
  area.addEventListener("input", () => {
    const next = nextDraft(state, area.value, crypto.randomUUID());
    state = { ...state, ...next };
    try { writeDraft(next); storageWorked("writeDraft"); document.dispatchEvent(new Event(DRAFT_EVENT)); }
    catch (error) { reportStorageFailure("writeDraft", error); }
    updateButton();
  });
  area.addEventListener("compositionstart", () => { composing = true; });
  area.addEventListener("compositionend", () => { composing = false; });
  area.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); void command("hide_quick"); }
    else if (!composing && shouldSend(event, busy)) { event.preventDefault(); void submit(); }
  });

  async function submit() {
    updateButton(); if (send.disabled || composing) return;
    const mode = state.mode;
    const content = area.value;
    const lengthError = quickLengthError(mode, content);
    if (lengthError) {
      liveStatus.textContent = lengthError;
      await publishOrRecord(errorFeedback(crypto.randomUUID(), mode, lengthError), lengthError);
      return;
    }
    const submittedId = state.requestId || crypto.randomUUID();
    const operationId = crypto.randomUUID();
    if (!state.requestId) { state = { ...state, requestId: submittedId }; try { writeDraft({ content: state.content, requestId: state.requestId }); storageWorked("writeDraft"); } catch (error) { reportStorageFailure("writeDraft", error); updateButton(); return; } }
    const reserved = reserveOperation(operation, operationId);
    if (!reserved) return;
    operation = reserved; busy = true; submittedDraftId = submittedId; activeMode = mode; updateButton();
    let started = false;
    let audience = "";
    try {
      audience = connectionAudience((await request("settings.get", {})).connection);
      if (mode === "input") { beginSubmission({ content, requestId: submittedId }, operationId, audience); started = true; }
      activeAudience = audience;
      await command("hide_quick");
      await queueFeedback(workingFeedback(operationId, mode, mode === "input" ? messages.quick.saveWorking : messages.quick.answerWorking, mode === "input" ? submittedId : undefined, audience));
      if (mode === "input") {
        const result = await request("memory.save", { content, requestId: submittedId, audience, autoClassify: true }, operationId);
        if (operation?.id === operationId) { operation.settled = true; operation = null; } // mark settled before final publish
        finishSubmission(submittedId, result.state === "saved" ? true : result.state === "rejected" ? "rejected" : false);
        storageWorked("finishSubmission");
        if (state.requestId === submittedId) {
          const latest = readDraft(); state = { ...state, content: latest.content, requestId: latest.requestId }; area.value = latest.content;
        }
        if (result.state === "saved") {
          const classification = result.classification;
          const captureLabel = classification?.outcome === "applied" && classification.capture ? labels[classification.capture.kind] : undefined;
          const failureReason = failedClassificationReason(classification);
          const detail = failureReason ? messages.feedback.classificationFailed(failureReason)
            : result.memory?.content ?? (result.resultType === "entity_patch" ? messages.feedback.entityPatched : messages.feedback.saved);
          await queueFeedback(savedFeedback(operationId, detail, submittedId, result.memory?.id, result.audience === audience ? audience : undefined, captureLabel, failureReason, result.resultType));
        } else {
          await queueFeedback(errorFeedback(operationId, mode, result.message ?? messages.feedback.unknownDetail, submittedId, audience));
        }
      } else {
        const answer = await request("assistant.ask", { question: content, audience }, operationId);
        if (operation?.id === operationId) { operation.settled = true; operation = null; }
        const current = readDraft(); const next = completeDraft(current, submittedId);
        if (next !== current) { writeDraft(next); state = { ...state, ...next }; area.value = next.content; document.dispatchEvent(new Event(DRAFT_EVENT)); }
        await queueFeedback(answerFeedback(operationId, answer.text, answer.sources, answer.generated, answer.outcome, answer.audience === audience ? audience : undefined));
      }
    } catch (error) {
      if (operation?.id === operationId) { operation.settled = true; operation = null; }
      if (started) try { finishSubmission(submittedId, false); storageWorked("finishSubmission"); } catch (storageError) { reportStorageFailure("finishSubmission", storageError); }
      const failureText = errorMessage(error);
      await publishOrRecord(errorFeedback(operationId, mode, failureText, mode === "input" ? submittedId : undefined, audience || undefined), failureText);
    } finally { if (!operation || operation.id === operationId) { busy = false; submittedDraftId = ""; activeMode = null; activeAudience = ""; updateButton(); } }
  }

  const refreshFromStorage = () => {
    if (!live) return;
    let access: StorageAccess = "readDraft";
    try {
      const stored = readDraft();
      storageWorked("readDraft");
      const focused = document.visibilityState === "visible" && document.activeElement === area && !!area.value;
      if (stored.requestId !== state.requestId || stored.content !== state.content) {
        const merged = mergeIncomingDraft({ content: state.content, requestId: state.requestId }, stored, focused, crypto.randomUUID(), stored.settledRequestId);
        state = { ...state, ...merged }; area.value = merged.content;
        if (focused && (merged.content !== stored.content || merged.requestId !== stored.requestId)) { access = "writeDraft"; writeDraft(merged); storageWorked("writeDraft"); }
      }
    } catch (error) { reportStorageFailure(access, error); }
    updateButton();
  };
  const onStorage = (event: StorageEvent) => { if (event.key?.startsWith("bara.pet.")) refreshFromStorage(); };
  const onVisible = () => { if (document.visibilityState === "visible") focusField(); };
  window.addEventListener("storage", onStorage);
  document.addEventListener(DRAFT_EVENT, refreshFromStorage);
  document.addEventListener("visibilitychange", onVisible);
  setMode("input");
  void onProgress(event => {
    if (canShowProgress(operation, event.requestId) && activeMode) void publishOrRecord(workingFeedback(operation!.id, activeMode, messages.progress[event.stage], activeMode === "input" ? submittedDraftId : undefined, activeAudience), messages.progress[event.stage]);
  }).then(stop => { if (live) unlistenProgress = stop; else stop(); });
  // Native remembers the requested mode before showing the window; register first, then hydrate.
  void onQuick(mode => { eventVersion++; setMode(mode); }).then(async stop => {
    if (!live) { stop(); return; }
    unlistenQuick = stop;
    const version = eventVersion;
    const loaded = await loadQuickMode(native, () => command<QuickMode>("get_quick_mode"));
    if (!live) return;
    if (loaded.kind === "loaded") { if (version === eventVersion) setMode(loaded.mode); }
    else if (loaded.kind === "failed") {
      // The native window did not say which mode it was opened in: the strip stays on the default input mode, and says why.
      liveStatus.textContent = loaded.text;
      void publishOrRecord(errorFeedback(crypto.randomUUID(), state.mode, loaded.text), loaded.text);
    }
  });
  return () => { live = false; unlistenQuick?.(); unlistenProgress?.(); window.removeEventListener("storage", onStorage); document.removeEventListener(DRAFT_EVENT, refreshFromStorage); document.removeEventListener("visibilitychange", onVisible); };
}
