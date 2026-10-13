/**
 * SSE/API 어댑터 토큰 발급·검증.
 *
 * 기존 Phase 1 토큰 게이트는 adapterId -> token 파일을 영속하고 Bearer 토큰을
 * 검증했다. 승인 큐 단계에서는 같은 파일 안에 "어댑터가 토큰을 요청했다"는
 * pending 요청도 함께 보관한다. 대시보드는 요청을 보고 승인/거절하고, 승인된
 * 요청을 만든 어댑터만 pickupSecret 으로 토큰을 회수한다.
 *
 * 보안 핵심:
 * - 토큰 값과 pickupSecret 값은 로그·에러 메시지에 넣지 않는다.
 * - pickupSecret 은 sha256 해시로만 보관한다.
 * - 기존 v1 파일({ version: 1, tokens })은 그대로 읽고, 다음 저장 때 v2 양식으로 쓴다.
 *
 * 관리 어댑터 권한(WP-B1-13, CR-0·SA-2·SA-6):
 * - 등록 요청의 requestedScope 는 저장·표시만 한다. 권한은 관리자가 승인 때 고른다.
 * - 이미 토큰이 있는 어댑터의 재등록 승인은 share(기존 토큰 전달, 기본)와
 *   rotate(새 토큰 발급 + 옛 토큰 무효) 중 관리자가 명시한 쪽만 따른다.
 * - 회수·교체·권한 변경은 onTokenChange 로 알려 열린 SSE 연결이 즉시 다시 검증한다.
 *
 * 무인증 등록 상한(adapter-enroll-limits.ts): pending 요청 수 상한, pending·rejected 요청
 * 수명(읽기·쓰기 때마다 만료분 정리), 같은 adapterId 의 pending 이 있으면 새 무인증 요청 거절.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  ADAPTER_ENROLL_LIMITS,
  type AdapterEnrollLimits,
  assertEnrollAdmission,
  pruneExpiredEnrollRequests,
} from "./adapter-enroll-limits.ts";
import { ID_PATTERN } from "./manifest-schema.ts";
import { writeTokenFileAtomic } from "./sse-token-file.ts";
import { isTokenScope, TOKEN_SCOPES, type TokenScope } from "./token-scope.ts";

/**
 * TokenScope·isTokenScope·TOKEN_SCOPES 는 token-scope.ts 가 단일 출처다(WP-B1-12,
 * SA-13). 이 파일은 하위 호환을 위해 다시 내보내기만 한다 — 기존 임포터
 * (mcp/access.ts, mcp/server.ts, auth-gate.ts, routes/adapter-tokens.ts, 모든
 * 테스트)는 이 파일에서 그대로 가져올 수 있다.
 */
export { isTokenScope, TOKEN_SCOPES, type TokenScope } from "./token-scope.ts";

/**
 * 토큰 보관 파일 디폴트 경로. env SSE_TOKEN_PATH 가 없을 때 부팅(index.ts)과 dashboard:link 가 쓴다.
 * SseTokenStore 는 env·이 값을 스스로 고르지 않는다 — 호출자가 경로를 넘긴다(테스트가 운영 파일을 우연히 고르지 않게).
 */
export const DEFAULT_SSE_TOKEN_PATH = "data/sse-tokens.json";

/** 토큰 엔트로피(바이트). 32 = 256 비트 — 추측 불가. */
const TOKEN_BYTES = 32;
const REQUEST_ID_BYTES = 16;
const PICKUP_SECRET_BYTES = 32;

/** 메타에 scope 칸이 없는 옛 토큰의 유효 권한. 기존 연결 보존을 위해 full 로 해석한다. */
const LEGACY_TOKEN_SCOPE: TokenScope = "full";

/** 처음 보는 어댑터를 관리자가 scope 없이 승인할 때의 권한. */
const NEW_ADAPTER_DEFAULT_SCOPE: TokenScope = "mcp-standard";

/**
 * 이미 토큰이 발급된 어댑터의 재등록 요청을 승인할 때 기존 토큰을 다루는 방식.
 * - share: 기존 토큰을 요청자에게 그대로 전달한다(기본, 현행 동작). 같은 adapterId 를
 *   여러 기기가 함께 쓰는 흐름에서 기기마다 승인해도 서로의 연결을 끊지 않는다.
 * - rotate: 새 토큰을 발급하고 옛 토큰을 즉시 무효로 만든다(기존 연결이 끊긴다).
 */
export type ExistingTokenChoice = "share" | "rotate";

export const EXISTING_TOKEN_CHOICES: readonly ExistingTokenChoice[] = ["share", "rotate"] as const;

export function isExistingTokenChoice(value: unknown): value is ExistingTokenChoice {
  return typeof value === "string" && (EXISTING_TOKEN_CHOICES as readonly string[]).includes(value);
}

/**
 * 토큰 변경 통지 종류(SA-6): revoked = removeToken, rotated = 승인 rotate(옛 토큰 무효),
 * scope-changed = 같은 토큰의 권한 변경(setTokenScope, scope 를 지정한 공유 승인).
 * 통지를 받은 열린 SSE 연결은 자기 토큰이 아직 유효하고 권한이 맞는지 다시 확인한다.
 */
export type TokenChangeKind = "revoked" | "rotated" | "scope-changed";

export interface TokenChange {
  adapterId: string;
  kind: TokenChangeKind;
}

export type TokenChangeListener = (change: TokenChange) => void;

interface TokenMetadata {
  issuedAt: string;
  /** Omitted only on legacy tokens, which retain full access. */
  scope?: TokenScope;
  /**
   * 이 토큰을 발급받은 어댑터의 endpoint. 주소는 소유 증명이 아니므로 자동 승인은
   * existingToken 검증으로만 한다. 하위 호환으로 생략된 endpoint는 그대로 유지한다.
   */
  endpoint?: string;
  /**
   * 이 어댑터가 코어에 등록한 로컬 관리 토큰(P1-통합 I2). 코어→봇 프록시 hop 이
   * Authorization: Bearer 로 부착해 봇 http-admin-gate 를 통과한다. 코어는 이 값의
   * 의미를 해석하지 않고 저장·부착만 한다(P1-A section 3.2 "중계·저장만" 경계).
   * 하위 호환: 관리 토큰 없이 발급된 기존 v2 메타는 undefined — 그 어댑터로의
   * 상태변경 프록시는 명시 실패(I6 424, 무토큰 부착 금지). 재enroll 로 채워진다.
   * 값은 대시보드 목록·로그·에러 어디에도 노출하지 않는다.
   */
  adminToken?: string;
}

export type AdapterTokenRequestStatus = "pending" | "approved" | "rejected";

export interface AdapterTokenRequest {
  requestId: string;
  adapterId: string;
  displayName: string;
  description: string;
  endpoint: string;
  remoteAddr: string;
  status: AdapterTokenRequestStatus;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  /**
   * 요청자가 필요하다고 밝힌 권한(CR-0). 표시 전용 — 서버는 이 값으로 권한을 주지
   * 않는다(클라이언트가 스스로 full 을 얻지 못하게). 생략한 요청에는 칸이 없다.
   */
  requestedScope?: TokenScope;
}

interface StoredAdapterTokenRequest extends AdapterTokenRequest {
  pickupSecretHash: string;
  /**
   * 승인 시 발급 메타로 옮길 봇 관리 토큰 임시 보관(P1-통합 I2). pickupSecretHash
   * 와 같은 톤으로 요청에만 저장되고, publicRequest 가 벗겨 대시보드 목록에 안
   * 실린다. 승인(수동 approve + D6 자동 승인) 시점에 tokenMeta 로 전파된다.
   */
  adminToken?: string;
  /**
   * 승인된 요청의 토큰을 요청자가 처음 회수한 시각. 이 시각부터 보관 기간이 지나면 요청을
   * 지운다(adapter-enroll-limits.ts). 대시보드 목록에는 싣지 않는다.
   */
  pickedUpAt?: string;
}

export interface AdapterTokenRequestInput {
  adapterId: string;
  displayName?: string;
  description?: string;
  endpoint?: string;
  remoteAddr?: string;
  /**
   * 이미 발급된 어댑터 API 토큰. 이 토큰이 같은 adapterId 로 검증되면, endpoint
   * 메타가 없던 옛 발급분도 자기 소유를 증명한 것으로 보고 재등록을 자동 승인한다.
   * 값은 요청 판정에만 쓰고 저장·응답·목록에 남기지 않는다.
   */
  existingToken?: string;
  /**
   * 어댑터가 코어에 등록하는 로컬 관리 토큰(P1-통합 I1). 봇 enroll 요청 body 에서
   * 읽어 실린다. 승인 흐름을 관통해 tokenMeta[adapterId].adminToken 에 도달한다.
   */
  adminToken?: string;
  /** 요청자가 필요하다고 밝힌 권한. 저장·표시만 하고 권한 부여에는 쓰지 않는다. */
  requestedScope?: TokenScope;
}

export interface AdapterTokenRequestResult {
  request: AdapterTokenRequest;
  pickupSecret: string;
}

export interface AdapterTokenPickupResult {
  status: AdapterTokenRequestStatus;
  request: AdapterTokenRequest;
  token?: string;
}

/**
 * 발급 토큰의 권한 요약. legacyScope = 메타에 scope 칸이 없는 옛 토큰(유효 권한 full).
 * 대시보드가 승인 전에 기존 권한과 옛 토큰 여부를 보여 주는 재료다(SA-2).
 */
export interface IssuedTokenScope {
  scope: TokenScope;
  legacyScope: boolean;
}

export interface IssuedAdapterToken extends IssuedTokenScope {
  adapterId: string;
  issuedAt: string | null;
}

/**
 * 디스크 보관 양식.
 * v1 = { version: 1, tokens }
 * v2 = { version: 2, tokens, tokenMeta, requests }
 */
interface TokenFileShape {
  version: 1 | 2;
  tokens: Record<string, string>;
  tokenMeta?: Record<string, TokenMetadata>;
  requests?: Record<string, StoredAdapterTokenRequest>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function trimBounded(value: string | undefined, max: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("base64url");
}

function secretMatches(storedHash: string, candidate: string): boolean {
  const a = Buffer.from(storedHash);
  const b = Buffer.from(hashSecret(candidate));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function publicRequest(req: StoredAdapterTokenRequest): AdapterTokenRequest {
  // pickupSecretHash 와 adminToken(봇 관리 토큰)은 대시보드 목록에 노출하지 않는다.
  const {
    pickupSecretHash: _pickupSecretHash,
    adminToken: _adminToken,
    pickedUpAt: _pickedUpAt,
    ...rest
  } = req;
  return rest;
}

function normalizeAdapterId(adapterId: string): string {
  const id = adapterId.trim();
  if (!ID_PATTERN.test(id)) {
    throw new Error(`어댑터 토큰 요청 실패: adapterId 양식 오류 (${ID_PATTERN.source})`);
  }
  return id;
}

/**
 * SSE/API 토큰 보관소.
 *
 * issueToken(adapterId) -> 토큰 발급(멱등) + 파일 영속.
 * verifyToken(token) -> 유효 시 adapterId, 무효 시 null.
 * createTokenRequest(...) -> 대시보드 승인 전 pending 요청 생성.
 */
export class SseTokenStore {
  private readonly filePath: string;
  /** adapterId -> token. */
  private byAdapter = new Map<string, string>();
  /** token -> adapterId (검증 역인덱스). */
  private byToken = new Map<string, string>();
  /** adapterId -> 발급 메타. */
  private tokenMeta = new Map<string, TokenMetadata>();
  /** requestId -> pending/approved/rejected 요청. */
  private requests = new Map<string, StoredAdapterTokenRequest>();
  /** 토큰 회수·교체·권한 변경 통지 대상(SA-6). 열린 SSE 연결마다 하나씩 등록된다. */
  private readonly changeListeners = new Set<TokenChangeListener>();

  /**
   * filePath = 토큰 파일. 필수 — 부팅은 index.ts 가 env SSE_TOKEN_PATH 로 정한 값, 테스트는 임시 파일.
   * enrollLimits = 등록 요청 상한. 운영은 ADAPTER_ENROLL_LIMITS, 테스트는 작은 값을 넘겨 경계를 검증한다.
   */
  constructor(
    filePath: string,
    private readonly enrollLimits: AdapterEnrollLimits = ADAPTER_ENROLL_LIMITS,
  ) {
    this.filePath = filePath;
    this.load();
    this.pruneExpiredRequests();
  }

  /**
   * adapterId 에 토큰을 발급한다. 이미 발급된 adapterId 면 같은 토큰을 회신(멱등).
   * 빈/양식 오류 adapterId 는 loud throw — silent 통과 금지.
   *
   * endpoint 를 주면 발급 메타에 기록한다. 이미 발급된 어댑터를 다시 부를 때
   * (멱등 반환) endpoint 를 주면 메타의
   * endpoint 를 갱신해 둔다 — 승인 시점의 요청 endpoint 를 최신으로 남기기 위함.
   *
   * adminToken 을 주면 발급 메타에 봇 관리 토큰을 기록한다(P1-통합 I2). endpoint
   * 갱신과 같은 톤으로, 멱등 반환 경로에서도 관리 토큰이 바뀌었으면 새 값으로
   * 덮어쓴다 — 봇 관리 토큰 재생성 후 재enroll 시 stale 을 푸는 핵심(spec § 약점
   * I-3). 관리 토큰을 안 주면(undefined) 기존 값을 건드리지 않는다.
   */
  issueToken(adapterId: string, endpoint?: string, adminToken?: string, scope?: TokenScope): string {
    if (scope !== undefined && !isTokenScope(scope)) throw new Error("Invalid token scope");
    const id = normalizeAdapterId(adapterId);
    const existing = this.byAdapter.get(id);
    if (existing !== undefined) {
      const meta = this.tokenMeta.get(id);
      const nextEndpoint =
        endpoint !== undefined && endpoint.length > 0 ? endpoint : meta?.endpoint;
      const nextAdminToken =
        adminToken !== undefined && adminToken.length > 0
          ? adminToken
          : meta?.adminToken;
      const nextScope = scope ?? meta?.scope;
      // scope 를 명시한 재발급(공유 승인 등)은 같은 토큰을 쓰는 모든 연결의 권한을 바꾼다.
      const scopeChanged = nextScope !== meta?.scope;
      if (meta) {
        if (nextEndpoint !== meta.endpoint || nextAdminToken !== meta.adminToken || scopeChanged) {
          const updated: TokenMetadata = { ...meta };
          if (nextEndpoint !== undefined) updated.endpoint = nextEndpoint;
          if (nextAdminToken !== undefined) updated.adminToken = nextAdminToken;
          if (nextScope !== undefined) updated.scope = nextScope;
          this.tokenMeta.set(id, updated);
          this.persist();
        }
      } else if (nextEndpoint !== undefined || nextAdminToken !== undefined || nextScope !== undefined) {
        // 하위호환/복원 상태에서 tokens 는 남고 tokenMeta 만 비어 있을 수 있다.
        // 이때 재issue 경로가 endpoint/adminToken 메타를 새로 만들어 프록시 424 를 복구한다.
        const restored: TokenMetadata = { issuedAt: nowIso() };
        if (nextEndpoint !== undefined) restored.endpoint = nextEndpoint;
        if (nextAdminToken !== undefined) restored.adminToken = nextAdminToken;
        if (nextScope !== undefined) restored.scope = nextScope;
        this.tokenMeta.set(id, restored);
        this.persist();
      }
      if (scopeChanged) this.notifyTokenChange({ adapterId: id, kind: "scope-changed" });
      return existing;
    }
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    this.byAdapter.set(id, token);
    this.byToken.set(token, id);
    const meta: TokenMetadata = { issuedAt: nowIso() };
    if (scope !== undefined) meta.scope = scope;
    if (endpoint !== undefined && endpoint.length > 0) {
      meta.endpoint = endpoint;
    }
    if (adminToken !== undefined && adminToken.length > 0) {
      meta.adminToken = adminToken;
    }
    this.tokenMeta.set(id, meta);
    this.persist();
    return token;
  }

  getTokenScope(adapterId: string): TokenScope {
    return this.tokenMeta.get(normalizeAdapterId(adapterId))?.scope ?? LEGACY_TOKEN_SCOPE;
  }

  /**
   * 발급된 토큰의 권한 요약. 토큰이 없는 어댑터는 null — 새 어댑터 요청과 기존 어댑터
   * 재등록 요청을 구분하는 근거다. 토큰 값은 반환하지 않는다.
   */
  getIssuedTokenScope(adapterId: string): IssuedTokenScope | null {
    const id = normalizeAdapterId(adapterId);
    return this.byAdapter.has(id) ? this.scopeSummary(id) : null;
  }

  setTokenScope(adapterId: string, scope: TokenScope): boolean {
    if (!isTokenScope(scope)) throw new Error("Invalid token scope");
    const id = normalizeAdapterId(adapterId);
    if (!this.byAdapter.has(id)) return false;
    const meta = this.tokenMeta.get(id) ?? { issuedAt: nowIso() };
    this.tokenMeta.set(id, { ...meta, scope });
    this.persist();
    this.notifyTokenChange({ adapterId: id, kind: "scope-changed" });
    return true;
  }

  /**
   * 토큰 회수·교체·권한 변경 통지를 구독한다(SA-6). 반환한 함수를 부르면 해제된다.
   * 통지는 변경이 파일에 저장된 뒤 동기로 전달되며, 받는 쪽이 토큰을 다시 검증한다.
   */
  onTokenChange(listener: TokenChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /**
   * 대상 어댑터가 코어에 등록한 로컬 관리 토큰을 반환한다(P1-통합 I3). 코어→봇
   * 프록시 hop 이 읽는 **유일한 접근자**. 발급된 관리 토큰이 있으면 값, 없으면
   * null. null 은 프록시가 "관리 토큰 미등록"으로 판정해 봇에 보내기 전 명시 실패
   * (I6 424)하는 신호다 — 무토큰 부착으로 세탁하지 않는다.
   */
  getAdapterAdminToken(adapterId: string): string | null {
    const id = normalizeAdapterId(adapterId);
    return this.tokenMeta.get(id)?.adminToken ?? null;
  }

  /**
   * 토큰을 검증한다. 유효하면 그 토큰의 adapterId, 아니면 null.
   * null 은 호출자가 401 로 변환하는 신호다(silent 통과로 쓰지 않는다).
   */
  verifyToken(token: string): string | null {
    if (typeof token !== "string" || token.length === 0) {
      return null;
    }
    return this.byToken.get(token) ?? null;
  }

  /** 발급된 토큰 목록(권한 요약 포함). 토큰 값은 절대 반환하지 않는다. */
  listIssuedTokens(): IssuedAdapterToken[] {
    return Array.from(this.byAdapter.keys())
      .sort((a, b) => a.localeCompare(b))
      .map((adapterId) => ({
        adapterId,
        issuedAt: this.tokenMeta.get(adapterId)?.issuedAt ?? null,
        ...this.scopeSummary(adapterId),
      }));
  }

  /** adapterId 토큰을 회수한다. dashboard 토큰 차단은 호출 라우트가 맡는다. */
  removeToken(adapterId: string): boolean {
    const id = normalizeAdapterId(adapterId);
    const token = this.byAdapter.get(id);
    if (token === undefined) return false;
    this.byAdapter.delete(id);
    this.byToken.delete(token);
    this.tokenMeta.delete(id);
    const ts = nowIso();
    for (const request of this.requests.values()) {
      if (request.adapterId !== id || request.status === "rejected") continue;
      request.status = "rejected";
      request.updatedAt = ts;
      request.rejectedAt = ts;
    }
    this.persist();
    this.notifyTokenChange({ adapterId: id, kind: "revoked" });
    return true;
  }

  /**
   * 어댑터 토큰 승인 요청을 만든다. 반환된 pickupSecret 은 요청자에게 한 번만 전달한다.
   * 같은 adapterId 가 여러 번 요청할 수 있지만 각 요청은 requestId/pickupSecret 으로
   * 분리된다. 재시도 루프는 같은 requestId 를 polling 해야 대기열이 불어나지 않는다.
   *
   * 재등록 자동 승인은 같은 adapterId의 기존 토큰 소유를 증명한 경우만 허용한다.
   * 공개된 endpoint 일치만으로 승인하면 타인의 full 토큰을 회수할 수 있다.
   * 자동 승인은 requestedScope 를 무시한다 — pickup 이 scope 없이 issueToken 을 불러
   * 기존 권한(옛 토큰이면 full)을 그대로 유지한다.
   */
  createTokenRequest(input: AdapterTokenRequestInput): AdapterTokenRequestResult {
    this.pruneExpiredRequests();
    const adapterId = normalizeAdapterId(input.adapterId);
    const requestedScope = input.requestedScope;
    if (requestedScope !== undefined && !isTokenScope(requestedScope)) {
      throw new Error(
        `어댑터 토큰 요청 실패: requestedScope 는 ${TOKEN_SCOPES.join(", ")} 중 하나여야 한다`,
      );
    }
    // 기존 토큰 소유 증명만 자동 승인한다. 입력 토큰 값 자체는 저장하지 않는다.
    const existingToken = trimBounded(input.existingToken, 4096);
    const ownsExistingToken =
      existingToken.length > 0 && this.verifyToken(existingToken) === adapterId;
    const autoApprove = this.byAdapter.has(adapterId) && ownsExistingToken;
    const remoteAddr = trimBounded(input.remoteAddr, 80);
    // 무인증 요청은 같은 adapterId 의 pending 을 건드리지 못하고(409), 주소별·전체 pending 상한도 지킨다.
    if (!autoApprove) {
      assertEnrollAdmission(this.requests.values(), adapterId, remoteAddr, this.enrollLimits);
    }

    const requestId = `atr_${randomBytes(REQUEST_ID_BYTES).toString("base64url")}`;
    const pickupSecret = randomBytes(PICKUP_SECRET_BYTES).toString("base64url");
    const ts = nowIso();
    const endpoint = trimBounded(input.endpoint, 200);
    if (autoApprove) {
      // 소유를 증명한 재등록만 같은 adapterId 의 남은 pending 요청을 대기열에서 정리한다.
      for (const existing of this.requests.values()) {
        if (existing.adapterId !== adapterId || existing.status !== "pending") continue;
        existing.status = "rejected";
        existing.updatedAt = ts;
        existing.rejectedAt = existing.rejectedAt ?? ts;
        existing.lastSeenAt = ts;
      }
    }

    const adminToken = trimBounded(input.adminToken, 4096);
    const request: StoredAdapterTokenRequest = {
      requestId,
      adapterId,
      displayName: trimBounded(input.displayName, 80) || adapterId,
      description: trimBounded(input.description, 200),
      endpoint,
      remoteAddr,
      status: autoApprove ? "approved" : "pending",
      createdAt: ts,
      updatedAt: ts,
      lastSeenAt: ts,
      approvedAt: autoApprove ? ts : null,
      rejectedAt: null,
      pickupSecretHash: hashSecret(pickupSecret),
      // 봇 관리 토큰을 요청에 임시 보관 — 승인(수동/자동) 시 발급 메타로 전파(I2).
      // 빈 값이면 필드를 두지 않아 하위 호환 메타와 구분한다.
      ...(adminToken.length > 0 ? { adminToken } : {}),
      // 표시 전용. 승인 권한의 기본값으로도 쓰지 않는다.
      ...(requestedScope !== undefined ? { requestedScope } : {}),
    };
    this.requests.set(requestId, request);
    // D6 자동 승인 흐름은 pickupApprovedToken 이 issueToken 을 부를 때 관리 토큰이
    // 메타로 전파된다(request.adminToken 을 그때 전달). 여기서 즉시 발급하지 않는
    // 이유는 기존 흐름(자동 승인도 pickup 시점 발급)을 그대로 따르기 위함이다.
    this.persist();
    return { request: publicRequest(request), pickupSecret };
  }

  /** 요청 목록. 기본은 전체, status 를 주면 해당 상태만 반환한다. */
  listTokenRequests(status?: AdapterTokenRequestStatus): AdapterTokenRequest[] {
    this.pruneExpiredRequests();
    return Array.from(this.requests.values())
      .filter((r) => status === undefined || r.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(publicRequest);
  }

  getTokenRequest(requestId: string): AdapterTokenRequest | null {
    this.pruneExpiredRequests();
    const req = this.requests.get(requestId);
    return req ? publicRequest(req) : null;
  }

  /**
   * 요청을 승인한다. requestedScope 는 여기서 쓰지 않는다(표시 전용).
   *
   * scope 생략: 새 어댑터는 NEW_ADAPTER_DEFAULT_SCOPE, 토큰이 이미 있는 어댑터는 현재
   * 권한 유지(옛 토큰이면 full 그대로). scope 지정: 어댑터당 토큰이 하나이므로 그 토큰을
   * 쓰는 모든 연결의 권한이 된다.
   *
   * existingToken(토큰이 이미 있는 어댑터 전용, 생략 = share): share 는 기존 토큰을
   * 요청자에게 그대로 전달하고, rotate 는 새 토큰 발급 + 옛 토큰 즉시 무효 + 같은
   * 어댑터의 다른 approved 요청 rejected(옛 요청자가 새 토큰을 pickup 하지 못하게)다.
   * 토큰이 없는 어댑터에 existingToken 을 주면 관리자가 확인한 목록과 실제 상태가 어긋난
   * 것이므로 throw 한다. 검증은 요청을 바꾸기 전에 끝낸다.
   */
  approveTokenRequest(
    requestId: string,
    scope?: TokenScope,
    existingToken?: ExistingTokenChoice,
  ): AdapterTokenRequest | null {
    if (scope !== undefined && !isTokenScope(scope)) throw new Error("Invalid token scope");
    if (existingToken !== undefined && !isExistingTokenChoice(existingToken)) {
      throw new Error(`existingToken 은 ${EXISTING_TOKEN_CHOICES.join(" / ")} 만 지정할 수 있다`);
    }
    this.pruneExpiredRequests();
    const req = this.requests.get(requestId);
    if (!req) return null;
    if (req.status === "rejected") {
      throw new Error("거절된 어댑터 토큰 요청은 승인할 수 없다");
    }
    const hasToken = this.byAdapter.has(req.adapterId);
    if (existingToken !== undefined && !hasToken) {
      throw new Error(
        `어댑터 ${req.adapterId} 에 발급된 토큰이 없어 existingToken(${existingToken})을 적용할 수 없다 — 목록을 새로 읽고 새 어댑터로 승인하라`,
      );
    }
    const ts = nowIso();
    req.status = "approved";
    req.updatedAt = ts;
    req.approvedAt = req.approvedAt ?? ts;
    req.lastSeenAt = ts;
    if (existingToken === "rotate") {
      this.rotateToken(req, scope ?? this.getTokenScope(req.adapterId), ts);
      this.requests.set(requestId, req);
      this.persist();
      this.notifyTokenChange({ adapterId: req.adapterId, kind: "rotated" });
      return publicRequest(req);
    }
    // share(또는 새 어댑터): 승인한 요청의 endpoint와 관리 토큰을 메타에 기록한다.
    // 요청에 보관된 관리 토큰(I2)도 함께 발급 메타로 전파한다.
    this.issueToken(req.adapterId, req.endpoint || undefined, req.adminToken || undefined,
      scope ?? (hasToken ? undefined : NEW_ADAPTER_DEFAULT_SCOPE));
    this.requests.set(requestId, req);
    this.persist();
    return publicRequest(req);
  }

  rejectTokenRequest(requestId: string): AdapterTokenRequest | null {
    this.pruneExpiredRequests();
    const req = this.requests.get(requestId);
    if (!req) return null;
    const ts = nowIso();
    req.status = "rejected";
    req.updatedAt = ts;
    req.rejectedAt = req.rejectedAt ?? ts;
    req.lastSeenAt = ts;
    this.requests.set(requestId, req);
    this.persist();
    return publicRequest(req);
  }

  /**
   * 승인된 요청의 토큰을 pickupSecret 으로 회수한다.
   * - request 없음(수명이 지나 지워진 요청 포함) / secret 불일치 = null
   * - pending/rejected = 상태만 반환
   * - approved = token 포함 반환
   */
  pickupApprovedToken(
    requestId: string,
    pickupSecret: string,
  ): AdapterTokenPickupResult | null {
    this.pruneExpiredRequests();
    const req = this.requests.get(requestId);
    if (!req) return null;
    if (!secretMatches(req.pickupSecretHash, pickupSecret)) return null;
    req.lastSeenAt = nowIso();
    req.updatedAt = req.updatedAt || req.lastSeenAt;
    this.requests.set(requestId, req);
    this.persist();

    const request = publicRequest(req);
    if (req.status !== "approved") {
      return { status: req.status, request };
    }
    if (!this.byAdapter.has(req.adapterId)) return null;
    // 이미 발급된 토큰이 있어도 관리 토큰이 바뀌었을 수 있으니 issueToken 을 부른다
    // (멱등 반환 경로가 관리 토큰을 갱신 — stale 방지 I-3). 미발급이면 새로 발급한다.
    const token = this.issueToken(
      req.adapterId,
      req.endpoint || undefined,
      req.adminToken || undefined,
    );
    if (req.pickedUpAt === undefined) {
      // 첫 회수 시각부터 보관 기간을 센다(adapter-enroll-limits.ts pickedUpRetentionMs).
      req.pickedUpAt = req.lastSeenAt;
      this.persist();
    }
    return { status: "approved", request, token };
  }

  /**
   * approve 의 rotate 전용 토큰 교체. 옛 토큰은 역인덱스에서 지워 즉시 검증에 실패한다.
   * 발급 메타는 새 발급 시각과 명시 scope 로 다시 쓴다 — 옛 토큰(scope 칸 없음)을 교체해도
   * 새 토큰에는 유효 권한(full)을 명시해 기록한다. endpoint·관리 토큰은 승인한 요청의 값만
   * 쓰고 끊어 낸 옛 연결의 값을 잇지 않는다. 이어 쓰면 요청자가 정한 새 endpoint 로 옛
   * 어댑터의 관리 토큰을 붙여 보내게 된다. 요청에 없으면 칸이 비고, 코어→어댑터 프록시는
   * 관리 토큰 미등록으로 명시 실패한다(424). 저장과 통지는 호출자가 한 번에 한다.
   */
  private rotateToken(req: StoredAdapterTokenRequest, scope: TokenScope, ts: string): void {
    const id = req.adapterId;
    const oldToken = this.byAdapter.get(id);
    if (oldToken === undefined) {
      throw new Error(`어댑터 ${id} 에 교체할 토큰이 없다`);
    }
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    this.byToken.delete(oldToken);
    this.byAdapter.set(id, token);
    this.byToken.set(token, id);
    const meta: TokenMetadata = { issuedAt: ts, scope };
    if (req.endpoint) meta.endpoint = req.endpoint;
    if (req.adminToken) meta.adminToken = req.adminToken;
    this.tokenMeta.set(id, meta);
    for (const other of this.requests.values()) {
      if (other.adapterId !== id || other.requestId === req.requestId || other.status !== "approved") {
        continue;
      }
      other.status = "rejected";
      other.updatedAt = ts;
      other.rejectedAt = ts;
    }
  }

  /**
   * 수명이 지난 pending·rejected 요청을 지운다(adapter-enroll-limits.ts). 요청을 읽고 쓰는
   * 모든 공개 메서드가 먼저 부른다. 지운 것이 있을 때만 파일에 다시 쓴다.
   */
  private pruneExpiredRequests(): void {
    if (pruneExpiredEnrollRequests(this.requests, Date.now(), this.enrollLimits)) this.persist();
  }

  /** 발급된 어댑터의 권한 요약. 호출자는 토큰이 있는 어댑터에만 부른다. */
  private scopeSummary(id: string): IssuedTokenScope {
    const scope = this.tokenMeta.get(id)?.scope;
    return scope === undefined
      ? { scope: LEGACY_TOKEN_SCOPE, legacyScope: true }
      : { scope, legacyScope: false };
  }

  /**
   * 변경 통지. 구독자 하나의 실패가 다른 구독자와 이미 저장된 변경을 깨지 않게 격리하고,
   * 실패는 식별자(adapterId·kind)만 경고로 남긴다(토큰 값은 넣지 않는다).
   */
  private notifyTokenChange(change: TokenChange): void {
    for (const listener of [...this.changeListeners]) {
      try {
        listener(change);
      } catch (err) {
        console.warn(
          `[sse-tokens] 토큰 변경 통지 실패 — adapterId=${change.adapterId} kind=${change.kind}: ${(err as Error).message}`,
        );
      }
    }
  }

  /** 디스크에서 매핑을 로드한다(파일 부재 = 빈 보관소). */
  private load(): void {
    if (!existsSync(this.filePath)) {
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch (err) {
      throw new Error(
        `SSE 토큰 파일 읽기 실패: ${this.filePath} — ${(err as Error).message}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `SSE 토큰 파일 JSON 파싱 실패: ${this.filePath} — ${(err as Error).message}`,
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as TokenFileShape).tokens !== "object" ||
      (parsed as TokenFileShape).tokens === null
    ) {
      throw new Error(`SSE 토큰 파일 형식 오류: ${this.filePath} — tokens 객체 필요`);
    }
    const shape = parsed as TokenFileShape;
    for (const [adapterId, token] of Object.entries(shape.tokens)) {
      if (typeof token !== "string" || token.length === 0) continue;
      if (!ID_PATTERN.test(adapterId)) continue;
      this.byAdapter.set(adapterId, token);
      this.byToken.set(token, adapterId);
    }
    for (const [adapterId, meta] of Object.entries(shape.tokenMeta ?? {})) {
      if (!ID_PATTERN.test(adapterId)) continue;
      if (meta?.scope !== undefined && !isTokenScope(meta.scope)) {
        throw new Error("SSE token metadata contains an invalid scope");
      }
      if (meta?.scope !== undefined && !(typeof meta.issuedAt === "string" && meta.issuedAt.length > 0)) {
        throw new Error("SSE token scope metadata is missing issuedAt");
      }
      if (typeof meta?.issuedAt === "string" && meta.issuedAt.length > 0) {
        const restored: TokenMetadata = { issuedAt: meta.issuedAt };
        if (meta.scope !== undefined) restored.scope = meta.scope;
        // 하위 호환: endpoint 없는 기존 v2 메타는 undefined 로 로드(자동 승인 불가).
        if (typeof meta.endpoint === "string" && meta.endpoint.length > 0) {
          restored.endpoint = meta.endpoint;
        }
        // 하위 호환: 관리 토큰 없는 기존 v2 메타는 undefined 로 로드(상태변경 프록시
        // I6 424 대상). 있으면 그대로 복원해 코어→봇 hop 부착에 쓴다(I2).
        if (typeof meta.adminToken === "string" && meta.adminToken.length > 0) {
          restored.adminToken = meta.adminToken;
        }
        this.tokenMeta.set(adapterId, restored);
      }
    }
    for (const [requestId, request] of Object.entries(shape.requests ?? {})) {
      if (
        typeof requestId !== "string" ||
        !requestId.startsWith("atr_") ||
        typeof request !== "object" ||
        request === null ||
        !ID_PATTERN.test(request.adapterId) ||
        typeof request.pickupSecretHash !== "string"
      ) {
        continue;
      }
      if (request.requestedScope !== undefined && !isTokenScope(request.requestedScope)) {
        throw new Error("SSE token request contains an invalid requestedScope");
      }
      this.requests.set(requestId, request);
    }
  }

  /** 현재 매핑을 디스크에 atomic 저장(tmp 쓰기 -> rename) + 권한 600 — sse-token-file.ts. */
  private persist(): void {
    const shape: TokenFileShape = {
      version: 2,
      tokens: Object.fromEntries(this.byAdapter),
      tokenMeta: Object.fromEntries(this.tokenMeta),
      requests: Object.fromEntries(this.requests),
    };
    writeTokenFileAtomic(this.filePath, `${JSON.stringify(shape, null, 2)}\n`);
  }
}
