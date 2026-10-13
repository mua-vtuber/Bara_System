/**
 * first-poll-gate.ts — 부팅 직후 "첫 즉시 폴링"을 봇 토큰 설치 이후로 미루는 관문.
 *
 * ClientReady 진입 시점의 ref.getClient() 는 아직 Authorization 토큰이 붙지 않은
 * 초기 클라이언트다. 봇 토큰은 그 뒤 SSE 부트스트랩(startSseWithRetry →
 * issueAndInstallBotToken → ref.setClient) 안에서 설치된다. 그래서 폴러가
 * ClientReady 에서 곧바로 첫 폴링을 쏘면 보호 경로(/api/date-occurrences 등)에서
 * 401 로 실패해 부팅마다 에러 로그 한 줄이 남고, 첫 알림 창이 다음 주기(기본 5분)
 * 로 밀렸다.
 *
 * 각 폴러는 첫 1회 폴링을 defer() 로 등록하고, issueAndInstallBotToken 이
 * ref.setClient 직후 release() 를 불러 등록 순서대로 실행한다. 주기 setInterval
 * 폴링은 이 관문과 무관하게 기존대로 즉시 시작한다(동작 불변).
 *
 * release 이전에 client 가 destroy 되면(reload-bus 재진입 등) 등록분은 실행 없이
 * client 와 함께 버려진다 — 인증 안 된 폴링을 쏘는 것보다 안전한 쪽이다.
 */

export interface FirstPollGate {
  /**
   * 첫 폴링을 등록한다. release 전이면 대기열에 쌓고, 이미 release 됐으면
   * 즉시 실행한다(등록이 조용히 사라지는 일 없음).
   */
  defer(run: () => void): void;
  /**
   * 인증된 클라이언트 설치 완료 신호 — 대기 중인 첫 폴링을 등록 순서대로 실행한다.
   * 두 번 이상 불려도 각 등록분은 한 번만 실행된다.
   */
  release(): void;
}

export function createFirstPollGate(): FirstPollGate {
  let released = false;
  const queue: Array<() => void> = [];
  return {
    defer(run: () => void): void {
      if (released) {
        run();
        return;
      }
      queue.push(run);
    },
    release(): void {
      if (released) return;
      released = true;
      for (const run of queue.splice(0)) {
        run();
      }
    },
  };
}
