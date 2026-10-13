import { acceptFeedback } from "../feedback-model.ts";
import type { FaceName, FaceState, MotionConfig, ReactionName, RestingState } from "./motion-config.ts";
import { EASINGS, clamp01, drawGap, endsAfter, pickWeighted, referencedAnimations, weightedTable, type WeightedTable } from "./motion-schedule.ts";
import type { MotionCommand, MotionFeedback, MotionMode, Presentation } from "./motion-types.ts";
import { SquirrelError } from "./squirrel-errors.ts";

/** Returned whenever nothing changes, so a frame with no change allocates no array. */
const NO_COMMANDS: readonly MotionCommand[] = Object.freeze([]);
/** The step index of a startup or show that is not running. */
const NONE = -1;

/** `from` moved `progress` (0 to 1) of the way to 1, exact at both ends so the end of a flight or a return is
 * exactly the character's own size. */
function towardsOne(from: number, progress: number): number {
  return from * (1 - progress) + progress;
}

/** The motion rules of the squirrel (design section 6), kept apart from the screen and WebGL. Inputs are events with
 * the motion clock `now` in milliseconds; outputs are commands for the renderer. The clock and the random source are
 * injected, so the machine never reads the wall clock or `Math.random` and every rule is testable with numbers.
 *
 * What shows follows section 6.3: the startup flight while nothing interrupted it, then a reaction, then `think` while
 * any work is running, then the random show, then sleep, then idle. A real state (feedback) always ends the startup
 * flight, the show and sleep at once, so decoration never delays it (U6). */
export class MotionMachine {
  private mode: MotionMode = "booting";
  private readonly lengthMs = new Map<string, number>();
  private readonly faceTables: Readonly<Record<FaceState, WeightedTable>>;
  private out: MotionCommand[] | null = null;

  private startupStep = NONE; // 0 = the flight, n = `startup.after[n - 1]`
  private startupEndsAt = 0;
  private flightStartAt = 0;
  private returning = false; // the return to place and size after a feedback interrupted the flight
  private returnStartAt = 0;
  private returnFromScale = 1;
  private returnFromLift = 0;
  private showStep = NONE;
  private showEndsAt = 0;
  private nextShowAt = Infinity;
  private reaction: ReactionName | null = null;
  private reactionEndsAt = 0;
  private readonly working = new Set<string>();
  /** Result ids already handled, oldest first, at most `reactions.rememberIds` (D14). */
  private readonly settledIds = new Set<string>();
  private lastFeedback: { sequence?: number } | null = null;
  private quickOpen = false;
  private reduced = false;
  private visible = true;
  private asleep = false;
  private lastActivityAt = 0;
  private face: FaceName | null = null;
  private faceEndsAt = 0;
  private nextFaceAt = Infinity;
  private body: string | null = null;

  /** `durations` are the animation lengths in seconds read from the skeleton data (`animationDurations`); every name
   * the configuration uses must be there. `random` returns a number in [0, 1). */
  constructor(private readonly config: MotionConfig, durations: Readonly<Record<string, number>>, private readonly random: () => number) {
    for (const name of referencedAnimations(config)) {
      const seconds = Object.hasOwn(durations, name) ? durations[name] : undefined;
      if (seconds === undefined || !Number.isFinite(seconds)) throw new SquirrelError("ANIMATION_MISSING", name);
      this.lengthMs.set(name, endsAfter(0, seconds));
    }
    if (!config.show.steps.length) throw new RangeError("The random show has no steps");
    this.faceTables = { idle: weightedTable(config.randomFaces.idle.choices), think: weightedTable(config.randomFaces.think.choices) };
  }

  /** The first visible frame after loading. Without reduced motion the startup flight begins; with it (or when work
   * already runs) the pet goes straight to its state. Inputs that came before are already applied. */
  start(now: number, reducedMotion: boolean): readonly MotionCommand[] {
    if (this.mode !== "booting") throw new Error("MotionMachine.start was called twice");
    this.reduced = reducedMotion;
    this.lastActivityAt = now;
    if (!reducedMotion && this.working.size === 0) {
      this.mode = "startup";
      this.startupStep = 0;
      this.flightStartAt = now;
      this.startupEndsAt = now + this.config.startup.flight.durationMs;
      this.playBody(this.config.startup.flight.animation, true, true);
    } else this.settle(now);
    return this.flush();
  }

  /** One frame: ends the steps, reactions and faces that are over and starts what is due. */
  tick(now: number): readonly MotionCommand[] {
    this.requireStarted("tick");
    if (this.startupStep !== NONE && now >= this.startupEndsAt) this.advanceStartup(now);
    if (this.showStep !== NONE && now >= this.showEndsAt) this.advanceShow(now);
    if (this.face && now >= this.faceEndsAt) this.face = null;
    if (this.reaction && now >= this.reactionEndsAt) { this.reaction = null; this.settle(now); }
    if (this.mode === "idle" && !this.quickOpen && now - this.lastActivityAt >= this.config.sleep.afterMs) {
      this.asleep = true;
      this.settle(now);
    }
    if (now >= this.nextShowAt) {
      if (this.canStartShow()) this.startShow(now);
      else this.scheduleShow(now);
    }
    if ((this.mode === "idle" || this.mode === "think") && !this.face && now >= this.nextFaceAt) this.startRandomFace(this.mode, now);
    return this.flush();
  }

  /** A `pet-feedback`. An older `sequence` than the last one is ignored (the `acceptFeedback` rule). A result id already
   * handled (the tray's "최근 결과" re-broadcasts it with a new sequence), or work already known to run, changes no
   * state and only counts as activity. Any other feedback ends the reaction to an earlier result (D15). */
  feedback(now: number, feedback: MotionFeedback): readonly MotionCommand[] {
    const reaction = this.resultReaction(feedback);
    if (acceptFeedback<{ sequence?: number }>(this.lastFeedback, feedback) !== feedback) return NO_COMMANDS;
    this.lastFeedback = feedback;
    this.lastActivityAt = now;
    if (this.settledIds.has(feedback.id) || (feedback.kind === "working" && this.working.has(feedback.id))) {
      if (this.mode !== "booting" && this.asleep) { this.asleep = false; this.settle(now); }
      return this.flush();
    }
    if (feedback.kind === "working") this.working.add(feedback.id);
    else { this.working.delete(feedback.id); this.remember(feedback.id); }
    // Before the first frame nobody saw the result, so like a hidden window it gets no late reaction.
    if (this.mode === "booting") return NO_COMMANDS;
    this.interruptDecoration(now);
    // The latest result owns the reaction (D15), and new work ends it too: a reaction to an earlier result never
    // outlives a newer feedback. A reaction-worthy result in a visible window starts its own; otherwise the earlier
    // reaction's face fades out with it and the state falls through the priority.
    const earlier = this.reaction;
    this.reaction = null;
    if (feedback.kind !== "working" && reaction && this.visible) this.startReaction(reaction, now);
    else if (earlier) this.clearReactionFace(earlier);
    this.settle(now);
    return this.flush();
  }

  /** The quick strip opened or closed. Both count as activity (U11); opening ends the random show at once. */
  quickVisibility(now: number, visible: boolean): readonly MotionCommand[] {
    this.quickOpen = visible;
    this.lastActivityAt = now;
    if (this.mode === "booting") return NO_COMMANDS;
    this.asleep = false;
    if (visible) this.showStep = NONE;
    else this.scheduleShow(now);
    this.settle(now);
    return this.flush();
  }

  /** The mouse moved over or pressed the pet. Wakes a sleeping pet with only the body mix (no wake animation, U8). */
  activity(now: number): readonly MotionCommand[] {
    this.lastActivityAt = now;
    if (this.mode === "booting" || !this.asleep) return NO_COMMANDS;
    this.asleep = false;
    this.settle(now);
    return this.flush();
  }

  /** The OS reduced-motion setting changed. On, the startup and the show stop at once without a return animation; the
   * state animations and faces stay because they carry state (O10). Off, a random show is scheduled again. */
  reducedMotion(now: number, reduced: boolean): readonly MotionCommand[] {
    if (reduced === this.reduced) return NO_COMMANDS;
    this.reduced = reduced;
    if (this.mode === "booting") return NO_COMMANDS;
    if (reduced) {
      this.returning = false;
      this.startupStep = NONE;
      this.showStep = NONE;
      this.settle(now);
    } else this.scheduleShow(now);
    return this.flush();
  }

  /** The window was hidden or shown. Only remembered: the loop stops the clock while hidden (section 6.8), and a
   * result that arrives while hidden gets no reaction. */
  visibility(_now: number, visible: boolean): readonly MotionCommand[] {
    this.visible = visible;
    return NO_COMMANDS;
  }

  /** The startup presentation at `now`, written into `out`: the eased flight, then the straight return after an
   * interrupted flight, otherwise the character at its place and size. */
  presentation(now: number, out: Presentation): void {
    this.requireStarted("presentation");
    if (this.startupStep === 0) {
      const eased = this.flightEase(now);
      out.scale = towardsOne(this.config.startup.flight.startScale, eased);
      out.lift = 1 - eased;
    } else if (this.returning) {
      const span = this.config.startup.interruptReturnMs;
      const done = span > 0 ? clamp01((now - this.returnStartAt) / span) : 1;
      out.scale = towardsOne(this.returnFromScale, done);
      out.lift = this.returnFromLift * (1 - done);
    } else {
      out.scale = 1;
      out.lift = 0;
    }
  }

  private requireStarted(method: string): void {
    if (this.mode === "booting") throw new Error(`MotionMachine.${method} was called before start`);
  }

  /** The reaction a feedback asks for (`null` for none or for `working`). A kind or an answer outcome the configuration
   * does not map is a broken contract and throws instead of being guessed. */
  private resultReaction(feedback: MotionFeedback): ReactionName | null {
    switch (feedback.kind) {
      case "working": return null;
      case "saved": return this.config.reactionFor.saved;
      case "error": return this.config.reactionFor.error;
      case "answer": {
        const outcomes = this.config.reactionFor.answer;
        if (!Object.hasOwn(outcomes, feedback.answerOutcome)) {
          throw new Error(`The answer feedback ${feedback.id} has no known answerOutcome (${String(feedback.answerOutcome)})`);
        }
        return outcomes[feedback.answerOutcome];
      }
      default: throw new Error(`The feedback kind ${String((feedback as { kind: unknown }).kind)} is not known`);
    }
  }

  private remember(id: string): void {
    this.settledIds.add(id);
    if (this.settledIds.size <= this.config.reactions.rememberIds) return;
    const oldest = this.settledIds.values().next().value;
    if (oldest !== undefined) this.settledIds.delete(oldest);
  }

  /** A feedback ends the startup flight (returning to place and size from where it was), the show and sleep. */
  private interruptDecoration(now: number): void {
    if (this.startupStep === 0) {
      const eased = this.flightEase(now);
      this.returning = true;
      this.returnStartAt = now;
      this.returnFromScale = towardsOne(this.config.startup.flight.startScale, eased);
      this.returnFromLift = 1 - eased;
    }
    this.startupStep = NONE;
    this.showStep = NONE;
    this.asleep = false;
  }

  private desiredMode(): MotionMode {
    if (this.startupStep !== NONE) return "startup";
    if (this.reaction) return "reaction";
    if (this.working.size > 0) return "think";
    if (this.showStep !== NONE) return "show";
    if (this.asleep) return "sleep";
    return "idle";
  }

  /** Moves to the mode the priority asks for. The startup, the show and a reaction are entered by their own start;
   * reaching one here would be a fault in these rules, so it throws instead of showing a wrong state. */
  private settle(now: number): void {
    const target = this.desiredMode();
    if (target === this.mode) return;
    if (target === "idle" || target === "think" || target === "sleep") this.enterResting(target, now);
    else throw new Error(`MotionMachine cannot settle into ${target} from ${this.mode}`);
  }

  private enterResting(state: RestingState, now: number): void {
    this.mode = state;
    this.clearFaceUnlessAllowed();
    this.playBody(this.config.states[state].animation, true, false);
    if (state === "sleep") { this.nextFaceAt = Infinity; return; }
    this.nextFaceAt = now + drawGap(this.config.randomFaces[state].gapMs, this.random);
    if (state === "idle") this.scheduleShow(now);
  }

  private advanceStartup(now: number): void {
    const after = this.config.startup.after;
    if (this.startupStep < after.length) {
      const step = after[this.startupStep];
      this.startupStep += 1;
      this.playBody(step, false, true);
      this.startupEndsAt = now + this.length(step);
    } else {
      this.startupStep = NONE;
      this.settle(now);
    }
  }

  private canStartShow(): boolean {
    return this.mode === "idle" && !this.quickOpen && !this.reduced && this.visible && this.working.size === 0 && !this.reaction;
  }

  private scheduleShow(now: number): void {
    this.nextShowAt = this.reduced ? Infinity : now + drawGap(this.config.show.gapMs, this.random);
  }

  private startShow(now: number): void {
    this.mode = "show";
    this.showStep = 0;
    this.nextShowAt = Infinity;
    this.nextFaceAt = Infinity;
    this.clearFaceUnlessAllowed();
    const step = this.config.show.steps[0];
    this.playBody(step, false, true);
    this.showEndsAt = now + this.length(step);
  }

  private advanceShow(now: number): void {
    const steps = this.config.show.steps;
    const next = this.showStep + 1;
    if (next < steps.length) {
      this.showStep = next;
      this.playBody(steps[next], false, true);
      this.showEndsAt = now + this.length(steps[next]);
    } else {
      this.showStep = NONE;
      this.settle(now);
    }
  }

  /** A reaction restarts for every new result: body looped for `loops` lengths, its face once, no random faces (O8). */
  private startReaction(name: ReactionName, now: number): void {
    const reaction = this.config.reactions[name];
    this.mode = "reaction";
    this.reaction = name;
    this.reactionEndsAt = now + this.length(reaction.body) * reaction.loops;
    this.nextFaceAt = Infinity;
    this.playBody(reaction.body, true, true);
    this.playFace(reaction.face, now);
  }

  /** The face of a reaction that a newer feedback ended, if it still plays. */
  private clearReactionFace(name: ReactionName): void {
    const face = this.config.reactions[name].face;
    if (this.face !== face) return;
    this.emit({ type: "faceClear", fadeOutSeconds: this.config.faces[face].fadeOutSeconds });
    this.face = null;
  }

  private startRandomFace(state: FaceState, now: number): void {
    this.playFace(pickWeighted(this.faceTables[state], this.random), now);
    this.nextFaceAt = this.faceEndsAt + drawGap(this.config.randomFaces[state].gapMs, this.random);
  }

  private playFace(face: FaceName, now: number): void {
    const settings = this.config.faces[face];
    this.emit({ type: "face", animation: face, additive: settings.additive, fadeInSeconds: settings.fadeInSeconds, fadeOutSeconds: settings.fadeOutSeconds });
    this.face = face;
    this.faceEndsAt = now + this.length(face);
  }

  /** The faces the current mode allows: its random choices in `idle` and `think`, its own face in a reaction, none in
   * the startup, the show or sleep (U3). A face it does not allow fades out. */
  private clearFaceUnlessAllowed(): void {
    const face = this.face;
    if (!face) return;
    const allowed = this.mode === "idle" || this.mode === "think" ? this.faceTables[this.mode].names.includes(face)
      : this.mode === "reaction" && this.reaction ? this.config.reactions[this.reaction].face === face : false;
    if (allowed) return;
    this.emit({ type: "faceClear", fadeOutSeconds: this.config.faces[face].fadeOutSeconds });
    this.face = null;
  }

  /** A looping state animation already playing is not sent again (repeated `working` progress must not restart
   * `think`); steps and reactions pass `restart`. */
  private playBody(animation: string, loop: boolean, restart: boolean): void {
    if (!restart && this.body === animation) return;
    this.emit({ type: "body", animation, loop });
    this.body = animation;
  }

  private flightEase(now: number): number {
    const flight = this.config.startup.flight;
    return EASINGS[flight.easing](flight.durationMs > 0 ? clamp01((now - this.flightStartAt) / flight.durationMs) : 1);
  }

  private length(animation: string): number {
    const ms = this.lengthMs.get(animation);
    if (ms === undefined) throw new SquirrelError("ANIMATION_MISSING", animation);
    return ms;
  }

  private emit(command: MotionCommand): void {
    (this.out ??= []).push(command);
  }

  private flush(): readonly MotionCommand[] {
    const out = this.out ?? NO_COMMANDS;
    this.out = null;
    return out;
  }
}
