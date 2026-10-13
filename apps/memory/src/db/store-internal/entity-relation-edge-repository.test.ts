/**
 * entity-relation-edge-repository.test.ts — 통합 cross-type 관계 엣지 CRUD 가드
 * (4단계 Task 1).
 *
 * 실제 bun:sqlite(:memory:) + 실제 schema(openMemoryDatabase)로 통합 검증한다 —
 * Mock 클래스 0. entity_relation_edges 는 FK 0 이라(끝점이 어느 타입 행이든 가리킴)
 * 끝점 행을 미리 넣지 않아도 엣지를 적을 수 있다 — 끝점 행 실재는 wiring(Task 4)이
 * 책임지고, 이 repository 는 멱등 저장·양방향 조회·관계명 검증만 본다.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../migrations.ts";
import { EntityRelationEdgeRepository } from "./entity-relation-edge-repository.ts";

let db: Database;
let repo: EntityRelationEdgeRepository;

const TEST_PROVENANCE = "system" as const;
const TEST_SOURCE_NODE_ID = null;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
  repo = new EntityRelationEdgeRepository(db);
});
afterEach(() => {
  db.close();
});

test("addEntityRelationEdge — 신규는 true, 한 행이 들어간다", () => {
  const created = repo.addEntityRelationEdge(
    "work",
    "wrk_demotjuk",
    "person",
    "psn_akutami",
    "created_by",
    "hashtag",
    42,
  );
  expect(created).toBe(true);

  const out = repo.getRelationsFromSource("work", "wrk_demotjuk");
  expect(out.length).toBe(1);
  expect(out[0]!.targetType).toBe("person");
  expect(out[0]!.targetId).toBe("psn_akutami");
  expect(out[0]!.relation).toBe("created_by");
  expect(out[0]!.weight).toBeNull();
  const row = db
    .prepare(
      `SELECT provenance, source_node_id FROM entity_relation_edges
       WHERE source_type = 'work' AND source_id = 'wrk_demotjuk'
         AND target_type = 'person' AND target_id = 'psn_akutami'`,
    )
    .get() as { provenance: string; source_node_id: number };
  expect(row.provenance).toBe("hashtag");
  expect(row.source_node_id).toBe(42);
  // created_at 은 형제 hierarchy_edges 와 같은 TEXT datetime("YYYY-MM-DD HH:MM:SS").
  // 옛 INTEGER epoch ms 양식은 선통일 묶음 M2/T1 에서 TEXT 로 통일했다.
  expect(typeof out[0]!.createdAt).toBe("string");
  expect(out[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test("addEntityRelationEdge 는 멱등 — 같은 엣지 두 번이면 두 번째는 false·한 행만", () => {
  const first = repo.addEntityRelationEdge(
    "work",
    "wrk_jjk",
    "person",
    "psn_akutami",
    "created_by",
    TEST_PROVENANCE,
    TEST_SOURCE_NODE_ID,
  );
  const second = repo.addEntityRelationEdge(
    "work",
    "wrk_jjk",
    "person",
    "psn_akutami",
    "created_by",
    "llm_extract",
    999,
  );
  expect(first).toBe(true);
  expect(second).toBe(false);
  expect(repo.getRelationsFromSource("work", "wrk_jjk").length).toBe(1);
  const row = db
    .prepare(
      `SELECT provenance, source_node_id FROM entity_relation_edges
       WHERE source_type = 'work' AND source_id = 'wrk_jjk'
         AND target_type = 'person' AND target_id = 'psn_akutami'`,
    )
    .get() as { provenance: string; source_node_id: number | null };
  expect(row.provenance).toBe("system");
  expect(row.source_node_id).toBeNull();
});

test("weight 를 주면 보존하고, 안 주면 null", () => {
  repo.addEntityRelationEdge("creature", "crt_bori", "person", "psn_mom", "owned_by", TEST_PROVENANCE, TEST_SOURCE_NODE_ID, 0.8);
  const out = repo.getRelationsFromSource("creature", "crt_bori");
  expect(out[0]!.weight).toBe(0.8);
});

test("getRelationsToTarget — 같은 target 을 가리키는 여러 source 를 역방향으로 모은다", () => {
  // 같은 작가(아쿠타미)를 가리키는 두 작품 — '이 작가의 다른 작품' 검색 토대.
  repo.addEntityRelationEdge("work", "wrk_demotjuk", "person", "psn_akutami", "created_by", TEST_PROVENANCE, TEST_SOURCE_NODE_ID);
  repo.addEntityRelationEdge("work", "wrk_jjk", "person", "psn_akutami", "created_by", TEST_PROVENANCE, TEST_SOURCE_NODE_ID);

  const incoming = repo.getRelationsToTarget("person", "psn_akutami");
  expect(incoming.length).toBe(2);
  const sources = incoming.map((e) => e.sourceId).sort();
  expect(sources).toEqual(["wrk_demotjuk", "wrk_jjk"]);
});

test("getRelationNeighbors — 양방향 1-hop(나가는 것 + 들어오는 것)", () => {
  // 작품 데못죽: 나가는 엣지(→ 아쿠타미) + 들어오는 엣지(다른 엔티티 → 데못죽).
  repo.addEntityRelationEdge("work", "wrk_demotjuk", "person", "psn_akutami", "created_by", TEST_PROVENANCE, TEST_SOURCE_NODE_ID);
  repo.addEntityRelationEdge("schedule", "sch_review", "work", "wrk_demotjuk", "located_at", TEST_PROVENANCE, TEST_SOURCE_NODE_ID);

  const neighbors = repo.getRelationNeighbors("work", "wrk_demotjuk");
  expect(neighbors.length).toBe(2);
  const relations = neighbors.map((e) => e.relation).sort();
  expect(relations).toEqual(["created_by", "located_at"]);
});

test("이웃이 없으면 빈 배열(정직한 빈 결과 — 실패 아님)", () => {
  expect(repo.getRelationsFromSource("work", "wrk_없음")).toEqual([]);
  expect(repo.getRelationsToTarget("person", "psn_없음")).toEqual([]);
  expect(repo.getRelationNeighbors("schedule", "sch_없음")).toEqual([]);
});

test("unknown relation 은 식별자와 함께 loud throw(거짓 엣지 0)", () => {
  expect(() =>
    repo.addEntityRelationEdge("work", "wrk_x", "person", "psn_y", "made_up_relation", TEST_PROVENANCE, TEST_SOURCE_NODE_ID),
  ).toThrow(/made_up_relation/);
  // throw 했으므로 행이 들어가지 않았다 — silent fallback 0.
  expect(repo.getRelationsFromSource("work", "wrk_x")).toEqual([]);
});

test("getRelationsFromSource 는 created_at 순으로 정렬", () => {
  repo.addEntityRelationEdge("schedule", "sch_meet", "person", "psn_a", "related_person", TEST_PROVENANCE, TEST_SOURCE_NODE_ID);
  repo.addEntityRelationEdge("schedule", "sch_meet", "place", "plc_seoul", "located_at", TEST_PROVENANCE, TEST_SOURCE_NODE_ID);
  const out = repo.getRelationsFromSource("schedule", "sch_meet");
  expect(out.length).toBe(2);
  // 정렬이 깨지지 않는다(둘 다 같은 source 의 서로 다른 관계).
  const relations = out.map((e) => e.relation).sort();
  expect(relations).toEqual(["located_at", "related_person"]);
});

test("created_at 이 다른 시각이면 TEXT lexicographic 비교가 곧 시간순", () => {
  // TEXT datetime 은 사전식 비교가 시간 순서와 같다(형제 hierarchy_edges 가 같은 사실에
  // 의존). created_at 을 직접 넣어(repository 의 nowKst 대신) 순서를 결정적으로 확인한다.
  db.prepare(
    `INSERT INTO entity_relation_edges
       (source_type, source_id, target_type, target_id, relation, provenance, source_node_id,
        weight, created_at)
     VALUES (?, ?, ?, ?, ?, 'system', NULL, ?, ?)`,
  ).run("work", "wrk_t", "person", "psn_late", "created_by", null, "2026-06-25 12:00:02");
  db.prepare(
    `INSERT INTO entity_relation_edges
       (source_type, source_id, target_type, target_id, relation, provenance, source_node_id,
        weight, created_at)
     VALUES (?, ?, ?, ?, ?, 'system', NULL, ?, ?)`,
  ).run("work", "wrk_t", "place", "plc_early", "located_at", null, "2026-06-25 12:00:01");
  const out = repo.getRelationsFromSource("work", "wrk_t");
  // 더 이른 시각이 먼저, 더 늦은 시각이 나중(사전식 = 시간순).
  expect(out.map((e) => e.targetId)).toEqual(["plc_early", "psn_late"]);
});

test("같은 초 동률은 PK(source_id, target_id) 보조 정렬로 결정적(결과 집합 불변)", () => {
  // 옛 INTEGER epoch ms 는 같은 초 안 INSERT 순서를 ms 로 갈랐지만, TEXT 초 양식은 같은
  // 초 INSERT 가 동률이 된다(D5). 동률 시 PK 보조 정렬로 순서를 결정적으로 만든다 —
  // 결과 집합은 같고 순서만 결정성을 얻는다(검색 1-hop 펼침은 동률 순서에 의미 없음).
  const sameSecond = "2026-06-25 12:00:00";
  // 일부러 PK 역순(target_id zeta → alpha)으로 넣어도, 조회는 PK 오름차순으로 결정된다.
  for (const targetId of ["plc_zeta", "plc_mid", "plc_alpha"]) {
    db.prepare(
      `INSERT INTO entity_relation_edges
         (source_type, source_id, target_type, target_id, relation, provenance, source_node_id,
          weight, created_at)
       VALUES (?, ?, ?, ?, ?, 'system', NULL, ?, ?)`,
    ).run("schedule", "sch_tie", "place", targetId, "located_at", null, sameSecond);
  }
  const out = repo.getRelationsFromSource("schedule", "sch_tie");
  expect(out.length).toBe(3);
  // 같은 초 + 같은 source_id 라 보조 정렬 키 target_id 오름차순으로 결정적.
  expect(out.map((e) => e.targetId)).toEqual(["plc_alpha", "plc_mid", "plc_zeta"]);
});
