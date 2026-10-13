/**
 * graph-same-label-absorb.test.ts — ⑧ 같은 이름 노드 전면 흡수 검증.
 * spec docs/decisions/2026-06-13-graph-node-absorption-shortcut-prevention-spec.md §5.4 ⑧·§8 3e·§9.
 *
 * 실제 bun:sqlite(:memory:) + 실제 SqliteMemoryStore 통합 — Mock 클래스 0.
 * graph-node-absorption.test.ts·graph-group-nodes.test.ts 의 삽입 양식을 재사용한다.
 *
 * 검증:
 *   ⑧ 라이브 일정 케이스 — 태그 "일정" 개념(classification_key=0·value=0) + schedule
 *      entity_group 묶음이 같은 이름으로 한 노드로 흡수(흡수 후 "일정" 노드 1개·대표는
 *      entity_group 거대 허브). 매달린 글-선·엣지가 대표로 재지정.
 *   ⑧ 대표 우선순위 — 엔티티 행 > entity_group > classification_key > concept(태그/멘션).
 *   ⑧ 회귀 0 — 장소(②④로 이미 한 노드)는 ⑧ 무변경. 같은 이름 2개+ 없으면 no-op.
 *   ⑧ 과흡수 하한 — 단일 노드는 안 건드린다(흡수 후보 2개 미만).
 *   absorbSameLabelNodes 순수 함수 — label 그룹핑 + 대표 매핑 + 흡수 엔진 재사용.
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
} from "./graph.ts";
import type { GraphNode, GraphEdge } from "./graph.ts";
import { MENTION_ENTITY_EDGE_TYPE } from "./graph-nodes-shared.ts";

beforeAll(async () => { await loadEmbedder(); });
afterAll(() => {});

let ctx: GraphTestContext;
let store: SqliteMemoryStore;
let db: Database;

beforeEach(async () => { ctx = await makeGraphTestDeps(); store = ctx.store; db = ctx.db; });
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
/** schedule 행 + identity 엣지(role='identity'·검색 JOIN 키). */
function insertScheduleLinkedToConcept(scheduleId: string, name: string, conceptId: string): void {
  // 단계4 T4(종류 통일) — schedule 행은 통일 entities 에 산다(전용 schedules 폐기).
  db.prepare(
    `INSERT INTO entities (entity_id, type_name, name, created_at, updated_at)
     VALUES (?, 'schedule', ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
  ).run(scheduleId, name);
  db.prepare(
    `INSERT INTO entity_concept_edges (entity_id, concept_id, role, created_at, provenance, source_node_id) VALUES (?, ?, 'identity', '2026-01-01 00:00:00', 'user_input', NULL)`,
  ).run(scheduleId, conceptId);
}
/** place 행 + identity 엣지(회귀 테스트용 장소 사슬·검색 JOIN 키). */
function insertPlaceLinkedToConcept(placeId: string, name: string, conceptId: string): void {
  // 단계4 T4(종류 통일) — place 행도 통일 entities 에 산다.
  db.prepare(
    `INSERT INTO entities (entity_id, type_name, name, created_at, updated_at)
     VALUES (?, 'place', ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
  ).run(placeId, name);
  db.prepare(
    `INSERT INTO entity_concept_edges (entity_id, concept_id, role, created_at, provenance, source_node_id) VALUES (?, ?, 'identity', '2026-01-01 00:00:00', 'user_input', NULL)`,
  ).run(placeId, conceptId);
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

// ── ⑧ 라이브 일정 케이스 ────────────────────────────────────────────────────

describe("⑧ 라이브 일정 케이스 — H1 승격이 잎을 schedule 행으로 정리해 '일정' 한 노드", () => {
  test("schedule 잎(장터당번) 승격 후 글이 행에 직접·일정 개념 노드 0·schedule 묶음 한 노드(H1)", async () => {
    // 태그 "일정" + 장터당번 schedule 행(cpt_market 와 identity 1:1·일정의 위계 자식).
    // H1(전 타입 일반화·Q2-5) 이후: graph-augment 1.5c 가 schedule 잎(cpt_market)을
    //   schedule 행으로 승격하고, 그 행의 위계 사슬 분류('일정')로 가는 글→일정 직접 선을
    //   제거한다. 그래서 augment 단계에서 이미 cpt_iljeong·cpt_market 개념 노드가 빠지고
    //   글이 장터당번 schedule 행에 직접 매달린다 — 옛 ⑧ 흡수가 거대 허브로 정리하던 결과를
    //   H1 승격이 상류에서 더 직접적으로 달성한다("일정" 으로 보이는 노드는 schedule 묶음
    //   한 노드). ⑧ 흡수 엔진 자체 검증은 아래 "대표 우선순위" 순수 fixture 테스트가 담당한다.
    insertConcept("cpt_iljeong", "일정");
    insertConcept("cpt_market", "장터당번", { isClassificationValue: true });
    insertScheduleLinkedToConcept("sch_market", "장터당번", "cpt_market");
    addParentOfToEntityRow("cpt_iljeong", "schedule", "sch_market");

    const nodeId = insertNode("장터당번 일정 글");
    const memKey = `node:${nodeId}`;
    linkNodeConcept(nodeId, "cpt_iljeong", "mention");
    linkNodeConcept(nodeId, "cpt_market", "classification");

    const nodeById = seedNodeMap(nodeId, "장터당번 일정 글");
    const edgeSet = new Map<string, GraphEdge>();

    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    buildGroupNodes(nodeById, edgeSet, refs);
    absorbSameLabelNodes(nodeById, edgeSet);

    // (H1) 장터당번 schedule 행 노드가 남고, 글이 그 행에 직접 매달린다(mentions_entity 승격).
    expect(nodeById.has("entity:schedule:sch_market")).toBe(true);
    expect(nodeById.get("entity:schedule:sch_market")!.sourceType).toBe("schedule");
    const promoted = [...edgeSet.values()].some(
      (e) =>
        e.type === MENTION_ENTITY_EDGE_TYPE
        && e.from === "entity:schedule:sch_market"
        && e.to === memKey,
    );
    expect(promoted).toBe(true);

    // (H1) 일정·장터당번 개념 노드는 사라졌다(잎 승격·사슬 분류 직접 선 제거).
    expect(nodeById.has("concept:cpt_iljeong")).toBe(false);
    expect(nodeById.has("concept:cpt_market")).toBe(false);
    // "일정" 으로 보이는 노드는 schedule 묶음(entity_group) 한 노드뿐(거대 허브 시각 유지).
    expect(nodeById.has("group:schedule")).toBe(true);
    const grp = nodeById.get("group:schedule")!;
    expect(grp.sourceType).toBe("entity_group");
    expect(grp.groupType).toBe("schedule");

    // 글→일정 사슬 분류 직접 선(개념·허브 어느 키로도) 0.
    expect([...edgeSet.values()].some(
      (e) => e.from === memKey && e.to === "concept:cpt_iljeong",
    )).toBe(false);
    expect([...edgeSet.values()].some(
      (e) => e.from === memKey && e.to === "group:schedule" && e.type === "mention",
    )).toBe(false);
    // 태그 개념 키를 끝점으로 가진 엣지는 0(개념 노드 제거 일관).
    expect([...edgeSet.values()].some(
      (e) => e.from === "concept:cpt_iljeong" || e.to === "concept:cpt_iljeong",
    )).toBe(false);
  });
});

// ── ⑧ 대표 우선순위 ────────────────────────────────────────────────────────

describe("⑧ 대표 우선순위 — 엔티티 > entity_group > classification_key > concept", () => {
  test("엔티티 행이 대표로 동명 개념을 빨아들인다(P3-display 후에도 *대표* 흡수는 유지)", () => {
    // 같은 label "한별" 네 종류 노드(섞임). 엔티티 행은 비대표로 빨려가진 않지만(P3-display)
    //   *대표* 로 남아 동명 개념(같은 정체성 그림자)을 빨아들이는 것은 그대로다 — c1·c2 흡수.
    const nodeById = new Map<string, GraphNode>([
      ["concept:c1", { id: "concept:c1", sourceType: "concept", label: "한별" }], // 태그/멘션 rank 1
      ["concept:c2", { id: "concept:c2", sourceType: "classification_key", label: "한별" }], // rank 2
      ["group:place", { id: "group:place", sourceType: "entity_group", groupType: "place", label: "한별" }], // rank 3(koName "장소" 라 별도 그룹)
      ["entity:place:e1", { id: "entity:place:e1", sourceType: "place", label: "한별" }], // rank 4 대표
      ["node:1", { id: "node:1", sourceId: 1, sourceType: "text", label: "글" }],
    ]);
    const edgeSet = new Map<string, GraphEdge>([
      ["edge:node:1->concept:c1:tag", { id: "edge:node:1->concept:c1:tag", from: "node:1", to: "concept:c1", type: "tag", weight: 0.6 }],
      ["edge:node:1->concept:c2:classification", { id: "edge:node:1->concept:c2:classification", from: "node:1", to: "concept:c2", type: "classification", weight: 0.6 }],
      ["edge:node:1->group:place:mention", { id: "edge:node:1->group:place:mention", from: "node:1", to: "group:place", type: "mention", weight: 0.6 }],
    ]);

    // group:place 의 그룹핑 키는 koName "장소" 라 label "한별" 그룹과 안 묶인다.
    //   "한별" 그룹은 {c1·c2·entity:place:e1} 셋 — entity 행이 대표(rank 4)라 c1·c2 를 빨아들인다.
    absorbSameLabelNodes(nodeById, edgeSet);

    // entity:place:e1 이 대표 — c1·c2 흡수, 엔티티 노드 생존.
    expect(nodeById.has("entity:place:e1")).toBe(true);
    expect(nodeById.has("concept:c1")).toBe(false);
    expect(nodeById.has("concept:c2")).toBe(false);
    // 글-선이 엔티티 대표로 재지정.
    expect([...edgeSet.values()].some((e) => e.from === "node:1" && e.to === "entity:place:e1" && e.type === "tag")).toBe(true);
    expect([...edgeSet.values()].some((e) => e.from === "node:1" && e.to === "entity:place:e1" && e.type === "classification")).toBe(true);
  });

  test("entity_group 이 classification_key·태그 개념을 제치고 대표(같은 koName 그룹)", () => {
    // schedule koName "일정" 으로 묶이는 그룹: entity_group(group:schedule) + 태그 "일정".
    const nodeById = new Map<string, GraphNode>([
      ["concept:c1", { id: "concept:c1", sourceType: "concept", label: "일정" }], // rank 1
      ["group:schedule", { id: "group:schedule", sourceType: "entity_group", groupType: "schedule", label: "일정 (전체)" }], // rank 3 대표
      ["node:1", { id: "node:1", sourceId: 1, sourceType: "text", label: "글" }],
    ]);
    const edgeSet = new Map<string, GraphEdge>([
      ["edge:node:1->concept:c1:mention", { id: "edge:node:1->concept:c1:mention", from: "node:1", to: "concept:c1", type: "mention", weight: 0.6 }],
    ]);

    absorbSameLabelNodes(nodeById, edgeSet);

    // group:schedule 이 대표 — 태그 "일정" 흡수.
    expect(nodeById.has("group:schedule")).toBe(true);
    expect(nodeById.has("concept:c1")).toBe(false);
    expect([...edgeSet.values()].some((e) => e.from === "node:1" && e.to === "group:schedule" && e.type === "mention")).toBe(true);
  });

  test("같은 등급 둘은 id 사전순 첫째가 대표(결정적)", () => {
    // 같은 label·같은 rank(둘 다 concept) — id 사전순 첫째 대표.
    const nodeById = new Map<string, GraphNode>([
      ["concept:zzz", { id: "concept:zzz", sourceType: "concept", label: "취미" }],
      ["concept:aaa", { id: "concept:aaa", sourceType: "concept", label: "취미" }],
    ]);
    const edgeSet = new Map<string, GraphEdge>();
    absorbSameLabelNodes(nodeById, edgeSet);
    // concept:aaa 가 사전순 첫째 → 대표 생존, concept:zzz 흡수.
    expect(nodeById.has("concept:aaa")).toBe(true);
    expect(nodeById.has("concept:zzz")).toBe(false);
  });
});

// ── ⑧ 회귀 0 / 과흡수 하한 ──────────────────────────────────────────────────

describe("⑧ 회귀 0 + 과흡수 하한", () => {
  test("장소(④⑥으로 이미 한 노드)는 ⑧ 이 추가로 안 바꾼다(no-op)", async () => {
    // 콜론 위계 장소 → ④⑥(buildGroupNodes 묶음)으로 "장소" 한 노드(entity_group)·무지개의원
    //   엔티티 한 노드. 위계 잎은 place 행 직접(위계 단일 출처·그림자 잎 0).
    insertConcept("cpt_place_root", "장소", { isClassificationKey: true });
    insertConcept("cpt_dermat", "피부과", { isClassificationKey: true, isClassificationValue: true });
    insertConcept("cpt_rainbow", "무지개의원", { isClassificationValue: true });
    addParentOf("cpt_place_root", "cpt_dermat");
    insertPlaceLinkedToConcept("plc_rainbow", "무지개의원", "cpt_rainbow");
    addParentOfToEntityRow("cpt_dermat", "place", "plc_rainbow");

    const nodeId = insertNode("무지개의원 진료");
    linkNodeConcept(nodeId, "cpt_place_root", "classification");
    linkNodeConcept(nodeId, "cpt_dermat", "classification");

    const nodeById = seedNodeMap(nodeId, "무지개의원 진료");
    const edgeSet = new Map<string, GraphEdge>();

    const refs = await augmentWithEntities(store, nodeById, edgeSet);
    buildGroupNodes(nodeById, edgeSet, refs);

    // ⑧ 직전 상태 스냅샷.
    const nodesBefore = [...nodeById.keys()].sort();
    const edgesBefore = [...edgeSet.keys()].sort();

    absorbSameLabelNodes(nodeById, edgeSet);

    // ⑧ 전후 노드/엣지 집합 동일(추가로 안 합침 — "장소" label 노드 1개뿐).
    expect([...nodeById.keys()].sort()).toEqual(nodesBefore);
    expect([...edgeSet.keys()].sort()).toEqual(edgesBefore);
  });

  test("같은 이름 2개 미만(단일 노드)은 안 건드린다(과흡수 하한)", () => {
    const nodeById = new Map<string, GraphNode>([
      ["concept:c1", { id: "concept:c1", sourceType: "concept", label: "유일" }],
      ["concept:c2", { id: "concept:c2", sourceType: "concept", label: "다른이름" }],
    ]);
    const edgeSet = new Map<string, GraphEdge>();
    absorbSameLabelNodes(nodeById, edgeSet);
    // 같은 label 2개+ 없음 → no-op.
    expect(nodeById.has("concept:c1")).toBe(true);
    expect(nodeById.has("concept:c2")).toBe(true);
  });

  test("이름 다른 엔티티 행·개념은 ⑧ 이 안 섞는다(흡수 폐기 후 과합치기 0)", () => {
    // 위계 단일 출처(S2-T3·흡수 폐기) 정합 — 옛 라벨 일치 흡수(collectPersonNameConcept
    //   Absorptions)는 "이름이 같다=같은 것" 전제로 무관 장소를 사람 행에 빨아들였다(회귀
    //   원인). ⑧ 은 *완전 동명* 만 합쳐, 이름이 다르면(사람 "인영희"·장소 "무지개의원") 어떤
    //   섞임도 없다. 그림자 잎 개념이 사라져 동명 충돌 자체가 줄었음을 직접 구조로 단언한다.
    const nodeById = new Map<string, GraphNode>([
      ["person:psn_inyoung", { id: "person:psn_inyoung", sourceType: "person", label: "인영희" }],
      ["entity:place:plc_rainbow", { id: "entity:place:plc_rainbow", sourceType: "place", label: "무지개의원" }],
      ["concept:cpt_family", { id: "concept:cpt_family", sourceType: "classification_key", label: "가족" }],
      ["node:1", { id: "node:1", sourceId: 1, sourceType: "text", label: "글" }],
    ]);
    const edgeSet = new Map<string, GraphEdge>([
      ["edge:concept:cpt_family->person:psn_inyoung:parent_of", {
        id: "edge:concept:cpt_family->person:psn_inyoung:parent_of",
        from: "concept:cpt_family", to: "person:psn_inyoung", type: "parent_of", weight: 0.9,
      }],
    ]);
    const nodesBefore = [...nodeById.keys()].sort();
    const edgesBefore = [...edgeSet.keys()].sort();

    absorbSameLabelNodes(nodeById, edgeSet);

    // 이름이 다 다르므로 ⑧ 이 단 한 노드도 안 합친다(과합치기 0·라벨 일치 섞임 0).
    expect([...nodeById.keys()].sort()).toEqual(nodesBefore);
    expect([...edgeSet.keys()].sort()).toEqual(edgesBefore);
    // 사람 행·장소 행 둘 다 별개 노드로 생존(옛 라벨 흡수면 한쪽이 빨려갔을 자리).
    expect(nodeById.has("person:psn_inyoung")).toBe(true);
    expect(nodeById.has("entity:place:plc_rainbow")).toBe(true);
  });

  test("person: 행이 entity: 대표로 우연 동명 합쳐진다(D4 잔여·person 일반화 Deferred)", () => {
    // P3-display 잔여(§6 D4) — entity: 가 *대표* 이고 person: 가 비대표면, person 은 보호
    //   대상이 아니라(entity: 한정) 기존처럼 대표로 합쳐진다. 둘 다 rank 4 동급이라 id 사전순
    //   첫째 entity:place:plc_hanbyeol 이 대표 → person 흡수. person/project 일반화는 Q3-3 Deferred.
    const nodeById = new Map<string, GraphNode>([
      ["entity:place:plc_hanbyeol", { id: "entity:place:plc_hanbyeol", sourceType: "place", label: "한별" }],
      ["person:psn_hanbyeol", { id: "person:psn_hanbyeol", sourceType: "person", label: "한별" }],
    ]);
    const edgeSet = new Map<string, GraphEdge>();
    absorbSameLabelNodes(nodeById, edgeSet);
    // entity:place:plc_hanbyeol 이 대표(흡수에서 빠지는 건 비대표 entity: 뿐) → person 흡수.
    expect(nodeById.has("entity:place:plc_hanbyeol")).toBe(true);
    expect(nodeById.has("person:psn_hanbyeol")).toBe(false);
    expect(nodeById.size).toBe(1); // 표시상 한 노드(D4 잔여·표시 전용).
  });
});

// ── P3-display(증상①) — 동명 다른 entity 행은 흡수 안 함 ─────────────────────

describe("P3-display(증상①) — 동명 다른 entity 정체성 노드 흡수 제외", () => {
  test("동명 다른 entity work 노드 둘은 흡수 안 함(P3 별개 작품 보존)", () => {
    // 라이브 결함 재현 — 같은 label "괴담" 다른 work 행 두 노드(다른 매체·다른 작가로
    //   P3 가 가른 별개 작품). 옛 ⑧ 은 label "괴담" 만 보고 한 노드로 합쳐, 사라진 쪽
    //   클릭 시 view-model 못 찾는 유령이 됐다. P3-display 후 둘 다 독립 노드로 남는다.
    const nodeById = new Map<string, GraphNode>([
      ["entity:work:wrk_a", { id: "entity:work:wrk_a", sourceType: "work", label: "괴담" }],
      ["entity:work:wrk_b", { id: "entity:work:wrk_b", sourceType: "work", label: "괴담" }],
    ]);
    const edgeSet = new Map<string, GraphEdge>();
    absorbSameLabelNodes(nodeById, edgeSet);
    // 두 work 노드가 둘 다 결과에 남아야(흡수 0).
    expect([...nodeById.values()].filter((n) => n.label === "괴담").length).toBe(2);
    expect(nodeById.has("entity:work:wrk_a")).toBe(true);
    expect(nodeById.has("entity:work:wrk_b")).toBe(true);
  });

  test("entity: 행에 매달린 글-선은 흡수로 재지정되지 않는다(엣지 보존)", () => {
    // 두 동명 work 행이 각자 다른 글에 닿을 때, 흡수가 일어나지 않으므로 글-선이 한쪽
    //   대표로 쏠리지 않고 각자 보존된다(증상① 유령 엣지 0).
    const nodeById = new Map<string, GraphNode>([
      ["entity:work:wrk_a", { id: "entity:work:wrk_a", sourceType: "work", label: "괴담" }],
      ["entity:work:wrk_b", { id: "entity:work:wrk_b", sourceType: "work", label: "괴담" }],
      ["node:1", { id: "node:1", sourceId: 1, sourceType: "text", label: "글A" }],
      ["node:2", { id: "node:2", sourceId: 2, sourceType: "text", label: "글B" }],
    ]);
    const edgeSet = new Map<string, GraphEdge>([
      ["edge:node:1->entity:work:wrk_a:mention", { id: "edge:node:1->entity:work:wrk_a:mention", from: "node:1", to: "entity:work:wrk_a", type: "mention", weight: 0.6 }],
      ["edge:node:2->entity:work:wrk_b:mention", { id: "edge:node:2->entity:work:wrk_b:mention", from: "node:2", to: "entity:work:wrk_b", type: "mention", weight: 0.6 }],
    ]);
    const edgesBefore = [...edgeSet.keys()].sort();

    absorbSameLabelNodes(nodeById, edgeSet);

    // 흡수 0 → 엣지 집합 동일(각 글이 자기 work 에 그대로 닿는다).
    expect([...edgeSet.keys()].sort()).toEqual(edgesBefore);
    expect([...edgeSet.values()].some((e) => e.from === "node:1" && e.to === "entity:work:wrk_a")).toBe(true);
    expect([...edgeSet.values()].some((e) => e.from === "node:2" && e.to === "entity:work:wrk_b")).toBe(true);
  });

  test("동명 개념 노드는 흡수 유지(회귀 0 — 같은 개념 합치기 원래 목적)", () => {
    // entity: 제외가 개념 동명 흡수를 깨면 안 된다. 같은 label "취미" 두 concept 노드는
    //   기존대로 한 노드로 합쳐진다(graph-untangle ⑧ 원래 목적·id 사전순 대표).
    const nodeById = new Map<string, GraphNode>([
      ["concept:zzz", { id: "concept:zzz", sourceType: "concept", label: "취미" }],
      ["concept:aaa", { id: "concept:aaa", sourceType: "concept", label: "취미" }],
    ]);
    const edgeSet = new Map<string, GraphEdge>();
    absorbSameLabelNodes(nodeById, edgeSet);
    // concept:aaa(사전순 첫째) 대표 생존, concept:zzz 흡수(기존 동작 유지).
    expect(nodeById.has("concept:aaa")).toBe(true);
    expect(nodeById.has("concept:zzz")).toBe(false);
  });
});

// ── 글 노드(node:) 보호 — 우측 검색 클릭 모달 결함 근본 ──────────────────────

describe("글 노드(node:) 보호 — 검색 hit ↔ subgraph 정합", () => {
  test("동명 개념/묶음과 같은 이름인 글 노드는 흡수 안 됨(글이 독립 생존)", () => {
    // 라이브 결함 재현 — label "일정" 글(node:1) + label/koName "일정" 묶음(entity_group).
    //   옛 ⑧ 은 글을 묶음에 빨아들여 흡수 후 subgraph 에서 node:1 이 사라졌고, 우측 검색
    //   결과(흡수 전 node:1 hit)를 클릭하면 buildNodeDetailEl 이 그 글 노드를 못 찾아 모달이
    //   안 떴다. 글 보호 후 node:1 은 흡수와 무관하게 그대로 살아남는다.
    const nodeById = new Map<string, GraphNode>([
      ["node:1", { id: "node:1", sourceId: 1, sourceType: "text", label: "일정", snippet: "장터당번 일정 글" }],
      ["group:schedule", { id: "group:schedule", sourceType: "entity_group", groupType: "schedule", label: "일정 (전체)" }],
    ]);
    const edgeSet = new Map<string, GraphEdge>();
    const hadNodeBefore = nodeById.has("node:1");

    absorbSameLabelNodes(nodeById, edgeSet);

    // 흡수 전후 글 노드 생존 — node:1 이 묶음에 빨려가지 않는다.
    expect(hadNodeBefore).toBe(true);
    expect(nodeById.has("node:1")).toBe(true);
    expect(nodeById.get("node:1")!.snippet).toBe("장터당번 일정 글"); // 실제 글 content 보존.
    // 묶음 노드는 자기대로 남는다(글을 안 빨아들였다·단일 그룹 무변경).
    expect(nodeById.has("group:schedule")).toBe(true);
  });

  test("동명 글 둘은 둘 다 생존(글끼리도 합치기 안 함)", () => {
    // 같은 label "회의" 두 글(node:1·node:2) — 글은 합치기 대상이 아니라 둘 다 독립 생존.
    const nodeById = new Map<string, GraphNode>([
      ["node:1", { id: "node:1", sourceId: 1, sourceType: "text", label: "회의", snippet: "회의 글 A" }],
      ["node:2", { id: "node:2", sourceId: 2, sourceType: "text", label: "회의", snippet: "회의 글 B" }],
    ]);
    const edgeSet = new Map<string, GraphEdge>();

    absorbSameLabelNodes(nodeById, edgeSet);

    // 두 글 노드가 둘 다 남는다(흡수 0).
    expect([...nodeById.values()].filter((n) => n.label === "회의").length).toBe(2);
    expect(nodeById.has("node:1")).toBe(true);
    expect(nodeById.has("node:2")).toBe(true);
  });

  test("회귀 가드 — 개념·묶음끼리 동명은 그대로 합쳐진다(글 보호가 깨면 안 됨)", () => {
    // 글 제외가 개념·묶음 동명 흡수를 깨면 안 된다. label "일정" concept + classification_key
    //   + schedule 묶음(koName "일정") — 글 없이 셋이 같은 그룹이라 비대표가 대표(entity_group)로
    //   흡수돼 사라진다(기존 동작 유지·회귀 0).
    const nodeById = new Map<string, GraphNode>([
      ["concept:c1", { id: "concept:c1", sourceType: "concept", label: "일정" }], // rank 1
      ["concept:c2", { id: "concept:c2", sourceType: "classification_key", label: "일정" }], // rank 2
      ["group:schedule", { id: "group:schedule", sourceType: "entity_group", groupType: "schedule", label: "일정 (전체)" }], // rank 3 대표
    ]);
    const edgeSet = new Map<string, GraphEdge>();

    absorbSameLabelNodes(nodeById, edgeSet);

    // group:schedule(rank 3) 대표 생존, concept 둘 흡수(기존 합치기 유지).
    expect(nodeById.has("group:schedule")).toBe(true);
    expect(nodeById.has("concept:c1")).toBe(false);
    expect(nodeById.has("concept:c2")).toBe(false);
  });
});
