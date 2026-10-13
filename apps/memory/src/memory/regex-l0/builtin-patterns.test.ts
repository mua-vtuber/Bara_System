/**
 * builtin 한국어 양식 fixture 검증.
 *
 * 데이터 fixture 방식 (순수 함수 입력 → 출력 검증). mock 객체 사용하지 않는다.
 * 각 builtin 양식의 exampleInput 을 그 양식 regex 로 매치 → 첫 캡처 그룹(없으면
 * m[0]) trim 길이 ≥ 2 검증. 매치 실패하는 양식이 0개여야 한다.
 */

import { describe, expect, test } from "bun:test";
import { BUILTIN_PATTERNS } from "./builtin-patterns.ts";

describe("BUILTIN_PATTERNS — 한국어 builtin 양식", () => {
  test("양식이 약 30개 이상 정의되어 있다", () => {
    expect(BUILTIN_PATTERNS.length).toBeGreaterThanOrEqual(30);
  });

  test("모든 양식이 ko 언어 + enabled + 점수 -2..3 + 분류 적합", () => {
    const validCategories = new Set([
      "decision",
      "preference",
      "constraint",
      "status",
      "fact",
      "technical",
    ]);
    for (const p of BUILTIN_PATTERNS) {
      expect(p.lang).toBe("ko");
      expect(p.enabled).toBe(true);
      expect(validCategories.has(p.category)).toBe(true);
      expect(p.score).toBeGreaterThanOrEqual(1);
      expect(p.score).toBeLessThanOrEqual(3);
      expect(p.polarity).toBeDefined();
    }
  });

  test("양식 id 가 모두 고유하다", () => {
    const ids = BUILTIN_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("pattern 문자열이 regex 로 정합 컴파일된다", () => {
    for (const p of BUILTIN_PATTERNS) {
      const recompiled = new RegExp(p.pattern, p.regex.flags);
      expect(recompiled.source).toBe(p.regex.source);
    }
  });

  test("기술 양식(technical)이 default ON 으로 포함된다 (사용자 결정 #1)", () => {
    const technical = BUILTIN_PATTERNS.filter(
      (p) => p.category === "technical",
    );
    expect(technical.length).toBeGreaterThanOrEqual(1);
    for (const p of technical) {
      expect(p.enabled).toBe(true);
    }
  });

  test("각 양식의 exampleInput 이 그 양식 regex 로 매치된다", () => {
    const failures: string[] = [];
    for (const p of BUILTIN_PATTERNS) {
      if (p.exampleInput === undefined) continue;
      const m = p.exampleInput.match(p.regex);
      if (m === null) {
        failures.push(`${p.id}: "${p.exampleInput}" 매치 실패`);
        continue;
      }
      const extracted = (m[1] ?? m[0]).trim();
      if (extracted.length < 2) {
        failures.push(
          `${p.id}: 추출 내용 "${extracted}" 길이 < 2`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  test("exampleInput 이 있는 양식이 충분히 존재한다 (검증 가치)", () => {
    const withExample = BUILTIN_PATTERNS.filter(
      (p) => p.exampleInput !== undefined,
    );
    expect(withExample.length).toBeGreaterThanOrEqual(20);
  });

  // drift 고정 — 자가 검증 페이지(T11/T12)가 exampleExtracted 를 "이 입력은
  // 이렇게 추출됩니다" 표시 값으로 쓴다. 정규식이 실제 뽑는 값(첫 캡처 그룹
  // m[1] trim, 없으면 m[0] trim — Level 0 추출 규칙)과 exampleExtracted 가
  // 어긋나면 거짓 표시가 된다. 이 test 가 실제 추출값 === exampleExtracted 를
  // 양식 하나하나 고정해, 앞으로 정규식을 건드려 추출이 달라지면 큰 소리로
  // 깨진다.
  test("각 양식의 실제 추출값이 exampleExtracted 와 정확히 일치한다 (drift 고정)", () => {
    const pinned: string[] = [];
    const failures: string[] = [];
    for (const p of BUILTIN_PATTERNS) {
      if (p.exampleInput === undefined || p.exampleExtracted === undefined) {
        continue;
      }
      const m = p.exampleInput.match(p.regex);
      if (m === null) {
        failures.push(`${p.id}: "${p.exampleInput}" 매치 실패`);
        continue;
      }
      const actual = (m[1] ?? m[0]).trim();
      pinned.push(p.id);
      if (actual !== p.exampleExtracted) {
        failures.push(
          `${p.id}: 실제 추출 "${actual}" !== exampleExtracted "${p.exampleExtracted}"`,
        );
      }
    }
    expect(failures).toEqual([]);
    // exampleExtracted 를 둔 양식이 빠짐없이 고정 대상에 들어왔는지 확인한다.
    const withBoth = BUILTIN_PATTERNS.filter(
      (p) => p.exampleInput !== undefined && p.exampleExtracted !== undefined,
    );
    expect(pinned.length).toBe(withBoth.length);
    expect(pinned.length).toBeGreaterThanOrEqual(30);
  });
});
