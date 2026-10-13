/**
 * body-limit.test.ts — 입력 byte 상한 미들웨어 검증
 *
 * 검증 대상:
 *   - Content-Length 헤더가 상한을 초과하면 본문 읽기 전에 413 반환.
 *   - 헤더가 없거나 틀려도 실제 누적 byte 가 상한을 초과하면 413 반환.
 *   - 상한 이하 요청은 통과하고 하위 핸들러가 본문을 정상 읽는다.
 *   - /ingest 및 OCR 결과 적용 경로는 maxAssetBytes 를 적용하고 maxTextBytes 는 적용하지 않는다.
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { createBodyLimit } from "./body-limit.ts";

// ── 헬퍼 ──────────────────────────────────────────────────────────────────

/** 모든 경로에 동일한 상한을 적용하는 단순 테스트 앱 */
function appWith(limit: number) {
  const app = new Hono();
  app.use("*", createBodyLimit(() => ({ maxTextBytes: limit, maxAssetBytes: limit })));
  app.post("/x", async (c) => c.json({ len: (await c.req.text()).length }));
  return app;
}

// ── 테스트 ────────────────────────────────────────────────────────────────

describe("body-limit 미들웨어", () => {
  test("Content-Length 초과 → 413", async () => {
    const res = await appWith(10).request("/x", {
      method: "POST",
      headers: { "Content-Length": "999", "Content-Type": "text/plain" },
      body: "x".repeat(999),
    });
    expect(res.status).toBe(413);
    const text = await res.text();
    // 오류 메시지에 상한 값이 포함되어야 한다
    expect(text).toContain("10");
  });

  test("Content-Length 없어도 실제 byte 초과 → 413", async () => {
    const res = await appWith(10).request("/x", { method: "POST", body: "x".repeat(50) });
    expect(res.status).toBe(413);
  });

  test("상한 이하 → 통과 + 본문 재사용", async () => {
    const res = await appWith(100).request("/x", { method: "POST", body: "hello" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ len: 5 });
  });

  test("자산 경로(/ingest)는 maxAssetBytes 적용", async () => {
    const app = new Hono();
    app.use("*", createBodyLimit(() => ({ maxTextBytes: 5, maxAssetBytes: 1000 })));
    app.post("/ingest", async (c) => {
      await c.req.arrayBuffer(); // 본문 소비
      return c.json({ ok: true });
    });
    // 50 byte — maxTextBytes(5) 초과지만 maxAssetBytes(1000) 이하 → 통과해야 한다
    const res = await app.request("/ingest", { method: "POST", body: "x".repeat(50) });
    expect(res.status).toBe(200);
  });

  test("자산 하위 경로(/ingest/file)도 maxAssetBytes 적용", async () => {
    const app = new Hono();
    app.use("*", createBodyLimit(() => ({ maxTextBytes: 5, maxAssetBytes: 1000 })));
    app.post("/ingest/file", async (c) => {
      await c.req.arrayBuffer();
      return c.json({ ok: true });
    });
    const res = await app.request("/ingest/file", { method: "POST", body: "x".repeat(50) });
    expect(res.status).toBe(200);
  });

  test("OCR 결과 적용 경로도 maxAssetBytes 적용", async () => {
    const app = new Hono();
    app.use("*", createBodyLimit(() => ({ maxTextBytes: 5, maxAssetBytes: 1000 })));
    app.post("/api/documents/doc_abc/ocr-result", async (c) => {
      await c.req.arrayBuffer();
      return c.json({ ok: true });
    });
    const res = await app.request("/api/documents/doc_abc/ocr-result", {
      method: "POST",
      body: "x".repeat(50),
    });
    expect(res.status).toBe(200);
  });

  test("자산 경로도 maxAssetBytes 초과 시 413", async () => {
    const app = new Hono();
    app.use("*", createBodyLimit(() => ({ maxTextBytes: 5, maxAssetBytes: 20 })));
    app.post("/ingest", async (c) => c.json({ ok: true }));
    const res = await app.request("/ingest", { method: "POST", body: "x".repeat(50) });
    expect(res.status).toBe(413);
    const text = await res.text();
    expect(text).toContain("20");
  });

  test("본문 없는 요청은 통과", async () => {
    const app = new Hono();
    app.use("*", createBodyLimit(() => ({ maxTextBytes: 5, maxAssetBytes: 100 })));
    app.get("/x", (c) => c.json({ ok: true }));
    const res = await app.request("/x");
    expect(res.status).toBe(200);
  });

  test("정확히 상한 byte 는 통과", async () => {
    // 경계값: 상한과 같은 크기는 허용
    const res = await appWith(5).request("/x", { method: "POST", body: "hello" }); // 5 byte == 5
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ len: 5 });
  });

  test("상한 + 1 byte 는 413", async () => {
    const res = await appWith(5).request("/x", { method: "POST", body: "hello!" }); // 6 byte > 5
    expect(res.status).toBe(413);
  });

  test("413 응답 메시지에 상한 값 포함", async () => {
    const res = await appWith(42).request("/x", { method: "POST", body: "x".repeat(100) });
    expect(res.status).toBe(413);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("42");
  });

  test("getLimits 는 요청마다 새로 호출 — 값 변경 반영", async () => {
    let currentLimit = 10;
    const app = new Hono();
    app.use("*", createBodyLimit(() => ({ maxTextBytes: currentLimit, maxAssetBytes: currentLimit })));
    app.post("/x", async (c) => c.json({ len: (await c.req.text()).length }));

    // 처음에는 상한 10, 50 byte 요청 → 413
    const res1 = await app.request("/x", { method: "POST", body: "x".repeat(50) });
    expect(res1.status).toBe(413);

    // 상한을 100 으로 올린 뒤 같은 요청 → 통과
    currentLimit = 100;
    const res2 = await app.request("/x", { method: "POST", body: "x".repeat(50) });
    expect(res2.status).toBe(200);
  });
});
