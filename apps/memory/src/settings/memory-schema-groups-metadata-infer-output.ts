/**
 * memory-schema-groups-metadata-infer-output.ts — 장소·시각 채우기(갈래 2) 출력 한도 칸의 스키마 조각.
 *
 * memory-schema-groups-pipeline.ts 가 이미 800줄을 넘어 새 칸은 이 파일에 두고 그쪽은 끼우기만 한다
 * (추출 출력 한도 칸 memory-schema-groups-extractor-output.ts 와 같은 방식).
 * 숫자(범위·기본값·입력 여유·기본 창)는 metadata-infer-output-limit.ts 와 llm/constants.ts 의 상수에서 와서 설명 문장과 어긋나지 않는다.
 */

import { DEFAULT_OLLAMA_NUM_CTX } from "../llm/constants.ts";
import { OLLAMA_NUM_CTX_ENV } from "../llm/ollama-num-ctx.ts";
import {
  METADATA_INFER_MAX_OUTPUT_TOKENS_DEFAULT,
  METADATA_INFER_MAX_OUTPUT_TOKENS_MAX,
  METADATA_INFER_MAX_OUTPUT_TOKENS_MIN,
  METADATA_INFER_OLLAMA_INPUT_TOKEN_RESERVE,
} from "../memory/metadata-infer-output-limit.ts";

export const METADATA_INFER_OUTPUT_LIMIT_REQUIRED = ["maxOutputTokens"] as const;

export const metadataInferOutputLimitProperties = {
  maxOutputTokens: {
    type: "integer",
    title: "장소·시각 채우기 출력 한도(토큰)",
    description:
      "장소·시각 채우기 응답 한 번의 최대 출력 토큰 수. 응답이 이 한도에 걸려 잘린 세션은 그 한도 값을 메모에 적고 같은 한도로는 다시 보내지 않는다. 한도를 바꾸고 서버를 다시 시작하면 잘렸던 세션을 다음 주기에 다시 시도한다. " +
      `Ollama 는 한도 + ${METADATA_INFER_OLLAMA_INPUT_TOKEN_RESERVE} 이 컨텍스트 창(기본 ${DEFAULT_OLLAMA_NUM_CTX}, 환경 변수 ${OLLAMA_NUM_CTX_ENV})을 넘을 수 없다. default ${METADATA_INFER_MAX_OUTPUT_TOKENS_DEFAULT}.`,
    default: METADATA_INFER_MAX_OUTPUT_TOKENS_DEFAULT,
    minimum: METADATA_INFER_MAX_OUTPUT_TOKENS_MIN,
    maximum: METADATA_INFER_MAX_OUTPUT_TOKENS_MAX,
  },
} as const;
