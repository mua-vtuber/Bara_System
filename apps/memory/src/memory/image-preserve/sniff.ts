/**
 * image-preserve/sniff.ts — Phase 11d D6 파일 시그니처(magic bytes) 검사.
 *
 * 봇·대시보드가 보낸 mime 은 이름·전송 헤더에서 나온 값이라 실제 형식과 어긋날 수
 * 있다. `photo.jpg` 인데 실제 webp 인 케이스(디스코드 재인코드·트위터 저장본)가 흔하다.
 * 이름·전송 mime 만 믿으면 디코더가 엉뚱한 코덱으로 가서 디코드 throw → 자산 손실까지 갔다.
 *
 * 이 모듈은 buffer 앞 12~16 바이트를 직접 비교해 실제 형식을 판정한다 — 라이브러리 0,
 * 순수 JS 바이트 비교. 시그니처 표는 이 한 파일에 모아 노출한다(여러 곳 흩뿌리기 금지).
 *
 * heic 는 @jsquash 가 디코더를 제공하지 않아 받아도 못 읽는다(§8 사용자 결정 — 제외).
 * 그래서 sniff 는 heic 를 *식별*만 하고("image/heic" 반환), 거부 판단은 호출자
 * (ingest-image.ts) 가 한다 — 받아놓고 자산 손실로 위장하지 않기 위함.
 *
 * 권위: docs/decisions/2026-05-31-phase11d-jsquash-decode-spec(...).md §6.5 + §8.
 */

/**
 * magic sniff 가 식별할 수 있는 mime 묶음. SUPPORTED_IMAGE_MIMES 와는 별개 —
 * sniff 는 "실제 형식이 무엇인가" 만 답하고, 지원 여부(allowlist) 판단은 호출자 몫.
 * heic 는 식별만 하고 호출자가 정직 거부한다(§8).
 */
export type SniffedImageMime =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/avif"
  | "image/heic";

/**
 * ISOBMFF(ftyp 컨테이너) brand → mime 매핑. avif / heic 가 같은 ftyp 컨테이너를
 * 쓰므로 brand(major_brand 또는 compatible_brands) 로 갈린다. heic 가족은 여러
 * brand 를 쓴다(heic/heix/heim/heis/mif1/msf1 등) — 모두 heic 로 식별(거부용).
 */
const AVIF_BRANDS: ReadonlySet<string> = new Set(["avif", "avis"]);
const HEIC_BRANDS: ReadonlySet<string> = new Set([
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "mif1",
  "msf1",
]);

/**
 * 바이트 묶음이 주어진 위치(offset)에서 ASCII 문자열과 일치하는지.
 * buffer 가 짧으면 false.
 */
function matchesAscii(buffer: Buffer, offset: number, ascii: string): boolean {
  if (buffer.length < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (buffer[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * 바이트 묶음이 주어진 위치에서 바이트 배열(시그니처)과 일치하는지.
 * buffer 가 짧으면 false.
 */
function matchesBytes(buffer: Buffer, offset: number, sig: number[]): boolean {
  if (buffer.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buffer[offset + i] !== sig[i]) return false;
  }
  return true;
}

/**
 * PNG = 89 50 4E 47 (‰PNG). 8바이트 시그니처 중 앞 4바이트로 충분.
 */
function isPng(buffer: Buffer): boolean {
  return matchesBytes(buffer, 0, [0x89, 0x50, 0x4e, 0x47]);
}

/**
 * JPEG = FF D8 FF (SOI 마커 + 첫 segment 마커 prefix).
 */
function isJpeg(buffer: Buffer): boolean {
  return matchesBytes(buffer, 0, [0xff, 0xd8, 0xff]);
}

/**
 * GIF = 47 49 46 38 (GIF8 — GIF87a/GIF89a 공통 prefix).
 */
function isGif(buffer: Buffer): boolean {
  return matchesBytes(buffer, 0, [0x47, 0x49, 0x46, 0x38]);
}

/**
 * WebP = RIFF(0~3) .... WEBP(8~11). RIFF 컨테이너 + WEBP 폼 타입.
 */
function isWebp(buffer: Buffer): boolean {
  return matchesAscii(buffer, 0, "RIFF") && matchesAscii(buffer, 8, "WEBP");
}

/**
 * ISOBMFF(ftyp) 컨테이너 brand 판정 — avif / heic 구분.
 *
 * 구조: [4바이트 box size][4바이트 'ftyp'][4바이트 major_brand][4바이트 minor_version]
 *       [compatible_brands... 4바이트씩].
 * 4~7 이 'ftyp' 이면 major_brand(8~11) 부터 box 끝까지 4바이트씩 brand 를 훑어
 * avif/heic 가족을 찾는다. box size 는 4~16 정도라 buffer 앞부분만 봐도 충분.
 *
 * @returns "image/avif" | "image/heic" | null
 */
function sniffFtypBrand(buffer: Buffer): "image/avif" | "image/heic" | null {
  if (!matchesAscii(buffer, 4, "ftyp")) return null;

  // box size(0~3, big-endian). 안전하게 buffer 길이로 상한을 둔다.
  const boxSize = buffer.length >= 4 ? buffer.readUInt32BE(0) : buffer.length;
  const scanEnd = Math.min(buffer.length, Math.max(boxSize, 16));

  // major_brand(8~11) + compatible_brands(16~) 를 4바이트 단위로 훑는다.
  // major_brand 가 8 에서 시작하므로 8 부터 4씩 진행.
  for (let off = 8; off + 4 <= scanEnd; off += 4) {
    // minor_version(12~15) 은 brand 가 아니므로 건너뛴다.
    if (off === 12) continue;
    const brand = buffer.toString("latin1", off, off + 4).replace(/\0+$/, "");
    if (AVIF_BRANDS.has(brand)) return "image/avif";
    if (HEIC_BRANDS.has(brand)) return "image/heic";
  }
  return null;
}

/**
 * buffer 의 파일 시그니처를 검사해 실제 image mime 을 판정한다.
 *
 * - 판정 가능: png / jpeg / gif / webp / avif / heic.
 * - 판정 불가(시그니처 미일치): null — 호출자는 들어온 mime 을 신뢰(기존 동작).
 *
 * heic 는 식별만 한다(거부 판단은 호출자) — 받아놓고 못 읽는 위장을 막기 위함.
 *
 * @param buffer 입력 이미지 바이트
 * @returns 실제 형식 mime, 또는 판정 불가 시 null
 */
export function sniffImageMime(buffer: Buffer): SniffedImageMime | null {
  if (isPng(buffer)) return "image/png";
  if (isJpeg(buffer)) return "image/jpeg";
  if (isGif(buffer)) return "image/gif";
  if (isWebp(buffer)) return "image/webp";

  // RIFF 가 아니면서 ftyp 컨테이너면 avif/heic 갈래 — brand 로 구분.
  const ftyp = sniffFtypBrand(buffer);
  if (ftyp !== null) return ftyp;

  return null;
}
