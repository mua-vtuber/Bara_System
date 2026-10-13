/**
 * graph-concept-source-type.test.ts
 *
 * conceptToGraphNode 3분 검증:
 *   - isClassificationKey === true  → sourceType "classification_key" (유리조각용)
 *   - isClassificationValue === true → sourceType "concept" (일반)
 *   - isTag === true                 → sourceType "concept" (일반)
 *
 * Phase 8 재매핑 Task 2.
 */

import { describe, test, expect } from "bun:test";
import { conceptToGraphNode } from "./graph.ts";
import type { ConceptNode } from "../../memory/types.ts";

/**
 * 순수 데이터 fixture — ConceptNode 인터페이스의 최소 유효 값으로 채우고
 * 테스트마다 다른 부분만 over 로 덮어쓴다.
 * (mock 클래스 아님, 인터페이스 구현체 아님 — 평범한 객체 리터럴)
 */
function fakeConcept(over: Partial<ConceptNode>): ConceptNode {
  return {
    conceptId: "cpt_test",
    name: "작품",
    koName: null,
    koAliases: [],
    enAliases: [],
    description: null,
    isTag: false,
    isClassificationKey: false,
    isClassificationValue: false,
    tagUsageCount: 0,
    classificationUsageCount: 0,
    searchBlacklist: false,
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    ...over,
  };
}

describe("conceptToGraphNode 3분 (Phase8 재매핑 Task 2)", () => {
  test("분류 키는 classification_key sourceType (유리조각)", () => {
    const n = conceptToGraphNode(fakeConcept({ isClassificationKey: true }));
    expect(n.sourceType).toBe("classification_key");
  });

  test("분류 값은 concept (일반)", () => {
    const n = conceptToGraphNode(fakeConcept({ isClassificationValue: true }));
    expect(n.sourceType).toBe("concept");
  });

  test("평범한 태그는 concept", () => {
    const n = conceptToGraphNode(fakeConcept({ isTag: true }));
    expect(n.sourceType).toBe("concept");
  });

  test("id 는 conceptKey 형식을 따른다", () => {
    const n = conceptToGraphNode(fakeConcept({ conceptId: "cpt_abc" }));
    expect(n.id).toBe("concept:cpt_abc");
  });

  test("koName 있으면 koName 을 label 로 쓴다", () => {
    const n = conceptToGraphNode(fakeConcept({ name: "work", koName: "작품" }));
    expect(n.label).toBe("작품");
  });

  test("koName null 이면 name 을 label 로 쓴다", () => {
    const n = conceptToGraphNode(fakeConcept({ name: "work", koName: null }));
    expect(n.label).toBe("work");
  });

  test("label 이 LABEL_MAX_CHARS(31) 초과하면 잘린다", () => {
    const longName = "가".repeat(40);
    const n = conceptToGraphNode(fakeConcept({ name: longName }));
    expect(n.label.length).toBeLessThanOrEqual(31);
  });
});
