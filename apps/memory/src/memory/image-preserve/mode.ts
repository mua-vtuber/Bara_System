/**
 * image-preserve/mode.ts — Phase 11a T4 보존 모드 분기 + 자산 사본 + 미리보기.
 *
 * settings.images.preserveMode 값에 따라 입력 이미지를 세 갈래로 처리:
 *
 *   - 'original': 한도 무관 원본 그대로 자산 보관.
 *   - 'resized': 한도 무관 사본 (정지 = max searchCopyMaxPx 축소, 움직이는 =
 *     첫프레임 PNG + 움직임 손실 경고).
 *   - 'smart' (default):
 *       · 정지 + ≤passthroughMaxMb + ≤passthroughMaxPx → 원본 그대로
 *       · 정지 + 초과 → resized 와 같은 사본 흐름
 *       · 움직이는 + ≤animatedPassthroughMaxMb → 원본 그대로
 *       · 움직이는 + 초과 → 첫프레임 PNG + 움직임 손실 경고
 *
 * 디코더 분기 (Phase 11d):
 *   - 래스터 (webp/avif/png/jpeg) → @jsquash decode.ts (probeMeta / toStaticCopy).
 *     옛 jimp 가 webp/avif 를 못 읽어 보존 모드가 처음부터 throw 하던 흠을 근본 해결.
 *   - 움직이는 (GIF/APNG, ANIMATED_MIMES) → jimp 첫 프레임 PNG (gif-firstframe.ts).
 *     @jsquash GIF 디코더 부재 + GIF/APNG 는 jimp 가 이미 정상 디코드 → jimp 잔존.
 *
 * 모든 갈래에서 미리보기 ≤previewMaxPx PNG 가 별도로 산출된다 (thumb.ts).
 *
 * 사본 형식: searchCopyFormat='auto' 한 갈래 — 알파 검사 결과 알파 있으면 PNG,
 * 없으면 JPEG. settings 안 'auto' 외 갈래는 11a 범위 밖.
 *
 * D3 graceful (Phase 11d): 원본 그대로 보관하는 갈래('original' 모드 또는 smart
 * 통과)에서 가로·세로 측정이나 미리보기 생성이 실패해도 원본 바이트(assetBuffer)는
 * 무조건 보관한다. 측정 실패 시 width/height=0 + warnings 에 정직 경고를 남긴다.
 * 사본이 필수인 갈래(resized / smart 초과)는 디코드 실패 시 원본 보존 의미가 없어
 * 명시 throw 로 전파한다. (silent fallback 금지 — 실패는 항상 warnings 또는 throw.)
 *
 * Silent fallback 금지: 움직임 손실·디코드 실패는 warnings 배열에 명시 문자열로 추가.
 * Mock 금지: 실제 jimp/@jsquash 호출. 하드코딩 금지: 모든 한도는 settings 인자에서 수신.
 *
 * 권위: docs/decisions/2026-05-31-phase11d-jsquash-decode-spec(...).md §6.4 + plan T3.
 */
import {
  ANIMATED_MIMES,
  MOTION_LOSS_WARNING,
  type PreserveResult,
  type PreserveSettings,
} from "./types.ts";
import { extractFirstFramePng } from "./gif-firstframe.ts";
import { generateThumb } from "./thumb.ts";
import { probeMeta, toStaticCopy } from "./decode.ts";

/** 바이트 → MB 단위 변환 (1 MB = 1024*1024 B). */
function toMb(byteLength: number): number {
  return byteLength / (1024 * 1024);
}

/**
 * 입력 mime 가 움직이는 이미지 갈래인지 판정.
 * animated webp 는 정지 webp 와 mime 공유 — 11a 안 단순화: gif/apng 한 갈래만 true.
 */
function isAnimatedMime(mime: string): boolean {
  return ANIMATED_MIMES.has(mime);
}

/**
 * 정지(래스터) 이미지 사본 산출 — `searchCopyMaxPx` 한도 안으로 축소 + 알파 검사
 * 양식 분기. 알파 있으면 PNG, 없으면 JPEG. @jsquash decode.ts `toStaticCopy` 경유
 * (디코드 → 비율 유지 축소 → 알파 검사 → png/jpeg 인코드). jimp `scaleToFit`/
 * `hasAlpha()` 동등 의미 보존.
 */
async function makeStaticCopy(
  buffer: Buffer,
  mime: string,
  maxPx: number,
): Promise<{ buffer: Buffer; outMime: "image/png" | "image/jpeg" }> {
  return toStaticCopy(buffer, mime, maxPx);
}

/**
 * 가로·세로 측정 — 래스터는 @jsquash `probeMeta`, 움직이는 갈래는 첫 프레임 PNG 를
 * 거쳐 같은 png 통로로 측정한다 (일관 통로).
 */
async function probeDimensions(
  buffer: Buffer,
  mime: string,
  isAnimated: boolean,
): Promise<{ width: number; height: number }> {
  if (isAnimated) {
    // 움직이는 갈래 → 첫 프레임 정지 PNG 한 번 거쳐 png 통로로 측정.
    const firstFrame = await extractFirstFramePng(buffer);
    const meta = await probeMeta(firstFrame, "image/png");
    return { width: meta.width, height: meta.height };
  }
  const meta = await probeMeta(buffer, mime);
  return { width: meta.width, height: meta.height };
}

/**
 * 보존 모드 분기 적용 → 자산 + 미리보기 + metadata + 손실 경고.
 *
 * @param buffer 입력 이미지 바이트
 * @param mime 입력 mime (호출자가 분류 — 'image/png' / 'image/jpeg' / 'image/gif' 등)
 * @param settings PreserveSettings — settings.images 와 1:1 정합
 * @returns PreserveResult — assetBuffer + thumbBuffer + width/height + isAnimated + warnings + outMime
 */
export async function applyPreserveMode(
  buffer: Buffer,
  mime: string,
  settings: PreserveSettings,
): Promise<PreserveResult> {
  const sizeMb = toMb(buffer.byteLength);
  const isAnimated = isAnimatedMime(mime);
  const warnings: string[] = [];

  // 1단계: 가로·세로 측정. 래스터=@jsquash probeMeta / 움직이는=첫프레임 PNG 경유.
  // D3 graceful — 측정이 실패해도 여기서 곧장 throw 하지 않는다. 원본 보존 갈래는
  // width/height=0 + 경고로 이어가고, 사본 필수 갈래는 2단계에서 명시 throw 한다.
  let width = 0;
  let height = 0;
  let probeFailed = false;
  let probeError = "";
  try {
    const dims = await probeDimensions(buffer, mime, isAnimated);
    width = dims.width;
    height = dims.height;
  } catch (e) {
    probeFailed = true;
    probeError = (e as Error).message;
  }

  // 2단계: 모드 갈래 분기.
  let assetBuffer: Buffer;
  let outMime: string;

  switch (settings.preserveMode) {
    case "original": {
      // 한도 무관 원본 그대로. 움직이는 갈래도 손실 0. 측정 실패해도 원본은 보관.
      assetBuffer = buffer;
      outMime = mime;
      if (probeFailed) {
        warnings.push(
          `디코드 실패로 가로·세로 미측정 — 원본은 보존됨 (사유: ${probeError})`,
        );
      }
      break;
    }

    case "resized": {
      // 한도 무관 사본 — 사본이 필수라 디코드 실패는 원본 보존 의미 없음 → throw 전파.
      if (isAnimated) {
        // 움직이는 → 첫프레임 PNG + 손실 경고.
        assetBuffer = await extractFirstFramePng(buffer);
        outMime = "image/png";
        warnings.push(MOTION_LOSS_WARNING);
      } else {
        if (probeFailed) {
          throw new Error(
            `보존 모드 'resized' 사본 생성 실패 (mime '${mime}'): ${probeError}`,
          );
        }
        const copy = await makeStaticCopy(
          buffer,
          mime,
          settings.searchCopyMaxPx,
        );
        assetBuffer = copy.buffer;
        outMime = copy.outMime;
      }
      break;
    }

    case "smart":
    default: {
      // 한도 안이면 원본 그대로, 초과 시 사본.
      // 래스터 측정이 실패하면 px 초과 판정이 불가능 → 사본을 만들 수 없으므로 원본
      // 보존 갈래로 떨어뜨리고 정직 경고를 남긴다 (D3 graceful).
      if (!isAnimated && probeFailed) {
        assetBuffer = buffer;
        outMime = mime;
        warnings.push(
          `디코드 실패로 가로·세로 미측정 — 원본은 보존됨 (사유: ${probeError})`,
        );
        break;
      }

      const overSizeStatic = !isAnimated && sizeMb > settings.passthroughMaxMb;
      const overPxStatic =
        !isAnimated &&
        (width > settings.passthroughMaxPx ||
          height > settings.passthroughMaxPx);
      const overSizeAnimated =
        isAnimated && sizeMb > settings.animatedPassthroughMaxMb;

      const overLimit = overSizeStatic || overPxStatic || overSizeAnimated;

      if (!overLimit) {
        // 한도 안 → 원본 그대로.
        assetBuffer = buffer;
        outMime = mime;
      } else if (isAnimated) {
        // 움직이는 + 초과 → 첫프레임 PNG + 손실 경고.
        assetBuffer = await extractFirstFramePng(buffer);
        outMime = "image/png";
        warnings.push(MOTION_LOSS_WARNING);
      } else {
        // 정지 + 초과 → 사본 (축소 + 알파 분기).
        const copy = await makeStaticCopy(
          buffer,
          mime,
          settings.searchCopyMaxPx,
        );
        assetBuffer = copy.buffer;
        outMime = copy.outMime;
      }
      break;
    }
  }

  // 3단계: 미리보기 산출 (보존 모드 무관 — 항상 신규 PNG).
  // D3 graceful — 원본 보존 갈래(assetBuffer === buffer)에서 미리보기 생성이 실패해도
  // 원본 자산은 이미 보관됐다. 미리보기만 비우고 정직 경고를 남긴다. 사본 갈래에서
  // 미리보기 실패는 자산 사본이 이미 디코드 성공한 입력이라 거의 발생하지 않으나,
  // 발생 시에도 자산은 보관됐으므로 같은 graceful 통로로 다룬다.
  let thumbBuffer: Buffer = Buffer.alloc(0);
  try {
    const thumb = await generateThumb(buffer, mime, settings.previewMaxPx);
    thumbBuffer = thumb.buffer;
  } catch (e) {
    warnings.push(
      `미리보기 생성 실패 — 원본·자산은 보존됨, 미리보기 없음 (사유: ${(e as Error).message})`,
    );
  }

  return {
    assetBuffer,
    thumbBuffer,
    width,
    height,
    isAnimated,
    warnings,
    outMime,
  };
}
