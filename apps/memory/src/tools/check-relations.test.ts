import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { CURRENT_SCHEMA_VERSION, openMemoryDatabase } from "../db/migrations.ts";
import { checkRelations } from "./check-relations.ts";

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

describe("checkRelations", () => {
  test("FK 0 관계 테이블의 끊긴 끝점과 비표준 relation을 read-only report로 낸다", () => {
    db.prepare(
      `INSERT INTO entity_relation_edges (source_type, source_id, target_type, target_id, relation, provenance, source_node_id) VALUES ('project', 'prj_missing', 'person', 'psn_missing', 'made_byy', 'user_input', NULL)`,
    ).run();

    const report = checkRelations(db, ":memory:");
    expect(report.ok).toBe(false);
    expect(report.checkedTables).toContain("entity_relation_edges");
    expect(report.rowCounts.entity_relation_edges).toBe(1);
    expect(
      report.tableSummaries.find((t) => t.table === "entity_relation_edges")
        ?.fkPolicy,
    ).toBe("polymorphic_no_fk");
    expect(
      report.findings.some(
        (f) =>
          f.table === "entity_relation_edges" &&
          f.check === "orphan-endpoint" &&
          f.severity === "critical",
      ),
    ).toBe(true);
    expect(
      report.findings.some(
        (f) =>
          f.table === "entity_relation_edges" &&
          f.check === "relation-policy" &&
          f.severity === "medium" &&
          f.message.includes("made_byy"),
      ),
    ).toBe(true);
  });

  test("FK 있는 관계 테이블도 orphan endpoint를 보고한다", () => {
    db.run("PRAGMA foreign_keys = OFF");
    db.prepare(
      "INSERT INTO node_person_edges (node_id, person_id, relation, provenance, source_node_id) VALUES (999, 'psn_missing', 'mentions', 'user_input', NULL)",
    ).run();
    db.run("PRAGMA foreign_keys = ON");

    const report = checkRelations(db, ":memory:");
    expect(
      report.tableSummaries.find((t) => t.table === "node_person_edges")
        ?.fkPolicy,
    ).toBe("foreign_key");
    expect(
      report.findings.some(
        (f) =>
          f.table === "node_person_edges" &&
          f.check === "orphan-endpoint" &&
          f.fkPolicy === "foreign_key",
      ),
    ).toBe(true);
  });

  test("self-loop와 duplicate tuple을 보고한다", () => {
    const n1 = addNode("a");
    const n2 = addNode("b");
    db.prepare(
      "INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, source_node_id) VALUES (?, ?, 'related_to', 'user_input', NULL)",
    ).run(n1, n1);

    db.run("DROP INDEX idx_ke_pair");
    db.prepare(
      "INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, source_node_id) VALUES (?, ?, 'links_to', 'user_input', NULL)",
    ).run(n1, n2);
    db.prepare(
      "INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, source_node_id) VALUES (?, ?, 'links_to', 'user_input', NULL)",
    ).run(n1, n2);

    const report = checkRelations(db, ":memory:");
    expect(
      report.findings.some(
        (f) => f.table === "knowledge_edges" && f.check === "self-loop",
      ),
    ).toBe(true);
    expect(
      report.findings.some(
        (f) =>
          f.table === "knowledge_edges" && f.check === "duplicate-tuple",
      ),
    ).toBe(true);
  });

  test("없는 relation table은 skipped로 보고한다", () => {
    db.run("DROP TABLE entity_concept_edges");

    const report = checkRelations(db, ":memory:");
    expect(report.skippedTables).toContain("entity_concept_edges");
    expect(report.checkedTables).not.toContain("entity_concept_edges");
  });

  test("사용자 추가 relation_name은 entity_relation_edges에서 표준으로 본다", () => {
    db.prepare(
      `INSERT INTO relation_name_user_entries
         (entry_id, relation_key, relation_name, source_types, target_types, default_target_type, created_at)
       VALUES ('rel_user_1', '구독', 'subscribed_to', 'person', 'material', 'material', '2026-01-01 00:00:00')`,
    ).run();
    db.prepare(
      `INSERT INTO entity_relation_edges (source_type, source_id, target_type, target_id, relation, provenance, source_node_id) VALUES ('person', 'psn_missing', 'material', 'mat_missing', 'subscribed_to', 'user_input', NULL)`,
    ).run();

    const report = checkRelations(db, ":memory:");
    expect(
      report.findings.some(
        (f) =>
          f.table === "entity_relation_edges" &&
          f.check === "relation-policy" &&
          JSON.stringify(f.row).includes("subscribed_to"),
      ),
    ).toBe(false);
    expect(
      report.findings.some(
        (f) =>
          f.table === "entity_relation_edges" &&
          f.check === "orphan-endpoint",
      ),
    ).toBe(true);
  });

  test("JSON 출력에 필요한 요약 필드가 직렬화 가능하다", () => {
    const report = checkRelations(db, ":memory:");
    const parsed = JSON.parse(JSON.stringify(report)) as typeof report;
    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.summary.checkedTables).toBeGreaterThan(0);
    expect(parsed.summary.totalRows).toBe(0);
    expect(parsed.rowCounts.knowledge_edges).toBe(0);
    expect(parsed.tableSummaries.length).toBe(parsed.checkedTables.length);
  });
});
