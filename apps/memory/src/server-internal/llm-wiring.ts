/**
 * server-internal/llm-wiring.ts — LLM 클라이언트 초기화 헬퍼
 *
 * buildLlmClient: provider 문자열 + extractor·cleanup 두 슬롯(LlmClientSlot)으로 LlmClient 구성.
 * buildLlmClientWithReason: 같은 일을 하되 실패 사유 문장을 함께 돌려준다(정리 게이트 사유에 붙임).
 * autoDetectProvider: 의미 추출 슬롯 기반 가동 provider 자동 감지.
 *
 * 서버 자체는 LLM 없이도 가동되어야 하므로 buildLlmClient 는 실패 시
 * null 반환 (throw 안 함). 실패 사유는 로그에 남기고, 키 값은 넣지 않는다(칸 이름만).
 */

import type { LlmClient } from "../llm/types.ts";
import { OllamaClient } from "../llm/ollama-client.ts";
import { AnthropicClient } from "../llm/anthropic-client.ts";
import { OpenAiCompatibleClient } from "../llm/openai-compatible-client.ts";
import { OpenAiClient } from "../llm/openai-client.ts";
import { GeminiClient } from "../llm/gemini-client.ts";
import type { MemorySettings } from "../settings/memory-settings.ts";
import {
  LLM_PROVIDER_SPECS,
  type LlmProvider,
  type LlmProviderFieldValues,
} from "../llm/provider-registry.ts";

/**
 * buildLlmClient 가 받는 LLM 슬롯의 공통 최소 부분집합 — 공급자 표가 가리키는 모델·키·주소 칸 전부.
 *
 * 의미 추출 슬롯(`settings.llm.extractor`)과 cleanup 슬롯(`settings.llm.cleanup`)을
 * 둘 다 받을 수 있게 두 슬롯이 공유하는 칸만 모은 구조다. `timeoutMs?` 는 optional —
 * extractor 슬롯은 `timeoutMs`, cleanup 슬롯은 `requestTimeoutMs`(데이터 정리 AI
 * 효율 가동 spec 4.A-8) 필드명이 달라 caller(index.ts/server.ts)가 호출 시 이
 * 공통 칸으로 매핑해 넘긴다. ollama·openai_compatible 은 없으면 자기 default, anthropic 은
 * SDK default. openai·google 은 호출 한도가 꼭 있어야 한다(없으면 사유를 대며 구성 실패).
 */
export interface LlmClientSlot extends LlmProviderFieldValues {
  /** 공급자 균일 호출 한도(ms). */
  timeoutMs?: number;
}

/** 클라이언트 구성 옵션 — 슬롯 설정에 없는, 호출하는 쪽이 정하는 값. */
export interface LlmClientBuildOptions {
  /** Anthropic SDK 자동 재시도 횟수. 없으면 SDK 기본값(2). */
  anthropicMaxRetries?: number;
}

/**
 * 추출 클라이언트의 Anthropic SDK 자동 재시도 횟수 (2026-10-14 backfill-retry-ledger 사용자 결정).
 * Bun 300초 제한을 끈 뒤(llm/bun-fetch.ts) SDK 기본 재시도 2번이 남으면 추출 한 번이 최악 timeoutMs × 3 까지 간다.
 * 추출 백필은 실패 기록 표(backfill_attempts)로 자체 재시도하므로 SDK 재시도는 끈다. 정리 경로는 이 값을 쓰지 않는다.
 */
export const EXTRACTOR_ANTHROPIC_MAX_RETRIES = 0 as const;

/** 클라이언트 구성 결과 — 실패하면 client=null + 사유 문장(키 값 없음). */
export interface LlmClientBuildResult {
  client: LlmClient | null;
  reason: string | null;
}

/**
 * 공급자 표로 빈칸을 먼저 검사한다 — 키가 필요한 공급자의 키 칸, 모든 공급자의 모델 칸.
 * 사유는 "<공급자>: <슬롯경로>.<칸> 이 비어 있음" 형식이며 값은 넣지 않는다.
 */
function missingFieldReason(provider: LlmProvider, slot: LlmClientSlot, slotPath: string): string | null {
  const spec = LLM_PROVIDER_SPECS[provider];
  if (spec.apiKeyRequired && spec.apiKeyField !== null && slot[spec.apiKeyField].trim().length === 0) {
    return `${provider}: ${slotPath}.${spec.apiKeyField} 이 비어 있음`;
  }
  if (slot[spec.modelField].trim().length === 0) {
    return `${provider}: ${slotPath}.${spec.modelField} 이 비어 있음`;
  }
  return null;
}

function requireTimeout(provider: LlmProvider, slot: LlmClientSlot, slotPath: string): number {
  if (slot.timeoutMs === undefined) {
    throw new Error(`${provider}: ${slotPath} 호출 한도(timeoutMs)가 넘어오지 않음`);
  }
  return slot.timeoutMs;
}

function constructClient(
  provider: LlmProvider,
  slot: LlmClientSlot,
  slotPath: string,
  options: LlmClientBuildOptions,
): LlmClient {
  switch (provider) {
    case "ollama":
      // extractor-a1-2.4b-transition T5 (IN-6) — settings 의 추출 타임아웃을 그대로 전달.
      return new OllamaClient({ baseUrl: slot.ollamaUrl, model: slot.ollamaModel, timeoutMs: slot.timeoutMs });
    case "anthropic":
      // 데이터 정리 AI 효율 가동 spec 4.A-8 — slot.timeoutMs 를 SDK 요청 timeout 옵션으로 전달.
      // 2026-10-14 backfill-retry-ledger — 재시도 횟수는 호출하는 쪽이 정한다(추출 0, 정리는 SDK 기본).
      return new AnthropicClient({
        apiKey: slot.anthropicApiKey,
        model: slot.anthropicModel,
        timeoutMs: slot.timeoutMs,
        ...(options.anthropicMaxRetries !== undefined ? { maxRetries: options.anthropicMaxRetries } : {}),
      });
    case "openai_compatible":
      return new OpenAiCompatibleClient({
        baseUrl: slot.openaiBaseUrl,
        model: slot.openaiModel,
        apiKey: slot.openaiApiKey,
        timeoutMs: slot.timeoutMs,
      });
    case "openai":
      return new OpenAiClient({
        apiKey: slot.gptApiKey,
        model: slot.gptModel,
        timeoutMs: requireTimeout(provider, slot, slotPath),
      });
    case "google":
      return new GeminiClient({
        apiKey: slot.geminiApiKey,
        model: slot.geminiModel,
        timeoutMs: requireTimeout(provider, slot, slotPath),
      });
    default: {
      const unknown: never = provider;
      throw new Error(`buildLlmClient: 알 수 없는 provider (${String(unknown)})`);
    }
  }
}

/**
 * Provider 문자열 + LLM 슬롯으로 LlmClient 를 구성하고, 실패하면 사유를 함께 돌려준다.
 * 실패해도 던지지 않는다(서버는 LLM 없이도 가동). 사유는 에러 로그에도 남긴다.
 *
 * @param slotPath 사유 문장에 쓸 설정 경로 — "llm.extractor" / "llm.cleanup".
 */
export function buildLlmClientWithReason(
  provider: LlmProvider | "none",
  slot: LlmClientSlot,
  slotPath: string,
  options: LlmClientBuildOptions = {},
): LlmClientBuildResult {
  if (provider === "none") return { client: null, reason: null };
  const missing = missingFieldReason(provider, slot, slotPath);
  let reason = missing;
  if (reason === null) {
    try {
      return { client: constructClient(provider, slot, slotPath, options), reason: null };
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
  }
  console.error(`[memory-api] LLM provider ${provider} init failed:`, reason);
  return { client: null, reason };
}

/**
 * Provider 문자열 + LLM 슬롯으로 LlmClient 를 구성 (Phase 5.6 W5 정합).
 * 실패 시 null (에러 로그만). 서버 자체는 LLM 없이도 가동되어야 하므로 throw 안 함.
 */
export function buildLlmClient(
  provider: LlmProvider | "none",
  slot: LlmClientSlot,
  slotPath: string,
  options: LlmClientBuildOptions = {},
): LlmClient | null {
  return buildLlmClientWithReason(provider, slot, slotPath, options).client;
}

/**
 * 의미 추출 슬롯 (`settings.llm.extractor`) 으로 가동 provider 자동 감지.
 * Phase 5.6 W5 — `enabled=false` 면 "none" (LLM 미가동). enabled=true 면 slot.provider 값 그대로.
 */
export function autoDetectProvider(
  slot: MemorySettings["llm"]["extractor"],
): LlmProvider | "none" {
  if (!slot.enabled) return "none";
  return slot.provider;
}
