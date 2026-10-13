/**
 * server-internal/routes/assets.ts — GET /assets/:sha + /thumbs/:sha 라우트 등록기 (Phase 11b T4).
 *
 * GET /assets/{sha256} — 등록된 자산 바이너리 회신 (이미지·문서 원본·canonical md).
 * GET /thumbs/{sha256} — preview 자산 바이너리 회신 (preview 는 항상 image/png 양식).
 *
 * 양 통로 모두:
 *   - sha256 양식 `^[a-f0-9]{64}$` 한 한 (path traversal 자연 차단 / 400)
 *   - 자산 없음 = 404 + 한국어 정직 에러 (silent 빈 응답 X)
 *   - Cache-Control = 'public, max-age=31536000, immutable' (자산 sha 가
 *     불변 식별자라 immutable 자연)
 *
 * /thumbs 는 옛 ingest-image.ts 안 image 5 종 (png/jpeg/gif/webp/apng) 한 한 가동.
 * /assets 는 asset_files.asset_path 확장자를 따라 AssetStore 에서 읽는다.
 *
 * 절대 제약:
 *   assetStore 는 선택 의존이므로 핸들러 안에서 호출 시점에 deps lookup. 미주입 시
 *   503 (옛 cleanup.ts 안 reset/re-embed 통로 양식 정합).
 */

import type { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { err, SHA256_HEX_RE } from "../http-helpers.ts";
// 파일 지우기(released-asset-files.ts)와 같은 계산으로 파일 경로를 정한다(WP-B1-20U 설계 17.17).
import { extOfAssetPath } from "../../assets/asset-store.ts";

/** Cache-Control 값 — sha 가 불변 식별자라 1년 + immutable 권위. */
const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * sha256 양식 — 64 자 소문자 hex 한 한. 대문자 / `../` / 비 hex 모두 자연 어긋남.
 * 단일 출처 = http-helpers.ts `SHA256_HEX_RE` (auth-gate 이미지 폴백과 공유).
 */
const SHA256_RE = SHA256_HEX_RE;

/**
 * mime → AssetStore 파일 확장자. ingest-image.ts `extOfMime` + re-embed-images.ts
 * 안 helper 와 같은 가족 (SUPPORTED_IMAGE_MIMES 권위 정합). mime 묶음 자체는
 * SUPPORTED_IMAGE_MIMES 한 곳이 권위이고, 확장자 매핑은 라우트 계층 분리를 위해
 * 인라인 (image mime 가 늘면 세 곳 다 갱신 — extOfMime 정합 테스트가 대조). Phase
 * 11d D6: avif 합류.
 */
function extOfMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/apng":
      return "apng";
    case "image/avif":
      return "avif";
    default:
      throw new Error(
        `assets: 알 수 없는 image mime '${mime}' — SUPPORTED_IMAGE_MIMES 한정`,
      );
  }
}

function contentTypeOfAsset(mimeType: string | null, ext: string): string {
  if (mimeType && mimeType.trim().length > 0) return mimeType;
  if (ext === "md") return "text/markdown; charset=utf-8";
  if (ext === "txt") return "text/plain; charset=utf-8";
  if (ext === "pdf") return "application/pdf";
  if (ext === "docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return "application/octet-stream";
}

/**
 * /assets + /thumbs 두 라우트를 app 에 등록한다.
 *
 * deps 객체 자체를 받는다 (assetStore 구조분해 금지). assetStore 미주입 시 503.
 */
export function registerAssetsRoutes(app: Hono, deps: MemoryApiDeps): void {
  const { store } = deps;

  // ── GET /assets/:sha — 원본/문서/canonical 자산 바이너리 ─────────────────
  // 흐름:
  //   1) sha 양식 검증 (`^[a-f0-9]{64}$`) — 어긋나면 400 (path traversal 차단)
  //   2) assetStore 주입 확인 — 미주입 시 503
  //   3) asset_files SELECT — mime_type + asset_path 회수 (없으면 404)
  //   4) assetStore.read(sha, ext) — bytes 회수 (파일 없으면 read 가 throw → 404)
  //   5) c.body(bytes, 200, headers)
  app.get("/assets/:sha", (c) => {
    const sha = c.req.param("sha");

    if (!SHA256_RE.test(sha)) {
      return err(
        c,
        400,
        "sha256 양식 어긋남 — [a-f0-9]{64} 64 자 소문자 hex 한 한 가동",
      );
    }

    if (!deps.assetStore) {
      return err(
        c,
        503,
        "assetStore 미설정 — 자산 디렉토리 부재 (settings.assets.dir 또는 BARA_ASSET_DIR 확인)",
      );
    }

    // asset_files 안 자산 row 회수 — 이미지뿐 아니라 문서 원본/canonical md 도 허용.
    const row = store
      .getRawDb()
      .prepare(
        "SELECT mime_type, asset_path FROM asset_files WHERE sha256 = ?",
      )
      .get(sha) as { mime_type: string | null; asset_path: string } | undefined;

    if (!row) {
      return err(c, 404, "자산 없음 — sha256 확인");
    }

    const ext = extOfAssetPath(row.asset_path);
    if (!ext) {
      return err(c, 500, "자산 경로 확장자 없음 — asset_files.asset_path 확인");
    }

    let bytes: Uint8Array;
    try {
      bytes = deps.assetStore.read(sha, ext);
    } catch {
      // DB row 는 있지만 파일이 사라진 가족 — 정직한 404.
      return err(c, 404, "자산 없음 — sha256 확인 (파일 부재)");
    }

    // c.body(Uint8Array, ...) 는 Hono 타입 양식 안 `Uint8Array<ArrayBuffer>`
    // 한 한 받지만 `assetStore.read` 산출은 `Uint8Array<ArrayBufferLike>` 라
    // 직접 Response 한 묶음 가동 — 같은 결과 / 타입 어긋남 자연 우회.
    // c.body(Uint8Array, ...) 는 Hono 타입 양식 안 `Uint8Array<ArrayBuffer>`
    // 한 한 받지만 `assetStore.read` 산출은 `Uint8Array<ArrayBufferLike>` 라
    // 직접 Response 한 묶음 가동 — 같은 결과 / 타입 어긋남 자연 우회.
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": contentTypeOfAsset(row.mime_type, ext),
        "Cache-Control": ASSET_CACHE_CONTROL,
      },
    });
  });

  // ── GET /thumbs/:sha — preview 자산 바이너리 ─────────────────────────────
  // preview 는 옛 ingest-image 흐름 안 항상 png 양식 (smart 보존 모드 default 가
  // sharp 위 png 산출). 한 한 image/png Content-Type 자연 회신.
  //
  // sha 양식 = 옛 /assets 와 같은 검증 한 한. asset_files 안 mime_type='image/png'
  // 한정 SELECT 로 thumb 자연 분기 — 옛 원본 (jpeg/gif/webp/apng) 가 잘못 회수 안 됨.
  app.get("/thumbs/:sha", (c) => {
    const sha = c.req.param("sha");

    if (!SHA256_RE.test(sha)) {
      return err(
        c,
        400,
        "sha256 양식 어긋남 — [a-f0-9]{64} 64 자 소문자 hex 한 한 가동",
      );
    }

    if (!deps.assetStore) {
      return err(
        c,
        503,
        "assetStore 미설정 — 자산 디렉토리 부재 (settings.assets.dir 또는 BARA_ASSET_DIR 확인)",
      );
    }

    // asset_files SELECT — thumb 자산도 같은 테이블 안 row 가 있어야 한다
    // (ingest-image 안 두 자산 한 묶음 동시 INSERT 양식 정합).
    const row = store
      .getRawDb()
      .prepare(
        "SELECT mime_type FROM asset_files WHERE sha256 = ? AND asset_type = 'image'",
      )
      .get(sha) as { mime_type: string } | undefined;

    if (!row) {
      return err(c, 404, "자산 없음 — sha256 확인");
    }

    // thumb 는 항상 png 양식 — 옛 ingest-image 안 thumbWrite 가 "png" 한 한 가동.
    let bytes: Uint8Array;
    try {
      bytes = deps.assetStore.read(sha, "png");
    } catch {
      return err(c, 404, "자산 없음 — sha256 확인 (파일 부재)");
    }

    // 옛 /assets 라우트와 같은 타입 우회 정신 — new Response 직접 가동.
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": ASSET_CACHE_CONTROL,
      },
    });
  });
}
