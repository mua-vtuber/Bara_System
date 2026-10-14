/**
 * reranker-limits.ts — 리랭커 (질의, 글) 쌍 길이 한도의 범위와 검사 (2026-10-14 speed-step1 spec 3.1·3.2).
 *
 * 순수 모듈: @huggingface/transformers 를 import 하지 않는다 — 설정 스키마·대시보드 번들이 읽어도 무겁지 않게.
 * 범위 숫자는 이 파일 한 곳에서만 정하고, 스키마의 minimum/maximum 과 검사 함수가 같은 상수를 쓴다.
 */

/** 설정 칸 경로. */
export const RERANKER_MAX_PAIR_TOKENS_KEY = "reranker.maxPairTokens";
/** 하한 — 질의와 글 앞부분이 함께 들어갈 최소 크기. */
export const RERANKER_MAX_PAIR_TOKENS_MIN = 64;
/** 상한 — 기본 모델의 model_max_length. */
export const RERANKER_MAX_PAIR_TOKENS_MAX = 8192;

/** 정수가 아니거나 범위 밖이면 키 이름이 든 문장을, 맞으면 null 을 돌려준다. */
export function rerankerMaxPairTokensError(value: unknown): string | null {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= RERANKER_MAX_PAIR_TOKENS_MIN &&
    value <= RERANKER_MAX_PAIR_TOKENS_MAX
  ) {
    return null;
  }
  return `${RERANKER_MAX_PAIR_TOKENS_KEY}: ${RERANKER_MAX_PAIR_TOKENS_MIN} 이상 ${RERANKER_MAX_PAIR_TOKENS_MAX} 이하 정수 필요 (받은 값 ${String(value)})`;
}

/**
 * 설정값이 모델 한도보다 크면 사유 문장, 아니면 null.
 * modelMaxLength 가 Infinity 면(토크나이저 설정에 칸이 없을 때 라이브러리가 주는 값) 비교하지 않는다.
 */
export function pairTokensExceedModelReason(maxPairTokens: number, modelMaxLength: number): string | null {
  if (modelMaxLength === Infinity) return null;
  if (maxPairTokens > modelMaxLength) {
    return `${RERANKER_MAX_PAIR_TOKENS_KEY}(${maxPairTokens}) 가 모델 한도(${modelMaxLength})보다 큼`;
  }
  return null;
}
