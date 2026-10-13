import type { MotionFeedback } from "./motion-types.ts";

/** Whether the host has the pet on screen (plan 1C). The host's `contract.petVisibilityEvent` is the authority,
 * because WebView2 keeps a hidden window's page "visible" to scripts. The page also asks once at load
 * (`get_pet_visible`), since an event sent before its listener existed is lost; an event that arrives while that
 * question is out is newer than its answer, so the answer is then dropped. Unknown until either comes. */
export class HostVisibility {
  private known: boolean | null = null;
  private events = 0;

  /** `true` shown, `false` hidden, `null` not known yet. */
  get visible(): boolean | null {
    return this.known;
  }

  /** The host's event. Returns whether the state changed. */
  event(visible: boolean): boolean {
    this.events++;
    return this.set(visible);
  }

  /** Call when the question goes out; hand the token back with its answer. */
  asked(): number {
    return this.events;
  }

  /** The question's answer. Ignored when an event came since it was asked. Returns whether the state changed. */
  answered(token: number, visible: boolean): boolean {
    return token === this.events && this.set(visible);
  }

  /** The question failed. With nothing known the pet counts as shown, so a broken question never leaves it blank (the
   * webview's own visibility still stops the drawing when the host hid it). Returns whether the state changed. */
  failed(token: number): boolean {
    return token === this.events && this.known === null && this.set(true);
  }

  private set(visible: boolean): boolean {
    if (this.known === visible) return false;
    this.known = visible;
    return true;
  }
}

/** The pet is drawn only when the host shows it and the page itself is visible. */
export function petDrawable(host: boolean | null, documentVisible: boolean): boolean {
  return host === true && documentVisible;
}

/** What the screen does next for the character. `load` creates the WebGL context and loads the Spine files; `pause`
 * stops the frame loop (no frames, no Spine updates, no draws) and `resume` starts it again with a fresh first frame. */
export type PresenceStep = "load" | "pause" | "resume";

export type PresencePhase = "waiting" | "loading" | "running" | "stopped";

/** When the character exists and draws (plan 1C, spec 3.2). Nothing is created until the pet is first shown, so a
 * tray-only start opens no WebGL context and loads no Spine files; after that it pauses while hidden and resumes when
 * shown. A change while loading is kept and answered by `loaded`. After a failed start nothing happens any more. */
export class RendererPresence {
  private current: PresencePhase = "waiting";
  private shown = false;

  get phase(): PresencePhase {
    return this.current;
  }

  get visible(): boolean {
    return this.shown;
  }

  /** The pet became drawable (`true`) or not. Returns the step to take, or `null`. */
  visibility(visible: boolean): PresenceStep | null {
    if (visible === this.shown) return null;
    this.shown = visible;
    switch (this.current) {
      case "waiting":
        if (!visible) return null;
        this.current = "loading";
        return "load";
      case "running": return visible ? "resume" : "pause";
      case "loading":
      case "stopped":
        return null;
    }
  }

  /** The character was created while the pet was drawable. It starts drawing; the step brings it to the state now. */
  loaded(): PresenceStep {
    if (this.current !== "loading") throw new Error(`RendererPresence.loaded in ${this.current}`);
    this.current = "running";
    return this.shown ? "resume" : "pause";
  }

  /** The character could not be created. */
  failed(): void {
    this.current = "stopped";
  }
}

/** The inputs that arrive before the character exists, handed to it once it runs. Before its first frame the motion
 * machine only records them (the work in progress, the results already seen, whether the quick input is open), so only
 * their outcome matters and the order of a feedback against the quick input does not. While the pet stays hidden this
 * can last for days, so at most `limit` feedbacks are kept: the oldest that can no longer matter goes first, a result
 * or a `working` with a later feedback for the same id. Work still running (`working` with nothing after it) is kept,
 * so the pet shows it when it first appears. The reduced-motion setting is not kept: it is read when the character
 * starts. */
export class PendingInputs {
  private readonly feedbacks: MotionFeedback[] = [];
  private quickVisible: boolean | null = null;

  constructor(private readonly limit: number) {
    if (!(Number.isInteger(limit) && limit > 0)) throw new RangeError(`The pending feedback limit ${limit} is not a positive integer`);
  }

  get size(): number {
    return this.feedbacks.length;
  }

  feedback(feedback: MotionFeedback): void {
    this.feedbacks.push(feedback);
    if (this.feedbacks.length > this.limit) this.feedbacks.splice(this.dropIndex(), 1);
  }

  quickVisibility(visible: boolean): void {
    this.quickVisible = visible;
  }

  /** Everything kept, in arrival order, and empties the store. */
  take(): { feedback: MotionFeedback[]; quickVisible: boolean | null } {
    const taken = { feedback: this.feedbacks.splice(0), quickVisible: this.quickVisible };
    this.quickVisible = null;
    return taken;
  }

  clear(): void {
    this.take();
  }

  private dropIndex(): number {
    const { feedbacks } = this;
    for (let index = 0; index < feedbacks.length; index++) {
      const entry = feedbacks[index]!;
      if (entry.kind !== "working") return index;
      for (let later = index + 1; later < feedbacks.length; later++) if (feedbacks[later]!.id === entry.id) return index;
    }
    return 0;
  }
}
