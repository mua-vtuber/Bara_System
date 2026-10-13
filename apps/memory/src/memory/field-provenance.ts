/**
 * field-provenance.ts — 칸 값의 "출처"(누가 채웠나)와 덮어쓰기 우선순위.
 *
 * 활용 spec §4.2·§4.3: 직접 입력(사람·어댑터) > 시스템 규칙(날짜파서) > 추론(LLM).
 * 직접 입력값은 시스템·추론이 못 덮고, 시스템값은 직접이 덮되 추론은 못 덮는다.
 * 빈 칸은 누구든 채운다. 같은 출처의 재기록은 허용(값 갱신).
 *
 * 출처는 knowledge_nodes.metadata_json 안 fieldSources 맵에 둔다(스키마 무변경).
 * 이 모듈은 DB 의존 없는 순수 함수만 — 단위 검증이 쉽다.
 */

export type FieldSource = "direct" | "system" | "inferred";

/** 높을수록 우선. 낮은 출처는 높은 출처가 채운 칸을 못 덮는다. */
const FIELD_SOURCE_PRIORITY: Record<FieldSource, number> = {
  direct: 3,
  system: 2,
  inferred: 1,
};

/**
 * incoming 출처가 existing 출처가 채운 칸을 덮어써도 되는지.
 * - existing 없음(빈 칸) → 항상 쓰기
 * - incoming 우선순위 >= existing → 쓰기(같으면 갱신 허용)
 * - incoming < existing → 거부(직접 입력값 보호)
 */
export function canWriteField(
  existing: FieldSource | undefined,
  incoming: FieldSource,
): boolean {
  if (existing === undefined) return true;
  return FIELD_SOURCE_PRIORITY[incoming] >= FIELD_SOURCE_PRIORITY[existing];
}

/** metadata_json 에서 한 칸의 출처를 읽는다. 없거나 깨졌으면 undefined. */
export function readFieldSource(
  metadataJson: string | null | undefined,
  field: string,
): FieldSource | undefined {
  if (!metadataJson) return undefined;
  try {
    const parsed = JSON.parse(metadataJson) as {
      fieldSources?: Record<string, string>;
    };
    const src = parsed.fieldSources?.[field];
    if (src === "direct" || src === "system" || src === "inferred") return src;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * metadata_json 에 한 칸의 출처를 기록한 새 JSON 문자열을 반환한다.
 * 기존 키는 보존하고 fieldSources[field] 만 갱신. 빈/깨진 입력은 새 객체로.
 */
export function withFieldSource(
  metadataJson: string | null | undefined,
  field: string,
  source: FieldSource,
): string {
  let base: Record<string, unknown> = {};
  if (metadataJson) {
    try {
      const parsed = JSON.parse(metadataJson);
      if (parsed && typeof parsed === "object") base = parsed;
    } catch {
      base = {};
    }
  }
  const fieldSources =
    (base.fieldSources as Record<string, string> | undefined) ?? {};
  fieldSources[field] = source;
  base.fieldSources = fieldSources;
  return JSON.stringify(base);
}

/** metadata_json 에서 한 칸의 출처 기록만 제거한 새 JSON 문자열을 반환한다. */
export function withoutFieldSource(
  metadataJson: string | null | undefined,
  field: string,
): string {
  let base: Record<string, unknown> = {};
  if (metadataJson) {
    try {
      const parsed = JSON.parse(metadataJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      base = {};
    }
  }
  const fieldSources =
    (base.fieldSources as Record<string, string> | undefined) ?? {};
  delete fieldSources[field];
  if (Object.keys(fieldSources).length === 0) {
    delete base.fieldSources;
  } else {
    base.fieldSources = fieldSources;
  }
  return JSON.stringify(base);
}
