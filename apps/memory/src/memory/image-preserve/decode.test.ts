/**
 * decode.test.ts — Phase 11d @jsquash 순수 WASM 디코드 어댑터 검증.
 *
 * 실제 @jsquash WASM 디코드·인코드·resize 로 검증한다 (mock·stub 없음).
 * webp·avif fixture 는 기존 png·jpg 를 @jsquash 로 디코드 후 인코드해 setup 안에서
 * 실제 바이트로 생성한다 (진짜 바이트 fixture — CLAUDE.md "데이터 fixture 허용").
 *
 * 권위: docs/decisions/2026-05-31-phase11d-jsquash-decode-spec(...).md §6.2.
 */
import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import decodePng from "@jsquash/png/decode";
import encodeWebp from "@jsquash/webp/encode";
import encodeAvif from "@jsquash/avif/encode";
import {
  decodeToRgba,
  probeMeta,
  encodePng,
  encodeJpeg,
  resizeRgba,
  resizeRgbaExact,
  toStaticCopy,
  type RgbaImage,
} from "./decode.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__");

const PNG_PATH = join(FIXTURES, "static-small.png"); // 50x50, 알파 있음
const NOALPHA_JPG_PATH = join(FIXTURES, "static-small-noalpha.jpg"); // 100x100, 알파 없음
const BIG_JPG_PATH = join(FIXTURES, "static-big.jpg"); // 3500x3500
const WEBP_PATH = join(FIXTURES, "static-small.webp");
const AVIF_PATH = join(FIXTURES, "static-small.avif");

function toAb(b: Buffer): ArrayBuffer {
  return b.buffer.slice(
    b.byteOffset,
    b.byteOffset + b.byteLength,
  ) as ArrayBuffer;
}

// 기존 png 를 @jsquash 로 디코드 후 webp·avif 로 인코드해 실제 fixture 파일 생성.
beforeAll(async () => {
  const png = readFileSync(PNG_PATH);
  const rgba = (await decodePng(toAb(png))) as unknown as RgbaImage;
  if (!existsSync(WEBP_PATH)) {
    const webp = await encodeWebp(
      rgba as unknown as Parameters<typeof encodeWebp>[0],
    );
    writeFileSync(WEBP_PATH, Buffer.from(webp));
  }
  if (!existsSync(AVIF_PATH)) {
    const avif = await encodeAvif(
      rgba as unknown as Parameters<typeof encodeAvif>[0],
    );
    writeFileSync(AVIF_PATH, Buffer.from(avif));
  }
});

describe("decodeToRgba", () => {
  test("png → 가로/세로 정확 + data.length === w*h*4", async () => {
    const img = await decodeToRgba(readFileSync(PNG_PATH), "image/png");
    expect(img.width).toBe(50);
    expect(img.height).toBe(50);
    expect(img.data.length).toBe(img.width * img.height * 4);
  });

  test("jpeg → 가로/세로 정확 + data.length === w*h*4", async () => {
    const img = await decodeToRgba(
      readFileSync(NOALPHA_JPG_PATH),
      "image/jpeg",
    );
    expect(img.width).toBe(100);
    expect(img.height).toBe(100);
    expect(img.data.length).toBe(img.width * img.height * 4);
  });

  test("webp → 가로/세로 정확 + data.length === w*h*4", async () => {
    const img = await decodeToRgba(readFileSync(WEBP_PATH), "image/webp");
    expect(img.width).toBe(50);
    expect(img.height).toBe(50);
    expect(img.data.length).toBe(img.width * img.height * 4);
  });

  test("avif → 가로/세로 정확 + data.length === w*h*4", async () => {
    const img = await decodeToRgba(readFileSync(AVIF_PATH), "image/avif");
    expect(img.width).toBe(50);
    expect(img.height).toBe(50);
    expect(img.data.length).toBe(img.width * img.height * 4);
  });

  test("깨진 avif → 명시 throw (사유·mime 노출)", async () => {
    // 잘린 avif 헤더 (ftyp box 만 있고 본체 없음) → @jsquash 가 null 반환 또는 throw,
    // 어댑터가 둘 다 명시 throw 로 바꾼다 (silent fallback 금지).
    const broken = Buffer.from([
      0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
    ]);
    let thrown: Error | null = null;
    try {
      await decodeToRgba(broken, "image/avif");
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain("avif");
  });

  test("움직이는 gif mime → 명시 throw (어댑터 래스터 전용)", async () => {
    let thrown: Error | null = null;
    try {
      await decodeToRgba(Buffer.from([0, 1, 2, 3]), "image/gif");
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain("image/gif");
  });

  test("지원 안 하는 mime → 명시 throw (식별자 노출)", async () => {
    let thrown: Error | null = null;
    try {
      await decodeToRgba(Buffer.from([0, 1, 2, 3]), "image/tiff");
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain("image/tiff");
  });

  // T8 차단 버그 회귀 가드: 전체 suite 에서 happy-dom 이 전역 fetch 를 file:// 거부 버전으로
  // 덮으면 @jsquash 자동 적재가 깨졌다. 수동 init (import.meta.resolve + readFileSync +
  // WebAssembly.compile) 은 전역 fetch 를 안 거치므로, 전역 fetch 가 깨진 상태에서도 디코드가
  // 정상 작동해야 한다. afterEach 로 전역 fetch 를 복원해 다른 테스트를 오염시키지 않는다.
  describe("전역 fetch 깨진 상태 (happy-dom file:// 거부 재현)", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    test("webp 디코드 — 전역 fetch throw 여도 정상 (수동 init 이 fetch 무관)", async () => {
      globalThis.fetch = (async () => {
        throw new Error(
          'Failed to fetch from "file://...": URL scheme "file" is not supported.',
        );
      }) as unknown as typeof globalThis.fetch;
      const img = await decodeToRgba(readFileSync(WEBP_PATH), "image/webp");
      expect(img.width).toBe(50);
      expect(img.height).toBe(50);
      expect(img.data.length).toBe(img.width * img.height * 4);
    });
  });
});

describe("probeMeta", () => {
  test("알파 있는 png → hasAlpha=true", async () => {
    const meta = await probeMeta(readFileSync(PNG_PATH), "image/png");
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(50);
    expect(meta.hasAlpha).toBe(true);
  });

  test("알파 없는 jpeg → hasAlpha=false", async () => {
    const meta = await probeMeta(
      readFileSync(NOALPHA_JPG_PATH),
      "image/jpeg",
    );
    expect(meta.hasAlpha).toBe(false);
  });
});

describe("resizeRgba", () => {
  test("큰 이미지 (3500x3500) → 512 안으로 비율 유지 축소", async () => {
    const big = await decodeToRgba(readFileSync(BIG_JPG_PATH), "image/jpeg");
    const resized = await resizeRgba(big, 512);
    expect(resized.width).toBeLessThanOrEqual(512);
    expect(resized.height).toBeLessThanOrEqual(512);
    // 정사각 입력 → 긴 변이 512 에 닿는다.
    expect(Math.max(resized.width, resized.height)).toBe(512);
    expect(resized.data.length).toBe(resized.width * resized.height * 4);
  });

  test("이미 한도 안 작은 이미지 → 그대로 (확대 안 함)", async () => {
    const small = await decodeToRgba(readFileSync(PNG_PATH), "image/png");
    const resized = await resizeRgba(small, 512);
    expect(resized.width).toBe(50);
    expect(resized.height).toBe(50);
  });
});

describe("resizeRgbaExact (SigLIP 256×256 고정 입력용 — 비율 유지 안 함)", () => {
  test("작은 정사각 (50x50) → 정확히 256×256 으로 확대", async () => {
    const small = await decodeToRgba(readFileSync(PNG_PATH), "image/png");
    const r = await resizeRgbaExact(small, 256, 256);
    expect(r.width).toBe(256);
    expect(r.height).toBe(256);
    expect(r.data.length).toBe(256 * 256 * 4);
  });

  test("비정사각 (100x100 jpg) → 정확히 256×256 (비율 무시 stretch)", async () => {
    const img = await decodeToRgba(readFileSync(NOALPHA_JPG_PATH), "image/jpeg");
    const r = await resizeRgbaExact(img, 256, 256);
    expect(r.width).toBe(256);
    expect(r.height).toBe(256);
    expect(r.data.length).toBe(256 * 256 * 4);
  });

  test("큰 이미지 (3500x3500) → 정확히 256×256 으로 축소", async () => {
    const big = await decodeToRgba(readFileSync(BIG_JPG_PATH), "image/jpeg");
    const r = await resizeRgbaExact(big, 256, 256);
    expect(r.width).toBe(256);
    expect(r.height).toBe(256);
    expect(r.data.length).toBe(256 * 256 * 4);
  });

  test("이미 같은 크기면 그대로 반환 (resize 왕복 없음)", async () => {
    const img = await decodeToRgba(readFileSync(NOALPHA_JPG_PATH), "image/jpeg");
    // 100x100 → 100x100 요청 = 같은 크기 → 입력 그대로.
    const r = await resizeRgbaExact(img, 100, 100);
    expect(r.width).toBe(100);
    expect(r.height).toBe(100);
    expect(r).toBe(img);
  });
});

describe("encodePng / encodeJpeg 왕복", () => {
  test("png 인코드 → 재디코드 가로/세로 보존", async () => {
    const img = await decodeToRgba(readFileSync(PNG_PATH), "image/png");
    const pngBytes = await encodePng(img);
    expect(pngBytes.byteLength).toBeGreaterThan(0);
    const back = await decodeToRgba(pngBytes, "image/png");
    expect(back.width).toBe(50);
    expect(back.height).toBe(50);
  });

  test("jpeg 인코드 → 재디코드 가로/세로 보존", async () => {
    const img = await decodeToRgba(readFileSync(NOALPHA_JPG_PATH), "image/jpeg");
    const jpegBytes = await encodeJpeg(img);
    expect(jpegBytes.byteLength).toBeGreaterThan(0);
    const back = await decodeToRgba(jpegBytes, "image/jpeg");
    expect(back.width).toBe(100);
    expect(back.height).toBe(100);
  });
});

describe("toStaticCopy", () => {
  test("알파 있는 입력 (png) → outMime image/png", async () => {
    const copy = await toStaticCopy(readFileSync(PNG_PATH), "image/png", 2048);
    expect(copy.outMime).toBe("image/png");
    expect(copy.buffer.byteLength).toBeGreaterThan(0);
    // PNG magic
    expect(copy.buffer[0]).toBe(0x89);
    expect(copy.buffer[1]).toBe(0x50);
  });

  test("알파 없는 입력 (jpeg) → outMime image/jpeg", async () => {
    const copy = await toStaticCopy(
      readFileSync(NOALPHA_JPG_PATH),
      "image/jpeg",
      2048,
    );
    expect(copy.outMime).toBe("image/jpeg");
    expect(copy.buffer.byteLength).toBeGreaterThan(0);
    // JPEG magic (FF D8)
    expect(copy.buffer[0]).toBe(0xff);
    expect(copy.buffer[1]).toBe(0xd8);
  });
});
