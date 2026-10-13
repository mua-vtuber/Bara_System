/**
 * search-project-unify-t7.test.ts — 분류 단계4 T7' 검증: project 검색 범용 색인 통일.
 *
 * 실질 통일은 T7'b 가 달성했다 — searchProjectsByFts/Vector 내부가 옛 전용
 * projects_fts/project_summary_vec 대신 범용 entities_fts/entities_vec 를 읽고
 * type_name='project' 로 거른다(메서드 이름·시그니처는 호출 의미상 유지). T7' 는 그
 * 통일을 검증으로 박고, unfiltered searchEntitiesByFts 로 전환하면 타입 혼입 회귀가
 * 난다는 사실을 가드로 남긴다(그래서 전환을 안 한다).
 *
 * 검증 두 축:
 *  (a) 10종 검색 누락 0 — 8타입·새 종류는 범용 entities_fts(searchEntitiesByFts)·project
 *      는 type 필터 통로(searchProjectsByFts)·person 은 전용 persons_fts(searchPersonsByFts·
 *      person A 보존)로 각자 잡힌다.
 *  (b) project 채널 타입 혼입 0 — 같은 검색 토큰을 가진 work 엔티티가 entities_fts 에
 *      함께 있어도 searchProjectsByFts 는 project entity_id 만 회신한다(type_name='project'
 *      필터). 이 필터가 사라지면(= unfiltered searchEntitiesByFts 로 전환) work id 가
 *      project 채널로 새어 getNodesByProjectId 에 잘못 먹는다 — 그 회귀를 이 단언이 막는다.
 *
 * 실 bun:sqlite(:memory:) + 실 Bgem3Embedder(1024) — Mock 0(CLAUDE.md). embeddingDim
 * 1024 명시(bge-m3 출력과 맞춤). person 통로(searchPersonsBy*·persons_fts)는 무변경 확인.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { SqliteMemoryStore } from "../store.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

describe("T7' — project 검색 범용 색인 통일 검증", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("(b) 타입 혼입 0 — 같은 토큰 work 가 entities_fts 에 있어도 searchProjectsByFts 는 project 만 회신", async () => {
    // project 와 work 엔티티가 같은 검색 토큰('통일테스트')을 공유하도록 둔다 — 둘 다
    // 범용 entities_fts 색인에 들어간다. searchProjectsByFts 는 type_name='project' 로
    // 걸러 project entity_id 만 회신해야 한다(work id 가 새면 project 채널이 깨진다).
    const project = await store.findOrCreateProject({ name: "통일테스트프로젝트" });
    const work = await store.entitiesRepo.findOrCreateEntity("work", "통일테스트작품");
    // 두 엔티티 다 entities_fts 합성 색인에 이름으로 들어간다(트리거 자동).

    const hits = await store.searchProjectsByFts("통일테스트", 20);
    const ids = hits.map((h) => h.projectId);
    // project 는 잡히고, work 는 절대 안 섞인다(type_name='project' 필터).
    expect(ids).toContain(project.projectId);
    expect(ids).not.toContain(work.id);
    // 회신은 전부 project entity_id(prj_ 접두사) — 다른 종류 id 0.
    expect(ids.every((id) => id.startsWith("prj_"))).toBe(true);
  });

  test("(b-vec) 타입 혼입 0 — searchProjectsByVector 도 project entity_id 만 회신", async () => {
    const project = await store.findOrCreateProject({ name: "벡터통일프로젝트" });
    await store.applyProjectEmbedding(project.projectId);
    const work = await store.entitiesRepo.findOrCreateEntity("work", "벡터통일작품");
    await store.entitiesRepo.applyEmbedding(work.id);

    const queryVec = await embedder.embed("벡터통일프로젝트");
    const hits = await store.searchProjectsByVector(queryVec, 20);
    const ids = hits.map((h) => h.projectId);
    expect(ids).toContain(project.projectId);
    expect(ids).not.toContain(work.id);
    expect(ids.every((id) => id.startsWith("prj_"))).toBe(true);
  });

  test("(a) 10종 검색 누락 0 — 8타입·새 종류·project·person 각 통로로 잡힌다", async () => {
    // 8 타입 엔티티 — 범용 entities_fts(searchEntitiesByFts)로 잡힌다.
    const work = await store.entitiesRepo.findOrCreateEntity("work", "누락검증작품");
    const place = await store.entitiesRepo.findOrCreateEntity("place", "누락검증장소");
    // project — type 필터 통로(searchProjectsByFts)로 잡힌다.
    const project = await store.findOrCreateProject({ name: "누락검증프로젝트" });
    // person — 전용 persons_fts(searchPersonsByFts·person A 보존)로 잡힌다.
    const person = await store.findOrCreatePersonByName("누락검증사람");

    // 8 타입·새 종류: 범용 검색이 work·place 를 잡는다(엔티티 자체 검색·entityHits 통로).
    const entHits = store.searchEntitiesByFts("누락검증", 50).map((h) => h.entityId);
    expect(entHits).toContain(work.id);
    expect(entHits).toContain(place.id);

    // project: 전용 이름 통로가 project 만 잡고 work·place 는 안 섞는다(타입 필터).
    const prjHits = (await store.searchProjectsByFts("누락검증", 50)).map((h) => h.projectId);
    expect(prjHits).toContain(project.projectId);
    expect(prjHits).not.toContain(work.id);

    // person: 전용 persons_fts 가 person 을 잡는다(범용 색인 무관·person A 보존).
    const psnHits = (await store.searchPersonsByFts("누락검증", 50)).map((h) => h.personId);
    expect(psnHits).toContain(person.personId);
  });

  test("project 가 범용 entities 본체에 산다(T7'b 통일 정합·dead projects 0)", async () => {
    const project = await store.findOrCreateProject({ name: "본체검증프로젝트" });
    // entities 에 type_name='project' 행으로 존재.
    const ent = db
      .query("SELECT type_name, name FROM entities WHERE entity_id = ?")
      .get(project.projectId) as { type_name: string; name: string } | null;
    expect(ent?.type_name).toBe("project");
    expect(ent?.name).toBe("본체검증프로젝트");
    // 옛 projects 전용 테이블은 단계4 T9'(v30)이 DROP 해 부재한다(본체가 거기 들어갈
    // 길 자체가 없다 — 옛 "행 0"보다 강한 보장).
    const deadTable = db
      .query("SELECT name FROM sqlite_master WHERE name = 'projects'")
      .get() as { name: string } | null;
    expect(deadTable).toBeNull();
  });
});
