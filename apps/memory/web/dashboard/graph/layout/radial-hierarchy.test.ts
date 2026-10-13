import { test, expect } from "bun:test";
import { buildHierarchy, ORPHAN_PARENT } from "./radial-hierarchy.ts";
import { seedFromId } from "./force-layout.ts";
import type { GraphNode, GraphEdge } from "../graph-view-model.ts";
import {
  MENTION_ENTITY_EDGE_TYPE,
  MENTION_ENTITY_SIDE_EDGE_TYPE,
} from "../../../../src/server-internal/routes/graph-nodes-shared.ts";

const N = (id: string, type: string): GraphNode => ({ id, type: type as GraphNode["type"], label: id });
const E = (from: string, to: string, type: string, weight = 1): GraphEdge =>
  ({ id: `${from}->${to}:${type}`, from, to, type, weight });

// 실데이터 모양 fixture:
//  - group:project → project:p1 (member_of)
//  - project:p1 → node:1 (owns_memory)            프로젝트 글
//  - node:1 → concept:c1 (mention)                 그 글이 개념 c1 언급
//  - concept:c1 → concept:c2 (parent_of)           개념 사슬 c1 > c2
//  - node:solo → concept:cx (classification)       프로젝트 없는 개념전용 글
//  - node:ext → node:1 (merged_into)               원본 글에 합쳐진 추출 조각
//  - node:lonely                                   아무 데도 안 걸린 외톨이 글
function fixture(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = [
    N("group:project", "entity_group"),
    N("project:p1", "project"),
    N("node:1", "memory"),
    N("node:solo", "memory"),
    N("node:ext", "llm_extract"),
    N("node:lonely", "memory"),
    N("concept:c1", "concept"),
    N("concept:c2", "concept"),
    N("concept:cx", "concept"),
  ];
  const edges = [
    E("group:project", "project:p1", "member_of"),
    E("project:p1", "node:1", "owns_memory"),
    E("node:1", "concept:c1", "mention"),
    E("concept:c1", "concept:c2", "parent_of"),
    E("node:solo", "concept:cx", "classification"),
    E("node:ext", "node:1", "merged_into"),
  ];
  return { nodes, edges };
}

test("프로젝트 글은 owns_memory 프로젝트가 주 부모", () => {
  const { nodes, edges } = fixture();
  const h = buildHierarchy(nodes, edges);
  expect(h.parentOf.get("node:1")).toBe("project:p1");
});

test("묶음→인스턴스→글 깊이가 단조 증가", () => {
  const { nodes, edges } = fixture();
  const h = buildHierarchy(nodes, edges);
  expect(h.depthOf.get("group:project")).toBe(1);
  expect(h.depthOf.get("project:p1")).toBe(2);
  expect(h.depthOf.get("node:1")).toBe(3);
});

test("THE FIX — parent_of 없는 개념은 자기를 언급한 글이 주 부모", () => {
  const { nodes, edges } = fixture();
  const h = buildHierarchy(nodes, edges);
  // concept:c1 은 parent_of 부모가 없다. node:1 이 c1 을 mention 하므로 c1 부모 = node:1.
  expect(h.parentOf.get("concept:c1")).toBe("node:1");
});

test("개념 parent_of 사슬: 하위 개념 부모=상위 개념, 사슬 꼭대기는 언급 글에 붙는다", () => {
  const { nodes, edges } = fixture();
  const h = buildHierarchy(nodes, edges);
  // 하위 c2 의 부모는 parent_of(40)로 상위 c1 (글-언급 35 를 이김).
  expect(h.parentOf.get("concept:c2")).toBe("concept:c1");
  // 사슬 꼭대기 c1 은 언급한 글 node:1 의 자식.
  expect(h.parentOf.get("concept:c1")).toBe("node:1");
});

test("프로젝트 없이 개념에만 걸린 글은 그 개념 아래로 떨어진다(ORPHAN 아님)", () => {
  const { nodes, edges } = fixture();
  const h = buildHierarchy(nodes, edges);
  // node:solo 는 owns_memory·1급 엔티티 없음. concept:cx classification fallback(30)으로 매달린다.
  expect(h.parentOf.get("node:solo")).toBe("concept:cx");
  expect(h.parentOf.get("node:solo")).not.toBe(ORPHAN_PARENT);
});

test("완전 외톨이 글은 ORPHAN", () => {
  const { nodes, edges } = fixture();
  const h = buildHierarchy(nodes, edges);
  expect(h.parentOf.get("node:lonely")).toBe(ORPHAN_PARENT);
});

test("merged_into 추출 조각은 원본 글이 부모·구조 엣지(cross-edge 아님)", () => {
  const { nodes, edges } = fixture();
  const h = buildHierarchy(nodes, edges);
  // node:ext → node:1 (merged_into): to 가 부모라 부모 = 원본 글 node:1.
  expect(h.parentOf.get("node:ext")).toBe("node:1");
  expect(h.parentOf.get("node:ext")).not.toBe(ORPHAN_PARENT);
  // merged_into 는 구조 엣지라 cross-edge 로 새지 않는다.
  expect(h.crossEdges.some((e) => e.type === "merged_into")).toBe(false);
  // 깊이는 원본 글보다 하나 더 바깥.
  expect(h.depthOf.get("node:ext")).toBe(h.depthOf.get("node:1")! + 1);
});

test("merged_into 없는 llm_extract 는 매달릴 데 없어 ORPHAN", () => {
  // merged_into 엣지를 떼면 추출 조각은 1급·2급 아니라 ORPHAN 이 맞다.
  const nodes = [N("node:ext", "llm_extract")];
  const edges: GraphEdge[] = [];
  const h = buildHierarchy(nodes, edges);
  expect(h.parentOf.get("node:ext")).toBe(ORPHAN_PARENT);
});

test("한 개념을 프로젝트 글 둘이 언급하면 하나는 구조 부모·다른 하나는 cross-edge", () => {
  const nodes = [
    N("project:p1", "project"),
    N("node:a", "memory"),
    N("node:b", "memory"),
    N("concept:shared", "concept"),
  ];
  const edges = [
    E("project:p1", "node:a", "owns_memory"),
    E("project:p1", "node:b", "owns_memory"),
    E("node:a", "concept:shared", "mention"),
    E("node:b", "concept:shared", "mention"),
  ];
  const h = buildHierarchy(nodes, edges);
  // concept:shared 는 글 둘 중 하나만 주 부모로 가진다(seedFromId 결정).
  const chosen = h.parentOf.get("concept:shared")!;
  expect(chosen === "node:a" || chosen === "node:b").toBe(true);
  // 나머지 글→개념 언급 엣지는 cross-edge 로 빠진다.
  const other = chosen === "node:a" ? "node:b" : "node:a";
  expect(h.crossEdges.some((e) => e.from === other && e.to === "concept:shared")).toBe(true);
});

test("결정적 — 같은 입력 두 번 같은 결과", () => {
  const a = buildHierarchy(...(Object.values(fixture()) as [GraphNode[], GraphEdge[]]));
  const b = buildHierarchy(...(Object.values(fixture()) as [GraphNode[], GraphEdge[]]));
  expect([...a.parentOf]).toEqual([...b.parentOf]);
});

test("위계 잎 작품 — 주 부모가 작가 관계(60) 아닌 분류 parent_of(40)", () => {
  // #작품:소설 #소설:괴담 #작가:백덕수 입력 → 데이터:
  //   - 소설(개념) → 괴담(work) parent_of (분류 위계 40·D1 라이브로 확인)
  //   - 괴담(work) → 백덕수(person) created_by (작가 관계 엣지·entity_relation_edges)
  // 관계 엣지는 to=백덕수(1급)라 from=괴담을 60+w prio 로 백덕수의 자식 후보로 민다.
  // 그게 parent_of(40)를 이겨 괴담이 작가 백덕수 옆으로 쏠리는 라이브 회귀(D1).
  // 가드: 괴담은 위계 안 노드(parent_of target)라 그 60 후보를 뺀다 → 분류 소설이 주 부모.
  const nodes = [
    N("work1", "work"),
    N("백덕수", "person"),
    N("소설", "concept"),
  ];
  const edges = [
    E("work1", "백덕수", "created_by"),   // 작품 → 작가 관계 60 (위계 안 노드라 제외 대상)
    E("소설", "work1", "parent_of", 0.9), // 분류 → 작품 위계 40
  ];
  const h = buildHierarchy(nodes, edges);
  // work1 은 위계 안(parent_of target)이라 작가 관계 후보 제외 → 분류 소설이 주 부모.
  expect(h.parentOf.get("work1")).toBe("소설");
  // 빠진 작품 → 작가 관계 엣지는 cross-edge 로 남는다(표시는 유지).
  expect(h.crossEdges.some((e) => e.from === "work1" && e.to === "백덕수")).toBe(true);
});

test("위계 없는 작품 — 작가 관계 60 후보가 주 부모(회귀 0)", () => {
  // parent_of 분류 부모가 없는 일반 1급 엔티티는 60 관계 후보가 그대로 주 부모.
  // 위계 밖이라 가드가 건드리지 않는다(영향 0).
  const nodes = [N("work2", "work"), N("백덕수", "person")];
  const edges = [E("work2", "백덕수", "created_by")];
  const h = buildHierarchy(nodes, edges);
  expect(h.parentOf.get("work2")).toBe("백덕수");
});

test("위계 안 글(memory)의 글→1급 mention 도 제외 — 사슬 안 뒤집힘(graph-augment S1-LIVE 회귀)", () => {
  // 글이 위계 잎(parent_of target)인 경우: 글→1급 엔티티 mention(60)이 그 글의 위계
  // 부모(parent_of 40)를 이겨 사슬을 뒤집던 graph-augment 주석의 실측 회귀.
  // 가드는 mention 의 child(e.from=글)가 위계 안이면 그 60 후보를 뺀다.
  const nodes = [
    N("doc1", "memory"),
    N("백덕수", "person"),
    N("일정", "concept"),
  ];
  const edges = [
    E("doc1", "백덕수", "mention"),       // 글 → 1급 언급 60 (위계 안 글이라 제외 대상)
    E("일정", "doc1", "parent_of", 0.9),  // 분류 → 글 위계 40
  ];
  const h = buildHierarchy(nodes, edges);
  expect(h.parentOf.get("doc1")).toBe("일정");
});

test("G1 — 글→works행 신설 type(70) 이 글→소설 mention(60) 을 이긴다", () => {
  // 분리 잎 개념을 거쳐 합류한 works 행을 graph-augment 가 글의 주 부모로 승격한
  // 간선(MENTION_ENTITY_EDGE_TYPE·prio 70)과, 글→매체 개념(소설) mention(60) 후보가
  // 함께 있을 때, 70 이 60 을 이겨 글이 자기 works 행 아래 직접 매달린다.
  const nodes = [
    N("node:1", "memory"),
    N("wrk_괴담소설", "work"),
    N("백덕수", "person"),
  ];
  const edges = [
    // works 행 → 글 승격 간선(from=부모·to=자식·prio 70).
    E("wrk_괴담소설", "node:1", MENTION_ENTITY_EDGE_TYPE, 0.7),
    // 글 → 작가(1급 person) mention 60 — works행 70 이 이겨야 한다.
    E("node:1", "백덕수", "mention", 1),
  ];
  const h = buildHierarchy(nodes, edges);
  expect(h.parentOf.get("node:1")).toBe("wrk_괴담소설");
});

test("G1 — 프로젝트 owns_memory(100) 가 글→works행 신설 type(70) 을 이긴다", () => {
  // 프로젝트 소속 글이 동시에 works 행 승격 간선을 받아도, 프로젝트(100)가
  // works행(70)을 이겨 프로젝트 소속 글 우선이 유지된다(owns_memory > 신설 type).
  const nodes = [
    N("node:1", "memory"),
    N("wrk_x", "work"),
    N("project:p1", "project"),
  ];
  const edges = [
    E("wrk_x", "node:1", MENTION_ENTITY_EDGE_TYPE, 0.7),
    E("project:p1", "node:1", "owns_memory", 0.7),
  ];
  const h = buildHierarchy(nodes, edges);
  expect(h.parentOf.get("node:1")).toBe("project:p1");
});

test("G4 — 사람 주체 글: 글→works행 곁다리 type 은 부모 후보 아님·주 부모 = 사람(60)", () => {
  // 사람 주체 글은 글→works행 간선을 비부모 곁다리 type(MENTION_ENTITY_SIDE_EDGE_TYPE)으로
  // 받는다. 그 type 은 PARENT_IS_FROM·PARENT_IS_TO 밖이라 buildHierarchy 가 부모 후보로 안
  // 써, 글의 주 부모가 글→백덕수 mention(60) 이 된다(작품은 곁다리 cross-edge).
  const nodes = [
    N("node:3", "memory"),
    N("wrk_괴담소설", "work"),
    N("백덕수", "person"),
  ];
  const edges = [
    // 곁다리 — 부모 후보가 안 되는 type(from=works행·to=글).
    E("wrk_괴담소설", "node:3", MENTION_ENTITY_SIDE_EDGE_TYPE, 0.7),
    // 글 → 백덕수(1급 person) mention 60 — 주 부모가 돼야 한다.
    E("node:3", "백덕수", "mention", 1),
  ];
  const h = buildHierarchy(nodes, edges);
  expect(h.parentOf.get("node:3")).toBe("백덕수");
  // works 행은 부모가 아니라 곁다리(cross-edge)로 남는다.
  const cross = h.crossEdges.some(
    (e) => e.type === MENTION_ENTITY_SIDE_EDGE_TYPE && e.from === "wrk_괴담소설",
  );
  expect(cross).toBe(true);
});

test("동점 부모 후보 둘이면 seedFromId 작은 쪽으로 결정적 고정", () => {
  // 글 하나가 1급 엔티티 둘을 같은 종류(person)·같은 weight 로 mention.
  // 두 후보는 우선순위(60+동일 weight)가 같아 seedFromId tie-break 으로 갈린다.
  const nodes = [
    N("person:a", "person"),
    N("person:b", "person"),
    N("node:tie", "memory"),
  ];
  const edges = [
    E("node:tie", "person:a", "mention", 1),
    E("node:tie", "person:b", "mention", 1),
  ];

  // 구현 규칙을 재현하지 않고, seedFromId 작은 쪽이 어느 후보인지만 미리 정한다.
  const expected =
    seedFromId("person:a") <= seedFromId("person:b") ? "person:a" : "person:b";

  const h1 = buildHierarchy(nodes, edges);
  const h2 = buildHierarchy(nodes, edges);

  // 두 번 호출해도 같은 한쪽으로 고정.
  expect(h1.parentOf.get("node:tie")).toBe(h2.parentOf.get("node:tie"));
  // 그 한쪽이 seedFromId 작은 후보임을 명시적으로 단정.
  expect(h1.parentOf.get("node:tie")).toBe(expected);
});
