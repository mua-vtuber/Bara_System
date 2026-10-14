/**
 * llm/bun-fetch.ts — Bun fetch 의 자체 기본 시간 제한(300초)을 끄는 옵션 한 곳 (2026-10-14 backfill-retry-ledger spec 3장).
 *
 * Bun 1.3 의 fetch 는 호출마다 따로 300초 제한을 건다. 우리 호출은 설정값으로 자체 제한 타이머(AbortController·
 * AbortSignal.timeout)를 거는데, 설정값이 300초보다 길면(추출 llm.extractor.timeoutMs 900000 등) Bun 이 먼저 300초에
 * "TimeoutError: The operation timed out." 으로 끊어 설정값이 지켜지지 않았다(로컬 Bun 1.3.6 재현 — 15분 타이머를 걸어도
 * 300.04초에 끊김, timeout:false 를 주면 320초 지연 응답을 정상 수신). 그렇게 끊기면 내부 타이머가 아니어서
 * timedOut=false 의 "네트워크 실패"로 잘못 분류되기도 했다.
 *
 * Bun 전용 옵션 `timeout: false` 는 bun-types 의 fetch 옵션 형에 없다. 그래서 이유를 여기 한 번만 적고, 호출 세 곳
 * (ollama-client·provider-http·documents-ocr-api)과 Anthropic SDK 생성자 두 곳이 이 값을 쓴다.
 * 내부 제한 타이머가 있는 호출에만 쓴다 — 타이머 없는 호출에 붙이면 끝없이 기다릴 수 있다.
 */
import type { ClientOptions } from "@anthropic-ai/sdk";

export const BUN_FETCH_NO_DEFAULT_TIMEOUT: { readonly timeout: false } = Object.freeze({ timeout: false as const });

/**
 * Anthropic SDK 생성자의 fetchOptions. SDK 0.96 은 전역 fetch(Bun)를 그대로 부르고(getDefaultFetch), 생성자 fetchOptions 를
 * 매 요청의 fetch 옵션에 펼쳐 넣는다(buildRequest → fetchWithTimeout). 이 값을 넘기면 SDK 자체 timeout 옵션이 실제 제한이 된다.
 * SDK 의 MergedRequestInit 형에 Bun 전용 칸이 없어 형 단언을 이 한 곳에만 둔다.
 */
export const ANTHROPIC_SDK_FETCH_OPTIONS = BUN_FETCH_NO_DEFAULT_TIMEOUT as NonNullable<ClientOptions["fetchOptions"]>;
