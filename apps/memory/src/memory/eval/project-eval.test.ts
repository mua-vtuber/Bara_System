import { beforeAll, describe, expect, test } from "bun:test";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { runEnrichedHarness, runHarness } from "./harness.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

describe("project expansion — harness EQ4 측정 게이트", () => {
  test("project=bara_system 배선 시 bara_cleanup 순위가 오르거나 유지", async () => {
    const snapBefore = await runEnrichedHarness(embedder, { applyProjectVocab: false });
    const snapAfter = await runEnrichedHarness(embedder, { applyProjectVocab: true });

    const variantBefore = snapBefore.variants.find((v) => v.variant === "full-rrf+concept")!;
    const variantAfter = snapAfter.variants.find((v) => v.variant === "full-rrf+concept")!;

    const eq4Before = variantBefore.perQuery.find((q) => q.id === "EQ4")!;
    const eq4After = variantAfter.perQuery.find((q) => q.id === "EQ4")!;

    console.log(
      `[EQ4 before] ndcg=${eq4Before.ndcg.toFixed(4)} recall=${eq4Before.recall.toFixed(4)} mrr=${eq4Before.mrr.toFixed(4)}`,
    );
    console.log(
      `[EQ4 after]  ndcg=${eq4After.ndcg.toFixed(4)} recall=${eq4After.recall.toFixed(4)} mrr=${eq4After.mrr.toFixed(4)}`,
    );
    // 아래 수치는 enriched 코퍼스에서 잰 full-rrf+concept variant 집계다(flat 아님).
    // flat full-rrf 0.8882 floor 는 별도 test 케이스에서 runHarness 로 단언한다.
    console.log(
      `[enriched full-rrf+concept avgNdcg before] ${variantBefore.avgNdcg.toFixed(4)}`,
    );
    console.log(
      `[enriched full-rrf+concept avgNdcg after]  ${variantAfter.avgNdcg.toFixed(4)}`,
    );

    // bara_cleanup 이 회수됨(recall > 0).
    expect(eq4After.recall).toBeGreaterThan(0);
    // after EQ4 ndcg/mrr 이 before 보다 오르거나 같다(bara_cleanup 이 nest_cleanup 보다 앞).
    expect(eq4After.ndcg).toBeGreaterThanOrEqual(eq4Before.ndcg - 1e-9);
    expect(eq4After.mrr).toBeGreaterThanOrEqual(eq4Before.mrr - 1e-9);
  });

  test("flat full-rrf 0.8882 floor — T3 가 flat 경로를 건드리지 않음", async () => {
    const snap = await runHarness(embedder); // flat embedding-corpus.txt, project 없음
    const full = snap.variants.find((v) => v.variant === "full-rrf")!;
    console.log(`[flat full-rrf avgNdcg] ${full.avgNdcg.toFixed(4)}`);
    // 1.1a 기준선 0.8882. T3 는 project 미지정 경로(baseQuery=query)를 불변 보존.
    expect(full.avgNdcg).toBeGreaterThanOrEqual(0.8882 - 1e-4);
  });
});
