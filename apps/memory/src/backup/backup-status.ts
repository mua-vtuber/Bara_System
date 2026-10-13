/**
 * 백업 마지막 결과 — 프로세스 메모리 싱글턴. (spec D1-e)
 *
 * 디스크가 죽어 백업이 실패해도 상태 라우트는 이 메모리 값으로 회신할 수 있어야
 * 하므로, 일부러 파일이 아니라 모듈 변수에 둔다. 프로세스 재시작 시 null 로
 * 초기화되는 것은 "이번 가동 중 백업 이력 없음"이라는 사실 그대로다.
 * 갱신 주체: backup cron(T3)이 회차 성공/실패와 다음 실행 시각을 기록한다.
 */
export interface BackupStatusSnapshot {
  lastResult: { ok: boolean; at: string; roundDir?: string; error?: string } | null;
  /** ISO — cron 이 갱신. null = 예약 없음. */
  nextRunAt: string | null;
}

let lastResult: BackupStatusSnapshot["lastResult"] = null;
let nextRunAt: string | null = null;

export function getBackupStatus(): BackupStatusSnapshot {
  // 호출자가 스냅샷을 변형해도 싱글턴 원본이 오염되지 않게 복사본을 준다.
  return {
    lastResult: lastResult === null ? null : { ...lastResult },
    nextRunAt,
  };
}

export function recordBackupSuccess(at: string, roundDir: string): void {
  lastResult = { ok: true, at, roundDir };
}

export function recordBackupFailure(at: string, error: string): void {
  lastResult = { ok: false, at, error };
}

export function recordNextRunAt(iso: string | null): void {
  nextRunAt = iso;
}

/**
 * 테스트 격리 전용 — 싱글턴 상태를 초기 가동 상태(이력 없음)로 되돌린다.
 * 프로덕션 코드는 이 함수를 호출하지 않는다. 여러 테스트 파일이 같은 프로세스에서
 * 이 모듈을 공유하므로, 한 테스트가 남긴 상태가 다른 테스트로 새지 않게 하는 seam.
 */
export function resetBackupStatus(): void {
  lastResult = null;
  nextRunAt = null;
}
