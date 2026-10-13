/**
 * settings/memory-settings-validate.ts — 메모리 설정 schema 정합 검증.
 *
 * memory-settings.ts 에서 떼어낸 validateMemorySettings + 그룹·서브그룹·필드 검증
 * 헬퍼를 모은다. MEMORY_SCHEMA 한 출처로 그룹 누락·타입·enum·범위를 검사한다.
 * 800줄 한계 안에 들어가도록 분리한 것일 뿐 검증 로직은 옮기기 전과 동일하다.
 */

import {
  MEMORY_GROUP_KEYS,
  MEMORY_SCHEMA,
  type MemoryGroupKey,
} from "./memory-schema";

/** 설정 검증 결과 — ok=false 면 errors 에 사람이 읽는 사유 목록. */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateMemorySettings(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return { ok: false, errors: ["root: 객체 필요"] };
  }
  const root = value as Record<string, unknown>;
  for (const groupKey of MEMORY_GROUP_KEYS) {
    if (!(groupKey in root)) {
      errors.push(`${groupKey}: 그룹 누락`);
      continue;
    }
    const group = root[groupKey];
    if (typeof group !== "object" || group === null) {
      errors.push(`${groupKey}: 객체 필요`);
      continue;
    }
    validateGroup(groupKey, group as Record<string, unknown>, errors);
  }
  return { ok: errors.length === 0, errors };
}

function validateGroup(
  groupKey: MemoryGroupKey,
  group: Record<string, unknown>,
  errors: string[],
): void {
  const groupSchema = MEMORY_SCHEMA.properties[groupKey];
  const required = groupSchema.required as readonly string[];
  for (const key of required) {
    if (!(key in group)) {
      errors.push(`${groupKey}.${key}: 필수 필드 누락`);
    }
  }
  for (const [fieldKey, fieldValue] of Object.entries(group)) {
    const propSchema = (groupSchema.properties as Record<string, unknown>)[
      fieldKey
    ] as
      | {
          type: "string" | "number" | "integer" | "boolean" | "array" | "object";
          enum?: readonly string[];
          format?: "uri";
          pattern?: string;
          minimum?: number;
          maximum?: number;
          items?: { type: "string"; enum?: readonly string[] };
          properties?: Record<string, unknown>;
          required?: readonly string[];
        }
      | undefined;
    if (!propSchema) {
      // schema 에 없는 필드는 무시 (확장 여지 — 엄격 모드 도입 전).
      continue;
    }
    const path = `${groupKey}.${fieldKey}`;
    if (propSchema.type === "object") {
      // Phase 5.6 W5 — sub-object 슬롯 (llm.extractor / llm.cleanup) 재귀 검증.
      // Phase 6a T10 — extractor.regex sub-object 도 같은 재귀 경로.
      if (typeof fieldValue !== "object" || fieldValue === null) {
        errors.push(`${path}: 객체 필요`);
        continue;
      }
      validateSubGroup(
        path,
        fieldValue as Record<string, unknown>,
        propSchema as {
          properties: Record<string, unknown>;
          required: readonly string[];
        },
        errors,
      );
      continue;
    }
    validateField(
      path,
      fieldValue,
      propSchema as {
        type: "string" | "number" | "integer" | "boolean" | "array";
        enum?: readonly string[];
        format?: "uri";
        pattern?: string;
        minimum?: number;
        maximum?: number;
        items?: { type: "string"; enum?: readonly string[] };
      },
      errors,
    );
  }
}

/**
 * Phase 5.6 W5 — sub-object 슬롯 (llm.extractor / llm.cleanup) 단위 검증.
 * Phase 5.7.1 W1 — 재귀 정합. sub-object 안에 또 sub-object (llm.extractor.backfill)
 * 가 들어간 갈래도 한 단계 더 깊게 검증.
 */
function validateSubGroup(
  parentPath: string,
  group: Record<string, unknown>,
  schema: {
    properties: Record<string, unknown>;
    required: readonly string[];
  },
  errors: string[],
): void {
  for (const key of schema.required) {
    if (!(key in group)) {
      errors.push(`${parentPath}.${key}: 필수 필드 누락`);
    }
  }
  for (const [fieldKey, fieldValue] of Object.entries(group)) {
    const fieldSchema = schema.properties[fieldKey] as
      | {
          type: "string" | "number" | "integer" | "boolean" | "array" | "object";
          enum?: readonly string[];
          format?: "uri";
          pattern?: string;
          minimum?: number;
          maximum?: number;
          items?: { type: "string"; enum?: readonly string[] };
          properties?: Record<string, unknown>;
          required?: readonly string[];
        }
      | undefined;
    if (!fieldSchema) continue;
    const path = `${parentPath}.${fieldKey}`;
    if (fieldSchema.type === "object") {
      // 한 단계 더 깊은 sub-object (llm.extractor.backfill).
      if (typeof fieldValue !== "object" || fieldValue === null) {
        errors.push(`${path}: 객체 필요`);
        continue;
      }
      validateSubGroup(
        path,
        fieldValue as Record<string, unknown>,
        fieldSchema as {
          properties: Record<string, unknown>;
          required: readonly string[];
        },
        errors,
      );
      continue;
    }
    validateField(
      path,
      fieldValue,
      fieldSchema as {
        type: "string" | "number" | "integer" | "boolean" | "array";
        enum?: readonly string[];
        format?: "uri";
        pattern?: string;
        minimum?: number;
        maximum?: number;
        items?: { type: "string"; enum?: readonly string[] };
      },
      errors,
    );
  }
}

function validateField(
  path: string,
  value: unknown,
  schema: {
    type: "string" | "number" | "integer" | "boolean" | "array";
    enum?: readonly string[];
    format?: "uri";
    pattern?: string;
    minimum?: number;
    maximum?: number;
    items?: { type: "string"; enum?: readonly string[] };
  },
  errors: string[],
): void {
  // array — Phase 6a T10 extractor.regex.langs (문자열 배열). 원소 타입 + (있으면)
  // enum 후보 목록 검증. 배열 아님 / 원소 비문자열 / enum 미일치 = 구체 에러.
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path}: 배열 필요`);
      return;
    }
    const itemEnum = schema.items?.enum;
    for (let i = 0; i < value.length; i++) {
      const el = value[i];
      if (typeof el !== "string") {
        errors.push(`${path}[${i}]: string 원소 필요`);
        continue;
      }
      if (itemEnum && !itemEnum.includes(el)) {
        errors.push(`${path}[${i}]: enum 미일치 (${itemEnum.join("|")})`);
      }
    }
    return;
  }
  // type
  if (schema.type === "string" && typeof value !== "string") {
    errors.push(`${path}: string 필요`);
    return;
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    errors.push(`${path}: boolean 필요`);
    return;
  }
  if (
    (schema.type === "number" || schema.type === "integer") &&
    typeof value !== "number"
  ) {
    errors.push(`${path}: number 필요`);
    return;
  }
  if (schema.type === "integer" && !Number.isInteger(value as number)) {
    errors.push(`${path}: integer 필요`);
    return;
  }
  // enum
  if (schema.enum && !schema.enum.includes(value as string)) {
    errors.push(`${path}: enum 미일치 (${schema.enum.join("|")})`);
    return;
  }
  // format: uri — 빈 문자열은 "미설정" 의미로 허용 (Phase 5.6 W5 두 슬롯 정합).
  // slot.enabled=false 또는 slot.provider='anthropic' 갈래에서는 ollamaUrl 이 빈
  // 문자열일 수 있고, 이는 schema 미정합 아닌 *명시 미사용* 상태. silent fallback
  // 아님 — provider 필드가 갈래 명시이므로 ollamaUrl 검사 자체가 의미 없음.
  if (
    schema.format === "uri" &&
    typeof value === "string" &&
    value.length > 0
  ) {
    try {
      // URL 생성자가 던지면 invalid.
      new URL(value);
    } catch {
      errors.push(`${path}: uri 형식 불일치`);
      return;
    }
  }
  // pattern — Phase 5.7.3 W1 trashManagement.cronTime HH:MM 검증 정합.
  if (
    schema.pattern !== undefined &&
    typeof value === "string" &&
    value.length > 0
  ) {
    const re = new RegExp(schema.pattern);
    if (!re.test(value)) {
      errors.push(`${path}: pattern 불일치 (${schema.pattern})`);
      return;
    }
  }
  // minimum / maximum
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: ${schema.minimum} 이상 필요`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: ${schema.maximum} 이하 필요`);
    }
  }
}
