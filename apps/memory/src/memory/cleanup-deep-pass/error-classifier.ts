/**
 * error-classifier.ts — LLM 오류 3분류 순수 함수 (spec 4.A-2).
 *
 * 데이터 정리 AI 효율 가동에서 도입. `LlmRequestError`(src/llm/errors.ts)가 status /
 * timedOut 을 필드로 보존하므로, 이 분류기는 그 두 필드만 보고 3분류를 낸다 —
 * 문자열 파싱 0(옛 v1 안의 메시지 문자열 분류는 부서지기 쉬워 폐기).
 *
 * 실행층(A-4)이 이 분류 결과로 재시도·중단·원장 상태 전이를 가른다:
 *   - transient    → 호출 재시도(소진 시 retryable_failure, 대상별 terminal 절대 없음).
 *   - deterministic → fingerprint 단위 attempt 누적(상한 도달 시 terminal_failure).
 *   - config       → 사이클 통째 즉시 중단(설정 결함 — 대상 죄가 아님).
 *
 * 분류기는 `LlmRequestError` 뿐 아니라 결정적 실패(JSON 파싱·ID 탈락·max_tokens 잘림)를
 * 표현하는 입력도 받을 수 있도록 status/timedOut 만 인자로 받는다 — 그 결정적 부류는
 * 대개 상태 코드가 없거나(파서가 만든 신호) config·transient 조건에 안 걸려 deterministic
 * 으로 떨어진다. 이 task 는 결정적 부류의 산출 자체를 만들지 않지만(실행층 소관) 분류
 * 함수는 그 계열을 커버한다.
 */

export type LlmErrorClass = "transient" | "deterministic" | "config";

export interface LlmErrorClassifyInput {
  /** HTTP 상태 코드. 네트워크 단절·timeout 처럼 응답이 없으면 null. */
  status: number | null;
  /** 요청 timeout 으로 끊긴 경우 true. */
  timedOut: boolean;
}

/** config(사이클 중단) 로 보는 상태 코드 집합 — 설정·인증 결함. */
const CONFIG_STATUS = new Set<number>([400, 401, 403]);

/**
 * status/timedOut 조합을 3분류로 판정한다(순수 함수 — 부수효과 0).
 *
 * 판정 우선순위:
 *   1. timeout → transient (상태값과 무관하게 일시로 본다).
 *   2. status===null(응답 없음, 네트워크 단절) → transient.
 *   3. 429 또는 5xx(500~599) → transient.
 *   4. 400/401/403 → config.
 *   5. 그 외(404·422·200 등) → deterministic.
 */
export function classifyLlmError(input: LlmErrorClassifyInput): LlmErrorClass {
  if (input.timedOut) return "transient";
  if (input.status === null) return "transient";
  if (input.status === 429) return "transient";
  if (input.status >= 500 && input.status <= 599) return "transient";
  if (CONFIG_STATUS.has(input.status)) return "config";
  return "deterministic";
}
