/**
 * entity-management-api-column.test.ts — addColumn/removeColumn fetch 순차 검증 (S8).
 *
 * 검증 정신 — Mock 클래스 0:
 *   globalThis.fetch 전역 함수만 stub 으로 교체해 createEntityManagementPanelApi().addColumn 이
 *   columns POST 후 (number/date면) column_types POST 를 *순차*로 부르는지, 글자형이면 column_types
 *   를 *안 부르는지*를 호출 기록으로 본다(인터페이스 가짜 구현 클래스 아님·전역 함수 교체).
 *
 * 핵심 갈래:
 *   - 숫자형 → POST columns → POST column_types('칸키\tnumber') 순서.
 *   - 날짜형 → POST columns → POST column_types('칸키\tdate') 순서.
 *   - 글자형 → POST columns 한 번만(column_types 호출 0).
 *   - columns 실패 → column_types 미시도(칸 없는데 datatype 무의미)·결과에 실패 메시지.
 *   - removeColumn → DELETE /classify-vocab/:id 한 번(라우트가 짝 삭제).
 */

import { describe, test, expect, afterEach } from "bun:test";
import "../../test-setup-dom.ts";
import { createEntityManagementPanelApi } from "./entity-management-api";
import { _resetTokenCacheForTest } from "./api-fetch";

const ORIGINAL_FETCH = globalThis.fetch;

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

/** classify-vocab POST/DELETE 만 기록하는 fetch stub. 토큰 발급은 통과시킨다. */
function stubFetch(opts: {
  /** /classify-vocab POST 응답 상태를 slot 별로 가른다(columns/column_types). */
  postStatusBySlot?: Partial<Record<"columns" | "column_types", number>>;
}): FetchCall[] {
  window.sessionStorage.setItem("bara.dashboard.token", "t");
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    if (url === "/dashboard/sse-token") {
      return new Response(JSON.stringify({ token: "t" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url === "/api/classify-vocab" && method === "POST") {
      const slot = (body as { slot: "columns" | "column_types" }).slot;
      const status = opts.postStatusBySlot?.[slot] ?? 201;
      if (status >= 400) {
        return new Response(JSON.stringify({ error: `라우트 거부 (${slot})` }), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ entry: { id: "x" } }), { status });
    }
    // DELETE /classify-vocab/:id
    return new Response(JSON.stringify({ deleted: "x" }), { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

afterEach(() => {
  window.sessionStorage.removeItem("bara.dashboard.token");
  globalThis.fetch = ORIGINAL_FETCH as unknown as typeof fetch;
  _resetTokenCacheForTest();
});

describe("createEntityManagementPanelApi().addColumn — 순차 POST(S8)", () => {
  test("숫자형 → columns POST 후 column_types POST(`칸키\\tnumber`) 순서", async () => {
    const calls = stubFetch({});
    const api = createEntityManagementPanelApi();
    const result = await api.addColumn("ledger", "금액", "number");

    const posts = calls.filter(
      (c) => c.url === "/api/classify-vocab" && c.method === "POST",
    );
    expect(posts.length).toBe(2);
    // 첫째 = columns, 둘째 = column_types(순서 보장).
    expect((posts[0]!.body as { slot: string }).slot).toBe("columns");
    expect((posts[0]!.body as { value: string }).value).toBe("금액");
    expect((posts[1]!.body as { slot: string }).slot).toBe("column_types");
    expect((posts[1]!.body as { value: string }).value).toBe("금액\tnumber");
    expect(result.columnsResult.ok).toBe(true);
    expect(result.columnTypesResult?.ok).toBe(true);
  });

  test("글자형 → columns POST 한 번만(column_types 호출 0)", async () => {
    const calls = stubFetch({});
    const api = createEntityManagementPanelApi();
    const result = await api.addColumn("ledger", "메모", "text");

    const posts = calls.filter(
      (c) => c.url === "/api/classify-vocab" && c.method === "POST",
    );
    expect(posts.length).toBe(1);
    expect((posts[0]!.body as { slot: string }).slot).toBe("columns");
    // 글자형이라 column_types 결과가 없다(둘째 호출 미시도).
    expect(result.columnTypesResult).toBeUndefined();
  });

  test("날짜형 → columns POST 후 column_types POST(`칸키\\tdate`) 순서", async () => {
    const calls = stubFetch({});
    const api = createEntityManagementPanelApi();
    const result = await api.addColumn("ledger", "구입일", "date");

    const posts = calls.filter(
      (c) => c.url === "/api/classify-vocab" && c.method === "POST",
    );
    expect(posts.length).toBe(2);
    expect((posts[0]!.body as { slot: string }).slot).toBe("columns");
    expect((posts[0]!.body as { value: string }).value).toBe("구입일");
    expect((posts[1]!.body as { slot: string }).slot).toBe("column_types");
    expect((posts[1]!.body as { value: string }).value).toBe("구입일\tdate");
    expect(result.columnsResult.ok).toBe(true);
    expect(result.columnTypesResult?.ok).toBe(true);
  });

  test("columns 실패 → column_types 미시도 + 결과에 실패 메시지", async () => {
    const calls = stubFetch({ postStatusBySlot: { columns: 400 } });
    const api = createEntityManagementPanelApi();
    const result = await api.addColumn("work", "발매일", "number");

    const posts = calls.filter(
      (c) => c.url === "/api/classify-vocab" && c.method === "POST",
    );
    // columns 한 번만 시도되고(400), column_types 는 안 불린다.
    expect(posts.length).toBe(1);
    expect(result.columnsResult.ok).toBe(false);
    expect(result.columnsResult.message).toContain("라우트 거부");
    expect(result.columnTypesResult).toBeUndefined();
  });

  test("removeColumn → DELETE /classify-vocab/:id 한 번(라우트가 짝 삭제)", async () => {
    const calls = stubFetch({});
    const api = createEntityManagementPanelApi();
    await api.removeColumn("cvocab_user_abc");

    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes.length).toBe(1);
    expect(deletes[0]!.url).toContain("/api/classify-vocab/");
    expect(deletes[0]!.url).toContain("cvocab_user_abc");
  });
});
