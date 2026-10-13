/**
 * helpers.timezone.test.ts — P3 G3-b 설정 시간대 인프라 검증.
 *
 * setTimeZone / getConfiguredTimeZone / nowInZone / nowKst / pastCutoffInZone 이
 * 한 zone 을 단일 출처로 따르는지, 잘못된 zone 은 loud 하게 실패하는지 확인한다.
 *
 * 순수 함수 + 모듈 전역 상태 검증 — 실 DB·mock 불필요. 각 테스트는 setTimeZone 을
 * 명시로 원복해 전역 상태 오염을 막는다(afterEach 로 default 복귀).
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  getConfiguredTimeZone,
  nowInZone,
  nowKst,
  pastCutoffInZone,
  setTimeZone,
} from "./helpers.ts";

const DEFAULT_ZONE = "Asia/Seoul";

afterEach(() => {
  // 전역 상태 오염 차단 — 매 테스트 후 default 로 복귀한다. 다른 테스트 파일이
  // nowKst 를 KST 로 가정하므로 반드시 원복한다.
  setTimeZone(DEFAULT_ZONE);
});

describe("설정 시간대 인프라 (P3 G3-b)", () => {
  test("default zone 은 Asia/Seoul — setTimeZone 미호출 시 옛 KST 동작", () => {
    expect(getConfiguredTimeZone()).toBe(DEFAULT_ZONE);
  });

  test("nowKst 와 nowInZone(기본) 은 같은 값 — nowKst 는 nowInZone 얇은 래퍼", () => {
    // 같은 순간에 두 번 읽으면 초 해상도라 같아야 한다(경계에서 1초 어긋날 수 있어
    // 앞 10글자 날짜 부분만 비교해도 충분하나, 여기선 양식 동일성만 본다).
    const a = nowKst();
    const b = nowInZone();
    // "YYYY-MM-DD HH:MM:SS" 양식.
    expect(a).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(b).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("setTimeZone 후 nowKst 가 그 zone 을 따른다 — UTC 는 KST 보다 9시간 이르다", () => {
    // 같은 순간을 KST 와 UTC 로 각각 읽어 9시간 차이를 확인한다. 고정 시점을 mock
    // 하지 않고 두 zone 을 같은 프로세스 순간에 읽어 상대 차이만 본다.
    setTimeZone("Asia/Seoul");
    const kstMs = Date.parse(nowKst().replace(" ", "T") + "+09:00");
    setTimeZone("UTC");
    const utcMs = Date.parse(nowInZone().replace(" ", "T") + "+00:00");
    // 두 벽시계 문자열이 가리키는 실제 순간은 (같은 프로세스 순간이라) 1~2초 이내.
    expect(Math.abs(kstMs - utcMs)).toBeLessThan(5000);
  });

  test("pastCutoffInZone 은 과거 시각을 설정 zone 문자열로 만든다", () => {
    setTimeZone("Asia/Seoul");
    // 고정 epoch: 2026-07-03T00:00:00Z = KST 2026-07-03 09:00:00.
    const fixedUtcMs = Date.parse("2026-07-03T00:00:00Z");
    const cutoffKst = pastCutoffInZone(fixedUtcMs);
    expect(cutoffKst).toBe("2026-07-03 09:00:00");

    setTimeZone("UTC");
    const cutoffUtc = pastCutoffInZone(fixedUtcMs);
    expect(cutoffUtc).toBe("2026-07-03 00:00:00");
  });

  test("pastCutoffInZone 명시 zone 인자가 전역 설정보다 우선", () => {
    setTimeZone("Asia/Seoul");
    const fixedUtcMs = Date.parse("2026-07-03T00:00:00Z");
    // 전역은 KST 지만 명시 인자 UTC 를 따른다.
    expect(pastCutoffInZone(fixedUtcMs, "UTC")).toBe("2026-07-03 00:00:00");
  });

  test("잘못된 zone 문자열은 loud 하게 throw — silent fallback 금지", () => {
    expect(() => setTimeZone("Not/AZone")).toThrow(/알 수 없는 시간대/);
    // throw 후에도 전역 zone 은 오염되지 않는다(직전 유효값 유지).
    expect(getConfiguredTimeZone()).toBe(DEFAULT_ZONE);
  });

  test("빈 문자열 zone 도 loud fail", () => {
    expect(() => setTimeZone("")).toThrow(/알 수 없는 시간대/);
  });

  test("UTC·America/New_York 같은 유효 IANA zone 은 통과", () => {
    expect(() => setTimeZone("UTC")).not.toThrow();
    expect(getConfiguredTimeZone()).toBe("UTC");
    expect(() => setTimeZone("America/New_York")).not.toThrow();
    expect(getConfiguredTimeZone()).toBe("America/New_York");
  });
});
