/**
 * Memory Core Settings — LLM 슬롯·문서 OCR 타입 (P3 G5-a 분할).
 *
 * memory-settings.ts 파사드의 슬롯 단위 타입 정의 본문 — 동작 불변. 루트
 * MemorySettings·partial 타입은 memory-settings-types.ts, 파일 read/write 는
 * memory-settings-io.ts 소관.
 */

import type { LlmProvider } from "../llm/provider-registry.ts";
import type { DocumentOcrApiProvider } from "./document-ocr-api-providers.ts";

// 공급자 값의 정의는 공급자 표(llm/provider-registry.ts, document-ocr-api-providers.ts) 한 곳 — 여기서는 다시 내보내기만 한다.
export type { LlmProvider, DocumentOcrApiProvider };

/**
 * 의미 추출 (extractor) 슬롯 — spec section 4.1. Phase 5.6 W5 본격 + Phase 5.7.1 W1
 * backfill sub-object 신규. 옛 `llm` 그룹 (provider + 4 필드) + 옛 `extractor` 그룹의
 * 의미 영향 칸 (enabled / importance / autoExtract) 흡수 + 옛 backfillIntervalMin +
 * 옛 extractor.backfill* 두 칸은 `backfill` sub-object 흡수.
 */
export interface LlmExtractorSlot {
  enabled: boolean;
  /** LLM 호출 갈래 — Ollama 로컬, OpenAI-compatible(LM Studio), Anthropic·OpenAI·Google API. */
  provider: LlmProvider;
  ollamaUrl: string;
  ollamaModel: string;
  anthropicApiKey: string;
  anthropicModel: string;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiApiKey: string;
  /** OpenAI(GPT) API 키 — 비밀 칸. 기본 "". (openai* 칸은 LM Studio/OpenAI 호환 뜻이라 따로 둔다.) */
  gptApiKey: string;
  /** OpenAI(GPT) 모델 이름 — 기본 "" (목록에서 고른다, 이름을 코드에 박아 두지 않음). */
  gptModel: string;
  /** Google(Gemini) API 키 — 비밀 칸. 기본 "". */
  geminiApiKey: string;
  /** Google(Gemini) 모델 이름 — 기본 "" ("models/" 앞머리 없는 값). */
  geminiModel: string;
  /** 'immediate' = raw 도착 즉시 추출, 'backfill' = 정해진 주기로 묶어 추출. 옛 autoExtract 의미 흡수. */
  mode: "immediate" | "backfill";
  /** 옛 extractor.importance 흡수 — 추출 atomic 노드 default importance. */
  minImportance: number;
  /**
   * ollama 형식 강제(jsonSchema/jsonMode) 토글. default false. 옛 운영 default
   * 모델 exaone3.5:2.4b 기준 측정에서 형식 강제 OFF 가 정상 추출이라 정한 값이다.
   * 현 default 모델은 qwen3:4b-instruct (2026-06-13 교체)인데 이 모델에서 OFF
   * 품질은 아직 재측정되지 않았다 (근거 미재확인). 큰 모델 구조화 출력 보장이
   * 필요하면 ON. T2 가 extract() 안에서 이 토글로 jsonMode/jsonSchema 전달 갈래를
   * 가른다.
   */
  forceJsonFormat: boolean;
  /**
   * extractor-a1-2.4b-transition T1 (IN-1) — ollama 추출 호출 한도(ms). default
   * 900000 (15분). OllamaClient timeoutMs 와 같은 ms 단위라 변환 0. T5 가
   * buildLlmClient → OllamaClient 로 이 값을 전달한다. A1 CPU 추출이 옛 고정
   * 120초를 넘겨 끊기던 흠을 푼다.
   */
  timeoutMs: number;
  /** Phase 5.7.1 W1 — 정해진 주기 추출 갈래 3 칸 그룹 (mode='backfill' 갈래에서만 가동). */
  backfill: {
    intervalMin: number;
    batchSize: number;
    minImportance: number;
    /** 같은 글로 센 실패(시간 초과 포함)가 이만큼이면 자동 재시도를 멈춘다(2026-10-14 backfill-retry-ledger spec 4.4). */
    maxAttempts: number;
    /** 첫 재시도 대기(분). 센 실패마다 늘어난다(배수는 ledger.ts 의 BACKFILL_RETRY_BACKOFF_FACTOR). */
    retryDelayMin: number;
    /** 늘어나는 대기의 상한(분). retryDelayMin 이상이어야 한다(설정 검사가 거부). */
    retryMaxDelayMin: number;
  };
}

/**
 * 데이터 정리 (cleanup) 슬롯 — spec section 4.2. Phase 5.6 W5 본격 신설.
 * default `enabled=false` — 본인 명시 활성화 + cleanup API 본격 구현 (Phase 5.7+)
 * 후 가동.
 */
export interface LlmCleanupSlot {
  enabled: boolean;
  provider: LlmProvider;
  ollamaUrl: string;
  ollamaModel: string;
  anthropicApiKey: string;
  anthropicModel: string;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiApiKey: string;
  /** OpenAI(GPT) API 키 — 비밀 칸. 기본 "". (openai* 칸은 LM Studio/OpenAI 호환 뜻이라 따로 둔다.) */
  gptApiKey: string;
  /** OpenAI(GPT) 모델 이름 — 기본 "" (목록에서 고른다, 이름을 코드에 박아 두지 않음). */
  gptModel: string;
  /** Google(Gemini) API 키 — 비밀 칸. 기본 "". */
  geminiApiKey: string;
  /** Google(Gemini) 모델 이름 — 기본 "" ("models/" 앞머리 없는 값). */
  geminiModel: string;
  /** cleanup 주기 (일). default 7. */
  intervalDays: number;
  /**
   * 데이터 정리 AI 효율 가동 spec (2026-07-11) 4.A-8 — cleanup 호출 한도(ms).
   * default 900000(15분), extractor.timeoutMs 대칭. **3 provider 전부에 균일 적용**
   * — Ollama·OpenAI-compatible 은 기존 timeoutMs 전달 통로(llm-wiring.ts
   * buildLlmClient)로, Anthropic 은 SDK 생성자 timeout 옵션으로 전달된다. (구
   * v1 안의 "ollama 갈래 한정" 서술은 llm-wiring 실측과 어긋난 오류였고 이 필드
   * 도입으로 정정한다 — spec 단락 4.A-8 참고.)
   */
  requestTimeoutMs: number;
  /** 정리 시점. default "interval". */
  trigger: CleanupTrigger;
}

/** 정리 시점(spec 7.1 / D4). interval = N일마다(intervalDays), on_save = 그에 더해 메모 저장 직후
 * 그 메모 하나를 메모 단위 단계(entityRegister·personLink)로 정리. */
export type CleanupTrigger = "interval" | "on_save";

/**
 * 이미지 캡션 (vision / VLM) 슬롯 — spec section 11b. Phase 11b T11 신설.
 * default `enabled=false` — 사용자 명시 활성화 시점부터 가동. SigLIP 이미지 임베딩
 * 위에 *추가* 신호 통로 — VLM 호출은 옵션 forceCall 갈래 또는 임베딩 미가용 자연
 * fallback 흐름 (T10 decideVlmInvocation).
 */
export interface LlmVisionSlot {
  enabled: boolean;
  provider: LlmProvider;
  ollamaUrl: string;
  ollamaModel: string;
  anthropicApiKey: string;
  anthropicModel: string;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiApiKey: string;
  /** OpenAI(GPT) API 키 — 비밀 칸. 기본 "". (openai* 칸은 LM Studio/OpenAI 호환 뜻이라 따로 둔다.) */
  gptApiKey: string;
  /** OpenAI(GPT) 모델 이름 — 기본 "" (목록에서 고른다, 이름을 코드에 박아 두지 않음). */
  gptModel: string;
  /** Google(Gemini) API 키 — 비밀 칸. 기본 "". */
  geminiApiKey: string;
  /** Google(Gemini) 모델 이름 — 기본 "" ("models/" 앞머리 없는 값). */
  geminiModel: string;
  /** ON = SigLIP 임베딩 가용 시에도 VLM 강제 호출. OFF (default) = 임베딩 가용 시 skip. */
  forceCall: boolean;
  /** 한 캡션 호출 max_tokens 한도. default 2000. */
  tokenCap: number;
  /**
   * ollama 캡션 한 번의 호출 한도(ms). default 360000ms = 6분. GPU 없는 A1 CPU에서
   * qwen2.5vl:3b 캡션 1장이 100~209초까지 가, 옛 OllamaVisionProvider 고정 120초로는
   * 매번 끊겼다. 같은 ms 단위라 OllamaVisionProvider.timeoutMs 로 변환 없이 전달.
   * anthropic 경로는 SDK 자체 타임아웃을 쓰므로 이 칸은 ollama 캡션 한정.
   */
  timeoutMs: number;
  /**
   * Phase 11e G2-4 — 캡션 프롬프트 글. 빈 문자열(default) 이면 caption-flow 가
   * 개정된 한국어 검색용 default 프롬프트를 쓴다. 사용자가 보관소 성격(만화·일러스트)에
   * 맞춰 직접 글을 적으면 그 글이 우선. 하드코딩 회피 — 호출부 리터럴 0.
   */
  captionPrompt: string;
  /**
   * 한 사이클 일괄 처리 설정. 동작 방식(mode)·주기(intervalMin)는 의미추출 AI 수준
   * 공통이라 권위 = llm.extractor 슬롯 — vision 은 extractor.mode·
   * extractor.backfill.intervalMin 을 따라간다(extractor-vision-unified-clock-scheduler
   * 결정 5). 그래서 vision 에는 mode·intervalMin 칸이 없고 batchSize 한 칸만 남는다.
   * minImportance 도 제외 — 이미지는 importance 부적합, 후보 기준은 has_caption_auto=0
   * + created_at ASC (T7 스케줄러 책임).
   */
  backfill: {
    batchSize: number;
    /** 같은 이미지로 센 실패(시간 초과 포함)가 이만큼이면 자동 재시도를 멈춘다(2026-10-14 backfill-retry-ledger spec 4.4). */
    maxAttempts: number;
    /** 첫 재시도 대기(분). 센 실패마다 늘어난다(배수는 ledger.ts 의 BACKFILL_RETRY_BACKOFF_FACTOR). */
    retryDelayMin: number;
    /** 늘어나는 대기의 상한(분). retryDelayMin 이상이어야 한다(설정 검사가 거부). */
    retryMaxDelayMin: number;
  };
}

export type DocumentOcrMode = "manual" | "local" | "api" | "pc_companion";
export type DocumentOcrResourceProfile = "low_power" | "balanced" | "gpu";
export type DocumentOcrLocalProvider =
  | "ollama_vision"
  | "lmstudio_vision"
  | "command";
export type DocumentOcrApiResponseFormat = "markdown" | "json_markdown";
export type DocumentOcrCommandSource = "local" | "server";
export type DocumentOcrAutoStatus = "needs_ocr" | "parse_failed" | "ocr_failed";

export interface DocumentOcrSettings {
  mode: DocumentOcrMode;
  resourceProfile: DocumentOcrResourceProfile;
  /** 한 쪽(파일 업로드 API 는 문서 1건)의 AI 출력 한도(토큰). 로컬·API 공통. 잘리면 저장하지 않고 실패. */
  maxOutputTokensPerPage: number;
  /** PDF 쪽을 그림으로 만들 때 긴 변 픽셀. */
  pageImage: { maxEdgePx: number };
  schedule: {
    /** 서버 자동 처리(로컬·API) 사이클 간격(분). */
    intervalMin: number;
    /** 한 사이클에서 처리할 최대 문서 수. */
    batchSize: number;
    /** 작업 임대 시간(초). 서버는 쪽마다 이만큼 연장한다. */
    leaseSeconds: number;
    /** 한 쪽 처리 한도(ms). */
    timeoutMs: number;
    /** 한 사이클의 최대 쪽 호출 수. */
    maxPagesPerCycle: number;
    /** 하루 최대 쪽 호출 수(실패한 호출 포함). */
    maxPagesPerDay: number;
  };
  /** 쪽 단위 실패 규칙 — 데이터 정리 깊은 패스와 같은 뜻. */
  reliability: {
    /** 같은 입력으로 결정적 실패가 이만큼 쌓이면 자동 재시도를 멈춘다. */
    maxAttemptsPerPage: number;
    /** 실패한 쪽을 다시 시도하기 전 기다리는 시간(분). */
    retryDelayMinutes: number;
    /** 한 사이클에서 일시 실패가 연달아 이만큼이면 사이클을 멈춘다. */
    circuitBreakerThreshold: number;
  };
  local: {
    provider: DocumentOcrLocalProvider;
    ollamaUrl: string;
    ollamaModel: string;
    lmstudioUrl: string;
    lmstudioModel: string;
    commandJson: string;
    /** Ollama 문맥 길이 = maxOutputTokensPerPage + 이 값. */
    ollamaInputTokenReserve: number;
  };
  api: {
    provider: DocumentOcrApiProvider;
    /** 칸 이름은 LLM 공급자 표(LLM_PROVIDER_SPECS)의 modelField/apiKeyField/baseUrlField 그대로. */
    anthropicApiKey: string;
    anthropicModel: string;
    gptApiKey: string;
    gptModel: string;
    geminiApiKey: string;
    geminiModel: string;
    openaiBaseUrl: string;
    openaiModel: string;
    openaiApiKey: string;
    /** 아래 네 칸은 파일 업로드 API(http_file_api) 전용. */
    endpointUrl: string;
    model: string;
    apiKey: string;
    responseFormat: DocumentOcrApiResponseFormat;
  };
  pcCompanion: {
    workerId: string;
    pollSeconds: number;
    commandSource: DocumentOcrCommandSource;
    commandJson: string;
    allowedStatuses: DocumentOcrAutoStatus[];
  };
}
