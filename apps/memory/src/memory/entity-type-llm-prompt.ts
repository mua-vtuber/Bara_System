/**
 * entity-type-llm-prompt.ts — 개념 엔티티 타입 3단(LLM) 프롬프트·스키마·파싱 (spec §6.2 3단).
 *
 * 결정적 1·2단(명시 태그·분류 폴더 단어 경계 매칭)에 안 걸린 입력만 LLM 으로 10 배치 타입 중 하나로
 * 분류한다. 이 모듈은 LLM 에 보낼 메시지와 jsonSchema 를 만들고 응답을 파싱하는 일만
 * 한다 — 실제 호출·degrade 판단은 classifyEntityType(entity-type-classifier.ts)이 한다.
 * 분류 본체에서 프롬프트·스키마·파싱이 비대해지지 않도록 떼어 둔 모듈이다.
 *
 * 타입 목록·enum 은 placementTypeNames() + koNameOf 단일 출처에서 만든다 — 타입 이름을
 * 여기 하드코딩하지 않는다. 새 타입이 늘면 이 프롬프트도 자동으로 따라 늘어난다.
 *
 * LLM 은 타입만 판정한다. subcategory(위계 진입)는 결정 단의 몫이라 스키마에 두지 않는다 —
 * LLM 이 분류 레벨까지 단정하면 환각이 된다.
 *
 * silent fallback 금지 — 파싱 실패는 throw 한다(classifyEntityType 이 받아 기타로 정직
 * degrade 하되 사유를 보존). LLM 이 "모름"(null)을 답하면 거짓 타입을 만들지 않고 그대로
 * { typeName: null } 로 돌려준다.
 */
import type { ChatMessage } from "../llm/types.ts";
import { placementTypeNames, isPlacementType, type PlacementTypeName } from "./concept-type-vocabulary.ts";
import { koNameOf } from "./entity-type-classifier.ts";

/** LLM 분류 응답을 파싱한 결과. typeName 이 null 이면 "모름"(기타). */
export interface ParsedClassification {
  typeName: PlacementTypeName | null;
  reason: string;
}

/** typeName 으로 허용되는 영문 키 목록(정적 10종 ∪ DB 새 종류). enum·검증 단일 출처. */
function typeKeyList(): PlacementTypeName[] {
  return [...placementTypeNames()];
}

/**
 * 응답 구조 강제용 jsonSchema. Ollama 0.5+ 의 structured output 양식 —
 * extractor 의 EXTRACTION_RESPONSE_SCHEMA 와 같은 형태(type/properties/enum).
 *
 * typeName 은 10 배치 타입 키 enum 에 "none"(모름)을 더한 닫힌 집합이다. JSON Schema
 * enum 은 null 토큰을 직접 못 담는 모델이 많아, "모름"을 별도 토큰 "none" 으로 받고
 * 파싱 단계에서 typeName: null 로 환산한다(거짓 타입 방지). reason 은 짧은 근거.
 */
export function classificationJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      typeName: { type: "string", enum: [...typeKeyList(), "none"] },
      reason: { type: "string" },
    },
    required: ["typeName"],
    additionalProperties: false,
  };
}

/**
 * 분류 프롬프트 메시지. 짧은 한국어 system + 입력 본문 user 한 쌍.
 * 타입 목록은 "영문키(한국어이름)" 줄로 만들어 모델이 영문 키를 그대로 뱉게 한다 —
 * enum 도 같은 영문 키라 응답이 스키마에 바로 맞는다.
 */
export function buildClassificationMessages(text: string): ChatMessage[] {
  const typeLines = typeKeyList()
    .map((t) => `- ${t} (${koNameOf(t)})`)
    .join("\n");
  const system =
    "너는 글을 읽고 그 글의 핵심 대상이 어떤 종류인지 하나만 고르는 분류기다.\n" +
    "아래 목록에서 가장 잘 맞는 종류의 영문 키 하나를 typeName 으로 답하라.\n" +
    `${typeLines}\n` +
    '- none (위 어디에도 분명히 들어맞지 않으면 이걸 골라라)\n' +
    "확실하지 않으면 억지로 고르지 말고 none 을 골라라. " +
    "reason 에는 그 종류를 고른 짧은 근거를 한국어로 한 문장 적어라.";
  const user = `다음 글의 종류를 골라라:\n${text}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * LLM 원문 응답(JSON 문자열)을 파싱한다. 모델이 코드펜스를 두르는 경우가 있어
 * 첫 `{`부터 마지막 `}`까지만 잘라 파싱한다(extractor 의 관대 파싱과 같은 정신).
 *
 * - typeName 이 10 배치 타입 키면 그대로.
 * - "none" 또는 목록 밖 무효 값이면 typeName: null(거짓 타입 안 만듦).
 * - JSON 자체가 깨졌으면 throw — classifyEntityType 이 받아 기타로 degrade 하되
 *   빈 성공으로 위장하지 않고 사유를 보존한다(silent fallback 금지).
 */
export function parseClassificationResponse(raw: string): ParsedClassification {
  const json = extractJsonObject(raw);
  const typeNameRaw = typeof json.typeName === "string" ? json.typeName.trim() : "";
  const reason = typeof json.reason === "string" ? json.reason.trim() : "";
  if (typeNameRaw && isPlacementTypeName(typeNameRaw)) {
    return { typeName: typeNameRaw, reason };
  }
  // "none"·빈 값·목록 밖 토큰 = 모름. 거짓 타입을 만들지 않고 정직하게 null.
  return { typeName: null, reason };
}

function isPlacementTypeName(value: string): value is PlacementTypeName {
  return isPlacementType(value);
}

/**
 * 응답에서 JSON 객체 본문을 떼어 파싱한다. 모델이 ```json 펜스나 설명 문장을
 * 앞뒤에 붙여도 첫 `{`~짝 맞는 마지막 `}` 만 파싱한다. 객체를 못 찾거나 파싱이
 * 깨지면 throw(호출자가 사유 보존하며 degrade).
 */
function extractJsonObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`분류 응답에서 JSON 객체를 찾지 못함: ${raw.slice(0, 200)}`);
  }
  const slice = raw.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch (e) {
    throw new Error(`분류 응답 JSON 파싱 실패: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`분류 응답이 객체가 아님: ${slice.slice(0, 200)}`);
  }
  return parsed as Record<string, unknown>;
}
