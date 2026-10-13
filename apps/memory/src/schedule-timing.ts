/**
 * 시계 정렬 스케줄러용 다음-경계 계산 (순수 함수, now 주입형).
 *
 * KST 자정(00:00)을 anchor 로 잡고, offsetMin 만큼 민 격자에서 주기 간격마다
 * 경계를 둔다. 경계열 = midnightKst + offsetMin*60_000 + k*intervalMin*60_000.
 * now 직후 가장 가까운 경계까지 남은 ms 를 회신한다.
 *
 * KST 가정은 trash-manager.ts 의 setHours 양식과 동일 — new Date(nowMs) 의
 * setHours(0,0,0,0) 가 시스템 TZ(A1 systemd Environment=TZ=Asia/Seoul)를 따라
 * 그 날 KST 자정을 잡는다. UTC+9 오프셋 상수를 직접 작성하지 않는다.
 *
 * @param nowMs       현재 시각 (밀리초, UTC epoch). 테스트는 mock clock 주입.
 * @param intervalMin 주기 (분, >= 1). 1 미만이면 throw.
 * @param offsetMin   사이클 시작 오프셋 (분, >= 0). extractor=0, vision=floor(intervalMin/2).
 * @returns 다음 경계까지 남은 밀리초 (항상 > 0).
 */
export function msUntilNextBoundary(
  nowMs: number,
  intervalMin: number,
  offsetMin: number,
): number {
  if (!Number.isFinite(intervalMin) || intervalMin < 1) {
    throw new Error(
      `msUntilNextBoundary: intervalMin must be >= 1 (got ${intervalMin}).`,
    );
  }
  if (!Number.isFinite(offsetMin) || offsetMin < 0) {
    throw new Error(
      `msUntilNextBoundary: offsetMin must be >= 0 (got ${offsetMin}).`,
    );
  }
  const intervalMs = intervalMin * 60_000;
  const offsetMs = offsetMin * 60_000;

  // KST 자정 anchor — 그 날 00:00 의 epoch ms. trash-manager 의 setHours 양식 정합.
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  const midnightMs = midnight.getTime();

  // anchor + offset 기준 경과 시간 안에서 경계 격자 탐색.
  const elapsed = nowMs - (midnightMs + offsetMs);
  let nextBoundaryMs: number;
  if (elapsed < 0) {
    // now 가 오늘 첫 경계(offset) 이전 — 첫 경계가 다음 경계.
    nextBoundaryMs = midnightMs + offsetMs;
  } else {
    const k = Math.floor(elapsed / intervalMs) + 1;
    nextBoundaryMs = midnightMs + offsetMs + k * intervalMs;
  }
  return nextBoundaryMs - nowMs;
}
