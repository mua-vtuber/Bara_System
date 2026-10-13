/**
 * HybridRetriever 질의 임베딩 캐시 통합 테스트.
 *
 * Real bun:sqlite + real Bgem3Embedder. No mocks — "두 번째 호출이 모델을
 * 재실행하지 않았다"는 MockEmbedder 호출 횟수가 아니라 retriever 에 내장된
 * QueryEmbeddingCache 의 hits/misses 카운터로 단언한다(dispatch 계약 방식).
 */

import {
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
import { HybridRetriever } from "./retriever.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

describe("HybridRetriever — 질의 임베딩 LRU 캐시 통합", () => {
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

  test("첫 호출 = miss 1건 — 한 retrieve() 안에서 질의 임베딩은 1회뿐", async () => {
    await store.addNode({ content: "철수는 커피를 좋아한다" });
    await retriever.retrieve("커피");
    // concept·project·person 채널은 같은 queryVec 을 재사용하므로(retriever.ts
    // step 1.5 산출을 인자로 전달) 캐시 통과가 정확히 1회다. imageVec 채널은
    // 별도 SigLIP text 모델(별 벡터 공간)이라 이 캐시 대상이 아니다.
    expect(retriever.queryEmbeddingCache.stats()).toEqual({
      hits: 0,
      misses: 1,
      size: 1,
    });
  });

  test("같은 질의 두 번째 호출은 캐시 적중 — 모델 재실행 없음", async () => {
    const coffeeId = await store.addNode({
      content: "아침마다 에스프레소를 한 잔 마신다",
    });
    await store.addNode({ content: "자전거 타기를 좋아함" });

    // 질의에 "에스프레소"가 없어도 vector 채널이 잡는 의미 매칭 질의 — 캐시가
    // 돌려준 벡터가 실제 KNN 을 통과해 같은 결과를 내는지까지 확인한다.
    const first = await retriever.retrieve("커피 음료 카페인");
    expect(first[0]!.node.id).toBe(coffeeId);
    expect(first[0]!.sources).toContain("vector");

    const second = await retriever.retrieve("커피 음료 카페인");
    expect(second[0]!.node.id).toBe(coffeeId);
    expect(second[0]!.sources).toContain("vector");
    // 두 호출의 노드 순서 동일(캐시 벡터 = 원 계산 벡터).
    expect(second.map((r) => r.node.id)).toEqual(first.map((r) => r.node.id));

    const stats = retriever.queryEmbeddingCache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.size).toBe(1);
  });

  test("다른 질의는 각각 miss — 키는 질의 텍스트 정확 일치", async () => {
    await store.addNode({ content: "철수는 커피를 좋아한다" });
    await retriever.retrieve("커피");
    await retriever.retrieve("자동차");
    expect(retriever.queryEmbeddingCache.stats()).toEqual({
      hits: 0,
      misses: 2,
      size: 2,
    });
  });

  test("캐시 적중 벡터로도 검색 결과가 비어 있지 않고 점수가 유한하다", async () => {
    await store.addNode({ content: "주말에 한강에서 자전거를 탔다" });
    await retriever.retrieve("자전거");
    const results = await retriever.retrieve("자전거");
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) expect(Number.isFinite(r.score)).toBe(true);
    expect(retriever.queryEmbeddingCache.stats().hits).toBe(1);
  });
});
