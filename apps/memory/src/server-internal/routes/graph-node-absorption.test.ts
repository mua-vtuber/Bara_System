/**
 * graph-node-absorption.test.ts — 그래프 노드 흡수(②·D3) + 묶음↔위계 루트 통합(④)
 * + member_of 추이 감축(⑤) 검증. spec docs/decisions/2026-06-13-graph-node-
 * absorption-shortcut-prevention-spec.md §5.4·§8·§9.
 *
 * 실제 bun:sqlite(:memory:) + 실제 SqliteMemoryStore 통합 — Mock 클래스 0.
 * graph-entity-augment.test.ts·graph-group-nodes.test.ts 의 삽입 양식을 재사용한다.
 *
 * 검증:
 *   ② 같은 이름 엔티티(plc_)+identity 개념(cpt_)이 한 노드로(무지개의원 1개).
 *   ② 개념에 매달린 위계 parent_of(피부과→무지개의원개념)가 엔티티 노드로 재지정.
 *   ④ 동명 위계 루트 개념이 있으면 group:<type> 가상 노드 대신 그 개념을 묶음 루트로
 *      재사용한다(장소 한 노드). 없으면 기존 group:<type> 생성(회귀 0).
 *   ⑤ 묶음 루트→엔티티 member_of 는 그 엔티티가 이미 parent_of 위계로 닿으면 생략.
 *   absorbConceptsIntoEntities 순수 함수 — 자기-루프·중복 엣지 정리.
 */

import {
  afterAll, afterEach, beforeAll, beforeEach, describe, expect, test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { loadEmbedder, makeGraphTestDeps } from "./graph.test-helpers.ts";
import type { GraphTestContext } from "./graph.test-helpers.ts";
import type { SqliteMemoryStore } from "../../db/store.ts";
import {
  augmentWithEntities,
  buildGroupNodes,
  absorbConceptsIntoEntities,
} from "./graph.ts";
import type { GraphNode, GraphEdge } from "./graph.ts";

beforeAll(async () => { await loadEmbedder(); });
afterAll(() => {});

let ctx: GraphTestContext;
let store: SqliteMemoryStore;
let db: Database;

beforeEach(async () => { ctx = await makeGraphTestDeps(); store = ctx.store; db = ctx.db; });
afterEach(() => { ctx.close(); });

// ── 삽입 헬퍼 ──────────────────────────────────────────────────────────────

function insertConcept(conceptId: string, name: string, opts: { isClassificationKey?: boolean; isClassificationValue?: boolean } = {}): void {
  db.prepare(
    `INSERT INTO concept_nodes (concept_id, name, is_classification_key, is_classification_value)
     VALUES (?, ?, ?, ?)`,
  ).run(conceptId, name, opts.isClassificationKey ? 1 : 0, opts.isClassificationValue ? 1 : 0);
}
function insertNode(content: string): number {
  const r = db.prepare("INSERT INTO knowledge_nodes (content) VALUES (?)").run(content);
  return Number(r.lastInsertRowid);
}
function linkNodeConcept(nodeId: number, conceptId: string, role: string): void {
  db.prepare("INSERT INTO node_concept_edges (node_id, concept_id, role, provenance, source_node_id) VALUES (?, ?, ?, 'user_input', NULL)").run(nodeId, conceptId, role);
}
function addParentOf(sourceConceptId: string, targetConceptId: string): void {
  // S0-T4(위계 단일 출처) — 그래프 위계 읽기가 hierarchy_edges 로 옮겨가, 시드도
  // 그 테이블에 넣는다(양 끝 개념). created_at 은 schema DEFAULT 가 채운다.
  db.prepare(
    `INSERT INTO hierarchy_edges (source_type, source_id, target_type, target_id, relation, weight, provenance, source_node_id) VALUES ('concept', ?, 'concept', ?, 'parent_of', 0.9, 'user_input', NULL)`,
  ).run(sourceConceptId, targetConceptId);
}
/** place 행 + identity 엣지(role='identity'·검색 JOIN 키로 보존). */
function insertPlaceLinkedToConcept(placeId: string, name: string, conceptId: string): void {
  // 단계4 T4(종류 통일) — place 행은 통일 entities 에 산다(전용 places 폐기).
  db.prepare(
    `INSERT INTO entities (entity_id, type_name, name, created_at, updated_at)
     VALUES (?, 'place', ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
  ).run(placeId, name);
  db.prepare(
    `INSERT INTO entity_concept_edges (entity_id, concept_id, role, created_at, provenance, source_node_id) VALUES (?, ?, 'identity', '2026-01-01 00:00:00', 'user_input', NULL)`,
  ).run(placeId, conceptId);
}
/** creature 행 + identity 엣지(role='identity'·동명 무관 행 가드용). */
function insertCreatureLinkedToConcept(creatureId: string, name: string, conceptId: string): void {
  // 단계4 T4(종류 통일) — creature 행도 통일 entities 에 산다.
  db.prepare(
    `INSERT INTO entities (entity_id, type_name, name, created_at, updated_at)
     VALUES (?, 'creature', ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
  ).run(creatureId, name);
  db.prepare(
    `INSERT INTO entity_concept_edges (entity_id, concept_id, role, created_at, provenance, source_node_id) VALUES (?, ?, 'identity', '2026-01-01 00:00:00', 'user_input', NULL)`,
  ).run(creatureId, conceptId);
}
/** 분류 개념(부모) → 8 타입 엔티티 행 id 직접 parent_of(끝점 종류 임의). */
function addParentOfToEntityRow(sourceConceptId: string, targetType: string, entityId: string): void {
  db.prepare(
    `INSERT INTO hierarchy_edges (source_type, source_id, target_type, target_id, relation, weight, provenance, source_node_id) VALUES ('concept', ?, ?, ?, 'parent_of', 0.9, 'user_input', NULL)`,
  ).run(sourceConceptId, targetType, entityId);
}
/**
 * 위계 단일 출처(S2-T1·S2-T3) — 분류 개념(부모) → 엔티티 행 id 직접 parent_of.
 * 옛 양식(부모 개념 → 그림자 잎 개념 + 흡수)을 행 직접 위계로 대체한다. 끝점 종류는
 * source=concept·target=place 로, 그래프 빌드가 entityKey 로 그 행을 위계 잎으로 그린다.
 */
function addParentOfToPlaceRow(sourceConceptId: string, placeId: string): void {
  db.prepare(
    `INSERT INTO hierarchy_edges (source_type, source_id, target_type, target_id, relation, weight, provenance, source_node_id) VALUES ('concept', ?, 'place', ?, 'parent_of', 0.9, 'user_input', NULL)`,
  ).run(sourceConceptId, placeId);
}
function seedNodeMap(nodeId: number, content: string): Map<string, GraphNode> {
  const m = new Map<string, GraphNode>();
  m.set(`node:${nodeId}`, { id: `node:${nodeId}`, sourceId: nodeId, sourceType: "text", label: content.slice(0, 31), snippet: content });
  return m;
}

// ── ② 위계 잎 행 직접 합류(S2-T3·옛 흡수 폐기) ──────────────────────────────

describe("위계 잎 행 직접 합류(S2-T3) — 엔티티 행이 위계 잎·흡수 0", () => {
  test("무지개의원 place 행이 위계 잎으로 직접 합류·피부과→plc_rainbow 직접·그림자 잎 위계 0", async () => {
    // 장소 사슬(위계 단일 출처): 장소(루트 분류 키) → 피부과(분류) → plc_rainbow(place 행).
    // 옛 양식의 부모개념 → 그림자 잎 개념 + 흡수를 행 직접 위계로 대체한다(S2-T1·S2-T3).
    insertConcept("cpt_place_root", "장소", { isClassificationKey: true });
    insertConcept("cpt_dermat", "피부과", { isClassificationKey: true, isClassificationValue: true });
    insertConcept("cpt_rainbow", "무지개의원", { isClassificationValue: true });
    addParentOf("cpt_place_root", "cpt_dermat");

    // 무지개의원 place 행 + identity 엣지(검색 JOIN 키). 위계 잎은 그 행 직접.
    insertPlaceLinkedToConcept("plc_rainbow", "무지개의원", "cpt_rainbow");
    addParentOfToPlaceRow("cpt_dermat", "plc_rainbow");

    // 글이 루트·분류 개념에 이어져 노드 집합에 들어오게 한다(양끝 불변식 충족·부모 in-set).
    const nodeId = insertNode("무지개의원에서 진료");
    linkNodeConcept(nodeId, "cpt_place_root", "classification");
    linkNodeConcept(nodeId, "cpt_dermat", "classification");

    const nodeById = seedNodeMap(nodeId, "무지개의원에서 진료");
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    // place 행이 위계 잎으로 직접 합류한다(흡수 없이).
    expect(nodeById.has("entity:place:plc_rainbow")).toBe(true);

    // 개념 루트·중간 분류는 개념 노드로 그대로 남는다(엔티티 아님).
    expect(nodeById.has("concept:cpt_place_root")).toBe(true);
    expect(nodeById.has("concept:cpt_dermat")).toBe(true);

    // 위계선 피부과 → plc_rainbow(행)이 직접 그려져 사슬이 이어진다(재지정 없이).
    const chainEdge = [...edgeSet.values()].some(
      (e) => e.from === "concept:cpt_dermat" && e.to === "entity:place:plc_rainbow" && e.type === "parent_of",
    );
    expect(chainEdge).toBe(true);

    // '무지개의원' 개념은 위계 자식으로 안 그어진다(위계 잎 자리는 place 행이 대신).
    const rainbowAsHierChild = [...edgeSet.values()].some(
      (e) => e.to === "concept:cpt_rainbow" && e.type === "parent_of",
    );
    expect(rainbowAsHierChild).toBe(false);

    // 자기-루프 엣지 0.
    expect([...edgeSet.values()].some((e) => e.from === e.to)).toBe(false);
  });
});

// ── 과흡수 0 가드(S3-T4·spec §1 회귀 고정·8 타입 identity 축) ────────────────

describe("과흡수 0 — 같은 이름 무관 8 타입 행이 직접 연결이라 다른 사슬 위계에 안 섞인다", () => {
  test("동명 '무지개의원' place·creature 행 두 사슬이 각자 위계 잎으로 따로 그어진다(라벨 일치 흡수 0)", async () => {
    // spec §1 회귀 고정 — 옛 identity 흡수는 conceptToEntityKey 라벨/이름 일치로 같은
    //   이름을 쓰는 무관한 엔티티 행을 한 노드로 빨아들였다(비결정적 과흡수의 뿌리).
    //   직접 연결 구조는 hierarchy_edges 가 가리키는 *그 행만* 위계 잎으로 그어, 우연히
    //   이름이 같은 다른 사슬의 무관 행을 끌어오지 않는다. place '무지개의원'(피부과 밑)과
    //   creature '무지개의원'(동물 밑)을 일부러 같은 이름으로 깔아, 둘이 각자 사슬에만
    //   잎으로 붙고 한 노드로 섞이지 않음을 단언한다.
    insertConcept("cpt_dermat", "피부과", { isClassificationKey: true, isClassificationValue: true });
    insertConcept("cpt_animal", "동물", { isClassificationKey: true, isClassificationValue: true });
    // 두 행의 identity 잎 개념은 서로 다른 이름으로 둔다(concept_nodes.name UNIQUE).
    // 회귀 단서는 *행 이름*이 같다는 것이라, 행 두 개만 동명으로 깔면 충분하다.
    insertConcept("cpt_rainbow_plc", "무지개의원장소", { isClassificationValue: true });
    insertConcept("cpt_rainbow_cre", "무지개의원생물", { isClassificationValue: true });

    // place 사슬: 피부과 → plc_rainbow 행(이름 "무지개의원").
    insertPlaceLinkedToConcept("plc_rainbow", "무지개의원", "cpt_rainbow_plc");
    addParentOfToPlaceRow("cpt_dermat", "plc_rainbow");
    // creature 사슬: 동물 → cre_rainbow 행(우연히 같은 이름 "무지개의원").
    insertCreatureLinkedToConcept("cre_rainbow", "무지개의원", "cpt_rainbow_cre");
    addParentOfToEntityRow("cpt_animal", "creature", "cre_rainbow");

    // 글이 두 분류 개념(피부과·동물)을 다 직접 언급해 두 사슬을 한 화면에 모은다.
    const nodeId = insertNode("무지개의원 진료·무지개의원 관찰");
    linkNodeConcept(nodeId, "cpt_dermat", "classification");
    linkNodeConcept(nodeId, "cpt_animal", "classification");

    const nodeById = seedNodeMap(nodeId, "무지개의원 진료·무지개의원 관찰");
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    // 두 엔티티 행이 *각자 별개 노드*로 합류한다(라벨 일치로 한 노드로 안 합쳐짐).
    expect(nodeById.has("entity:place:plc_rainbow")).toBe(true);
    expect(nodeById.has("entity:creature:cre_rainbow")).toBe(true);

    // 위계선이 사슬별로 따로 그어진다 — 피부과는 place 행에만, 동물은 creature 행에만.
    const has = (from: string, to: string): boolean =>
      [...edgeSet.values()].some(
        (e) => e.from === from && e.to === to && e.type === "parent_of",
      );
    expect(has("concept:cpt_dermat", "entity:place:plc_rainbow")).toBe(true);
    expect(has("concept:cpt_animal", "entity:creature:cre_rainbow")).toBe(true);

    // 교차 오염 0 — 직접 연결이라 라벨 일치로 사슬이 안 섞인다(과흡수 회귀 고정).
    expect(has("concept:cpt_dermat", "entity:creature:cre_rainbow")).toBe(false);
    expect(has("concept:cpt_animal", "entity:place:plc_rainbow")).toBe(false);
  });
});

// ── ③ 묶음 라벨 구분 ───────────────────────────────────────────────────────

describe("묶음↔위계 루트 통합(④) + member_of 추이 감축(⑤)", () => {
  test("콜론 위계 장소 → group:place 없음·'장소' 한 노드·member_of 생략·parent_of 한 줄(행 직접 잎)", async () => {
    // 콜론 위계(위계 단일 출처): 장소(루트 분류 키) → 병원 → 피부과 → plc_rainbow(place 행).
    // 옛 부모개념 → 그림자 잎 개념 + 흡수를 행 직접 위계로 대체한다(S2-T1·S2-T3).
    insertConcept("cpt_place_root", "장소", { isClassificationKey: true });
    insertConcept("cpt_hosp", "병원", { isClassificationKey: true, isClassificationValue: true });
    insertConcept("cpt_dermat", "피부과", { isClassificationKey: true, isClassificationValue: true });
    insertConcept("cpt_rainbow", "무지개의원", { isClassificationValue: true });
    addParentOf("cpt_place_root", "cpt_hosp");
    addParentOf("cpt_hosp", "cpt_dermat");
    insertPlaceLinkedToConcept("plc_rainbow", "무지개의원", "cpt_rainbow");
    addParentOfToPlaceRow("cpt_dermat", "plc_rainbow");

    const nodeId = insertNode("무지개의원에서 진료");
    linkNodeConcept(nodeId, "cpt_place_root", "classification");
    linkNodeConcept(nodeId, "cpt_hosp", "classification");
    linkNodeConcept(nodeId, "cpt_dermat", "classification");

    const nodeById = seedNodeMap(nodeId, "무지개의원에서 진료");
    const edgeSet = new Map<string, GraphEdge>();

    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    buildGroupNodes(nodeById, edgeSet, refs);

    // ④ 동명 위계 루트 "장소" 개념을 묶음 루트로 재사용 — group:place 가상 노드 0.
    expect(nodeById.has("group:place")).toBe(false);
    // "장소" 라벨 노드는 위계 루트 개념 하나뿐(묶음과 통합·같은 이름 두 노드 0).
    const placeLabeled = [...nodeById.values()].filter((n) => n.label === "장소");
    expect(placeLabeled.length).toBe(1);
    // ⑥ 거대 허브 시각 — 재사용한 위계 루트 노드에 entity_group 신호를 덧입힌다.
    //   (위계 루트면서 거대 허브 양립 — sourceType=entity_group·groupType=place·라벨 "장소"
    //    접미사 없음. 노드 키는 그대로라 parent_of 출발점 불변 — 아래 사슬 단정으로 확인.)
    expect(placeLabeled[0]!.sourceType).toBe("entity_group");
    expect(placeLabeled[0]!.groupType).toBe("place");
    expect(placeLabeled[0]!.label).toBe("장소"); // koName 그대로(접미사 안 붙임).

    // ⑤ 무지개의원은 위계로 닿으므로 member_of 직접선 생략 — member_of 엣지 0.
    const memberOfEdges = [...edgeSet.values()].filter((e) => e.type === "member_of");
    expect(memberOfEdges.length).toBe(0);

    // parent_of 사슬이 한 줄로 이어진다(끝점은 place 행 키·위계 단일 출처 직접).
    const placeRootKey = placeLabeled[0]!.id;
    const chain = [...edgeSet.values()].filter((e) => e.type === "parent_of");
    expect(chain.some((e) => e.from === placeRootKey && e.to === "concept:cpt_hosp")).toBe(true);
    expect(chain.some((e) => e.from === "concept:cpt_hosp" && e.to === "concept:cpt_dermat")).toBe(true);
    expect(chain.some((e) => e.from === "concept:cpt_dermat" && e.to === "entity:place:plc_rainbow")).toBe(true);
  });

  test("단일 배치 장소(#장소:카페) → 타입 루트가 집합 안이면 group:place 재사용·member_of 생략(행 직접 잎)", async () => {
    // 카페는 단일 배치라 부모 = 타입 루트("장소"). 위계 단일 출처(S2-T1)는 장소 → plc_cafe
    // parent_of 를 직접 쓴다. 위계 잎 행이 그어지려면 그 부모(장소 루트)가 노드 집합 안이어야
    // 한다(spec §6.1). 글이 "장소" 루트를 언급한 상황을 재현한다 — 그러면 카페 행이 위계
    // 잎으로 합류하고, ④ 가 그 위계 루트("장소" 개념)를 묶음 루트로 재사용한다.
    insertConcept("cpt_place_root", "장소", { isClassificationKey: true });
    insertConcept("cpt_cafe", "카페", { isClassificationValue: true });
    insertPlaceLinkedToConcept("plc_cafe", "카페", "cpt_cafe");
    addParentOfToPlaceRow("cpt_place_root", "plc_cafe");

    const nodeId = insertNode("카페 갔다");
    linkNodeConcept(nodeId, "cpt_place_root", "classification"); // 타입 루트를 집합 안으로.

    const nodeById = seedNodeMap(nodeId, "카페 갔다");
    const edgeSet = new Map<string, GraphEdge>();

    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    buildGroupNodes(nodeById, edgeSet, refs);

    // 카페 행이 위계 잎으로 합류했다(entityRefs 인계).
    expect(refs.entityRefs).toContainEqual({ type: "place", id: "plc_cafe" });
    expect(nodeById.has("entity:place:plc_cafe")).toBe(true);

    // ④ 동명 위계 루트 "장소" 개념을 묶음 루트로 재사용 — group:place 가상 노드 0.
    expect(nodeById.has("group:place")).toBe(false);

    // ⑤ 카페는 장소 → plc_cafe 위계로 닿으므로 member_of 직접선 생략.
    const placeRootKey = [...nodeById.values()].find((n) => n.label === "장소")!.id;
    expect(edgeSet.has(`edge:${placeRootKey}->entity:place:plc_cafe:member_of`)).toBe(false);
    // 위계선 장소 → plc_cafe 가 직접 그려진다.
    const chain = [...edgeSet.values()].some(
      (e) => e.from === placeRootKey && e.to === "entity:place:plc_cafe" && e.type === "parent_of",
    );
    expect(chain).toBe(true);
  });
});

// ── absorbConceptsIntoEntities 순수 함수 단위 ──────────────────────────────

describe("absorbConceptsIntoEntities — 순수 함수 흡수 규칙", () => {
  test("개념 노드 제거 + 엣지 끝점 재지정 + 자기-루프/중복 정리", () => {
    const nodeById = new Map<string, GraphNode>([
      ["concept:c1", { id: "concept:c1", sourceType: "concept", label: "무지개의원" }],
      ["entity:place:e1", { id: "entity:place:e1", sourceType: "place", label: "무지개의원" }],
      ["concept:parent", { id: "concept:parent", sourceType: "classification_key", label: "피부과" }],
      ["node:1", { id: "node:1", sourceId: 1, sourceType: "text", label: "글" }],
    ]);
    const edgeSet = new Map<string, GraphEdge>([
      // 위계 엣지(부모 → 개념) — 엔티티로 재지정돼야.
      ["edge:concept:parent->concept:c1:parent_of", { id: "edge:concept:parent->concept:c1:parent_of", from: "concept:parent", to: "concept:c1", type: "parent_of", weight: 0.9 }],
      // identity 엣지(엔티티 → 개념) — 자기-루프가 돼 버려져야.
      ["edge:entity:place:e1->concept:c1:identity", { id: "edge:entity:place:e1->concept:c1:identity", from: "entity:place:e1", to: "concept:c1", type: "identity", weight: 0.6 }],
      // 글 엣지(글 → 개념) — 글 → 엔티티로 재지정돼야.
      ["edge:node:1->concept:c1:classification", { id: "edge:node:1->concept:c1:classification", from: "node:1", to: "concept:c1", type: "classification", weight: 0.6 }],
    ]);

    absorbConceptsIntoEntities(nodeById, edgeSet, new Map([["concept:c1", "entity:place:e1"]]));

    // 개념 노드 제거.
    expect(nodeById.has("concept:c1")).toBe(false);
    expect(nodeById.has("entity:place:e1")).toBe(true);

    // 위계 엣지 재지정.
    expect([...edgeSet.values()].some((e) => e.from === "concept:parent" && e.to === "entity:place:e1" && e.type === "parent_of")).toBe(true);
    // 글 엣지 재지정.
    expect([...edgeSet.values()].some((e) => e.from === "node:1" && e.to === "entity:place:e1" && e.type === "classification")).toBe(true);
    // 자기-루프(identity) 제거.
    expect([...edgeSet.values()].some((e) => e.from === e.to)).toBe(false);
    // 개념 끝점 0.
    expect([...edgeSet.values()].some((e) => e.from === "concept:c1" || e.to === "concept:c1")).toBe(false);
  });

  test("빈 매핑이면 아무 변형 없음(no-op)", () => {
    const nodeById = new Map<string, GraphNode>([["concept:c1", { id: "concept:c1", sourceType: "concept", label: "x" }]]);
    const edgeSet = new Map<string, GraphEdge>();
    absorbConceptsIntoEntities(nodeById, edgeSet, new Map());
    expect(nodeById.has("concept:c1")).toBe(true);
  });

  test("매핑에 없는 동명 노드는 안 건드린다(라벨 일치 자동 흡수 입구 0·S3-T4)", () => {
    // spec §1 회귀 고정 — 이 엔진은 *받은 매핑이 가리키는 노드만* 합친다. 라벨(이름)이
    //   같다는 이유로 알아서 합치지 않는다(옛 라벨 흡수가 이름 일치를 흡수 단서로 삼아
    //   무관 노드를 빨아들인 회귀의 뿌리). 같은 label '무지개의원' 노드 둘을 깔되 매핑은
    //   하나만 가리켜, 매핑 밖 동명 노드가 멀쩡히 남음을 단언한다.
    const nodeById = new Map<string, GraphNode>([
      ["concept:c1", { id: "concept:c1", sourceType: "concept", label: "무지개의원" }],
      ["entity:place:e1", { id: "entity:place:e1", sourceType: "place", label: "무지개의원" }],
      ["entity:creature:e2", { id: "entity:creature:e2", sourceType: "creature", label: "무지개의원" }],
    ]);
    const edgeSet = new Map<string, GraphEdge>();
    // 매핑은 concept:c1 → entity:place:e1 만 지목. 동명 entity:creature:e2 는 매핑 밖.
    absorbConceptsIntoEntities(nodeById, edgeSet, new Map([["concept:c1", "entity:place:e1"]]));

    // 매핑이 지목한 c1 만 사라지고, 라벨이 같은 무관 행 e2 는 그대로 남는다(자동 흡수 0).
    expect(nodeById.has("concept:c1")).toBe(false);
    expect(nodeById.has("entity:place:e1")).toBe(true);
    expect(nodeById.has("entity:creature:e2")).toBe(true);
  });
});
