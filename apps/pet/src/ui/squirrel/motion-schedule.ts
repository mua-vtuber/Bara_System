import { FACE_NAMES, REACTION_NAMES, type EasingName, type FaceName, type GapRange, type MotionConfig, type WeightedFace } from "./motion-config.ts";

const MS_PER_SECOND = 1_000;

/** The easing curves a configuration can name. Both `t` and the result run from 0 to 1. */
export const EASINGS: Readonly<Record<EasingName, (t: number) => number>> = {
  easeOutCubic: t => 1 - (1 - t) ** 3,
};

export function clamp01(value: number): number {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

/** One draw of the injected random source. A value outside [0, 1) is a broken source, not something to round into a
 * choice, so it fails here instead of skewing a face or a wait. */
export function drawUnit(random: () => number): number {
  const value = random();
  if (!(value >= 0 && value < 1)) throw new RangeError(`The random source returned ${value}, outside [0, 1)`);
  return value;
}

/** A wait drawn from `[least, most]` milliseconds. */
export function drawGap(range: GapRange, random: () => number): number {
  return range[0] + drawUnit(random) * (range[1] - range[0]);
}

/** A face list prepared once so a pick allocates nothing: `bounds[i]` is the running weight up to choice `i`. */
export interface WeightedTable { readonly names: readonly FaceName[]; readonly bounds: readonly number[]; readonly total: number }

export function weightedTable(choices: readonly WeightedFace[]): WeightedTable {
  if (!choices.length) throw new RangeError("A random face list has no choices");
  const names: FaceName[] = [];
  const bounds: number[] = [];
  let total = 0;
  for (const choice of choices) {
    if (!(choice.weight > 0 && Number.isFinite(choice.weight))) throw new RangeError(`The face ${choice.animation} has the weight ${choice.weight}`);
    total += choice.weight;
    names.push(choice.animation);
    bounds.push(total);
  }
  return { names, bounds, total };
}

export function pickWeighted(table: WeightedTable, random: () => number): FaceName {
  const point = drawUnit(random) * table.total;
  for (let index = 0; index < table.bounds.length; index++) if (point < table.bounds[index]) return table.names[index];
  // A draw just under 1 can round `point` up to exactly `total`; that point is the top of the last choice.
  return table.names[table.names.length - 1];
}

/** When something that starts at `now` (milliseconds) and lasts `seconds`, played `times` times, ends. */
export function endsAfter(now: number, seconds: number, times = 1): number {
  return now + seconds * times * MS_PER_SECOND;
}

/** The body steps of the startup in order: the flight, then each `after` step. */
export function startupSteps(config: MotionConfig): readonly string[] {
  return [config.startup.flight.animation, ...config.startup.after];
}

/** The neighbouring pairs of a step sequence, the changes the transition list must allow. */
export function stepPairs(steps: readonly string[]): Array<{ from: string; to: string }> {
  const pairs: Array<{ from: string; to: string }> = [];
  for (let index = 1; index < steps.length; index++) pairs.push({ from: steps[index - 1], to: steps[index] });
  return pairs;
}

/** The body animations the configuration plays: the resting states, the reactions, the startup and the show. */
export function bodyAnimations(config: MotionConfig): Set<string> {
  const names = new Set<string>();
  for (const state of Object.values(config.states)) names.add(state.animation);
  for (const reaction of REACTION_NAMES) names.add(config.reactions[reaction].body);
  for (const step of startupSteps(config)) names.add(step);
  for (const step of config.show.steps) names.add(step);
  return names;
}

/** Every animation name the configuration refers to anywhere, each of which the skeleton data must have. */
export function referencedAnimations(config: MotionConfig): Set<string> {
  const names = bodyAnimations(config);
  for (const face of FACE_NAMES) names.add(face);
  for (const reaction of REACTION_NAMES) names.add(config.reactions[reaction].face);
  for (const state of Object.values(config.randomFaces)) for (const choice of state.choices) names.add(choice.animation);
  for (const pair of config.mix.pairs) names.add(pair.from).add(pair.to);
  for (const pair of config.transitions.allowed) names.add(pair.from).add(pair.to);
  return names;
}
