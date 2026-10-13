/**
 * runAutoCleanup 단위 테스트 — Phase 5.7.3 W2.
 *
 * 옛 evolver.test.ts 안 단계 1+2+3+5 단위 모방. 단계 4 (purgeOldArchive +
 * soonToPurgeCount) 단위는 trash-manager.test.ts 가 담당하므로 본 파일에서
 * 제외.
 *
 * 결정성 확보 전략 = evolver.test.ts 와 동일:
 *  - Bgem3Embedder.load() 호출 안 함 — addNode 에 embedding 직접 주입.
 *  - last_accessed_at 직접 UPDATE — Date.now() 의존 없이 오래된 노드 재현.
 *  - unit vector 직접 주입으로 cosine sim 값 결정론적 제어.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { runAutoCleanup } from "./auto-cleanup-runner.ts";

// bge-m3 임베딩 dim — 기준 스키마 vec_nodes float[1024] 와 정합.
const DIM = 1024;

/** 단위 벡터 e_i (i번째 축만 1.0). */
function basisVector(index: number): Float32Array {
  const v = new Float32Array(DIM);
  v[index] = 1.0;
  return v;
}

/**
 * basis e0 와 cosine sim = `targetSim` 인 unit vector.
 * 구성: [targetSim, sqrt(1 - targetSim²), 0, ..., 0].
 */
function unitVectorWithSim(targetSim: number): Float32Array {
  const v = new Float32Array(DIM);
  v[0] = targetSim;
  v[1] = Math.sqrt(1 - targetSim * targetSim);
  return v;
}

/**
 * e0-e1 평면 안 각도 `angleRad` 의 unit vector — e0 와 cosine sim =
 * cos(angleRad), 두 평면 벡터끼리 sim = cos(각도 차). 세 노드 이상의
 * 짝별 sim 을 결정론적으로 갈라 배치할 때 쓴다.
 */
function planeUnitVector(angleRad: number): Float32Array {
  const v = new Float32Array(DIM);
  v[0] = Math.cos(angleRad);
  v[1] = Math.sin(angleRad);
  return v;
}

let embedder: Bgem3Embedder;
let db: Database;
let store: SqliteMemoryStore;

beforeAll(() => {
  embedder = new Bgem3Embedder(); // load() 호출 안 함 — embedding 직접 주입
});

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
});

afterEach(() => {
  db.close();
});

describe("runAutoCleanup", () => {
  test("빈 DB 가동 시 summary = clusterEdgesAdded:0 + nodesArchived:0 + durationMs 측정값", async () => {
    const summary = await runAutoCleanup(store, { valueThreshold: 0.05 });

    expect(summary.clusterEdgesAdded).toBe(0);
    expect(summary.nodesArchived).toBe(0);
    expect(typeof summary.startedAt).toBe("string");
    expect(summary.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof summary.durationMs).toBe("number");
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("임계값 이하 노드 → 휴지통 이동 + 활동 로그 한 줄 추가", async () => {
    // 1년 전 접근 + 낮은 importance = 가치 점수 임계값 이하
    const past = new Date(Date.now() - 365 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    const id = await store.addNode({
      content: "낡은 메모",
      memoryType: "fact",
      importance: 0.3,
      embedding: basisVector(0),
    });
    db.prepare("UPDATE knowledge_nodes SET last_accessed_at = ? WHERE id = ?").run(past, id);

    const summary = await runAutoCleanup(store, { valueThreshold: 0.05 });

    expect(summary.nodesArchived).toBe(1);
    expect(await store.getNode(id)).toBeNull();
    expect((await store.getArchive())[0]!.id).toBe(id);

    // 활동 로그 한 줄 들어감 (source='auto-cleanup' 라벨)
    const acts = await store.getEvolverActivity(5);
    expect(acts.length).toBeGreaterThanOrEqual(1);
    expect(acts[0]!.nodesArchived).toBe(1);
  });

  test("preservedRaw 노드는 임계값 이하라도 보호", async () => {
    const past = new Date(Date.now() - 365 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    const id = await store.addNode({
      content: "원문 raw",
      memoryType: "fact",
      sourceType: "auto_capture",
      importance: 0.3,
      metadata: { preservedRaw: true },
      embedding: basisVector(0),
    });
    db.prepare("UPDATE knowledge_nodes SET last_accessed_at = ? WHERE id = ?").run(past, id);

    const summary = await runAutoCleanup(store, { valueThreshold: 0.05 });

    expect(summary.nodesArchived).toBe(0);
    expect(await store.getNode(id)).not.toBeNull();
  });

  test("sim 범위 [0.84, 0.99) 안 노드 짝에 related_to 엣지 추가 (bge-m3 시프트)", async () => {
    // e0 = basisVector(0), unitVectorWithSim(0.9) = [0.9, sqrt(0.19), 0...]
    // dot product = 0.9 → 클러스터 sim 범위 [0.84, 0.99) 안 (bge-m3 시프트)
    const aId = await store.addNode({
      content: "노드 A",
      memoryType: "fact",
      embedding: basisVector(0),
    });
    const bId = await store.addNode({
      content: "노드 B",
      memoryType: "fact",
      embedding: unitVectorWithSim(0.9),
    });

    const summary = await runAutoCleanup(store);

    expect(summary.clusterEdgesAdded).toBe(1);
    const edges = db
      .prepare(
        "SELECT * FROM knowledge_edges WHERE relation = 'related_to' AND source_id IN (?, ?)",
      )
      .all(aId, bId) as Array<Record<string, unknown>>;
    expect(edges).toHaveLength(1);
  });

  test("summary 안 nodesPurged + soonToPurgeCount 필드 X (단계 4 분리)", async () => {
    // 35일 된 archive 노드를 미리 넣어두고 → runAutoCleanup 이 영구 삭제 호출
    // 안 하는지 검증 (= 영구 삭제는 trash-manager.ts 가 담당).
    const oldId = await store.addNode({
      content: "옛 archive 노드",
      importance: 0.1,
      embedding: basisVector(5),
    });
    await store.trashNodes([oldId], "cascade");
    db.prepare("UPDATE knowledge_nodes_archive SET archived_at = ? WHERE id = ?").run(
      new Date(Date.now() - 35 * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 19)
        .replace("T", " "),
      oldId,
    );

    const summary = await runAutoCleanup(store);

    // AutoCleanupActivitySummary 안 nodesPurged + soonToPurgeCount 필드 X
    expect((summary as unknown as Record<string, unknown>).nodesPurged).toBeUndefined();
    expect((summary as unknown as Record<string, unknown>).soonToPurgeCount).toBeUndefined();

    // 35일 된 archive 노드 = 그대로 잔존 (영구 삭제 안 함)
    const archive = await store.getArchive();
    expect(archive.find((n) => n.id === oldId)).toBeDefined();
  });

  test("valueThreshold 옵션 — 임계값 0 = 어떤 노드도 휴지통 이동 X", async () => {
    const past = new Date(Date.now() - 365 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    const id = await store.addNode({
      content: "낡은 메모",
      memoryType: "fact",
      importance: 0.3,
      embedding: basisVector(0),
    });
    db.prepare("UPDATE knowledge_nodes SET last_accessed_at = ? WHERE id = ?").run(past, id);

    const summary = await runAutoCleanup(store, { valueThreshold: 0 });

    expect(summary.nodesArchived).toBe(0);
    expect(await store.getNode(id)).not.toBeNull();
  });

  test("clusterSimLow/clusterSimHigh 옵션 — 좁힌 범위에 sim 0.9 노드 짝 제외", async () => {
    const aId = await store.addNode({
      content: "노드 A",
      memoryType: "fact",
      embedding: basisVector(0),
    });
    const bId = await store.addNode({
      content: "노드 B",
      memoryType: "fact",
      embedding: unitVectorWithSim(0.9),
    });

    // [0.95, 0.99) 안 sim 0.9 = 범위 밖 → 엣지 0
    const summary = await runAutoCleanup(store, {
      clusterSimLow: 0.95,
      clusterSimHigh: 0.99,
    });

    expect(summary.clusterEdgesAdded).toBe(0);
    const edges = db
      .prepare(
        "SELECT * FROM knowledge_edges WHERE relation = 'related_to' AND source_id IN (?, ?)",
      )
      .all(aId, bId) as Array<Record<string, unknown>>;
    expect(edges).toHaveLength(0);
  });

  test("kNN 클러스터 — sim 범위 안 짝만 이어지고, 짝당 엣지 1개(역방향 중복 0) + source<target 정규화", async () => {
    // e0-e1 평면 각도 배치: A=0°, B=+acos(0.9)≈25.84°, C=−acos(0.85)≈−31.79°.
    // sim(A,B)=0.9(범위 안), sim(A,C)=0.85(범위 안),
    // sim(B,C)=cos(57.63°)≈0.535(범위 밖) — 짝별 판정이 갈리는 3노드 배치.
    const aId = await store.addNode({
      content: "노드 A",
      memoryType: "fact",
      embedding: planeUnitVector(0),
    });
    const bId = await store.addNode({
      content: "노드 B",
      memoryType: "fact",
      embedding: planeUnitVector(Math.acos(0.9)),
    });
    const cId = await store.addNode({
      content: "노드 C",
      memoryType: "fact",
      embedding: planeUnitVector(-Math.acos(0.85)),
    });

    const summary = await runAutoCleanup(store);

    // 범위 안 짝 = (A,B), (A,C) 둘. B-C 는 범위 밖.
    expect(summary.clusterEdgesAdded).toBe(2);
    const edges = db
      .prepare(
        "SELECT source_id, target_id FROM knowledge_edges WHERE relation = 'related_to' ORDER BY source_id, target_id",
      )
      .all() as Array<{ source_id: number; target_id: number }>;
    // kNN 은 짝을 양방향으로 두 번 방문하지만 min→max 정규화로 행은 짝당 1개.
    expect(edges).toHaveLength(2);
    expect(edges).toEqual([
      { source_id: aId, target_id: bId },
      { source_id: aId, target_id: cId },
    ]);
    for (const e of edges) {
      expect(e.source_id).toBeLessThan(e.target_id);
    }
  });

  test("kNN 클러스터 — 다른 (memoryType, platform) 그룹이면 sim 범위 안이라도 엣지 X", async () => {
    await store.addNode({
      content: "discord 글",
      memoryType: "fact",
      platform: "discord",
      embedding: basisVector(0),
    });
    await store.addNode({
      content: "telegram 글",
      memoryType: "fact",
      platform: "telegram",
      embedding: unitVectorWithSim(0.9),
    });
    await store.addNode({
      content: "preference 글",
      memoryType: "preference",
      platform: "discord",
      embedding: unitVectorWithSim(0.85),
    });

    const summary = await runAutoCleanup(store);

    expect(summary.clusterEdgesAdded).toBe(0);
    const count = db
      .prepare(
        "SELECT COUNT(*) AS c FROM knowledge_edges WHERE relation = 'related_to'",
      )
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  test("kNN 클러스터 — 두 사이클 재가동에도 DB 엣지 행은 짝당 1개 유지 (INSERT OR IGNORE)", async () => {
    await store.addNode({
      content: "노드 A",
      memoryType: "fact",
      embedding: basisVector(0),
    });
    await store.addNode({
      content: "노드 B",
      memoryType: "fact",
      embedding: unitVectorWithSim(0.9),
    });

    await runAutoCleanup(store);
    await runAutoCleanup(store);

    const count = db
      .prepare(
        "SELECT COUNT(*) AS c FROM knowledge_edges WHERE relation = 'related_to'",
      )
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  test("페이지네이션 — pageSize 초과 노드도 조용히 빠지지 않고 정리 대상에 든다", async () => {
    const past = new Date(Date.now() - 365 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    // 5개 노드, pageSize=2 → 3페이지 순회. 서로 직교 basis 라 클러스터 엣지 0.
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await store.addNode({
          content: `노드 ${i}`,
          memoryType: "fact",
          importance: 0.9,
          embedding: basisVector(i * 2),
        }),
      );
    }
    // 마지막(5번째) 노드만 낡은 저가치 — 옛 상한 방식이면 페이지 밖에서 누락될 자리.
    const lastId = ids[4]!;
    db.prepare("UPDATE knowledge_nodes SET importance = 0.3, last_accessed_at = ? WHERE id = ?").run(
      past,
      lastId,
    );

    const summary = await runAutoCleanup(store, { valueThreshold: 0.05, pageSize: 2 });

    expect(summary.nodesArchived).toBe(1);
    expect(await store.getNode(lastId)).toBeNull();
    expect((await store.getArchive())[0]!.id).toBe(lastId);
  });

  test("페이지네이션 — 페이지 경계를 넘는 sim 범위 안 짝도 kNN 으로 이어진다", async () => {
    // A(1페이지)와 E(3페이지)가 sim 0.9 짝. 사이 3개는 직교 basis(무관).
    const aId = await store.addNode({
      content: "노드 A",
      memoryType: "fact",
      embedding: basisVector(0),
    });
    for (let i = 0; i < 3; i++) {
      await store.addNode({
        content: `무관 노드 ${i}`,
        memoryType: "fact",
        embedding: basisVector(10 + i * 2),
      });
    }
    const eId = await store.addNode({
      content: "노드 E",
      memoryType: "fact",
      embedding: unitVectorWithSim(0.9),
    });

    const summary = await runAutoCleanup(store, { pageSize: 2 });

    expect(summary.clusterEdgesAdded).toBe(1);
    const edges = db
      .prepare(
        "SELECT source_id, target_id FROM knowledge_edges WHERE relation = 'related_to'",
      )
      .all() as Array<{ source_id: number; target_id: number }>;
    expect(edges).toEqual([{ source_id: aId, target_id: eId }]);
  });

  test("pageSize 0 이하·비정수 = 구체 에러 throw (조용한 무한루프·무처리 방지)", async () => {
    await expect(runAutoCleanup(store, { pageSize: 0 })).rejects.toThrow(
      /pageSize must be a positive integer/,
    );
    await expect(runAutoCleanup(store, { pageSize: 1.5 })).rejects.toThrow(
      /pageSize must be a positive integer/,
    );
  });
});
