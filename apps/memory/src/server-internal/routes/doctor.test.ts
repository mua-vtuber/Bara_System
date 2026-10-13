/**
 * server-internal/routes/doctor.test.ts — GET /doctor 라우트 검증 (T23 / spec E).
 *
 * runDoctor 자체의 단계 로직은 server-internal/doctor.test.ts 권위 — 여기서는
 * 라우트 표면(등록·200·JSON 형태·공개 경로 아님)만 확인한다.
 */
import { expect, test } from "bun:test";
import { Hono } from "hono";
import { isPublicPath } from "../auth-gate-public-paths.ts";
import { registerDoctorRoutes } from "./doctor.ts";
import type { DoctorReport } from "../doctor.ts";

test("공개 경로 아님 — 외곽 auth 게이트 보호 대상", () => {
  expect(isPublicPath("/doctor")).toBe(false);
});

test("GET /doctor — 200 + { stages, firstBlockingCause, counters } 형태", async () => {
  const rawDb = {
    query: (sql: string) => ({
      get: () => {
        if (sql.includes("cleanup_runs")) throw new Error("no such table");
        return { n: 0, ok: 1 };
      },
    }),
  };
  const app = new Hono({ strict: false });
  registerDoctorRoutes(app, {
    store: { getRawDb: () => rawDb, embedder: { dimension: 1024 } },
  } as never);
  const res = await app.request("/doctor");
  expect(res.status).toBe(200);
  const body = (await res.json()) as DoctorReport;
  expect(Array.isArray(body.stages)).toBe(true);
  expect(body.stages.length).toBe(8);
  expect("firstBlockingCause" in body).toBe(true);
  expect(body.counters).toEqual({ knowledgeNodes: 0, vecNodes: 0, ftsRows: 0 });
});
