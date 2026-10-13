import { describe, expect, test } from "bun:test";
import {
  buildGeminiRequest,
  chatMessagesToGemini,
  geminiErrorCode,
  geminiErrorReasons,
  parseGeminiResponse,
  stripGeminiModelPrefix,
} from "./gemini-wire.ts";

describe("Gemini 요청 변환", () => {
  test("system → systemInstruction, assistant → model, JSON 스키마 → responseJsonSchema", () => {
    const { systemInstruction, contents } = chatMessagesToGemini([
      { role: "system", content: "규칙 A" },
      { role: "system", content: "규칙 B" },
      { role: "user", content: "질문" },
      { role: "assistant", content: "답" },
    ]);
    const body = buildGeminiRequest(systemInstruction, contents, {
      temperature: 0.2,
      maxOutputTokens: 128,
      jsonSchema: { type: "object" },
    });
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: "규칙 A\n\n규칙 B" }] },
      contents: [
        { role: "user", parts: [{ text: "질문" }] },
        { role: "model", parts: [{ text: "답" }] },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 128,
        responseMimeType: "application/json",
        responseJsonSchema: { type: "object" },
      },
    });
  });

  test("jsonMode 만이면 responseMimeType 만, 옵션이 없으면 generationConfig 자체가 없다", () => {
    const { contents } = chatMessagesToGemini([{ role: "user", content: "x" }]);
    expect(buildGeminiRequest(undefined, contents, { jsonMode: true }).generationConfig).toEqual({
      responseMimeType: "application/json",
    });
    expect("generationConfig" in buildGeminiRequest(undefined, contents, {})).toBe(false);
  });

  test("user/assistant 메시지가 없으면 던진다", () => {
    expect(() => chatMessagesToGemini([{ role: "system", content: "only" }])).toThrow("비어 있다");
  });

  test("모델 앞 models/ 는 뗀다", () => {
    expect(stripGeminiModelPrefix("models/gemini-2.5-flash")).toBe("gemini-2.5-flash");
    expect(stripGeminiModelPrefix(" gemini-2.5-pro ")).toBe("gemini-2.5-pro");
  });
});

describe("Gemini 응답 해석", () => {
  test("STOP + 생각 조각 제외 + 사용량(캐시는 입력에서 빼고 생각은 출력에 더함)", () => {
    const result = parseGeminiResponse({
      candidates: [
        {
          content: { parts: [{ text: "생각 중...", thought: true }, { text: '{"ok":' }, { text: "true}" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 40, thoughtsTokenCount: 200, cachedContentTokenCount: 100, totalTokenCount: 740 },
    });
    expect(result).toEqual({
      text: '{"ok":true}',
      stopReason: "stop",
      usage: { inputTokens: 400, outputTokens: 240, cacheReadTokens: 100, cacheWriteTokens: 0 },
    });
  });

  test("MAX_TOKENS + 생각만 있고 글 없음 → 빈 글 + max_tokens (던지지 않음)", () => {
    const result = parseGeminiResponse({
      candidates: [{ content: { parts: [{ text: "생각", thought: true }] }, finishReason: "MAX_TOKENS" }],
      usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 64 },
    });
    expect(result.text).toBe("");
    expect(result.stopReason).toBe("max_tokens");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 64, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  test("MAX_TOKENS + 글 있음 → 글 + max_tokens", () => {
    const result = parseGeminiResponse({ candidates: [{ content: { parts: [{ text: "앞부분" }] }, finishReason: "MAX_TOKENS" }] });
    expect(result).toEqual({ text: "앞부분", stopReason: "max_tokens", usage: null });
  });

  test("promptFeedback.blockReason → 사유를 담아 던진다", () => {
    expect(() => parseGeminiResponse({ promptFeedback: { blockReason: "SAFETY" } })).toThrow("blockReason=SAFETY");
  });

  test("후보 0개 → 던진다", () => {
    expect(() => parseGeminiResponse({ candidates: [] })).toThrow("0개");
  });

  test("SAFETY 로 멈추고 글 없음 → 사유를 담아 던진다", () => {
    expect(() => parseGeminiResponse({ candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] })).toThrow(
      "finishReason=SAFETY",
    );
  });

  test("그 밖의 finishReason 은 other", () => {
    expect(parseGeminiResponse({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "RECITATION" }] }).stopReason).toBe("other");
  });

  test("오류 본문의 error.status 를 code 로 꺼낸다", () => {
    expect(geminiErrorCode('{"error":{"code":429,"message":"quota","status":"RESOURCE_EXHAUSTED"}}')).toBe("RESOURCE_EXHAUSTED");
    expect(geminiErrorCode("not json")).toBeNull();
    // AIP-193 오류 모델의 ErrorInfo.reason 만 꺼낸다(본문·키는 담지 않음).
    const badKey = JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid", details: [
      { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" },
      { "@type": "type.googleapis.com/google.rpc.LocalizedMessage", locale: "en-US", message: "x" },
    ] } });
    expect(geminiErrorReasons(badKey)).toEqual(["API_KEY_INVALID"]);
    expect(geminiErrorReasons('{"error":{"code":400,"status":"INVALID_ARGUMENT"}}')).toEqual([]);
    expect(geminiErrorReasons("not json")).toEqual([]);
  });
});
