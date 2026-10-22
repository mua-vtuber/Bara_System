/**
 * project-attachment-plan — 저장 전 예측 = 실제 저장 결과 (2026-10-21 spec 20.3, E-T8).
 * 실제 bge-m3 + 실제 SQLite 위에서 계획(planProjectAttachment)을 먼저 보고, 같은 글을 실제 저장 경로로 저장한 뒤
 * 기억의 project_id 가 계획과 같은지 본다(mock 없음).
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { EMBEDDING_DIMENSIONS } from "../embedding/factory.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { saveSharedMemoryInput } from "../server-internal/shared-memory-write.ts";
import { planProjectAttachment, predictWriteProject } from "./project-attachment-plan.ts";
import { resolveProjectDeclaration } from "./project-hashtag-resolver.ts";
import { parseHashtagEntities } from "./parsers/hashtag-entity-parser.ts";

let embedder: Bgem3Embedder;
let db: Database;
let store: SqliteMemoryStore;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"] });
  store = new SqliteMemoryStore(db, embedder);
});
afterEach(() => db.close());

async function saveAndReadProject(content: string, project: string | null = null): Promise<string | null> {
  const saved = await saveSharedMemoryInput(store, { content, source: "mcp", author: "t", projectId: project, force: true });
  expect(saved.kind).toBe("memory");
  return (await store.getNode(saved.originNodeId!))!.projectId;
}

test("none — 프로젝트 선언이 없으면 project 인자(또는 전역) 그대로", async () => {
  expect(await planProjectAttachment(store, "평범한 메모")).toEqual({ kind: "none" });
  expect(await saveAndReadProject("평범한 메모")).toBeNull();
  expect(await saveAndReadProject("인자만 있는 메모", "bara_system")).toBe("bara_system");
});

test("not_attached/ends_in_category — 폴더에서 끝난 사슬은 붙지 않고 인자 값이 남는다", async () => {
  const content = "#프로젝트:코딩, 분류만 적은 메모";
  expect(await planProjectAttachment(store, content)).toEqual({ kind: "not_attached", reason: "ends_in_category", name: "코딩" });
  expect(await saveAndReadProject(content, "옛값")).toBe("옛값");
});

test("not_attached/ambiguous — 별칭이 둘 이상과 겹치면 붙지 않는다", async () => {
  const a = await store.findOrCreateProject({ name: "알파" });
  const b = await store.findOrCreateProject({ name: "베타" });
  store.entitiesRepo.setKoAliases(a.projectId, ["겹침"]);
  store.entitiesRepo.setKoAliases(b.projectId, ["겹침"]);
  const content = "#프로젝트:겹침, 배포 메모";
  expect(await planProjectAttachment(store, content)).toEqual({ kind: "not_attached", reason: "ambiguous", name: "겹침" });
  expect(await saveAndReadProject(content)).toBeNull();
});

test("existing — 기존 프로젝트에 붙고 project 인자를 덮어쓴다", async () => {
  const project = await store.findOrCreateProject({ name: "bara_system" });
  const content = "#프로젝트:코딩, #코딩:bara_system, 배포 메모";
  expect(await planProjectAttachment(store, content)).toEqual({ kind: "existing", projectId: project.projectId, name: "bara_system" });
  expect(await saveAndReadProject(content, "다른값")).toBe(project.projectId);
});

test("new — 저장이 그 이름으로 프로젝트를 만들어 붙인다", async () => {
  const content = "#프로젝트:코딩, #코딩:새프로젝트, 첫 메모";
  expect(await planProjectAttachment(store, content)).toEqual({ kind: "new", name: "새프로젝트" });
  const projectId = await saveAndReadProject(content);
  expect(projectId).toBe((await store.findProjectByName("새프로젝트"))!.projectId);
});

test("resolveProjectDeclaration 은 같은 계획을 따른다(붙지 않는 계획이면 project_id 없음)", async () => {
  const project = await store.findOrCreateProject({ name: "bara_system" });
  for (const [content, expected] of [
    ["#프로젝트:코딩, #코딩:bara_system, 본문", project.projectId],
    ["#프로젝트:코딩, 본문", null],
    ["본문만", null],
  ] as const) {
    const resolved = await resolveProjectDeclaration(store, content, parseHashtagEntities(content).projectDeclarations, null);
    expect(`${content}: ${resolved.projectId}`).toBe(`${content}: ${expected}`);
  }
});

test("두 번째 프로젝트 사슬은 글에 붙지 않지만 프로젝트 행은 생긴다(안내·경고 문구 M1 의 근거)", async () => {
  const content = "#프로젝트:첫째, #프로젝트:둘째, 두 사슬 메모";
  expect(await planProjectAttachment(store, content)).toEqual({ kind: "new", name: "첫째" });
  const projectId = await saveAndReadProject(content);
  expect(projectId).toBe((await store.findProjectByName("첫째"))!.projectId);
  expect(await store.findProjectByName("둘째")).not.toBeNull();
});

test("predictWriteProject — 사슬이 이기고, 다른 프로젝트의 인자만 덮어씀으로 표시한다", async () => {
  const project = await store.findOrCreateProject({ name: "bara_system" });
  const content = "#프로젝트:코딩, #코딩:bara_system, 본문";
  const sameByName = await predictWriteProject(store, content, "bara_system");
  expect(sameByName).toMatchObject({ source: "chain", overriddenArgument: null });
  expect(sameByName.group!.projectIds).toContain(project.projectId);
  expect((await predictWriteProject(store, content, project.projectId)).overriddenArgument).toBeNull();
  expect((await predictWriteProject(store, content, "다른값")).overriddenArgument).toBe("다른값");
  expect(await predictWriteProject(store, "본문만", null)).toMatchObject({ source: "none", group: null, overriddenArgument: null });
  expect((await predictWriteProject(store, "#프로젝트:코딩, #코딩:새것, 본문", "새것")).overriddenArgument).toBeNull();
});
