/**
 * LLM 공급자 표 — 단일 출처 (2026-10-11 llm-api-providers spec D4).
 *
 * 어떤 공급자가 있는지, 각 공급자가 슬롯 설정의 어느 칸(모델·키·주소)을 쓰는지, 대시보드
 * "처리 방법" 분류(서버 AI / AI API)가 무엇인지를 한 곳에 둔다. 설정 스키마의 provider
 * 선택지·정리 게이트의 모델 빈칸 검사·LLM 클라이언트 배선·이미지 캡션 설정 변환·대시보드
 * 선택지와 저장 payload 가 모두 이 표를 읽는다 — 공급자→칸 대응을 여러 파일에 복사하지 않는다.
 *
 * 이 모듈은 아무것도 import 하지 않는다(브라우저 번들에서도 그대로 쓰인다). 사람이 읽는
 * 이름(라벨)은 여기 두지 않고 대시보드 라벨 모듈(settings-llm-labels.ts)에 둔다.
 */

/** 공급자 값 — 설정 파일 `llm.<슬롯>.provider` 에 저장되는 문자열. */
export const LLM_PROVIDERS = ["ollama", "openai_compatible", "anthropic", "openai", "google"] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/** 대시보드 "처리 방법" 분류 — 서버에 설치된 AI / AI API. */
export type LlmProcessingMode = "server" | "api";

/** 처리 방법 값 — 화면의 드롭다운 순서. */
export const LLM_PROCESSING_MODES: readonly LlmProcessingMode[] = ["server", "api"];

/** 슬롯 설정에서 모델 이름을 담는 칸. */
export type LlmModelField = "ollamaModel" | "openaiModel" | "anthropicModel" | "gptModel" | "geminiModel";

/** 슬롯 설정에서 API 키를 담는 칸(비밀 칸). */
export type LlmApiKeyField = "openaiApiKey" | "anthropicApiKey" | "gptApiKey" | "geminiApiKey";

/** 슬롯 설정에서 서버 주소를 담는 칸. 고정 주소 공급자는 없음. */
export type LlmBaseUrlField = "ollamaUrl" | "openaiBaseUrl";

export interface LlmProviderSpec {
  /** 대시보드 "처리 방법" 분류. */
  mode: LlmProcessingMode;
  /** 모델 이름 칸. */
  modelField: LlmModelField;
  /** API 키 칸. Ollama 는 키가 없다. */
  apiKeyField: LlmApiKeyField | null;
  /** 키가 반드시 있어야 하는지. LM Studio(openai_compatible) 는 로컬이라 선택. */
  apiKeyRequired: boolean;
  /** 서버 주소 칸. 공급자 주소가 고정이면 null. */
  baseUrlField: LlmBaseUrlField | null;
  /** 모델 목록을 어느 설정 액션으로 가져오는지. */
  modelListing: "ollama" | "provider-models";
}

export const LLM_PROVIDER_SPECS: Readonly<Record<LlmProvider, LlmProviderSpec>> = {
  ollama: {
    mode: "server",
    modelField: "ollamaModel",
    apiKeyField: null,
    apiKeyRequired: false,
    baseUrlField: "ollamaUrl",
    modelListing: "ollama",
  },
  openai_compatible: {
    mode: "server",
    modelField: "openaiModel",
    apiKeyField: "openaiApiKey",
    apiKeyRequired: false,
    baseUrlField: "openaiBaseUrl",
    modelListing: "provider-models",
  },
  anthropic: {
    mode: "api",
    modelField: "anthropicModel",
    apiKeyField: "anthropicApiKey",
    apiKeyRequired: true,
    baseUrlField: null,
    modelListing: "provider-models",
  },
  openai: {
    mode: "api",
    modelField: "gptModel",
    apiKeyField: "gptApiKey",
    apiKeyRequired: true,
    baseUrlField: null,
    modelListing: "provider-models",
  },
  google: {
    mode: "api",
    modelField: "geminiModel",
    apiKeyField: "geminiApiKey",
    apiKeyRequired: true,
    baseUrlField: null,
    modelListing: "provider-models",
  },
};

/** 모든 공급자가 쓰는 칸 이름 합집합 — 슬롯 값 타입이 이 칸들을 모두 가져야 한다. */
export type LlmProviderFieldName = LlmModelField | LlmApiKeyField | LlmBaseUrlField;

/** 공급자 칸을 문자열로 담는 슬롯 값의 최소 모양. */
export type LlmProviderFieldValues = Readonly<Record<LlmProviderFieldName, string>>;

/** 표에 나오는 API 키 칸 전부(중복 없이, 표 순서). */
export const LLM_API_KEY_FIELDS: readonly LlmApiKeyField[] = LLM_PROVIDERS.flatMap((p) => {
  const field = LLM_PROVIDER_SPECS[p].apiKeyField;
  return field === null ? [] : [field];
});

export function isLlmProvider(v: unknown): v is LlmProvider {
  return typeof v === "string" && (LLM_PROVIDERS as readonly string[]).includes(v);
}

/** 이 처리 방법에 속한 공급자 — 표 순서 그대로. */
export function providersForMode(mode: LlmProcessingMode): LlmProvider[] {
  return LLM_PROVIDERS.filter((p) => LLM_PROVIDER_SPECS[p].mode === mode);
}
