/**
 * GeminiClient — Google Gemini 공식 REST generateContent 글 클라이언트 (2026-10-11 llm-api-providers spec D2).
 *
 * SDK 없이 fetch 로 `POST {GEMINI_API_BASE_URL}/models/{model}:generateContent` 를 부른다. 키는
 * x-goog-api-key 헤더에만 싣는다(URL 쿼리 금지). OpenAI 호환 계층(beta, 지원 안 되는 인자를 조용히
 * 무시)은 쓰지 않는다 — 잘림·사용량·오류 분류에 필요한 칸이 공식 API 에서만 문서화돼 있다.
 *
 * 요청·응답 변환은 gemini-wire.ts, 전송 실패 규칙(timeout·취소·상태 코드)은 provider-http.ts.
 * 잘못된 키에도 Gemini 는 400 을 주고 error.status 문자열(예: INVALID_ARGUMENT)을 code 에 싣는다 →
 * 정리 실행층은 설정 결함으로 분류한다.
 */

import type { ChatMessage, LlmChatOptions, LlmChatResult, ObservableLlmClient } from "./types.ts";
import { GEMINI_API_BASE_URL } from "./constants.ts";
import { normalizeBaseUrl, requestProviderJson } from "./provider-http.ts";
import {
  buildGeminiRequest,
  chatMessagesToGemini,
  geminiErrorCode,
  geminiErrorReasons,
  parseGeminiResponse,
  stripGeminiModelPrefix,
} from "./gemini-wire.ts";

export interface GeminiClientOptions {
  /** settings.llm.<슬롯>.geminiApiKey. */
  apiKey: string;
  /** settings.llm.<슬롯>.geminiModel ("models/" 없는 값). */
  model: string;
  /** 요청 한도(ms) — 슬롯의 timeoutMs / requestTimeoutMs. */
  timeoutMs: number;
  /** 테스트 대역 서버 주소. 운영 배선은 넘기지 않는다(고정 주소). */
  baseUrl?: string;
}

/** 키·모델 빈칸 검사 — 칸 이름만 대고 값은 넣지 않는다. 글·이미지 클라이언트가 같이 쓴다. */
export function assertGeminiCredentials(who: string, apiKey: string, model: string): void {
  if (apiKey.trim().length === 0) {
    throw new Error(`${who}: geminiApiKey 가 비어 있음 — Google API 키를 설정하라.`);
  }
  if (stripGeminiModelPrefix(model).length === 0) {
    throw new Error(`${who}: geminiModel 이 비어 있음 — 설정 화면에서 Gemini 모델을 고르라.`);
  }
}

/** generateContent 한 번 호출 대상. 이미지 캡션도 이 함수로 보낸다. */
export interface GeminiTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export function geminiTarget(opts: GeminiClientOptions): GeminiTarget {
  return {
    baseUrl: normalizeBaseUrl(opts.baseUrl ?? GEMINI_API_BASE_URL),
    apiKey: opts.apiKey.trim(),
    model: stripGeminiModelPrefix(opts.model),
    timeoutMs: opts.timeoutMs,
  };
}

export async function sendGeminiGenerateContent(
  target: GeminiTarget,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  parseOptions: { allowEmptyText?: boolean } = {},
): Promise<LlmChatResult> {
  const json = await requestProviderJson({
    provider: "google",
    label: "Gemini generateContent",
    url: `${target.baseUrl}/models/${encodeURIComponent(target.model)}:generateContent`,
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": target.apiKey },
    body,
    timeoutMs: target.timeoutMs,
    signal,
    secrets: [target.apiKey],
    errorCode: geminiErrorCode,
    errorReasons: geminiErrorReasons,
  });
  return parseGeminiResponse(json, [target.apiKey], parseOptions);
}

export class GeminiClient implements ObservableLlmClient {
  private readonly target: GeminiTarget;

  constructor(opts: GeminiClientOptions) {
    assertGeminiCredentials("GeminiClient", opts.apiKey, opts.model);
    this.target = geminiTarget(opts);
  }

  get name(): string {
    return `google:${this.target.model}`;
  }

  /** 글만 받는 소비처용 — 글 없이 잘린 응답이면 빈 답을 넘기지 않고 던진다. */
  async chat(messages: readonly ChatMessage[], options: LlmChatOptions = {}): Promise<string> {
    const result = await this.chatDetailed(messages, options);
    if (result.text === "") {
      throw new Error(`GeminiClient: 응답에 글이 없다 (stopReason=${result.stopReason})`);
    }
    return result.text;
  }

  async chatDetailed(
    messages: readonly ChatMessage[],
    options: LlmChatOptions = {},
  ): Promise<LlmChatResult> {
    const { systemInstruction, contents } = chatMessagesToGemini(messages);
    const body = buildGeminiRequest(systemInstruction, contents, options);
    return sendGeminiGenerateContent(this.target, body, options.signal);
  }
}
