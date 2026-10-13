/**
 * document-ocr/page-reader.ts — 서버 OCR 한 쪽 읽기 (2026-10-11 document-ocr-api-providers spec D2·D5·D9).
 *
 * 이미지 캡션 공급자를 그대로 재사용한다: OCR 은 "쪽 그림 1장 + 지시문 → 글" 이라 캡션과 같은 호출이다.
 *   - mode=api  + anthropic/openai/google/openai_compatible → 해당 캡션 공급자(키·모델·주소 = OCR 전용 칸)
 *   - mode=local + ollama_vision → OllamaVisionProvider(num_ctx = 출력 한도 + 입력 여유)
 *   - mode=local + lmstudio_vision → OpenAiCompatibleVisionProvider
 *   - mode=api  + http_file_api → 파일 업로드 리더(문서 1건을 "1쪽"으로 셈)
 * 그 밖(command·manual·pc_companion·빈 칸)은 생성 시점에 DocumentOcrConfigError(칸 이름 포함).
 *
 * 잘린 쪽 판정(사용자 결정 Q1): stopReason=max_tokens → 결정적 실패(저장 안 함), stop 이 아니면 결정적 실패,
 * stop + 글 → 성공. 모든 오류는 classifyOcrError 로 3분류 + 키 가림을 거친 OcrPageError 로 던진다.
 */

import { LLM_PROVIDER_SPECS } from "../../llm/provider-registry.ts";
import type { VisionProvider } from "../../llm/vision/index.ts";
import { AnthropicVisionProvider } from "../../llm/vision/anthropic.ts";
import { OpenAiVisionProvider } from "../../llm/vision/openai.ts";
import { GeminiVisionProvider } from "../../llm/vision/gemini.ts";
import { OpenAiCompatibleVisionProvider } from "../../llm/vision/openai-compatible.ts";
import { OllamaVisionProvider } from "../../llm/vision/ollama.ts";
import { errorMessage } from "../../llm/errors.ts";
import {
  isDocumentOcrServerMode,
  isDocumentOcrVisionApiProvider,
  type DocumentOcrVisionApiProvider,
} from "../../settings/document-ocr-api-providers.ts";
import type { DocumentOcrSettings } from "../../settings/memory-settings.ts";
import { callHttpFileOcrApi } from "../routes/documents-ocr-api.ts";
import { classifyOcrError } from "./error-classify.ts";
import {
  DocumentOcrConfigError,
  OcrPageError,
  type OcrAsset,
  type OcrPageImage,
  type OcrPageResult,
} from "./types.ts";

/** 모델에 주는 OCR 지시문 — 로컬·API 공통 한 곳. 글을 바꾸면 버전을 올린다(원장 지문 → 다시 평가 신호). */
export const DOCUMENT_OCR_PROMPT = [
  "Extract all visible text from this document page image and return Markdown only.",
  "Keep the original language and reading order. Do not summarize, translate, or add commentary.",
  "Do not wrap the output in code fences.",
].join("\n");
export const DOCUMENT_OCR_PROMPT_VERSION = 1;
export const DOCUMENT_OCR_TEMPERATURE = 0;
/** 글 없이 잘렸을 때 오류 문장에 넣는 한도 칸 경로. */
export const DOCUMENT_OCR_LIMIT_SETTING_PATH = "documents.ocr.maxOutputTokensPerPage";

/** 지문에 들어가는 리더 정보(공급자·모델·한도·지시문 버전 등). */
export type OcrFingerprintParts = Readonly<Record<string, string | number>>;

export interface DocumentOcrPageReader {
  readonly kind: "vision";
  /** 문서 상태의 providerName — "server-api:openai", "server-local:ollama_vision" 등. */
  readonly providerName: string;
  readonly fingerprintParts: OcrFingerprintParts;
  /** 실패는 OcrPageError(분류·가림 마침). */
  readPage(page: OcrPageImage, signal?: AbortSignal): Promise<OcrPageResult>;
}

export interface DocumentOcrFileReader {
  readonly kind: "file";
  readonly providerName: string;
  readonly fingerprintParts: OcrFingerprintParts;
  /** 문서 파일째 한 번 호출 — 원장에서는 0쪽 한 행으로 센다. */
  readDocument(documentId: string, asset: OcrAsset, signal?: AbortSignal): Promise<OcrPageResult>;
}

export type DocumentOcrReader = DocumentOcrPageReader | DocumentOcrFileReader;

/** 테스트 전용 — 고정 주소 공급자(Anthropic·OpenAI·Gemini)를 대역 서버로 돌린다. 운영 배선은 넘기지 않는다. */
export interface FixedAddressOverrides {
  anthropicBaseUrl?: string;
  openaiBaseUrl?: string;
  geminiBaseUrl?: string;
}

function emptyField(path: string, provider: string): DocumentOcrConfigError {
  return new DocumentOcrConfigError(`${path} 이 비어 있음 (provider=${provider})`);
}

function requireValue(value: string, path: string, provider: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw emptyField(path, provider);
  return trimmed;
}

interface VisionBuild {
  provider: VisionProvider;
  providerName: string;
  model: string;
  /** 오류 문장에서 가릴 키. */
  secrets: string[];
  /** 키 칸 경로(인증 거절 사유에 칸 이름을 대려고). 키가 없는 갈래는 없음. */
  keyPath?: string;
  numCtx?: number;
  fingerprintParts: Record<string, string | number>;
}

function buildApiVision(
  settings: DocumentOcrSettings,
  provider: DocumentOcrVisionApiProvider,
  overrides: FixedAddressOverrides,
): VisionBuild {
  const api = settings.api;
  const spec = LLM_PROVIDER_SPECS[provider];
  const base = "documents.ocr.api";
  const model = requireValue(api[spec.modelField as keyof typeof api] as string, `${base}.${spec.modelField}`, provider);
  const keyField = spec.apiKeyField;
  const key = keyField === null ? "" : (api[keyField as keyof typeof api] as string).trim();
  if (keyField !== null && spec.apiKeyRequired && key.length === 0) throw emptyField(`${base}.${keyField}`, provider);
  const common = {
    limitSettingPath: DOCUMENT_OCR_LIMIT_SETTING_PATH,
    defaultMaxTokens: settings.maxOutputTokensPerPage,
    timeoutMs: settings.schedule.timeoutMs,
  };
  const parts: Record<string, string | number> = { provider, model };
  let vision: VisionProvider;
  if (provider === "anthropic") {
    vision = new AnthropicVisionProvider({
      ...common, apiKey: key, model, maxRetries: 0,
      ...(overrides.anthropicBaseUrl ? { baseURL: overrides.anthropicBaseUrl } : {}),
    });
  } else if (provider === "openai") {
    vision = new OpenAiVisionProvider({ ...common, apiKey: key, model, ...(overrides.openaiBaseUrl ? { baseUrl: overrides.openaiBaseUrl } : {}) });
  } else if (provider === "google") {
    vision = new GeminiVisionProvider({ ...common, apiKey: key, model, ...(overrides.geminiBaseUrl ? { baseUrl: overrides.geminiBaseUrl } : {}) });
  } else {
    const baseUrl = requireValue(api.openaiBaseUrl, `${base}.openaiBaseUrl`, provider);
    parts.baseUrl = baseUrl;
    vision = new OpenAiCompatibleVisionProvider({ ...common, baseUrl, model, apiKey: key });
  }
  return {
    provider: vision, providerName: `server-api:${provider}`, model, secrets: [key], fingerprintParts: parts,
    ...(keyField !== null ? { keyPath: `${base}.${keyField}` } : {}),
  };
}

function buildLocalVision(settings: DocumentOcrSettings): VisionBuild {
  const local = settings.local;
  const common = {
    limitSettingPath: DOCUMENT_OCR_LIMIT_SETTING_PATH,
    defaultMaxTokens: settings.maxOutputTokensPerPage,
    timeoutMs: settings.schedule.timeoutMs,
  };
  if (local.provider === "ollama_vision") {
    const baseUrl = requireValue(local.ollamaUrl, "documents.ocr.local.ollamaUrl", local.provider);
    const model = requireValue(local.ollamaModel, "documents.ocr.local.ollamaModel", local.provider);
    const numCtx = settings.maxOutputTokensPerPage + local.ollamaInputTokenReserve;
    return {
      provider: new OllamaVisionProvider({ ...common, baseUrl, model }),
      providerName: `server-local:${local.provider}`,
      model,
      secrets: [],
      numCtx,
      fingerprintParts: { provider: local.provider, baseUrl, model, numCtx },
    };
  }
  if (local.provider === "lmstudio_vision") {
    const baseUrl = requireValue(local.lmstudioUrl, "documents.ocr.local.lmstudioUrl", local.provider);
    const model = requireValue(local.lmstudioModel, "documents.ocr.local.lmstudioModel", local.provider);
    return {
      provider: new OpenAiCompatibleVisionProvider({ ...common, baseUrl, model }),
      providerName: `server-local:${local.provider}`,
      model,
      secrets: [],
      fingerprintParts: { provider: local.provider, baseUrl, model },
    };
  }
  throw new DocumentOcrConfigError(
    `documents.ocr.local.provider=${local.provider} 는 서버 자동 처리를 지원하지 않음 — Ollama 또는 LM Studio 를 고르거나 내 PC 보조 프로그램을 쓰세요`,
  );
}

/** 잘림·비정상 종료 판정(D5) 뒤 글을 돌려준다. pageNumber 는 사람이 읽는 1부터 번호. */
function acceptPageText(
  caption: string,
  stopReason: string | undefined,
  pageNumber: number,
  settings: DocumentOcrSettings,
  build: VisionBuild,
): string {
  const label = build.providerName.replace(/^server-(api|local):/, "");
  if (stopReason === "max_tokens") {
    throw new OcrPageError(
      `OCR 결과가 출력 한도(${DOCUMENT_OCR_LIMIT_SETTING_PATH}=${settings.maxOutputTokensPerPage})에서 잘림 — ${pageNumber}쪽 뒷부분 글이 빠져 저장하지 않음. 한도를 올리면 다시 처리됨 (provider=${label}, model=${build.model})`,
      "deterministic",
    );
  }
  if (stopReason !== "stop") {
    throw new OcrPageError(
      `OCR 응답이 정상 종료가 아님(stopReason=${stopReason ?? "없음"}) — 끝까지 읽었는지 알 수 없어 저장하지 않음`,
      "deterministic",
    );
  }
  // 정상 종료 + 글 없음 = 빈 쪽(사용자 결정 H3) — 실패가 아니다. 호출부가 blank 로 기록한다.
  return caption.trim();
}

/**
 * 분류 + 키 가림 뒤, 공급자 응답 해석 단계의 영어 오류 문장(예: "response missing choices…")은 앞에 사람이 읽는
 * 한국어 사유를 붙인다. 상태 코드가 있는 전송 오류·우리가 만든 판정 문장은 그대로 둔다.
 */
function readableOcrFailure(err: unknown, secrets: readonly string[], keyPath?: string): OcrPageError {
  const failure = classifyOcrError(err, secrets);
  // 인증·권한 거절(401·403, 또는 400 + API_KEY_INVALID 등) — 어느 키 칸을 고쳐야 하는지 칸 이름을 앞에 댄다(키 값 없음).
  if (keyPath && failure.klass === "config" && (failure.httpStatus === 400 || failure.httpStatus === 401 || failure.httpStatus === 403)) {
    return new OcrPageError(`${keyPath} 의 키가 거절됨(인증·권한 문제) — 키를 확인하세요: ${failure.message}`, "config", null, failure.httpStatus);
  }
  if (err instanceof OcrPageError || failure.klass !== "deterministic" || failure.httpStatus !== null) return failure;
  return new OcrPageError(`AI 응답을 글로 읽지 못함(응답 형식이 예상과 다름) — ${failure.message}`, failure.klass, failure.retryAfterMs);
}

function createVisionReader(settings: DocumentOcrSettings, build: VisionBuild): DocumentOcrPageReader {
  const fingerprintParts = Object.freeze({
    ...build.fingerprintParts,
    maxOutputTokensPerPage: settings.maxOutputTokensPerPage,
    promptVersion: DOCUMENT_OCR_PROMPT_VERSION,
  });
  return {
    kind: "vision",
    providerName: build.providerName,
    fingerprintParts,
    async readPage(page, signal) {
      try {
        const result = await build.provider.captionImage(page.bytes, page.mimeType, DOCUMENT_OCR_PROMPT, {
          maxTokens: settings.maxOutputTokensPerPage,
          temperature: DOCUMENT_OCR_TEMPERATURE,
          ...(signal ? { signal } : {}),
          ...(build.numCtx !== undefined ? { numCtx: build.numCtx } : {}),
          allowEmptyText: true,
        });
        const markdown = acceptPageText(result.caption, result.stopReason, page.pageIndex + 1, settings, build);
        const usage = result.usage && (result.usage.inputTokens !== undefined || result.usage.outputTokens !== undefined)
          ? { ...result.usage }
          : null;
        return { markdown, usage, blank: markdown.length === 0 };
      } catch (err) {
        throw readableOcrFailure(err, build.secrets, build.keyPath);
      }
    },
  };
}

function createFileReader(settings: DocumentOcrSettings): DocumentOcrFileReader {
  const endpoint = requireValue(settings.api.endpointUrl, "documents.ocr.api.endpointUrl", "http_file_api");
  const secrets = [settings.api.apiKey.trim()];
  return {
    kind: "file",
    providerName: "server-api:http_file_api",
    fingerprintParts: Object.freeze({
      provider: "http_file_api",
      endpoint,
      model: settings.api.model.trim(),
      responseFormat: settings.api.responseFormat,
    }),
    async readDocument(documentId, asset, signal) {
      try {
        const markdown = await callHttpFileOcrApi(
          settings,
          { documentId, bytes: asset.bytes, mimeType: asset.mimeType, originalName: asset.originalName },
          signal,
        );
        if (markdown.trim().length === 0) {
          throw new OcrPageError("OCR API가 빈 Markdown을 반환했습니다", "deterministic");
        }
        return { markdown, usage: null, blank: false };
      } catch (err) {
        throw readableOcrFailure(err, secrets, secrets[0] ? "documents.ocr.api.apiKey" : undefined);
      }
    },
  };
}

/**
 * 지금 설정으로 리더를 만든다. 서버 자동 처리 대상이 아닌 조합·빈 칸은 DocumentOcrConfigError(칸 이름 포함).
 * 공급자 생성자의 검사 오류도 같은 오류로 바꾼다(설정 결함).
 */
export function createDocumentOcrReader(
  settings: DocumentOcrSettings,
  overrides: FixedAddressOverrides = {},
): DocumentOcrReader {
  if (!isDocumentOcrServerMode(settings.mode)) {
    throw new DocumentOcrConfigError(`documents.ocr.mode=${settings.mode} 은 서버 자동 처리 대상이 아님`);
  }
  try {
    if (settings.mode === "local") return createVisionReader(settings, buildLocalVision(settings));
    if (settings.api.provider === "http_file_api") return createFileReader(settings);
    if (!isDocumentOcrVisionApiProvider(settings.api.provider)) {
      throw new DocumentOcrConfigError(`documents.ocr.api.provider=${String(settings.api.provider)} 는 알 수 없는 업체`);
    }
    return createVisionReader(settings, buildApiVision(settings, settings.api.provider, overrides));
  } catch (err) {
    if (err instanceof DocumentOcrConfigError) throw err;
    throw new DocumentOcrConfigError(`서버 OCR 리더를 만들지 못함: ${errorMessage(err)}`, { cause: err });
  }
}

/** 쪽 그림 리더만 받는다(파일 업로드 API 면 설정 오류). */
export function createDocumentOcrPageReader(
  settings: DocumentOcrSettings,
  overrides: FixedAddressOverrides = {},
): DocumentOcrPageReader {
  const reader = createDocumentOcrReader(settings, overrides);
  if (reader.kind !== "vision") {
    throw new DocumentOcrConfigError("documents.ocr.api.provider=http_file_api 는 쪽 그림 리더가 아님 — 파일 업로드 리더를 쓴다");
  }
  return reader;
}
