/**
 * content-hash.ts — 텍스트 노드 정확-중복 흡수 키의 단일 출처(P0-A 입력 멱등성).
 *
 * `addNode` 코어 계층·마이그레이션 v36 backfill·테스트가 모두 이 함수 하나를
 * import 한다. 정규화 규칙(NFC + 앞뒤 trim)은 여기 한 곳에만 존재한다 — 두 곳에
 * 다시 기재하면 규칙이 갈려 같은 글이 다른 키를 갖는 결함이 생긴다(No-hardcoding).
 *
 * 정규화 규칙:
 *   - NFC: 같은 글자의 조합형(자모 분리)/완성형(NFC) 표현을 통일한다. 사용자가
 *     다른 IME 로 친 같은 문장이 다른 바이트가 되는 것을 흡수한다.
 *   - trim: 앞뒤 공백만 제거한다. 내부 공백·줄바꿈은 보존한다 — "노란후드"와
 *     "노란 후드"는 다른 글이고, 여러 줄 글의 줄바꿈은 의미가 있다.
 *   - 대소문자·내부 공백 정규화는 하지 않는다(과도 정규화는 정당한 별개 글을
 *     중복으로 오판한다 — spec §4.2·§9.2).
 */

import { createHash } from "node:crypto";
import { toNfc } from "./nfc.ts";

/**
 * 정규화(NFC + 앞뒤 trim) 후 sha256 hex. 텍스트 노드 정확-중복 흡수 키.
 *
 * NFC 자체는 nfc.ts 의 단일 출처(`toNfc`)를 재사용하고, 이 함수는 그 위에
 * trim 규칙만 얹는다 — 저장 content·검색 질의·태그 dedup(NFC-only, trim 없음)과
 * 흡수 키(NFC + trim)가 서로 다른 규칙임을 두 곳에 따로 적지 않고 한 곳(이 파일의
 * import)에서 드러낸다.
 *
 * 빈 문자열도 유효한 해시를 반환한다(빈 문자열의 sha256 은 유효 — 손상이 아님).
 */
export function contentHash(content: string): string {
  const normalized = toNfc(content).trim();
  return createHash("sha256").update(normalized).digest("hex");
}
