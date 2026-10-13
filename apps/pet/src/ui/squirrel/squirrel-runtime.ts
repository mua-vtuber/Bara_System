import type { ManagedWebGLRenderingContext, TextureAtlas } from "@esotericsoftware/spine-webgl";
import type { CanvasLayout } from "./camera.ts";
import { FrameLoop } from "./frame-loop.ts";
import { SQUIRREL_MOTION } from "./motion-config.ts";
import { MotionMachine } from "./motion-machine.ts";
import type { MotionFeedback, Presentation } from "./motion-types.ts";
import { animationDurations, validateMotionConfig } from "./motion-validate.ts";
import { causeText, loadSquirrelAssets } from "./squirrel-assets.ts";
import { SquirrelError } from "./squirrel-errors.ts";
import { createSquirrelContext, reapplyAtlasTextures, SquirrelStage, watchDisplay } from "./squirrel-renderer.ts";

// The pet window loads this module with a dynamic `import()` (pet-view.ts), so the Spine runtime stays in its own
// chunk and the other windows never read it (design sections 3.5 and 4.2).

export interface SquirrelOptions {
  /** The canvas that covers the pet window. */
  readonly canvas: HTMLCanvasElement;
  /** The canvas size and the clearance below the character's soles, read from the page's layout and CSS. */
  readonly measure: () => CanvasLayout;
  /** The page URL the squirrel files are fetched relative to. */
  readonly baseUri: string;
  /** The OS reduced-motion setting now; later changes come through `SquirrelHandle.reducedMotion`. */
  readonly reducedMotion: boolean;
  /** A failure after the start, or a lost GPU context during or after it. Lost contexts can come back (`onRecovered`). */
  readonly onFailure: (error: SquirrelError) => void;
  readonly onRecovered: () => void;
}

/** The inputs of a running squirrel. Each applies the motion machine's commands at once, without waiting for a frame
 * (section 4.3). A failure inside stops the drawing and reaches `onFailure`; inputs after it change nothing. */
export interface SquirrelHandle {
  feedback(feedback: MotionFeedback): void;
  quickVisibility(visible: boolean): void;
  /** The mouse moved over or pressed the pet window. */
  activity(): void;
  reducedMotion(reduced: boolean): void;
  /** The pet was hidden (`false`) or shown again (plan 1C). Hidden stops the frame loop: no frame, no Spine update, no
   * draw. Shown draws again from where it stopped; the time hidden is not added to the motion clock. */
  visibility(visible: boolean): void;
}

const LOST_EVENT = "webglcontextlost";
const RESTORED_EVENT = "webglcontextrestored";

/** A failure as the card shows it. Anything the squirrel code did not name itself is a drawing failure with its cause;
 * its stack goes to the console, because the card shows only the message. */
function toSquirrelError(error: unknown): SquirrelError {
  if (error instanceof SquirrelError) return error;
  console.error(error);
  return new SquirrelError("RENDER_FAILED", causeText(error), { cause: error });
}

class SquirrelRuntime implements SquirrelHandle {
  private readonly loop: FrameLoop;
  private readonly stopDisplay: () => void;
  private readonly presentation: Presentation = { scale: 1, lift: 0 };
  private started = false;
  private failed = false;
  private reduced: boolean;

  constructor(private readonly options: SquirrelOptions, private readonly atlas: TextureAtlas,
    private readonly stage: SquirrelStage, private readonly machine: MotionMachine) {
    this.reduced = options.reducedMotion;
    // The screen creates the squirrel only once the pet is shown (pet-view.ts), so it starts visible.
    this.loop = new FrameLoop(SQUIRREL_MOTION.frame, this.frame);
    this.stopDisplay = watchDisplay(this.resized);
    this.loop.run();
  }

  feedback(feedback: MotionFeedback): void {
    if (this.failed) return;
    try { this.stage.apply(this.machine.feedback(this.loop.clock, feedback)); } catch (error) { this.fail(error); }
  }

  quickVisibility(visible: boolean): void {
    if (this.failed) return;
    try { this.stage.apply(this.machine.quickVisibility(this.loop.clock, visible)); } catch (error) { this.fail(error); }
  }

  activity(): void {
    if (this.failed) return;
    try { this.stage.apply(this.machine.activity(this.loop.clock)); } catch (error) { this.fail(error); }
  }

  reducedMotion(reduced: boolean): void {
    if (this.failed) return;
    this.reduced = reduced;
    try { this.stage.apply(this.machine.reducedMotion(this.loop.clock, reduced)); } catch (error) { this.fail(error); }
  }

  visibility(visible: boolean): void {
    if (this.failed) return;
    this.loop.setVisible(visible);
    try { this.stage.apply(this.machine.visibility(this.loop.clock, visible)); } catch (error) { this.fail(error); }
  }

  contextLost(): void {
    if (this.failed) return;
    this.loop.halt();
    this.options.onFailure(new SquirrelError("CONTEXT_LOST", LOST_EVENT));
  }

  /** The Spine context has uploaded the shaders and textures again by now (its own listener runs first); the atlas
   * filters and the GL viewport are set again before drawing resumes. */
  contextRestored(): void {
    if (this.failed) return;
    try {
      reapplyAtlasTextures(this.atlas);
      this.stage.resize();
    } catch (error) {
      this.fail(error);
      return;
    }
    this.options.onRecovered();
    this.loop.run();
  }

  /** One frame (section 7.4). The first frame the pet is visible starts the machine (section 6.6), so the startup
   * flight never plays unseen. A frame that throws stops the loop with `RENDER_FAILED`. */
  private readonly frame = (deltaSeconds: number, clockMs: number): void => {
    try {
      if (this.started) this.stage.apply(this.machine.tick(clockMs));
      else {
        this.started = true;
        this.stage.apply(this.machine.start(clockMs, this.reduced));
      }
      this.machine.presentation(clockMs, this.presentation);
      this.stage.frame(deltaSeconds, this.presentation);
    } catch (error) {
      this.fail(error);
    }
  };

  private readonly resized = (): void => {
    if (this.failed) return;
    try { this.stage.resize(); } catch (error) { this.fail(error); }
  };

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.loop.dispose();
    this.stopDisplay();
    this.options.onFailure(toSquirrelError(error));
  }
}

/** Opens the WebGL context, loads and checks the export, and starts drawing (design section 4.3). Rejects with the
 * `SquirrelError` that names the cause. A context lost while loading is reported through `onFailure` and the start
 * waits for it to come back, because the renderer cannot size itself on a lost context. */
export async function startSquirrel(options: SquirrelOptions): Promise<SquirrelHandle> {
  const config = SQUIRREL_MOTION;
  const { canvas } = options;
  const context: ManagedWebGLRenderingContext = createSquirrelContext(canvas, config);
  let runtime: SquirrelRuntime | null = null;
  let restoredWhileLoading: (() => void) | null = null;
  const lost = (): void => {
    if (runtime) runtime.contextLost();
    else options.onFailure(new SquirrelError("CONTEXT_LOST", LOST_EVENT));
  };
  const restored = (): void => {
    if (runtime) { runtime.contextRestored(); return; }
    options.onRecovered();
    restoredWhileLoading?.();
    restoredWhileLoading = null;
  };
  canvas.addEventListener(LOST_EVENT, lost);
  canvas.addEventListener(RESTORED_EVENT, restored);
  try {
    const assets = await loadSquirrelAssets(context, options.baseUri, config.load.timeoutMs);
    validateMotionConfig(config, assets.data);
    if (context.gl.isContextLost()) await new Promise<void>(resolve => { restoredWhileLoading = resolve; });
    const stage = new SquirrelStage(canvas, context, assets.data, config, options.measure);
    const machine = new MotionMachine(config, animationDurations(assets.data), Math.random);
    runtime = new SquirrelRuntime(options, assets.atlas, stage, machine);
    return runtime;
  } catch (error) {
    canvas.removeEventListener(LOST_EVENT, lost);
    canvas.removeEventListener(RESTORED_EVENT, restored);
    context.dispose();
    throw toSquirrelError(error);
  }
}
