/**
 * store-internal/concept-alias-helpers.ts — 개념 별칭·임베딩 본문 순수 헬퍼.
 *
 * ConceptRepository 에서 떼어낸, `this` 에 의존하지 않는 순수 문자열 함수 모음이다.
 * 별칭 JSON array TEXT 의 파싱·합집합 추가·중복 판정·언어 판정과 임베딩 입력 본문
 * 합성을 한곳에 모아 ConceptRepository 본체를 작게 유지한다. 동작은 옮기기 전과 동일.
 */

import { toNfc } from "../../memory/nfc.ts";

/** ConceptRepository 가 임베딩 본문 합성에 쓰는 개념 필드 묶음. */
export interface ConceptEmbeddingFields {
  name: string;
  koName?: string | null;
  koAliases?: string | null;
  enAliases?: string | null;
  description?: string | null;
}

/**
 * 별칭 JSON array TEXT 를 공백 join. 깨진 JSON 은 빈 문자열로 방어.
 */
export function joinAliases(rawJson: string | null | undefined): string {
  if (!rawJson) return "";
  try {
    const arr = JSON.parse(rawJson) as unknown;
    if (Array.isArray(arr)) {
      return arr.filter((x) => typeof x === "string").join(" ");
    }
  } catch {
    // 깨진 JSON 은 빈 문자열로 방어 — 별칭 없는 것으로 취급.
  }
  return "";
}

/**
 * 개념 임베딩 입력 본문 합성. name + ko_name + 한글 별칭 + 영문 별칭 + description.
 * 모두 비면 name 만 사용한다(name 은 NOT NULL 이라 항상 존재). 합성 결과가
 * 빈 문자열이면 throw — silent fallback 금지.
 */
export function buildEmbeddingText(fields: ConceptEmbeddingFields): string {
  const parts = [
    fields.name,
    fields.koName ?? "",
    joinAliases(fields.koAliases),
    joinAliases(fields.enAliases),
    fields.description ?? "",
  ];
  const text = parts
    .filter((p) => p && p.trim())
    .join(" ")
    .trim();
  if (!text) {
    throw new Error(
      "buildEmbeddingText: empty embedding input (name must be non-empty)",
    );
  }
  return text;
}

/**
 * source 이름이 한글(Hangul 음절·자모 포함)이면 'ko', 아니면 'en'. 별칭을
 * ko_aliases / en_aliases 중 어디에 추가할지 가른다. 혼합 문자열은 한글이 하나라도
 * 있으면 ko 로 본다(한국어 우선 프로필 — korean-first-search-profile).
 *
 * 판정 전에 함수 스스로 NFC 정규화한다(T6 잔여 우려 2 마감) — 아래 정규식은
 * 완성형 음절 기준이라 조합형(NFD) 한글을 en 으로 오판한다. 호출자 NFC 선행에
 * 기대면 정규화 없는 새 호출처가 생길 때 조합형 별칭이 en_aliases 로 새는
 * 버그가 재발하므로, 방어를 함수 계약 안으로 넣는다(NFC 입력에는 무해).
 */
export function aliasLangOf(name: string): "ko" | "en" {
  return /[㄰-㆏가-힣]/.test(toNfc(name)) ? "ko" : "en";
}

/**
 * 별칭 JSON array TEXT 에 한 이름을 추가(중복은 건너뜀)한 새 JSON 문자열을
 * 돌려준다. 깨진 JSON/NULL 은 빈 배열로 방어 후 추가.
 */
export function appendAlias(rawJson: string | null, name: string): string {
  let arr: string[] = [];
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      if (Array.isArray(parsed)) {
        arr = parsed.filter((x) => typeof x === "string") as string[];
      }
    } catch {
      // 깨진 JSON 은 빈 배열로 방어 — 새 별칭만 남긴다.
    }
  }
  // 저장된 별칭도 NFC 로 맞춰 비교한다 — 옛 조합형(NFD) 저장분이 있으면 완성형 별칭이
  // 중복인데도 새로 쌓인다(aliasAlreadyPresent 와 같은 규칙).
  if (!arr.some((x) => toNfc(x) === name)) arr.push(name);
  return JSON.stringify(arr);
}

/**
 * 별칭 한 개가 이미 target 의 ko/en 별칭 array 에 (소문자 키 기준) 들어있는지.
 * 원본 표기는 보존하되 중복 판정은 소문자로 비교한다(registerAliasesFromAliasTags 양식).
 * 깨진 JSON/NULL 은 "없음" 으로 본다.
 */
export function aliasAlreadyPresent(
  rawJson: string | null,
  alias: string,
): boolean {
  if (!rawJson) return false;
  // 비교 키는 NFC + 소문자 — 저장된 쪽도 NFC 로 맞춰, 옛 조합형(NFD) 저장분이 완성형
  // 별칭과 갈려 같은 별칭이 두 형태로 쌓이는 것을 막는다.
  const key = toNfc(alias).toLowerCase();
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.some(
        (x) => typeof x === "string" && toNfc(x).toLowerCase() === key,
      );
    }
  } catch {
    // 깨진 JSON 은 "없음" 으로 본다 — append 가 새 array 로 복구한다.
  }
  return false;
}
