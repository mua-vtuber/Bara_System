/**
 * detail-trash-control.test.ts — 홈 상세 삭제 버튼 검증 (개별 삭제 spec T4).
 *
 * happy-dom + real fetch mock(전역 fetch 스텁, MockStore 류 아님 — 순수 함수형
 * 모듈 fetch 래퍼를 감싸는 관례를 node-detail.test.ts 에서 그대로 가져옴).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerHappyDom } from "../test-happy-dom.ts";
registerHappyDom();

import {
  detailTrashControl,
  extractedToCount,
  trashConfirmMessage,
  type TrashedResult,
} from "./detail-trash-control.ts";
import { _resetTokenCacheForTest } from "../api-fetch.js";

const TOKEN_PATH = "/dashboard/sse-token";

let originalFetch: typeof globalThis.fetch;
let fetchCalls: Array<{ url: string; init?: RequestInit }>;

/** 토큰 발급 요청은 자동으로 흡수하고, 실제 API 요청만 handler 로 넘긴다. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes(TOKEN_PATH)) {
      return new Response(JSON.stringify({ token: "test-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    fetchCalls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof globalThis.fetch;
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
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

/** fetchCalls 가 원하는 길이에 도달할 때까지 짧게 폴링한다(토큰 발급 왕복 포함 비동기 체인 대응). */
async function waitForFetchCalls(count: number): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (fetchCalls.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("extractedToCount", () => {
  test("metadata.extractedTo 배열 길이를 돌려준다", () => {
    expect(extractedToCount({ extractedTo: [1, 2, 3] })).toBe(3);
  });

  test("extractedTo 부재는 0", () => {
    expect(extractedToCount({})).toBe(0);
    expect(extractedToCount(undefined)).toBe(0);
  });

  test("extractedTo 가 배열이 아니면 0", () => {
    expect(extractedToCount({ extractedTo: "not-an-array" })).toBe(0);
  });
});

describe("trashConfirmMessage", () => {
  test("파생 건수를 문구에 포함한다", () => {
    const msg = trashConfirmMessage(2);
    expect(msg).toContain("파생 항목 약 2건 포함");
    expect(msg).toContain("휴지통에서 복원 가능");
    expect(msg).toContain("자동 영구 삭제");
  });
});

describe("detailTrashControl — 렌더", () => {
  test("삭제 버튼 하나를 담은 블록을 렌더한다", () => {
    const el = detailTrashControl({
      memoryId: 1,
      metadata: undefined,
      onTrashed: () => undefined,
    });
    const btn = el.querySelector("button.detail-trash-btn");
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toBe("삭제");
  });
});

describe("detailTrashControl — confirm 거부", () => {
  test("confirm 이 false 면 fetch 를 호출하지 않는다", async () => {
    stubFetch(() => new Response(JSON.stringify({ trashed: 1, cascadeTrashedIds: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    let onTrashedCalls = 0;

    const el = detailTrashControl({
      memoryId: 1,
      metadata: { extractedTo: [10, 11] },
      onTrashed: () => {
        onTrashedCalls++;
      },
      confirmFn: () => false,
    });
    document.body.appendChild(el);

    const btn = el.querySelector("button.detail-trash-btn") as HTMLButtonElement;
    btn.click();
    await flushMicrotasks();

    expect(fetchCalls.length).toBe(0);
    expect(onTrashedCalls).toBe(0);
  });
});

describe("detailTrashControl — 성공", () => {
  test("confirm 수락 시 trash API 를 호출하고 onTrashed 로 갱신을 위임한다", async () => {
    stubFetch((url) => {
      expect(url).toContain("/memories/1/trash");
      return new Response(JSON.stringify({ trashed: 1, cascadeTrashedIds: [10, 11] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    let onTrashedCalls = 0;
    let confirmMessageSeen = "";
    const onTrashedResults: TrashedResult[] = [];

    const el = detailTrashControl({
      memoryId: 1,
      metadata: { extractedTo: [10, 11] },
      onTrashed: (result) => {
        onTrashedCalls++;
        onTrashedResults.push(result);
      },
      confirmFn: (message) => {
        confirmMessageSeen = message;
        return true;
      },
    });
    document.body.appendChild(el);

    const btn = el.querySelector("button.detail-trash-btn") as HTMLButtonElement;
    btn.click();
    await waitForFetchCalls(1);
    await flushMicrotasks();

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]?.init?.method).toBe("POST");
    expect(confirmMessageSeen).toContain("파생 항목 약 2건 포함");
    expect(onTrashedCalls).toBe(1);
    // onTrashed 가 trash API 응답(cascade id 포함)을 그대로 받는지 — 호출자가
    // 이 값으로 검색 결과 등 부가 상태를 필터링할 수 있어야 한다.
    expect(onTrashedResults[0]).toEqual({ trashed: 1, cascadeTrashedIds: [10, 11] });
  });

  test("실패 응답이면 onTrashed 를 호출하지 않고 버튼을 다시 활성화한다", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    }));
    let onTrashedCalls = 0;

    const el = detailTrashControl({
      memoryId: 999,
      metadata: undefined,
      onTrashed: () => {
        onTrashedCalls++;
      },
      confirmFn: () => true,
    });
    document.body.appendChild(el);

    const btn = el.querySelector("button.detail-trash-btn") as HTMLButtonElement;
    btn.click();
    await waitForFetchCalls(1);
    await flushMicrotasks();

    expect(onTrashedCalls).toBe(0);
    expect(btn.disabled).toBe(false);
  });
});
