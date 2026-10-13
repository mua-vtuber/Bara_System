import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import {
  RELATION_TABLE_NAMES,
  RELATION_TABLE_SPECS,
  endpointKindFromId,
  hasRelationTable,
  relationSpecByTable,
} from "./relation-registry.ts";

let db: Database;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
});

afterEach(() => {
  db.close();
});

describe("relation-registry", () => {
  test("실제 관계 테이블 명단의 단일 출처를 제공한다", () => {
    expect(RELATION_TABLE_NAMES).toEqual([
      "knowledge_edges",
      "node_concept_edges",
      "node_person_edges",
      "concept_edges",
      "entity_concept_edges",
      "entity_relation_edges",
      "hierarchy_edges",
    ]);
    for (const tableName of RELATION_TABLE_NAMES) {
      expect(hasRelationTable(db, tableName)).toBe(true);
      expect(relationSpecByTable(tableName)?.tableName).toBe(tableName);
    }
  });

  test("각 테이블 사양은 endpoint, relation column, duplicate tuple 기준을 가진다", () => {
    for (const spec of RELATION_TABLE_SPECS) {
      expect(spec.source.idColumn.length).toBeGreaterThan(0);
      expect(spec.target.idColumn.length).toBeGreaterThan(0);
      expect(spec.relationColumn.name.length).toBeGreaterThan(0);
      expect(spec.provenanceColumn).toBe("provenance");
      expect(spec.sourceNodeIdColumn).toBe("source_node_id");
      expect(spec.duplicateTupleColumns).toContain(spec.relationColumn.name);
      expect(spec.orderBy.length).toBeGreaterThan(0);
    }
    expect(relationSpecByTable("entity_relation_edges")).toMatchObject({
      fkPolicy: "polymorphic_no_fk",
      layer: "entity",
      source: { idColumn: "source_id" },
      target: { idColumn: "target_id" },
    });
    expect(relationSpecByTable("entity_concept_edges")).toMatchObject({
      fkPolicy: "foreign_key",
      layer: "classification",
      relationColumn: { name: "role", kind: "role" },
    });
  });

  test("endpoint id prefix 해석 규칙을 한 곳에서 제공한다", () => {
    expect(endpointKindFromId("cpt_a")).toBe("concept");
    expect(endpointKindFromId("psn_a")).toBe("person");
    expect(endpointKindFromId("wrk_a")).toBe("work");
    expect(endpointKindFromId("sch_a")).toBe("schedule");
    expect(endpointKindFromId("missing")).toBe("unknown");
  });
});
