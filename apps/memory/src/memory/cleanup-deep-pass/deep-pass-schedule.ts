/**
 * deep-pass-schedule.ts — 깊은 패스 다음 정기 실행까지 남은 시간 (순수 함수, now 주입형).
 *
 * 배경(2026-10-22 결함): 옛 스케줄러는 "서버를 켠 날 자정 + intervalDays" 격자로 첫 실행을
 * 잡았다(msUntilNextBoundary(now, intervalDays*1440, 0)). 그 격자의 기준점이 매번 "오늘 자정"
 * 이라, intervalDays 안에 서버가 한 번이라도 다시 켜지면 남은 날짜가 처음부터 다시 셌다.
 * A1 은 배포·업데이트로 일주일에 여러 번 재시작하므로 7일 주기 정리가 한 번도 돌지 않았다
 * (cleanup_runs 0건 실측).
 *
 * 이 모듈은 기준점을 서버 기동 시각이 아니라 실행 기록(cleanup_runs)의 "마지막 전체 실행"
 * 으로 옮긴다. 재시작해도 기록은 남으므로 일정이 밀리지 않는다.
 *
 * 규칙:
 *  - 마지막 전체 실행이 없으면 → 다음 자정.
 *  - 마지막 전체 실행 날짜 + intervalDays 일이 아직 안 왔으면 → 그 날 자정.
 *  - 기한이 오늘이거나 이미 지났으면(서버가 꺼져 있었음 등) → 다음 자정.
 *    배포 직후 곧바로 돌리지 않고 자정에 맞춘다(정기 실행은 항상 자정 격자).
 *  - intervalDays 가 소수(예: 1.5)면 올림한 날 수로 센다 — 정기 실행이 자정에만 돌기 때문에
 *    "하루 반 뒤"는 그 다음 자정이다.
 *
 * 날짜와 자정은 모두 실행 기록과 같은 설정 시간대(pastCutoffInZone)로 계산한다. 시스템 시간대
 * 자정(msUntilNextBoundary 의 setHours)을 섞으면 두 시간대가 다를 때 — bun test 는 기본 UTC 다 —
 * 날짜 비교와 자정이 서로 어긋난다. 하루는 24시간으로 본다(KST 등 서머타임 없는 시간대 기준).
 */

import { pastCutoffInZone, zoneDay } from "../../db/store-internal/helpers.ts";

const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" 두 날짜 사이 일수(to - from). 달력 날짜끼리의 차이라 시간대와 무관하다. */
function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS);
}

/** 설정 시간대 기준 다음 자정까지 남은 ms(항상 > 0). */
function msUntilNextZoneMidnight(nowMs: number): number {
  const clock = pastCutoffInZone(nowMs).slice(11); // "HH:MM:SS"
  const [h, m, s] = clock.split(":").map(Number) as [number, number, number];
  const sinceMidnight = (((h % 24) * 60 + m) * 60 + s) * 1000 + (((nowMs % 1000) + 1000) % 1000);
  return DAY_MS - sinceMidnight;
}

/**
 * @param nowMs                현재 시각(ms epoch).
 * @param intervalDays         정리 주기(일, >= 1).
 * @param lastFullRunStartedAt 마지막 전체 실행의 시작 시각("YYYY-MM-DD HH:MM:SS", 설정 시간대). 없으면 null.
 * @returns 다음 정기 실행까지 남은 ms(항상 > 0).
 */
export function msUntilNextDeepPass(
  nowMs: number,
  intervalDays: number,
  lastFullRunStartedAt: string | null,
): number {
  if (!Number.isFinite(intervalDays) || intervalDays < 1) {
    throw new Error(`msUntilNextDeepPass: intervalDays must be >= 1 (got ${intervalDays}).`);
  }
  const untilNextMidnight = msUntilNextZoneMidnight(nowMs);
  if (lastFullRunStartedAt === null) return untilNextMidnight;

  const today = zoneDay(pastCutoffInZone(nowMs));
  const daysUntilDue = Math.ceil(intervalDays) - daysBetween(zoneDay(lastFullRunStartedAt), today);
  if (daysUntilDue <= 0) return untilNextMidnight;
  return untilNextMidnight + (daysUntilDue - 1) * DAY_MS;
}
