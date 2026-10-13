/**
 * memory/eval/bm25-blend-eval.test.ts — BM25 blend + 출처 boost 측정 게이트
 * (공통 인프라 1.1b T4 / DCL-5).
 *
 * flat 코퍼스(embedding-corpus.txt) + runHarness 로 full-rrf variant 의 평균
 * nDCG 를 측정한다. T4 메커니즘(blend + boost)이 운영 default(floor-중립)에서
 * 기준선을 회귀 없이 유지하는지 검증한다.
 *
 * 측정 게이트: flat full-rrf avgNdcg >= 0.90 (bge-m3 재실측 2026-07-10 기반 floor).
 *
 * ## DCL-5 진단 증거 (T5/T6 before-picture)
 *
 * flat 코퍼스는 의미 정답 코퍼스라 FTS bm25() rank-1 노드가 구조적으로 잡음이다.
 * spec 직감 상수(boost bm25 1.08 / cross weight 0.3)는 그 잡음 노드를 우대해
 * 기준선을 깎았다 — 진단 실측:
 *   - 운영 default(blend 1.0/0.0, boost 전부 1.0): full-rrf 0.8882 (기준선 유지)
 *   - spec 직감(boost 1.08/0.96/1.08, cross 0.3)     : full-rrf 0.7967 (-0.0915)
 *   - boost 동등 + cross 0.05 만                      : full-rrf 0.8000 (즉시 하락)
 *   - vector-only 야심 목표                           : full-rrf 0.9272
 *   - enriched 코퍼스도 spec boost 적용 시 하락        : 0.6404 → 0.6218
 *
 * 결론(DCL-5): 운영 default 는 측정으로 검증된 floor-중립값. spec 직감값은
 * BLEND_SWEEP_GRID / GRAPH_BOOST_SWEEP_GRID 에 보존해 T5 가 measured-win gate 로
 * 채택 판단한다.
 *
 * 기준선 이력: 위 DCL-5 진단 수치(0.8882/0.7967/0.9272/0.6404 등)는 Granite
 * embedder 시절 실측이다. 테스트 embedder 가 bge-m3 로 바뀐 뒤 재실측(2026-07-10:
 * full-rrf avgNdcg 0.9029 / avgRecall 0.975)해 게이트 floor 를 현 운영 모델 실측
 * 기반으로 갱신했다 — 진단 수치 자체는 당시 이력으로 보존한다.
 */
import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { runHarness, SWEEP_VARIANTS } from "./harness.ts";

/**
 * flat full-rrf nDCG floor — Granite embedder 시절 실측 0.8882 → bge-m3 재실측
 * 2026-07-10 avgNdcg 0.9029. floor 0.90(여유 0.003) — 큰 회귀만 잡는다.
 */
const FLAT_NDCG_FLOOR = 0.9;

/**
 * flat recall floor — Granite 시절 만점(1.0) → bge-m3 재실측 2026-07-10
 * avgRecall 0.975. floor 0.97 — magnitude-fusion-regression FLAT_RECALL_FLOOR 정합.
 */
const FLAT_RECALL_FLOOR = 0.97;

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

afterAll(() => {});

describe("BM25 blend + 출처 boost 측정 게이트 — flat 코퍼스", () => {
  test("full-rrf avgNdcg 가 bge-m3 실측 floor(0.90)를 유지한다", async () => {
    const snap = await runHarness(embedder, {
      variants: { "full-rrf": SWEEP_VARIANTS["full-rrf"]! },
    });

    const fullRrf = snap.variants.find((v) => v.variant === "full-rrf");
    expect(fullRrf).toBeDefined();

    const { avgNdcg, avgRecall, avgMrr } = fullRrf!;
    console.log(
      `[T4/DCL-5 게이트] 운영 default(floor-중립) full-rrf ` +
        `avgNdcg=${avgNdcg.toFixed(4)} ` +
        `avgRecall=${avgRecall.toFixed(4)} ` +
        `avgMrr=${avgMrr.toFixed(4)}`,
    );
    // DCL-5 진단 증거 — T5/T6 before-picture (값은 commit 시점 진단 실측).
    console.log(
      `[DCL-5 진단] spec 직감 상수(boost 1.08 / cross 0.3) → flat full-rrf 0.7967 ` +
        `(-0.0915) / 중립 default → 0.8882 (기준선 유지) / vector-only 야심 목표 0.9272 ` +
        `/ enriched 도 spec boost 시 하락 0.6404→0.6218`,
    );

    // 측정 게이트: bge-m3 실측 기반 floor. DCL-5 운영 default 는 통과.
    expect(avgNdcg).toBeGreaterThanOrEqual(FLAT_NDCG_FLOOR);
  });

  test("vector-only 기준선 수치 기록 (야심 목표 비교용)", async () => {
    const snap = await runHarness(embedder, {
      variants: {
        "vector-only": SWEEP_VARIANTS["vector-only"]!,
        "full-rrf": SWEEP_VARIANTS["full-rrf"]!,
      },
    });

    const vectorOnly = snap.variants.find((v) => v.variant === "vector-only")!;
    const fullRrf = snap.variants.find((v) => v.variant === "full-rrf")!;

    console.log(
      `[T4 비교] vector-only avgNdcg=${vectorOnly.avgNdcg.toFixed(4)} ` +
        `/ full-rrf avgNdcg=${fullRrf.avgNdcg.toFixed(4)} ` +
        `/ 델타=${(fullRrf.avgNdcg - vectorOnly.avgNdcg).toFixed(4)}`,
    );

    // recall 은 floor 이상 유지돼야 한다(blend 가 회수를 깎으면 안 됨).
    // Granite 시절 만점(1.0) → bge-m3 재실측 2026-07-10 avgRecall 0.975.
    expect(fullRrf.avgRecall).toBeGreaterThanOrEqual(FLAT_RECALL_FLOOR);
  });
});
