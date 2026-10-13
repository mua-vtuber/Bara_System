/**
 * 문서 OCR 공급자 표 — 단일 출처 (2026-10-11 document-ocr-api-providers spec D3).
 *
 * 문서 OCR 의 "AI API 사용" 업체 목록, 서버가 직접 돌리는 로컬 AI 목록, 서버 자동 처리 대상 모드,
 * 서버 전용 작업 임대 ID 를 한 곳에 둔다. 설정 스키마의 선택지·대시보드 업체 순서·서버 실행기 분기가
 * 모두 이 표를 읽는다. 공급자별 칸 이름(모델·키·주소)은 LLM 공급자 표(LLM_PROVIDER_SPECS)를 그대로 쓴다 —
 * OCR 용 대응표를 따로 두지 않는다.
 *
 * 브라우저 번들에서도 쓰이므로 타입만 import 한다.
 */

import type { LlmProvider } from "../llm/provider-registry.ts";

/** "AI API 사용" 중 쪽 그림을 AI 에 보내 읽는 업체 — LLM 공급자 값 그대로. */
export const DOCUMENT_OCR_VISION_API_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "openai_compatible",
] as const satisfies readonly LlmProvider[];

export type DocumentOcrVisionApiProvider = (typeof DOCUMENT_OCR_VISION_API_PROVIDERS)[number];

/** "AI API 사용" 업체 전부 — 화면 순서 그대로. 파일 업로드 API 는 문서 파일째 보내는 별도 갈래. */
export const DOCUMENT_OCR_API_PROVIDERS = [...DOCUMENT_OCR_VISION_API_PROVIDERS, "http_file_api"] as const;

export type DocumentOcrApiProvider = (typeof DOCUMENT_OCR_API_PROVIDERS)[number];

/** 서버가 직접 실행할 수 있는 로컬 AI. `command` 는 서버 자동 처리를 지원하지 않는다. */
export const DOCUMENT_OCR_SERVER_LOCAL_PROVIDERS = ["ollama_vision", "lmstudio_vision"] as const;

export type DocumentOcrServerLocalProvider = (typeof DOCUMENT_OCR_SERVER_LOCAL_PROVIDERS)[number];

/** 옛 설정의 OpenAI 호환 vision 값 — 옮기기(migrate-document-ocr-api.ts) 전용. 새 코드는 쓰지 않는다. */
export const LEGACY_DOCUMENT_OCR_API_PROVIDER = "openai_compatible_vision";

/** 서버가 처리 간격대로 자동 처리하는 모드. */
export const DOCUMENT_OCR_SERVER_MODES = ["local", "api"] as const;

export type DocumentOcrServerMode = (typeof DOCUMENT_OCR_SERVER_MODES)[number];

/** 서버 자동 처리 전용 작업 임대 ID — 보조 프로그램이 이 ID 로 임대하면 거절한다. */
export const SERVER_OCR_WORKER_ID = "bara-server-ocr";

export function isDocumentOcrVisionApiProvider(v: unknown): v is DocumentOcrVisionApiProvider {
  return typeof v === "string" && (DOCUMENT_OCR_VISION_API_PROVIDERS as readonly string[]).includes(v);
}

export function isDocumentOcrApiProvider(v: unknown): v is DocumentOcrApiProvider {
  return typeof v === "string" && (DOCUMENT_OCR_API_PROVIDERS as readonly string[]).includes(v);
}

export function isDocumentOcrServerMode(v: unknown): v is DocumentOcrServerMode {
  return typeof v === "string" && (DOCUMENT_OCR_SERVER_MODES as readonly string[]).includes(v);
}

export function isDocumentOcrServerLocalProvider(v: unknown): v is DocumentOcrServerLocalProvider {
  return typeof v === "string" && (DOCUMENT_OCR_SERVER_LOCAL_PROVIDERS as readonly string[]).includes(v);
}
