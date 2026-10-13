import "../../../test-setup-dom";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  dynamicEnumBus,
  executeAction,
  renderActions,
  type ManifestAction,
} from "./actions";
import { _resetTokenCacheForTest } from "../api-fetch";

const ENDPOINT = "http://127.0.0.1:3100";

interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
  contentType?: string;
}

function installFetch(
  responses: Array<{
    ok: boolean;
    status?: number;
    body: unknown;
    text?: string;
  }>,
): { calls: FetchCall[]; restore: () => void } {
  window.sessionStorage.setItem("bara.dashboard.token", "test-token");
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  let idx = 0;
  globalThis.fetch = (async (
    input: unknown,
    init?: { method?: string; body?: unknown; headers?: Record<string, string> | Headers },
  ) => {
    const url = typeof input === "string" ? input : String(input);
    // apiFetch 내부 토큰 발급 요청 — calls 목록에 추가하지 않고 토큰 응답만 돌려준다.
    if (url === "/dashboard/sse-token") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: "test-token" }),
        text: async () => "",
      } as unknown as Response;
    }
    let parsedBody: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    } else {
      parsedBody = init?.body;
    }
    // apiFetch 가 Headers 객체로 변환해 넘기므로 양쪽 형태 모두 처리한다.
    const rawHeaders = init?.headers;
    let contentType: string | undefined;
    if (rawHeaders instanceof Headers) {
      contentType = rawHeaders.get("content-type") ?? undefined;
    } else if (rawHeaders && typeof rawHeaders === "object") {
      contentType = (rawHeaders as Record<string, string>)["content-type"];
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: parsedBody,
      contentType,
    });
    const r = responses[Math.min(idx, responses.length - 1)]!;
    idx += 1;
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.body,
      text: async () => r.text ?? "",
    } as unknown as Response;
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      window.sessionStorage.removeItem("bara.dashboard.token");
      globalThis.fetch = originalFetch;
    },
  };
}

function installConfirm(answer: boolean): {
  prompts: string[];
  restore: () => void;
} {
  const prompts: string[] = [];
  const original = globalThis.confirm;
  globalThis.confirm = (msg?: string) => {
    prompts.push(msg ?? "");
    return answer;
  };
  return {
    prompts,
    restore: () => {
      globalThis.confirm = original;
    },
  };
}

describe("renderActions", () => {
  beforeEach(() => {
    _resetTokenCacheForTest();
    const host = document.getElementById("form-toast-host");
    if (host) host.innerHTML = "";
  });

  afterEach(() => {
    _resetTokenCacheForTest();
    const host = document.getElementById("form-toast-host");
    if (host) host.innerHTML = "";
  });

  test("actions[] = 각 매니페스트 action 마다 버튼 노출 + 라벨/returns dataset", () => {
    const actions: ManifestAction[] = [
      {
        id: "verify-token",
        label: "토큰 검증",
        method: "POST",
        path: "/actions/verify-token",
        returns: "toast",
      },
      {
        id: "list-channels",
        label: "채널 목록 갱신",
        method: "GET",
        path: "/actions/list-channels",
        returns: "enum",
      },
    ];
    const el = renderActions(actions, ENDPOINT);
    const buttons = Array.from(
      el.querySelectorAll("button"),
    ) as HTMLButtonElement[];
    expect(buttons.length).toBe(2);
    expect(buttons[0]!.textContent).toBe("토큰 검증");
    expect(buttons[0]!.dataset.actionId).toBe("verify-token");
    expect(buttons[0]!.className).toContain("form-action-toast");
    expect(buttons[1]!.dataset.actionId).toBe("list-channels");
    expect(buttons[1]!.className).toContain("form-action-enum");
  });
});

describe("executeAction — returns: 'toast'", () => {
  beforeEach(() => {
    _resetTokenCacheForTest();
    const host = document.getElementById("form-toast-host");
    if (host) host.innerHTML = "";
  });

  afterEach(() => { _resetTokenCacheForTest(); });

  test("성공 = toast 녹색 + 응답 message 표시", async () => {
    const { calls, restore } = installFetch([
      { ok: true, body: { message: "토큰 유효" } },
    ]);
    const action: ManifestAction = {
      id: "verify-token",
      label: "토큰 검증",
      method: "POST",
      path: "/actions/verify-token",
      returns: "toast",
    };
    await executeAction(action, ENDPOINT);
    restore();

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(
      "http://127.0.0.1:3100/actions/verify-token",
    );
    expect(calls[0]!.method).toBe("POST");

    const toast = document.querySelector(".form-toast") as HTMLElement;
    expect(toast).not.toBeNull();
    expect(toast.dataset.kind).toBe("success");
    expect(toast.textContent).toBe("토큰 유효");
  });

  test("HTTP 실패 = toast 빨강 + 에러 메시지 (fallback 없음)", async () => {
    const { restore } = installFetch([
      { ok: false, status: 401, body: null, text: "Unauthorized" },
    ]);
    const action: ManifestAction = {
      id: "verify-token",
      label: "토큰 검증",
      method: "POST",
      path: "/actions/verify-token",
      returns: "toast",
    };
    await executeAction(action, ENDPOINT);
    restore();

    const toast = document.querySelector(".form-toast") as HTMLElement;
    expect(toast).not.toBeNull();
    expect(toast.dataset.kind).toBe("error");
    expect(toast.textContent).toContain("verify-token");
    expect(toast.textContent).toContain("401");
  });
});

describe("executeAction — returns: 'enum'", () => {
  beforeEach(() => { _resetTokenCacheForTest(); });
  afterEach(() => { _resetTokenCacheForTest(); });

  test("성공 = dynamicEnumBus 가 actionId 이벤트 emit", async () => {
    const { restore } = installFetch([
      { ok: true, body: [{ id: "x", name: "X" }] },
    ]);
    const action: ManifestAction = {
      id: "list-channels",
      label: "채널 목록 갱신",
      method: "GET",
      path: "/actions/list-channels",
      returns: "enum",
    };
    let captured: unknown = null;
    const listener = (ev: Event): void => {
      const ce = ev as CustomEvent<{ data: unknown[] }>;
      captured = ce.detail.data;
    };
    dynamicEnumBus.addEventListener("refresh:list-channels", listener);
    await executeAction(action, ENDPOINT);
    dynamicEnumBus.removeEventListener("refresh:list-channels", listener);
    restore();

    expect(captured).toEqual([{ id: "x", name: "X" }]);
  });

  test("응답이 배열 아님 = toast 빨강 + emit 없음", async () => {
    const { restore } = installFetch([
      { ok: true, body: { not: "array" } },
    ]);
    const action: ManifestAction = {
      id: "list-channels",
      label: "채널 목록 갱신",
      method: "GET",
      path: "/actions/list-channels",
      returns: "enum",
    };
    let emitted = false;
    const listener = (): void => {
      emitted = true;
    };
    dynamicEnumBus.addEventListener("refresh:list-channels", listener);
    const host = document.getElementById("form-toast-host");
    if (host) host.innerHTML = "";
    await executeAction(action, ENDPOINT);
    dynamicEnumBus.removeEventListener("refresh:list-channels", listener);
    restore();

    expect(emitted).toBe(false);
    const toast = document.querySelector(".form-toast") as HTMLElement;
    expect(toast).not.toBeNull();
    expect(toast.dataset.kind).toBe("error");
  });
});

describe("executeAction — returns: 'redirect'", () => {
  beforeEach(() => { _resetTokenCacheForTest(); });
  afterEach(() => { _resetTokenCacheForTest(); });

  test("성공 = window.location 변경", async () => {
    const { restore } = installFetch([
      { ok: true, body: { url: "http://127.0.0.1:3000/redirected" } },
    ]);
    const original = globalThis.location.href;
    const action: ManifestAction = {
      id: "go",
      label: "이동",
      method: "POST",
      path: "/actions/go",
      returns: "redirect",
    };
    const captured: { value?: string } = {};
    Object.defineProperty(globalThis.location, "href", {
      configurable: true,
      get: () => original,
      set: (v: string) => {
        captured.value = v;
      },
    });
    await executeAction(action, ENDPOINT);
    restore();

    expect(captured.value).toBe("http://127.0.0.1:3000/redirected");
  });

  test("응답에 URL 없음 = toast 빨강", async () => {
    const { restore } = installFetch([{ ok: true, body: {} }]);
    const action: ManifestAction = {
      id: "go",
      label: "이동",
      method: "POST",
      path: "/actions/go",
      returns: "redirect",
    };
    const host = document.getElementById("form-toast-host");
    if (host) host.innerHTML = "";
    await executeAction(action, ENDPOINT);
    restore();

    const toast = document.querySelector(".form-toast") as HTMLElement;
    expect(toast).not.toBeNull();
    expect(toast.dataset.kind).toBe("error");
  });
});

describe("executeAction — needsConfirm", () => {
  beforeEach(() => { _resetTokenCacheForTest(); });
  afterEach(() => { _resetTokenCacheForTest(); });

  test("needsConfirm=true + 사용자 OK = 호출 진행", async () => {
    const { calls, restore } = installFetch([
      { ok: true, body: { message: "ok" } },
    ]);
    const { prompts, restore: restoreConfirm } = installConfirm(true);
    const action: ManifestAction = {
      id: "purge",
      label: "전체 삭제",
      method: "POST",
      path: "/actions/purge",
      returns: "toast",
      needsConfirm: true,
    };
    await executeAction(action, ENDPOINT);
    restore();
    restoreConfirm();

    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("전체 삭제");
    expect(calls.length).toBe(1);
  });

  test("needsConfirm=true + 사용자 취소 = 호출 없음 + toast 없음", async () => {
    const { calls, restore } = installFetch([{ ok: true, body: {} }]);
    const { restore: restoreConfirm } = installConfirm(false);
    const action: ManifestAction = {
      id: "purge",
      label: "전체 삭제",
      method: "POST",
      path: "/actions/purge",
      returns: "toast",
      needsConfirm: true,
    };
    const host = document.getElementById("form-toast-host");
    if (host) host.innerHTML = "";
    await executeAction(action, ENDPOINT);
    restore();
    restoreConfirm();

    expect(calls.length).toBe(0);
    expect(document.querySelector(".form-toast")).toBeNull();
  });
});

describe("renderActions click → executeAction", () => {
  beforeEach(() => { _resetTokenCacheForTest(); });
  afterEach(() => { _resetTokenCacheForTest(); });

  test("버튼 click = HTTP 호출 + toast", async () => {
    const { calls, restore } = installFetch([
      { ok: true, body: { message: "ping" } },
    ]);
    const actions: ManifestAction[] = [
      {
        id: "verify-token",
        label: "토큰 검증",
        method: "POST",
        path: "/actions/verify-token",
        returns: "toast",
      },
    ];
    const el = renderActions(actions, ENDPOINT);
    const btn = el.querySelector("button") as HTMLButtonElement;
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    restore();

    expect(calls.length).toBe(1);
    const toast = document.querySelector(".form-toast") as HTMLElement;
    expect(toast).not.toBeNull();
    expect(toast.textContent).toBe("ping");
  });
});

describe("POST action body wiring — getFormValue provider", () => {
  beforeEach(() => {
    _resetTokenCacheForTest();
    const host = document.getElementById("form-toast-host");
    if (host) host.innerHTML = "";
  });

  afterEach(() => { _resetTokenCacheForTest(); });

  test("POST action + getFormValue 있으면 폼 현재 값을 body 로 전달", async () => {
    const { calls, restore } = installFetch([
      { ok: true, body: { message: "토큰 유효" } },
    ]);
    const action: ManifestAction = {
      id: "verify-token",
      label: "토큰 검증",
      method: "POST",
      path: "/actions/verify-token",
      returns: "toast",
    };
    const formValue = { discordToken: "abc123", ownerId: "999" };
    await executeAction(action, ENDPOINT, () => formValue);
    restore();

    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual(formValue);
    expect(calls[0]!.contentType).toBe("application/json");
  });

  test("POST action + getFormValue 없으면 body 전송 없음 (옛 흐름 유지)", async () => {
    const { calls, restore } = installFetch([
      { ok: true, body: { message: "ok" } },
    ]);
    const action: ManifestAction = {
      id: "verify-token",
      label: "토큰 검증",
      method: "POST",
      path: "/actions/verify-token",
      returns: "toast",
    };
    await executeAction(action, ENDPOINT);
    restore();

    expect(calls.length).toBe(1);
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.contentType).toBeUndefined();
  });

  test("GET action + getFormValue 있어도 body 전송 없음", async () => {
    const { calls, restore } = installFetch([
      { ok: true, body: [{ id: "ch1", name: "general" }] },
    ]);
    const action: ManifestAction = {
      id: "list-channels",
      label: "채널 목록 갱신",
      method: "GET",
      path: "/actions/list-channels",
      returns: "enum",
    };
    let emitted = false;
    const listener = (): void => { emitted = true; };
    dynamicEnumBus.addEventListener("refresh:list-channels", listener);
    await executeAction(action, ENDPOINT, () => ({ discordToken: "should-not-send" }));
    dynamicEnumBus.removeEventListener("refresh:list-channels", listener);
    restore();

    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.body).toBeUndefined();
    expect(emitted).toBe(true);
  });
});
