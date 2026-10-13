/**
 * stage-retry.ts — retryable_failure 의 next_retry_at 시각 산출 (spec 4.A-2/4.A-3).
 *
 * 일시 오류 재시도 소진 시 원장에 retryable_failure 를 남기면서 "이 시각 전엔 후보
 * 제외"인 next_retry_at 을 함께 적는다. 그 시각은 설정 시간대 문자열이어야 원장 대조
 * (isCandidateExcluded)의 lexicographic 비교가 맞아떨어진다(저장 시각과 같은 zone).
 *
 * 지연 결정: retryAfterMs(서버가 지시한 대기)가 있으면 그 값을, 없으면 기본 지연을 쓴다.
 * 여기 기본 지연은 "다음 후보 재등장까지의 최소 간격"으로, 실행층의 호출 내 backoff
 * (retryBaseDelayMs) 와는 다른 관심사다 — 이건 사이클 간 재등장 간격이다.
 */

import { pastCutoffInZone } from "../../db/store-internal/helpers.ts";

/**
 * next_retry_at 산출. now(ms)에 지연을 더한 시각을 설정 시간대 문자열로 낸다.
 * pastCutoffInZone 은 이름과 달리 임의 epoch ms 를 그 zone 문자열로 바꾸는 순수 변환이라
 * 미래 시각에도 그대로 쓴다(과거 전용이 아님).
 *
 * @param retryAfterMs 서버 지시 대기(있으면 우선). 없으면 defaultDelayMs.
 * @param defaultDelayMs 지시 없을 때 기본 재등장 지연.
 * @param now 기준 시각 ms(테스트 결정성 위해 주입 가능, 미지정 시 Date.now()).
 */
export function nextRetryAt(
  retryAfterMs: number | null,
  defaultDelayMs: number,
  now: number = Date.now(),
): string {
  const delay = retryAfterMs !== null && retryAfterMs > 0 ? retryAfterMs : defaultDelayMs;
  return pastCutoffInZone(now + delay);
}

/**
 * 재등장 기본 지연(ms) — 서버가 Retry-After 를 안 줄 때. 30분: 같은 사이클(분 단위)
 * 안에서는 안 돌아오되, 다음 정기 사이클(일 단위)에는 확실히 후보로 재등장하도록 하는
 * 보수적 하한. reliability 설정 승격은 T5 소관이라, 그전까지 이 상수가 단일 출처다.
 */
export const DEFAULT_RETRY_REAPPEAR_DELAY_MS = 30 * 60 * 1000;
