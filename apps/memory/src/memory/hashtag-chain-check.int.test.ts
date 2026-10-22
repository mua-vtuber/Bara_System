/**
 * hashtag-chain-check — 실제 store 위의 판정과 실제 저장 결과 대조(2026-10-21 spec 12.4, B-T6).
 * 경고가 말하는 읽기가 저장 파이프라인의 실제 처리(project_id 가 붙었는지, 글 기억이 생겼는지)와
 * 같은지 본다. 실제 bge-m3 + 실제 SQLite(mock 없음).
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { EMBEDDING_DIMENSIONS } from "../embedding/factory.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { saveSharedMemoryInput } from "../server-internal/shared-memory-write.ts";
import { analyzeHashtagChain, checkProjectAmbiguityBeforeSave } from "./hashtag-chain-check.ts";
import { planProjectAttachment } from "./project-attachment-plan.ts";

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

function save(content: string) {
  return saveSharedMemoryInput(store, { content, source: "mcp", author: "claude-code", projectId: null, force: true });
}

function projectCount(): number {
  return (db.query("SELECT COUNT(*) AS n FROM entities WHERE type_name = 'project'").get() as { n: number }).n;
}

test("PROJECT_AMBIGUOUS — 별칭이 두 프로젝트에 겹치면 저장은 되고 프로젝트는 붙지 않는다", async () => {
  const a = await store.findOrCreateProject({ name: "알파 프로젝트" });
  const b = await store.findOrCreateProject({ name: "베타 프로젝트" });
  store.entitiesRepo.setKoAliases(a.projectId, ["겹침"]);
  store.entitiesRepo.setKoAliases(b.projectId, ["겹침"]);
  const content = "#프로젝트:겹침, 배포 순서를 정리했다";

  const ambiguousBeforeSave = await checkProjectAmbiguityBeforeSave(content, store);
  expect(ambiguousBeforeSave).toBe(true);
  const plan = await planProjectAttachment(store, content);
  const saved = await save(content);
  expect(saved.kind).toBe("memory");
  // 실제 저장 결과: 애매한 이름이라 글에 프로젝트가 붙지 않았다.
  expect((await store.getNode(saved.originNodeId!))!.projectId).toBeNull();

  const warnings = analyzeHashtagChain(content, { savedAs: "memory", projectPlan: plan, overriddenArgument: null });
  expect(warnings.map((w) => [w.code, w.tag])).toEqual([["PROJECT_AMBIGUOUS", "#프로젝트:겹침"]]);
  expect(warnings[0]!.readAs).toContain('"겹침"');

  // 타입 배치도 같은 이름·별칭 조회를 써서 애매한 이름으로 프로젝트 행을 만들지 않는다(2026-10-22 별칭
  // 갈라짐 결함 수정) — 저장 뒤에도 그 이름의 행이 없고 판정도 그대로 애매하다.
  expect(await store.findProjectByName("겹침")).toBeNull();
  expect(await checkProjectAmbiguityBeforeSave(content, store)).toBe(true);
});

test("PROJECT_NOT_CREATED — 분류에서 끝난 사슬은 프로젝트를 만들지 않는다", async () => {
  const content = "#프로젝트:코딩";
  const plan = await planProjectAttachment(store, content);
  const saved = await save(content);
  expect(saved.kind).toBe("entity_patch");
  expect(projectCount()).toBe(0);

  expect(await checkProjectAmbiguityBeforeSave(content, store)).toBe(false);
  const warnings = analyzeHashtagChain(content, { savedAs: "entity_patch", projectPlan: plan, overriddenArgument: null });
  expect(warnings.map((w) => w.code)).toEqual(["PROJECT_NOT_CREATED"]);
});

test("정상 사슬 — 경고 없음, 실제로 프로젝트가 붙는다", async () => {
  const content = "#프로젝트:코딩, #코딩:bara_system, 배포는 deploy:a1 하나로 한다";
  const ambiguousBeforeSave = await checkProjectAmbiguityBeforeSave(content, store);
  expect(ambiguousBeforeSave).toBe(false);
  const plan = await planProjectAttachment(store, content);
  const saved = await save(content);
  const project = await store.findProjectByName("bara_system");
  expect(project).not.toBeNull();
  expect((await store.getNode(saved.originNodeId!))!.projectId).toBe(project!.projectId);
  expect(analyzeHashtagChain(content, { savedAs: "memory", projectPlan: plan, overriddenArgument: null })).toEqual([]);
});

test("BODY_ABSORBED — 쉼표가 빠진 사슬은 실제로 엔티티 전용 입력이 되고 이상한 이름의 프로젝트가 생긴다", async () => {
  const content = "#프로젝트:코딩, #코딩:바라 배포 메모";
  const plan = await planProjectAttachment(store, content);
  const saved = await save(content);
  expect(saved.kind).toBe("entity_patch");
  expect(await store.findProjectByName("바라 배포 메모")).not.toBeNull();

  const warnings = analyzeHashtagChain(content, { savedAs: saved.kind, projectPlan: plan, overriddenArgument: null });
  expect(warnings.map((w) => [w.code, w.tag])).toEqual([["BODY_ABSORBED", "#코딩:바라 배포 메모"]]);
});
