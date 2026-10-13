/**
 * image-vec-channel.test.ts — Phase 11b T5.
 *
 * fake store(인터페이스 가짜 구현체 X — 함수 한 가지 한 한 stub 양식 / 옛 T4
 * storeStub 양식 정합)로 단위 검증. 실제 vec0 호출 양식 정합은 통합 검증.
 */

import { describe, test, expect } from "bun:test";
import {
  getImageVecCandidates,
  type ImageVecCandidate,
} from "./image-vec-channel.ts";
import { collectImageVecChannel } from "./retrieve-channels.ts";
import type { ResolvedRetrieveConfig } from "./retrieve-config.ts";
import type { SqliteMemoryStore } from "../db/store.ts";

/** searchImageVec 한 함수 한 한 stub — 옛 storeStub 양식. */
function makeStub(
  rows: Array<{ nodeId: number; distance: number }>,
): SqliteMemoryStore {
  return {
    async searchImageVec(_vec: Float32Array, _k: number) {
      return rows;
    },
  } as unknown as SqliteMemoryStore;
}

describe("getImageVecCandidates", () => {
  test("queryEmbedding=null → 빈 candidates (graceful degrade)", async () => {
    const store = makeStub([{ nodeId: 1, distance: 0.1 }]);
    const result = await getImageVecCandidates(store, null, 10);
    expect(result).toEqual([]);
  });

  test("topK<=0 → 빈 candidates", async () => {
    const store = makeStub([{ nodeId: 1, distance: 0.1 }]);
    const vec = new Float32Array(768);
    const result = await getImageVecCandidates(store, vec, 0);
    expect(result).toEqual([]);
  });

  test("한 가지 결과 → rank=1, score = 1 - distance", async () => {
    const store = makeStub([{ nodeId: 42, distance: 0.2 }]);
    const vec = new Float32Array(768);
    const result = await getImageVecCandidates(store, vec, 10);
    expect(result).toHaveLength(1);
    expect(result[0]!.nodeId).toBe(42);
    expect(result[0]!.rank).toBe(1);
    expect(result[0]!.score).toBeCloseTo(0.8, 6);
  });

  test("여러 결과 → rank 1..N 차례 정합", async () => {
    const store = makeStub([
      { nodeId: 10, distance: 0.05 },
      { nodeId: 20, distance: 0.15 },
      { nodeId: 30, distance: 0.40 },
    ]);
    const vec = new Float32Array(768);
    const result = await getImageVecCandidates(store, vec, 10);
    expect(result).toHaveLength(3);
    expect(result.map((c: ImageVecCandidate) => c.rank)).toEqual([1, 2, 3]);
    expect(result.map((c) => c.nodeId)).toEqual([10, 20, 30]);
    expect(result[0]!.score).toBeCloseTo(0.95, 6);
    expect(result[2]!.score).toBeCloseTo(0.6, 6);
  });

  test("빈 store 결과 → 빈 candidates", async () => {
    const store = makeStub([]);
    const vec = new Float32Array(768);
    const result = await getImageVecCandidates(store, vec, 10);
    expect(result).toEqual([]);
  });
});

describe("collectImageVecChannel", () => {
  test("image_vec row 0개 → SigLIP text encoder 로드 전 빈 채널", async () => {
    const store = {
      hasImageVecRows() {
        return false;
      },
      async searchImageVec(_vec: Float32Array, _k: number) {
        throw new Error("searchImageVec should not run when image_vec is empty");
      },
    } as unknown as SqliteMemoryStore;
    const config = {
      imageVecK: 20,
      mask: {
        vector: true,
        fts: true,
        graph: true,
        concept: true,
        imageVec: true,
        project: true,
        person: true,
      },
    } as ResolvedRetrieveConfig;

    const result = await collectImageVecChannel(store, "노란후드", config);

    expect(result.ids).toEqual([]);
    expect(result.magnitude.size).toBe(0);
  });
});
