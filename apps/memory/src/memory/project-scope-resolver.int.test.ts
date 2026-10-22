/**
 * memory/project-scope-resolver.int.test.ts — 읽기 범위 해석기 (2026-10-21 spec C-T1).
 *
 * 실제 SQLite + 실제 bge-m3 store 로 해석 순서 6단계를 검증한다: 번호 → 이름·별칭(+같은
 * 글자 옛 값) → 모호 → 옛 글자값 단독 → 모름, null → 전역, 범위 없음 → 입구별 기본값.
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { EMBEDDING_DIMENSIONS } from "../embedding/factory.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import {
  GLOBAL_READ_SCOPE, legacyProjectValues, PROJECT_SCOPE_MESSAGES, ProjectScopeError, projectGroupForWrite,
  resolveMemoryReadScope, SCOPE_NOTE_WHEN_ABSENT, scopeNoteFields,
} from "./project-scope-resolver.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let db: Database;
let store: SqliteMemoryStore;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"] });
  store = new SqliteMemoryStore(db, embedder);
});
afterEach(() => db.close());

async function rejection(promise: Promise<unknown>): Promise<ProjectScopeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProjectScopeError) return error;
    throw error;
  }
  throw new Error("expected ProjectScopeError, but the scope resolved");
}

test("범위 없음 → 입구별 기본값: unfiltered 는 거름 없음, global 은 프로젝트 없는 기억만", async () => {
  expect(await resolveMemoryReadScope(store, undefined, "unfiltered")).toBeUndefined();
  expect(await resolveMemoryReadScope(store, undefined, "global")).toEqual(GLOBAL_READ_SCOPE);
  expect(GLOBAL_READ_SCOPE).toEqual({
    projectIds: null, includeGlobal: false, requested: null, resolvedFrom: "global", projectName: null,
  });
});

test("projectId null → 전역(기본값과 상관없이)", async () => {
  const resolved = await resolveMemoryReadScope(store, { projectId: null }, "unfiltered");
  expect(resolved?.projectIds).toBeNull();
  expect(resolved?.resolvedFrom).toBe("global");
});

test("프로젝트 번호 → 그 프로젝트 + 이름과 같은 글자로 저장된 옛 값", async () => {
  const project = await store.findOrCreateProject({ name: "bara_system" });
  await store.addNode({ content: "옛 글자값으로 저장한 기억", project_id: "bara_system" });
  const resolved = await resolveMemoryReadScope(store, { projectId: project.projectId, includeGlobal: true }, "global");
  expect(resolved).toEqual({
    projectIds: [project.projectId, "bara_system"], includeGlobal: true,
    requested: project.projectId, resolvedFrom: "project_id", projectName: "bara_system",
  });
});

test("이름 → 프로젝트 번호 + 실제로 쓰이는 이름·별칭 글자값만(안 쓰인 별칭은 빠짐)", async () => {
  const project = await store.findOrCreateProject({ name: "bara_system" });
  store.entitiesRepo.setKoAliases(project.projectId, ["바라"]);
  store.entitiesRepo.setEnAliases(project.projectId, ["bara"]);
  await store.addNode({ content: "이름 글자값 기억", project_id: "bara_system" });
  await store.addNode({ content: "별칭 글자값 기억", project_id: "바라" });
  const resolved = await resolveMemoryReadScope(store, { projectId: "bara_system" }, "unfiltered");
  expect(resolved?.resolvedFrom).toBe("project_name");
  expect(resolved?.projectName).toBe("bara_system");
  expect(resolved?.includeGlobal).toBe(false);
  // "bara" 별칭은 어떤 기억에도 저장되지 않아 묶음에 넣지 않는다.
  expect(resolved?.projectIds).toEqual([project.projectId, "bara_system", "바라"]);
});

test("별칭 → 같은 프로젝트(project_alias), NFD 로 저장된 옛 글자값도 같은 글자로 묶는다", async () => {
  const project = await store.findOrCreateProject({ name: "바라시스템" });
  store.entitiesRepo.setKoAliases(project.projectId, ["바라"]);
  const nfd = "바라".normalize("NFD");
  await store.addNode({ content: "NFD 별칭으로 저장된 기억", project_id: nfd });
  const resolved = await resolveMemoryReadScope(store, { projectId: "바라" }, "unfiltered");
  expect(resolved?.resolvedFrom).toBe("project_alias");
  expect(resolved?.projectName).toBe("바라시스템");
  expect(resolved?.projectIds).toEqual([project.projectId, nfd]);
  expect(legacyProjectValues(store, { projectId: project.projectId, name: "바라시스템", koAliases: ["바라"], enAliases: [] }))
    .toEqual([nfd]);
});

test("별칭이 두 프로젝트에 겹치면 AMBIGUOUS_PROJECT — 후보 번호·이름을 싣는다", async () => {
  const a = await store.findOrCreateProject({ name: "알파" });
  const b = await store.findOrCreateProject({ name: "베타" });
  store.entitiesRepo.setKoAliases(a.projectId, ["겹침"]);
  store.entitiesRepo.setKoAliases(b.projectId, ["겹침"]);
  const error = await rejection(resolveMemoryReadScope(store, { projectId: "겹침" }, "global"));
  expect(error.code).toBe("AMBIGUOUS_PROJECT");
  expect(error.value).toBe("겹침");
  const candidates = [...error.candidates].sort((x, y) => x.name.localeCompare(y.name));
  expect(candidates).toEqual([
    { projectId: a.projectId, name: "알파" }, { projectId: b.projectId, name: "베타" },
  ].sort((x, y) => x.name.localeCompare(y.name)));
  expect(error.message).toBe(PROJECT_SCOPE_MESSAGES.AMBIGUOUS_PROJECT("겹침", error.candidates));
  expect(error.toPayload()).toEqual({
    code: "AMBIGUOUS_PROJECT", message: error.message, details: { value: "겹침", candidates: error.candidates },
  });
});

test("프로젝트 실체 없이 글자값으로만 저장된 값 → legacy_value 단독 범위", async () => {
  await store.addNode({ content: "옛 프로젝트 기억", project_id: "old-project" });
  const resolved = await resolveMemoryReadScope(store, { projectId: "old-project", includeGlobal: true }, "unfiltered");
  expect(resolved).toEqual({
    projectIds: ["old-project"], includeGlobal: true, requested: "old-project",
    resolvedFrom: "legacy_value", projectName: null,
  });
});

test("모르는 값 → UNKNOWN_PROJECT(값을 밝힘). 빈 결과·전역으로 바꾸지 않는다", async () => {
  await store.findOrCreateProject({ name: "bara_system" });
  const error = await rejection(resolveMemoryReadScope(store, { projectId: "bara_systm" }, "global"));
  expect(error.code).toBe("UNKNOWN_PROJECT");
  expect(error.value).toBe("bara_systm");
  expect(error.message).toBe(
    'No project matches scope.projectId "bara_systm". Call get_usage_guide for project names and ids.',
  );
  expect(error.toPayload()).toEqual({ code: "UNKNOWN_PROJECT", message: error.message, details: { value: "bara_systm" } });
});

test("다른 종류 엔티티 번호는 프로젝트 번호로 받지 않는다", async () => {
  const work = await store.entitiesRepo.findOrCreateEntity("work", "괴담 모음");
  const error = await rejection(resolveMemoryReadScope(store, { projectId: work.id }, "unfiltered"));
  expect(error.code).toBe("UNKNOWN_PROJECT");
});

test("scopeNote 는 범위를 안 준 호출에만 실린다", () => {
  expect(scopeNoteFields(undefined)).toEqual({ scopeNote: SCOPE_NOTE_WHEN_ABSENT });
  expect(scopeNoteFields({ projectId: null })).toEqual({});
  expect(scopeNoteFields({ projectId: "bara_system" })).toEqual({});
});

// ── projectGroupForWrite — 저장 쪽 "같은 프로젝트" 묶음(spec 20.4 표 네 경우, E-T9) ──────────

test("projectGroupForWrite: 번호·이름·별칭은 읽기 해석기와 같은 묶음(번호 + 같은 글자 옛 값)", async () => {
  const project = await store.findOrCreateProject({ name: "bara_system" });
  store.entitiesRepo.setKoAliases(project.projectId, ["바라"]);
  await store.addNode({ content: "옛 글자값 기억", project_id: "bara_system" });
  const read = await resolveMemoryReadScope(store, { projectId: "bara_system" }, "unfiltered");
  for (const value of [project.projectId, "bara_system", "바라"]) {
    const group = await projectGroupForWrite(store, { kind: "value", value });
    for (const id of read!.projectIds!) expect(`${value}: ${group.projectIds.includes(id)}`).toBe(`${value}: true`);
    expect(group).toMatchObject({ label: "bara_system", projectName: "bara_system", projectId: project.projectId });
  }
});

test("projectGroupForWrite: 둘 이상과 겹치는 값은 던지지 않고 그 글자값만", async () => {
  const a = await store.findOrCreateProject({ name: "알파" });
  const b = await store.findOrCreateProject({ name: "베타" });
  store.entitiesRepo.setKoAliases(a.projectId, ["겹침"]);
  store.entitiesRepo.setKoAliases(b.projectId, ["겹침"]);
  expect(await projectGroupForWrite(store, { kind: "value", value: "겹침" }))
    .toEqual({ projectIds: ["겹침"], label: "겹침", projectName: null, projectId: null });
});

test("projectGroupForWrite: 프로젝트도 옛 값도 아닌 새 값은 던지지 않고 그 글자값", async () => {
  expect(await projectGroupForWrite(store, { kind: "value", value: "처음보는값" }))
    .toEqual({ projectIds: ["처음보는값"], label: "처음보는값", projectName: null, projectId: null });
});

test("projectGroupForWrite: 사슬이 새로 만들 프로젝트는 같은 이름으로 실제 쓰이는 옛 글자값들", async () => {
  expect((await projectGroupForWrite(store, { kind: "new_project", name: "새프로젝트" })).projectIds).toEqual([]);
  await store.addNode({ content: "옛 글자값 기억", project_id: "새프로젝트" });
  expect(await projectGroupForWrite(store, { kind: "new_project", name: "새프로젝트" }))
    .toEqual({ projectIds: ["새프로젝트"], label: "새프로젝트", projectName: "새프로젝트", projectId: null });
});
