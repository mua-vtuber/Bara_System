import { expect, test } from "bun:test";
import { SQUIRREL_MOTION, type MotionConfig } from "./motion-config.ts";
import { referencedAnimations, startupSteps, stepPairs } from "./motion-schedule.ts";
import { animationDurations, validateMotionConfig } from "./motion-validate.ts";
import { SquirrelError } from "./squirrel-errors.ts";
import { loadRealSkeletonData, parseSkeletonData, readRealSkeletonFiles } from "./test-utils/real-skeleton.ts";

// The configuration checked against the real export (bara.json, bara.atlas) through the real Spine classes.
const data = await loadRealSkeletonData();

function validationError(config: MotionConfig, skeleton = data): SquirrelError {
  try { validateMotionConfig(config, skeleton); } catch (error) {
    if (error instanceof SquirrelError) return error;
    throw error;
  }
  throw new Error("expected the validation to fail");
}

test("every animation the configuration names exists in the real export, and validation passes", () => {
  for (const name of referencedAnimations(SQUIRREL_MOTION)) expect(data.findAnimation(name)).not.toBeNull();
  expect(() => validateMotionConfig(SQUIRREL_MOTION, data)).not.toThrow();
});

test("the animation lengths come from the data, one per animation", () => {
  const durations = animationDurations(data);
  expect(Object.keys(durations).sort()).toEqual(data.animations.map(animation => animation.name).sort());
  for (const animation of data.animations) {
    expect(durations[animation.name]).toBe(animation.duration);
    expect(animation.duration).toBeGreaterThan(0);
  }
  expect(Object.isFrozen(durations)).toBe(true);
});

test("every step change of the startup and the show is on the allowed transition list", () => {
  const allowed = SQUIRREL_MOTION.transitions.allowed.map(pair => `${pair.from}>${pair.to}`);
  for (const steps of [startupSteps(SQUIRREL_MOTION), SQUIRREL_MOTION.show.steps]) {
    for (const pair of stepPairs(steps)) expect(allowed).toContain(`${pair.from}>${pair.to}`);
  }
  // U7, plus glide>cling from the startup order of U5 (O17).
  expect([...allowed].sort()).toEqual(["cling>land", "glide>cling", "glide>land", "jump>cling", "jump>glide", "jump>land"]);
});

test("no slot of the real export has a dark tint, so two color tinting stays off", () => {
  expect(SQUIRREL_MOTION.render.twoColorTint).toBe(false);
  expect(data.slots.filter(slot => slot.setupPose.darkColor).map(slot => slot.name)).toEqual([]);
});

test("a configuration copy with one animation name changed fails with ANIMATION_MISSING and that name", () => {
  const renamedState: MotionConfig = { ...SQUIRREL_MOTION, states: { ...SQUIRREL_MOTION.states, think: { animation: "thinking" } } };
  expect(validationError(renamedState)).toMatchObject({ code: "ANIMATION_MISSING", detail: "thinking" });
  const renamedStep: MotionConfig = { ...SQUIRREL_MOTION, show: { ...SQUIRREL_MOTION.show, steps: ["jump", "clinging", "land"] } };
  expect(validationError(renamedStep)).toMatchObject({ code: "ANIMATION_MISSING", detail: "clinging" });
});

test("a step change outside the allowed list fails with TRANSITION_NOT_ALLOWED and the pair", () => {
  const showStep: MotionConfig = { ...SQUIRREL_MOTION, show: { ...SQUIRREL_MOTION.show, steps: ["jump", "sleep", "land"] } };
  expect(validationError(showStep)).toMatchObject({ code: "TRANSITION_NOT_ALLOWED", detail: "jump>sleep" });
  const startupOrder: MotionConfig = { ...SQUIRREL_MOTION, startup: { ...SQUIRREL_MOTION.startup, after: ["land", "cling"] } };
  expect(validationError(startupOrder)).toMatchObject({ code: "TRANSITION_NOT_ALLOWED", detail: "land>cling" });
});

test("a slot with a dark tint fails with DARK_TINT_DISABLED and the slot name while two color tinting is off", async () => {
  // The real export with one slot given a dark colour, parsed by the real SkeletonJson.
  const files = await readRealSkeletonFiles();
  const json = JSON.parse(files.skeletonText) as { slots: Array<{ name: string; dark?: string }> };
  const slot = json.slots[0]!;
  slot.dark = "000000";
  const tinted = parseSkeletonData(files.atlasText, JSON.stringify(json));
  expect(validationError(SQUIRREL_MOTION, tinted)).toMatchObject({ code: "DARK_TINT_DISABLED", detail: slot.name });
  const twoColor: MotionConfig = { ...SQUIRREL_MOTION, render: { ...SQUIRREL_MOTION.render, twoColorTint: true } };
  expect(() => validateMotionConfig(twoColor, tinted)).not.toThrow();
});
