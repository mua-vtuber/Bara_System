/**
 * image-preserve/decode.ts — Phase 11d @jsquash 순수 WASM 디코드 어댑터 (D1).
 *
 * 옛 sharp 가 A1 ARM64 + Bun 에 native 빌드 실패해 이미지 입력이 처음부터 막혔다.
 * 그 자리를 순수 WASM `@jsquash` 로 갈음한 얇은 어댑터 — webp/avif/png/jpeg 래스터
 * 디코드 + 비율 유지 축소 + png/jpeg 인코드를 한 통로에 모은다.
 *
 * WASM 적재 = 수동 init (자동 적재 안 씀). @jsquash 의 자동 적재는 전역 `fetch()` 로
 * `file://` URL 의 `.wasm` 을 읽는데, 전체 테스트 suite 에서 happy-dom 이 전역 `fetch`
 * 를 `file://` 거부하는 버전으로 덮어 그 뒤 디코드가 전부 깨졌다 (T8 차단 버그). 그래서
 * 각 코덱의 `.wasm` 을 `import.meta.resolve` 로 해석 → `readFileSync` → `WebAssembly.compile`
 * → 코덱별 `init(module)` 로 직접 적재한다. 전역 `fetch` 거동에 의존하지 않으므로 A1
 * ARM64 Bun 배포도 견고해진다. 코덱별 init 은 모듈 스코프에서 한 번만 (lazy memo) 수행.
 *
 * 다루는 mime = image/webp · image/avif · image/png · image/jpeg 래스터 한정.
 * GIF/APNG (움직이는 갈래) 는 이 어댑터가 다루지 않는다 — jimp 가 담당 (gif-firstframe.ts).
 * 받으면 명시 throw 로 "래스터 전용" 알린다.
 *
 * Silent fallback 금지: 디코드 실패는 빈 결과로 둔갑하지 않고 사유·mime 을 담아 throw.
 * avif decode 가 malformed 시 null 을 반환할 수 있어 (@jsquash 계약), null 가드 후
 * 명시 throw 로 바꾼다 — null 을 그대로 흘리지 않는다.
 *
 * 권위: docs/decisions/2026-05-31-phase11d-jsquash-decode-spec(...).md §6.2.
 */
import { readFileSync } from "node:fs";
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode";
import decodeAvif, { init as initAvifDecode } from "@jsquash/avif/decode";
import decodePng, { init as initPngDecode } from "@jsquash/png/decode";
import decodeJpeg, { init as initJpegDecode } from "@jsquash/jpeg/decode";
import encodePngRaw, { init as initPngEncode } from "@jsquash/png/encode";
import encodeJpegRaw, { init as initJpegEncode } from "@jsquash/jpeg/encode";
import resize, { initResize } from "@jsquash/resize";

/**
 * 코덱별 `.wasm` 파일 경로 spec — `import.meta.resolve` 인자. 하드코딩 금지 원칙에 따라
 * 절대 경로를 직접 적지 않고 패키지 하위 경로 spec 만 한 곳에 모은다. 실제 경로는 런타임에
 * `import.meta.resolve(spec)` 가 node_modules 위치를 풀어 해석한다.
 *
 * png 은 디코드·인코드가 같은 wasm-bindgen 모듈(`squoosh_png_bg.wasm`)을 공유하므로
 * spec 이 하나다 (compile 한 번 후 decode·encode 두 init 에 같은 모듈을 넘긴다).
 * webp/avif/jpeg 는 디코드·인코드 wasm 이 별개라 디코드용·(jpeg 는 인코드용도) 따로 둔다.
 */
const WASM_SPEC = {
  png: "@jsquash/png/codec/pkg/squoosh_png_bg.wasm",
  webpDecode: "@jsquash/webp/codec/dec/webp_dec.wasm",
  avifDecode: "@jsquash/avif/codec/dec/avif_dec.wasm",
  jpegDecode: "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm",
  jpegEncode: "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm",
  resize: "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm",
} as const;

/**
 * spec 문자열 → 컴파일된 `WebAssembly.Module`. `import.meta.resolve` 로 `.wasm` 의 file://
 * URL 을 얻어 경로화 후 `readFileSync` 로 읽고 `WebAssembly.compile` 한다. 전역 `fetch` 를
 * 거치지 않으므로 happy-dom 의 `file://` 거부에 영향받지 않는다.
 *
 * 적재 실패 시 어느 `.wasm` spec 인지 사유와 함께 담아 명시 throw — 누락 식별자를 노출한다
 * (silent fallback 금지, spec §6.2).
 */
async function compileWasm(spec: string): Promise<WebAssembly.Module> {
  let path: string;
  try {
    const url = import.meta.resolve(spec);
    path = Bun.fileURLToPath(url);
  } catch (e) {
    throw new Error(
      `@jsquash .wasm 경로 해석 실패 (spec '${spec}'): ${(e as Error).message}`,
    );
  }
  try {
    const buf = readFileSync(path);
    const ab = buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
    return await WebAssembly.compile(ab);
  } catch (e) {
    throw new Error(
      `@jsquash .wasm 적재 실패 (spec '${spec}', 경로 '${path}'): ${(e as Error).message}`,
    );
  }
}

// 코덱별 init memo — 처음 호출 시 compile + init, 이후 같은 Promise 재사용 (중복 적재 회피).
// png 은 decode·encode 가 같은 wasm 을 쓰지만 각자 별도 모듈 스코프 init/memo 를 가지므로
// (@jsquash/png 내부 구조), 컴파일된 모듈 하나를 두 init 에 모두 넘겨 한 memo 로 묶는다.
let pngInited: Promise<void> | null = null;
let webpDecodeInited: Promise<void> | null = null;
let avifDecodeInited: Promise<void> | null = null;
let jpegDecodeInited: Promise<void> | null = null;
let jpegEncodeInited: Promise<void> | null = null;
let resizeInited: Promise<void> | null = null;

/** png 디코드·인코드 — 같은 `squoosh_png_bg.wasm` 하나로 두 init 을 함께 적재. */
function ensurePngInited(): Promise<void> {
  if (!pngInited) {
    pngInited = (async () => {
      const mod = await compileWasm(WASM_SPEC.png);
      await initPngDecode(mod);
      await initPngEncode(mod);
    })();
  }
  return pngInited;
}

/** webp 디코드 wasm 적재 (`webp_dec.wasm`). */
function ensureWebpDecodeInited(): Promise<void> {
  if (!webpDecodeInited) {
    webpDecodeInited = (async () => {
      await initWebpDecode(await compileWasm(WASM_SPEC.webpDecode));
    })();
  }
  return webpDecodeInited;
}

/** avif 디코드 wasm 적재 (`avif_dec.wasm`). */
function ensureAvifDecodeInited(): Promise<void> {
  if (!avifDecodeInited) {
    avifDecodeInited = (async () => {
      await initAvifDecode(await compileWasm(WASM_SPEC.avifDecode));
    })();
  }
  return avifDecodeInited;
}

/** jpeg 디코드 wasm 적재 (`mozjpeg_dec.wasm`). */
function ensureJpegDecodeInited(): Promise<void> {
  if (!jpegDecodeInited) {
    jpegDecodeInited = (async () => {
      await initJpegDecode(await compileWasm(WASM_SPEC.jpegDecode));
    })();
  }
  return jpegDecodeInited;
}

/** jpeg 인코드 wasm 적재 (`mozjpeg_enc.wasm`). */
function ensureJpegEncodeInited(): Promise<void> {
  if (!jpegEncodeInited) {
    jpegEncodeInited = (async () => {
      await initJpegEncode(await compileWasm(WASM_SPEC.jpegEncode));
    })();
  }
  return jpegEncodeInited;
}

/** resize wasm 적재 (`squoosh_resize_bg.wasm`, default lanczos3 메서드용). */
function ensureResizeInited(): Promise<void> {
  if (!resizeInited) {
    resizeInited = (async () => {
      await initResize(await compileWasm(WASM_SPEC.resize));
    })();
  }
  return resizeInited;
}

/**
 * RGBA 8bit 픽셀 묶음 — @jsquash 디코드·인코드·resize 가 주고받는 평범한 객체.
 * ImageData 클래스 불필요 (T1 게이트 실측 — 평범한 `{data,width,height}` 로 작동).
 */
export interface RgbaImage {
  /** RGBA 4채널 8bit 픽셀 (length === width * height * 4). */
  data: Uint8ClampedArray;
  /** 가로 (px). */
  width: number;
  /** 세로 (px). */
  height: number;
}

/** 이 어댑터가 래스터로 다루는 mime → @jsquash 디코더 묶음. */
const RASTER_MIMES = new Set([
  "image/webp",
  "image/avif",
  "image/png",
  "image/jpeg",
]);

/** GIF/APNG 등 jimp 가 담당하는 움직이는 mime 묶음 — 이 어댑터는 거부한다. */
const ANIMATED_MIMES = new Set(["image/gif", "image/apng"]);

/**
 * Buffer → ArrayBuffer 변환. @jsquash 디코더 입력 양식.
 * subarray 가 공유 버퍼를 가리킬 수 있어 byteOffset~byteLength 구간만 잘라 넘긴다.
 */
function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

/**
 * RGBA 픽셀 알파 채널 검사 — A 값이 하나라도 255 미만이면 true (투명 존재),
 * 전부 255(불투명)면 false.
 */
function rgbaHasAlpha(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    if (a !== undefined && a < 255) {
      return true;
    }
  }
  return false;
}

/**
 * mime 별 @jsquash 래스터 디코더 선택 → RGBA 8bit 픽셀 산출.
 *
 * 지원 mime: image/webp · image/avif · image/png · image/jpeg.
 * GIF/APNG 을 넘기면 "래스터 전용" 명시 throw — 그 갈래는 jimp 가 담당한다.
 * 그 외 알 수 없는 mime 도 식별자를 담아 throw.
 *
 * avif 는 malformed 시 @jsquash 가 null 을 반환할 수 있어 (또는 자체 throw),
 * 둘 다 사유·mime 을 담은 명시 throw 로 바꾼다 — 빈 결과로 둔갑하지 않는다.
 *
 * @param buffer 입력 이미지 바이트
 * @param mime 입력 mime (호출자가 분류)
 * @returns RGBA 8bit 픽셀 + 가로/세로
 */
export async function decodeToRgba(
  buffer: Buffer,
  mime: string,
): Promise<RgbaImage> {
  if (ANIMATED_MIMES.has(mime)) {
    throw new Error(
      `decode.ts 어댑터는 래스터(정지) 이미지 전용입니다. 움직이는 mime '${mime}' 은 gif-firstframe.ts(jimp) 가 다룹니다.`,
    );
  }
  if (!RASTER_MIMES.has(mime)) {
    throw new Error(
      `decode.ts 가 다루지 못하는 mime '${mime}'. 지원 mime: ${[...RASTER_MIMES].join(", ")}.`,
    );
  }

  const ab = toArrayBuffer(buffer);

  if (mime === "image/avif") {
    await ensureAvifDecodeInited();
    let decoded: RgbaImage | null;
    try {
      decoded = (await decodeAvif(ab)) as RgbaImage | null;
    } catch (e) {
      throw new Error(
        `avif 디코드 실패 (mime '${mime}'): ${(e as Error).message}`,
      );
    }
    if (decoded === null) {
      throw new Error(
        `avif 디코드 실패 (mime '${mime}'): @jsquash 가 null 반환 (malformed 또는 미지원 avif).`,
      );
    }
    return decoded;
  }

  if (mime === "image/webp") {
    await ensureWebpDecodeInited();
    return (await decodeWebp(ab)) as unknown as RgbaImage;
  }
  if (mime === "image/png") {
    await ensurePngInited();
    return (await decodePng(ab)) as unknown as RgbaImage;
  }
  // 남은 갈래 = image/jpeg (RASTER_MIMES 검사로 보장).
  await ensureJpegDecodeInited();
  return (await decodeJpeg(ab)) as unknown as RgbaImage;
}

/**
 * 디코드 후 RGBA 알파 채널 존재 검사 + 가로/세로 산출.
 * A 값이 하나라도 255 미만이면 hasAlpha=true, 전부 255(불투명)면 false.
 *
 * @param buffer 입력 이미지 바이트
 * @param mime 입력 mime
 * @returns 가로/세로 + 알파 존재 여부
 */
export async function probeMeta(
  buffer: Buffer,
  mime: string,
): Promise<{ width: number; height: number; hasAlpha: boolean }> {
  const img = await decodeToRgba(buffer, mime);
  return {
    width: img.width,
    height: img.height,
    hasAlpha: rgbaHasAlpha(img.data),
  };
}

/**
 * RGBA 픽셀 → PNG 바이트 인코드 (@jsquash/png). 반환 ArrayBuffer 를 Buffer 로 변환.
 *
 * @param rgba RGBA 8bit 픽셀 + 가로/세로
 * @returns PNG 바이트
 */
export async function encodePng(rgba: RgbaImage): Promise<Buffer> {
  await ensurePngInited();
  const ab = await encodePngRaw(
    rgba as unknown as Parameters<typeof encodePngRaw>[0],
  );
  return Buffer.from(ab);
}

/**
 * RGBA 픽셀 → JPEG 바이트 인코드 (@jsquash/jpeg). 반환 ArrayBuffer 를 Buffer 로 변환.
 *
 * @param rgba RGBA 8bit 픽셀 + 가로/세로
 * @returns JPEG 바이트
 */
export async function encodeJpeg(rgba: RgbaImage): Promise<Buffer> {
  await ensureJpegEncodeInited();
  const ab = await encodeJpegRaw(
    rgba as unknown as Parameters<typeof encodeJpegRaw>[0],
  );
  return Buffer.from(ab);
}

/**
 * 비율 유지 축소 — 가로·세로 둘 다 targetMaxPx 안으로 들어오게 목표 크기 계산 후 resize.
 * jimp `scaleToFit` 동등 의미. 이미 둘 다 ≤targetMaxPx 면 그대로 반환 (재축소 안 함 —
 * 확대하지 않는다).
 *
 * @param image 입력 RGBA 픽셀 + 가로/세로
 * @param targetMaxPx 가로/세로 한도 (px)
 * @returns 축소된 (또는 그대로인) RGBA 픽셀 + 새 가로/세로
 */
export async function resizeRgba(
  image: RgbaImage,
  targetMaxPx: number,
): Promise<RgbaImage> {
  if (image.width <= targetMaxPx && image.height <= targetMaxPx) {
    return image;
  }
  // 긴 변을 targetMaxPx 에 맞추는 축소 비율 — 가로·세로 둘 다 한도 안으로 들어온다.
  const scale = targetMaxPx / Math.max(image.width, image.height);
  const outWidth = Math.max(1, Math.round(image.width * scale));
  const outHeight = Math.max(1, Math.round(image.height * scale));
  await ensureResizeInited();
  const resized = (await resize(
    image as unknown as Parameters<typeof resize>[0],
    {
      width: outWidth,
      height: outHeight,
      fitMethod: "contain",
    },
  )) as unknown as RgbaImage;
  return resized;
}

/**
 * 정확한 가로×세로로 resize (비율 유지 안 함 — SigLIP 256×256 고정 입력용).
 *
 * `resizeRgba` 와 달리 긴 변 한도가 아니라 가로·세로를 그대로 targetWidth/targetHeight
 * 로 맞춘다. SigLIP 2 의 vision tower 는 256×256 정확 입력을 요구하므로 (비율 유지
 * letterbox 가 아니라 늘려서라도 정확 256×256) 이 통로를 따로 둔다.
 *
 * @jsquash/resize 의 `fitMethod: "stretch"` = 비율 무시 정확 채움. 이미 같은 크기면
 * resize 호출 없이 그대로 돌려준다 (불필요한 WASM 왕복 회피).
 *
 * @param image 입력 RGBA 픽셀 + 가로/세로
 * @param targetWidth 결과 가로 (px)
 * @param targetHeight 결과 세로 (px)
 * @returns 정확히 targetWidth×targetHeight 인 RGBA 픽셀
 */
export async function resizeRgbaExact(
  image: RgbaImage,
  targetWidth: number,
  targetHeight: number,
): Promise<RgbaImage> {
  if (image.width === targetWidth && image.height === targetHeight) {
    return image;
  }
  await ensureResizeInited();
  const resized = (await resize(
    image as unknown as Parameters<typeof resize>[0],
    {
      width: targetWidth,
      height: targetHeight,
      fitMethod: "stretch",
    },
  )) as unknown as RgbaImage;
  return resized;
}

/**
 * 디코드 → 비율 유지 축소 → PNG 인코드. 미리보기·검색 사본 산출 통로.
 *
 * @param buffer 입력 이미지 바이트
 * @param mime 입력 mime
 * @param maxPx 가로/세로 한도 (px)
 * @returns PNG 바이트
 */
export async function toPreviewPng(
  buffer: Buffer,
  mime: string,
  maxPx: number,
): Promise<Buffer> {
  const decoded = await decodeToRgba(buffer, mime);
  const resized = await resizeRgba(decoded, maxPx);
  return encodePng(resized);
}

/**
 * 디코드 → 비율 유지 축소 → 알파 검사 → 양식 분기 인코드.
 * 알파 있으면 PNG(image/png), 없으면 JPEG(image/jpeg). jimp `hasAlpha()` 분기 동등.
 *
 * @param buffer 입력 이미지 바이트
 * @param mime 입력 mime
 * @param maxPx 가로/세로 한도 (px)
 * @returns 사본 바이트 + 결과 mime
 */
export async function toStaticCopy(
  buffer: Buffer,
  mime: string,
  maxPx: number,
): Promise<{ buffer: Buffer; outMime: "image/png" | "image/jpeg" }> {
  const decoded = await decodeToRgba(buffer, mime);
  const resized = await resizeRgba(decoded, maxPx);

  if (rgbaHasAlpha(resized.data)) {
    return { buffer: await encodePng(resized), outMime: "image/png" };
  }
  return { buffer: await encodeJpeg(resized), outMime: "image/jpeg" };
}
