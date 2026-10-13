/**
 * graph-project-augment.test.ts — augmentWithEntities 프로젝트 노드 합류 검증.
 *
 * Phase 8 재매핑 Task 9.
 *
 * 실제 bun:sqlite(:memory:) + 실제 SqliteMemoryStore 통합 테스트 — Mock 클래스 0.
 * 데이터 경로: 프로젝트 행 + classification/tag 개념 엣지 + 그 개념을 가진 글
 * (node_concept_edges). graph-entity-augment.test.ts 의 셋업 패턴을 재사용한다.
 *
 * 검증 항목:
 *   1. classification role 개념을 가진 프로젝트가 augmentWithEntities 로 합류된다.
 *   2. tag role 개념을 가진 프로젝트도 합류된다.
 *   3. 프로젝트 노드 id 는 project:<projectId> 형식이다.
 *   4. 프로젝트 ↔ 개념 연결선이 edgeSet 에 추가된다.
 *   5. 개념 노드가 집합 밖이면 프로젝트는 합류되지 않는다(양끝 집합 안 불변식).
 *   6. PROJECTS_PER_NODE 상한이 과밀을 막는다.
 *   7. store 헬퍼 getProjectsByConceptId — role 필터 없이·role 지정 둘 다 동작한다.
 *   8. 프로젝트 0건이면 빈 상태(정직한 빈 상태·가짜 노드 없음).
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
import {
  augmentWithEntities,
  PROJECTS_PER_NODE,
  PROJECT_MEMBER_NODES_LIMIT,
  OWNS_MEMORY_EDGE_TYPE,
  PROJECT_OWNS_WEIGHT,
} from "./graph.ts";
import type { GraphNode, GraphEdge } from "./graph.ts";
import { KO_ALIASES_ATTR_KEY } from "../../db/store-internal/entities-repository.ts";

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
 * 프로젝트 본체 행을 직접 삽입한다 — 단계4 T7'b 통합으로 본체가 entities
 * (type_name='project')에 산다(옛 projects 테이블 아님). findOrCreateProject 는
 * 임베딩 로드를 요구해 테스트 셋업에서 직접 SQL 을 쓴다.
 */
function insertProject(projectId: string, name: string): void {
  db.prepare(
    `INSERT INTO entities (entity_id, type_name, name, created_at, updated_at)
     VALUES (?, 'project', ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
  ).run(projectId, name);
}

function insertProjectAttr(
  projectId: string,
  key: string,
  value: string,
  isColumn: boolean,
): void {
  db.prepare(
    `INSERT INTO entity_attributes
       (entity_id, attr_key, attr_value, is_column)
     VALUES (?, ?, ?, ?)`,
  ).run(projectId, key, value, isColumn ? 1 : 0);
}

function linkProjectConcept(
  projectId: string,
  conceptId: string,
  role: string,
): void {
  // 라벨 엣지도 단계4 T7'b 통합 테이블 entity_concept_edges 에 산다(옛
  // project_concept_edges 아님). entity_id 끝점 = 프로젝트 본체 entity_id.
  db.prepare(
    `INSERT INTO entity_concept_edges (entity_id, concept_id, role, created_at, provenance, source_node_id) VALUES (?, ?, ?, '2026-01-01 00:00:00', 'user_input', NULL)`,
  ).run(projectId, conceptId, role);
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

// ── store 헬퍼 단위 테스트 ────────────────────────────────────────────────────

describe("store.getProjectsByConceptId — read-only 역조회 헬퍼", () => {
  test("classification role 로 이어진 프로젝트를 돌려준다", () => {
    insertProject("prj_alpha", "알파 프로젝트");
    insertConcept("cpt_ai", "AI");
    linkProjectConcept("prj_alpha", "cpt_ai", "classification");

    const results = store.getProjectsByConceptId("cpt_ai");
    expect(results.map((r) => r.projectId)).toContain("prj_alpha");
  });

  test("tag role 로 이어진 프로젝트도 돌려준다", () => {
    insertProject("prj_beta", "베타 프로젝트");
    insertConcept("cpt_beta_tag", "베타태그");
    linkProjectConcept("prj_beta", "cpt_beta_tag", "tag");

    const results = store.getProjectsByConceptId("cpt_beta_tag");
    expect(results.map((r) => r.projectId)).toContain("prj_beta");
  });

  test("role 필터를 주면 그 role 만 반환된다", () => {
    insertProject("prj_gamma", "감마 프로젝트");
    insertConcept("cpt_shared", "공유개념");
    linkProjectConcept("prj_gamma", "cpt_shared", "classification");
    linkProjectConcept("prj_gamma", "cpt_shared", "tag");

    const classOnly = store.getProjectsByConceptId("cpt_shared", "classification");
    expect(classOnly.every((r) => r.role === "classification")).toBe(true);

    const tagOnly = store.getProjectsByConceptId("cpt_shared", "tag");
    expect(tagOnly.every((r) => r.role === "tag")).toBe(true);
  });

  test("일치하는 개념이 없으면 빈 배열(정직한 빈 상태)", () => {
    const results = store.getProjectsByConceptId("cpt_nonexistent");
    expect(results).toEqual([]);
  });
});

// ── augmentWithEntities 프로젝트 합류 검증 ────────────────────────────────────

describe("augmentWithEntities — 프로젝트 노드 합류(classification)", () => {
  test("classification 개념을 가진 프로젝트가 project 노드로 합류된다", async () => {
    insertProject("prj_test1", "테스트 프로젝트1");
    insertProjectAttr("prj_test1", "summary", "프로젝트 설명", true);
    insertProjectAttr("prj_test1", KO_ALIASES_ATTR_KEY, JSON.stringify(["테프"]), true);
    insertConcept("cpt_proj_class", "프로젝트분류");
    linkProjectConcept("prj_test1", "cpt_proj_class", "classification");

    const nodeId = insertNode("프로젝트 관련 글");
    linkNodeConcept(nodeId, "cpt_proj_class");

    const nodeById = seedNodeMap(nodeId, "프로젝트 관련 글");
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    const projectKey = "project:prj_test1";
    expect(nodeById.has(projectKey)).toBe(true);
    expect(nodeById.get(projectKey)!.sourceType).toBe("project");
    expect(nodeById.get(projectKey)!.label).toBeTruthy();
    expect(nodeById.get(projectKey)!.meta).toEqual({
      entityInfo: {
        sections: [
          { title: "칸", rows: [{ key: "요약", value: "프로젝트 설명" }] },
          { title: "별칭", rows: [{ key: "별칭", value: "테프" }] },
        ],
      },
    });
  });

  test("tag 개념을 가진 프로젝트도 합류된다", async () => {
    insertProject("prj_test2", "태그 프로젝트");
    insertConcept("cpt_proj_tag", "프로젝트태그");
    linkProjectConcept("prj_test2", "cpt_proj_tag", "tag");

    const nodeId = insertNode("태그 프로젝트 관련 글");
    linkNodeConcept(nodeId, "cpt_proj_tag");

    const nodeById = seedNodeMap(nodeId, "태그 프로젝트 관련 글");
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    const projectKey = "project:prj_test2";
    expect(nodeById.has(projectKey)).toBe(true);
    expect(nodeById.get(projectKey)!.sourceType).toBe("project");
  });

  test("프로젝트 노드 id 는 project:<projectId> 형식이다", async () => {
    insertProject("prj_fmt", "형식 테스트");
    insertConcept("cpt_fmt", "형식개념");
    linkProjectConcept("prj_fmt", "cpt_fmt", "classification");

    const nodeId = insertNode("형식 테스트 글");
    linkNodeConcept(nodeId, "cpt_fmt");

    const nodeById = seedNodeMap(nodeId, "형식 테스트 글");
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    const projectKeys = [...nodeById.keys()].filter((k) =>
      k.startsWith("project:"),
    );
    expect(projectKeys).toContain("project:prj_fmt");
  });

  test("프로젝트 ↔ 개념 연결선이 edgeSet 에 추가된다", async () => {
    insertProject("prj_edge", "엣지 테스트");
    insertConcept("cpt_edge", "엣지개념");
    linkProjectConcept("prj_edge", "cpt_edge", "classification");

    const nodeId = insertNode("엣지 테스트 글");
    linkNodeConcept(nodeId, "cpt_edge");

    const nodeById = seedNodeMap(nodeId, "엣지 테스트 글");
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    const found = [...edgeSet.keys()].some(
      (k) =>
        k.includes("project:prj_edge") && k.includes("concept:cpt_edge"),
    );
    expect(found).toBe(true);
  });

  test("개념 노드가 집합 밖이면 프로젝트는 합류되지 않는다(양끝 불변식)", async () => {
    // 프로젝트 + 개념은 만들지만, 그 개념을 글에 이어지지 않게 해서
    // nodeById 에 개념 노드가 들어오지 않도록 한다.
    insertProject("prj_orphan", "고아 프로젝트");
    insertConcept("cpt_orphan", "고아개념");
    linkProjectConcept("prj_orphan", "cpt_orphan", "classification");
    // 글을 만들되 다른 개념에 이어서 cpt_orphan 은 집합 밖으로 둔다.
    insertConcept("cpt_other", "다른개념");
    const nodeId = insertNode("관계없는 글");
    linkNodeConcept(nodeId, "cpt_other");

    const nodeById = seedNodeMap(nodeId, "관계없는 글");
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    expect(nodeById.has("project:prj_orphan")).toBe(false);
  });

  test("프로젝트가 없으면 노드 0개(정직한 빈 상태)", async () => {
    insertConcept("cpt_empty", "빈개념");
    const nodeId = insertNode("프로젝트 없는 글");
    linkNodeConcept(nodeId, "cpt_empty");

    const nodeById = seedNodeMap(nodeId, "프로젝트 없는 글");
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    const projectKeys = [...nodeById.keys()].filter((k) =>
      k.startsWith("project:"),
    );
    expect(projectKeys.length).toBe(0);
  });
});

// ── 단계 1.7 — 프로젝트 → 글 owns_memory 허브 합류 ───────────────────────────

/** project_id 를 채운 글 행을 넣는다(D2 getProjectMemberNodes 가 끌어올 대상). */
function insertNodeWithProject(content: string, projectId: string): number {
  const r = db
    .prepare(
      "INSERT INTO knowledge_nodes (content, project_id) VALUES (?, ?)",
    )
    .run(content, projectId);
  return Number(r.lastInsertRowid);
}

/**
 * 글 노드를 nodeById seed 로 넣되 길 A 그대로 projectId 를 싣는다(toGraphNode 가
 * 운영에서 채우는 칸을 테스트 seed 가 직접 흉내). 단계 1.7 이 이 칸을 읽어 프로젝트를 모은다.
 */
function seedNodeWithProject(
  m: Map<string, GraphNode>,
  nodeId: number,
  content: string,
  projectId: string | null,
): void {
  m.set(`node:${nodeId}`, {
    id: `node:${nodeId}`,
    sourceId: nodeId,
    sourceType: "auto_capture",
    label: content.slice(0, 31),
    snippet: content,
    projectId: projectId ?? undefined,
  });
}

describe("augmentWithEntities — 단계 1.7 프로젝트 → 글 owns_memory 허브", () => {
  test("집합 안 글 하나가 프로젝트 소속이면 같은 프로젝트 다른 글들이 owns_memory 로 합류한다", async () => {
    insertProject("prj_zombie", "좀비 로그라이크");
    const inSet = insertNodeWithProject("좀비 첫 글", "prj_zombie");
    const other1 = insertNodeWithProject("좀비 둘째 글", "prj_zombie");
    const other2 = insertNodeWithProject("좀비 셋째 글", "prj_zombie");

    const nodeById = new Map<string, GraphNode>();
    seedNodeWithProject(nodeById, inSet, "좀비 첫 글", "prj_zombie");
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    const projectKey = "project:prj_zombie";
    // 프로젝트 노드 합류.
    expect(nodeById.has(projectKey)).toBe(true);
    expect(nodeById.get(projectKey)!.sourceType).toBe("project");
    // 다른 글들도 노드로 들어온다.
    expect(nodeById.has(`node:${other1}`)).toBe(true);
    expect(nodeById.has(`node:${other2}`)).toBe(true);

    // owns_memory 엣지가 프로젝트 → 글 방향으로 그려진다.
    const ownsEdges = [...edgeSet.values()].filter(
      (e) => e.type === OWNS_MEMORY_EDGE_TYPE,
    );
    expect(ownsEdges.length).toBeGreaterThan(0);
    for (const e of ownsEdges) {
      expect(e.from).toBe(projectKey); // 방향 = 프로젝트 → 글.
      expect(e.to.startsWith("node:")).toBe(true);
      expect(e.weight).toBe(PROJECT_OWNS_WEIGHT);
      // 양끝이 둘 다 집합 안.
      expect(nodeById.has(e.from)).toBe(true);
      expect(nodeById.has(e.to)).toBe(true);
    }
    // 집합 안에 이미 있던 글(inSet)에도 owns_memory 엣지가 그려진다.
    const toInSet = ownsEdges.some((e) => e.to === `node:${inSet}`);
    expect(toInSet).toBe(true);
  });

  test("라벨 경유(1.6)로 이미 합류한 프로젝트가 1.7 과 같은 키면 노드 하나(중복 0)", async () => {
    // 1.6 경로: classification 개념 → 프로젝트. 1.7 경로: 같은 프로젝트 소속 글.
    insertProject("prj_dual", "양쪽 합류 프로젝트");
    insertConcept("cpt_dual", "양쪽개념");
    linkProjectConcept("prj_dual", "cpt_dual", "classification");

    const labelNode = insertNode("개념 경유 글");
    linkNodeConcept(labelNode, "cpt_dual"); // 1.6 이 이 글에서 프로젝트를 끌어옴.
    const projNode = insertNodeWithProject("프로젝트 소속 글", "prj_dual"); // 1.7 대상.

    const nodeById = new Map<string, GraphNode>();
    // labelNode 는 개념 경유라 projectId 없이 seed, projNode 는 projectId 실어 seed.
    nodeById.set(`node:${labelNode}`, {
      id: `node:${labelNode}`,
      sourceId: labelNode,
      sourceType: "auto_capture",
      label: "개념 경유 글",
      snippet: "개념 경유 글",
    });
    seedNodeWithProject(nodeById, projNode, "프로젝트 소속 글", "prj_dual");
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    const dualKeys = [...nodeById.keys()].filter(
      (k) => k === "project:prj_dual",
    );
    expect(dualKeys.length).toBe(1); // 노드 하나(자동 병합).
  });

  test("projectId NULL 글만 있으면 owns_memory 엣지 0(가짜 글 0·정직한 빈 상태)", async () => {
    const n1 = insertNode("소속 없는 글 하나");
    const n2 = insertNode("소속 없는 글 둘");

    const nodeById = new Map<string, GraphNode>();
    seedNodeWithProject(nodeById, n1, "소속 없는 글 하나", null);
    seedNodeWithProject(nodeById, n2, "소속 없는 글 둘", null);
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    const ownsEdges = [...edgeSet.values()].filter(
      (e) => e.type === OWNS_MEMORY_EDGE_TYPE,
    );
    expect(ownsEdges.length).toBe(0);
    const projectKeys = [...nodeById.keys()].filter((k) =>
      k.startsWith("project:"),
    );
    expect(projectKeys.length).toBe(0);
  });

  test("프로젝트에 글 하나뿐이면(집합 안 그 글) owns_memory 끌어올 다른 글 없음", async () => {
    insertProject("prj_solo", "혼자 프로젝트");
    const only = insertNodeWithProject("유일한 글", "prj_solo");

    const nodeById = new Map<string, GraphNode>();
    seedNodeWithProject(nodeById, only, "유일한 글", "prj_solo");
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    // 프로젝트 노드는 합류하고 집합 안 그 글로 owns_memory 한 줄은 그려진다.
    expect(nodeById.has("project:prj_solo")).toBe(true);
    const ownsEdges = [...edgeSet.values()].filter(
      (e) => e.type === OWNS_MEMORY_EDGE_TYPE,
    );
    // 끌어온 글은 only 하나 → owns_memory 도 only 한 줄(에러 0).
    expect(ownsEdges.length).toBe(1);
    expect(ownsEdges[0]!.to).toBe(`node:${only}`);
  });

  test("새로 추가되는 글 총수가 PROJECT_MEMBER_NODES_LIMIT 를 넘지 않는다", async () => {
    insertProject("prj_big", "대형 프로젝트");
    // 상한보다 많은 글을 같은 프로젝트에 넣는다.
    const total = PROJECT_MEMBER_NODES_LIMIT + 30;
    let firstId = 0;
    for (let i = 0; i < total; i++) {
      const id = insertNodeWithProject(`대형 글 ${i}`, "prj_big");
      if (i === 0) firstId = id;
    }

    const nodeById = new Map<string, GraphNode>();
    seedNodeWithProject(nodeById, firstId, "대형 글 0", "prj_big");
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    // 집합 밖에서 새로 들어온 글 노드 수 = 전체 글 노드 - 처음 seed 한 1개.
    const memoryNodes = [...nodeById.keys()].filter((k) => k.startsWith("node:"));
    const newlyAdded = memoryNodes.length - 1; // firstId 는 seed 라 카운트 제외.
    expect(newlyAdded).toBeLessThanOrEqual(PROJECT_MEMBER_NODES_LIMIT);
  });
});

describe("augmentWithEntities — 프로젝트 과밀 상한(PROJECTS_PER_NODE)", () => {
  test("글 1개당 합류 프로젝트는 PROJECTS_PER_NODE 이하", async () => {
    // 개념 1개에 프로젝트 10개를 이어 상한을 초과하는 후보를 만든다.
    insertConcept("cpt_many", "다수프로젝트개념");
    const nodeId = insertNode("다수 프로젝트 글");
    linkNodeConcept(nodeId, "cpt_many");

    for (let i = 0; i < 10; i++) {
      const pid = `prj_many_${i}`;
      insertProject(pid, `많은 프로젝트 ${i}`);
      linkProjectConcept(pid, "cpt_many", "classification");
    }

    const nodeById = seedNodeMap(nodeId, "다수 프로젝트 글");
    const edgeSet = new Map<string, GraphEdge>();

    await augmentWithEntities(store, nodeById, edgeSet);

    const projectNodes = [...nodeById.keys()].filter((k) =>
      k.startsWith("project:"),
    );
    // graph.ts 상수를 import 해 쓴다 — 상한이 바뀌면 테스트도 자동 따라간다.
    expect(projectNodes.length).toBeLessThanOrEqual(PROJECTS_PER_NODE);
  });
});
