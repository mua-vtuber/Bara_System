/**
 * 본문에서 `#태그` 토큰을 추출하고 깨끗한 본문만 반환.
 *
 * 2026-05-20 spec section 5 — 처리 흐름의 *맨 앞 단계*.
 * extractor.ts 진입부에서 호출됨 (W2 단계).
 *
 * 매칭 규칙 (spec 3.3 + 1.2 후속 F1):
 *   - 콜론 없는 `#태그` 만 개념 태그로 인정 (한글·영문·숫자·언더바)
 *   - `#키:값` (예: `#사람:민수`) 은 예약 키 / 라벨 양식이라 태그에서 제외
 *   - 영문은 소문자 정규화 (#Manga ≡ #manga)
 *   - 한글은 변동 0
 *   - 같은 태그 중복 입력은 dedup (Set 으로 첫 등장 순서 보존)
 *
 * store 의존성 없이 순수 함수 한 개만 노출 — 단위 테스트하기 좋도록 분리.
 */

import {
  findTagValueEndForKey,
} from "./parsers/tag-value-boundary.ts";
import { toNfc } from "./nfc.ts";

/** parseTags 의 반환값. */
export interface ParseTagsResult {
  /** 정규화 + dedup 된 태그 식별자 (# 떼고 본문만 담김). */
  tags: string[];
  /** `#태그` 토큰을 모두 제거하고 공백 1칸으로 정리한 본문. */
  cleanContent: string;
}

const HASHTAG_KEY_CHAR = /[\p{L}\d_]/u;
interface RemoveRange {
  start: number;
  end: number;
}

function isHashtagKeyChar(ch: string | undefined): boolean {
  return ch !== undefined && HASHTAG_KEY_CHAR.test(ch);
}

function removeRanges(content: string, ranges: RemoveRange[]): string {
  const out = removeRangesRaw(content, ranges);
  return out.replace(/\s+/g, " ").trim();
}

function removeRangesRaw(content: string, ranges: RemoveRange[]): string {
  let cursor = 0;
  let out = "";
  for (const range of ranges) {
    out += content.slice(cursor, range.start);
    cursor = range.end;
  }
  out += content.slice(cursor);
  return out;
}

function consumeTrailingTagDelimiter(content: string, index: number): number {
  if (content[index] === ",") return index + 1;
  if (content[index] === "\r" && content[index + 1] === "\n") return index + 2;
  if (content[index] === "\r" || content[index] === "\n") return index + 1;
  return index;
}

function consumeDisplayTagDelimiter(content: string, index: number): number {
  return content[index] === "," ? index + 1 : index;
}

function normalizeLineBreaks(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeDisplayLine(line: string): string {
  return line.replace(/[^\S\n]+/g, " ").trim();
}

function removeRangesForDisplay(content: string, ranges: RemoveRange[]): string {
  const lines = content.split("\n");
  const normalizedLines: string[] = [];
  let lineStart = 0;
  let rangeIndex = 0;

  for (const line of lines) {
    const lineEnd = lineStart + line.length;
    while (rangeIndex < ranges.length && ranges[rangeIndex]!.end <= lineStart) {
      rangeIndex += 1;
    }

    let cursor = lineStart;
    let out = "";
    let hadRemovedTag = false;
    let localRangeIndex = rangeIndex;
    while (
      localRangeIndex < ranges.length &&
      ranges[localRangeIndex]!.start < lineEnd
    ) {
      const range = ranges[localRangeIndex]!;
      const start = Math.max(range.start, lineStart);
      const end = Math.min(range.end, lineEnd);
      if (start < end) {
        out += content.slice(cursor, start);
        cursor = end;
        hadRemovedTag = true;
      }
      localRangeIndex += 1;
    }
    out += content.slice(cursor, lineEnd);

    const normalized = normalizeDisplayLine(out);
    if (!(hadRemovedTag && normalized === "" && line.trim() !== "")) {
      normalizedLines.push(normalized);
    }
    lineStart = lineEnd + 1;
  }

  return normalizedLines.join("\n").trim();
}

function scanTagRanges(
  content: string,
  consumeDelimiter: (content: string, index: number) => number,
): { tags: string[]; ranges: RemoveRange[] } {
  const normalized = new Set<string>();
  const ranges: RemoveRange[] = [];

  let i = 0;
  while (i < content.length) {
    if (content[i] !== "#") {
      i += 1;
      continue;
    }

    const keyStart = i + 1;
    if (!isHashtagKeyChar(content[keyStart])) {
      i += 1;
      continue;
    }

    let keyEnd = keyStart;
    while (isHashtagKeyChar(content[keyEnd])) {
      keyEnd += 1;
    }

    if (content[keyEnd] === ":") {
      const key = content.slice(keyStart, keyEnd);
      const valueStart = keyEnd + 1;
      const end = consumeDelimiter(
        content,
        findTagValueEndForKey(content, valueStart, key),
      );
      ranges.push({ start: i, end });
      i = end;
      continue;
    }

    // NFC 정규화 경계(G3-a) — 태그 식별자를 Set 에 넣기 전 NFC 로 통일한다. NFD 로
    // 입력된 같은 한글 태그(예: "노란후드")가 NFC 입력과 다른 바이트라 dedup 되지
    // 않던 문제를 막는다. 영문 소문자화(toLowerCase)는 기존 규칙 그대로 유지.
    normalized.add(toNfc(content.slice(keyStart, keyEnd)).toLowerCase());
    const end = consumeDelimiter(content, keyEnd);
    ranges.push({ start: i, end });
    i = end;
  }

  return { tags: [...normalized], ranges };
}

/**
 * 본문 텍스트에서 콜론 없는 `#태그` 토큰만 뽑아내고 본문은 깨끗하게 정리해 돌려준다.
 *
 * `#키:값` (예: `#사람:민수`) 은 예약 키 / 라벨 양식이라 개념 태그로 잡지 않고,
 * 본문 정리 시 토큰 통째로 (`:값` 포함) 제거한다 — 개념 그래프 오염과
 * `:민수` 같은 콜론 뒤 찌꺼기를 둘 다 막는다.
 *
 * @param content 원본 본문 텍스트
 * @returns 태그 식별자 배열과 정리된 본문
 *
 * @example
 *   parseTags("#만화 #주술회전 고조가 죽었어!!")
 *   // => { tags: ["만화", "주술회전"], cleanContent: "고조가 죽었어!!" }
 *   parseTags("#사람:민수 #생일:3월5일")
 *   // => { tags: [], cleanContent: "" }
 */
export function parseTags(content: string): ParseTagsResult {
  const { tags, ranges } = scanTagRanges(content, consumeTrailingTagDelimiter);
  const cleanContent = removeRanges(content, ranges);

  return { tags, cleanContent };
}

/**
 * 본문 안 해시태그 토큰을 원문 표기(`#태그`, `#키:값`) 그대로 회수한다.
 *
 * 수정 UI 는 태그를 숨기고 본문만 고치게 하므로, 서버가 기존 태그 토큰을 보존해
 * 다시 붙일 때 쓴다. 중복 토큰은 첫 등장만 유지한다.
 */
export function extractHashtagTokens(content: string): string[] {
  const normalized = normalizeLineBreaks(content);
  const { ranges } = scanTagRanges(normalized, (_content, index) => index);
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const range of ranges) {
    const token = normalized.slice(range.start, range.end).trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

/** 본문에 해시태그 문법이 하나라도 있는지 빠르게 확인한다. */
export function hasHashtagSyntax(content: string): boolean {
  return extractHashtagTokens(content).length > 0;
}

/**
 * 화면 표시용 해시태그 제거. LLM/regex 입력용 parseTags.cleanContent 는 기존처럼 모든
 * 공백을 한 칸으로 접지만, UI 는 사용자가 입력한 줄바꿈을 보존해야 한다.
 */
export function stripTagsForDisplay(content: string): string {
  const normalized = normalizeLineBreaks(content);
  const { ranges } = scanTagRanges(normalized, consumeDisplayTagDelimiter);
  return removeRangesForDisplay(normalized, ranges);
}
