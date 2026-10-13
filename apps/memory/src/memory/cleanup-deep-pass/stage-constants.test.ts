/**
 * stage-constants.test.ts — 단계별 LLM 상수 단일 출처 맵 검증 (spec 5.B-3).
 *
 * EMBEDDING_DIMENSIONS/EMBEDDING_VECTOR_BASELINES 선례 정합 — 등록 stage 조회는
 * spec 값 그대로, 미등록 stage 조회는 loud throw. 순수 함수 검증이라 DB·mock 0.
 */

import { expect, test } from "bun:test";
import {
  CLEANUP_STAGE_LLM_LIMITS,
  CLEANUP_STAGE_TEMPERATURE,
  cleanupStageLlmLimitsOf,
  cleanupStageMaxOutputTokensFor,
  ENTITY_REGISTER_BATCH_SIZE_MAX,
} from "./stage-constants.ts";

test("regex_strengthen — 등록 상수 조회(spec 5.B-3 표 그대로)", () => {
  const limits = cleanupStageLlmLimitsOf("regex_strengthen");
  expect(limits.maxOutputTokens).toBe(768);
  expect(limits.maxOutputTokensCap).toBe(3072);
  expect(limits.stageVersion).toBe(1);
});

test("summary — 등록 상수 조회(spec 5.B-3 표 그대로)", () => {
  const limits = cleanupStageLlmLimitsOf("summary");
  expect(limits.maxOutputTokens).toBe(1536);
  expect(limits.maxOutputTokensCap).toBe(6144);
  expect(limits.stageVersion).toBe(1);
});

test("person_link — 등록 상수 조회 + prefilterTopK 포함(spec 5.B-3 표 그대로)", () => {
  const limits = cleanupStageLlmLimitsOf("person_link");
  expect(limits.maxOutputTokens).toBe(768);
  expect(limits.maxOutputTokensCap).toBe(3072);
  expect(limits.stageVersion).toBe(1);
  expect(limits.prefilterTopK).toBe(5);
});

test("relation_discovery — summary 사이클 안 소속 stage 라 이 맵에서도 summary 값과 같은 stageVersion 을 공유(별도 항목 없음)", () => {
  // relation_discovery 는 summary-cycle.ts 안에서 summary 와 같은 STAGE_VERSION 을
  // 쓰는 사이클 내부 stage 다(plan Task 9 지시 — summary 항목 재사용, 별도 맵 항목 없음).
  const summaryLimits = cleanupStageLlmLimitsOf("summary");
  expect(summaryLimits.stageVersion).toBe(1);
});

test("미등록 stage 조회 — loud throw(EMBEDDING_* 선례 정합, silent fallback 금지)", () => {
  expect(() =>
    cleanupStageLlmLimitsOf("unknown_stage" as Parameters<typeof cleanupStageLlmLimitsOf>[0]),
  ).toThrow(/unknown_stage/);
});

test("lens_draft 조회 — 등록 완료(C-2b, maxOutputTokens 1024 / cap 4096)", () => {
  const lens = cleanupStageLlmLimitsOf("lens_draft");
  expect(lens.maxOutputTokens).toBe(1024);
  expect(lens.maxOutputTokensCap).toBe(4096);
  expect(lens.stageVersion).toBe(1);
});

test("CLEANUP_STAGE_TEMPERATURE — 단일 출처 상수(spec 5.B-3, 4단계 공유 0.1)", () => {
  expect(CLEANUP_STAGE_TEMPERATURE).toBe(0.1);
});

test("CLEANUP_STAGE_LLM_LIMITS — 맵이 5 stage 키 노출(entity_register 합류)", () => {
  expect(Object.keys(CLEANUP_STAGE_LLM_LIMITS).sort()).toEqual([
    "entity_register",
    "lens_draft",
    "person_link",
    "regex_strengthen",
    "summary",
  ]);
});

test("entity_register has its own limits and contract version", () => {
  const limits = cleanupStageLlmLimitsOf("entity_register");
  expect(limits.stageVersion).toBe(1);
  expect(limits.maxOutputTokensCap).toBeGreaterThan(limits.maxOutputTokens);
});

test("entity_register 출력 한도는 묶음 메모 수에 맞춰 기본 몫 + 메모당 몫으로 정해지고 cap 을 넘지 않는다", () => {
  const limits = cleanupStageLlmLimitsOf("entity_register");
  const perItem = limits.outputTokensPerItem!;
  expect(cleanupStageMaxOutputTokensFor("entity_register", 1)).toBe(limits.maxOutputTokens + perItem);
  expect(cleanupStageMaxOutputTokensFor("entity_register", 10)).toBe(limits.maxOutputTokens + perItem * 10);
  expect(cleanupStageMaxOutputTokensFor("entity_register", 1000)).toBe(limits.maxOutputTokensCap);
});

test("entity_register 기본 묶음(10개) 한도는 실측 출력(생각 1512 + 답 글 약 760 = 2274)을 담고, 잘림 재호출(2배) 여지가 남는다", () => {
  const ten = cleanupStageMaxOutputTokensFor("entity_register", 10);
  expect(ten).toBeGreaterThan(2274);
  expect(cleanupStageLlmLimitsOf("entity_register").maxOutputTokensCap).toBeGreaterThan(ten);
});

test("대상 몫이 없는 단계는 대상 수와 무관하게 maxOutputTokens 그대로", () => {
  expect(cleanupStageMaxOutputTokensFor("regex_strengthen", 7)).toBe(cleanupStageLlmLimitsOf("regex_strengthen").maxOutputTokens);
});

test("대상 수가 1 이상 정수가 아니면 던진다", () => {
  expect(() => cleanupStageMaxOutputTokensFor("entity_register", 0)).toThrow(/대상 수/);
  expect(() => cleanupStageMaxOutputTokensFor("entity_register", 2.5)).toThrow(/대상 수/);
});

test("entity_register 묶음 상한의 출력 한도는 상한(cap) 아래라 잘림 재호출 여지가 항상 남는다", () => {
  expect(cleanupStageMaxOutputTokensFor("entity_register", ENTITY_REGISTER_BATCH_SIZE_MAX))
    .toBeLessThan(cleanupStageLlmLimitsOf("entity_register").maxOutputTokensCap);
});
