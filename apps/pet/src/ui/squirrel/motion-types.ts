import type { AnswerOutcome } from "../../shared/contracts.ts";

/** What the motion machine asks the renderer to do (design section 7.5). `body` plays on the body track, `face` layers
 * a face animation once on the face track, `faceClear` fades the face track out. */
export type MotionCommand =
  | { type: "body"; animation: string; loop: boolean }
  | { type: "face"; animation: string; additive: boolean; fadeInSeconds: number; fadeOutSeconds: number }
  | { type: "faceClear"; fadeOutSeconds: number };

/** The startup presentation. `scale` 1 and `lift` 0 is the character at its place and size; `lift` 1 puts the
 * anchor at the flight's start point. The camera turns it into pixels (`camera.ts`). */
export interface Presentation { scale: number; lift: number }

/** The part of a `pet-feedback` the machine reads. An `answer` always names its outcome: `contracts.ts` defines the
 * values, and a feedback without one is a contract break the screen reports instead of passing on (section 9.1). */
export type MotionFeedback =
  | { id: string; kind: "working" | "saved" | "error"; sequence?: number }
  | { id: string; kind: "answer"; answerOutcome: AnswerOutcome; sequence?: number };

/** What the machine shows. `booting` is before `start`, the rest follow the priority of section 6.3. */
export type MotionMode = "booting" | "startup" | "idle" | "show" | "think" | "reaction" | "sleep";
