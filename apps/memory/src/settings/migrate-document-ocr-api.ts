/**
 * 옛 문서 OCR API 설정 옮기기 (2026-10-11 document-ocr-api-providers spec D8, 사용자 결정 Q6).
 *
 * 옛 `documents.ocr.api.provider = "openai_compatible_vision"` 은 완성 주소(`endpointUrl`)로 바로 POST 하던 갈래다.
 * 새 설정은 업체를 고르고 업체별 칸(LLM 공급자 표의 칸 이름)을 쓴다. 옮기는 규칙:
 *
 *   - 주소 호스트가 정확히 api.openai.com(https) → provider="openai", gptModel ← model, gptApiKey ← apiKey
 *   - 그 밖 + 끝이 /chat/completions → provider="openai_compatible", openaiBaseUrl ← 끝을 뗀 값, openaiModel ← model,
 *     openaiApiKey ← apiKey
 *   - 그 밖 + 끝이 다름 → openai_compatible, openaiBaseUrl ← 그대로 + 경고(짐작해 다른 주소로 바꾸지 않음)
 *   - 빈 칸 → openai_compatible, openaiBaseUrl="" (실행 때 칸 이름 오류 — 옛 코드도 실패하던 조합)
 *
 * 대상 칸에 이미 값이 있으면 덮지 않는다(멱등). endpointUrl·model 은 옮긴 뒤 비운다(이제 파일 업로드 API 전용 칸).
 * apiKey 는 비밀 값이라 여기서 다루지 않고 "어디서 어디로 복사할지"만 돌려준다 — getMemorySettings 가 비밀 파일을
 * 얹은 뒤 대상이 비었으면 복사한다(빈 값 = 저장된 키 유지 약속이라 저장으로 옛 키를 지울 수는 없다). 경고에는 칸
 * 이름만 넣고 키 값·자릿수는 넣지 않는다.
 */

import { LLM_PROVIDER_SPECS } from "../llm/provider-registry.ts";
import { LEGACY_DOCUMENT_OCR_API_PROVIDER } from "./document-ocr-api-providers.ts";

/** 비밀 값 복사 한 건 — 둘 다 PASSWORD_FIELD_PATHS 에 있는 경로. */
export interface SecretCopy {
  from: string;
  to: string;
}

const API_PATH = "documents.ocr.api";
const OPENAI_HOST = "api.openai.com";
const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

function readApiObject(settings: Record<string, unknown>): Record<string, unknown> | null {
  const documents = settings.documents;
  if (!documents || typeof documents !== "object") return null;
  const ocr = (documents as Record<string, unknown>).ocr;
  if (!ocr || typeof ocr !== "object") return null;
  const api = (ocr as Record<string, unknown>).api;
  if (!api || typeof api !== "object") return null;
  return api as Record<string, unknown>;
}

function stringAt(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === "string" ? value.trim() : "";
}

function isOpenAiEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && url.hostname === OPENAI_HOST;
  } catch {
    return false;
  }
}

/** 대상 칸이 비어 있을 때만 값을 넣는다. 이미 값이 있으면 그대로 두고 경고한다. */
function setIfEmpty(
  api: Record<string, unknown>,
  key: string,
  value: string,
  warnings: string[],
): void {
  if (value.length === 0) return;
  if (stringAt(api, key).length > 0) {
    warnings.push(
      `문서 OCR 옛 설정 옮기기 — ${API_PATH}.${key} 에 이미 값이 있어 옛 값으로 덮지 않음.`,
    );
    return;
  }
  api[key] = value;
}

/**
 * settings(파싱한 JSON, 제자리 변경)의 옛 OCR API 갈래를 새 업체 칸으로 옮긴다. 옛 값이 아니면 아무것도 안 한다.
 * @returns 비밀 값 복사 목록(옮기지 않았으면 빈 목록).
 */
export function migrateDocumentOcrApiProvider(
  settings: Record<string, unknown>,
  warnings: string[],
): SecretCopy[] {
  const api = readApiObject(settings);
  if (!api || api.provider !== LEGACY_DOCUMENT_OCR_API_PROVIDER) return [];

  const endpoint = stringAt(api, "endpointUrl");
  const model = stringAt(api, "model");
  const toOpenAi = endpoint.length > 0 && isOpenAiEndpoint(endpoint);
  const provider = toOpenAi ? "openai" : "openai_compatible";
  const spec = LLM_PROVIDER_SPECS[provider];
  api.provider = provider;

  if (!toOpenAi && spec.baseUrlField !== null) {
    let baseUrl = endpoint;
    if (endpoint.endsWith(CHAT_COMPLETIONS_SUFFIX)) {
      baseUrl = endpoint.slice(0, -CHAT_COMPLETIONS_SUFFIX.length);
    } else if (endpoint.length > 0) {
      warnings.push(
        `문서 OCR 옛 설정 옮기기 — ${API_PATH}.endpointUrl 끝이 ${CHAT_COMPLETIONS_SUFFIX} 가 아니라 ${API_PATH}.${spec.baseUrlField} 에 그대로 옮김. 이제 요청은 이 주소 뒤에 ${CHAT_COMPLETIONS_SUFFIX} 를 붙인 곳으로 간다 — 주소가 맞는지 설정 화면에서 확인하세요.`,
      );
    }
    setIfEmpty(api, spec.baseUrlField, baseUrl, warnings);
  }
  setIfEmpty(api, spec.modelField, model, warnings);
  api.endpointUrl = "";
  api.model = "";

  warnings.push(
    `문서 OCR 옛 설정 옮기기 — ${API_PATH}.provider=${LEGACY_DOCUMENT_OCR_API_PROVIDER} → ${provider}.`,
  );
  if (spec.apiKeyField === null) return [];
  return [{ from: `${API_PATH}.apiKey`, to: `${API_PATH}.${spec.apiKeyField}` }];
}
