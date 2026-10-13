import { expect, test } from "bun:test";
import { MotionMachine } from "./motion-machine.ts";
import { startupSteps } from "./motion-schedule.ts";
import type { MotionCommand, MotionFeedback } from "./motion-types.ts";
import { SquirrelError } from "./squirrel-errors.ts";
import { bodies, body, config, cycling, durations, face, faceClear, idleAfterStartup, lengthMs, machine } from "./test-utils/motion-fixtures.ts";

// Every row of the transition table in design section 6.4, with real animation lengths from bara.json.
const IDLE = config.states.idle.animation;
const THINK = config.states.think.animation;
const SLEEP = config.states.sleep.animation;
const FLIGHT = config.startup.flight.animation;
const STEPS = config.show.steps;
const SHOW_GAP = config.show.gapMs[0];
const SAVED = config.reactions.saved;
const ERROR = config.reactions.error;
const ANSWER_FOUND = config.reactions.answerFound;
const SAVED_REACTION = [body(SAVED.body, true), face(SAVED.face)];

function working(id: string, sequence: number): MotionFeedback {
  return { id, kind: "working", sequence };
}
function idleMachine(): MotionMachine {
  const motion = machine(cycling(0));
  motion.start(0, true);
  return motion;
}
function thrown(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error("expected a throw");
}

test("the configuration maps the app's states as the user decided (U2, U5, U6, U11, U12, O18)", () => {
  expect(config.states).toEqual({ idle: { animation: "idle" }, think: { animation: "think" }, sleep: { animation: "sleep" } });
  expect(SAVED).toMatchObject({ body: "cheer", face: "smile" });
  expect(ANSWER_FOUND).toMatchObject({ body: "cheer", face: "smile" });
  expect(ERROR).toMatchObject({ body: "droop", face: "side_eye" });
  expect(config.reactionFor).toEqual({ saved: "saved", error: "error", answer: { found: "answerFound", notFound: null, aiFailed: null } });
  expect(startupSteps(config)).toEqual(["glide", "cling", "land"]);
  expect(STEPS).toEqual(["jump", "cling", "land"]);
  expect(config.sleep.afterMs).toBe(10 * 60 * 1_000);
});

test("start without reduced motion flies in on a looping glide and shows no face", () => {
  expect(machine(cycling(0)).start(0, false)).toEqual([body(FLIGHT, true)]);
});

test("the startup plays the flight for its time, then cling and land once each at their real lengths, then idle with faces", () => {
  // Entering idle draws the face wait (0 = shortest) and the show wait; the face then draws its pick and the next wait.
  const motion = machine(cycling(0));
  motion.start(1_000, false);
  let at = 1_000 + config.startup.flight.durationMs;
  expect(motion.tick(at - 1)).toEqual([]);
  for (const step of config.startup.after) {
    expect(motion.tick(at)).toEqual([body(step, false)]);
    at += lengthMs(step);
    expect(motion.tick(at - 1)).toEqual([]);
  }
  expect(motion.tick(at)).toEqual([body(IDLE, true)]);
  const faceAt = at + config.randomFaces.idle.gapMs[0];
  expect(motion.tick(faceAt - 1)).toEqual([]);
  expect(motion.tick(faceAt)).toEqual([face(config.randomFaces.idle.choices[0]!.animation)]);
});

test("with reduced motion the pet starts idle at once and keeps its faces, with no flight and no random show", () => {
  const motion = machine(cycling(0.5));
  expect(motion.start(0, true)).toEqual([body(IDLE, true)]);
  const presentation = { scale: 0, lift: 0 };
  motion.presentation(0, presentation);
  expect(presentation).toEqual({ scale: 1, lift: 0 });
  const seen = new Set<string>();
  for (let at = 100; at <= config.show.gapMs[1] * 2; at += 100) {
    if (at % 60_000 === 0) motion.activity(at); // keep it awake
    for (const command of motion.tick(at)) seen.add(command.type === "body" ? `body ${command.animation}` : command.type);
  }
  expect(seen.has("face")).toBe(true);
  expect([...seen].filter(entry => entry.startsWith("body"))).toEqual([]);
});

test("a working feedback shows think, and more progress for the same or another operation does not restart it", () => {
  const motion = idleMachine();
  expect(motion.feedback(10, working("a", 1))).toEqual([body(THINK, true)]);
  expect(motion.feedback(20, working("a", 2))).toEqual([]);
  expect(motion.feedback(30, working("b", 3))).toEqual([]);
});

test("a saved result reacts with cheer on loop and smile, holds for loops x the real length, then returns to idle", () => {
  const motion = idleMachine();
  motion.feedback(10, working("a", 1));
  expect(motion.feedback(1_000, { id: "a", kind: "saved", sequence: 2 })).toEqual(SAVED_REACTION);
  const holdEnd = 1_000 + lengthMs(SAVED.body) * SAVED.loops;
  expect(motion.tick(holdEnd - 1)).toEqual([]);
  expect(motion.tick(holdEnd)).toEqual([body(IDLE, true)]);
});

test("an answer that found memories reacts like a save, and an error droops with side_eye for three lengths", () => {
  const motion = idleMachine();
  expect(motion.feedback(10, { id: "q", kind: "answer", answerOutcome: "found", sequence: 1 }))
    .toEqual([body(ANSWER_FOUND.body, true), face(ANSWER_FOUND.face)]);
  expect(motion.feedback(20, { id: "e", kind: "error", sequence: 2 })).toEqual([body(ERROR.body, true), face(ERROR.face)]);
  const holdEnd = 20 + lengthMs(ERROR.body) * ERROR.loops;
  expect(motion.tick(holdEnd - 1)).toEqual([]);
  expect(motion.tick(holdEnd)).toEqual([body(IDLE, true)]);
});

test("an answer that found nothing or whose AI failed gets no reaction: think ends straight in idle", () => {
  for (const outcome of ["notFound", "aiFailed"] as const) {
    const motion = idleMachine();
    motion.feedback(10, working("q", 1));
    expect(motion.feedback(20, { id: "q", kind: "answer", answerOutcome: outcome, sequence: 2 })).toEqual([body(IDLE, true)]);
  }
});

test("an answer without a reaction keeps think while other work still runs", () => {
  const motion = idleMachine();
  motion.feedback(10, working("a", 1));
  motion.feedback(20, working("b", 2));
  expect(motion.feedback(30, { id: "a", kind: "answer", answerOutcome: "notFound", sequence: 3 })).toEqual([]);
  expect(bodies(motion.tick(60_000))).toEqual([]);
  expect(motion.feedback(60_010, { id: "b", kind: "answer", answerOutcome: "found", sequence: 4 }))
    .toEqual([body(ANSWER_FOUND.body, true), face(ANSWER_FOUND.face)]);
});

test("after a reaction, work that is still running shows think again", () => {
  const motion = idleMachine();
  motion.feedback(10, working("a", 1));
  motion.feedback(20, working("b", 2));
  expect(motion.feedback(1_000, { id: "a", kind: "saved", sequence: 3 })).toEqual(SAVED_REACTION);
  // b was already known to run, so its repeated working feedback is no change and does not cut the reaction.
  expect(motion.feedback(1_500, working("b", 4))).toEqual([]);
  const holdEnd = 1_000 + lengthMs(SAVED.body) * SAVED.loops;
  expect(motion.tick(holdEnd - 1)).toEqual([]);
  expect(motion.tick(holdEnd)).toEqual([body(THINK, true)]);
});

test("new work that starts during a reaction ends the reaction and shows think", () => {
  const motion = idleMachine();
  expect(motion.feedback(10, { id: "a", kind: "saved", sequence: 1 })).toEqual(SAVED_REACTION);
  expect(bodies(motion.feedback(500, working("b", 2)))).toEqual([body(THINK, true)]);
});

test("the latest result owns the reaction: a result that arrives hidden ends the earlier cheer, and it does not come back (D15)", () => {
  const motion = idleMachine();
  expect(motion.feedback(10, { id: "s", kind: "saved", sequence: 1 })).toEqual(SAVED_REACTION);
  motion.visibility(100, false);
  expect(motion.feedback(200, { id: "e", kind: "error", sequence: 2 })).toEqual([faceClear(SAVED.face), body(IDLE, true)]);
  expect(motion.visibility(300, true)).toEqual([]);
  expect(bodies(motion.tick(10 + lengthMs(SAVED.body) * SAVED.loops))).toEqual([]);
});

test("a newer result without a reaction ends the earlier result's cheer, and the state falls to think or idle (D15)", () => {
  const motion = idleMachine();
  motion.feedback(10, { id: "s", kind: "saved", sequence: 1 });
  expect(motion.feedback(500, { id: "q", kind: "answer", answerOutcome: "notFound", sequence: 2 })).toEqual([faceClear(SAVED.face), body(IDLE, true)]);
  expect(bodies(motion.tick(10 + lengthMs(SAVED.body) * SAVED.loops))).toEqual([]);

  const busy = idleMachine();
  busy.feedback(5, working("w", 1));
  busy.feedback(10, { id: "s", kind: "saved", sequence: 2 });
  expect(busy.feedback(500, { id: "q", kind: "answer", answerOutcome: "aiFailed", sequence: 3 })).toEqual([faceClear(SAVED.face), body(THINK, true)]);
});

test("a late working feedback for a result already settled does not bring think back", () => {
  const motion = idleMachine();
  motion.feedback(10, working("a", 1));
  expect(motion.feedback(20, { id: "a", kind: "answer", answerOutcome: "notFound", sequence: 2 })).toEqual([body(IDLE, true)]);
  expect(motion.feedback(30, working("a", 3))).toEqual([]);
  expect(bodies(motion.tick(60_000))).toEqual([]);
});

test("think lasting longer than sleep.afterMs without any activity never loses to sleep (priority 6.3)", () => {
  const motion = idleMachine();
  expect(motion.feedback(10, working("a", 1))).toEqual([body(THINK, true)]);
  const doneAt = 10 + config.sleep.afterMs * 3;
  for (let at = 1_000; at < doneAt; at += 1_000) expect(bodies(motion.tick(at))).toEqual([]);
  // The result is activity: the pet is idle, not asleep, and sleeps only sleep.afterMs later.
  expect(motion.feedback(doneAt, { id: "a", kind: "answer", answerOutcome: "notFound", sequence: 2 })).toEqual([body(IDLE, true)]);
  expect(bodies(motion.tick(doneAt + config.sleep.afterMs - 1))).toEqual([]);
});

test("a sleeping pet in a hidden window wakes to idle when a result arrives, without a reaction", () => {
  const motion = idleMachine();
  expect(bodies(motion.tick(config.sleep.afterMs))).toEqual([body(SLEEP, true)]);
  motion.visibility(config.sleep.afterMs + 10, false);
  expect(motion.feedback(config.sleep.afterMs + 20, { id: "s", kind: "saved", sequence: 1 })).toEqual([body(IDLE, true)]);
});

test("a result reaction plays while the quick input is open: 6.4 sets no quick-input condition on reactions", () => {
  const motion = idleMachine();
  expect(motion.quickVisibility(10, true)).toEqual([]);
  expect(motion.feedback(20, { id: "s", kind: "saved", sequence: 1 })).toEqual(SAVED_REACTION);
  expect(motion.feedback(30, { id: "e", kind: "error", sequence: 2 })).toEqual([body(ERROR.body, true), face(ERROR.face)]);
});

test("a result id already handled gets no second reaction when the tray re-broadcasts it, but still counts as activity", () => {
  const motion = idleMachine();
  motion.feedback(10, { id: "q", kind: "answer", answerOutcome: "found", sequence: 1 });
  motion.tick(10 + lengthMs(ANSWER_FOUND.body) * ANSWER_FOUND.loops);
  expect(motion.feedback(5_000, { id: "q", kind: "answer", answerOutcome: "found", sequence: 7 })).toEqual([]);
  // The re-broadcast reset the inactivity time, so sleep comes sleep.afterMs after it.
  const sleepAt = 5_000 + config.sleep.afterMs;
  expect(bodies(motion.tick(sleepAt - 1))).toEqual([]);
  expect(bodies(motion.tick(sleepAt))).toEqual([body(SLEEP, true)]);
  expect(motion.feedback(sleepAt + 10, { id: "q", kind: "answer", answerOutcome: "found", sequence: 8 })).toEqual([body(IDLE, true)]);
});

test("only the last rememberIds result ids are remembered, the oldest dropped first", () => {
  const motion = idleMachine();
  const limit = config.reactions.rememberIds;
  let sequence = 0;
  for (let index = 0; index <= limit; index++) {
    expect(motion.feedback(index, { id: `r${index}`, kind: "saved", sequence: ++sequence })).toEqual(SAVED_REACTION);
  }
  // limit + 1 ids were handled, so r0 fell out and reacts again; that drops r1, and r2 is still remembered.
  expect(motion.feedback(100, { id: "r0", kind: "saved", sequence: ++sequence })).toEqual(SAVED_REACTION);
  expect(motion.feedback(101, { id: "r2", kind: "saved", sequence: ++sequence })).toEqual([]);
});

test("a feedback with an older sequence than the last is ignored; the same sequence passes as in acceptFeedback", () => {
  const motion = idleMachine();
  expect(motion.feedback(10, working("a", 5))).toEqual([body(THINK, true)]);
  expect(motion.feedback(20, { id: "a", kind: "saved", sequence: 3 })).toEqual([]);
  expect(motion.feedback(30, { id: "a", kind: "saved" })).toEqual([]); // no sequence counts as -1
  expect(bodies(motion.tick(60_000))).toEqual([]); // still thinking
  expect(motion.feedback(60_010, { id: "a", kind: "saved", sequence: 5 })).toEqual(SAVED_REACTION);
});

test("while the window is hidden a result gets no reaction and work still shows think; visibility only records", () => {
  const motion = idleMachine();
  expect(motion.visibility(5, false)).toEqual([]);
  expect(motion.feedback(10, working("a", 1))).toEqual([body(THINK, true)]);
  expect(motion.feedback(20, { id: "a", kind: "saved", sequence: 2 })).toEqual([body(IDLE, true)]);
  expect(motion.visibility(30, true)).toEqual([]);
  expect(motion.feedback(40, { id: "b", kind: "saved", sequence: 3 })).toEqual(SAVED_REACTION);
  // The hidden result was remembered, so a later re-broadcast does not show it late.
  expect(motion.feedback(50, { id: "a", kind: "saved", sequence: 4 })).toEqual([]);
});

test("the random show plays jump, cling and land once each from idle at their real lengths, then idle again", () => {
  const { motion, at } = idleAfterStartup(cycling(0));
  const showAt = at + SHOW_GAP;
  expect(bodies(motion.tick(showAt - 1))).toEqual([]);
  expect(bodies(motion.tick(showAt))).toEqual([body(STEPS[0]!, false)]);
  let stepAt = showAt;
  for (let index = 1; index < STEPS.length; index++) {
    stepAt += lengthMs(STEPS[index - 1]!);
    expect(motion.tick(stepAt - 1)).toEqual([]);
    expect(motion.tick(stepAt)).toEqual([body(STEPS[index]!, false)]);
  }
  expect(motion.tick(stepAt + lengthMs(STEPS[STEPS.length - 1]!))).toEqual([body(IDLE, true)]);
});

test("the show wait is drawn across its whole range: random 0.5 starts the show halfway between the shortest and longest wait", () => {
  const range = config.show.gapMs;
  const halfway = range[0] + (range[1] - range[0]) / 2; // 330000 ms for [180000, 480000]
  const { motion, at } = idleAfterStartup(cycling(0.5));
  expect(bodies(motion.tick(at + halfway - 1))).toEqual([]);
  expect(bodies(motion.tick(at + halfway))).toEqual([body(STEPS[0]!, false)]);
});

test("a show due while the window is hidden is rescheduled from that moment", () => {
  const { motion, at } = idleAfterStartup(cycling(0));
  motion.visibility(at, false);
  const due = at + SHOW_GAP;
  expect(bodies(motion.tick(due))).toEqual([]);
  motion.visibility(due + 1, true);
  expect(bodies(motion.tick(due + SHOW_GAP - 1))).toEqual([]);
  expect(bodies(motion.tick(due + SHOW_GAP))).toEqual([body(STEPS[0]!, false)]);
});

test("an open quick strip blocks the show, and closing it schedules the show from the close", () => {
  const { motion, at } = idleAfterStartup(cycling(0));
  expect(motion.quickVisibility(at + 10, true)).toEqual([]);
  expect(bodies(motion.tick(at + SHOW_GAP))).toEqual([]);
  expect(bodies(motion.tick(at + SHOW_GAP * 2))).toEqual([]);
  const closedAt = at + SHOW_GAP * 2 + 5;
  expect(motion.quickVisibility(closedAt, false)).toEqual([]);
  expect(bodies(motion.tick(closedAt + SHOW_GAP - 1))).toEqual([]);
  expect(bodies(motion.tick(closedAt + SHOW_GAP))).toEqual([body(STEPS[0]!, false)]);
});

test("no show starts while thinking, asleep or with reduced motion; it comes a show wait after the pet is idle again", () => {
  const thinking = idleAfterStartup(cycling(0));
  thinking.motion.feedback(thinking.at + 10, working("a", 1));
  expect(bodies(thinking.motion.tick(thinking.at + SHOW_GAP))).toEqual([]);
  const idleAt = thinking.at + SHOW_GAP + 10;
  expect(thinking.motion.feedback(idleAt, { id: "a", kind: "answer", answerOutcome: "notFound", sequence: 2 })).toEqual([body(IDLE, true)]);
  expect(bodies(thinking.motion.tick(idleAt + SHOW_GAP - 1))).toEqual([]);
  expect(bodies(thinking.motion.tick(idleAt + SHOW_GAP))).toEqual([body(STEPS[0]!, false)]);

  // Sleep is checked before the due show, so the overdue show does not jump a sleeping pet.
  const sleeping = idleAfterStartup(cycling(0)).motion;
  expect(bodies(sleeping.tick(config.sleep.afterMs))).toEqual([body(SLEEP, true)]);
  expect(bodies(sleeping.tick(config.sleep.afterMs + SHOW_GAP))).toEqual([]);
  const wokeAt = config.sleep.afterMs + SHOW_GAP + 10;
  expect(sleeping.activity(wokeAt)).toEqual([body(IDLE, true)]);
  expect(bodies(sleeping.tick(wokeAt + SHOW_GAP))).toEqual([body(STEPS[0]!, false)]);

  const reduced = idleAfterStartup(cycling(0));
  expect(reduced.motion.reducedMotion(reduced.at + 10, true)).toEqual([]);
  expect(bodies(reduced.motion.tick(reduced.at + SHOW_GAP))).toEqual([]);
  const restoredAt = reduced.at + SHOW_GAP * 2;
  reduced.motion.activity(restoredAt);
  expect(bodies(reduced.motion.tick(restoredAt))).toEqual([]);
  expect(reduced.motion.reducedMotion(restoredAt, false)).toEqual([]);
  expect(bodies(reduced.motion.tick(restoredAt + SHOW_GAP - 1))).toEqual([]);
  expect(bodies(reduced.motion.tick(restoredAt + SHOW_GAP))).toEqual([body(STEPS[0]!, false)]);
});

test("a feedback during the show returns the real state in the same call, and the show never resumes", () => {
  const { motion, at } = idleAfterStartup(cycling(0));
  const showAt = at + SHOW_GAP;
  motion.tick(showAt);
  const secondStepAt = showAt + lengthMs(STEPS[0]!);
  expect(motion.tick(secondStepAt)).toEqual([body(STEPS[1]!, false)]);
  expect(motion.feedback(secondStepAt + 100, working("a", 1))).toEqual([body(THINK, true)]);
  expect(motion.feedback(secondStepAt + 200, { id: "a", kind: "answer", answerOutcome: "notFound", sequence: 2 })).toEqual([body(IDLE, true)]);
  let stepAt = secondStepAt;
  for (let index = 1; index < STEPS.length; index++) {
    stepAt += lengthMs(STEPS[index]!);
    expect(bodies(motion.tick(stepAt))).toEqual([]);
  }

  const reacting = idleAfterStartup(cycling(0));
  reacting.motion.tick(reacting.at + SHOW_GAP);
  expect(reacting.motion.feedback(reacting.at + SHOW_GAP + 100, { id: "s", kind: "saved", sequence: 1 })).toEqual(SAVED_REACTION);

  // Hidden, a result still ends the show although it gets no reaction.
  const hidden = idleAfterStartup(cycling(0));
  hidden.motion.tick(hidden.at + SHOW_GAP);
  hidden.motion.visibility(hidden.at + SHOW_GAP + 50, false);
  expect(hidden.motion.feedback(hidden.at + SHOW_GAP + 100, { id: "s", kind: "saved", sequence: 1 })).toEqual([body(IDLE, true)]);
});

test("a feedback during the startup flight returns the real state in the same call, and the startup never resumes", () => {
  const motion = machine(cycling(0));
  motion.start(0, false);
  expect(motion.feedback(400, working("a", 1))).toEqual([body(THINK, true)]);
  expect(bodies(motion.tick(config.startup.flight.durationMs))).toEqual([]);
  expect(motion.feedback(3_000, { id: "a", kind: "answer", answerOutcome: "notFound", sequence: 2 })).toEqual([body(IDLE, true)]);
  expect(bodies(motion.tick(config.startup.flight.durationMs + lengthMs(config.startup.after[0]!)))).toEqual([]);

  const reacting = machine(cycling(0));
  reacting.start(0, false);
  expect(reacting.feedback(400, { id: "s", kind: "saved", sequence: 1 })).toEqual(SAVED_REACTION);
});

test("opening the quick strip ends the random show at once", () => {
  const { motion, at } = idleAfterStartup(cycling(0));
  motion.tick(at + SHOW_GAP);
  expect(motion.quickVisibility(at + SHOW_GAP + 100, true)).toEqual([body(IDLE, true)]);
});

test("the pet sleeps after sleep.afterMs without interaction, and mouse activity postpones it", () => {
  const motion = idleMachine();
  expect(bodies(motion.tick(config.sleep.afterMs - 1))).toEqual([]);
  expect(bodies(motion.tick(config.sleep.afterMs))).toEqual([body(SLEEP, true)]);

  const active = idleMachine();
  expect(active.activity(1_000)).toEqual([]);
  expect(bodies(active.tick(config.sleep.afterMs))).toEqual([]);
  expect(bodies(active.tick(1_000 + config.sleep.afterMs))).toEqual([body(SLEEP, true)]);
});

test("a sleeping pet wakes by mouse activity, by feedback and by the quick strip", () => {
  const asleep = (): MotionMachine => {
    const motion = idleMachine();
    motion.tick(config.sleep.afterMs);
    return motion;
  };
  const wakeAt = config.sleep.afterMs + 1_000;
  expect(asleep().activity(wakeAt)).toEqual([body(IDLE, true)]);
  expect(asleep().feedback(wakeAt, working("a", 1))).toEqual([body(THINK, true)]);
  expect(asleep().feedback(wakeAt, { id: "s", kind: "saved", sequence: 1 })).toEqual(SAVED_REACTION);
  expect(asleep().feedback(wakeAt, { id: "q", kind: "answer", answerOutcome: "notFound", sequence: 1 })).toEqual([body(IDLE, true)]);
  expect(asleep().quickVisibility(wakeAt, true)).toEqual([body(IDLE, true)]);
});

test("an open quick strip keeps the pet awake, and closing it starts the inactivity time again", () => {
  const motion = idleMachine();
  expect(motion.quickVisibility(1_000, true)).toEqual([]);
  expect(bodies(motion.tick(config.sleep.afterMs * 3))).toEqual([]);
  const closedAt = config.sleep.afterMs * 3 + 10;
  expect(motion.quickVisibility(closedAt, false)).toEqual([]);
  expect(bodies(motion.tick(closedAt + config.sleep.afterMs - 1))).toEqual([]);
  expect(bodies(motion.tick(closedAt + config.sleep.afterMs))).toEqual([body(SLEEP, true)]);
});

test("turning reduced motion on ends the startup and the show at once; repeating the current value changes nothing", () => {
  const starting = machine(cycling(0));
  starting.start(0, false);
  expect(starting.reducedMotion(400, true)).toEqual([body(IDLE, true)]);
  expect(bodies(starting.tick(config.startup.flight.durationMs))).toEqual([]);

  const showing = idleAfterStartup(cycling(0));
  showing.motion.tick(showing.at + SHOW_GAP);
  expect(showing.motion.reducedMotion(showing.at + SHOW_GAP + 100, true)).toEqual([body(IDLE, true)]);

  const unchanged = idleAfterStartup(cycling(0));
  expect(unchanged.motion.reducedMotion(unchanged.at + 1_000, false)).toEqual([]);
  expect(bodies(unchanged.motion.tick(unchanged.at + SHOW_GAP))).toEqual([body(STEPS[0]!, false)]);
});

test("with reduced motion on, a due show stops its schedule instead of drawing a new wait each time", () => {
  let draws = 0;
  const { motion, at } = idleAfterStartup(() => { draws++; return 0; });
  motion.reducedMotion(at + 10, true);
  for (const due of [at + SHOW_GAP, at + SHOW_GAP * 2]) {
    const before = draws;
    // Only the face pick and the wait after it are drawn: no new show wait, and no show.
    expect(motion.tick(due)).toEqual([face(config.randomFaces.idle.choices[0]!.animation)]);
    expect(draws - before).toBe(2);
    motion.activity(due); // keep it awake
  }
});

test("inputs before the first frame are kept: running work skips the flight, and a result before it gets no late reaction", () => {
  const busy = machine(cycling(0));
  expect(busy.feedback(0, working("a", 1))).toEqual([]);
  expect(busy.start(10, false)).toEqual([body(THINK, true)]);

  const settled = machine(cycling(0));
  expect(settled.feedback(0, { id: "s", kind: "saved", sequence: 1 })).toEqual([]);
  expect(settled.start(10, false)).toEqual([body(FLIGHT, true)]);
  expect(settled.feedback(20, { id: "s", kind: "saved", sequence: 2 })).toEqual([]);
});

test("misuse and broken inputs throw instead of being guessed", () => {
  const motion = machine(cycling(0));
  expect(String(thrown(() => motion.tick(0)))).toContain("before start");
  expect(String(thrown(() => motion.presentation(0, { scale: 1, lift: 0 })))).toContain("before start");
  motion.start(0, true);
  expect(String(thrown(() => motion.start(1, true)))).toContain("twice");
  const withoutOutcome = { id: "q", kind: "answer", sequence: 1 } as unknown as MotionFeedback;
  const unknownOutcome = { id: "q", kind: "answer", answerOutcome: "maybe", sequence: 1 } as unknown as MotionFeedback;
  expect(String(thrown(() => motion.feedback(1, withoutOutcome)))).toContain("answerOutcome");
  expect(String(thrown(() => motion.feedback(1, unknownOutcome)))).toContain("answerOutcome");
  // Nothing was taken from the broken feedbacks: sequence 1 is still new.
  expect(motion.feedback(2, working("w", 1))).toEqual([body(THINK, true)]);

  const missing = STEPS[0]!;
  const withoutStep = Object.fromEntries(Object.entries(durations).filter(([name]) => name !== missing));
  const error = thrown(() => new MotionMachine(config, withoutStep, cycling(0)));
  expect(error).toBeInstanceOf(SquirrelError);
  expect(error).toMatchObject({ code: "ANIMATION_MISSING", detail: missing });

  expect(thrown(() => machine(() => 1).start(0, true))).toBeInstanceOf(RangeError);
});

test("a frame without a change returns the one shared, frozen empty list", () => {
  const motion = idleMachine();
  const first: readonly MotionCommand[] = motion.tick(1);
  expect(first).toEqual([]);
  expect(motion.tick(2)).toBe(first);
  expect(motion.visibility(3, false)).toBe(first);
  expect(Object.isFrozen(first)).toBe(true);
});
