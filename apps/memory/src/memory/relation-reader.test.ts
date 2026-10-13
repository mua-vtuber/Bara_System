import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import {
  listRelationEdges,
  relationSelectSql,
} from "./relation-reader.ts";
import { relationSpecByTable, type RelationTableName } from "./relation-registry.ts";

let db: Database;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
});

afterEach(() => {
  db.close();
});

function addNode(content: string): number {
  const result = db
    .prepare(
      `INSERT INTO knowledge_nodes (content, memory_type, source_type)
       VALUES (?, 'fact', 'test')`,
    )
    .run(content);
  return Number(result.lastInsertRowid);
}

function seedEndpoints(): { n1: number; n2: number } {
  const n1 = addNode("node one");
  const n2 = addNode("node two");
  db.prepare(
    "INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_a', 'A'), ('cpt_b', 'B')",
  ).run();
  db.prepare(
    "INSERT INTO persons (person_id, display_name) VALUES ('psn_a', 'Alice')",
  ).run();
  db.prepare(
    "INSERT INTO entities (entity_id, type_name, name) VALUES ('wrk_a', 'work', 'Work A'), ('prj_a', 'project', 'Project A')",
  ).run();
  return { n1, n2 };
}

describe("relation-reader", () => {
  test("기존 관계 테이블들을 공통 edge 형태로 읽는다", () => {
    const { n1, n2 } = seedEndpoints();
    db.prepare(
      "INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, weight) VALUES (?, ?, 'related_to', 'system', 0.4)",
    ).run(n1, n2);
    db.prepare(
      "INSERT INTO node_concept_edges (node_id, concept_id, role, provenance) VALUES (?, 'cpt_a', 'tag', 'hashtag')",
    ).run(n1);
    db.prepare(
      "INSERT INTO node_person_edges (node_id, person_id, relation, provenance) VALUES (?, 'psn_a', 'mentions', 'hashtag')",
    ).run(n1);
    db.prepare(
      "INSERT INTO concept_edges (source_concept_id, target_concept_id, relation, provenance, weight) VALUES ('cpt_a', 'cpt_b', 'llm_relation', 'llm_extract', 0.8)",
    ).run();
    db.prepare(
      "INSERT INTO entity_concept_edges (entity_id, concept_id, role, provenance, weight) VALUES ('wrk_a', 'cpt_a', 'identity', 'hashtag', 1.0)",
    ).run();
    db.prepare(
      "INSERT INTO entity_relation_edges (source_type, source_id, target_type, target_id, relation, provenance, source_node_id, weight) VALUES ('project', 'prj_a', 'person', 'psn_a', 'participated_by', 'hashtag', ?, 1.0)",
    ).run(n1);
    db.prepare(
      "INSERT INTO hierarchy_edges (source_type, source_id, target_type, target_id, relation, provenance, weight) VALUES ('concept', 'cpt_a', 'work', 'wrk_a', 'parent_of', 'hashtag', 0.9)",
    ).run();

    const edges = listRelationEdges(db);
    expect(edges.map((e) => e.tableName).sort()).toEqual([
      "concept_edges",
      "entity_concept_edges",
      "entity_relation_edges",
      "hierarchy_edges",
      "knowledge_edges",
      "node_concept_edges",
      "node_person_edges",
    ]);
    expect(edges).toContainEqual(
      expect.objectContaining({
        tableName: "entity_relation_edges",
        rowId: expect.any(Number),
        sourceKind: "project",
        sourceId: "prj_a",
        targetKind: "person",
        targetId: "psn_a",
        relation: "participated_by",
        provenance: "hashtag",
        sourceNodeId: n1,
        layer: "entity",
        fkPolicy: "polymorphic_no_fk",
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        tableName: "entity_concept_edges",
        sourceKind: "work",
        sourceId: "wrk_a",
        targetKind: "concept",
        targetId: "cpt_a",
        relation: "identity",
        provenance: "hashtag",
        sourceNodeId: null,
        layer: "classification",
        fkPolicy: "foreign_key",
      }),
    );
  });

  test("없는 관계 테이블은 읽기 실패가 아니라 자연스럽게 건너뛴다", () => {
    seedEndpoints();
    db.run("DROP TABLE concept_edges");

    const edges = listRelationEdges(db);
    expect(edges.some((e) => e.tableName === "concept_edges")).toBe(false);
  });

  test("table, layer, relation 필터는 registry 기반 공통 edge를 유지한다", () => {
    const { n1, n2 } = seedEndpoints();
    db.prepare(
      "INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, weight) VALUES (?, ?, 'related_to', 'system', 0.4)",
    ).run(n1, n2);
    db.prepare(
      "INSERT INTO node_concept_edges (node_id, concept_id, role, provenance) VALUES (?, 'cpt_a', 'tag', 'hashtag')",
    ).run(n1);
    db.prepare(
      "INSERT INTO node_concept_edges (node_id, concept_id, role, provenance) VALUES (?, 'cpt_b', 'classification', 'hashtag')",
    ).run(n2);
    db.prepare(
      "INSERT INTO entity_relation_edges (source_type, source_id, target_type, target_id, relation, provenance, weight) VALUES ('project', 'prj_a', 'person', 'psn_a', 'participated_by', 'user_input', 1.0)",
    ).run();

    expect(listRelationEdges(db, { tableName: "node_concept_edges" })).toEqual([
      expect.objectContaining({
        tableName: "node_concept_edges",
        sourceKind: "memory",
        targetKind: "concept",
      }),
      expect.objectContaining({
        tableName: "node_concept_edges",
        sourceKind: "memory",
        targetKind: "concept",
      }),
    ]);
    expect(listRelationEdges(db, { layer: "entity" })).toEqual([
      expect.objectContaining({
        tableName: "entity_relation_edges",
        relation: "participated_by",
        sourceKind: "project",
        targetKind: "person",
      }),
    ]);
    expect(listRelationEdges(db, { relation: "tag" })).toEqual([
      expect.objectContaining({
        tableName: "node_concept_edges",
        relation: "tag",
        sourceId: String(n1),
        targetId: "cpt_a",
      }),
    ]);
    expect(
      listRelationEdges(db, {
        tableName: "node_concept_edges",
        relation: "classification",
      }),
    ).toEqual([
      expect.objectContaining({
        sourceId: String(n2),
        targetId: "cpt_b",
        relation: "classification",
      }),
    ]);
  });

  test("around 조회는 source/target 어느 쪽에 있든 같은 endpoint를 찾는다", () => {
    const { n1, n2 } = seedEndpoints();
    db.prepare(
      "INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, weight) VALUES (?, ?, 'related_to', 'system', 0.4)",
    ).run(n1, n2);
    db.prepare(
      "INSERT INTO node_concept_edges (node_id, concept_id, role, provenance) VALUES (?, 'cpt_a', 'tag', 'hashtag')",
    ).run(n1);
    db.prepare(
      "INSERT INTO concept_edges (source_concept_id, target_concept_id, relation, provenance, weight) VALUES ('cpt_a', 'psn_a', 'has_attribute', 'user_input', 0.8)",
    ).run();
    db.prepare(
      "INSERT INTO hierarchy_edges (source_type, source_id, target_type, target_id, relation, provenance, weight) VALUES ('concept', 'cpt_a', 'work', 'wrk_a', 'parent_of', 'hashtag', 0.9)",
    ).run();

    expect(
      listRelationEdges(db, { around: { kind: "memory", id: String(n1) } }),
    ).toEqual([
      expect.objectContaining({ tableName: "knowledge_edges", sourceId: String(n1) }),
      expect.objectContaining({ tableName: "node_concept_edges", sourceId: String(n1) }),
    ]);
    expect(
      listRelationEdges(db, { around: { kind: "person", id: "psn_a" } }),
    ).toEqual([
      expect.objectContaining({
        tableName: "concept_edges",
        sourceKind: "concept",
        targetKind: "person",
        targetId: "psn_a",
      }),
    ]);
    expect(
      listRelationEdges(db, { around: { kind: "work", id: "wrk_a" } }),
    ).toEqual([
      expect.objectContaining({
        tableName: "hierarchy_edges",
        sourceKind: "concept",
        targetKind: "work",
        targetId: "wrk_a",
      }),
    ]);
  });

  test("등록됐지만 현재 DB에 없는 table filter도 skip 결과를 낸다", () => {
    seedEndpoints();
    db.run("DROP TABLE concept_edges");

    expect(listRelationEdges(db, { tableName: "concept_edges" })).toEqual([]);
  });
});

describe("relation-reader WHERE pushdown", () => {
  // 여러 행을 깔아 두고, pushdown 적용 뒤에도 같은 edge 집합·같은 정렬이 나오는지 본다.
  function seedManyEdges(): void {
    const n1 = addNode("node one");
    const n2 = addNode("node two");
    const n3 = addNode("node three");
    db.prepare(
      "INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_a', 'A'), ('cpt_b', 'B'), ('cpt_c', 'C')",
    ).run();
    db.prepare(
      "INSERT INTO persons (person_id, display_name) VALUES ('psn_a', 'Alice'), ('psn_b', 'Bob')",
    ).run();
    db.prepare(
      `INSERT INTO entities (entity_id, type_name, name) VALUES
         ('wrk_a', 'work', 'Work A'),
         ('wrk_b', 'work', 'Work B'),
         ('prj_a', 'project', 'Project A'),
         ('prj_b', 'project', 'Project B')`,
    ).run();

    db.prepare(
      "INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, weight) VALUES (?, ?, 'related_to', 'system', 0.4)",
    ).run(n1, n2);
    db.prepare(
      "INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, weight) VALUES (?, ?, 'caused_by', 'system', 0.3)",
    ).run(n1, n3);
    db.prepare(
      "INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, weight) VALUES (?, ?, 'related_to', 'system', 0.2)",
    ).run(n2, n3);

    db.prepare(
      "INSERT INTO node_concept_edges (node_id, concept_id, role, provenance) VALUES (?, 'cpt_a', 'tag', 'hashtag')",
    ).run(n1);
    db.prepare(
      "INSERT INTO node_concept_edges (node_id, concept_id, role, provenance) VALUES (?, 'cpt_b', 'classification', 'hashtag')",
    ).run(n2);

    db.prepare(
      "INSERT INTO node_person_edges (node_id, person_id, relation, provenance) VALUES (?, 'psn_a', 'mentions', 'hashtag')",
    ).run(n1);
    db.prepare(
      "INSERT INTO node_person_edges (node_id, person_id, relation, provenance) VALUES (?, 'psn_b', 'mentions', 'hashtag')",
    ).run(n2);

    db.prepare(
      `INSERT INTO concept_edges (source_concept_id, target_concept_id, relation, provenance, weight) VALUES
         ('cpt_a', 'cpt_b', 'llm_relation', 'llm_extract', 0.8),
         ('cpt_b', 'cpt_c', 'llm_relation', 'llm_extract', 0.7)`,
    ).run();

    db.prepare(
      `INSERT INTO entity_concept_edges (entity_id, concept_id, role, provenance, weight) VALUES
         ('wrk_a', 'cpt_a', 'identity', 'hashtag', 1.0),
         ('wrk_b', 'cpt_b', 'identity', 'hashtag', 1.0)`,
    ).run();

    db.prepare(
      `INSERT INTO entity_relation_edges (source_type, source_id, target_type, target_id, relation, provenance, weight) VALUES
         ('project', 'prj_a', 'person', 'psn_a', 'participated_by', 'user_input', 1.0),
         ('project', 'prj_b', 'person', 'psn_a', 'participated_by', 'user_input', 1.0),
         ('project', 'prj_a', 'person', 'psn_b', 'participated_by', 'user_input', 1.0),
         ('work', 'wrk_a', 'person', 'psn_a', 'created_by', 'hashtag', 1.0)`,
    ).run();

    db.prepare(
      `INSERT INTO hierarchy_edges (source_type, source_id, target_type, target_id, relation, provenance, weight) VALUES
         ('concept', 'cpt_a', 'work', 'wrk_a', 'parent_of', 'hashtag', 0.9),
         ('concept', 'cpt_b', 'work', 'wrk_b', 'parent_of', 'hashtag', 0.9)`,
    ).run();
  }

  // pushdown 결과가 "전체 스캔 후 앱 필터"만 돌린 결과와 같은지 비교하는 기준.
  // 앱 필터 matchesEdgeFilter 는 그대로 유지되므로, 전체를 읽어 앱 필터로 거른 것과
  // WHERE 로 줄여 읽은 것이 같아야 한다(동작 보존).
  function referenceEdges(
    filter: Parameters<typeof listRelationEdges>[1],
  ): ReturnType<typeof listRelationEdges> {
    return listRelationEdges(db).filter((edge) => {
      if (filter?.tableName !== undefined) {
        const tables = Array.isArray(filter.tableName)
          ? filter.tableName
          : [filter.tableName];
        if (!tables.includes(edge.tableName as RelationTableName)) return false;
      }
      if (filter?.source?.id !== undefined && edge.sourceId !== String(filter.source.id))
        return false;
      if (filter?.source?.kind !== undefined && edge.sourceKind !== filter.source.kind)
        return false;
      if (filter?.target?.id !== undefined && edge.targetId !== String(filter.target.id))
        return false;
      if (filter?.target?.kind !== undefined && edge.targetKind !== filter.target.kind)
        return false;
      if (filter?.relation !== undefined) {
        const rels = Array.isArray(filter.relation) ? filter.relation : [filter.relation];
        if (!rels.includes(edge.relation)) return false;
      }
      if (filter?.around !== undefined) {
        const id = String(filter.around.id);
        const hit =
          (edge.sourceKind === filter.around.kind && edge.sourceId === id) ||
          (edge.targetKind === filter.around.kind && edge.targetId === id);
        if (!hit) return false;
      }
      return true;
    });
  }

  test("source.id 필터 결과가 pushdown 후에도 동일하다", () => {
    seedManyEdges();
    const filter = { tableName: "entity_relation_edges" as const, source: { id: "prj_a" } };
    expect(listRelationEdges(db, filter)).toEqual(referenceEdges(filter));
    expect(listRelationEdges(db, filter).length).toBe(2);
  });

  test("target.id 필터 결과가 pushdown 후에도 동일하다", () => {
    seedManyEdges();
    const filter = { tableName: "entity_relation_edges" as const, target: { id: "psn_a" } };
    expect(listRelationEdges(db, filter)).toEqual(referenceEdges(filter));
    expect(listRelationEdges(db, filter).length).toBe(3);
  });

  test("relation 단일/배열 필터 결과가 pushdown 후에도 동일하다", () => {
    seedManyEdges();
    const single = { relation: "related_to" as const };
    expect(listRelationEdges(db, single)).toEqual(referenceEdges(single));
    const many = { relation: ["related_to", "caused_by"] as const };
    expect(listRelationEdges(db, many)).toEqual(referenceEdges(many));
  });

  test("around 필터 결과가 pushdown(id OR) 후에도 동일하다", () => {
    seedManyEdges();
    const filter = { around: { kind: "person", id: "psn_a" } };
    expect(listRelationEdges(db, filter)).toEqual(referenceEdges(filter));
  });

  test("type_column kind 필터(entity_relation_edges)가 pushdown 후에도 동일하다", () => {
    seedManyEdges();
    const filter = {
      tableName: "entity_relation_edges" as const,
      source: { kind: "project" },
    };
    expect(listRelationEdges(db, filter)).toEqual(referenceEdges(filter));
    // project source 만 남고 work source 는 빠진다.
    expect(listRelationEdges(db, filter).every((e) => e.sourceKind === "project")).toBe(true);
  });

  test("entity_type_lookup kind 필터(entity_concept_edges)가 pushdown 후에도 동일하다", () => {
    seedManyEdges();
    const filter = {
      tableName: "entity_concept_edges" as const,
      source: { kind: "work" },
    };
    expect(listRelationEdges(db, filter)).toEqual(referenceEdges(filter));
    expect(listRelationEdges(db, filter).every((e) => e.sourceKind === "work")).toBe(true);
  });

  test("fixed kind 불일치 spec은 빈 결과로 제외된다", () => {
    seedManyEdges();
    // knowledge_edges 양 끝은 fixed 'memory'. source.kind='concept' 이면 한 행도 못 맞춘다.
    const filter = {
      tableName: "knowledge_edges" as const,
      source: { kind: "concept" },
    };
    expect(listRelationEdges(db, filter)).toEqual([]);
    // fixed kind 가 일치하면 조건은 무시되고 모든 행이 나온다.
    const matchFilter = {
      tableName: "knowledge_edges" as const,
      source: { kind: "memory" },
    };
    expect(listRelationEdges(db, matchFilter).length).toBe(3);
  });

  test("id_prefix kind 필터는 SQL pushdown 없이도 정확하다", () => {
    seedManyEdges();
    // concept_edges 양 끝은 id_prefix. cpt_ 는 concept 로 갈린다. pushdown 하지 않고
    // 앱 필터가 거른다 — 그래도 결과는 정확해야 한다.
    const filter = {
      tableName: "concept_edges" as const,
      source: { kind: "concept" },
    };
    expect(listRelationEdges(db, filter)).toEqual(referenceEdges(filter));
    expect(listRelationEdges(db, filter).every((e) => e.sourceKind === "concept")).toBe(true);
    // 어긋난 kind 는 정확히 빈 결과(앱 필터가 거른다).
    const noneFilter = {
      tableName: "concept_edges" as const,
      source: { kind: "person" },
    };
    expect(listRelationEdges(db, noneFilter)).toEqual([]);
  });

  test("kind+id 필터 조회가 reader SQL 에서 WHERE 를 포함하고 전체 SCAN 대신 인덱스 SEARCH 를 탄다", () => {
    seedManyEdges();
    // 실제 소비 패턴(getRelationsFromSource)은 source.kind + source.id 를 함께 준다.
    // entity_relation_edges 의 idx_ere_source = (source_type, source_id) 를 타려면
    // source_type 조건이 같이 있어야 한다.
    const tableName: RelationTableName = "entity_relation_edges";
    const filter = {
      tableName,
      source: { kind: "project", id: "prj_a" },
    };
    const spec = relationSpecByTable(tableName);
    if (spec === null) throw new Error(`spec 없음: ${tableName}`);
    const select = relationSelectSql(spec, filter);
    if (select === null) throw new Error("select 가 null");
    // SQL 에 WHERE 가 실제로 들어갔다(회귀 = WHERE 없는 전체 SELECT).
    expect(select.sql).toContain("WHERE");

    const plan = (
      db.prepare(`EXPLAIN QUERY PLAN ${select.sql}`).all(...select.params) as Array<{
        detail: string;
      }>
    ).map((r) => r.detail);
    // WHERE 없이 전체를 읽던 회귀에서는 "SCAN" 만 나온다. pushdown 회복 후엔 SEARCH + INDEX.
    expect(plan.some((step) => step.includes("SEARCH"))).toBe(true);
    expect(plan.some((step) => step.includes("INDEX"))).toBe(true);
    expect(plan.some((step) => step.includes("SCAN entity_relation_edges"))).toBe(false);
  });
});
