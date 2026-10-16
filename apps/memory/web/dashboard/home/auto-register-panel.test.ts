import { afterEach, beforeEach, expect, test } from "bun:test";
import { registerHappyDom } from "../test-happy-dom.ts";
import { _resetTokenCacheForTest } from "../api-fetch.ts";
import { createAutoRegisterPanel } from "./auto-register-panel.ts";
import { ENTITY_REGISTER_STRINGS as S } from "./entity-register-strings.ts";
registerHappyDom();

const originalFetch = globalThis.fetch;
let routes: Record<string, (init?: RequestInit) => Response>;
const requests: Array<{ path: string; method: string; body: string | null }> = [];

beforeEach(() => {
  window.sessionStorage.setItem("bara.dashboard.token", "fixture");
  _resetTokenCacheForTest();
  requests.length = 0;
  routes = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.includes("/dashboard/sse-token")) return Response.json({ token: "fixture" });
    requests.push({ path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
    const key = Object.keys(routes).find((k) => path.includes(k));
    if (!key) return Response.json({ error: `no route ${path}` }, { status: 500 });
    return routes[key]!(init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  document.body.replaceChildren();
  window.sessionStorage.clear();
  _resetTokenCacheForTest();
});

const noWait = () => Promise.resolve();
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
const available = () => Response.json({ available: true, running: false, reasons: [] });
const emptyRecords = () => Response.json({ records: [], total: 0 });
const record = (over: Record<string, unknown> = {}) => ({
  id: 5, itemKind: "entity_created", targetType: "person", targetId: "psn_1", name: "민수", sourceNodeId: 1,
  memoContent: "민수가 11월 3일 결혼한다더라", date: null, runId: "run_1", createdAt: "2026-10-10 09:00:00", ...over,
});

async function mount(opts: Parameters<typeof createAutoRegisterPanel>[0] = { sleep: noWait }) {
  const panel = createAutoRegisterPanel(opts);
  document.body.append(panel.root);
  await panel.refresh();
  return panel;
}

test("the button is disabled with the reasons when cleanup cannot run", async () => {
  routes["/api/cleanup-runs/availability"] = () => Response.json({ available: false, running: false, reasons: ["정리 AI 모델이 설정되지 않음 (llm.cleanup.anthropicModel)"] });
  routes["/api/entity-register/records"] = emptyRecords;
  const panel = await mount();
  expect(panel.root.querySelector<HTMLButtonElement>("button.auto-register-run")!.disabled).toBe(true);
  expect(panel.root.textContent).toContain("llm.cleanup.anthropicModel");
  expect(panel.root.textContent).toContain(S.emptyRecent);
});

test("the list request omits limit so the server constant decides the size", async () => {
  routes["/api/cleanup-runs/availability"] = available;
  routes["/api/entity-register/records"] = emptyRecords;
  await mount();
  const listReq = requests.find((r) => r.path.includes("/api/entity-register/records"))!;
  expect(listReq.path).not.toContain("limit");
});

test("running shows progress and then per-stage results with failure reasons", async () => {
  let polls = 0;
  routes["/api/cleanup-runs/availability"] = available;
  routes["/api/entity-register/records"] = emptyRecords;
  routes["/api/cleanup-runs/run_1"] = () => {
    polls += 1;
    return polls < 2
      ? Response.json({ runId: "run_1", status: "running", aggregates: null })
      : Response.json({ runId: "run_1", status: "completed", aggregates: { stageAggregates: [
          { stage: "entityRegister", processed: 3, completed: 2, completedNoop: 0, failures: 1, terminal: 1, autoApplied: 4, proposed: 1, alreadyProcessed: 2, failureReasons: ["메모 9: 형식 오류 — 3번 실패해 처리 불가로 확정"] },
        ] } });
  };
  routes["/api/cleanup-runs"] = () => Response.json({ runId: "run_1" }, { status: 202 });
  const panel = await mount({ sleep: noWait, newKey: () => "key-1" });
  panel.root.querySelector<HTMLButtonElement>("button.auto-register-run")!.click();
  await tick();
  const post = requests.find((r) => r.method === "POST" && r.path.endsWith("/api/cleanup-runs"))!;
  expect(JSON.parse(post.body!)).toEqual({ idempotencyKey: "key-1" });
  expect(panel.root.textContent).toContain(S.finished("completed"));
  expect(panel.root.textContent).toContain(S.stageResult("entityRegister", 4, 1, 1, 2));
  expect(panel.root.textContent).toContain("이미 처리됨 2개");
  expect(panel.root.textContent).toContain("처리 불가로 확정");
});

test("a failed run shows its stopReason", async () => {
  const reason = "항목·일정 등록: 설정 결함으로 중단 — llm.cleanup.anthropicModel 비어 있음";
  routes["/api/cleanup-runs/availability"] = available;
  routes["/api/entity-register/records"] = emptyRecords;
  routes["/api/cleanup-runs/run_2"] = () => Response.json({ runId: "run_2", status: "failed", aggregates: { stageAggregates: [], stopReason: reason } });
  routes["/api/cleanup-runs"] = () => Response.json({ runId: "run_2" }, { status: 202 });
  const panel = await mount();
  panel.root.querySelector<HTMLButtonElement>("button.auto-register-run")!.click();
  await tick();
  expect(panel.root.textContent).toContain(S.finished("failed"));
  expect(panel.root.textContent).toContain(S.stopReason(reason));
});

test("a failed status poll shows pollFailed and stops polling", async () => {
  let polls = 0;
  routes["/api/cleanup-runs/availability"] = available;
  routes["/api/entity-register/records"] = emptyRecords;
  routes["/api/cleanup-runs/run_3"] = () => { polls += 1; return Response.json({ error: "db locked" }, { status: 500 }); };
  routes["/api/cleanup-runs"] = () => Response.json({ runId: "run_3" }, { status: 202 });
  const panel = await mount();
  panel.root.querySelector<HTMLButtonElement>("button.auto-register-run")!.click();
  await tick();
  expect(polls).toBe(1);
  expect(panel.root.textContent).toContain("진행 상태를 읽지 못했습니다");
  expect(panel.root.textContent).toContain("db locked");
  expect(panel.root.textContent).not.toContain("정리를 시작하지 못했습니다");
});

test("a failed start shows startFailed with the cause", async () => {
  routes["/api/cleanup-runs/availability"] = available;
  routes["/api/entity-register/records"] = emptyRecords;
  routes["/api/cleanup-runs"] = () => Response.json({ error: "이미 진행 중인 깊은 패스 사이클이 있다" }, { status: 409 });
  const panel = await mount();
  panel.root.querySelector<HTMLButtonElement>("button.auto-register-run")!.click();
  await tick();
  expect(panel.root.textContent).toContain("정리를 시작하지 못했습니다");
  expect(panel.root.textContent).toContain("이미 진행 중인 깊은 패스 사이클이 있다");
});

test("recent auto-registrations list the memo and revert removes the row with its result", async () => {
  routes["/api/cleanup-runs/availability"] = available;
  let reverted = false;
  routes["/api/entity-register/records/5/revert"] = () => {
    reverted = true;
    return Response.json({ reverted: 5, result: { recordId: 5, removedEdges: 1, deletedRow: null, keptRowReason: "다른 메모가 참조함", removedAlias: "민수형", trashedScheduleNodeId: null, clearedMemoDate: null } });
  };
  routes["/api/entity-register/records"] = () => Response.json(reverted ? { records: [], total: 0 } : { records: [record()], total: 1 });
  const panel = await mount();
  expect(panel.root.textContent).toContain("민수가 11월 3일 결혼한다더라");
  panel.root.querySelector<HTMLButtonElement>("button.auto-register-revert")!.click();
  await tick();
  expect(reverted).toBe(true);
  expect(panel.root.textContent).toContain(S.emptyRecent);
  expect(panel.root.textContent).toContain(S.revertRemovedAlias("민수형"));
  expect(panel.root.textContent).toContain(S.revertKeptRow("다른 메모가 참조함"));
});

test("a memo-date record reads '메모 날짜 · 1월 5일 (2027-01-05)' and its revert says which date was cleared", async () => {
  routes["/api/cleanup-runs/availability"] = available;
  let reverted = false;
  routes["/api/entity-register/records/7/revert"] = () => {
    reverted = true;
    return Response.json({ reverted: 7, result: {
      recordId: 7, removedEdges: 0, deletedRow: null, keptRowReason: null, removedAlias: null, trashedScheduleNodeId: null, clearedMemoDate: "2027-01-05",
    } });
  };
  const memoDateRecord = record({ id: 7, itemKind: "memo_date_filled", targetType: "memo", targetId: "1", name: "1월 5일", date: "2027-01-05", memoContent: "1월 5일까지 제출" });
  routes["/api/entity-register/records"] = () => Response.json(reverted ? { records: [], total: 0 } : { records: [memoDateRecord], total: 1 });
  const panel = await mount();
  expect(panel.root.textContent).toContain("메모 날짜 · 1월 5일 (2027-01-05)");
  panel.root.querySelector<HTMLButtonElement>("button.auto-register-revert")!.click();
  await tick();
  expect(panel.root.textContent).toContain("메모 날짜(2027-01-05)를 지웠습니다.");
});

test("a record whose memo was purged says there is no source memo", async () => {
  routes["/api/cleanup-runs/availability"] = available;
  routes["/api/entity-register/records"] = () => Response.json({ records: [record({ memoContent: null })], total: 1 });
  const panel = await mount();
  expect(panel.root.textContent).toContain(S.noMemo);
});

test("revert answered 409 is shown as already processed and the list reloads", async () => {
  routes["/api/cleanup-runs/availability"] = available;
  let gone = false;
  routes["/api/entity-register/records/5/revert"] = () => { gone = true; return Response.json({ error: "자동 등록 기록 5 은(는) 이미 되돌림" }, { status: 409 }); };
  routes["/api/entity-register/records"] = () => Response.json(gone ? { records: [], total: 0 } : { records: [record()], total: 1 });
  const panel = await mount();
  panel.root.querySelector<HTMLButtonElement>("button.auto-register-revert")!.click();
  await tick();
  expect(panel.root.textContent).toContain("이미 처리됨");
  expect(panel.root.textContent).toContain(S.emptyRecent);
});

test("revert answered 500 is a real failure with the status and the button stays usable", async () => {
  routes["/api/cleanup-runs/availability"] = available;
  routes["/api/entity-register/records/5/revert"] = () => Response.json({ error: "db locked" }, { status: 500 });
  routes["/api/entity-register/records"] = () => Response.json({ records: [record()], total: 1 });
  const panel = await mount();
  const revert = panel.root.querySelector<HTMLButtonElement>("button.auto-register-revert")!;
  revert.click();
  await tick();
  expect(panel.root.textContent).toContain("되돌리지 못했습니다");
  expect(panel.root.textContent).toContain("500");
  expect(panel.root.textContent).not.toContain("이미 처리됨");
  expect(revert.disabled).toBe(false);
});

test("a failed list request is shown as an error, not as an empty list", async () => {
  routes["/api/cleanup-runs/availability"] = available;
  routes["/api/entity-register/records"] = () => Response.json({ error: "db locked" }, { status: 500 });
  const panel = await mount();
  expect(panel.root.textContent).toContain("db locked");
  expect(panel.root.textContent).not.toContain(S.emptyRecent);
});
