/**
 * 봇 :3100 Host / Origin 검증 미들웨어 (D1·D3).
 *
 * 권위: docs/decisions/2026-07-02-adapter-auth-spec.md section 3.1
 *
 * 봇 HTTP 서버는 127.0.0.1 에 bind 하지만, bind 만으로는 DNS 리바인딩 공격을
 * 막지 못한다 — 브라우저가 공격자 도메인(evil.com)을 127.0.0.1 로 리졸브하게
 * 만들면 그 요청은 same-origin 으로 봇에 닿는다. Host 헤더 화이트리스트가
 * 이 2차 방어를 맡는다:
 *
 *   - Host 헤더가 허용목록(127.0.0.1:3100 / localhost:3100 / 포트 없는 형태 +
 *     BOT_ALLOWED_HOSTS env 확장)에 없으면 403.
 *   - Origin 헤더가 있는데 loopback origin 이 아니면 403(브라우저發 방어).
 *     서버-서버 호출(코어 디스커버리 fetch)은 Origin 을 안 붙이므로 통과한다.
 *
 * 코어 auth-gate.ts 의 createAuthGate 팩토리 패턴을 답습한다(의존성 주입 →
 * MiddlewareHandler 반환). hostOf / originOf 는 테스트가 스텁을 주입할 수 있게
 * 열어 둔다 — 기본은 c.req.header.
 *
 * Host 검증은 코어 :3001 auth-gate 엔 없다(감사 확인). 이 미들웨어는 봇을 코어보다
 * 강하게 만드는 데 한정하며, 코어 Host 검증은 별도 결함 항목이다(spec Excluded).
 */

import type { Context, MiddlewareHandler } from "hono";
import { BOT_HTTP_HOST, BOT_HTTP_PORT } from "./http-server.ts";

/**
 * 기본 Host 허용목록. D7 포트 상수에서 파생한다(하드코딩 금지).
 * 포트 없는 형태(127.0.0.1 / localhost)도 넣는다 — 일부 클라이언트가 기본 포트
 * 생략 형태로 Host 를 보낼 수 있어서다.
 */
export function defaultAllowedHosts(): string[] {
  return [
    `${BOT_HTTP_HOST}:${BOT_HTTP_PORT}`,
    `localhost:${BOT_HTTP_PORT}`,
    BOT_HTTP_HOST,
    "localhost",
  ];
}

/**
 * BOT_ALLOWED_HOSTS 환경변수(콤마 구분)를 파싱한다. 리버스 프록시 뒤 배포 시
 * 프록시가 세팅한 Host(예: bot.example.com)를 추가 허용하는 통로다(spec § D1-1).
 *
 * 부트스트랩 env 예외 정신: 이 게이트는 settings 파일이 아직 없을 수도 있는
 * 시점(첫 부팅)에도 동작해야 하므로 settings 가 아니라 env 로 받는다 —
 * settings-store 의 BOT_SETTINGS_PATH 예외와 같은 근거.
 */
export function parseAllowedHostsEnv(raw: string | undefined): string[] {
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  return raw
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}

/**
 * Origin 헤더 값이 loopback origin 인지 판별한다(순수 함수).
 *
 * URL 로 파싱해 hostname 이 loopback(127.0.0.1 / localhost / ::1)인지 본다.
 * IPv6 는 WHATWG URL 규격상 hostname 이 대괄호를 유지한 `[::1]` 로 오므로 두
 * 형태를 모두 인정한다. 파싱 실패(빈 문자열·잘못된 origin)는 loopback 아님으로
 * 판정한다 — 게이트가 그 케이스를 403 으로 막게 하려는 의도.
 *
 * `null` origin 문자열(파일 스킴·샌드박스 iframe 등)은 loopback 이 아니므로 false.
 */
export function isLoopbackOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const host = parsed.hostname;
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]"
  );
}

/** createHostGuard 의존 주입 인터페이스. */
export interface HostGuardDeps {
  /**
   * 허용 Host 목록. 미지정 시 defaultAllowedHosts() + BOT_ALLOWED_HOSTS env.
   * 테스트는 명시 목록을 주입해 env 격리.
   */
  allowedHosts?: string[];
  /** 요청에서 Host 헤더를 읽는 함수. 기본 c.req.header("host"). 테스트 스텁용. */
  hostOf?: (c: Context) => string | undefined;
  /** 요청에서 Origin 헤더를 읽는 함수. 기본 c.req.header("origin"). 테스트 스텁용. */
  originOf?: (c: Context) => string | undefined;
}

/**
 * Host / Origin 검증 미들웨어를 만든다. app.use("*", ...) 에 가장 먼저 등록한다.
 *
 * 판정 순서:
 *   1) Host 헤더 부재 → 403. HTTP/1.1 은 Host 필수라 부재는 비정상 요청이다.
 *      코어 디스커버리(fetch)는 Host 를 자동으로 붙이므로 실사용 영향 없음.
 *   2) Host ∉ 허용목록 → 403. Host 값 자체는 응답 본문에 넣지 않는다(로그만).
 *   3) Origin 헤더가 있고 loopback origin 아님 → 403. Origin 부재는 통과
 *      (서버-서버 호출).
 */
export function createHostGuard(deps: HostGuardDeps = {}): MiddlewareHandler {
  const allowed = new Set(
    deps.allowedHosts ?? [
      ...defaultAllowedHosts(),
      ...parseAllowedHostsEnv(process.env.BOT_ALLOWED_HOSTS),
    ],
  );
  const hostOf = deps.hostOf ?? ((c: Context) => c.req.header("host"));
  const originOf = deps.originOf ?? ((c: Context) => c.req.header("origin"));

  return async (c, next) => {
    const host = hostOf(c);
    if (host === undefined || host.length === 0) {
      return c.json({ error: "허용되지 않은 Host 헤더입니다." }, 403);
    }
    if (!allowed.has(host)) {
      return c.json({ error: "허용되지 않은 Host 헤더입니다." }, 403);
    }

    const origin = originOf(c);
    if (origin !== undefined && origin.length > 0) {
      if (!isLoopbackOrigin(origin)) {
        return c.json({ error: "허용되지 않은 Origin 헤더입니다." }, 403);
      }
    }

    await next();
  };
}
