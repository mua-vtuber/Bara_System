/**
 * stage-execution.ts — 실행층 경유 단계의 공통 계약 (spec 4.A-4 표준 실행 파이프라인).
 *
 * 각 단계 infer 함수는 이제 CleanupLlmExecutor 를 받아 프롬프트 조립 + executor.run() 호출
 * + 응답 파싱까지 하고, 그 결과를 StageInferResult 로 회신한다. 파싱 성공분(parsed)과
 * 실행층 비-ok 신호(transient/deterministic/config/budget)를 한 판별 유니온으로 실어,
 * 단계 글루가 이 신호로 결과 원장 상태 전이를 가른다:
 *   - ok           → 파싱 성공. 글루가 산출 유무로 completed / completed_noop 결정.
 *   - transient    → 일시 오류 재시도 소진. 글루가 recordStageRetryable(next_retry_at).
 *   - deterministic→ 파싱·검증·max_tokens 결정적 실패. 글루가 recordStageDeterministicFailure.
 *   - config       → 설정 결함(400/401/403). 글루가 사이클 통째 중단(던져 올림).
 *   - budget       → 예산 도달로 호출 안 함. 글루가 원장에 안 남긴다(다음 사이클 재등장).
 *
 * 파싱 실패(JSON 배열 못 찾음 등)는 executor 밖 결정적 실패라, infer 함수가 executor ok
 * 회신을 받은 뒤 파싱하다 실패하면 스스로 deterministic 결과로 바꿔 회신한다(글루가 같은
 * 경로로 attempt 누적). silent fallback 금지 — 어떤 경우도 값을 지어내지 않는다.
 */

import type { RunOutcome } from "./cleanup-llm-executor.ts";

/**
 * 한 단계 대상(또는 묶음)에 대한 infer 회신. parsed 는 단계별 산출 타입 T.
 *   - ok:          파싱 성공(빈 배열도 ok — 글루가 산출 0 이면 completed_noop).
 *   - transient:   재시도 소진(retryAfterMs 로 next_retry 계산).
 *   - deterministic: 파싱·검증·max_tokens 결정적 실패(사유 문자열).
 *   - config:      설정 결함(사이클 중단 신호).
 *   - budget:      예산 도달(원장 미기록).
 */
export type StageInferResult<T> =
  | { kind: "ok"; parsed: T }
  | { kind: "transient"; retryAfterMs: number | null; reason: string }
  | { kind: "deterministic"; reason: string }
  | { kind: "config"; reason: string }
  | { kind: "budget"; dimension: string; detail: string };

/**
 * executor.run() 의 RunOutcome 중 비-ok 를 StageInferResult 의 대응 항으로 옮긴다(ok 는
 * 호출부가 파싱을 이어가야 하므로 여기서 다루지 않는다). 파싱 실패를 deterministic 으로
 * 승격하는 것은 각 infer 함수가 직접 한다 — 이 함수는 실행층 신호만 옮긴다.
 */
export function runOutcomeToNonOk<T>(
  outcome: Exclude<RunOutcome, { kind: "ok" }>,
): Exclude<StageInferResult<T>, { kind: "ok" }> {
  switch (outcome.kind) {
    case "transient":
      return {
        kind: "transient",
        retryAfterMs: outcome.retryAfterMs,
        reason: `일시 오류(transient) status=${outcome.error.status ?? "-"}: ${outcome.error.message}`,
      };
    case "deterministic":
      return { kind: "deterministic", reason: outcome.reason };
    case "config":
      return {
        kind: "config",
        reason: `설정 결함(config) status=${outcome.error.status ?? "-"} code=${outcome.error.code ?? "-"}: ${outcome.error.message}`,
      };
    case "budget":
      return { kind: "budget", dimension: outcome.dimension, detail: outcome.detail };
  }
}

/**
 * config 결과를 만나면 사이클 통째 중단해야 한다(spec 4.A-2). 글루가 이 오류를 던져
 * 상위(스케줄러 runCycle)가 그 사이클을 끊게 한다. 대상별 원장 기록은 남기지 않는다 —
 * 설정 결함은 대상의 죄가 아니고, 항목 실패로 위장하면 원인이 소음에 묻힌다.
 */
export class CleanupConfigError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CleanupConfigError";
  }
}
