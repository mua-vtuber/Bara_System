/**
 * cleanup-llm-executor.test.ts — 단일 실행층 검증 (spec 4.A-4).
 *
 * ObservableLlmClient 는 chatDetailed 한 메서드만 가진 데이터 fixture 함수로 주입한다
 * (인터페이스 가짜 구현체가 아니라 함수 인자 — mock 객체 금지 규칙 정합). sleep·jitter 는
 * 주입해 실제 대기 0 으로 backoff 흐름을 검증한다(spec 테스트 방침 — 실 대기 0).
 *
 * 검증 축(spec 4.A-4 책임):
 *   - 재시도: 429 두 번 throw 후 성공 → ok + totalCalls 3.
 *   - 재시도 소진: 계속 429 → transient + retryAfterMs 보존.
 *   - retryAfterMs 우선 + 상한: 60초 초과 retryAfterMs → 즉시 포기(transient).
 *   - config(400/401/403): 재시도 없이 즉시 config.
 *   - deterministic(응답 파싱 오류): 즉시 deterministic(재시도 0).
 *   - max_tokens 잘림: 2배 재호출 → 성공. 2배로도 잘림 → deterministic.
 *   - usage 누적(캐시 포함) + missingUsageCalls 집계.
 *   - circuit breaker: 연속 일시 실패 임계 도달 → isBreakerTripped, 성공이 리셋.
 *   - AbortSignal: aborted 면 호출 안 하고 AbortError throw.
 *   - 예산 훅 block → budget outcome(호출 0).
 */

import { expect, test } from "bun:test";
import type {
  ChatMessage,
  LlmChatOptions,
  LlmChatResult,
  ObservableLlmClient,
} from "../../llm/types.ts";
import { LlmRequestError } from "../../llm/errors.ts";
import {
  CircuitBreaker,
  CleanupLlmExecutor,
  createUsageAccumulator,
  type BudgetHook,
  type RunRequest,
} from "./cleanup-llm-executor.ts";

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "u" },
];

/** 기본 run 요청(단계 상수 자리 — 정상 768 / cap 3072 / temp 0.1). */
function req(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    messages: MESSAGES,
    maxOutputTokens: 768,
    maxOutputTokensCap: 3072,
    temperature: 0.1,
    ...overrides,
  };
}

/** chatDetailed 결과 하나(usage 기본값). */
function result(overrides: Partial<LlmChatResult> = {}): LlmChatResult {
  return {
    text: "ok-text",
    stopReason: "stop",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    },
    ...overrides,
  };
}

/** 순차 응답/throw 스크립트를 소비하는 chatDetailed 함수 fixture. */
function scriptedClient(
  script: Array<LlmChatResult | (() => never)>,
): { client: ObservableLlmClient; calls: LlmChatOptions[] } {
  const calls: LlmChatOptions[] = [];
  let i = 0;
  const client: ObservableLlmClient = {
    name: "fixture",
    chat: async () => "unused",
    chatDetailed: async (_m: readonly ChatMessage[], options: LlmChatOptions = {}) => {
      calls.push(options);
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      if (typeof step === "function") step();
      return step as LlmChatResult;
    },
  };
  return { client, calls };
}

/** 429 LlmRequestError(retryAfterMs 옵션). */
function rateLimit(retryAfterMs: number | null = null): LlmRequestError {
  return new LlmRequestError({
    provider: "ollama",
    message: "429 rate limited",
    status: 429,
    code: "rate_limit",
    retryAfterMs,
    timedOut: false,
  });
}

/** 즉시 resolve sleep(실 대기 0) + jitter 0. */
const noWait = { sleep: async () => {}, jitter: () => 0 };

function makeExecutor(
  client: ObservableLlmClient,
  overrides: Partial<ConstructorParameters<typeof CleanupLlmExecutor>[0]> = {},
) {
  const usage = createUsageAccumulator();
  const breaker = new CircuitBreaker(5);
  const executor = new CleanupLlmExecutor({
    client,
    usage,
    breaker,
    ...noWait,
    ...overrides,
  });
  return { executor, usage, breaker };
}

test("일시 오류 재시도 — 429 두 번 후 성공 → ok + totalCalls 3", async () => {
  const { client } = scriptedClient([
    () => {
      throw rateLimit();
    },
    () => {
      throw rateLimit();
    },
    result({ text: "third" }),
  ]);
  const { executor, usage } = makeExecutor(client);
  const outcome = await executor.run(req());
  expect(outcome.kind).toBe("ok");
  if (outcome.kind === "ok") expect(outcome.text).toBe("third");
  // 첫 호출 + 재시도 2 = 3 호출.
  expect(usage.totalCalls).toBe(3);
  // 성공한 마지막 호출의 usage 만 누적(throw 는 usage 없음).
  expect(usage.inputTokens).toBe(10);
});

test("재시도 소진 — 계속 429 → transient + retryAfterMs 보존", async () => {
  const { client } = scriptedClient([
    () => {
      throw rateLimit(5000);
    },
  ]);
  const { executor } = makeExecutor(client, { retryMaxPerCall: 2 });
  const outcome = await executor.run(req());
  expect(outcome.kind).toBe("transient");
  if (outcome.kind === "transient") expect(outcome.retryAfterMs).toBe(5000);
});

test("retryAfterMs 상한 초과(60초+) → 즉시 포기(transient)", async () => {
  let slept = 0;
  const { client } = scriptedClient([
    () => {
      throw rateLimit(70_000);
    },
  ]);
  const { executor } = makeExecutor(client, {
    retryMaxPerCall: 5,
    sleep: async (ms) => {
      slept += ms;
    },
    jitter: () => 0,
  });
  const outcome = await executor.run(req());
  expect(outcome.kind).toBe("transient");
  // 상한 초과라 대기 자체를 안 한다.
  expect(slept).toBe(0);
});

test("config 오류(401) → 재시도 없이 즉시 config", async () => {
  let callCount = 0;
  const client: ObservableLlmClient = {
    name: "fixture",
    chat: async () => "u",
    chatDetailed: async () => {
      callCount += 1;
      throw new LlmRequestError({
        provider: "anthropic",
        message: "401 unauthorized",
        status: 401,
        code: "auth",
        retryAfterMs: null,
        timedOut: false,
      });
    },
  };
  const { executor } = makeExecutor(client, { retryMaxPerCall: 3 });
  const outcome = await executor.run(req());
  expect(outcome.kind).toBe("config");
  // config 는 재시도 0 — 한 번만 호출.
  expect(callCount).toBe(1);
});

test("deterministic — 비 LlmRequestError throw(응답 처리 실패) → 즉시 deterministic", async () => {
  let callCount = 0;
  const client: ObservableLlmClient = {
    name: "fixture",
    chat: async () => "u",
    chatDetailed: async () => {
      callCount += 1;
      throw new Error("본문 파싱 실패");
    },
  };
  const { executor } = makeExecutor(client, { retryMaxPerCall: 3 });
  const outcome = await executor.run(req());
  expect(outcome.kind).toBe("deterministic");
  expect(callCount).toBe(1);
});

test("max_tokens 잘림 → 2배 재호출 성공", async () => {
  const { client, calls } = scriptedClient([
    result({ stopReason: "max_tokens", text: "truncated" }),
    result({ stopReason: "stop", text: "full" }),
  ]);
  const { executor } = makeExecutor(client);
  const outcome = await executor.run(req({ maxOutputTokens: 768, maxOutputTokensCap: 3072 }));
  expect(outcome.kind).toBe("ok");
  if (outcome.kind === "ok") expect(outcome.text).toBe("full");
  // 재호출 출력 한도 = min(768*2, 3072) = 1536.
  expect(calls[1]?.maxOutputTokens).toBe(1536);
});

test("max_tokens 잘림 → 2배로도 잘림 → deterministic", async () => {
  const { client } = scriptedClient([
    result({ stopReason: "max_tokens" }),
    result({ stopReason: "max_tokens" }),
  ]);
  const { executor } = makeExecutor(client);
  const outcome = await executor.run(req());
  expect(outcome.kind).toBe("deterministic");
});

test("cap<=maxOutputTokens 면 잘림 재호출을 안 하고, 잘린 답을 ok 로 넘기지 않고 deterministic 으로 회신한다", async () => {
  const { client, calls } = scriptedClient([result({ stopReason: "max_tokens", text: "" })]);
  const { executor } = makeExecutor(client);
  // cap == maxOutputTokens → 올릴 여지가 없다(큰 묶음이 처음부터 cap 에 닿는 경우).
  const outcome = await executor.run(req({ maxOutputTokens: 6144, maxOutputTokensCap: 6144 }));
  expect(outcome).toEqual({ kind: "deterministic", reason: "max_tokens 잘림 — 출력 한도 6144 가 이미 cap" });
  expect(calls.length).toBe(1);
});

test("생각(thinking)이 한도를 다 써 빈 글로 잘린 첫 답 → 한도 2배로 다시 불러 성공, 두 호출 usage 모두 집계", async () => {
  const { client, calls } = scriptedClient([
    result({ stopReason: "max_tokens", text: "", usage: { inputTokens: 1752, outputTokens: 1536, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
    result({ text: "[]", usage: { inputTokens: 1752, outputTokens: 2274, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
  ]);
  const { executor, usage } = makeExecutor(client);
  const outcome = await executor.run(req({ maxOutputTokens: 1536, maxOutputTokensCap: 6144 }));
  expect(outcome).toEqual({ kind: "ok", text: "[]", stopReason: "stop" });
  expect(calls.map((c) => c.maxOutputTokens)).toEqual([1536, 3072]);
  expect(usage).toMatchObject({ totalCalls: 2, inputTokens: 3504, outputTokens: 3810 });
});

test("usage 누적 — 여러 호출 합산 + missingUsageCalls 집계", async () => {
  const { client } = scriptedClient([
    result({ usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 } }),
  ]);
  const { executor, usage } = makeExecutor(client);
  await executor.run(req());
  // usage null 인 결과를 내는 두 번째 executor 로 missing 집계 확인.
  const { client: client2 } = scriptedClient([result({ usage: null })]);
  const executor2 = new CleanupLlmExecutor({
    client: client2,
    usage,
    breaker: new CircuitBreaker(5),
    ...noWait,
  });
  await executor2.run(req());
  expect(usage.inputTokens).toBe(10);
  expect(usage.cacheReadTokens).toBe(2);
  expect(usage.cacheWriteTokens).toBe(1);
  expect(usage.missingUsageCalls).toBe(1);
  expect(usage.totalCalls).toBe(2);
});

test("circuit breaker — 연속 일시 실패 임계 도달 시 tripped, 성공이 리셋", async () => {
  // threshold 2. 매 호출 429(재시도 0) → 두 run 이면 연속 2건 → tripped.
  const failClient: ObservableLlmClient = {
    name: "fixture",
    chat: async () => "u",
    chatDetailed: async () => {
      throw rateLimit();
    },
  };
  const usage = createUsageAccumulator();
  const breaker = new CircuitBreaker(2);
  const executor = new CleanupLlmExecutor({
    client: failClient,
    usage,
    breaker,
    retryMaxPerCall: 0,
    ...noWait,
  });
  expect(executor.isBreakerTripped()).toBe(false);
  await executor.run(req());
  expect(executor.isBreakerTripped()).toBe(false);
  await executor.run(req());
  expect(executor.isBreakerTripped()).toBe(true);

  // 성공 한 번이 리셋한다.
  const okClient: ObservableLlmClient = {
    name: "fixture",
    chat: async () => "u",
    chatDetailed: async () => result(),
  };
  const executor2 = new CleanupLlmExecutor({
    client: okClient,
    usage,
    breaker,
    ...noWait,
  });
  await executor2.run(req());
  expect(breaker.isTripped()).toBe(false);
});

test("AbortSignal aborted → 호출 안 하고 AbortError throw", async () => {
  let callCount = 0;
  const client: ObservableLlmClient = {
    name: "fixture",
    chat: async () => "u",
    chatDetailed: async () => {
      callCount += 1;
      return result();
    },
  };
  const controller = new AbortController();
  controller.abort();
  const { executor } = makeExecutor(client, { cancelSignal: controller.signal });
  await expect(executor.run(req())).rejects.toThrow(/cancelled|abort/i);
  expect(callCount).toBe(0);
});

test("cancelSignal 을 chatDetailed options.signal 로 전달한다", async () => {
  const { client, calls } = scriptedClient([result()]);
  const controller = new AbortController();
  const { executor } = makeExecutor(client, { cancelSignal: controller.signal });
  await executor.run(req());
  expect(calls[0]?.signal).toBe(controller.signal);
});

test("예산 훅 block → budget outcome, 호출 0", async () => {
  let callCount = 0;
  const client: ObservableLlmClient = {
    name: "fixture",
    chat: async () => "u",
    chatDetailed: async () => {
      callCount += 1;
      return result();
    },
  };
  const budgetHook: BudgetHook = {
    check: () => ({ blocked: true, dimension: "maxCallsPerCycle", detail: "12/12" }),
    commit: () => {},
  };
  const { executor } = makeExecutor(client, { budgetHook });
  const outcome = await executor.run(req());
  expect(outcome.kind).toBe("budget");
  if (outcome.kind === "budget") expect(outcome.dimension).toBe("maxCallsPerCycle");
  expect(callCount).toBe(0);
});
