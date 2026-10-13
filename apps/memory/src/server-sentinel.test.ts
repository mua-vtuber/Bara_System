/**
 * Tests for the model-sentinel resolution that wires conflict/dedup thresholds
 * (C1/M5, 2026-06-18). resolveModelSentinel + conflictThresholdsOf together are
 * the load-bearing contract: settings.search 칸이 음수 sentinel 이면 모델 연동
 * default 를, 0..1 로 명시되면 사용자값을 쓴다 — baselineVectorCosine 과 같은 규칙.
 *
 * 실제 임베더·LLM 을 올리지 않는 순수 단위 검증이라 빠르다. ConflictChecker /
 * MemoryExtractor 의 private 임계 필드를 들여다보는 대신, server.ts 가 생성자로
 * 흘리기 직전 계산하는 그 값(resolveModelSentinel 출력)을 직접 검증한다.
 */

import { describe, expect, test } from "bun:test";
import { resolveModelSentinel } from "./server.ts";
import { conflictThresholdsOf } from "./embedding/factory.ts";

describe("resolveModelSentinel — 충돌·중복 임계 모델 연동 (C1/M5)", () => {
  test("음수 sentinel(-1, 미지정) → 모델 default 를 쓴다", () => {
    expect(resolveModelSentinel(-1, 0.55)).toBe(0.55);
    expect(resolveModelSentinel(-1, 0.85)).toBe(0.85);
  });

  test("0..1 명시값 → 사용자값이 모델 default 를 이긴다", () => {
    expect(resolveModelSentinel(0.7, 0.55)).toBe(0.7);
    expect(resolveModelSentinel(0, 0.55)).toBe(0); // 0 도 명시 (>= 0)
    expect(resolveModelSentinel(1, 0.85)).toBe(1);
  });

  test("bge-m3 운영 default 흐름 — sentinel 이 모델 충돌·중복 임계로 풀린다", () => {
    // server.ts 가 settings.search 칸(-1)을 모델값으로 푸는 그 경로를 복제 검증.
    const t = conflictThresholdsOf("bge-m3");
    expect(resolveModelSentinel(-1, t.conflictLow)).toBe(0.55);
    expect(resolveModelSentinel(-1, t.conflictHigh)).toBe(0.85);
    expect(resolveModelSentinel(-1, t.dedupSim)).toBe(0.85);
  });

  test("사용자 오버라이드는 모델과 무관 — 명시값이면 모델이 무엇이든 그 값", () => {
    const bge = conflictThresholdsOf("bge-m3");
    // 사용자가 conflictCheckMin=0.6 으로 직접 저장하면 bge-m3 의 0.55 가 아니라 0.6.
    expect(resolveModelSentinel(0.6, bge.conflictLow)).toBe(0.6);
  });
});
