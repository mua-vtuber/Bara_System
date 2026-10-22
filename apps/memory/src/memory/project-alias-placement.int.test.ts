/**
 * project-alias-placement — 별칭으로 쓴 프로젝트 사슬이 프로젝트를 둘로 가르지 않는다 (2026-10-22 결함).
 *
 * 결함: 글을 프로젝트에 붙이는 단계는 별칭까지 보는데(findProjectByNameOrAlias), 그래프 배치 단계는
 * 이름만 보고 findOrCreateEntity 로 같은 이름의 프로젝트를 하나 더 만들었다. 그래서 두 번째 저장부터
 * 이름이 정확히 맞는 새 프로젝트로 붙어 기억이 갈라졌다. 실제 bge-m3 + 실제 SQLite + 실제 저장 경로로
 * 그 순서를 그대로 재현한다(mock 없음).
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { EMBEDDING_DIMENSIONS } from "../embedding/factory.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { saveSharedMemoryInput } from "../server-internal/shared-memory-write.ts";
import { createEntityRow } from "./entity-row-gate.ts";
import { resolveRelationTarget } from "./entity-relation-target.ts";
import type { RelationSpec } from "./entity-relation-vocabulary.ts";

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

async function saveAndReadProject(content: string): Promise<string | null> {
  const saved = await saveSharedMemoryInput(store, { content, source: "mcp", author: "t", projectId: null, force: true });
  expect(saved.kind).toBe("memory");
  return (await store.getNode(saved.originNodeId!))!.projectId;
}

test("별칭 사슬을 두 번 저장해도 같은 이름의 프로젝트가 새로 생기지 않고 둘 다 원래 프로젝트에 붙는다", async () => {
  const project = await store.findOrCreateProject({ name: "bara_system" });
  store.entitiesRepo.setKoAliases(project.projectId, ["바라"]);

  const first = await saveAndReadProject("#프로젝트:코딩, #코딩:바라, 첫 배포 메모");
  const second = await saveAndReadProject("#프로젝트:코딩, #코딩:바라, 두 번째 배포 메모");

  expect(first).toBe(project.projectId);
  expect(second).toBe(project.projectId);
  expect(await store.findProjectByName("바라")).toBeNull();
  expect((await store.listProjects()).map((p) => p.projectId)).toEqual([project.projectId]);
  // 그래프: 별칭 이름의 개념 노드가 따로 생기지 않는다(사슬 분류 '코딩'만 개념).
  expect(await store.findConceptByName("바라")).toBeNull();
  expect(await store.findConceptByName("코딩")).not.toBeNull();
});

test("createEntityRow 도 별칭이면 기존 프로젝트를 쓰고, 애매하면 이름을 대며 던진다", async () => {
  const project = await store.findOrCreateProject({ name: "bara_system" });
  store.entitiesRepo.setKoAliases(project.projectId, ["바라"]);
  expect((await createEntityRow(store, "project", "바라")).id).toBe(project.projectId);

  const other = await store.findOrCreateProject({ name: "다른것" });
  store.entitiesRepo.setKoAliases(other.projectId, ["바라"]);
  await expect(createEntityRow(store, "project", "바라")).rejects.toThrow("'바라'");
  expect(await store.listProjects()).toHaveLength(2);
});

test("관계 대상이 project 일 때도 별칭은 기존 프로젝트로, 애매한 이름은 관계를 건너뛴다", async () => {
  const spec: RelationSpec = {
    relation: "소속", sourceTypes: ["person"], targetTypes: ["project"], defaultTargetType: "project",
  };
  const project = await store.findOrCreateProject({ name: "bara_system" });
  store.entitiesRepo.setKoAliases(project.projectId, ["바라"]);
  expect(await resolveRelationTarget(store, spec, "바라")).toEqual({
    type: "project", id: project.projectId, name: "bara_system",
  });

  const other = await store.findOrCreateProject({ name: "다른것" });
  store.entitiesRepo.setKoAliases(other.projectId, ["바라"]);
  const skipped = await resolveRelationTarget(store, spec, "바라");
  expect(skipped).toMatchObject({ skipped: true });
  expect(await store.listProjects()).toHaveLength(2);
});

test("별칭이 여러 프로젝트에 겹치면 그 이름으로 프로젝트를 새로 만들지 않는다", async () => {
  const a = await store.findOrCreateProject({ name: "알파" });
  const b = await store.findOrCreateProject({ name: "베타" });
  store.entitiesRepo.setKoAliases(a.projectId, ["겹침"]);
  store.entitiesRepo.setKoAliases(b.projectId, ["겹침"]);

  expect(await saveAndReadProject("#프로젝트:코딩, #코딩:겹침, 배포 메모")).toBeNull();
  expect(await store.findProjectByName("겹침")).toBeNull();
  expect((await store.listProjects()).map((p) => p.projectId).sort()).toEqual([a.projectId, b.projectId].sort());
});

test("어디에도 없는 이름은 지금처럼 한 번만 만들고 다음 저장도 같은 프로젝트에 붙는다", async () => {
  const first = await saveAndReadProject("#프로젝트:코딩, #코딩:새프로젝트, 첫 메모");
  const second = await saveAndReadProject("#프로젝트:코딩, #코딩:새프로젝트, 둘째 메모");

  const created = await store.findProjectByName("새프로젝트");
  expect(created).not.toBeNull();
  expect(first).toBe(created!.projectId);
  expect(second).toBe(created!.projectId);
  expect(await store.listProjects()).toHaveLength(1);
});
