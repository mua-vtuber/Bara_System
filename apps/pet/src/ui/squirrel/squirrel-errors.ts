/** Every way the squirrel can fail to show (design section 8). The screen turns a code into its Korean text
 * (`squirrel-error-text.ts`); this module never holds user-facing words. */
export const SQUIRREL_ERROR_CODES = [
  "WEBGL_UNAVAILABLE", "ASSET_HTTP", "ASSET_NETWORK", "IMAGE_DECODE", "ASSET_PARSE", "ANIMATION_MISSING",
  "TRANSITION_NOT_ALLOWED", "DARK_TINT_DISABLED", "LOAD_TIMEOUT", "MODULE_LOAD", "CONTEXT_LOST", "RENDER_FAILED",
  "CAMERA_LAYOUT", "ASSET_MISSING",
] as const;
export type SquirrelErrorCode = (typeof SQUIRREL_ERROR_CODES)[number];

/** A failure with its code and the one fact the text needs (`detail`): a file name with its HTTP status, an animation
 * name, a `from>to` transition, a slot name, a time limit, a `needed > available` pair of heights in px
 * (`CAMERA_LAYOUT`) or a cause. `message` is for logs only. */
export class SquirrelError extends Error {
  constructor(readonly code: SquirrelErrorCode, readonly detail: string, options?: { cause?: unknown }) {
    super(`${code}: ${detail}`, options);
    this.name = "SquirrelError";
  }
}
