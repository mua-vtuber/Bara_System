/**
 * OpenAiCompatibleVisionProvider — OpenAI-compatible chat completions vision 통로.
 *
 * LM Studio 의 OpenAI-compatible 서버처럼 /v1/chat/completions 를 제공하는 VLM
 * 서버에 data URL 이미지와 텍스트 프롬프트를 보낸다.
 *
 * 요청 만들기·응답 해석·전송 실패(LlmRequestError — 상태 코드·timeout)는 OpenAI 형식 공통 본체
 * (openai-chat-core.ts)가 맡는다. 잘림 신호(finish_reason=length)는 stopReason 으로 돌려주고,
 * 글 없이 잘리면 tokenCap 칸 이름을 담아 던진다(caption-result.ts).
 */

import type {
  VisionCaptionOptions,
  VisionCaptionResult,
  VisionProvider,
} from "./index.ts";
import { DEFAULT_OLLAMA_TIMEOUT_MS } from "../constants.ts";
import { OPENAI_COMPATIBLE_DIALECT } from "../openai-compatible-client.ts";
import { normalizeBaseUrl } from "../provider-http.ts";
import type { OpenAiChatTarget } from "../openai-chat-core.ts";
import { sendOpenAiVisionCaption } from "./openai-vision-request.ts";
import { requireLimitSettingPath } from "./caption-result.ts";

export interface OpenAiCompatibleVisionProviderOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  defaultMaxTokens?: number;
  timeoutMs?: number;
  /** 글 없이 잘렸을 때 오류에 넣을 한도 칸 경로(필수). */
  limitSettingPath: string;
}

/** 캡션 호출별 maxTokens·defaultMaxTokens 가 모두 없을 때의 출력 한도(caption-flow 는 늘 tokenCap 을 넘긴다). */
const DEFAULT_CAPTION_MAX_TOKENS = 256;

export class OpenAiCompatibleVisionProvider implements VisionProvider {
  private readonly target: OpenAiChatTarget;
  private readonly defaultMaxTokens: number;
  private readonly limitSettingPath: string;

  constructor(opts: OpenAiCompatibleVisionProviderOptions) {
    if (!opts.baseUrl || opts.baseUrl.trim().length === 0) {
      throw new Error("OpenAiCompatibleVisionProvider: baseUrl 이 비어 있음.");
    }
    if (!opts.model || opts.model.trim().length === 0) {
      throw new Error("OpenAiCompatibleVisionProvider: model 이 비어 있음.");
    }
    this.target = {
      dialect: OPENAI_COMPATIBLE_DIALECT,
      baseUrl: normalizeBaseUrl(opts.baseUrl),
      apiKey: opts.apiKey?.trim() ?? "",
      model: opts.model.trim(),
      timeoutMs: opts.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS,
    };
    this.limitSettingPath = requireLimitSettingPath("OpenAiCompatibleVisionProvider", opts.limitSettingPath);
    this.defaultMaxTokens = opts.defaultMaxTokens ?? DEFAULT_CAPTION_MAX_TOKENS;
  }

  get name(): string {
    return `openai-compatible:${this.target.model}`;
  }

  async captionImage(
    imageBuffer: Uint8Array | Buffer,
    mimeType: string,
    prompt: string,
    options: VisionCaptionOptions = {},
  ): Promise<VisionCaptionResult> {
    return sendOpenAiVisionCaption("OpenAiCompatibleVisionProvider", this.target, {
      imageBuffer,
      mimeType,
      prompt,
      temperature: options.temperature ?? 0.3,
      maxTokens: options.maxTokens ?? this.defaultMaxTokens,
      signal: options.signal,
      limitSettingPath: this.limitSettingPath,
      allowEmptyText: options.allowEmptyText === true,
    });
  }
}
