import { describe, test, expect } from "bun:test";
import { isEntityRelationEdgeType, ENTITY_RELATION_EDGE_TYPES } from "./edges.ts";

describe("isEntityRelationEdgeType — 관계선 구별 (Phase8 재매핑 Task 7)", () => {
  test("엔티티 관계명은 관계선이다", () => {
    // export 된 Set 을 전수 순회한다 — 9번째 관계명이 늘어도 테스트가 자동 커버한다.
    expect(ENTITY_RELATION_EDGE_TYPES.size).toBeGreaterThan(0);
    for (const t of ENTITY_RELATION_EDGE_TYPES) {
      expect(isEntityRelationEdgeType(t)).toBe(true);
    }
  });

  test("글 연결선 type 은 관계선이 아니다", () => {
    for (const t of [
      "contains_chunk",
      "classified_as",
      "identity",
      "mentions",
      "has_attribute",
      "parent_of",
      "llm_relation",
      "classification",
      "tag",
    ]) {
      expect(isEntityRelationEdgeType(t)).toBe(false);
    }
  });

  test("빈 문자열은 관계선이 아니다", () => {
    expect(isEntityRelationEdgeType("")).toBe(false);
  });

  test("알 수 없는 type 은 관계선이 아니다", () => {
    expect(isEntityRelationEdgeType("unknown_type")).toBe(false);
    expect(isEntityRelationEdgeType("CREATED_BY")).toBe(false);
  });
});
