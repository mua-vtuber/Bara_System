/**
 * 백필 실패 분류 — spec 4.3 표의 각 줄을 하나씩 (순수 함수, 데이터 fixture 만).
 */
import { describe, expect, test } from "bun:test";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk/error";
import { LlmRequestError } from "../../llm/errors.ts";
import { BackfillRechunkError, classifyBackfillFailure } from "./classify.ts";

function llmError(status: number | null, timedOut = false): LlmRequestError {
  return new LlmRequestError({
    provider: "ollama", message: `status ${status}`, status, code: null, retryAfterMs: null, timedOut,
  });
}

describe("LlmRequestError — 상태·시간 초과 칸만 본다", () => {
  test("시간 초과는 센다", () => {
    expect(classifyBackfillFailure(llmError(null, true))).toEqual({ klass: "counted", status: null });
  });
  test("응답 없음(연결 거부·끊김)은 주기 중단 connection", () => {
    expect(classifyBackfillFailure(llmError(null))).toEqual({ klass: "stop_cycle", reason: "connection", status: null });
  });
  test.each([429, 500, 502, 503, 504])("%i 는 일시 장애 — 세지 않음", (status) => {
    expect(classifyBackfillFailure(llmError(status))).toEqual({ klass: "uncounted", status });
  });
  test.each([401, 403, 404])("%i 는 설정 문제 — 주기 중단 config", (status) => {
    expect(classifyBackfillFailure(llmError(status))).toEqual({ klass: "stop_cycle", reason: "config", status });
  });
  test.each([400, 409, 413, 422])("%i 는 입력 탓 — 센다", (status) => {
    expect(classifyBackfillFailure(llmError(status))).toEqual({ klass: "counted", status });
  });
});

describe("Anthropic SDK 오류(캡션 공급자가 그대로 던짐) — 같은 규칙", () => {
  test("사용자 취소는 주기 중단 aborted", () => {
    expect(classifyBackfillFailure(new APIUserAbortError())).toEqual({ klass: "stop_cycle", reason: "aborted", status: null });
  });
  test("연결 시간 초과는 센다", () => {
    expect(classifyBackfillFailure(new APIConnectionTimeoutError())).toEqual({ klass: "counted", status: null });
  });
  test("연결 실패는 주기 중단 connection", () => {
    expect(classifyBackfillFailure(new APIConnectionError({ message: "refused" })))
      .toEqual({ klass: "stop_cycle", reason: "connection", status: null });
  });
  test("상태가 있는 APIError 는 상태 규칙대로", () => {
    expect(classifyBackfillFailure(new APIError(401, undefined, "unauthorized", new Headers())))
      .toEqual({ klass: "stop_cycle", reason: "config", status: 401 });
    expect(classifyBackfillFailure(new APIError(529, undefined, "overloaded", new Headers())))
      .toEqual({ klass: "uncounted", status: 529 });
    expect(classifyBackfillFailure(new APIError(400, undefined, "bad", new Headers())))
      .toEqual({ klass: "counted", status: 400 });
  });
});

describe("그 밖의 오류", () => {
  test("외부 취소(AbortError)는 주기 중단 aborted", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classifyBackfillFailure(abort)).toEqual({ klass: "stop_cycle", reason: "aborted", status: null });
  });
  test("응답 형식 오류·빈 캡션·자산 없음 같은 일반 예외는 센다", () => {
    expect(classifyBackfillFailure(new Error("Ollama response missing message.content"))).toEqual({ klass: "counted", status: null });
    expect(classifyBackfillFailure("문자열 오류")).toEqual({ klass: "counted", status: null });
  });
  test("Bun 의 TimeoutError(이름이 AbortError 가 아님)는 시간 초과 계열로 센다", () => {
    const bunTimeout = Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    expect(classifyBackfillFailure(bunTimeout)).toEqual({ klass: "counted", status: null });
  });
});

describe("재청크 실패 — cause 를 풀어 같은 규칙", () => {
  test("cause 가 연결 실패면 주기 중단, 시간 초과면 셈", () => {
    expect(classifyBackfillFailure(new BackfillRechunkError("재청크 실패", { cause: llmError(null) })))
      .toEqual({ klass: "stop_cycle", reason: "connection", status: null });
    expect(classifyBackfillFailure(new BackfillRechunkError("재청크 실패", { cause: llmError(null, true) })))
      .toEqual({ klass: "counted", status: null });
  });
  test("cause 가 일반 오류(DB 잠김 등)면 센다", () => {
    expect(classifyBackfillFailure(new BackfillRechunkError("재청크 실패", { cause: new Error("database is locked") })))
      .toEqual({ klass: "counted", status: null });
  });
  test("재청크 오류가 아닌 일반 Error 의 cause 는 풀지 않는다", () => {
    expect(classifyBackfillFailure(new Error("감싼 오류", { cause: llmError(null) }))).toEqual({ klass: "counted", status: null });
  });
});
