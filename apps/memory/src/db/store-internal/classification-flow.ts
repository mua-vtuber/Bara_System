/**
 * classification-flow.ts — `addClassificationTag` 오케스트레이션 헬퍼 (감사 M-11).
 *
 * store.ts 가 순수 위임 facade 로 남도록 이 한 흐름의 업무 로직(입력 검증 +
 * 두 개념 생성 + 트랜잭션 두 엣지 쓰기 + 과거 평평 글 자동 재정리)을 facade
 * 밖으로 옮겼다.
 *
 * S0-T4(2026-06-14 위계 단일 출처 spec §4.1) — 개념↔개념 위계(parent_of) 쓰기를
 * 옛 concept_edges 에서 새 단일 출처 테이블 hierarchy_edges 로 옮겼다. 이 흐름이
 * 만드는 위계 직결·지름길 차단(2-(a)·2-(b))이 모두 hierarchy_edges 위에서 돈다
 * (HierarchyEdgeRepository). 글↔개념 mention 엣지(node_concept_edges role
 * 'classification')는 위계가 아니라 그대로 남긴다(spec §4.3 경계). reflow 는
 * node_concept_edges(tag role) 위에서 도는 별 통로라 테이블 이동과 무관하게
 * 그대로 가동한다.
 *
 * 순환 의존 차단: 이 파일은 store.ts 를 import 하지 않는다. 의존 repository
 * 타입은 각자 원천 모듈(concept-repository / hierarchy-edge-repository)에서,
 * ReflowStore 와 reflow 헬퍼는 memory/tag-reflow 에서 가져온다. store.ts 가
 * ReflowStore 를 만족하므로 호출 측에서 store 자신을 reflowStore 로 넘긴다.
 */

import type { Database } from "bun:sqlite";
import type { ConceptRepository } from "./concept-repository.ts";
import type { HierarchyEdgeRepository } from "./hierarchy-edge-repository.ts";
import {
  reflowFlatParentTags,
  REFLOW_TRIGGER_LABEL,
  type ReflowStore,
} from "../../memory/tag-reflow.ts";
import type { Provenance } from "../../memory/provenance-vocabulary.ts";

/** 개념 행을 가리키는 hierarchy_edges 끝점 종류 — 이 흐름은 양 끝이 모두 개념이다. */
const CONCEPT_TYPE = "concept";

/**
 * 헬퍼가 실제로 쓰는 의존만 명시 주입한다(전체 store 대신). hierarchyRepo 는
 * 위계 단일 출처 테이블 hierarchy_edges 의 쓰기·지름길 차단 읽기를 맡는다
 * (S0-T4). reflowStore 는 reflowFlatParentTags 가 받는 좁은 구조 타입 — 호출
 * 측에서 store 자신을 넘긴다.
 */
export interface ClassificationFlowDeps {
  db: Database;
  conceptRepo: ConceptRepository;
  hierarchyRepo: HierarchyEdgeRepository;
  reflowStore: ReflowStore;
}

/**
 * Phase 11b T1 — image_asset 노드 위 `#category:value` colon 양식 자동 합류 (11.4).
 *
 * 흐름 (한 트랜잭션 정합):
 *   1. category concept 노드 — `findOrCreateConcept(category, { isClassificationKey: true })`
 *   2. value concept 노드 — `findOrCreateConcept(value, { isClassificationValue: true })`
 *      (같은 이름 = 같은 노드 — name UNIQUE, D2 결정)
 *   3. hierarchy_edges(parent_of) — concept(category) → concept(value), 콜론 위계라
 *      weight 0.9 확정 (S0-T4 — 옛 concept_edges 에서 단일 출처 테이블로 이동)
 *   4. node_concept_edges(role='classification') — nodeId → value (위계 아닌 mention)
 *
 * idempotent — `findOrCreateConcept` 이름 UNIQUE / `addHierarchyEdge` INSERT OR IGNORE /
 * `addNodeConceptEdge` INSERT OR IGNORE 라 같은 호출 두 번 = 노드·edge 중복 0.
 *
 * 옛 spec(2026-05-22 11.4) 안 `tagged_with` edge 양식은 1.0b 이주 후 폐기 —
 * `node_concept_edges(role='classification')` 양식이 현 코드 정합 통로.
 *
 * 빈 category·빈 value 는 호출 측(`parseClassificationTags`)이 자연 제외하지만,
 * 안전상 throw — silent fallback 금지 (CLAUDE.md "실패 ≠ 빈 결과").
 *
 * @param deps     헬퍼가 쓰는 의존만(db + conceptRepo + edgeRepo + reflowStore).
 * @param nodeId   image_asset 노드(또는 일반 knowledge_nodes) id.
 * @param category colon 양식의 왼쪽 (예: 'character').
 * @param value    colon 양식의 오른쪽 (예: '흰머리토끼귀').
 */
export async function addClassificationTagFlow(
  deps: ClassificationFlowDeps,
  nodeId: number,
  category: string,
  value: string,
  provenance: Provenance,
  sourceNodeId: number | null,
): Promise<void> {
  if (!category || !category.trim()) {
    throw new Error("addClassificationTag: category must be non-empty");
  }
  if (!value || !value.trim()) {
    throw new Error("addClassificationTag: value must be non-empty");
  }

  // 두 개념 생성은 각자 자기-원자적(이름 UNIQUE 멱등 + 내부 embed)이라
  // 트랜잭션 밖에서 먼저 await 한다(mergeConceptAlias 와 같은 "embed 먼저 →
  // 동기 INSERT 를 트랜잭션 안에서" 순서, M-5).
  const categoryId = await deps.conceptRepo.findOrCreateConcept(category, {
    isClassificationKey: true,
  });
  const valueId = await deps.conceptRepo.findOrCreateConcept(value, {
    isClassificationValue: true,
  });

  // parent_of 위계 엣지(hierarchy_edges)와 classification 글-개념 엣지를 한
  // 트랜잭션으로 묶는다. 둘 다 커밋되거나 둘 다 롤백 — 자식(classification)만 안
  // 만들어진 어긋난 부분 상태를 차단한다(audit M-5). addHierarchyEdge 와
  // addNodeConceptEdgeSync 본체는 둘 다 순수 동기 DB 쓰기라 bun:sqlite 의 동기
  // 트랜잭션 콜백 안에서 안전하게 묶인다(deps.db 와 두 repo 의 db 는 같은
  // Database 인스턴스 — 생성자 주입).
  let skippedAsShortcut = false;
  deps.db.transaction(() => {
    const hierarchyResult = deps.hierarchyRepo.addReducedHierarchyEdge({
      sourceType: CONCEPT_TYPE,
      sourceId: categoryId,
      targetType: CONCEPT_TYPE,
      targetId: valueId,
      provenance,
      sourceNodeId,
      // 콜론 라벨은 사용자의 명시 선언이라 추측이 아닌 확정 강도 0.9 로 시작한다.
      weight: 0.9,
    });
    skippedAsShortcut = hierarchyResult.skippedAsShortcut;
    deps.conceptRepo.addNodeConceptEdgeSync(
      nodeId,
      valueId,
      "classification",
      provenance,
      sourceNodeId,
    );
  })();

  // 위계 지름길이면 parent_of 직통은 만들지 않고 글→value classification 만 남긴다.
  // 새 reduced API 가 concept 외 project/person/entity leaf 까지 같은 감축 규칙을 공유한다.
  if (skippedAsShortcut) {
    return; // parent_of 직결 안 만듦 + reflow skip.
  }

  // 위계 선언 직후 과거 평평 글 자동 재정리(spec §4.2.3 B3 — 검토 게이트 없음).
  // tag-reflow.ts 헬퍼는 ReflowStore 인터페이스만 쓰고 store 를 import 하지 않아
  // store→memory 값 import 가 순환을 만들지 않는다(store 가 두 메서드를 만족).
  // 상위 실패(findFlatParentTagNodes DB 오류 등) 격리 — 자동 정리가 깨져도 라벨 등록
  // 자체는 유지한다(글 단위 격리와 같은 정신, silent 아님 / §4.2.4).
  try {
    await reflowFlatParentTags(
      deps.reflowStore,
      categoryId,
      valueId,
      REFLOW_TRIGGER_LABEL,
    );
  } catch (err) {
    console.warn(
      `[addClassificationTag reflow] 자동 재정리 실패 — 라벨 등록은 유지 ` +
        `(parent ${categoryId}, label ${category}:${value}): ${String(err)}`,
    );
  }
}
