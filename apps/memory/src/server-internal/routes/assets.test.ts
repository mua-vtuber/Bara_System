/**
 * server-internal/routes/assets.test.ts — GET /assets + /thumbs 통합 검증 (Phase 11b T4).
 *
 * 실 SQLite(:memory:) + 실 AssetStore(tmp dir) + 실 Hono app — mock 0
 * (CLAUDE.md "테스트 정책" 정합).
 *
 * 검증 가족 6 가지:
 *   (a) GET /assets/{sha} → 200 + 바이너리 동일 + Content-Type=asset_files.mime_type
 *   (b) GET /thumbs/{thumbSha} → 200 + Content-Type=image/png
 *   (c) GET /assets/{없는 sha} → 404 + 한국어 정직 에러
 *   (d) GET /assets/../etc/passwd 같은 path traversal → 400
 *   (e) GET /assets/{짧은 sha} → 400 양식 어긋남
 *   (f) GET /assets/{대문자 sha} → 400 양식 어긋남
 *
 * 옛 ingest.test.ts harness 양식 정합 (실 Bgem3Embedder 가족 대신 본 라우트는
 * 임베더 미사용이라 곧장 AssetStore + store 만 가동).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { AssetStore } from "../../assets/asset-store.ts";
import { registerAssetsRoutes } from "./assets.ts";
import type { MemoryApiDeps } from "../types.ts";
import type { SqliteMemoryStore } from "../../db/store.ts";

// ── /assets · /thumbs 라우트 한 가족 안 onnxruntime / 임베더 의존 0 ──────
// 본 두 라우트는 asset_files SQL SELECT + AssetStore.read 한 가족 한 한 가동.
// buildMemoryApi 가 끌고 오는 HybridRetriever / ContextAssembler / Reranker
// 가족이 transitive 로 transformers (onnxruntime-node) 를 import 하므로,
// 본 검증은 buildMemoryApi 우회 + registerAssetsRoutes 직접 호출 한 한 가동
// (실 SqliteMemoryStore 도 안 만든다 — getRawDb() 한 한 stub 한 묶음 충분).

// ── 테스트별 harness ───────────────────────────────────────────────────────

let dir: string;
let db: Database;
let assetStore: AssetStore;
let app: Hono;

const PNG_BYTES = new Uint8Array([
  // 작은 합법 PNG 헤더 + 데이터 (1x1 transparent). 본 라우트는 mime 헤더만
  // 본다 — 실제 디코드는 안 한다. 가짜 바이너리로 충분.
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const JPEG_BYTES = new Uint8Array([
  // 가짜 JPEG SOI + 최소 EOI 한 묶음. 라우트 흐름 검증용.
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 옛 ingest-image 흐름을 줄여 본 — asset_files row + images row 둘 다 추가.
 * /assets · /thumbs 라우트는 두 테이블 한 가지 SELECT 한 한 동작 확인 자료.
 */
function seedImage(args: {
  bytes: Uint8Array;
  mime: string;
  ext: string;
  thumbSha?: string;
  thumbBytes?: Uint8Array;
}): { assetSha: string; thumbSha: string | null } {
  const assetSha = sha256Hex(args.bytes);
  // 원본 자산 — AssetStore 안 실제 파일 작성.
  assetStore.write(args.bytes, args.ext);
  db.prepare(
    `INSERT OR REPLACE INTO asset_files
       (sha256, asset_type, asset_path, byte_size, mime_type, original_name, first_imported_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))`,
  ).run(
    assetSha,
    "image",
    assetStore.path(assetSha, args.ext),
    args.bytes.byteLength,
    args.mime,
    "seed-test",
  );

  // thumb 자산 (있으면) — 항상 png 양식.
  let thumbSha: string | null = null;
  if (args.thumbBytes) {
    thumbSha = sha256Hex(args.thumbBytes);
    assetStore.write(args.thumbBytes, "png");
    db.prepare(
      `INSERT OR REPLACE INTO asset_files
         (sha256, asset_type, asset_path, byte_size, mime_type, original_name, first_imported_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))`,
    ).run(
      thumbSha,
      "image",
      assetStore.path(thumbSha, "png"),
      args.thumbBytes.byteLength,
      "image/png",
      "seed-test-thumb",
    );
  }

  // images row — asset_sha256 PK + thumb_sha256 nullable + mime 권위.
  db.prepare(
    `INSERT OR REPLACE INTO images
       (asset_sha256, thumb_sha256, width, height, mime, preserve_mode, is_animated, warnings_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(assetSha, thumbSha, 1, 1, args.mime, "smart", 0, "[]");

  return { assetSha, thumbSha };
}

function seedTextAsset(bytes: Uint8Array, ext: string, mime: string): string {
  const sha = sha256Hex(bytes);
  assetStore.write(bytes, ext);
  db.prepare(
    `INSERT OR REPLACE INTO asset_files
       (sha256, asset_type, asset_path, byte_size, mime_type, original_name, first_imported_at)
     VALUES (?, 'text', ?, ?, ?, ?, datetime('now', 'localtime'))`,
  ).run(sha, assetStore.path(sha, ext), bytes.byteLength, mime, `seed.${ext}`);
  return sha;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bara-assets-test-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  assetStore = new AssetStore(dir);

  // store 는 라우트 안 `store.getRawDb()` 한 한 가동 — stub 한 묶음 충분.
  // 옛 SqliteMemoryStore 생성자 흐름 (db + embedder) 가 가져오는 transformers
  // 의존 0 회피 정신.
  const storeStub = { getRawDb: () => db } as unknown as SqliteMemoryStore;
  const deps: MemoryApiDeps = {
    store: storeStub,
    // 본 두 라우트는 retriever / assembler 안 건드림 — undefined cast 한 한.
    retriever: undefined as unknown as MemoryApiDeps["retriever"],
    assembler: undefined as unknown as MemoryApiDeps["assembler"],
    assetStore,
  };
  app = new Hono({ strict: false });
  registerAssetsRoutes(app, deps);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── 검증 가족 ──────────────────────────────────────────────────────────────

describe("GET /assets/:sha + /thumbs/:sha", () => {
  // (a) 원본 자산 — 200 + 바이너리 동일 + mime 자연 추론
  test("GET /assets/{sha} → 200 + 바이너리 동일 + Content-Type=images.mime", async () => {
    const { assetSha } = seedImage({
      bytes: PNG_BYTES,
      mime: "image/png",
      ext: "png",
    });

    const res = await app.request(`/assets/${assetSha}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );

    const got = new Uint8Array(await res.arrayBuffer());
    expect(got.byteLength).toBe(PNG_BYTES.byteLength);
    expect(Array.from(got)).toEqual(Array.from(PNG_BYTES));
  });

  test("GET /assets/{문서 sha} → Markdown 자산 다운로드", async () => {
    const bytes = new TextEncoder().encode("# OCR 결과\n\n문서 자산 다운로드 검증");
    const sha = seedTextAsset(bytes, "md", "text/markdown");

    const res = await app.request(`/assets/${sha}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown");
    const got = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(got)).toEqual(Array.from(bytes));
  });

  // (b) preview 자산 — png 양식 자연
  test("GET /thumbs/{thumbSha} → 200 + Content-Type=image/png", async () => {
    const { thumbSha } = seedImage({
      bytes: JPEG_BYTES,
      mime: "image/jpeg",
      ext: "jpg",
      thumbBytes: PNG_BYTES,
    });
    expect(thumbSha).not.toBeNull();

    const res = await app.request(`/thumbs/${thumbSha}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );

    const got = new Uint8Array(await res.arrayBuffer());
    expect(got.byteLength).toBe(PNG_BYTES.byteLength);
  });

  // (c) 자산 없음 — 404 정직 회신
  test("GET /assets/{없는 sha} → 404 + 한국어 정직 에러", async () => {
    const fakeSha = "a".repeat(64);
    const res = await app.request(`/assets/${fakeSha}`);
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("자산 없음");
    expect(json.error).toContain("sha256");
  });

  // (d) path traversal — `../` 어긋남 = 400
  test("GET /assets/../etc/passwd → 400 양식 어긋남 (path traversal 자연 차단)", async () => {
    // Hono 라우트 매칭이 `/` 를 자연 분리 — `..` 단독 segment 도 양식 검증에서
    // 어긋남 한 한. 본 검증은 직접 `..` 문자열 sha 위치에 가동.
    const res = await app.request(`/assets/..%2Fetc%2Fpasswd`);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("sha256 양식");
  });

  // (e) 짧은 sha — 64자 미만 = 400
  test("GET /assets/{짧은 sha} → 400 양식 어긋남", async () => {
    const shortSha = "abc123";
    const res = await app.request(`/assets/${shortSha}`);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("sha256 양식");
  });

  // (f) 대문자 sha — 소문자 한정 = 400
  test("GET /assets/{대문자 sha} → 400 양식 어긋남", async () => {
    const upperSha = "A".repeat(64);
    const res = await app.request(`/assets/${upperSha}`);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("sha256 양식");
  });
});
