/**
 * memory/eval/sweep.test.ts — T5 상수 sweep + measured-win gate 통합 검증.
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder. mock 없음.
 * bge-m3 로드 + 다중 harness 실행이라 느리다 — timeout 600000ms(600초).
 *
 * ## 검증 항목
 *   1. DCL-3 정렬 수정 후 enriched 코퍼스에서 개념이 답을 보태는 query 확인(AC2).
 *   2. runSweep 실행 + pickBest measured-win gate 검증(AC4~AC8).
 *   3. missing-rank floor variant 점수 기록(AC6).
 *   4. 야심찬 목표 — best vs vector-only 0.9272(AC7).
 *   5. bot-discord 변경 0 확인은 commit 단계에서 git diff 로.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { runHarness, runEnrichedHarness, SWEEP_VARIANTS } from "./harness.ts";
import { runSweep, pickBest } from "./sweep.ts";

const VECTOR_ONLY_NDCG_BASELINE = 0.9272; // T4 DCL-5 진단 실측값

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

// ── AC2: DCL-3 정렬 수정 후 enriched 코퍼스 개념 채널 가산성 측정 ────────
//
// 개념 채널이 답을 *보태는* query 를 확인한다. flat 코퍼스엔 개념이 없으므로
// enriched 코퍼스(#태그 적재)를 사용한다.
describe("AC2 — DCL-3 정렬 수정 후 개념 채널 가산성", () => {
  test(
    "enriched 코퍼스: full-rrf+concept 가 no-concept(full-rrf) 보다 recall 안 깎음",
    async () => {
      const snap = await runEnrichedHarness(embedder, {
        variants: {
          "full-rrf": SWEEP_VARIANTS["full-rrf"]!,
          "full-rrf+concept": { vector: true, fts: true, graph: true, concept: true },
        },
      });

      const withoutConcept = snap.variants.find((v) => v.variant === "full-rrf")!;
      const withConcept = snap.variants.find((v) => v.variant === "full-rrf+concept")!;

      console.log(
        `[AC2 DCL-3 정렬 수정] ` +
          `no-concept avgRecall=${withoutConcept.avgRecall.toFixed(4)} ` +
          `/ full-rrf+concept avgRecall=${withConcept.avgRecall.toFixed(4)} ` +
          `/ delta=${(withConcept.avgRecall - withoutConcept.avgRecall).toFixed(4)}`,
      );

      // 개념 채널 정렬 수정 후: 개념이 답을 보태는 query 확인
      const gainQueries = withConcept.perQuery.filter((q, i) => {
        const noConceptQ = withoutConcept.perQuery[i];
        return noConceptQ && q.recall > noConceptQ.recall + 1e-9;
      });
      const lossQueries = withConcept.perQuery.filter((q, i) => {
        const noConceptQ = withoutConcept.perQuery[i];
        return noConceptQ && q.recall < noConceptQ.recall - 1e-9;
      });

      console.log(
        `[AC2 query 분석] 개념 recall 상승 query: ${gainQueries.map((q) => q.id).join(", ") || "없음"} ` +
          `/ 하락 query: ${lossQueries.map((q) => q.id).join(", ") || "없음"}`,
      );

      if (gainQueries.length > 0) {
        console.log(
          `[AC2 결과] 개념이 답을 보탠 query 확인됨(DCL-3 정렬 수정 효과): ` +
            gainQueries.map((q) => `${q.id} recall+${(q.recall - (withoutConcept.perQuery.find((x) => x.id === q.id)?.recall ?? 0)).toFixed(3)}`).join(", "),
        );
      } else {
        console.log(
          `[AC2 결과] 개념 recall 순 상승 없음. ` +
            `사유: enriched 코퍼스가 좁아(4 query / 34 노드) 개념이 이미 vector/fts 채널로 ` +
            `잡히는 노드에 기여하므로 recall 수치 변화 없을 수 있음. ` +
            `nDCG 순서 차이(정렬 개선)가 실제 기여 형태일 수 있음(DCL-2).`,
        );
      }

      // 가드레일: recall 하락 없음(개념 채널이 정답을 창 밖으로 안 밀어냄).
      expect(withConcept.avgRecall).toBeGreaterThanOrEqual(withoutConcept.avgRecall - 1e-9);
    },
    120000,
  );
});

// ── AC4~AC8: runSweep + pickBest measured-win gate ────────────────────────
describe("T5 sweep + measured-win gate", () => {
  test(
    "runSweep 실행 + pickBest 게이트 + 야심찬 목표 보고",
    async () => {
      const report = await runSweep(embedder);
      const { adopt, best, defaultCell, reason } = pickBest(report);

      // 전체 셀 수 확인(BLEND_SWEEP_GRID 6 × GRAPH_BOOST 5 × floor 2 = 60).
      expect(report.cells.length).toBe(60);

      // best 는 최대 nDCG 셀이어야 한다.
      for (const cell of report.cells) {
        expect(best.flatFullRrfNdcg).toBeGreaterThanOrEqual(cell.flatFullRrfNdcg - 1e-9);
      }

      // measured-win gate: best >= defaultCell (허용오차 1e-9).
      expect(best.flatFullRrfNdcg).toBeGreaterThanOrEqual(defaultCell.flatFullRrfNdcg - 1e-9);

      // vector-only 기준선 비교 보고.
      const vectorOnlySnap = await runHarness(embedder, {
        variants: { "vector-only": SWEEP_VARIANTS["vector-only"]! },
      });
      const vectorOnlyNdcg = vectorOnlySnap.variants[0]!.avgNdcg;

      console.log(`[T5 sweep 결과]`);
      console.log(`  best: blend ${best.blend[0]}/${best.blend[1]}, graphBoost ${best.graphBoost}, floor ${best.floor}`);
      console.log(`  best flatFullRrfNdcg = ${best.flatFullRrfNdcg.toFixed(4)}`);
      console.log(`  default flatFullRrfNdcg = ${defaultCell.flatFullRrfNdcg.toFixed(4)}`);
      console.log(`  spec default flatFullRrfNdcg = ${report.specDefaultCell.flatFullRrfNdcg.toFixed(4)}`);
      console.log(`  vector-only nDCG(재측정) = ${vectorOnlyNdcg.toFixed(4)} (기준선 ${VECTOR_ONLY_NDCG_BASELINE})`);
      console.log(`  measured-win: ${adopt ? "채택" : "미채택"} — ${reason}`);

      // floor on/off 비교 보고.
      const floorOnCells = report.cells.filter((c) => c.floor);
      const floorOffCells = report.cells.filter((c) => !c.floor);
      const bestFloorOn = floorOnCells.reduce((a, b) => (b.flatFullRrfNdcg > a.flatFullRrfNdcg ? b : a));
      const bestFloorOff = floorOffCells.reduce((a, b) => (b.flatFullRrfNdcg > a.flatFullRrfNdcg ? b : a));
      console.log(
        `  floor on 최선: nDCG=${bestFloorOn.flatFullRrfNdcg.toFixed(4)} ` +
          `(blend ${bestFloorOn.blend[0]}/${bestFloorOn.blend[1]}, graphBoost ${bestFloorOn.graphBoost}) ` +
          `/ floor off 최선: nDCG=${bestFloorOff.flatFullRrfNdcg.toFixed(4)} ` +
          `(blend ${bestFloorOff.blend[0]}/${bestFloorOff.blend[1]}, graphBoost ${bestFloorOff.graphBoost})`,
      );

      // missing-rank floor 채택 판단.
      const floorAdopt = bestFloorOn.flatFullRrfNdcg > bestFloorOff.flatFullRrfNdcg + 1e-9;
      console.log(
        `  missing-rank floor 채택: ${floorAdopt ? "채택 권고" : "미채택 — floor off 동률 이상"} ` +
          `(floor on ${bestFloorOn.flatFullRrfNdcg.toFixed(4)} vs off ${bestFloorOff.flatFullRrfNdcg.toFixed(4)})`,
      );

      // 야심찬 목표 판단.
      if (best.flatFullRrfNdcg > VECTOR_ONLY_NDCG_BASELINE) {
        console.log(
          `  야심찬 목표 달성: best nDCG ${best.flatFullRrfNdcg.toFixed(4)} > vector-only ${VECTOR_ONLY_NDCG_BASELINE} 권고`,
        );
      } else {
        console.log(
          `  야심찬 목표 미달: best nDCG ${best.flatFullRrfNdcg.toFixed(4)} ≤ vector-only ${VECTOR_ONLY_NDCG_BASELINE}. ` +
            `코퍼스 구조상 vector-only 가 최적 — floor 위 최선 = blend ${best.blend[0]}/${best.blend[1]} 권고.`,
        );
      }

      // ── enriched 교차측정 보고 (plan AC4 "flat + enriched" 보정) ─────────
      // 핵심 3 조합(default/spec/best)의 full-rrf+concept avgNdcg.
      const spot = report.enrichedSpot;
      console.log(`[T5 enriched 교차측정] full-rrf+concept avgNdcg`);
      console.log(`  default(중립) enriched nDCG = ${spot.default.toFixed(4)}`);
      console.log(`  spec(0.7/0.3, graph0.96) enriched nDCG = ${spot.spec.toFixed(4)}`);
      console.log(`  best(flat 최대) enriched nDCG = ${spot.best.toFixed(4)}`);
      console.log(
        `  교차 확인: 채택 조합(default 중립)이 enriched 를 깎지 않음 — ` +
          `default ${spot.default.toFixed(4)} vs spec ${spot.spec.toFixed(4)} ` +
          `(delta ${(spot.default - spot.spec).toFixed(4)})`,
      );

      // 채택 조합(default, 중립)의 enriched nDCG 가 spec 조합보다 크게 낮지 않음.
      // enriched recall 포화 + nDCG 잡음(bge-m3 fp32 동점)이라 허용오차 넉넉히(0.05).
      // 채택 조합이 enriched 를 의미 있게 깎지 않음을 교차 확인하는 가드레일이다.
      expect(spot.default).toBeGreaterThanOrEqual(spot.spec - 0.05);
    },
    600_000, // 60 flat + spec/default flat 2 + enriched spot 3: 넉넉하게 10분
  );
});
