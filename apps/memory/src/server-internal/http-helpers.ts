/**
 * server-internal/http-helpers.ts — HTTP 공통 헬퍼
 *
 * 순수 함수 / 상수 모음. buildMemoryApi 라우트 핸들러가 공통으로 사용한다.
 * Hono 의존 최소화: `err`만 Context 를 받는다.
 */

import type { Context } from "hono";
import { resolve, sep } from "node:path";

// ── 공용 상수 ────────────────────────────────────────────────────────────

/**
 * sha256 hex 양식 — 64 자 소문자 hex 한 정. 대문자 / `../` / 비 hex 모두 어긋남.
 *
 * 단일 출처: assets 라우트(`/assets/:sha`·`/thumbs/:sha`)의 양식 검증과
 * auth-gate 의 이미지 경로 query-token 폴백 판별이 같은 양식을 써야 한다.
 * 두 곳이 각자 리터럴을 두면 한쪽만 바뀔 때 폴백이 새거나 막히므로 여기 한 곳을
 * 권위로 둔다. auth-gate 는 경로 정규식을 이 `source` 로 조립한다.
 */
export const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

// ── 값 검증 헬퍼 ─────────────────────────────────────────────────────────

export function isPositiveString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function parseLimit(raw: unknown, fallback: number, max = 100): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.min(max, Math.floor(raw)));
  }
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.max(1, Math.min(max, Math.floor(n)));
  }
  return fallback;
}

export function parseIntParam(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : null;
}

// ── HTTP 응답 헬퍼 ────────────────────────────────────────────────────────

export function err(c: Context, status: 400 | 401 | 404 | 409 | 500 | 503, message: string) {
  return c.json({ error: message }, status);
}

// ── 정적 파일 서빙 헬퍼 ──────────────────────────────────────────────────

/**
 * MIME types we serve from the static dir. Keep the list small —
 * `apps/memory/web/` 는 index.html + dashboard/ (settings 등) 정도.
 * 새 자산 종류가 실제로 들어올 때만 항목 추가.
 */
export const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  // dashboard ESM 진입 — 브라우저는 항상 *.js 산출만 본다. *.ts 본문은
  // `bun run build:dashboard` 가 bundle + type annotation 제거 후 같은
  // 디렉토리에 *.js 로 산출 (Phase 5.5.5 S9 정착, start-memory-api.bat 자동
  // 빌드 단계가 가동마다 재생성).
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  // *.ts 본문은 노출 안 함 — bundle 산출 *.js 만 브라우저가 본다.
  // *.map 은 inline source map 사용 정신이므로 별도 엔트리 불필요.
};

/**
 * Resolve a request path inside `staticDir` and guard against path
 * traversal. Returns `null` for invalid paths so the caller can 404.
 */
export function resolveStaticPath(staticDir: string, requestPath: string): string | null {
  const cleaned = requestPath === "/" ? "/index.html" : requestPath;
  if (cleaned.includes("\0")) return null;
  const safeRelative = cleaned.replace(/^\/+/, "");
  const full = resolve(staticDir, safeRelative);
  const rootResolved = resolve(staticDir);
  // Ensure resolved path is inside the static dir — block any `..` escapes.
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
    return null;
  }
  return full;
}

export function extensionOf(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx === -1 ? "" : path.slice(idx).toLowerCase();
}
