/**
 * graph-project-chain-render.test.ts — project 끝 실체 위계 사슬 렌더 회귀 가드.
 *
 * 결함(운영 DB 실측): `#프로젝트:코딩 #코딩:디롱` 의 hierarchy_edges 는
 * `프로젝트(개념)→코딩(개념)→디롱(project)` 단일 사슬인데 그래프 산출에선
 * `코딩→디롱` parent_of 가 빠지고 `프로젝트→디롱 member_of` 직결이 그어져 사슬이
 * 두 갈래로 갈라져 보였다. 1차 원인은 블록 1.55 의 project 끝점 명시 skip(continue),
 * 2차는 그 누락이 member_of 추이 감축(graph-group-nodes)을 오판하게 한 연쇄였다.
 *
 * 가드(7건): project 단일 사슬·다단계 project·8 타입 byte 동일·project_id 허브 보존·
 * project 노드 중복 0·member_of 추이 감축 정합·사람 라벨 동반 회귀 0.
 *
 * 그래프 렌더 한 경로만 검증한다 — augmentWithEntities → buildGroupNodes 를 라우트
 * 핸들러와 같은 순서로 직접 호출한다(입력 배치 단계 1~3·project 통로 무접촉). 실
 * bun:sqlite(:memory:) + 실 SqliteMemoryStore + 실 임베딩 — Mock 클래스 0(CLAUDE.md).
 * 데이터는 실제 store API + hierarchy_edges 직접 INSERT(끝점 종류 강제) fixture 로 깐다.
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
import { augmentWithEntities, buildGroupNodes } from "./graph.ts";
import type { GraphNode, GraphEdge } from "./graph.ts";

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

/** 글 노드 한 개를 nodeById seed 로 넣는다(projectId 칸 선택 — 1.7 허브 입력). */
function seedDoc(
  nodeById: Map<string, GraphNode>,
  nodeId: number,
  content: string,
  projectId?: string,
): void {
  nodeById.set(`node:${nodeId}`, {
    id: `node:${nodeId}`,
    sourceId: nodeId,
    sourceType: "text",
    label: content.slice(0, 31),
    snippet: content,
    projectId,
  });
}

/** 개념 노드를 nodeById seed 로 넣는다(분류 키/값). */
function seedConcept(
  nodeById: Map<string, GraphNode>,
  cid: string,
  label: string,
): void {
  nodeById.set(`concept:${cid}`, {
    id: `concept:${cid}`,
    sourceType: "concept",
    label,
  });
}

/** augment → group 을 라우트 순서대로 돌려 최종 그래프 산출(노드·엣지)을 만든다. */
async function buildGraph(
  nodeById: Map<string, GraphNode>,
  edgeSet: Map<string, GraphEdge>,
): Promise<void> {
  const augment = await augmentWithEntities(store, nodeById, edgeSet);
  buildGroupNodes(nodeById, edgeSet, augment);
}

function hasEdge(
  edgeSet: Map<string, GraphEdge>,
  fromKey: string,
  toKey: string,
  type: string,
): boolean {
  for (const e of edgeSet.values()) {
    if (e.from === fromKey && e.to === toKey && e.type === type) return true;
  }
  return false;
}

describe("project 끝 실체 위계 사슬 렌더 (결함 회귀 가드)", () => {
  test("가드1 — project 단일 사슬: 프로젝트→코딩→디롱 parent_of·member_of 직결 없음·디롱 노드 1개", async () => {
    // `#프로젝트:코딩 #코딩:디롱` 재현 — 프로젝트(키)→코딩(값/키)→디롱(project) 사슬.
    const nodeId = await store.addNode({ content: "#프로젝트:코딩 #코딩:디롱", sourceType: "auto_capture" });
    const projConcept = await store.findOrCreateConcept("프로젝트", { isClassificationKey: true });
    const codingConcept = await store.findOrCreateConcept("코딩", { isClassificationKey: true });
    const dirong = await store.findOrCreateProject({ name: "디롱" });
    // 글이 잎 개념(코딩)을 mention → 코딩이 집합 안 개념이 되고 위계 자식(디롱 project)이 합류.
    await store.addNodeConceptEdge(nodeId, codingConcept, "classification", "user_input", nodeId);
    await store.setNodeProjectId(nodeId, dirong.projectId); // 글이 디롱 소속(1.7 허브도 디롱 합류).
    // hierarchy_edges 사슬 — 프로젝트→코딩(개념끼리)·코딩→디롱(개념→project).
    store.addHierarchyEdge({ sourceType: "concept", sourceId: projConcept, targetType: "concept", targetId: codingConcept, weight: 0.9 ,
    provenance: "user_input",
    sourceNodeId: null,
});
    store.addHierarchyEdge({ sourceType: "concept", sourceId: codingConcept, targetType: "project", targetId: dirong.projectId, weight: 0.9 ,
    provenance: "user_input",
    sourceNodeId: null,
});

    const nodeById = new Map<string, GraphNode>();
    seedDoc(nodeById, nodeId, "#프로젝트:코딩 #코딩:디롱", dirong.projectId);
    seedConcept(nodeById, codingConcept, "코딩");
    const edgeSet = new Map<string, GraphEdge>();
    await buildGraph(nodeById, edgeSet);

    const projKey = `concept:${projConcept}`;
    const codingKey = `concept:${codingConcept}`;
    const dirongKey = `project:${dirong.projectId}`;

    // 단일 사슬 — 프로젝트→코딩→디롱 parent_of.
    expect(hasEdge(edgeSet, projKey, codingKey, "parent_of")).toBe(true);
    expect(hasEdge(edgeSet, codingKey, dirongKey, "parent_of")).toBe(true);
    // 프로젝트→디롱 member_of 직결 없음(갈라져 보이던 결함의 핵심).
    expect(hasEdge(edgeSet, projKey, dirongKey, "member_of")).toBe(false);
    // 디롱 노드 1개 — projectKey 한 노드만(entity:project:... 8 타입 키 0·중복 0).
    expect(nodeById.has(dirongKey)).toBe(true);
    expect(nodeById.has(`entity:project:${dirong.projectId}`)).toBe(false);
    const dirongNodes = [...nodeById.keys()].filter((k) => k.includes(dirong.projectId));
    expect(dirongNodes.length).toBe(1);
  });

  test("가드2 — 다단계 project: 프로젝트→라이브2D→동글이 단일 사슬", async () => {
    const nodeId = await store.addNode({ content: "#프로젝트:라이브2D #라이브2D:동글이", sourceType: "auto_capture" });
    const projConcept = await store.findOrCreateConcept("프로젝트", { isClassificationKey: true });
    const live2d = await store.findOrCreateConcept("라이브2D", { isClassificationKey: true });
    const dongguli = await store.findOrCreateProject({ name: "동글이" });
    await store.addNodeConceptEdge(nodeId, live2d, "classification", "user_input", nodeId);
    await store.setNodeProjectId(nodeId, dongguli.projectId); // 글이 동글이 소속(1.7 허브 입력).
    store.addHierarchyEdge({ sourceType: "concept", sourceId: projConcept, targetType: "concept", targetId: live2d, weight: 0.9 ,
    provenance: "user_input",
    sourceNodeId: null,
});
    store.addHierarchyEdge({ sourceType: "concept", sourceId: live2d, targetType: "project", targetId: dongguli.projectId, weight: 0.9 ,
    provenance: "user_input",
    sourceNodeId: null,
});

    const nodeById = new Map<string, GraphNode>();
    seedDoc(nodeById, nodeId, "#프로젝트:라이브2D #라이브2D:동글이", dongguli.projectId);
    seedConcept(nodeById, live2d, "라이브2D");
    const edgeSet = new Map<string, GraphEdge>();
    await buildGraph(nodeById, edgeSet);

    const projKey = `concept:${projConcept}`;
    const live2dKey = `concept:${live2d}`;
    const dongguliKey = `project:${dongguli.projectId}`;
    expect(hasEdge(edgeSet, projKey, live2dKey, "parent_of")).toBe(true);
    expect(hasEdge(edgeSet, live2dKey, dongguliKey, "parent_of")).toBe(true);
    expect(hasEdge(edgeSet, projKey, dongguliKey, "member_of")).toBe(false);
    expect(nodeById.has(`entity:project:${dongguli.projectId}`)).toBe(false);
  });

  test("가드3 — 8 타입(장소) 사슬 동작 동일: 병원→피부과→무지개의원 parent_of 유지", async () => {
    // 8 타입 끝 실체는 수정 전후 동작이 같아야 한다(project 만 비대칭 해소·8 타입 무변).
    const nodeId = await store.addNode({ content: "#장소:병원 #병원:피부과 #피부과:무지개의원", sourceType: "auto_capture" });
    const hospital = await store.findOrCreateConcept("병원", { isClassificationKey: true });
    const derma = await store.findOrCreateConcept("피부과", { isClassificationKey: true });
    const place = await store.entitiesRepo.findOrCreateEntity("place", "무지개의원");
    await store.addNodeConceptEdge(nodeId, derma, "classification", "user_input", nodeId);
    store.addHierarchyEdge({ sourceType: "concept", sourceId: hospital, targetType: "concept", targetId: derma, weight: 0.9 ,
    provenance: "user_input",
    sourceNodeId: null,
});
    store.addHierarchyEdge({ sourceType: "concept", sourceId: derma, targetType: "place", targetId: place.id, weight: 0.9 ,
    provenance: "user_input",
    sourceNodeId: null,
});

    const nodeById = new Map<string, GraphNode>();
    seedDoc(nodeById, nodeId, "#장소:병원 #병원:피부과 #피부과:무지개의원");
    // 글은 잎 개념(피부과)만 mention — 병원(상위)은 1.6b 가, 무지개의원(자식)은 1.55 가 합류한다
    //   (실제 augment 흐름과 동일·8 타입 사슬 합류 경로 검증).
    seedConcept(nodeById, derma, "피부과");
    const edgeSet = new Map<string, GraphEdge>();
    await buildGraph(nodeById, edgeSet);

    const hospitalKey = `concept:${hospital}`;
    const dermaKey = `concept:${derma}`;
    const placeKey = `entity:place:${place.id}`;
    expect(hasEdge(edgeSet, hospitalKey, dermaKey, "parent_of")).toBe(true);
    expect(hasEdge(edgeSet, dermaKey, placeKey, "parent_of")).toBe(true);
    // 8 타입 끝 실체는 entityKey 통로 — projectKey 로는 안 샌다(통로 분리 유지).
    expect(nodeById.has(`project:${place.id}`)).toBe(false);
  });

  test("가드4 — project_id 허브 보존: 디롱→글 owns_memory 유지", async () => {
    // project_id 칸 통로(1.7)는 위계 수정과 무관하게 owns_memory 를 그대로 그린다.
    const nodeId = await store.addNode({ content: "#프로젝트:코딩 #코딩:디롱", sourceType: "auto_capture" });
    const projConcept = await store.findOrCreateConcept("프로젝트", { isClassificationKey: true });
    const codingConcept = await store.findOrCreateConcept("코딩", { isClassificationKey: true });
    const dirong = await store.findOrCreateProject({ name: "디롱" });
    await store.addNodeConceptEdge(nodeId, codingConcept, "classification", "user_input", nodeId);
    await store.setNodeProjectId(nodeId, dirong.projectId); // 글이 디롱 소속(1.7 허브 입력).
    store.addHierarchyEdge({ sourceType: "concept", sourceId: projConcept, targetType: "concept", targetId: codingConcept, weight: 0.9 ,
    provenance: "user_input",
    sourceNodeId: null,
});
    store.addHierarchyEdge({ sourceType: "concept", sourceId: codingConcept, targetType: "project", targetId: dirong.projectId, weight: 0.9 ,
    provenance: "user_input",
    sourceNodeId: null,
});

    const nodeById = new Map<string, GraphNode>();
    seedDoc(nodeById, nodeId, "#프로젝트:코딩 #코딩:디롱", dirong.projectId);
    seedConcept(nodeById, codingConcept, "코딩");
    const edgeSet = new Map<string, GraphEdge>();
    await buildGraph(nodeById, edgeSet);

    // 디롱→글 owns_memory 보존(project_id 허브).
    expect(hasEdge(edgeSet, `project:${dirong.projectId}`, `node:${nodeId}`, "owns_memory")).toBe(true);
  });

  test("가드5 — project 노드 중복 0: 위계 합류 + project_id glob 두 통로가 한 노드 공유", async () => {
    // 1.7(project_id glob)이 먼저 디롱 노드를 만들고, 1.55(위계 잎)가 같은 prj_ 를 또
    // 만나도 nodeById.has(projectKey) 로 건너뛰어 한 노드를 공유한다(중복 0).
    const nodeId = await store.addNode({ content: "#프로젝트:코딩 #코딩:디롱", sourceType: "auto_capture" });
    const projConcept = await store.findOrCreateConcept("프로젝트", { isClassificationKey: true });
    const codingConcept = await store.findOrCreateConcept("코딩", { isClassificationKey: true });
    const dirong = await store.findOrCreateProject({ name: "디롱" });
    await store.addNodeConceptEdge(nodeId, codingConcept, "classification", "user_input", nodeId);
    await store.setNodeProjectId(nodeId, dirong.projectId); // 1.7 허브가 디롱을 먼저 합류(중복 0 검증의 핵심).
    store.addHierarchyEdge({ sourceType: "concept", sourceId: projConcept, targetType: "concept", targetId: codingConcept, weight: 0.9 ,
    provenance: "user_input",
    sourceNodeId: null,
});
    store.addHierarchyEdge({ sourceType: "concept", sourceId: codingConcept, targetType: "project", targetId: dirong.projectId, weight: 0.9 ,
    provenance: "user_input",
    sourceNodeId: null,
});

    const nodeById = new Map<string, GraphNode>();
    seedDoc(nodeById, nodeId, "#프로젝트:코딩 #코딩:디롱", dirong.projectId);
    seedConcept(nodeById, codingConcept, "코딩");
    const edgeSet = new Map<string, GraphEdge>();
    await buildGraph(nodeById, edgeSet);

    // 디롱 id 를 키에 가진 노드는 정확히 1개(project:<id> 단일).
    const dirongNodeKeys = [...nodeById.keys()].filter((k) => k.includes(dirong.projectId));
    expect(dirongNodeKeys).toEqual([`project:${dirong.projectId}`]);
  });

  test("가드6 — member_of 추이 감축 정합: 위계 없는 단독 project 는 member_of 직결 유지", async () => {
    // 위계 자식이 아닌 단독 project(글 project_id 만·hierarchy_edges 없음)는 위계로 못
    // 닿으니 묶음 member_of 직결을 유지해야 한다(묶음 기능 보존). 위계로 닿는 자식만 감축.
    const nodeId = await store.addNode({ content: "#프로젝트:바라", sourceType: "auto_capture" });
    const bara = await store.findOrCreateProject({ name: "바라" });
    await store.setNodeProjectId(nodeId, bara.projectId); // 글이 바라 소속(1.7 허브 입력).

    const nodeById = new Map<string, GraphNode>();
    seedDoc(nodeById, nodeId, "#프로젝트:바라", bara.projectId);
    const edgeSet = new Map<string, GraphEdge>();
    await buildGraph(nodeById, edgeSet);

    const baraKey = `project:${bara.projectId}`;
    // 단독 project 는 owns_memory 허브로 글에 닿는다(1.7).
    expect(hasEdge(edgeSet, baraKey, `node:${nodeId}`, "owns_memory")).toBe(true);
    // 묶음 노드(group:project)가 생기면 바라로 member_of 직결(위계 미도달이라 감축 안 함).
    const groupKey = "group:project";
    if (nodeById.has(groupKey)) {
      expect(hasEdge(edgeSet, groupKey, baraKey, "member_of")).toBe(true);
    }
  });

  test("가드7 — 사람·라벨 동반: #프로젝트:바라 #참여자:철수 그래프 회귀 0", async () => {
    const nodeId = await store.addNode({ content: "#프로젝트:바라 #참여자:철수", sourceType: "auto_capture" });
    const bara = await store.findOrCreateProject({ name: "바라" });
    const cheolsu = await store.findOrCreatePersonByName("철수");
    await store.addNodePersonEdge(nodeId, cheolsu.personId, "mentions", "user_input", nodeId);
    await store.setNodeProjectId(nodeId, bara.projectId); // 글이 바라 소속(1.7 허브 입력).

    const nodeById = new Map<string, GraphNode>();
    seedDoc(nodeById, nodeId, "#프로젝트:바라 #참여자:철수", bara.projectId);
    const edgeSet = new Map<string, GraphEdge>();
    await buildGraph(nodeById, edgeSet);

    // 사람 노드·project 허브 둘 다 정상 렌더(크래시·누락 0).
    expect(nodeById.has(`person:${cheolsu.personId}`)).toBe(true);
    expect(nodeById.has(`project:${bara.projectId}`)).toBe(true);
    expect(hasEdge(edgeSet, `project:${bara.projectId}`, `node:${nodeId}`, "owns_memory")).toBe(true);
    // 글→사람 mention 엣지 보존.
    expect(hasEdge(edgeSet, `node:${nodeId}`, `person:${cheolsu.personId}`, "mentions")).toBe(true);
  });
});
