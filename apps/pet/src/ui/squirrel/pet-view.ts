import { getCurrentWindow } from "@tauri-apps/api/window";
import { ANSWER_OUTCOMES, type AnswerOutcome, type Feedback } from "../../shared/contracts.ts";
import { command, errorMessage, native, onFeedback, onPetVisibility, onQuickVisibility } from "../bridge.ts";
import { element } from "../dom.ts";
import { messages } from "../messages.ts";
import type { CanvasLayout } from "./camera.ts";
import { SQUIRREL_MOTION } from "./motion-config.ts";
import type { MotionFeedback } from "./motion-types.ts";
import { NoticeState, type NoticeKind } from "./pet-notice.ts";
import { HostVisibility, PendingInputs, petDrawable, RendererPresence, type PresenceStep } from "./pet-presence.ts";
import { PetPress } from "./pet-press.ts";
import { mountPetUpdate } from "./pet-update.ts";
import { squirrelErrorText } from "./squirrel-error-text.ts";
import { SquirrelError } from "./squirrel-errors.ts";
import type { SquirrelHandle } from "./squirrel-runtime.ts";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const ERROR_CAUSE_ID = "pet-error-cause";
/** Set on `#app` while the error card stands in for the character (`style.css` hides the canvas then). */
const FAILED_STATE = "failed";
/** How many feedbacks wait for a character not created yet, per result id the motion machine remembers: room for the
 * remembered results plus as much work still running. */
const PENDING_PER_REMEMBERED_ID = 2;

interface NoticeLine { show(kind: NoticeKind, text: string): void; clear(kind: NoticeKind): void }

/** The notice line at the top of the pet window: `NoticeState` decides what shows, this keeps the elements and the
 * `ui.commandNoticeMs` timer of the passing notice. The text sits in its own element inside the padded box, so the
 * line clamp cuts it at a whole line instead of letting the next line show through the padding. */
function noticeLine(box: HTMLElement, node: HTMLElement): NoticeLine {
  const state = new NoticeState();
  let timer: number | undefined;
  const render = (): void => {
    const text = state.text;
    node.textContent = text ?? "";
    box.hidden = text === null;
  };
  const expire = (): void => {
    timer = undefined;
    state.expire();
    render();
  };
  return {
    show(kind, text) {
      if (state.show(kind, text)) {
        window.clearTimeout(timer);
        timer = window.setTimeout(expire, SQUIRREL_MOTION.ui.commandNoticeMs);
      }
      render();
    },
    clear(kind) {
      if (!state.clear(kind)) return;
      window.clearTimeout(timer);
      timer = undefined;
      render();
    },
  };
}

function isAnswerOutcome(value: unknown): value is AnswerOutcome {
  return (ANSWER_OUTCOMES as readonly unknown[]).includes(value);
}

/** The part of a `pet-feedback` the motion machine reads. An `answer` without a known `answerOutcome` breaks the
 * contract the host already checks (section 9.1): it gives `null`, and the screen reports it instead of guessing. */
function toMotionFeedback(feedback: Feedback): MotionFeedback | null {
  if (feedback.kind !== "answer") return { id: feedback.id, kind: feedback.kind, sequence: feedback.sequence };
  if (!isAnswerOutcome(feedback.answerOutcome)) return null;
  return { id: feedback.id, kind: "answer", answerOutcome: feedback.answerOutcome, sequence: feedback.sequence };
}

/** The pet window: the pet button with the character's canvas, the error card that stands in for the character
 * when it cannot be drawn, and the notice line. Clicking opens the composer with its input and question modes.
 * Clicking, dragging and the right click work at once, before the character loads and when it fails.
 *
 * The character is created only when the pet is first shown, and it draws only while shown (plan 1C): the host's
 * `contract.petVisibilityEvent`, its answer to `get_pet_visible` at load, and the page's own visibility decide. A
 * tray-only start therefore opens no WebGL context and loads no Spine files until "펫 보이기". */
export function renderPet(app: HTMLElement): void {
  const petButton = element("button", "pet-button");
  petButton.type = "button";
  petButton.setAttribute("aria-label", messages.main.petLabel);
  petButton.title = messages.main.petTitle;
  const canvas = element("canvas", "pet-canvas");
  canvas.setAttribute("aria-hidden", "true");
  petButton.append(canvas);

  // The notice line and the card share one overlay that lets the pointer through, so the button under it keeps every
  // action. The notice sits at the top and the card at the bottom; when both show, the card shrinks instead of being
  // covered. The overlay is not inside the button: a button's content is presentational to assistive technology,
  // which would silence the alert.
  const overlay = element("div", "pet-overlay");
  const card = element("div", "pet-error");
  card.hidden = true;
  card.setAttribute("role", "alert");
  const cause = element("p", "pet-error-cause");
  cause.id = ERROR_CAUSE_ID;
  card.append(element("strong", "pet-error-title", messages.pet.errorTitle), cause, element("span", "pet-error-hint", messages.pet.errorHint));
  const noticeBox = element("div", "pet-notice");
  noticeBox.hidden = true;
  noticeBox.setAttribute("role", "status");
  const noticeText = element("p", "pet-notice-text");
  noticeBox.append(noticeText);
  const notice = noticeLine(noticeBox, noticeText);
  overlay.append(noticeBox, card);

  /** Runs one of the pet window's own commands at once, as part of the input event (dragging must start while the
   * button is down). A refusal shows on the notice line with its cause (D10); a success clears an earlier command
   * failure, because the window answers again. */
  function runCommand(run: () => Promise<unknown>, failed: (reason: string) => string): void {
    void (async () => {
      try {
        await run();
      } catch (error) {
        notice.show("command", failed(errorMessage(error)));
        return;
      }
      notice.clear("command");
    })();
  }
  const openQuick = (): void => runCommand(() => command("open_quick", { mode: "input" }), messages.pet.quickToggleFailed);
  app.append(petButton, overlay);

  const press = new PetPress();
  petButton.addEventListener("pointerdown", event => press.down(event.screenX, event.screenY));
  petButton.addEventListener("pointermove", event => {
    if (press.move(event.screenX, event.screenY, event.buttons) && native) runCommand(() => getCurrentWindow().startDragging(), messages.pet.dragFailed);
  });
  petButton.addEventListener("pointerup", () => press.up());
  petButton.addEventListener("click", () => { if (press.click()) openQuick(); });
  petButton.addEventListener("contextmenu", event => {
    event.preventDefault();
    runCommand(() => command("open_panel", { mode: "settings" }), messages.pet.panelOpenFailed);
  });
  // The update button sits beside the pet button (not inside it), above it in the window's bottom right corner.
  mountPetUpdate(app, { notice: text => notice.show("update", text), press });

  function showFailure(error: SquirrelError): void {
    const text = squirrelErrorText(error);
    cause.textContent = text;
    // The card lets the pointer through, so the full sentence is on the button's tooltip; the card clamps its lines.
    petButton.title = `${text}\n${messages.main.petTitle}`;
    petButton.setAttribute("aria-describedby", ERROR_CAUSE_ID);
    app.dataset.character = FAILED_STATE;
    card.hidden = false;
  }
  function hideFailure(): void {
    card.hidden = true;
    cause.textContent = "";
    petButton.title = messages.main.petTitle;
    petButton.removeAttribute("aria-describedby");
    delete app.dataset.character;
  }

  // Inputs that arrive before the character runs (while the pet is hidden or the runtime loads) wait here and reach
  // it once it runs; the motion machine only records them until its first frame (section 6.4). After a failed start
  // nothing waits any more.
  let handle: SquirrelHandle | null = null;
  const presence = new RendererPresence();
  const host = new HostVisibility();
  const pending = new PendingInputs(SQUIRREL_MOTION.reactions.rememberIds * PENDING_PER_REMEMBERED_ID);
  function failStart(error: SquirrelError): void {
    presence.failed();
    pending.clear();
    showFailure(error);
  }

  void onFeedback(feedback => {
    const motion = toMotionFeedback(feedback);
    if (!motion) notice.show("contract", messages.pet.answerOutcomeMissing);
    else if (handle) handle.feedback(motion);
    else if (presence.phase !== "stopped") pending.feedback(motion);
  }).catch(error => notice.show("listen", messages.pet.listenFailed(errorMessage(error))));
  void onQuickVisibility(visible => {
    if (handle) handle.quickVisibility(visible);
    else if (presence.phase !== "stopped") pending.quickVisibility(visible);
  }).catch(error => notice.show("listen", messages.pet.listenFailed(errorMessage(error))));
  const reducedMotion = window.matchMedia(REDUCED_MOTION_QUERY);
  reducedMotion.addEventListener("change", event => handle?.reducedMotion(event.matches));
  const activity = (): void => { handle?.activity(); };
  document.addEventListener("pointermove", activity, { passive: true });
  document.addEventListener("pointerdown", activity, { passive: true });

  const measure = (): CanvasLayout => ({
    cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight,
    bandPx: Number.parseFloat(getComputedStyle(canvas).getPropertyValue("--pet-floor-inset")),
  });
  async function load(): Promise<void> {
    let runtime: typeof import("./squirrel-runtime.ts");
    try {
      runtime = await import("./squirrel-runtime.ts");
    } catch (error) {
      failStart(new SquirrelError("MODULE_LOAD", errorMessage(error), { cause: error }));
      return;
    }
    try {
      const ready = await runtime.startSquirrel({
        canvas, measure, baseUri: document.baseURI, reducedMotion: reducedMotion.matches,
        onFailure: showFailure, onRecovered: hideFailure,
      });
      handle = ready;
      const waiting = pending.take();
      for (const feedback of waiting.feedback) ready.feedback(feedback);
      if (waiting.quickVisible !== null) ready.quickVisibility(waiting.quickVisible);
      // The setting may have changed while the files loaded; the same value changes nothing.
      ready.reducedMotion(reducedMotion.matches);
      take(presence.loaded());
    } catch (error) {
      failStart(error instanceof SquirrelError ? error : new SquirrelError("RENDER_FAILED", errorMessage(error), { cause: error }));
    }
  }
  function take(step: PresenceStep | null): void {
    if (step === "load") void load();
    else if (step !== null) handle?.visibility(step === "resume");
  }
  const refresh = (): void => take(presence.visibility(petDrawable(host.visible, document.visibilityState === "visible")));
  document.addEventListener("visibilitychange", refresh);
  if (!native) {
    // A browser preview has no host: the page's own visibility decides.
    host.event(true);
    refresh();
  } else {
    // Listen first, then ask: an event from before the listener is lost, and one during the question wins over its
    // answer. A failed question counts as shown, so the pet never stays blank; while the host hides the webview its
    // page is hidden too, which still stops the drawing.
    void onPetVisibility(visible => { if (host.event(visible)) refresh(); })
      .catch(error => notice.show("listen", messages.pet.listenFailed(errorMessage(error))))
      .finally(() => {
        const token = host.asked();
        const failed = (): void => { if (host.failed(token)) refresh(); };
        command<unknown>("get_pet_visible").then(
          visible => { if (typeof visible !== "boolean") failed(); else if (host.answered(token, visible)) refresh(); },
          failed,
        );
      });
  }
}
