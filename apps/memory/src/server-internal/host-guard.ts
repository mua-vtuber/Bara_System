/**
 * 코어 :3001 Host / Origin 검증 미들웨어 (P1-A2, C1·C2·C3·C4).
 *
 * 권위: docs/decisions/2026-07-02-core-host-guard-spec.md
 *
 * 코어 HTTP 서버는 127.0.0.1 에 bind 하지만, bind 만으로는 DNS 리바인딩 공격을
 * 막지 못한다 — 브라우저가 공격자 도메인(evil.com)을 127.0.0.1 로 리졸브하게
 * 만들면 그 요청은 same-origin 으로 코어에 닿는다. Host 헤더 화이트리스트가
 * 이 2차 방어를 맡는다:
 *
 *   - Host 헤더가 허용목록(서버 bind 주소/포트 + MEMORY_ALLOWED_HOSTS) 또는
 *     숫자 포트를 가진 정확한 loopback literal(SSH local forward)에 없으면 403.
 *   - Origin 헤더가 있는데 loopback origin 이 아니면 403(브라우저發 방어).
 *     서버-서버 호출(봇 → 코어 discovery fetch)은 Origin 을 안 붙이므로 통과한다.
 *     MEMORY_ALLOWED_HOSTS 는 Host 만 확장한다. 원격 브라우저 대시보드 Origin 허용은
 *     별도 보안 설계가 필요한 후속 기능이며, 이 게이트는 현행 loopback-only 정책을 유지한다.
 *
 * 봇 apps/bot-discord/src/http-host-guard.ts 의 대칭 미들웨어다. **차이 하나** =
 * 허용목록을 주입 host/port 에서 파생한다 — 봇 포트는 컴파일 상수(BOT_HTTP_PORT)
 * 지만 코어 포트·host 는 런타임 settings 값(settings.db.port·host + MEMORY_PORT/
 * MEMORY_HOST override)이라, index.ts 가 계산한 hostname·port 를 주입받아 파생한다
 * (미들웨어 안에 포트·host 리터럴 0 — 코어 단일출처 계승, 하드코딩 금지).
 *
 * 코어 auth-gate.ts 의 createAuthGate 팩토리 패턴을 답습한다(의존성 주입 →
 * MiddlewareHandler 반환). hostOf / originOf 는 테스트가 스텁을 주입할 수 있게
 * 열어 둔다 — 기본은 c.req.header.
 *
 * 이 미들웨어는 index.ts 미들웨어 스택의 **가장 앞**(body-limit·auth-gate 앞)에
 * 등록한다 — 리바인딩 방어는 어떤 서버 로직보다 먼저 걸려야 한다.
 * auth-gate 는 안 건드린다(P1-B 가 건드리는 파일 — 물리적 충돌 0).
 */

import type { Context, MiddlewareHandler } from "hono";

/** defaultAllowedHosts 파생에 필요한 코어 런타임 bind 값. */
export interface AllowedHostsSource {
  /** 코어가 bind 한 host (index.ts hostname — settings.db.host + MEMORY_HOST override). */
  host: string;
  /** 코어가 bind 한 port (index.ts port — settings.db.port + MEMORY_PORT override). */
  port: number;
}

/**
 * 기본 Host 허용목록. 주입 host/port 에서 파생한다(하드코딩 금지).
 *
 * 봇 defaultAllowedHosts() 는 컴파일 상수(BOT_HTTP_PORT)에서 파생하지만, 코어
 * 포트·host 는 런타임 settings 값이라 주입받아 파생한다. 포트 없는 형태
 * (127.0.0.1 / localhost / <host>)도 넣는다 — 일부 클라이언트가 기본 포트 생략
 * 형태로 Host 를 보낼 수 있어서다. <host>:<port> / <host> 형태는 소유자가
 * MEMORY_HOST 로 127.0.0.1 이 아닌 값에 bind 한 커스텀 배포를 대응한다(중복은
 * createHostGuard 의 Set 이 흡수).
 */
export function defaultAllowedHosts(source: AllowedHostsSource): string[] {
  const { host, port } = source;
  return [
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `${host}:${port}`,
    "127.0.0.1",
    "localhost",
    host,
  ];
}

/**
 * MEMORY_ALLOWED_HOSTS 환경변수(콤마 구분)를 파싱한다. 리버스 프록시 뒤 배포 시
 * 프록시가 세팅한 Host(예: memory.example.com)를 추가 허용하는 통로다(spec § 약점 C1).
 * 브라우저 Origin 허용목록이 아니므로, 원격 대시보드 same-origin fetch 를 자동으로
 * 허용하지 않는다.
 *
 * 부트스트랩 env 예외 정신: 이 게이트는 settings 파일이 아직 없을 수도 있는
 * 시점(setup 전후 첫 부팅)에도 동작해야 하므로 settings 가 아니라 env 로 받는다 —
 * MEMORY_PORT/MEMORY_HOST 부트스트랩 env 관행과 같은 근거. 봇 parseAllowedHostsEnv
 * (BOT_ALLOWED_HOSTS)와 동일 로직.
 */
export function parseAllowedHostsEnv(raw: string | undefined): string[] {
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  return raw
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}

/** SSH local forwarding changes the browser-visible loopback port. The host
 * still has to be an exact loopback literal; DNS names cannot use this path. */
export function isLoopbackForwardHost(host: string): boolean {
  const match = /^(?:127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})$/.exec(host);
  if (!match) return false;
  return Number(match[1]) <= 65535;
}

/**
 * Origin 헤더 값이 loopback origin 인지 판별한다(순수 함수).
 *
 * 봇 apps/bot-discord/src/http-host-guard.ts 의 isLoopbackOrigin 과 **동일 로직**
 * 이다(드리프트 관리 — spec C6 Deferred: P3 공용 추출 재검토 전까지 동일 로직 +
 * 원본 위치 주석으로 최소화). 한쪽 버그 수정 시 다른 쪽에도 옮겨야 한다.
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
export interface HostGuardDeps extends AllowedHostsSource {
  /**
   * 허용 Host 목록. 미지정 시 defaultAllowedHosts({host, port}) +
   * MEMORY_ALLOWED_HOSTS env. 테스트는 명시 목록을 주입해 env 격리.
   */
  allowedHosts?: string[];
  /** 요청에서 Host 헤더를 읽는 함수. 기본 c.req.header("host"). 테스트 스텁용. */
  hostOf?: (c: Context) => string | undefined;
  /** 요청에서 Origin 헤더를 읽는 함수. 기본 c.req.header("origin"). 테스트 스텁용. */
  originOf?: (c: Context) => string | undefined;
}

/**
 * Host / Origin 검증 미들웨어를 만든다. outerApp.use("*", ...) 에 가장 먼저
 * 등록한다(body-limit·auth-gate 앞).
 *
 * 판정 순서:
 *   1) Host 헤더 부재 → 403. HTTP/1.1 은 Host 필수라 부재는 비정상 요청이다.
 *      봇→코어 discovery(fetch)는 Host 를 자동으로 붙이므로 실사용 영향 없음.
 *   2) Host ∉ 허용목록·정확한 loopback local forward → 403. Host 값 자체는
 *      응답 본문에 넣지 않는다(로그만).
 *   3) Origin 헤더가 있고 loopback origin 아님 → 403. Origin 부재는 통과
 *      (서버-서버 호출).
 */
export function createHostGuard(deps: HostGuardDeps): MiddlewareHandler {
  const allowed = new Set(
    deps.allowedHosts ?? [
      ...defaultAllowedHosts({ host: deps.host, port: deps.port }),
      ...parseAllowedHostsEnv(process.env.MEMORY_ALLOWED_HOSTS),
    ],
  );
  const hostOf = deps.hostOf ?? ((c: Context) => c.req.header("host"));
  const originOf = deps.originOf ?? ((c: Context) => c.req.header("origin"));

  return async (c, next) => {
    const host = hostOf(c);
    if (host === undefined || host.length === 0) {
      return c.json({ error: "허용되지 않은 Host 헤더입니다." }, 403);
    }
    const forwardedLoopback = !allowed.has(host) && isLoopbackForwardHost(host);
    if (!allowed.has(host) && !forwardedLoopback) {
      return c.json({ error: "허용되지 않은 Host 헤더입니다." }, 403);
    }

    const origin = originOf(c);
    if (origin !== undefined && origin.length > 0) {
      // A forwarded browser tab must come from the same local origin it sends
      // as Host. Exact text also rejects username/path tricks in Origin.
      if (forwardedLoopback ? origin !== `http://${host}` : !isLoopbackOrigin(origin)) {
        return c.json({ error: "허용되지 않은 Origin 헤더입니다." }, 403);
      }
    }

    await next();
  };
}
