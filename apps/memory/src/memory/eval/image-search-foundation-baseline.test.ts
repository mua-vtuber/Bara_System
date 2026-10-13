/**
 * image-search-foundation-baseline.test.ts — image-search-foundation Task 6
 * (c-C0): 검색 코어(RRF 유사도 정렬)를 바꾸는 T7(C1) *전* 회귀 기준선을 고정한다.
 *
 * 이 task 는 코어를 *바꾸지 않는다* — 측정·snapshot 만 산출한다. 세 가지:
 *
 *  1. 글 검색 nDCG·recall baseline (C0 게이트 핵심) — 기존 harness.ts 의
 *     runHarness 를 *호출만* 해 flat full-rrf nDCG 가 기준선 floor 를 유지함을
 *     단언한다. 11e 정착 기준값 0.8882(final-snapshot T4 실측 0.888210)는 Granite
 *     embedder 시절 실측이고, 테스트 embedder bge-m3 전환 후 2026-07-10 재실측
 *     0.9029 기반 floor 로 갱신했다(상수 주석 참조). a/b(T1·T5)는 글 검색을 안
 *     건드리므로 이 값은 그대로여야 한다 — C1 이 비교할 baseline.
 *
 *  2. a/b 효과 — 이미지가 연결검색(개념 채널)에 합류함을 입증(spec §12.4). 작은
 *     데이터 fixture 코퍼스에 image_asset 노드 + 그 이미지에 연결된 개념 엣지
 *     (role='visual'/'tag')를 넣고, 같은 개념에 연결된 글도 넣는다. 그 개념을
 *     검색하면 image_asset 노드가 검색 결과(concept 채널)에 합류함을 단언한다.
 *     a/b 가 §8.5 의 "이미지는 외톨이 노드라 연결검색에 못 낀다" 갭을 해소했음을
 *     정량으로 보인다. image_vec 임베딩은 768-dim 데이터 fixture(순수
 *     Float32Array — mock 클래스 아님)다.
 *
 *  3. 이미지 0건 검색 snapshot 고정 — 글만 있는 코퍼스에서 retrieve 결과(상위 K
 *     노드 id·점수 순서)를 결정론적 문자열로 직렬화해 단언한다. T7(C1)이 (c)
 *     변경 후 이 글-only 결과가 byte 동일(글 검색 회귀 0)임을 비교할 대상이다.
 *
 * 실 Bgem3Embedder + bun:sqlite + :memory: DB — mock 0. 운영 DB(data/bara.sqlite)
 * 는 절대 건드리지 않는다(모든 적재는 :memory:). 신규 측정자(새 harness·새 nDCG
 * 구현)는 만들지 않는다 — 기존 harness·11e baseline 을 재사용한다. 코어
 * (rrf.ts/search-tuning.ts/retriever.ts)·봇은 0줄 변경 — 이 파일만 추가한다.
 *
 * 모델 로드가 느려 timeout 넉넉히(600000ms).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../retriever.ts";
import type { RetrievalResult } from "../retriever.ts";
import { runHarness, loadCorpus, SWEEP_VARIANTS } from "./harness.ts";
import { EVAL_QUERIES } from "./answer-map.ts";

/** flat 글 코퍼스 — 운영 default(full-rrf) 검색을 재는 텍스트 자산(11e 정합). */
const FLAT_CORPUS_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "test-fixtures",
  "sandbox",
  "embedding-corpus.txt",
);

/**
 * flat full-rrf 기준선 floor — Granite embedder 시절 실측 0.888210(final-snapshot
 * T4 / 11e baseline 0.8882) → 테스트 embedder bge-m3 전환 후 재실측 2026-07-10
 * avgNdcg 0.9029. floor 0.90(여유 0.003) — 글 검색이 이 floor 아래로 떨어지면
 * 회귀(a/b 가 글 검색을 건드렸다는 신호 — T7 의 C1 회귀 게이트가 비교할 baseline).
 */
const FLAT_FULL_RRF_FLOOR = 0.9;

/**
 * flat recall floor — Granite 시절 만점(1.0) → bge-m3 재실측 2026-07-10
 * avgRecall 0.975. floor 0.97 — magnitude-fusion-regression FLAT_RECALL_FLOOR 정합.
 */
const FLAT_RECALL_FLOOR = 0.97;

/** 측정 창 — final-snapshot / 11e baseline 과 같은 20. */
const FLAT_LIMIT = 20;

/** SigLIP 2 base-256 image_vec 차원(기준 스키마 image_vec / concept_siglip_vec). */
const SIGLIP_DIM = 768;

/**
 * 검색 결과를 byte 비교용 결정론적 문자열로 직렬화한다(11e serializeRanking 정합).
 *
 * 신규 metric 이 아니라 단순 직렬화다 — 노드 id 순서와 score(소수점 12 단위 고정)와
 * sources 만 한 줄씩 적는다. 부동소수 score 를 toFixed 로 고정해 같은 입력이면
 * 항상 같은 문자열이 나온다. T7(C1) 적용 후 글-only 결과를 같은 직렬화로 만들어
 * 이 기준점과 byte 동일 비교한다(글 검색 회귀 0 게이트).
 */
function serializeRanking(results: ReadonlyArray<RetrievalResult>): string {
  return results
    .map((r) => `${r.node.id}|${r.score.toFixed(12)}|${r.sources.join(",")}`)
    .join("\n");
}

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
}, 600_000);

afterAll(() => {});

// ── 1. 글 검색 nDCG·recall baseline (C0 게이트 핵심 / C1 비교 대상) ────────────

describe("T6 C0 — 글 검색 nDCG·recall baseline (기존 harness 재사용)", () => {
  test(
    "flat 글 코퍼스 full-rrf nDCG 가 bge-m3 실측 floor(0.90)를 유지한다",
    async () => {
      // 기존 runHarness 를 호출만 — 신규 측정자 0(T6 acceptance).
      const snap = await runHarness(embedder, {
        variants: {
          "vector-only": SWEEP_VARIANTS["vector-only"]!,
          "full-rrf": SWEEP_VARIANTS["full-rrf"]!,
        },
      });

      const vectorOnly = snap.variants.find((v) => v.variant === "vector-only")!;
      const flatFull = snap.variants.find((v) => v.variant === "full-rrf")!;

      console.log(
        `[T6 C0 baseline — flat] vector-only ` +
          `nDCG=${vectorOnly.avgNdcg.toFixed(4)} recall=${vectorOnly.avgRecall.toFixed(4)} ` +
          `MRR=${vectorOnly.avgMrr.toFixed(4)}`,
      );
      console.log(
        `[T6 C0 baseline — flat] full-rrf ` +
          `nDCG=${flatFull.avgNdcg.toFixed(4)} recall=${flatFull.avgRecall.toFixed(4)} ` +
          `MRR=${flatFull.avgMrr.toFixed(4)} (C1 비교 baseline)`,
      );

      // a/b 는 글 검색을 안 건드리므로 floor 그대로여야 한다(C1 회귀 게이트).
      expect(flatFull.avgNdcg).toBeGreaterThanOrEqual(FLAT_FULL_RRF_FLOOR);
      // 글 검색 recall 은 floor 이상 유지(이미지 합류가 글 정답을 창 밖으로 안
      // 밀어냄). Granite 시절 만점(1.0) → bge-m3 재실측 2026-07-10 avgRecall 0.975.
      expect(flatFull.avgRecall).toBeGreaterThanOrEqual(FLAT_RECALL_FLOOR);
      // 모든 query 가 채점됐다(부분 측정 아님).
      expect(flatFull.perQuery.length).toBe(EVAL_QUERIES.length);
    },
    600_000,
  );
});

// ── 2. a/b 효과 — 이미지가 연결검색(개념 채널)에 합류함을 입증(spec §12.4) ─────

describe("T6 C0 — a/b 효과: 이미지가 개념 엣지로 연결검색에 합류한다", () => {
  /**
   * 한 dim 에 1, 나머지 0 인 768-dim 단위벡터(데이터 fixture — image_vec 적재용).
   * a/b 입증에는 image_vec KNN 이 필요 없지만(개념 채널만 측정), image_asset
   * 노드가 image_vec 행 없이도 자연스럽게 적재되도록 fixture 로 둔다(11b 정합).
   */
  function unitAt(dim: number): Float32Array {
    const v = new Float32Array(SIGLIP_DIM);
    v[dim] = 1;
    return v;
  }

  /**
   * fixture 코퍼스를 :memory: store 에 적재한다(운영 DB 불변경). 구성:
   *  - 글 노드 "노란색 캐릭터 일러스트 감상" — 개념 '노란색'에 role='tag' 로 연결.
   *  - image_asset 노드(image_vec fixture 동반) — 같은 '노란색' 개념에 role='visual'
   *    로 연결. a/b(T1 평면 태그 + T5 SigLIP 자동 개념 연결)가 만드는 엣지를 직접
   *    재현해, "이미지가 개념 채널로 연결검색에 합류함" 을 측정한다.
   *
   * addNodeConceptEdge / findOrCreateTagConcept 는 운영 store API 그대로 — 우회 0.
   */
  async function buildAbCorpus(): Promise<{
    store: SqliteMemoryStore;
    retriever: HybridRetriever;
    imageNodeId: number;
    textNodeId: number;
    close: () => void;
  }> {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);

    // 글 노드 — '노란색' 개념에 연결될 글.
    const textNodeId = await store.addNode({
      content: "노란색 캐릭터 일러스트 감상",
    });
    // image_asset 노드 — 같은 '노란색' 개념에 role='visual' 로 연결(T5 재현).
    const imageNodeId = await store.addNode({
      content: "노란 옷 캐릭터 그림 자산",
      sourceType: "image_asset",
    });
    // image_vec fixture 적재(11b image_asset 양식 정합 — KNN 채널 자연 동반).
    db.run("INSERT INTO image_vec(node_id, embedding) VALUES (?, ?)", [
      imageNodeId,
      unitAt(0),
    ]);

    // 개념 '노란색' — 글(role='tag')·이미지(role='visual') 둘 다 연결.
    const yellowConceptId = await store.findOrCreateTagConcept("노란색");
    await store.addNodeConceptEdge(textNodeId, yellowConceptId, "tag", "user_input", textNodeId);
    await store.addNodeConceptEdge(imageNodeId, yellowConceptId, "visual", "user_input", imageNodeId);

    const retriever = new HybridRetriever(store, embedder);
    return {
      store,
      retriever,
      imageNodeId,
      textNodeId,
      close: () => db.close(),
    };
  }

  test(
    "'노란색' 검색 시 image_asset 노드가 concept 채널로 연결검색에 합류한다",
    async () => {
      const ctx = await buildAbCorpus();
      try {
        // 채널 격리 — vector·fts·imageVec 를 끄고 graph·concept 만 켠다. image_asset
        // 노드도 content 글이 있어 vector 채널엔 잡히므로, 그 채널을 켜두면 "개념
        // 엣지 덕에 합류" 라는 인과가 임베딩 매칭과 섞인다(§8.5 의 갭은 *연결검색*
        // 채널이지 vector 임베딩이 아니다). graph·concept 만 남기면 합류 원인이
        // 개념 엣지 단 하나로 좁혀져 a/b 효과를 깨끗이 측정한다.
        const results = await ctx.retriever.retrieve("노란색", {
          limit: FLAT_LIMIT,
          channelMask: {
            vector: false,
            fts: false,
            graph: true,
            concept: true,
            imageVec: false,
          },
        });

        const imageResult = results.find((r) => r.node.id === ctx.imageNodeId);
        const textResult = results.find((r) => r.node.id === ctx.textNodeId);

        console.log(
          `[T6 C0 a/b 효과] 검색 "노란색"(graph·concept 만) → 결과 ${results.length}건. ` +
            `image_asset(id=${ctx.imageNodeId}) 합류=${imageResult !== undefined} ` +
            `sources=[${imageResult?.sources.join(",") ?? "없음"}] ` +
            `score=${imageResult?.score.toFixed(6) ?? "없음"}`,
        );
        if (textResult) {
          console.log(
            `[T6 C0 a/b 효과] 같은 개념 글(id=${ctx.textNodeId}) 합류 ` +
              `sources=[${textResult.sources.join(",")}] score=${textResult.score.toFixed(6)}`,
          );
        }

        // 핵심 단언 — image_asset 노드가 연결검색 결과에 합류했다(§8.5 갭 해소).
        expect(imageResult).toBeDefined();
        expect(imageResult!.node.sourceType).toBe("image_asset");
        // 합류 원인이 개념 채널 단 하나다(vector·fts·imageVec 전부 껐으므로).
        expect(imageResult!.sources).toEqual(["concept"]);
        // 같은 개념에 연결된 글도 같은 인과로 함께 합류한다(개념 채널 교차 확인).
        expect(textResult).toBeDefined();
        expect(textResult!.sources).toContain("concept");
      } finally {
        ctx.close();
      }
    },
    600_000,
  );

  test(
    "이미지에 개념 엣지가 없으면(a/b 전 상태) 연결검색에 못 낀다 (대조)",
    async () => {
      // §8.5 의 옛 상태 재현 — 개념 엣지가 없는 외톨이 image_asset 노드는 개념
      // 채널이 회수하지 못한다. a/b 가 더한 엣지가 합류의 원인임을 대조로 보인다.
      const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
      try {
        const store = new SqliteMemoryStore(db, embedder);
        // 개념 '노란색' + 그 개념에 연결된 글만 둔다.
        const textNodeId = await store.addNode({
          content: "노란색 캐릭터 일러스트 감상",
        });
        const yellowConceptId = await store.findOrCreateTagConcept("노란색");
        await store.addNodeConceptEdge(textNodeId, yellowConceptId, "tag", "user_input", textNodeId);

        // 외톨이 image_asset — 어떤 개념 엣지도 없다(a/b 전 상태).
        const orphanImageId = await store.addNode({
          content: "분류 안 된 그림 자산",
          sourceType: "image_asset",
        });
        db.run("INSERT INTO image_vec(node_id, embedding) VALUES (?, ?)", [
          orphanImageId,
          unitAt(3),
        ]);

        const retriever = new HybridRetriever(store, embedder);
        // 같은 채널 격리(graph·concept 만) — image_asset content 글이 vector 채널엔
        // 잡히므로 그 채널을 켜두면 인과가 흐려진다. §8.5 의 갭은 *연결검색* 채널이라
        // 거기서만 측정한다. 개념 엣지가 없는 외톨이는 이 두 채널이 못 회수해야 옳다.
        const results = await retriever.retrieve("노란색", {
          limit: FLAT_LIMIT,
          channelMask: {
            vector: false,
            fts: false,
            graph: true,
            concept: true,
            imageVec: false,
          },
        });

        const orphan = results.find((r) => r.node.id === orphanImageId);
        console.log(
          `[T6 C0 a/b 대조] 개념 엣지 없는 외톨이 image_asset(id=${orphanImageId}) ` +
            `합류=${orphan !== undefined} (graph·concept 만) — a/b 전이라 연결검색 미합류가 옳다`,
        );

        // 개념 엣지가 없으면 연결검색 채널이 못 회수한다(a/b 전 §8.5 외톨이 상태).
        expect(orphan).toBeUndefined();
      } finally {
        db.close();
      }
    },
    600_000,
  );
});

// ── 3. 이미지 0건 글-only 검색 snapshot 고정 (T7 C1 회귀 비교 대상) ────────────

describe("T6 C0 — 이미지 0건 글-only 검색 snapshot (C1 byte 동일 비교 대상)", () => {
  /**
   * 글만 적재한 :memory: store + retriever. image_asset 노드가 0건이라 imageVec
   * 채널은 빈 배열이고, 검색 결과에 image_asset 이 절대 섞이지 않는다. 이 글-only
   * 결과가 T7(C1) 의 (c) 유사도 정렬 변경 전후 byte 동일이어야 한다(글 검색
   * 회귀 0 — C1 회귀 게이트가 비교할 대상).
   */
  async function buildFlatTextOnly(): Promise<{
    retriever: HybridRetriever;
    close: () => void;
  }> {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    await loadCorpus(store, FLAT_CORPUS_PATH); // 글만 — image_asset 0건.
    const retriever = new HybridRetriever(store, embedder);
    return { retriever, close: () => db.close() };
  }

  test(
    "글-only retrieve 결과가 결정론적이고 image_asset 0건이다 (byte 동일 기준점)",
    async () => {
      const a = await buildFlatTextOnly();
      let serializedA = "";
      const imageContaminated: boolean[] = [];
      try {
        const lines: string[] = [];
        for (const q of EVAL_QUERIES) {
          const results = await a.retriever.retrieve(q.query, {
            limit: FLAT_LIMIT,
          });
          // 글만 적재했으니 어떤 결과도 image_asset/image_caption 이 아니다.
          imageContaminated.push(
            results.some(
              (r) =>
                r.node.sourceType === "image_asset" ||
                r.node.sourceType === "image_caption",
            ),
          );
          // imageVec 채널이 후보를 0개 합류했으니 sources 에 imageVec 가 없다.
          imageContaminated.push(
            results.some((r) => r.sources.includes("imageVec")),
          );
          lines.push(`### ${q.id} ${q.query}`);
          lines.push(serializeRanking(results));
        }
        serializedA = lines.join("\n");
      } finally {
        a.close();
      }

      // 이미지가 단 한 query 에서도 섞이지 않았다(글-only 검색이라 0건이 옳다).
      expect(imageContaminated.every((x) => x === false)).toBe(true);

      // 결정론 확인 — 같은 코퍼스·같은 query 를 두 번째 store 로 다시 돌리면 byte 동일.
      const b = await buildFlatTextOnly();
      let serializedB = "";
      try {
        const lines: string[] = [];
        for (const q of EVAL_QUERIES) {
          const results = await b.retriever.retrieve(q.query, {
            limit: FLAT_LIMIT,
          });
          lines.push(`### ${q.id} ${q.query}`);
          lines.push(serializeRanking(results));
        }
        serializedB = lines.join("\n");
      } finally {
        b.close();
      }

      expect(serializedB).toBe(serializedA);

      // 기준점을 콘솔에 산출 — T7(C1) 후 같은 직렬화와 byte 동일 비교(글 회귀 0).
      console.log(
        `[T6 C0 이미지 0건 snapshot] ${EVAL_QUERIES.length} query / ` +
          `직렬화 길이=${serializedA.length}자 / image_asset·imageVec 0건 / 결정론 OK ` +
          `(C1 byte 동일 비교 대상)`,
      );
    },
    600_000,
  );
});
