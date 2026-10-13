/**
 * OpenAiClient — OpenAI(GPT) API 글 클라이언트 (2026-10-11 llm-api-providers spec D1).
 *
 * OpenAI 형식 공통 본체(openai-chat-core.ts) 위에 OpenAI 방언을 얹는다. 방언 차이:
 *   - 출력 한도는 항상 max_completion_tokens(추론 모델이 max_tokens 를 거절함, 추론 토큰 포함 상한).
 *   - temperature 는 받는 것이 확인된 모델에만(openai-model-capabilities.ts 표).
 *   - 키 필수, 주소는 고정(OPENAI_API_BASE_URL). baseUrl 인자는 테스트 대역 서버 전용.
 *
 * 키·모델이 비면 생성자가 칸 이름을 대며 던진다(키 값은 오류에 넣지 않음). 다른 공급자로 바꿔 타거나
 * 아무 모델이나 고르지 않는다.
 */

import type { ChatMessage, LlmChatOptions, LlmChatResult, ObservableLlmClient } from "./types.ts";
import { OPENAI_API_BASE_URL } from "./constants.ts";
import {
  buildOpenAiChatBody,
  sendOpenAiChat,
  type OpenAiChatDialect,
  type OpenAiChatTarget,
} from "./openai-chat-core.ts";
import { normalizeBaseUrl } from "./provider-http.ts";
import { openAiModelAcceptsSampling } from "./openai-model-capabilities.ts";

/** OpenAI(GPT) 방언. */
export const OPENAI_DIALECT: OpenAiChatDialect = {
  provider: "openai",
  label: "OpenAI",
  tokenLimitParam: "max_completion_tokens",
  acceptsSampling: openAiModelAcceptsSampling,
  apiKeyRequired: true,
};

export interface OpenAiClientOptions {
  /** settings.llm.<슬롯>.gptApiKey. */
  apiKey: string;
  /** settings.llm.<슬롯>.gptModel. */
  model: string;
  /** 요청 한도(ms) — 슬롯의 timeoutMs / requestTimeoutMs. */
  timeoutMs: number;
  /** 테스트 대역 서버 주소. 운영 배선은 넘기지 않는다(고정 주소). */
  baseUrl?: string;
}

/** 키·모델 빈칸 검사 — 칸 이름만 대고 값은 넣지 않는다. 글·이미지 클라이언트가 같이 쓴다. */
export function assertOpenAiCredentials(who: string, apiKey: string, model: string): void {
  if (apiKey.trim().length === 0) {
    throw new Error(`${who}: gptApiKey 가 비어 있음 — OpenAI API 키를 설정하라.`);
  }
  if (model.trim().length === 0) {
    throw new Error(`${who}: gptModel 이 비어 있음 — 설정 화면에서 OpenAI 모델을 고르라.`);
  }
}

export class OpenAiClient implements ObservableLlmClient {
  private readonly target: OpenAiChatTarget;

  constructor(opts: OpenAiClientOptions) {
    assertOpenAiCredentials("OpenAiClient", opts.apiKey, opts.model);
    this.target = {
      dialect: OPENAI_DIALECT,
      baseUrl: normalizeBaseUrl(opts.baseUrl ?? OPENAI_API_BASE_URL),
      apiKey: opts.apiKey.trim(),
      model: opts.model.trim(),
      timeoutMs: opts.timeoutMs,
    };
  }

  get name(): string {
    return `openai:${this.target.model}`;
  }

  /** 글만 받는 소비처용 — 글 없이 잘린 응답이면 빈 답을 넘기지 않고 던진다. */
  async chat(messages: readonly ChatMessage[], options: LlmChatOptions = {}): Promise<string> {
    const result = await this.chatDetailed(messages, options);
    if (result.text === "") {
      throw new Error(`OpenAiClient: 응답에 글이 없다 (stopReason=${result.stopReason})`);
    }
    return result.text;
  }

  async chatDetailed(
    messages: readonly ChatMessage[],
    options: LlmChatOptions = {},
  ): Promise<LlmChatResult> {
    const body = buildOpenAiChatBody(this.target.dialect, this.target.model, messages, options);
    return sendOpenAiChat(this.target, body, options.signal);
  }
}
