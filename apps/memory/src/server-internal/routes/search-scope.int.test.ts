/**
 * server-internal/routes/search-scope.int.test.ts — POST /search 의 프로젝트 범위 해석
 * (2026-10-21 spec C-T4).
 *
 * MCP search_memory 와 같은 runSearchPipeline 을 쓰므로 해석 결과·오류 code·문구가 같아야
 * 한다. 실제 SQLite + 실제 bge-m3 + 실제 retriever(mock 없음).
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { EMBEDDING_DIMENSIONS } from "../../embedding/factory.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { PROJECT_SCOPE_MESSAGES } from "../../memory/project-scope-resolver.ts";
import type { MemoryApiDeps } from "../types.ts";
import { registerSearchRoutes } from "./search.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let db: Database;
let store: SqliteMemoryStore;
let app: Hono;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"] });
  store = new SqliteMemoryStore(db, embedder);
  const deps: MemoryApiDeps = { store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler() };
  app = new Hono({ strict: false });
  registerSearchRoutes(app, deps);
});
afterEach(() => db.close());

function search(body: Record<string, unknown>) {
  return app.request("/search", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

test("POST /search — 모르는 프로젝트 범위는 400 + UNKNOWN_PROJECT", async () => {
  const res = await search({ query: "배포 방법", scope: { projectId: "bara_systm" } });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    code: "UNKNOWN_PROJECT", message: PROJECT_SCOPE_MESSAGES.UNKNOWN_PROJECT("bara_systm"),
    details: { value: "bara_systm" },
  });
});

test("POST /search — 애매한 별칭은 400 + AMBIGUOUS_PROJECT(후보 포함)", async () => {
  const a = await store.findOrCreateProject({ name: "알파" });
  const b = await store.findOrCreateProject({ name: "베타" });
  store.entitiesRepo.setKoAliases(a.projectId, ["겹침"]);
  store.entitiesRepo.setKoAliases(b.projectId, ["겹침"]);
  const res = await search({ query: "배포 방법", scope: { projectId: "겹침" } });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { code: string; details: { value: string; candidates: Array<{ projectId: string }> } };
  expect(body.code).toBe("AMBIGUOUS_PROJECT");
  expect(body.details.value).toBe("겹침");
  expect(body.details.candidates.map((c) => c.projectId).sort()).toEqual([a.projectId, b.projectId].sort());
});

test("POST /search — 이름 범위는 번호 기억과 글자값 기억을 함께 찾고 appliedScope 로 알린다", async () => {
  const project = await store.findOrCreateProject({ name: "bara_system" });
  const embedding = await embedder.embed("배포 방법");
  const chained = await store.addNode({ content: "배포 방법은 deploy:a1 하나다", embedding, project_id: project.projectId });
  const legacy = await store.addNode({ content: "배포 방법: git push 는 A1 에 영향 없음", embedding, project_id: "bara_system" });
  const other = await store.addNode({ content: "배포 방법은 다른 프로젝트 규칙", embedding, project_id: "other" });
  const res = await search({ query: "배포 방법", scope: { projectId: "bara_system" }, responseMode: "index", limit: 50 });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { results: Array<{ id: number }>; appliedScope: { projectIds: string[]; resolvedFrom: string } };
  const ids = body.results.map((r) => r.id);
  expect(ids.sort((x, y) => x - y)).toEqual([chained, legacy].sort((x, y) => x - y));
  expect(ids).not.toContain(other);
  expect(body.appliedScope.projectIds).toEqual([project.projectId, "bara_system"]);
  expect(body.appliedScope.resolvedFrom).toBe("project_name");
});
