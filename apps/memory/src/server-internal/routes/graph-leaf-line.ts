/**
 * server-internal/routes/graph-leaf-line.ts — ⑦⑨ 글-허브 연결선 정리.
 *
 * 위계 사슬 상위 분류·타입 허브로 가는 글-선을 거르고 잎(실제 엔티티)에만 남기는
 * pruneClassificationLeafLines 와 거름 대상 role 집합(PRUNABLE_LINE_TYPES)을 담는다.
 * graph.ts 에서 책임 단위로 옮겨 왔다(CLAUDE.md "파일 작게") — 동작 불변(순수 이동).
 *
 * 공유 토대는 graph-nodes-shared.ts 에 의존한다. 읽기 전용 — edgeSet 만 in-place
 * 변형. 쓰기 0 / 스키마 변경 0 / RRF 코어 0.
 */

import {
  MENTION_ENTITY_EDGE_TYPE,
  OWNS_MEMORY_EDGE_TYPE,
  type GraphNode,
  type GraphEdge,
} from "./graph-nodes-shared.ts";
import type { ConceptRole, PersonRelation } from "../../memory/types.ts";

/**
 * ⑨ 글-선 거름 대상 type — 글→개념/사람/허브 표시 선만 담는다.
 *
 * 글-선 type 의 단일 출처는 graph-augment.ts 가 addEntityEdge 에 싣는 실제 값이다:
 *   - 글→개념(node_concept_edges.role) = ConceptRole = "tag"|"classification"|"mention"|"visual"
 *   - 글→사람(node_person_edges.relation) = PersonRelation = "mentions"|"authored_by"
 *
 * prune 대상은 그중 *위계 사슬 상위로 잉여로 가는* 선뿐이다:
 *   - classification·tag·mention(글→개념 분류·태그·언급) — 잎까지 닿으면 상위는 잉여.
 *   - mentions(글→사람 언급) — 위계 잎 사람(이몽룡·성춘향)에 닿는 선. 이게 빠지면
 *     그 사람이 prune 후보(coTarget)에서 누락돼 조상 분류(막내·가족)로 가는 글-선이
 *     안 지워진다(S1-LIVE 실측 결함 — 글이 위계 잎 사람 + 상위 분류 두 군데에 보임).
 *
 * 제외 — visual(글→시각 개념)·authored_by(글→작성자)는 위계 사슬 잉여가 아니라
 * 의미 있는 직결이라 거르지 않는다.
 *
 * 단일 출처 정합 — 각 멤버를 ConceptRole / PersonRelation union 으로 좁혀 satisfies 로
 * 검증한다. node_person_edges 의 relation 이 'mentions'(복수)인데 옛 집합은
 * 'mention'(단수)만 담아 글→사람 선이 누락되던 단수/복수 드리프트를, 타입 위반이면
 * 컴파일이 멈추게 해 구조적으로 차단한다(types.ts 가 문자열의 단일 출처).
 */
const CONCEPT_PRUNABLE_ROLES = ["classification", "tag", "mention"] as const satisfies ConceptRole[];
const PERSON_PRUNABLE_RELATIONS = ["mentions"] as const satisfies PersonRelation[];
const PRUNABLE_LINE_TYPES: ReadonlySet<string> = new Set<string>([
  ...CONCEPT_PRUNABLE_ROLES,
  ...PERSON_PRUNABLE_RELATIONS,
]);
const STRUCTURAL_LEAF_LINE_TYPES: ReadonlySet<string> = new Set<string>([
  OWNS_MEMORY_EDGE_TYPE,
  MENTION_ENTITY_EDGE_TYPE,
]);

/**
 * ⑦⑨ 글-허브 연결선 정리 — 위계 사슬 상위 분류·타입 허브로 가는 글-선을 거르고
 * 잎(실제 엔티티)에만 남긴다(spec 2026-06-13 그래프 노드 흡수 §5.4 ⑦⑨·라이브).
 *
 * ⑨ 가 ⑦ 의 상위집합이다 — ⑦ 은 classification 글-선만 걸렀고, ⑨ 는 거름 대상 type 을
 * 글→개념(classification·tag·mention) + 글→사람(mentions) 로 넓혀(글→개념/사람/허브
 * 표시 선 전부) 원본이 거대 허브에 mention/tag 로 직접 붙던 라이브 결함(관찰 1)과,
 * 글이 위계 잎 사람 + 상위 분류 두 군데에 보이던 결함(S1-LIVE)까지 푼다. 조상 판정·
 * 과삭제 차단은 ⑦ 과 같다.
 *
 * 한 글이 같은 사슬의 여러 끝점(`장소·병원·피부과·한빛의원` 또는 타입 허브 "일정")에
 * 글-선을 다 가지면, 그 글→상위(다른 끝점의 조상) 선을 거르고 글→잎(가장 깊은 후손)
 * 선만 남긴다. 조상 판정 = edgeSet 의 parent_of + member_of 사슬(허브→…→엔티티 멤버
 * 경로 포함) BFS — DB 재조회 0.
 *
 * 위계 단일 출처(S2-T3·흡수 폐기) 정합 — 옛날엔 ②⑧ 흡수가 글→그림자개념 선을 글→
 * 엔티티 행으로 재지정한 뒤 이 함수가 그 edgeSet 위에서 걸렀다. 이제 흡수가 사라져
 * 엔티티 행은 흡수가 아니라 *위계 잎으로 직접* 노드 집합에 합류하고(graph-augment 블록
 * 1.55 위계 자식·1.5b identity 역조회·1.6b 상위), 블록 2 가 부모 분류 개념 → 엔티티 행
 * parent_of 위계선을 *직접* 긋는다. 그래서 엔티티 행이 edgeSet 의 parent_of 끝점(자식)
 * 으로 들어와 조상 판정 BFS 가 그 행을 잎으로 잡는다 — 재지정이 아니라 직접 연결을
 * 보는 차이뿐, 거름 로직(상위 사슬 글-선 제거)은 그대로다. ⑧ 동명 합치기가 태그↔타입
 * 루트를 한 노드로 묶어둔 뒤일 수 있으나(예 "일정"), 그래도 끝점이 parent_of/member_of
 * 로 잎의 조상이면 거름되므로 일관된다.
 *
 * 과삭제 차단:
 *   · 글이 이은 끝점 중 어느 것도 다른 끝점의 조상이 아니면(서로 무관한 둘) 둘 다 남긴다.
 *   · 끝점 하나뿐인 글은 그 선을 남긴다(글이 어디에도 안 붙는 외톨이 방지).
 *
 * 검색 무영향 — node_concept_edges·node_person_edges DB 무변경(classification·tag·
 * mention·mentions 전부)·RRF 무변경.
 * 오직 그래프 빌드 산출 edgeSet(메모리)에서만 표시 엣지를 거른다. 읽기 전용 — edgeSet 만
 * in-place 변형하고 DB 쓰기·스키마 변경 0.
 */
export function pruneClassificationLeafLines(
  nodeById: Map<string, GraphNode>,
  edgeSet: Map<string, GraphEdge>,
): void {
  // 1) 조상 인접 목록(부모/허브 → [자식...]) — parent_of(위계) + member_of(허브 멤버)
  //    둘 다 모은다. 허브가 엔티티의 조상인 멤버 경로(허브→장터당번)도 조상으로 잡혀야
  //    원본이 허브에 직접 붙은 글-선이 잎으로 정리된다(⑨·관찰 1).
  const childrenOf = new Map<string, string[]>();
  for (const e of edgeSet.values()) {
    if (e.type !== "parent_of" && e.type !== "member_of") continue;
    const arr = childrenOf.get(e.from) ?? [];
    arr.push(e.to);
    childrenOf.set(e.from, arr);
  }

  /** key 에서 parent_of/member_of 사슬로 닿는 후손 집합(자기 제외)을 BFS 로 모은다. */
  const reachableFrom = (key: string): Set<string> => {
    const seen = new Set<string>([key]);
    const out = new Set<string>();
    let frontier = [key];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const from of frontier) {
        for (const to of childrenOf.get(from) ?? []) {
          if (seen.has(to)) continue;
          seen.add(to);
          out.add(to);
          next.push(to);
        }
      }
      frontier = next;
    }
    return out;
  };

  // 2) 글 노드마다 그 글의 글-선(끝점 노드 키 + 엣지 id)을 모은다.
  //    글-선 = from 이 글 노드(node:) 이고 type ∈ PRUNABLE_LINE_TYPES 인 엣지(⑨).
  //    글→개념(classification·tag·mention) + 글→사람(mentions) 전부 후보로 모은다.
  //    project/entity leaf 가 부모 방향으로 그은 구조선(owns_memory·mentions_entity)도
  //    coTarget 으로만 모은다. 이 구조선 자체는 삭제하지 않고, 그 leaf 조상으로 향하는
  //    node-origin 분류선만 삭제 후보가 된다.
  //    엣지 id 를 함께 들고 있어 제거 시 키를 재조립하지 않고 그대로 delete 한다(id 양식 drift 무관).
  const linesByMemoryNode = new Map<
    string,
    { target: string; edgeId: string; prunable: boolean }[]
  >();
  for (const e of edgeSet.values()) {
    if (PRUNABLE_LINE_TYPES.has(e.type)) {
      if (!e.from.startsWith("node:") || !nodeById.has(e.from)) continue; // 글 노드 출발만.
      const arr = linesByMemoryNode.get(e.from) ?? [];
      arr.push({ target: e.to, edgeId: e.id, prunable: true });
      linesByMemoryNode.set(e.from, arr);
      continue;
    }
    if (!STRUCTURAL_LEAF_LINE_TYPES.has(e.type)) continue;
    if (!e.to.startsWith("node:") || !nodeById.has(e.to) || !nodeById.has(e.from)) continue;
    const arr = linesByMemoryNode.get(e.to) ?? [];
    arr.push({ target: e.from, edgeId: e.id, prunable: false });
    linesByMemoryNode.set(e.to, arr);
  }

  // 3) 각 글에 대해, 같은 사슬의 *조상* 인 끝점으로 가는 글-선을 거른다.
  //    끝점 T 가 같은 글의 다른 끝점 U 의 조상(parent_of/member_of 로 U 에 닿음)이면 T 는
  //    상위 → 글→T 글-선을 뗀다. 어느 끝점의 조상도 아닌 끝점(잎·서로 무관)은 남긴다.
  for (const [, lines] of linesByMemoryNode) {
    if (lines.length < 2) continue; // 끝점 하나뿐인 글은 그대로(외톨이 방지).
    const coTargets = new Set(lines.map((l) => l.target));
    for (const { target, edgeId, prunable } of lines) {
      if (!prunable) continue;
      const descendants = reachableFrom(target);
      // target 이 같은 글의 다른 끝점 u 의 조상이면 상위 → 제거.
      let isAncestorOfCoTarget = false;
      for (const u of coTargets) {
        if (u === target) continue;
        if (descendants.has(u)) { isAncestorOfCoTarget = true; break; }
      }
      if (isAncestorOfCoTarget) edgeSet.delete(edgeId);
    }
  }
}
