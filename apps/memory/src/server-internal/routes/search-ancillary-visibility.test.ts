/**
 * search-ancillary-visibility.test.ts — 부가 출력 판정 표(WP-B1-03)의 순수 계약.
 *
 * concept_edges.provenance 값마다 출처 부류가 정확히 하나로 정해져 있고, 코드상 실제
 * 작성자가 쓰는 값이 문서화한 부류로 묶이는지 고정한다. 부류별 동작(허용·제외)은
 * search.ancillary-visibility.int.test.ts 가 실제 검색 파이프라인으로 단언한다.
 */
import { describe, expect, test } from "bun:test";
import { PROVENANCE_VALUES } from "../../memory/provenance-vocabulary.ts";
import {
  ANCILLARY_KINDS,
  CONCEPT_EDGE_SOURCE_CLASS,
} from "./search-ancillary-visibility.ts";

describe("concept_edges provenance → 출처 부류 표", () => {
  test("provenance 어휘의 모든 값이 정확히 한 부류로 정해져 있다(표에 빠진 값 0)", () => {
    expect(Object.keys(CONCEPT_EDGE_SOURCE_CLASS).sort()).toEqual([...PROVENANCE_VALUES].sort());
    for (const provenance of PROVENANCE_VALUES) {
      expect(["sourceNode", "relationSummaryDocument", "vocabulary"]).toContain(CONCEPT_EDGE_SOURCE_CLASS[provenance]);
    }
  });

  test("실제 작성자가 쓰는 값 — hashtag 는 출처 노드, llm_extract 는 문서 근거, user_input 은 어휘", () => {
    // hashtag-entity-wiring addPersonAttributeConcept(원본 노드 id) / summary-cycle
    // addConceptEdge(llm_relation) / persons 라벨 REST·글 없는 엔티티 입력(source_node_id 없음).
    expect(CONCEPT_EDGE_SOURCE_CLASS.hashtag).toBe("sourceNode");
    expect(CONCEPT_EDGE_SOURCE_CLASS.llm_extract).toBe("relationSummaryDocument");
    expect(CONCEPT_EDGE_SOURCE_CLASS.user_input).toBe("vocabulary");
  });

  test("글 내용에서 나오는 값은 출처 노드가 있어야 하고, 구조·이전 값은 어휘로 본다", () => {
    for (const provenance of ["regex", "image", "evolver"] as const) {
      expect(CONCEPT_EDGE_SOURCE_CLASS[provenance]).toBe("sourceNode");
    }
    for (const provenance of ["system", "migration"] as const) {
      expect(CONCEPT_EDGE_SOURCE_CLASS[provenance]).toBe("vocabulary");
    }
  });
});

test("omittedAncillary 종류 이름·순서는 판정 도입 전 응답과 같다", () => {
  expect([...ANCILLARY_KINDS]).toEqual([
    "conceptExpansion", "neighborContext", "parentSubstitution", "summaries", "entityHits", "imageCaptions",
  ]);
});
