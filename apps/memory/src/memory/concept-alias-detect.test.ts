import { describe, test, expect } from "bun:test";
import {
  isAliasCandidate,
  cosineFromDistance,
  filterAliasCandidates,
  CONCEPT_ALIAS_THRESHOLD,
} from "./concept-alias-detect.ts";
import {
  aliasThresholdOf,
  DEFAULT_EMBEDDER_MODEL,
} from "../embedding/factory.ts";

describe("concept-alias-detect — 순수 판정", () => {
  test("CONCEPT_ALIAS_THRESHOLD — 모델별 factory 맵 연동 (bge-m3 = 0.68)", () => {
    // 직접 기재값이 아닌 EMBEDDING_ALIAS_THRESHOLDS 단일 출처와 연동돼야 한다.
    expect(CONCEPT_ALIAS_THRESHOLD).toBe(aliasThresholdOf(DEFAULT_EMBEDDER_MODEL));
    // 2026-07-10 실측 확정값 pin — 무단 변경 방지(근거는 factory.ts 맵 주석).
    expect(CONCEPT_ALIAS_THRESHOLD).toBe(0.68);
  });

  test("cosineFromDistance — cosine = 1 − distance (concept_vec distance_metric=cosine)", () => {
    expect(cosineFromDistance(0)).toBeCloseTo(1);
    expect(cosineFromDistance(0.05)).toBeCloseTo(0.95);
    expect(cosineFromDistance(0.5)).toBeCloseTo(0.5);
    expect(cosineFromDistance(1)).toBeCloseTo(0);
  });

  test("isAliasCandidate — 임계값 이상이면 true, 미만이면 false", () => {
    expect(isAliasCandidate(0.7)).toBe(true);
    expect(isAliasCandidate(0.68)).toBe(true); // 경계 포함 (≥)
    expect(isAliasCandidate(0.6799)).toBe(false);
    expect(isAliasCandidate(0.5)).toBe(false);
  });

  test("isAliasCandidate — 커스텀 임계값", () => {
    expect(isAliasCandidate(0.9, 0.9)).toBe(true);
    expect(isAliasCandidate(0.89, 0.9)).toBe(false);
  });

  test("filterAliasCandidates — 임계값 이상만 cosine 내림차순 + self/같은이름 제외", () => {
    const rows = [
      { conceptRowid: 1, conceptId: "cpt_self", name: "갈비", distance: 0.0 }, // self
      { conceptRowid: 2, conceptId: "cpt_a", name: "rib", distance: 0.03 }, // cosine 0.97
      { conceptRowid: 3, conceptId: "cpt_b", name: "spare rib", distance: 0.04 }, // cosine 0.96
      { conceptRowid: 4, conceptId: "cpt_c", name: "날씨", distance: 0.6 }, // 미달
      { conceptRowid: 5, conceptId: "cpt_d", name: "갈비", distance: 0.01 }, // 같은 이름(자동 합류 대상)
    ];
    const out = filterAliasCandidates(rows, {
      selfRowid: 1,
      selfName: "갈비",
      threshold: 0.95,
    });
    // self(rowid 1) 제외 + 같은이름 "갈비"(rowid 5) 제외 + 미달(rowid 4) 제외.
    // 남는 건 cpt_a(0.97) / cpt_b(0.96), cosine 내림차순.
    expect(out.map((c) => c.conceptId)).toEqual(["cpt_a", "cpt_b"]);
    expect(out[0]!.cosine).toBeCloseTo(0.97);
    expect(out[1]!.cosine).toBeCloseTo(0.96);
  });

  test("filterAliasCandidates — 같은 이름 비교는 대소문자/공백 무시", () => {
    const rows = [
      { conceptRowid: 1, conceptId: "cpt_self", name: "Rib", distance: 0.0 },
      { conceptRowid: 2, conceptId: "cpt_dup", name: "  rib  ", distance: 0.01 },
    ];
    const out = filterAliasCandidates(rows, {
      selfRowid: 1,
      selfName: "rib",
      threshold: 0.95,
    });
    expect(out.length).toBe(0); // self + 같은이름(정규화 후 동일)만 있어 후보 0
  });

  test("filterAliasCandidates — limit 적용", () => {
    const rows = [
      { conceptRowid: 1, conceptId: "cpt_self", name: "s", distance: 0.0 },
      { conceptRowid: 2, conceptId: "cpt_a", name: "a", distance: 0.01 },
      { conceptRowid: 3, conceptId: "cpt_b", name: "b", distance: 0.02 },
      { conceptRowid: 4, conceptId: "cpt_c", name: "c", distance: 0.03 },
    ];
    const out = filterAliasCandidates(rows, {
      selfRowid: 1,
      selfName: "s",
      threshold: 0.95,
      limit: 2,
    });
    expect(out.length).toBe(2);
    expect(out.map((c) => c.conceptId)).toEqual(["cpt_a", "cpt_b"]);
  });
});
