/**
 * image-mime.ts — supported image MIME single authority.
 *
 * Keep this module dependency-light so tests and client contract checks can import
 * the MIME allowlist without loading image decoding or embedding dependencies.
 */

/**
 * 지원하는 image mime 6 종 — 이미지 입력 코어 권위. dispatcher.ts·봇·대시보드·
 * assets.ts·re-embed-images.ts 가 모두 이 묶음 한 곳을 import 해서 쓴다 (단일
 * 권위 — 중복 정의 금지). Phase 11d D6: @jsquash 디코드 도입으로 avif 합류
 * (webp 와 함께 최신 저장본 갈래). heic 는 디코더 부재로 제외 (§8 사용자 결정 —
 * sniff 가 진입에서 명시 거부).
 */
export const SUPPORTED_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/apng",
  "image/avif",
]);
