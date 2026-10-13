/**
 * mode.test.ts — Phase 11a T4 보존 모드 분기 검증 + Phase 11d @jsquash 정합.
 *
 * 6 갈래 + 한도 분기 + 움직임 손실 경고 + 미리보기 동반 검증 + webp/avif 래스터
 * 갈래 + 알파 분기 + D3 graceful 원본 보존 검증.
 *
 * Phase 11d 재정합: byteLength 절대값 단언 → 의미 보존 단언(width/height/outMime/
 * warnings/isAnimated). 래스터 디코더는 @jsquash, GIF/APNG 만 jimp 잔존.
 *
 * 권위: docs/decisions/2026-05-31-phase11d-jsquash-decode-spec(...).md §6.4 + plan T3.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Jimp } from "jimp";
import { applyPreserveMode } from "./mode.ts";
import { probeMeta } from "./decode.ts";
import {
  MOTION_LOSS_WARNING,
  PRESERVE_DEFAULTS,
  type PreserveSettings,
} from "./types.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__");

describe("applyPreserveMode", () => {
  test("smart + 작은 정지 PNG → 원본 그대로 + 미리보기 생성 + 경고 0", async () => {
    const buffer = readFileSync(join(FIXTURES, "static-small.png"));
    const result = await applyPreserveMode(
      buffer,
      "image/png",
      PRESERVE_DEFAULTS,
    );
    // 원본 그대로 보존 — assetBuffer 가 입력 바이트와 동일
    expect(result.assetBuffer).toEqual(buffer);
    expect(result.outMime).toBe("image/png");
    expect(result.warnings).toEqual([]);
    expect(result.isAnimated).toBe(false);
    expect(result.thumbBuffer.byteLength).toBeGreaterThan(0);
    expect(result.width).toBe(50);
    expect(result.height).toBe(50);
  });

  test("smart + 큰 정지 JPG (>5MB / 3500x3500) → 사본 + max 2048px + 경고 0", async () => {
    const buffer = readFileSync(join(FIXTURES, "static-big.jpg"));
    // fixture 가 제대로 5MB·2048px 초과 가정 확인 — 그래야 분기 경로가 의미 있음.
    expect(buffer.byteLength).toBeGreaterThan(5 * 1024 * 1024);

    const result = await applyPreserveMode(
      buffer,
      "image/jpeg",
      PRESERVE_DEFAULTS,
    );
    // 사본 — 입력 (16MB) 보다 작아야 함
    expect(result.assetBuffer.byteLength).toBeLessThan(buffer.byteLength);
    // 알파 없음 → JPEG 사본
    expect(result.outMime).toBe("image/jpeg");
    expect(result.warnings).toEqual([]);
    expect(result.isAnimated).toBe(false);
    // 사본 가로/세로 ≤2048 (@jsquash 디코드 → 측정)
    const copy = await probeMeta(result.assetBuffer, result.outMime);
    expect(copy.width).toBeLessThanOrEqual(2048);
    expect(copy.height).toBeLessThanOrEqual(2048);
    expect(Math.max(copy.width, copy.height)).toBe(2048);
  });

  test("smart + 작은 정지 WebP → 원본 그대로 (옛 jimp 가 못 읽던 형식)", async () => {
    const buffer = readFileSync(join(FIXTURES, "static-small.webp"));
    const result = await applyPreserveMode(
      buffer,
      "image/webp",
      PRESERVE_DEFAULTS,
    );
    // 50x50 + 작은 파일 → smart 통과 (원본 그대로)
    expect(result.assetBuffer).toEqual(buffer);
    expect(result.outMime).toBe("image/webp");
    expect(result.warnings).toEqual([]);
    expect(result.isAnimated).toBe(false);
    expect(result.width).toBe(50);
    expect(result.height).toBe(50);
    // 미리보기는 PNG (래스터 → @jsquash toPreviewPng)
    expect(result.thumbBuffer[0]).toBe(0x89);
    expect(result.thumbBuffer[1]).toBe(0x50);
  });

  test("smart + 작은 정지 AVIF → 원본 그대로 (옛 jimp 가 못 읽던 형식)", async () => {
    const buffer = readFileSync(join(FIXTURES, "static-small.avif"));
    const result = await applyPreserveMode(
      buffer,
      "image/avif",
      PRESERVE_DEFAULTS,
    );
    expect(result.assetBuffer).toEqual(buffer);
    expect(result.outMime).toBe("image/avif");
    expect(result.warnings).toEqual([]);
    expect(result.width).toBe(50);
    expect(result.height).toBe(50);
    expect(result.thumbBuffer[0]).toBe(0x89);
    expect(result.thumbBuffer[1]).toBe(0x50);
  });

  test("resized + WebP (알파 있음) → PNG 사본 (알파 보존)", async () => {
    const buffer = readFileSync(join(FIXTURES, "static-small.webp"));
    const settings: PreserveSettings = {
      ...PRESERVE_DEFAULTS,
      preserveMode: "resized",
    };
    const result = await applyPreserveMode(buffer, "image/webp", settings);
    // 알파 있는 webp → PNG 사본
    expect(result.outMime).toBe("image/png");
    expect(result.warnings).toEqual([]);
    expect(result.isAnimated).toBe(false);
    // PNG magic
    expect(result.assetBuffer[0]).toBe(0x89);
    expect(result.assetBuffer[1]).toBe(0x50);
    // 50x50 ≤ 2048 → 축소 없이 사본
    const copy = await probeMeta(result.assetBuffer, "image/png");
    expect(copy.width).toBe(50);
    expect(copy.height).toBe(50);
  });

  test("resized + AVIF (알파 있음) → PNG 사본 + 미리보기 PNG", async () => {
    const buffer = readFileSync(join(FIXTURES, "static-small.avif"));
    const settings: PreserveSettings = {
      ...PRESERVE_DEFAULTS,
      preserveMode: "resized",
    };
    const result = await applyPreserveMode(buffer, "image/avif", settings);
    expect(result.outMime).toBe("image/png");
    expect(result.warnings).toEqual([]);
    expect(result.assetBuffer[0]).toBe(0x89);
    expect(result.assetBuffer[1]).toBe(0x50);
    expect(result.thumbBuffer[0]).toBe(0x89);
    expect(result.thumbBuffer[1]).toBe(0x50);
  });

  test("smart + 작은 움직이는 GIF (<15MB) → 원본 그대로 + isAnimated=true + 경고 0", async () => {
    const buffer = readFileSync(join(FIXTURES, "animated-small.gif"));
    expect(buffer.byteLength).toBeLessThan(15 * 1024 * 1024);

    const result = await applyPreserveMode(
      buffer,
      "image/gif",
      PRESERVE_DEFAULTS,
    );
    expect(result.isAnimated).toBe(true);
    // 원본 그대로 보존
    expect(result.assetBuffer).toEqual(buffer);
    expect(result.outMime).toBe("image/gif");
    expect(result.warnings).toEqual([]);
    // 미리보기는 별도 PNG (GIF → jimp 첫 프레임)
    expect(result.thumbBuffer[0]).toBe(0x89);
    expect(result.thumbBuffer[1]).toBe(0x50);
  });

  test("smart + 큰 움직이는 GIF (>15MB) → 첫프레임 PNG + 움직임 손실 경고", async () => {
    const buffer = readFileSync(join(FIXTURES, "animated-big.gif"));
    expect(buffer.byteLength).toBeGreaterThan(15 * 1024 * 1024);

    const result = await applyPreserveMode(
      buffer,
      "image/gif",
      PRESERVE_DEFAULTS,
    );
    expect(result.isAnimated).toBe(true);
    expect(result.outMime).toBe("image/png");
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toBe(MOTION_LOSS_WARNING);
    // 첫 프레임 PNG magic
    expect(result.assetBuffer[0]).toBe(0x89);
    expect(result.assetBuffer[1]).toBe(0x50);
  });

  test("resized + 움직이는 GIF → 첫프레임 PNG + 손실 경고 (한도 무관)", async () => {
    const buffer = readFileSync(join(FIXTURES, "animated-small.gif"));
    const settings: PreserveSettings = {
      ...PRESERVE_DEFAULTS,
      preserveMode: "resized",
    };
    const result = await applyPreserveMode(buffer, "image/gif", settings);
    expect(result.isAnimated).toBe(true);
    expect(result.outMime).toBe("image/png");
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toBe(MOTION_LOSS_WARNING);
  });

  test("resized + 정지 JPG (알파 없음) → JPEG 사본 + 경고 0", async () => {
    const buffer = readFileSync(join(FIXTURES, "static-small-noalpha.jpg"));
    const settings: PreserveSettings = {
      ...PRESERVE_DEFAULTS,
      preserveMode: "resized",
    };
    const result = await applyPreserveMode(buffer, "image/jpeg", settings);
    // 알파 없음 → JPEG 사본
    expect(result.outMime).toBe("image/jpeg");
    expect(result.warnings).toEqual([]);
    expect(result.isAnimated).toBe(false);
    // JPEG magic (FF D8 FF)
    expect(result.assetBuffer[0]).toBe(0xff);
    expect(result.assetBuffer[1]).toBe(0xd8);
  });

  test("resized + 알파 있는 정지 PNG → PNG 사본 (알파 보존)", async () => {
    const buffer = readFileSync(join(FIXTURES, "static-small.png"));
    const settings: PreserveSettings = {
      ...PRESERVE_DEFAULTS,
      preserveMode: "resized",
    };
    const result = await applyPreserveMode(buffer, "image/png", settings);
    // 알파 있음 → PNG 사본
    expect(result.outMime).toBe("image/png");
    expect(result.warnings).toEqual([]);
    expect(result.assetBuffer[0]).toBe(0x89);
    expect(result.assetBuffer[1]).toBe(0x50);
  });

  test("original + 큰 정지 JPG → 원본 한도 무관", async () => {
    const buffer = readFileSync(join(FIXTURES, "static-big.jpg"));
    const settings: PreserveSettings = {
      ...PRESERVE_DEFAULTS,
      preserveMode: "original",
    };
    const result = await applyPreserveMode(buffer, "image/jpeg", settings);
    // 한도 무관 원본 그대로 보존
    expect(result.assetBuffer).toEqual(buffer);
    expect(result.outMime).toBe("image/jpeg");
    expect(result.warnings).toEqual([]);
  });

  test("original + 큰 움직이는 GIF → 원본 한도 무관 (움직임 보존)", async () => {
    const buffer = readFileSync(join(FIXTURES, "animated-big.gif"));
    const settings: PreserveSettings = {
      ...PRESERVE_DEFAULTS,
      preserveMode: "original",
    };
    const result = await applyPreserveMode(buffer, "image/gif", settings);
    expect(result.assetBuffer).toEqual(buffer);
    expect(result.outMime).toBe("image/gif");
    expect(result.warnings).toEqual([]);
    expect(result.isAnimated).toBe(true);
  });

  test("미리보기는 보존 모드 무관 — 항상 ≤previewMaxPx PNG", async () => {
    // 작은 fixture 하나 사용 — 큰 fixture 는 3 모드 돌리면 timeout. 이 검증의 가닥은
    // "보존 모드 무관 미리보기 산출 양식 정합" 이라 작은 입력으로도 충분.
    const buffer = readFileSync(join(FIXTURES, "static-small.png"));
    for (const mode of ["smart", "original", "resized"] as const) {
      const settings: PreserveSettings = {
        ...PRESERVE_DEFAULTS,
        preserveMode: mode,
      };
      const result = await applyPreserveMode(buffer, "image/png", settings);
      // PNG magic
      expect(result.thumbBuffer[0]).toBe(0x89);
      expect(result.thumbBuffer[1]).toBe(0x50);
      // 가로/세로 ≤512
      const meta = await probeMeta(result.thumbBuffer, "image/png");
      expect(meta.width).toBeLessThanOrEqual(512);
      expect(meta.height).toBeLessThanOrEqual(512);
    }
  });

  test("smart + 가로/세로만 초과 (5MB 안 / 2048px 초과) → 사본 경로", async () => {
    // 큰 JPG fixture 가 이미 두 조건 다 초과지만, settings 한도를 살짝 올려서
    // px 만 초과하도록 만든다 — passthroughMaxMb=100 (16MB 안), passthroughMaxPx=1024.
    const buffer = readFileSync(join(FIXTURES, "static-big.jpg"));
    const settings: PreserveSettings = {
      ...PRESERVE_DEFAULTS,
      passthroughMaxMb: 100,
      passthroughMaxPx: 1024,
      searchCopyMaxPx: 1024,
    };
    const result = await applyPreserveMode(buffer, "image/jpeg", settings);
    expect(result.assetBuffer.byteLength).toBeLessThan(buffer.byteLength);
    const copy = await probeMeta(result.assetBuffer, result.outMime);
    expect(Math.max(copy.width, copy.height)).toBe(1024);
  });

  // ── D3 graceful — 디코드 실패해도 원본 보존 (silent fallback 아님: warnings 명시) ──

  test("original + 깨진 래스터 → throw 안 함 + 원본 보존 + 디코드 실패 경고", async () => {
    // RIFF....WEBP magic 만 있고 픽셀 데이터가 깨진 webp — @jsquash 디코드 단계에서 throw.
    const broken = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      0x00, 0x00, 0x00, 0x00,
    ]);
    const settings: PreserveSettings = {
      ...PRESERVE_DEFAULTS,
      preserveMode: "original",
    };
    const result = await applyPreserveMode(broken, "image/webp", settings);
    // 원본 바이트는 무조건 보존
    expect(result.assetBuffer).toEqual(broken);
    expect(result.outMime).toBe("image/webp");
    // 가로·세로 미측정
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
    // 정직 경고 — probe 실패 + 미리보기 실패 둘 다 명시 (silent 아님)
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.some((w) => w.includes("원본은 보존됨"))).toBe(true);
  });

  test("smart + 깨진 래스터 → throw 안 함 + 원본 보존 (px 판정 불가 → 통과 갈래)", async () => {
    const broken = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      0x00, 0x00, 0x00, 0x00,
    ]);
    const result = await applyPreserveMode(
      broken,
      "image/webp",
      PRESERVE_DEFAULTS,
    );
    expect(result.assetBuffer).toEqual(broken);
    expect(result.outMime).toBe("image/webp");
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
    expect(result.warnings.some((w) => w.includes("원본은 보존됨"))).toBe(true);
  });

  test("resized + 깨진 래스터 → 명시 throw (사본 필수 갈래 — 원본 보존 의미 없음)", async () => {
    const broken = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      0x00, 0x00, 0x00, 0x00,
    ]);
    const settings: PreserveSettings = {
      ...PRESERVE_DEFAULTS,
      preserveMode: "resized",
    };
    await expect(
      applyPreserveMode(broken, "image/webp", settings),
    ).rejects.toThrow(/resized/);
  });
});
