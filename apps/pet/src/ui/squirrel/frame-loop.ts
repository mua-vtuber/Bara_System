import type { MotionConfig } from "./motion-config.ts";

const MS_PER_SECOND = 1_000;
/** `requestAnimationFrame` times sit on multiples of the display refresh but not exactly: two frames of a 60 Hz display
 * can be 33.32 ms apart under the 33.33 ms of a 30 fps cap. Without this slack such a frame would be skipped and the
 * cap would draw every third frame (20 fps) instead of every second one. It is a timestamp tolerance, not a tuning
 * value: a millisecond is far below any frame interval. */
const FRAME_TIME_SLACK_MS = 1;

/** The elapsed seconds a frame at `time` gets after the last drawn frame at `last`, or `null` when it comes before
 * `minIntervalMs` and is skipped. The first frame (`last` is `null`) gets none, and no frame gets more than
 * `maxDeltaSeconds` or less than nothing, so a pause never turns into a jump. */
export function frameDelta(last: number | null, time: number, minIntervalMs: number, maxDeltaSeconds: number): number | null {
  if (last === null) return 0;
  if (time - last + FRAME_TIME_SLACK_MS < minIntervalMs) return null;
  return Math.max(0, Math.min((time - last) / MS_PER_SECOND, maxDeltaSeconds));
}

/** The one `requestAnimationFrame` loop of the pet (design section 7.4) and its motion clock. It draws at most
 * `frame.maxFps` times a second and hands each frame its elapsed seconds clamped to `frame.maxDeltaSeconds` (physics
 * would otherwise step many times after a pause). It draws only while running and visible: the screen says when the
 * pet is hidden or shown (`setVisible`, from the host's signal and the page's own visibility; plan 1C), and hidden
 * means no frame is even requested. The clock adds only the clamped time of the frames it drew, so it stops while the
 * pet is hidden (section 6.8). The first frame after a start, a resume or a return to visible gets no elapsed time, so
 * nothing jumps. No other timer is used: the motion machine decides everything that is due from this clock. */
export class FrameLoop {
  private readonly minIntervalMs: number;
  private readonly maxDeltaSeconds: number;
  private running = false;
  private shown = true;
  private frameId = 0;
  private lastTime: number | null = null;
  private clockMs = 0;

  constructor(
    frame: MotionConfig["frame"],
    private readonly onFrame: (deltaSeconds: number, clockMs: number) => void,
  ) {
    if (!(frame.maxFps > 0 && frame.maxDeltaSeconds > 0)) throw new RangeError(`The frame cap ${frame.maxFps} fps or the frame step ${frame.maxDeltaSeconds} s is not above 0`);
    this.minIntervalMs = MS_PER_SECOND / frame.maxFps;
    this.maxDeltaSeconds = frame.maxDeltaSeconds;
  }

  /** The motion clock in milliseconds: the clamped time of every frame drawn so far. */
  get clock(): number {
    return this.clockMs;
  }

  /** Whether a frame is requested now. */
  get pending(): boolean {
    return this.frameId !== 0;
  }

  /** Starts drawing, or resumes after `halt`. */
  run(): void {
    this.running = true;
    this.lastTime = null;
    this.request();
  }

  /** Stops drawing until `run`; the clock stops with it. */
  halt(): void {
    this.running = false;
    this.cancel();
  }

  /** The pet was hidden (`false`) or shown again. Hidden cancels the requested frame; shown requests one, which
   * counts as a first frame, so the time hidden is never added to the clock. */
  setVisible(visible: boolean): void {
    if (visible === this.shown) return;
    this.shown = visible;
    this.cancel();
    this.lastTime = null;
    this.request();
  }

  dispose(): void {
    this.halt();
  }

  private readonly step = (time: number): void => {
    this.frameId = 0;
    if (!this.running || !this.shown) return;
    const deltaSeconds = frameDelta(this.lastTime, time, this.minIntervalMs, this.maxDeltaSeconds);
    if (deltaSeconds === null) {
      this.request();
      return;
    }
    this.lastTime = time;
    this.clockMs += deltaSeconds * MS_PER_SECOND;
    this.onFrame(deltaSeconds, this.clockMs);
    this.request();
  };

  private request(): void {
    if (this.running && this.shown && this.frameId === 0) this.frameId = requestAnimationFrame(this.step);
  }

  private cancel(): void {
    if (this.frameId !== 0) cancelAnimationFrame(this.frameId);
    this.frameId = 0;
  }
}
