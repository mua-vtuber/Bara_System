/**
 * openai-vision-request.ts — OpenAI 형식(/chat/completions) 이미지 캡션 요청 한 번.
 * LM Studio(openai-compatible.ts)와 OpenAI(openai.ts) 캡션 공급자가 같이 쓴다.
 *
 * 이미지는 data URL 로 image_url 조각에 싣는다. 출력 한도 칸 이름·temperature 허용은 방언이 정한다.
 */

import type { VisionCaptionResult } from "./index.ts";
import {
  buildOpenAiChatBody,
  sendOpenAiChat,
  type OpenAiChatTarget,
} from "../openai-chat-core.ts";
import { captionFromChatResult } from "./caption-result.ts";

export interface OpenAiVisionCall {
  imageBuffer: Uint8Array | Buffer;
  mimeType: string;
  prompt: string;
  temperature: number;
  maxTokens: number;
  signal: AbortSignal | undefined;
  /** 글 없이 잘렸을 때 오류 문장에 넣을 한도 칸 경로. */
  limitSettingPath: string;
  /** 문서 OCR 전용 — 빈 글 회신을 오류 대신 빈 caption 으로. */
  allowEmptyText?: boolean;
}

export async function sendOpenAiVisionCaption(
  who: string,
  target: OpenAiChatTarget,
  call: OpenAiVisionCall,
): Promise<VisionCaptionResult> {
  const base64 = Buffer.from(call.imageBuffer).toString("base64");
  const body = buildOpenAiChatBody(
    target.dialect,
    target.model,
    [
      {
        role: "user",
        content: [
          { type: "text", text: call.prompt },
          { type: "image_url", image_url: { url: `data:${call.mimeType};base64,${base64}` } },
        ],
      },
    ],
    { temperature: call.temperature, maxOutputTokens: call.maxTokens },
  );
  const result = await sendOpenAiChat(target, body, call.signal, { allowEmptyText: call.allowEmptyText === true });
  return captionFromChatResult(who, result, call.limitSettingPath, call.allowEmptyText === true);
}
