import { describe, expect, test } from "bun:test";
import { Bgem3Embedder } from "./bge-m3";
import {
  aliasThresholdOf,
  conflictThresholdsOf,
  createEmbedder,
  DEFAULT_EMBEDDER_MODEL,
  embeddingDimensionOf,
  EMBEDDING_RESULT_FLOOR_PARAMS,
  resultFloorParamsOf,
  storeDuplicateThresholdOf,
  vectorBaselineOf,
} from "./factory";

describe("createEmbedder factory", () => {
  test("model='bge-m3' returns Bgem3Embedder with dim 1024", () => {
    const e = createEmbedder({ model: "bge-m3" });
    expect(e).toBeInstanceOf(Bgem3Embedder);
    expect(e.dimension).toBe(1024);
  });

  test("undefined opts defaults to bge-m3", () => {
    expect(createEmbedder()).toBeInstanceOf(Bgem3Embedder);
    expect(createEmbedder({}).dimension).toBe(1024);
  });

  test("unknown model throws (no silent fallback)", () => {
    expect(() =>
      // @ts-expect-error intentional invalid value for runtime guard.
      createEmbedder({ model: "nonexistent-model" }),
    ).toThrow(/Unknown embedding model/);
  });
});

describe("embedding model constants", () => {
  test("bge-m3 is the only text embedding model", () => {
    expect(DEFAULT_EMBEDDER_MODEL).toBe("bge-m3");
    expect(embeddingDimensionOf("bge-m3")).toBe(1024);
    expect(vectorBaselineOf("bge-m3")).toBe(0.5);
    expect(conflictThresholdsOf("bge-m3")).toEqual({
      conflictLow: 0.55,
      conflictHigh: 0.85,
      dedupSim: 0.85,
    });
    // 별칭 임계 — 2026-07-10 실측 확정값 (근거는 EMBEDDING_ALIAS_THRESHOLDS 주석).
    expect(aliasThresholdOf("bge-m3")).toBe(0.68);
  });
});

describe("storeDuplicateThresholdOf", () => {
  // 2026-08-03 실측 확정값 (근거는 EMBEDDING_STORE_DUPLICATE_THRESHOLDS 주석).
  test("bge-m3 returns the measured threshold", () => {
    expect(storeDuplicateThresholdOf("bge-m3")).toBe(0.89);
  });

  test("unknown model throws (no silent fallback)", () => {
    expect(() =>
      // @ts-expect-error intentional invalid value for runtime guard.
      storeDuplicateThresholdOf("nonexistent-model"),
    ).toThrow(/Unknown embedding model/);
  });

  // 무단 변경 감지선 — 원문 단위 실측 근거 없이 값이 흔들리면 여기서 빨개진다.
  // 하한 0.7 은 관련-비중복 분포 위쪽(최고 0.8514)을 침범하지 않기 위한 선,
  // 상한 1.0 미만은 verbatim 동일 글(cosine 1.0)조차 못 잡는 값이 되는 것을 막는다.
  test("threshold stays within sane bounds", () => {
    const threshold = storeDuplicateThresholdOf("bge-m3");
    expect(threshold).toBeGreaterThan(0.7);
    expect(threshold).toBeLessThan(1.0);
  });

  // 추출 항목(fact) 단위 dedupSim 을 원문 단위로 그대로 옮겨오면 안 된다는
  // 관측 단위 분리를 고정한다 (2026-07-10 fail 21건 사건의 교훈).
  test("is measured separately from extractor dedupSim", () => {
    expect(storeDuplicateThresholdOf("bge-m3")).not.toBe(
      conflictThresholdsOf("bge-m3").dedupSim,
    );
  });
});

describe("resultFloorParamsOf", () => {
  // 2026-08-03 실측 확정값 (근거는 EMBEDDING_RESULT_FLOOR_PARAMS 주석).
  test("bge-m3 returns the measured absolute floor", () => {
    expect(resultFloorParamsOf("bge-m3")).toEqual({
      mode: "absolute",
      floor: 0.44,
    });
  });

  test("unknown model throws (no silent fallback)", () => {
    expect(() =>
      // @ts-expect-error intentional invalid value for runtime guard.
      resultFloorParamsOf("nonexistent-model"),
    ).toThrow(/Unknown embedding model/);
  });

  // 무단 변경 감지선 — 실측 근거 없이 값이 흔들리면 여기서 빨개진다.
  // 상한 0.4788 은 gold 최저 raw cosine(EX19) — 이 값 이상으로 올리면 회수
  // 손실이 시작된다. 하한 0.35 는 비-gold 분포 한가운데(p50 0.4181) 아래로
  // 내려가 하한선이 사실상 아무것도 안 거르게 되는 것을 막는다.
  test("floor stays within sane bounds", () => {
    const params = resultFloorParamsOf("bge-m3");
    expect(params.mode).toBe("absolute");
    if (params.mode !== "absolute") throw new Error("unreachable");
    expect(params.floor).toBeGreaterThan(0.35);
    expect(params.floor).toBeLessThanOrEqual(0.4788);
  });

  // 결과를 *버리는* 하한과, 정밀 강도를 0 으로 *깎는* 게이트는 하는 일이 다르다.
  // 두 값이 같아지면 둘 중 하나가 근거 없이 복사됐다는 뜻이라 여기서 잡는다.
  test("is measured separately from the precision-strength baseline gate", () => {
    const params = resultFloorParamsOf("bge-m3");
    if (params.mode !== "absolute") throw new Error("unreachable");
    expect(params.floor).not.toBe(vectorBaselineOf("bge-m3"));
  });

  test("every registered model has params (map/accessor stay in sync)", () => {
    for (const model of Object.keys(EMBEDDING_RESULT_FLOOR_PARAMS)) {
      expect(resultFloorParamsOf(model as "bge-m3")).toBeDefined();
    }
  });
});
