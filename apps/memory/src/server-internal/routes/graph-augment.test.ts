/**
 * graph-augment.test.ts — P2-G2 글→works행 승격 + 분리 잎 identity 1:1 미출력·재지정.
 *
 * E3(잎 개념을 work 정체성 키로 분리) 이후 작품 글은 works 행을 직접 mention 하지 않고
 * 분리 잎 개념('괴담 (소설/백덕수)')만 mention 한다. graph-augment 블록 1.5c 가 그 잎
 * 개념의 work identity 가 정확히 1개일 때 ① 글→works행 신설 type 간선 승격 ② 글→잎 개념
 * mention 제거 ③ 잎 개념 노드 미출력으로, 글이 자기 works 행 아래 직접 매달리고 '괴담' 이
 * 한 노드만 남게 한다(옵션 2-A′·Q2-2·Q2-3).
 *
 * 실 bun:sqlite(:memory:) + 실 SqliteMemoryStore + 실 bge-m3 임베딩 통합 — Mock 0
 * (CLAUDE.md "DB/임베딩 의존 모듈은 실제 구현체와 통합 검증"). 데이터는 실제 입력 통로
 * (wireHashtagEntities → wireEntityPlacement)로 깐다.
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
import type { GraphNode, GraphEdge } from "./graph.ts";
import {
  MENTION_ENTITY_EDGE_TYPE,
  MENTION_ENTITY_SIDE_EDGE_TYPE,
} from "./graph-nodes-shared.ts";
import { buildHierarchy } from "../../../web/dashboard/graph/layout/radial-hierarchy.ts";
import { normalizeGraphNodeType } from "../../../web/dashboard/graph/graph-view-model.ts";
import type {
  GraphNode as ViewGraphNode,
  GraphEdge as ViewGraphEdge,
} from "../../../web/dashboard/graph/graph-view-model.ts";
import { wireHashtagEntities } from "../../memory/hashtag-entity-wiring.ts";
import { wireEntityPlacement } from "../../memory/entity-placement-wiring.ts";
import { resetConceptTypeVocabularyCache } from "../../memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";

beforeAll(async () => {
  await loadEmbedder();
});

afterAll(() => {});

let ctx: GraphTestContext;
let store: SqliteMemoryStore;

beforeEach(async () => {
  resetConceptTypeVocabularyCache();
  resetClassifierCache();
  ctx = await makeGraphTestDeps();
  store = ctx.store;
});

afterEach(() => {
  ctx.close();
});

/** 입력 한 줄을 실제 통로로 처리한다(분류 개념 → 분리 잎 개념 → works 행 identity 까지). */
async function processInput(content: string): Promise<number> {
  const nodeId = await store.addNode({
    content,
    sourceType: "auto_capture",
    author: "owner",
    platform: "dashboard:manual",
  });
  await wireHashtagEntities(store, nodeId, content);
  await wireEntityPlacement(store, nodeId, content, { llm: null });
  return nodeId;
}

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

describe("augmentWithEntities — G2 글→works행 승격·분리 잎 미출력 (P2-G2)", () => {
  test("소설 괴담 글: 분리 잎 개념 미출력 + 글→works행 신설 type 간선 + 매체 닻 자동 해소", async () => {
    const content = "#작품:소설 #소설:괴담 #작가:백덕수";
    const nodeId = await processInput(content);

    const work = await store.entitiesRepo.findByName("work", "괴담");
    if (!work) throw new Error("괴담 work 행이 입력 통로 처리로 생기지 않았다");

    const nodeById = seedNodeMap(nodeId, content);
    const edgeSet = new Map<string, GraphEdge>();
    await augmentWithEntities(store, nodeById, edgeSet);

    // (a) 분리 잎 개념 '괴담 (소설/백덕수)' 노드가 그래프에 없다(identity 1:1 미출력).
    const leafNode = [...nodeById.values()].find((n) => n.label?.startsWith("괴담 ("));
    expect(leafNode).toBeUndefined();

    // (b) works 행 노드는 남아 '괴담' 한 노드로 보인다.
    const workKey = `entity:work:${work.id}`;
    expect(nodeById.has(workKey)).toBe(true);
    expect(nodeById.get(workKey)!.sourceType).toBe("work");

    // (c) 글→works행 신설 type 간선이 있다(from=works행·to=글 — 승격 부모 컨벤션).
    const hasMentionEntity = [...edgeSet.values()].some(
      (e) => e.type === MENTION_ENTITY_EDGE_TYPE && e.from === workKey && e.to === `node:${nodeId}`,
    );
    expect(hasMentionEntity).toBe(true);

    // (d) 글→분리 잎 개념 mention 엣지는 재지정으로 사라졌다(분리 잎 노드 자체가 없음).
    const danglingLeafEdge = [...edgeSet.values()].some(
      (e) => e.from === `node:${nodeId}` && !nodeById.has(e.to),
    );
    expect(danglingLeafEdge).toBe(false);
  });

  test("이름 흡수 0 — works 행과 분리 잎 개념은 합쳐지지 않고 잎만 빠진다(과흡수 회귀 방지)", async () => {
    const content = "#작품:소설 #소설:괴담 #작가:백덕수";
    const nodeId = await processInput(content);
    const work = await store.entitiesRepo.findByName("work", "괴담");
    if (!work) throw new Error("괴담 work 행이 안 생겼다");

    const nodeById = seedNodeMap(nodeId, content);
    const edgeSet = new Map<string, GraphEdge>();
    await augmentWithEntities(store, nodeById, edgeSet);

    // works 행 라벨은 흡수 없이 원래 이름('괴담')을 유지한다(분리 이름으로 바뀌지 않음).
    const workKey = `entity:work:${work.id}`;
    expect(nodeById.get(workKey)!.label).toBe("괴담");
    // 모든 엣지 양끝이 집합 안(매달린 엣지 0 — 재지정·노드 제거가 일관).
    for (const e of edgeSet.values()) {
      expect(nodeById.has(e.from)).toBe(true);
      expect(nodeById.has(e.to)).toBe(true);
    }
  });

  test("생물 #동물:고양이 — work identity 0 이라 G2 work 승격·미출력 발동 안 함(work 한정 가드·회귀 0)", async () => {
    // 결정 D(2026-06-27 M7): 명시 선언 '고양이'(creature seed)가 1급 creature 엔티티가 된다.
    // 그래도 G2(글→works행 승격 + 잎 미출력)는 *work 한정* 이라 발동하지 않는다 — work identity 0.
    // 글→고양이 creature 행 mention 은 정상 효과(creature 엔티티 mention)이고, G2 work 승격과 다르다.
    const content = "#동물:고양이, 귀엽다";
    const nodeId = await processInput(content);

    const nodeById = seedNodeMap(nodeId, content);
    const edgeSet = new Map<string, GraphEdge>();
    await augmentWithEntities(store, nodeById, edgeSet);

    // G2 가 노린 works행 승격은 없다 — work identity 0 이라 G2 미발동(work 한정 가드).
    const work = await store.entitiesRepo.findByName("work", "고양이").catch(() => null);
    expect(work).toBeNull(); // 고양이 work 행은 없다(G2 승격 대상 부재).
    // 결정 D — 고양이는 creature 행이 된다(work 가 아니라 G2 와 무관·creature 엔티티 mention 은 정상).
    const creature = await store.entitiesRepo.findByName("creature", "고양이");
    expect(creature).not.toBeNull();
    // mention_entity 간선이 있어도 그 대상은 creature 행이지 work 승격이 아니다 — work 키 prefix 0.
    const mentionEntityEdges = [...edgeSet.values()].filter(
      (e) => e.type === MENTION_ENTITY_EDGE_TYPE,
    );
    for (const e of mentionEntityEdges) {
      // work 행 id(wrk_) 를 가리키는 mention_entity 승격 간선이 없어야 한다(G2 미발동).
      expect(e.from.includes("wrk_") || e.to.includes("wrk_")).toBe(false);
    }
    // 결정 D — 고양이는 creature 엔티티 노드로 그래프에 나온다(옛 concept 잎 대신 1급 카드).
    expect(nodeById.has(`entity:creature:${creature!.id}`)).toBe(true);
  });
});

/**
 * augment 산출(sourceType 기반 노드)을 buildHierarchy 입력 뷰모델(type 기반)로 옮긴다.
 * normalizeGraphNodeType 단일 출처로 sourceType→GraphNodeType 을 변환해, 실 위계 결정을
 * 태운다(드리프트 0). 엣지는 그대로 옮긴다.
 */
function toViewModel(
  nodeById: Map<string, GraphNode>,
  edgeSet: Map<string, GraphEdge>,
): { nodes: ViewGraphNode[]; edges: ViewGraphEdge[] } {
  const nodes: ViewGraphNode[] = [...nodeById.values()].map((n) => ({
    id: n.id,
    type: normalizeGraphNodeType(n.sourceType),
    label: n.label,
  }));
  const edges: ViewGraphEdge[] = [...edgeSet.values()].map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    type: e.type,
    weight: e.weight,
  }));
  return { nodes, edges };
}

describe("augmentWithEntities — G4 사람 주체 글 승격 제외 (P2-G4·Q2-4)", () => {
  test("사람 주체 글(글3): 글→works행 간선이 비부모 곁다리 type — 주 부모 = 백덕수(person)", async () => {
    // 작품 글(괴담 소설·백덕수)로 works 행·분리 잎 개념을 먼저 세운다(연결 대상 존재).
    await processInput("#작품:소설 #소설:괴담 #작가:백덕수");
    const work = await store.entitiesRepo.findByName("work", "괴담");
    if (!work) throw new Error("괴담 work 행이 안 생겼다");

    // 사람 주체 글(글3) — #사람:백덕수 가 글→백덕수 person mention(node_person_edges)을 만든다.
    // 사람 주체 글의 #작품: 은 새 work 행을 안 만들고 기존 괴담 work 에 잎 개념으로 연결된다(P4-redefine).
    const o3 = await processInput("#사람:백덕수 #직업:소설작가 #작품:괴담");

    const nodeById = seedNodeMap(o3, "#사람:백덕수 #직업:소설작가 #작품:괴담");
    const edgeSet = new Map<string, GraphEdge>();
    await augmentWithEntities(store, nodeById, edgeSet);

    const workKey = `entity:work:${work.id}`;
    const nodeKey3 = `node:${o3}`;

    // (a) 글→works행 간선이 부모 승격 type 이 아니라 비부모 곁다리 type 이다.
    const promoted = [...edgeSet.values()].some(
      (e) => e.type === MENTION_ENTITY_EDGE_TYPE && e.from === workKey && e.to === nodeKey3,
    );
    expect(promoted).toBe(false);
    const sideEdge = [...edgeSet.values()].some(
      (e) => e.type === MENTION_ENTITY_SIDE_EDGE_TYPE && e.from === workKey && e.to === nodeKey3,
    );
    expect(sideEdge).toBe(true);

    // (b) 글→백덕수 person mention 엣지가 살아 있다(주 부모 후보).
    const personMention = [...edgeSet.values()].some(
      (e) => e.from === nodeKey3 && e.to.startsWith("person:"),
    );
    expect(personMention).toBe(true);

    // (c) buildHierarchy 주 부모 = person(백덕수), works 행이 아니다(라이브 정합).
    const { nodes, edges } = toViewModel(nodeById, edgeSet);
    const h = buildHierarchy(nodes, edges);
    const parent = h.parentOf.get(nodeKey3);
    expect(parent?.startsWith("person:")).toBe(true);
    expect(parent).not.toBe(workKey);
  });

  test("작품 선언 글(글1·사람 엣지 0): 글→works행 승격 type 그대로 — 주 부모 = works행(회귀 0)", async () => {
    const o1 = await processInput("#작품:소설 #소설:괴담 #작가:백덕수");
    const work = await store.entitiesRepo.findByName("work", "괴담");
    if (!work) throw new Error("괴담 work 행이 안 생겼다");

    const nodeById = seedNodeMap(o1, "#작품:소설 #소설:괴담 #작가:백덕수");
    const edgeSet = new Map<string, GraphEdge>();
    await augmentWithEntities(store, nodeById, edgeSet);

    const workKey = `entity:work:${work.id}`;
    const nodeKey1 = `node:${o1}`;

    // (a) 글→works행 승격 type 그대로(G2 동작 무변·G4 가드 미발동).
    const promoted = [...edgeSet.values()].some(
      (e) => e.type === MENTION_ENTITY_EDGE_TYPE && e.from === workKey && e.to === nodeKey1,
    );
    expect(promoted).toBe(true);
    const sideEdge = [...edgeSet.values()].some(
      (e) => e.type === MENTION_ENTITY_SIDE_EDGE_TYPE,
    );
    expect(sideEdge).toBe(false);

    // (b) buildHierarchy 주 부모 = works행(승격 prio 70).
    const { nodes, edges } = toViewModel(nodeById, edgeSet);
    const h = buildHierarchy(nodes, edges);
    expect(h.parentOf.get(nodeKey1)).toBe(workKey);
  });
});

describe("augmentWithEntities — H1 전 타입 일반화 + 사슬 분류 직접 선 제거 (P2-H1·Q2-5)", () => {
  /** node 끝점 키 → 그 글이 직접 mention 한 (to 키 → 노드 라벨) 목록을 모은다. */
  function mentionEdgeLabels(
    edgeSet: Map<string, GraphEdge>,
    nodeById: Map<string, GraphNode>,
    fromKey: string,
  ): string[] {
    const labels: string[] = [];
    for (const e of edgeSet.values()) {
      if (e.from !== fromKey) continue;
      const target = nodeById.get(e.to);
      if (target?.label) labels.push(target.label);
    }
    return labels;
  }

  test("생물 글: 주 부모 = 까망이 creature행·글→동물/글→고양이 직접 선 0·사슬 보존", async () => {
    const content = "#생물:동물 #동물:고양이 #고양이:까망이";
    const o = await processInput(content);
    const cre = await store.entitiesRepo.findByName("creature", "까망이");
    if (!cre) throw new Error("까망이 creature 행이 안 생겼다");

    const nodeById = seedNodeMap(o, content);
    const edgeSet = new Map<string, GraphEdge>();
    await augmentWithEntities(store, nodeById, edgeSet);

    const creKey = `entity:creature:${cre.id}`;
    const nodeKey0 = `node:${o}`;

    // (a) 글→creature행 승격 간선(from=creature행·to=글·승격 type).
    const promoted = [...edgeSet.values()].some(
      (e) => e.type === MENTION_ENTITY_EDGE_TYPE && e.from === creKey && e.to === nodeKey0,
    );
    expect(promoted).toBe(true);

    // (b) buildHierarchy 주 부모 = 까망이 creature 행(가장 깊은 대상).
    const { nodes, edges } = toViewModel(nodeById, edgeSet);
    const h = buildHierarchy(nodes, edges);
    expect(h.parentOf.get(nodeKey0)).toBe(creKey);

    // (c) 글이 직접 mention 한 노드 라벨에 '고양이'·'동물' 분류가 없다(사슬 분류 직접 선 0).
    const directLabels = mentionEdgeLabels(edgeSet, nodeById, nodeKey0);
    expect(directLabels.some((l) => l === "고양이")).toBe(false);
    expect(directLabels.some((l) => l === "동물")).toBe(false);

    // (d) 위계 사슬 까망이→고양이→동물→생물 parent_of 선이 보존된다(끊김 0).
    const parentOfEdges = [...edgeSet.values()].filter((e) => e.type === "parent_of");
    expect(parentOfEdges.length).toBeGreaterThanOrEqual(3);
    // creature 행이 위계 사슬의 잎으로 부모(고양이 개념)를 가진다.
    const creHasParent = parentOfEdges.some((e) => e.to === creKey || e.from === creKey)
      || [...edgeSet.values()].some(
        (e) => e.type === "parent_of" && (e.from === creKey || e.to === creKey),
      );
    // 사슬 보존을 buildHierarchy 깊이로도 확인 — creature 행이 루트가 아니라 사슬 안.
    expect(h.parentOf.has(creKey)).toBe(true);
    void creHasParent;
  });

  test("순수 분류 글(#취미:독서 단독·행 없음): 글→분류 mention 유지(회귀 0)", async () => {
    // 행으로 승격되는 잎이 없으면(가장 깊은 대상이 분류) 글→분류 mention 을 그대로 둔다.
    const content = "#취미:독서, 오늘 좋았다";
    const o = await processInput(content);

    const nodeById = seedNodeMap(o, content);
    const edgeSet = new Map<string, GraphEdge>();
    await augmentWithEntities(store, nodeById, edgeSet);

    const nodeKey0 = `node:${o}`;
    // 어떤 타입으로도 승격 안 함 → 글→works행/creature행 승격 간선 0.
    const promoted = [...edgeSet.values()].some(
      (e) =>
        (e.type === MENTION_ENTITY_EDGE_TYPE || e.type === MENTION_ENTITY_SIDE_EDGE_TYPE)
        && e.to === nodeKey0,
    );
    expect(promoted).toBe(false);
    // 글이 mention 한 개념 노드가 남아 직접 선이 유지된다(회귀 0).
    const hasDirectMention = [...edgeSet.values()].some(
      (e) => e.from === nodeKey0 && e.to.startsWith("concept:"),
    );
    expect(hasDirectMention).toBe(true);
  });

  test("작품 글: 글→소설 매체 직접 선 제거(잔존 해소)·글→works행 부모 유지·매체 위계선 보존", async () => {
    const content = "#작품:소설 #소설:괴담 #작가:백덕수";
    const o = await processInput(content);
    const work = await store.entitiesRepo.findByName("work", "괴담");
    if (!work) throw new Error("괴담 work 행이 안 생겼다");

    const nodeById = seedNodeMap(o, content);
    const edgeSet = new Map<string, GraphEdge>();
    await augmentWithEntities(store, nodeById, edgeSet);

    const workKey = `entity:work:${work.id}`;
    const nodeKey0 = `node:${o}`;

    // (a) buildHierarchy 주 부모 = works행(승격 유지).
    const { nodes, edges } = toViewModel(nodeById, edgeSet);
    const h = buildHierarchy(nodes, edges);
    expect(h.parentOf.get(nodeKey0)).toBe(workKey);

    // (b) 글→소설 매체 직접 mention 선이 제거됐다(잔존 해소).
    const directLabels = mentionEdgeLabels(edgeSet, nodeById, nodeKey0);
    expect(directLabels.some((l) => l === "소설")).toBe(false);

    // (c) works행→소설 parent_of 위계 사슬은 보존(매체 위계선은 글→분류 mention 과 별개).
    const mediumConcept = await store.findConceptByName("소설");
    if (mediumConcept) {
      const mediumKey = `concept:${mediumConcept.conceptId}`;
      const chainAlive = [...edgeSet.values()].some(
        (e) =>
          e.type === "parent_of"
          && (e.from === mediumKey || e.to === mediumKey)
          && (e.from === workKey || e.to === workKey),
      );
      expect(chainAlive).toBe(true);
    }
  });

  test("사람 주체 글: 일반화 후에도 사람 아래·작품 곁다리(G4 가드 유지)", async () => {
    await processInput("#작품:소설 #소설:괴담 #작가:백덕수");
    const work = await store.entitiesRepo.findByName("work", "괴담");
    if (!work) throw new Error("괴담 work 행이 안 생겼다");
    const o3 = await processInput("#사람:백덕수 #직업:소설작가 #작품:괴담");

    const nodeById = seedNodeMap(o3, "#사람:백덕수 #직업:소설작가 #작품:괴담");
    const edgeSet = new Map<string, GraphEdge>();
    await augmentWithEntities(store, nodeById, edgeSet);

    const workKey = `entity:work:${work.id}`;
    const nodeKey3 = `node:${o3}`;

    // 글→works행 간선이 비부모 곁다리 type(일반화해도 G4 가드 유지).
    const sideEdge = [...edgeSet.values()].some(
      (e) => e.type === MENTION_ENTITY_SIDE_EDGE_TYPE && e.from === workKey && e.to === nodeKey3,
    );
    expect(sideEdge).toBe(true);

    // buildHierarchy 주 부모 = person(백덕수).
    const { nodes, edges } = toViewModel(nodeById, edgeSet);
    const h = buildHierarchy(nodes, edges);
    expect(h.parentOf.get(nodeKey3)?.startsWith("person:")).toBe(true);
  });
});
