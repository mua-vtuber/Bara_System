/**
 * OpenAiCompatibleClient — OpenAI-compatible /v1/chat/completions 구현 (LM Studio 방언).
 *
 * LM Studio 같은 로컬 서버와 OpenAI-compatible API를 같은 LlmClient 계약으로 쓴다.
 * baseUrl 은 보통 http://127.0.0.1:1234/v1 이며, caller 가 settings.llm.* 슬롯의
 * openaiBaseUrl/openaiModel/openaiApiKey 를 전달한다.
 *
 * 요청 만들기·응답 해석·잘림·사용량·전송 실패 처리는 OpenAI 형식 공통 본체(openai-chat-core.ts)가
 * 맡고, 이 파일은 LM Studio 방언(max_tokens, temperature 그대로, 키 선택)만 정한다.
 */

import type {
  ChatMessage,
  LlmChatOptions,
  LlmChatResult,
  ObservableLlmClient,
} from "./types.ts";
import { DEFAULT_OLLAMA_TIMEOUT_MS } from "./constants.ts";
import {
  buildOpenAiChatBody,
  sendOpenAiChat,
  type OpenAiChatDialect,
  type OpenAiChatTarget,
} from "./openai-chat-core.ts";
import { normalizeBaseUrl } from "./provider-http.ts";

/** LM Studio / OpenAI 호환 서버 방언 — 출력 한도 max_tokens, temperature 는 받은 그대로, 키는 선택. */
export const OPENAI_COMPATIBLE_DIALECT: OpenAiChatDialect = {
  provider: "openai_compatible",
  label: "OpenAI-compatible",
  tokenLimitParam: "max_tokens",
  acceptsSampling: () => true,
  apiKeyRequired: false,
};

export interface OpenAiCompatibleClientOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

export class OpenAiCompatibleClient implements ObservableLlmClient {
  private readonly target: OpenAiChatTarget;

  constructor(opts: OpenAiCompatibleClientOptions) {
    if (!opts.baseUrl || opts.baseUrl.trim().length === 0) {
      throw new Error("OpenAiCompatibleClient: baseUrl 이 비어 있음.");
    }
    if (!opts.model || opts.model.trim().length === 0) {
      throw new Error("OpenAiCompatibleClient: model 이 비어 있음.");
    }
    this.target = {
      dialect: OPENAI_COMPATIBLE_DIALECT,
      baseUrl: normalizeBaseUrl(opts.baseUrl),
      apiKey: opts.apiKey?.trim() ?? "",
      model: opts.model.trim(),
      timeoutMs: opts.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS,
    };
  }

  get name(): string {
    return `openai-compatible:${this.target.model}`;
  }

  /**
   * 글만 받는 소비처용. chatDetailed 는 글 없이 잘린 응답을 빈 글 + max_tokens 로 돌려주지만(정리
   * 실행층이 한도를 올려 다시 부르게), 여기서는 빈 답을 넘기지 않고 던진다(Anthropic 과 같은 규칙).
   */
  async chat(
    messages: readonly ChatMessage[],
    options: LlmChatOptions = {},
  ): Promise<string> {
    const result = await this.chatDetailed(messages, options);
    if (result.text === "") {
      throw new Error(
        `OpenAiCompatibleClient: 응답에 글이 없다 (stopReason=${result.stopReason})`,
      );
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
