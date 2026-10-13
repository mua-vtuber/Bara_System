/**
 * VisionProvider — VLM (Vision-Language Model) 통로 추상화 (Phase 11b T9).
 *
 * 이미지 + 프롬프트 → 캡션 글 회신. 옛 LlmClient (글 한정) 가족 옆 자연 합류 —
 * 별 인터페이스로 자가 격리해서 vision 가족만의 옵션 (token cap / mime / 강제 호출
 * 흐름) 자가 흐름 유지.
 *
 * 구현 (2026-10-11 OpenAI·Gemini 추가):
 *   - OpenAiVisionProvider (`openai.ts`) / GeminiVisionProvider (`gemini.ts`) /
 *     OpenAiCompatibleVisionProvider (`openai-compatible.ts`, LM Studio).
 *   - AnthropicVisionProvider (`anthropic.ts`) — Anthropic Messages API + content
 *     blocks 안 base64 image + text. claude-sonnet-4-* / claude-opus-4-* 가족 사용.
 *   - OllamaVisionProvider (`ollama.ts`) — 로컬 Ollama HTTP /api/chat + messages[0]
 *     안 images: [base64]. qwen3-vl:4b / llava 가족 사용.
 *
 * 인터페이스 호출 흐름:
 *   const provider = createVisionProvider(settings.llm.vision);
 *   if (provider) {
 *     const { caption } = await provider.captionImage(buffer, "image/png", "...", { maxTokens: 200 });
 *   }
 *
 * settings 양식 (T11 가 settings UI 신설 — T9 시점엔 양식만 동결):
 *   { enabled, provider: 'anthropic' | 'ollama' | null, model, endpoint, apiKey,
 *     tokenCap, forceCall }
 *
 * 가동 실패 흐름 (CLAUDE.md 정합 — silent fallback 금지):
 *   - enabled=false 또는 provider=null → createVisionProvider 가 null 회신 (정상 OFF).
 *   - enabled=true 인데 apiKey 또는 endpoint 부족 → 정직 throw (구체 식별자 메시지).
 *   - captionImage 호출 중 가동 실패 (HTTP 5xx / 응답 양식 어긋남) → 정직 throw.
 */

import { AnthropicVisionProvider } from "./anthropic.ts";
import { OllamaVisionProvider } from "./ollama.ts";
import { OpenAiCompatibleVisionProvider } from "./openai-compatible.ts";
import { OpenAiVisionProvider } from "./openai.ts";
import { GeminiVisionProvider } from "./gemini.ts";
import { LLM_PROVIDER_SPECS, type LlmProvider } from "../provider-registry.ts";

/**
 * VisionProvider settings 양식.
 *
 * T11 가 `data/memory-settings.json` 안 `llm.vision` 칸 신설 자리. T9 시점엔 본 양식만
 * 동결 + T10 가 호출 흐름 합류 + T11 이 UI 칸 신설.
 */
export interface VisionProviderSettings {
  /** OFF / ON 갈래. false 시 createVisionProvider 가 null 회신 (호출 자체 건너뜀). */
  enabled: boolean;
  /** 공급자 표(provider-registry.ts)의 값. null 시 createVisionProvider 가 null 회신. */
  provider: LlmProvider | null;
  /** 모델 식별자. anthropic = "claude-sonnet-4-6" 가족, ollama = "qwen3-vl:4b" 가족. */
  model: string | null;
  /** ollama 한정 — `http://127.0.0.1:11434` 가족. anthropic 은 SDK default 사용 (null 허용). */
  endpoint: string | null;
  /** anthropic 한정 — Anthropic API 키. ollama 는 null 허용. */
  apiKey: string | null;
  /** captionImage 호출별 max_tokens default. 사이드카 default 200~400. */
  tokenCap: number;
  /** 호출 강제 갈래 — T10 자동 흐름 안 default 호출 흐름 / forceCall=true 면 항상 호출. */
  forceCall: boolean;
  /**
   * ollama 한정 — 캡션 한 번의 호출 한도(ms). OllamaVisionProvider.timeoutMs 로 전달.
   * anthropic 은 SDK 자체 타임아웃을 쓰므로 무관. 미지정 시 OllamaVisionProvider 가
   * 자체 default 를 쓴다.
   */
  timeoutMs?: number;
}

/** captionImage 호출 옵션. 전부 옵셔널 — 어댑터별 default 사용. */
export interface VisionCaptionOptions {
  /** max output tokens. 미지정 시 settings.tokenCap 사용. */
  maxTokens?: number;
  /** temperature. 0.0~1.0. 캡션 작업은 0.2~0.4 권장 (default 0.3). */
  temperature?: number;
  /** AbortSignal — 봇 SIGTERM 시 호출 빠른 단절. */
  signal?: AbortSignal;
  /**
   * Ollama think 토글. false 면 VLM 추론(thinking) 제거.
   * 미지정 시 송신 안 함 = 모델 기본 동작. Ollama 전용 칸 — Anthropic vision 은 무시.
   */
  think?: boolean;
  /**
   * Ollama 문맥 길이(options.num_ctx). 문서 OCR 이 출력 한도 + 입력 여유로 정해 넘긴다. Ollama 전용 칸 —
   * 다른 공급자는 무시한다(think 와 같은 방식). 미지정 시 보내지 않는다 = 모델·서버 기본값.
   */
  numCtx?: number;
  /**
   * 문서 OCR 전용 — 정상 종료(stop)인데 글이 없는 회신을 오류 대신 빈 caption 으로 돌려준다(빈 쪽). 잘림·비정상
   * 종료 판정은 호출부(문서 OCR)가 stopReason 으로 한다. 미지정이면 지금처럼 빈 캡션 = 오류(이미지 캡션 그대로).
   */
  allowEmptyText?: boolean;
}

/** 캡션 배선이 넘기는 한도 칸 경로 — 글 없이 잘렸을 때 오류 문장에 들어간다. */
export const VISION_CAPTION_LIMIT_SETTING_PATH = "llm.vision.tokenCap";

/** captionImage 회신 양식. */
export interface VisionCaptionResult {
  /** 모델 회신 캡션 글. trim 후 회신. */
  caption: string;
  /** usage 메트릭 (가용 시). anthropic 은 input/output tokens 회신, ollama 는 prompt/eval count. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  /**
   * 종료 사유(공급자가 알려 줄 때). "max_tokens" 면 캡션이 출력 한도(tokenCap)에서 잘린 것 —
   * caption-flow 가 저장은 하고 경고를 남긴다(2026-10-11 spec D8). 알려 주지 않는 공급자는 비워 둔다.
   */
  stopReason?: "stop" | "max_tokens" | "other";
}

/**
 * VisionProvider 공통 계약. 두 구현 (AnthropicVisionProvider / OllamaVisionProvider) 가
 * 같은 시그니처를 따라 caller (T10 ingest 흐름) 는 본 인터페이스 한 양식만 알면 된다.
 */
export interface VisionProvider {
  /** 어댑터 이름 (로그용). 예: "anthropic:claude-sonnet-4-6" / "ollama:qwen3-vl:4b". */
  readonly name: string;

  /**
   * 이미지 buffer + mimeType + 프롬프트 글 → 캡션 회신.
   * 실패 시 정직 throw — silent fallback 없음.
   */
  captionImage(
    imageBuffer: Uint8Array | Buffer,
    mimeType: string,
    prompt: string,
    options?: VisionCaptionOptions,
  ): Promise<VisionCaptionResult>;
}

/**
 * settings 검사 후 VisionProvider 한 갈래 생성.
 *
 * 회신 흐름:
 *   - enabled=false → null (정상 OFF — caller 가 호출 자체 건너뜀)
 *   - provider=null → null (정상 OFF)
 *   - enabled=true + provider='anthropic' + apiKey 빈 문자열 → throw
 *   - enabled=true + provider='ollama' + endpoint 빈 문자열 → throw
 *   - enabled=true + model 빈 문자열 → throw
 *
 * AnthropicVisionProvider 는 testBaseUrl 옵션을 추가로 받아 가짜 server URL 가리키게 함
 * (단위 test 한정 — settings 양식엔 없음).
 */
export function createVisionProvider(
  settings: VisionProviderSettings,
): VisionProvider | null {
  if (settings.enabled === false) return null;
  if (settings.provider === null) return null;

  if (!settings.model || settings.model.length === 0) {
    throw new Error(
      `createVisionProvider: enabled=true 인데 model 이 비어 있음. ` +
        `settings.llm.vision.${LLM_PROVIDER_SPECS[settings.provider].modelField} 를 채워라 (provider=${settings.provider}).`,
    );
  }

  if (settings.provider === "anthropic") {
    if (!settings.apiKey || settings.apiKey.length === 0) {
      throw new Error(
        `createVisionProvider: provider='anthropic' 인데 apiKey 가 비어 있음. ` +
          `settings.llm.vision.apiKey 를 채우거나 provider 를 'ollama' 로 전환하라.`,
      );
    }
    return new AnthropicVisionProvider({
      apiKey: settings.apiKey,
      model: settings.model,
      defaultMaxTokens: settings.tokenCap,
      limitSettingPath: VISION_CAPTION_LIMIT_SETTING_PATH,
    });
  }

  if (settings.provider === "ollama") {
    if (!settings.endpoint || settings.endpoint.length === 0) {
      throw new Error(
        `createVisionProvider: provider='ollama' 인데 endpoint 가 비어 있음. ` +
          `settings.llm.vision.endpoint 를 채워라 (예: http://127.0.0.1:11434).`,
      );
    }
    return new OllamaVisionProvider({
      baseUrl: settings.endpoint,
      model: settings.model,
      defaultMaxTokens: settings.tokenCap,
      limitSettingPath: VISION_CAPTION_LIMIT_SETTING_PATH,
      // settings.llm.vision.timeoutMs 를 그대로 전달 — A1 CPU 캡션이 옛 고정 120초를
      // 넘겨 끊기던 흠을 푼다 (extractor.timeoutMs 선례 정합). 같은 ms 단위라 변환 0.
      timeoutMs: settings.timeoutMs,
    });
  }

  if (settings.provider === "openai_compatible") {
    if (!settings.endpoint || settings.endpoint.length === 0) {
      throw new Error(
        `createVisionProvider: provider='openai_compatible' 인데 endpoint 가 비어 있음. ` +
          `settings.llm.vision.openaiBaseUrl 를 채워라 (예: http://127.0.0.1:1234/v1).`,
      );
    }
    return new OpenAiCompatibleVisionProvider({
      baseUrl: settings.endpoint,
      model: settings.model,
      apiKey: settings.apiKey ?? "",
      defaultMaxTokens: settings.tokenCap,
      limitSettingPath: VISION_CAPTION_LIMIT_SETTING_PATH,
      timeoutMs: settings.timeoutMs,
    });
  }

  if (settings.provider === "openai" || settings.provider === "google") {
    const keyField = settings.provider === "openai" ? "gptApiKey" : "geminiApiKey";
    if (!settings.apiKey || settings.apiKey.trim().length === 0) {
      throw new Error(
        `createVisionProvider: provider='${settings.provider}' 인데 apiKey 가 비어 있음. ` +
          `settings.llm.vision.${keyField} 를 채워라.`,
      );
    }
    if (settings.timeoutMs === undefined) {
      throw new Error(
        `createVisionProvider: provider='${settings.provider}' 인데 timeoutMs 가 없음. settings.llm.vision.timeoutMs 를 확인하라.`,
      );
    }
    const providerOptions = {
      apiKey: settings.apiKey,
      model: settings.model,
      defaultMaxTokens: settings.tokenCap,
      limitSettingPath: VISION_CAPTION_LIMIT_SETTING_PATH,
      timeoutMs: settings.timeoutMs,
    };
    return settings.provider === "openai"
      ? new OpenAiVisionProvider(providerOptions)
      : new GeminiVisionProvider(providerOptions);
  }

  throw new Error(
    `createVisionProvider: 알 수 없는 provider 값: ${String(settings.provider)}`,
  );
}
