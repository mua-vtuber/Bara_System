/**
 * memory-schema-groups-extractor-output.ts — 추출 LLM 출력 한도 칸의 스키마 조각 (2026-10-15 extractor-output-limit spec 3.1).
 *
 * memory-schema-groups-pipeline.ts 가 이미 800줄을 넘어 새 칸은 이 파일에 두고 그쪽은 끼우기만 한다
 * (재시도 칸 memory-schema-groups-backfill-retry.ts 와 같은 방식).
 * 숫자(범위·기본값·입력 여유·기본 창)는 extractor-output-limit.ts 와 llm/constants.ts 의 상수에서 와서 설명 문장과 어긋나지 않는다.
 */

import { DEFAULT_OLLAMA_NUM_CTX } from "../llm/constants.ts";
import { OLLAMA_NUM_CTX_ENV } from "../llm/ollama-num-ctx.ts";
import {
  EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT,
  EXTRACTOR_MAX_OUTPUT_TOKENS_MAX,
  EXTRACTOR_MAX_OUTPUT_TOKENS_MIN,
  EXTRACTOR_OLLAMA_INPUT_TOKEN_RESERVE,
} from "../memory/extractor-output-limit.ts";

export const EXTRACTOR_OUTPUT_LIMIT_REQUIRED = ["maxOutputTokens"] as const;

export const extractorOutputLimitProperties = {
  maxOutputTokens: {
    type: "integer",
    title: "추출 출력 한도(토큰)",
    description:
      "추출 응답 한 번의 최대 출력 토큰 수. 응답이 이 한도에 걸려 잘린 기억은 실패 기록에 '멈춤'으로 남는다. 한도를 바꾸고 서버를 다시 시작하면 멈췄던 기억을 다음 주기에 다시 시도한다. 한도를 올리면 잘리던 기억의 추출 시간이 길어지므로 '추출 호출 한도(ms)'(timeoutMs) 안에 끝나는지 함께 본다 — 대략 한도 ÷ 초당 출력 토큰 + 입력 읽는 시간. " +
      `Ollama 는 한도 + ${EXTRACTOR_OLLAMA_INPUT_TOKEN_RESERVE} 이 컨텍스트 창(기본 ${DEFAULT_OLLAMA_NUM_CTX}, 환경 변수 ${OLLAMA_NUM_CTX_ENV})을 넘을 수 없다. default ${EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT}.`,
    default: EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT,
    minimum: EXTRACTOR_MAX_OUTPUT_TOKENS_MIN,
    maximum: EXTRACTOR_MAX_OUTPUT_TOKENS_MAX,
  },
} as const;
