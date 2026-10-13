/**
 * server-internal/restart-policy.ts — 대시보드 "기억 서버 재시작" 버튼의 단일 출처 상수·판정
 *
 * 버튼이 누르면 서버는 정상 종료 절차를 마친 뒤 0 이 아닌 종료 코드로 끝난다. systemd 의
 * `Restart=on-failure` 가 그 종료를 보고 서버를 다시 띄운다. 그래서 이 동작은 "끝나면 누군가
 * 다시 켜 준다" 고 표시된 프로세스에서만 허용한다 — 표시는 환경변수 RESTART_ON_EXIT_ENV=1 이고,
 * 펫이 쓰는 서버 유닛(apps/pet/src/service/install/server-component.ts)이 넣는다. 표시가 없는
 * 서버(내 PC 로컬 실행 등)에서 종료하면 아무도 다시 켜지 않아 서버가 그냥 사라진다.
 */

/** 감독 프로세스(systemd)가 종료 뒤 다시 켠다고 알리는 환경변수 이름. 펫 쪽 SERVER_RESTART_ON_EXIT_ENV 와 같은 문자열(두 프로그램 사이의 약속). */
export const RESTART_ON_EXIT_ENV = "BARA_RESTART_ON_EXIT";

/** RESTART_ON_EXIT_ENV 가 "재시작 허용" 을 뜻하는 값. */
export const RESTART_ON_EXIT_VALUE = "1";

/** 재시작 요청 종료 코드. 0 이 아니라야 systemd `Restart=on-failure` 가 다시 켠다(EX_TEMPFAIL, sysexits.h). */
export const RESTART_EXIT_CODE = 75;

/** 202 응답이 클라이언트에 닿은 뒤 종료 절차를 시작하기까지 기다리는 시간(ms). 종료 절차의 server.stop(true) 가 열린 연결을 끊기 때문이다. */
export const RESTART_TRIGGER_DELAY_MS = 500;

/** 재시작을 지원하지 않을 때 사용자에게 보이는 이유. */
export const RESTART_UNSUPPORTED_REASON =
  `이 서버는 꺼진 뒤 다시 켜 주는 관리 프로그램(systemd)이 없는 상태로 실행 중이라 재시작할 수 없어요 (${RESTART_ON_EXIT_ENV}=${RESTART_ON_EXIT_VALUE} 표시가 없음).`;

/** 정리·추출·이미지 분석 같은 백그라운드 쓰기 작업이 도는 중에는 재시작하지 않는다 — 종료 절차가 그 사이클이 끝나길 기다리는 동안 옛 프로세스가 계속 응답해 재시작이 실패한 것처럼 보인다. */
export const RESTART_BUSY_REASON = "정리·추출 작업이 진행 중이에요. 끝난 뒤 다시 눌러 주세요.";

/** 대시보드 소유자가 아닌 호출자에게 주는 거절 문구. */
export const RESTART_FORBIDDEN_MESSAGE = "서버 재시작은 대시보드에서만 쓸 수 있어요.";

/** 이 프로세스가 시작될 때 한 번 정해지는 구분값. 재시작 전후 서버가 다른 프로세스인지 대시보드가 알아본다. */
export const PROCESS_BOOT_ID: string = crypto.randomUUID();

export interface RestartSupport {
  supported: boolean;
  reason: string | null;
}

/** env 에 재시작 허용 표시가 있는지 판정한다. */
export function resolveRestartSupport(env: Record<string, string | undefined>): RestartSupport {
  if (env[RESTART_ON_EXIT_ENV] === RESTART_ON_EXIT_VALUE) return { supported: true, reason: null };
  return { supported: false, reason: RESTART_UNSUPPORTED_REASON };
}
