/**
 * ollama-num-ctx.ts — Ollama 컨텍스트 창(num_ctx) 값 계산을 한 곳에 둔다 (2026-10-15 extractor-output-limit spec 5장).
 *
 * 순수 모듈: llm/constants.ts 외에는 import 하지 않는다 — 설정 검사·대시보드 번들이 읽어도 가볍게.
 * OllamaClient 생성자와 설정 저장·읽기 검사가 같은 함수를 쓰므로 "검사가 본 창"과 "요청에 보내는 창"이 어긋나지 않는다.
 */

import { DEFAULT_OLLAMA_NUM_CTX } from "./constants.ts";

/** 환경 변수 이름 — 오류·안내 문장이 같은 문자열을 쓴다. */
export const OLLAMA_NUM_CTX_ENV = "OLLAMA_NUM_CTX";

/** 글 전체가 양의 정수인지 본다(앞부분만 읽는 parseInt 방식은 쓰지 않는다). */
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

/**
 * 명시값 → 환경 변수 → DEFAULT_OLLAMA_NUM_CTX 순서로 컨텍스트 창을 정한다.
 * 환경 변수가 있는데(빈 문자열은 "없음") 양의 정수가 아니면 던진다 — 잘못된 값을 조용히 8192 로 바꾸지 않는다.
 */
export function resolveOllamaNumCtx(
  explicit: number | undefined,
  env: Readonly<Record<string, string | undefined>>,
): number {
  if (explicit !== undefined) return explicit;
  const raw = env[OLLAMA_NUM_CTX_ENV];
  if (raw === undefined || raw === "") return DEFAULT_OLLAMA_NUM_CTX;
  if (!POSITIVE_INTEGER_PATTERN.test(raw)) {
    throw new Error(`${OLLAMA_NUM_CTX_ENV} 가 양의 정수가 아님 (받은 값 "${raw}")`);
  }
  const n = Number(raw);
  // 숫자 글자만 있어도 너무 길면 Number 가 안전 정수 범위를 넘는다 — 부정확한 값을 그대로 쓰지 않는다.
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${OLLAMA_NUM_CTX_ENV} 가 양의 정수가 아님 (받은 값 "${raw}")`);
  }
  return n;
}
