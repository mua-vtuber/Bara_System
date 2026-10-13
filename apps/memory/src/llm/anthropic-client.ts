/**
 * AnthropicClient — `LlmClient`의 Claude API 구현.
 *
 * 본인 Claude Pro 구독과 별도로 API 키 필요 (Anthropic 콘솔에서 발급).
 * 비용·정확도 모두 Ollama보다 높음. Phase 2.1엔 추출의 fallback 또는
 * 명시적 지정용. Phase 2.4 reflector는 이쪽이 주.
 *
 * 호출 인자:
 *   apiKey  — 필수. 디폴트 fallback 없음 (caller 가 `settings.llm.anthropicApiKey` 전달).
 *   model   — 필수. 디폴트 fallback 없음 (caller 가 `settings.llm.anthropicModel` 전달).
 *
 * S10 정착 (2026-05-19) 후 env 직접 읽기는 제거. 옛 ANTHROPIC_API_KEY/ANTHROPIC_MODEL 은
 * `data/memory-settings.json` 의 llm.anthropicApiKey/anthropicModel 로 이전. apiKey 가
 * 빈 문자열이면 생성자가 throw — caller (createMemoryApi) 가 settings 검사 후 provider 자동
 * 감지 단계에서 anthropic 분기 진입 자체를 막는다.
 *
 * 프롬프트 캐싱: 추출 시스템 프롬프트는 호출마다 동일하므로
 * `cache_control: { type: "ephemeral" }`를 시스템 블록에 붙임. 5분 TTL,
 * 매 분당 1회 이상 추출 시 캐시 히트로 비용·지연 절감.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk/error";
import type {
  ChatMessage,
  LlmChatOptions,
  LlmChatResult,
  ObservableLlmClient,
} from "./types.ts";
import { LlmRequestError, parseRetryAfterMs } from "./errors.ts";
import { anthropicSamplingParams } from "./anthropic-model-capabilities.ts";

/** Anthropic stop_reason 원문 → LlmChatResult.stopReason 3값 정규화. */
function normalizeAnthropicStopReason(
  stopReason: string | null,
): LlmChatResult["stopReason"] {
  if (stopReason === "end_turn" || stopReason === "stop_sequence") return "stop";
  if (stopReason === "max_tokens") return "max_tokens";
  return "other";
}

/**
 * 호출별 옵션(options.maxOutputTokens)이 없을 때 쓸 기본 최대 출력 토큰 수.
 * 추출·답변 한 번에 충분하면서 과도 청구를 막는 선.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

/**
 * Messages API 요청 본문을 만든다(순수 함수 — 네트워크 없음).
 *
 * temperature 는 `anthropicSamplingParams` 가 모델별로 넣을지 정한다. 최신 모델
 * (Haiku 5.5·Sonnet 5·Opus 4.7 이상 등)은 표본 조절값을 받으면 400 으로 거절하므로
 * 그 모델에는 칸 자체를 넣지 않는다. 판정 표는 `anthropic-model-capabilities.ts` 하나.
 */
export function buildAnthropicChatRequest(params: {
  model: string;
  maxTokens: number;
  temperature: number | undefined;
  system: string | Anthropic.TextBlockParam[] | undefined;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: params.model,
    max_tokens: params.maxTokens,
    ...anthropicSamplingParams(params.model, { temperature: params.temperature }),
    ...(params.system !== undefined ? { system: params.system } : {}),
    messages: params.messages,
  };
}

export interface AnthropicClientOptions {
  /** API 키. caller (createMemoryApi) 가 settings.llm.anthropicApiKey 전달. */
  apiKey: string;
  /** 모델 ID. caller 가 settings.llm.anthropicModel 전달. */
  model: string;
  /** 시스템 프롬프트 캐싱 사용 여부 (기본 true). */
  enablePromptCache?: boolean;
  /** 기본 maxOutputTokens (호출별 옵션이 우선). 기본 2048. */
  defaultMaxOutputTokens?: number;
  /**
   * Anthropic API base URL 오버라이드. 미지정 시 SDK 기본값(https://api.anthropic.com).
   * 테스트에서 실제 HTTP fake server 를 주입할 때만 쓴다 — 운영 경로는 항상 미지정.
   */
  baseURL?: string;
  /**
   * SDK 내장 재시도 횟수. 미지정 시 SDK 기본값(2회). cleanup 실행층(A-4)은 오류 분류·
   * backoff 를 자체 관리하므로 그 경로는 0 을 주어 이중 재시도를 막고, LlmRequestError 를
   * 즉시 받아 분류한다.
   */
  maxRetries?: number;
  /**
   * 요청 한도(ms). 미지정 시 SDK 기본값. 데이터 정리 AI 효율 가동 spec 4.A-8 —
   * `settings.llm.cleanup.requestTimeoutMs` 를 caller(buildLlmClient)가 그대로
   * 전달한다. Ollama·OpenAI-compatible 의 timeoutMs 전달 통로와 대칭.
   */
  timeoutMs?: number;
}

export class AnthropicClient implements ObservableLlmClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly enablePromptCache: boolean;
  private readonly defaultMaxOutputTokens: number;

  constructor(opts: AnthropicClientOptions) {
    if (!opts.apiKey || opts.apiKey.length === 0) {
      throw new Error(
        "AnthropicClient: apiKey 가 비어 있음. " +
          "settings.llm.anthropicApiKey 를 채우거나 ollama 경로로 전환하라.",
      );
    }
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    });
    this.model = opts.model;
    this.enablePromptCache = opts.enablePromptCache ?? true;
    this.defaultMaxOutputTokens =
      opts.defaultMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  }

  get name(): string {
    return `anthropic:${this.model}`;
  }

  /** 기존 `chat()` 소비처 0줄 변경 — `chatDetailed()` 위임 wrapper. */
  async chat(
    messages: readonly ChatMessage[],
    options: LlmChatOptions = {},
  ): Promise<string> {
    const result = await this.chatDetailed(messages, options);
    // chatDetailed 는 생각(thinking)이 출력 한도를 다 써 글이 없는 잘림을 빈 글 + max_tokens 로 돌려준다
    // (실행층이 한도를 올려 다시 부르게). 글만 받는 chat() 소비처에는 빈 답을 넘기지 않고 예전처럼 던진다.
    if (result.text === "") {
      throw new Error(`AnthropicClient: 응답에 텍스트 블록이 없다 (stop_reason=${result.stopReason})`);
    }
    return result.text;
  }

  async chatDetailed(
    messages: readonly ChatMessage[],
    options: LlmChatOptions = {},
  ): Promise<LlmChatResult> {
    // Anthropic Messages API는 system을 별도 인자로 받음.
    // 우리 ChatMessage 시퀀스의 첫 system 메시지(또는 연속된 system들)를
    // 분리해서 system 인자로 보내고 나머지를 messages로.
    const systemChunks: string[] = [];
    const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const m of messages) {
      if (m.role === "system") {
        systemChunks.push(m.content);
      } else {
        turns.push({ role: m.role, content: m.content });
      }
    }

    if (turns.length === 0) {
      throw new Error("AnthropicClient.chat: user/assistant 메시지가 비어 있다");
    }

    const systemParam = this.buildSystem(systemChunks);

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(
        buildAnthropicChatRequest({
          model: this.model,
          maxTokens: options.maxOutputTokens ?? this.defaultMaxOutputTokens,
          temperature: options.temperature,
          system: systemParam,
          messages: turns,
        }),
        options.signal ? { signal: options.signal } : undefined,
      );
    } catch (error) {
      throw this.wrapSdkError(error);
    }

    // Claude는 content가 블록 배열. 텍스트 블록들을 합쳐서 반환.
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    // usage 는 Anthropic Messages API 가 항상 회신하는 필수 필드라 null 분기 없음
    // (다른 두 provider 와 달리 usage 부재 케이스가 존재하지 않는다).
    const usage: LlmChatResult["usage"] = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    const stopReason = normalizeAnthropicStopReason(response.stop_reason);

    // 생각(thinking)을 기본으로 하는 모델(Haiku 5.5 등)은 출력 한도를 생각에 다 쓰고 글 없이
    // max_tokens 로 끝날 수 있다. 이것은 "응답 처리 실패"가 아니라 잘림이므로 빈 글 + max_tokens 로
    // 그대로 돌려준다 — 정리 실행층이 출력 한도를 올려 다시 부르고 usage 도 센다. 잘림이 아닌데
    // 글이 없는 응답은 예전처럼 던진다.
    if (!text && stopReason !== "max_tokens") {
      throw new Error(
        `AnthropicClient: 응답에 텍스트 블록이 없다 (stop_reason=${response.stop_reason})`,
      );
    }

    return { text, stopReason, usage };
  }

  /**
   * 시스템 메시지들을 Messages API의 system 인자로 변환.
   * 캐싱 활성화 시 마지막 청크에만 cache_control을 붙임 — Anthropic 권장
   * 패턴 (앞 청크들은 자동으로 prefix로 매칭됨).
   */
  private buildSystem(
    chunks: readonly string[],
  ): string | Anthropic.TextBlockParam[] | undefined {
    if (chunks.length === 0) return undefined;
    if (!this.enablePromptCache) {
      return chunks.join("\n\n");
    }
    const blocks: Anthropic.TextBlockParam[] = chunks.map((text, idx) => {
      const block: Anthropic.TextBlockParam = { type: "text", text };
      if (idx === chunks.length - 1) {
        block.cache_control = { type: "ephemeral" };
      }
      return block;
    });
    return blocks;
  }

  /**
   * Anthropic SDK 오류를 `LlmRequestError` 로 래핑한다(요청·전송 계층 실패 전용).
   *
   * - `APIUserAbortError`(외부 AbortSignal 취소) → 그대로 던진다. 취소는 요청 실패가
   *   아니라 사용자·상위 run 의 명시 중단이라 취소 의미를 보존해야 한다.
   * - `APIConnectionTimeoutError` → timedOut=true, status=null(응답 없음).
   * - 그 외 `APIError`(429/5xx/4xx 등) → status·code(error.type)·Retry-After 보존.
   * - 네트워크 단절 등 status 없는 `APIError` → status=null(일시로 분류됨).
   * - SDK 오류가 아닌 값(우리 자체 throw 등) → 그대로 던진다(재래핑 금지).
   */
  private wrapSdkError(error: unknown): unknown {
    if (error instanceof APIUserAbortError) {
      return error;
    }
    if (error instanceof APIConnectionTimeoutError) {
      return new LlmRequestError({
        provider: "anthropic",
        message: `Anthropic 요청 timeout: ${error.message}`,
        status: null,
        code: null,
        retryAfterMs: null,
        timedOut: true,
        cause: error,
      });
    }
    if (error instanceof APIError) {
      const status = typeof error.status === "number" ? error.status : null;
      const retryAfterMs =
        error.headers instanceof Headers
          ? parseRetryAfterMs(error.headers.get("retry-after"))
          : null;
      return new LlmRequestError({
        provider: "anthropic",
        message: `Anthropic API 오류 (status=${status ?? "none"}): ${error.message}`,
        status,
        code: error.type ?? null,
        retryAfterMs,
        timedOut: false,
        cause: error,
      });
    }
    return error;
  }
}
