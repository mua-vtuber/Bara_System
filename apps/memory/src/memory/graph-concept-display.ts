/**
 * 그래프 개념 노드 대표 정체성 표시 규칙 — 서버·web 공용 단일 출처.
 *
 * 같은 이름 태그·분류·개념은 concept_nodes.name UNIQUE 로 한 행에 합류하고
 * (concept-repository.ts:150~235 findOrCreateConcept), is_tag·is_classification_key·
 * is_classification_value 역할 플래그가 한 행에 누적된다(그래프 꼬임 해소 1단계
 * 결정 1·spec §3.1). 역할이 겹친 한 행을 그래프에 그릴 때 무엇을 대표 type 으로
 * 고를지 한 규칙으로 정한다.
 *
 * 이 모듈을 둘 다 import 한다 — 중복 구현 0(단일 출처):
 *  - 서버: server-internal/routes/graph.ts 의 conceptToGraphNode 가 노드 sourceType
 *    문자열을 이 규칙으로 정한다(아래 반환 리터럴이 그대로 서버 sourceType 어휘).
 *  - web: web/dashboard/graph/graph-view-model.ts 가 이 함수를 재export 해 렌더 쪽도
 *    같은 규칙을 본다. tsconfig 가 web/dashboard 를 컴파일에서 제외하므로 규칙을
 *    web 에 두면 서버가 import 할 수 없다 — 그래서 양쪽이 닿는 src/ 에 둔다.
 *
 * 순수 함수다 — DB·서버·DOM 어디에도 의존하지 않아 web 번들이 트리쉐이킹으로
 * 이 함수만 가져온다(서버 런타임 유입 없음).
 */

/**
 * 한 concept_nodes 행에 누적된 역할 플래그.
 */
export interface ConceptRoleFlags {
  isTag?: boolean;
  isClassificationKey?: boolean;
  isClassificationValue?: boolean;
}

/**
 * 대표 정체성 표시 type — 개념 노드 한 행이 그래프에 그려질 때 고를 수 있는 좁은
 * 어휘. 서버 sourceType 문자열이자 web GraphNodeType 의 부분집합이라 두 층의 공통
 * 어휘다(web SOURCE_TYPE_MAP 이 같은 이름으로 통과시킨다).
 *
 * 그래프가 실제 시각으로 가르는 개념 행은 두 갈래다 — 분류 키(콜론 위계 부모,
 * 유리조각 장식)와 그 외 일반 개념(별). 태그·분류 값·순수 개념은 다 일반 개념으로
 * 한데 그린다(graph.ts 확립 동작·기존 graph.test.ts 계약). 그래서 대표 어휘는
 * classification_key 와 concept 둘이다.
 */
export type ConceptDisplayType = "concept" | "classification_key";

/**
 * 역할이 겹친 한 행의 대표 정체성 type 을 개념 > 분류 > 태그 우선순위로 고른다
 * (spec §3.1).
 *
 * 같은 이름이 개념·분류·태그 여러 역할을 동시에 가질 때 무엇으로 그릴지 한 규칙으로
 * 정한다. 한 행 = 한 conceptId = 한 노드라 중복 노드가 생기지 않고, 이 함수가 그 한
 * 노드의 대표 type 을 단일 출처로 결정한다.
 *
 * 우선순위 적용(spec §3.1 "개념 > 분류 > 태그" + graph.ts 확립 동작):
 *   - 분류 키 역할이 있으면 → classification_key(유리조각). 분류 키만 시각으로 따로
 *     빼고, 태그·분류 값과 겹쳐도 분류 키 표시가 이긴다.
 *   - 그 외(분류 값·태그-only·순수 개념)는 → concept(일반 개념 별). 태그는 별도
 *     모양으로 빼지 않고 개념과 한데 그린다 — 기존 graph.test.ts 가 "태그-only
 *     커피 → concept" 로 명시한 계약을 보존한다(회귀 0).
 *
 * 즉 그래프가 실제 가르는 두 시각(분류 키 = 유리조각 / 그 외 = 일반 별)을 우선순위
 * 한 규칙으로 표현한다. 우선순위의 "태그" 끝단은 별도 tag 모양이 아니라 일반 개념
 * 흡수로 실현돼, 태그가 개념·분류와 겹쳐도 분류 키가 아니면 일반 개념으로 합류한다.
 */
export function representativeConceptType(
  roles: ConceptRoleFlags,
): ConceptDisplayType {
  if (roles.isClassificationKey) return "classification_key";
  return "concept";
}
