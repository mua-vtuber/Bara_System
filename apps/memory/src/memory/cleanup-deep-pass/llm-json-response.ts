/**
 * llm-json-response.ts — 정리 AI 응답 글에서 JSON 값을 꺼내는 공용 함수(순수 함수).
 *
 * 정리 단계들(정규식 강화·요약·항목 등록·렌즈 초안)이 같은 순서로 응답을 읽게 한 곳에 둔다.
 * 읽는 순서:
 *   1. 앞뒤 공백을 지운 글 전체. 글 전체를 감싼 코드 울타리(```json ... ```) 하나는 벗긴다.
 *   2. 글 안 어딘가에 코드 울타리 블록이 있으면 그 안의 글(앞뒤 설명 글에 괄호가 섞여도 읽힌다).
 *   3. (배열만) 코드 울타리 없이 앞뒤 잡담에 "[12]" 같은 괄호가 섞인 경우 — '[' 자리마다
 *      짝 맞는 ']' 까지 잘라 객체만 담긴 비어 있지 않은 첫 배열.
 *   4. 첫 여는 괄호 ~ 마지막 닫는 괄호 구간(옛 방식).
 * 1·2 는 기대한 모양(배열/객체)으로 읽혔을 때만 받는다. 3 까지 실패하면 옛 오류 문장 그대로
 * 던진다 — 호출자가 결정적 실패로 원장에 남긴다(빈 결과 위장 금지).
 */

/** 기대하는 JSON 모양 — 배열이면 [ ], 객체면 { } 로 3번 구간을 자른다. */
export type LlmJsonShape = "array" | "object";

const SHAPE_BRACKETS: Record<LlmJsonShape, { open: string; close: string; label: string }> = {
  array: { open: "[", close: "]", label: "배열을" },
  object: { open: "{", close: "}", label: "객체를" },
};

/** 오류 문장에 싣는 응답 앞부분 글자 수. */
const ERROR_PREVIEW_CHARS = 80;

/** 글 전체를 감싼 코드 울타리 하나(언어 표시 선택). */
const WRAPPING_FENCE_RE = /^```[\w-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/;

/** 글 안의 첫 코드 울타리 블록. */
const INNER_FENCE_RE = /```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```/;

function matchesShape(value: unknown, shape: LlmJsonShape): boolean {
  if (shape === "array") return Array.isArray(value);
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON.parse 가 성공하고 모양이 맞으면 { value }, 아니면 null. */
function tryParseShape(text: string, shape: LlmJsonShape): { value: unknown } | null {
  try {
    const value: unknown = JSON.parse(text);
    return matchesShape(value, shape) ? { value } : null;
  } catch {
    // 이 후보는 JSON 이 아님 — 다음 읽는 방식으로 넘어간다(최종 실패는 3번이 던진다).
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** '[' 자리마다 짝 맞는 ']' 까지(문자열 안 괄호는 건너뜀) 파싱해 객체 배열을 찾는다. */
function findObjectArray(text: string): unknown[] | null {
  for (let start = text.indexOf("["); start >= 0; start = text.indexOf("[", start + 1)) {
    const end = matchingBracketEnd(text, start);
    if (end < 0) continue;
    const parsed = tryParseShape(text.slice(start, end + 1), "array");
    if (
      parsed &&
      Array.isArray(parsed.value) &&
      parsed.value.length > 0 &&
      parsed.value.every(isPlainObject)
    ) {
      return parsed.value;
    }
  }
  return null;
}

function matchingBracketEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 응답 글에서 JSON 값을 꺼낸다. 1·2번은 모양이 맞을 때만 돌려주고, 3번은 JSON 문법만 맞으면
 * 모양과 상관없이 돌려준다(모양 검사 오류 문장은 호출자가 낸다 — 옛 동작 그대로).
 *
 * @throws 3번 구간이 없으면 "LLM 응답에서 JSON {배열|객체}를 못 찾음 (앞 80자: ...)",
 *   구간이 JSON 이 아니면 "LLM 응답 JSON 파싱 실패: ...".
 */
export function extractLlmJson(
  raw: string,
  shape: LlmJsonShape,
  options: { rejectWholeOtherShape?: boolean } = {},
): unknown {
  const trimmed = raw.trim();
  const wrapped = WRAPPING_FENCE_RE.exec(trimmed);
  const wholeText = wrapped ? wrapped[1]!.trim() : trimmed;
  const whole = tryParseShape(wholeText, shape);
  if (whole) return whole.value;
  if (options.rejectWholeOtherShape) {
    // 글 전체가 JSON 인데 기대한 모양이 아니면 다른 모양 속을 뒤져 추측하지 않고 던진다.
    let otherShape = false;
    try {
      JSON.parse(wholeText);
      otherShape = true;
    } catch {
      // 글 전체가 JSON 이 아님 — 아래 읽는 방식들로 계속한다.
    }
    if (otherShape) {
      throw new Error(`LLM 응답이 ${shape === "array" ? "배열이" : "객체가"} 아님`);
    }
  }

  const inner = INNER_FENCE_RE.exec(trimmed);
  if (inner) {
    const fenced = tryParseShape(inner[1]!.trim(), shape);
    if (fenced) return fenced.value;
  }

  if (shape === "array") {
    // 코드 울타리 없이 앞뒤 잡담에 "[12]" 같은 괄호가 섞인 경우 — '[' 자리마다 짝 맞는 ']' 까지를
    // 잘라 객체만 담긴 비어 있지 않은 첫 배열을 쓴다(문자열 안 괄호는 건너뜀).
    const scanned = findObjectArray(raw);
    if (scanned !== null) return scanned;
  }

  const { open, close, label } = SHAPE_BRACKETS[shape];
  const start = raw.indexOf(open);
  const end = raw.lastIndexOf(close);
  if (start < 0 || end < start) {
    throw new Error(
      `LLM 응답에서 JSON ${label} 못 찾음 (앞 ${ERROR_PREVIEW_CHARS}자: ${JSON.stringify(raw.slice(0, ERROR_PREVIEW_CHARS))})`,
    );
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    throw new Error(`LLM 응답 JSON 파싱 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
}
