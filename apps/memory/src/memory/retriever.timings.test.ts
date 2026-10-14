/**
 * retriever 단계별 시간(timings) 통합 테스트 — 실제 SQLite + 실제 bge-m3.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { HybridRetriever } from "./retriever.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

describe("HybridRetriever — 단계별 timings", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let retriever: HybridRetriever;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    retriever = new HybridRetriever(store, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("결과가 있으면 모든 단계 칸이 숫자, totalMs 는 단계 합 이상", async () => {
    await store.addNode({ content: "철수는 커피를 좋아한다" });
    const { results, timings } = await retriever.retrieveWithStats("커피");
    expect(results.length).toBeGreaterThan(0);
    const stages = [
      timings.prepMs,
      timings.planMs,
      timings.embedMs,
      timings.vectorFtsMs,
      timings.conceptMs,
      timings.imageVecMs,
      timings.projectMs,
      timings.personMs,
      timings.graphMs,
      timings.scoreMs,
      timings.touchMs,
    ];
    for (const s of stages) expect(typeof s).toBe("number");
    const sum = stages.reduce<number>((a, s) => a + (s as number), 0);
    expect(timings.totalMs).toBeGreaterThanOrEqual(sum - 1);
    expect(timings.embedCacheHit).toBe(false);
  });

  test("같은 질의 두 번째는 embedCacheHit true", async () => {
    await store.addNode({ content: "철수는 커피를 좋아한다" });
    await retriever.retrieveWithStats("커피");
    const second = await retriever.retrieveWithStats("커피");
    expect(second.timings.embedCacheHit).toBe(true);
  });

  test("결과 0건으로 일찍 끝난 길은 scoreMs·touchMs 가 null", async () => {
    const { results, timings } = await retriever.retrieveWithStats("커피");
    expect(results).toEqual([]);
    expect(timings.scoreMs).toBeNull();
    expect(timings.touchMs).toBeNull();
    expect(typeof timings.prepMs).toBe("number");
    expect(typeof timings.planMs).toBe("number");
    expect(typeof timings.embedMs).toBe("number");
    expect(typeof timings.totalMs).toBe("number");
  });
});
