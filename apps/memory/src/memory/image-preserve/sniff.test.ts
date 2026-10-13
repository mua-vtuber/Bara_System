/**
 * sniff.test.ts — Phase 11d D6 파일 시그니처(magic bytes) 판정 검증.
 *
 * 실제 fixture 바이트(png/jpg/gif/webp/avif)로 각 형식 정확 판정 + heic 시그니처
 * (합성 ftyp+heic brand) → heic 판정 + 위장(.jpg 헤더가 실제 webp) → webp 판정.
 * Mock·stub 0 — 실제 파일 바이트만 사용 (CLAUDE.md "데이터 fixture 허용").
 *
 * webp·avif fixture 가 디스크에 없으면 png 를 @jsquash 로 디코드 후 인코드해 생성한다
 * (decode.test.ts 와 같은 통로 — 진짜 바이트).
 *
 * 권위: docs/decisions/2026-05-31-phase11d-jsquash-decode-spec(...).md §6.5 + §8.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import decodePng from "@jsquash/png/decode";
import encodeWebp from "@jsquash/webp/encode";
import encodeAvif from "@jsquash/avif/encode";
import { sniffImageMime } from "./sniff.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__");

const PNG_PATH = join(FIXTURES, "static-small.png");
const JPG_PATH = join(FIXTURES, "static-small-noalpha.jpg");
const GIF_PATH = join(FIXTURES, "animated-small.gif");
const WEBP_PATH = join(FIXTURES, "static-small.webp");
const AVIF_PATH = join(FIXTURES, "static-small.avif");

function toAb(b: Buffer): ArrayBuffer {
  return b.buffer.slice(
    b.byteOffset,
    b.byteOffset + b.byteLength,
  ) as ArrayBuffer;
}

// webp·avif fixture 가 없으면 png 디코드 후 인코드해 실제 바이트로 생성.
beforeAll(async () => {
  const png = readFileSync(PNG_PATH);
  if (!existsSync(WEBP_PATH) || !existsSync(AVIF_PATH)) {
    const rgba = (await decodePng(toAb(png))) as unknown as Parameters<
      typeof encodeWebp
    >[0];
    if (!existsSync(WEBP_PATH)) {
      const webp = await encodeWebp(rgba);
      writeFileSync(WEBP_PATH, Buffer.from(webp));
    }
    if (!existsSync(AVIF_PATH)) {
      const avif = await encodeAvif(
        rgba as unknown as Parameters<typeof encodeAvif>[0],
      );
      writeFileSync(AVIF_PATH, Buffer.from(avif));
    }
  }
});

describe("sniffImageMime — 실제 fixture 형식 판정", () => {
  test("PNG fixture → image/png", () => {
    expect(sniffImageMime(readFileSync(PNG_PATH))).toBe("image/png");
  });

  test("JPEG fixture → image/jpeg", () => {
    expect(sniffImageMime(readFileSync(JPG_PATH))).toBe("image/jpeg");
  });

  test("GIF fixture → image/gif", () => {
    expect(sniffImageMime(readFileSync(GIF_PATH))).toBe("image/gif");
  });

  test("WebP fixture → image/webp (RIFF....WEBP)", () => {
    expect(sniffImageMime(readFileSync(WEBP_PATH))).toBe("image/webp");
  });

  test("AVIF fixture → image/avif (ftyp + avif brand)", () => {
    expect(sniffImageMime(readFileSync(AVIF_PATH))).toBe("image/avif");
  });
});

describe("sniffImageMime — heic 식별 (거부용)", () => {
  // 합성 ftyp 컨테이너 — major_brand 'heic'. 실제 heic 디코드는 안 하므로 헤더만
  // 만들면 충분 (sniff 는 brand 만 본다).
  function heicHeader(brand: string): Buffer {
    // [box size 0x00000020][ftyp][major_brand][minor_version][compatible: brand,mif1]
    const head = Buffer.from([0x00, 0x00, 0x00, 0x20]); // box size 32
    const ftyp = Buffer.from("ftyp", "latin1");
    const major = Buffer.from(brand, "latin1");
    const minor = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    const compat = Buffer.concat([
      Buffer.from(brand, "latin1"),
      Buffer.from("mif1", "latin1"),
    ]);
    return Buffer.concat([head, ftyp, major, minor, compat]);
  }

  test("ftyp + 'heic' brand → image/heic", () => {
    expect(sniffImageMime(heicHeader("heic"))).toBe("image/heic");
  });

  test("ftyp + 'heix' brand → image/heic", () => {
    expect(sniffImageMime(heicHeader("heix"))).toBe("image/heic");
  });

  test("ftyp + 'mif1' brand (heic 계열) → image/heic", () => {
    expect(sniffImageMime(heicHeader("mif1"))).toBe("image/heic");
  });
});

describe("sniffImageMime — 위장 / 판정 불가", () => {
  test("이름은 .jpg 라도 실제 바이트가 webp 면 → image/webp", () => {
    // 호출자는 mime='image/jpeg' 로 들어오지만 buffer 는 실제 webp 바이트.
    // sniff 는 buffer 만 본다 → webp 로 판정 (이름 무시).
    const webpBytes = readFileSync(WEBP_PATH);
    expect(sniffImageMime(webpBytes)).toBe("image/webp");
  });

  test("시그니처 미일치(텍스트) → null (호출자가 들어온 mime 신뢰)", () => {
    expect(sniffImageMime(Buffer.from("이건 이미지가 아닙니다"))).toBeNull();
  });

  test("빈 buffer → null (짧아서 판정 불가)", () => {
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });

  test("RIFF 지만 WEBP 폼이 아니면 → null (wav 등)", () => {
    // RIFF....WAVE — webp 가 아니므로 null.
    const riffWave = Buffer.concat([
      Buffer.from("RIFF", "latin1"),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from("WAVE", "latin1"),
    ]);
    expect(sniffImageMime(riffWave)).toBeNull();
  });
});
