/**
 * QueryEmbeddingCache 단위 테스트 — 순수 자료구조 검증(데이터 fixture 만 사용,
 * mock 클래스 없음). "두 번째 호출이 모델을 재실행하지 않는다"의 실제 embedder
 * 통합 단언은 retriever.query-cache.test.ts 에 있다.
 */

import { describe, expect, test } from "bun:test";
import {
  QUERY_EMBEDDING_CACHE_CAPACITY,
  QueryEmbeddingCache,
} from "./query-embedding-cache.ts";

function vec(...values: number[]): Float32Array {
  return new Float32Array(values);
}

describe("QueryEmbeddingCache — 용량 검증", () => {
  test("0·음수·비정수 용량은 명시 throw", () => {
    expect(() => new QueryEmbeddingCache(0)).toThrow(
      "capacity must be a positive integer",
    );
    expect(() => new QueryEmbeddingCache(-1)).toThrow(
      "capacity must be a positive integer",
    );
    expect(() => new QueryEmbeddingCache(1.5)).toThrow(
      "capacity must be a positive integer",
    );
  });

  test("default 용량 상수는 양의 정수", () => {
    expect(Number.isInteger(QUERY_EMBEDDING_CACHE_CAPACITY)).toBe(true);
    expect(QUERY_EMBEDDING_CACHE_CAPACITY).toBeGreaterThan(0);
    expect(() => new QueryEmbeddingCache()).not.toThrow();
  });
});

describe("QueryEmbeddingCache — get/set/stats", () => {
  test("미적중은 undefined + miss 집계, 적중은 값 회신 + hit 집계", () => {
    const cache = new QueryEmbeddingCache(4);
    expect(cache.get("커피")).toBeUndefined();
    expect(cache.stats()).toEqual({ hits: 0, misses: 1, size: 0 });

    cache.set("커피", vec(1, 2, 3));
    const hit = cache.get("커피");
    expect(hit).toEqual(vec(1, 2, 3));
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, size: 1 });
  });

  test("같은 키 재저장은 값을 덮고 size 를 안 늘린다", () => {
    const cache = new QueryEmbeddingCache(4);
    cache.set("커피", vec(1));
    cache.set("커피", vec(9));
    expect(cache.get("커피")).toEqual(vec(9));
    expect(cache.stats().size).toBe(1);
  });
});

describe("QueryEmbeddingCache — 별칭 오염 차단(양방향 복사)", () => {
  test("회신 벡터를 변형해도 캐시 원본은 안 바뀐다", () => {
    const cache = new QueryEmbeddingCache(4);
    cache.set("커피", vec(1, 2, 3));
    const first = cache.get("커피")!;
    first[0] = 999;
    expect(cache.get("커피")).toEqual(vec(1, 2, 3));
  });

  test("set 후 입력 배열을 변형해도 캐시는 안 바뀐다", () => {
    const cache = new QueryEmbeddingCache(4);
    const input = vec(1, 2, 3);
    cache.set("커피", input);
    input[0] = 999;
    expect(cache.get("커피")).toEqual(vec(1, 2, 3));
  });

  test("두 번 get 한 벡터는 서로 다른 배열 인스턴스(공유 별칭 없음)", () => {
    const cache = new QueryEmbeddingCache(4);
    cache.set("커피", vec(1, 2, 3));
    const a = cache.get("커피")!;
    const b = cache.get("커피")!;
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("QueryEmbeddingCache — LRU 방출", () => {
  test("용량 초과 시 가장 오래 안 쓰인 항목이 방출된다", () => {
    const cache = new QueryEmbeddingCache(2);
    cache.set("a", vec(1));
    cache.set("b", vec(2));
    cache.set("c", vec(3)); // a 가 가장 오래됨 → 방출
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toEqual(vec(2));
    expect(cache.get("c")).toEqual(vec(3));
    expect(cache.stats().size).toBe(2);
  });

  test("get 적중이 최근 사용으로 승격해 방출 순서를 바꾼다", () => {
    const cache = new QueryEmbeddingCache(2);
    cache.set("a", vec(1));
    cache.set("b", vec(2));
    cache.get("a"); // a 승격 → 이제 b 가 가장 오래됨
    cache.set("c", vec(3)); // b 방출
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toEqual(vec(1));
    expect(cache.get("c")).toEqual(vec(3));
  });

  test("같은 키 재저장(set)도 승격을 겸한다", () => {
    const cache = new QueryEmbeddingCache(2);
    cache.set("a", vec(1));
    cache.set("b", vec(2));
    cache.set("a", vec(9)); // a 승격 → b 가 가장 오래됨
    cache.set("c", vec(3)); // b 방출
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toEqual(vec(9));
  });

  test("size 는 어떤 삽입 순서에서도 용량을 안 넘는다", () => {
    const cache = new QueryEmbeddingCache(3);
    for (let i = 0; i < 10; i++) cache.set(`q${i}`, vec(i));
    expect(cache.stats().size).toBe(3);
    // 마지막 3개(q7·q8·q9)만 생존.
    expect(cache.get("q6")).toBeUndefined();
    expect(cache.get("q7")).toEqual(vec(7));
    expect(cache.get("q9")).toEqual(vec(9));
  });
});
