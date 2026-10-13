/**
 * reranker-eval.test.ts — R5 reranker measured-win gate (Phase 6b T7 / spec 11.2·11.3.1).
 *
 * 목적: harness 에 +reranker variant 를 더해, full-rrf 결과(운영 default = 중립
 * RRF + cue)를 실제 cross-encoder(bge-reranker-v2-m3-ONNX)로 재정렬한 뒤의
 * nDCG/recall/MRR 을 flat·enriched 두 코퍼스에서 측정한다. measured-win gate
 * (sweep.ts pickBest 패턴)로 "reranker 를 켜면 운영 default 대비 nDCG 가 오르나?"
 * 를 판정하고, 그 숫자로 reranker.enabled default ON/OFF 를 결정한다.
 *
 * 측정 정신(spec 11.2): OFF 는 *측정으로 확인된 보수적 default* 이지 측정 전
 * 추측이 아니다. 1.1b DCL-5 / 1.1c 가 두 코퍼스의 vector-only recall 포화를
 * 보였으므로 post-RRF 단계(reranker 포함)가 점수를 못 올릴 수 있다 — 그러면
 * default OFF 가 *옳은* 결과다. 숫자를 꾸며내 ON 으로 모는 일은 금지.
 *
 * 실 bge-m3 + 실 bge-reranker + bun:sqlite + :memory: DB — mock 0. 운영 DB
 * (data/bara.sqlite) 불변경. 모델 로드 + 재정렬이 느려 timeout 넉넉히(600000ms).
 *
 * 모델 부재 시(T4 선행이라 정상은 가용) — available=false 면 측정이 BLOCKED 다.
 * 가짜 점수를 만들지 않고 단언으로 실패시켜 BLOCKED 를 드러낸다.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { Reranker } from "../reranker.ts";
import {
  runHarness,
  runEnrichedHarness,
  runRerankerVariant,
  runEnrichedRerankerVariant,
  rerankerMeasuredWin,
  SWEEP_VARIANTS,
  ENRICHED_SWEEP_VARIANTS,
  DEFAULT_ENRICHED_RETRIEVAL_LIMIT,
} from "./harness.ts";

/**
 * 측정용 reranker 설정. settings default 의 topK_output(5)는 회신을 5개로 잘라
 * nDCG 창(20)을 못 채운다 — 측정에서는 topKInput·topKOutput 을 eval 창 크기로
 * 키워 metric 이 충분한 ranked 결과를 본다(spec 11.1 "상위 채점" 정신 보존,
 * 측정 창만 확대). 운영 default(5)는 spec 11.3.1 에 그대로 남는다.
 */
const FLAT_LIMIT = 20;
const ENRICHED_LIMIT = DEFAULT_ENRICHED_RETRIEVAL_LIMIT; // 20

let embedder: Bgem3Embedder;
let reranker: Reranker;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
  reranker = new Reranker({
    model: "onnx-community/bge-reranker-v2-m3-ONNX",
    topKInput: 30, // RRF 상위 30 채점(spec 11.1)
    topKOutput: 30, // 측정 창 — eval limit(20)보다 커 metric 이 전부 본다
    host: "local",
  });
  await reranker.load();
}, 600_000);

afterAll(() => {});

describe("R5 reranker — 모델 가용성 선행 게이트(T4)", () => {
  test("실제 cross-encoder 모델이 로드돼야 측정 가능(부재면 BLOCKED)", () => {
    // T4 가 확정 선행이므로 정상은 가용. 부재면 이 단언이 실패해 BLOCKED 를
    // 드러낸다 — 가짜 점수로 측정을 진행하지 않는다(No-fabrication 정책).
    expect(reranker.available).toBe(true);
  });
});

describe("R5 reranker measured-win — flat 코퍼스", () => {
  test(
    "+reranker variant nDCG/recall/MRR 점수표 + 운영 default 대비 측정",
    async () => {
      // 기준선 = 운영 default(full-rrf = 중립 RRF + cue / reranker 미적용).
      const baselineSnap = await runHarness(embedder, {
        variants: { "full-rrf": SWEEP_VARIANTS["full-rrf"]! },
      });
      const baseline = baselineSnap.variants.find((v) => v.variant === "full-rrf")!;

      // +reranker = 같은 full-rrf 결과를 실제 cross-encoder 로 재정렬한 뒤 채점.
      const t0 = performance.now();
      const rerankSnap = await runRerankerVariant(embedder, reranker, {
        variant: "full-rrf+reranker",
        mask: SWEEP_VARIANTS["full-rrf"]!,
        retrievalLimit: FLAT_LIMIT,
      });
      const elapsedMs = performance.now() - t0;

      console.log(`[6b T7 flat] +reranker 측정 시간: ${elapsedMs.toFixed(1)}ms`);
      console.log(
        `[6b T7 flat] baseline(full-rrf) nDCG=${baseline.avgNdcg.toFixed(4)} ` +
          `recall=${baseline.avgRecall.toFixed(4)} MRR=${baseline.avgMrr.toFixed(4)}`,
      );
      console.log(
        `[6b T7 flat] +reranker         nDCG=${rerankSnap.avgNdcg.toFixed(4)} ` +
          `recall=${rerankSnap.avgRecall.toFixed(4)} MRR=${rerankSnap.avgMrr.toFixed(4)}`,
      );

      const win = rerankerMeasuredWin(baseline, rerankSnap);
      console.log(`[6b T7 flat] measured-win: ${win.reason}`);

      // 정합성: reranker 가 정답을 창 밖으로 밀어내 recall 을 깎지 않는다
      // (가드레일 — 재정렬은 순서만 바꿀 뿐 후보 회수를 줄이면 안 됨).
      expect(rerankSnap.avgRecall).toBeGreaterThanOrEqual(baseline.avgRecall - 1e-9);
      // 점수표가 query 별로 채워졌다.
      expect(rerankSnap.perQuery.length).toBe(baseline.perQuery.length);
    },
    600_000,
  );
});

describe("R5 reranker measured-win — enriched 코퍼스(개념 적재)", () => {
  test(
    "+reranker variant nDCG/recall/MRR 점수표 + full-rrf+concept 대비 측정",
    async () => {
      // 기준선 = enriched 운영 default(full-rrf+concept = 개념 채널 포함 중립 RRF + cue).
      const baselineSnap = await runEnrichedHarness(embedder, {
        variants: {
          "full-rrf+concept": ENRICHED_SWEEP_VARIANTS["full-rrf+concept"]!,
        },
      });
      const baseline = baselineSnap.variants.find(
        (v) => v.variant === "full-rrf+concept",
      )!;

      const t0 = performance.now();
      const rerankSnap = await runEnrichedRerankerVariant(embedder, reranker, {
        variant: "full-rrf+concept+reranker",
        mask: ENRICHED_SWEEP_VARIANTS["full-rrf+concept"]!,
        retrievalLimit: ENRICHED_LIMIT,
      });
      const elapsedMs = performance.now() - t0;

      console.log(`[6b T7 enriched] +reranker 측정 시간: ${elapsedMs.toFixed(1)}ms`);
      console.log(
        `[6b T7 enriched] baseline(full-rrf+concept) nDCG=${baseline.avgNdcg.toFixed(4)} ` +
          `recall=${baseline.avgRecall.toFixed(4)} MRR=${baseline.avgMrr.toFixed(4)}`,
      );
      console.log(
        `[6b T7 enriched] +reranker                  nDCG=${rerankSnap.avgNdcg.toFixed(4)} ` +
          `recall=${rerankSnap.avgRecall.toFixed(4)} MRR=${rerankSnap.avgMrr.toFixed(4)}`,
      );

      const win = rerankerMeasuredWin(baseline, rerankSnap);
      console.log(`[6b T7 enriched] measured-win: ${win.reason}`);

      // 가드레일: recall 안 깎음.
      expect(rerankSnap.avgRecall).toBeGreaterThanOrEqual(baseline.avgRecall - 1e-9);
      expect(rerankSnap.perQuery.length).toBe(baseline.perQuery.length);
    },
    600_000,
  );
});

describe("R5 reranker default 결정 — flat + enriched measured-win 종합", () => {
  test(
    "두 코퍼스 measured-win 종합 → reranker.enabled default ON/OFF 결정 + 근거 기록",
    async () => {
      // flat 기준선 + reranker.
      const flatBaseSnap = await runHarness(embedder, {
        variants: { "full-rrf": SWEEP_VARIANTS["full-rrf"]! },
      });
      const flatBase = flatBaseSnap.variants.find((v) => v.variant === "full-rrf")!;
      const flatRerank = await runRerankerVariant(embedder, reranker, {
        variant: "full-rrf+reranker",
        mask: SWEEP_VARIANTS["full-rrf"]!,
        retrievalLimit: FLAT_LIMIT,
      });
      const flatWin = rerankerMeasuredWin(flatBase, flatRerank);

      // enriched 기준선 + reranker.
      const enrBaseSnap = await runEnrichedHarness(embedder, {
        variants: {
          "full-rrf+concept": ENRICHED_SWEEP_VARIANTS["full-rrf+concept"]!,
        },
      });
      const enrBase = enrBaseSnap.variants.find(
        (v) => v.variant === "full-rrf+concept",
      )!;
      const enrRerank = await runEnrichedRerankerVariant(embedder, reranker, {
        variant: "full-rrf+concept+reranker",
        mask: ENRICHED_SWEEP_VARIANTS["full-rrf+concept"]!,
        retrievalLimit: ENRICHED_LIMIT,
      });
      const enrWin = rerankerMeasuredWin(enrBase, enrRerank);

      // default 결정: 두 코퍼스 중 하나라도 measured-win 이면 ON 검토, 둘 다
      // 동률·하락이면 OFF 유지(spec 11.2 보수적 default). measured-win gate 는
      // nDCG 상승(허용오차 1e-9 초과)을 win 으로 본다.
      const anyWin = flatWin.adopt || enrWin.adopt;
      const decision = anyWin ? "ON 검토" : "OFF 유지";

      console.log(`[6b T7 default 결정]`);
      console.log(
        `  flat: baseline nDCG ${flatBase.avgNdcg.toFixed(4)} → +reranker ${flatRerank.avgNdcg.toFixed(4)} ` +
          `(delta ${(flatRerank.avgNdcg - flatBase.avgNdcg).toFixed(4)}) — ${flatWin.adopt ? "WIN" : "동률·하락"}`,
      );
      console.log(
        `  enriched: baseline nDCG ${enrBase.avgNdcg.toFixed(4)} → +reranker ${enrRerank.avgNdcg.toFixed(4)} ` +
          `(delta ${(enrRerank.avgNdcg - enrBase.avgNdcg).toFixed(4)}) — ${enrWin.adopt ? "WIN" : "동률·하락"}`,
      );
      console.log(`  → reranker.enabled default 결정: ${decision}`);
      if (!anyWin) {
        console.log(
          `  근거(spec 11.2): 두 코퍼스 모두 vector-only recall 포화(1.1b DCL-5 / 1.1c) — ` +
            `post-RRF 재정렬이 nDCG 를 끌어올릴 틈이 없음. OFF 는 측정으로 확인된 보수적 default.`,
        );
      } else {
        console.log(
          `  근거: 적어도 한 코퍼스에서 nDCG measured-win — settings.reranker.enabled default ON 승격 후보(DCL 에 숫자 기록).`,
        );
      }

      // 결정이 둘 중 하나로 명확히 산출됐다(측정 기반 — 추측 아님).
      expect(["ON 검토", "OFF 유지"]).toContain(decision);
      // measured-win 판정 함수가 nDCG delta 부호와 정합한다(no-fabrication 교차 확인).
      expect(flatWin.adopt).toBe(flatRerank.avgNdcg > flatBase.avgNdcg + 1e-9);
      expect(enrWin.adopt).toBe(enrRerank.avgNdcg > enrBase.avgNdcg + 1e-9);
    },
    600_000,
  );
});
