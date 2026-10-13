import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { CURRENT_SCHEMA_VERSION, openMemoryDatabase } from "../db/migrations.ts";
import { reportRelations } from "./report-relations.ts";

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

describe("reportRelations", () => {
  test("관계 테이블, layer, relation, endpoint kind별 count를 read-only로 낸다", () => {
    const n1 = addNode("node one");
    const n2 = addNode("node two");
    db.prepare(
      "INSERT INTO persons (person_id, display_name) VALUES ('psn_a', 'Alice')",
    ).run();
    db.prepare(
      "INSERT INTO entities (entity_id, type_name, name) VALUES ('prj_a', 'project', 'Project A')",
    ).run();
    db.prepare(
      "INSERT INTO knowledge_edges (source_id, target_id, relation, weight, provenance, source_node_id) VALUES (?, ?, 'related_to', 0.4, 'user_input', NULL)",
    ).run(n1, n2);
    db.prepare(
      `INSERT INTO entity_relation_edges (source_type, source_id, target_type, target_id, relation, weight, provenance, source_node_id) VALUES ('project', 'prj_a', 'person', 'psn_a', 'participated_by', 1.0, 'user_input', NULL)`,
    ).run();

    const report = reportRelations(db, ":memory:");

    expect(report.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(report.totalEdges).toBe(2);
    expect(report.tableRowCounts.knowledge_edges).toBe(1);
    expect(report.tableRowCounts.entity_relation_edges).toBe(1);
    expect(report.layerCounts.memory).toBe(1);
    expect(report.layerCounts.entity).toBe(1);
    expect(report.relationCounts.related_to).toBe(1);
    expect(report.relationCounts.participated_by).toBe(1);
    expect(report.sourceKindCounts.memory).toBe(1);
    expect(report.sourceKindCounts.project).toBe(1);
    expect(report.targetKindCounts.memory).toBe(1);
    expect(report.targetKindCounts.person).toBe(1);
    expect(report.endpointPairCounts["project->person"]).toBe(1);
  });

  test("없는 관계 테이블은 skipped 목록에 둔다", () => {
    db.run("DROP TABLE concept_edges");

    const report = reportRelations(db, ":memory:");

    expect(report.skippedTables).toContain("concept_edges");
    expect(report.tableRowCounts.concept_edges).toBeUndefined();
  });
});
