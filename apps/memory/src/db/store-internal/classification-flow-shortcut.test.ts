/**
 * classification-flow-shortcut.test.ts — 위계 지름길 차단(2-(a) 생성 차단 + 2-(b)
 * 소급 제거) 통합 검증. spec docs/decisions/2026-06-13-graph-node-absorption-
 * shortcut-prevention-spec.md §5.2·§8·§9.
 *
 * 실제 bun:sqlite(:memory:) + 실제 SqliteMemoryStore 통합 — Mock 클래스 0.
 * store.addClassificationTag 한 통로로 콜론 사슬·추출기 메타데이터를 다 재현한다
 * (둘 다 addClassificationTagFlow 단일 출처를 지난다).
 *
 * S0-T4(2026-06-14) — 이 흐름의 개념↔개념 위계(parent_of) 쓰기·지름길 차단이
 * 옛 concept_edges 에서 새 단일 출처 hierarchy_edges 로 옮겨졌다. 단정도 그 테이블
 * (source_type='concept' source_id → target_type='concept' target_id)을 직접 읽는다.
 *
 * 검증:
 *   순서 1 — 콜론 사슬 `#장소:병원 #병원:피부과 #피부과:무지개의원` → parent_of 가
 *            장소→병원·병원→피부과·피부과→무지개의원 3쌍만(장소→무지개의원 없음).
 *   순서 2 — `#장소:무지개의원` 직결 먼저 → 그 다음 콜론 사슬 → 소급으로 장소→무지개의원
 *            제거(자가 치유·§5.2.2 시나리오 1).
 *   순서 3 — `#장소:무지개의원` 단독(더 긴 경로 없음) → 직결 유지(과삭제 안 함).
 *   LLM 경로 — addClassificationTag("장소","무지개의원") 후 콜론 사슬 → 소급 제거.
 *   인접 쌍 보존 — 사슬 중간 인접 쌍(병원→피부과)은 안 떼임.
 *   멱등 — 같은 입력 두 번이라도 직결 1회 떼인 뒤 진동 0.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { SqliteMemoryStore } from "../store.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

describe("위계 지름길 차단 — 2-(a) 생성 차단 + 2-(b) 소급 제거", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  /** 한 개념 이름의 conceptId(없으면 null) — 직결 부재 단정에 쓴다. */
  function conceptIdByName(name: string): string | null {
    const row = db
      .prepare("SELECT concept_id FROM concept_nodes WHERE name = ?")
      .get(name) as { concept_id: string } | undefined;
    return row?.concept_id ?? null;
  }

  /** source→target parent_of 직결 위계 엣지가 hierarchy_edges 에 있는지(S0-T4). */
  function hasParentOf(sourceName: string, targetName: string): boolean {
    const s = conceptIdByName(sourceName);
    const t = conceptIdByName(targetName);
    if (!s || !t) return false;
    const row = db
      .prepare(
        `SELECT 1 FROM hierarchy_edges
         WHERE source_type = 'concept' AND source_id = ?
           AND target_type = 'concept' AND target_id = ?
           AND relation = 'parent_of'`,
      )
      .get(s, t);
    return row !== null && row !== undefined;
  }

  /** hierarchy_edges 의 전체 개념 parent_of 엣지를 (source 이름 → target 이름) 쌍 Set 으로. */
  function allParentOfPairs(): Set<string> {
    const rows = db
      .prepare(
        `SELECT s.name AS sname, t.name AS tname
         FROM hierarchy_edges e
         JOIN concept_nodes s ON s.concept_id = e.source_id
         JOIN concept_nodes t ON t.concept_id = e.target_id
         WHERE e.relation = 'parent_of'
           AND e.source_type = 'concept' AND e.target_type = 'concept'`,
      )
      .all() as Array<{ sname: string; tname: string }>;
    return new Set(rows.map((r) => `${r.sname}→${r.tname}`));
  }

  /** 한 콜론 사슬 입력 재현 — 타입 루트 진입 한 단 + 인접 쌍 + 잎. */
  async function applyColonChain(nodeId: number): Promise<void> {
    // 타입 지시 키 `#장소:병원` = 장소→병원, 일반 분류 `#병원:피부과`·`#피부과:무지개의원`.
    await store.addClassificationTag(nodeId, "장소", "병원", "hashtag", nodeId);
    await store.addClassificationTag(nodeId, "병원", "피부과", "hashtag", nodeId);
    await store.addClassificationTag(nodeId, "피부과", "무지개의원", "hashtag", nodeId);
  }

  test("순서 1 — 콜론 사슬만: parent_of 3쌍, 장소→무지개의원 직결 없음", async () => {
    const nodeId = await store.addNode({ content: "5월 12일 무지개의원에서 진료" });
    await applyColonChain(nodeId);

    const pairs = allParentOfPairs();
    expect(pairs.has("장소→병원")).toBe(true);
    expect(pairs.has("병원→피부과")).toBe(true);
    expect(pairs.has("피부과→무지개의원")).toBe(true);
    // 지름길 없음.
    expect(pairs.has("장소→무지개의원")).toBe(false);
    expect(pairs.size).toBe(3);
  });

  test("순서 2 — 직결 먼저 → 콜론 사슬 나중: 장소→무지개의원 소급 제거(자가 치유)", async () => {
    const nodeId = await store.addNode({ content: "무지개의원 첫 등장" });
    // ① 직결 먼저 — 더 긴 경로가 아직 없어 장소→무지개의원 직결이 선다(D1 (A)).
    await store.addClassificationTag(nodeId, "장소", "무지개의원", "hashtag", nodeId);
    expect(hasParentOf("장소", "무지개의원")).toBe(true);

    // ② 나중에 콜론 사슬 — 피부과→무지개의원 이 서는 순간 장소→...→무지개의원 길이 3
    //    경로가 완성돼 2-(b)가 장소→무지개의원 직결을 소급 제거한다.
    await applyColonChain(nodeId);

    const pairs = allParentOfPairs();
    expect(pairs.has("장소→무지개의원")).toBe(false); // 소급 제거됨.
    expect(pairs.has("장소→병원")).toBe(true);
    expect(pairs.has("병원→피부과")).toBe(true);
    expect(pairs.has("피부과→무지개의원")).toBe(true);
    expect(pairs.size).toBe(3); // 사슬 하나만.
  });

  test("순서 3 — 직결 단독(더 긴 경로 없음): 직결 유지(과삭제 안 함)", async () => {
    const nodeId = await store.addNode({ content: "무지개의원 한 번 언급" });
    await store.addClassificationTag(nodeId, "장소", "무지개의원", "hashtag", nodeId);

    // 더 긴 경로가 영영 없으니 직결은 유일 경로라 옳다(D1 (A) — 트리에 보임).
    expect(hasParentOf("장소", "무지개의원")).toBe(true);
    expect(allParentOfPairs().size).toBe(1);
  });

  test("LLM 메타데이터 경로 — addClassificationTag('장소','무지개의원') 후 콜론 사슬 → 소급 제거", async () => {
    const nodeId = await store.addNode({ content: "무지개의원에서 진료받음" });
    // 추출기 통로 재현 — metadata-apply 가 부르는 그 호출(같은 단일 출처).
    await store.addClassificationTag(nodeId, "장소", "무지개의원", "llm_extract", nodeId);
    expect(hasParentOf("장소", "무지개의원")).toBe(true);

    // 나중에 콜론 사슬이 오면 2-(b)가 직결을 떼낸다(P3 자가 치유 — 추출기 별도 배선 0).
    await applyColonChain(nodeId);
    expect(hasParentOf("장소", "무지개의원")).toBe(false);
    expect(allParentOfPairs().size).toBe(3);
  });

  test("2-(a) — 사슬 먼저 선 뒤 추출기 직결 시도: 직결 애초에 안 생김", async () => {
    const nodeId = await store.addNode({ content: "무지개의원 진료 기록" });
    // ① 콜론 사슬 먼저 — 장소→병원→피부과→무지개의원.
    await applyColonChain(nodeId);
    // ② 나중에 추출기가 장소="무지개의원" → 이미 깊이 ≥ 2 후손이라 직결 생성 skip.
    await store.addClassificationTag(nodeId, "장소", "무지개의원", "llm_extract", nodeId);

    expect(hasParentOf("장소", "무지개의원")).toBe(false);
    expect(allParentOfPairs().size).toBe(3); // 사슬 그대로.
  });

  test("과삭제 차단 — 인접 쌍(병원→피부과)·잎(피부과→무지개의원)은 안 떼임", async () => {
    const nodeId = await store.addNode({ content: "무지개의원 진료" });
    await applyColonChain(nodeId);

    // 인접 쌍·잎은 유일 경로라 2-(b)가 손대지 않는다.
    expect(hasParentOf("장소", "병원")).toBe(true);
    expect(hasParentOf("병원", "피부과")).toBe(true);
    expect(hasParentOf("피부과", "무지개의원")).toBe(true);
  });

  test("멱등 — 직결 먼저 + 콜론 사슬을 두 번 쳐도 직결 1회 떼인 뒤 진동 0", async () => {
    const nodeId = await store.addNode({ content: "무지개의원 반복 입력" });
    await store.addClassificationTag(nodeId, "장소", "무지개의원", "hashtag", nodeId);
    await applyColonChain(nodeId);
    const after1 = allParentOfPairs();

    // 같은 입력 한 번 더 — removeHierarchyEdge 가 0 행 no-op, addHierarchyEdge 멱등.
    await applyColonChain(nodeId);
    await store.addClassificationTag(nodeId, "장소", "무지개의원", "llm_extract", nodeId);
    const after2 = allParentOfPairs();

    expect(after2.has("장소→무지개의원")).toBe(false);
    expect(after2.size).toBe(3);
    expect([...after2].sort()).toEqual([...after1].sort()); // 진동 없음.
  });

  test("글-개념 엣지는 직결 skip 갈래에서도 유지된다(글 연결·생명력 보존)", async () => {
    const nodeId = await store.addNode({ content: "무지개의원 방문" });
    await applyColonChain(nodeId); // 무지개의원 개념 생성 + 글 엣지.
    // 추출기 재호출 — 직결은 skip 되지만 글-개념 classification 엣지는 더해진다.
    await store.addClassificationTag(nodeId, "장소", "무지개의원", "llm_extract", nodeId);

    const rainbow = conceptIdByName("무지개의원")!;
    const row = db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM node_concept_edges
         WHERE node_id = ? AND concept_id = ? AND role = 'classification'`,
      )
      .get(nodeId, rainbow) as { cnt: number };
    expect(row.cnt).toBeGreaterThanOrEqual(1); // 글이 무지개의원에 이어져 있다.
  });
});
