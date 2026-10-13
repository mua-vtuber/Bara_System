/**
 * AnthropicVisionProvider — Anthropic Messages API + content blocks 안 base64 image
 * + text. claude-sonnet-4-* / claude-opus-4-* 가족.
 *
 * 옛 `anthropic-client.ts` (글 한정) 가족 옆 자연 합류 — content blocks 구조는 똑같고
 * `type: "image"` 블록 추가만 다르다.
 *
 * 호출 양식 (Messages API content blocks):
 *   messages: [{
 *     role: "user",
 *     content: [
 *       { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } },
 *       { type: "text", text: "이 이미지를 한 줄로 묘사하라" }
 *     ]
 *   }]
 *
 * 회신 회수: response.content 안 텍스트 블록들을 합쳐 회신. usage 합류.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  VisionCaptionOptions,
  VisionCaptionResult,
  VisionProvider,
} from "./index.ts";
import { anthropicSamplingParams } from "../anthropic-model-capabilities.ts";
import { emptyTruncatedOutputError, requireLimitSettingPath } from "./caption-result.ts";

export interface AnthropicVisionProviderOptions {
  /** API 키. caller (createVisionProvider) 가 settings.llm.vision.apiKey 검사 후 전달. */
  apiKey: string;
  /** 모델 ID. caller 가 settings.llm.vision.model 전달. 예: "claude-sonnet-4-6". */
  model: string;
  /** captionImage 호출별 default max_tokens. 미지정 시 256. */
  defaultMaxTokens?: number;
  /**
   * SDK baseURL 덮어쓰기 — 단위 test 가짜 server 가리키게 할 자리.
   * 운영 흐름에선 미지정 (Anthropic SDK default `https://api.anthropic.com`).
   */
  baseURL?: string;
  /** 글 없이 잘렸을 때 오류에 넣을 한도 칸 경로(필수 — 캡션 "llm.vision.tokenCap", OCR "documents.ocr.maxOutputTokensPerPage"). */
  limitSettingPath: string;
  /**
   * 호출 한도(ms) → SDK `timeout`. 주면 SDK 가 max_tokens 로 예상 시간을 계산해 큰 한도에서 "Streaming is
   * required" 로 던지는 검사를 건너뛴다(SDK 0.96). 문서 OCR 은 늘 넘기고, 캡션 배선은 지금처럼 넘기지 않는다.
   */
  timeoutMs?: number;
  /**
   * SDK 내장 재시도 횟수. 미지정 시 SDK 기본값. 문서 OCR 은 0 — 재시도·시도 수는 OCR 원장이 직접 세므로
   * SDK 가 몰래 다시 부르지 않게 한다(정리 실행층 AnthropicClient 와 같은 규칙).
   */
  maxRetries?: number;
}

/** Anthropic 이 받는 image media_type 가족 — Phase 11a 5 mime 양식 정합. */
const SUPPORTED_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export class AnthropicVisionProvider implements VisionProvider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly defaultMaxTokens: number;
  private readonly limitSettingPath: string;

  constructor(opts: AnthropicVisionProviderOptions) {
    if (!opts.apiKey || opts.apiKey.length === 0) {
      throw new Error(
        "AnthropicVisionProvider: apiKey 가 비어 있음. " +
          "settings.llm.vision.apiKey 를 채워라.",
      );
    }
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    });
    this.limitSettingPath = requireLimitSettingPath("AnthropicVisionProvider", opts.limitSettingPath);
    this.model = opts.model;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 256;
  }

  get name(): string {
    return `anthropic:${this.model}`;
  }

  async captionImage(
    imageBuffer: Uint8Array | Buffer,
    mimeType: string,
    prompt: string,
    options: VisionCaptionOptions = {},
  ): Promise<VisionCaptionResult> {
    if (!SUPPORTED_MEDIA_TYPES.has(mimeType)) {
      throw new Error(
        `AnthropicVisionProvider: 지원 안 하는 mimeType: ${mimeType}. ` +
          `허용: ${[...SUPPORTED_MEDIA_TYPES].join(", ")}`,
      );
    }

    const base64 = Buffer.from(imageBuffer).toString("base64");

    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: options.maxTokens ?? this.defaultMaxTokens,
        // 최신 모델(Haiku 5.5 등)은 temperature 를 400 으로 거절 — 모델별 판정은 단일 출처.
        ...anthropicSamplingParams(this.model, {
          temperature: options.temperature ?? 0.3,
        }),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mimeType as
                    | "image/png"
                    | "image/jpeg"
                    | "image/gif"
                    | "image/webp",
                  data: base64,
                },
              },
              { type: "text", text: prompt },
            ],
          },
        ],
      },
      options.signal ? { signal: options.signal } : undefined,
    );

    const caption = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    const stopReason =
      response.stop_reason === "max_tokens"
        ? "max_tokens"
        : response.stop_reason === "end_turn" || response.stop_reason === "stop_sequence"
          ? "stop"
          : "other";
    if (!caption && options.allowEmptyText === true) {
      // 문서 OCR 의 빈 쪽 — 판정(잘림·비정상 종료·빈 쪽)은 호출부가 stopReason 으로 한다.
      return {
        caption: "",
        usage: { inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens },
        stopReason,
      };
    }
    if (!caption) {
      if (response.stop_reason === "max_tokens") {
        throw emptyTruncatedOutputError("AnthropicVisionProvider", this.limitSettingPath);
      }
      throw new Error(
        `AnthropicVisionProvider: 회신에 텍스트 블록이 없다 ` +
          `(stop_reason=${response.stop_reason}).`,
      );
    }

    return {
      caption,
      usage: {
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
      },
      // 출력 한도(tokenCap)에서 잘렸으면 caption-flow 가 저장하면서 경고를 남긴다.
      stopReason:
        response.stop_reason === "max_tokens"
          ? "max_tokens"
          : response.stop_reason === "end_turn" || response.stop_reason === "stop_sequence"
            ? "stop"
            : "other",
    };
  }
}
