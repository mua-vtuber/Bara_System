/**
 * entity-concept-edge-repository.test.ts — 라벨·identity 엣지 공통 CRUD 가드.
 *
 * 실제 sqlite(:memory:)로 검증한다 — Mock 클래스 금지(프로젝트 정책). FK 충족용
 * 개념·엔티티 행은 진짜 INSERT 로 만든다. add 멱등·role 별 조회·역방향 조회·종류 필터를
 * 확인한다.
 *
 * 분류 단계4 T4 — 옛 per-type `<type>_concept_edges` 8개 테이블을 범용 통합 테이블
 * entity_concept_edges(entity_id 끝점·FK→entities) 하나로 수렴했다. 엔티티 행은 죽은
 * 전용 테이블(works 등)이 아니라 범용 entities 에 만든다(통합 엣지 FK 충족). 역방향
 * 조회(getEntitiesByConcept)는 entities 로 JOIN 해 type_name 으로 거른다(종류 필터 보존).
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../migrations.ts";
import {
  EntityConceptEdgeRepository,
  type EntityConceptEdge,
} from "./entity-concept-edge-repository.ts";

let db: Database;
let repo: EntityConceptEdgeRepository;

const TEST_PROVENANCE = "system" as const;
const TEST_SOURCE_NODE_ID = null;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
  repo = new EntityConceptEdgeRepository(db);
});
afterEach(() => {
  db.close();
});

/** FK 충족용 — 실제 concept_nodes 행 삽입. */
function insertConcept(conceptId: string, name: string): string {
  db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES (?, ?)").run(
    conceptId,
    name,
  );
  return conceptId;
}

/**
 * FK 충족용 — 범용 본체 entities 에 엔티티 행 삽입(단계4 T4). 통합 엣지 테이블의
 * entity_id FK 가 entities 를 가리키므로 여기로 만든다. type_name 은 역방향 조회의
 * 종류 필터 토대다.
 */
function insertEntity(entityId: string, typeName: string, name: string): string {
  db.prepare(
    `INSERT INTO entities (entity_id, type_name, name, created_at, updated_at)
     VALUES (?, ?, ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
  ).run(entityId, typeName, name);
  return entityId;
}

test("addEntityConceptEdge 는 멱등 — 두 번 호출해도 한 행", () => {
  insertEntity("wrk_1", "work", "데못죽");
  insertConcept("cpt_action", "액션");

  const first = repo.addEntityConceptEdge(
    "work",
    "wrk_1",
    "cpt_action",
    "has_attribute",
    TEST_PROVENANCE,
    TEST_SOURCE_NODE_ID,
  );
  const second = repo.addEntityConceptEdge(
    "work",
    "wrk_1",
    "cpt_action",
    "has_attribute",
    "hashtag",
    999,
  );

  expect(first).toBe(true);
  expect(second).toBe(false);

  const edges = repo.getEntityConceptEdges("work", "wrk_1");
  expect(edges.length).toBe(1);
  const row = db
    .prepare(
      `SELECT provenance, source_node_id FROM entity_concept_edges
       WHERE entity_id = 'wrk_1' AND concept_id = 'cpt_action' AND role = 'has_attribute'`,
    )
    .get() as { provenance: string; source_node_id: number | null };
  expect(row.provenance).toBe("system");
  expect(row.source_node_id).toBeNull();
});

test("weight 를 주면 보존하고, 안 주면 null", () => {
  insertEntity("wrk_2", "work", "작품2");
  insertConcept("cpt_a", "A");
  insertConcept("cpt_b", "B");

  repo.addEntityConceptEdge("work", "wrk_2", "cpt_a", "has_attribute", TEST_PROVENANCE, TEST_SOURCE_NODE_ID, 0.7);
  repo.addEntityConceptEdge("work", "wrk_2", "cpt_b", "has_attribute", TEST_PROVENANCE, TEST_SOURCE_NODE_ID);

  const byConceptA = repo.getEntityConceptEdges("work", "wrk_2", "has_attribute")
    .find((e) => e.conceptId === "cpt_a");
  const byConceptB = repo.getEntityConceptEdges("work", "wrk_2", "has_attribute")
    .find((e) => e.conceptId === "cpt_b");

  expect(byConceptA?.weight).toBe(0.7);
  expect(byConceptB?.weight).toBeNull();
});

test("비표준 role 은 relation-policy warn 만 남기고 저장 의미는 유지한다", () => {
  insertEntity("wrk_warn", "work", "경고작");
  insertConcept("cpt_warn", "경고라벨");
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    expect(
      repo.addEntityConceptEdge(
        "work",
        "wrk_warn",
        "cpt_warn",
        "custom_role",
        TEST_PROVENANCE,
        TEST_SOURCE_NODE_ID,
      ),
    ).toBe(true);
  } finally {
    console.warn = originalWarn;
  }

  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("entity_concept_edges.role");
  expect(warnings[0]).toContain("custom_role");
  expect(repo.getEntityConceptEdges("work", "wrk_warn", "custom_role")).toEqual([
    expect.objectContaining({ entityId: "wrk_warn", conceptId: "cpt_warn", role: "custom_role" }),
  ]);
});

test("role 별 조회 — has_attribute 와 identity 를 가른다", () => {
  insertEntity("wrk_3", "work", "작품3");
  insertConcept("cpt_label", "장르라벨");
  insertConcept("cpt_leaf", "위계잎");

  repo.addEntityConceptEdge("work", "wrk_3", "cpt_label", "has_attribute", TEST_PROVENANCE, TEST_SOURCE_NODE_ID);
  repo.addEntityConceptEdge("work", "wrk_3", "cpt_leaf", "identity", TEST_PROVENANCE, TEST_SOURCE_NODE_ID);

  const all = repo.getEntityConceptEdges("work", "wrk_3");
  expect(all.length).toBe(2);

  const labels = repo.getEntityConceptEdges("work", "wrk_3", "has_attribute");
  expect(labels.map((e: EntityConceptEdge) => e.conceptId)).toEqual(["cpt_label"]);

  const identities = repo.getEntityConceptEdges("work", "wrk_3", "identity");
  expect(identities.map((e: EntityConceptEdge) => e.conceptId)).toEqual(["cpt_leaf"]);
});

test("역방향 조회 — getEntitiesByConcept 가 개념으로 그 종류 엔티티를 찾는다", () => {
  insertEntity("wrk_4", "work", "작품4");
  insertEntity("wrk_5", "work", "작품5");
  insertConcept("cpt_shared", "공유라벨");

  repo.addEntityConceptEdge("work", "wrk_4", "cpt_shared", "has_attribute", TEST_PROVENANCE, TEST_SOURCE_NODE_ID);
  repo.addEntityConceptEdge("work", "wrk_5", "cpt_shared", "has_attribute", TEST_PROVENANCE, TEST_SOURCE_NODE_ID);

  const entities = repo.getEntitiesByConcept("work", "cpt_shared", "has_attribute");
  expect(entities.map((e) => e.entityId).sort()).toEqual(["wrk_4", "wrk_5"]);
});

test("역방향 조회 — 종류 필터: 같은 개념이라도 다른 종류 엔티티는 안 섞인다(통합 테이블 종류 가름)", () => {
  // 통합 테이블은 종류를 안 담으므로 entities JOIN 으로 type_name 을 거른다 — 옛
  // per-type 테이블이 구조적으로 보장하던 "그 종류만" 의미를 보존한다(단계4 T4).
  insertEntity("wrk_6", "work", "작품6");
  insertEntity("cre_6", "creature", "생물6");
  insertConcept("cpt_cross", "교차개념");

  repo.addEntityConceptEdge("work", "wrk_6", "cpt_cross", "identity", TEST_PROVENANCE, TEST_SOURCE_NODE_ID);
  repo.addEntityConceptEdge("creature", "cre_6", "cpt_cross", "identity", TEST_PROVENANCE, TEST_SOURCE_NODE_ID);

  // work 로 물으면 work 행만, creature 로 물으면 creature 행만.
  expect(
    repo.getEntitiesByConcept("work", "cpt_cross", "identity").map((e) => e.entityId),
  ).toEqual(["wrk_6"]);
  expect(
    repo.getEntitiesByConcept("creature", "cpt_cross", "identity").map((e) => e.entityId),
  ).toEqual(["cre_6"]);
});

test("행이 없으면 빈 배열(정직한 빈 결과)", () => {
  insertConcept("cpt_none", "없음");
  expect(repo.getEntityConceptEdges("work", "wrk_missing")).toEqual([]);
  expect(repo.getEntitiesByConcept("work", "cpt_none")).toEqual([]);
});

test("미존재 엔티티에 엣지를 걸면 FK 로 loud fail(거짓 성공 0)", () => {
  // 단계4 T4 — 옛 registry 종류 검증 throw 대신, 통합 테이블 entity_id FK→entities 가
  // 진짜 가드다. entities 에 없는 entity_id 로 엣지를 만들면 FK 위반으로 명시 throw 한다
  // (silent fallback 금지 — 존재하지 않는 엔티티에 거짓 엣지를 만들지 않는다).
  insertConcept("cpt_x", "X");
  expect(() =>
    repo.addEntityConceptEdge("work", "wrk_ghost", "cpt_x", "has_attribute", TEST_PROVENANCE, TEST_SOURCE_NODE_ID),
  ).toThrow(/FOREIGN KEY/);
});
