/**
 * bun-fetch — Bun fetch 기본 300초 제한을 끄는 옵션이 호출 옵션에 실제로 실리는지 (2026-10-14 backfill-retry-ledger spec 3장·7장 A).
 * 서버 쪽에서는 클라이언트의 fetch 옵션을 볼 수 없으므로, 호출이 쓰는 요청 옵션 만들기 함수의 결과를 검사한다.
 * 300초를 넘기는 실제 확인은 자동 시험에서 빼고 수동 스크립트로 한다(5분 이상 걸림 — 계획 Task 11).
 */
import { describe, expect, test } from "bun:test";
import { ANTHROPIC_SDK_FETCH_OPTIONS, BUN_FETCH_NO_DEFAULT_TIMEOUT } from "./bun-fetch.ts";
import { buildOllamaChatInit } from "./ollama-client.ts";
import { buildProviderFetchInit } from "./provider-http.ts";
import { buildAnthropicClientOptions } from "./anthropic-client.ts";
import { buildAnthropicVisionClientOptions } from "./vision/anthropic.ts";

describe("Bun 기본 300초 제한 끄기 옵션", () => {
  test("공용 상수는 timeout:false 한 칸이고 바꿀 수 없다", () => {
    expect(BUN_FETCH_NO_DEFAULT_TIMEOUT).toEqual({ timeout: false });
    expect(Object.isFrozen(BUN_FETCH_NO_DEFAULT_TIMEOUT)).toBe(true);
    expect(ANTHROPIC_SDK_FETCH_OPTIONS).toEqual({ timeout: false } as never);
  });

  test("Ollama /api/chat 요청 옵션 — timeout:false 와 내부 제한 signal 이 함께 실린다", () => {
    const controller = new AbortController();
    const init = buildOllamaChatInit({ model: "m", stream: false }, controller.signal);
    expect(init).toMatchObject({ method: "POST", timeout: false, body: JSON.stringify({ model: "m", stream: false }) });
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(init.signal).toBe(controller.signal);
  });

  test("공급자 공통 요청 옵션 — POST·GET 모두 timeout:false, GET 은 본문 없음", () => {
    const controller = new AbortController();
    const post = buildProviderFetchInit({
      provider: "openai", label: "OpenAI /chat/completions", url: "http://127.0.0.1:1/v1/chat/completions",
      method: "POST", headers: { Authorization: "Bearer k" }, body: { a: 1 }, timeoutMs: 1000,
    }, controller.signal);
    expect(post).toMatchObject({ method: "POST", timeout: false, body: '{"a":1}', headers: { Authorization: "Bearer k" } });
    expect(post.signal).toBe(controller.signal);
    const get = buildProviderFetchInit({
      provider: "google", label: "Gemini models", url: "http://127.0.0.1:1/v1beta/models", method: "GET", headers: {}, timeoutMs: 1000,
    }, controller.signal);
    expect(get.timeout).toBe(false);
    expect("body" in get).toBe(false);
  });

  test("Anthropic SDK 생성자 옵션(글·캡션) — fetchOptions.timeout=false, 나머지 칸은 그대로", () => {
    expect(buildAnthropicClientOptions({ apiKey: "sk-ant-test", model: "claude-haiku-4-5", timeoutMs: 900000, maxRetries: 0 }))
      .toEqual({ apiKey: "sk-ant-test", maxRetries: 0, timeout: 900000, fetchOptions: { timeout: false } } as never);
    expect(buildAnthropicVisionClientOptions({
      apiKey: "sk-ant-test", model: "claude-haiku-4-5", limitSettingPath: "llm.vision.tokenCap", baseURL: "http://127.0.0.1:9",
    })).toEqual({ apiKey: "sk-ant-test", baseURL: "http://127.0.0.1:9", fetchOptions: { timeout: false } } as never);
  });
});
