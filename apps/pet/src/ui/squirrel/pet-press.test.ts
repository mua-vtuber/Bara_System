import { expect, test } from "bun:test";
import { DRAG_THRESHOLD_PX, PetPress } from "./pet-press.ts";

test("a press without moving is a click that opens the input", () => {
  const press = new PetPress();
  press.down(100, 100);
  expect(press.move(101, 101, 1)).toBe(false);
  press.up();
  expect(press.click()).toBe(true);
});

test("moving past the threshold with the button held starts one drag and no click", () => {
  const press = new PetPress();
  press.down(100, 100);
  expect(press.move(100 + DRAG_THRESHOLD_PX, 100, 1)).toBe(true);
  expect(press.move(100 + DRAG_THRESHOLD_PX * 3, 100, 1)).toBe(false);
  press.up();
  expect(press.click()).toBe(false);
});

test("moving with no button held never drags", () => {
  const press = new PetPress();
  press.down(100, 100);
  expect(press.move(200, 200, 0)).toBe(false);
});

test("a press on the update button ends a press the pet button still held, so moving over the pet does not drag", () => {
  const press = new PetPress();
  press.down(100, 100); // released outside the pet button: its pointerup never came
  press.cancel();        // the update button's pointerdown
  expect(press.move(200, 200, 1)).toBe(false);
});
