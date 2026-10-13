/**
 * server-internal/graceful-exit.ts — 정상 종료 절차 실행기
 *
 * SIGINT·SIGTERM(종료 코드 0)과 대시보드 재시작 요청(RESTART_EXIT_CODE)이 같은 종료 절차를 쓴다.
 * 종료 절차(stop)는 호출부가 넘기고, 프로세스 종료(exit)도 주입받아 테스트가 실제로 끝나지 않고
 * 종료 코드만 확인할 수 있다. 두 번째 호출은 무시한다(종료 절차는 한 번만).
 */

export interface GracefulExitDeps {
  /** 스케줄러·크론·서버·DB 를 멈추는 절차. */
  stop: () => Promise<void>;
  /** 프로세스 종료. 운영은 process.exit. */
  exit: (code: number) => void;
  log: (message: string) => void;
  error: (message: string, cause: unknown) => void;
}

/** 종료 코드 failure 는 종료 절차 자체가 실패했을 때 쓴다 — 실패를 삼키지 않고 원인을 남긴 채 0 이 아닌 코드로 끝난다. */
export const SHUTDOWN_FAILED_EXIT_CODE = 1;

export function createGracefulExit(deps: GracefulExitDeps): (reason: string, exitCode: number) => Promise<void> {
  let stopping = false;
  return async (reason, exitCode) => {
    if (stopping) return;
    stopping = true;
    deps.log(`[memory-api] received ${reason}, shutting down...`);
    try {
      await deps.stop();
    } catch (cause) {
      deps.error(`[memory-api] 종료 절차 실패 (${reason}) — 종료 코드 ${SHUTDOWN_FAILED_EXIT_CODE} 로 끝낸다`, cause);
      deps.exit(SHUTDOWN_FAILED_EXIT_CODE);
      return;
    }
    deps.exit(exitCode);
  };
}
