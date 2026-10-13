/**
 * sse-bootstrap.ts — SSE 구독의 "토큰 발급 + 첫 연결" 부트스트랩을 backoff 재시도로
 * 견고하게 감싼다 (운영 버그 수정 — 봇이 memory-api 보다 먼저 깰 때 구독 영구 누락).
 *
 * 권위: docs/decisions/2026-06-04-phase7-2nd-active-loop-plan.md Task 7 (SSE 구독)
 *
 * ## 왜 이 파일이 따로 필요한가 (운영에서 확인된 버그)
 *
 * 봇(bara-bot)과 memory-api(bara-memory)가 동시에 재시작되면 봇이 먼저 깬다.
 * memory-api 는 임베딩 모델 로딩 때문에 LISTEN 까지 ~21초 걸린다. 그 사이 봇이
 * SSE 구독을 시작하려고 토큰 승인 요청(/adapter-enroll)을 보내면 연결이 거부돼 예외가 난다.
 * 옛 index.ts 의 ClientReady 핸들러는 이 첫 발급을 try/catch 한 번으로만 감싸,
 * 실패하면 경고 한 줄 찍고 끝 — 영영 재시도하지 않았다. 그 결과 정리 제안 실시간
 * 알림(SSE)이 끊긴 채로 봇이 계속 돌았다.
 *
 * SseConsumer 자체는 "연결에 성공한 뒤" 끊김에 대해서는 이미 견고하게 재연결한다.
 * 비어 있던 건 "연결 성공 이전", 즉 토큰 발급 + 첫 start 의 부트스트랩이다. 그래서
 * 이 파일은 SseConsumer 본체는 손대지 않고 그 앞단만 backoff 재시도로 감싼다.
 *
 * ## 재시도 정책 — 무한 재시도 + 대기 상한 캡
 *
 * 최대 횟수 제한을 두지 않는다. memory-api 가 한참 죽어 있다가 깨어나도 봇이
 * 스스로 붙어야 하기 때문이다. 로그 도배는 "대기 상한"으로 막는다 — 대기가
 * SSE_BOOTSTRAP_MAX_DELAY_MS 에 닿으면 그 뒤로는 그 간격으로만 재시도하므로
 * 로그 빈도가 자연히 낮아진다.
 *
 * ## config.sseReconnectDelayMs 와는 역할이 다르다 (합치지 말 것)
 *
 *   - config.sseReconnectDelayMs = "연결에 한 번 성공한 뒤" 끊겼을 때 재연결 대기.
 *     SseConsumer 안에서 쓰인다. 사용자가 settings 로 조정한다.
 *   - 이 파일의 상수 = "연결에 성공하기 전" 토큰 발급+첫 start 의 부트스트랩 재시도
 *     대기. 매일 만지는 값이 아니라 동작 정책이라 settings 로 빼지 않고 모듈 상단
 *     export const 단일 출처로 둔다. 테스트가 이 상수를 import 해 기대값을 계산하므로
 *     "코드 안 매직 넘버 금지" 규칙을 충족한다.
 */

import { SseConsumer, type SseEvent } from "./sse-consumer.ts";
import { createHash } from "node:crypto";
import {
  MemoryApiError,
  type MemoryApiClient,
} from "../../memory/src/api-client.ts";
import type { TokenScope } from "../../memory/src/federation/sse-tokens.ts";
import { ADAPTER_ENROLL_ERROR_CODES } from "../../memory/src/federation/adapter-enroll-limits.ts";
import {
  clearAdapterToken,
  isStoredTokenForEndpoint,
  loadAdapterToken,
  saveAdapterToken,
} from "./adapter-token-store.ts";
import {
  clearPendingEnrollment,
  loadPendingEnrollment,
  savePendingEnrollment,
} from "./adapter-enrollment-store.ts";

/**
 * 승인 대기 요청의 토큰 회수(pickup) 응답 중 "그 요청은 끝났다"는 두 status.
 * 403 = 소유자가 이 봇의 요청을 거절했다 — 다시 등록하면 소유자 뜻을 거스르므로 재시도를 멈춘다.
 * 404 = 서버가 수명이 지난 요청을 지웠거나 모른다 — 보관한 요청을 버리고 다음 시도에서 새로 등록한다.
 */
const PICKUP_REJECTED_STATUS = 403;
const PICKUP_GONE_STATUS = 404;

/**
 * 소유자가 대시보드에서 이 봇의 승인 요청을 거절했다(회수 확인이 403). startSseWithRetry 는
 * 다시 등록하지 않고 재시도를 멈춘다 — 다시 연결하려면 봇을 재시작해야 한다.
 */
export class AdapterEnrollmentRejectedError extends Error {
  readonly adapterId: string;

  constructor(adapterId: string, serverMessage: string) {
    super(`어댑터 ${adapterId} 승인 요청이 거절됨 — 다시 연결하려면 봇을 재시작하세요 (서버 응답: ${serverMessage})`);
    this.name = "AdapterEnrollmentRejectedError";
    this.adapterId = adapterId;
  }
}

/**
 * 서버에 이 어댑터의 옛 승인 대기 요청이 남아 있는데(409 ADAPTER_ENROLL_PENDING_EXISTS),
 * 봇에는 그 요청을 회수할 비밀값이 없는 상태. 그 요청은 승인해도 봇이 토큰을 받을 수 없다.
 * startSseWithRetry 는 이 상태에 들어설 때 안내를 한 번만 남기고, 그 뒤로는
 * SSE_BOOTSTRAP_BLOCKED_RECHECK_MS 간격으로 조용히 다시 확인한다. 소유자가 대시보드에서
 * 그 요청을 거절하면(또는 서버가 수명이 지나 지우면) 다음 확인에서 봇이 스스로 새로 등록한다.
 */
export class AdapterEnrollmentBlockedError extends Error {
  readonly adapterId: string;

  constructor(adapterId: string, serverMessage: string) {
    super(
      `어댑터 ${adapterId} 의 옛 승인 대기 요청이 서버에 남아 있어 새로 등록할 수 없습니다. ` +
        `봇은 그 요청의 토큰을 회수할 비밀값이 없어 그 요청은 승인해도 쓸 수 없습니다. ` +
        `대시보드 설정 > 어댑터 관리에서 ${adapterId} 의 대기 요청이 본인 것인지(주소·시각) 확인한 뒤 거절하세요. ` +
        `거절하면 봇이 다음 확인 때 스스로 새로 등록합니다. ` +
        `(서버 응답: ${serverMessage})`,
    );
    this.name = "AdapterEnrollmentBlockedError";
    this.adapterId = adapterId;
  }
}

/**
 * 재시도해도 같은 결과가 나오는 인증 실패 status. 401 = 토큰 자체가 무효(회수·만료 등) —
 * 같은 토큰을 다시 내도 같은 거부가 돌아오므로 비재시도로 골라내 폐기·재enroll 한다.
 *
 * 403(권한 부족)은 여기 포함하지 않는다 — 토큰은 유효하지만 이 경로에 필요한 권한이
 * 모자란 상태라, 토큰을 버려도 소용없고(재enroll 해도 같은 부족한 권한으로 재승인되는
 * 게 보통이다) 관리자가 대시보드에서 권한을 올려주면 "같은 토큰"으로 다음 시도가
 * 성공한다. 그래서 403 은 AdapterScopeInsufficientError 로 별도 분류해 토큰을 보존한
 * 채 재시도 루프에 맡긴다(아래 isNonRetryableTokenError·defaultProbeToken 참고).
 * HTTP 표준값이지만 의미를 한곳에 모아 두려고 상수로 둔다(매직 넘버 금지).
 */
const NON_RETRYABLE_AUTH_STATUSES: ReadonlySet<number> = new Set([401]);

/** 401(토큰 무효)과 구분해 403(권한 부족)만 골라내는 상수. */
const INSUFFICIENT_SCOPE_STATUS = 403;

/**
 * 저장된 어댑터 토큰은 유효하지만(인증 통과) 이 어댑터가 실제로 필요한 권한(scope)이
 * 없어서 보호 경로가 403 을 돌려준 상태. 토큰을 폐기하면 안 된다 — 관리자가 대시보드
 * 어댑터 관리에서 권한을 올려주는 것만이 해결책이고, 그러면 같은 토큰이 다음 시도에서
 * 통한다. startSseWithRetry 는 이 에러를 재시도 대상으로 취급하되(backoff 계속),
 * 경고 로그에 무엇이 부족한지와 고치는 방법을 매번 안내한다.
 */
export class AdapterScopeInsufficientError extends Error {
  readonly adapterId: string;
  readonly requiredScope: TokenScope;

  constructor(adapterId: string, requiredScope: TokenScope = "full") {
    super(
      `어댑터 ${adapterId} 의 저장된 토큰은 유효하지만 권한이 부족합니다(필요: ${requiredScope}). ` +
        `대시보드 설정 > 어댑터 관리에서 ${adapterId} 권한을 ${requiredScope} 로 변경하세요.`,
    );
    this.name = "AdapterScopeInsufficientError";
    this.adapterId = adapterId;
    this.requiredScope = requiredScope;
  }
}

/**
 * memory-api 호출 실패를 사용자가 바로 이해하고 조치할 수 있는 한 문장으로 바꾼다.
 * 401(토큰 무효)과 403(권한 부족 — 조치 방법이 다르다)을 구분해 알린다. deleteBySource·
 * /forget·/stats·/cleanup·일정 알림처럼 실행 중 개별 API 호출이 실패하는 모든 지점에서
 * 같은 판별 로직을 반복하지 않도록 이 함수를 공용 출처로 둔다.
 */
export function describeMemoryApiAuthFailure(err: unknown): string {
  if (err instanceof MemoryApiError) {
    if (err.status === 401) {
      return `인증 실패(401) — 저장된 토큰이 무효합니다. 재enroll 후 대시보드에서 다시 승인하세요: ${err.message}`;
    }
    if (err.status === INSUFFICIENT_SCOPE_STATUS) {
      return `권한 부족(403) — 토큰은 유효하지만 이 요청에 필요한 권한이 없습니다. 대시보드 설정 > 어댑터 관리에서 권한을 full 로 변경하세요: ${err.message}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * 부트스트랩 첫 재시도 대기(ms). 첫 실패 뒤 이만큼 기다렸다 다시 시도한다.
 * 동작 정책이라 settings 로 빼지 않는다(파일 상단 주석 참조).
 */
export const SSE_BOOTSTRAP_INITIAL_DELAY_MS = 1000;

/**
 * 부트스트랩 재시도 대기 상한(ms). 대기가 이 값에 닿으면 그 뒤로는 이 간격으로만
 * 재시도한다 — 무한 재시도여도 로그 도배를 막는 핵심 장치다.
 */
export const SSE_BOOTSTRAP_MAX_DELAY_MS = 30_000;

/**
 * 옛 승인 대기 요청에 막힌 동안(AdapterEnrollmentBlockedError)의 재확인 간격(ms). 소유자가
 * 대시보드에서 그 요청을 거절할 때까지 기다리는 동안 서버에 등록 요청을 몰아 보내지 않는다.
 */
const MS_PER_MINUTE = 60 * 1000;
export const SSE_BOOTSTRAP_BLOCKED_RECHECK_MS = 10 * MS_PER_MINUTE;

/** 재시도할 때마다 대기를 늘리는 배수. 상한(MAX_DELAY)까지만 늘어난다. */
export const SSE_BOOTSTRAP_BACKOFF_FACTOR = 2;

/**
 * Discord 봇 어댑터 등록 상수(WP-B1-15). adapterId·displayName·description·
 * requestedScope 를 한곳에 모아 index.ts 가 펼쳐 쓰기만 하게 한다. 봇은 삭제
 * 동기화·/forget·/stats·/cleanup·일정 알림처럼 full 전용 경로를 쓰므로 항상
 * requestedScope: "full" 을 요청한다(SHARED_MEMORY.md 클라이언트별 권한 표 참고).
 */
export const BOT_ADAPTER_ENROLLMENT = {
  adapterId: "bot-discord",
  displayName: "디스코드 봇",
  description: "Discord reference adapter",
  requestedScope: "full",
} as const satisfies {
  adapterId: string;
  displayName: string;
  description: string;
  requestedScope: TokenScope;
};

/** 토큰 발급 함수 시그니처 — 승인 큐 polling 함수도 같은 모양으로 맞춘다. */
export type IssueSseToken = () => Promise<{ token: string }>;

export interface AdapterApprovalTokenIssuerOptions {
  client: () => MemoryApiClient;
  adapterId: string;
  displayName: string;
  description?: string;
  endpoint?: string;
  /**
   * 봇 로컬 관리 토큰(P1-통합 I1). 지정하면 enroll 요청 body 에 실어 코어에
   * 등록한다 — 코어가 이 값을 코어→봇 프록시 hop 에 Authorization: Bearer 로
   * 부착해 봇 http-admin-gate 를 통과한다. 재enroll(D6 자동 승인)마다 최신 값이
   * 코어 메타로 갱신돼 관리 토큰 재생성 후 stale 을 자동 복구한다(spec § 약점 I-3).
   * 값은 로그에 남기지 않는다.
   */
  adminToken?: string;
  /**
   * 이 어댑터가 동작하는 데 필요한 권한(WP-B1-13·WP-B1-15). enroll 요청에 실려
   * 대시보드 승인 화면에 표시될 뿐 권한을 직접 주지는 않는다 — 관리자가 승인할 때
   * 고른다. Discord 봇은 삭제 동기화·/forget·/stats·/cleanup·일정 알림처럼 full
   * 전용 경로를 쓰므로 항상 "full"을 요청한다(BOT_ADAPTER_ENROLLMENT 참고).
   */
  requestedScope?: TokenScope;
  log?: (message: string) => void;
  /**
   * 어댑터 토큰 저장 파일 경로 override (D5). 미지정 시 저장소 디폴트 경로
   * (data/bot-adapter-token.json) 또는 BOT_ADAPTER_TOKEN_PATH env. 테스트는 임시
   * 경로를 주입한다.
   */
  tokenStorePath?: string;
  /**
   * 저장된 토큰이 코어에서 아직 유효한지 확인하는 probe 함수 (D5). true 면
   * 재승인 없이 그 토큰을 재사용, false(401)면 폐기 후 재enroll. 미지정 시
   * 기본 probe(저장 토큰으로 인증된 클라이언트를 만들어 보호 경로 GET /stats 를
   * 호출)가 쓰인다 — 401 이면 무효(false), 403 이면 AdapterScopeInsufficientError
   * 를 throw 한다(토큰 보존 — WP-B1-15). 테스트는 스텁을 주입해 실제 호출 없이
   * 검증한다. 스텁이 403 케이스를 검증하려면 boolean 이 아니라 throw 로 표현해야
   * 한다(스텁도 이 계약을 따라야 함).
   */
  probeToken?: (token: string) => Promise<boolean>;
  /**
   * 저장 토큰이 API 인증에는 유효하더라도, 코어가 어댑터 보호 settings 경로를
   * 프록시할 adminToken 메타를 실제로 갖고 있는지 확인한다. false 면 저장 토큰
   * 소유를 existingToken 으로 증명해 재enroll 한다.
   */
  verifyAdminTokenRegistration?: (token: string) => Promise<boolean>;
  /**
   * 인증된 MemoryApiClient 를 만드는 팩토리(기본 probe 가 저장 토큰을 검증할 때
   * 사용). 미지정 시 실제 MemoryApiClient 를 memoryApiUrl 로 생성한다. 테스트에서
   * probeToken 을 주면 이 팩토리는 쓰이지 않는다.
   */
  authedClientFactory?: (token: string) => MemoryApiClient;
}

/** 부트스트랩 취소 신호 — ClientReady 가 client 에 매달아 옛/새 루프를 분리한다. */
export interface SseBootstrapAbort {
  /** true 가 되면 재시도 루프가 다음 확인 시점에 즉시 종료한다. */
  cancelled: boolean;
}

export interface StartSseWithRetryOptions {
  /** 토큰 발급 함수. 승인 큐 방식이면 승인 전에는 throw 해서 재시도 루프로 들어간다. */
  issueToken: IssueSseToken;
  /** 메모리 API base URL(예: "http://127.0.0.1:3001"). SseConsumer 에 그대로 전달. */
  memoryApiUrl: string;
  /** 연결 성공 후 재연결 대기(ms) — SseConsumer 에 전달(부트스트랩 대기와 별개). */
  sseReconnectDelayMs: number;
  /** SSE 이벤트 한 건마다 호출. SseConsumer 의 onEvent 로 그대로 넘긴다. */
  onEvent: (event: SseEvent) => void | Promise<void>;
  /** 연결 성공 후 SseConsumer 가 끊김·오류를 알릴 때 호출. */
  onConsumerError?: (err: Error) => void;
  /** 부트스트랩 취소 신호(ClientReady 가 client 에 매단 것). */
  abort: SseBootstrapAbort;
  /** 정상 진행 로그(테스트가 가로채기 위해 주입 가능). 미지정 시 console.log. */
  log?: (message: string) => void;
  /** 경고 로그(토큰 발급 실패·비재시도 등). 미지정 시 console.warn. */
  warn?: (message: string) => void;
  /** 테스트 주입용 sleep — 미지정 시 실제 setTimeout. */
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * 테스트 주입용 fetch — SseConsumer 에 그대로 전달(미지정 시 전역 fetch).
   * 테스트는 보통 memoryApiUrl 로 로컬 서버를 가리키므로 생략해도 된다.
   */
  fetchImpl?: typeof fetch;
}

/** startSseWithRetry 결과 — 호출자가 client 수명에 묶어 stop 할 수 있게 한다. */
export interface StartSseWithRetryResult {
  /** 토큰 발급에 성공해 생성·start 한 consumer. 취소·비재시도 종료면 null. */
  consumer: SseConsumer | null;
}

/** running 동안만 의미 있는 기본 sleep. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashAdminToken(adminToken: string | undefined): string | undefined {
  if (adminToken === undefined || adminToken.length === 0) return undefined;
  return createHash("sha256").update(adminToken).digest("hex");
}

/**
 * 토큰 발급 실패가 "재시도해도 소용없는" 종류인지 판별한다.
 *
 * api-client 의 unwrap 은 이제 status 를 `MemoryApiError.status` 필드로 담아 던진다.
 * 그래서 메시지 문자열을 정규식으로 파내지 않고 필드를 바로 본다 — 401(토큰 자체가
 * 무효)만 비재시도로 골라낸다.
 *
 * 403(권한 부족)은 여기 포함하지 않는다. 옛 구현은 401·403 을 똑같이 "무효 토큰"으로
 * 취급해 mcp-standard 권한으로 발급된 유효한 토큰까지 버리고 재enroll 을 반복하는
 * 운영 버그를 냈다(재enroll 승인도 기존 권한을 유지하므로 재시작마다 같은 일이
 * 되풀이됐다). 403 은 AdapterScopeInsufficientError 로 별도 분류돼 위쪽에서
 * 재시도 루프로 넘어가고, 토큰은 보존된다 — isNonRetryableTokenError 는 여전히
 * 이 에러를 false(재시도 대상)로 본다.
 *
 * 연결 거부(가장 흔한 운영 버그 케이스)는 fetch 가 던지는 TypeError 라
 * MemoryApiError 가 아니다 → instanceof 가 false → 비재시도로 분류되지 않음 →
 * 재시도된다. 이게 "봇이 memory-api 보다 먼저 깰 때 스스로 붙는다"는 동작의 핵심
 * 이라 반드시 보존돼야 한다. MemoryApiError 인데 401 이 아닌 경우(403·5xx 등)도
 * 재시도 대상이다(보수적 분류).
 */
export function isNonRetryableTokenError(err: unknown): boolean {
  return err instanceof MemoryApiError && NON_RETRYABLE_AUTH_STATUSES.has(err.status);
}

/**
 * 저장된 어댑터 토큰이 코어에서 아직 유효한지 확인하는 기본 probe (D5, WP-B1-15 갱신).
 *
 * 저장 토큰으로 인증된 클라이언트를 만들어 보호 경로 GET /stats 를 호출한다.
 * probe 결과는 셋 중 하나다:
 *   - 200: 토큰 유효 → true 반환.
 *   - 401: 토큰 자체가 무효(회수·만료 등) → false 반환(호출부가 폐기 후 재enroll).
 *   - 403: 토큰은 유효하지만 이 경로에 필요한 권한이 없음(예: mcp-standard 토큰으로
 *     full 전용 /stats 호출) → AdapterScopeInsufficientError 를 throw 한다. 여기서
 *     false 를 반환하지 않는 이유: false 는 "폐기 대상"이라는 신호라, 예전 버그처럼
 *     권한만 부족한 유효 토큰을 지우고 재enroll 을 반복하게 된다. 이 에러는
 *     startSseWithRetry 가 재시도 대상으로 처리하되 토큰은 그대로 둔다.
 * 그 외 실패(연결 거부·5xx·타임아웃 등)는 "유효성 미확정"이라 그대로 throw 해
 * startSseWithRetry 의 재시도에 맡긴다 — memory-api 가 아직 안 깬 상황에서 저장
 * 토큰을 성급히 버리지 않기 위함이다(silent 폐기 금지).
 */
async function defaultProbeToken(
  token: string,
  adapterId: string,
  authedClientFactory: (token: string) => MemoryApiClient,
): Promise<boolean> {
  const client = authedClientFactory(token);
  try {
    await client.stats();
    return true;
  } catch (err) {
    if (err instanceof MemoryApiError) {
      if (NON_RETRYABLE_AUTH_STATUSES.has(err.status)) {
        return false;
      }
      if (err.status === INSUFFICIENT_SCOPE_STATUS) {
        throw new AdapterScopeInsufficientError(adapterId);
      }
    }
    // 연결 거부·5xx 등은 유효성 미확정 — 재시도로 넘긴다.
    throw err;
  }
}

async function defaultVerifyAdminTokenRegistration(
  token: string,
  adapterId: string,
  authedClientFactory: (token: string) => MemoryApiClient,
): Promise<boolean> {
  const client = authedClientFactory(token);
  try {
    await client.getFederationAppSettings(adapterId);
    return true;
  } catch (err) {
    if (err instanceof MemoryApiError) {
      // 424 = 코어에 adminToken 메타 없음. 401/403 은 코어가 들고 있는 adminToken 이
      // 봇 게이트에서 거부된 stale 상태로 보고 재등록한다. 그 외 5xx/네트워크성
      // 실패는 유실로 단정하지 않고 부트스트랩 재시도 루프에 넘긴다.
      if (err.status === 424 || NON_RETRYABLE_AUTH_STATUSES.has(err.status)) {
        return false;
      }
    }
    throw err;
  }
}

/**
 * 어댑터 승인 큐 기반 토큰 발급 함수 (D5·D6 통합, WP-B1-15 갱신).
 *
 * 흐름(첫 호출):
 *   1) 저장소 probe — 저장 토큰이 현 endpoint 용이면 probe 로 유효성 확인.
 *      유효 → 그 토큰을 즉시 반환(enroll 건너뜀, 수동 재승인 0).
 *      무효(401) → 저장 토큰 폐기 후 enroll 진행.
 *      권한 부족(403) → 저장 토큰을 그대로 보존한다. AdapterScopeInsufficientError 를
 *      throw 해 재시도 루프로 넘기고, storeProbed 를 true 로 두지 않아 다음 시도에서
 *      다시 probe 한다(관리자가 권한을 올려주면 바로 다음 시도에서 그 토큰이 통한다).
 *      endpoint 불일치(포트 변경 등) → 저장 토큰 폐기 후 enroll 진행.
 *   2) enroll — POST /adapter-enroll. requestedScope 로 이 어댑터가 실제로 필요한
 *      권한을 밝힌다(승인 화면 표시용 — 권한을 직접 주지는 않는다).
 *      D6 자동 승인(status:"approved") → 즉시 pickup → 저장 → 반환.
 *      pending → requestId/pickupSecret 보관 후 throw(승인 대기, 재시도로 polling).
 *
 * 이후 호출은 보관한 pending 요청을 polling 한다. 승인 전에는 Error 를 던져
 * startSseWithRetry 의 backoff 재시도에 맡기고, 승인·pickup 성공 시 토큰을 저장한
 * 뒤 반환한다. 재시도 중에도 pending 요청이 매번 새로 쌓이지 않는다.
 *
 * 대기 요청은 토큰 파일 옆 파일(adapter-enrollment-store.ts)에도 남겨, 봇이 재시작돼도 같은
 * 요청을 이어 확인한다. 회수 확인이 404(서버가 지움)면 그 요청을 버리고 다음 시도에서 새로
 * 등록하고, 403(소유자가 거절)이면 AdapterEnrollmentRejectedError 로 재시도를 멈춘다.
 * 비밀값이 없는 옛 대기 요청이 서버에 남아 등록이 409 로 막히면 AdapterEnrollmentBlockedError
 * 를 던진다 — startSseWithRetry 가 안내를 한 번 남기고 느린 간격으로 다시 확인한다.
 */
export function createAdapterApprovalTokenIssuer(
  options: AdapterApprovalTokenIssuerOptions,
): IssueSseToken {
  let pending:
    | { requestId: string; pickupSecret: string; adapterId: string }
    | null = null;
  // 첫 호출에서만 저장소 probe 를 시도한다(한 번 시도하면 다시 안 함). 403(권한
  // 부족)이 나오면 이 플래그를 세우지 않아 다음 호출이 다시 probe 한다 — 관리자가
  // 권한을 올려주는 순간 재enroll 없이 저장 토큰이 바로 통하게 하기 위함이다.
  let storeProbed = false;
  const log = options.log ?? (() => {});
  const endpoint = options.endpoint ?? "";

  /**
   * 승인 대기 요청을 파일에 남긴다 — 재시작 뒤에도 같은 요청의 토큰을 회수하기 위해서다.
   * 저장 실패는 이번 실행의 회수를 막지 않으므로 경고만 남긴다(재시작하면 회수할 수 없게 됨을 알린다).
   */
  const rememberPending = (next: { requestId: string; pickupSecret: string; adapterId: string }): void => {
    pending = next;
    try {
      savePendingEnrollment(
        { ...next, baseUrl: options.client().apiBaseUrl },
        options.tokenStorePath,
      );
    } catch (err) {
      log(
        `승인 대기 요청 저장 실패(대기 중 재시작하면 이 요청을 회수할 수 없음) — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /**
   * 보관한 대기 요청을 버린다(토큰 회수 성공·요청 종료). 파일 삭제 실패는 연결을 막지 않도록
   * 경고만 남긴다 — 남은 파일은 다음 확인에서 끝난 요청(404·403)으로 드러나 다시 지워진다.
   */
  const forgetPending = (): void => {
    pending = null;
    try {
      clearPendingEnrollment(options.tokenStorePath);
    } catch (err) {
      log(`승인 대기 요청 파일 삭제 실패 — ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /**
   * 지난 실행이 남긴 대기 요청을 이어받는다. 다른 어댑터·다른 서버 주소의 요청이거나 깨진
   * 파일이면 회수할 수 없으므로 지우고 null 을 돌려준다(새로 등록).
   */
  const resumeSavedPending = (): { requestId: string; pickupSecret: string; adapterId: string } | null => {
    const saved = loadPendingEnrollment(options.tokenStorePath);
    if (saved === null) {
      clearPendingEnrollment(options.tokenStorePath);
      return null;
    }
    if (saved.adapterId !== options.adapterId || saved.baseUrl !== options.client().apiBaseUrl) {
      clearPendingEnrollment(options.tokenStorePath);
      log("저장된 승인 대기 요청이 다른 어댑터·서버 주소의 것이라 폐기 — 새로 등록 진행");
      return null;
    }
    log(`지난 실행의 승인 대기 요청을 이어서 확인 — requestId=${saved.requestId}`);
    return { requestId: saved.requestId, pickupSecret: saved.pickupSecret, adapterId: saved.adapterId };
  };

  /** 저장 토큰이 유효한지 확인하는 probe. 스텁 우선, 없으면 기본 probe. */
  const probe = async (token: string): Promise<boolean> => {
    if (options.probeToken) return options.probeToken(token);
    if (options.authedClientFactory) {
      return defaultProbeToken(token, options.adapterId, options.authedClientFactory);
    }
    // probe 수단이 전혀 없으면 저장 토큰을 검증할 수 없다 — 재사용하지 않고
    // 재enroll 로 넘긴다(무효로 취급, 안전 측). silent 재사용 금지.
    return false;
  };

  const verifyAdminRegistration = async (token: string): Promise<boolean> => {
    if (options.verifyAdminTokenRegistration) {
      return options.verifyAdminTokenRegistration(token);
    }
    if (options.authedClientFactory) {
      return defaultVerifyAdminTokenRegistration(
        token,
        options.adapterId,
        options.authedClientFactory,
      );
    }
    // 확인 통로가 전혀 없으면 core 에 adminToken 메타데이터가 등록됐는지 확인할
    // 수 없다 — silent 성공 단정 금지, 미확인 상태로 간주해 안전 측(재enroll)
    // 경로로 넘긴다.
    return false;
  };

  /** enroll → (자동승인) 즉시 pickup, (pending) 보관 후 throw. */
  const enrollAndMaybePickup = async (
    existingToken?: string,
  ): Promise<{ token: string }> => {
    let enrolled: Awaited<ReturnType<MemoryApiClient["enrollAdapterToken"]>>;
    try {
      enrolled = await options.client().enrollAdapterToken({
        adapterId: options.adapterId,
        displayName: options.displayName,
        description: options.description,
        endpoint: options.endpoint,
        // 저장 토큰이 유효한 경우, 그 토큰 소유를 증명해 endpoint/adminToken 메타를
        // 수동 승인 없이 갱신한다. 응답·로그에는 이 값이 다시 나오지 않는다.
        existingToken,
        // 봇 로컬 관리 토큰을 코어에 등록(I1) — 코어→봇 프록시 hop 부착용.
        adminToken: options.adminToken,
        // 이 어댑터가 실제로 쓰는 권한(WP-B1-15). 표시·경고용일 뿐 권한을 직접 주지는
        // 않는다 — 관리자가 승인 화면에서 최종적으로 고른다.
        requestedScope: options.requestedScope,
      });
    } catch (err) {
      // 옛 대기 요청이 서버에 남아 있고 그 비밀값은 봇에 없다 — 재시도해도 같은 409 라 멈춘다.
      if (err instanceof MemoryApiError && err.code === ADAPTER_ENROLL_ERROR_CODES.pendingExists) {
        throw new AdapterEnrollmentBlockedError(options.adapterId, err.message);
      }
      throw err;
    }

    if (enrolled.status === "approved") {
      // D6 자동 승인 — 즉시 pickup.
      const picked = await options
        .client()
        .pickupAdapterToken(enrolled.requestId, enrolled.pickupSecret);
      if (picked.status === "approved") {
        saveIssuedToken(picked.token, enrolled.requestId, enrolled.pickupSecret);
        log(`어댑터 토큰 재enroll(자동승인) 완료 — adapterId=${enrolled.adapterId}`);
        return { token: picked.token };
      }
      // 자동승인 응답 뒤 pickup 이 approved 가 아니면(경합 등) pending 흐름으로.
      rememberPending({
        requestId: enrolled.requestId,
        pickupSecret: enrolled.pickupSecret,
        adapterId: enrolled.adapterId,
      });
      throw new Error(
        `어댑터 토큰 승인 대기 중 — settings 어댑터 관리에서 ${enrolled.adapterId} 요청을 승인해야 한다`,
      );
    }

    // pending — 파일에도 보관한 뒤 재시도 루프로(재시작 뒤 이어서 회수).
    rememberPending({
      requestId: enrolled.requestId,
      pickupSecret: enrolled.pickupSecret,
      adapterId: enrolled.adapterId,
    });
    log(
      `어댑터 토큰 승인 요청 등록(승인 대기) — adapterId=${enrolled.adapterId}, requestId=${enrolled.requestId}`,
    );
    throw new Error(
      `어댑터 토큰 승인 대기 중 — settings 어댑터 관리에서 ${enrolled.adapterId} 요청을 승인해야 한다`,
    );
  };

  /**
   * pickup 성공 토큰을 저장한다. 저장 실패는 loud warn 하되 흐름을 막지 않는다.
   * 토큰을 먼저 저장한 뒤 끝난 대기 요청을 지운다(지우기 실패는 경고만 — forgetPending).
   */
  const saveIssuedToken = (
    token: string,
    requestId: string,
    pickupSecret: string,
  ): void => {
    try {
      const adminTokenHash = hashAdminToken(options.adminToken);
      saveAdapterToken(
        {
          adapterId: options.adapterId,
          endpoint,
          token,
          requestId,
          pickupSecret,
          ...(adminTokenHash !== undefined ? { adminTokenHash } : {}),
        },
        options.tokenStorePath,
      );
    } catch (err) {
      // 저장 실패는 다음 재시작에서 재승인이 필요해질 뿐, 현 세션 인증은 됐다.
      // 값은 로그에 안 넣고 실패 사실만 알린다.
      log(
        `어댑터 토큰 저장 실패(다음 재시작 시 재승인 필요) — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    forgetPending();
  };

  return async () => {
    // ── 첫 호출: 저장소 probe ────────────────────────────────────────────────
    if (!storeProbed) {
      const stored = loadAdapterToken(options.tokenStorePath);
      if (stored !== null) {
        if (!isStoredTokenForEndpoint(stored, endpoint)) {
          // endpoint 변경(포트 등) — 저장 토큰 무효로 보고 폐기.
          clearAdapterToken(options.tokenStorePath);
          log("저장된 어댑터 토큰의 endpoint 가 현재와 달라 폐기 — 재enroll 진행");
        } else {
          let valid: boolean;
          try {
            valid = await probe(stored.token);
          } catch (err) {
            if (err instanceof AdapterScopeInsufficientError) {
              // 토큰은 유효하지만 권한이 부족하다 — 폐기·재enroll 하지 않는다.
              // storeProbed 를 세우지 않아 다음 시도에서 다시 probe 한다(관리자가
              // 권한을 올려주면 재enroll 없이 이 토큰이 바로 통한다).
              log(err.message);
              throw err;
            }
            // 연결 거부·5xx 등 유효성 미확정 — 재시도 루프로 넘긴다(폐기하지 않음).
            throw err;
          }
          if (valid) {
            const expectedAdminHash = hashAdminToken(options.adminToken);
            if (
              expectedAdminHash !== undefined &&
              stored.adminTokenHash !== expectedAdminHash
            ) {
              log("저장된 토큰 유효 — 관리 토큰 재등록 진행");
              try {
                const result = await enrollAndMaybePickup(stored.token);
                storeProbed = true;
                return result;
              } catch (err) {
                if (pending !== null) storeProbed = true;
                throw err;
              }
            }
            if (
              expectedAdminHash !== undefined &&
              !(await verifyAdminRegistration(stored.token))
            ) {
              log("저장된 토큰 유효 — 코어 관리 토큰 메타 재등록 진행");
              try {
                const result = await enrollAndMaybePickup(stored.token);
                storeProbed = true;
                return result;
              } catch (err) {
                if (pending !== null) storeProbed = true;
                throw err;
              }
            }
            log("저장된 토큰 유효 — 재승인 없이 사용");
            // 유효한 토큰이 있으면 남아 있던 대기 요청 파일은 쓸 일이 없다.
            forgetPending();
            storeProbed = true;
            return { token: stored.token };
          }
          clearAdapterToken(options.tokenStorePath);
          log("저장된 어댑터 토큰이 코어에서 무효(401) — 폐기 후 재enroll 진행");
        }
      }
      storeProbed = true;
    }

    // ── enroll 또는 pending polling ──────────────────────────────────────────
    if (pending === null) pending = resumeSavedPending();
    if (pending === null) {
      return enrollAndMaybePickup();
    }

    let picked: Awaited<ReturnType<MemoryApiClient["pickupAdapterToken"]>>;
    try {
      picked = await options
        .client()
        .pickupAdapterToken(pending.requestId, pending.pickupSecret);
    } catch (err) {
      if (err instanceof MemoryApiError && err.status === PICKUP_REJECTED_STATUS) {
        // 소유자가 거절했다 — 다시 등록하지 않는다. 파일을 지우고 재시도를 멈추게 한다.
        const rejected = pending;
        forgetPending();
        log(`승인 대기 요청 ${rejected.requestId} 이(가) 거절됨 — 다시 연결하려면 봇을 재시작하세요`);
        throw new AdapterEnrollmentRejectedError(rejected.adapterId, err.message);
      }
      if (err instanceof MemoryApiError && err.status === PICKUP_GONE_STATUS) {
        // 서버가 수명이 지난 요청을 지웠다 — 같은 요청은 다시 물어도 같으니 버리고 새로 등록한다.
        const gone = pending;
        forgetPending();
        log(`승인 대기 요청 ${gone.requestId} 이(가) 서버에서 사라짐(대기 시간 만료 등) — 다음 시도에서 새로 등록 요청`);
        throw new Error(
          `어댑터 ${gone.adapterId} 승인 대기 요청이 서버에서 사라짐(대기 시간 만료 등) — 다음 시도에서 새로 등록한다: ${err.message}`,
        );
      }
      throw err;
    }
    if (picked.status === "approved") {
      saveIssuedToken(picked.token, pending.requestId, pending.pickupSecret);
      log(`어댑터 토큰 승인 완료 — adapterId=${picked.adapterId}`);
      return { token: picked.token };
    }
    throw new Error(
      `어댑터 토큰 승인 대기 중 — settings 어댑터 관리에서 ${pending.adapterId} 요청을 승인해야 한다`,
    );
  };
}

/**
 * 토큰을 발급해 SseConsumer 를 연결한다 — 발급 실패 시 backoff 로 무한 재시도한다.
 *
 * 흐름(루프):
 *   1) 취소 신호 확인 → 취소면 즉시 종료.
 *   2) issueToken() 시도.
 *      - 성공: SseConsumer 생성 + start() → consumer 를 반환(호출자가 client 수명에
 *        묶는다). SseConsumer 가 그 뒤의 끊김 재연결을 맡으므로 부트스트랩은 끝.
 *      - 인증 실패(401): 토큰 자체가 무효 — 재시도해도 소용없으니 loud 경고만
 *        남기고 종료(호출자가 재enroll 을 유도).
 *      - 권한 부족(403, AdapterScopeInsufficientError): 토큰은 유효하다 —
 *        재enroll 하지 않고 재시도만 계속한다(WP-B1-15). 경고마다 대시보드에서
 *        권한을 올리는 방법을 안내한다. 관리자가 권한을 올리면 다음 시도에서
 *        같은 토큰으로 바로 붙는다.
 *      - 그 외 실패(연결 거부·5xx·타임아웃 등): 현재 대기만큼 잤다가 대기를 배수로
 *        늘려(상한 캡) 다시 시도. 대기 전후로 취소를 확인한다(좀비 루프 방지).
 *
 * 호출자는 await 하지 말고 fire-and-forget 으로 부른다(ClientReady 가 SSE 로 막히면
 * 안 됨). 취소되거나 401 인증 실패로 끝나면 consumer 는 null 로 반환된다. 403 은
 * 종료하지 않고 무한 재시도를 계속한다(대기 상한이 로그 도배를 막는다).
 */
export async function startSseWithRetry(
  options: StartSseWithRetryOptions,
): Promise<StartSseWithRetryResult> {
  const {
    issueToken,
    memoryApiUrl,
    sseReconnectDelayMs,
    onEvent,
    onConsumerError,
    abort,
    fetchImpl,
  } = options;
  const log = options.log ?? ((m: string) => console.log(m));
  const warn = options.warn ?? ((m: string) => console.warn(m));
  const sleep = options.sleepImpl ?? defaultSleep;

  let delay = SSE_BOOTSTRAP_INITIAL_DELAY_MS;
  let attempt = 0;
  // 옛 대기 요청에 막힌 상태에 들어선 뒤 안내를 이미 남겼는가(재확인마다 반복하지 않는다).
  let blockedNotified = false;

  while (!abort.cancelled) {
    attempt += 1;
    try {
      const { token } = await issueToken();
      // 토큰 발급 사이에 취소가 내려왔으면 consumer 를 만들지 않는다(좀비 방지).
      if (abort.cancelled) {
        return { consumer: null };
      }
      const consumer = new SseConsumer({
        baseUrl: memoryApiUrl,
        token,
        reconnectDelayMs: sseReconnectDelayMs,
        onEvent,
        onError: onConsumerError,
        fetchImpl,
      });
      consumer.start();
      // 토큰 값은 로그에 남기지 않는다(식별자만) — 시도 횟수만 알린다.
      log(
        `정리 제안 SSE 구독 연결 성공 (시도 ${attempt}회) — ${memoryApiUrl}/events/stream`,
      );
      return { consumer };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof AdapterEnrollmentBlockedError) {
        // 옛 대기 요청이 남아 새 등록이 막혔다 — 안내는 처음 한 번만 남기고, 소유자가 그 요청을
        // 거절할 때까지 느린 간격으로 조용히 다시 확인한다(거절되면 다음 확인에서 스스로 등록).
        if (!blockedNotified) {
          warn(
            `정리 제안 SSE 구독 토큰 발급 대기 — ${Math.round(SSE_BOOTSTRAP_BLOCKED_RECHECK_MS / MS_PER_MINUTE)}분 간격으로 다시 확인: ${message}`,
          );
          blockedNotified = true;
        }
        if (abort.cancelled) return { consumer: null };
        await sleep(SSE_BOOTSTRAP_BLOCKED_RECHECK_MS);
        continue;
      }
      blockedNotified = false;
      if (err instanceof AdapterEnrollmentRejectedError) {
        // 소유자가 거절했다 — 다시 등록하지 않고 멈춘다.
        warn(`정리 제안 SSE 구독 토큰 발급 중단: ${message}`);
        return { consumer: null };
      }
      if (isNonRetryableTokenError(err)) {
        // 401(토큰 무효) 은 재시도해도 같은 결과 — loud 경고만 남기고 멈춘다.
        warn(
          `정리 제안 SSE 구독 토큰 발급 거부(인증 실패) — 재시도 중단: ${message}`,
        );
        return { consumer: null };
      }
      // 다음 시도 대기를 계산하되 상한으로 캡한다(로그 도배 차단).
      const nextDelay = Math.min(delay, SSE_BOOTSTRAP_MAX_DELAY_MS);
      if (err instanceof AdapterScopeInsufficientError) {
        // 403(권한 부족) — 토큰은 유효하니 재enroll 하지 않고 재시도만 계속한다.
        // 경고마다 무엇이 부족하고 어떻게 고치는지 안내한다(err.message 에 포함).
        warn(
          `정리 제안 SSE 구독 권한 대기 중 (누적 ${attempt}회) — ${Math.round(
            nextDelay / 1000,
          )}초 뒤 재확인: ${message}`,
        );
      } else {
        warn(
          `정리 제안 SSE 구독 토큰 발급 실패 (누적 ${attempt}회) — ${Math.round(
            nextDelay / 1000,
          )}초 뒤 재시도: ${message}`,
        );
      }
      // 대기 전 취소 확인 → 대기 → 대기 후 취소 확인(좀비 루프 방지).
      if (abort.cancelled) return { consumer: null };
      await sleep(nextDelay);
      if (abort.cancelled) return { consumer: null };
      delay = Math.min(
        delay * SSE_BOOTSTRAP_BACKOFF_FACTOR,
        SSE_BOOTSTRAP_MAX_DELAY_MS,
      );
    }
  }

  return { consumer: null };
}
