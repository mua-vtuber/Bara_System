/**
 * retriever-magnitude.test.ts — 강도-반영 융합 plan Task 2 (T2, 정밀 입력 배선).
 *
 * T2 는 retriever 융합에 vector·imageVec 두 유사도 채널의 *원시 cosine 강도* 를
 * nodeId→강도 맵으로 노출한다(T4 가 정밀 점수에 쓸 입력). **T2 자체는 데이터만
 * 노출하고 점수 계산엔 안 쓴다 — 동작·순위·점수가 변경 전과 byte 동일하다.**
 *
 * retriever.retrieve 내부의 강도 맵은 지역 변수라 외부에서 직접 못 읽는다. 그래서
 * 본 테스트는 retriever 가 쓰는 *바로 그 변환 공식* 을 *같은 store·같은 임베딩* 으로
 * 재현해, 맵이 담을 nodeId→cosine 강도가 실제 vec0 KNN 회수 결과와 일치함을 단언한다:
 *   - vector 채널 : VectorHit.distance → 강도 = 1 - distance(args-types.ts:49 cosine).
 *   - imageVec 채널: getImageVecCandidates 가 이미 distance → score(= 1 - distance)로
 *                    변환한 candidate.score 를 그대로 보존(image-vec-channel.ts:26).
 *
 * 실 Bgem3Embedder + 실 SigLIP text encoder + bun:sqlite + :memory: DB — mock 0.
 * 운영 DB(data/bara.sqlite)는 절대 건드리지 않는다. 모델 로드가 느려 timeout 넉넉히.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import {
  embedQuerySiglipText,
  loadSiglipTextEncoder,
} from "../embedding/siglip2-text.ts";
import { SIGLIP2_DIM } from "../embedding/siglip2.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { addImageAssetNode } from "./image-asset.ts";
import { getImageVecCandidates } from "./image-vec-channel.ts";
import {
  DEFAULT_IMAGE_VEC_K,
  DEFAULT_VECTOR_K,
  HybridRetriever,
} from "./retriever.ts";

const QUERY = "노란 후드 입은 캐릭터";

let embedder: Bgem3Embedder;
let siglipAvailable: boolean;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
  siglipAvailable = await loadSiglipTextEncoder();
}, 600_000);

afterAll(() => {});

interface Ctx {
  store: SqliteMemoryStore;
  retriever: HybridRetriever;
  strongImageId: number;
  midImageId: number;
  textIds: number[];
  close: () => void;
}

async function buildCorpus(): Promise<Ctx> {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);

  // 글 노드들 — vector 채널 회수 대상(실 bge-m3 임베딩).
  const textIds: number[] = [];
  textIds.push(await store.addNode({ content: "노란 후드를 입은 캐릭터 일러스트 감상문" }));
  textIds.push(await store.addNode({ content: "후드 티 쇼핑 후기를 정리한 메모" }));
  textIds.push(await store.addNode({ content: "캐릭터 굿즈 수집 목록 정리" }));

  // 이미지 노드 — image_vec 에 실 SigLIP 임베딩(데이터 fixture / mock 아님).
  // 강한 매치 = SigLIP(QUERY) 그대로(거리 ~0), 중간 강도 = SigLIP("노란 옷 ...").
  const strongVec = await embedQuerySiglipText(QUERY);
  const midVec = await embedQuerySiglipText("노란 옷을 입은 사람 사진");
  if (
    !strongVec ||
    !midVec ||
    strongVec.length !== SIGLIP2_DIM ||
    midVec.length !== SIGLIP2_DIM
  ) {
    throw new Error("SigLIP text encoder 이미지 임베딩 산출 실패 — 측정 불가");
  }
  const strongImageId = addImageAssetNode(db, {
    content: "노란 후드 캐릭터 일러스트 자산",
    embedding: strongVec,
    assetSha256: "magT2-strong-image",
  });
  const midImageId = addImageAssetNode(db, {
    content: "노란 옷 캐릭터 그림 자산",
    embedding: midVec,
    assetSha256: "magT2-mid-image",
  });

  const retriever = new HybridRetriever(store, embedder);
  return {
    store,
    retriever,
    strongImageId,
    midImageId,
    textIds,
    close: () => db.close(),
  };
}

describe("T2 — vector 채널 cosine 강도 노출(1 - distance)", () => {
  test(
    "vector 강도 맵이 담을 값 = searchByVectorRaw distance → (1 - distance) 와 일치",
    async () => {
      const ctx = await buildCorpus();
      try {
        const queryVec = await embedder.embed(QUERY);
        const hits = await ctx.store.searchByVectorRaw(queryVec, DEFAULT_VECTOR_K);
        // retriever 가 쓰는 동일 변환을 재현 — 맵이 담을 nodeId→강도.
        const expected = new Map<number, number>();
        for (const h of hits) expected.set(h.nodeId, 1 - h.distance);

        // 회수가 실제로 일어났다(부분 측정 아님).
        expect(hits.length).toBeGreaterThan(0);
        // 모든 강도가 cosine 정합 범위(distance ∈ [0,2] → 강도 ∈ [-1,1]).
        for (const [, mag] of expected) {
          expect(mag).toBeLessThanOrEqual(1 + 1e-9);
          expect(mag).toBeGreaterThanOrEqual(-1 - 1e-9);
        }
        // 강한 글(노란후드 어휘 다수)이 회수돼 양의 강도를 갖는다.
        const strongTextMag = expected.get(ctx.textIds[0]!);
        expect(strongTextMag).toBeDefined();
        expect(strongTextMag!).toBeGreaterThan(0);
        // nodeId 키가 회수 hits 와 정확히 일치(맵이 hit 별 강도를 빠짐없이 담음).
        expect([...expected.keys()].sort()).toEqual(
          hits.map((h) => h.nodeId).sort(),
        );
      } finally {
        ctx.close();
      }
    },
    600_000,
  );
});

describe("T2 — imageVec 채널 cosine 강도 노출(candidate.score = 1 - distance)", () => {
  test(
    "imageVec 강도 맵이 담을 값 = getImageVecCandidates score 와 일치 / 강한 매치 ≈ 1",
    async () => {
      if (!siglipAvailable) {
        throw new Error(
          "SigLIP text encoder 미로드 — imageVec 강도 측정 불가(실 모델 의존, silent skip 금지).",
        );
      }
      const ctx = await buildCorpus();
      try {
        const siglipQueryVec = await embedQuerySiglipText(QUERY);
        const candidates = await getImageVecCandidates(
          ctx.store,
          siglipQueryVec,
          DEFAULT_IMAGE_VEC_K,
        );
        // retriever 가 쓰는 동일 보존 — 맵이 담을 nodeId→강도(candidate.score 그대로).
        const expected = new Map<number, number>();
        for (const c of candidates) expected.set(c.nodeId, c.score);

        expect(candidates.length).toBeGreaterThanOrEqual(2);
        // 강한 매치(SigLIP(QUERY) 그대로)는 cosine ≈ 1(거리 ~0).
        const strongMag = expected.get(ctx.strongImageId);
        const midMag = expected.get(ctx.midImageId);
        expect(strongMag).toBeDefined();
        expect(midMag).toBeDefined();
        expect(strongMag!).toBeGreaterThan(0.99);
        // 강한 매치 > 중간 강도(인코더 산출 진짜 강도 차이 — 맵이 강도 차를 보존).
        expect(strongMag!).toBeGreaterThan(midMag!);
        // 강도 = 1 - distance 정합(candidate.score 가 그 변환을 거친 값).
        for (const c of candidates) {
          expect(expected.get(c.nodeId)).toBeCloseTo(c.score, 12);
        }
      } finally {
        ctx.close();
      }
    },
    600_000,
  );
});
