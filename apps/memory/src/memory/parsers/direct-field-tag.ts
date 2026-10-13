/**
 * direct-field-tag.ts — 활용 단계2 ②·③ 직접 입력 칸 파서.
 *
 * 직접 입력 칸 키(node_field·place 갈래)는 글 노드 칸/장소 입력이라는 별도 의미를
 * 가진다. 그래서 일반 라벨 파서와 별도로 쉼표 경계 값을 뽑고, 호출처가 글 칸 충돌과
 * 장소 갈래를 따로 처리한다. 값 경계 = 다음 쉼표 / 없으면 줄바꿈·줄 끝(먼저 오는 것).
 *
 * 두 갈래를 산출에서 가른다 — 글 칸(`fields`·event_at·event_until)과 장소(`places`).
 * 호출처(parseHashtagEntities)가 글 칸은 같은 칸 충돌을 판정하고, place 는 한 글에
 * 여럿이 자연스러워(엔티티) 충돌 없이 다 받기 때문이다.
 *
 * 회귀 0: node_field·place 갈래 키만 매칭(#사람:·#작품: 은 무시·기존 정규식이 처리).
 * 정직한 실패: 값 빈 키는 errors 로(거짓 채움 0). LLM 호출 0·now/DB 의존 0.
 */
import type {
  NodeFieldColumn,
  ReservedKeyMap,
} from "./hashtag-reserved-keys.ts";
import { extractValueToBoundary } from "./tag-value-boundary.ts";

export interface ParsedDirectField {
  column: NodeFieldColumn;
  value: string;
}

export interface DirectFieldParseError {
  tag: string;
  reason: string;
}

export interface ParsedDirectFieldInput {
  /** 글 칸(event_at·event_until) 직접 입력 — 기존 node_field 갈래. */
  fields: ParsedDirectField[];
  /** 장소 직접 입력(활용 단계2 ③) — 값 그대로(엔티티 해석은 wiring 의 setPlace). */
  places: string[];
  errors: DirectFieldParseError[];
}

// `#` + 키(공백 안·colon 안) + `:` — 값은 정규식이 아니라 쉼표/줄바꿈 경계로 잘라 뽑는다.
const DIRECT_FIELD_KEY_REGEX = /#([\p{L}\p{N}_-]+):/gu;

export function parseDirectFieldTags(
  text: string,
  reservedKeys: ReservedKeyMap,
): ParsedDirectFieldInput {
  const result: ParsedDirectFieldInput = { fields: [], places: [], errors: [] };
  if (!text) return result;

  DIRECT_FIELD_KEY_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DIRECT_FIELD_KEY_REGEX.exec(text)) !== null) {
    const key = match[1];
    if (!key) continue;
    const def = reservedKeys[key];
    if (!def) continue;
    if (def.kind !== "node_field" && def.kind !== "place") continue;
    if (def.kind === "node_field" && !def.nodeColumn) continue;

    // 값 경계 — 쉼표/줄바꿈 중 먼저, 없으면 줄 끝(두 갈래 공통·tag-value-boundary 단일 출처).
    const valueStart = match.index + match[0].length;
    const value = extractValueToBoundary(text, valueStart);

    if (value.length === 0) {
      result.errors.push({
        tag: `#${key}:`,
        reason: `직접 입력 칸 키 '${key}' 의 값이 비어 있음`,
      });
      continue;
    }
    if (def.kind === "node_field") {
      result.fields.push({ column: def.nodeColumn!, value });
    } else {
      result.places.push(value);
    }
  }
  return result;
}
