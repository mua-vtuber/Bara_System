/**
 * route-error-handler.test.ts — buildMemoryApi 의 app.onError(WP-B1-20U 설계 17.19 설계 6 M1, 단계 U11c).
 *
 * 실제 Hono 앱에 handler 를 달고 실제 요청을 보낸다. 주인 표가 가리키는 문서 기록이 없을 때의 오류는 본문 error 에 기록 id 를
 * 싣고, 그 밖의 오류는 handler 를 달지 않은 Hono 앱과 같은 응답(HTTPException 은 그 응답, 나머지는 500 + Internal Server
 * Error + console.error)이다. 실제 라우트에서 그 오류가 나는 경우(외래 키를 끈 DB)는 routes/document-record-owners.test.ts
 * 가 맡는다. mock 0 — console.error 만 호출 기록을 본다.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { OwnedDocumentRecordMissingError } from "../db/store-internal/asset-release.ts";
import { routeErrorHandler } from "./route-error-handler.ts";

const MISSING_IDS = ["doc_missing_a", "doc_missing_b"];
const ORDINARY_FAILURE = new Error("ordinary failure");

/** 경로마다 다른 오류를 던지는 앱. handler 가 있으면 routeErrorHandler 를 단다. */
function throwingApp(withHandler: boolean): Hono {
  const app = new Hono();
  if (withHandler) app.onError(routeErrorHandler);
  app.get("/owned-missing", () => {
    throw new OwnedDocumentRecordMissingError(MISSING_IDS);
  });
  app.get("/ordinary", () => {
    throw ORDINARY_FAILURE;
  });
  app.get("/http-exception", () => {
    throw new HTTPException(418, { message: "teapot" });
  });
  app.get("/http-exception-response", () => {
    throw new HTTPException(403, { res: new Response("denied", { status: 403, headers: { "x-denied-by": "test" } }) });
  });
  return app;
}

/** 요청을 보내고 console.error 가 받은 첫 인자들을 함께 돌려준다. */
async function request(app: Hono, path: string): Promise<{ response: Response; text: string; errors: unknown[] }> {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await app.request(path);
    return { response, text: await response.text(), errors: spy.mock.calls.map((args) => args[0]) };
  } finally {
    spy.mockRestore();
  }
}

describe("routeErrorHandler", () => {
  test("주인 표가 가리키는 기록이 없다는 오류: 500 이고 본문 error 에 기록 id 가 실리며 오류를 로그한다", async () => {
    const { response, text, errors } = await request(throwingApp(true), "/owned-missing");

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = JSON.parse(text) as { error: string };
    expect(body.error).toBe(new OwnedDocumentRecordMissingError(MISSING_IDS).message);
    for (const id of MISSING_IDS) expect(body.error).toContain(id);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(OwnedDocumentRecordMissingError);
  });

  test("같은 앱을 바깥 앱에 route(\"/\", app) 으로 붙여도 본문이 같다", async () => {
    const inner = await request(throwingApp(true), "/owned-missing");
    const mounted = await request(new Hono().route("/", throwingApp(true)), "/owned-missing");

    expect(mounted.response.status).toBe(500);
    expect(mounted.text).toBe(inner.text);
    expect(mounted.errors).toHaveLength(1);
  });

  test("handler 가 없으면 같은 오류도 Hono 기본 문구가 된다 — 위 두 시험이 막는 결함의 재현", async () => {
    const { response, text } = await request(throwingApp(false), "/owned-missing");

    expect(response.status).toBe(500);
    expect(text).toBe("Internal Server Error");
  });

  test("다른 오류: handler 를 달지 않은 Hono 앱과 같은 500 응답이고 오류를 로그한다", async () => {
    const plain = await request(throwingApp(false), "/ordinary");
    const handled = await request(throwingApp(true), "/ordinary");

    expect(handled.response.status).toBe(500);
    expect(handled.text).toBe("Internal Server Error");
    expect(handled.text).toBe(plain.text);
    expect(handled.response.headers.get("content-type")).toBe(plain.response.headers.get("content-type"));
    expect(handled.errors).toEqual([ORDINARY_FAILURE]);
    expect(plain.errors).toEqual([ORDINARY_FAILURE]);
  });

  test("HTTPException: 그 오류가 가진 응답을 그대로 내고 로그하지 않는다", async () => {
    const plain = await request(throwingApp(false), "/http-exception");
    const handled = await request(throwingApp(true), "/http-exception");

    expect(handled.response.status).toBe(418);
    expect(handled.text).toBe("teapot");
    expect(handled.text).toBe(plain.text);
    expect(handled.errors).toEqual([]);

    const withResponse = await request(throwingApp(true), "/http-exception-response");
    expect(withResponse.response.status).toBe(403);
    expect(withResponse.response.headers.get("x-denied-by")).toBe("test");
    expect(withResponse.text).toBe("denied");
    expect(withResponse.errors).toEqual([]);
  });
});
