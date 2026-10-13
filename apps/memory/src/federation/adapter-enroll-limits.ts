/**
 * 무인증 어댑터 등록(POST /adapter-enroll) 상한 단일 출처.
 *
 * /adapter-enroll 은 토큰 없이 부를 수 있는 공개 경로다. 상한이 없으면 외부에 열린
 * 서버에 요청을 쏟아부어 (1) 승인 대기열을 끝없이 불리고 (2) 요청마다 토큰 파일
 * 전체를 다시 써서 디스크·CPU 를 계속 돌리게 만들 수 있었다. 이 파일의 값이 그
 * 표면을 막는다. 값을 바꿀 때는 이 파일 한 곳만 고친다.
 *
 * - 대기 요청 상한: 승인 대기(pending) 요청이 이 수에 닿으면 새 무인증 요청을 거절한다.
 *   개인 서버에 붙는 어댑터(펫·디스코드 봇·OCR 동반 도구 등)는 몇 개뿐이라 넉넉하다.
 * - 주소별 대기 요청 상한: 한 접속 주소가 대기열을 혼자 채우지 못하게 한다. 한 기기에서
 *   펫·봇·OCR 도구를 함께 등록하는 경우(3개)까지는 받는다.
 * - 대기 요청 수명: 만든 지 이 시간이 지난 pending 요청은 대기열에서 지운다. 요청자가
 *   pickup 으로 polling 해도 연장되지 않는다(createdAt 기준) — 연장되면 공격자가 자기
 *   요청을 영원히 살려 둘 수 있다.
 * - 거절 요청 보관 기간: 거절된 요청은 요청자가 "거절됨"을 확인할 시간만 남긴 뒤 지운다.
 * - 회수된 승인 요청 보관 기간: 요청자가 토큰을 회수(pickup)한 승인 요청은 회수 시각부터
 *   이 기간이 지나면 지운다(회수 직후 저장에 실패한 요청자가 한 번 더 회수할 시간). 아직
 *   회수되지 않은 승인 요청은 지우지 않는다 — 요청자가 토큰을 못 받게 된다.
 * - 주소별 요청 빈도: 같은 접속 주소에서 창(window) 안에 이 수를 넘는 등록 요청은 본문을
 *   읽기 전에 429 로 거절한다. 디스코드 봇의 재시도 상한(30초 간격)이 창 안에 들어가는
 *   수(10회)보다 약간 크게 잡았다.
 * - 추적 주소 상한: 빈도 계산용으로 기억하는 접속 주소 수. 넘으면 만료 기록을 먼저 지우고,
 *   그래도 가득 차면 처음 보는 주소의 요청을 거절한다(기억 공간이 끝없이 늘지 않게).
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export interface AdapterEnrollLimits {
  /** 동시에 쌓일 수 있는 승인 대기(pending) 요청 수. */
  maxPendingRequests: number;
  /** 한 접속 주소의 승인 대기 요청 수. */
  maxPendingPerAddress: number;
  /** pending 요청 수명(ms, createdAt 기준). */
  pendingTtlMs: number;
  /** 거절된 요청 보관 기간(ms, rejectedAt 기준). */
  rejectedRetentionMs: number;
  /** 토큰을 회수한 승인 요청 보관 기간(ms, pickedUpAt 기준). */
  pickedUpRetentionMs: number;
}

export interface AdapterEnrollRateLimits {
  /** 한 접속 주소가 창 안에서 보낼 수 있는 등록 요청 수. */
  maxRequestsPerWindow: number;
  /** 빈도 계산 창 길이(ms). */
  windowMs: number;
  /** 동시에 추적하는 접속 주소 수 상한. */
  maxTrackedClients: number;
}

export const ADAPTER_ENROLL_LIMITS: Readonly<AdapterEnrollLimits> = Object.freeze({
  maxPendingRequests: 20,
  maxPendingPerAddress: 3,
  pendingTtlMs: 24 * HOUR_MS,
  rejectedRetentionMs: 24 * HOUR_MS,
  pickedUpRetentionMs: 24 * HOUR_MS,
});

export const ADAPTER_ENROLL_RATE_LIMITS: Readonly<AdapterEnrollRateLimits> = Object.freeze({
  maxRequestsPerWindow: 12,
  windowMs: 5 * MINUTE_MS,
  maxTrackedClients: 10_000,
});

/**
 * 등록 거절 사유 코드. 응답 body 의 `code` 칸에 그대로 실려 펫·봇·대시보드가
 * 문장을 파싱하지 않고 갈래를 고른다.
 * - pendingExists: 같은 adapterId 의 승인 대기 요청이 이미 있다(409).
 * - pendingLimit: 승인 대기 요청이 상한에 닿았다(429).
 * - addressPendingLimit: 같은 접속 주소의 승인 대기 요청이 상한에 닿았다(429).
 * - rateLimited: 같은 접속 주소의 요청 빈도가 상한을 넘었다(429).
 */
export const ADAPTER_ENROLL_ERROR_CODES = Object.freeze({
  pendingExists: "ADAPTER_ENROLL_PENDING_EXISTS",
  pendingLimit: "ADAPTER_ENROLL_PENDING_LIMIT",
  addressPendingLimit: "ADAPTER_ENROLL_ADDRESS_PENDING_LIMIT",
  rateLimited: "ADAPTER_ENROLL_RATE_LIMITED",
} as const);

export type AdapterEnrollErrorCode =
  (typeof ADAPTER_ENROLL_ERROR_CODES)[keyof typeof ADAPTER_ENROLL_ERROR_CODES];

/** 저장소가 새 등록 요청을 받지 않을 때 던진다. 라우트가 code 로 HTTP 상태를 고른다. */
export class AdapterEnrollRefusedError extends Error {
  readonly code: AdapterEnrollErrorCode;

  constructor(code: AdapterEnrollErrorCode, message: string) {
    super(message);
    this.name = "AdapterEnrollRefusedError";
    this.code = code;
  }
}

/** 수명 판정에 필요한 요청 칸만. sse-tokens.ts 의 저장 요청이 이 모양을 만족한다. */
export interface ExpirableEnrollRequest {
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  rejectedAt: string | null;
  updatedAt: string;
  /** 승인된 요청의 토큰을 요청자가 처음 회수한 시각. 회수 전이면 칸이 없다. */
  pickedUpAt?: string;
}

/**
 * 지금 시각 기준으로 지워야 할 요청인가.
 * pending 은 createdAt + pendingTtlMs, rejected 는 (rejectedAt ?? updatedAt) +
 * rejectedRetentionMs, 회수된 approved 는 pickedUpAt + pickedUpRetentionMs 를 넘으면
 * 만료다. 회수 전 approved 는 만료되지 않는다. 시각을 읽을 수 없는 요청(손상된 파일)은
 * 만료로 본다 — 수명을 판정할 수 없는 요청을 영원히 남기지 않는다.
 */
export function isEnrollRequestExpired(
  request: ExpirableEnrollRequest,
  nowMs: number,
  limits: AdapterEnrollLimits,
): boolean {
  let since: number;
  let lifetime: number;
  if (request.status === "approved") {
    if (request.pickedUpAt === undefined) return false;
    since = Date.parse(request.pickedUpAt);
    lifetime = limits.pickedUpRetentionMs;
  } else if (request.status === "pending") {
    since = Date.parse(request.createdAt);
    lifetime = limits.pendingTtlMs;
  } else {
    since = Date.parse(request.rejectedAt ?? request.updatedAt);
    lifetime = limits.rejectedRetentionMs;
  }
  if (!Number.isFinite(since)) return true;
  return nowMs - since >= lifetime;
}

/**
 * 만료된 요청을 지운다(sse-tokens.ts 의 요청 대기열 정리). 하나라도 지웠으면 true —
 * 호출자가 그때만 파일에 다시 쓴다.
 */
export function pruneExpiredEnrollRequests<T extends ExpirableEnrollRequest>(
  requests: Map<string, T>,
  nowMs: number,
  limits: AdapterEnrollLimits,
): boolean {
  let pruned = false;
  for (const [requestId, request] of requests) {
    if (!isEnrollRequestExpired(request, nowMs, limits)) continue;
    requests.delete(requestId);
    pruned = true;
  }
  return pruned;
}

/**
 * 소유 증명이 없는(무인증) 새 등록 요청을 받아도 되는지 판정하고, 안 되면 던진다.
 *
 * - 같은 adapterId 의 pending 요청이 이미 있으면 거절한다(pendingExists). 옛 동작은 새
 *   요청이 기존 pending 을 rejected 로 바꿨는데, 그러면 누구든 adapterId 만 알면 정상
 *   요청자의 대기 요청을 취소시킬 수 있었다. 기존 요청은 그대로 둔다. 남아 있는 요청은
 *   먼저 온 누군가의 것일 수 있으므로, 소유자가 대시보드에서 접속 주소·요청 시각으로 본인
 *   요청인지 확인하고 아니면 거절해야 한다.
 * - 같은 접속 주소의 pending 이 주소별 상한에 닿았으면 거절한다(addressPendingLimit).
 *   주소를 모르는 요청(remoteAddr 빈 값)끼리는 한 주소로 함께 센다.
 * - pending 요청이 전체 상한에 닿았으면 거절한다(pendingLimit).
 *
 * 기존 토큰으로 소유를 증명한 재등록(자동 승인)은 이 판정을 거치지 않는다 — pending 을
 * 늘리지 않고, 인증된 요청자라 같은 adapterId 의 대기 요청을 정리해도 된다.
 */
export function assertEnrollAdmission(
  requests: Iterable<{ adapterId: string; remoteAddr: string; status: ExpirableEnrollRequest["status"] }>,
  adapterId: string,
  remoteAddr: string,
  limits: AdapterEnrollLimits,
): void {
  let pendingCount = 0;
  let addressPendingCount = 0;
  for (const request of requests) {
    if (request.status !== "pending") continue;
    if (request.adapterId === adapterId) {
      throw new AdapterEnrollRefusedError(
        ADAPTER_ENROLL_ERROR_CODES.pendingExists,
        `어댑터 ${adapterId} 의 승인 대기 요청이 이미 있습니다. 설정 > 어댑터 관리에서 그 요청의 접속 주소와 요청 시각을 보고 본인 요청인지 확인하세요. 본인 요청이 아니거나 더 쓰지 않는 요청이면 거절한 뒤 다시 요청하세요 (대기 요청은 ${formatHours(limits.pendingTtlMs)}시간 뒤 자동으로 지워집니다).`,
      );
    }
    pendingCount += 1;
    if (request.remoteAddr === remoteAddr) addressPendingCount += 1;
  }
  if (addressPendingCount >= limits.maxPendingPerAddress) {
    throw new AdapterEnrollRefusedError(
      ADAPTER_ENROLL_ERROR_CODES.addressPendingLimit,
      `이 접속 주소에서 보낸 승인 대기 요청이 상한(${limits.maxPendingPerAddress}개)에 닿아 새 등록 요청을 받지 않습니다. 설정 > 어댑터 관리에서 대기 요청을 승인하거나 거절하세요.`,
    );
  }
  if (pendingCount >= limits.maxPendingRequests) {
    throw new AdapterEnrollRefusedError(
      ADAPTER_ENROLL_ERROR_CODES.pendingLimit,
      `승인 대기 요청이 상한(${limits.maxPendingRequests}개)에 닿아 새 등록 요청을 받지 않습니다. 설정 > 어댑터 관리에서 대기 요청을 정리하세요.`,
    );
  }
}

function formatHours(ms: number): string {
  return String(Math.round((ms / HOUR_MS) * 10) / 10);
}
