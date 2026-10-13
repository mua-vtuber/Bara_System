import { messages } from "../messages.ts";
import type { SquirrelError } from "./squirrel-errors.ts";

/** The Korean cause shown on the pet's error card for a `SquirrelError` (design section 8). A code whose text needs
 * no detail (no WebGL, a lost GPU context) has a fixed sentence; every other text carries the error's `detail`: the
 * file with its HTTP status or cause, the animation or slot name, the time limit, or the cause. */
export function squirrelErrorText(error: SquirrelError): string {
  const text = messages.pet.errors[error.code];
  return typeof text === "string" ? text : text(error.detail);
}
