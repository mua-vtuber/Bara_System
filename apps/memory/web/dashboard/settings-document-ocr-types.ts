/**
 * dashboard/settings-document-ocr-types.ts — 문서 OCR 설정 값 타입과 엄격한 읽기 (2026-10-11 document-ocr spec D18).
 *
 * 서버 GET /settings 는 늘 기본값을 합친 전체 설정을 보낸다. 그래서 칸이 없거나 형식이 틀리면 서버·화면 버전이
 * 어긋난 것이고, 기본값으로 메우지 않고 칸 이름을 대며 멈춘다(settings-llm-types.ts 의 readRequiredString 선례).
 * 화면 값의 타입은 서버 설정 타입을 그대로 쓴다(사본 타입을 두지 않음).
 */

import {
  DOCUMENT_OCR_API_PROVIDERS,
  type DocumentOcrApiProvider,
} from "../../src/settings/document-ocr-api-providers";
import { LLM_API_KEY_FIELDS, type LlmApiKeyField } from "../../src/llm/provider-registry";
import type {
  DocumentOcrAutoStatus,
  DocumentOcrSettings,
} from "../../src/settings/memory-settings-slots";

export type { DocumentOcrApiProvider, DocumentOcrSettings };
export type DocumentOcrMode = DocumentOcrSettings["mode"];
export type DocumentOcrLocalProvider = DocumentOcrSettings["local"]["provider"];
export type VisibleDocumentOcrLocalProvider = Exclude<DocumentOcrLocalProvider, "command">;

/** 화면이 쓰는 OCR 설정 + 서버에 키가 저장된 OCR API 키 칸. */
export interface DocumentOcrSettingsValue extends DocumentOcrSettings {
  savedKeyFields: readonly LlmApiKeyField[];
  /** 파일 업로드 API 키(documents.ocr.api.apiKey)가 저장돼 있는지. */
  httpFileKeySaved: boolean;
}

const MODES = ["manual", "local", "api", "pc_companion"] as const;
const PROFILES = ["low_power", "balanced", "gpu"] as const;
const LOCAL_PROVIDERS = ["ollama_vision", "lmstudio_vision", "command"] as const;
const RESPONSE_FORMATS = ["markdown", "json_markdown"] as const;
const COMMAND_SOURCES = ["local", "server"] as const;
const AUTO_STATUSES = ["needs_ocr", "parse_failed", "ocr_failed"] as const;

function objectAt(parent: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
  const value = parent[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} 값이 객체가 아님 — 서버·화면 버전을 확인하세요.`);
  }
  return value as Record<string, unknown>;
}

function str(obj: Record<string, unknown>, path: string, key: string): string {
  const value = obj[key];
  if (typeof value !== "string") throw new Error(`${path}.${key} 값이 문자열이 아님 — "${String(value)}".`);
  return value;
}

function int(obj: Record<string, unknown>, path: string, key: string): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${path}.${key} 값이 정수가 아님 — "${String(value)}".`);
  }
  return value;
}

function oneOf<T extends string>(obj: Record<string, unknown>, path: string, key: string, allowed: readonly T[]): T {
  const value = obj[key];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${path}.${key} 값이 ${allowed.join("/")} 중 하나가 아님 — "${String(value)}".`);
  }
  return value as T;
}

function secretsSetOf(value: Record<string, unknown>): ReadonlySet<string> {
  const raw = value.$secretsSet;
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    throw new Error("설정 응답에 $secretsSet(저장된 키 경로 목록)이 없음 — 서버 응답 형식을 확인하세요.");
  }
  return new Set(raw as string[]);
}

/** 서버 설정 응답에서 documents.ocr 를 엄격하게 읽는다. 칸이 없거나 틀리면 칸 이름을 대며 던진다. */
export function readDocumentOcrSettings(value: Record<string, unknown>): DocumentOcrSettingsValue {
  const documents = objectAt(value, "documents", "documents");
  const ocr = objectAt(documents, "ocr", "documents.ocr");
  const base = "documents.ocr";
  const pageImage = objectAt(ocr, "pageImage", `${base}.pageImage`);
  const schedule = objectAt(ocr, "schedule", `${base}.schedule`);
  const reliability = objectAt(ocr, "reliability", `${base}.reliability`);
  const local = objectAt(ocr, "local", `${base}.local`);
  const api = objectAt(ocr, "api", `${base}.api`);
  const pc = objectAt(ocr, "pcCompanion", `${base}.pcCompanion`);
  const secrets = secretsSetOf(value);
  const sp = `${base}.schedule`;
  const rp = `${base}.reliability`;
  const lp = `${base}.local`;
  const ap = `${base}.api`;
  const pp = `${base}.pcCompanion`;

  const allowedRaw = pc.allowedStatuses;
  if (!Array.isArray(allowedRaw) || allowedRaw.some((s) => !(AUTO_STATUSES as readonly unknown[]).includes(s))) {
    throw new Error(`${pp}.allowedStatuses 값이 ${AUTO_STATUSES.join("/")} 목록이 아님.`);
  }

  return {
    mode: oneOf(ocr, base, "mode", MODES),
    resourceProfile: oneOf(ocr, base, "resourceProfile", PROFILES),
    maxOutputTokensPerPage: int(ocr, base, "maxOutputTokensPerPage"),
    pageImage: { maxEdgePx: int(pageImage, `${base}.pageImage`, "maxEdgePx") },
    schedule: {
      intervalMin: int(schedule, sp, "intervalMin"),
      batchSize: int(schedule, sp, "batchSize"),
      leaseSeconds: int(schedule, sp, "leaseSeconds"),
      timeoutMs: int(schedule, sp, "timeoutMs"),
      maxPagesPerCycle: int(schedule, sp, "maxPagesPerCycle"),
      maxPagesPerDay: int(schedule, sp, "maxPagesPerDay"),
    },
    reliability: {
      maxAttemptsPerPage: int(reliability, rp, "maxAttemptsPerPage"),
      retryDelayMinutes: int(reliability, rp, "retryDelayMinutes"),
      circuitBreakerThreshold: int(reliability, rp, "circuitBreakerThreshold"),
    },
    local: {
      provider: oneOf(local, lp, "provider", LOCAL_PROVIDERS),
      ollamaUrl: str(local, lp, "ollamaUrl"),
      ollamaModel: str(local, lp, "ollamaModel"),
      lmstudioUrl: str(local, lp, "lmstudioUrl"),
      lmstudioModel: str(local, lp, "lmstudioModel"),
      commandJson: str(local, lp, "commandJson"),
      ollamaInputTokenReserve: int(local, lp, "ollamaInputTokenReserve"),
    },
    api: {
      provider: oneOf(api, ap, "provider", DOCUMENT_OCR_API_PROVIDERS),
      anthropicApiKey: str(api, ap, "anthropicApiKey"),
      anthropicModel: str(api, ap, "anthropicModel"),
      gptApiKey: str(api, ap, "gptApiKey"),
      gptModel: str(api, ap, "gptModel"),
      geminiApiKey: str(api, ap, "geminiApiKey"),
      geminiModel: str(api, ap, "geminiModel"),
      openaiBaseUrl: str(api, ap, "openaiBaseUrl"),
      openaiModel: str(api, ap, "openaiModel"),
      openaiApiKey: str(api, ap, "openaiApiKey"),
      endpointUrl: str(api, ap, "endpointUrl"),
      model: str(api, ap, "model"),
      apiKey: str(api, ap, "apiKey"),
      responseFormat: oneOf(api, ap, "responseFormat", RESPONSE_FORMATS),
    },
    pcCompanion: {
      workerId: str(pc, pp, "workerId"),
      pollSeconds: int(pc, pp, "pollSeconds"),
      commandSource: oneOf(pc, pp, "commandSource", COMMAND_SOURCES),
      commandJson: str(pc, pp, "commandJson"),
      allowedStatuses: allowedRaw as DocumentOcrAutoStatus[],
    },
    savedKeyFields: LLM_API_KEY_FIELDS.filter((field) => secrets.has(`${ap}.${field}`)),
    httpFileKeySaved: secrets.has(`${ap}.apiKey`),
  };
}
