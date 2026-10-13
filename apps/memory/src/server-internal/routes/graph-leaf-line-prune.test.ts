/**
 * graph-leaf-line-prune.test.ts — ⑦⑨ 글-허브 연결선 정리 검증.
 * spec docs/decisions/2026-06-13-graph-node-absorption-shortcut-prevention-spec.md §5.4 ⑦⑨·§8 3d·3f·§9.
 *
 * 실제 bun:sqlite(:memory:) + 실제 SqliteMemoryStore 통합 — Mock 클래스 0.
 * graph-node-absorption.test.ts·graph-group-nodes.test.ts 의 삽입 양식을 재사용한다.
 *
 * 검증:
 *   ⑦ 한 글이 위계 사슬 여러 분류(장소·병원·피부과·무지개의원)에 그은 classification
 *      글-선 중 상위 분류(다른 분류의 조상) 선을 거르고 잎(무지개의원 엔티티)만 남긴다.
 *   ⑦ 과삭제 차단 — 서로 무관한 분류 둘은 둘 다 남는다·분류 하나뿐인 글은 그 선이 남는다.
 *   ⑦ 검색 무영향 — node_concept_edges DB 행은 그대로.
 *   ⑨ role 무관(mention·tag) 글-선도 잎으로 닿으면 거름(타입 허브 직결 해소)·⑦ 상위집합.
 *   ⑨ 검색 무영향 — classification·mention·tag DB 행 전부 그대로.
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
  absorbSameLabelNodes,
  pruneClassificationLeafLines,
} from "./graph.ts";
import type { GraphNode, GraphEdge } from "./graph.ts";
import {
  MENTION_ENTITY_EDGE_TYPE,
  OWNS_MEMORY_EDGE_TYPE,
} from "./graph-nodes-shared.ts";
import { wireHashtagEntities } from "../../memory/hashtag-entity-wiring.ts";
import { wireEntityPlacement } from "../../memory/entity-placement-wiring.ts";
import { resetConceptTypeVocabularyCache } from "../../memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";

beforeAll(async () => { await loadEmbedder(); });
afterAll(() => {});

let ctx: GraphTestContext;
let store: SqliteMemoryStore;
let db: Database;

beforeEach(async () => {
  // 운영 yaml 단일 출처를 읽는다(다른 테스트가 fixture path 로 캐시를 오염했을 수 있어 초기화).
  resetConceptTypeVocabularyCache();
  resetClassifierCache();
  ctx = await makeGraphTestDeps();
  store = ctx.store;
  db = ctx.db;
});
afterEach(() => { ctx.close(); });

// ── 삽입 헬퍼(absorption 테스트 양식 재사용) ─────────────────────────────────

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
function insertPlaceLinkedToConcept(placeId: string, name: string, conceptId: string): void {
  // 단계4 T4(종류 통일) — place 행은 전용 places 가 아니라 통일 entities 에 산다.
  db.prepare(
    `INSERT INTO entities (entity_id, type_name, name, created_at, updated_at)
     VALUES (?, 'place', ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
  ).run(placeId, name);
  db.prepare(
    `INSERT INTO entity_concept_edges (entity_id, concept_id, role, created_at, provenance, source_node_id) VALUES (?, ?, 'identity', '2026-01-01 00:00:00', 'user_input', NULL)`,
  ).run(placeId, conceptId);
}
/** schedule 행 + identity 엣지(⑨ 일정 허브 케이스용·검색 JOIN 키). */
function insertScheduleLinkedToConcept(scheduleId: string, name: string, conceptId: string): void {
  // 단계4 T4(종류 통일) — schedule 행도 통일 entities 에 산다.
  db.prepare(
    `INSERT INTO entities (entity_id, type_name, name, created_at, updated_at)
     VALUES (?, 'schedule', ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
  ).run(scheduleId, name);
  db.prepare(
    `INSERT INTO entity_concept_edges (entity_id, concept_id, role, created_at, provenance, source_node_id) VALUES (?, ?, 'identity', '2026-01-01 00:00:00', 'user_input', NULL)`,
  ).run(scheduleId, conceptId);
}
/** 위계 단일 출처(S2-T1·S2-T3) — 분류 개념(부모) → 엔티티 행 id 직접 parent_of. */
function addParentOfToEntityRow(sourceConceptId: string, targetType: string, entityId: string): void {
  db.prepare(
    `INSERT INTO hierarchy_edges (source_type, source_id, target_type, target_id, relation, weight, provenance, source_node_id) VALUES ('concept', ?, ?, ?, 'parent_of', 0.9, 'user_input', NULL)`,
  ).run(sourceConceptId, targetType, entityId);
}
function seedNodeMap(nodeId: number, content: string): Map<string, GraphNode> {
  const m = new Map<string, GraphNode>();
  m.set(`node:${nodeId}`, { id: `node:${nodeId}`, sourceId: nodeId, sourceType: "text", label: content.slice(0, 31), snippet: content });
  return m;
}

/** 한 글의 classification 글-선(글 → 분류 노드)이 edgeSet 에 있는지. */
function hasClassLine(edgeSet: Map<string, GraphEdge>, memoryKey: string, targetKey: string): boolean {
  return [...edgeSet.values()].some(
    (e) => e.type === "classification" && e.from === memoryKey && e.to === targetKey,
  );
}

/** 한 글의 글-선(role 무관)이 edgeSet 에 있는지(⑨ mention·tag 확인용). */
function hasLine(edgeSet: Map<string, GraphEdge>, memoryKey: string, targetKey: string, role: string): boolean {
  return [...edgeSet.values()].some(
    (e) => e.type === role && e.from === memoryKey && e.to === targetKey,
  );
}

// ── ⑦ 위계 사슬 다중 연결 글 → 잎만 남김 ────────────────────────────────────

describe("⑦ 글-분류 연결선 정리 — 잎만 남기고 상위 분류 글-선 거름", () => {
  test("장소·병원 상위 글-선은 걸러지고 잎(피부과·무지개의원 행)만 남는다(위계 단일 출처 행 직접)", async () => {
    // 콜론 위계(위계 단일 출처): 장소 → 병원 → 피부과 → plc_rainbow(place 행). '무지개의원'
    // 이름 개념(cpt_rainbow)은 행 ↔ 잎-개념 identity 로 DB 에 남고 글이 그 개념도 언급한다.
    // 옛 흡수가 글→cpt_rainbow 을 글→plc_rainbow 으로 재지정하던 것을, 위계 단일 출처는 행을
    // 위계 잎으로 직접 그린다(흡수 0). 이 글-선 끝점 변화는 spec §6.4 ⑨ 라이브 게이트 대상.
    insertConcept("cpt_place_root", "장소", { isClassificationKey: true });
    insertConcept("cpt_hosp", "병원", { isClassificationKey: true, isClassificationValue: true });
    insertConcept("cpt_dermat", "피부과", { isClassificationKey: true, isClassificationValue: true });
    insertConcept("cpt_rainbow", "무지개의원", { isClassificationValue: true });
    addParentOf("cpt_place_root", "cpt_hosp");
    addParentOf("cpt_hosp", "cpt_dermat");
    insertPlaceLinkedToConcept("plc_rainbow", "무지개의원", "cpt_rainbow");
    addParentOfToEntityRow("cpt_dermat", "place", "plc_rainbow");

    // 글이 사슬 분류(장소·병원·피부과)에 classification 으로 이어진다(라이브 재현).
    const nodeId = insertNode("무지개의원에서 진료");
    const memKey = `node:${nodeId}`;
    linkNodeConcept(nodeId, "cpt_place_root", "classification");
    linkNodeConcept(nodeId, "cpt_hosp", "classification");
    linkNodeConcept(nodeId, "cpt_dermat", "classification");

    const nodeById = seedNodeMap(nodeId, "무지개의원에서 진료");
    const edgeSet = new Map<string, GraphEdge>();

    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    buildGroupNodes(nodeById, edgeSet, refs);

    // place 행이 위계 잎으로 합류했다(피부과 → plc_rainbow 위계선 직접·그림자 잎 0).
    expect(nodeById.has("entity:place:plc_rainbow")).toBe(true);
    // 위계 단일 출처(흡수 폐기) — place 행이 흡수 산물이 아니라 entity 행 노드로 직접 들어왔고
    //   피부과(부모 분류) → plc_rainbow(자식 행) parent_of 위계선이 edgeSet 에 직접 그어졌는지 단언.
    //   ⑨ 의 조상 판정 BFS 가 이 parent_of 끝점(행)을 잎으로 잡아 상위 글-선을 거른다.
    expect(nodeById.get("entity:place:plc_rainbow")!.sourceType).toBe("place");
    expect(
      [...edgeSet.values()].some(
        (e) => e.type === "parent_of" && e.from === "concept:cpt_dermat" && e.to === "entity:place:plc_rainbow",
      ),
    ).toBe(true);

    // 거르기 전: 글-선이 사슬 상위 분류(장소·병원·피부과)에 다 있다.
    expect(hasClassLine(edgeSet, memKey, "concept:cpt_place_root")).toBe(true);
    expect(hasClassLine(edgeSet, memKey, "concept:cpt_hosp")).toBe(true);
    expect(hasClassLine(edgeSet, memKey, "concept:cpt_dermat")).toBe(true);

    pruneClassificationLeafLines(nodeById, edgeSet);

    // 거른 뒤: 상위 분류(장소·병원) 글-선은 사라지고 잎 피부과(place 행의 위계 부모)
    //   글-선만 남는다 — 피부과는 plc_rainbow 행의 부모이자 글이 직접 언급한 가장 깊은 분류다.
    expect(hasClassLine(edgeSet, memKey, "concept:cpt_place_root")).toBe(false);
    expect(hasClassLine(edgeSet, memKey, "concept:cpt_hosp")).toBe(false);
    expect(hasClassLine(edgeSet, memKey, "concept:cpt_dermat")).toBe(true);

    // ⑦ 검색 무영향 — node_concept_edges DB 행은 세 분류 그대로(걸러진 건 표시 엣지뿐).
    const dbRows = db.prepare(
      "SELECT concept_id FROM node_concept_edges WHERE node_id = ? AND role = 'classification' ORDER BY concept_id",
    ).all(nodeId) as { concept_id: string }[];
    const dbConceptIds = dbRows.map((r) => r.concept_id).sort();
    expect(dbConceptIds).toEqual(["cpt_dermat", "cpt_hosp", "cpt_place_root"].sort());
  });

  test("위계 중간까지만 닿아도 그 사슬의 상위만 거르고 가장 깊은 잎만 남긴다", async () => {
    // 장소 → 병원 → 피부과. 글이 장소·병원·피부과 셋에만 이어진다(엔티티 없음·피부과가 잎).
    insertConcept("cpt_place_root", "장소", { isClassificationKey: true });
    insertConcept("cpt_hosp", "병원", { isClassificationKey: true, isClassificationValue: true });
    insertConcept("cpt_dermat", "피부과", { isClassificationKey: true, isClassificationValue: true });
    addParentOf("cpt_place_root", "cpt_hosp");
    addParentOf("cpt_hosp", "cpt_dermat");

    const nodeId = insertNode("병원 갔다");
    const memKey = `node:${nodeId}`;
    linkNodeConcept(nodeId, "cpt_place_root", "classification");
    linkNodeConcept(nodeId, "cpt_hosp", "classification");
    linkNodeConcept(nodeId, "cpt_dermat", "classification");

    const nodeById = seedNodeMap(nodeId, "병원 갔다");
    const edgeSet = new Map<string, GraphEdge>();

    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    buildGroupNodes(nodeById, edgeSet, refs);
    pruneClassificationLeafLines(nodeById, edgeSet);

    // 장소·병원(조상)은 거르고 피부과(잎)만 남는다.
    expect(hasClassLine(edgeSet, memKey, "concept:cpt_place_root")).toBe(false);
    expect(hasClassLine(edgeSet, memKey, "concept:cpt_hosp")).toBe(false);
    expect(hasClassLine(edgeSet, memKey, "concept:cpt_dermat")).toBe(true);
  });
});

// ── ⑦ 과삭제 차단 ─────────────────────────────────────────────────────────

describe("⑦ 과삭제 차단 — 무관·단독 분류 글-선은 남긴다", () => {
  test("서로 무관한 분류 둘(장소·취향)은 둘 다 남는다(외톨이 방지)", async () => {
    // 두 분류가 같은 사슬이 아님 — 어느 쪽도 다른 쪽의 조상이 아니다.
    insertConcept("cpt_place_root", "장소", { isClassificationKey: true });
    insertConcept("cpt_taste", "취향", { isClassificationKey: true });
    // 사슬 없음(두 분류 사이 parent_of 0). 글이 둘 다에 이어진다.
    const nodeId = insertNode("장소·취향 글");
    const memKey = `node:${nodeId}`;
    linkNodeConcept(nodeId, "cpt_place_root", "classification");
    linkNodeConcept(nodeId, "cpt_taste", "classification");

    const nodeById = seedNodeMap(nodeId, "장소·취향 글");
    const edgeSet = new Map<string, GraphEdge>();

    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    buildGroupNodes(nodeById, edgeSet, refs);
    pruneClassificationLeafLines(nodeById, edgeSet);

    // 무관한 두 분류 글-선 둘 다 남는다(조상-자손 관계가 없어 과삭제 안 됨).
    expect(hasClassLine(edgeSet, memKey, "concept:cpt_place_root")).toBe(true);
    expect(hasClassLine(edgeSet, memKey, "concept:cpt_taste")).toBe(true);
  });

  test("분류 하나뿐인 글은 그 글-선이 남는다(외톨이 방지)", async () => {
    insertConcept("cpt_solo", "병원", { isClassificationKey: true, isClassificationValue: true });
    const nodeId = insertNode("병원만 글");
    const memKey = `node:${nodeId}`;
    linkNodeConcept(nodeId, "cpt_solo", "classification");

    const nodeById = seedNodeMap(nodeId, "병원만 글");
    const edgeSet = new Map<string, GraphEdge>();

    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    buildGroupNodes(nodeById, edgeSet, refs);
    pruneClassificationLeafLines(nodeById, edgeSet);

    expect(hasClassLine(edgeSet, memKey, "concept:cpt_solo")).toBe(true);
  });

  test("멱등 — 두 번 거른다고 잎까지 사라지지 않는다", async () => {
    insertConcept("cpt_place_root", "장소", { isClassificationKey: true });
    insertConcept("cpt_hosp", "병원", { isClassificationKey: true, isClassificationValue: true });
    addParentOf("cpt_place_root", "cpt_hosp");
    const nodeId = insertNode("두번 거름 글");
    const memKey = `node:${nodeId}`;
    linkNodeConcept(nodeId, "cpt_place_root", "classification");
    linkNodeConcept(nodeId, "cpt_hosp", "classification");

    const nodeById = seedNodeMap(nodeId, "두번 거름 글");
    const edgeSet = new Map<string, GraphEdge>();

    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    buildGroupNodes(nodeById, edgeSet, refs);
    pruneClassificationLeafLines(nodeById, edgeSet);
    pruneClassificationLeafLines(nodeById, edgeSet); // 2회째 — 잎은 그대로.

    expect(hasClassLine(edgeSet, memKey, "concept:cpt_place_root")).toBe(false);
    expect(hasClassLine(edgeSet, memKey, "concept:cpt_hosp")).toBe(true);
  });
});

// ── ⑨ role 무관(mention·tag) 글-선 정리 ─────────────────────────────────────

describe("⑨ 글-허브 연결선 role 무관 정리 — mention·tag 글-선도 잎으로 닿으면 거름", () => {
  test("일정 허브 글-선이 잎(장터당번 schedule 행)으로도 닿으면 글이 잎에만 붙는다(관찰 1·3f·H1)", async () => {
    // 태그 "일정" + schedule 엔티티 "장터당번"(cpt_market 와 identity 1:1).
    // H1(전 타입 일반화·Q2-5) 이후: graph-augment 1.5c 가 schedule 잎(cpt_market)을
    //   schedule 행으로 승격해 글이 자기 행에 직접 매달리고(mentions_entity), 그 행의 위계
    //   사슬 분류('일정')로 가는 글→일정 직접 선을 제거한다. 그래서 ⑨ prune 이 돌기 전에
    //   이미 글이 장터당번 schedule 행 한 곳에만 붙어 있고, 일정 허브 직결 선은 0 이다(⑨ 가
    //   하던 "잎에만 남김"을 H1 승격이 상류에서 더 직접적으로 달성). 옛 흡수/prune 중간
    //   상태(글→일정 mention·글→장터당번 classification 글-선 공존) 대신 H1 최종 표시를 단언.
    insertConcept("cpt_iljeong", "일정");
    insertConcept("cpt_market", "장터당번", { isClassificationValue: true });
    insertScheduleLinkedToConcept("sch_market", "장터당번", "cpt_market");
    addParentOfToEntityRow("cpt_iljeong", "schedule", "sch_market");

    const nodeId = insertNode("장터당번 일정 글");
    const memKey = `node:${nodeId}`;
    linkNodeConcept(nodeId, "cpt_iljeong", "mention");        // 글 → "일정"(mention·상위 분류)
    linkNodeConcept(nodeId, "cpt_market", "classification"); // 글 → 장터당번(classification·잎)

    const nodeById = seedNodeMap(nodeId, "장터당번 일정 글");
    const edgeSet = new Map<string, GraphEdge>();

    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    buildGroupNodes(nodeById, edgeSet, refs); // group:schedule + member_of(허브→장터당번)
    absorbSameLabelNodes(nodeById, edgeSet);  // ⑧
    pruneClassificationLeafLines(nodeById, edgeSet); // ⑨

    // (H1) 글→일정 사슬 분류 직접 선은 0 — 개념·허브 어느 키로도 글이 일정에 직접 안 붙는다.
    expect(hasLine(edgeSet, memKey, "concept:cpt_iljeong", "mention")).toBe(false);
    expect(hasLine(edgeSet, memKey, "group:schedule", "mention")).toBe(false);
    // (H1) 글이 장터당번 schedule 행에 직접 매달린다(mentions_entity 승격 간선·from=행·to=글).
    const promoted = [...edgeSet.values()].some(
      (e) =>
        e.type === MENTION_ENTITY_EDGE_TYPE
        && e.from === "entity:schedule:sch_market"
        && e.to === memKey,
    );
    expect(promoted).toBe(true);

    // 검색 무영향 — node_concept_edges DB 행(mention·classification 전부) 그대로(표시만 정리).
    const rows = db.prepare(
      "SELECT concept_id, role FROM node_concept_edges WHERE node_id = ? ORDER BY concept_id",
    ).all(nodeId) as { concept_id: string; role: string }[];
    const pairs = rows.map((r) => `${r.concept_id}:${r.role}`).sort();
    expect(pairs).toEqual(["cpt_iljeong:mention", "cpt_market:classification"].sort());
  });

  test("tag 글-선도 같은 사슬 잎으로 닿으면 거른다(role 무관 확대)", async () => {
    // 콜론 위계 장소 → 병원. 글이 "장소"(tag)·"병원"(classification) 둘에 이어진다.
    insertConcept("cpt_place_root", "장소", { isClassificationKey: true });
    insertConcept("cpt_hosp", "병원", { isClassificationKey: true, isClassificationValue: true });
    addParentOf("cpt_place_root", "cpt_hosp");

    const nodeId = insertNode("병원 갔다");
    const memKey = `node:${nodeId}`;
    linkNodeConcept(nodeId, "cpt_place_root", "tag");          // 글 → "장소"(tag·상위)
    linkNodeConcept(nodeId, "cpt_hosp", "classification");      // 글 → "병원"(잎)

    const nodeById = seedNodeMap(nodeId, "병원 갔다");
    const edgeSet = new Map<string, GraphEdge>();

    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    buildGroupNodes(nodeById, edgeSet, refs);
    pruneClassificationLeafLines(nodeById, edgeSet);

    // 상위 "장소"(tag) 글-선은 거름, 잎 "병원" 글-선은 남는다(⑦ classification 외 role 도).
    expect(hasLine(edgeSet, memKey, "concept:cpt_place_root", "tag")).toBe(false);
    expect(hasLine(edgeSet, memKey, "concept:cpt_hosp", "classification")).toBe(true);
  });

  test("⑨ 과삭제 차단 — 무관한 mention 끝점 둘은 둘 다 남는다", async () => {
    // 사슬 없는 두 끝점(mention) — 어느 쪽도 다른 쪽 조상이 아니다.
    insertConcept("cpt_a", "취미");
    insertConcept("cpt_b", "기분");
    const nodeId = insertNode("취미·기분 글");
    const memKey = `node:${nodeId}`;
    linkNodeConcept(nodeId, "cpt_a", "mention");
    linkNodeConcept(nodeId, "cpt_b", "mention");

    const nodeById = seedNodeMap(nodeId, "취미·기분 글");
    const edgeSet = new Map<string, GraphEdge>();

    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    buildGroupNodes(nodeById, edgeSet, refs);
    pruneClassificationLeafLines(nodeById, edgeSet);

    expect(hasLine(edgeSet, memKey, "concept:cpt_a", "mention")).toBe(true);
    expect(hasLine(edgeSet, memKey, "concept:cpt_b", "mention")).toBe(true);
  });

  test("⑨ vs ⑦ 상위집합 — classification 만 있는 장소 케이스는 ⑦ 과 같은 결과", async () => {
    // mention/tag 없이 classification 만 — ⑨ 가 ⑦ 과 동일(잎만 남김).
    insertConcept("cpt_place_root", "장소", { isClassificationKey: true });
    insertConcept("cpt_hosp", "병원", { isClassificationKey: true, isClassificationValue: true });
    insertConcept("cpt_dermat", "피부과", { isClassificationKey: true, isClassificationValue: true });
    addParentOf("cpt_place_root", "cpt_hosp");
    addParentOf("cpt_hosp", "cpt_dermat");

    const nodeId = insertNode("피부과 글");
    const memKey = `node:${nodeId}`;
    linkNodeConcept(nodeId, "cpt_place_root", "classification");
    linkNodeConcept(nodeId, "cpt_hosp", "classification");
    linkNodeConcept(nodeId, "cpt_dermat", "classification");

    const nodeById = seedNodeMap(nodeId, "피부과 글");
    const edgeSet = new Map<string, GraphEdge>();

    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    buildGroupNodes(nodeById, edgeSet, refs);
    pruneClassificationLeafLines(nodeById, edgeSet);

    expect(hasClassLine(edgeSet, memKey, "concept:cpt_place_root")).toBe(false);
    expect(hasClassLine(edgeSet, memKey, "concept:cpt_hosp")).toBe(false);
    expect(hasClassLine(edgeSet, memKey, "concept:cpt_dermat")).toBe(true);
  });
});

// ── ⑨ person mentions 끝점 글-선 정리(S1-LIVE 결함 가드) ──────────────────────

/**
 * 한 글의 글-선(role 무관)이 edgeSet 에 있는지 — coTarget 키와 type 둘 다로 본다.
 * person mentions 케이스를 글→사람(mentions)·글→조상개념(classification) 으로 구별한다.
 */
function hasLineTo(
  edgeSet: Map<string, GraphEdge>,
  memoryKey: string,
  targetKey: string,
): boolean {
  return [...edgeSet.values()].some((e) => e.from === memoryKey && e.to === targetKey);
}

describe("⑨ person mentions 끝점 — 위계 잎 사람과 그 조상 분류에 함께 닿은 글", () => {
  test("이놀부(mentions·잎)와 막내·가족(classification·조상)에 닿은 글 → 글→이놀부만 남고 조상 cross-edge 거름", async () => {
    // S1-LIVE 실측 결함 재현: 글→사람 글-선 type 이 DB 의 'mentions'(복수)인데
    // PRUNABLE 이 'mention'(단수)만 담아, 이놀부가 prune 후보(coTarget)에서 빠졌다.
    // 그러면 "막내가 다른 끝점(이놀부)의 조상" 판정이 false 라 글→막내 cross-edge 가
    // 안 지워졌다. PRUNABLE 이 'mentions'(복수)도 담으면 이놀부가 coTarget 에 들어와
    // 막내·가족이 그 조상으로 잡혀 글→막내·글→가족 cross-edge 가 거름된다.
    //
    // 데이터는 실제 입력 통로로 깐다(Mock 0): wireHashtagEntities → wireEntityPlacement.
    const content =
      "#사람:이놀부 #관계:가족 #가족:막내 #별명:놀부 #별명:셋째 #생일:1991년8월19일";
    const nodeId = Number(
      (
        db
          .prepare("INSERT INTO knowledge_nodes (content) VALUES (?)")
          .run(content) as { lastInsertRowid: number | bigint }
      ).lastInsertRowid,
    );
    await wireHashtagEntities(store, nodeId, content);
    await wireEntityPlacement(store, nodeId, content, { llm: null });

    const person = await store.findPersonByName("이놀부");
    if (!person) throw new Error("이놀부 person 행이 입력 통로 처리로 생기지 않았다");
    const momConceptId = await store.findOrCreateConcept("막내");
    const familyConceptId = await store.findOrCreateConcept("가족");

    const memKey = `node:${nodeId}`;
    const personKey = `person:${person.personId}`;
    const momKey = `concept:${momConceptId}`;
    const familyKey = `concept:${familyConceptId}`;

    const nodeById = seedNodeMap(nodeId, content);
    const edgeSet = new Map<string, GraphEdge>();
    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    buildGroupNodes(nodeById, edgeSet, refs);

    // 거르기 전: 글이 이놀부(mentions)·막내·가족(classification 조상)에 다 닿는다.
    expect(hasLineTo(edgeSet, memKey, personKey)).toBe(true);
    expect(hasLineTo(edgeSet, memKey, momKey)).toBe(true);
    expect(hasLineTo(edgeSet, memKey, familyKey)).toBe(true);

    pruneClassificationLeafLines(nodeById, edgeSet);

    // 거른 뒤: 글→이놀부(위계 잎)만 남고 글→막내·글→가족 cross-edge 는 거름된다.
    expect(hasLineTo(edgeSet, memKey, personKey)).toBe(true);
    expect(hasLineTo(edgeSet, memKey, momKey)).toBe(false);
    expect(hasLineTo(edgeSet, memKey, familyKey)).toBe(false);

    // 글에 남은 글-선은 정확히 글→이놀부 하나(crossEdges=0 정합).
    const memLines = [...edgeSet.values()].filter((e) => e.from === memKey);
    expect(memLines).toHaveLength(1);
    expect(memLines[0]!.to).toBe(personKey);

    // 검색 무영향 — node_concept_edges 의 막내·가족 classification DB 행은 그대로.
    const dbRows = db
      .prepare(
        "SELECT concept_id FROM node_concept_edges WHERE node_id = ? AND role = 'classification' ORDER BY concept_id",
      )
      .all(nodeId) as { concept_id: string }[];
    const dbIds = dbRows.map((r) => r.concept_id);
    expect(dbIds).toContain(momConceptId);
    expect(dbIds).toContain(familyConceptId);
  });

  test("인영희(mentions·잎)도 같은 코드로 글이 인영희에만 닿는다(엄마·가족 cross-edge 거름)", async () => {
    const content = "#사람:인영희 #관계:가족 #가족:엄마";
    const nodeId = Number(
      (
        db
          .prepare("INSERT INTO knowledge_nodes (content) VALUES (?)")
          .run(content) as { lastInsertRowid: number | bigint }
      ).lastInsertRowid,
    );
    await wireHashtagEntities(store, nodeId, content);
    await wireEntityPlacement(store, nodeId, content, { llm: null });

    const person = await store.findPersonByName("인영희");
    if (!person) throw new Error("인영희 person 행이 입력 통로 처리로 생기지 않았다");
    const eommaConceptId = await store.findOrCreateConcept("엄마");
    const familyConceptId = await store.findOrCreateConcept("가족");

    const memKey = `node:${nodeId}`;
    const personKey = `person:${person.personId}`;
    const eommaKey = `concept:${eommaConceptId}`;
    const familyKey = `concept:${familyConceptId}`;

    const nodeById = seedNodeMap(nodeId, content);
    const edgeSet = new Map<string, GraphEdge>();
    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    buildGroupNodes(nodeById, edgeSet, refs);
    pruneClassificationLeafLines(nodeById, edgeSet);

    // 글→인영희(위계 잎)만 남고 글→엄마·글→가족 cross-edge 는 거름된다.
    expect(hasLineTo(edgeSet, memKey, personKey)).toBe(true);
    expect(hasLineTo(edgeSet, memKey, eommaKey)).toBe(false);
    expect(hasLineTo(edgeSet, memKey, familyKey)).toBe(false);
  });
});

// ── 구조 leaf co-target — owns_memory / mentions_entity ─────────────────────

function putGraphNode(nodeById: Map<string, GraphNode>, id: string, label: string): void {
  nodeById.set(id, { id, sourceType: "concept", label });
}

function putEdge(
  edgeSet: Map<string, GraphEdge>,
  from: string,
  to: string,
  type: string,
): void {
  const id = `edge:${from}->${to}:${type}`;
  edgeSet.set(id, { id, from, to, type, weight: 0.9 });
}

function hasEdge(
  edgeSet: Map<string, GraphEdge>,
  from: string,
  to: string,
  type: string,
): boolean {
  return [...edgeSet.values()].some(
    (e) => e.from === from && e.to === to && e.type === type,
  );
}

describe("⑨ 구조 leaf co-target — owns_memory / mentions_entity 가 조상 글-선을 밀어냄", () => {
  test("project owns_memory leaf 가 있으면 글→프로젝트/코딩/앱 조상 분류선은 제거되고 owns_memory 는 유지된다", () => {
    const nodeById = new Map<string, GraphNode>();
    const edgeSet = new Map<string, GraphEdge>();
    const memKey = "node:1";
    nodeById.set(memKey, {
      id: memKey,
      sourceId: 1,
      sourceType: "text",
      label: "Bara System",
      snippet: "#프로젝트:코딩 #코딩:앱 #앱:바라",
    });
    putGraphNode(nodeById, "concept:project", "프로젝트");
    putGraphNode(nodeById, "concept:coding", "코딩");
    putGraphNode(nodeById, "concept:app", "앱");
    nodeById.set("project:bara", { id: "project:bara", sourceType: "project", label: "바라" });

    putEdge(edgeSet, "concept:project", "concept:coding", "parent_of");
    putEdge(edgeSet, "concept:coding", "concept:app", "parent_of");
    putEdge(edgeSet, "concept:app", "project:bara", "parent_of");
    putEdge(edgeSet, "project:bara", memKey, OWNS_MEMORY_EDGE_TYPE);
    putEdge(edgeSet, memKey, "concept:project", "classification");
    putEdge(edgeSet, memKey, "concept:coding", "classification");
    putEdge(edgeSet, memKey, "concept:app", "classification");

    pruneClassificationLeafLines(nodeById, edgeSet);

    expect(hasLine(edgeSet, memKey, "concept:project", "classification")).toBe(false);
    expect(hasLine(edgeSet, memKey, "concept:coding", "classification")).toBe(false);
    expect(hasLine(edgeSet, memKey, "concept:app", "classification")).toBe(false);
    expect(hasEdge(edgeSet, "project:bara", memKey, OWNS_MEMORY_EDGE_TYPE)).toBe(true);
  });

  test("mentions_entity leaf 가 있으면 글→조상 분류선만 제거하고 무관한 분류선은 남긴다", () => {
    const nodeById = new Map<string, GraphNode>();
    const edgeSet = new Map<string, GraphEdge>();
    const memKey = "node:2";
    nodeById.set(memKey, {
      id: memKey,
      sourceId: 2,
      sourceType: "text",
      label: "네스트 기획",
      snippet: "#작품:게임 #게임:네스트 #취향:힐링",
    });
    putGraphNode(nodeById, "concept:work", "작품");
    putGraphNode(nodeById, "concept:game", "게임");
    putGraphNode(nodeById, "concept:taste", "취향");
    nodeById.set("entity:work:wrk_nest", {
      id: "entity:work:wrk_nest",
      sourceType: "work",
      label: "네스트",
    });

    putEdge(edgeSet, "concept:work", "concept:game", "parent_of");
    putEdge(edgeSet, "concept:game", "entity:work:wrk_nest", "parent_of");
    putEdge(edgeSet, "entity:work:wrk_nest", memKey, MENTION_ENTITY_EDGE_TYPE);
    putEdge(edgeSet, memKey, "concept:work", "classification");
    putEdge(edgeSet, memKey, "concept:game", "classification");
    putEdge(edgeSet, memKey, "concept:taste", "classification");

    pruneClassificationLeafLines(nodeById, edgeSet);

    expect(hasLine(edgeSet, memKey, "concept:work", "classification")).toBe(false);
    expect(hasLine(edgeSet, memKey, "concept:game", "classification")).toBe(false);
    expect(hasLine(edgeSet, memKey, "concept:taste", "classification")).toBe(true);
    expect(hasEdge(edgeSet, "entity:work:wrk_nest", memKey, MENTION_ENTITY_EDGE_TYPE)).toBe(true);
  });
});
