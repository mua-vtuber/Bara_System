import "../../../../test-setup-dom";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { renderDynamicEnumWidget } from "./dynamic-enum";
import { emitDynamicEnumRefresh, type ManifestAction } from "../actions";
import type { WidgetContext } from "./widget";
import { _resetTokenCacheForTest } from "../../api-fetch";

const ACTION: ManifestAction = {
  id: "list-channels",
  label: "채널 목록 갱신",
  method: "GET",
  path: "/actions/list-channels",
  returns: "enum",
};

const ENDPOINT = "http://127.0.0.1:3100";

function makeCtx(partial: Partial<WidgetContext>): WidgetContext {
  return {
    key: partial.key ?? "channelId",
    path: partial.path ?? "channelId",
    schema: partial.schema ?? {
      type: "string",
      title: "활성 채널",
      "x-ui": {
        widget: "dynamic-enum",
        actionId: "list-channels",
        labelField: "name",
        valueField: "id",
      },
    },
    value: partial.value,
    onChange: partial.onChange ?? (() => {}),
    required: partial.required,
  };
}

interface FetchCall {
  url: string;
  method: string;
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
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    const url = typeof input === "string" ? input : String(input);
    // apiFetch 내부 토큰 발급 요청 — stub 인덱스를 소비하지 않고 토큰 응답만 돌려준다.
    if (url === "/dashboard/sse-token") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: "test-token" }),
        text: async () => "",
      } as unknown as Response;
    }
    calls.push({ url, method: init?.method ?? "GET" });
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

/**
 * microtask + task 큐를 모두 드레인한다.
 * apiFetch 내부 체인(토큰발급 2단계 + 실제API 1단계)은 void fire-and-forget 으로 시작하므로
 * Promise.resolve() 반복만으로는 완료를 보장할 수 없다. setTimeout(0) 으로 task 경계를 넘는다.
 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("renderDynamicEnumWidget", () => {
  let toastHost: HTMLElement | null;

  beforeEach(() => {
    _resetTokenCacheForTest();
    toastHost = document.getElementById("form-toast-host");
    if (toastHost) toastHost.innerHTML = "";
  });

  afterEach(() => {
    _resetTokenCacheForTest();
    const host = document.getElementById("form-toast-host");
    if (host) host.innerHTML = "";
  });

  test("탭 진입 시 액션 자동 호출 + labelField/valueField 반영 + 드롭다운 채움", async () => {
    const { calls, restore } = installFetch([
      {
        ok: true,
        body: [
          { id: "111", name: "#일반" },
          { id: "222", name: "#작업" },
        ],
      },
    ]);
    const el = renderDynamicEnumWidget(makeCtx({ value: "222", required: true }), {
      action: ACTION,
      endpoint: ENDPOINT,
    });
    await flush();
    restore();

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(
      "http://127.0.0.1:3100/actions/list-channels",
    );
    expect(calls[0]!.method).toBe("GET");

    const select = el.querySelector("select") as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option"));
    expect(options.map((o) => o.value)).toEqual(["111", "222"]);
    expect(options.map((o) => o.textContent)).toEqual(["#일반", "#작업"]);
    expect(select.value).toBe("222");
  });

  test("갱신 버튼 = 액션 재호출 + 새 데이터 반영", async () => {
    const { calls, restore } = installFetch([
      { ok: true, body: [{ id: "1", name: "old" }] },
      { ok: true, body: [{ id: "2", name: "new" }] },
    ]);
    const el = renderDynamicEnumWidget(makeCtx({ required: true }), {
      action: ACTION,
      endpoint: ENDPOINT,
    });
    await flush();
    const refreshBtn = el.querySelector(
      ".form-dynamic-enum-refresh",
    ) as HTMLButtonElement;
    refreshBtn.click();
    await flush();
    restore();

    expect(calls.length).toBe(2);
    const select = el.querySelector("select") as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option"));
    expect(options.map((o) => o.value)).toEqual(["2"]);
    expect(options.map((o) => o.textContent)).toEqual(["new"]);
  });

  test("외부에서 dynamicEnumBus refresh 이벤트 = 같은 actionId 위젯 갱신", async () => {
    const { restore } = installFetch([{ ok: true, body: [] }]);
    const el = renderDynamicEnumWidget(makeCtx({ required: true }), {
      action: ACTION,
      endpoint: ENDPOINT,
    });
    await flush();

    emitDynamicEnumRefresh("list-channels", [
      { id: "abc", name: "외부 채널" },
    ]);
    restore();

    const select = el.querySelector("select") as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option"));
    expect(options.map((o) => o.value)).toEqual(["abc"]);
    expect(options.map((o) => o.textContent)).toEqual(["외부 채널"]);
  });

  test("change = onChange 호출 (string 값)", async () => {
    const { restore } = installFetch([
      {
        ok: true,
        body: [
          { id: "111", name: "#일반" },
          { id: "222", name: "#작업" },
        ],
      },
    ]);
    let captured: { path?: string; value?: unknown } = {};
    const el = renderDynamicEnumWidget(
      makeCtx({
        required: true,
        onChange: (path, value) => {
          captured = { path, value };
        },
      }),
      { action: ACTION, endpoint: ENDPOINT },
    );
    await flush();
    const select = el.querySelector("select") as HTMLSelectElement;
    select.value = "222";
    select.dispatchEvent(new Event("change"));
    restore();

    expect(captured.path).toBe("channelId");
    expect(captured.value).toBe("222");
  });

  test("HTTP 에러 = toast 빨강 + 옵션 변경 없음 (fallback 없음)", async () => {
    const { restore } = installFetch([
      { ok: false, status: 500, body: null, text: "boom" },
    ]);
    const el = renderDynamicEnumWidget(makeCtx({ required: true }), {
      action: ACTION,
      endpoint: ENDPOINT,
    });
    await flush();
    restore();

    const host = document.getElementById("form-toast-host");
    expect(host).not.toBeNull();
    const toast = host!.querySelector(".form-toast") as HTMLElement;
    expect(toast).not.toBeNull();
    expect(toast.dataset.kind).toBe("error");
    expect(toast.textContent).toContain("list-channels");

    const select = el.querySelector("select") as HTMLSelectElement;
    const realOpts = Array.from(select.querySelectorAll("option")).filter(
      (o) => o.value !== "",
    );
    expect(realOpts.length).toBe(0);
  });
});
