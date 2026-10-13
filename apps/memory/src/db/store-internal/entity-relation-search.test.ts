/**
 * entity-relation-search.test.ts — 검색 1-hop 펼침 가드 (4단계 Task 5).
 *
 * 실제 bun:sqlite(:memory:) + 실제 schema(openMemoryDatabase)로 통합 검증한다 —
 * Mock 클래스 0. 데이터 경로를 진짜 INSERT 로 깐다: 작품 행 + identity 엣지
 * (entity_concept_edges role='identity') + 그 작품 개념 ↔ 글(node_concept_edges) +
 * 작품 행 ↔ 작가 행(entity_relation_edges created_by) + 작가(persons) ↔ 글
 * (node_person_edges). 그 위에서:
 *
 *  - 직접 잡은 개념 → identity 엔티티 행 seed 회수(getEntitySeedsByConcepts)
 *  - 데못죽 seed → 같은 작가 아쿠타미 → 아쿠타미의 다른 작품 주술회전 글 회수
 *  - seed/이웃 0개 → 빈 배열(정직)
 *  - 깊이 1 고정(2-hop 너머는 안 끌어옴) 가드
 *
 * RRF 코어 3파일(rrf.ts·scoring.ts·search-tuning.ts) byte 동일은 종합 가드(Task 6)와
 * 보고에서 git diff 로 확인한다 — 이 파일은 후보 합류 동작을 검증한다.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../migrations.ts";
import { EntityRelationEdgeRepository } from "./entity-relation-edge-repository.ts";

let db: Database;
let repo: EntityRelationEdgeRepository;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
  repo = new EntityRelationEdgeRepository(db);
});
afterEach(() => {
  db.close();
});

// ── FK 충족용 실제 INSERT 헬퍼 ──────────────────────────────────────────────

function insertConcept(conceptId: string, name: string): void {
  db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES (?, ?)").run(
    conceptId,
    name,
  );
}

function insertWork(workId: string, name: string): void {
  db.prepare(
    `INSERT INTO entities (entity_id, type_name, name, created_at, updated_at)
     VALUES (?, 'work', ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
  ).run(workId, name);
}

function insertPerson(personId: string, name: string): void {
  db.prepare(
    "INSERT INTO persons (person_id, display_name) VALUES (?, ?)",
  ).run(personId, name);
}

/** 글 노드 한 줄 — id 회수. */
function insertNode(content: string): number {
  const r = db
    .prepare("INSERT INTO knowledge_nodes (content) VALUES (?)")
    .run(content);
  return Number(r.lastInsertRowid);
}

/** 작품 행 ↔ 위계 잎 개념을 role='identity' 로 잇는다(3단계 양식). */
function linkIdentity(workId: string, conceptId: string): void {
  db.prepare(
    `INSERT INTO entity_concept_edges (entity_id, concept_id, role, created_at, provenance, source_node_id) VALUES (?, ?, 'identity', '2026-01-01 00:00:00', 'user_input', NULL)`,
  ).run(workId, conceptId);
}

/** 글 ↔ 개념(태그/identity 개념) node_concept_edges. */
function linkNodeConcept(nodeId: number, conceptId: string): void {
  db.prepare(
    `INSERT INTO node_concept_edges (node_id, concept_id, role, provenance, source_node_id) VALUES (?, ?, 'tag', 'user_input', NULL)`,
  ).run(nodeId, conceptId);
}

/** 글 ↔ 사람 node_person_edges. */
function linkNodePerson(nodeId: number, personId: string): void {
  db.prepare(
    `INSERT INTO node_person_edges (node_id, person_id, relation, provenance, source_node_id) VALUES (?, ?, 'mentions', 'user_input', NULL)`,
  ).run(nodeId, personId);
}

/**
 * 데못죽·주술회전 두 작품이 같은 작가 아쿠타미를 created_by 로 가진 끝에서 끝 데이터.
 * 각 작품: 행 + identity 개념 + 그 개념을 가진 글. 작가: persons 행.
 */
function seedAkutamiWorld(): {
  demotjukConcept: string;
  jjkNodeId: number;
  demotjukNodeId: number;
} {
  insertWork("wrk_demotjuk", "데못죽");
  insertWork("wrk_jjk", "주술회전");
  insertPerson("psn_akutami", "아쿠타미");

  insertConcept("cpt_demotjuk", "데못죽");
  insertConcept("cpt_jjk", "주술회전");
  linkIdentity("wrk_demotjuk", "cpt_demotjuk");
  linkIdentity("wrk_jjk", "cpt_jjk");

  // 각 작품 개념을 가진 글(node_concept_edges).
  const demotjukNodeId = insertNode("데못죽 감상");
  const jjkNodeId = insertNode("주술회전 감상");
  linkNodeConcept(demotjukNodeId, "cpt_demotjuk");
  linkNodeConcept(jjkNodeId, "cpt_jjk");

  // 같은 작가 아쿠타미를 created_by 로 가진 두 작품.
  repo.addEntityRelationEdge("work", "wrk_demotjuk", "person", "psn_akutami", "created_by", "user_input", null);
  repo.addEntityRelationEdge("work", "wrk_jjk", "person", "psn_akutami", "created_by", "user_input", null);

  return { demotjukConcept: "cpt_demotjuk", jjkNodeId, demotjukNodeId };
}

// ── getEntitySeedsByConcepts ────────────────────────────────────────────────

test("getEntitySeedsByConcepts — identity 개념을 가진 엔티티 행을 seed 로 회수", () => {
  seedAkutamiWorld();
  const seeds = repo.getEntitySeedsByConcepts(["cpt_demotjuk"]);
  expect(seeds.length).toBe(1);
  expect(seeds[0]!.type).toBe("work");
  expect(seeds[0]!.id).toBe("wrk_demotjuk");
});

test("getEntitySeedsByConcepts — 빈 conceptIds 면 빈 배열(IN () 방어)", () => {
  seedAkutamiWorld();
  expect(repo.getEntitySeedsByConcepts([])).toEqual([]);
});

test("getEntitySeedsByConcepts — identity 엣지 없는 개념이면 빈 배열(정직)", () => {
  // 작품 행은 있으나 identity 엣지가 안 걸린 평범한 개념 검색.
  insertConcept("cpt_random", "그냥개념");
  expect(repo.getEntitySeedsByConcepts(["cpt_random"])).toEqual([]);
});

// ── getRelatedEntityNodeIds: 데못죽 → 아쿠타미 → 주술회전 ──────────────────

test("데못죽 seed → 같은 작가 아쿠타미 → 주술회전 글을 끌어온다(끝에서 끝)", () => {
  const { jjkNodeId } = seedAkutamiWorld();
  const related = repo.getRelatedEntityNodeIds(
    [{ type: "work", id: "wrk_demotjuk" }],
    20,
  );
  // 주술회전 글이 회수된다(같은 작가의 다른 작품).
  expect(related).toContain(jjkNodeId);
});

test("seed 자신(데못죽)의 글은 회수에서 제외(1차 검색이 이미 잡음)", () => {
  const { demotjukNodeId, jjkNodeId } = seedAkutamiWorld();
  const related = repo.getRelatedEntityNodeIds(
    [{ type: "work", id: "wrk_demotjuk" }],
    20,
  );
  expect(related).not.toContain(demotjukNodeId);
  expect(related).toContain(jjkNodeId);
});

test("person target 의 글도 회수한다(작가 자신을 언급한 글)", () => {
  seedAkutamiWorld();
  // 아쿠타미 인터뷰 글 — node_person_edges 로만 이어짐.
  const interviewNodeId = insertNode("아쿠타미 인터뷰");
  linkNodePerson(interviewNodeId, "psn_akutami");

  const related = repo.getRelatedEntityNodeIds(
    [{ type: "work", id: "wrk_demotjuk" }],
    20,
  );
  expect(related).toContain(interviewNodeId);
});

// ── 빈 결과 정직성 ───────────────────────────────────────────────────────────

test("seed 가 빈 배열이면 빈 배열(정직 — 실패 아님)", () => {
  seedAkutamiWorld();
  expect(repo.getRelatedEntityNodeIds([], 20)).toEqual([]);
});

test("limit 0 이하면 빈 배열", () => {
  seedAkutamiWorld();
  expect(
    repo.getRelatedEntityNodeIds([{ type: "work", id: "wrk_demotjuk" }], 0),
  ).toEqual([]);
});

test("관계 이웃이 0개면 빈 배열(엣지 없는 외톨이 작품)", () => {
  insertWork("wrk_lonely", "외톨이작품");
  insertConcept("cpt_lonely", "외톨이작품");
  linkIdentity("wrk_lonely", "cpt_lonely");
  const lonelyNode = insertNode("외톨이 글");
  linkNodeConcept(lonelyNode, "cpt_lonely");
  // 관계 엣지를 안 만들었다 — 이웃 0.

  const related = repo.getRelatedEntityNodeIds(
    [{ type: "work", id: "wrk_lonely" }],
    20,
  );
  expect(related).toEqual([]);
});

// ── 깊이 1 고정 가드 ─────────────────────────────────────────────────────────

test("깊이 1 고정 — 2-hop 너머 작품은 안 끌어온다", () => {
  // 체인: 데못죽 → 아쿠타미(target). 주술회전 → 아쿠타미(같은 target·깊이 1).
  // 또 한 단 멀리: 주술회전 → 자료 mat_far(주술회전이 target). 그 자료의 글은
  // 데못죽 seed 기준 2-hop 너머라 끌려오면 안 된다.
  const { jjkNodeId } = seedAkutamiWorld();

  // 주술회전을 target 으로 가진 자료(허용 관계명 하나 사용) — 데못죽에서 보면 깊이 2.
  insertConcept("cpt_far", "먼자료");
  db.prepare(
    `INSERT INTO entities (entity_id, type_name, name, created_at, updated_at)
     VALUES ('mat_far', 'material', '먼자료', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
  ).run();
  db.prepare(
    `INSERT INTO entity_concept_edges (entity_id, concept_id, role, created_at, provenance, source_node_id) VALUES ('mat_far', 'cpt_far', 'identity', '2026-01-01 00:00:00', 'user_input', NULL)`,
  ).run();
  const farNode = insertNode("먼 자료 글");
  linkNodeConcept(farNode, "cpt_far");
  repo.addEntityRelationEdge("material", "mat_far", "work", "wrk_jjk", "located_at", "user_input", null);

  const related = repo.getRelatedEntityNodeIds(
    [{ type: "work", id: "wrk_demotjuk" }],
    20,
  );
  // 주술회전(깊이 1)은 끌려온다.
  expect(related).toContain(jjkNodeId);
  // 먼 자료(깊이 2)는 안 끌려온다 — 무한 확산 0.
  expect(related).not.toContain(farNode);
});

test("limit 가 회수 글 수를 자른다", () => {
  seedAkutamiWorld();
  // 아쿠타미가 만든 작품을 더 추가해 회수 후보를 늘린다.
  for (let i = 0; i < 5; i++) {
    insertWork(`wrk_extra${i}`, `추가작품${i}`);
    insertConcept(`cpt_extra${i}`, `추가작품${i}`);
    linkIdentity(`wrk_extra${i}`, `cpt_extra${i}`);
    const n = insertNode(`추가 글${i}`);
    linkNodeConcept(n, `cpt_extra${i}`);
    repo.addEntityRelationEdge("work", `wrk_extra${i}`, "person", "psn_akutami", "created_by", "user_input", null);
  }
  const related = repo.getRelatedEntityNodeIds(
    [{ type: "work", id: "wrk_demotjuk" }],
    2,
  );
  expect(related.length).toBeLessThanOrEqual(2);
});
