/**
 * detail-schedule-control.test.ts — 홈 상세 "일정 아님" 버튼 검증.
 *
 * happy-dom + 전역 fetch 스텁(detail-trash-control.test.ts 와 같은 관례, 인터페이스 mock 클래스 아님).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerHappyDom } from "../test-happy-dom.ts";
registerHappyDom();

import {
  detailScheduleControl,
  hasScheduleDate,
  isScheduleHidden,
  isScheduleNode,
} from "./detail-schedule-control.ts";
import { DETAIL_SCHEDULE_STRINGS as S } from "./detail-schedule-strings.ts";
import type { ScheduleVisibilityResult } from "./dashboard-api.ts";
import { _resetTokenCacheForTest } from "../api-fetch.js";

const TOKEN_PATH = "/dashboard/sse-token";
const BUTTON = "button.detail-schedule-btn";

let originalFetch: typeof globalThis.fetch;
let fetchCalls: Array<{ url: string; init?: RequestInit }>;

function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes(TOKEN_PATH)) {
      return new Response(JSON.stringify({ token: "test-token" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    fetchCalls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof globalThis.fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  window.sessionStorage.setItem("bara.dashboard.token", "test-token");
  _resetTokenCacheForTest();
  originalFetch = globalThis.fetch;
  fetchCalls = [];
  document.body.replaceChildren();
});

afterEach(() => {
  window.sessionStorage.removeItem("bara.dashboard.token");
  globalThis.fetch = originalFetch;
  document.body.replaceChildren();
  _resetTokenCacheForTest();
});

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function waitForFetchCalls(count: number): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (fetchCalls.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("metadata 판독 헬퍼", () => {
  test("scheduleHidden === true 일 때만 숨김", () => {
    expect(isScheduleHidden({ scheduleHidden: true })).toBe(true);
    expect(isScheduleHidden({ scheduleHidden: false })).toBe(false);
    expect(isScheduleHidden({})).toBe(false);
    expect(isScheduleHidden(undefined)).toBe(false);
  });

  test("scheduleOccurrence === true 인 글이 일정 노드", () => {
    expect(isScheduleNode({ scheduleOccurrence: true })).toBe(true);
    expect(isScheduleNode({})).toBe(false);
    expect(isScheduleNode(undefined)).toBe(false);
  });

  test("날짜 유무", () => {
    expect(hasScheduleDate("2026-10-16")).toBe(true);
    expect(hasScheduleDate(null)).toBe(false);
    expect(hasScheduleDate(undefined)).toBe(false);
    expect(hasScheduleDate("  ")).toBe(false);
  });
});

describe("detailScheduleControl — 렌더", () => {
  test("날짜가 없으면 버튼을 만들지 않는다", () => {
    expect(detailScheduleControl({ memoryId: 1, eventAt: null, metadata: {}, onChanged: () => undefined })).toBeNull();
  });

  test("날짜가 있으면 '일정 아님' 버튼, 숨김 상태면 '일정으로 다시 보기' 버튼", () => {
    const normal = detailScheduleControl({ memoryId: 1, eventAt: "2026-10-16", metadata: {}, onChanged: () => undefined })!;
    expect(normal.querySelector(BUTTON)?.textContent).toBe(S.hideButton);
    const hidden = detailScheduleControl({
      memoryId: 1, eventAt: "2026-10-16", metadata: { scheduleHidden: true }, onChanged: () => undefined,
    })!;
    expect(hidden.querySelector(BUTTON)?.textContent).toBe(S.showButton);
  });
});

describe("detailScheduleControl — 숨기기", () => {
  test("confirm 이 false 면 fetch 를 부르지 않는다", async () => {
    stubFetch(() => jsonResponse({}));
    let changed = 0;
    const control = detailScheduleControl({
      memoryId: 7, eventAt: "2026-10-16", metadata: {}, onChanged: () => { changed++; }, confirmFn: () => false,
    })!;
    document.body.appendChild(control);
    (control.querySelector(BUTTON) as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(fetchCalls.length).toBe(0);
    expect(changed).toBe(0);
  });

  test("수락하면 hidden:true 로 POST 하고 onChanged 에 응답을 넘긴다. 자동 일정이면 휴지통 안내가 문구에 있다", async () => {
    const response: ScheduleVisibilityResult = { nodeId: 7, hidden: true, action: "reverted_schedule", revertedRecordId: 3, sourceMemoFlagged: true };
    stubFetch((url) => {
      expect(url).toContain("/memories/7/schedule-visibility");
      return jsonResponse(response);
    });
    const seen: ScheduleVisibilityResult[] = [];
    let message = "";
    const control = detailScheduleControl({
      memoryId: 7, eventAt: "2026-10-16", metadata: { scheduleOccurrence: true },
      onChanged: (r) => { seen.push(r); },
      confirmFn: (m) => { message = m; return true; },
    })!;
    document.body.appendChild(control);
    (control.querySelector(BUTTON) as HTMLButtonElement).click();
    await waitForFetchCalls(1);
    await flushMicrotasks();

    expect(fetchCalls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({ hidden: true });
    expect(message).toContain("휴지통");
    expect(seen).toEqual([response]);
  });

  test("일반 메모의 확인 문구에는 휴지통 안내가 없다", () => {
    expect(S.hideConfirm(false)).not.toContain("휴지통");
    expect(S.hideConfirm(true)).toContain("휴지통");
  });

  test("서버 오류면 onChanged 를 부르지 않고 버튼을 다시 켠다", async () => {
    stubFetch(() => jsonResponse({ error: "기억 7 없음" }, 404));
    let changed = 0;
    const control = detailScheduleControl({
      memoryId: 7, eventAt: "2026-10-16", metadata: {}, onChanged: () => { changed++; }, confirmFn: () => true,
    })!;
    document.body.appendChild(control);
    const button = control.querySelector(BUTTON) as HTMLButtonElement;
    button.click();
    await waitForFetchCalls(1);
    await flushMicrotasks();
    expect(changed).toBe(0);
    expect(button.disabled).toBe(false);
  });
});

describe("detailScheduleControl — 다시 보기", () => {
  test("확인 없이 hidden:false 로 POST 한다", async () => {
    stubFetch(() => jsonResponse({ nodeId: 7, hidden: false, action: "unflagged" }));
    let asked = 0;
    const seen: ScheduleVisibilityResult[] = [];
    const control = detailScheduleControl({
      memoryId: 7, eventAt: "2026-10-16", metadata: { scheduleHidden: true },
      onChanged: (r) => { seen.push(r); },
      confirmFn: () => { asked++; return true; },
    })!;
    document.body.appendChild(control);
    (control.querySelector(BUTTON) as HTMLButtonElement).click();
    await waitForFetchCalls(1);
    await flushMicrotasks();
    expect(asked).toBe(0);
    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({ hidden: false });
    expect(seen.map((r) => r.action)).toEqual(["unflagged"]);
  });
});
