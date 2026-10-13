/**
 * image-preserve/thumb.ts — 미리보기 ≤previewMaxPx PNG 사본 산출.
 *
 * 보존 모드 무관 — 모든 입력 이미지에 대해 한 장의 작은 미리보기 PNG 를 만든다.
 *
 * 디코더 분기 (Phase 11d):
 *   - 래스터 (webp/avif/png/jpeg) → @jsquash `toPreviewPng` (decode.ts).
 *     옛 jimp 가 webp/avif 를 못 읽어 미리보기 단계가 throw 하던 흠을 근본 해결.
 *   - 움직이는 (GIF/APNG, ANIMATED_MIMES) → jimp 첫 프레임 PNG. @jsquash 가 GIF
 *     디코더를 제공하지 않고 jimp 가 이미 정상 디코드하므로 잔존.
 *
 * 크기 정합: 가로·세로 둘 다 previewMaxPx 안으로 들어오도록 비율 유지 축소.
 * 입력이 이미 ≤previewMaxPx 면 원본 비율 그대로 PNG 재인코드 (확대 안 함).
 *
 * 형식: 미리보기는 항상 PNG 한 갈래로 단순화. 알파 검사 분기는 mode.ts 의 자산 사본
 * 단계에서 다룬다.
 *
 * 권위: docs/decisions/2026-05-31-phase11d-jsquash-decode-spec(...).md §6.4 + plan T3.
 */
import { Jimp } from "jimp";
import { toPreviewPng } from "./decode.ts";
import { ANIMATED_MIMES } from "./types.ts";

/**
 * 움직이는 (GIF/APNG) 입력의 첫 프레임 PNG 미리보기 — jimp 경로.
 */
async function generateAnimatedThumb(
  buffer: Buffer,
  maxPx: number,
): Promise<{ buffer: Buffer; mime: "image/png" }> {
  let img: Awaited<ReturnType<typeof Jimp.read>>;
  try {
    img = await Jimp.read(buffer);
  } catch (e) {
    throw new Error(
      `미리보기 생성 실패 (디코드 단계): ${(e as Error).message}`,
    );
  }

  // 가로·세로 둘 다 maxPx 안으로 — 비율 유지 축소.
  if (img.width > maxPx || img.height > maxPx) {
    img.scaleToFit({ w: maxPx, h: maxPx });
  }

  try {
    const out = await img.getBuffer("image/png");
    return { buffer: out as Buffer, mime: "image/png" };
  } catch (e) {
    throw new Error(
      `미리보기 생성 실패 (PNG 인코드 단계): ${(e as Error).message}`,
    );
  }
}

/**
 * 미리보기 PNG 산출.
 *
 * mime 으로 디코더 분기:
 *   - ANIMATED_MIMES (image/gif · image/apng) → jimp 첫 프레임 PNG.
 *   - 그 외 래스터 (webp/avif/png/jpeg) → @jsquash decode.ts `toPreviewPng`.
 *
 * @param buffer 입력 이미지 바이트 (정지 / 움직이는 둘 다)
 * @param mime 입력 mime (호출자가 분류)
 * @param maxPx 가로/세로 한도 (px)
 * @returns { buffer: PNG 바이트, mime: 'image/png' }
 */
export async function generateThumb(
  buffer: Buffer,
  mime: string,
  maxPx: number,
): Promise<{ buffer: Buffer; mime: "image/png" }> {
  if (ANIMATED_MIMES.has(mime)) {
    return generateAnimatedThumb(buffer, maxPx);
  }

  // 래스터 갈래 — @jsquash 디코드 → 비율 유지 축소 → PNG 인코드.
  let out: Buffer;
  try {
    out = await toPreviewPng(buffer, mime, maxPx);
  } catch (e) {
    throw new Error(
      `미리보기 생성 실패 (mime '${mime}'): ${(e as Error).message}`,
    );
  }
  return { buffer: out, mime: "image/png" };
}
