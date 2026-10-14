/**
 * cleanup-llm-executor.ts — 깊은 패스 4단계가 LLM 을 부르는 단일 실행층 (spec 4.A-4).
 *
 * 예산·timeout·재시도·usage 누적·AbortSignal·circuit breaker 를 단계마다 흩어 구현하면
 * 새 단계가 검사를 빼먹는 통로가 생긴다. 그래서 전부 이 한 층에 모으고, 4단계(regex_strengthen /
 * summary / relation_discovery / person_link, 이후 lens_draft)는 LLM 을 오직 이 층의 run()
 * 을 통해서만 부른다. 각 단계의 infer 함수는 이 executor 를 받아 프롬프트만 조립하고, 실제
 * chatDetailed 호출·재시도·잘림 재호출은 executor 가 맡는다.
 *
 * 이 task(T4)의 범위:
 *   - requestTimeoutMs + run 취소 AbortSignal 전달(모든 호출에 signal 주입 — cancel 전파 토대).
 *   - 일시 오류 backoff 재시도(retryMaxPerCall / retryBaseDelayMs 지수 + jitter, retryAfterMs 우선,
 *     상한 60초 초과 시 이번 호출 포기).
 *   - max_tokens 잘림 시 같은 사이클 1회 출력 한도 2배 재호출(cap = 단계 상수 maxOutputTokensCap).
 *   - usage(캐시 읽기/쓰기 포함) 누적 + usage 미제공 건수 집계.
 *   - provider+단계 연속 일시 실패 circuit breaker 카운터(임계 도달 시 단계 중단 신호).
 *   - 예산 검사 훅(budgetHook) / 입력 추정 검사 훅(inputCapHook) 은 *지점만* 연다 — 기본
 *     주입은 아무것도 막지 않는 통과 훅(A-5 예산 4차원 / A-6 입력 추정이 이 자리에 실체를 채운다).
 *
 * reliability 설정 키(maxAttemptsPerTarget / retryMaxPerCall / retryBaseDelayMs /
 * circuitBreakerThreshold)는 아직 설정 스키마에 없다(T5/A-5 가 등록). 그래서 여기서는
 * 생성자 인자로 spec 4.A 기본값을 받고, T5 가 설정에서 읽어 주입하도록 배선만 남긴다.
 *
 * 결과 원장 기록(recordStageSuccess / recordStageRetryable / recordStageDeterministicFailure /
 * recordStageTerminal)은 executor 가 직접 하지 않는다 — executor 는 한 호출의 성공/실패
 * 신호(RunOutcome)만 돌려주고, 원장 기록은 각 단계 글루가 대상(target_key)·지문과 함께
 * 한다(단계마다 대상 식별·지문 산출이 달라 executor 가 알 수 없다). silent fallback 금지 —
 * 실패는 RunOutcome 으로 명시 회신하고, executor 자신은 값을 지어내지 않는다.
 */

import type {
  ChatMessage,
  LlmChatOptions,
  LlmChatResult,
  ObservableLlmClient,
} from "../../llm/types.ts";
import { LlmRequestError } from "../../llm/errors.ts";
import { LLM_CALL_LABELS } from "../../llm/call-labels.ts";
import { classifyLlmError, type LlmErrorClass } from "./error-classifier.ts";

// ── 실행층 기본 상수(spec 4.A 표 — T5 설정 등록 전 잠정 단일 출처) ───────────────

/** 일시 오류 호출 재시도 상한(reliability.retryMaxPerCall). */
export const DEFAULT_RETRY_MAX_PER_CALL = 2;
/** backoff 기준 지연(reliability.retryBaseDelayMs) — 지수 + jitter 의 밑. */
export const DEFAULT_RETRY_BASE_DELAY_MS = 2000;
/** provider+단계 연속 일시 실패 임계(reliability.circuitBreakerThreshold). 도달 시 단계 중단. */
export const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;
/**
 * 재시도 지연 상한(ms). retryAfterMs 든 자체 backoff 든 이 값을 넘기면 이번 호출을
 * 포기한다 — 자정 격자를 넘기는 장기 대기 방지(spec 4.A-4: 상한 60초 초과 시 포기).
 */
export const RETRY_DELAY_CEILING_MS = 60_000;

// ── usage 누적 ──────────────────────────────────────────────────────────────

/** 사이클(또는 run) 단위 토큰 사용량 누적기. 캐시 읽기/쓰기 포함(spec 4.A-1 usage). */
export interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** provider 가 usage 를 안 준(null) 호출 수 — 0 위장 금지, 별도 집계. */
  missingUsageCalls: number;
  /** 재시도를 포함한 실제 chatDetailed 호출 총수. */
  totalCalls: number;
}

/** 빈 usage 누적기 하나를 만든다(사이클 시작 시). */
export function createUsageAccumulator(): UsageAccumulator {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    missingUsageCalls: 0,
    totalCalls: 0,
  };
}

/** 한 chatDetailed 결과의 usage 를 누적기에 더한다(null 이면 missingUsageCalls++). */
function accumulateUsage(acc: UsageAccumulator, result: LlmChatResult): void {
  acc.totalCalls += 1;
  if (result.usage === null) {
    acc.missingUsageCalls += 1;
    return;
  }
  acc.inputTokens += result.usage.inputTokens;
  acc.outputTokens += result.usage.outputTokens;
  acc.cacheReadTokens += result.usage.cacheReadTokens;
  acc.cacheWriteTokens += result.usage.cacheWriteTokens;
}

// ── 예산·입력 추정 훅(A-5/A-6 가 실체를 채우는 지점) ──────────────────────────

/**
 * 한 호출 직전 예산 잔량을 검사하는 훅(A-5 가 채운다). block 이면 이 호출을 안 하고
 * budget 상태로 회신한다. T4 기본 주입은 항상 통과(아무것도 안 막음) — 지점만 연다.
 */
export interface BudgetHook {
  /**
   * @param estimatedInputTokens 이 호출의 추정 입력 토큰(A-6 추정 훅 산출). T4 기본은 0.
   * @returns block 이면 예산 도달(호출 금지), 그 사유 차원(dimension)·수치를 함께.
   */
  check(estimatedInputTokens: number): BudgetDecision;
  /** 한 호출 성공 후 실제 사용량을 예산에 반영(출력 토큰 등 사후 확정 차원). */
  commit(result: LlmChatResult): void;
}

/** 예산 훅 판정 — 통과 또는 도달(도달 차원·수치 명시). */
export type BudgetDecision =
  | { blocked: false }
  | { blocked: true; dimension: string; detail: string };

/** 아무것도 막지 않는 기본 예산 훅(T4 — A-5 가 실체로 교체). */
export const PASSTHROUGH_BUDGET_HOOK: BudgetHook = {
  check(): BudgetDecision {
    return { blocked: false };
  },
  commit(): void {
    // no-op — A-5 가 출력 토큰 누적·차원 상한 반영을 채운다.
  },
};

/**
 * 호출 입력 추정 훅(A-6 가 채운다). T4 기본은 추정 0 을 회신한다 — 입력 상한 검사가
 * A-6 도입 전까지 아무 대상도 막지 않도록. A-6 이 문자 수 근사 추정 + 호출당 상한
 * 초과 판정(분할·terminal)을 이 자리에 채운다.
 */
export interface InputEstimateHook {
  /** 이 메시지 묶음의 추정 입력 토큰. T4 기본은 0. */
  estimate(messages: readonly ChatMessage[]): number;
}

/** 추정 0 을 내는 기본 입력 훅(T4 — A-6 가 실체로 교체). */
export const ZERO_INPUT_ESTIMATE_HOOK: InputEstimateHook = {
  estimate(): number {
    return 0;
  },
};

// ── run 회신 ─────────────────────────────────────────────────────────────────

/**
 * executor.run() 한 호출의 결과. 단계 글루가 이 신호로 원장 상태 전이를 가른다.
 *   - ok:        text 회신(성공). 파싱·검증은 글루가 이어서 한다.
 *   - transient: 일시 오류 재시도 소진(retryable_failure 대상). retryAfterMs 로 next_retry 계산.
 *   - deterministic: max_tokens 잘림 2배 재호출까지 실패 등 결정적 실패(attempt 누적 대상).
 *   - config:    설정 결함(400/401/403) — 사이클 통째 중단 신호(단계 글루가 던져 올림).
 *   - budget:    예산 도달로 호출 안 함(원장 미기록 — 다음 사이클 재등장). 차원·수치 동반.
 */
export type RunOutcome =
  | { kind: "ok"; text: string; stopReason: LlmChatResult["stopReason"] }
  | { kind: "transient"; error: LlmRequestError; retryAfterMs: number | null }
  | { kind: "deterministic"; reason: string }
  | { kind: "config"; error: LlmRequestError }
  | { kind: "budget"; dimension: string; detail: string };

/** 한 run 호출 인자 — 메시지 + 단계별 출력 한도(정상·잘림 재호출 cap). */
export interface RunRequest {
  messages: readonly ChatMessage[];
  /** 정상 호출 출력 한도(단계 상수 maxOutputTokens). */
  maxOutputTokens: number;
  /**
   * max_tokens 잘림 시 2배 재호출의 출력 상한(단계 상수 maxOutputTokensCap). B-3a 상수 맵
   * 등재 전까지 단계 글루가 상수로 넘긴다. maxOutputTokens 이하면 잘림 재호출을 안 한다.
   */
  maxOutputTokensCap: number;
  /** 이 호출의 온도(단계 상수). */
  temperature: number;
  /** JSON 모드 강제 여부(Ollama structured output 등). 기존 단계 호출과 동일 옵션. */
  jsonMode?: boolean;
}

// ── circuit breaker ──────────────────────────────────────────────────────────

/**
 * provider+단계 단위 연속 일시 실패 카운터. 임계 도달 시 tripped — 단계 글루가 남은
 * 후보를 호출 없이 retryable_failure 처리하고 단계를 중단한다(spec 8: 장애 중 후보 전부를
 * 훑으며 과금·대기하는 낭비 차단). 성공 한 번이 카운터를 리셋한다.
 */
export class CircuitBreaker {
  private consecutiveTransient = 0;

  constructor(private readonly threshold: number) {
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new Error(
        `CircuitBreaker threshold 는 1 이상 정수여야 함(받은 값: ${threshold})`,
      );
    }
  }

  /** 일시 실패 한 건 기록. 임계 도달 시 이후 isTripped()==true. */
  recordTransient(): void {
    this.consecutiveTransient += 1;
  }

  /** 성공(또는 결정적 실패) — 연속 일시 실패 카운터 리셋. */
  reset(): void {
    this.consecutiveTransient = 0;
  }

  /** 임계 도달 여부(연속 일시 실패 >= threshold). */
  isTripped(): boolean {
    return this.consecutiveTransient >= this.threshold;
  }

  /** 현재 연속 일시 실패 수(로그·집계용). */
  get count(): number {
    return this.consecutiveTransient;
  }
}

// ── executor ─────────────────────────────────────────────────────────────────

/** executor 생성 인자. reliability 값은 T5 설정 등록 전 spec 기본값을 생성자로 받는다. */
export interface CleanupLlmExecutorOptions {
  /** 관측 가능 LLM 클라이언트(cleanup 슬롯 — chatDetailed 필수). */
  client: ObservableLlmClient;
  /** run 취소 AbortSignal(run API cancel 전파). 없으면 timeout signal 만. */
  cancelSignal?: AbortSignal;
  /** usage 누적기(사이클 단위 — 여러 run 이 공유). */
  usage: UsageAccumulator;
  /** circuit breaker(provider+단계 단위). */
  breaker: CircuitBreaker;
  /** 일시 오류 호출 재시도 상한(default DEFAULT_RETRY_MAX_PER_CALL). */
  retryMaxPerCall?: number;
  /** backoff 기준 지연 ms(default DEFAULT_RETRY_BASE_DELAY_MS). */
  retryBaseDelayMs?: number;
  /**
   * 지연 실행 함수(테스트 주입 지점). 실제로는 setTimeout 래핑, 테스트는 즉시 resolve 하는
   * 함수를 주입해 실제 대기 없이 재시도 흐름을 검증한다(spec 테스트 방침 — 실 대기 0).
   */
  sleep?: (ms: number) => Promise<void>;
  /** jitter 비율(0~1) 산출 — 테스트가 결정적으로 주입(default Math.random). */
  jitter?: () => number;
  /** 예산 훅(A-5 실체 / 기본 통과). */
  budgetHook?: BudgetHook;
  /** 입력 추정 훅(A-6 실체 / 기본 0). */
  inputEstimateHook?: InputEstimateHook;
}

/** 실제 지연 — setTimeout 을 Promise 로. */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CleanupLlmExecutor {
  private readonly client: ObservableLlmClient;
  private readonly cancelSignal: AbortSignal | undefined;
  private readonly usage: UsageAccumulator;
  private readonly breaker: CircuitBreaker;
  private readonly retryMaxPerCall: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;
  private readonly budgetHook: BudgetHook;
  private readonly inputEstimateHook: InputEstimateHook;

  constructor(opts: CleanupLlmExecutorOptions) {
    this.client = opts.client;
    this.cancelSignal = opts.cancelSignal;
    this.usage = opts.usage;
    this.breaker = opts.breaker;
    this.retryMaxPerCall = opts.retryMaxPerCall ?? DEFAULT_RETRY_MAX_PER_CALL;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.sleep = opts.sleep ?? realSleep;
    this.jitter = opts.jitter ?? Math.random;
    this.budgetHook = opts.budgetHook ?? PASSTHROUGH_BUDGET_HOOK;
    this.inputEstimateHook = opts.inputEstimateHook ?? ZERO_INPUT_ESTIMATE_HOOK;
    if (this.retryMaxPerCall < 0 || !Number.isInteger(this.retryMaxPerCall)) {
      throw new Error(
        `retryMaxPerCall 은 0 이상 정수여야 함(받은 값: ${this.retryMaxPerCall})`,
      );
    }
  }

  /** circuit breaker 가 이미 열렸는지(단계 글루가 호출 전 확인). */
  isBreakerTripped(): boolean {
    return this.breaker.isTripped();
  }

  /**
   * 한 LLM 호출을 실행한다. 예산 검사 → 입력 추정 → chatDetailed(재시도·잘림 재호출) →
   * usage 누적 순. 성공/실패를 RunOutcome 으로 명시 회신한다(silent fallback 0).
   */
  async run(req: RunRequest): Promise<RunOutcome> {
    // ── 예산 훅 — 호출 전 결정적 차단(A-5 실체 / 기본 통과) ─────────────────
    const estimatedInput = this.inputEstimateHook.estimate(req.messages);
    const budget = this.budgetHook.check(estimatedInput);
    if (budget.blocked) {
      return { kind: "budget", dimension: budget.dimension, detail: budget.detail };
    }

    // ── 정상 출력 한도로 호출(일시 오류 재시도 포함) ──────────────────────────
    const first = await this.callWithRetry(req, req.maxOutputTokens);
    if (first.kind !== "ok") return first;

    // ── max_tokens 잘림 — 같은 사이클 1회 출력 2배 재호출(cap 상한) ───────────
    if (first.result.stopReason === "max_tokens" && req.maxOutputTokensCap <= req.maxOutputTokens) {
      // 올릴 여지가 없는 잘림 = 결정적 실패. 잘린(빈 글일 수도 있는) 답을 ok 로 넘기지 않는다 —
      // 묶음 크기로 한도를 계산하는 단계는 큰 묶음에서 처음부터 cap 에 닿을 수 있다.
      return {
        kind: "deterministic",
        reason: `max_tokens 잘림 — 출력 한도 ${req.maxOutputTokens} 가 이미 cap`,
      };
    }
    if (first.result.stopReason === "max_tokens") {
      const raised = Math.min(req.maxOutputTokens * 2, req.maxOutputTokensCap);
      const second = await this.callWithRetry(req, raised);
      if (second.kind !== "ok") return second;
      if (second.result.stopReason === "max_tokens") {
        // 2배로도 잘림 = 결정적 실패(같은 조건 재시도는 100% 재발 — 더 안 늘린다).
        return {
          kind: "deterministic",
          reason: `max_tokens 잘림 — 출력 한도 ${raised} 재호출에도 재발(cap=${req.maxOutputTokensCap})`,
        };
      }
      // 예산 사후 확정 — 이 대상 호출의 출력 토큰·호출 수를 예산에 반영(A-5 실체 / 기본 no-op).
      this.budgetHook.commit(second.result);
      return { kind: "ok", text: second.result.text, stopReason: second.result.stopReason };
    }

    // 예산 사후 확정 — 성공한 대상 호출을 예산에 반영(호출 수 1 + 출력 토큰).
    this.budgetHook.commit(first.result);
    return { kind: "ok", text: first.result.text, stopReason: first.result.stopReason };
  }

  /**
   * 한 출력 한도로 chatDetailed 를 부르되 일시 오류를 backoff 재시도한다. 성공 시 usage 를
   * 누적하고 결과를 담아 회신한다. config 오류는 즉시 회신(재시도 안 함), deterministic 은
   * 그대로 회신, transient 는 소진 시까지 재시도 후 회신.
   */
  private async callWithRetry(
    req: RunRequest,
    maxOutputTokens: number,
  ): Promise<
    | { kind: "ok"; result: LlmChatResult }
    | { kind: "transient"; error: LlmRequestError; retryAfterMs: number | null }
    | { kind: "deterministic"; reason: string }
    | { kind: "config"; error: LlmRequestError }
  > {
    let attempt = 0;
    // 첫 호출 + 재시도 최대 retryMaxPerCall 회.
    for (;;) {
      // 취소 우선 — run API cancel 이 오면 더 호출하지 않는다(deterministic 아님, 던져 올림).
      if (this.cancelSignal?.aborted) {
        // 취소는 실패가 아니다 — 상위(단계 글루/run)가 AbortError 로 흐름을 끊는다.
        throw new DOMException("cleanup run cancelled", "AbortError");
      }

      let result: LlmChatResult;
      try {
        const options: LlmChatOptions = {
          temperature: req.temperature,
          maxOutputTokens,
          callLabel: LLM_CALL_LABELS.cleanup,
          ...(req.jsonMode !== undefined ? { jsonMode: req.jsonMode } : {}),
          ...(this.cancelSignal !== undefined ? { signal: this.cancelSignal } : {}),
        };
        result = await this.client.chatDetailed(req.messages, options);
      } catch (err) {
        const classified = this.classifyThrown(err);
        if (classified.klass === "config") {
          this.breaker.reset();
          return { kind: "config", error: classified.error };
        }
        if (classified.klass === "deterministic") {
          this.breaker.reset();
          this.usage.totalCalls += 1;
          return { kind: "deterministic", reason: classified.reason };
        }
        // transient — 재시도 여부 판정.
        this.usage.totalCalls += 1;
        this.breaker.recordTransient();
        if (attempt >= this.retryMaxPerCall) {
          return {
            kind: "transient",
            error: classified.error,
            retryAfterMs: classified.error.retryAfterMs,
          };
        }
        const delay = this.backoffDelayMs(attempt, classified.error.retryAfterMs);
        if (delay > RETRY_DELAY_CEILING_MS) {
          // 지연이 상한 초과 — 이번 호출 포기(장기 대기 방지). retryable 로 회신.
          return {
            kind: "transient",
            error: classified.error,
            retryAfterMs: classified.error.retryAfterMs,
          };
        }
        await this.sleep(delay);
        attempt += 1;
        continue;
      }

      // 성공 — usage 누적 + breaker 리셋.
      accumulateUsage(this.usage, result);
      this.breaker.reset();
      return { kind: "ok", result };
    }
  }

  /**
   * 던져진 오류를 3분류한다. LlmRequestError 면 status/timedOut 으로 분류기를 태우고, 그
   * 외 오류(응답 파싱 실패 등 결정적 계열)는 deterministic 으로 본다 — LlmRequestError 가
   * 아니면 전송 계층 실패가 아니라 응답 처리 실패라, 같은 입력 재시도가 무의미하다.
   */
  private classifyThrown(
    err: unknown,
  ):
    | { klass: "transient"; error: LlmRequestError }
    | { klass: "config"; error: LlmRequestError }
    | { klass: "deterministic"; reason: string } {
    if (err instanceof LlmRequestError) {
      const klass: LlmErrorClass = classifyLlmError({
        status: err.status,
        timedOut: err.timedOut,
      });
      if (klass === "transient") return { klass: "transient", error: err };
      if (klass === "config") return { klass: "config", error: err };
      return {
        klass: "deterministic",
        reason: `LLM 요청 오류(deterministic) status=${err.status ?? "-"} code=${err.code ?? "-"}: ${err.message}`,
      };
    }
    // AbortError 는 취소 — run() 루프가 cancelSignal 로 이미 걸러야 하나 방어적으로 rethrow.
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    return {
      klass: "deterministic",
      reason: `LLM 응답 처리 실패(deterministic): ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  /**
   * backoff 지연(ms) 산출. retryAfterMs 가 있으면 그 값을 우선하고(서버가 지시한 대기),
   * 없으면 지수 backoff(base * 2^attempt) + jitter(0~base). 지수·jitter 는 여러 대상이
   * 동시에 재시도해 서버를 다시 때리는 것(thundering herd)을 흩는다.
   */
  private backoffDelayMs(attempt: number, retryAfterMs: number | null): number {
    if (retryAfterMs !== null && retryAfterMs > 0) return retryAfterMs;
    const exponential = this.retryBaseDelayMs * 2 ** attempt;
    const jitterMs = Math.floor(this.jitter() * this.retryBaseDelayMs);
    return exponential + jitterMs;
  }
}
