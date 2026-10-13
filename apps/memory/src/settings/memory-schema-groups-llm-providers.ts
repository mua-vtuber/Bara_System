/**
 * Memory Core Settings Schema — LLM 세 슬롯 공통 OpenAI(GPT)·Google(Gemini) 칸 (2026-10-11
 * llm-api-providers spec 5.1).
 *
 * 의미 추출·데이터 정리·이미지 캡션 세 슬롯이 똑같이 갖는 4칸이라 한 번만 정의하고 각 슬롯
 * properties 에 펼쳐 넣는다(memory-schema-groups-pipeline.ts 가 800줄을 넘어 더 쌓지 않는다).
 * 모델 기본값은 빈 칸 — 모델 이름은 수개월 단위로 바뀌어 코드에 박아 두면 낡는다(spec D5).
 * 빈 칸으로 가동하면 실행 시 칸 이름을 대며 멈춘다.
 */

import type { FieldSchema } from "./memory-schema-types.ts";

export const llmApiProviderFields = {
  gptApiKey: {
    type: "string",
    title: "OpenAI API 키",
    description:
      "OpenAI(GPT) API 키. 설정 파일이 아니라 비밀 파일에 따로 저장된다. 비어 있으면 OpenAI 경로는 칸 이름을 대며 멈춘다.",
    default: "",
    "x-ui": { widget: "password" },
  },
  gptModel: {
    type: "string",
    title: "OpenAI 모델",
    description:
      "OpenAI(GPT) 호출에 쓸 모델 이름. 기본은 빈 칸 — 설정 화면에서 목록을 불러와 고르거나 직접 적는다.",
    default: "",
  },
  geminiApiKey: {
    type: "string",
    title: "Google API 키",
    description:
      "Google(Gemini) API 키. 설정 파일이 아니라 비밀 파일에 따로 저장된다. 비어 있으면 Gemini 경로는 칸 이름을 대며 멈춘다.",
    default: "",
    "x-ui": { widget: "password" },
  },
  geminiModel: {
    type: "string",
    title: "Gemini 모델",
    description:
      "Google(Gemini) 호출에 쓸 모델 이름(\"models/\" 앞머리 없이). 기본은 빈 칸 — 설정 화면에서 목록을 불러와 고르거나 직접 적는다.",
    default: "",
  },
} as const satisfies Record<string, FieldSchema>;
