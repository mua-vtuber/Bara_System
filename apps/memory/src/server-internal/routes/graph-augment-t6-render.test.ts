/**
 * graph-augment-t6-render.test.ts — 분류 단계4 T6: graph endpoint 10종 렌더 silent-miss 가드.
 *
 * 두 가지를 검증한다(억지 변경 0·검증과 정직 분류만):
 *   (a) entityRefForId 가 10종 id prefix 를 모두 정직하게 가른다 — prj_→'project'·psn_→
 *       'person'·8 타입 prefix→그 타입·그 밖(cpt_ 등)→'concept'. project 를 'concept' 로
 *       오분류하지 않는다(T6 분류 정직화·미래 위계 끝점 회귀 가드).
 *   (b) augmentWithEntities 가 10종(8타입+person+project)을 각자 통로로 노드로 렌더한다 —
 *       8타입은 hierarchy_edges 위계 잎(+ entity_concept_edges identity 역조회), person 은
 *       node_person_edges, project 는 getProjectsByConceptId(통합 entity_concept_edges) 역조회. silent miss 0.
 *   회귀: prj_ 는 현재 hierarchy_edges 끝점이 아니라 entityRefForId 에 도달 0 이므로, 분류
 *       변경이 현 경로 결과를 안 바꾼다(concept·person·8타입 동작 불변 — 이 테스트가 확인한다).
 *
 * 실 bun:sqlite(:memory:) + 실 SqliteMemoryStore + 실 임베딩 — Mock 클래스 0(CLAUDE.md).
 * 데이터는 실제 store API + FK 충족 fixture INSERT 로 깐다(인터페이스 가짜 구현 0).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { loadEmbedder, makeGraphTestDeps } from "./graph.test-helpers.ts";
import type { GraphTestContext } from "./graph.test-helpers.ts";
import type { SqliteMemoryStore } from "../../db/store.ts";
import { augmentWithEntities } from "./graph.ts";
import { entityRefForId } from "./graph-augment.ts";
import type { GraphNode, GraphEdge } from "./graph.ts";
import { ENTITY_TYPE_METAS } from "../../db/store-internal/entity-type-registry.ts";

beforeAll(async () => {
  await loadEmbedder();
});
afterAll(() => {});

let ctx: GraphTestContext;
let store: SqliteMemoryStore;

beforeEach(async () => {
  ctx = await makeGraphTestDeps();
  store = ctx.store;
});
afterEach(() => {
  ctx.close();
});

// ── (a) entityRefForId 분류 — 단위 테스트(임베딩 무관·결정적) ─────────────────────

describe("entityRefForId — 10종 prefix 정직 분류 (T6)", () => {
  test("prj_ 는 'project' 로 가른다(옛 'concept' 오분류 정직화)", () => {
    expect(entityRefForId("prj_abc").type).toBe("project");
  });

  test("psn_ 는 'person' 으로 가른다", () => {
    expect(entityRefForId("psn_abc").type).toBe("person");
  });

  test("8 타입 prefix 는 각 타입으로 가른다", () => {
    for (const m of ENTITY_TYPE_METAS) {
      expect(entityRefForId(`${m.idPrefix}xyz`).type).toBe(m.typeName);
    }
  });

  test("그 밖(cpt_ 개념·미상 prefix)은 'concept' 으로 떨어진다", () => {
    expect(entityRefForId("cpt_abc").type).toBe("concept");
    expect(entityRefForId("zzz_abc").type).toBe("concept");
  });

  test("id 값은 그대로 보존한다(분류만·변형 0)", () => {
    expect(entityRefForId("prj_keep").id).toBe("prj_keep");
    expect(entityRefForId("wrk_keep").id).toBe("wrk_keep");
  });
});

// ── (b) 10종 렌더 — augment 결과에 각 종류가 노드로 보인다(silent miss 0) ──────────

/** 글 노드 한 개를 nodeById seed 로 넣는다. */
function seedNodeMap(nodeId: number, content: string): Map<string, GraphNode> {
  const m = new Map<string, GraphNode>();
  m.set(`node:${nodeId}`, {
    id: `node:${nodeId}`,
    sourceId: nodeId,
    sourceType: "text",
    label: content.slice(0, 31),
    snippet: content,
  });
  return m;
}

describe("augmentWithEntities — 10종 렌더 silent-miss 0 (T6)", () => {
  test("8 타입 각각이 hierarchy_edges 위계 잎으로 노드 렌더된다", async () => {
    // 글이 잎 개념 cid 를 mention → cid 가 집합 안 개념이 되고, cid 의 hierarchy_edges
    // 자식인 8 타입 행이 위계 잎으로 노드에 합류한다(블록 1.55). 종류마다 자기 글·자기
    // 부모 개념을 둬 과밀 상한(leafHierCap = 6 * 글 수)에 안 걸리게 한다 — 한 글 아래 8개를
    // 몰면 상한이 8 미만이라 2개가 정상적으로 잘려 테스트가 *과밀 보호*를 silent miss 로
    // 오인한다(그건 의도된 cap 이지 결함이 아니므로 종류당 글을 따로 둔다).
    const nodeById = new Map<string, GraphNode>();
    const created: Array<{ typeName: string; id: string }> = [];
    for (const m of ENTITY_TYPE_METAS) {
      const nodeId = await store.addNode({
        content: `${m.typeName} 렌더 글`,
        sourceType: "auto_capture",
      });
      const cid = await store.findOrCreateConcept(`렌더부모_${m.typeName}`, {
        isClassificationKey: true,
      });
      await store.addNodeConceptEdge(nodeId, cid, "classification", "user_input", nodeId);
      const e = await store.entitiesRepo.findOrCreateEntity(m.typeName, `렌더_${m.typeName}`);
      created.push({ typeName: m.typeName, id: e.id });
      // 부모 개념 → 8 타입 행 parent_of(위계 잎이 행을 직접 짊어짐·S2-T3).
      store.addHierarchyEdge({
        sourceType: "concept",
        sourceId: cid,
        targetType: m.typeName,
        targetId: e.id,
        provenance: "user_input",
        sourceNodeId: null,
        weight: 0.9,
      });
      // 글 노드 + 그 부모 개념을 집합에 seed(블록 1.55 불변식 — 부모 개념이 집합 안).
      nodeById.set(`node:${nodeId}`, {
        id: `node:${nodeId}`,
        sourceId: nodeId,
        sourceType: "text",
        label: `${m.typeName} 렌더 글`,
        snippet: `${m.typeName} 렌더 글`,
      });
      nodeById.set(`concept:${cid}`, {
        id: `concept:${cid}`,
        sourceType: "concept",
        label: `렌더부모_${m.typeName}`,
      });
    }

    const edgeSet = new Map<string, GraphEdge>();
    await augmentWithEntities(store, nodeById, edgeSet);

    // 8 타입 행이 모두 노드로 보인다(어느 하나도 silent miss 안 함).
    for (const c of created) {
      const key = `entity:${c.typeName}:${c.id}`;
      expect(nodeById.has(key)).toBe(true);
      expect(nodeById.get(key)!.sourceType).toBe(c.typeName);
    }
  });

  test("person 이 node_person_edges 통로로 노드 렌더된다", async () => {
    const nodeId = await store.addNode({ content: "사람 글", sourceType: "auto_capture" });
    const person = await store.findOrCreatePersonByName("렌더사람");
    await store.addNodePersonEdge(nodeId, person.personId, "mentions", "user_input", nodeId);

    const nodeById = seedNodeMap(nodeId, "사람 글");
    const edgeSet = new Map<string, GraphEdge>();
    await augmentWithEntities(store, nodeById, edgeSet);

    const key = `person:${person.personId}`;
    expect(nodeById.has(key)).toBe(true);
    expect(nodeById.get(key)!.sourceType).toBe("person");
  });

  test("project 가 getProjectsByConceptId 역조회 통로로 노드 렌더된다", async () => {
    const nodeId = await store.addNode({ content: "프로젝트 글", sourceType: "auto_capture" });
    const cid = await store.findOrCreateConcept("프로젝트개념", { isTag: true });
    await store.addNodeConceptEdge(nodeId, cid, "tag", "user_input", nodeId);
    const project = await store.findOrCreateProject({ name: "렌더프로젝트" });
    // 프로젝트 ↔ 개념 — 집합 안 개념에서 project 를 역조회해 합류(블록 1.6).
    await store.addProjectConceptEdge(project.projectId, cid, "tag", "user_input", null);

    const nodeById = seedNodeMap(nodeId, "프로젝트 글");
    nodeById.set(`concept:${cid}`, { id: `concept:${cid}`, sourceType: "concept", label: "프로젝트개념" });
    const edgeSet = new Map<string, GraphEdge>();
    await augmentWithEntities(store, nodeById, edgeSet);

    const key = `project:${project.projectId}`;
    expect(nodeById.has(key)).toBe(true);
    expect(nodeById.get(key)!.sourceType).toBe("project");
  });

  test("미존재 엔티티 id 가 위계 잎이면 가짜 노드 0(엣지 양끝 불변식)", async () => {
    // hierarchy_edges 자식이 entities 에 없는 wrk_ghost 면, getEntityRowById 가 null 을
    // 돌려 노드를 안 만든다(silent fallback 아니라 정직한 미합류·가짜 노드 0).
    const nodeId = await store.addNode({ content: "유령 글", sourceType: "auto_capture" });
    const cid = await store.findOrCreateConcept("유령부모", { isClassificationKey: true });
    await store.addNodeConceptEdge(nodeId, cid, "classification", "user_input", nodeId);
    // entities 에 없는 wrk_ghost 를 위계 자식으로 — FK 0 인 hierarchy_edges 라 INSERT 가능.
    store.addHierarchyEdge({
      sourceType: "concept",
      sourceId: cid,
      targetType: "work",
      targetId: "wrk_ghost",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.9,
    });

    const nodeById = seedNodeMap(nodeId, "유령 글");
    nodeById.set(`concept:${cid}`, { id: `concept:${cid}`, sourceType: "concept", label: "유령부모" });
    const edgeSet = new Map<string, GraphEdge>();
    await augmentWithEntities(store, nodeById, edgeSet);

    // 가짜 work 노드가 안 생긴다.
    expect(nodeById.has("entity:work:wrk_ghost")).toBe(false);
  });

  test("project 가 위계 끝점이면 projectKey 노드로 합류하고 위계선이 그어진다(8 타입 통로로 안 샘)", async () => {
    // 단계4 source wiring 후 project 끝 실체가 hierarchy_edges 끝점(target_type='project')이
    // 된다. 호출처(블록 1.55)가 project 를 projectKey(project:<id>) 노드로 합류시키고,
    // 위계선(부모개념→project)이 그어진다. 8 타입 통로(getEntityRowById)로는 새지 않아
    // entity:project:<id> 키는 만들어지지 않는다(이중 처리 0·노드 키 분리).
    const nodeId = await store.addNode({ content: "위계끝 프로젝트 글", sourceType: "auto_capture" });
    const cid = await store.findOrCreateConcept("위계끝부모", { isClassificationKey: true });
    await store.addNodeConceptEdge(nodeId, cid, "classification", "user_input", nodeId);
    const project = await store.findOrCreateProject({ name: "위계끝프로젝트" });
    store.addHierarchyEdge({
      sourceType: "concept",
      sourceId: cid,
      targetType: "project",
      targetId: project.projectId,
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.9,
    });

    const nodeById = seedNodeMap(nodeId, "위계끝 프로젝트 글");
    nodeById.set(`concept:${cid}`, { id: `concept:${cid}`, sourceType: "concept", label: "위계끝부모" });
    const edgeSet = new Map<string, GraphEdge>();
    // 던지지 않고 통과해야 한다(8 타입 getEntityRowById 로 새면 타입 오류·크래시 위험).
    await augmentWithEntities(store, nodeById, edgeSet);

    // project 는 projectKey 통로로 합류한다(위계 잎 노드).
    expect(nodeById.has(`project:${project.projectId}`)).toBe(true);
    expect(nodeById.get(`project:${project.projectId}`)!.sourceType).toBe("project");
    // 8 타입 통로(entity:project:...) 키로는 안 샌다(이중 처리 0).
    expect(nodeById.has(`entity:project:${project.projectId}`)).toBe(false);
    // 부모개념 → project 위계선(parent_of)이 그어진다(양끝 집합 안 불변식 충족).
    const hierEdge = `edge:concept:${cid}->project:${project.projectId}:parent_of`;
    expect(edgeSet.has(hierEdge)).toBe(true);
  });

  test("모든 엣지 양끝이 집합 안(매달린 엣지 0·10종 합류 후 불변식)", async () => {
    const nodeId = await store.addNode({ content: "불변식 글", sourceType: "auto_capture" });
    const cid = await store.findOrCreateConcept("불변식부모", { isClassificationKey: true });
    await store.addNodeConceptEdge(nodeId, cid, "classification", "user_input", nodeId);
    const work = await store.entitiesRepo.findOrCreateEntity("work", "불변식작품");
    store.addHierarchyEdge({
      sourceType: "concept",
      sourceId: cid,
      targetType: "work",
      targetId: work.id,
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.9,
    });

    const nodeById = seedNodeMap(nodeId, "불변식 글");
    nodeById.set(`concept:${cid}`, { id: `concept:${cid}`, sourceType: "concept", label: "불변식부모" });
    const edgeSet = new Map<string, GraphEdge>();
    await augmentWithEntities(store, nodeById, edgeSet);

    for (const e of edgeSet.values()) {
      expect(nodeById.has(e.from)).toBe(true);
      expect(nodeById.has(e.to)).toBe(true);
    }
  });
});
