import { describe, expect, it } from "bun:test";
import { AutoRotationMotion } from "./auto-rotation-motion.ts";

const speed = (2 * Math.PI) / 240;

describe("AutoRotationMotion", () => {
  it("starts at one full turn per 240 seconds", () => {
    const motion = new AutoRotationMotion(10);
    expect(motion.step(10)).toBe(0);
    expect(motion.step(70)).toBeCloseTo(Math.PI / 2, 12);
    expect(motion.step(250)).toBeCloseTo((3 * Math.PI) / 2, 12);
  });

  it("decelerates to zero in 0.25 seconds", () => {
    const motion = new AutoRotationMotion(0);
    motion.activity(0);
    expect(motion.step(0.125)).toBeCloseTo(speed * 0.09375, 12);
    expect(motion.step(0.25)).toBeCloseTo(speed * 0.03125, 12);
    expect(motion.step(8)).toBe(0);
  });

  it("repeated wheel events refresh the wait without extending deceleration", () => {
    const motion = new AutoRotationMotion(0);
    motion.activity(0);
    motion.activity(0.05);
    motion.activity(0.1);
    motion.activity(0.2);
    expect(motion.step(0.25)).toBeCloseTo(speed * 0.125, 12);
    expect(motion.step(8.2)).toBeCloseTo(0, 12);
    expect(motion.step(8.7)).toBeCloseTo(speed * 0.125, 12);
  });

  it("waits until a held interaction ends, then waits 8 seconds and accelerates for 1 second", () => {
    const motion = new AutoRotationMotion(0);
    motion.setInteracting(true, 0);
    expect(motion.step(0.25)).toBeCloseTo(speed * 0.125, 12);
    expect(motion.step(20)).toBe(0);
    motion.setInteracting(false, 20);
    expect(motion.step(28)).toBe(0);
    expect(motion.step(28.5)).toBeCloseTo(speed * 0.125, 12);
    expect(motion.step(29)).toBeCloseTo(speed * 0.375, 12);
    expect(motion.step(30)).toBeCloseTo(speed, 12);
  });

  it("preserves rotation before an input event between frames", () => {
    const motion = new AutoRotationMotion(0);
    motion.activity(1);
    expect(motion.step(1.25)).toBeCloseTo(speed * 1.125, 12);
  });

  it("stops immediately while paused and starts a fresh wait when unpaused", () => {
    const motion = new AutoRotationMotion(0);
    motion.activity(0.1);
    motion.setPaused(true, 0.2);
    expect(motion.step(100)).toBe(0);
    motion.activity(101);
    expect(motion.step(200)).toBe(0);
    motion.setPaused(false, 200);
    expect(motion.step(208)).toBe(0);
    expect(motion.step(209)).toBeCloseTo(speed * 0.5, 12);
  });

  it("repeated unpause calls do not postpone resuming", () => {
    const motion = new AutoRotationMotion(0);
    motion.setPaused(false, 1);
    expect(motion.step(1)).toBeCloseTo(speed, 12);
    motion.setPaused(true, 1);
    motion.setPaused(false, 2);
    motion.setPaused(false, 6);
    motion.setPaused(false, 9);
    expect(motion.step(10)).toBe(0);
    expect(motion.step(11)).toBeCloseTo(speed * 0.5, 12);
  });

  it("repeated interaction state calls do not restart deceleration or idle wait", () => {
    const motion = new AutoRotationMotion(0);
    motion.setInteracting(true, 0);
    motion.setInteracting(true, 0.1);
    expect(motion.step(0.25)).toBeCloseTo(speed * 0.125, 12);
    motion.setInteracting(false, 1);
    motion.setInteracting(false, 5);
    expect(motion.step(9)).toBe(0);
    expect(motion.step(10)).toBeCloseTo(speed * 0.5, 12);
  });

  it("decelerates from the current speed when input interrupts acceleration", () => {
    const motion = new AutoRotationMotion(0);
    motion.activity(0);
    expect(motion.step(8.5)).toBeCloseTo(speed * 0.25, 12);
    motion.activity(8.5);
    expect(motion.step(8.625)).toBeCloseTo(speed * 0.046875, 12);
    expect(motion.step(8.75)).toBeCloseTo(speed * 0.015625, 12);
    expect(motion.step(16.5)).toBe(0);
    expect(motion.step(17)).toBeCloseTo(speed * 0.125, 12);
    expect(motion.step(17.5)).toBeCloseTo(speed * 0.375, 12);
  });

  it("keeps held input stopped when a pause ends", () => {
    const motion = new AutoRotationMotion(0);
    motion.setPaused(true, 0);
    motion.setInteracting(true, 1);
    motion.setPaused(false, 2);
    expect(motion.step(20)).toBe(0);
    motion.setInteracting(false, 20);
    expect(motion.step(28)).toBe(0);
    expect(motion.step(29)).toBeCloseTo(speed * 0.5, 12);
  });

  it("integrates the same angle at different frame cadences", () => {
    const sample = (frames: number): number => {
      const motion = new AutoRotationMotion(0);
      motion.activity(0);
      let angle = 0;
      for (let frame = 1; frame <= frames; frame++) {
        angle += motion.step((12 * frame) / frames);
      }
      return angle;
    };
    // 0.125 seconds at full-speed equivalent while stopping, 0.5 while
    // accelerating, then 3 seconds at full speed after the 8-second wait.
    for (const frames of [1, 24, 360, 1440]) {
      expect(sample(frames)).toBeCloseTo(speed * 3.625, 12);
    }
  });
});
