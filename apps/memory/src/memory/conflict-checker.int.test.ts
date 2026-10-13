/**
 * ConflictChecker 통합 테스트 — 실제 SqliteMemoryStore + 직접 주입한 벡터.
 *
 * 무엇을 검증하나:
 *  - 일반(non-raw) 노드는 충돌 후보를 기록하고 새 진술만 disputed로 표시한다.
 *  - `metadata.preservedRaw === true` 노드는 supersede 대상에서 제외되어
 *    importance가 그대로 유지된다 (status.md #1 데이터 무결성 버그 회귀 가드).
 *  - 같은 검색 쿼리에 raw + normal 두 후보가 같이 잡혀도 normal만 충돌 후보.
 *
 * 왜 임베딩을 직접 주입하나:
 *  - addNode가 args.embedding을 받으면 embedder.embed를 호출하지 않으므로
 *    Bgem3Embedder.load() 없이 (모델 다운로드 없이) 통합 검증이 가능.
 *  - 두 벡터의 cosine sim이 정확히 0.7로 떨어지게 만들 수 있어 conflict band
 *    (bge-m3 기준: 0.55 ≤ sim < 0.85) 안에 결정론적으로
 *    들어간다.
 *  - 기준 스키마 vec_nodes float[1024]·bge-m3 L2-normalized 가정으로 정합
 *    (B4 production cutover, 2026-05-17).
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
import {
  CONFLICT_SIM_HIGH,
  CONFLICT_SIM_LOW,
  ConflictChecker,
  isConflictSimilarity,
} from "./conflict-checker.ts";
import { ExtractionVisibility } from "./extraction-visibility.ts";
import {
  countMemoryVisibilityComputations,
  getMemoryVisibilitySnapshot,
} from "./shared-memory-read.ts";

// bge-m3 차원 — 기준 스키마 vec_nodes float[1024] 와 정합.
const DIM = 1024;

/** 단위 벡터 e_i (i 번째 축만 1.0). */
function basisVector(index: number): Float32Array {
  const v = new Float32Array(DIM);
  v[index] = 1.0;
  return v;
}

/**
 * basis e0와 cosine sim = `targetSim` 인 unit vector.
 *
 * 구성: [targetSim, sqrt(1 - targetSim²), 0, ..., 0].
 * dot product with e0 = targetSim. L2 norm = sqrt(targetSim² + (1-targetSim²)) = 1.
 */
function unitVectorWithSim(targetSim: number): Float32Array {
  if (targetSim < -1 || targetSim > 1) {
    throw new Error(`targetSim out of range: ${targetSim}`);
  }
  const v = new Float32Array(DIM);
  v[0] = targetSim;
  v[1] = Math.sqrt(1 - targetSim * targetSim);
  return v;
}

let embedder: Bgem3Embedder;
let db: Database;
let store: SqliteMemoryStore;
let checker: ConflictChecker;

beforeAll(() => {
  // load() 호출 안 함 — addNode에 embedding 직접 주입할 거라 모델 불필요.
  embedder = new Bgem3Embedder();
});

describe("bge-m3 conflict thresholds", () => {
  test("CONFLICT_SIM_LOW = 0.55", () => {
    expect(CONFLICT_SIM_LOW).toBe(0.55);
  });
  test("CONFLICT_SIM_HIGH = 0.85", () => {
    expect(CONFLICT_SIM_HIGH).toBe(0.85);
  });
  test("sim 0.7은 conflict band 한가운데", () => {
    expect(isConflictSimilarity(0.7)).toBe(true);
  });
  test("sim 0.9는 conflict band 밖", () => {
    expect(isConflictSimilarity(0.9)).toBe(false);
  });
});

afterAll(() => {});

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  checker = new ConflictChecker(store);
});

afterEach(() => {
  db.close();
});

describe("ConflictChecker.check — preservedRaw 보호 (status.md #1 회귀 가드)", () => {
  test("normal 노드만 있을 때: conflict band 진입 시 새 기억 disputed 후보 기록", async () => {
    const sharedVec = basisVector(0);

    const targetId = await store.addNode({
      content: "커피 normal 노드",
      memoryType: "fact",
      sourceType: "user_explicit",
      author: "owner",
      importance: 0.7,
      embedding: sharedVec,
    });

    const newVec = unitVectorWithSim(0.7); // conflict band 한가운데
    const newId = await store.addNode({
      content: "커피 새 사실",
      memoryType: "fact",
      sourceType: "llm_extract",
      author: "owner",
      importance: 0.6,
      embedding: newVec,
    });

    const superseded = await checker.check({
      newNodeId: newId,
      content: "커피",
      author: "owner",
      memoryType: "fact",
      newVector: newVec,
    });

    expect(superseded).toBe(1);
    const target = await store.getNode(targetId);
    expect(target!.importance).toBeCloseTo(0.7, 5);
  });

  test("preservedRaw 노드는 단독 후보일 때도 supersede 되지 않음 + importance 유지", async () => {
    const sharedVec = basisVector(0);

    const rawId = await store.addNode({
      content: "커피 원문 raw",
      memoryType: "fact",
      sourceType: "auto_capture",
      author: "owner",
      importance: 0.4,
      metadata: { preservedRaw: true },
      embedding: sharedVec,
    });

    const newVec = unitVectorWithSim(0.7);
    const newId = await store.addNode({
      content: "커피 새 사실",
      memoryType: "fact",
      sourceType: "llm_extract",
      author: "owner",
      importance: 0.6,
      embedding: newVec,
    });

    const superseded = await checker.check({
      newNodeId: newId,
      content: "커피",
      author: "owner",
      memoryType: "fact",
      newVector: newVec,
    });

    expect(superseded).toBe(0);
    const raw = await store.getNode(rawId);
    expect(raw!.importance).toBeCloseTo(0.4, 5);
    expect(raw!.metadata.preservedRaw).toBe(true);
  });

  test("raw + normal 둘 다 후보: normal만 충돌 후보, raw는 보호", async () => {
    const sharedVec = basisVector(0);

    const rawId = await store.addNode({
      content: "커피 원문 raw",
      memoryType: "fact",
      sourceType: "auto_capture",
      author: "owner",
      importance: 0.4,
      metadata: { preservedRaw: true },
      embedding: sharedVec,
    });

    const normalId = await store.addNode({
      content: "커피 normal 사실",
      memoryType: "fact",
      sourceType: "llm_extract",
      author: "owner",
      importance: 0.7,
      embedding: sharedVec,
    });

    const newVec = unitVectorWithSim(0.7);
    const newId = await store.addNode({
      content: "커피 새 사실",
      memoryType: "fact",
      sourceType: "llm_extract",
      author: "owner",
      importance: 0.6,
      embedding: newVec,
    });

    const superseded = await checker.check({
      newNodeId: newId,
      content: "커피",
      author: "owner",
      memoryType: "fact",
      newVector: newVec,
    });

    expect(superseded).toBe(1);
    const raw = await store.getNode(rawId);
    expect(raw!.importance).toBeCloseTo(0.4, 5);
    const normal = await store.getNode(normalId);
    expect(normal!.importance).toBeCloseTo(0.7, 5);
  });

  test("매 사이클마다 호출되어도 raw importance 누적 감소 없음 (silent decay 회귀 가드)", async () => {
    const sharedVec = basisVector(0);

    const rawId = await store.addNode({
      content: "커피 원문 raw",
      memoryType: "fact",
      sourceType: "auto_capture",
      author: "owner",
      importance: 0.4,
      metadata: { preservedRaw: true },
      embedding: sharedVec,
    });

    for (let i = 0; i < 5; i++) {
      const newVec = unitVectorWithSim(0.7);
      const newId = await store.addNode({
        content: `커피 비슷한 사실 ${i}`,
        memoryType: "fact",
        sourceType: "llm_extract",
        author: "owner",
        importance: 0.6,
        embedding: newVec,
      });
      await checker.check({
        newNodeId: newId,
        content: "커피",
        author: "owner",
        memoryType: "fact",
        newVector: newVec,
      });
    }

    const raw = await store.getNode(rawId);
    // 버그가 살아있던 시절엔 0.4 × 0.7^5 ≈ 0.0672 로 떨어졌다.
    expect(raw!.importance).toBeCloseTo(0.4, 5);
  });
});

describe("ConflictChecker.check — project 스코프", () => {
  test("같은 author라도 project가 다르면 supersede 하지 않는다", async () => {
    const oldVec = basisVector(0);
    const oldId = await store.addNode({
      content: "커피 프로젝트별 사실",
      memoryType: "fact",
      sourceType: "llm_extract",
      author: "owner",
      importance: 0.7,
      embedding: oldVec,
      project_id: "prj_a",
    });

    const newVec = unitVectorWithSim(0.7);
    const newId = await store.addNode({
      content: "커피 프로젝트별 새 사실",
      memoryType: "fact",
      sourceType: "llm_extract",
      author: "owner",
      importance: 0.6,
      embedding: newVec,
      project_id: "prj_b",
    });

    const superseded = await checker.check({
      newNodeId: newId,
      content: "커피 프로젝트별",
      author: "owner",
      memoryType: "fact",
      newVector: newVec,
      projectId: "prj_b",
    });

    expect(superseded).toBe(0);
    expect((await store.getNode(oldId))!.importance).toBeCloseTo(0.7, 5);
  });

  test("같은 author + 같은 project면 기존 conflict 동작 유지", async () => {
    const oldVec = basisVector(0);
    const oldId = await store.addNode({
      content: "커피 프로젝트별 사실",
      memoryType: "fact",
      sourceType: "llm_extract",
      author: "owner",
      importance: 0.7,
      embedding: oldVec,
      project_id: "prj_same",
    });

    const newVec = unitVectorWithSim(0.7);
    const newId = await store.addNode({
      content: "커피 프로젝트별 새 사실",
      memoryType: "fact",
      sourceType: "llm_extract",
      author: "owner",
      importance: 0.6,
      embedding: newVec,
      project_id: "prj_same",
    });

    const superseded = await checker.check({
      newNodeId: newId,
      content: "커피 프로젝트별",
      author: "owner",
      memoryType: "fact",
      newVector: newVec,
      projectId: " prj_same ",
    });

    expect(superseded).toBe(1);
    expect((await store.getNode(oldId))!.importance).toBeCloseTo(0.7, 5);
  });
});

describe("ConflictChecker.check — revision 이력 기록 (Phase 7 ④)", () => {
  test("supersede 1건마다 memory_revisions 에 manual 후보 revision 1건 기록", async () => {
    const sharedVec = basisVector(0);

    const oldId = await store.addNode({
      content: "커피 옛 사실",
      memoryType: "fact",
      sourceType: "user_explicit",
      author: "owner",
      importance: 0.7,
      embedding: sharedVec,
    });

    const targetSim = 0.7; // conflict band 한가운데
    const newVec = unitVectorWithSim(targetSim);
    const newId = await store.addNode({
      content: "커피 새 사실",
      memoryType: "fact",
      sourceType: "llm_extract",
      author: "owner",
      importance: 0.6,
      embedding: newVec,
    });

    const superseded = await checker.check({
      newNodeId: newId,
      content: "커피",
      author: "owner",
      memoryType: "fact",
      newVector: newVec,
    });

    expect(superseded).toBe(1);

    const revisions = await store.getRevisionsForNode(oldId);
    expect(revisions.length).toBe(1);
    const rev = revisions[0]!;
    expect(rev.revisionType).toBe("manual");
    expect(rev.oldNodeId).toBe(oldId);
    expect(rev.newNodeId).toBe(newId);
    // similarityScore 는 실제 측정된 cosine sim (구성상 0.7 근방).
    expect(rev.similarityScore).toBeCloseTo(targetSim, 5);
    expect(rev.reason).toContain("충돌 후보");
  });

  test("후보로 잡혀도 sim 이 band 밖이면 → superseded 0 → revision 0", async () => {
    // FTS 로는 "커피" 후보로 잡히되, 벡터는 무관 축(e5)이라 새 노드(e0)와
    // cosine sim 0 → conflict band 밖 → supersede·기록 둘 다 안 함.
    const unrelatedVec = basisVector(5);
    const unrelatedId = await store.addNode({
      content: "커피 무관 사실",
      memoryType: "fact",
      sourceType: "user_explicit",
      author: "owner",
      importance: 0.7,
      embedding: unrelatedVec,
    });

    const newVec = basisVector(0);
    const newId = await store.addNode({
      content: "커피 새 사실",
      memoryType: "fact",
      sourceType: "llm_extract",
      author: "owner",
      importance: 0.6,
      embedding: newVec,
    });

    const superseded = await checker.check({
      newNodeId: newId,
      content: "커피",
      author: "owner",
      memoryType: "fact",
      newVector: newVec,
    });

    expect(superseded).toBe(0);
    expect((await store.getRevisionsForNode(unrelatedId)).length).toBe(0);
    expect((await store.getRevisionsForNode(newId)).length).toBe(0);
  });
});

describe("ConflictChecker.check — 추출 가시성 보기 (WP-B1-07, SL-8)", () => {
  test("넘긴 보기로 후보를 판정하고 스냅샷을 다시 계산하지 않는다 — admit 한 노드만 허용이 늘어난다", async () => {
    // 스냅샷을 먼저 잡고 그 뒤에 넣은 노드는 스냅샷에 없다 — 보기가 admit 해야 후보가 된다.
    const snapshot = getMemoryVisibilitySnapshot(store);
    const targetId = await store.addNode({
      content: "커피 스냅샷 뒤 노드",
      memoryType: "fact",
      sourceType: "user_explicit",
      author: "owner",
      importance: 0.7,
      embedding: basisVector(0),
    });
    const newVec = unitVectorWithSim(0.7);
    const newId = await store.addNode({
      content: "커피 새 사실",
      memoryType: "fact",
      sourceType: "llm_extract",
      author: "owner",
      importance: 0.6,
      embedding: newVec,
    });
    const args = { newNodeId: newId, content: "커피", author: "owner", memoryType: "fact" as const, newVector: newVec };
    const before = countMemoryVisibilityComputations(store);

    expect(await checker.check({ ...args, visibility: new ExtractionVisibility(store, snapshot) })).toBe(0);
    const admitted = new ExtractionVisibility(store, snapshot);
    admitted.admit(targetId);
    expect(await checker.check({ ...args, visibility: admitted })).toBe(1);
    expect(countMemoryVisibilityComputations(store) - before).toBe(0);
  });
});
