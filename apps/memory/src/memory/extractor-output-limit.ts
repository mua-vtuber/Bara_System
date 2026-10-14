/**
 * extractor-output-limit.ts — 추출 LLM 응답 한 번의 최대 출력 토큰 수 범위와 검사
 * (2026-10-15 extractor-output-limit spec 3.1·3.3).
 *
 * 순수 모듈: 설정 스키마·대시보드 번들이 읽어도 무겁지 않게, 가져오는 것은 환경 변수 이름 상수 하나뿐이다.
 * 범위 숫자는 이 파일 한 곳에서만 정하고, 스키마·기본값·추출기·오류 문장이 같은 상수를 쓴다.
 */

import { OLLAMA_NUM_CTX_ENV } from "../llm/ollama-num-ctx.ts";

/** 설정 칸 경로. */
export const EXTRACTOR_MAX_OUTPUT_TOKENS_KEY = "llm.extractor.maxOutputTokens";
/** 하한 — 몇 개 항목은 담을 수 있는 크기. */
export const EXTRACTOR_MAX_OUTPUT_TOKENS_MIN = 256;
/** 상한 — API 공급자 모델들의 출력 한도 안에서 넉넉히 잡은 값. Ollama 는 아래 관계 검사가 더 좁게 막는다. */
export const EXTRACTOR_MAX_OUTPUT_TOKENS_MAX = 32768;
/** 기본값 — 지금 운영 값과 같다. */
export const EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT = 1024;
/** Ollama 컨텍스트 창 안에서 추출 입력(시스템 지시 + 예시 5쌍 + 본문)에 남겨 둘 토큰 수. */
export const EXTRACTOR_OLLAMA_INPUT_TOKEN_RESERVE = 4096;

/** 정수가 아니거나 범위 밖이면 키 이름이 든 문장을, 맞으면 null 을 돌려준다. */
export function extractorMaxOutputTokensError(value: unknown): string | null {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= EXTRACTOR_MAX_OUTPUT_TOKENS_MIN &&
    value <= EXTRACTOR_MAX_OUTPUT_TOKENS_MAX
  ) {
    return null;
  }
  return `${EXTRACTOR_MAX_OUTPUT_TOKENS_KEY}: ${EXTRACTOR_MAX_OUTPUT_TOKENS_MIN} 이상 ${EXTRACTOR_MAX_OUTPUT_TOKENS_MAX} 이하 정수 필요 (받은 값 ${String(value)})`;
}

/** 출력 한도 + 입력 여유가 Ollama 컨텍스트 창을 넘으면 문장, 아니면 null. */
export function extractorOutputExceedsOllamaContextError(
  maxOutputTokens: number,
  numCtx: number,
): string | null {
  if (maxOutputTokens + EXTRACTOR_OLLAMA_INPUT_TOKEN_RESERVE <= numCtx) return null;
  return `${EXTRACTOR_MAX_OUTPUT_TOKENS_KEY}(${maxOutputTokens}) + 추출 입력 여유(${EXTRACTOR_OLLAMA_INPUT_TOKEN_RESERVE}) 가 Ollama 컨텍스트 창(num_ctx ${numCtx} — 환경 변수 ${OLLAMA_NUM_CTX_ENV})보다 큼`;
}
