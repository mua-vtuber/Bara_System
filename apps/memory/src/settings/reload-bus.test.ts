/**
 * ReloadBus — 단위 검증 (Phase 5.5 / S9).
 *
 * subscribe + emit / unsubscribe / 한 listener throw 가 다른 listener 호출을
 * 막지 않는 정신 검증.
 */

import { afterEach, describe, expect, test, beforeEach } from "bun:test";
import { ReloadBus } from "./reload-bus";

describe("ReloadBus — 기본 동작", () => {
  let consoleErrors: string[];
  let originalError: typeof console.error;

  beforeEach(() => {
    consoleErrors = [];
    originalError = console.error;
    console.error = ((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    }) as typeof console.error;
  });

  afterEach(() => {
    console.error = originalError;
  });

  test("subscribe + emit = listener 호출", () => {
    const bus = new ReloadBus();
    let calls = 0;
    bus.subscribe(() => {
      calls += 1;
    });
    bus.emit();
    expect(calls).toBe(1);
    bus.emit();
    expect(calls).toBe(2);
  });

  test("unsubscribe 후 emit = listener 미호출", () => {
    const bus = new ReloadBus();
    let calls = 0;
    const off = bus.subscribe(() => {
      calls += 1;
    });
    bus.emit();
    expect(calls).toBe(1);
    off();
    bus.emit();
    expect(calls).toBe(1);
    expect(bus.size).toBe(0);
  });

  test("한 listener throw = 다른 listener 호출 영향 X + console.error surface", () => {
    const bus = new ReloadBus();
    const calls: string[] = [];
    bus.subscribe(() => {
      calls.push("first");
      throw new Error("boom");
    });
    bus.subscribe(() => {
      calls.push("second");
    });
    bus.emit();
    expect(calls).toEqual(["first", "second"]);
    expect(consoleErrors.some((msg) => msg.includes("boom"))).toBe(true);
  });

  test("같은 listener 중복 subscribe = Set 정합 = 한 번만 호출", () => {
    const bus = new ReloadBus();
    let calls = 0;
    const fn = () => {
      calls += 1;
    };
    bus.subscribe(fn);
    bus.subscribe(fn);
    bus.emit();
    expect(calls).toBe(1);
  });
});
