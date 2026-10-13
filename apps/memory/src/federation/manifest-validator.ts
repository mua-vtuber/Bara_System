/**
 * App Federation Manifest Validator (Phase 5.5 / spec section 4.3)
 *
 * `app.manifest.json` 을 본 모듈이 자체 검증. 외부 ajv 미사용 — 본 plan 정신
 * 정합 (외부 의존성 ↓ → 외부 사용자 신뢰).
 */

import {
  type AppManifest,
  type AppManifestAction,
  ID_PATTERN,
  SUPPORTED_MANIFEST_VERSION,
  isAllowedEndpoint,
  isValidActionReturns,
} from "./manifest-schema";

/** 검증 결과 타입. errors 항목 = 어떤 경로 / 어떤 항목 실패인지 명시. */
export type ManifestValidationResult =
  | { ok: true; manifest: AppManifest }
  | { ok: false; errors: ManifestValidationError[] };

export interface ManifestValidationError {
  path: string;
  message: string;
}

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function validateAction(
  action: unknown,
  index: number,
  errors: ManifestValidationError[],
): action is AppManifestAction {
  const basePath = `actions[${index}]`;
  if (typeof action !== "object" || action === null) {
    errors.push({ path: basePath, message: "action 항목 = 객체 필요" });
    return false;
  }
  const a = action as Record<string, unknown>;
  let ok = true;

  if (!isString(a.id)) {
    errors.push({ path: `${basePath}.id`, message: "string 필요" });
    ok = false;
  }
  if (!isString(a.label)) {
    errors.push({ path: `${basePath}.label`, message: "string 필요" });
    ok = false;
  }
  if (a.method !== "GET" && a.method !== "POST") {
    errors.push({
      path: `${basePath}.method`,
      message: "'GET' 또는 'POST' 필요",
    });
    ok = false;
  }
  if (!isString(a.path) || !(a.path as string).startsWith("/")) {
    errors.push({
      path: `${basePath}.path`,
      message: "'/' 시작 string 필요",
    });
    ok = false;
  }
  if (!isValidActionReturns(a.returns)) {
    errors.push({
      path: `${basePath}.returns`,
      message: "'toast' / 'enum' / 'redirect' 중 하나 필요",
    });
    ok = false;
  }
  if (a.needsConfirm !== undefined && typeof a.needsConfirm !== "boolean") {
    errors.push({
      path: `${basePath}.needsConfirm`,
      message: "boolean 필요 (선택 필드)",
    });
    ok = false;
  }
  return ok;
}

/**
 * 매니페스트 JSON 검증. 입력 = 본 모듈 외부 (파일 파싱 산출) =
 * `unknown` 타입. 본 함수 통과 시 `AppManifest` 로 narrowing.
 */
export function validateManifest(input: unknown): ManifestValidationResult {
  const errors: ManifestValidationError[] = [];

  if (typeof input !== "object" || input === null) {
    return {
      ok: false,
      errors: [{ path: "", message: "매니페스트 = 객체 필요" }],
    };
  }
  const m = input as Record<string, unknown>;

  // id
  if (!isString(m.id)) {
    errors.push({ path: "id", message: "string 필요" });
  } else if (!ID_PATTERN.test(m.id)) {
    errors.push({
      path: "id",
      message: `정규식 ${ID_PATTERN.source} 와 미일치`,
    });
  }

  // name
  if (!isString(m.name)) {
    errors.push({ path: "name", message: "string 필요" });
  }

  // version
  if (!isString(m.version)) {
    errors.push({ path: "version", message: "string 필요" });
  }

  // manifestVersion
  if (!isInteger(m.manifestVersion)) {
    errors.push({ path: "manifestVersion", message: "integer 필요" });
  } else if (m.manifestVersion < 1) {
    errors.push({
      path: "manifestVersion",
      message: "1 이상 필요",
    });
  } else if (m.manifestVersion > SUPPORTED_MANIFEST_VERSION) {
    errors.push({
      path: "manifestVersion",
      message: `본 모듈 지원 버전 ${SUPPORTED_MANIFEST_VERSION} 초과 — 본 모듈 업그레이드 필요`,
    });
  }

  // endpoint
  if (!isString(m.endpoint)) {
    errors.push({ path: "endpoint", message: "string 필요" });
  } else if (!isAllowedEndpoint(m.endpoint)) {
    errors.push({
      path: "endpoint",
      message:
        "127.0.0.1 또는 localhost 호스트만 허용 (외부 노출 차단). 형식 = http://127.0.0.1:포트",
    });
  }

  // health
  if (!isString(m.health) || !(m.health as string).startsWith("/")) {
    errors.push({
      path: "health",
      message: "'/' 시작 string 필요",
    });
  }

  // settings
  if (typeof m.settings !== "object" || m.settings === null) {
    errors.push({ path: "settings", message: "객체 필요" });
  } else {
    const s = m.settings as Record<string, unknown>;
    if (!isString(s.schemaPath) || !(s.schemaPath as string).startsWith("/")) {
      errors.push({
        path: "settings.schemaPath",
        message: "'/' 시작 string 필요",
      });
    }
    if (!isString(s.getPath) || !(s.getPath as string).startsWith("/")) {
      errors.push({
        path: "settings.getPath",
        message: "'/' 시작 string 필요",
      });
    }
    if (!isString(s.putPath) || !(s.putPath as string).startsWith("/")) {
      errors.push({
        path: "settings.putPath",
        message: "'/' 시작 string 필요",
      });
    }
  }

  // actions (선택)
  if (m.actions !== undefined) {
    if (!Array.isArray(m.actions)) {
      errors.push({ path: "actions", message: "배열 필요 (선택 필드)" });
    } else {
      const ids = new Set<string>();
      m.actions.forEach((action, i) => {
        if (validateAction(action, i, errors)) {
          const id = (action as AppManifestAction).id;
          if (ids.has(id)) {
            errors.push({
              path: `actions[${i}].id`,
              message: `중복 id '${id}'`,
            });
          }
          ids.add(id);
        }
      });
    }
  }

  // 선택 필드 type 가드 (단순 타입)
  for (const field of ["icon", "description", "docs"] as const) {
    if (m[field] !== undefined && typeof m[field] !== "string") {
      errors.push({ path: field, message: "string 필요 (선택 필드)" });
    }
  }
  if (m.tags !== undefined) {
    if (!Array.isArray(m.tags) || !m.tags.every((t) => typeof t === "string")) {
      errors.push({
        path: "tags",
        message: "string 배열 필요 (선택 필드)",
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, manifest: m as unknown as AppManifest };
}
