/**
 * image-preserve/types.ts — Phase 11a T4 보존 모드 + 미리보기 타입.
 *
 * smart / original / resized 세 갈래 보존 모드 분기 + 미리보기 ≤512px 자동 +
 * GIF/APNG 첫프레임 정지 PNG fallback + 움직임 손실 경고 배열을 위한 공유 타입.
 *
 * 권위: docs/decisions/2026-05-28-phase11a-plan(...).md § Task 4.
 */

/**
 * 보존 모드 — settings.images.preserveMode.
 *
 *   - 'smart' (default): 한도 안이면 원본 그대로, 초과 시 사본 (정지=resize 2048,
 *     움직이는=첫프레임 PNG + 경고).
 *   - 'original': 한도 무관 원본 그대로.
 *   - 'resized': 한도 무관 사본 (정지=resize 2048, 움직이는=첫프레임 PNG + 경고).
 */
export type PreserveMode = "smart" | "original" | "resized";

/**
 * 보존 모드 + 한도 + 미리보기 칸 묶음. settings.images 와 1:1 정합.
 */
export interface PreserveSettings {
  /** 보존 모드 갈래 — smart(default) / original / resized */
  preserveMode: PreserveMode;
  /** smart 정지 통과 허용 한도 (MB). 초과 시 사본 흐름 진입. default 5. */
  passthroughMaxMb: number;
  /** smart 정지 통과 허용 가로/세로 (px). 초과 시 사본 흐름 진입. default 2048. */
  passthroughMaxPx: number;
  /** smart 움직이는 통과 허용 한도 (MB). 초과 시 첫프레임 PNG fallback. default 15. */
  animatedPassthroughMaxMb: number;
  /** resized + smart 사본 흐름의 가로/세로 한도 (px). default 2048. */
  searchCopyMaxPx: number;
  /** 사본 형식 갈래. 11a 안 'auto' 한 갈래 — jimp 알파 검사 (투명 → png / 없으면 jpeg). */
  searchCopyFormat: "auto";
  /** 미리보기 한도 (px). 보존 모드 무관 — 항상 사본 PNG. default 512. */
  previewMaxPx: number;
}

/**
 * applyPreserveMode 산출 — 보관용 자산 + 미리보기 + metadata + 손실 경고 배열.
 */
export interface PreserveResult {
  /** image_asset 테이블에 보관할 자산 바이트 (smart 통과면 입력 그대로). */
  assetBuffer: Buffer;
  /** 미리보기 ≤previewMaxPx PNG 바이트 (항상 신규 사본). */
  thumbBuffer: Buffer;
  /** 원본 가로 (px). 움직이는 이미지면 첫 프레임 가로. */
  width: number;
  /** 원본 세로 (px). 움직이는 이미지면 첫 프레임 세로. */
  height: number;
  /** GIF/APNG 등 움직이는 mime 갈래 여부. */
  isAnimated: boolean;
  /** 손실·강등 발생 시 명시 경고 배열 (silent fallback 금지 정합). */
  warnings: string[];
  /** assetBuffer 의 mime — 'image/png' / 'image/jpeg' / 입력 mime (smart 통과 갈래). */
  outMime: string;
}

/**
 * 움직이는 이미지로 다루는 mime 묶음. animated webp 는 정지 webp 와 mime 공유 — 11a
 * 안 단순화: gif/apng 한 갈래만 isAnimated=true. 후속 phase 에서 webp frame count
 * 검사 추가 가능.
 */
export const ANIMATED_MIMES: ReadonlySet<string> = new Set([
  "image/gif",
  "image/apng",
]);

/**
 * 움직이는 손실 경고 문자열. mode.ts·resized·smart 초과 갈래 공유.
 */
export const MOTION_LOSS_WARNING =
  "원본 움직이는 이미지 — 첫 프레임 정지 PNG 사본 한 장만 보관. 움직임 살리려면 settings 안 `images.preserveMode='original'` 또는 한도 (`animatedPassthroughMaxMb`) 늘리세요.";

/**
 * 보존 모드 default 묶음. settings.images 의 default 와 1:1 정합 — memory-schema.ts
 * 의 MEMORY_DEFAULTS.images 와 같은 값을 들고 있다.
 */
export const PRESERVE_DEFAULTS: PreserveSettings = {
  preserveMode: "smart",
  passthroughMaxMb: 5,
  passthroughMaxPx: 2048,
  animatedPassthroughMaxMb: 15,
  searchCopyMaxPx: 2048,
  searchCopyFormat: "auto",
  previewMaxPx: 512,
};
