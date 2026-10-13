import { describe, test, expect } from "bun:test";
import {
  proxyFetch,
  TimeoutError,
  NetworkError,
  HttpError,
  DEFAULT_PROXY_TIMEOUT_MS,
} from "./proxy-fetch";

// ---------------------------------------------------------------------------
// stub 헬퍼
// ---------------------------------------------------------------------------

function stubFetch(
  status: number,
  body: string,
  contentType = "application/json",
): typeof fetch {
  const impl = async () =>
    new Response(body, {
      status,
      headers: { "content-type": contentType },
    });
  return impl as unknown as typeof fetch;
}

function errorFetch(err: Error): typeof fetch {
  const impl = async () => {
    throw err;
  };
  return impl as unknown as typeof fetch;
}

function abortFetch(): typeof fetch {
  const impl = async (_url: string | URL | Request, opts?: RequestInit) => {
    const signal = opts?.signal as AbortSignal | undefined;
    const abortErr = new DOMException("aborted", "AbortError");
    if (signal?.aborted) throw abortErr;
    await new Promise<void>((_, reject) => {
      signal?.addEventListener("abort", () => reject(abortErr));
    });
    throw abortErr;
  };
  return impl as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// 테스트
// ---------------------------------------------------------------------------

describe("proxyFetch — 정상 응답", () => {
  test("200 응답 = ProxyFetchResult 반환", async () => {
    const result = await proxyFetch("http://127.0.0.1:3100/settings/schema", {
      fetchImpl: stubFetch(200, '{"fields":[]}'),
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe('{"fields":[]}');
    expect(result.contentType).toContain("application/json");
  });

  test("PUT body 그대로 전달", async () => {
    let capturedBody: unknown;
    const fetchImpl = async (_url: string | URL | Request, opts?: RequestInit) => {
      capturedBody = opts?.body;
      return new Response("{}", { status: 200 });
    };
    await proxyFetch("http://127.0.0.1:3100/settings", {
      method: "PUT",
      body: '{"key":"value"}',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(capturedBody).toBe('{"key":"value"}');
  });

  test("Content-Type 헤더 null 일 때 contentType = null", async () => {
    const fetchImpl = async () => new Response("{}", { status: 200 });
    const result = await proxyFetch("http://127.0.0.1:3100/x", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.contentType).toBeNull();
  });
});

describe("proxyFetch — 에러 분류", () => {
  test("AbortError = TimeoutError throw", async () => {
    let threw: unknown;
    try {
      await proxyFetch("http://127.0.0.1:3100/slow", {
        timeoutMs: 1,
        fetchImpl: abortFetch(),
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(TimeoutError);
    const e = threw as TimeoutError;
    expect(e.kind).toBe("timeout");
    expect(e.message).toContain("타임아웃");
  });

  test("네트워크 오류 = NetworkError throw", async () => {
    let threw: unknown;
    try {
      await proxyFetch("http://127.0.0.1:9999/nope", {
        fetchImpl: errorFetch(new Error("ECONNREFUSED")),
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(NetworkError);
    const e = threw as NetworkError;
    expect(e.kind).toBe("network");
    expect(e.message).toContain("연결 실패");
  });

  test("4xx 응답 = HttpError throw (status 보존)", async () => {
    let threw: unknown;
    try {
      await proxyFetch("http://127.0.0.1:3100/not-found", {
        fetchImpl: stubFetch(404, '{"error":"not found"}'),
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(HttpError);
    const e = threw as HttpError;
    expect(e.kind).toBe("http");
    expect(e.status).toBe(404);
    expect(e.body).toContain("not found");
  });

  test("5xx 응답 = HttpError throw (status 보존)", async () => {
    let threw: unknown;
    try {
      await proxyFetch("http://127.0.0.1:3100/err", {
        fetchImpl: stubFetch(503, "Service Unavailable"),
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(HttpError);
    const e = threw as HttpError;
    expect(e.status).toBe(503);
  });

  test("4xx 응답 = HttpError.contentType 보존 (text/plain)", async () => {
    let threw: unknown;
    try {
      await proxyFetch("http://127.0.0.1:3100/bad", {
        fetchImpl: stubFetch(422, "처리 불가", "text/plain; charset=utf-8"),
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(HttpError);
    const e = threw as HttpError;
    expect(e.status).toBe(422);
    expect(e.body).toBe("처리 불가");
    expect(e.contentType).toContain("text/plain");
  });

  test("4xx 응답 = content-type 없을 때 HttpError.contentType = null", async () => {
    const impl = async () => new Response("err", { status: 400 });
    let threw: unknown;
    try {
      await proxyFetch("http://127.0.0.1:3100/bad", {
        fetchImpl: impl as unknown as typeof fetch,
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(HttpError);
    const e = threw as HttpError;
    expect(e.contentType).toBeNull();
  });
});

describe("proxyFetch — 기본값", () => {
  test("DEFAULT_PROXY_TIMEOUT_MS = 30초", () => {
    expect(DEFAULT_PROXY_TIMEOUT_MS).toBe(30_000);
  });
});
