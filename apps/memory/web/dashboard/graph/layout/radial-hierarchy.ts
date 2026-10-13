/**
 * 계층 방사 spanning tree 빌더.
 *
 * 뷰모델 노드·엣지에서 각 노드의 주 부모(하나)·깊이·자손 잎 수를 정하고,
 * 주 부모로 선택되지 않은 엣지를 cross-edge 로 분류한다.
 *
 * 이 모듈은 좌표 계산과 렌더에 관여하지 않는다.
 * Task 2(해석적 방사 좌표)가 이 출력을 입력으로 받는다.
 */
import type { GraphNode, GraphEdge } from "../graph-view-model.ts";
import { isFirstTier, isSecondTier } from "./ball-assignment.ts";
import { seedFromId } from "./force-layout.ts";
import { MENTION_ENTITY_EDGE_TYPE } from "../../../../src/server-internal/routes/graph-nodes-shared.ts";

/** 부모 없는 노드를 표시하는 특수 id. roots 와 구분한다. */
export const ORPHAN_PARENT = "__orphan__";

/** 가상 루트 id. parentOf 에서 내부용으로 쓰인다. */
const ROOT = "__root__";

/**
 * 엣지 type 에서 from 이 부모인 구조 엣지.
 * owns_memory:     프로젝트 → 글
 * member_of:       entity_group → 인스턴스
 * parent_of:       상위개념 → 하위개념
 * contains_section/document_chunk: 문서 → 섹션 → 청크
 * mentions_entity: works 행 → 글(graph-augment 승격 간선·글이 자기 works 행 자식)
 */
const PARENT_IS_FROM: ReadonlySet<string> = new Set([
  "owns_memory",
  "member_of",
  "parent_of",
  "contains_section",
  "contains_chunk",
  MENTION_ENTITY_EDGE_TYPE,
]);

/**
 * 엣지 type 에서 to 가 부모인 구조 엣지(자식 → 부모).
 * merged_into: atomic 자식(llm_extract)이 원본 글을 가리킨다.
 */
const PARENT_IS_TO: ReadonlySet<string> = new Set(["merged_into"]);

/**
 * 구조 엣지별 주 부모 우선순위.
 * 숫자가 클수록 우선한다.
 */
const STRUCTURAL_PRIORITY: Record<string, number> = {
  owns_memory: 100,
  merged_into: 95,
  member_of: 90,
  // works 행 → 글 승격 간선 — parent_of(40) 보다 높아 글이 매체 mention(60) 이 아니라
  // 자기 works 행 아래 매달리고, owns_memory(100)·member_of(90) 보다 낮아 프로젝트
  // 소속·묶음 소속이 우선한다(plan G1·Q2-1).
  [MENTION_ENTITY_EDGE_TYPE]: 70,
  contains_section: 55,
  contains_chunk: 55,
  parent_of: 40,
};

export interface Hierarchy {
  /** 각 노드 id → 주 부모 id (ROOT "__root__" 은 포함되지 않음). */
  parentOf: Map<string, string>;
  /** 각 노드 id → 자식 id 배열 (결정적 정렬). */
  childrenOf: Map<string, string[]>;
  /** 각 노드 id → 깊이 (루트=1). 고아 노드는 포함되지 않는다. */
  depthOf: Map<string, number>;
  /** 각 노드 id → 자손 잎 수. */
  descendantLeaves: Map<string, number>;
  /** 가상 루트 직결 노드 id 목록 (1급·2급 엔티티·entity_group). */
  roots: string[];
  /** 주 부모로 선택되지 않은 나머지 엣지. 표시 전용. */
  crossEdges: GraphEdge[];
}

/**
 * 뷰모델 노드·엣지를 받아 계층 구조를 반환한다.
 *
 * 주 부모 우선순위:
 *   owns_memory(100) > merged_into(95) > member_of(90) > mentions_entity(70) >
 *   1급 언급(60+w) > parent_of(40) / 2급 언급(40+w) > 루트 직결 > ORPHAN_PARENT
 */
export function buildHierarchy(nodes: GraphNode[], edges: GraphEdge[]): Hierarchy {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const present = (id: string) => byId.has(id);

  // 양쪽 노드가 모두 존재하는 엣지만 처리한다.
  const usable = edges.filter((e) => present(e.from) && present(e.to));

  // 위계 안 노드 집합 — parent_of 위계의 자식(target) id 를 모은다.
  // parent_of 는 PARENT_IS_FROM 이라 from 이 부모·to 가 자식이다(분류 → 작품).
  // 이 집합에 든 노드는 자기 분류 위계(소설·일정 등)를 주 부모로 가져야 하므로,
  // 글→1급 mention·작품→작가 관계 같은 60+w 후보가 그 노드를 child 로 끌어가
  // parent_of(40)를 이기지 못하게 막는다(D1 라이브 회귀·graph-augment S1-LIVE 주석).
  const inHierarchy = new Set<string>();
  for (const e of usable) {
    if (e.type === "parent_of") inHierarchy.add(e.to);
  }

  // 각 노드 id → 부모 후보 목록(우선순위+부모 id).
  const cand = new Map<string, { parent: string; prio: number }[]>();

  const pushCand = (child: string, parent: string, prio: number) => {
    let list = cand.get(child);
    if (!list) { list = []; cand.set(child, list); }
    list.push({ parent, prio });
  };

  for (const e of usable) {
    if (PARENT_IS_FROM.has(e.type)) {
      // 구조 엣지: from 이 부모, to 가 자식.
      pushCand(e.to, e.from, STRUCTURAL_PRIORITY[e.type] ?? 30);
      continue;
    }
    if (PARENT_IS_TO.has(e.type)) {
      // 구조 엣지(방향 반대): to 가 부모, from 이 자식.
      pushCand(e.from, e.to, STRUCTURAL_PRIORITY[e.type] ?? 30);
      continue;
    }
    const from = byId.get(e.from), to = byId.get(e.to);
    if (!from || !to) continue;
    // 가중치를 미세 tie-break 으로 활용한다(순위 역전 방지를 위해 0.001 배율).
    const w = (e.weight ?? 0) * 0.001;
    if (isSecondTier(to.type)) {
      // 무언가 → 개념(의미추출): 개념을 그 출처(글/엔티티)의 자식으로 둬 바깥으로 이어 붙인다.
      pushCand(e.to, e.from, 35 + w);
      // 출처가 글(1급 엔티티 아님)이면, 글이 달리 매달릴 데 없을 때 개념 아래로 떨어지는 fallback.
      if (!isFirstTier(from.type)) pushCand(e.from, e.to, 30 + w);
    } else if (isFirstTier(to.type)) {
      // 무언가 → 1급 엔티티(글 mention·작품→작가 관계 등): to(1급)를 from 의 후보 부모로.
      // 단 from 이 위계 안 노드면 그 60 후보를 뺀다 — 자기 분류 parent_of(40)를
      // 60 이 이겨 위계 사슬이 뒤집히는 걸 막는다(엣지는 cross-edge 로 표시는 유지).
      if (!inHierarchy.has(e.from)) pushCand(e.from, e.to, 60 + w);
    }
  }

  // 주 부모 결정: 우선순위 내림차순, 동점이면 seedFromId 로 결정적 선택.
  const parentOf = new Map<string, string>();

  for (const n of nodes) {
    if (n.type === "entity_group") {
      // entity_group 은 항상 루트 직결.
      parentOf.set(n.id, ROOT);
      continue;
    }

    const list = cand.get(n.id);
    if (!list || list.length === 0) {
      if (isFirstTier(n.type) || isSecondTier(n.type)) {
        parentOf.set(n.id, ROOT);
      } else {
        parentOf.set(n.id, ORPHAN_PARENT);
      }
      continue;
    }

    list.sort(
      (a, b) => (b.prio - a.prio) || (seedFromId(a.parent) - seedFromId(b.parent))
    );
    parentOf.set(n.id, list[0]!.parent);
  }

  // 순환 감지·차단: 주 부모 사슬에 같은 노드가 다시 나오면 그 순환을 끊는다.
  // 끊을 때 순환 멤버 중 second-tier(개념)를 우선 루트 직결로 보낸다 — 그래야
  // 글↔개념 상호 지목 시 글이 개념 밑에 남고, 개념은 중심에서 가지를 시작한다.
  for (const n of nodes) {
    const seen = new Set<string>([n.id]);
    const order: string[] = [n.id];
    let p = parentOf.get(n.id);
    let guard = 0;
    while (p && p !== ROOT && p !== ORPHAN_PARENT && guard++ < 64) {
      if (seen.has(p)) {
        // p 부터 다시 만난 지점까지가 순환. 그 안에서 끊을 노드를 고른다.
        const cycle = order.slice(order.indexOf(p));
        const concept = cycle.find((id) => isSecondTier(byId.get(id)!.type));
        const cut = concept ?? cycle[0]!;
        parentOf.set(cut, ROOT);
        break;
      }
      seen.add(p);
      order.push(p);
      p = parentOf.get(p);
    }
  }

  // childrenOf 와 roots 구성.
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];

  for (const n of nodes) {
    const p = parentOf.get(n.id)!;
    if (p === ROOT) {
      roots.push(n.id);
      continue;
    }
    if (p === ORPHAN_PARENT) continue;
    let kids = childrenOf.get(p);
    if (!kids) { kids = []; childrenOf.set(p, kids); }
    kids.push(n.id);
  }

  // 결정적 정렬.
  roots.sort((a, b) => seedFromId(a) - seedFromId(b));
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => seedFromId(a) - seedFromId(b));
  }

  // BFS 로 깊이 계산.
  const depthOf = new Map<string, number>();
  const queue: string[] = [];
  for (const r of roots) { depthOf.set(r, 1); queue.push(r); }
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    const d = depthOf.get(id)!;
    for (const c of childrenOf.get(id) ?? []) {
      if (!depthOf.has(c)) {
        depthOf.set(c, d + 1);
        queue.push(c);
      }
    }
  }

  // 자손 잎 수 계산(메모이제이션 재귀).
  const descendantLeaves = new Map<string, number>();
  const leafCount = (id: string): number => {
    const cached = descendantLeaves.get(id);
    if (cached !== undefined) return cached;
    const kids = childrenOf.get(id) ?? [];
    const v = kids.length === 0 ? 1 : kids.reduce((s, c) => s + leafCount(c), 0);
    descendantLeaves.set(id, v);
    return v;
  };
  for (const r of roots) leafCount(r);

  // 주 부모로 선택된 엣지를 키 집합으로 기록한다.
  const usedKey = new Set<string>();
  for (const [child, parent] of parentOf) {
    if (parent === ROOT || parent === ORPHAN_PARENT) continue;
    usedKey.add(`${parent}|${child}`);
    usedKey.add(`${child}|${parent}`);
  }

  // 나머지 usable 엣지가 cross-edge 다.
  const crossEdges = usable.filter((e) => !usedKey.has(`${e.from}|${e.to}`));

  return { parentOf, childrenOf, depthOf, descendantLeaves, roots, crossEdges };
}
