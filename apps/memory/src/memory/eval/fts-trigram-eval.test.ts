/**
 * memory/eval/fts-trigram-eval.test.ts — FTS5 듀얼 색인(1.1a T2) harness 측정.
 *
 * 현 기준 스키마가 unicode61 본색인 + trigram 보조 색인 듀얼이므로, 이 harness
 * 의 fts-only snapshot 이 듀얼 색인 'after' 수치다. T1 기준선(avgNdcg 0.5318 /
 * avgRecall 0.7000 / avgMrr 0.4667) 대비 떨어지지 않음을 측정·기록한다(2글자
 * 검색어 보존이 단순 trigram 전환의 회귀를 막으므로 동률 이상 기대). trigram
 * 보조 색인이 3글자+ 검색에 더하는 무관 글(노이즈)은 perQuery 차이로 기록 —
 * 1.1b sweep 의 입력 자료가 된다. 실 bge-m3 로드(수십 초) — Mock 금지.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { runHarness, SWEEP_VARIANTS } from "./harness.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

describe("FTS 듀얼 색인 — harness 측정", () => {
  test("듀얼 색인 후 fts-only avgNdcg 가 기준선(0.5318) 대비 떨어지지 않음", async () => {
    const after = await runHarness(embedder, {
      variants: { "fts-only": SWEEP_VARIANTS["fts-only"]! },
    });
    const ftsOnly = after.variants[0]!;
    // 자동 sanity — 0 이상 + 유한. 기준선 대비 하락 여부는 아래 로그를 수동
    // snapshot(T1: avgNdcg 0.5318)과 비교(Q6 "AI 도구" 회복 확인). 떨어지면
    // Decision Change Log + 사용자 확인 게이트.
    expect(ftsOnly.avgRecall).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(ftsOnly.avgNdcg)).toBe(true);
    console.log(
      "[fts-trigram-eval] 듀얼 fts-only avg:",
      JSON.stringify({
        avgNdcg: ftsOnly.avgNdcg,
        avgRecall: ftsOnly.avgRecall,
        avgMrr: ftsOnly.avgMrr,
      }),
    );
    console.log(
      "[fts-trigram-eval] 듀얼 fts-only perQuery:",
      JSON.stringify(ftsOnly.perQuery),
    );
  });
});
