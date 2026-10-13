import type { AnswerOutcome } from "../../shared/contracts.ts";

/** How a face animation is layered over the body on the face track. `additive` keeps the breathing of the body under
 * the ears and cheeks (U4); a replacing face shows the expression exactly as it was made. The fades blend the face in
 * and out so ears and cheeks never jump. */
export interface FaceSettings { additive: boolean; fadeInSeconds: number; fadeOutSeconds: number }

const FACES = {
  // Replacing: no key of `blink` overlaps `idle` or `think`, so the result is the same, and its attachment and scale
  // keys stay exactly as made (decision D3).
  blink: { additive: false, fadeInSeconds: 0.08, fadeOutSeconds: 0.08 },
  ear_flap: { additive: true, fadeInSeconds: 0.15, fadeOutSeconds: 0.2 },
  nose_wiggle: { additive: true, fadeInSeconds: 0.15, fadeOutSeconds: 0.2 },
  smile: { additive: true, fadeInSeconds: 0.15, fadeOutSeconds: 0.25 },
  side_eye: { additive: false, fadeInSeconds: 0.15, fadeOutSeconds: 0.25 },
} as const satisfies Record<string, FaceSettings>;
/** A face animation the configuration knows how to layer. */
export type FaceName = keyof typeof FACES;
export const FACE_NAMES = Object.keys(FACES) as readonly FaceName[];

/** A reaction to a result feedback: the body animation looped `loops` times (that is how long the reaction holds)
 * and the face played once over it. */
export interface ReactionSettings { body: string; loops: number; face: FaceName }
const REACTIONS = {
  saved: { body: "cheer", loops: 2, face: "smile" },
  answerFound: { body: "cheer", loops: 2, face: "smile" },
  error: { body: "droop", loops: 3, face: "side_eye" },
} as const satisfies Record<string, ReactionSettings>;
/** A reaction the configuration defines. */
export type ReactionName = keyof typeof REACTIONS;
export const REACTION_NAMES = Object.keys(REACTIONS) as readonly ReactionName[];

/** The resting states whose body animation loops for as long as the state lasts. */
export type RestingState = "idle" | "think" | "sleep";
/** The states that layer random face animations. */
export type FaceState = "idle" | "think";
/** One face to choose at random, and its weight among the choices of the state. */
export interface WeightedFace { animation: FaceName; weight: number }
/** A `[least, most]` range a random wait is drawn from, in milliseconds. */
export type GapRange = readonly [number, number];
/** The easing curves `motion-schedule.ts` defines. */
export type EasingName = "easeOutCubic";

/** The whole configuration, read only at every level: nothing changes a tuning value while the pet runs. */
export interface MotionConfig {
  readonly tracks: { readonly body: number; readonly face: number };
  readonly states: Readonly<Record<RestingState, { readonly animation: string }>>;
  /** Plus `rememberIds`: how many result feedback ids are remembered so a re-broadcast id gets no second reaction (D14). */
  readonly reactions: Readonly<Record<ReactionName, Readonly<ReactionSettings>>> & { readonly rememberIds: number };
  /** The reaction for each result feedback, an `answer` one by its `answerOutcome`. `null` means no reaction (U12, O18). */
  readonly reactionFor: {
    readonly saved: ReactionName | null; readonly error: ReactionName | null;
    readonly answer: Readonly<Record<AnswerOutcome, ReactionName | null>>;
  };
  readonly faces: Readonly<Record<FaceName, Readonly<FaceSettings>>>;
  /** The faces each state layers at random, and the wait after one face ends before the next starts. */
  readonly randomFaces: Readonly<Record<FaceState, { readonly choices: readonly Readonly<WeightedFace>[]; readonly gapMs: GapRange }>>;
  /** The mix between body animations, with exceptions for single pairs. */
  readonly mix: { readonly defaultSeconds: number; readonly pairs: readonly { readonly from: string; readonly to: string; readonly seconds: number }[] };
  /** The approaching flight when the app starts (U5): `scale` grows from `startScale` to 1 and the anchor moves from
   * `startTopPx` below the top of the canvas to its place, over `durationMs`; then the `after` steps play once. */
  readonly startup: {
    readonly flight: {
      readonly animation: string; readonly durationMs: number; readonly startScale: number; readonly startTopPx: number;
      readonly easing: EasingName;
    };
    readonly after: readonly string[];
    /** How long the character takes back to its place and size when a real state interrupts the flight. */
    readonly interruptReturnMs: number;
  };
  /** The random show from the idle state (U6): each step plays once, then the pet is idle again. */
  readonly show: { readonly steps: readonly string[]; readonly gapMs: GapRange };
  /** The body changes allowed between the steps of the startup and the show (U7, and `glide>cling` from U5). */
  readonly transitions: { readonly allowed: readonly { readonly from: string; readonly to: string }[] };
  readonly sleep: { readonly afterMs: number };
  /** The Spine-space range the fixed camera always shows, and the height of the soles when standing (section 3.3). */
  readonly view: {
    readonly contentBounds: { readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number };
    readonly floorY: number;
  };
  readonly frame: { readonly maxFps: number; readonly maxDeltaSeconds: number };
  readonly load: { readonly timeoutMs: number };
  readonly render: {
    readonly twoColorTint: boolean;
    /** `alpha` and `premultipliedAlpha` must stay true for the transparent window to composite the character. */
    readonly contextAttributes: {
      readonly alpha: boolean; readonly premultipliedAlpha: boolean; readonly antialias: boolean; readonly depth: boolean;
      readonly stencil: boolean; readonly preserveDrawingBuffer: boolean;
      readonly powerPreference: "default" | "high-performance" | "low-power";
    };
  };
  readonly ui: { readonly commandNoticeMs: number };
}

/** Every tuning value of the squirrel pet (design `docs/decisions/2026-10-04-squirrel-spine-design.md` section 5).
 * Animation lengths are not here: they are read from the skeleton data. */
export const SQUIRREL_MOTION: MotionConfig = {
  tracks: { body: 0, face: 1 },
  states: { idle: { animation: "idle" }, think: { animation: "think" }, sleep: { animation: "sleep" } },
  reactions: { ...REACTIONS, rememberIds: 32 },
  reactionFor: { saved: "saved", error: "error", answer: { found: "answerFound", notFound: null, aiFailed: null } },
  faces: FACES,
  randomFaces: {
    idle: {
      choices: [{ animation: "blink", weight: 3 }, { animation: "ear_flap", weight: 1 }, { animation: "nose_wiggle", weight: 1 }, { animation: "smile", weight: 1 }],
      gapMs: [2_000, 6_000],
    },
    // Never `nose_wiggle` or `smile` while thinking (U3, art/squirrel/README.md).
    think: { choices: [{ animation: "blink", weight: 3 }, { animation: "ear_flap", weight: 1 }], gapMs: [2_000, 6_000] },
  },
  mix: { defaultSeconds: 0.2, pairs: [] },
  startup: {
    flight: { animation: "glide", durationMs: 1_600, startScale: 0.3, startTopPx: 28, easing: "easeOutCubic" },
    after: ["cling", "land"],
    interruptReturnMs: 200,
  },
  show: { steps: ["jump", "cling", "land"], gapMs: [180_000, 480_000] },
  transitions: {
    allowed: [
      { from: "jump", to: "glide" }, { from: "jump", to: "cling" }, { from: "jump", to: "land" },
      { from: "glide", to: "land" }, { from: "cling", to: "land" }, { from: "glide", to: "cling" },
    ],
  },
  sleep: { afterMs: 600_000 },
  view: { contentBounds: { minX: -324.4, maxX: 255.9, minY: -100.7, maxY: 674.2 }, floorY: -12.7 },
  frame: { maxFps: 30, maxDeltaSeconds: 0.1 },
  load: { timeoutMs: 10_000 },
  render: {
    twoColorTint: false,
    contextAttributes: {
      alpha: true, premultipliedAlpha: true, antialias: true, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: "low-power",
    },
  },
  ui: { commandNoticeMs: 12_000 },
};
