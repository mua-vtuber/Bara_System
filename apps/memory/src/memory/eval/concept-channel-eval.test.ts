/**
 * concept-channel-eval.test.ts — 개념 채널 노이즈 측정 (1.1a T5).
 *
 * T1 harness 에 concept 채널 ON variant 를 더해, 개념 채널이 정답 nDCG 를
 * 떨어뜨리지 않는지 측정한다.
 *
 * 한계 — harness corpus(embedding-corpus.txt)는 평면 텍스트라 개념(#태그)이
 * 자동 생성되지 않는다. 그래서 이 측정의 의미는 "개념 색인이 비어 있을 때
 * 개념 채널이 검색을 *해치지 않음*"(graceful degrade 확인)이다. 개념이 실제로
 * 정답을 *올리는* 순효과는 개념이 적재된 corpus variant 또는 1.1b sweep 에서
 * 측정한다 — 이 차이는 plan "우려" 단락에 기록.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { runHarness } from "./harness.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

describe("개념 채널 노이즈 측정 — harness", () => {
  test("4채널(+concept)이 3채널 대비 nDCG 동률 이상", async () => {
    const snap = await runHarness(embedder, {
      variants: {
        "full-rrf": { vector: true, fts: true, graph: true, concept: false },
        "full-plus-concept": { vector: true, fts: true, graph: true, concept: true },
      },
    });
    const three = snap.variants.find((v) => v.variant === "full-rrf")!;
    const four = snap.variants.find((v) => v.variant === "full-plus-concept")!;
    // 개념 채널이 정답을 떨어뜨리지 않음 (corpus 에 개념이 적재 안 됐으면 동률).
    // 떨어지면 Decision Change Log + 사용자 확인 (Acceptance 정합).
    expect(four.avgNdcg).toBeGreaterThanOrEqual(three.avgNdcg - 1e-9);
  });
});
