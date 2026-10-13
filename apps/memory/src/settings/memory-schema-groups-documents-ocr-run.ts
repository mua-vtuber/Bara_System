/**
 * Memory Core Settings Schema — 문서 OCR 서버 자동 처리 칸 (2026-10-11 document-ocr-api-providers spec D3).
 *
 * 쪽 출력 한도·쪽 그림 크기·사이클/하루 쪽 한도·실패 규칙·Ollama 입력 여유와, "AI API 사용" 업체별
 * 키·모델·주소 칸을 정의한다. memory-schema-groups-documents.ts 가 이 칸들을 펼쳐 넣는다(그 파일이
 * 너무 길어지지 않게 나눔). 모델·주소 기본은 빈 칸 — 모델 이름은 코드에 박아 두지 않는다.
 */

import type { FieldSchema, SubGroupSchema } from "./memory-schema-types.ts";

/** documents.ocr 최상위에 더하는 칸. */
export const documentOcrRunTopFields = {
  maxOutputTokensPerPage: {
    type: "integer",
    title: "한 쪽 최대 출력 길이(토큰)",
    description:
      "서버 자동 처리(로컬·API)에서 한 쪽(파일 업로드 API 는 문서 1건)을 읽을 때 AI 출력 한도. 이 길이에서 잘리면 저장하지 않고 실패로 남긴다. 생각하는 모델은 생각에도 이 길이를 쓴다. default 8192.",
    default: 8192,
    minimum: 256,
    maximum: 131072,
  },
  pageImage: {
    type: "object",
    title: "쪽 그림",
    description: "PDF 쪽을 그림으로 바꿔 AI 에 보낼 때의 크기.",
    properties: {
      maxEdgePx: {
        type: "integer",
        title: "쪽 그림 긴 변(px)",
        description:
          "쪽 그림의 긴 변 픽셀. 크면 작은 글씨를 잘 읽지만 AI 입력이 늘어난다. default 1600.",
        default: 1600,
        minimum: 512,
        maximum: 4096,
      },
    },
    required: ["maxEdgePx"] as const,
  },
  reliability: {
    type: "object",
    title: "실패 규칙",
    description:
      "서버 자동 처리의 쪽 단위 실패 규칙. 데이터 정리 깊은 패스와 같은 뜻 — 결정적 실패는 시도 상한에서 멈추고, 일시 실패는 기다린 뒤 다시 시도한다.",
    properties: {
      maxAttemptsPerPage: {
        type: "integer",
        title: "쪽 최대 시도 횟수",
        description:
          "같은 입력으로 결정적 실패(잘림·비정상 종료·빈 글 등)가 이만큼 쌓이면 그 쪽의 자동 재시도를 멈춘다. default 3.",
        default: 3,
        minimum: 1,
        maximum: 20,
      },
      retryDelayMinutes: {
        type: "integer",
        title: "재시도 대기(분)",
        description:
          "실패한 쪽을 다시 시도하기 전 기다리는 시간. 공급자가 Retry-After 를 더 길게 주면 그 값을 따른다. default 30.",
        default: 30,
        minimum: 1,
        maximum: 10080,
      },
      circuitBreakerThreshold: {
        type: "integer",
        title: "연속 일시 실패 중단 기준",
        description:
          "한 사이클에서 일시 실패(시간 초과·429·5xx 등)가 연달아 이만큼이면 그 사이클을 멈춘다. default 3.",
        default: 3,
        minimum: 1,
        maximum: 50,
      },
    },
    required: ["maxAttemptsPerPage", "retryDelayMinutes", "circuitBreakerThreshold"] as const,
  },
} as const satisfies Record<string, FieldSchema | SubGroupSchema>;

/** documents.ocr.schedule 에 더하는 칸. */
export const documentOcrRunScheduleFields = {
  maxPagesPerCycle: {
    type: "integer",
    title: "한 번에 읽을 최대 쪽 수",
    description:
      "서버 자동 처리 한 사이클에서 AI 를 부르는 최대 쪽 수. 다 못 읽은 문서는 다음 사이클이 이어서 읽는다. default 10.",
    default: 10,
    minimum: 1,
    maximum: 1000,
  },
  maxPagesPerDay: {
    type: "integer",
    title: "하루 최대 쪽 수",
    description:
      "하루(설정 시간대 날짜) 동안 AI 를 부르는 최대 쪽 수. 실패한 호출도 센다. 닿으면 다음 날 이어서 처리한다. default 100.",
    default: 100,
    minimum: 1,
    maximum: 100000,
  },
} as const satisfies Record<string, FieldSchema>;

/** documents.ocr.local 에 더하는 칸. */
export const documentOcrRunLocalFields = {
  ollamaInputTokenReserve: {
    type: "integer",
    title: "Ollama 입력 여유 토큰",
    description:
      "Ollama 에 주는 문맥 길이 = 한 쪽 최대 출력 길이 + 이 값. 너무 작으면 쪽 그림 일부가 잘려 들어갈 수 있다. default 8192.",
    default: 8192,
    minimum: 256,
    maximum: 131072,
  },
} as const satisfies Record<string, FieldSchema>;

/**
 * documents.ocr.api 의 업체별 칸 — 칸 이름은 LLM 공급자 표(LLM_PROVIDER_SPECS)의 modelField/apiKeyField/
 * baseUrlField 그대로. 키 칸은 비밀 파일에 따로 저장된다(PASSWORD_FIELD_PATHS).
 */
export const documentOcrApiProviderFields = {
  anthropicApiKey: {
    type: "string",
    title: "Anthropic API 키 (OCR)",
    description:
      "문서 OCR 전용 Anthropic(Claude) API 키. 이미지 캡션 키와 따로 둔다. 비밀 파일에 저장된다.",
    default: "",
    "x-ui": { widget: "password" },
  },
  anthropicModel: {
    type: "string",
    title: "Anthropic 모델 (OCR)",
    description: "문서 OCR 에 쓸 Anthropic 모델. 기본은 빈 칸 — 목록에서 고르거나 직접 적는다.",
    default: "",
  },
  gptApiKey: {
    type: "string",
    title: "OpenAI API 키 (OCR)",
    description: "문서 OCR 전용 OpenAI(GPT) API 키. 비밀 파일에 저장된다.",
    default: "",
    "x-ui": { widget: "password" },
  },
  gptModel: {
    type: "string",
    title: "OpenAI 모델 (OCR)",
    description: "문서 OCR 에 쓸 OpenAI 모델. 기본은 빈 칸 — 목록에서 고르거나 직접 적는다.",
    default: "",
  },
  geminiApiKey: {
    type: "string",
    title: "Google API 키 (OCR)",
    description: "문서 OCR 전용 Google(Gemini) API 키. 비밀 파일에 저장된다.",
    default: "",
    "x-ui": { widget: "password" },
  },
  geminiModel: {
    type: "string",
    title: "Gemini 모델 (OCR)",
    description:
      "문서 OCR 에 쓸 Gemini 모델(\"models/\" 앞머리 없이). 기본은 빈 칸 — 목록에서 고르거나 직접 적는다.",
    default: "",
  },
  openaiBaseUrl: {
    type: "string",
    title: "OpenAI 호환 주소 (OCR)",
    description:
      "OpenAI 형식(/chat/completions)을 받는 서버의 기본 주소. /chat/completions 앞까지만 적는다. 기본은 빈 칸.",
    default: "",
  },
  openaiModel: {
    type: "string",
    title: "OpenAI 호환 모델 (OCR)",
    description: "OpenAI 호환 서버에서 쓸 모델 이름. 기본은 빈 칸.",
    default: "",
  },
  openaiApiKey: {
    type: "string",
    title: "OpenAI 호환 API 키 (OCR)",
    description: "OpenAI 호환 서버 인증 키. 인증이 필요 없는 서버는 비워 둔다. 비밀 파일에 저장된다.",
    default: "",
    "x-ui": { widget: "password" },
  },
} as const satisfies Record<string, FieldSchema>;
