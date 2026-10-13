import { expect, test } from "bun:test";
import { messages } from "../messages.ts";
import { CameraLayoutError, fitCamera } from "./camera.ts";
import { SQUIRREL_MOTION } from "./motion-config.ts";
import { squirrelErrorText } from "./squirrel-error-text.ts";
import { SQUIRREL_ERROR_CODES, SquirrelError, type SquirrelErrorCode } from "./squirrel-errors.ts";
import { layoutHeights } from "./squirrel-renderer.ts";

// The texts of the pet's error card (design section 8), checked against the code list, the same way error-text.test.ts
// checks the host error codes.

/** The two codes section 8 leaves without a detail: no WebGL at all, and a lost GPU context. */
const WITHOUT_DETAIL: readonly SquirrelErrorCode[] = ["WEBGL_UNAVAILABLE", "CONTEXT_LOST"];
/** The codes whose detail carries an exception's sentence after the file name (or alone), which can come out empty. */
const WITH_CAUSE: readonly SquirrelErrorCode[] = ["ASSET_NETWORK", "ASSET_PARSE", "MODULE_LOAD", "RENDER_FAILED"];
const DETAIL = "detail-sample.png, HTTP 404";

test("every squirrel error code has a Korean text, and no text is left without a code", () => {
  expect(new Set(SQUIRREL_ERROR_CODES).size).toBe(SQUIRREL_ERROR_CODES.length);
  expect(Object.keys(messages.pet.errors).sort()).toEqual([...SQUIRREL_ERROR_CODES].sort());
  for (const code of SQUIRREL_ERROR_CODES) {
    expect({ code, text: squirrelErrorText(new SquirrelError(code, DETAIL)) }).toEqual({ code, text: expect.stringMatching(/[가-힣]/) });
  }
});

test("every text but the two section 8 leaves bare carries the error's detail", () => {
  expect(SQUIRREL_ERROR_CODES.filter(code => typeof messages.pet.errors[code] === "string").sort()).toEqual([...WITHOUT_DETAIL].sort());
  for (const code of SQUIRREL_ERROR_CODES) {
    if (WITHOUT_DETAIL.includes(code)) continue;
    expect({ code, text: squirrelErrorText(new SquirrelError(code, DETAIL)) }).toEqual({ code, text: expect.stringContaining(DETAIL) });
  }
});

test("details as the squirrel code writes them reach the card: a file with its status, names, a time limit", () => {
  expect(squirrelErrorText(new SquirrelError("ASSET_HTTP", "bara.png, HTTP 404"))).toContain("bara.png, HTTP 404");
  expect(squirrelErrorText(new SquirrelError("IMAGE_DECODE", "bara.png"))).toContain("bara.png");
  expect(squirrelErrorText(new SquirrelError("ASSET_MISSING", "bara.atlas"))).toContain("bara.atlas");
  expect(squirrelErrorText(new SquirrelError("ANIMATION_MISSING", "glide"))).toContain("glide");
  expect(squirrelErrorText(new SquirrelError("TRANSITION_NOT_ALLOWED", "jump>sleep"))).toContain("jump>sleep");
  expect(squirrelErrorText(new SquirrelError("DARK_TINT_DISABLED", "eye_shadow_L"))).toContain("eye_shadow_L");
  expect(squirrelErrorText(new SquirrelError("LOAD_TIMEOUT", "10"))).toContain("10초");
});

test("a cause that came out empty is said in words, never shown as empty parentheses", () => {
  for (const code of WITH_CAUSE) {
    const text = squirrelErrorText(new SquirrelError(code, ""));
    expect({ code, text }).toEqual({ code, text: expect.not.stringContaining("()") });
    expect(text).toMatch(/[가-힣]/);
  }
});

test("a layout too low for the character names both heights in px in Korean, without the English refusal", () => {
  let refusal: unknown;
  try {
    fitCamera({ cssWidth: 150, cssHeight: 165, bandPx: 0 }, SQUIRREL_MOTION.view.contentBounds, SQUIRREL_MOTION.view.floorY);
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(CameraLayoutError);
  const layout = refusal as CameraLayoutError;
  const heights = layoutHeights(layout);
  expect(heights).toBe(`${Math.ceil(layout.neededPx * 10) / 10}px > 0px`);
  const text = squirrelErrorText(new SquirrelError("CAMERA_LAYOUT", heights, { cause: layout }));
  expect(text).toContain(heights);
  expect(text).toMatch(/[가-힣]/);
  expect(text).not.toContain(layout.message);
  expect(text).not.toMatch(/[A-Za-z]{3,}/);
});

test("the shown heights never read as if they fitted: the need rounds up, the band rounds down", () => {
  expect(layoutHeights(new CameraLayoutError("refused", 17.31, 17.39))).toBe("17.4px > 17.3px");
  expect(layoutHeights(new CameraLayoutError("refused", 21.14, 0))).toBe("21.2px > 0px");
});

test("the card and notice line texts are Korean", () => {
  for (const text of [messages.pet.errorTitle, messages.pet.errorHint, messages.pet.answerOutcomeMissing, messages.pet.listenFailed("원인")]) {
    expect(text).toMatch(/[가-힣]/);
  }
  expect(messages.pet.listenFailed("listen denied")).toContain("listen denied");
});

test("a refused pet window command names its cause, and an opening says it did not finish rather than never started", () => {
  /** A cause that does not itself say "did not finish", so the phrase below can only come from the text. */
  const reason = "창이 응답하지 않아요.";
  const unfinished = "끝내지 못했어요";
  for (const failed of [messages.pet.quickToggleFailed, messages.pet.panelOpenFailed, messages.pet.dragFailed]) {
    expect(failed(reason)).toContain(reason);
    expect(failed(reason)).toMatch(/[가-힣]/);
    expect(failed("")).not.toMatch(/원인: $/);
  }
  // The host shows the window before it focuses it, so a refusal can come after the window appeared (D10).
  for (const failed of [messages.pet.quickToggleFailed, messages.pet.panelOpenFailed]) {
    expect(reason).not.toContain(unfinished);
    expect(failed(reason)).toContain(unfinished);
    expect(failed("")).toContain(unfinished);
  }
});
