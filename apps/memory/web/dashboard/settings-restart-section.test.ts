import "../../test-setup-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderRestartSection, type RestartInfo, type RestartSectionDeps } from "./settings-restart-section";
import { RESTART_LABELS } from "./settings-restart-labels";
import { RESTART_GIVE_UP_MS } from "./settings-restart-state";

const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => document.body.replaceChildren());
afterEach(() => document.body.replaceChildren());

interface Harness {
  deps: Partial<RestartSectionDeps>;
  confirms: string[];
  posts: number;
  versionCalls: number;
  clock: { now: number };
}

/** 서버 흉내가 아니라 호출을 기록하는 데이터 주입이다. infos 는 fetchInfo 가 차례로 돌려주거나 던질 값. */
function harness(infos: Array<RestartInfo | Error>, options: { confirm?: boolean; post?: Error; version?: string | Error } = {}): Harness {
  const h: Harness = { deps: {}, confirms: [], posts: 0, versionCalls: 0, clock: { now: 0 } };
  let index = 0;
  h.deps = {
    fetchInfo: async () => {
      const next = infos[Math.min(index, infos.length - 1)]!;
      index += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    postRestart: async () => {
      h.posts += 1;
      if (options.post) throw options.post;
      return { bootId: "old" };
    },
    fetchVersion: async () => {
      h.versionCalls += 1;
      const version = options.version ?? "0.1.3";
      if (version instanceof Error) throw version;
      return version;
    },
    confirm: (message) => { h.confirms.push(message); return options.confirm ?? true; },
    now: () => h.clock.now,
    pollIntervalMs: 5,
  };
  return h;
}

const mount = (h: Harness) => {
  const section = renderRestartSection(h.deps);
  document.body.append(section);
  return {
    section,
    button: section.querySelector(".server-restart-button") as HTMLButtonElement,
    status: section.querySelector(".server-restart-status") as HTMLElement,
  };
};

test("unsupported server: button disabled and the reason is shown", async () => {
  const h = harness([{ supported: false, reason: "systemd 없음", busy: false, busyReason: null, bootId: "old" }]);
  const { button, status } = mount(h);
  await settle();
  expect(button.disabled).toBe(true);
  expect(status.textContent).toBe("systemd 없음");
  button.click();
  expect(h.confirms).toEqual([]);
  expect(h.posts).toBe(0);
});

test("a failed support check shows its cause and keeps the button disabled", async () => {
  const h = harness([new Error("HTTP 500")]);
  const { button, status } = mount(h);
  await settle();
  expect(button.disabled).toBe(true);
  expect(status.textContent).toBe(RESTART_LABELS.loadFailed("HTTP 500"));
  expect(status.classList.contains("error")).toBe(true);
});

test("declining the confirmation sends nothing", async () => {
  const h = harness([{ supported: true, reason: null, busy: false, busyReason: null, bootId: "old" }], { confirm: false });
  const { button } = mount(h);
  await settle();
  expect(button.disabled).toBe(false);
  button.click();
  await settle();
  expect(h.confirms).toEqual([RESTART_LABELS.confirm]);
  expect(h.posts).toBe(0);
  expect(button.disabled).toBe(false);
});

test("restart: waits through unreachable answers and finishes on a new bootId with the /health version", async () => {
  const h = harness([
    { supported: true, reason: null, busy: false, busyReason: null, bootId: "old" },
    { supported: true, reason: null, busy: false, busyReason: null, bootId: "old" },
    new Error("fetch failed"),
    new Error("fetch failed"),
    { supported: true, reason: null, busy: false, busyReason: null, bootId: "new" },
  ]);
  const { button, status } = mount(h);
  await settle();
  button.click();
  await settle(5);
  expect(status.textContent).toBe(RESTART_LABELS.restarting);
  expect(button.disabled).toBe(true);
  await settle(120);
  expect(h.posts).toBe(1);
  expect(h.versionCalls).toBe(1);
  expect(status.textContent).toBe(RESTART_LABELS.doneVersion("0.1.3"));
  expect(status.classList.contains("error")).toBe(false);
});

test("restart finishes even if the version lookup fails, and says so", async () => {
  const h = harness([
    { supported: true, reason: null, busy: false, busyReason: null, bootId: "old" },
    { supported: true, reason: null, busy: false, busyReason: null, bootId: "new" },
  ], { version: new Error("HTTP 502") });
  const { button, status } = mount(h);
  await settle();
  button.click();
  await settle(120);
  expect(status.textContent).toBe(RESTART_LABELS.doneVersionProblem("HTTP 502"));
});

test("gives up after the limit with the journalctl hint", async () => {
  const h = harness([
    { supported: true, reason: null, busy: false, busyReason: null, bootId: "old" },
    new Error("connection refused"),
  ]);
  const { button, status } = mount(h);
  await settle();
  button.click();
  await settle(5);
  h.clock.now = RESTART_GIVE_UP_MS + 1;
  await settle(60);
  expect(status.classList.contains("error")).toBe(true);
  expect(status.textContent).toContain("journalctl -u bara-pet-memory.service");
  expect(status.textContent).toContain("connection refused");
});

test("a refused restart request shows the cause and does not start waiting", async () => {
  const h = harness([{ supported: true, reason: null, busy: false, busyReason: null, bootId: "old" }], { post: new Error("HTTP 403") });
  const { button, status } = mount(h);
  await settle();
  button.click();
  await settle(60);
  expect(status.textContent).toBe(RESTART_LABELS.requestFailed("HTTP 403"));
  expect(h.versionCalls).toBe(0);
});

test("each poll request gets an abort signal so one hung request cannot stall the limit", async () => {
  const signals: Array<AbortSignal | undefined> = [];
  const h = harness([{ supported: true, reason: null, busy: false, busyReason: null, bootId: "old" }]);
  let calls = 0;
  const original = h.deps.fetchInfo!;
  h.deps.fetchInfo = async (signal) => {
    calls += 1;
    if (calls === 1) return original(signal);
    signals.push(signal);
    return { supported: true, reason: null, busy: false, busyReason: null, bootId: "new" };
  };
  const { button } = mount(h);
  await settle();
  button.click();
  await settle(60);
  expect(signals[0]).toBeInstanceOf(AbortSignal);
});
