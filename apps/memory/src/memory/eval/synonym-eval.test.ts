/**
 * synonym-eval.test.ts — 동의어 확장 배선 before/after 측정(공통 인프라 1.1b T2 / D9).
 *
 * enriched 코퍼스를 실제 store 에 적재해 실제 HybridRetriever 로 EQ3(포근↔따뜻
 * 동의어) fts-only recall 을 동의어 사전 주입 전/후로 비교한다. mock 0 — 실제
 * bge-m3 + bun:sqlite + 실제 seed yaml(추적 위치 src/memory/synonym_dictionary.yaml).
 *
 * 측정 게이트(plan acceptance / DCL-4):
 *  - enriched EQ3 fts-only recall: before < after(0 → 1). EQ3 query 를 직접 겹침
 *    토큰 없이 조정해(="포근한 느낌"), 동의어 확장 전엔 fts 가 design_warm 의
 *    어휘("따뜻한 색감의 디자인")를 하나도 안 잡고, 확장 후 "따뜻한"이 합류하며
 *    잡는다. synonym 단독 효과의 유효한 격리 측정(DCL-4 — 측정 유효화이지 결과
 *    조작 아님).
 *  - flat full-rrf avgNdcg >= 0.8882 - 1e-3(floor 보호 — 동의어 배선이 flat 기준선
 *    을 깎지 않는다).
 *
 * DCL-4 배경: 옛 EQ3 query "포근한 색감 디자인"은 "색감"·"디자인" 토큰이
 * design_warm content 와 직접 겹쳐 동의어 확장 전에도 fts recall=1 → 동의어 단독
 * 효과가 격리 안 됐다. coordinator 가 query 를 "포근한 느낌"으로 조정해 직접 겹침을
 * 없앴다. answerKeys=["design_warm"] 유지. 임베딩 채널이 의미로 design_warm 을
 * 잡는 건 정상(spec 13.3 — 동의어는 fts 전용이라 fts-only 채널로 격리 측정).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { loadSynonymDictionary } from "../synonym-dictionary.ts";
import type { SynonymDictionary } from "../synonym-dictionary.ts";
import { runEnrichedHarness, runHarness, type VariantSnapshot } from "./harness.ts";

const SEED = join(import.meta.dir, "../synonym_dictionary.yaml");

/** flat full-rrf avgNdcg floor(T1 기준선 실측). 동의어 배선이 이 밑으로 깎으면 회귀. */
const FLAT_FULL_RRF_FLOOR = 0.8882;
const FLOOR_TOLERANCE = 1e-3;

let embedder: Bgem3Embedder;
let dict: SynonymDictionary;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
  dict = loadSynonymDictionary(SEED);
});

function eq3FtsRecall(snapshot: { variants: VariantSnapshot[] }): number {
  const ftsOnly = snapshot.variants.find((v) => v.variant === "fts-only");
  if (!ftsOnly) throw new Error("synonym-eval: fts-only variant 없음");
  const eq3 = ftsOnly.perQuery.find((q) => q.id === "EQ3");
  if (!eq3) throw new Error("synonym-eval: EQ3 점수 없음");
  return eq3.recall;
}

describe("synonym expansion 배선 before/after (T2 측정 게이트)", () => {
  test("seed 사전 — EQ3 정합 어휘(포근한→따뜻한) 로드", () => {
    // EQ3 query 표면형 "포근한" → design_warm content "따뜻한" 으로 확장 가능해야.
    expect(dict.get("포근한")).toContain("따뜻한");
  });

  test("enriched EQ3 fts-only recall: before < after (동의어 단독 효과 0→1)", async () => {
    const before = await runEnrichedHarness(embedder); // 사전 미주입 = expansion 0
    const after = await runEnrichedHarness(embedder, { synonymDict: dict });

    const beforeRecall = eq3FtsRecall(before);
    const afterRecall = eq3FtsRecall(after);

    // DCL-4: query "포근한 느낌"은 design_warm 어휘와 직접 안 겹쳐 확장 전 fts
    // recall=0, "따뜻한" 동의어 합류 후 recall=1. 동의어 단독 효과의 격리 측정.
    expect(beforeRecall).toBe(0);
    expect(afterRecall).toBe(1);
    expect(afterRecall).toBeGreaterThan(beforeRecall);
  });

  test("flat full-rrf avgNdcg floor 보호 — 동의어 배선이 0.8882 를 안 깎음", async () => {
    const after = await runHarness(embedder, { synonymDict: dict });
    const fullRrf = after.variants.find((v) => v.variant === "full-rrf");
    if (!fullRrf) throw new Error("synonym-eval: full-rrf variant 없음");
    expect(fullRrf.avgNdcg).toBeGreaterThanOrEqual(
      FLAT_FULL_RRF_FLOOR - FLOOR_TOLERANCE,
    );
  });
});
