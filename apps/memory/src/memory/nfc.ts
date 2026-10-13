/**
 * nfc.ts — NFC(유니코드 정규화 형식 C) 단일 출처 유틸(G3-a).
 *
 * 저장 content 경계(node-repository.ts) / 검색 질의 경계(routes/search.ts) /
 * 태그 dedup 경계(tag-extractor.ts) 세 곳이 이 함수 하나를 재사용한다.
 *
 * **NFC-only, trim 은 하지 않는다.** content-hash.ts 의 `contentHash()`(NFC + trim
 * + sha256, 흡수 키 전용 규칙)와는 별개 규칙이다 — 저장 content·검색 질의·태그
 * 식별자는 정확-중복 흡수 키가 아니므로 앞뒤 공백을 지울 근거가 없다. 두 규칙을
 * 섞어 한 함수로 합치면 "저장 content 는 trim 안 함" 계약이 조용히 깨진다.
 *
 * 배경 — macOS(NFD 입력) 등에서 같은 글자가 다른 바이트로 들어오면, NFC 미적용
 * 지점에서는 검색 정확일치·태그 dedup·임베딩 유사도가 흔들린다. 이 유틸은 그
 * "앞으로 들어오는 입력"만 NFC 로 통일한다 — 기존 DB 의 NFD 데이터를 다시 쓰는
 * 소급 재정규화는 범위 밖(G3-a 결정).
 */

/**
 * 유니코드 NFC 정규화만 적용한다(trim 없음, 대소문자 변환 없음).
 *
 * `NFC(NFC(x)) === NFC(x)` 이므로 이미 NFC 인 입력에 다시 적용해도 무해하다
 * (idempotent) — 호출부에서 "이미 NFC 인지" 여부를 따로 판정할 필요가 없다.
 */
export function toNfc(s: string): string {
  return s.normalize("NFC");
}
