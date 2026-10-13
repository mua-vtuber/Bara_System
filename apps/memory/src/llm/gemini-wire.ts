/**
 * gemini-wire.ts — Google Gemini 공식 REST generateContent 요청·응답 변환 (순수 함수, 네트워크 없음).
 * 2026-10-11 llm-api-providers spec D2·D7. 글 클라이언트(gemini-client.ts)와 이미지 캡션
 * (vision/gemini.ts)이 같이 쓴다.
 *
 * 공식 칸만 쓴다:
 *   - 요청: systemInstruction, contents[].parts[](text / inlineData{mimeType,data}), generationConfig
 *     (temperature, maxOutputTokens, responseMimeType, responseJsonSchema).
 *   - 응답: candidates[].content.parts[], candidates[].finishReason, promptFeedback.blockReason,
 *     usageMetadata(promptTokenCount, candidatesTokenCount, thoughtsTokenCount, cachedContentTokenCount).
 *
 * 잘림: finishReason "MAX_TOKENS" → max_tokens. 글 없이 잘린 응답은 빈 글 그대로 돌려주고(정리 실행층이
 * 한도를 올려 다시 부름), 잘림이 아닌데 글이 없으면(SAFETY 등) 사유를 담아 던진다. 요청이 차단됐거나
 * 후보가 0개면 사유를 담아 던진다(결정적 실패). 생각 조각(parts[].thought === true)은 본문에서 뺀다.
 */

import type { ChatMessage, LlmChatOptions, LlmChatResult } from "./types.ts";
import { maskProviderText } from "./provider-http.ts";

export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export type GeminiBodyOptions = Pick<LlmChatOptions, "temperature" | "maxOutputTokens" | "jsonMode" | "jsonSchema">;

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: unknown; thought?: unknown }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  error?: { message?: string };
}

/** 모델 값 앞의 "models/" 를 뗀다(설정에는 뗀 값을 저장하지만 손으로 적은 값도 받는다). */
export function stripGeminiModelPrefix(model: string): string {
  const trimmed = model.trim();
  return trimmed.startsWith("models/") ? trimmed.slice("models/".length) : trimmed;
}

/** ChatMessage 시퀀스 → systemInstruction + contents. user/assistant 가 하나도 없으면 던진다. */
export function chatMessagesToGemini(messages: readonly ChatMessage[]): {
  systemInstruction: { parts: GeminiPart[] } | undefined;
  contents: GeminiContent[];
} {
  const systemChunks: string[] = [];
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === "system") systemChunks.push(m.content);
    else contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] });
  }
  if (contents.length === 0) {
    throw new Error("GeminiClient: user/assistant 메시지가 비어 있다");
  }
  return {
    systemInstruction: systemChunks.length > 0 ? { parts: [{ text: systemChunks.join("\n\n") }] } : undefined,
    contents,
  };
}

/** generateContent 요청 본문. */
export function buildGeminiRequest(
  systemInstruction: { parts: GeminiPart[] } | undefined,
  contents: readonly GeminiContent[],
  options: GeminiBodyOptions,
): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {};
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  if (options.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = options.maxOutputTokens;
  if (options.jsonSchema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseJsonSchema = options.jsonSchema;
  } else if (options.jsonMode) {
    generationConfig.responseMimeType = "application/json";
  }
  return {
    ...(systemInstruction ? { systemInstruction } : {}),
    contents,
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  };
}

/** finishReason 원문 → 3값. */
export function normalizeGeminiStopReason(finishReason: string | undefined): LlmChatResult["stopReason"] {
  if (finishReason === "STOP") return "stop";
  if (finishReason === "MAX_TOKENS") return "max_tokens";
  return "other";
}

/**
 * usageMetadata → 공통 뜻. 캐시 읽기는 입력에서 빼고, 생각 토큰은 출력에 더한다(과금 기준).
 * Gemini 는 0 인 칸을 생략하므로 usageMetadata 가 있으면 빠진 세부 칸은 0 이다. usageMetadata 자체나
 * promptTokenCount 가 없으면 null(0 위장 금지).
 */
export function normalizeGeminiUsage(meta: GeminiResponse["usageMetadata"]): LlmChatResult["usage"] {
  if (typeof meta?.promptTokenCount !== "number") return null;
  const cached = meta.cachedContentTokenCount ?? 0;
  return {
    inputTokens: meta.promptTokenCount - cached,
    outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

/** generateContent 응답 → LlmChatResult. 규칙은 파일 머리말. */
export function parseGeminiResponse(
  raw: unknown,
  secrets?: readonly string[],
  /** allowEmptyText — 정상 종료인데 글이 없는 후보도 빈 글로 돌려준다(문서 OCR 의 빈 쪽 전용). */
  parseOptions: { allowEmptyText?: boolean } = {},
): LlmChatResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("Gemini 응답 형식 불일치: 객체가 아님");
  }
  const json = raw as GeminiResponse;
  if (json.error?.message) {
    // 2xx 본문의 error 문장도 보낸 키를 되돌려 줄 수 있다 — 2xx 아닌 경로와 같이 가린다.
    throw new Error(`Gemini error: ${maskProviderText(json.error.message, secrets)}`);
  }
  const blockReason = json.promptFeedback?.blockReason;
  if (blockReason) {
    throw new Error(`Gemini: 요청이 차단됨 (promptFeedback.blockReason=${blockReason})`);
  }
  const candidate = json.candidates?.[0];
  if (!candidate) {
    throw new Error("Gemini: 응답 후보(candidates)가 0개");
  }
  const text = (candidate.content?.parts ?? [])
    .filter((part) => part.thought !== true)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
  const stopReason = normalizeGeminiStopReason(candidate.finishReason);
  if (text.length === 0 && stopReason !== "max_tokens" && !parseOptions.allowEmptyText) {
    throw new Error(`Gemini: 응답에 글이 없다 (finishReason=${candidate.finishReason ?? "없음"})`);
  }
  return { text, stopReason, usage: normalizeGeminiUsage(json.usageMetadata) };
}

/**
 * Gemini 오류 본문의 상세 사유 — Google API 오류 모델(AIP-193, https://google.aip.dev/193)은
 * {"error":{"code","message","status","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason","domain","metadata"}]}}
 * 모양이고, 사유 값은 google/api/error_reason.proto 의 ErrorReason(예: API_KEY_INVALID, API_KEY_SERVICE_BLOCKED)을 쓴다.
 * 잘못된 키는 HTTP 400 INVALID_ARGUMENT + reason API_KEY_INVALID 로 온다. 사유 낱말만 돌려준다(본문·키 없음).
 */
export function geminiErrorReasons(bodyText: string): string[] {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { details?: unknown } };
    const details = parsed.error?.details;
    if (!Array.isArray(details)) return [];
    const reasons: string[] = [];
    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue;
      const rec = detail as Record<string, unknown>;
      if (rec["@type"] === "type.googleapis.com/google.rpc.ErrorInfo" && typeof rec.reason === "string" && rec.reason.length > 0) {
        reasons.push(rec.reason);
      }
    }
    return reasons;
  } catch {
    return [];
  }
}

/** Gemini 오류 본문 {"error":{"status":"RESOURCE_EXHAUSTED",...}} 에서 상태 문자열을 꺼낸다. 형식이 다르면 null. */
export function geminiErrorCode(bodyText: string): string | null {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { status?: unknown } };
    const status = parsed.error?.status;
    return typeof status === "string" && status.length > 0 ? status : null;
  } catch {
    return null;
  }
}
