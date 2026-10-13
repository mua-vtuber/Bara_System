/**
 * thumb.test.ts — Phase 11a T4 미리보기 ≤previewMaxPx PNG 산출 검증 + 11d @jsquash 정합.
 *
 * 정지 PNG / 큰 정지 JPG / webp / avif / 움직이는 GIF 미리보기 양식이 같은지 +
 * 결과 가로/세로 한도 안 머무는지 확인. 래스터는 @jsquash, GIF 는 jimp 첫 프레임.
 *
 * Phase 11d 재정합: generateThumb 시그니처에 mime 인자 추가. 가로/세로 측정은
 * @jsquash probeMeta 로 (모든 미리보기 산출이 PNG 라 png 디코드 통로 일관).
 *
 * 권위: docs/decisions/2026-05-31-phase11d-jsquash-decode-spec(...).md §6.4 + plan T3.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateThumb } from "./thumb.ts";
import { probeMeta } from "./decode.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__");

describe("generateThumb", () => {
  test("작은 정지 PNG → PNG 미리보기 + 한도 안", async () => {
    const buffer = readFileSync(join(FIXTURES, "static-small.png"));
    const result = await generateThumb(buffer, "image/png", 512);
    expect(result.mime).toBe("image/png");
    expect(result.buffer.byteLength).toBeGreaterThan(0);
    // PNG magic
    expect(result.buffer[0]).toBe(0x89);
    expect(result.buffer[1]).toBe(0x50);
    // 결과 가로/세로 ≤512
    const meta = await probeMeta(result.buffer, "image/png");
    expect(meta.width).toBeLessThanOrEqual(512);
    expect(meta.height).toBeLessThanOrEqual(512);
  });

  test("큰 정지 JPG (3500x3500) → ≤512px PNG", async () => {
    const buffer = readFileSync(join(FIXTURES, "static-big.jpg"));
    const result = await generateThumb(buffer, "image/jpeg", 512);
    expect(result.mime).toBe("image/png");
    const meta = await probeMeta(result.buffer, "image/png");
    expect(meta.width).toBeLessThanOrEqual(512);
    expect(meta.height).toBeLessThanOrEqual(512);
    // 적어도 한 가지 가로/세로는 512 에 닿아야 (3500 → 512 비율 축소).
    expect(Math.max(meta.width, meta.height)).toBe(512);
  });

  test("작은 WebP → PNG 미리보기 (옛 jimp 가 못 읽던 형식)", async () => {
    const buffer = readFileSync(join(FIXTURES, "static-small.webp"));
    const result = await generateThumb(buffer, "image/webp", 512);
    expect(result.mime).toBe("image/png");
    expect(result.buffer[0]).toBe(0x89);
    expect(result.buffer[1]).toBe(0x50);
    const meta = await probeMeta(result.buffer, "image/png");
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(50);
  });

  test("작은 AVIF → PNG 미리보기 (옛 jimp 가 못 읽던 형식)", async () => {
    const buffer = readFileSync(join(FIXTURES, "static-small.avif"));
    const result = await generateThumb(buffer, "image/avif", 512);
    expect(result.mime).toBe("image/png");
    expect(result.buffer[0]).toBe(0x89);
    expect(result.buffer[1]).toBe(0x50);
    const meta = await probeMeta(result.buffer, "image/png");
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(50);
  });

  test("움직이는 GIF → 첫 프레임 PNG 미리보기 (jimp 잔존)", async () => {
    const buffer = readFileSync(join(FIXTURES, "animated-small.gif"));
    const result = await generateThumb(buffer, "image/gif", 512);
    expect(result.mime).toBe("image/png");
    expect(result.buffer[0]).toBe(0x89);
    expect(result.buffer[1]).toBe(0x50);
  });

  test("입력보다 한도가 큰 갈래 → 비율 그대로 PNG 재인코드 (확대 X)", async () => {
    // 50x50 입력 + maxPx=512 → 50x50 유지.
    const buffer = readFileSync(join(FIXTURES, "static-small.png"));
    const result = await generateThumb(buffer, "image/png", 512);
    const meta = await probeMeta(result.buffer, "image/png");
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(50);
  });

  test("깨진 래스터 → 미리보기 생성 단계 명시 throw (silent 아님)", async () => {
    const broken = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      0x00, 0x00, 0x00, 0x00,
    ]);
    await expect(
      generateThumb(broken, "image/webp", 512),
    ).rejects.toThrow(/미리보기 생성 실패/);
  });
});
