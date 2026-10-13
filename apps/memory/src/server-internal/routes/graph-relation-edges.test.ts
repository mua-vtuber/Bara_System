/**
 * graph-relation-edges.test.ts — augmentWithEntities entity_relation_edges 관계선 합류 검증.
 *
 * Phase 8 재매핑 Task 4.
 *
 * 실제 bun:sqlite(:memory:) + 실제 SqliteMemoryStore 통합 테스트 — Mock 클래스 0.
 * graph-entity-augment.test.ts 의 셋업 패턴을 재사용한다.
 *
 * 검증 항목:
 *   1. 두 work 가 같은 person 을 created_by 로 가리키고 셋 다 집합 안이면
 *      created_by 관계선 2개가 edgeSet 에 추가된다.
 *   2. 관계선 type 은 관계명 그대로("created_by" 등).
 *   3. 양끝 중 하나가 노드 집합 밖이면 그 관계선을 추가하지 않는다(불변식).
 *   4. 관계 엣지 수가 RELATION_EDGES_LIMIT(80) 상한 안에 머문다.
 *   5. 기존 엔티티 노드 합류 회귀 0(관계선 추가 후에도 entityRefs 정상 반환).
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
import type { Database } from "bun:sqlite";
import { loadEmbedder, makeGraphTestDeps } from "./graph.test-helpers.ts";
import type { GraphTestContext } from "./graph.test-helpers.ts";
import type { SqliteMemoryStore } from "../../db/store.ts";
import { augmentWithEntities } from "./graph.ts";
import type { GraphNode, GraphEdge } from "./graph.ts";

beforeAll(async () => {
  await loadEmbedder();
});

afterAll(() => {});

let ctx: GraphTestContext;
let store: SqliteMemoryStore;
let db: Database;

beforeEach(async () => {
  ctx = await makeGraphTestDeps();
  store = ctx.store;
  db = ctx.db;
});

afterEach(() => {
  ctx.close();
});

// ── 데이터 삽입 헬퍼 ──────────────────────────────────────────────────────────

function insertConcept(conceptId: string, name: string): void {
  db.prepare(
    "INSERT INTO concept_nodes (concept_id, name) VALUES (?, ?)",
  ).run(conceptId, name);
}

function insertNode(content: string): number {
  const r = db
    .prepare("INSERT INTO knowledge_nodes (content) VALUES (?)")
    .run(content);
  return Number(r.lastInsertRowid);
}

function linkNodeConcept(nodeId: number, conceptId: string): void {
  db.prepare(
    "INSERT INTO node_concept_edges (node_id, concept_id, role, provenance, source_node_id) VALUES (?, ?, 'tag', 'user_input', NULL)",
  ).run(nodeId, conceptId);
}

/**
 * work 행 + identity 개념(검색 JOIN 키) + 위계 잎 엣지 + 글 한 세트를 심는다.
 * 글 nodeId 를 반환한다.
 *
 * 위계 단일 출처(S2-T1·S2-T3) — work 행이 그래프 노드로 합류하려면 hierarchy_edges
 * 위계 잎이어야 한다(옛 identity 역조회 흡수 폐기). conceptId(글이 언급하는 그 개념)를
 * 위계 부모로 두고 conceptId → work 행 parent_of 를 직접 써, 글이 그 개념을 언급해
 * 집합 안일 때 work 행이 위계 잎으로 합류하게 한다.
 */
function seedWork(workId: string, name: string, conceptId: string): number {
  db.prepare(
    "INSERT INTO entities (entity_id, type_name, name, created_at, updated_at) VALUES (?, 'work', ?, '2026-01-01', '2026-01-01')",
  ).run(workId, name);
  insertConcept(conceptId, name);
  db.prepare(
    "INSERT INTO entity_concept_edges (entity_id, concept_id, role, created_at, provenance, source_node_id) VALUES (?, ?, 'identity', '2026-01-01', 'user_input', NULL)",
  ).run(workId, conceptId);
  // 위계 잎 — conceptId(부모) → work 행 직접(그림자 잎 0).
  db.prepare(
    `INSERT INTO hierarchy_edges (source_type, source_id, target_type, target_id, relation, weight, provenance, source_node_id) VALUES ('concept', ?, 'work', ?, 'parent_of', 0.9, 'user_input', NULL)`,
  ).run(conceptId, workId);
  const nodeId = insertNode(`${name} 메모`);
  linkNodeConcept(nodeId, conceptId);
  return nodeId;
}

/** persons 행을 심는다(node_person_edges 는 불필요 — 관계선 검증에서 personKey 만 씀). */
function seedPerson(personId: string, displayName: string): void {
  db.prepare(
    "INSERT INTO persons (person_id, display_name, created_at, updated_at) VALUES (?, ?, '2026-01-01', '2026-01-01')",
  ).run(personId, displayName);
}

/** entity_relation_edges 에 관계를 직접 심는다. */
function insertRelationEdge(
  sourceType: string,
  sourceId: string,
  targetType: string,
  targetId: string,
  relation: string,
): void {
  db.prepare(
    `INSERT INTO entity_relation_edges (source_type, source_id, target_type, target_id, relation, created_at, provenance, source_node_id) VALUES (?, ?, ?, ?, ?, ?, 'user_input', NULL)`,
  ).run(sourceType, sourceId, targetType, targetId, relation, Date.now());
}

/**
 * nodeById 에 여러 노드를 한 번에 심는다.
 * entries 각각은 { key, sourceId?, sourceType, label } 형태.
 */
function buildNodeMap(
  entries: {
    key: string;
    sourceId?: number;
    sourceType: string;
    label: string;
    snippet?: string;
  }[],
): Map<string, GraphNode> {
  const m = new Map<string, GraphNode>();
  for (const e of entries) {
    m.set(e.key, {
      id: e.key,
      sourceId: e.sourceId,
      sourceType: e.sourceType,
      label: e.label,
      snippet: e.snippet,
    });
  }
  return m;
}

// ── 검증 ─────────────────────────────────────────────────────────────────────

describe("augmentWithEntities — entity_relation_edges 관계선 합류", () => {
  test("두 work 가 같은 person 에 created_by 로 이어지고 셋 다 집합 안이면 관계선 2개가 추가된다", async () => {
    // 데이터: work A, work B, person P, created_by 관계 2개
    const nodeIdA = seedWork("wrk_demotjuk", "데못죽", "cpt_demotjuk");
    const nodeIdB = seedWork("wrk_jujutsu", "주술회전", "cpt_jujutsu");
    seedPerson("psn_akutami", "아쿠타미");
    insertRelationEdge("work", "wrk_demotjuk", "person", "psn_akutami", "created_by");
    insertRelationEdge("work", "wrk_jujutsu", "person", "psn_akutami", "created_by");

    // 세 노드를 nodeById 에 미리 넣는다(identity 개념 경유로 work 노드가 합류되므로
    // augmentWithEntities 호출 후에는 자동 합류된다 — 그래서 아래는 글 노드만 seed 하고
    // work 노드는 augment 가 채우게 한다. person 노드는 수동으로 넣는다).
    const nodeById = buildNodeMap([
      { key: `node:${nodeIdA}`, sourceId: nodeIdA, sourceType: "text", label: "데못죽 메모" },
      { key: `node:${nodeIdB}`, sourceId: nodeIdB, sourceType: "text", label: "주술회전 메모" },
      // person 노드는 augmentWithEntities 가 node_person_edges 경유로 추가하지 않을 수
      // 있으므로(글에 node_person_edges 가 없어) 미리 넣어 둔다.
      { key: "person:psn_akutami", sourceType: "person", label: "아쿠타미" },
    ]);
    const edgeSet = new Map<string, GraphEdge>();

    const { entityRefs } = await augmentWithEntities(store, nodeById, edgeSet);

    // work 노드 2개가 합류됐어야 한다(identity 개념 경유).
    expect(nodeById.has("entity:work:wrk_demotjuk")).toBe(true);
    expect(nodeById.has("entity:work:wrk_jujutsu")).toBe(true);

    // created_by 관계선 2개가 추가됐어야 한다.
    const relationEdges = [...edgeSet.values()].filter(
      (e) => e.type === "created_by",
    );
    expect(relationEdges.length).toBe(2);
    expect(relationEdges.every((e) => e.meta?.edgeKind === "entity_relation")).toBe(true);
    expect(relationEdges.every((e) => e.meta?.source === "entity_relation_edges")).toBe(true);

    // entityRefs 에 work 두 개가 들어 있어야 한다(Task 4 인계 정상).
    expect(entityRefs.some((r) => r.type === "work" && r.id === "wrk_demotjuk")).toBe(true);
    expect(entityRefs.some((r) => r.type === "work" && r.id === "wrk_jujutsu")).toBe(true);
  });

  test("관계선 type 은 관계명 그대로다('created_by'·'located_at' 등)", async () => {
    const nid = seedWork("wrk_testwork", "테스트작품", "cpt_testwork");
    seedPerson("psn_testauthor", "테스트작가");
    insertRelationEdge("work", "wrk_testwork", "person", "psn_testauthor", "created_by");

    const nodeById = buildNodeMap([
      { key: `node:${nid}`, sourceId: nid, sourceType: "text", label: "테스트작품 메모" },
      { key: "person:psn_testauthor", sourceType: "person", label: "테스트작가" },
    ]);
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    const relEdge = [...edgeSet.values()].find((e) => e.type === "created_by");
    expect(relEdge).toBeDefined();
    expect(relEdge!.type).toBe("created_by");
    expect(relEdge!.meta).toMatchObject({
      edgeKind: "entity_relation",
      source: "entity_relation_edges",
    });
  });

  test("새 관계명도 entity_relation_edges 출처 메타를 싣는다", async () => {
    const nid = seedWork("wrk_directed", "감독작품", "cpt_directed");
    seedPerson("psn_director", "테스트감독");
    insertRelationEdge("work", "wrk_directed", "person", "psn_director", "directed_by");

    const nodeById = buildNodeMap([
      { key: `node:${nid}`, sourceId: nid, sourceType: "text", label: "감독작품 메모" },
      { key: "person:psn_director", sourceType: "person", label: "테스트감독" },
    ]);
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    const relEdge = [...edgeSet.values()].find((e) => e.type === "directed_by");
    expect(relEdge).toBeDefined();
    expect(relEdge!.meta).toMatchObject({
      edgeKind: "entity_relation",
      source: "entity_relation_edges",
    });
  });

  test("양끝 중 하나가 집합 밖이면 그 관계선을 추가하지 않는다(불변식)", async () => {
    const nodeIdA = seedWork("wrk_solo", "솔로작품", "cpt_solo");
    seedPerson("psn_ghost", "고스트작가");
    // work → person 관계는 있지만 person 노드를 nodeById 에 넣지 않는다.
    insertRelationEdge("work", "wrk_solo", "person", "psn_ghost", "created_by");

    const nodeById = buildNodeMap([
      { key: `node:${nodeIdA}`, sourceId: nodeIdA, sourceType: "text", label: "솔로작품 메모" },
      // person:psn_ghost 는 집합 밖 — 의도적으로 넣지 않는다.
    ]);
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    const relationEdges = [...edgeSet.values()].filter(
      (e) => e.type === "created_by",
    );
    // person 노드가 집합 밖이므로 관계선 0개여야 한다.
    expect(relationEdges.length).toBe(0);
  });

  test("work 가 집합 밖이고 person 이 집합 안이어도 관계선을 추가하지 않는다(불변식·반대 방향)", async () => {
    // work 행은 심지만 nodeById 에는 넣지 않는다.
    db.prepare(
      "INSERT INTO entities (entity_id, type_name, name, created_at, updated_at) VALUES (?, 'work', ?, '2026-01-01', '2026-01-01')",
    ).run("wrk_hidden", "숨겨진작품");
    seedPerson("psn_visible", "보이는작가");
    insertRelationEdge("work", "wrk_hidden", "person", "psn_visible", "created_by");

    // person 만 집합 안 — work 없음.
    const nodeById = buildNodeMap([
      { key: "person:psn_visible", sourceType: "person", label: "보이는작가" },
    ]);
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    const relationEdges = [...edgeSet.values()].filter(
      (e) => e.type === "created_by",
    );
    expect(relationEdges.length).toBe(0);
  });

  test("관계 엣지 수가 RELATION_EDGES_LIMIT(80) 상한 안에 머문다", async () => {
    // work 90개 + person 1개 + created_by 90개 → 상한 80개로 잘림.
    seedPerson("psn_prolific", "다작작가");
    const nodeEntries: Parameters<typeof buildNodeMap>[0] = [
      { key: "person:psn_prolific", sourceType: "person", label: "다작작가" },
    ];

    for (let i = 0; i < 90; i++) {
      const wid = `wrk_lot${i}`;
      const cid = `cpt_lot${i}`;
      db.prepare(
        "INSERT INTO entities (entity_id, type_name, name, created_at, updated_at) VALUES (?, 'work', ?, '2026-01-01', '2026-01-01')",
      ).run(wid, `작품${i}`);
      insertConcept(cid, `작품${i}`);
      db.prepare(
        "INSERT INTO entity_concept_edges (entity_id, concept_id, role, created_at, provenance, source_node_id) VALUES (?, ?, 'identity', '2026-01-01', 'user_input', NULL)",
      ).run(wid, cid);
      const nid = insertNode(`작품${i} 메모`);
      linkNodeConcept(nid, cid);
      insertRelationEdge("work", wid, "person", "psn_prolific", "created_by");
      nodeEntries.push({ key: `node:${nid}`, sourceId: nid, sourceType: "text", label: `작품${i} 메모` });
    }

    const nodeById = buildNodeMap(nodeEntries);
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    const relationEdges = [...edgeSet.values()].filter(
      (e) => e.type === "created_by",
    );
    expect(relationEdges.length).toBeLessThanOrEqual(80);
  });
});

describe("augmentWithEntities — 관계선 추가 후 기존 합류 회귀 없음", () => {
  test("관계선 합류 후에도 entityRefs 와 개념 노드가 정상 반환된다", async () => {
    const nodeId = seedWork("wrk_regression", "회귀테스트작품", "cpt_regression");
    seedPerson("psn_reg", "회귀작가");
    insertRelationEdge("work", "wrk_regression", "person", "psn_reg", "created_by");

    const nodeById = buildNodeMap([
      { key: `node:${nodeId}`, sourceId: nodeId, sourceType: "text", label: "회귀테스트작품 메모" },
      { key: "person:psn_reg", sourceType: "person", label: "회귀작가" },
    ]);
    const edgeSet = new Map<string, GraphEdge>();

    const { entityRefs } = await augmentWithEntities(store, nodeById, edgeSet);

    // work 노드 합류 정상.
    expect(nodeById.has("entity:work:wrk_regression")).toBe(true);
    expect(entityRefs.some((r) => r.id === "wrk_regression")).toBe(true);

    // 위계 단일 출처(S2-T3) — 옛 ② 흡수가 사라져 identity 개념 노드는 글-tag 로 남을 수
    //   있으나, 위계 잎 자리는 work 행이 대신한다(그 개념을 끝점으로 가진 parent_of 0).
    const conceptAsHierChild = [...edgeSet.values()].some(
      (e) => e.to === "concept:cpt_regression" && e.type === "parent_of",
    );
    expect(conceptAsHierChild).toBe(false);

    // 관계선도 추가됨.
    const relEdges = [...edgeSet.values()].filter((e) => e.type === "created_by");
    expect(relEdges.length).toBe(1);
  });
});
