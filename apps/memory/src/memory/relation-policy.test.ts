import { describe, expect, test } from "bun:test";
import {
  STANDARD_CONCEPT_EDGE_RELATIONS,
  STANDARD_ENTITY_CONCEPT_ROLES,
  STANDARD_KNOWLEDGE_EDGE_RELATIONS,
  STANDARD_RELATION_NAMES,
  checkRelationNameForTable,
  checkRelationName,
  normalizeRelationName,
  relationWriteWarningMessage,
  standardNamesForRelationColumn,
} from "./relation-policy.ts";

describe("relation-policy", () => {
  test("표준 관계/역할 이름을 포함한다", () => {
    expect(STANDARD_RELATION_NAMES).toContain("created_by");
    expect(STANDARD_RELATION_NAMES).toContain("participated_by");
    expect(STANDARD_RELATION_NAMES).toContain("parent_of");
    expect(STANDARD_RELATION_NAMES).toContain("merged_into");
    expect(STANDARD_RELATION_NAMES).toContain("classification");
    expect(STANDARD_RELATION_NAMES).toContain("identity");
  });

  test("테이블별 표준 목록은 현재 코드의 실제 relation/role 갈래를 구분한다", () => {
    expect(STANDARD_KNOWLEDGE_EDGE_RELATIONS).toContain("parent_of");
    expect(STANDARD_KNOWLEDGE_EDGE_RELATIONS).toContain("merged_into");
    expect(STANDARD_CONCEPT_EDGE_RELATIONS).toEqual([
      "parent_of",
      "llm_relation",
      "has_attribute",
    ]);
    expect(STANDARD_ENTITY_CONCEPT_ROLES).toContain("identity");
    expect(STANDARD_ENTITY_CONCEPT_ROLES).toContain("has_attribute");
  });

  test("entity_relation_edges만 사용자 추가 관계명을 표준으로 받아들인다", () => {
    const extra = new Set(["subscribed_to"]);
    expect(
      standardNamesForRelationColumn(
        "entity_relation_edges",
        "relation",
        extra,
      ).has("subscribed_to"),
    ).toBe(true);
    expect(
      standardNamesForRelationColumn(
        "knowledge_edges",
        "relation",
        extra,
      ).has("subscribed_to"),
    ).toBe(false);
  });

  test("normalizeRelationName trims and rejects empty/non-string", () => {
    expect(normalizeRelationName(" created_by ")).toBe("created_by");
    expect(normalizeRelationName("   ")).toBeNull();
    expect(normalizeRelationName(null)).toBeNull();
  });

  test("checkRelationName reports non-standard values", () => {
    expect(checkRelationName("created_by").ok).toBe(true);
    const bad = checkRelationName("made_byy");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("non_standard");
  });

  test("write policy check uses table-specific relation/role columns", () => {
    expect(
      checkRelationNameForTable("node_concept_edges", "role", "classification").ok,
    ).toBe(true);
    const bad = checkRelationNameForTable(
      "node_concept_edges",
      "role",
      "created_by",
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("non_standard");
  });

  test("write warning message is report-only and keeps the raw value visible", () => {
    expect(
      relationWriteWarningMessage("concept_edges", "relation", "parent_of"),
    ).toBeNull();
    const message = relationWriteWarningMessage(
      "entity_concept_edges",
      "role",
      "custom_role",
    );
    expect(message).toContain("entity_concept_edges.role");
    expect(message).toContain("custom_role");
    expect(message).toContain("non_standard");
  });
});
