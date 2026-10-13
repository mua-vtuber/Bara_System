/**
 * tag-reflow.ts — 콜론 위계 선언 시 과거 평평 글 자동 재정리(spec §4.2.3 B3).
 *
 * 네 site(ensureLabelValueConcept·addClassificationTag·routes/persons·routes/projects)가
 * category→value parent_of 를 만든 *직후* 같은 짝으로 이 헬퍼를 부른다 — 단일 출처라
 * 통로별 분기 비정합을 막는다. 검토 게이트·제안·승인 없음(자동 / D-B1·D-B2).
 *
 * 동작: findFlatParentTagNodes(categoryId, [valueId]) 로 부모+자식 둘 다 붙은 과거 글을
 * 얻어, 각 글에서 detachParentTagEdge 로 부모(category) 연결만 뗀다(자식은 남김 / §5.5
 * 안전 증명). 떼어낸 글 0건이면 no-op(정직한 빈 결과).
 *
 * 글 단위 실패 격리(§4.2.4): detach 가 한 글에서 throw 하면 삼키지 않고 node_id·categoryId
 * 를 담은 console.warn 후 그 글만 건너뛰고 다음 글로 진행한다 — 위계 선언(parent_of 생성)은
 * 이미 끝났으므로 자동 정리 실패가 선언을 통째 깨지 않게 격리한다(silent fallback 아님).
 *
 * 좁은 구조 타입 ReflowStore 만 받아 store→memory 순환 import 를 피한다(구체 클래스 미import).
 */

/**
 * 네 site 공통 triggerLabel — tag_reflow_log.trigger_hierarchy 에 기록돼 되돌리기·감사
 * 추적 필터의 키가 된다(spec D-B6 단일 출처). 네 통로 모두 "콜론 라벨 category→value
 * parent_of 선언 후 평평 글 재정리"라는 같은 동작이라 한 값으로 통일한다(통로별 갈림 0).
 */
export const REFLOW_TRIGGER_LABEL = "category→value" as const;

export interface ReflowStore {
  findFlatParentTagNodes(parentConceptId: string, childConceptIds: string[]): Promise<number[]>;
  detachParentTagEdge(nodeId: number, parentConceptId: string, triggerHierarchy: string): Promise<void>;
}

export async function reflowFlatParentTags(
  store: ReflowStore,
  categoryId: string,
  valueId: string,
  triggerLabel: string,
): Promise<void> {
  const flatNodes = await store.findFlatParentTagNodes(categoryId, [valueId]);
  for (const nodeId of flatNodes) {
    try {
      await store.detachParentTagEdge(nodeId, categoryId, triggerLabel);
    } catch (err) {
      console.warn(
        `[reflowFlatParentTags] detach 실패 — 이 글만 건너뜀 ` +
          `(node ${nodeId}, parent ${categoryId}, trigger ${triggerLabel}): ${String(err)}`,
      );
    }
  }
}
