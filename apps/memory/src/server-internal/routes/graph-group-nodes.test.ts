/**
 * graph-group-nodes.test.ts — buildGroupNodes 가상 묶음 노드 검증.
 *
 * 그래프 타입 묶음 노드 plan Task 1.
 * 실제 bun:sqlite(:memory:) + 실제 SqliteMemoryStore 통합 — Mock 클래스 0.
 * graph-project-augment.test.ts 의 셋업 패턴을 재사용한다.
 */
import {
  afterAll, afterEach, beforeAll, beforeEach, describe, expect, test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { loadEmbedder, makeGraphTestDeps } from "./graph.test-helpers.ts";
import type { GraphTestContext } from "./graph.test-helpers.ts";
import type { SqliteMemoryStore } from "../../db/store.ts";
import { augmentWithEntities, buildGroupNodes, PROJECTS_PER_NODE } from "./graph.ts";
import type { GraphNode, GraphEdge } from "./graph.ts";

beforeAll(async () => { await loadEmbedder(); });
afterAll(() => {});

let ctx: GraphTestContext;
let store: SqliteMemoryStore;
let db: Database;

beforeEach(async () => { ctx = await makeGraphTestDeps(); store = ctx.store; db = ctx.db; });
afterEach(() => { ctx.close(); });

function insertConcept(conceptId: string, name: string): void {
  db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES (?, ?)").run(conceptId, name);
}
function insertNode(content: string): number {
  const r = db.prepare("INSERT INTO knowledge_nodes (content) VALUES (?)").run(content);
  return Number(r.lastInsertRowid);
}
function linkNodeConcept(nodeId: number, conceptId: string): void {
  db.prepare("INSERT INTO node_concept_edges (node_id, concept_id, role, provenance, source_node_id) VALUES (?, ?, 'identity', 'user_input', NULL)").run(nodeId, conceptId);
}
function insertProject(projectId: string, name: string): void {
  // 단계4 T7'b(종류 통일) — 프로젝트 본체는 범용 entities(type_name='project')에 산다
  // (전용 projects 테이블은 T9'·v30 으로 DROP 됨). getProjectsByConceptId 가 entities 를
  // JOIN 해 찾으므로 fixture 도 entities 에 넣어야 production 통로가 합류한다.
  db.prepare(
    `INSERT INTO entities (entity_id, type_name, name, created_at, updated_at)
     VALUES (?, 'project', ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
  ).run(projectId, name);
}
function linkProjectConcept(projectId: string, conceptId: string, role: string): void {
  // 프로젝트 라벨 엣지도 통합 entity_concept_edges(entity_id 끝점)에 산다(T4·T9' 후
  // project_concept_edges 부재).
  db.prepare(
    `INSERT INTO entity_concept_edges (entity_id, concept_id, role, created_at, provenance, source_node_id) VALUES (?, ?, ?, '2026-01-01 00:00:00', 'user_input', NULL)`,
  ).run(projectId, conceptId, role);
}
/**
 * persons 행을 삽입한다(기준 스키마 persons = person_id·display_name 필수,
 * 나머지 nullable). augmentWithEntities 1) 블록이 node_person_edges 로 이 사람을
 * 글에 잇고 collectedPersonRefs 에 담는다 → buildGroupNodes 의 person 갈래가 탄다.
 */
function insertPerson(personId: string, displayName: string): void {
  db.prepare(
    `INSERT INTO persons (person_id, display_name, created_at, updated_at)
     VALUES (?, ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
  ).run(personId, displayName);
}
/** 글↔사람을 node_person_edges(node_id, person_id, relation)로 잇는다. */
function linkNodePerson(nodeId: number, personId: string, relation: string): void {
  db.prepare(
    `INSERT INTO node_person_edges (node_id, person_id, relation, created_at, provenance, source_node_id) VALUES (?, ?, ?, '2026-01-01 00:00:00', 'user_input', NULL)`,
  ).run(nodeId, personId, relation);
}
/**
 * 작품(work) 행 + identity 엣지(검색 JOIN 키) + 위계 잎 엣지를 만든다.
 *
 * 위계 단일 출처(S2-T1·S2-T3) — work 행이 그래프 노드로 합류하려면 hierarchy_edges
 * 위계 잎이어야 한다(옛 identity 역조회 흡수 폐기). conceptId(글이 언급하는 그 개념)를
 * 위계 부모로 두고 conceptId → work 행 parent_of 를 직접 쓴다 — 그러면 글이 그 개념을
 * 언급해 집합 안일 때 work 행이 위계 잎으로 합류한다.
 */
function insertWorkLinkedToConcept(workId: string, name: string, conceptId: string): void {
  // 단계4 T4(종류 통일) — work 행은 통일 entities 에 산다(전용 works 폐기).
  db.prepare(
    `INSERT INTO entities (entity_id, type_name, name, created_at, updated_at)
     VALUES (?, 'work', ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
  ).run(workId, name);
  db.prepare(
    `INSERT INTO entity_concept_edges (entity_id, concept_id, role, created_at, provenance, source_node_id) VALUES (?, ?, 'identity', '2026-01-01 00:00:00', 'user_input', NULL)`,
  ).run(workId, conceptId);
  // 위계 잎 — conceptId(부모) → work 행 직접(그림자 잎 0).
  db.prepare(
    `INSERT INTO hierarchy_edges (source_type, source_id, target_type, target_id, relation, weight, provenance, source_node_id) VALUES ('concept', ?, 'work', ?, 'parent_of', 0.9, 'user_input', NULL)`,
  ).run(conceptId, workId);
}
function seedNodeMap(nodeId: number, content: string): Map<string, GraphNode> {
  const m = new Map<string, GraphNode>();
  m.set(`node:${nodeId}`, { id: `node:${nodeId}`, sourceId: nodeId, sourceType: "text", label: content.slice(0, 31), snippet: content });
  return m;
}

describe("buildGroupNodes — 자식 있는 타입만 묶음 생성", () => {
  test("작품 자식 1+ 면 group:work 노드와 member_of 엣지가 생긴다", async () => {
    insertConcept("cpt_w", "작품개념");
    insertWorkLinkedToConcept("wrk_a", "데못죽", "cpt_w");
    const nid = insertNode("작품 글"); linkNodeConcept(nid, "cpt_w");
    const nodeById = seedNodeMap(nid, "작품 글");
    const edgeSet = new Map<string, GraphEdge>();

    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    buildGroupNodes(nodeById, edgeSet, refs);

    expect(nodeById.has("group:work")).toBe(true);
    const grp = nodeById.get("group:work")!;
    expect(grp.sourceType).toBe("entity_group");
    expect(grp.groupType).toBe("work");
    expect(grp.label).toBe("작품 (전체)"); // koName + 라벨 접미사(개념 루트와 구분·D2)
    expect(edgeSet.has("edge:group:work->entity:work:wrk_a:member_of")).toBe(true);
  });

  test("project 자식 1+ 면 group:project, person 자식 1+ 면 group:person", async () => {
    // 프로젝트 자식 — 개념 역조회로 합류.
    insertConcept("cpt_p", "프로젝트개념");
    insertProject("prj_a", "바라시스템"); linkProjectConcept("prj_a", "cpt_p", "classification");
    // 사람 자식 — node_person_edges 로 글에 직접 잇는다(augment 1) 블록 경로).
    insertPerson("psn_a", "타니아");
    const nid = insertNode("프로젝트·사람 글");
    linkNodeConcept(nid, "cpt_p");
    linkNodePerson(nid, "psn_a", "mentions");
    const nodeById = seedNodeMap(nid, "프로젝트·사람 글");
    const edgeSet = new Map<string, GraphEdge>();

    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    buildGroupNodes(nodeById, edgeSet, refs);

    expect(nodeById.has("group:project")).toBe(true);
    expect(nodeById.get("group:project")!.label).toBe("프로젝트 (전체)");
    expect(nodeById.get("group:project")!.groupType).toBe("project");

    // person 갈래 — group:person 노드·label="사람 (전체)"·groupType="person"·member_of 엣지.
    expect(nodeById.has("group:person")).toBe(true);
    expect(nodeById.get("group:person")!.label).toBe("사람 (전체)"); // 타입 이름 + 라벨 접미사(D2)
    expect(nodeById.get("group:person")!.groupType).toBe("person");
    expect(nodeById.get("group:person")!.sourceType).toBe("entity_group");
    expect(edgeSet.has("edge:group:person->person:psn_a:member_of")).toBe(true);
  });

  test("자식 0 타입은 묶음 노드를 만들지 않는다(빈 허브 금지)", async () => {
    const nid = insertNode("그냥 글");
    const nodeById = seedNodeMap(nid, "그냥 글");
    const edgeSet = new Map<string, GraphEdge>();

    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    buildGroupNodes(nodeById, edgeSet, refs);

    const groupKeys = [...nodeById.keys()].filter((k) => k.startsWith("group:"));
    expect(groupKeys.length).toBe(0);
  });

  test("여러 타입에 자식이 있으면 묶음 노드가 타입 수만큼 생긴다", async () => {
    insertConcept("cpt_w2", "작품개념2");
    insertWorkLinkedToConcept("wrk_b", "주술회전", "cpt_w2");
    insertConcept("cpt_p2", "프로젝트개념2");
    insertProject("prj_b", "다른프로젝트"); linkProjectConcept("prj_b", "cpt_p2", "tag");
    const nid = insertNode("둘 다 글");
    linkNodeConcept(nid, "cpt_w2"); linkNodeConcept(nid, "cpt_p2");
    const nodeById = seedNodeMap(nid, "둘 다 글");
    const edgeSet = new Map<string, GraphEdge>();

    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    buildGroupNodes(nodeById, edgeSet, refs);

    const groupKeys = [...nodeById.keys()].filter((k) => k.startsWith("group:")).sort();
    expect(groupKeys).toEqual(["group:project", "group:work"]);
  });

  test("member_of 엣지의 양끝은 둘 다 노드 집합 안이다", async () => {
    insertConcept("cpt_w3", "작품개념3");
    insertWorkLinkedToConcept("wrk_c", "어떤작품", "cpt_w3");
    const nid = insertNode("작품 글3"); linkNodeConcept(nid, "cpt_w3");
    const nodeById = seedNodeMap(nid, "작품 글3");
    const edgeSet = new Map<string, GraphEdge>();

    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    buildGroupNodes(nodeById, edgeSet, refs);

    for (const e of edgeSet.values()) {
      if (e.type !== "member_of") continue;
      expect(nodeById.has(e.from)).toBe(true);
      expect(nodeById.has(e.to)).toBe(true);
    }
  });

  test("buildGroupNodes 반환값은 생성된 묶음 노드 id 배열(검색 강조용)", async () => {
    insertConcept("cpt_w4", "작품개념4");
    insertWorkLinkedToConcept("wrk_d", "또작품", "cpt_w4");
    const nid = insertNode("작품 글4"); linkNodeConcept(nid, "cpt_w4");
    const nodeById = seedNodeMap(nid, "작품 글4");
    const edgeSet = new Map<string, GraphEdge>();

    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    const groupIds = buildGroupNodes(nodeById, edgeSet, refs);
    expect(groupIds).toContain("group:work");
  });

  test("과밀 상한으로 일부만 합류해도 묶음은 합류한 자식만 묶는다", async () => {
    // 글 1개에 개념 1개를 잇고, 그 개념에 프로젝트를 상한(PROJECTS_PER_NODE) 초과로 잇는다.
    // augmentWithEntities 는 projectCap = PROJECTS_PER_NODE * 글수(=1) 까지만 합류시킨다.
    // 그러면 group:project 의 member_of 엣지 수는 합류한 프로젝트 노드 수와 같아야 한다
    // (DB 에 있는 전체 수가 아니라 nodeById 안 자식만 묶는다는 불변식).
    insertConcept("cpt_cap", "과밀개념");
    const overCount = PROJECTS_PER_NODE + 2;
    for (let i = 0; i < overCount; i++) {
      insertProject(`prj_cap_${i}`, `프로젝트${i}`);
      linkProjectConcept(`prj_cap_${i}`, "cpt_cap", "classification");
    }
    const nid = insertNode("과밀 글"); linkNodeConcept(nid, "cpt_cap");
    const nodeById = seedNodeMap(nid, "과밀 글");
    const edgeSet = new Map<string, GraphEdge>();

    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    buildGroupNodes(nodeById, edgeSet, refs);

    // 실제 합류한 project: 노드 수(상한에 걸려 PROJECTS_PER_NODE 개여야 한다).
    const joinedProjectNodes = [...nodeById.keys()].filter((k) => k.startsWith("project:"));
    expect(joinedProjectNodes.length).toBe(PROJECTS_PER_NODE);

    // group:project 의 member_of 엣지 수 = 합류한 project 노드 수(전체 DB 수 아님).
    const memberEdges = [...edgeSet.values()].filter(
      (e) => e.type === "member_of" && e.from === "group:project",
    );
    expect(memberEdges.length).toBe(joinedProjectNodes.length);
    // 모든 member_of 엣지의 양끝이 노드 집합 안(불변식 재확인).
    for (const e of memberEdges) {
      expect(nodeById.has(e.from)).toBe(true);
      expect(nodeById.has(e.to)).toBe(true);
    }
  });
});
