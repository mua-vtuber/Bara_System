/**
 * error-classifier.test.ts — LLM 오류 3분류 순수 함수 검증 (spec 4.A-2).
 *
 * 분류기는 status/timedOut 필드만 보는 순수 함수 — 문자열 파싱 0. 데이터 fixture 로
 * status·timedOut 조합을 입력해 transient/deterministic/config 회신을 검증한다(Mock 0).
 *
 * 3분류 의미(spec 8 실패 의미론 총괄표):
 *   - transient: 429 / 5xx / 네트워크 단절 / timeout — 대상별 terminal 절대 금지, 실행층 재시도.
 *   - config:    400 / 401 / 403 — 사이클 통째 중단(설정 결함).
 *   - deterministic: 그 외(파싱 실패·ID 탈락·max_tokens 잘림·404/422 등) — fingerprint 단위 attempt 누적.
 */

import { describe, expect, test } from "bun:test";
import { classifyLlmError } from "./error-classifier.ts";

describe("classifyLlmError — transient (일시 오류)", () => {
  test("429 → transient", () => {
    expect(classifyLlmError({ status: 429, timedOut: false })).toBe("transient");
  });

  test("500 → transient (5xx 하한)", () => {
    expect(classifyLlmError({ status: 500, timedOut: false })).toBe("transient");
  });

  test("503 → transient", () => {
    expect(classifyLlmError({ status: 503, timedOut: false })).toBe("transient");
  });

  test("599 → transient (5xx 상한)", () => {
    expect(classifyLlmError({ status: 599, timedOut: false })).toBe("transient");
  });

  test("timedOut=true → transient (상태 코드 없어도 timeout 우선)", () => {
    expect(classifyLlmError({ status: null, timedOut: true })).toBe("transient");
  });

  test("status=null + timedOut=false → transient (네트워크 단절)", () => {
    expect(classifyLlmError({ status: null, timedOut: false })).toBe("transient");
  });

  test("timedOut=true 는 status 값과 무관하게 transient (내부 timeout 이 우선)", () => {
    // 방어적 조합 — timeout abort 로 끊긴 뒤 어떤 상태값이 실려도 일시로 본다.
    expect(classifyLlmError({ status: 400, timedOut: true })).toBe("transient");
  });
});

describe("classifyLlmError — config (설정 오류)", () => {
  test("400 → config", () => {
    expect(classifyLlmError({ status: 400, timedOut: false })).toBe("config");
  });

  test("401 → config", () => {
    expect(classifyLlmError({ status: 401, timedOut: false })).toBe("config");
  });

  test("403 → config", () => {
    expect(classifyLlmError({ status: 403, timedOut: false })).toBe("config");
  });
});

describe("classifyLlmError — deterministic (결정적 오류)", () => {
  test("404 → deterministic (config 3종 외 4xx)", () => {
    expect(classifyLlmError({ status: 404, timedOut: false })).toBe("deterministic");
  });

  test("422 → deterministic (내용 문제 — 같은 입력 재발)", () => {
    expect(classifyLlmError({ status: 422, timedOut: false })).toBe("deterministic");
  });

  test("409 → deterministic", () => {
    expect(classifyLlmError({ status: 409, timedOut: false })).toBe("deterministic");
  });

  test("200 등 비오류 상태가 오분류로 들어와도 deterministic (transient·config 아님)", () => {
    // 파싱 실패·ID 탈락은 status 200 으로 도착할 수 있다 — 이 부류는 결정적.
    expect(classifyLlmError({ status: 200, timedOut: false })).toBe("deterministic");
  });
});
