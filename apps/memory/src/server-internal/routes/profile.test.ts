/**
 * server-internal/routes/profile.test.ts — GET /profile 라우트 검증 (T25 / spec H).
 *
 * getProfile 자체의 facet 분류 로직은 server-internal/profile.test.ts 권위 — 여기서는
 * 라우트 표면(등록·200·400·공개 경로 아님·쿼리 파라미터 파싱)만 확인한다.
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { EMBEDDING_DIMENSIONS } from "../../embedding/factory.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { isPublicPath } from "../auth-gate-public-paths.ts";
import type { MemoryApiDeps } from "../types.ts";
import type { ProfileReport } from "../profile.ts";
import { registerProfileRoutes } from "./profile.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let db: Database;
let store: SqliteMemoryStore;
let deps: MemoryApiDeps;
let app: Hono;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"] });
  store = new SqliteMemoryStore(db, embedder);
  deps = { store, retriever: {} as never, assembler: {} as never };
  app = new Hono({ strict: false });
  registerProfileRoutes(app, deps);
});
afterEach(() => {
  db.close();
});

test("공개 경로 아님 — 외곽 auth 게이트 보호 대상", () => {
  expect(isPublicPath("/profile")).toBe(false);
});

test("GET /profile — facet 미지정, 선호 0건이면 200 + note", async () => {
  const res = await app.request("/profile");
  expect(res.status).toBe(200);
  const body = (await res.json()) as ProfileReport;
  expect(body).toEqual({ facets: {}, note: "no preferences stored yet" });
});

test("GET /profile?facet=stack — 유효 facet 은 200 + 그 facet 만 회신", async () => {
  await store.addNode({
    content: "Bun 런타임을 쓴다",
    memoryType: "preference",
    metadata: { facet: "stack" },
  });
  const res = await app.request("/profile?facet=stack");
  expect(res.status).toBe(200);
  const body = (await res.json()) as ProfileReport;
  expect(Object.keys(body.facets)).toEqual(["stack"]);
});

test("GET /profile?facet=존재하지않는값 — 400 (닫힌 enum, 조용히 무시하지 않음)", async () => {
  const res = await app.request("/profile?facet=존재하지않는값");
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("미지원 facet");
});

test("profile scope query is strict and project reads include global by default", async () => {
  const embedding = await embedder.embed("사용자 규칙");
  const global = await store.addNode({ content: "공통", memoryType: "preference", embedding });
  const a = await store.addNode({ content: "A", memoryType: "preference", project_id: "A", embedding });
  await store.addNode({ content: "B", memoryType: "preference", project_id: "B", embedding });
  const params = new URLSearchParams({ scope: JSON.stringify({ projectId: "A" }) });
  const response = await app.request(`/profile?${params}`);
  expect(response.status).toBe(200);
  const report = await response.json() as ProfileReport;
  expect(new Set(Object.values(report.facets).flat().map(entry => entry.id))).toEqual(new Set([global, a]));
  expect((await app.request("/profile?scope=broken")).status).toBe(400);
  expect((await app.request("/profile?includeInactive=yes")).status).toBe(400);
});
