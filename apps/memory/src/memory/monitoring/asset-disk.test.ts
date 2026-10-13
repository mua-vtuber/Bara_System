/**
 * asset-disk.test.ts — Phase 11b T2.
 *
 * 자산 디스크 사용량 측정 + 임계 검증 두 함수 단위 검증.
 * threshold default 0.80 = 80%. 미도달 = exceeded false / 도달·초과 = exceeded true.
 *
 * getAssetDirUsage 는 실제 `du -sb` + statfs 호출 — 단위 test 대상 X
 * (통합 sanity 는 runAssetDiskMonitor 또는 monitor.ts 가동에서 검증).
 */

import { describe, expect, test } from "bun:test";

import { checkAssetThreshold } from "./asset-disk.ts";

describe("checkAssetThreshold", () => {
  test("미도달 = exceeded false + 안전 메시지", () => {
    const result = checkAssetThreshold(
      { totalBytes: 100, usedBytes: 50, percent: 0.5 },
      0.8,
    );
    expect(result.exceeded).toBe(false);
    expect(result.message).toContain("50.0%");
    expect(result.message).toContain("80%");
  });

  test("정확 도달 = exceeded true (>= 비교)", () => {
    const result = checkAssetThreshold(
      { totalBytes: 100, usedBytes: 80, percent: 0.8 },
      0.8,
    );
    expect(result.exceeded).toBe(true);
    expect(result.message).toContain("80.0%");
    expect(result.message).toContain("초과");
  });

  test("초과 = exceeded true + 정직 사용량 정수", () => {
    const result = checkAssetThreshold(
      {
        totalBytes: 100_000_000_000,
        usedBytes: 95_000_000_000,
        percent: 0.95,
      },
      0.8,
    );
    expect(result.exceeded).toBe(true);
    expect(result.message).toMatch(/95\.0%/);
    expect(result.message).toMatch(/95\.00GB/);
    expect(result.message).toMatch(/100\.00GB/);
  });

  test("빈 dir = percent 0 = exceeded false", () => {
    const result = checkAssetThreshold(
      { totalBytes: 100, usedBytes: 0, percent: 0 },
      0.8,
    );
    expect(result.exceeded).toBe(false);
    expect(result.message).toContain("0.0%");
  });
});
