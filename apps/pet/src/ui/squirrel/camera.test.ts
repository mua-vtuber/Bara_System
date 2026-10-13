import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AnimationState, AnimationStateData, Physics, Skeleton, Vector2, type SkeletonData } from "@esotericsoftware/spine-webgl";
import { boundsCenter, CameraLayoutError, fitCamera, flightStartPoint, presentCamera, type CameraFit, type CameraView, type SpinePoint, type SpineRect } from "./camera.ts";
import { SQUIRREL_MOTION as config } from "./motion-config.ts";
import { bodyAnimations, startupSteps } from "./motion-schedule.ts";
import { animationDurations } from "./motion-validate.ts";
import { loadRealSkeletonData } from "./test-utils/real-skeleton.ts";

// The fixed camera (design sections 3.3 and 7.3), checked with pure numbers and with the real export played through
// the real Spine classes.
const data = await loadRealSkeletonData();
const durations = animationDurations(data);
const content = config.view.contentBounds;
/** The bottom clearance, read from the same CSS pixel token that the screen uses to place the character. */
const BAND_PX = cssPixelToken(join(import.meta.dir, "..", "style.css"), "--pet-floor-inset");
/** `view.floorY` is the measured sole height rounded to 0.1 unit, so the real sole can sit up to half of that lower. */
const FLOOR_ROUNDING = 0.05;
/** How the measurement of section 3.3 played the animations: 60 frames a second, a looping animation three times,
 * one played once for its length plus half a second. */
const FRAME_SECONDS = 1 / 60;
const LOOP_ROUNDS = 3;
const ONCE_TAIL_SECONDS = 0.5;
/** The margin section 3.3 added on every side of the measured range, and how far this playback may stay inside the
 * measured extremes (the measurement also played `jump>glide>land`, which reached 1.6 units further right). */
const CONTENT_MARGIN = 16;
const MEASURE_SLACK = 2;

interface Play { animation: string; loop: boolean; seconds: number }

/** The pixel value of a custom property the stylesheet defines exactly once. */
function cssPixelToken(path: string, name: string): number {
  const definitions = [...readFileSync(path, "utf8").matchAll(new RegExp(`${name}\\s*:\\s*([^;}]+)[;}]`, "g"))];
  if (definitions.length !== 1) throw new Error(`${path} defines ${name} ${definitions.length} times, not once`);
  const value = /^(\d+(?:\.\d+)?)px$/.exec(definitions[0]![1]!.trim());
  if (!value) throw new Error(`${name} is ${definitions[0]![1]}, not a pixel length`);
  return Number(value[1]);
}

/** The bounds of every frame of `plays`, played one after another on the body track from the setup pose. */
function playedBounds(skeletonData: SkeletonData, plays: readonly Play[], physics: Physics): SpineRect {
  const skeleton = new Skeleton(skeletonData);
  skeleton.setupPose();
  skeleton.updateWorldTransform(Physics.reset);
  const mixes = new AnimationStateData(skeletonData);
  mixes.defaultMix = config.mix.defaultSeconds;
  for (const pair of config.mix.pairs) mixes.setMix(pair.from, pair.to, pair.seconds);
  const state = new AnimationState(mixes);
  const offset = new Vector2();
  const size = new Vector2();
  const scratch: number[] = [];
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const play of plays) {
    state.setAnimation(config.tracks.body, play.animation, play.loop);
    for (let frame = Math.ceil(play.seconds / FRAME_SECONDS); frame > 0; frame--) {
      state.update(FRAME_SECONDS);
      state.apply(skeleton);
      skeleton.update(FRAME_SECONDS);
      skeleton.updateWorldTransform(physics);
      skeleton.getBounds(offset, size, scratch);
      bounds.minX = Math.min(bounds.minX, offset.x);
      bounds.minY = Math.min(bounds.minY, offset.y);
      bounds.maxX = Math.max(bounds.maxX, offset.x + size.x);
      bounds.maxY = Math.max(bounds.maxY, offset.y + size.y);
    }
  }
  return bounds;
}

function looped(animation: string): Play {
  return { animation, loop: true, seconds: durations[animation]! * LOOP_ROUNDS };
}
function once(animation: string): Play {
  return { animation, loop: false, seconds: durations[animation]! };
}

function petWindow(): { width: number; height: number } {
  const tauri = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "src-tauri", "tauri.conf.json"), "utf8")) as {
    app: { windows: Array<{ label: string; width: number; height: number }> };
  };
  const pet = tauri.app.windows.find(entry => entry.label === "pet");
  if (!pet) throw new Error("tauri.conf.json has no pet window");
  return pet;
}

/** Where a Spine point lands on the canvas, in CSS pixels from the top left, for a camera `view` over `fit`. */
function onCanvas(fit: CameraFit, view: CameraView, point: SpinePoint): { x: number; y: number } {
  const unitPx = fit.unitPx / view.zoom;
  return { x: fit.cssWidth / 2 + (point.x - view.x) * unitPx, y: fit.cssHeight / 2 - (point.y - view.y) * unitPx };
}

test("the 150x165 window with a 30px band gives the numbers of section 7.3", () => {
  const fit = fitCamera({ cssWidth: 150, cssHeight: 165, bandPx: 30 }, content, config.view.floorY);
  expect(fit.unitPx).toBeCloseTo(135 / (674.2 + 12.7), 10);
  expect(fit.unitPx).toBeCloseTo(0.19654, 5);
  expect(fit.minX).toBeCloseTo(-415.9, 1);
  expect(fit.maxX).toBeCloseTo(347.4, 1);
  expect(fit.minY).toBeCloseTo(-165.3, 1);
  expect(fit.maxY).toBeCloseTo(674.2, 1);
  // The same camera as before the full-height term was dropped: that term never decided this layout.
  const width = content.maxX - content.minX;
  const aboveFloor = content.maxY - config.view.floorY;
  const height = content.maxY - content.minY;
  expect(fit.unitPx).toBe(Math.min(150 / width, 135 / aboveFloor, 165 / height));
});

test("the scale is set by the width or by the height above the band, whichever is tighter", () => {
  const width = content.maxX - content.minX;
  const aboveFloor = content.maxY - config.view.floorY;
  expect(fitCamera({ cssWidth: 60, cssHeight: 165, bandPx: 30 }, content, config.view.floorY).unitPx).toBeCloseTo(60 / width, 12);
  expect(fitCamera({ cssWidth: 300, cssHeight: 165, bandPx: 30 }, content, config.view.floorY).unitPx).toBeCloseTo(135 / aboveFloor, 12);
});

test("every layout the camera accepts shows the whole content range, and every other layout is refused", () => {
  const belowFloor = config.view.floorY - content.minY;
  const EDGE = 1e-9; // floating-point rounding where an edge of the range sits exactly on an edge of the canvas
  let accepted = 0;
  let refused = 0;
  for (const cssWidth of [60, 100, 140, 150, 200, 300]) {
    for (const cssHeight of [100, 133, 165, 200, 300]) {
      for (const bandPx of [0, 5, 10, 18, 19, 25, 30, 45, 60]) {
        const layout = { cssWidth, cssHeight, bandPx };
        const scale = Math.min(cssWidth / (content.maxX - content.minX), (cssHeight - bandPx) / (content.maxY - config.view.floorY));
        let fit: CameraFit;
        try { fit = fitCamera(layout, content, config.view.floorY); } catch (error) {
          // Refused only when the part below the soles would not fit in the band.
          expect(error).toBeInstanceOf(RangeError);
          expect({ layout, cut: belowFloor * scale > bandPx }).toEqual({ layout, cut: true });
          refused++;
          continue;
        }
        accepted++;
        expect({ layout, holds: fit.minX <= content.minX + EDGE && fit.maxX >= content.maxX - EDGE && fit.minY <= content.minY + EDGE && fit.maxY >= content.maxY - EDGE })
          .toEqual({ layout, holds: true });
        // The soles sit on the top of the band, the range is centred across, and the canvas aspect is kept.
        expect((config.view.floorY - fit.minY) * fit.unitPx).toBeCloseTo(bandPx, 9);
        expect((fit.minX + fit.maxX) / 2).toBeCloseTo((content.minX + content.maxX) / 2, 9);
        expect((fit.maxX - fit.minX) * fit.unitPx).toBeCloseTo(cssWidth, 9);
        expect((fit.maxY - fit.minY) * fit.unitPx).toBeCloseTo(cssHeight, 9);
      }
    }
  }
  expect(accepted).toBeGreaterThan(0);
  expect(refused).toBeGreaterThan(0);
});

test("a band too low for the part below the soles is refused with the numbers, never cropped: band 0 and layout A", () => {
  expect(() => fitCamera({ cssWidth: 150, cssHeight: 165, bandPx: 0 }, content, config.view.floorY)).toThrow(/band is 0px on a 150x165 canvas/);
  expect(() => fitCamera({ cssWidth: 140, cssHeight: 133, bandPx: 0 }, content, config.view.floorY)).toThrow(RangeError);
  // On the 150x165 window the band must be about 18.7px or more.
  expect(() => fitCamera({ cssWidth: 150, cssHeight: 165, bandPx: 18 }, content, config.view.floorY)).toThrow(RangeError);
  expect(fitCamera({ cssWidth: 150, cssHeight: 165, bandPx: 19 }, content, config.view.floorY).minY).toBeLessThanOrEqual(content.minY);
});

test("a band too low is refused with the height the part below the soles needs and the band's height", () => {
  for (const bandPx of [0, 10, 18]) {
    let refusal: unknown;
    try { fitCamera({ cssWidth: 150, cssHeight: 165, bandPx }, content, config.view.floorY); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(CameraLayoutError);
    const unitPx = Math.min(150 / (content.maxX - content.minX), (165 - bandPx) / (content.maxY - config.view.floorY));
    expect((refusal as CameraLayoutError).neededPx).toBeCloseTo((config.view.floorY - content.minY) * unitPx, 9);
    expect((refusal as CameraLayoutError).availablePx).toBe(bandPx);
  }
});

test("a canvas that cannot hold the band, or a range that does not hold the floor, is refused", () => {
  expect(() => fitCamera({ cssWidth: 0, cssHeight: 165, bandPx: 30 }, content, config.view.floorY)).toThrow(RangeError);
  expect(() => fitCamera({ cssWidth: 150, cssHeight: 30, bandPx: 30 }, content, config.view.floorY)).toThrow(RangeError);
  expect(() => fitCamera({ cssWidth: 150, cssHeight: 165, bandPx: 30 }, content, content.maxY)).toThrow(RangeError);
});

test("every body animation, and the startup and show sequences, stay inside contentBounds with physics updating or posed", () => {
  const flight = config.startup.flight;
  const onceSteps = new Set([...config.startup.after, ...config.show.steps]);
  const alone = [...bodyAnimations(config)].map(animation => onceSteps.has(animation)
    ? { animation, loop: false, seconds: durations[animation]! + ONCE_TAIL_SECONDS } : looped(animation));
  const sequences: Play[][] = [
    [{ animation: flight.animation, loop: true, seconds: flight.durationMs / 1_000 }, ...config.startup.after.map(once), looped(config.states.idle.animation)],
    [...config.show.steps.map(once), looped(config.states.idle.animation)],
    [looped(config.states.idle.animation), looped(config.states.sleep.animation)],
  ];
  expect(startupSteps(config)[0]).toBe(flight.animation);
  const union = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const physics of [Physics.update, Physics.pose]) {
    for (const plays of [...alone.map(play => [play]), ...sequences]) {
      const bounds = playedBounds(data, plays, physics);
      const label = `${plays.map(play => play.animation).join(">")} (${Physics[physics]})`;
      expect({ label, inside: bounds.minX >= content.minX && bounds.maxX <= content.maxX && bounds.minY >= content.minY && bounds.maxY <= content.maxY })
        .toEqual({ label, inside: true });
      union.minX = Math.min(union.minX, bounds.minX);
      union.maxX = Math.max(union.maxX, bounds.maxX);
      union.minY = Math.min(union.minY, bounds.minY);
      union.maxY = Math.max(union.maxY, bounds.maxY);
    }
  }
  // The plays really reach out to the measured range: every edge of contentBounds is the measured extreme plus the
  // margin of section 3.3, so the check above is not passing on a pose that never moved.
  expect(content.minX + CONTENT_MARGIN + MEASURE_SLACK).toBeGreaterThanOrEqual(union.minX);
  expect(content.maxX - CONTENT_MARGIN - MEASURE_SLACK).toBeLessThanOrEqual(union.maxX);
  expect(content.minY + CONTENT_MARGIN + MEASURE_SLACK).toBeGreaterThanOrEqual(union.minY);
  expect(content.maxY - CONTENT_MARGIN - MEASURE_SLACK).toBeLessThanOrEqual(union.maxY);
});

test("the camera fitted to the real pet window holds the whole content range, and idle stands on the band", () => {
  const petSize = petWindow();
  const fit = fitCamera({ cssWidth: petSize.width, cssHeight: petSize.height, bandPx: BAND_PX }, content, config.view.floorY);
  expect(fit.minX).toBeLessThanOrEqual(content.minX);
  expect(fit.maxX).toBeGreaterThanOrEqual(content.maxX);
  expect(fit.minY).toBeLessThanOrEqual(content.minY);
  expect(fit.maxY).toBeGreaterThanOrEqual(content.maxY);
  const idle = playedBounds(data, [looped(config.states.idle.animation)], Physics.update);
  expect(idle.minY).toBeGreaterThanOrEqual(config.view.floorY - FLOOR_ROUNDING);
  expect((idle.minY - fit.minY) * fit.unitPx).toBeGreaterThanOrEqual(BAND_PX - FLOOR_ROUNDING * fit.unitPx);
});

test("the startup camera equals the fixed camera at scale 1 and lift 0, and puts the anchor on the start point at lift 1", () => {
  const petSize = petWindow();
  const fit = fitCamera({ cssWidth: petSize.width, cssHeight: petSize.height, bandPx: BAND_PX }, content, config.view.floorY);
  const setup = new Skeleton(data);
  setup.setupPose();
  setup.updateWorldTransform(Physics.reset);
  const anchor = boundsCenter(setup.getBoundsRect());
  expect(anchor.x).toBeCloseTo(-22.6, 1);
  expect(anchor.y).toBeCloseTo(232.0, 1);
  const start = flightStartPoint(fit, config.startup.flight.startTopPx);
  expect(start).toEqual({ x: petSize.width / 2, y: config.startup.flight.startTopPx });
  const view = { x: Number.NaN, y: Number.NaN, zoom: Number.NaN };

  presentCamera(fit, anchor, { scale: 1, lift: 0 }, start, view);
  expect(view.x).toBeCloseTo((fit.minX + fit.maxX) / 2, 9);
  expect(view.y).toBeCloseTo((fit.minY + fit.maxY) / 2, 9);
  expect(view.zoom).toBe(1);
  const home = onCanvas(fit, view, anchor);

  const startScale = config.startup.flight.startScale;
  presentCamera(fit, anchor, { scale: startScale, lift: 1 }, start, view);
  expect(view.zoom).toBeCloseTo(1 / startScale, 12);
  const atStart = onCanvas(fit, view, anchor);
  expect(atStart.x).toBeCloseTo(start.x, 9);
  expect(atStart.y).toBeCloseTo(start.y, 9);

  presentCamera(fit, anchor, { scale: 0.5, lift: 0.5 }, start, view);
  const halfway = onCanvas(fit, view, anchor);
  expect(halfway.x).toBeCloseTo((home.x + start.x) / 2, 9);
  expect(halfway.y).toBeCloseTo((home.y + start.y) / 2, 9);
  expect(() => presentCamera(fit, anchor, { scale: 0, lift: 1 }, start, view)).toThrow(RangeError);
});
