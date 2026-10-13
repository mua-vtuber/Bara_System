import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { EntitiesRepository } from "./entities-repository.ts";
import { EntityTypeRegistryDb } from "./entity-type-registry-db.ts";
import { PROJECT_STATUSES, ProjectRepository } from "./project-repository.ts";

const TEST_PROVENANCE = "system" as const;
const TEST_SOURCE_NODE_ID = null;

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

/** db 한 개에 entitiesRepo + projectRepo 를 묶어 만든다(단계4 T7'b 통합 토대). */
function makeRepo(db: Database): ProjectRepository {
  const registry = new EntityTypeRegistryDb(db);
  const entitiesRepo = new EntitiesRepository(db, embedder, registry);
  return new ProjectRepository(db, entitiesRepo);
}

/** FK 충족용 — 실제 concept_nodes 행을 직접 삽입(개념 id 반환). */
function insertConcept(db: Database, conceptId: string, name: string): string {
  db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES (?, ?)").run(
    conceptId,
    name,
  );
  return conceptId;
}

/** FK 충족용 — 실제 persons 행을 직접 삽입(사람 id 반환). */
function insertPerson(db: Database, personId: string, name: string): string {
  db.prepare("INSERT INTO persons (person_id, display_name) VALUES (?, ?)").run(
    personId,
    name,
  );
  return personId;
}

/**
 * 단계4 T9'(v30) 후 죽은 전용 테이블이 sqlite_master 에 부재인지 확인용. 옛 테스트는
 * "옛 테이블 행 0" 으로 본체가 안 들어감을 봤으나, v30 이 그 테이블을 DROP 했으므로
 * 이제는 "테이블 자체 부재"가 더 강한 보장이다(코드가 쓸 테이블이 없다).
 */
function deadTableAbsent(db: Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE name = ?")
    .get(name) as { name: string } | null;
  return row === null;
}

/** entities(type_name='project') 행 개수 — 본체가 범용 테이블로 옮겨졌는지 확인용. */
function entityProjectCount(db: Database): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM entities WHERE type_name = 'project'",
      )
      .get() as { c: number }
  ).c;
}

/** 한 프로젝트(entity_id)의 예약 칸 값 — 없으면 undefined. */
function attrValue(
  db: Database,
  projectId: string,
  key: string,
): string | undefined {
  const row = db
    .prepare(
      "SELECT attr_value FROM entity_attributes WHERE entity_id = ? AND attr_key = ?",
    )
    .get(projectId, key) as { attr_value: string } | null;
  return row?.attr_value;
}

describe("ProjectRepository — entities(type_name='project') 통합 CRUD (T7'b)", () => {
  let db: Database;
  let repo: ProjectRepository;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    repo = makeRepo(db);
  });
  afterEach(() => {
    db.close();
  });

  test("findOrCreateProject — 본체가 projects 가 아니라 entities(type_name='project')에 산다", async () => {
    const p = await repo.findOrCreateProject({ name: "바라시스템" });
    expect(p.projectId.startsWith("prj_")).toBe(true);
    // 본체는 entities 에 산다. 옛 projects 전용 테이블은 단계4 T9'(v30)이 DROP 해 부재한다
    // (쓸 테이블이 없으니 본체가 거기 들어갈 길 자체가 없다 — 옛 "행 0"보다 강한 보장).
    expect(entityProjectCount(db)).toBe(1);
    expect(deadTableAbsent(db, "projects")).toBe(true);
    const entRow = db
      .prepare("SELECT type_name FROM entities WHERE entity_id = ?")
      .get(p.projectId) as { type_name: string };
    expect(entRow.type_name).toBe("project");
  });

  test("findOrCreateProject — 같은 이름 두 번이면 같은 prj_ id (재사용, 새 행 X)", async () => {
    const first = await repo.findOrCreateProject({ name: "바라시스템" });
    const second = await repo.findOrCreateProject({ name: "바라시스템" });
    expect(first.projectId).toBe(second.projectId);
    expect(first.projectId.startsWith("prj_")).toBe(true);
    expect(entityProjectCount(db)).toBe(1);
    const all = await repo.listProjects();
    expect(all.length).toBe(1);
  });

  test("findOrCreateProject — name 앞뒤 공백 정규화(같은 이름으로 재사용)", async () => {
    const a = await repo.findOrCreateProject({ name: "  바라  " });
    const b = await repo.findOrCreateProject({ name: "바라" });
    expect(a.projectId).toBe(b.projectId);
    expect(a.name).toBe("바라");
  });

  test("findOrCreateProject — status 미지정이면 active, summary 보존 + 칸 저장 확인", async () => {
    const p = await repo.findOrCreateProject({
      name: "메모리 모듈",
      summary: "어디든 붙는 메모리 모듈",
    });
    expect(p.status).toBe("active");
    expect(p.summary).toBe("어디든 붙는 메모리 모듈");
    expect(p.attributes).toEqual({});
    expect(p.embeddingText).toBeNull();
    // status·summary 는 칸(is_column=1)으로 저장돼 합성 색인 본문에 합류한다.
    expect(attrValue(db, p.projectId, "status")).toBe("active");
    expect(attrValue(db, p.projectId, "summary")).toBe("어디든 붙는 메모리 모듈");
  });

  test("findOrCreateProject — 재사용 행은 옛 summary 를 덮지 않는다", async () => {
    const first = await repo.findOrCreateProject({
      name: "재사용",
      summary: "처음 요약",
    });
    const second = await repo.findOrCreateProject({
      name: "재사용",
      summary: "두 번째 요약(무시돼야 함)",
    });
    expect(second.projectId).toBe(first.projectId);
    expect(second.summary).toBe("처음 요약");
  });

  test("빈 이름 = throw (silent fallback 금지)", async () => {
    await expect(repo.findOrCreateProject({ name: "" })).rejects.toThrow(
      /비어 있을 수 없다|non-empty/,
    );
    await expect(repo.findOrCreateProject({ name: "   " })).rejects.toThrow(
      /비어 있을 수 없다|non-empty/,
    );
  });

  test("잘못된 status 입력 = throw", async () => {
    await expect(
      repo.findOrCreateProject({
        name: "테스트",
        status: "bogus" as never,
      }),
    ).rejects.toThrow(/invalid project status/);
  });

  test("PROJECT_STATUSES = active/done/paused 단일 출처", () => {
    expect(PROJECT_STATUSES).toEqual(["active", "done", "paused"]);
  });

  test("getProject / findProjectByName — 정확 매칭, 없으면 null", async () => {
    const p = await repo.findOrCreateProject({ name: "주술회전 위키" });
    expect((await repo.getProject(p.projectId))?.name).toBe("주술회전 위키");
    expect((await repo.findProjectByName("주술회전 위키"))?.projectId).toBe(
      p.projectId,
    );
    expect(await repo.getProject("prj_nope")).toBeNull();
    expect(await repo.findProjectByName("없는 프로젝트")).toBeNull();
  });

  test("findProjectByNameOrAlias — 별칭으로 기존 프로젝트를 조회한다", async () => {
    const p = await repo.findOrCreateProject({ name: "바라시스템" });
    const entityRepo = new EntitiesRepository(db, embedder, new EntityTypeRegistryDb(db));
    entityRepo.setKoAliases(p.projectId, ["바라"]);

    const lookup = await repo.findProjectByNameOrAlias("바라");
    expect(lookup.ambiguous).toBe(false);
    expect(lookup.project?.projectId).toBe(p.projectId);

    const missing = await repo.findProjectByNameOrAlias("없는 별칭");
    expect(missing).toEqual({ project: null, ambiguous: false });
  });

  test("getProject — 다른 종류 entity_id 는 project 로 안 잡힌다(null)", async () => {
    // person·새 종류 등 비-project 본체를 project getter 로 읽으면 null(혼선 방지).
    const reg = new EntityTypeRegistryDb(db);
    const entitiesRepo = new EntitiesRepository(db, embedder, reg);
    const work = await entitiesRepo.findOrCreateEntity("work", "어떤 작품");
    expect(await repo.getProject(work.id)).toBeNull();
  });

  test("getProject — full Project 재조립(모든 칸)", async () => {
    const p = await repo.findOrCreateProject({
      name: "전체 칸",
      summary: "요약문",
    });
    await repo.updateProject(p.projectId, {
      status: "done",
      attributes: { repo: "https://example.test/x" },
      embeddingText: "임베딩 본문",
    });
    const got = await repo.getProject(p.projectId);
    expect(got).not.toBeNull();
    expect(got!.projectId).toBe(p.projectId);
    expect(got!.name).toBe("전체 칸");
    expect(got!.summary).toBe("요약문");
    expect(got!.status).toBe("done");
    expect(got!.attributes).toEqual({ repo: "https://example.test/x" });
    expect(got!.embeddingText).toBe("임베딩 본문");
    expect(typeof got!.createdAt).toBe("string");
    expect(typeof got!.updatedAt).toBe("string");
  });

  test("updateProject — summary/status/attributes 부분 갱신 + updated_at 갱신", async () => {
    const p = await repo.findOrCreateProject({ name: "변경 대상" });
    const updated = await repo.updateProject(p.projectId, {
      summary: "갱신된 정체성",
      status: "done",
      attributes: { repo: "https://example.test/x" },
    });
    expect(updated).not.toBeNull();
    expect(updated!.summary).toBe("갱신된 정체성");
    expect(updated!.status).toBe("done");
    expect(updated!.attributes).toEqual({ repo: "https://example.test/x" });
    // attributes_json 은 라벨(is_column=0)이라 검색 합성 본문에 안 들어간다(Q5).
    const isCol = db
      .prepare(
        "SELECT is_column FROM entity_attributes WHERE entity_id = ? AND attr_key = 'attributes_json'",
      )
      .get(p.projectId) as { is_column: number };
    expect(isCol.is_column).toBe(0);
    expect(updated!.updatedAt >= p.createdAt).toBe(true);
  });

  test("updateProject — 미존재 id 면 null (throw 아님)", async () => {
    expect(await repo.updateProject("prj_nope", { status: "paused" })).toBeNull();
  });

  test("updateProject — 잘못된 status 면 throw", async () => {
    const p = await repo.findOrCreateProject({ name: "상태 검증" });
    await expect(
      repo.updateProject(p.projectId, { status: "wrong" as never }),
    ).rejects.toThrow(/invalid project status/);
  });

  test("listProjects — status 필터 + 잘못된 status throw", async () => {
    const a = await repo.findOrCreateProject({ name: "A", status: "active" });
    const b = await repo.findOrCreateProject({ name: "B" });
    await repo.updateProject(b.projectId, { status: "done" });

    const actives = await repo.listProjects({ status: "active" });
    expect(actives.map((p) => p.projectId)).toContain(a.projectId);
    expect(actives.map((p) => p.projectId)).not.toContain(b.projectId);

    const dones = await repo.listProjects({ status: "done" });
    expect(dones.map((p) => p.projectId)).toContain(b.projectId);

    expect((await repo.listProjects()).length).toBe(2);
    await expect(
      repo.listProjects({ status: "bad" as never }),
    ).rejects.toThrow(/invalid project status/);
  });
});

describe("ProjectRepository — 요약 임베딩 (범용 entities_vec · 실 bge-m3)", () => {
  let db: Database;
  let repo: ProjectRepository;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    repo = makeRepo(db);
  });
  afterEach(() => {
    db.close();
  });

  /** 프로젝트 임베딩이 범용 entities_vec 에 들어갔는지 — entities.rowid 로 센다. */
  function vecCount(projectId: string): number {
    const rid = (
      db
        .prepare("SELECT rowid FROM entities WHERE entity_id=?")
        .get(projectId) as { rowid: number }
    ).rowid;
    return (
      db
        .prepare("SELECT COUNT(*) AS c FROM entities_vec WHERE entity_rowid=?")
        .get(rid) as { c: number }
    ).c;
  }

  test("applyProjectEmbedding — summary 로 entities_vec 1행 적재", async () => {
    const p = await repo.findOrCreateProject({
      name: "주술회전 위키",
      summary: "주술회전 캐릭터·설정 보관소",
    });
    expect(await repo.applyProjectEmbedding(p.projectId)).toBe(true);
    expect(vecCount(p.projectId)).toBe(1);
    // 옛 전용 색인 project_summary_vec 는 단계4 T9'(v30)이 DROP 해 부재한다 — 적재가
    // 범용 entities_vec 로만 흐른다(쓸 옛 색인이 없다).
    expect(deadTableAbsent(db, "project_summary_vec")).toBe(true);
  });

  test("applyProjectEmbedding — summary 없으면 name 으로 적재", async () => {
    const p = await repo.findOrCreateProject({ name: "이름만 있는 프로젝트" });
    expect(await repo.applyProjectEmbedding(p.projectId)).toBe(true);
    expect(vecCount(p.projectId)).toBe(1);
  });

  test("applyProjectEmbedding — embedding_text 포함 적재", async () => {
    const p = await repo.findOrCreateProject({ name: "우선순위", summary: "요약" });
    await repo.updateProject(p.projectId, { embeddingText: "명시 임베딩 본문" });
    expect(await repo.applyProjectEmbedding(p.projectId)).toBe(true);
    expect(vecCount(p.projectId)).toBe(1);
  });

  test("applyProjectEmbedding — 재적재 시 1행 유지(DELETE+INSERT)", async () => {
    const p = await repo.findOrCreateProject({ name: "재적재", summary: "처음" });
    await repo.applyProjectEmbedding(p.projectId);
    await repo.updateProject(p.projectId, { summary: "바뀐 요약" });
    await repo.applyProjectEmbedding(p.projectId);
    expect(vecCount(p.projectId)).toBe(1);
  });

  test("applyProjectEmbedding — 미존재 id 면 throw (silent fallback 금지)", async () => {
    await expect(repo.applyProjectEmbedding("prj_nope")).rejects.toThrow(
      /not found/,
    );
  });

  test("같은 프로젝트 임베딩 = 검색어와 가장 가까운 프로젝트(entities_vec KNN 최근접)", async () => {
    const a = await repo.findOrCreateProject({
      name: "주술회전 위키",
      summary: "주술회전 캐릭터 설정",
    });
    const b = await repo.findOrCreateProject({
      name: "날씨 기록",
      summary: "매일 날씨 메모",
    });
    await repo.applyProjectEmbedding(a.projectId);
    await repo.applyProjectEmbedding(b.projectId);

    const q = await embedder.embed("주술회전 캐릭터 설정");
    const hits = db
      .prepare(
        "SELECT entity_rowid, distance FROM entities_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 2",
      )
      .all(q) as Array<{ entity_rowid: number; distance: number }>;
    expect(hits.length).toBeGreaterThan(0);
    const topId = (
      db
        .prepare("SELECT entity_id FROM entities WHERE rowid=?")
        .get(hits[0]!.entity_rowid) as { entity_id: string }
    ).entity_id;
    expect(topId).toBe(a.projectId);
  });
});

describe("ProjectRepository — 엣지(통합 entity_concept_edges) + 참여자(entity_relation_edges participated_by)", () => {
  let db: Database;
  let repo: ProjectRepository;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    repo = makeRepo(db);
  });
  afterEach(() => {
    db.close();
  });

  test("addProjectConceptEdge — 통합 entity_concept_edges 에 저장 + 중복은 false", async () => {
    const p = await repo.findOrCreateProject({ name: "라벨 대상" });
    const cid = insertConcept(db, "cpt_ts", "typescript");

    expect(await repo.addProjectConceptEdge(p.projectId, cid, "tag", TEST_PROVENANCE, TEST_SOURCE_NODE_ID)).toBe(true);
    expect(
      await repo.addProjectConceptEdge(p.projectId, cid, "classification", TEST_PROVENANCE, TEST_SOURCE_NODE_ID),
    ).toBe(true);
    expect(await repo.addProjectConceptEdge(p.projectId, cid, "tag", "hashtag", 999)).toBe(
      false,
    ); // 중복

    // 엣지가 옛 project_concept_edges 가 아니라 통합 entity_concept_edges 에 산다. 옛
    // 전용 엣지는 단계4 T9'(v30)이 DROP 해 부재한다(쓸 옛 테이블이 없다).
    expect(deadTableAbsent(db, "project_concept_edges")).toBe(true);
    const unifiedCount = db
      .prepare(
        "SELECT COUNT(*) AS c FROM entity_concept_edges WHERE entity_id = ?",
      )
      .get(p.projectId) as { c: number };
    expect(unifiedCount.c).toBe(2);
    const tagRow = db
      .prepare(
        `SELECT provenance, source_node_id FROM entity_concept_edges
         WHERE entity_id = ? AND concept_id = ? AND role = 'tag'`,
      )
      .get(p.projectId, cid) as { provenance: string; source_node_id: number | null };
    expect(tagRow.provenance).toBe("system");
    expect(tagRow.source_node_id).toBeNull();

    const labels = await repo.listProjectConcepts(p.projectId);
    expect(labels.length).toBe(2);
    expect(labels.map((e) => e.role).sort()).toEqual(["classification", "tag"]);
    expect(labels.every((e) => e.projectId === p.projectId)).toBe(true);
  });

  test("getProjectsByConceptId — 통합 엣지에서 project 끝점만 거른다", async () => {
    const p = await repo.findOrCreateProject({ name: "개념 역방향" });
    const cid = insertConcept(db, "cpt_kw", "키워드");
    await repo.addProjectConceptEdge(p.projectId, cid, "tag", TEST_PROVENANCE, TEST_SOURCE_NODE_ID);

    // 같은 개념에 비-project 엔티티(work) 엣지를 더해도 project 만 회신해야 한다.
    const reg = new EntityTypeRegistryDb(db);
    const entitiesRepo = new EntitiesRepository(db, embedder, reg);
    const work = await entitiesRepo.findOrCreateEntity("work", "어떤 작품");
    db.prepare(
      `INSERT INTO entity_concept_edges
         (entity_id, concept_id, role, provenance, source_node_id, created_at)
       VALUES (?, ?, 'tag', 'system', NULL, '2026-06-25 00:00:00')`,
    ).run(work.id, cid);

    const got = repo.getProjectsByConceptId(cid);
    expect(got.map((g) => g.projectId)).toEqual([p.projectId]);

    const tagOnly = repo.getProjectsByConceptId(cid, "tag");
    expect(tagOnly.map((g) => g.projectId)).toEqual([p.projectId]);
    expect(repo.getProjectsByConceptId(cid, "classification")).toEqual([]);
  });

  // 참여자 추가·중복(INSERT OR IGNORE) 동작은 store 레벨 특성 테스트(project-person-edges-characterization 갈래1)가 생산 경로로 덮는다. repo 직접 쓰기 메서드 addProjectPersonEdge 는 S3 전환 후 죽었고 S4 가 제거한다.

  test("양방향 참여자 조회 — 프로젝트→사람 과 사람→프로젝트 가 일치", async () => {
    const p1 = await repo.findOrCreateProject({ name: "프로젝트 하나" });
    const p2 = await repo.findOrCreateProject({ name: "프로젝트 둘" });
    const kim = insertPerson(db, "psn_kim", "김민수");
    const lee = insertPerson(db, "psn_lee", "이영희");

    // 참여자 엣지를 통합 거처(entity_relation_edges participated_by)에 직접 깐다 —
    // 생산 경로(store.addProjectPersonEdge mixin)도 같은 표를 쓴다. repo 직접 쓰기
    // 메서드는 S4 가 제거했다(특성 테스트가 생산 경로로 덮는다).
    const linkParticipant = (projectId: string, personId: string): void => {
      db.prepare(
        `INSERT INTO entity_relation_edges
           (source_type, source_id, target_type, target_id, relation, provenance, source_node_id, created_at)
         VALUES ('project', ?, 'person', ?, 'participated_by', 'system', NULL, '2026-01-01 00:00:00')`,
      ).run(projectId, personId);
    };
    linkParticipant(p1.projectId, kim);
    linkParticipant(p1.projectId, lee);
    linkParticipant(p2.projectId, kim);

    // 프로젝트 → 사람.
    const p1Parts = await repo.listProjectParticipants(p1.projectId);
    expect(p1Parts.map((e) => e.personId).sort()).toEqual(["psn_kim", "psn_lee"]);
    // role 은 통합 후 빈 값(사용자 결정 — 회상·표시가 role 을 안 가름).
    expect(p1Parts.every((e) => e.role === "")).toBe(true);

    // 사람 → 프로젝트 (김민수는 두 프로젝트 참여).
    const kimProjects = await repo.listPersonProjects(kim);
    expect(kimProjects.map((e) => e.projectId).sort()).toEqual([
      p1.projectId,
      p2.projectId,
    ].sort());

    // 이영희는 한 프로젝트만.
    const leeProjects = await repo.listPersonProjects(lee);
    expect(leeProjects.length).toBe(1);
    expect(leeProjects[0]!.projectId).toBe(p1.projectId);
  });

  test("참여자·라벨 없는 프로젝트 = 빈 배열 (정직한 빈 결과)", async () => {
    const p = await repo.findOrCreateProject({ name: "외톨이" });
    expect(await repo.listProjectParticipants(p.projectId)).toEqual([]);
    expect(await repo.listProjectConcepts(p.projectId)).toEqual([]);
    expect(await repo.listPersonProjects("psn_nobody")).toEqual([]);
  });

  test("프로젝트(entities) 삭제 시 통합 라벨 엣지 FK CASCADE 정리", async () => {
    const p = await repo.findOrCreateProject({ name: "삭제 대상" });
    const cid = insertConcept(db, "cpt_ts", "typescript");
    await repo.addProjectConceptEdge(p.projectId, cid, "tag", TEST_PROVENANCE, TEST_SOURCE_NODE_ID);

    // 본체가 entities 에 있으므로 entities 에서 지운다 — entity_concept_edges 가
    // FK(entity_id → entities) ON DELETE CASCADE 로 함께 사라진다(통합 엣지).
    db.prepare("DELETE FROM entities WHERE entity_id=?").run(p.projectId);

    expect(await repo.listProjectConcepts(p.projectId)).toEqual([]);
  });
});
