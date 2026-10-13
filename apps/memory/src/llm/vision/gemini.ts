/**
 * GeminiVisionProvider — Google(Gemini) 이미지 캡션 (2026-10-11 llm-api-providers spec D8).
 *
 * 공식 generateContent 에 이미지를 inlineData{mimeType, data(base64)} 조각으로 싣는다. 요청·응답 변환은
 * gemini-wire.ts, 전송 실패 규칙은 provider-http.ts, 글 없이 잘린 캡션 처리는 caption-result.ts.
 */

import type { VisionCaptionOptions, VisionCaptionResult, VisionProvider } from "./index.ts";
import {
  assertGeminiCredentials,
  geminiTarget,
  sendGeminiGenerateContent,
  type GeminiTarget,
} from "../gemini-client.ts";
import { buildGeminiRequest } from "../gemini-wire.ts";
import { captionFromChatResult, requireLimitSettingPath } from "./caption-result.ts";

export interface GeminiVisionProviderOptions {
  /** settings.llm.vision.geminiApiKey. */
  apiKey: string;
  /** settings.llm.vision.geminiModel. */
  model: string;
  /** 캡션 호출별 기본 출력 한도 — settings.llm.vision.tokenCap. */
  defaultMaxTokens: number;
  /** 캡션 한 번의 호출 한도(ms) — settings.llm.vision.timeoutMs. */
  timeoutMs: number;
  /** 테스트 대역 서버 주소. 운영 배선은 넘기지 않는다(고정 주소). */
  baseUrl?: string;
  /** 글 없이 잘렸을 때 오류에 넣을 한도 칸 경로(필수). */
  limitSettingPath: string;
}

export class GeminiVisionProvider implements VisionProvider {
  private readonly target: GeminiTarget;
  private readonly defaultMaxTokens: number;
  private readonly limitSettingPath: string;

  constructor(opts: GeminiVisionProviderOptions) {
    assertGeminiCredentials("GeminiVisionProvider", opts.apiKey, opts.model);
    this.target = geminiTarget(opts);
    this.defaultMaxTokens = opts.defaultMaxTokens;
    this.limitSettingPath = requireLimitSettingPath("GeminiVisionProvider", opts.limitSettingPath);
  }

  get name(): string {
    return `google:${this.target.model}`;
  }

  async captionImage(
    imageBuffer: Uint8Array | Buffer,
    mimeType: string,
    prompt: string,
    options: VisionCaptionOptions = {},
  ): Promise<VisionCaptionResult> {
    const data = Buffer.from(imageBuffer).toString("base64");
    const body = buildGeminiRequest(
      undefined,
      [{ role: "user", parts: [{ inlineData: { mimeType, data } }, { text: prompt }] }],
      {
        temperature: options.temperature ?? 0.3,
        maxOutputTokens: options.maxTokens ?? this.defaultMaxTokens,
      },
    );
    const allowEmpty = options.allowEmptyText === true;
    const result = await sendGeminiGenerateContent(this.target, body, options.signal, { allowEmptyText: allowEmpty });
    return captionFromChatResult("GeminiVisionProvider", result, this.limitSettingPath, allowEmpty);
  }
}
