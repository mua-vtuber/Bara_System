import { describe, expect, test } from "bun:test";
import { buildRetrieveTimings, StageTimer } from "./stage-timer.ts";

/** 값 배열을 차례로 돌려주는 주입 시계. */
function clockOf(values: number[]): () => number {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error("clock exhausted");
    return values[i++]!;
  };
}

describe("StageTimer", () => {
  test("lap 은 직전 지점부터의 ms, elapsed 는 시작부터의 ms", () => {
    const timer = new StageTimer(clockOf([100, 130, 135, 200]));
    expect(timer.lap("a")).toBe(30);
    expect(timer.lap("b")).toBe(5);
    expect(timer.elapsed()).toBe(100);
    expect([...timer.laps()]).toEqual([
      ["a", 30],
      ["b", 5],
    ]);
  });

  test("같은 이름을 두 번 lap 하면 오류", () => {
    const timer = new StageTimer(clockOf([0, 1, 2]));
    timer.lap("a");
    expect(() => timer.lap("a")).toThrow("'a'");
  });

  test("buildRetrieveTimings: 기록 안 된 단계는 null, totalMs 는 숫자", () => {
    const timer = new StageTimer(clockOf([0, 4, 10]));
    timer.lap("embedMs");
    const t = buildRetrieveTimings(timer, false);
    expect(t.embedMs).toBe(4);
    expect(t.embedCacheHit).toBe(false);
    expect(t.scoreMs).toBeNull();
    expect(t.totalMs).toBe(10);
  });
});
