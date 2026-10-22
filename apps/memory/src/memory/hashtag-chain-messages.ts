/**
 * memory/hashtag-chain-messages.ts — 저장 응답 해시태그 경고 문구 단일 출처
 * (2026-10-21 mcp-usage-and-guidance spec 12.4).
 *
 * 두 묶음을 둔다:
 *   - HASHTAG_WARNING_MESSAGES: 경고 한 건의 message 칸(저장 응답).
 *   - HASHTAG_WARNING_GUIDE: 사용 안내(get_usage_guide) 6절의 코드별 한 줄 설명.
 * 둘 다 경고 코드를 키로 하는 Record 라 코드가 늘면 컴파일이 문구 누락을 막는다.
 * 소비자가 클라이언트 AI 라 영어다. 문구는 서버가 "어떻게 읽었는지"만 말한다 —
 * 저장은 이미 끝났으므로 실패라고 말하지 않는다.
 */

import type { HashtagWarningCode } from "./hashtag-chain-check.ts";

/** 저장이 어느 갈래로 처리됐는지 — 같은 경고도 갈래에 따라 일어난 일이 다르다. */
export type HashtagSavedAs = "memory" | "entity_patch";

/** 문구를 고르는 데 필요한 사실. */
export interface HashtagWarningMessageInput {
  savedAs: HashtagSavedAs;
  /** 경고가 가리키는 키가 예약 키(사람·프로젝트·생일 등)인지. */
  reservedKey: boolean;
  /** 경고가 가리키는 태그가 콜론 태그(#키:값)인지 — HYPHEN_SPLIT 문구가 갈린다. */
  colon: boolean;
}

export const HASHTAG_WARNING_MESSAGES: Record<HashtagWarningCode, (p: HashtagWarningMessageInput) => string> = {
  BODY_ABSORBED: (p) => p.savedAs === "memory"
    ? "No text outside tags remained; the value may have absorbed your body text. End the tag with a comma before the body."
    : "No memory text was stored: the input was read as entity declarations only, so entities may have been created or updated from these values. Save again with a comma before the body.",
  HYPHEN_SPLIT: (p) => p.colon
    ? "The two tag readers split this hyphenated key differently. Use letters, digits or underscore in keys."
    : "Only the part before the hyphen was read as a tag; the rest stayed in the text. If '#' was not meant as a tag, write the text without '#'; if it was, use underscore instead of hyphens.",
  EMPTY_VALUE: (p) => p.reservedKey
    ? "This reserved key has no value, so it was not applied."
    : "This tag has no value, so it was ignored.",
  CHAIN_CYCLE: () =>
    "This chain loops back to a key already used; reading stopped at the value shown.",
  EXTRA_PROJECT_CHAIN: () =>
    "Only the first project chain is attached to this memory; this chain was not attached, but it may still have created a project entry.",
  PROJECT_NOT_CREATED: () =>
    "The project chain ends on a category, so this chain created and attached no project.",
  PROJECT_AMBIGUOUS: () =>
    "The project name or alias matches more than one project, so this chain attached and created no project.",
  PROJECT_ARGUMENT_OVERRIDDEN: () =>
    "The project chain decides the project, so the memory was saved in the chain's project, not the project argument.",
};

export const HASHTAG_WARNING_GUIDE: Record<HashtagWarningCode, string> = {
  BODY_ABSORBED: "no text remained outside tags and a tag value contains spaces, so the value probably swallowed the body.",
  HYPHEN_SPLIT: "a key contains a hyphen; the colon reader and the plain-tag reader split it differently.",
  EMPTY_VALUE: "a #key: tag has no value and was ignored (a reserved key is not applied).",
  CHAIN_CYCLE: "a chain returns to a key it already passed; reading stopped there.",
  EXTRA_PROJECT_CHAIN: "more than one project chain; only the first is attached to the memory.",
  PROJECT_NOT_CREATED: "the project chain ends on a category, so no project was created or attached.",
  PROJECT_AMBIGUOUS: "the project name or alias matches several projects, so none was attached.",
  PROJECT_ARGUMENT_OVERRIDDEN: "the project argument named a different project than the chain; the chain's project was used.",
};
