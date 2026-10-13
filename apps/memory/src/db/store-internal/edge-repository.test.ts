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
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { ConceptRepository } from "./concept-repository.ts";
import { EdgeRepository } from "./edge-repository.ts";

const TEST_PROVENANCE = "system" as const;
const TEST_SOURCE_NODE_ID = null;

function testConceptEdgeMeta(): {
  provenance: typeof TEST_PROVENANCE;
  sourceNodeId: null;
} {
  return { provenance: TEST_PROVENANCE, sourceNodeId: TEST_SOURCE_NODE_ID };
}

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

describe("EdgeRepository — concept_edges 위계 + 공출현", () => {
  let db: Database;
  let edges: EdgeRepository;
  let concepts: ConceptRepository;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    edges = new EdgeRepository(db);
    concepts = new ConceptRepository(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  /** 두 태그 개념 + 자산 글 N개 + 양쪽 role='tag' 엣지. */
  async function seedCoOccurrence(n: number): Promise<{ parent: string; child: string }> {
    const parent = await concepts.findOrCreateTagConcept("만화");
    const child = await concepts.findOrCreateTagConcept("주술회전");
    for (let i = 0; i < n; i++) {
      db.prepare("INSERT INTO knowledge_nodes (content) VALUES (?)").run(`글${i}`);
      const nodeId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
      await concepts.addNodeConceptEdge(nodeId, parent, "tag", TEST_PROVENANCE, nodeId);
      await concepts.addNodeConceptEdge(nodeId, child, "tag", TEST_PROVENANCE, nodeId);
    }
    return { parent, child };
  }

  test("addConceptEdge + listConceptEdges — 다중 부모", async () => {
    const c = await concepts.findOrCreateTagConcept("주술회전");
    const m = await concepts.findOrCreateTagConcept("만화");
    const a = await concepts.findOrCreateTagConcept("액션");
    await edges.addConceptEdge({
      sourceConceptId: c,
      targetConceptId: m,
      relation: "parent_of",
      ...testConceptEdgeMeta(),

      provenance: "user_input",
      sourceNodeId: null,
});
    await edges.addConceptEdge({
      sourceConceptId: c,
      targetConceptId: a,
      relation: "parent_of",
      ...testConceptEdgeMeta(),

      provenance: "user_input",
      sourceNodeId: null,
});
    const list = await edges.listConceptEdges({ relation: "parent_of" });
    expect(list.length).toBe(2);
    expect(list[0]!.weight).toBeCloseTo(0.3);
  });

  test("addEdge 는 출처와 촉발 글을 저장하고 중복 호출 때 첫 출처를 유지한다", async () => {
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES ('원본')").run();
    const sourceId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES ('자식')").run();
    const targetId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;

    await edges.addEdge({
      sourceId,
      targetId,
      relation: "merged_into",
      provenance: "regex",
      sourceNodeId: targetId,
      weight: 1,
    });
    await edges.addEdge({
      sourceId,
      targetId,
      relation: "merged_into",
      provenance: "system",
      sourceNodeId: sourceId,
      weight: 0.2,
    });

    const row = db
      .prepare(
        `SELECT provenance, source_node_id, weight
         FROM knowledge_edges
         WHERE source_id = ? AND target_id = ? AND relation = 'merged_into'`,
      )
      .get(sourceId, targetId) as { provenance: string; source_node_id: number; weight: number };
    expect(row.provenance).toBe("regex");
    expect(row.source_node_id).toBe(targetId);
    expect(row.weight).toBe(1);
  });

  test("addConceptEdge 는 출처를 저장하고 UPSERT 때 첫 출처를 유지한다", async () => {
    const child = await concepts.findOrCreateTagConcept("주술회전");
    const parent = await concepts.findOrCreateTagConcept("만화");

    await edges.addConceptEdge({
      sourceConceptId: parent,
      targetConceptId: child,
      relation: "parent_of",
      provenance: "hashtag",
      sourceNodeId: 101,
      weight: 0.3,
    });
    await edges.addConceptEdge({
      sourceConceptId: parent,
      targetConceptId: child,
      relation: "parent_of",
      provenance: "llm_extract",
      sourceNodeId: 202,
      weight: 0.9,
    });

    const row = db
      .prepare(
        `SELECT provenance, source_node_id, weight
         FROM concept_edges
         WHERE source_concept_id = ? AND target_concept_id = ? AND relation = 'parent_of'`,
      )
      .get(parent, child) as { provenance: string; source_node_id: number; weight: number };
    expect(row.provenance).toBe("hashtag");
    expect(row.source_node_id).toBe(101);
    expect(row.weight).toBeCloseTo(0.9);
  });

  test("countConceptCoOccurrence — role='tag' 공출현 distinct node 수", async () => {
    const { parent, child } = await seedCoOccurrence(3);
    expect(await edges.countConceptCoOccurrence(parent, child)).toBe(3);
    expect(await edges.countConceptCoOccurrence(child, parent)).toBe(3);
  });

  test("countConceptCoOccurrence — 공출현 0 이면 0 (throw 안 함)", async () => {
    const a = await concepts.findOrCreateTagConcept("만화");
    const b = await concepts.findOrCreateTagConcept("게임");
    expect(await edges.countConceptCoOccurrence(a, b)).toBe(0);
  });

  test("getConceptNeighbors — source/target 양방향 직접 이웃", async () => {
    const c = await concepts.findOrCreateTagConcept("주술회전");
    const m = await concepts.findOrCreateTagConcept("만화");
    await edges.addConceptEdge({
      sourceConceptId: c,
      targetConceptId: m,
      relation: "parent_of",
      ...testConceptEdgeMeta(),

      provenance: "user_input",
      sourceNodeId: null,
});
    const fromChild = await edges.getConceptNeighbors(c);
    const fromParent = await edges.getConceptNeighbors(m);
    expect(fromChild.length).toBe(1);
    expect(fromParent.length).toBe(1);
  });

  // ── Task 18: 양 끝 FK 제거 → 사람(psn_)·개념(cpt_) 자유 연결 ────────────
  // FK 가 살아 있던 시절엔 psn_ 끝 INSERT 가 SQLITE_CONSTRAINT_FOREIGNKEY 로
  // 크래시했다(psn_ id 는 concept_nodes 에 없으므로). FK 를 뺀 뒤로는 세 조합이
  // 다 통과한다. 실재 검증은 애플리케이션 게이트(validateRelationSummary)가 맡는다.

  test("세 조합 INSERT — cpt_-cpt_ / psn_-cpt_ / psn_-psn_ 다 통과 (FK 제거)", () => {
    // concept_nodes 에 cpt_ 두 개, persons 에 psn_ 두 개를 실재로 만든다.
    // FK 가 없으므로 행 실재와 무관하게 INSERT 가 통과해야 한다(자유 연결).
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_x', '개념X')").run();
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_y', '개념Y')").run();
    db.prepare("INSERT INTO persons (person_id, display_name) VALUES ('psn_a', '사람A')").run();
    db.prepare("INSERT INTO persons (person_id, display_name) VALUES ('psn_b', '사람B')").run();

    const insert = db.prepare(
      `INSERT INTO concept_edges
         (source_concept_id, target_concept_id, relation, provenance, source_node_id, weight)
       VALUES (?, ?, ?, 'system', NULL, ?)`,
    );
    // cpt_-cpt_ (옛 동작 — 위계)
    expect(() => insert.run("cpt_x", "cpt_y", "related_to", 0.3)).not.toThrow();
    // psn_-cpt_ (사람 → 개념)
    expect(() => insert.run("psn_a", "cpt_x", "related_to", 0.3)).not.toThrow();
    // psn_-psn_ (사람 → 사람)
    expect(() => insert.run("psn_a", "psn_b", "related_to", 0.3)).not.toThrow();

    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM concept_edges").get() as { c: number }).c;
    expect(cnt).toBe(3);
  });

  test("psn_ 끝은 concept_nodes 에 없어도 INSERT 통과 (FK 부재 확인)", () => {
    // persons 에만 있고 concept_nodes 에는 없는 psn_ id 를 양 끝에 넣어도
    // 통과해야 한다 — FK 가 살아 있으면 여기서 크래시한다.
    db.prepare("INSERT INTO persons (person_id, display_name) VALUES ('psn_only', '사람')").run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO concept_edges
             (source_concept_id, target_concept_id, relation, provenance, source_node_id, weight)
           VALUES ('psn_only', 'psn_only2', 'related_to', 'system', NULL, 0.3)`,
        )
        .run(),
    ).not.toThrow();
  });

  // ── 1.2 T5: has_attribute 역방향 조회 ('개발자인 사람들') ──────────────

  test("getPersonsByAttributeConcept — has_attribute 사람 끝만 회신", async () => {
    const dev = await concepts.findOrCreateTagConcept("개발자");
    db.prepare("INSERT INTO persons (person_id, display_name) VALUES ('psn_a', '사람A')").run();
    db.prepare("INSERT INTO persons (person_id, display_name) VALUES ('psn_b', '사람B')").run();

    const insert = db.prepare(
      `INSERT INTO concept_edges
         (source_concept_id, target_concept_id, relation, provenance, source_node_id, weight)
       VALUES (?, ?, 'has_attribute', 'system', NULL, 1.0)`,
    );
    insert.run("psn_a", dev);
    insert.run("psn_b", dev);

    const people = edges.getPersonsByAttributeConcept(dev);
    expect(people.sort()).toEqual(["psn_a", "psn_b"]);
  });

  test("getPersonsByAttributeConcept — 라벨↔라벨 has_attribute 와 다른 relation 은 섞이지 않음", async () => {
    const dev = await concepts.findOrCreateTagConcept("개발자");
    db.prepare("INSERT INTO persons (person_id, display_name) VALUES ('psn_a', '사람A')").run();
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_label', '라벨')").run();

    // 사람 끝 has_attribute — 회신 대상.
    db.prepare(
      `INSERT INTO concept_edges
         (source_concept_id, target_concept_id, relation, provenance, source_node_id, weight)
       VALUES ('psn_a', ?, 'has_attribute', 'system', NULL, 1.0)`,
    ).run(dev);
    // 라벨↔라벨 has_attribute(source 가 cpt_) — LIKE 'psn_%' 로 걸러져 회신 제외.
    db.prepare(
      `INSERT INTO concept_edges
         (source_concept_id, target_concept_id, relation, provenance, source_node_id, weight)
       VALUES ('cpt_label', ?, 'has_attribute', 'system', NULL, 1.0)`,
    ).run(dev);
    // 같은 사람의 parent_of(다른 relation) — 회신 제외.
    db.prepare(
      `INSERT INTO concept_edges
         (source_concept_id, target_concept_id, relation, provenance, source_node_id, weight)
       VALUES ('psn_a', ?, 'parent_of', 'system', NULL, 0.3)`,
    ).run(dev);

    expect(edges.getPersonsByAttributeConcept(dev)).toEqual(["psn_a"]);
  });

  test("getPersonsByAttributeConcept — 엣지 0건이면 빈 배열 (throw 안 함)", async () => {
    const c = await concepts.findOrCreateTagConcept("아무도없음");
    expect(edges.getPersonsByAttributeConcept(c)).toEqual([]);
  });

  test("addConceptEdge — has_attribute relation 도 free-text 로 통과", async () => {
    db.prepare("INSERT INTO persons (person_id, display_name) VALUES ('psn_x', '사람X')").run();
    const dev = await concepts.findOrCreateTagConcept("개발자");
    await edges.addConceptEdge({
      sourceConceptId: "psn_x",
      targetConceptId: dev,
      relation: "has_attribute",
      ...testConceptEdgeMeta(),
      provenance: "user_input",
      sourceNodeId: null,
      weight: 1.0,
    });
    const list = await edges.listConceptEdges({ relation: "has_attribute" });
    expect(list.length).toBe(1);
    expect(list[0]!.sourceConceptId).toBe("psn_x");
    expect(list[0]!.weight).toBeCloseTo(1.0);
  });

  test("parent_of (cpt_-cpt_) 동작 불변 — FK 제거 후에도 위계 그대로", async () => {
    const c = await concepts.findOrCreateTagConcept("주술회전");
    const m = await concepts.findOrCreateTagConcept("만화");
    await edges.addConceptEdge({
      sourceConceptId: c,
      targetConceptId: m,
      relation: "parent_of",
      ...testConceptEdgeMeta(),

      provenance: "user_input",
      sourceNodeId: null,
});
    const list = await edges.listConceptEdges({ relation: "parent_of" });
    expect(list.length).toBe(1);
    expect(list[0]!.sourceConceptId).toBe(c);
    expect(list[0]!.targetConceptId).toBe(m);
    expect(list[0]!.weight).toBeCloseTo(0.3);
  });

  // 옛 concept_edges 위계 메서드(getParentOfEdgesWithin·getParentOfChildrenTransitive)
  // 단위 테스트는 S3 에서 그 메서드와 함께 삭제했다 — 위계가 hierarchy_edges 로
  // 단일화돼 같은 동작을 hierarchy-edge-repository.test.ts 가 새 테이블 위에서 검증한다.

  describe("findFlatParentTagNodes + detachParentTagEdge — 자동 재정리(B1)", () => {
    /** 부모·자식 개념 + 글 N개(둘 다 role='tag') + 부모만 붙은 글 1개. */
    async function seedFlat(): Promise<{
      parent: string;
      child: string;
      bothNodes: number[];
      parentOnlyNode: number;
    }> {
      const parent = await concepts.findOrCreateTagConcept("작품");
      const child = await concepts.findOrCreateTagConcept("주술회전");
      const bothNodes: number[] = [];
      for (let i = 0; i < 2; i++) {
        db.prepare("INSERT INTO knowledge_nodes (content) VALUES (?)").run(`평평글${i}`);
        const nid = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
        await concepts.addNodeConceptEdge(nid, parent, "tag", TEST_PROVENANCE, nid);
        await concepts.addNodeConceptEdge(nid, child, "tag", TEST_PROVENANCE, nid);
        bothNodes.push(nid);
      }
      // 부모(작품)에만 붙은 글 — 대상 아님.
      db.prepare("INSERT INTO knowledge_nodes (content) VALUES (?)").run("부모만글");
      const parentOnlyNode = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
      await concepts.addNodeConceptEdge(parentOnlyNode, parent, "tag", TEST_PROVENANCE, parentOnlyNode);
      return { parent, child, bothNodes, parentOnlyNode };
    }

    test("빈 childConceptIds → 빈 배열", async () => {
      const { parent } = await seedFlat();
      expect(await edges.findFlatParentTagNodes(parent, [])).toEqual([]);
    });

    test("부모+자식 둘 다 붙은 글만 회신 (부모만 붙은 글 제외)", async () => {
      const { parent, child, bothNodes, parentOnlyNode } = await seedFlat();
      const found = await edges.findFlatParentTagNodes(parent, [child]);
      expect(found.sort()).toEqual([...bothNodes].sort());
      expect(found).not.toContain(parentOnlyNode);
    });

    test("detach — 부모 엣지만 떼이고 자식 엣지 남음 + tag_reflow_log 기록", async () => {
      const { parent, child, bothNodes } = await seedFlat();
      const target = bothNodes[0]!;
      await edges.detachParentTagEdge(target, parent, "category→value");

      // 부모 엣지 떼임.
      const parentEdge = db
        .prepare("SELECT 1 FROM node_concept_edges WHERE node_id=? AND concept_id=? AND role='tag'")
        .get(target, parent);
      expect(parentEdge).toBeNull();
      // 자식 엣지 남음.
      const childEdge = db
        .prepare("SELECT 1 FROM node_concept_edges WHERE node_id=? AND concept_id=? AND role='tag'")
        .get(target, child);
      expect(childEdge).not.toBeNull();
      // 기록 1건.
      const log = db
        .prepare("SELECT node_id, parent_concept_id, trigger_hierarchy FROM tag_reflow_log WHERE node_id=?")
        .get(target) as
        | { node_id: number; parent_concept_id: string; trigger_hierarchy: string }
        | null;
      expect(log).not.toBeNull();
      expect(log!.parent_concept_id).toBe(parent);
      expect(log!.trigger_hierarchy).toBe("category→value");
    });

    test("idempotent — detach 후 findFlatParentTagNodes 가 그 글을 다시 안 잡음", async () => {
      const { parent, child, bothNodes } = await seedFlat();
      const target = bothNodes[0]!;
      await edges.detachParentTagEdge(target, parent, "category→value");
      const found = await edges.findFlatParentTagNodes(parent, [child]);
      expect(found).not.toContain(target);
    });
  });

  // ── 자가 치유 UPSERT (옛 0.3 청소) ──────────────────────────────
  // spec docs/decisions/2026-06-07-concept-edge-upsert-self-heal-spec.md §5

  test("UPSERT 자가 치유 — 0.3 선재 후 0.9 재선언 시 0.9 로 올라감", async () => {
    const child = await concepts.findOrCreateTagConcept("주술회전");
    const parent = await concepts.findOrCreateTagConcept("만화");
    await edges.addConceptEdge({
      sourceConceptId: parent,
      targetConceptId: child,
      relation: "parent_of",
      ...testConceptEdgeMeta(),
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.3,
    });
    await edges.addConceptEdge({
      sourceConceptId: parent,
      targetConceptId: child,
      relation: "parent_of",
      ...testConceptEdgeMeta(),
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.9,
    });
    const list = await edges.listConceptEdges({ relation: "parent_of" });
    expect(list.length).toBe(1);
    expect(list[0]!.weight).toBeCloseTo(0.9);
  });

  test("UPSERT 강등 차단 — 0.9 선재 후 0.3 재선언 시 0.9 유지", async () => {
    const child = await concepts.findOrCreateTagConcept("주술회전");
    const parent = await concepts.findOrCreateTagConcept("만화");
    await edges.addConceptEdge({
      sourceConceptId: parent,
      targetConceptId: child,
      relation: "parent_of",
      ...testConceptEdgeMeta(),
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.9,
    });
    await edges.addConceptEdge({
      sourceConceptId: parent,
      targetConceptId: child,
      relation: "parent_of",
      ...testConceptEdgeMeta(),
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.3,
    });
    const list = await edges.listConceptEdges({ relation: "parent_of" });
    expect(list.length).toBe(1);
    expect(list[0]!.weight).toBeCloseTo(0.9);
  });

  test("UPSERT 신규 — 없던 쌍은 넘긴 weight 그대로 INSERT", async () => {
    const child = await concepts.findOrCreateTagConcept("주술회전");
    const parent = await concepts.findOrCreateTagConcept("만화");
    await edges.addConceptEdge({
      sourceConceptId: parent,
      targetConceptId: child,
      relation: "parent_of",
      ...testConceptEdgeMeta(),
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.9,
    });
    const list = await edges.listConceptEdges({ relation: "parent_of" });
    expect(list.length).toBe(1);
    expect(list[0]!.weight).toBeCloseTo(0.9);
  });

  test("UPSERT — created_at 보존 / updated_at 갱신", async () => {
    const child = await concepts.findOrCreateTagConcept("주술회전");
    const parent = await concepts.findOrCreateTagConcept("만화");
    await edges.addConceptEdge({
      sourceConceptId: parent,
      targetConceptId: child,
      relation: "parent_of",
      ...testConceptEdgeMeta(),
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.3,
    });
    db.prepare(
      `UPDATE concept_edges SET created_at = '2000-01-01 00:00:00',
         updated_at = '2000-01-01 00:00:00'
       WHERE source_concept_id = ? AND target_concept_id = ? AND relation = 'parent_of'`,
    ).run(parent, child);
    await edges.addConceptEdge({
      sourceConceptId: parent,
      targetConceptId: child,
      relation: "parent_of",
      ...testConceptEdgeMeta(),
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.9,
    });
    const row = db
      .prepare(
        `SELECT weight, created_at, updated_at FROM concept_edges
         WHERE source_concept_id = ? AND target_concept_id = ? AND relation = 'parent_of'`,
      )
      .get(parent, child) as { weight: number; created_at: string; updated_at: string };
    expect(row.weight).toBeCloseTo(0.9);
    expect(row.created_at).toBe("2000-01-01 00:00:00");
    expect(row.updated_at).not.toBe("2000-01-01 00:00:00");
  });

  test("UPSERT 멱등 — 같은 값 두 번 호출해도 행 1 개", async () => {
    const child = await concepts.findOrCreateTagConcept("주술회전");
    const parent = await concepts.findOrCreateTagConcept("만화");
    for (let i = 0; i < 2; i++) {
      await edges.addConceptEdge({
        sourceConceptId: parent,
        targetConceptId: child,
        relation: "parent_of",
        ...testConceptEdgeMeta(),
        provenance: "user_input",
        sourceNodeId: null,
        weight: 0.9,
      });
    }
    const list = await edges.listConceptEdges({ relation: "parent_of" });
    expect(list.length).toBe(1);
    expect(list[0]!.weight).toBeCloseTo(0.9);
  });
});
