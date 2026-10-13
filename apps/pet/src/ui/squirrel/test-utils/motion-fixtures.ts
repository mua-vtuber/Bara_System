import { SQUIRREL_MOTION, type FaceName, type FaceState, type GapRange, type MotionConfig } from "../motion-config.ts";
import { MotionMachine } from "../motion-machine.ts";
import { endsAfter } from "../motion-schedule.ts";
import type { MotionCommand } from "../motion-types.ts";
import { animationDurations } from "../motion-validate.ts";
import { loadRealSkeletonData } from "./real-skeleton.ts";

// Test only. The machine's inputs are data: clock numbers, random numbers and plain feedback objects. Every animation
// length comes from the real export through `animationDurations`.

export const config = SQUIRREL_MOTION;
export const durations = animationDurations(await loadRealSkeletonData());

/** One play of `animation` in milliseconds, from the real data. */
export function lengthMs(animation: string): number {
  if (!Object.hasOwn(durations, animation)) throw new Error(`The real data has no animation ${animation}`);
  return endsAfter(0, durations[animation]!);
}

/** A random source returning `values` in order. Running out fails the test, so a test states every draw it causes. */
export function scripted(...values: number[]): () => number {
  let index = 0;
  return () => {
    if (index >= values.length) throw new Error(`The random script ran out after ${values.length} draws`);
    return values[index++]!;
  };
}

/** A random source that repeats `values` in a cycle (one value: always the same). */
export function cycling(...values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length]!;
}

/** The draw that picks `face` among the random faces of `state`: the middle of its weight band. */
export function drawFor(state: FaceState, face: FaceName, motion: MotionConfig = config): number {
  const choices = motion.randomFaces[state].choices;
  const total = choices.reduce((sum, choice) => sum + choice.weight, 0);
  let below = 0;
  for (const choice of choices) {
    if (choice.animation === face) return (below + choice.weight / 2) / total;
    below += choice.weight;
  }
  throw new Error(`${face} is not a random face of ${state}`);
}

/** The draw that makes a wait of `ms` within `range`. */
export function drawForGap(range: GapRange, ms: number): number {
  return (ms - range[0]) / (range[1] - range[0]);
}

export function machine(random: () => number, motion: MotionConfig = config): MotionMachine {
  return new MotionMachine(motion, durations, random);
}

/** A machine that went through the whole startup without reduced motion, and the time it became idle. Entering idle
 * draws a face wait and then a show wait. */
export function idleAfterStartup(random: () => number): { motion: MotionMachine; at: number } {
  const motion = machine(random);
  motion.start(0, false);
  let at = config.startup.flight.durationMs;
  for (const step of config.startup.after) {
    motion.tick(at);
    at += lengthMs(step);
  }
  const last = motion.tick(at);
  if (!last.some(command => command.type === "body" && command.animation === config.states.idle.animation)) {
    throw new Error(`The startup did not end in idle at ${at}`);
  }
  return { motion, at };
}

export function body(animation: string, loop: boolean): MotionCommand {
  return { type: "body", animation, loop };
}
export function face(name: FaceName, motion: MotionConfig = config): MotionCommand {
  return { type: "face", animation: name, ...motion.faces[name] };
}
export function faceClear(name: FaceName, motion: MotionConfig = config): MotionCommand {
  return { type: "faceClear", fadeOutSeconds: motion.faces[name].fadeOutSeconds };
}
/** Only the body commands of a list, for checks that do not care which faces came and went. */
export function bodies(commands: readonly MotionCommand[]): MotionCommand[] {
  return commands.filter(command => command.type === "body");
}
