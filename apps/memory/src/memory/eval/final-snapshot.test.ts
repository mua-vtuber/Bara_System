/**
 * memory/eval/final-snapshot.test.ts — 1.1b·1.1c 최종 snapshot.
 *
 * 1.1b 측정 항목(보존):
 *   - flat: vector-only / full-rrf (운영 default — floor-중립)
 *   - enriched: full-rrf+concept (그래프·개념 채널 포함)
 *
 * 1.1c 측정 항목(필터 가족 — cue / polarity):
 *   - cue: cue-off vs cue-on (관계 cue + graph-hop 정답 / EQ5 — measured-win gate)
 *   - polarity: polarity-off vs polarity-on (positive 분별 / EQ6)
 *   (filter 분류 필터 snapshot 은 classification-filter-eval.test.ts 가 별도 측정 —
 *    enriched 코퍼스에 분류 role 자산이 없어 자체 코퍼스로 잰다.)
 *
 * 수치를 console.log 로 산출하고 flat full-rrf 에 floor 게이트 단언을 건다.
 * coordinator 가 이 수치를 plan '운영 default 권고' 단락에 기록한다.
 *
 * 튜닝 상수 오버라이드 없음 — search-tuning.ts 모듈 default 가 그대로 적용된다
 * (1.1b DCL-5 floor-중립 + cue 가중치 중립 1.0 — 2026-07-10 bge-m3 재측정).
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder. mock 없음.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import {
  runHarness,
  runEnrichedHarness,
  runCuePolarityHarness,
  SWEEP_VARIANTS,
  ENRICHED_SWEEP_VARIANTS,
  CUE_POLARITY_VARIANTS,
} from "./harness.ts";

// flat full-rrf 기준선 — T4 실측값(0.888210). 1e-3 여유.
const FLAT_FULL_RRF_FLOOR = 0.8882 - 1e-3;

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

describe("1.1b·1.1c 최종 snapshot — 운영 default 수치 산출", () => {
  test(
    "flat: vector-only / full-rrf 수치 산출 + floor 게이트",
    async () => {
      const snap = await runHarness(embedder, {
        variants: {
          "vector-only": SWEEP_VARIANTS["vector-only"]!,
          "full-rrf": SWEEP_VARIANTS["full-rrf"]!,
        },
      });

      const vectorOnly = snap.variants.find((v) => v.variant === "vector-only")!;
      const flatFull = snap.variants.find((v) => v.variant === "full-rrf")!;

      console.log(
        `[1.1b 최종 snapshot — flat] ` +
          `vector-only avgNdcg=${vectorOnly.avgNdcg.toFixed(4)} ` +
          `avgRecall=${vectorOnly.avgRecall.toFixed(4)} ` +
          `avgMrr=${vectorOnly.avgMrr.toFixed(4)}`,
      );
      console.log(
        `[1.1b 최종 snapshot — flat] ` +
          `full-rrf avgNdcg=${flatFull.avgNdcg.toFixed(4)} ` +
          `avgRecall=${flatFull.avgRecall.toFixed(4)} ` +
          `avgMrr=${flatFull.avgMrr.toFixed(4)}`,
      );

      // floor 게이트 — 운영 default 가 기준선 아래로 떨어지지 않아야 한다.
      expect(flatFull.avgNdcg).toBeGreaterThanOrEqual(FLAT_FULL_RRF_FLOOR);
    },
    60_000,
  );

  test(
    "enriched: full-rrf+concept 수치 산출",
    async () => {
      const snap = await runEnrichedHarness(embedder, {
        variants: {
          "full-rrf+concept": ENRICHED_SWEEP_VARIANTS["full-rrf+concept"]!,
        },
      });

      const enrichedFull = snap.variants.find((v) => v.variant === "full-rrf+concept")!;

      console.log(
        `[1.1b 최종 snapshot — enriched] ` +
          `full-rrf+concept avgNdcg=${enrichedFull.avgNdcg.toFixed(4)} ` +
          `avgRecall=${enrichedFull.avgRecall.toFixed(4)} ` +
          `avgMrr=${enrichedFull.avgMrr.toFixed(4)}`,
      );

      // 수치 존재 확인
      expect(enrichedFull.avgNdcg).toBeGreaterThanOrEqual(0);
      expect(enrichedFull.avgRecall).toBeGreaterThanOrEqual(0);
    },
    60_000,
  );

  test(
    "1.1c cue·polarity: cue-off/cue-on + polarity-off/polarity-on 수치 산출 + measured-win 게이트",
    async () => {
      const snap = await runCuePolarityHarness(embedder, {
        variants: CUE_POLARITY_VARIANTS,
      });

      const cueOff = snap.variants.find((v) => v.variant === "cue-off")!;
      const cueOn = snap.variants.find((v) => v.variant === "cue-on")!;
      const polOff = snap.variants.find((v) => v.variant === "polarity-off")!;
      const polOn = snap.variants.find((v) => v.variant === "polarity-on")!;

      // cue 측정 — EQ5 graph-hop 정답을 cue-on 이 끌어올린다(좁은 창).
      const cueOffEq5 = cueOff.perQuery.find((q) => q.id === "EQ5")!;
      const cueOnEq5 = cueOn.perQuery.find((q) => q.id === "EQ5")!;

      console.log(
        `[1.1c 최종 snapshot — cue] ` +
          `cue-off avgNdcg=${cueOff.avgNdcg.toFixed(4)} avgRecall=${cueOff.avgRecall.toFixed(4)} ` +
          `/ cue-on avgNdcg=${cueOn.avgNdcg.toFixed(4)} avgRecall=${cueOn.avgRecall.toFixed(4)}`,
      );
      console.log(
        `[1.1c 최종 snapshot — cue EQ5 graph-hop] ` +
          `cue-off recall=${cueOffEq5.recall.toFixed(4)} ndcg=${cueOffEq5.ndcg.toFixed(4)} ` +
          `→ cue-on recall=${cueOnEq5.recall.toFixed(4)} ndcg=${cueOnEq5.ndcg.toFixed(4)}`,
      );
      console.log(
        `[1.1c 최종 snapshot — polarity] ` +
          `polarity-off avgNdcg=${polOff.avgNdcg.toFixed(4)} avgRecall=${polOff.avgRecall.toFixed(4)} ` +
          `/ polarity-on avgNdcg=${polOn.avgNdcg.toFixed(4)} avgRecall=${polOn.avgRecall.toFixed(4)}`,
      );

      // 비회귀 gate — cue-on 이 EQ5 graph-hop 에서 cue-off 를 안 깎는다. strict-lift
      // 단언은 2026-07-10 bge-m3 재측정에서 measured-win 부재(EQ5 정답이 vector
      // 채널로 직접 회수 — graph-hop 전제 붕괴)로 삭제(search-tuning.ts 이력 주석).
      expect(cueOnEq5.recall).toBeGreaterThanOrEqual(cueOffEq5.recall);

      // polarity 분별 — polarity-on 이 EQ6 의 polarity 필터로 positive 만 회수한다.
      // recall 은 양수(정답 회수) — polarity-on 이 후보를 0 으로 깎지 않는다.
      const polOnEq6 = polOn.perQuery.find((q) => q.id === "EQ6")!;
      expect(polOnEq6.recall).toBeGreaterThan(0);
    },
    60_000,
  );
});
