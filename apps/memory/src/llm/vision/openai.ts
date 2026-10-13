/**
 * OpenAiVisionProvider — OpenAI(GPT) 이미지 캡션 (2026-10-11 llm-api-providers spec D8).
 *
 * OpenAI 방언(max_completion_tokens, 확인된 모델에만 temperature, 키 필수, 고정 주소)으로
 * /chat/completions 에 data URL 이미지를 보낸다. 이미지를 받는지는 미리 판정하지 않는다(OpenAI 목록이
 * 알려 주지 않음) — 못 받는 모델이면 공급자가 4xx 로 거절해 이름 있는 오류로 드러난다.
 */

import type { VisionCaptionOptions, VisionCaptionResult, VisionProvider } from "./index.ts";
import { OPENAI_API_BASE_URL } from "../constants.ts";
import { OPENAI_DIALECT, assertOpenAiCredentials } from "../openai-client.ts";
import { normalizeBaseUrl } from "../provider-http.ts";
import type { OpenAiChatTarget } from "../openai-chat-core.ts";
import { sendOpenAiVisionCaption } from "./openai-vision-request.ts";
import { requireLimitSettingPath } from "./caption-result.ts";

export interface OpenAiVisionProviderOptions {
  /** settings.llm.vision.gptApiKey. */
  apiKey: string;
  /** settings.llm.vision.gptModel. */
  model: string;
  /** 캡션 호출별 기본 출력 한도 — settings.llm.vision.tokenCap. */
  defaultMaxTokens: number;
  /** 캡션 한 번의 호출 한도(ms) — settings.llm.vision.timeoutMs. */
  timeoutMs: number;
  /** 테스트 대역 서버 주소. 운영 배선은 넘기지 않는다(고정 주소). */
  baseUrl?: string;
  /** 글 없이 잘렸을 때 오류에 넣을 한도 칸 경로(필수 — 캡션 "llm.vision.tokenCap", OCR "documents.ocr.maxOutputTokensPerPage"). */
  limitSettingPath: string;
}

export class OpenAiVisionProvider implements VisionProvider {
  private readonly target: OpenAiChatTarget;
  private readonly defaultMaxTokens: number;
  private readonly limitSettingPath: string;

  constructor(opts: OpenAiVisionProviderOptions) {
    assertOpenAiCredentials("OpenAiVisionProvider", opts.apiKey, opts.model);
    this.target = {
      dialect: OPENAI_DIALECT,
      baseUrl: normalizeBaseUrl(opts.baseUrl ?? OPENAI_API_BASE_URL),
      apiKey: opts.apiKey.trim(),
      model: opts.model.trim(),
      timeoutMs: opts.timeoutMs,
    };
    this.limitSettingPath = requireLimitSettingPath("OpenAiVisionProvider", opts.limitSettingPath);
    this.defaultMaxTokens = opts.defaultMaxTokens;
  }

  get name(): string {
    return `openai:${this.target.model}`;
  }

  async captionImage(
    imageBuffer: Uint8Array | Buffer,
    mimeType: string,
    prompt: string,
    options: VisionCaptionOptions = {},
  ): Promise<VisionCaptionResult> {
    return sendOpenAiVisionCaption("OpenAiVisionProvider", this.target, {
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
