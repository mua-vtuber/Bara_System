/**
 * Validator (Phase 5.5.2 / spec section 5.2).
 *
 * 본 모듈 자체 검증기 — 외부 ajv 안 씀 (모듈 정체성: 외부 의존성 최소).
 * JSON Schema 의 핵심 키워드만 처리 (required / pattern / min/max /
 * minLength/maxLength / type / enum + 객체/배열 재귀).
 */

import type { FieldSchema } from "./widgets/widget";

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

function joinPath(parent: string, key: string | number): string {
  if (parent === "") return String(key);
  return typeof key === "number" ? `${parent}[${key}]` : `${parent}.${key}`;
}

function validateField(
  schema: FieldSchema,
  value: unknown,
  path: string,
  errors: ValidationError[],
  required: boolean,
): void {
  if (value === undefined || value === null || value === "") {
    if (required) errors.push({ path, message: "필수 필드" });
    return;
  }

  // type 검증
  if (schema.type === "string" && typeof value !== "string") {
    errors.push({ path, message: "string 필요" });
    return;
  }
  if ((schema.type === "number" || schema.type === "integer") && typeof value !== "number") {
    errors.push({ path, message: "number 필요" });
    return;
  }
  if (schema.type === "integer" && typeof value === "number" && !Number.isInteger(value)) {
    errors.push({ path, message: "정수 필요" });
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    errors.push({ path, message: "boolean 필요" });
    return;
  }
  if (schema.type === "array" && !Array.isArray(value)) {
    errors.push({ path, message: "배열 필요" });
    return;
  }
  if (
    schema.type === "object" &&
    (typeof value !== "object" || Array.isArray(value) || value === null)
  ) {
    errors.push({ path, message: "객체 필요" });
    return;
  }

  // string 제약
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push({ path, message: `${schema.minLength}자 이상 필요` });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push({ path, message: `${schema.maxLength}자 이하 필요` });
    }
    if (typeof schema.pattern === "string") {
      const re = new RegExp(schema.pattern);
      if (!re.test(value)) {
        errors.push({ path, message: `패턴 ${schema.pattern} 미일치` });
      }
    }
  }

  // number 제약
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push({ path, message: `${schema.minimum} 이상 필요` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push({ path, message: `${schema.maximum} 이하 필요` });
    }
  }

  // enum 제약
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push({
      path,
      message: `허용 값: ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`,
    });
  }

  // 재귀 — 객체
  if (schema.type === "object" && schema.properties) {
    const obj = value as Record<string, unknown>;
    const requiredFields = new Set(schema.required ?? []);
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      validateField(
        childSchema,
        obj[key],
        joinPath(path, key),
        errors,
        requiredFields.has(key),
      );
    }
  }

  // 재귀 — 배열
  if (schema.type === "array" && schema.items && Array.isArray(value)) {
    value.forEach((item, i) => {
      validateField(schema.items!, item, joinPath(path, i), errors, false);
    });
  }
}

export function validate(
  schema: FieldSchema,
  value: unknown,
): ValidationResult {
  const errors: ValidationError[] = [];
  validateField(schema, value, "", errors, false);
  return { valid: errors.length === 0, errors };
}
