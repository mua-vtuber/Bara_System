/**
 * dashboard/settings-llm-labels.ts — 설정 화면 LLM 세 슬롯의 화면 문구 (2026-10-11 llm-api-providers spec 11장).
 * i18n-ready 로 한 곳에 모은다(settings-restart-labels.ts 관례). 공급자 값·칸 대응은 공급자 표
 * (src/llm/provider-registry.ts)에 있고, 여기에는 사람이 읽는 이름만 둔다.
 */

import type { LlmProcessingMode, LlmProvider } from "../../src/llm/provider-registry";

/** 처리 방법 드롭다운 문구. */
export const LLM_METHOD_LABELS: Readonly<Record<LlmProcessingMode, string>> = {
  server: "서버에 설치된 AI로 처리",
  api: "AI API 사용",
};

/** 선택 AI 드롭다운 문구. */
export const LLM_PROVIDER_LABELS: Readonly<Record<LlmProvider, string>> = {
  ollama: "Ollama",
  openai_compatible: "LM Studio / OpenAI 호환",
  openai: "OpenAI (GPT)",
  google: "Google (Gemini)",
  anthropic: "Anthropic (Claude)",
};

/** 키 칸 이름에 쓰는 짧은 공급자 이름. */
export const LLM_PROVIDER_KEY_NAMES: Readonly<Record<"anthropic" | "openai" | "google", string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

export const LLM_LABELS = {
  methodLabel: "처리 방법",
  providerLabel: "선택 AI",
  providerLabelInline: "AI 종류",
  enabledLabel: "켜기",

  keyLabel: (name: string) => `${name} API 키`,
  keySaved: "저장된 키가 있습니다. 바꿀 때만 새로 입력하세요.",
  keyMissing: "키를 입력하세요.",
  modelLabel: "모델",
  loadModels: "목록 불러오기",
  loadingModels: "목록을 불러오는 중…",
  needKeyFirst: "키를 입력한 뒤 [목록 불러오기]를 누르세요.",
  notInList: (v: string) => `${v} (목록에 없음)`,
  savedButFailed: (v: string) => `${v} (저장된 값 — 목록을 못 불러옴)`,
  deprecated: (v: string) => `${v} (지원 종료 예정)`,
  manualEntry: "직접 입력…",
  manualEntryPlaceholder: "모델 이름을 그대로 적으세요",
  emptyList: "이 키로 쓸 수 있는 모델이 없습니다.",
  openaiChatOnly: "OpenAI는 대화용 모델만 보여 줍니다. 목록에 없는 모델은 [직접 입력…]으로 적을 수 있습니다.",
  visionFiltered: (n: number) => `이미지를 못 받는 모델 ${n}개를 뺐습니다.`,
  noModelSelected: "(모델 미선택)",
  modelListFailed: (status: number) => `모델 목록을 불러오지 못했습니다 (HTTP ${status}).`,
  modelListBadResponse: "모델 목록 응답 형식이 맞지 않습니다.",

  // Ollama 폼 (이동만, 뜻 변경 없음)
  ollamaUrlLabel: "Ollama 주소",
  ollamaUrlHint: "기본값을 자동으로 사용한다. 다른 PC나 GPU 서버의 Ollama를 쓸 때만 바꾼다.",
  ollamaAdvancedSummary: "외부 Ollama 연결",
  ollamaAdvancedHint: "다른 PC나 GPU 서버의 Ollama를 쓸 때만 사용.",
  ollamaModelLabel: "Ollama 모델",
  ollamaModelHint:
    "페이지 진입 시 Ollama 에서 자동으로 설치 모델 목록 가져옴. Ollama 미가동 시 옛 모델 값 유지 + 안내 toast.",
  ollamaModelTextHint: "예: qwen3:4b-instruct (Apache 2.0·상업 안전·non-thinking).",
  ollamaListFailed: (status: number, text: string) =>
    `Ollama 모델 목록 가져오기 실패 — HTTP ${status}${text ? `: ${text}` : ""}`,
  ollamaListNotArray: (type: string) => `Ollama 모델 목록 응답이 배열 형태가 아님 (type=${type})`,
  ollamaDown: (msg: string) => `Ollama 미가동 — 옛 모델 값 유지 (${msg})`,

  // LM Studio / OpenAI 호환 폼 (이동만, 뜻 변경 없음)
  compatUrlLabel: "호환 API 주소",
  compatUrlHint: "LM Studio 서버의 OpenAI-compatible base URL. 로컬 기본값은 http://127.0.0.1:1234/v1.",
  compatKeyLabel: "호환 API 키",
  compatKeyEmptyHint: "로컬 LM Studio 는 보통 비워 둠",
  compatKeyInlineHint: "인증이 없는 로컬 서버는 비워 둔다.",
} as const;
