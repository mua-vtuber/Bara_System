/**
 * model-listing.ts — 공급자별 모델 목록 조회·정규화·거르기 (2026-10-11 llm-api-providers spec D9).
 *
 * 설정 화면의 모델 드롭다운이 쓰는 목록을 공급자 API 에서 그대로 받아 온다. 비용이 들지 않는 목록 조회만
 * 하고 모델 시험 호출은 하지 않는다. 실패하면 던진다 — 빈 목록이나 미리 적어 둔 모델 이름으로 대신하지 않는다.
 *
 *   - Anthropic: GET /v1/models?limit=1000 + has_more/last_id 반복. vision 슬롯이면 공식 칸
 *     capabilities.image_input.supported === false 인 모델을 뺀다(vision·ocr 슬롯 — slotNeedsImageInput).
 *   - OpenAI: GET /models 한 번. 기능 정보가 없어 사용자 결정(Q3)대로 대화 모델 이름 규칙
 *     (openai-model-capabilities.ts)으로 거른다. 만든 날짜 최신순.
 *   - Gemini: GET /models?pageSize=1000 + nextPageToken 반복. generateContent 를 못 하는 모델(임베딩 등)을
 *     뺀다(공식 칸 supportedGenerationMethods). 설정에 저장할 id 는 "models/" 앞머리를 뗀 값.
 *   - OpenAI 호환(LM Studio): GET <baseUrl>/models. 거르지 않는다.
 *
 * 걸러 낸 개수는 filter.removed 로 돌려줘 화면이 밝힌다(조용히 사라지지 않게).
 */

import { LlmRequestError } from "./errors.ts";
import { requestProviderJson } from "./provider-http.ts";
import { isOpenAiChatModelId } from "./openai-model-capabilities.ts";
import { stripGeminiModelPrefix } from "./gemini-wire.ts";
import {
  ANTHROPIC_API_BASE_URL,
  ANTHROPIC_API_VERSION,
  GEMINI_API_BASE_URL,
  MODEL_LIST_MAX_PAGES,
  MODEL_LIST_PAGE_SIZE,
  MODEL_LIST_TIMEOUT_MS,
  OPENAI_API_BASE_URL,
} from "./constants.ts";

/** 모델 목록을 서버 액션으로 가져오는 공급자(Ollama 는 기존 list-ollama-models). */
export const MODEL_LISTING_PROVIDERS = ["anthropic", "openai", "google", "openai_compatible"] as const;
export type ModelListingProvider = (typeof MODEL_LISTING_PROVIDERS)[number];

/** 고정 주소 공급자 — 주소를 요청 본문으로 받지 않는다(입력한 키가 남의 주소로 새지 않게). */
export type FixedAddressProvider = Exclude<ModelListingProvider, "openai_compatible">;

/** 목록을 쓰는 자리 — LLM 세 슬롯 + 문서 OCR(2026-10-11 document-ocr spec D7). */
export type ModelListSlot = "extractor" | "cleanup" | "vision" | "ocr";

/** 이미지 입력을 받는 모델만 남길 자리(이미지 캡션·문서 OCR) — 판정 한 곳. */
export function slotNeedsImageInput(slot: ModelListSlot): boolean {
  return slot === "vision" || slot === "ocr";
}

export interface ListedModel {
  /** 설정에 저장할 값. */
  id: string;
  /** 화면에 보일 이름. */
  label: string;
  /** 공급자가 알려 주면 true/false, 모르면 null. */
  imageInput: boolean | null;
  /** 지원 종료 예정(Anthropic lifecycle=deprecated, OpenAI shutdown_date 있음). */
  deprecated: boolean;
}

export type ModelListFilterKind = "none" | "image-input" | "generate-content" | "name-rule";

export interface ModelListResult {
  models: ListedModel[];
  filter: { kind: ModelListFilterKind; removed: number };
}

export interface ModelListRequest {
  provider: ModelListingProvider;
  slot: ModelListSlot;
  /** 빈 문자열이면 인증 헤더를 싣지 않는다(LM Studio 한정 — 다른 공급자는 호출자가 미리 막는다). */
  apiKey: string;
  /** openai_compatible 한정 주소. */
  baseUrl?: string;
}

/** 테스트 대역 서버 주소. 운영 배선은 넘기지 않는다(고정 주소 상수 사용). */
export type FixedAddressOverrides = Partial<Record<FixedAddressProvider, string>>;

function fixedBase(provider: FixedAddressProvider, overrides: FixedAddressOverrides | undefined): string {
  const defaults: Record<FixedAddressProvider, string> = {
    anthropic: ANTHROPIC_API_BASE_URL,
    openai: OPENAI_API_BASE_URL,
    google: GEMINI_API_BASE_URL,
  };
  return (overrides?.[provider] ?? defaults[provider]).replace(/\/+$/, "");
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${what} 응답 형식 불일치: 객체 필요`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, what: string, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${what} 응답 형식 불일치: ${field} 배열 필요`);
  }
  return value;
}

function tooManyPages(what: string): Error {
  return new Error(`${what} 모델 목록이 ${MODEL_LIST_MAX_PAGES} 페이지(페이지당 ${MODEL_LIST_PAGE_SIZE}개)를 넘음 — 비정상 목록으로 보고 멈춘다`);
}

/** OpenAI 형식 /models 응답의 data[].id 목록(LM Studio·OpenAI 공용). */
export function normalizeOpenAiModels(data: unknown, sourceName: string): Array<{ id: string; name: string }> {
  const rec = asObject(data, sourceName);
  const models = asArray(rec.data, sourceName, "data");
  const result: Array<{ id: string; name: string }> = [];
  for (const entry of models) {
    if (typeof entry === "object" && entry !== null) {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === "string" && id.length > 0) result.push({ id, name: id });
    }
  }
  return result;
}

/** LM Studio 주소 → /models 주소(끝이 /v1 이면 그 뒤에, 아니면 /v1/models). */
export function lmStudioModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  return trimmed.endsWith("/v1") ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

async function listAnthropic(req: ModelListRequest, overrides?: FixedAddressOverrides): Promise<ModelListResult> {
  const base = fixedBase("anthropic", overrides);
  const collected: ListedModel[] = [];
  let afterId: string | null = null;
  for (let page = 0; page < MODEL_LIST_MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(MODEL_LIST_PAGE_SIZE) });
    if (afterId !== null) query.set("after_id", afterId);
    const raw = await requestProviderJson({
      provider: "anthropic",
      label: "Anthropic /v1/models",
      url: `${base}/v1/models?${query.toString()}`,
      method: "GET",
      headers: { "x-api-key": req.apiKey, "anthropic-version": ANTHROPIC_API_VERSION },
      timeoutMs: MODEL_LIST_TIMEOUT_MS,
      secrets: [req.apiKey],
    });
    const rec = asObject(raw, "Anthropic /v1/models");
    for (const entry of asArray(rec.data, "Anthropic /v1/models", "data")) {
      const item = asObject(entry, "Anthropic /v1/models data[]");
      if (typeof item.id !== "string" || item.id.length === 0) continue;
      const caps = item.capabilities as { image_input?: { supported?: unknown } } | undefined;
      const supported = caps?.image_input?.supported;
      const lifecycle = item.lifecycle as unknown;
      const lifecycleStatus =
        typeof lifecycle === "string"
          ? lifecycle
          : lifecycle && typeof lifecycle === "object"
            ? (lifecycle as { status?: unknown }).status
            : undefined;
      collected.push({
        id: item.id,
        label: typeof item.display_name === "string" && item.display_name.length > 0 ? item.display_name : item.id,
        imageInput: typeof supported === "boolean" ? supported : null,
        deprecated: lifecycleStatus === "deprecated",
      });
    }
    if (rec.has_more !== true) {
      if (!slotNeedsImageInput(req.slot)) return { models: collected, filter: { kind: "none", removed: 0 } };
      const kept = collected.filter((m) => m.imageInput !== false);
      return { models: kept, filter: { kind: "image-input", removed: collected.length - kept.length } };
    }
    if (typeof rec.last_id !== "string" || rec.last_id.length === 0) {
      throw new Error("Anthropic /v1/models 응답 형식 불일치: has_more=true 인데 last_id 없음");
    }
    afterId = rec.last_id;
  }
  throw tooManyPages("Anthropic");
}

async function listOpenAi(req: ModelListRequest, overrides?: FixedAddressOverrides): Promise<ModelListResult> {
  const raw = await requestProviderJson({
    provider: "openai",
    label: "OpenAI /models",
    url: `${fixedBase("openai", overrides)}/models`,
    method: "GET",
    headers: { Authorization: `Bearer ${req.apiKey}` },
    timeoutMs: MODEL_LIST_TIMEOUT_MS,
    secrets: [req.apiKey],
  });
  const rec = asObject(raw, "OpenAI /models");
  const all: Array<ListedModel & { created: number }> = [];
  for (const entry of asArray(rec.data, "OpenAI /models", "data")) {
    const item = asObject(entry, "OpenAI /models data[]");
    if (typeof item.id !== "string" || item.id.length === 0) continue;
    all.push({
      id: item.id,
      label: item.id,
      imageInput: null,
      deprecated: item.shutdown_date !== undefined && item.shutdown_date !== null,
      created: typeof item.created === "number" ? item.created : 0,
    });
  }
  const kept = all.filter((m) => isOpenAiChatModelId(m.id)).sort((a, b) => b.created - a.created);
  return {
    models: kept.map(({ created: _created, ...model }) => model),
    filter: { kind: "name-rule", removed: all.length - kept.length },
  };
}

async function listGemini(req: ModelListRequest, overrides?: FixedAddressOverrides): Promise<ModelListResult> {
  const base = fixedBase("google", overrides);
  const kept: ListedModel[] = [];
  let removed = 0;
  let pageToken: string | null = null;
  for (let page = 0; page < MODEL_LIST_MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ pageSize: String(MODEL_LIST_PAGE_SIZE) });
    if (pageToken !== null) query.set("pageToken", pageToken);
    const raw = await requestProviderJson({
      provider: "google",
      label: "Gemini /models",
      url: `${base}/models?${query.toString()}`,
      method: "GET",
      headers: { "x-goog-api-key": req.apiKey },
      timeoutMs: MODEL_LIST_TIMEOUT_MS,
      secrets: [req.apiKey],
    });
    const rec = asObject(raw, "Gemini /models");
    // 키로 볼 수 있는 모델이 0개면 Gemini 는 models 칸 자체를 생략한다 — 그때만 빈 목록으로 본다.
    const models = rec.models === undefined ? [] : asArray(rec.models, "Gemini /models", "models");
    for (const entry of models) {
      const item = asObject(entry, "Gemini /models models[]");
      if (typeof item.name !== "string" || item.name.length === 0) continue;
      const methods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods : [];
      if (!methods.includes("generateContent")) {
        removed += 1;
        continue;
      }
      const id = stripGeminiModelPrefix(item.name);
      kept.push({
        id,
        label: typeof item.displayName === "string" && item.displayName.length > 0 ? item.displayName : id,
        imageInput: null,
        deprecated: false,
      });
    }
    const next = rec.nextPageToken;
    if (typeof next !== "string" || next.length === 0) {
      return { models: kept, filter: { kind: "generate-content", removed } };
    }
    pageToken = next;
  }
  throw tooManyPages("Gemini");
}

async function listOpenAiCompatible(req: ModelListRequest): Promise<ModelListResult> {
  if (!req.baseUrl || req.baseUrl.trim().length === 0) {
    throw new Error("OpenAI 호환 모델 목록: 주소(baseUrl)가 비어 있음");
  }
  const raw = await requestProviderJson({
    provider: "openai_compatible",
    label: "OpenAI 호환 /models",
    url: lmStudioModelsUrl(req.baseUrl.trim()),
    method: "GET",
    headers: req.apiKey.length > 0 ? { Authorization: `Bearer ${req.apiKey}` } : {},
    timeoutMs: MODEL_LIST_TIMEOUT_MS,
    secrets: [req.apiKey],
  });
  const models = normalizeOpenAiModels(raw, "OpenAI 호환").map((m) => ({
    id: m.id,
    label: m.name,
    imageInput: null,
    deprecated: false,
  }));
  return { models, filter: { kind: "none", removed: 0 } };
}

/** 공급자별 목록 조회. 실패는 LlmRequestError(상태 코드) 또는 형식 오류 Error 로 던진다. */
export async function listProviderModels(
  req: ModelListRequest,
  overrides?: FixedAddressOverrides,
): Promise<ModelListResult> {
  switch (req.provider) {
    case "anthropic":
      return listAnthropic(req, overrides);
    case "openai":
      return listOpenAi(req, overrides);
    case "google":
      return listGemini(req, overrides);
    case "openai_compatible":
      return listOpenAiCompatible(req);
    default: {
      const unknown: never = req.provider;
      throw new Error(`listProviderModels: 알 수 없는 공급자 (${String(unknown)})`);
    }
  }
}

/** 목록 실패의 HTTP 상태(공급자가 준 값). 응답이 없거나 형식 오류면 null. */
export function modelListErrorStatus(error: unknown): number | null {
  return error instanceof LlmRequestError ? error.status : null;
}
