import { expect, test } from "bun:test";
import type { FaceName, MotionConfig } from "./motion-config.ts";
import type { MotionMachine } from "./motion-machine.ts";
import type { MotionCommand, MotionFeedback, Presentation } from "./motion-types.ts";
import { body, config, cycling, drawFor, face, faceClear, idleAfterStartup, lengthMs, machine, scripted } from "./test-utils/motion-fixtures.ts";

// The face overlays (design section 6.5, U3, U4) and the startup presentation (section 6.6) of the motion machine.
const IDLE = config.states.idle.animation;
const THINK = config.states.think.animation;
const SLEEP = config.states.sleep.animation;
const FLIGHT = config.startup.flight;
const BACK_MS = config.startup.interruptReturnMs;

/** A fixed spread of random numbers across [0, 1): every face and many different waits get drawn. */
const spread = (): (() => number) => cycling(...Array.from({ length: 97 }, (_, index) => index / 97));
function working(id: string, sequence: number): MotionFeedback {
  return { id, kind: "working", sequence };
}
/** The face names a machine sends while ticking every 100 ms up to `until`, with mouse activity each minute. */
function facesUntil(motion: MotionMachine, until: number): string[] {
  const names = new Set<string>();
  for (let at = 100; at <= until; at += 100) {
    if (at % 60_000 === 0) motion.activity(at);
    for (const command of motion.tick(at)) {
      if (command.type === "body") throw new Error(`The state changed to ${command.animation} at ${at}`);
      if (command.type === "face") names.add(command.animation);
    }
  }
  return [...names].sort();
}
function presentationAt(motion: MotionMachine, now: number): Presentation {
  const out = { scale: Number.NaN, lift: Number.NaN };
  motion.presentation(now, out);
  return out;
}

test("idle layers only its four faces and think only blink and ear_flap: nose_wiggle and smile never show while thinking", () => {
  expect(config.randomFaces.idle.choices.map(choice => choice.animation).sort()).toEqual(["blink", "ear_flap", "nose_wiggle", "smile"]);
  expect(config.randomFaces.think.choices.map(choice => choice.animation).sort()).toEqual(["blink", "ear_flap"]);

  const idle = machine(spread());
  idle.start(0, true);
  expect(facesUntil(idle, 30 * 60_000)).toEqual(["blink", "ear_flap", "nose_wiggle", "smile"]);

  const thinking = machine(spread());
  thinking.start(0, true);
  expect(thinking.feedback(0, working("a", 1))).toEqual([body(THINK, true)]);
  const thinkFaces = facesUntil(thinking, 30 * 60_000);
  expect(thinkFaces).toEqual(["blink", "ear_flap"]);
  expect(thinkFaces).not.toContain("nose_wiggle");
  expect(thinkFaces).not.toContain("smile");
});

test("no face plays during the startup, the random show or sleep", () => {
  const motion = machine(spread());
  let current = FLIGHT.animation;
  const facesDuring = new Map<string, number>();
  const seenBodies = new Set<string>([current]);
  const record = (commands: readonly MotionCommand[]): void => {
    for (const command of commands) {
      if (command.type === "body") { current = command.animation; seenBodies.add(current); }
      if (command.type === "face") facesDuring.set(current, (facesDuring.get(current) ?? 0) + 1);
    }
  };
  record(motion.start(0, false));
  for (let at = 50; at <= config.sleep.afterMs + 5 * 60_000; at += 50) record(motion.tick(at));
  // The run went through every quiet state, so the check below is not empty.
  const quiet = [FLIGHT.animation, ...config.startup.after, ...config.show.steps, SLEEP];
  for (const animation of quiet) expect(seenBodies.has(animation)).toBe(true);
  for (const animation of quiet) expect(facesDuring.get(animation) ?? 0).toBe(0);
  expect(facesDuring.get(IDLE) ?? 0).toBeGreaterThan(0);
});

test("each face is layered as configured: ear_flap, nose_wiggle and smile add onto the breathing, blink and side_eye replace", () => {
  expect(config.faces.ear_flap.additive).toBe(true);
  expect(config.faces.nose_wiggle.additive).toBe(true);
  expect(config.faces.smile.additive).toBe(true);
  expect(config.faces.side_eye.additive).toBe(false);
  expect(config.faces.blink.additive).toBe(false);

  const sent: MotionCommand[] = [];
  const motion = machine(spread());
  motion.start(0, true);
  for (let at = 100; at <= 10 * 60_000 - 100; at += 100) sent.push(...motion.tick(at));
  sent.push(...motion.feedback(10 * 60_000, { id: "e", kind: "error", sequence: 1 }));
  const faces = sent.filter(command => command.type === "face");
  for (const name of Object.keys(config.faces) as FaceName[]) {
    const ofName = faces.filter(command => command.animation === name);
    expect(ofName.length).toBeGreaterThan(0);
    for (const command of ofName) expect<MotionCommand>(command).toEqual(face(name));
  }
});

test("a face the new state does not allow fades out on the state change, and one it allows keeps playing", () => {
  const gap = config.randomFaces.idle.gapMs[0];
  // Draws: the idle face wait, the face pick, the wait after it, the think face wait.
  for (const name of ["smile", "nose_wiggle"] as const) {
    const motion = machine(scripted(0, drawFor("idle", name), 0, 0));
    motion.start(0, true);
    expect(motion.tick(gap)).toEqual([face(name)]);
    expect(motion.feedback(gap + 100, working("a", 1))).toEqual([faceClear(name), body(THINK, true)]);
  }
  const kept = machine(scripted(0, drawFor("idle", "ear_flap"), 0, 0));
  kept.start(0, true);
  expect(kept.tick(gap)).toEqual([face("ear_flap")]);
  expect(kept.feedback(gap + 100, working("a", 1))).toEqual([body(THINK, true)]);

  // A reaction cut by new work loses its face too.
  const reacting = machine(cycling(0));
  reacting.start(0, true);
  reacting.feedback(10, { id: "s", kind: "saved", sequence: 1 });
  expect(reacting.feedback(110, working("b", 2))).toEqual([faceClear(config.reactions.saved.face), body(THINK, true)]);
});

test("a reaction face still playing when its reaction ends fades out if the next state does not allow it", () => {
  // A configuration copy (data) whose droop holds half as long as side_eye plays, so the face outlasts the reaction.
  const error = config.reactions.error;
  const loops = lengthMs(error.face) / lengthMs(error.body) / 2;
  const shortDroop: MotionConfig = { ...config, reactions: { ...config.reactions, error: { ...error, loops } } };
  const motion = machine(cycling(0), shortDroop);
  motion.start(0, true);
  expect(motion.feedback(10, { id: "e", kind: "error", sequence: 1 })).toEqual([body(error.body, true), face(error.face)]);
  expect(motion.tick(10 + lengthMs(error.body) * loops)).toEqual([faceClear(error.face), body(IDLE, true)]);
});

test("the random show and sleep clear a playing face first", () => {
  // Draws: the idle face wait, the show wait, then the face pick and the wait after it.
  const { motion, at } = idleAfterStartup(scripted(0, 0, drawFor("idle", "blink"), 0));
  const showAt = at + config.show.gapMs[0];
  expect(motion.tick(showAt - 1)).toEqual([face("blink")]);
  expect(motion.tick(showAt)).toEqual([faceClear("blink"), body(config.show.steps[0]!, false)]);

  const sleeping = machine(scripted(0, drawFor("idle", "smile"), 0));
  sleeping.start(0, true);
  expect(sleeping.tick(config.sleep.afterMs - 1)).toEqual([face("smile")]);
  expect(sleeping.tick(config.sleep.afterMs)).toEqual([faceClear("smile"), body(SLEEP, true)]);
});

test("the face wait is drawn across its range, and the next face waits from the end of the previous one (6.5)", () => {
  const range = config.randomFaces.idle.gapMs;
  const wait = (draw: number): number => range[0] + draw * (range[1] - range[0]);
  // Draws: the idle face wait, the pick, the wait after it, the next pick, the wait after that.
  const motion = machine(scripted(0.5, drawFor("idle", "blink"), 0.25, drawFor("idle", "ear_flap"), 0.75));
  motion.start(0, true);
  const first = wait(0.5);
  expect(motion.tick(first - 1)).toEqual([]);
  expect(motion.tick(first)).toEqual([face("blink")]);
  const second = first + lengthMs("blink") + wait(0.25);
  expect(motion.tick(second - 1)).toEqual([]);
  expect(motion.tick(second)).toEqual([face("ear_flap")]);
  const third = second + lengthMs("ear_flap") + wait(0.75);
  expect(motion.tick(third - 1)).toEqual([]);
});

test("no random face is scheduled during a reaction", () => {
  const motion = machine(cycling(0));
  motion.start(0, true);
  const saved = config.reactions.saved;
  expect(motion.feedback(10, { id: "s", kind: "saved", sequence: 1 })).toEqual([body(saved.body, true), face(saved.face)]);
  const holdEnd = 10 + lengthMs(saved.body) * saved.loops;
  for (let at = 20; at < holdEnd; at += 20) expect(motion.tick(at)).toEqual([]);
});

test("the flight eases from the start scale and lift to place and size, and the steps after it stand in place", () => {
  expect(FLIGHT.easing).toBe("easeOutCubic");
  const motion = machine(cycling(0));
  motion.start(1_000, false);
  expect(presentationAt(motion, 1_000)).toEqual({ scale: FLIGHT.startScale, lift: 1 });
  const eased = 1 - (1 - 0.5) ** 3; // easeOutCubic halfway through, section 6.6
  const middle = presentationAt(motion, 1_000 + FLIGHT.durationMs / 2);
  expect(middle.scale).toBeCloseTo(FLIGHT.startScale + (1 - FLIGHT.startScale) * eased, 12);
  expect(middle.lift).toBeCloseTo(1 - eased, 12);
  expect(presentationAt(motion, 1_000 + FLIGHT.durationMs)).toEqual({ scale: 1, lift: 0 });
  motion.tick(1_000 + FLIGHT.durationMs);
  expect(presentationAt(motion, 1_000 + FLIGHT.durationMs + 1)).toEqual({ scale: 1, lift: 0 });
});

test("a feedback during the flight returns straight to place and size over interruptReturnMs", () => {
  const motion = machine(cycling(0));
  motion.start(0, false);
  const cut = FLIGHT.durationMs / 4;
  const from = presentationAt(motion, cut);
  expect(from.scale).toBeLessThan(1);
  expect(from.lift).toBeGreaterThan(0);
  expect(motion.feedback(cut, working("a", 1))).toEqual([body(THINK, true)]);
  expect(presentationAt(motion, cut)).toEqual(from);
  const halfway = presentationAt(motion, cut + BACK_MS / 2);
  expect(halfway.scale).toBeCloseTo(from.scale + (1 - from.scale) / 2, 12);
  expect(halfway.lift).toBeCloseTo(from.lift / 2, 12);
  expect(presentationAt(motion, cut + BACK_MS)).toEqual({ scale: 1, lift: 0 });
  expect(presentationAt(motion, cut + BACK_MS * 10)).toEqual({ scale: 1, lift: 0 });
});

test("reduced motion turned on during the flight puts the pet at its place and size at once, without a return", () => {
  const motion = machine(cycling(0));
  motion.start(0, false);
  expect(motion.reducedMotion(FLIGHT.durationMs / 4, true)).toEqual([body(IDLE, true)]);
  expect(presentationAt(motion, FLIGHT.durationMs / 4)).toEqual({ scale: 1, lift: 0 });

  // Also a return already under way stops at once.
  const returning = machine(cycling(0));
  returning.start(0, false);
  returning.feedback(FLIGHT.durationMs / 4, working("a", 1));
  const turnedOnAt = FLIGHT.durationMs / 4 + BACK_MS / 4;
  expect(presentationAt(returning, turnedOnAt).scale).toBeLessThan(1);
  expect(returning.reducedMotion(turnedOnAt, true)).toEqual([]);
  expect(presentationAt(returning, turnedOnAt)).toEqual({ scale: 1, lift: 0 });
});

test("a feedback after the flight, during cling or land, needs no return", () => {
  const motion = machine(cycling(0));
  motion.start(0, false);
  motion.tick(FLIGHT.durationMs);
  expect(motion.feedback(FLIGHT.durationMs + 10, working("a", 1))).toEqual([body(THINK, true)]);
  expect(presentationAt(motion, FLIGHT.durationMs + 10)).toEqual({ scale: 1, lift: 0 });
});
