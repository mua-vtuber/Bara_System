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
/**
 * 기본값 — 꽉 찬 청크 한 덩어리(chunker.ts DEFAULT_TOKEN_CAP = 2000, token-counter.ts estimateTokens
 * 기준)의 추출 응답이 잘리지 않는 크기. 계산(2026-10-20):
 *   - 본문 몫: 규칙 7(원문 단어 보존)로 항목들의 content 를 합치면 거의 원문 그대로다 → 최대 2000.
 *   - 항목 수: estimateTokens 는 한글 1자를 2토큰으로 센다 → 2000토큰 = 한글 약 1000자. 가장 짧은
 *     항목을 16자로 보면 최대 약 63개(1000 / 16 = 62.5).
 *   - 항목 하나의 JSON 뼈대: 한 줄 JSON {"content":"","memoryType":"episode","importance":0.45,
 *     "place":"","eventDateText":""} 이 영문 기호 약 90자. estimateTokens 는 공백 없는 영문 덩어리를
 *     한 낱말(0.75토큰)로 세서 이 몫을 잴 수 없으므로 BPE 의 영문 약 4자 = 1토큰으로 잡아 약 24토큰.
 *   - 합계 2000 + 63 × 24 = 3512 → 연결어미를 '-다'로 바꾸며 늘어나는 몫까지 담아 4096.
 * Ollama 는 이 값 + EXTRACTOR_OLLAMA_INPUT_TOKEN_RESERVE(4096) = 8192 가 기본 컨텍스트 창
 * (DEFAULT_OLLAMA_NUM_CTX 8192)과 같아 기본 설정 그대로 관계 검사를 통과한다
 * (extractor-output-limit.test.ts 가 이 관계를 지킨다).
 */
export const EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT = 4096;
/** 상향 전 기본값 — 이 값이 저장돼 있으면 설정 로드 때 새 기본값으로 올린다(settings/migrate-extractor-output-limit.ts). */
export const EXTRACTOR_MAX_OUTPUT_TOKENS_LEGACY_DEFAULT = 1024;
/**
 * Ollama 컨텍스트 창 안에서 추출 입력(시스템 지시 + few-shot 예시 쌍 + 확정 메타 + 본문)에 남겨 둘 토큰 수.
 * 본문을 뺀 고정 몫이 estimateTokens 로 약 1440 이라(2026-10-20 측정, 예시 4쌍) 꽉 찬 청크 2000 을
 * 더해도 약 3440 으로 안에 든다(extractor-output-limit.test.ts 가 실제 조립 결과로 확인한다).
 */
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
