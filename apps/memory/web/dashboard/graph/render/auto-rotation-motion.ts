const ROTATION_SPEED = (2 * Math.PI) / 240;
const DECELERATION_SECONDS = 0.25;
const IDLE_SECONDS = 8;
const ACCELERATION_SECONDS = 1;

/** Pure rotation timing. All timestamps are monotonic seconds. */
export class AutoRotationMotion {
  private time: number;
  private rampStart: number;
  private rampDuration = 0;
  private rampFrom = ROTATION_SPEED;
  private rampTo = ROTATION_SPEED;
  private resumeAt = Infinity;
  private pendingAngle = 0;
  private interacting = false;
  private paused = false;

  constructor(now: number) {
    this.time = now;
    this.rampStart = now;
  }

  /** Radians accumulated since the last frame, including intervening events. */
  step(now: number): number {
    const angle = this.pendingAngle + this.advance(now);
    this.pendingAngle = 0;
    return angle;
  }

  activity(now: number): void {
    this.pendingAngle += this.advance(now);
    if (this.paused) return;

    // A wheel burst refreshes idle time but keeps the original stopping ramp.
    if (this.rampTo !== 0) {
      this.setRamp(this.speedAt(now), 0, now, DECELERATION_SECONDS);
    }
    this.resumeAt = this.interacting ? Infinity : now + IDLE_SECONDS;
  }

  setInteracting(active: boolean, now: number): void {
    if (this.interacting === active) return;
    this.interacting = active;
    this.activity(now);
  }

  setPaused(paused: boolean, now: number): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.time = now;
    this.pendingAngle = 0;
    this.setRamp(0, 0, now, 0);
    this.resumeAt = !paused && !this.interacting ? now + IDLE_SECONDS : Infinity;
  }

  private advance(now: number): number {
    let angle = 0;
    if (!this.paused) {
      if (this.resumeAt <= now) {
        angle = this.integrate(this.time, this.resumeAt);
        this.setRamp(0, ROTATION_SPEED, this.resumeAt, ACCELERATION_SECONDS);
        this.time = this.resumeAt;
        this.resumeAt = Infinity;
      }
      angle += this.integrate(this.time, now);
    }
    this.time = now;
    return angle;
  }

  private setRamp(from: number, to: number, start: number, duration: number): void {
    this.rampFrom = from;
    this.rampTo = to;
    this.rampStart = start;
    this.rampDuration = duration;
  }

  private speedAt(now: number): number {
    if (this.rampDuration === 0) return this.rampTo;
    const fraction = Math.max(0, Math.min(1, (now - this.rampStart) / this.rampDuration));
    return this.rampFrom + (this.rampTo - this.rampFrom) * fraction;
  }

  private integrate(from: number, to: number): number {
    if (to <= from) return 0;
    const rampEnd = Math.max(from, Math.min(to, this.rampStart + this.rampDuration));
    // The trapezoid under a linear speed ramp is exact at every frame cadence.
    const rampAngle = ((this.speedAt(from) + this.speedAt(rampEnd)) / 2) * (rampEnd - from);
    return rampAngle + this.rampTo * (to - rampEnd);
  }
}
