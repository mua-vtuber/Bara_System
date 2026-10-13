import type { SkeletonData } from "@esotericsoftware/spine-webgl";
import type { MotionConfig } from "./motion-config.ts";
import { referencedAnimations, startupSteps, stepPairs } from "./motion-schedule.ts";
import { SquirrelError } from "./squirrel-errors.ts";

/** The length in seconds of every animation in the skeleton data, by name: the only source of animation lengths,
 * so no length is written into code. */
export function animationDurations(data: SkeletonData): Readonly<Record<string, number>> {
  const durations: Record<string, number> = {};
  for (const animation of data.animations) durations[animation.name] = animation.duration;
  return Object.freeze(durations);
}

/** Checks the configuration against the loaded skeleton before anything plays, and throws the first mismatch:
 * a name the data lacks (`ANIMATION_MISSING`), a startup or show step change the transition list does not allow
 * (`TRANSITION_NOT_ALLOWED`, detail `from>to`), or a slot with a dark tint while two color tinting is off
 * (`DARK_TINT_DISABLED`; the renderer would drop that colour without a word). */
export function validateMotionConfig(config: MotionConfig, data: SkeletonData): void {
  for (const name of referencedAnimations(config)) {
    if (!data.findAnimation(name)) throw new SquirrelError("ANIMATION_MISSING", name);
  }
  const allowed = new Set(config.transitions.allowed.map(pair => transitionKey(pair.from, pair.to)));
  for (const steps of [startupSteps(config), config.show.steps]) {
    for (const pair of stepPairs(steps)) {
      const key = transitionKey(pair.from, pair.to);
      if (!allowed.has(key)) throw new SquirrelError("TRANSITION_NOT_ALLOWED", key);
    }
  }
  if (config.render.twoColorTint) return;
  for (const slot of data.slots) {
    if (slot.setupPose.darkColor) throw new SquirrelError("DARK_TINT_DISABLED", slot.name);
  }
}

function transitionKey(from: string, to: string): string {
  return `${from}>${to}`;
}
