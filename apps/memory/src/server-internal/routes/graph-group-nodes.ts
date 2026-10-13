/**
 * server-internal/routes/graph-group-nodes.ts — 타입 묶음 노드 빌더.
 *
 * 합류된 개별 엔티티를 1급 타입별로 모아 묶음 루트(group:<type> 가상 노드 또는 동명
 * 위계 루트 개념 노드)와 소속 엣지(member_of)를 더하는 buildGroupNodes, 그리고 그
 * 판정을 돕는 findHierarchyRootNodeKey·collectHierarchyDescendants·groupLabel 을 담는다.
 * graph.ts 에서 책임 단위로 옮겨 왔다(CLAUDE.md "파일 작게") — 동작 불변(순수 이동).
 *
 * 공유 토대는 graph-nodes-shared.ts 에 의존한다. 읽기 전용 — nodeById·edgeSet 만
 * in-place 변형. 쓰기 0 / 스키마 변경 0 / RRF 코어 0.
 */

import {
  type GraphNode,
  type GraphEdge,
  type AugmentResult,
  MEMBER_OF_WEIGHT,
  entityKey,
  personKey,
  projectKey,
} from "./graph-nodes-shared.ts";
import { displayKindName } from "../../memory/entity-type-classifier.ts";

/**
 * 타입 묶음 노드 라벨 접미사(2026-06-13 그래프 노드 흡수 §5.4 ③·D2).
 *
 * 묶음 노드(`group:<type>`)는 개념 루트(예 콜론 위계 부모 "장소")와 같은 koName
 * 을 그대로 쓰면 그래프에 같은 이름 두 노드("장소"·"장소")로 떠 사슬이 끊겨
 * 보인다. 접미사를 붙여 "장소 (전체)" 로 또렷이 구분한다 — 한 타입의 모든
 * 엔티티를 모은 묶음임을 드러낸다. "묶음/분류" 어근은 한국어 룰(부패 단어 차단)·
 * classification_key 시각과의 혼동을 피해 쓰지 않는다. 라벨 문구는 라이브에서
 * 사용자가 조정 가능(여기 한 줄 단일 출처).
 */
const GROUP_LABEL_SUFFIX = " (전체)";

/**
 * 타입 묶음 노드 라벨 = 한글 타입 이름 + 접미사. 개념 루트 koName 과 충돌하지
 * 않게 구분하는 단일 출처(§5.4 ③).
 *
 * koName 단일 출처 = displayKindName(plan 2026-06-28 G3) — 옛 GROUP_TYPE_KO 정적 Record 는
 * 모듈 로드 시점 8 타입 + person/project 만 담아 user 새 종류(가계부 등) koName 이 없어
 * 라벨이 영문 코드명('ledger')으로 떴다. displayKindName 은 정적 10종(레지스트리/상수)과
 * user 새 종류(주입된 동적 명부) koName 을 모두 한 통로로 돌려주고, 출처가 없으면(주입 전·
 * 미등록) 코드명을 정직하게 노출한다(honest degradation·빈 칸·가짜 이름 0).
 */
function groupLabel(typeName: string): string {
  return displayKindName(typeName) + GROUP_LABEL_SUFFIX;
}

/**
 * 한 타입의 묶음 루트 노드 키를 정한다 — ④ 묶음 노드 ↔ 동명 위계 루트 통합
 * (spec 2026-06-13 그래프 노드 흡수 §5.4 ④·라이브 결함 1 해소).
 *
 * 같은 koName(예 "장소")의 *위계 루트 개념 노드*가 이미 nodeById 에 있으면 별도
 * `group:<type>` 가상 노드를 만들지 않고 그 개념 노드를 묶음 루트로 재사용한다 —
 * "장소" 가 그래프에 콜론 위계 부모 + 묶음 노드 둘로 갈리던 것을 한 노드로 통합.
 * 위계 루트 개념은 콜론 위계 부모(is_classification_key)라 conceptToGraphNode 가
 * sourceType="classification_key" 를 매겨 둔다 — 그 단서를 보고 DB 재조회 없이
 * label + sourceType 두 칸으로 판정한다.
 *
 * koName 비교는 displayKindName(plan G3·레지스트리/동적 명부 koName 단일 출처)과 노드
 * label 의 문자열 일치다. conceptToGraphNode 의 label 도 같은 koName 을 쓰므로 두 곳이
 * 같은 문자열을 본다(하드코딩 0). user 종류도 displayKindName 이 koName('가계부')을
 * 돌려줘 같은 이름 위계 루트 개념을 찾는다. koName 출처가 없어 코드명이 돌아오면 그
 * 코드명과 같은 label 개념은 보통 없어 자연히 못 찾는다(null → 가상 노드). 못 찾으면
 * null — 호출처가 기존 group:<type> 가상 노드를 만든다.
 */
function findHierarchyRootNodeKey(
  nodeById: Map<string, GraphNode>,
  typeName: string,
): string | null {
  const koName = displayKindName(typeName);
  if (!koName) return null;
  for (const node of nodeById.values()) {
    if (node.sourceType === "classification_key" && node.label === koName) {
      return node.id;
    }
  }
  return null;
}

/**
 * 묶음 루트에서 parent_of 위계로 닿는 후손 노드 키 집합을 회신한다 — ⑤ member_of
 * 추이 감축의 판정 재료(spec 2026-06-13 §5.4 ⑤·라이브 결함 2 해소).
 *
 * 그래프 빌드가 이미 모은 edgeSet 의 `parent_of` 엣지만 메모리 위에서 BFS 한다 —
 * DB 재조회 0. rootKey 에서 출발해 parent_of 사슬(`장소개념→병원→피부과→한빛의원
 * 엔티티`)을 따라 닿는 모든 노드 키를 모은다. member_of 를 긋기 전, 자식이 이 집합에
 * 있으면 *이미 위계로 닿음* → 직접 member_of 를 생략한다(2-(a) 추이 감축과 같은
 * 정신·표시 단계 무대).
 *
 * 자기 루트는 결과에서 제외(visited 선등록). cycle/다중 경로 중복은 visited 가 막는다.
 */
function collectHierarchyDescendants(
  edgeSet: Map<string, GraphEdge>,
  rootKey: string,
): Set<string> {
  // from → [to...] 인접 목록을 parent_of 엣지만으로 한 번 모은다.
  const childrenOf = new Map<string, string[]>();
  for (const e of edgeSet.values()) {
    if (e.type !== "parent_of") continue;
    const arr = childrenOf.get(e.from) ?? [];
    arr.push(e.to);
    childrenOf.set(e.from, arr);
  }
  const visited = new Set<string>([rootKey]);
  const descendants = new Set<string>();
  let frontier = [rootKey];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const from of frontier) {
      for (const to of childrenOf.get(from) ?? []) {
        if (visited.has(to)) continue;
        visited.add(to);
        descendants.add(to);
        next.push(to);
      }
    }
    frontier = next;
  }
  return descendants;
}

/**
 * 합류된 개별 엔티티를 타입별로 모아 묶음 루트와 소속 엣지를 더한다.
 *
 * 묶음 루트는 두 갈래다(④ — spec §5.4):
 *   · 동명 위계 루트 개념이 nodeById 에 있으면(콜론 위계를 적은 장소 등) 그 개념
 *     노드를 묶음 루트로 *재사용* — 별도 group:<type> 가상 노드를 안 만든다("장소"
 *     한 노드로 통합).
 *   · 없으면(작품·사람·`#장소:카페` 단독 등) 기존대로 group:<type> 가상 노드를
 *     만든다(DB 행 아닌 메모리 위 표현·자식 0 타입은 빈 허브 금지 R2).
 *
 * member_of 는 추이 감축한다(⑤ — spec §5.4): 자식이 이미 parent_of 위계로 묶음
 * 루트에 닿으면(`장소→병원→피부과→한빛의원`) member_of 직접선을 생략해 묶음선이
 * 위계를 건너뛰지 않게 한다. 위계 없는 엔티티는 닿는 경로가 없어 member_of 직접
 * 연결 유지(묶음 기능 보존). 판정은 edgeSet 의 parent_of BFS 만 읽어 DB 재조회 0.
 *
 * 반환: 새로 만든 group:<type> 가상 노드 id 배열(검색 focus 강조 대상·Q1). 재사용한
 * 위계 루트 개념 노드는 이미 nodeById 에 있던 노드라 반환에 더하지 않는다.
 * 읽기 전용 — nodeById·edgeSet 만 in-place 변형하고 DB 쓰기·스키마 변경 0.
 */
export function buildGroupNodes(
  nodeById: Map<string, GraphNode>,
  edgeSet: Map<string, GraphEdge>,
  refs: AugmentResult,
): string[] {
  // 타입별 자식 노드 키를 모은다. 자식이 노드 집합 안일 때만 센다(양끝 불변식).
  const childrenByType = new Map<string, string[]>();
  const addChild = (typeName: string, childKey: string): void => {
    if (!nodeById.has(childKey)) return;
    const arr = childrenByType.get(typeName) ?? [];
    arr.push(childKey);
    childrenByType.set(typeName, arr);
  };
  for (const e of refs.entityRefs) addChild(e.type, entityKey(e.type, e.id));
  for (const pid of refs.personRefs) addChild("person", personKey(pid));
  for (const pid of refs.projectRefs) addChild("project", projectKey(pid));

  const createdGroupIds: string[] = [];
  for (const [typeName, childKeys] of childrenByType) {
    if (childKeys.length === 0) continue; // 빈 허브 금지(R2).

    // ④ 묶음 루트 결정 — 동명 위계 루트 개념이 있으면 재사용, 없으면 가상 노드.
    const hierarchyRootKey = findHierarchyRootNodeKey(nodeById, typeName);
    let rootKey: string;
    if (hierarchyRootKey) {
      rootKey = hierarchyRootKey; // 위계 루트 개념 노드를 묶음 루트로 재사용("장소" 한 노드).
      // ⑥ 거대 허브 시각 일관화(spec §5.4 ⑥·라이브) — 재사용한 위계 루트 개념 노드에
      //   거대 허브 신호를 덧입힌다. sourceType 을 "entity_group" 로 올리고 groupType 을
      //   그 타입(place 등)으로 채우면 nodes.ts nodeSizeOf·planNodeVisuals·decorations 의
      //   *기존* entity_group 통로가 그대로 거대 크기 + 자식과 같은 장식(place→ring)을 매긴다
      //   (새 시각 발명 0). 노드 키(conceptKey)는 그대로라 parent_of 출발점이 안 바뀌어
      //   "거대 허브이면서 위계 루트" 가 한 노드에서 양립한다. 라벨도 koName("장소") 유지
      //   (④ 통합으로 묶음 노드가 없어져 라벨 충돌 없음 — 접미사 안 붙인다).
      const rootNode = nodeById.get(rootKey);
      if (rootNode) {
        rootNode.sourceType = "entity_group";
        rootNode.groupType = typeName;
      }
    } else {
      rootKey = `group:${typeName}`;
      nodeById.set(rootKey, {
        id: rootKey,
        sourceType: "entity_group",
        groupType: typeName,
        label: groupLabel(typeName),
      });
      createdGroupIds.push(rootKey);
    }

    // ⑤ member_of 추이 감축 — 묶음 루트에서 위계로 이미 닿는 자식엔 member_of 생략.
    const hierarchyDescendants = collectHierarchyDescendants(edgeSet, rootKey);
    for (const childKey of childKeys) {
      if (hierarchyDescendants.has(childKey)) continue; // 위계로 닿음 → 직접선 생략.
      const edgeId = `edge:${rootKey}->${childKey}:member_of`;
      if (!edgeSet.has(edgeId)) {
        edgeSet.set(edgeId, { id: edgeId, from: rootKey, to: childKey, type: "member_of", weight: MEMBER_OF_WEIGHT });
      }
    }
  }
  return createdGroupIds;
}
