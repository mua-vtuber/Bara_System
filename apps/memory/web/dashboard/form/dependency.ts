/**
 * Dependency evaluator (Phase 5.5.2 / spec section 5.2).
 *
 * JSON Schema `if/then/else` + `dependentSchemas` 의 단순 평가기. 본 모듈
 * 활용 범위는 *boolean true → 추가 필드 노출* 패턴 정도라, 전체 JSON Schema
 * 의존성 의미를 다 다루지 않고 핵심 케이스만 처리한다.
 *
 * 평가 규칙: `if` 안의 `properties` 매칭만 인식. 예) `if: { properties:
 * { enabled: { const: true } } }` 면 value.enabled === true 일 때 then 활성.
 */

import type { FieldSchema } from "./widgets/widget";

export interface ConditionalSchema {
  if?: FieldSchema;
  then?: FieldSchema;
  else?: FieldSchema;
  dependentSchemas?: Record<string, FieldSchema>;
}

/**
 * 본 함수는 if 조건이 value 와 매칭되는지 판단한다.
 *
 * JSON Schema 표준의 `if` 는 *부분 schema* 형태지만, 본 모듈이 활용하는
 * 범위는 `if: { properties: { X: { const: V } } }` 패턴만이라 X === V 만
 * 확인. 그 외 properties / type / enum 도 보조적으로 지원.
 */
export function evaluateIf(
  ifSchema: FieldSchema | undefined,
  value: Record<string, unknown>,
): boolean {
  if (!ifSchema) return false;
  if (ifSchema.properties) {
    for (const [key, childSchema] of Object.entries(ifSchema.properties)) {
      const childValue = value[key];
      const constValue = (childSchema as FieldSchema & { const?: unknown }).const;
      if (constValue !== undefined) {
        if (childValue !== constValue) return false;
      } else if (Array.isArray(childSchema.enum)) {
        if (!childSchema.enum.includes(childValue)) return false;
      } else if (childSchema.type !== undefined) {
        const t = typeof childValue;
        if (childSchema.type === "string" && t !== "string") return false;
        if (childSchema.type === "number" && t !== "number") return false;
        if (childSchema.type === "boolean" && t !== "boolean") return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * `if/then/else` 평가 → 활성 schema (then 또는 else) 반환. 호출자는 본
 * 결과의 *추가 properties* 를 기본 properties 위에 merge 한다.
 */
export function resolveConditional(
  conditional: ConditionalSchema,
  value: Record<string, unknown>,
): FieldSchema | undefined {
  if (conditional.if !== undefined) {
    const matched = evaluateIf(conditional.if, value);
    if (matched) return conditional.then;
    return conditional.else;
  }
  return undefined;
}

/**
 * `dependentSchemas` 평가 → value 의 키가 채워져 있으면 해당 추가 schema 를
 * 활성화. 호출자가 merge 한다.
 */
export function resolveDependentSchemas(
  dependentSchemas: Record<string, FieldSchema> | undefined,
  value: Record<string, unknown>,
): FieldSchema[] {
  if (!dependentSchemas) return [];
  const active: FieldSchema[] = [];
  for (const [key, depSchema] of Object.entries(dependentSchemas)) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== "") {
      active.push(depSchema);
    }
  }
  return active;
}

/**
 * 활성 필드 = 기본 properties + (if/then/else 매칭 결과의 properties) +
 * dependentSchemas 매칭 결과의 properties.
 *
 * form-renderer (S5) 가 *지금 렌더링할 필드 집합* 결정 시 호출.
 */
export function getActiveProperties(
  schema: FieldSchema & ConditionalSchema,
  value: Record<string, unknown>,
): Record<string, FieldSchema> {
  const result: Record<string, FieldSchema> = { ...(schema.properties ?? {}) };

  const conditional = resolveConditional(schema, value);
  if (conditional?.properties) {
    Object.assign(result, conditional.properties);
  }

  for (const dep of resolveDependentSchemas(schema.dependentSchemas, value)) {
    if (dep.properties) Object.assign(result, dep.properties);
  }
  return result;
}
