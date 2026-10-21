/**
 * parse.ts — LLM 응답 파싱·필터·dedup(extractor.ts 에서 분리·G5-a).
 *
 * extractor.ts 가 1213줄로 800줄 하드 상한을 넘겨 책임 경계로 하위 모듈에 코드를 옮겼다
 * (동작 0 변화 — 코드 이동만). 이 모듈은 LLM 이 낸 raw 응답을 ExtractedItem 배열로 바꾸는
 * 응답 쪽 순수 함수를 모은다:
 *   - parseExtractionResponse·classifyEmptyResponse — 관대 파싱 + 빈 응답 갈래 판별.
 *   - filterByImportance·dedupeWithinResponse — importance 하한·응답 내 중복 제거.
 *   - normalizeRestatementText·isTrivialSingleExtractionRestatement·
 *     filterTrivialSingleExtraction — 원문 재진술 1건 필터.
 *   - countFilteredOut — 필터로 버려진 갯수 계산(관측용).
 */

import { MEMORY_TYPES, type MemoryType } from "../types.ts";
import { OPENAI_JSON_SCHEMA_ARRAY_WRAPPER_KEY } from "../../llm/openai-chat-core.ts";
import {
  EXTRACTOR_MIN_IMPORTANCE,
  MIN_EXTRACTED_CONTENT_LENGTH,
} from "../constants.ts";
import type { ExtractedItem } from "./contract.ts";
import { toNfc } from "../nfc.ts";

/** parseExtractionResponseDetailed 결과 — 통과한 항목과 importance 가 없어 버린 항목 수. */
export interface ParsedExtraction {
  items: ExtractedItem[];
  /** content 는 있었지만 importance 가 없거나 유한한 숫자가 아니어서 버린 항목 수. */
  missingImportanceCount: number;
}

/**
 * LLM JSON 응답을 ExtractedItem 배열로 파싱.
 *
 * 관대한 처리:
 *   - 앞뒤 공백·코드 펜스(```json ... ```) 제거
 *   - 응답이 객체이면 그 객체의 첫 배열 필드 사용 (Ollama 일부 모델이
 *     `{"items": [...]}` 형태로 반환하기도 함)
 *   - 알 수 없는 memoryType → "fact" fallback
 *   - importance 가 [0, 1] 밖의 숫자면 가까운 끝값으로 clamp(값은 있었으므로 빈 값이 아니다)
 *
 * importance 가 없거나 숫자가 아닌 항목은 기본값으로 채우지 않고 버리고 그 수를 센다 —
 * 빈 값을 0.5 로 채우면 모델이 중요도를 안 준 항목이 판단을 거친 것처럼 저장된다.
 * 파싱 실패·content 너무 짧음 등 모든 항목 제거 후 통과한 배열만 반환.
 */
export function parseExtractionResponseDetailed(raw: string): ParsedExtraction {
  const empty: ParsedExtraction = { items: [], missingImportanceCount: 0 };
  const stripped = stripCodeFences(raw.trim());
  if (!stripped) return empty;

  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch {
    return empty;
  }

  const arr = coerceToArray(data);
  if (!arr) return empty;

  const items: ExtractedItem[] = [];
  let missingImportanceCount = 0;
  for (const entry of arr) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;

    const content =
      typeof rec.content === "string" ? rec.content.trim() : "";
    if (content.length < MIN_EXTRACTED_CONTENT_LENGTH) continue;

    const importance = clampImportance(rec.importance);
    if (importance === null) {
      missingImportanceCount += 1;
      continue;
    }

    items.push({
      content,
      memoryType: coerceMemoryType(rec.memoryType),
      importance,
      // Phase 7 명시 메타 (Task 3) — 선택 칸. 모델이 안 내면 undefined (graceful).
      place: optionalString(rec.place),
      person: optionalStringArray(rec.person),
      eventDateText: optionalString(rec.eventDateText),
    });
  }

  return { items, missingImportanceCount };
}

/** 통과한 항목만 — 버린 수가 필요 없는 호출처용. */
export function parseExtractionResponse(raw: string): ExtractedItem[] {
  return parseExtractionResponseDetailed(raw).items;
}

/**
 * 2026-06-02 T3 — 빈 응답 판별 (순수 함수, 단위 검증 가능).
 *
 * 형식 강제 OFF (T2) 의 안전망 — parseExtractionResponse 가 빈 배열을 낼 때
 * 두 갈래를 구분한다:
 *   - "valid-empty": 모델이 빈 배열을 *명시* 반환 (`[]` / `{"items":[]}` 등).
 *     ㅋㅋㅋ 같은 잡음 입력에 "추출할 게 없다 → []" 를 정상 반환한 것 —
 *     진짜 빈 결과 (CLAUDE.md real empty state). 재요청 불필요.
 *   - "garbled": raw 가 빈 문자열이거나, JSON 파싱 실패거나, 파싱은 됐으나
 *     배열 / 래퍼 객체 어디에도 안 맞는 형태 (coerceToArray null). 모델이
 *     설명문 / 잘린 JSON / 엉뚱한 구조를 낸 경우 — 1회 재요청 대상.
 *
 * 주의 (§4.3): coerceToArray 가 *비어있지 않은* 배열을 반환했는데
 * parseExtractionResponse 가 필터 (importance / content 길이) 로 빈 배열을 낸
 * 경우는 garbled 아님 — 모델은 정상 JSON 을 냈고 필터가 비운 것이라 재요청
 * 불필요. 그래서 판별은 parseExtractionResponse 결과가 아니라 raw 의 파싱
 * 가능성으로 한다.
 */
export function classifyEmptyResponse(raw: string): "valid-empty" | "garbled" {
  const stripped = stripCodeFences(raw.trim());
  if (!stripped) return "garbled";

  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch {
    return "garbled";
  }

  const arr = coerceToArray(data);
  if (arr === null) return "garbled";
  return "valid-empty";
}

/** importance 하한 이하 항목 제거. */
export function filterByImportance(
  items: readonly ExtractedItem[],
  minImportance: number = EXTRACTOR_MIN_IMPORTANCE,
): ExtractedItem[] {
  return items.filter((i) => i.importance >= minImportance);
}

/**
 * 같은 응답 내 중복(content 정확 일치) 제거.
 *
 * 비교 키는 NFC + trim 으로 통일한다 — 저장 흡수 키(content-hash.ts)와 같은 규칙이라
 * 여기서 남긴 항목이 뒤 저장 단계에서 다시 갈라지지 않는다. 모델이 같은 한글 문장을
 * 조합형(NFD)·완성형(NFC)으로 섞어 내면 정규화 없이는 둘 다 통과해 중복이 쌓인다.
 * 반환 항목의 content 자체는 안 바꾼다(키만 정규화 — 원문 보존).
 */
export function dedupeWithinResponse(
  items: readonly ExtractedItem[],
): ExtractedItem[] {
  const seen = new Set<string>();
  const out: ExtractedItem[] = [];
  for (const item of items) {
    const key = toNfc(item.content).trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function normalizeRestatementText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.?!。！？]+$/u, "")
    .trim();
}

export function isTrivialSingleExtractionRestatement(
  sourceText: string,
  extractedContent: string,
): boolean {
  const source = normalizeRestatementText(sourceText);
  const extracted = normalizeRestatementText(extractedContent);
  if (!source || !extracted) return false;
  if (extracted === source) return true;
  return extracted === `${source}이다` || extracted === `${source}입니다`;
}

export function filterTrivialSingleExtraction(
  sourceText: string,
  items: readonly ExtractedItem[],
): ExtractedItem[] {
  if (items.length !== 1) return [...items];
  return isTrivialSingleExtractionRestatement(sourceText, items[0]!.content)
    ? []
    : [...items];
}

// ── 내부 헬퍼 ────────────────────────────────────────────────────────────

function stripCodeFences(text: string): string {
  if (!text.startsWith("```")) return text;
  // ```json\n...\n``` 또는 ```\n...\n```
  const firstNewline = text.indexOf("\n");
  const inner = firstNewline === -1 ? text.slice(3) : text.slice(firstNewline + 1);
  const trailingFenceIdx = inner.lastIndexOf("```");
  return trailingFenceIdx === -1 ? inner.trim() : inner.slice(0, trailingFenceIdx).trim();
}

function coerceToArray(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  // 일부 모델이 {"items": [...]} 또는 {"memories": [...]}로 감싸기도 함.
  if (data && typeof data === "object") {
    const rec = data as Record<string, unknown>;
    for (const key of [OPENAI_JSON_SCHEMA_ARRAY_WRAPPER_KEY, "memories", "extractions", "results"]) {
      const v = rec[key];
      if (Array.isArray(v)) return v;
    }
    // 단일 항목 객체 → 1원소 배열로.
    if (typeof rec.content === "string") return [rec];
  }
  return null;
}

const VALID_MEMORY_TYPES: ReadonlySet<string> = new Set(MEMORY_TYPES);

function coerceMemoryType(raw: unknown): MemoryType {
  if (typeof raw === "string" && VALID_MEMORY_TYPES.has(raw)) {
    return raw as MemoryType;
  }
  return "fact";
}

/** 유한한 숫자면 [0, 1] 로 clamp, 아니면(없음·문자열·NaN 등) null. */
function clampImportance(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}

function optionalString(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Phase 7 명시 메타 (Task 3) — person 칸 정리. 모델이 사람 이름을 배열로 내는 게
 * 정상이지만, 단일 문자열로 내는 변동도 관대하게 1원소 배열로 받는다. 빈 문자열
 * 원소·공백은 제거하고, 정리 후 0개면 undefined (지어내지 않음 — 정직한 빈 값).
 */
function optionalStringArray(raw: unknown): string[] | undefined {
  let candidates: unknown[];
  if (Array.isArray(raw)) {
    candidates = raw;
  } else if (typeof raw === "string") {
    candidates = [raw];
  } else {
    return undefined;
  }
  const cleaned: string[] = [];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const trimmed = c.trim();
    if (trimmed.length > 0) cleaned.push(trimmed);
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * "버려진 항목 갯수" 계산 — importance 가 없어 파싱에서 버린 항목 + importance 하한·응답 내
 * 중복·원문 재진술 필터로 버린 항목. 저장 단계는 필터 뒤 항목만 받으므로 raw 응답을 다시
 * 파싱한다 — 한 번 더 비용이지만 디버깅·관측에 가치.
 */
export function countFilteredOut(raw: string, finalItems: readonly ExtractedItem[]): number {
  const parsed = parseExtractionResponseDetailed(raw);
  return Math.max(0, parsed.items.length + parsed.missingImportanceCount - finalItems.length);
}
