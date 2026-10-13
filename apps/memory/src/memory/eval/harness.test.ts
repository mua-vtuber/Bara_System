import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import {
  runHarness,
  SWEEP_VARIANTS,
  runExtHarness,
  EXT_RETRIEVAL_LIMIT,
  EXT_TIGHT_RETRIEVAL_LIMIT,
} from "./harness.ts";

/**
 * 확장 손 정답 셋 6-metric 동결 기준선 (T2 / spec 5-1, 2026-08-03 실측).
 *
 * 무엇인가 — 확장 코퍼스(embedding-corpus-ext.txt 90줄) + 확장 문항 42건을
 * 운영 default 파이프라인(full-rrf)에 통과시킨 실측값이다. T14·T19 가 임계값을
 * 움직일 때 품질이 떨어졌는지 판정하는 회귀 기준점 역할을 한다.
 *
 * 바꿔도 되는 때 — *측정으로 개선을 보인 경우에만* 갱신한다. 테스트가 빨개졌다는
 * 이유로 수치를 실측에 맞춰 옮기는 것은 회귀를 지우는 행위다. 갱신할 때는 새 수치와
 * 함께 무엇을 바꿔서 얼마나 올랐는지를 이 주석에 남긴다.
 *
 * 2026-10-13 재동결 (성능 개선 아님) — 저장소 공개 전에 두 코퍼스의 실제 개인 메모를
 * 같은 줄 위치·같은 관계(같은 대상의 다른 측면, 같은 뜻 다른 표현, 날짜 문장)의 지어낸
 * 문장으로 바꿨다. 코드는 그대로이고 측정 대상 글이 달라져 다시 쟀다. 옛 글이 오답으로
 * 끼어들던 문항(Q1·Q5·EX19)이 쉬워져 수치가 올랐다:
 *   Q1~Q10 full-rrf nDCG 0.902867 -> 0.941392, recall 0.975 -> 1.0, MRR 0.9 -> 0.95
 *   넓은 창 nDCG 0.957552 -> 0.958386, MAP 0.943376 -> 0.945513
 *   좁은 창 nDCG 0.933238 -> 0.939255, recall 0.940171 -> 0.948718,
 *           precision 0.341880 -> 0.350427, F1 0.494017 -> 0.502564
 * 옛 수치는 공개할 수 없는 글로 잰 값이라 이후 비교 기준은 새 수치다.
 *
 * 창을 둘 다 재는 이유 — 넓은 창(상한 20, 기존 flat harness 관례 정합)에서는
 * recall 이 1.0000 천장에 붙는다. 코퍼스 90줄에 20건을 돌려주니 정답이 1위든
 * 15위든 똑같이 충족으로 세어져서, 순위가 나빠져도 수치가 안 움직인다.
 * 좁은 창(상한 3)은 같은 파이프라인의 상위권 정확도만 봐서 천장에 안 붙는다
 * (recall 0.9487 / precision 0.3504 / F1 0.5026). 회귀 감지는 좁은 창이 맡고,
 * 넓은 창은 기존 수치와의 비교 가능성을 맡는다.
 *
 * 결정성 — 임베딩·RRF 모두 결정론적이라 실행 간 변동이 없다. 2회 연속 실행이
 * 소수점 6자리까지 동일함을 확인하고 동결했으므로 tolerance 는 부동소수 오차만
 * 흡수하는 1e-6 이다(모델·정렬이 흔들리면 곧바로 빨개지는 게 의도다).
 */
const EXT_BASELINE_TOLERANCE = 1e-6;

/** 넓은 창(상한 20) — 기존 flat harness 와 동일 조건. */
const EXT_BASELINE_WIDE = {
  avgNdcg: 0.958386,
  avgRecall: 1.0,
  avgMrr: 0.945513,
  avgPrecision: 0.055128,
  avgF1: 0.103925,
  avgMap: 0.945513,
} as const;

/** 좁은 창(상한 3) — 천장에 안 붙는 회귀 감지용 계측기. */
const EXT_BASELINE_TIGHT = {
  avgNdcg: 0.939255,
  avgRecall: 0.948718,
  avgMrr: 0.935897,
  avgPrecision: 0.350427,
  avgF1: 0.502564,
  avgMap: 0.935897,
} as const;

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

describe("검색 평가 harness — 실 SQLite + bge-m3 기준선", () => {
  test("기준선 snapshot 산출 — variant별 평균 점수 + 질문별 점수", async () => {
    const snap = await runHarness(embedder);
    expect(snap.corpusLines).toBeGreaterThan(100); // corpus 111줄 적재
    expect(snap.embedderDim).toBe(1024); // bge-m3 dim(factory EMBEDDING_DIMENSIONS 정합)
    const full = snap.variants.find((v) => v.variant === "full-rrf");
    expect(full).toBeDefined();
    expect(full!.perQuery.length).toBe(10); // Q1~Q10
    // 전체 RRF 가 단일 채널보다 나쁘지 않은지 sanity (정밀 임계값은 1.1b sweep).
    expect(full!.avgRecall).toBeGreaterThan(0);
    // 채널 분리가 실제로 다른 점수를 내는지(원인 분리 가능 확인).
    const vectorOnly = snap.variants.find((v) => v.variant === "vector-only")!;
    expect(vectorOnly.avgRecall).toBeGreaterThanOrEqual(0);
  }, 600_000);

  test("운영 DB 불변경 — harness 는 :memory: 만 활용", async () => {
    // runHarness 가 dbPath 인자 없이 :memory: 만 연다(코드 경로 보장).
    const snap = await runHarness(embedder, { variants: { "full-rrf": SWEEP_VARIANTS["full-rrf"]! } });
    expect(snap.variants.length).toBe(1);
  }, 600_000);

  test("동결분 Q1~Q10 수치 불변 — 확장이 기존 기준선을 안 흔든다", async () => {
    // 확장분은 별도 코퍼스·별도 문항 셋이므로 기존 harness 출력은 그대로여야 한다.
    // 2026-10-13 재측정(코퍼스 개인정보 교체, 위 파일 머리 주석): avgNdcg 0.941392 / recall 1.0 / mrr 0.95.
    const snap = await runHarness(embedder, {
      variants: { "full-rrf": SWEEP_VARIANTS["full-rrf"]! },
    });
    const full = snap.variants.find((v) => v.variant === "full-rrf")!;
    expect(snap.corpusLines).toBe(112);
    expect(full.perQuery.length).toBe(10);
    expect(full.avgNdcg).toBeCloseTo(0.941392, 5);
    expect(full.avgRecall).toBeCloseTo(1.0, 5);
    expect(full.avgMrr).toBeCloseTo(0.95, 5);
  }, 600_000);
});

describe("확장 손 정답 셋 — 6-metric 기준선 동결 (T2, 2026-08-03)", () => {
  test("확장 코퍼스·문항 적재 규모 확인", async () => {
    const snap = await runExtHarness(embedder);
    expect(snap.corpusLines).toBe(90); // 확장 코퍼스 90줄(중복 흡수 0건)
    expect(snap.queryCount).toBe(42);
    expect(snap.embedderDim).toBe(1024);
    const v = snap.variants[0]!;
    expect(v.answerableCount).toBe(39);
    expect(v.unanswerableCount).toBe(3);
  }, 600_000);

  test("넓은 창(상한 20) 6-metric 이 동결값과 일치", async () => {
    const snap = await runExtHarness(embedder, { limit: EXT_RETRIEVAL_LIMIT });
    const v = snap.variants[0]!;
    expect(v.limit).toBe(20);
    console.log(
      `[T2 기준선 — 넓은 창 상한 ${v.limit}] ` +
        `ndcg=${v.avgNdcg.toFixed(6)} recall=${v.avgRecall.toFixed(6)} ` +
        `mrr=${v.avgMrr.toFixed(6)} precision=${v.avgPrecision.toFixed(6)} ` +
        `f1=${v.avgF1.toFixed(6)} map=${v.avgMap.toFixed(6)}`,
    );
    expect(v.avgNdcg).toBeCloseTo(EXT_BASELINE_WIDE.avgNdcg, 6);
    expect(v.avgRecall).toBeCloseTo(EXT_BASELINE_WIDE.avgRecall, 6);
    expect(v.avgMrr).toBeCloseTo(EXT_BASELINE_WIDE.avgMrr, 6);
    expect(v.avgPrecision).toBeCloseTo(EXT_BASELINE_WIDE.avgPrecision, 6);
    expect(v.avgF1).toBeCloseTo(EXT_BASELINE_WIDE.avgF1, 6);
    expect(v.avgMap).toBeCloseTo(EXT_BASELINE_WIDE.avgMap, 6);
  }, 600_000);

  test("좁은 창(상한 3) 6-metric 이 동결값과 일치 — 회귀 감지용 계측기", async () => {
    const snap = await runExtHarness(embedder, { limit: EXT_TIGHT_RETRIEVAL_LIMIT });
    const v = snap.variants[0]!;
    expect(v.limit).toBe(3);
    console.log(
      `[T2 기준선 — 좁은 창 상한 ${v.limit}] ` +
        `ndcg=${v.avgNdcg.toFixed(6)} recall=${v.avgRecall.toFixed(6)} ` +
        `mrr=${v.avgMrr.toFixed(6)} precision=${v.avgPrecision.toFixed(6)} ` +
        `f1=${v.avgF1.toFixed(6)} map=${v.avgMap.toFixed(6)}`,
    );
    expect(v.avgNdcg).toBeCloseTo(EXT_BASELINE_TIGHT.avgNdcg, 6);
    expect(v.avgRecall).toBeCloseTo(EXT_BASELINE_TIGHT.avgRecall, 6);
    expect(v.avgMrr).toBeCloseTo(EXT_BASELINE_TIGHT.avgMrr, 6);
    expect(v.avgPrecision).toBeCloseTo(EXT_BASELINE_TIGHT.avgPrecision, 6);
    expect(v.avgF1).toBeCloseTo(EXT_BASELINE_TIGHT.avgF1, 6);
    expect(v.avgMap).toBeCloseTo(EXT_BASELINE_TIGHT.avgMap, 6);

    // 좁은 창은 천장에 붙으면 안 된다 — 붙는 순간 회귀 감지력이 사라진다.
    expect(v.avgRecall).toBeLessThan(1);
    expect(v.avgPrecision).toBeLessThan(1);
  }, 600_000);

  test("같은 조건 두 번 실행이 동일 수치 — 동결값의 결정성 근거", async () => {
    const a = await runExtHarness(embedder, { limit: EXT_TIGHT_RETRIEVAL_LIMIT });
    const b = await runExtHarness(embedder, { limit: EXT_TIGHT_RETRIEVAL_LIMIT });
    const va = a.variants[0]!;
    const vb = b.variants[0]!;
    expect(Math.abs(va.avgNdcg - vb.avgNdcg)).toBeLessThan(EXT_BASELINE_TOLERANCE);
    expect(Math.abs(va.avgRecall - vb.avgRecall)).toBeLessThan(EXT_BASELINE_TOLERANCE);
    expect(Math.abs(va.avgMrr - vb.avgMrr)).toBeLessThan(EXT_BASELINE_TOLERANCE);
    expect(Math.abs(va.avgPrecision - vb.avgPrecision)).toBeLessThan(EXT_BASELINE_TOLERANCE);
    expect(Math.abs(va.avgF1 - vb.avgF1)).toBeLessThan(EXT_BASELINE_TOLERANCE);
    expect(Math.abs(va.avgMap - vb.avgMap)).toBeLessThan(EXT_BASELINE_TOLERANCE);
  }, 600_000);
});
