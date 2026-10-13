/**
 * App Federation Manifest Schema (Phase 5.5 / spec section 4)
 *
 * 본 모듈 코어가 어댑터를 만나는 *경계 약속*. 각 어댑터 디렉토리에
 * `app.manifest.json` 이 본 schema 와 정합 필수.
 *
 * 권위: docs/decisions/2026-05-18-app-federation-spec.md section 4
 */

/** 본 모듈 지원 manifestVersion (현 = 1). 미래 v2 도입 시 증가. */
export const SUPPORTED_MANIFEST_VERSION = 1;

/** id 정규식 (spec section 4.1). */
export const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** 본 모듈 허용 endpoint 호스트 목록 (외부 노출 차단 정신). */
const ALLOWED_ENDPOINT_HOSTS = ["127.0.0.1", "localhost"] as const;

/** action returns 타입 (spec section 5.4). */
export type ActionReturns = "toast" | "enum" | "redirect";

/** 매니페스트 actions[*] 항목. */
export interface AppManifestAction {
  id: string;
  label: string;
  method: "GET" | "POST";
  path: string;
  returns: ActionReturns;
  needsConfirm?: boolean;
}

/** 매니페스트 settings 묶음 (spec section 4.1). */
export interface AppManifestSettings {
  schemaPath: string;
  getPath: string;
  putPath: string;
}

/** App 매니페스트 본체 (spec section 4.1 + 4.2). */
export interface AppManifest {
  /** 필수 필드 */
  id: string;
  name: string;
  version: string;
  manifestVersion: number;
  endpoint: string;
  health: string;
  settings: AppManifestSettings;

  /** 선택 필드 (spec section 4.2) */
  actions?: AppManifestAction[];
  icon?: string;
  description?: string;
  docs?: string;
  tags?: string[];
}

/**
 * 매니페스트 endpoint 검증 — `http://127.0.0.1:포트` 또는
 * `http://localhost:포트` 만 허용. 외부 호스트 차단 정신
 * (spec section 8.1).
 */
export function isAllowedEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (!url.port) return false;
  return ALLOWED_ENDPOINT_HOSTS.includes(
    url.hostname as (typeof ALLOWED_ENDPOINT_HOSTS)[number],
  );
}

/**
 * 매니페스트 action returns 값 검증.
 */
export function isValidActionReturns(value: unknown): value is ActionReturns {
  return value === "toast" || value === "enum" || value === "redirect";
}
