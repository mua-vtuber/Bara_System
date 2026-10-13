/**
 * POST /settings/actions/list-provider-models — Anthropic·OpenAI·Google·LM Studio 모델 목록
 * (2026-10-11 llm-api-providers spec D9).
 *
 * 요청 본문: { slot, provider, apiKey?, baseUrl? }.
 *   - apiKey 가 비어 있지 않으면 그 키(화면에 방금 입력한, 저장 전 키 — 사용자 결정 Q2), 아니면 저장된 키.
 *   - 키가 필요한 공급자인데 둘 다 없으면 400(칸 이름을 댄다).
 *   - baseUrl 은 openai_compatible 만 받는다. 고정 주소 공급자(anthropic·openai·google)에 주소가 오면 400 —
 *     입력한 키를 남이 정한 주소로 보내지 않는다.
 * 응답 200: { models, filter, keySource }. 공급자 호출 실패는 502 { error, status } — 설정 문제(400)와
 * 바깥 서비스 문제(502)를 화면이 구분하게 한다.
 *
 * 키 보호: 키는 POST 본문으로만 받고(URL·쿼리 금지) 본문을 로그에 남기지 않는다. 공급자 오류 문장은
 * 받은 키와 정확히 같은 부분을 먼저 가리고 redactSecrets 를 한 번 더 거친 뒤 응답한다.
 */

import type { Context, Hono } from "hono";

import type { MemorySettings } from "./memory-settings-types";
import { LLM_PROVIDER_SPECS, type LlmApiKeyField } from "../llm/provider-registry";
import { DOCUMENT_OCR_VISION_API_PROVIDERS, isDocumentOcrVisionApiProvider } from "./document-ocr-api-providers";
import {
  listProviderModels,
  modelListErrorStatus,
  MODEL_LISTING_PROVIDERS,
  type FixedAddressOverrides,
  type ModelListingProvider,
  type ModelListSlot,
} from "../llm/model-listing";
import { maskExactSecrets } from "../llm/provider-http";
import { redactSecrets } from "../memory/cleanup-deep-pass/redact-secrets";

const MODEL_LIST_SLOTS: readonly ModelListSlot[] = ["extractor", "cleanup", "vision", "ocr"];

/**
 * 슬롯의 저장된 공급자 칸(키·모델·주소)과 오류 문장에 쓸 칸 경로. ocr → documents.ocr.api, 그 밖 → llm.<slot>
 * (2026-10-11 document-ocr spec D7). 칸 이름은 LLM 공급자 표 그대로라 두 자리 모두 같은 이름을 가진다.
 */
export function savedValuesForSlot(
  settings: MemorySettings,
  slot: ModelListSlot,
): { values: Readonly<Record<LlmApiKeyField | "openaiBaseUrl", string>>; path: string } {
  if (slot === "ocr") return { values: settings.documents.ocr.api, path: "documents.ocr.api" };
  return { values: settings.llm[slot], path: `llm.${slot}` };
}

export interface ProviderModelsRouteOptions {
  readSettings: () => MemorySettings;
  /** 테스트 대역 서버 주소. 운영 배선은 넘기지 않는다(고정 주소 상수 사용). */
  fixedAddressOverrides?: FixedAddressOverrides;
}

interface ParsedBody {
  slot: ModelListSlot;
  provider: ModelListingProvider;
  apiKey: string;
  baseUrl: string;
}

function parseBody(body: unknown): ParsedBody | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "본문이 객체 형태여야 한다";
  const rec = body as Record<string, unknown>;
  if (!MODEL_LIST_SLOTS.includes(rec.slot as ModelListSlot)) {
    return `slot 은 ${MODEL_LIST_SLOTS.join("/")} 중 하나여야 한다`;
  }
  if (!(MODEL_LISTING_PROVIDERS as readonly string[]).includes(rec.provider as string)) {
    return `provider 는 ${MODEL_LISTING_PROVIDERS.join("/")} 중 하나여야 한다`;
  }
  if (rec.apiKey !== undefined && typeof rec.apiKey !== "string") return "apiKey 는 문자열이어야 한다";
  if (rec.baseUrl !== undefined && typeof rec.baseUrl !== "string") return "baseUrl 은 문자열이어야 한다";
  const provider = rec.provider as ModelListingProvider;
  if (rec.slot === "ocr" && !isDocumentOcrVisionApiProvider(provider)) {
    return `slot=ocr 의 provider 는 ${DOCUMENT_OCR_VISION_API_PROVIDERS.join("/")} 중 하나여야 한다`;
  }
  const baseUrl = typeof rec.baseUrl === "string" ? rec.baseUrl.trim() : "";
  if (provider !== "openai_compatible" && baseUrl.length > 0) {
    return `provider=${provider} 는 고정 주소라 baseUrl 을 받지 않는다`;
  }
  return {
    slot: rec.slot as ModelListSlot,
    provider,
    apiKey: typeof rec.apiKey === "string" ? rec.apiKey.trim() : "",
    baseUrl,
  };
}

function badRequest(c: Context, message: string) {
  return c.json({ error: message }, 400);
}

export function registerProviderModelsRoute(app: Hono, opts: ProviderModelsRouteOptions): void {
  app.post("/actions/list-provider-models", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return badRequest(c, "invalid JSON body");
    }
    const parsed = parseBody(body);
    if (typeof parsed === "string") return badRequest(c, parsed);

    let settings: MemorySettings;
    try {
      settings = opts.readSettings();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `settings 읽기 실패: ${message}` }, 500);
    }
    const { values: slotValues, path: slotPath } = savedValuesForSlot(settings, parsed.slot);
    const spec = LLM_PROVIDER_SPECS[parsed.provider];

    // 키 고르기 — 입력한 키 우선, 없으면 저장된 키.
    let apiKey = "";
    let keySource: "typed" | "saved" | "none" = "none";
    if (parsed.apiKey.length > 0) {
      apiKey = parsed.apiKey;
      keySource = "typed";
    } else if (spec.apiKeyField !== null && slotValues[spec.apiKeyField].trim().length > 0) {
      apiKey = slotValues[spec.apiKeyField].trim();
      keySource = "saved";
    }
    if (spec.apiKeyRequired && keySource === "none") {
      return badRequest(c, `${slotPath}.${spec.apiKeyField} 가 비어 있음 — 키를 입력하거나 저장하라`);
    }

    let baseUrl: string | undefined;
    if (parsed.provider === "openai_compatible") {
      baseUrl = parsed.baseUrl.length > 0 ? parsed.baseUrl : slotValues.openaiBaseUrl.trim();
      if (baseUrl.length === 0) {
        return badRequest(c, `${slotPath}.openaiBaseUrl 가 비어 있음 — 주소를 입력하거나 저장하라`);
      }
    }

    try {
      const result = await listProviderModels(
        { provider: parsed.provider, slot: parsed.slot, apiKey, ...(baseUrl !== undefined ? { baseUrl } : {}) },
        opts.fixedAddressOverrides,
      );
      return c.json({ ...result, keySource });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const safe = redactSecrets(maskExactSecrets(raw, [apiKey]));
      return c.json({ error: safe, status: modelListErrorStatus(err) }, 502);
    }
  });
}
