import {
  AnimationState, AnimationStateData, ManagedWebGLRenderingContext, Physics, ResizeMode, SceneRenderer, Skeleton,
  type SkeletonData, type TextureAtlas, type TrackEntry,
} from "@esotericsoftware/spine-webgl";
import {
  boundsCenter, CameraLayoutError, fitCamera, flightStartPoint, presentCamera,
  type CameraFit, type CameraView, type CanvasLayout, type CanvasPoint, type SpinePoint,
} from "./camera.ts";
import type { MotionConfig } from "./motion-config.ts";
import type { MotionCommand, Presentation } from "./motion-types.ts";
import { SquirrelError } from "./squirrel-errors.ts";

type FaceCommand = Extract<MotionCommand, { type: "face" }>;
/** Heights on the error card are shown to a tenth of a pixel. */
const TENTHS = 10;

/** The `detail` of `CAMERA_LAYOUT`: the needed height rounded up and the band rounded down, so the shown pair never
 * reads as if it fitted. */
export function layoutHeights(error: CameraLayoutError): string {
  return `${Math.ceil(error.neededPx * TENTHS) / TENTHS}px > ${Math.floor(error.availablePx * TENTHS) / TENTHS}px`;
}

/** Opens the WebGL context of the transparent pet window with the configured attributes (`alpha` and
 * `premultipliedAlpha` stay true, design section 7.1). Without WebGL the Spine context holds no `gl` and says nothing,
 * so this throws `WEBGL_UNAVAILABLE`. A software WebGL is accepted (`failIfMajorPerformanceCaveat` stays off). */
export function createSquirrelContext(canvas: HTMLCanvasElement, config: MotionConfig): ManagedWebGLRenderingContext {
  const context = new ManagedWebGLRenderingContext(canvas, config.render.contextAttributes);
  if (!(context.gl as WebGLRenderingContext | null)) {
    context.dispose();
    throw new SquirrelError("WEBGL_UNAVAILABLE", "webgl2, webgl");
  }
  return context;
}

/** Calls `onChange` when the window is resized or moves to a display with another pixel ratio (section 7.2). A
 * resolution query matches only the ratio it was made for, so it is made again after every change. Returns the stop. */
export function watchDisplay(onChange: () => void): () => void {
  let query: MediaQueryList | null = null;
  const ratioChanged = (): void => {
    watchRatio();
    onChange();
  };
  const watchRatio = (): void => {
    query?.removeEventListener("change", ratioChanged);
    query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener("change", ratioChanged);
  };
  watchRatio();
  window.addEventListener("resize", onChange);
  return () => {
    query?.removeEventListener("change", ratioChanged);
    window.removeEventListener("resize", onChange);
  };
}

/** Sets every atlas page's filters and wraps on its texture again. A restored context uploads each texture again
 * (`GLTexture.restore`) with its own default filter, so the atlas filters are applied once more. */
export function reapplyAtlasTextures(atlas: TextureAtlas): void {
  for (const page of atlas.pages) {
    if (!page.texture) throw new Error(`The atlas page ${page.name} has no texture`);
    page.setTexture(page.texture);
  }
}

/** The drawn character: the Spine renderer, the skeleton with its animation state, and the fixed camera. Motion
 * commands are applied as they come (section 7.5); `frame` advances, poses and draws one frame (section 7.4). */
export class SquirrelStage {
  private readonly renderer: SceneRenderer;
  private readonly skeleton: Skeleton;
  private readonly state: AnimationState;
  /** The centre of the setup pose, the point the startup flight moves and scales around (section 7.3). */
  private readonly anchor: SpinePoint;
  private readonly view: CameraView = { x: 0, y: 0, zoom: 1 };
  /** `null` while the canvas has no area (a minimized window, a page not laid out yet): there is nowhere to draw. */
  private camera: { fit: CameraFit; start: CanvasPoint } | null;

  constructor(canvas: HTMLCanvasElement, context: ManagedWebGLRenderingContext, data: SkeletonData,
    private readonly config: MotionConfig, private readonly measure: () => CanvasLayout) {
    this.renderer = new SceneRenderer(canvas, context, config.render.twoColorTint);
    this.skeleton = new Skeleton(data);
    this.skeleton.setupPose();
    this.skeleton.updateWorldTransform(Physics.reset);
    this.anchor = boundsCenter(this.skeleton.getBoundsRect());
    const mixes = new AnimationStateData(data);
    mixes.defaultMix = config.mix.defaultSeconds;
    for (const pair of config.mix.pairs) mixes.setMix(pair.from, pair.to, pair.seconds);
    this.state = new AnimationState(mixes);
    this.renderer.resize(ResizeMode.Stretch);
    this.camera = this.fitToCanvas();
  }

  /** Sizes the drawing buffer to the canvas's CSS size times the device pixel ratio (bounded by the GPU), sets the GL
   * viewport and fits the fixed camera to the layout again. Called on start, on a resize or ratio change, and after a
   * lost context comes back; never per frame. */
  resize(): void {
    this.renderer.resize(ResizeMode.Stretch);
    this.camera = this.fitToCanvas();
  }

  apply(commands: readonly MotionCommand[]): void {
    for (let index = 0; index < commands.length; index++) {
      const command = commands[index]!;
      switch (command.type) {
        case "body": this.state.setAnimation(this.config.tracks.body, command.animation, command.loop); break;
        case "face": this.playFace(command); break;
        case "faceClear": this.state.setEmptyAnimation(this.config.tracks.face, command.fadeOutSeconds); break;
        default: {
          const unknown: never = command;
          throw new Error(`Unknown motion command ${JSON.stringify(unknown)}`);
        }
      }
    }
  }

  /** Advances the animations and physics by `deltaSeconds` (already clamped by the loop), places the camera for the
   * startup presentation and draws onto a cleared transparent buffer. The atlas is premultiplied and the Spine
   * renderer blends premultiplied only, so no dark fringe shows on the transparent window. Allocates nothing. */
  frame(deltaSeconds: number, presentation: Presentation): void {
    const { state, skeleton, renderer, view } = this;
    state.update(deltaSeconds);
    state.apply(skeleton);
    skeleton.update(deltaSeconds);
    skeleton.updateWorldTransform(Physics.update);
    if (!this.camera) return;
    presentCamera(this.camera.fit, this.anchor, presentation, this.camera.start, view);
    const camera = renderer.camera;
    camera.position.x = view.x;
    camera.position.y = view.y;
    camera.zoom = view.zoom;
    const gl = renderer.context.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    renderer.begin();
    renderer.drawSkeleton(skeleton);
    renderer.end();
  }

  dispose(): void {
    this.renderer.dispose();
  }

  /** The fixed camera for the current layout. Its viewport is the Spine size of the whole canvas at zoom 1, so the
   * stretched projection maps exactly that range onto the drawing buffer at any pixel ratio. A canvas without area
   * gets no camera until the next resize gives it one; a layout that has area but cannot hold the character still
   * throws: a band too low for the part below the soles as `CAMERA_LAYOUT` with both heights (its English sentence
   * goes to the console only), anything else `fitCamera` refuses as it is. */
  private fitToCanvas(): { fit: CameraFit; start: CanvasPoint } | null {
    const layout = this.measure();
    if (layout.cssWidth <= 0 || layout.cssHeight <= 0) return null;
    let fit: CameraFit;
    try {
      fit = fitCamera(layout, this.config.view.contentBounds, this.config.view.floorY);
    } catch (error) {
      if (!(error instanceof CameraLayoutError)) throw error;
      console.error(error);
      throw new SquirrelError("CAMERA_LAYOUT", layoutHeights(error), { cause: error });
    }
    this.renderer.camera.setViewport(fit.maxX - fit.minX, fit.maxY - fit.minY);
    return { fit, start: flightStartPoint(fit, this.config.startup.flight.startTopPx) };
  }

  /** A face on the face track, faded in and out (section 7.5). On an idle track the face follows an empty animation so
   * it mixes in from the pose below, then an empty animation queued to end with the face mixes it out. A face still
   * showing, including one still fading out, is replaced by mixing across, so the earlier face never cuts off. */
  private playFace(command: FaceCommand): void {
    const track = this.config.tracks.face;
    const current = this.state.getTrack(track);
    let entry: TrackEntry;
    if (current === null || (current.animation === AnimationState.emptyAnimation && current.mixingFrom === null)) {
      this.state.setEmptyAnimation(track, 0);
      entry = this.state.addAnimation(track, command.animation, false, 0);
      entry.setMixDuration(command.fadeInSeconds, 0);
    } else {
      entry = this.state.setAnimation(track, command.animation, false);
      entry.mixDuration = command.fadeInSeconds;
    }
    entry.additive = command.additive;
    this.state.addEmptyAnimation(track, command.fadeOutSeconds, 0);
  }
}
