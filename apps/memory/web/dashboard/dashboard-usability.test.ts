import { afterAll, beforeAll, expect, test } from "bun:test";
import { registerHappyDom } from "./test-happy-dom.ts";
import { _resetTokenCacheForTest } from "./api-fetch.ts";
import { skipNodeDetailTypewriter } from "./ui/node-detail.ts";
registerHappyDom();

const originalFetch = globalThis.fetch;
const longText = "첫 줄\n" + "긴 기억의 본문입니다. ".repeat(70) + "\n마지막 문장까지 읽기";
const taggedText = "#프로젝트:코딩, #코딩:bara_system, #AI기록, 대시보드 목록 제목 정리 결정";
const deferred = new Map<string, (response: Response) => void>();
let lastEdit: Record<string, unknown> | undefined;
const autoRegisterReads = { availability: 0, records: 0 };
const autoRegisterRecord = {
  id: 7, itemKind: "entity_created", targetType: "person", targetId: "psn_7", name: "민수", sourceNodeId: 1,
  memoContent: "민수가 왔다", date: null, runId: "run_1", createdAt: "2026-10-10 09:00:00",
};
const json = (value: unknown) => Response.json(value);
const query = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("화면 상태 변경을 기다렸지만 완료되지 않았습니다.");
}
async function startSearch(value: string): Promise<void> {
  query<HTMLInputElement>("#dashboard-search").value = value;
  query<HTMLButtonElement>("[data-so-search-btn]").click();
  await until(() => deferred.has(value));
}
function finishSearch(value: string): void {
  deferred.get(value)!(json({ query: value, count: 1, results: [{ id: 2, content: value, score: 1, sources: [], components: {} }] }));
}
beforeAll(async () => {
  document.body.innerHTML = '<div id="app-nav-rail"></div><main id="dashboard-root"></main>';
  window.history.replaceState(null, "", "/");
  window.sessionStorage.setItem("bara.dashboard.token", "fixture-token");
  _resetTokenCacheForTest();
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    if (path === "/dashboard/sse-token") return json({token: "fixture-token"});
    if (path === "/stats") return json({ totalMemories: 1 });
    if (path === "/ingest") return json({ok: true, type: "text", originNodeId: 3});
    if (path === "/memories/1" && init?.method === "PATCH") {
      lastEdit = JSON.parse(String(init.body));
      // 실제 PATCH 응답처럼 노드 전체(작성자·저장 경로·출처 기록 포함)를 돌려주되 장소 칸은 없다.
      return json({memory: {id: 1, content: lastEdit!.content, sourceType: "user_input", author: "민수", platform: "pet",
        metadata: {sharedMemory: {revision: 1}, fieldSources: {place: "inferred"}}}});
    }
    if (path.startsWith("/memories?")) return json({ memories: [
      {id: 1, content: longText, sourceType: "user_input"},
      {id: 3, content: taggedText, sourceType: "user_input"},
    ], count: 2 });
    if (path === "/memories/3") return json({memory: {id: 3, content: taggedText, sourceType: "user_input", author: "", platform: "mcp", metadata: {}}});
    if (path === "/memories/1") return json({memory: {
      id: 1, content: longText, sourceType: "user_input", author: "민수", platform: "pet",
      place: "속초", places: ["속초"], metadata: { fieldSources: { place: "inferred" } },
    }});
    if (path === "/memories/2") return json({memory: {id: 2, content: "번호로 연 기억", sourceType: "user_input", author: "", platform: "mcp", metadata: {}}});
    if (path.startsWith("/api/date-occurrences")) return json({upcoming: [], past: []});
    if (path.startsWith("/graph/overview")) return json({nodes: [], edges: []});
    if (path === "/search") {
      const value = JSON.parse(String(init?.body)).query as string;
      return await new Promise<Response>((resolve) => deferred.set(value, resolve));
    }
    if (path === "/api/cleanup-runs/availability") {
      autoRegisterReads.availability += 1;
      return json({ available: true, running: false, reasons: [] });
    }
    if (path === "/api/entity-register/records/7/revert") return Response.json({ error: "db locked" }, { status: 500 });
    if (path.startsWith("/api/entity-register/records")) {
      autoRegisterReads.records += 1;
      return json({ records: [autoRegisterRecord], total: 1 });
    }
    if (path.startsWith("/api/entity-types")) return json({entityTypes: []});
    if (path.startsWith("/api/tag-suggest")) return json({tags: []});
    return json({});
  }) as typeof fetch;
  await import("./dashboard-entry.ts");
  await until(() => Boolean(document.querySelector('.dash-panel--list [data-node-id="node:1"]')));
});
afterAll(() => {
  skipNodeDetailTypewriter(query<HTMLElement>(".dash-detail"));
  document.body.replaceChildren();
  globalThis.fetch = originalFetch;
  window.sessionStorage.clear();
  _resetTokenCacheForTest();
});

test("홈 자동 정리 칸은 처음 열 때 한 번만 읽고, 메모를 눌러도 다시 읽지 않으며 되돌리기 실패 문구를 지우지 않는다", async () => {
  await until(() => Boolean(document.querySelector(".auto-register-revert")));
  expect(autoRegisterReads).toEqual({ availability: 1, records: 1 });
  query<HTMLButtonElement>(".auto-register-revert").click();
  await until(() => (query(".auto-register-note").textContent ?? "").includes("db locked"));
  query<HTMLButtonElement>('.dash-panel--list [data-node-id="node:1"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(autoRegisterReads).toEqual({ availability: 1, records: 1 });
  expect(query(".auto-register-note").textContent).toContain("db locked");
});

test("홈 일반 메모 상세는 줄바꿈과 마지막 문장을 포함한 전체 원문을 보여준다", async () => {
  query<HTMLButtonElement>('.dash-panel--list [data-node-id="node:1"]').click();
  await until(() => Boolean(document.querySelector(".detail-trash-btn")));
  await new Promise((resolve) => setTimeout(resolve, 0));
  skipNodeDetailTypewriter(query<HTMLElement>(".dash-detail"));
  expect(query(".node-detail__snippet").textContent).toBe(longText);
});

test("홈 상세의 수정·삭제 버튼은 본문보다 위에 한 줄로 놓인다", () => {
  const detail = query(".dash-detail");
  const actions = detail.querySelector(":scope > .dash-detail-actions");
  expect(actions).not.toBeNull();
  expect(detail.firstElementChild).toBe(actions);
  expect(actions!.querySelector(".node-window__edit-toggle")).not.toBeNull();
  expect(actions!.querySelector(".detail-trash-btn")).not.toBeNull();
});

test("홈 목록 제목은 앞머리 분류 해시태그를 빼고 본문을 보여준다", () => {
  const label = query('.dash-panel--list [data-node-id="node:3"] .rp-row__label').textContent;
  expect(label).toBe("대시보드 목록 제목 정리 결정");
});

test("다른 기억을 열면 상세 스크롤이 맨 위로 돌아가고, 같은 기억을 다시 그릴 때는 유지된다", async () => {
  const detail = query(".dash-detail");
  detail.scrollTop = 200;
  query<HTMLButtonElement>('.dash-panel--list [data-node-id="node:3"]').click();
  await until(() => (query(".dash-detail .node-detail").textContent ?? "").includes("대시보드 목록 제목 정리 결정")
    && Boolean(document.querySelector(".dash-detail details.memory-info")));
  expect(detail.scrollTop).toBe(0);
  detail.scrollTop = 50;
  const before = detail.scrollTop;
  query<HTMLButtonElement>('.dash-panel--list [data-node-id="node:3"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(detail.scrollTop).toBe(before);
  query<HTMLButtonElement>('.dash-panel--list [data-node-id="node:1"]').click();
  await until(() => Boolean(document.querySelector(".dash-detail details.memory-info")) &&
    query(".dash-detail .memory-no").textContent === "#1");
  skipNodeDetailTypewriter(query<HTMLElement>(".dash-detail"));
});

test("홈 목록과 상세에 기억 번호가 보이고, 상세의 정보 블록은 접힌 채 장소 출처·작성자·저장 경로를 보여준다", () => {
  expect(query('.dash-panel--list [data-node-id="node:1"] .memory-no').textContent).toBe("#1");
  expect(query(".dash-detail .node-detail__badges .memory-no").textContent).toBe("#1");
  const info = query<HTMLDetailsElement>(".dash-detail details.memory-info");
  expect(info.open).toBe(false);
  expect(info.querySelector("summary")?.textContent).toBe("정보");
  const text = info.textContent ?? "";
  expect(text).toContain("속초 · 추론");
  expect(text).toContain("민수");
  expect(text).toContain("펫 앱");
  expect(text).toContain("없음"); // 시각(event_at)이 없다
});

test("홈에서 전체 메모를 수정하고 기존 revision 조건으로 저장할 수 있다", async () => {
  const edit = document.querySelector<HTMLButtonElement>(".dash-detail .node-window__edit-toggle");
  expect(edit).not.toBeNull();
  edit!.click();
  const input = query<HTMLTextAreaElement>(".node-edit-modal__textarea");
  expect(input.value).toBe(longText.replace(/ +\n/g, "\n"));
  input.value = "홈에서 수정한 기억";
  query<HTMLFormElement>(".node-edit-modal__form").dispatchEvent(new Event("submit", {bubbles: true, cancelable: true}));
  await until(() => Boolean(lastEdit));
  await until(() => !document.querySelector(".node-edit-modal"));
  expect(lastEdit!.content).toBe("홈에서 수정한 기억");
  expect(lastEdit!.expectedRevision).toBe(0);
  // 수정 응답에는 장소 칸이 없지만 정보 블록의 장소는 이전 값을 잇는다.
  expect(query(".dash-detail details.memory-info").textContent).toContain("속초 · 추론");
});

test("늦은 이전 검색 응답이 최신 검색 결과를 덮지 않는다", async () => {
  await startSearch("이전 검색");
  await startSearch("최신 검색");
  finishSearch("최신 검색");
  await until(() => query(".dash-panel--list").textContent!.includes("최신 검색"));
  finishSearch("이전 검색");
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(query(".dash-panel--list").textContent).toContain("최신 검색");
  expect(query(".dash-panel--list").textContent).not.toContain("이전 검색");
});

test("검색 초기화 뒤 도착한 응답이 결과를 다시 표시하지 않는다", async () => {
  await startSearch("초기화할 검색");
  query<HTMLButtonElement>('[aria-label="검색 초기화"]').click();
  finishSearch("초기화할 검색");
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(query(".dash-panel--list").textContent).not.toContain("초기화할 검색");
  expect(query(".dash-panel--list").textContent).toContain("첫 줄");
});

test("다음 검색이 실패하면 이전 검색의 상세와 쓰기 버튼을 남기지 않는다", async () => {
  await startSearch("성공 검색");
  finishSearch("성공 검색");
  await until(() => query(".dash-panel--list").textContent!.includes("성공 검색"));
  query<HTMLButtonElement>('.dash-panel--list [data-node-id="node:2"]').click();
  await until(() => Boolean(document.querySelector(".detail-trash-btn")));
  await startSearch("실패 검색");
  deferred.get("실패 검색")!(new Response("{}", {status:503}));
  await until(() => query(".dash-panel--list").textContent!.includes("검색 실패"));
  expect(Boolean(document.querySelector(".detail-trash-btn"))).toBe(false);
  expect(Boolean(document.querySelector(".dash-detail .node-window__edit-toggle"))).toBe(false);
  const input = query<HTMLTextAreaElement>("[data-ingest-input]");
  input.value = "검색 중 다른 메모 저장";
  input.dispatchEvent(new Event("input", {bubbles: true}));
  query<HTMLButtonElement>("[data-ingest-send]").click();
  await until(() => query("[data-ingest-result]").textContent!.includes("저장됨"));
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(query(".dash-panel--list").textContent).toContain("검색 실패");
  expect(query(".dash-panel--list").textContent).not.toContain("성공 검색");
});

test("검색창에 #번호만 입력하면 검색 대신 그 기억을 연다", async () => {
  query<HTMLInputElement>("#dashboard-search").value = "#2";
  query<HTMLButtonElement>("[data-so-search-btn]").click();
  await until(() => Boolean(document.querySelector(".dash-detail details.memory-info")));
  skipNodeDetailTypewriter(query<HTMLElement>(".dash-detail"));
  expect(query(".dash-detail .node-detail__snippet").textContent).toBe("번호로 연 기억");
  expect(query(".dash-detail .node-detail__badges .memory-no").textContent).toBe("#2");
  expect(deferred.has("#2")).toBe(false); // /search 를 부르지 않았다
});
