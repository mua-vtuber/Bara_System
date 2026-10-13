/**
 * memory/claim-text.ts — 글의 "주장 본문" 정의(단일 출처).
 *
 * 편집 무효화(node-repo-lifecycle-mixin)가 추출기와 같은 본문 정의로 "주장이 바뀌었는가"를
 * 판정하도록 모은다. 백필(scheduler Q1 정제)과 즉시 추출(save-input-immediate)은 해시태그를
 * 뺀 본문(parseTags(...).cleanContent)만 LLM 에 넘긴다. 그래서 태그만 바뀐 편집은 주장을
 * 바꾸지 않고, 추출 자식·청크 같은 파생 기억을 무효화할 이유도 없다(SL-2).
 *
 * 저장소 계층이 라우트 모듈을 import 하지 않도록 편집 본문 정규화(normalizeEditableBody)도
 * 여기 둔다. routes/memories-shared.ts 는 이 함수를 다시 내보낸다.
 */

import { toNfc } from "./nfc.ts";
import { parseTags } from "./tag-extractor.ts";

/** 편집 본문의 줄바꿈을 LF 로 통일하고 앞뒤 공백을 지운다(PATCH·by-source·태그 라우트 공용). */
export function normalizeEditableBody(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

/**
 * 추출기가 보는 주장 본문 — 해시태그(`#태그`, `#키:값`)를 빼고 공백을 한 칸으로 접은 본문.
 * 저장 경계(G3-a)와 같이 NFC 로 통일해, 정규화 형식만 다른 같은 글을 같은 주장으로 본다.
 */
export function extractionClaimText(content: string): string {
  return normalizeEditableBody(parseTags(toNfc(content)).cleanContent);
}

/** 두 저장 본문의 주장이 다른가 — 편집이 파생 기억을 무효화하고 재추출 대상이 되는 조건. */
export function extractionClaimChanged(before: string, after: string): boolean {
  return extractionClaimText(before) !== extractionClaimText(after);
}
