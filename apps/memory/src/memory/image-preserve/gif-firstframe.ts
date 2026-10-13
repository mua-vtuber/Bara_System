/**
 * image-preserve/gif-firstframe.ts — GIF/APNG 첫 프레임 → 정지 PNG 추출.
 *
 * jimp 가 GIF 디코더 (omggif) 를 자체 포함하고 있어 `Jimp.read(gifBuffer)` 하면
 * 첫 프레임이 RGBA 비트맵으로 메모리에 적재된다. 그 뒤 `getBuffer('image/png')`
 * 로 PNG 사본을 만들면 움직임은 사라지고 첫 프레임만 남는다 — 본 모듈의 목적.
 *
 * APNG (animated PNG) 도 jimp 가 첫 IDAT 묶음을 정지 PNG 로 읽어내므로 같은
 * 흐름으로 다룬다.
 *
 * 권위: docs/decisions/2026-05-28-phase11a-plan(...).md § Task 4 Step 3.
 */
import { Jimp } from "jimp";

/**
 * GIF / APNG 바이트를 첫 프레임 정지 PNG 바이트로 변환한다.
 *
 * - 실패 시 mime 명시 에러를 던진다 (silent fallback 금지).
 * - 입력 mime 검사는 호출자 (mode.ts) 가 ANIMATED_MIMES 로 판정한 뒤 호출하는 흐름 —
 *   이 함수 자체는 jimp 가 디코드 가능한 모든 갈래를 받아 첫 프레임을 정지 PNG 로 산출한다.
 */
export async function extractFirstFramePng(buffer: Buffer): Promise<Buffer> {
  let img: Awaited<ReturnType<typeof Jimp.read>>;
  try {
    img = await Jimp.read(buffer);
  } catch (e) {
    throw new Error(
      `첫 프레임 추출 실패 (디코드 단계): ${(e as Error).message}`,
    );
  }
  try {
    const out = await img.getBuffer("image/png");
    return out as Buffer;
  } catch (e) {
    throw new Error(
      `첫 프레임 추출 실패 (PNG 인코드 단계): ${(e as Error).message}`,
    );
  }
}
