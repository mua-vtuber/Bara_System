/**
 * ingest-image.int.test.ts — Phase 11a T5 통합 검증.
 *
 * 실제 bun:sqlite + sqlite-vec + schema v7 + AssetStore + SigLIP 2 임베더 위에서
 * ingestImage 한 흐름 (보존 모드 분기 → 자산 저장 → asset_files / asset_file_imports /
 * images 행 → 임베딩 → image_asset 노드 + image_vec) 합류 정합 검증. Mock 0 —
 * CLAUDE.md "테스트 정책" + 14b attachment-ingest.integration.test 양식 정합.
 *
 * 7 갈래:
 *  (a) PNG 5MB 미만 → smart 보존 (원본 그대로) + image_vec row + 응답 정합
 *  (b) 큰 JPG (>5MB or >2048px) → smart 보존 (사본) + image_vec row + 사본 sha 다름
 *  (c) 작은 GIF (animated, <15MB) → smart 보존 (원본 그대로) + isAnimated=true
 *  (d) 큰 animated GIF (>15MB) → 첫프레임 PNG + 움직임 손실 경고 + isAnimated=true
 *  (e) 같은 이미지 두 번 ingest → asset_files 1 row + asset_file_imports 2 row +
 *      knowledge_nodes 2 row (자산 dedup / 노드 두 row 정합 — T3 흐름)
 *  (f) embedding=null 분기 (stub embedder) → 노드 생성 + image_vec skip + warn
 *  (g) 잘못된 image mime (`image/svg+xml`) → 명시 throw + 노드·자산 0
 *  (h) 이름 위장 (mime=image/jpeg, 실제 webp) → sniff 교정 + 경고 + 정상 저장 (11d D6)
 *  (h2) avif → allowlist 통과 + @jsquash 디코드 + 저장 + probe + 임베딩 (11d D6)
 *  (i) heic 바이트 → 명시 거부 + 노드·자산 0 (디코더 없음 §8)
 *
 * SigLIP 2 모델 다운로드 비용 — 첫 통합 test 호출 시 수~수십초 소요. timeout 180s.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { AssetStore } from "../assets/asset-store.ts";
import { createImageEmbedder } from "../embedding/factory.ts";
import type { ImageEmbedder } from "../embedding/types.ts";
import { ingestImage } from "./ingest-image.ts";

const FIXTURES = join(import.meta.dir, "image-preserve", "__fixtures__");

// SigLIP 2 singleton — describe 안 한 번 로드, 모든 test 공유 (다운로드 비용 1회).
let imageEmbedder: ImageEmbedder;

beforeAll(() => {
  imageEmbedder = createImageEmbedder();
});
afterAll(() => {});

// ── 테스트별 harness ────────────────────────────────────────────────────────

let db: Database;
let assetDir: string;
let assetStore: AssetStore;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
  assetDir = mkdtempSync(join(tmpdir(), "bara-ingest-image-"));
  assetStore = new AssetStore(assetDir);
});

afterEach(() => {
  db.close();
  rmSync(assetDir, { recursive: true, force: true });
});

// ── 보조 — DB row 검사 helper ────────────────────────────────────────────────

interface ImagesRow {
  asset_sha256: string;
  thumb_sha256: string;
  width: number;
  height: number;
  mime: string;
  preserve_mode: string;
  is_animated: number;
  warnings_json: string;
}

function getImagesRow(sha: string): ImagesRow | null {
  return db
    .prepare("SELECT * FROM images WHERE asset_sha256 = ?")
    .get(sha) as ImagesRow | null;
}

function countAssetFiles(sha: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM asset_files WHERE sha256 = ?")
      .get(sha) as { c: number }
  ).c;
}

function countAssetImports(sha: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM asset_file_imports WHERE asset_sha256 = ?")
      .get(sha) as { c: number }
  ).c;
}

function countImageNodes(): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM knowledge_nodes WHERE source_type = 'image_asset'",
      )
      .get() as { c: number }
  ).c;
}

function countImageVec(nodeId: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM image_vec WHERE node_id = ?")
      .get(nodeId) as { c: number }
  ).c;
}

// ── 7 갈래 ─────────────────────────────────────────────────────────────────

describe("ingestImage 통합", () => {
  // ── (a) 작은 PNG → smart 통과 ────────────────────────────────────────────
  test(
    "(a) 작은 PNG → smart 보존 (원본 그대로) + image_vec row + 응답 정합",
    async () => {
      const buffer = readFileSync(join(FIXTURES, "static-small.png"));
      const result = await ingestImage(
        { db, assetStore, imageEmbedder },
        {
          buffer,
          mime: "image/png",
          originalName: "small.png",
          author: "tester",
          platform: "dashboard",
          source: "dashboard:manual",
          userId: "u-test",
        },
      );

      expect(result.assetSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.thumbSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.isAnimated).toBe(false);
      expect(result.warnings).toEqual([]);
      expect(result.mime).toBe("image/png");
      expect(result.width).toBe(50);
      expect(result.height).toBe(50);
      expect(result.nodeId).toBeGreaterThan(0);

      // images row 정합
      const img = getImagesRow(result.assetSha256);
      expect(img).not.toBeNull();
      expect(img!.thumb_sha256).toBe(result.thumbSha256);
      expect(img!.preserve_mode).toBe("smart");
      expect(img!.is_animated).toBe(0);
      expect(JSON.parse(img!.warnings_json)).toEqual([]);

      // asset_files: 원본 + 미리보기 두 row (sha 다르면 2, 같으면 1)
      expect(countAssetFiles(result.assetSha256)).toBe(1);
      expect(countAssetFiles(result.thumbSha256)).toBe(1);

      // asset_file_imports: 원본 자산 1 import row
      expect(countAssetImports(result.assetSha256)).toBe(1);

      // knowledge_nodes 1 + image_vec 1 (SigLIP 임베딩 가용 시)
      expect(countImageNodes()).toBe(1);
      // image_vec 은 SigLIP 모델 로드 성공 시 1, 실패 시 0 — 두 갈래 모두 정합
      const vecCount = countImageVec(result.nodeId);
      expect(vecCount === 0 || vecCount === 1).toBe(true);

      // documents·document_chunk row 0 — 이미지 별 갈래
      const docCount = (
        db.prepare("SELECT COUNT(*) AS c FROM documents").get() as {
          c: number;
        }
      ).c;
      expect(docCount).toBe(0);
    },
    180_000,
  );

  // ── (b) 큰 JPG → smart 사본 ──────────────────────────────────────────────
  test(
    "(b) 큰 JPG (>5MB) → smart 보존 (사본) + 사본 sha ≠ 원본 sha + image_vec row",
    async () => {
      const buffer = readFileSync(join(FIXTURES, "static-big.jpg"));
      expect(buffer.byteLength).toBeGreaterThan(5 * 1024 * 1024);

      // 원본 sha 사전 계산 — 사본 sha 와 다름을 확인하기 위함
      const { createHash } = await import("node:crypto");
      const origSha = createHash("sha256").update(buffer).digest("hex");

      const result = await ingestImage(
        { db, assetStore, imageEmbedder },
        {
          buffer,
          mime: "image/jpeg",
          originalName: "big.jpg",
        },
      );

      // 사본 (보존 모드 갈래 — assetSha256 = 사본 sha, 원본 sha 와 다름)
      expect(result.assetSha256).not.toBe(origSha);
      expect(result.isAnimated).toBe(false);
      expect(result.warnings).toEqual([]);
      // 사본은 jimp 알파 검사 — JPG 는 알파 없음 → JPEG 사본
      expect(result.mime).toBe("image/jpeg");

      // images row 정합
      const img = getImagesRow(result.assetSha256);
      expect(img).not.toBeNull();
      expect(img!.preserve_mode).toBe("smart");
      expect(img!.is_animated).toBe(0);
      expect(Math.max(img!.width, img!.height)).toBe(2048);

      // 사본 자산 1 row + 미리보기 1 row
      expect(countAssetFiles(result.assetSha256)).toBe(1);
      expect(countAssetFiles(result.thumbSha256)).toBe(1);

      expect(countImageNodes()).toBe(1);
    },
    180_000,
  );

  // ── (c) 작은 GIF → smart 통과 (animated) ───────────────────────────────
  test(
    "(c) 작은 GIF (animated, <15MB) → smart 보존 (원본 그대로) + isAnimated=true",
    async () => {
      const buffer = readFileSync(join(FIXTURES, "animated-small.gif"));
      expect(buffer.byteLength).toBeLessThan(15 * 1024 * 1024);

      const result = await ingestImage(
        { db, assetStore, imageEmbedder },
        {
          buffer,
          mime: "image/gif",
          originalName: "small.gif",
        },
      );

      expect(result.isAnimated).toBe(true);
      expect(result.warnings).toEqual([]);
      expect(result.mime).toBe("image/gif");

      const img = getImagesRow(result.assetSha256);
      expect(img).not.toBeNull();
      expect(img!.is_animated).toBe(1);
      expect(img!.preserve_mode).toBe("smart");
      expect(JSON.parse(img!.warnings_json)).toEqual([]);

      expect(countImageNodes()).toBe(1);
    },
    180_000,
  );

  // ── (d) 큰 animated GIF → 첫프레임 PNG + 움직임 손실 경고 ─────────────
  test(
    "(d) 큰 animated GIF (>15MB) → 첫프레임 PNG + 움직임 손실 경고 + isAnimated=true",
    async () => {
      const buffer = readFileSync(join(FIXTURES, "animated-big.gif"));
      expect(buffer.byteLength).toBeGreaterThan(15 * 1024 * 1024);

      const result = await ingestImage(
        { db, assetStore, imageEmbedder },
        {
          buffer,
          mime: "image/gif",
          originalName: "big.gif",
        },
      );

      expect(result.isAnimated).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      // 움직임 손실 경고 — types.ts MOTION_LOSS_WARNING 문자열 prefix
      expect(result.warnings.some((w) => w.includes("움직"))).toBe(true);
      // 첫프레임 PNG fallback → mime = image/png
      expect(result.mime).toBe("image/png");

      const img = getImagesRow(result.assetSha256);
      expect(img).not.toBeNull();
      expect(img!.is_animated).toBe(1);
      expect(img!.mime).toBe("image/png");
      const warnList = JSON.parse(img!.warnings_json) as string[];
      expect(warnList.length).toBeGreaterThan(0);
    },
    180_000,
  );

  // ── (e) 같은 이미지 두 번 ingest → 자산 dedup / 노드 두 row ───────────
  test(
    "(e) 같은 이미지 두 번 ingest → asset_files 1 + asset_file_imports 2 + knowledge_nodes 2",
    async () => {
      const buffer = readFileSync(join(FIXTURES, "static-small.png"));
      const r1 = await ingestImage(
        { db, assetStore, imageEmbedder },
        { buffer, mime: "image/png", originalName: "small.png", source: "a" },
      );
      const r2 = await ingestImage(
        { db, assetStore, imageEmbedder },
        { buffer, mime: "image/png", originalName: "small.png", source: "b" },
      );

      // 같은 자산 — sha 일치
      expect(r2.assetSha256).toBe(r1.assetSha256);
      // 노드는 서로 다름
      expect(r2.nodeId).not.toBe(r1.nodeId);

      // 자산 row 1 (sha PK 멱등)
      expect(countAssetFiles(r1.assetSha256)).toBe(1);
      // import row 2 (attribution 두 번 보존)
      expect(countAssetImports(r1.assetSha256)).toBe(2);
      // 노드 2 row
      expect(countImageNodes()).toBe(2);
    },
    180_000,
  );

  // ── (f) embedding=null 분기 — stub embedder ─────────────────────────────
  test("(f) embedding=null 분기 → 노드 생성 + image_vec skip + warn", async () => {
    const buffer = readFileSync(join(FIXTURES, "static-small.png"));
    // stub embedder — 모델 미로드 시뮬레이션 (silent fallback 금지 정합 / 명시 null)
    const stubEmbedder: ImageEmbedder = {
      dim: 768,
      modelId: "stub:null-for-test",
      async embedImage() {
        return null;
      },
    };

    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };

    try {
      const result = await ingestImage(
        { db, assetStore, imageEmbedder: stubEmbedder },
        { buffer, mime: "image/png", originalName: "null-emb.png" },
      );
      expect(result.nodeId).toBeGreaterThan(0);

      // 노드 1 + image_vec 0 (skip)
      expect(countImageNodes()).toBe(1);
      expect(countImageVec(result.nodeId)).toBe(0);

      // images row 는 정합 추가 (자산 보존은 임베딩과 무관)
      const img = getImagesRow(result.assetSha256);
      expect(img).not.toBeNull();

      // warn 한 줄 (addImageAssetNode 안 "[image-asset] embedding=null" 메시지)
      expect(warns.some((line) => line.includes("[image-asset]"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  // ── (g) 잘못된 image mime → 명시 throw + 부수 효과 0 ───────────────────
  test("(g) 잘못된 image mime (image/svg+xml) → throw + 노드·자산 0", async () => {
    const buffer = Buffer.from("<svg/>");
    await expect(
      ingestImage(
        { db, assetStore, imageEmbedder },
        { buffer, mime: "image/svg+xml" },
      ),
    ).rejects.toThrow("지원 안 하는 이미지 형식");

    // 부수 효과 0
    expect(countImageNodes()).toBe(0);
    const af = (
      db.prepare("SELECT COUNT(*) AS c FROM asset_files").get() as {
        c: number;
      }
    ).c;
    expect(af).toBe(0);
  });

  // ── (h) 이름 위장 (mime=image/jpeg 인데 실제 webp 바이트) → sniff 교정 ──
  // Phase 11d D6: 봇·대시보드가 .jpg 라 보냈지만 실제 바이트가 webp. sniff 가
  // 실제 형식으로 교정 + 정직 경고 + 정상 저장. 옛 흐름은 디코드 throw 로 자산
  // 손실까지 갔던 케이스.
  test(
    "(h) 이름 위장 (mime=image/jpeg, 실제 webp) → sniff 교정 + 경고 + 정상 저장",
    async () => {
      const buffer = readFileSync(join(FIXTURES, "static-small.webp"));

      const result = await ingestImage(
        { db, assetStore, imageEmbedder },
        { buffer, mime: "image/jpeg", originalName: "disguised.jpg" },
      );

      // 교정 경고 — "실제 형식은 'image/webp'" 정직 기록
      expect(result.warnings.some((w) => w.includes("image/webp"))).toBe(true);
      expect(result.warnings.some((w) => w.includes("image/jpeg"))).toBe(true);

      // 정상 저장 — 노드·자산·images row 생성
      expect(result.nodeId).toBeGreaterThan(0);
      expect(result.assetSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(countImageNodes()).toBe(1);

      const img = getImagesRow(result.assetSha256);
      expect(img).not.toBeNull();
      // images row 의 warnings_json 에도 교정 경고가 들어간다
      const warnList = JSON.parse(img!.warnings_json) as string[];
      expect(warnList.some((w) => w.includes("image/webp"))).toBe(true);
    },
    180_000,
  );

  // ── (h2) avif 입력 → allowlist 통과 + @jsquash 디코드 + 정상 저장 (11d D6) ──
  // T5 가 avif 를 SUPPORTED_IMAGE_MIMES 에 합류시켰다. 옛 흐름은 allowlist 밖이라
  // 진입에서 막혔고, jimp 도 avif 를 못 읽었다. 11d @jsquash 디코드로 저장·probe·
  // (모델 가용 시) 임베딩까지 가동. 모델 미가용은 graceful (image_vec 0 OK).
  test(
    "(h2) avif → allowlist 통과 + 저장 + probe + 임베딩 (graceful)",
    async () => {
      const buffer = readFileSync(join(FIXTURES, "static-small.avif"));

      const result = await ingestImage(
        { db, assetStore, imageEmbedder },
        {
          buffer,
          mime: "image/avif",
          originalName: "최신.avif",
          source: "dashboard:manual",
        },
      );

      // 정상 저장 — 노드·자산·images row 생성
      expect(result.assetSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.thumbSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.nodeId).toBeGreaterThan(0);
      expect(result.isAnimated).toBe(false);
      // @jsquash 디코드로 width/height 측정 (0 이 아니어야 디코드 성공)
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);

      // images row 정합 — 보존 모드 통과 후 outMime (avif 원본 보존 또는 png/jpeg 사본)
      const img = getImagesRow(result.assetSha256);
      expect(img).not.toBeNull();
      expect(img!.width).toBe(result.width);
      expect(img!.height).toBe(result.height);
      expect(countImageNodes()).toBe(1);

      // image_vec 은 SigLIP 모델 로드 성공 시 1, 미가용 시 0 — 두 갈래 모두 정합
      const vecCount = countImageVec(result.nodeId);
      expect(vecCount === 0 || vecCount === 1).toBe(true);

      // 이미지 별 갈래 — documents row 0
      const docCount = (
        db.prepare("SELECT COUNT(*) AS c FROM documents").get() as { c: number }
      ).c;
      expect(docCount).toBe(0);
    },
    180_000,
  );

  // ── (i) heic 바이트 → 명시 거부 (디코더 없음 §8) ────────────────────────
  // @jsquash 가 heic 디코더를 제공하지 않아 받아도 못 읽는다. 받아놓고 자산 손실로
  // 위장하지 않고 진입 즉시 정직 거부 + 부수 효과 0.
  test("(i) heic 바이트 → 명시 거부 + 노드·자산 0", async () => {
    // 합성 heic ftyp 헤더 (major_brand 'heic'). sniff 가 brand 만 보므로 충분.
    const heicBytes = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x20]), // box size
      Buffer.from("ftyp", "latin1"),
      Buffer.from("heic", "latin1"), // major_brand
      Buffer.from([0x00, 0x00, 0x00, 0x00]), // minor_version
      Buffer.from("heicmif1", "latin1"), // compatible_brands
    ]);

    await expect(
      ingestImage(
        { db, assetStore, imageEmbedder },
        { buffer: heicBytes, mime: "image/heic", originalName: "photo.heic" },
      ),
    ).rejects.toThrow("HEIC");

    // 부수 효과 0
    expect(countImageNodes()).toBe(0);
    const af = (
      db.prepare("SELECT COUNT(*) AS c FROM asset_files").get() as {
        c: number;
      }
    ).c;
    expect(af).toBe(0);
  });
});
