/**
 * openai-chat-core.ts — OpenAI 대화 형식(/chat/completions) 공통 본체 (2026-10-11 llm-api-providers spec D1·D7).
 *
 * LM Studio 같은 OpenAI 호환 서버와 OpenAI(GPT) API 는 같은 요청·응답 형식을 쓴다. 차이는 "방언"
 * (dialect) 한 묶음뿐이다 — 출력 한도 칸 이름, temperature 를 보낼지, 키가 필수인지, 오류 머리말.
 * 글 클라이언트(openai-compatible-client.ts, openai-client.ts)와 이미지 캡션(vision/openai*.ts)이
 * 이 본체 하나로 요청을 만들고 응답을 해석한다.
 *
 * 보장(모든 방언 공통):
 *   - 잘림: finish_reason "length" → stopReason "max_tokens".
 *   - 글 없이 잘린 응답(text "" + max_tokens)은 빈 글 그대로 돌려준다 — 정리 실행층이 한도를 올려 다시
 *     부르고 사용량도 센다(Anthropic 과 같은 규칙). 잘림이 아닌데 글이 없으면 던진다.
 *   - 사용량: inputTokens = 캐시에서 읽지 않은 입력(prompt_tokens − cached_tokens), cacheReadTokens =
 *     캐시 읽기, outputTokens = completion_tokens(추론 토큰 포함 — 과금 기준), cacheWriteTokens = 0.
 *     usage 칸이 아예 없으면 null(0 위장 금지).
 */

import type { LlmChatOptions, LlmChatResult } from "./types.ts";
import type { LlmProvider } from "./provider-registry.ts";
import { maskProviderText, requestProviderJson } from "./provider-http.ts";

/** 방언 — 공급자마다 다른 부분만. */
export interface OpenAiChatDialect {
  /** LlmRequestError.provider 값. */
  provider: LlmProvider;
  /** 오류 문장 머리말 ("OpenAI", "OpenAI-compatible"). */
  label: string;
  /** 출력 한도 칸 이름. OpenAI 추론 모델은 max_tokens 를 거절해 max_completion_tokens 를 쓴다. */
  tokenLimitParam: "max_tokens" | "max_completion_tokens";
  /** 이 모델에 temperature 를 보내도 되는지. */
  acceptsSampling(model: string): boolean;
  /** 키가 반드시 있어야 하는지. */
  apiKeyRequired: boolean;
}

export type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface OpenAiChatMessage {
  role: "system" | "user" | "assistant";
  content: string | OpenAiContentPart[];
}

/** 호출 대상 — 방언 + 주소 + 키 + 모델 + 시간 한도. */
export interface OpenAiChatTarget {
  dialect: OpenAiChatDialect;
  /** /chat/completions 앞까지의 주소(끝 "/" 없음). */
  baseUrl: string;
  /** 빈 문자열이면 Authorization 헤더를 싣지 않는다. */
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/** 요청 본문에 쓰는 선택 칸 — LlmChatOptions 중 본문에 들어가는 것만. */
export type OpenAiChatBodyOptions = Pick<
  LlmChatOptions,
  "temperature" | "maxOutputTokens" | "jsonMode" | "jsonSchema"
>;

/** JSON 스키마 강제 때 쓰는 이름(OpenAI response_format.json_schema.name). */
export const OPENAI_JSON_SCHEMA_NAME = "bara_response";

interface OpenAiChatResponse {
  choices?: Array<{
    message?: { content?: unknown };
    /** "stop" = 정상 종료, "length" = 출력 한도로 잘림. 안 주면 undefined. */
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string };
}

/** /chat/completions 요청 본문(순수 함수 — 네트워크 없음). */
export function buildOpenAiChatBody(
  dialect: OpenAiChatDialect,
  model: string,
  messages: readonly OpenAiChatMessage[],
  options: OpenAiChatBodyOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: false,
  };
  if (options.temperature !== undefined && dialect.acceptsSampling(model)) {
    body.temperature = options.temperature;
  }
  if (options.maxOutputTokens !== undefined) {
    body[dialect.tokenLimitParam] = options.maxOutputTokens;
  }
  if (options.jsonSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: OPENAI_JSON_SCHEMA_NAME, schema: options.jsonSchema, strict: false },
    };
  } else if (options.jsonMode) {
    body.response_format = { type: "json_object" };
  }
  return body;
}

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const text = (part as Record<string, unknown>).text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  return "";
}

/** finish_reason 원문 → 3값. */
export function normalizeOpenAiStopReason(finishReason: string | undefined): LlmChatResult["stopReason"] {
  if (finishReason === "stop") return "stop";
  if (finishReason === "length") return "max_tokens";
  return "other";
}

/** usage 원문 → 공통 뜻(캐시 읽기는 inputTokens 에서 뺀다). usage 칸이 없으면 null. */
export function normalizeOpenAiUsage(usage: OpenAiChatResponse["usage"]): LlmChatResult["usage"] {
  if (typeof usage?.prompt_tokens !== "number" || typeof usage?.completion_tokens !== "number") {
    return null;
  }
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: usage.prompt_tokens - cached,
    outputTokens: usage.completion_tokens,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

/**
 * 응답 본문 → LlmChatResult. 글 없이 잘린 응답은 빈 글 + max_tokens 로 돌려주고,
 * 잘림이 아닌데 글이 없거나 본문에 error 가 있으면 던진다.
 */
export function parseOpenAiChatResponse(
  label: string,
  raw: unknown,
  secrets?: readonly string[],
  /** allowEmptyText — 정상 종료인데 글이 없는 응답도 빈 글로 돌려준다(문서 OCR 의 빈 쪽 전용, 그 밖은 지금처럼 던짐). */
  parseOptions: { allowEmptyText?: boolean } = {},
): LlmChatResult {
  if (!raw || typeof raw !== "object") {
    throw new Error(`${label} 응답 형식 불일치: 객체가 아님`);
  }
  const json = raw as OpenAiChatResponse;
  if (json.error?.message) {
    // 2xx 본문의 error 문장도 공급자 문장이라 보낸 키를 되돌려 줄 수 있다 — 2xx 아닌 경로와 같이 가린다.
    throw new Error(`${label} error: ${maskProviderText(json.error.message, secrets)}`);
  }
  const choice = json.choices?.[0];
  const text = contentToString(choice?.message?.content);
  const stopReason = normalizeOpenAiStopReason(choice?.finish_reason);
  if (text.length === 0 && stopReason !== "max_tokens" && !(parseOptions.allowEmptyText && choice)) {
    throw new Error(
      `${label} response missing choices[0].message.content (finish_reason=${choice?.finish_reason ?? "없음"})`,
    );
  }
  return { text, stopReason, usage: normalizeOpenAiUsage(json.usage) };
}

/** 요청 헤더 — 키가 있으면 Bearer. */
export function openAiHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey.length > 0) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/** /chat/completions 한 번 호출 → LlmChatResult. 전송 실패 규칙은 provider-http.ts. */
export async function sendOpenAiChat(
  target: OpenAiChatTarget,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  parseOptions: { allowEmptyText?: boolean } = {},
): Promise<LlmChatResult> {
  const label = `${target.dialect.label} /chat/completions`;
  const json = await requestProviderJson({
    provider: target.dialect.provider,
    label,
    url: `${target.baseUrl}/chat/completions`,
    method: "POST",
    headers: openAiHeaders(target.apiKey),
    body,
    timeoutMs: target.timeoutMs,
    signal,
    secrets: [target.apiKey],
    errorCode: openAiErrorCode,
  });
  return parseOpenAiChatResponse(target.dialect.label, json, [target.apiKey], parseOptions);
}

/** OpenAI 오류 본문 {"error":{"code"|"type"}} 에서 코드를 꺼낸다. 형식이 다르면 null. */
export function openAiErrorCode(bodyText: string): string | null {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: unknown; type?: unknown } };
    const code = parsed.error?.code ?? parsed.error?.type;
    return typeof code === "string" && code.length > 0 ? code : null;
  } catch {
    return null;
  }
}
