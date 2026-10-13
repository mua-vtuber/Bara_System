/**
 * Tests for Stanford 3-factor scoring.
 *
 * Verifies parity with backend/app/services/memory/scoring.py behavior:
 * - exponential decay shape (1.0 at age=0, 0.5 at one half-life)
 * - timezone-naive ISO strings interpreted as UTC
 * - clamping into [0, 1]
 * - keyword-arg style options object
 */

import { describe, expect, test } from "bun:test";
import {
  computeRecency,
  computeEffectiveImportance,
  computeNodeValue,
} from "./scoring.ts";

describe("computeRecency", () => {
  test("returns 1.0 for just-accessed Date", () => {
    expect(computeRecency(new Date())).toBeCloseTo(1.0, 4);
  });

  test("returns ~0.5 at one half-life ago", () => {
    const halfLifeDays = 30;
    const past = new Date(Date.now() - halfLifeDays * 24 * 3600 * 1000);
    expect(computeRecency(past, halfLifeDays)).toBeCloseTo(0.5, 3);
  });

  test("returns ~0.25 at two half-lives ago", () => {
    const halfLifeDays = 30;
    const past = new Date(Date.now() - 2 * halfLifeDays * 24 * 3600 * 1000);
    expect(computeRecency(past, halfLifeDays)).toBeCloseTo(0.25, 3);
  });

  test("custom half-life is honored", () => {
    const halfLifeDays = 7;
    const past = new Date(Date.now() - halfLifeDays * 24 * 3600 * 1000);
    expect(computeRecency(past, halfLifeDays)).toBeCloseTo(0.5, 3);
  });

  test("treats future timestamp as age=0 → 1.0", () => {
    const future = new Date(Date.now() + 60_000);
    expect(computeRecency(future)).toBeCloseTo(1.0, 4);
  });

  test("accepts ISO string with Z (UTC)", () => {
    const isoNow = new Date().toISOString();
    expect(computeRecency(isoNow)).toBeCloseTo(1.0, 4);
  });

  test("naive ISO string is treated as UTC (Python parity)", () => {
    // 30 days ago, naive ISO (no timezone marker)
    const past = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const naiveIso = past.toISOString().replace("Z", ""); // strip trailing Z
    expect(computeRecency(naiveIso, 30)).toBeCloseTo(0.5, 2);
  });

  test("returns 0.0 for unparseable string", () => {
    expect(computeRecency("not-a-date")).toBe(0.0);
    expect(computeRecency("")).toBe(0.0);
  });

  test("halfLifeDays = 0 returns 1.0 only when age is exactly 0", () => {
    // Just accessed (Date.now() within microseconds)
    const now = new Date();
    expect(computeRecency(now, 0)).toBe(1.0);

    // Even 1 second ago → 0.0
    const oneSecAgo = new Date(Date.now() - 1000);
    expect(computeRecency(oneSecAgo, 0)).toBe(0.0);
  });

  test("score always in [0, 1]", () => {
    const veryOld = new Date(2000, 0, 1);
    const s = computeRecency(veryOld);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe("computeEffectiveImportance", () => {
  test("시간 0 (방금 봄) → importance 그대로 반환", () => {
    const now = new Date();
    expect(computeEffectiveImportance(0.5, now, 90)).toBeCloseTo(0.5, 5);
    expect(computeEffectiveImportance(0.3, now, 90)).toBeCloseTo(0.3, 5);
  });

  test("90일 (반감기) 지나면 importance 절반", () => {
    const past = new Date(Date.now() - 90 * 24 * 3600 * 1000);
    expect(computeEffectiveImportance(0.5, past, 90)).toBeCloseTo(0.25, 2);
  });

  test("365일 안 봄 + importance 0.5 → 약 0.03", () => {
    const past = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    const result = computeEffectiveImportance(0.5, past, 90);
    expect(result).toBeLessThan(0.04);
    expect(result).toBeGreaterThan(0.025);
  });

  test("결과 항상 [0, 1] clamp", () => {
    const past = new Date(Date.now() - 10000 * 24 * 3600 * 1000);
    expect(computeEffectiveImportance(1.0, past, 90)).toBeGreaterThanOrEqual(0);
    expect(computeEffectiveImportance(1.0, new Date(), 90)).toBeLessThanOrEqual(
      1,
    );
  });

  test("parse 실패 시 0.0", () => {
    expect(computeEffectiveImportance(0.5, "invalid-date", 90)).toBe(0.0);
  });
});

describe("computeNodeValue", () => {
  test("갓 만든 importance 0.3 mention 0 → 0.36", () => {
    const v = computeNodeValue({
      importance: 0.3,
      lastAccessedAt: new Date(),
      mentionCount: 0,
    });
    expect(v).toBeCloseTo(0.36, 2);
  });

  test("1년 안 본 importance 0.3 mention 0 → 0.004 근처 (휴지통 후보)", () => {
    const past = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    const v = computeNodeValue({
      importance: 0.3,
      lastAccessedAt: past,
      mentionCount: 0,
    });
    expect(v).toBeLessThan(0.01);
  });

  test("1년 안 본 importance 0.7 mention 5회 → 살아남음 (≥ 0.25)", () => {
    const past = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    const v = computeNodeValue({
      importance: 0.7,
      lastAccessedAt: past,
      mentionCount: 5,
    });
    expect(v).toBeGreaterThan(0.25);
  });

  test("결과 [0, 1] clamp", () => {
    const v = computeNodeValue({
      importance: 1.0,
      lastAccessedAt: new Date(),
      mentionCount: 100,
    });
    expect(v).toBeLessThanOrEqual(1.0);
    expect(v).toBeGreaterThanOrEqual(0.0);
  });
});

// ── Task 12: isProtected 시간 감쇠 면제 (spec 4.2) ─────────────────────

describe("computeEffectiveImportance — isProtected 면제", () => {
  const longAgo = "2020-01-01 00:00:00"; // ~6년 전, 정상이면 거의 0

  test("isProtected=true → 시간 무관 importance 그대로 반환", () => {
    expect(computeEffectiveImportance(0.7, longAgo, 90, true)).toBe(0.7);
    expect(computeEffectiveImportance(1.0, longAgo, 90, true)).toBe(1.0);
    expect(computeEffectiveImportance(0.3, longAgo, 90, true)).toBe(0.3);
  });

  test("isProtected=false 면 정상 감쇠 (6년 전 → ≈0)", () => {
    const decayed = computeEffectiveImportance(0.7, longAgo, 90, false);
    expect(decayed).toBeGreaterThanOrEqual(0);
    expect(decayed).toBeLessThan(0.01);
  });

  test("isProtected default 는 false (4번째 인자 생략 = 정상 감쇠)", () => {
    const decayed = computeEffectiveImportance(0.7, longAgo, 90);
    const explicitFalse = computeEffectiveImportance(0.7, longAgo, 90, false);
    expect(decayed).toBe(explicitFalse);
    expect(decayed).toBeLessThan(0.01);
  });

  test("isProtected=true 면 parse 실패 timestamp 도 importance 반환", () => {
    expect(computeEffectiveImportance(0.5, "not-a-date", 90, true)).toBe(0.5);
    // 정상 모드는 parse 실패 시 0
    expect(computeEffectiveImportance(0.5, "not-a-date", 90, false)).toBe(0);
  });

  test("isProtected=true 도 [0, 1] clamp", () => {
    expect(computeEffectiveImportance(1.5, longAgo, 90, true)).toBe(1.0);
    expect(computeEffectiveImportance(-0.3, longAgo, 90, true)).toBe(0);
  });
});

describe("computeNodeValue — isProtected 입력 전파", () => {
  const longAgo = "2020-01-01 00:00:00";

  test("NodeValueInput.isProtected 가 evolver 가치 점수 보호", () => {
    const protectedValue = computeNodeValue({
      importance: 0.9,
      lastAccessedAt: longAgo,
      mentionCount: 0,
      isProtected: true,
    });
    const decayedValue = computeNodeValue({
      importance: 0.9,
      lastAccessedAt: longAgo,
      mentionCount: 0,
      isProtected: false,
    });
    expect(protectedValue).toBeGreaterThan(decayedValue);
    // 보호된 노드는 importance × weight (0.2 × 0.9 = 0.18) 만큼 보장
    expect(protectedValue).toBeGreaterThanOrEqual(0.18);
  });
});
