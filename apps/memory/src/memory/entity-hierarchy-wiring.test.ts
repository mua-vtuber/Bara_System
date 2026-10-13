/**
 * entity-hierarchy-wiring.test.ts — 타입 루트 + 분류 키 위계 연결 통합 검증
 * (개념 엔티티 타입 체계 3단계 Task 2, spec §6.3).
 *
 * mock 0 — 실제 SQLite + 실제 임베딩 store 로 검증한다(CLAUDE.md "DB/임베딩 의존
 * 모듈은 실제 구현체와 통합 검증"). 검증 대상:
 *   - ensureTypeRootConcept('creature') 가 '생물' 노드(is_classification_key=1) 생성·재호출 같은 id.
 *   - linkSubcategoryToTypeRoot(..., 'creature', '동물') 후 '생물 parent_of 동물' 엣지 weight 0.9.
 *   - 이어서 store.addClassificationTag 로 '동물 → 고양이' 를 만든 뒤 '생물 → 동물 → 고양이'
 *     사슬이 같은 hierarchy_edges parent_of 로 전부 이어짐(transitive).
 *   - 두 번 호출 멱등(노드·엣지 중복 0).
 *
 * S0-T4(2026-06-14) — linkSubcategoryToTypeRoot 도 store.addClassificationTag 단일
 * 출처를 지나므로, '생물→동물'·'동물→고양이' 두 단이 모두 새 단일 출처 테이블
 * hierarchy_edges 로 들어간다. 사슬은 한 테이블 안에서 그대로 이어진다 — 단정만
 * concept_edges 에서 hierarchy_edges 로 옮긴다.
 *
 * 알 수 없는 타입 이름은 식별자와 함께 loud throw 함도 확인한다.
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
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import {
  ensureTypeRootConcept,
  linkSubcategoryToTypeRoot,
} from "./entity-hierarchy-wiring.ts";

describe("entity-hierarchy-wiring — 타입 루트 + 분류 키 위계 연결 (§6.3)", () => {
  let embedder: Bgem3Embedder;
  let db: Database;
  let store: SqliteMemoryStore;

  beforeAll(async () => {
    embedder = new Bgem3Embedder();
    await embedder.load();
  });

  afterAll(() => {});

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  /** origin 노드 한 개를 실제로 만들어 id 를 돌려준다(addClassificationTag 가 분류 키에 잇는다). */
  async function makeOrigin(content: string): Promise<number> {
    return store.addNode({
      content,
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
  }

  /**
   * source→target 개념 parent_of 위계 엣지가 hierarchy_edges 에 weight 와 함께
   * 있는지(S0-T4 — 옛 concept_edges 가 아닌 단일 출처 테이블). 없으면 null.
   */
  function hierarchyEdge(
    sourceId: string,
    targetId: string,
  ): { weight: number } | null {
    const row = db
      .prepare(
        `SELECT weight FROM hierarchy_edges
         WHERE relation = 'parent_of'
           AND source_type = 'concept' AND source_id = ?
           AND target_type = 'concept' AND target_id = ?`,
      )
      .get(sourceId, targetId) as { weight: number } | undefined;
    return row ?? null;
  }

  test("ensureTypeRootConcept('creature') 가 '생물' 노드(is_classification_key=1)를 만든다", async () => {
    const rootId = await ensureTypeRootConcept(store, "creature");

    const root = await store.getConcept(rootId);
    expect(root).not.toBeNull();
    expect(root!.name).toBe("생물");
    expect(root!.isClassificationKey).toBe(true);
  });

  test("ensureTypeRootConcept 를 다시 불러도 같은 id 를 돌려준다(이름 UNIQUE 재사용)", async () => {
    const first = await ensureTypeRootConcept(store, "creature");
    const second = await ensureTypeRootConcept(store, "creature");
    expect(second).toBe(first);

    // 같은 이름 개념 노드는 정확히 한 행이어야 한다(중복 0).
    const count = (
      db
        .prepare("SELECT COUNT(*) AS n FROM concept_nodes WHERE name = ?")
        .get("생물") as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  test("linkSubcategoryToTypeRoot 후 '생물 parent_of 동물' 엣지가 weight 0.9 로 존재한다", async () => {
    const originId = await makeOrigin("생물 분류 글");
    const rootId = await ensureTypeRootConcept(store, "creature");

    await linkSubcategoryToTypeRoot(store, originId, "creature", "동물");

    const dongmul = await store.findConceptByName("동물");
    expect(dongmul).not.toBeNull();

    const rootToDongmul = hierarchyEdge(rootId, dongmul!.conceptId);
    expect(rootToDongmul).not.toBeNull();
    expect(rootToDongmul!.weight).toBe(0.9);
  });

  test("'생물 → 동물 → 고양이' 사슬이 같은 parent_of 엣지로 전부 이어진다(transitive)", async () => {
    const originRoot = await makeOrigin("생물 분류 글");
    const originLeaf = await makeOrigin("고양이 글");

    const rootId = await ensureTypeRootConcept(store, "creature");
    // 생물 → 동물 (타입 루트 연결)
    await linkSubcategoryToTypeRoot(store, originRoot, "creature", "동물");
    // 동물 → 고양이 (기존 엔진 양식 — store.addClassificationTag 그대로)
    await store.addClassificationTag(originLeaf, "동물", "고양이", "user_input", originLeaf);

    const dongmul = await store.findConceptByName("동물");
    const goyangi = await store.findConceptByName("고양이");
    expect(dongmul).not.toBeNull();
    expect(goyangi).not.toBeNull();

    // 사슬 두 단이 같은 hierarchy_edges parent_of 로 전부 이어진다.
    expect(hierarchyEdge(rootId, dongmul!.conceptId)).not.toBeNull(); // 생물 → 동물
    expect(hierarchyEdge(dongmul!.conceptId, goyangi!.conceptId)).not.toBeNull(); // 동물 → 고양이
  });

  test("같은 타입·분류로 두 번 불러도 노드·엣지 중복이 없다(멱등)", async () => {
    const origin = await makeOrigin("생물 분류 글");

    await linkSubcategoryToTypeRoot(store, origin, "creature", "동물");
    await linkSubcategoryToTypeRoot(store, origin, "creature", "동물");

    const rootCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM concept_nodes WHERE name = ?")
        .get("생물") as { n: number }
    ).n;
    const dongmulCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM concept_nodes WHERE name = ?")
        .get("동물") as { n: number }
    ).n;
    expect(rootCount).toBe(1);
    expect(dongmulCount).toBe(1);

    const rootId = (await store.findConceptByName("생물"))!.conceptId;
    const dongmulId = (await store.findConceptByName("동물"))!.conceptId;
    const edgeCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM hierarchy_edges
           WHERE relation = 'parent_of'
             AND source_type = 'concept' AND source_id = ?
             AND target_type = 'concept' AND target_id = ?`,
        )
        .get(rootId, dongmulId) as { n: number }
    ).n;
    expect(edgeCount).toBe(1);
  });

  test("알 수 없는 배치 타입 이름은 식별자와 함께 loud throw 한다", async () => {
    await expect(ensureTypeRootConcept(store, "nonsense")).rejects.toThrow(
      /nonsense/,
    );
    const origin = await makeOrigin("글");
    await expect(
      linkSubcategoryToTypeRoot(store, origin, "nonsense", "동물"),
    ).rejects.toThrow(/nonsense/);
  });
});
