/**
 * caption-result.ts — 글 응답(LlmChatResult)을 캡션 회신으로 바꾸는 공통 규칙 (2026-10-11 llm-api-providers spec D8).
 *
 * OpenAI 형식(LM Studio·OpenAI)과 Gemini 캡션 공급자가 같이 쓴다.
 *   - 글이 있으면 잘렸어도 캡션으로 돌려주고 stopReason 을 함께 싣는다 — caption-flow 가 잘림 경고를 남긴다
 *     (사용자 결정 Q6: 잘린 캡션도 저장, 앞부분도 검색에 쓸모).
 *   - 글이 비고 출력 한도에서 잘렸으면 "생각(추론)에 한도를 다 썼다"는 사유와 한도 칸 경로(생성자 인자
 *     limitSettingPath — 캡션은 llm.vision.tokenCap, 문서 OCR 은 documents.ocr.maxOutputTokensPerPage)를 담아 던진다.
 *   - 글이 비고 잘림도 아니면 던진다(공급자 응답 해석 단계가 이미 던지지만 여기서도 지킨다).
 */

import type { LlmChatResult } from "../types.ts";
import type { VisionCaptionResult } from "./index.ts";

/**
 * 글 없이 출력 한도에서 잘렸을 때의 오류 — 한도 칸 경로(limitSettingPath)를 문장에 넣는다.
 * 캡션 = "llm.vision.tokenCap", 문서 OCR = "documents.ocr.maxOutputTokensPerPage". 여섯 공급자가 같이 쓴다.
 */
export function emptyTruncatedOutputError(who: string, limitSettingPath: string): Error {
  return new Error(
    `${who}: 글 없이 출력 한도에서 잘림 — 모델이 생각(추론)에 한도를 다 썼다. ${limitSettingPath} 을 올려라.`,
  );
}

/** 생성자 필수 인자 검사 — 한도 칸 경로가 비면 이름을 대며 멈춘다(기본값 없음). */
export function requireLimitSettingPath(who: string, value: string | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${who}: limitSettingPath 가 비어 있음 — 출력 한도 칸 경로를 넘겨라.`);
  }
  return value;
}

export function captionFromChatResult(
  who: string,
  result: LlmChatResult,
  limitSettingPath: string,
  /** 문서 OCR 전용 — 글이 없어도 던지지 않고 빈 caption 을 돌려준다(판정은 호출부). 캡션은 넘기지 않는다. */
  allowEmptyText = false,
): VisionCaptionResult {
  const caption = result.text.trim();
  if (caption.length === 0 && allowEmptyText) {
    return {
      caption: "",
      usage: result.usage ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } : {},
      stopReason: result.stopReason,
    };
  }
  if (caption.length === 0) {
    if (result.stopReason === "max_tokens") {
      throw emptyTruncatedOutputError(who, limitSettingPath);
    }
    throw new Error(`${who}: 회신 caption 이 빈 문자열 (stopReason=${result.stopReason}).`);
  }
  return {
    caption,
    usage: result.usage
      ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }
      : {},
    stopReason: result.stopReason,
  };
}
