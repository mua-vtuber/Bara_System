import { describe, expect, test } from "bun:test";
import { createGracefulExit, SHUTDOWN_FAILED_EXIT_CODE } from "./graceful-exit.ts";
import { RESTART_EXIT_CODE } from "./restart-policy.ts";

function harness(stop: () => Promise<void>) {
  const exits: number[] = [];
  const logs: string[] = [];
  const errors: Array<{ message: string; cause: unknown }> = [];
  const run = createGracefulExit({
    stop,
    exit: (code) => { exits.push(code); },
    log: (message) => { logs.push(message); },
    error: (message, cause) => { errors.push({ message, cause }); },
  });
  return { run, exits, logs, errors };
}

describe("createGracefulExit", () => {
  test("종료 절차를 마친 뒤 받은 종료 코드로 끝낸다 (재시작 = 75)", async () => {
    const order: string[] = [];
    const h = harness(async () => { order.push("stop"); });
    await h.run("dashboard restart request", RESTART_EXIT_CODE);
    expect(RESTART_EXIT_CODE).toBe(75);
    expect(h.exits).toEqual([75]);
    expect(order).toEqual(["stop"]);
    expect(h.logs[0]).toContain("dashboard restart request");
  });

  test("SIGTERM 은 종료 코드 0", async () => {
    const h = harness(async () => {});
    await h.run("SIGTERM", 0);
    expect(h.exits).toEqual([0]);
  });

  test("종료 절차가 끝나기 전에는 exit 하지 않는다", async () => {
    let release!: () => void;
    const h = harness(() => new Promise<void>((resolve) => { release = resolve; }));
    const pending = h.run("SIGTERM", 0);
    await Promise.resolve();
    expect(h.exits).toEqual([]);
    release();
    await pending;
    expect(h.exits).toEqual([0]);
  });

  test("두 번째 호출은 무시한다", async () => {
    let stops = 0;
    const h = harness(async () => { stops += 1; });
    await h.run("SIGTERM", 0);
    await h.run("dashboard restart request", RESTART_EXIT_CODE);
    expect(stops).toBe(1);
    expect(h.exits).toEqual([0]);
  });

  test("종료 절차가 실패하면 원인을 남기고 실패 코드로 끝낸다", async () => {
    const boom = new Error("scheduler stuck");
    const h = harness(async () => { throw boom; });
    await h.run("dashboard restart request", RESTART_EXIT_CODE);
    expect(h.exits).toEqual([SHUTDOWN_FAILED_EXIT_CODE]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]!.cause).toBe(boom);
  });
});
