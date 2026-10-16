/**
 * metadata-infer-output-limit.ts — 장소·시각 채우기(갈래 2) LLM 응답 한 번의 최대 출력 토큰 수 범위와 검사.
 *
 * 추출 출력 한도(extractor-output-limit.ts)와 같은 방식이다. 갈래 2 는 추출과 *같은* LLM 클라이언트
 * (llm.extractor 슬롯)를 타므로 Ollama 일 때는 같은 컨텍스트 창 관계(한도 + 입력 여유 ≤ num_ctx)를 지킨다.
 *
 * 순수 모듈: 설정 스키마·대시보드 번들이 읽어도 무겁지 않게, 가져오는 것은 환경 변수 이름 상수 하나뿐이다.
 * 범위 숫자는 이 파일 한 곳에서만 정하고, 스키마·기본값·추론 함수·오류 문장이 같은 상수를 쓴다.
 */

import { OLLAMA_NUM_CTX_ENV } from "../llm/ollama-num-ctx.ts";

/** 설정 칸 경로. */
export const METADATA_INFER_MAX_OUTPUT_TOKENS_KEY = "metadataInfer.maxOutputTokens";
/** 하한 — 제안 몇 줄은 담을 수 있는 크기. */
export const METADATA_INFER_MAX_OUTPUT_TOKENS_MIN = 256;
/** 상한 — API 공급자 모델들의 출력 한도 안에서 넉넉히 잡은 값. Ollama 는 아래 관계 검사가 더 좁게 막는다. */
export const METADATA_INFER_MAX_OUTPUT_TOKENS_MAX = 32768;
/**
 * 기본값 — 옛 고정값 512 로는 10개 메모 세션의 제안 배열이 잘려(A1 실측, done=length output=512tok)
 * 같은 세션이 매 주기 다시 보내졌다. 사용자 결정으로 1024.
 */
export const METADATA_INFER_MAX_OUTPUT_TOKENS_DEFAULT = 1024;
/**
 * Ollama 컨텍스트 창 안에서 갈래 2 입력(지시문 + 세션 메모 목록)에 남겨 둘 토큰 수.
 * 추출 입력 여유(EXTRACTOR_OLLAMA_INPUT_TOKEN_RESERVE)와 같은 크기 — 같은 클라이언트·같은 창을 쓴다.
 */
export const METADATA_INFER_OLLAMA_INPUT_TOKEN_RESERVE = 4096;

/** 정수가 아니거나 범위 밖이면 키 이름이 든 문장을, 맞으면 null 을 돌려준다. */
export function metadataInferMaxOutputTokensError(value: unknown): string | null {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= METADATA_INFER_MAX_OUTPUT_TOKENS_MIN &&
    value <= METADATA_INFER_MAX_OUTPUT_TOKENS_MAX
  ) {
    return null;
  }
  return `${METADATA_INFER_MAX_OUTPUT_TOKENS_KEY}: ${METADATA_INFER_MAX_OUTPUT_TOKENS_MIN} 이상 ${METADATA_INFER_MAX_OUTPUT_TOKENS_MAX} 이하 정수 필요 (받은 값 ${String(value)})`;
}

/** 출력 한도 + 입력 여유가 Ollama 컨텍스트 창을 넘으면 문장, 아니면 null. */
export function metadataInferOutputExceedsOllamaContextError(
  maxOutputTokens: number,
  numCtx: number,
): string | null {
  if (maxOutputTokens + METADATA_INFER_OLLAMA_INPUT_TOKEN_RESERVE <= numCtx) return null;
  return `${METADATA_INFER_MAX_OUTPUT_TOKENS_KEY}(${maxOutputTokens}) + 장소·시각 채우기 입력 여유(${METADATA_INFER_OLLAMA_INPUT_TOKEN_RESERVE}) 가 Ollama 컨텍스트 창(num_ctx ${numCtx} — 환경 변수 ${OLLAMA_NUM_CTX_ENV})보다 큼`;
}
