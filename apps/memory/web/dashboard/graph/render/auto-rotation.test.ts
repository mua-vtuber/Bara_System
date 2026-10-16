import { afterEach, describe, expect, test } from "bun:test";
import * as THREE from "three";
import { registerHappyDom } from "../../test-happy-dom.ts";
import { GraphAutoRotation } from "./auto-rotation.ts";

registerHappyDom();
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function setup() {
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const target = new THREE.Vector3(4, 2, -3);
  const camera = new THREE.PerspectiveCamera();
  camera.position.copy(target).add(new THREE.Vector3(0, 3, 20));
  let time = 0;
  const rotation = new GraphAutoRotation(camera, target, canvas, () => time);
  cleanups.push(() => { rotation.dispose(); canvas.remove(); });
  const at = (next: number, blocked = false) => { time = next; rotation.update(blocked); };
  const pointer = (type: string, button = 0, pointerId = 1, surface: EventTarget = canvas) => {
    surface.dispatchEvent(new PointerEvent(type, { button, pointerId, bubbles: true }));
  };
  return { canvas, target, camera, rotation, at, pointer };
}

describe("graph automatic camera rotation", () => {
  test("orbits the current target without moving the target, changing distance or tilt", () => {
    const s = setup();
    s.at(1);
    expect(s.camera.position.x).toBeLessThan(4);
    expect(s.camera.position.distanceTo(s.target)).toBeCloseTo(Math.sqrt(409), 10);
    expect(s.camera.position.y).toBe(5);
    expect(s.target.toArray()).toEqual([4, 2, -3]);
    s.target.add(new THREE.Vector3(3, 0, 1));
    const distance = s.camera.position.distanceTo(s.target);
    s.at(2);
    expect(s.camera.position.distanceTo(s.target)).toBeCloseTo(distance, 10);
  });

  for (const button of [0, 1, 2]) {
    test(`button ${button} brakes in 0.25s and waits until release plus 8s`, () => {
      const s = setup();
      s.at(1);
      s.pointer("pointerdown", button);
      const before = s.camera.position.clone();
      s.at(1.125);
      expect(s.camera.position.distanceTo(before)).toBeGreaterThan(0);
      s.at(1.25);
      const stopped = s.camera.position.clone();
      s.at(15);
      expect(s.camera.position.distanceTo(stopped)).toBeLessThan(1e-10);
      s.pointer("pointerup", button, 1, window);
      s.at(23);
      expect(s.camera.position.distanceTo(stopped)).toBeLessThan(1e-10);
      s.at(23.5);
      expect(s.camera.position.distanceTo(stopped)).toBeGreaterThan(0);
    });
  }

  test("wheel events extend the wait without extending the brake; hover does not pause", () => {
    const s = setup();
    s.at(1);
    const beforeHover = s.camera.position.clone();
    s.pointer("pointermove");
    s.at(2);
    expect(s.camera.position.distanceTo(beforeHover)).toBeGreaterThan(0);
    s.canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 20 }));
    s.at(2.2);
    s.canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 20 }));
    s.at(2.25);
    const stopped = s.camera.position.clone();
    s.at(10.2);
    expect(s.camera.position.distanceTo(stopped)).toBeLessThan(1e-10);
    s.at(10.7);
    expect(s.camera.position.distanceTo(stopped)).toBeGreaterThan(0);
  });

  test("details stay still indefinitely and closing starts a fresh wait", () => {
    const s = setup();
    s.at(1);
    s.rotation.setDetailOpen(true);
    const stopped = s.camera.position.clone();
    s.at(40);
    expect(s.camera.position.distanceTo(stopped)).toBeLessThan(1e-10);
    s.rotation.setDetailOpen(true);
    s.at(50);
    expect(s.camera.position.distanceTo(stopped)).toBeLessThan(1e-10);
    s.rotation.setDetailOpen(false);
    s.at(58);
    expect(s.camera.position.distanceTo(stopped)).toBeLessThan(1e-10);
    s.at(58.5);
    expect(s.camera.position.distanceTo(stopped)).toBeGreaterThan(0);
  });

  test("camera transition or reduced motion blocks rotation even when details close", () => {
    const s = setup();
    s.at(1, true);
    s.rotation.setDetailOpen(true);
    s.rotation.setDetailOpen(false);
    const stopped = s.camera.position.clone();
    s.at(20, true);
    expect(s.camera.position.distanceTo(stopped)).toBeLessThan(1e-10);
    s.at(21, false);
    s.at(29, false);
    expect(s.camera.position.distanceTo(stopped)).toBeLessThan(1e-10);
    s.at(29.5, false);
    expect(s.camera.position.distanceTo(stopped)).toBeGreaterThan(0);
  });

  test("canceled pointers release the hold and disposal detaches input listeners", () => {
    const s = setup();
    s.pointer("pointerdown");
    s.at(1);
    s.pointer("pointercancel", 0, 1, window);
    const stopped = s.camera.position.clone();
    s.at(10);
    expect(s.camera.position.distanceTo(stopped)).toBeGreaterThan(0);
    s.rotation.dispose();
    s.pointer("pointerdown");
    const disposed = s.camera.position.clone();
    s.at(20);
    expect(s.camera.position.distanceTo(disposed)).toBeLessThan(1e-10);
  });

  for (const move of [false, true]) test(`a held button stays stopped across window focus changes (move=${move})`, () => {
    const s = setup();
    s.pointer("pointerdown");
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    if (move) s.canvas.dispatchEvent(new PointerEvent("pointermove", {
      pointerId: 1, pointerType: "mouse", buttons: 1, bubbles: true,
    }));
    const held = s.camera.position.clone();
    s.at(15);
    expect(s.camera.position.distanceTo(held)).toBeLessThan(1e-10);
    s.pointer("pointerup", 0, 1, window);
    s.at(23);
    expect(s.camera.position.distanceTo(held)).toBeLessThan(1e-10);
    s.at(23.5);
    expect(s.camera.position.distanceTo(held)).toBeGreaterThan(0);
  });

  test("a release outside the inactive window is reconciled on the next hover", () => {
    const s = setup();
    s.pointer("pointerdown");
    window.dispatchEvent(new Event("blur"));
    s.at(20);
    window.dispatchEvent(new Event("focus"));
    s.canvas.dispatchEvent(new PointerEvent("pointermove", {
      pointerId: 1, pointerType: "mouse", buttons: 0, bubbles: true,
    }));
    const stopped = s.camera.position.clone();
    s.at(28);
    expect(s.camera.position.distanceTo(stopped)).toBeLessThan(1e-10);
    s.at(28.5);
    expect(s.camera.position.distanceTo(stopped)).toBeGreaterThan(0);
  });
});
