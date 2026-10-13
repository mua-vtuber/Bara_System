/**
 * memory/compute-candidates.test.ts — resolveComputeCandidates 실 SQLite 통합 검증 (단계5 T2).
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder. mock 0. 검증 항목(D3):
 *   (a) 종류만 → 그 분류값 매칭 글
 *   (b) 종류 + 기간 → AND 교집합(기간 밖 글 제외)
 *   (c) 장소 + 기간 → 교집합
 *   (d) 프로젝트 단독
 *   (e) 날짜 단독 → selectNodeIdsByDateRange 출발 집합
 *   (f) 칸 0개 → 빈 Set + needsCondition(전 노드 폭주 차단·정직)
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
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { resolveComputeCandidates } from "./compute-candidates.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

describe("resolveComputeCandidates — 칸 교집합 후보(D3)", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => db.close());

  /** 종류(분류값)를 classification role 로 매단 글 하나 만들고 id 반환. */
  async function nodeWithConcept(
    content: string,
    conceptValue: string,
    eventAt?: string,
  ): Promise<number> {
    const cid = await store.findOrCreateTagConcept(conceptValue);
    const nid = await store.addNode({ content, eventAt });
    await store.addNodeConceptEdge(nid, cid, "classification", "user_input", nid);
    return nid;
  }

  /** 장소 leaf(place_concept_edges identity) + 그 글 하나 만들고 id 반환. */
  function nodeWithPlace(
    content: string,
    placeId: string,
    conceptId: string,
    placeName: string,
  ): number {
    // 분류 단계4 T4 — place 엔티티는 범용 본체 entities(type_name='place')에 살고,
    // identity 엣지는 통합 entity_concept_edges(entity_id 끝점)에 깐다(죽은 places·
    // place_concept_edges 대체). production 이 그 통로로 읽으므로 fixture 도 거기 만든다.
    db.prepare(
      `INSERT INTO entities (entity_id, type_name, name, created_at, updated_at)
       VALUES (?, 'place', ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
    ).run(placeId, placeName);
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES (?, ?)").run(
      conceptId,
      placeName.toLowerCase(),
    );
    db.prepare(
      `INSERT INTO entity_concept_edges (entity_id, concept_id, role, created_at, provenance, source_node_id) VALUES (?, ?, 'identity', '2026-01-01 00:00:00', 'user_input', NULL)`,
    ).run(placeId, conceptId);
    const nid = Number(
      db.prepare("INSERT INTO knowledge_nodes (content) VALUES (?)").run(content)
        .lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO node_concept_edges (node_id, concept_id, role, provenance, source_node_id) VALUES (?, ?, 'classification', 'user_input', NULL)`,
    ).run(nid, conceptId);
    return nid;
  }

  test("(a) 종류만 → 그 분류값 매칭 글 전부", async () => {
    const a = await nodeWithConcept("커피 3000원", "가계부");
    const b = await nodeWithConcept("점심 8000원", "가계부");
    await nodeWithConcept("운동 1시간", "일정"); // 다른 종류 — 제외
    const r = resolveComputeCandidates(store, { conceptValue: "가계부" });
    expect(r.needsCondition).toBe(false);
    expect(r.candidates).toEqual(new Set([a, b]));
  });

  test("(b) 종류 + 기간 → AND 교집합(기간 밖 글 제외)", async () => {
    const inRange = await nodeWithConcept("5월 커피", "가계부", "2026-05-10");
    await nodeWithConcept("6월 커피", "가계부", "2026-06-20"); // 기간 밖
    const r = resolveComputeCandidates(store, {
      conceptValue: "가계부",
      since: "2026-05-01",
      until: "2026-05-31",
    });
    expect(r.candidates).toEqual(new Set([inRange]));
  });

  test("(c) 장소 + 기간 → 교집합", async () => {
    const nid = nodeWithPlace("강남에서 산 것", "plc_gn", "cpt_gn", "강남");
    // 그 글에 event_at 을 5월로.
    db.prepare("UPDATE knowledge_nodes SET event_at = ? WHERE id = ?").run(
      "2026-05-15",
      nid,
    );
    const inRange = resolveComputeCandidates(store, {
      place: "강남",
      since: "2026-05-01",
      until: "2026-05-31",
    });
    expect(inRange.candidates).toEqual(new Set([nid]));
    const outRange = resolveComputeCandidates(store, {
      place: "강남",
      since: "2026-07-01",
      until: "2026-07-31",
    });
    expect(outRange.candidates.size).toBe(0);
  });

  test("(d) 프로젝트 단독 → 그 project_id 글", async () => {
    const a = await store.addNode({ content: "작업1", project_id: "prj_x" });
    const b = await store.addNode({ content: "작업2", project_id: "prj_x" });
    await store.addNode({ content: "딴거", project_id: "prj_y" });
    const r = resolveComputeCandidates(store, { projectId: "prj_x" });
    expect(r.candidates).toEqual(new Set([a, b]));
  });

  test("(e) 날짜 단독 → selectNodeIdsByDateRange 출발 집합", async () => {
    const inMay = await store.addNode({ content: "5월 글", eventAt: "2026-05-10" });
    await store.addNode({ content: "6월 글", eventAt: "2026-06-20" });
    const r = resolveComputeCandidates(store, {
      since: "2026-05-01",
      until: "2026-05-31",
    });
    expect(r.needsCondition).toBe(false);
    expect(r.candidates).toEqual(new Set([inMay]));
  });

  test("(f) 칸 0개 → 빈 Set + needsCondition(전 노드 폭주 차단·정직)", async () => {
    await store.addNode({ content: "아무 글" });
    const r = resolveComputeCandidates(store, {});
    expect(r.needsCondition).toBe(true);
    expect(r.candidates.size).toBe(0);
  });

  test("빈 문자열 칸은 미적용(공백 trim 후 빈 값)", async () => {
    await store.addNode({ content: "아무 글" });
    const r = resolveComputeCandidates(store, {
      conceptValue: "   ",
      place: "",
      projectId: "  ",
    });
    expect(r.needsCondition).toBe(true);
  });

  test("매칭 0건이면 빈 Set(needsCondition 아님 — 정직한 빈 결과)", async () => {
    await nodeWithConcept("커피", "가계부");
    const r = resolveComputeCandidates(store, { conceptValue: "존재안함" });
    expect(r.needsCondition).toBe(false);
    expect(r.candidates.size).toBe(0);
  });
});
