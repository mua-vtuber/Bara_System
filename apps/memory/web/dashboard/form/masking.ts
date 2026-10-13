/**
 * Password 마스킹 약속 — PUT body 생성 (Phase 5.5.3 / spec section 5.3, 6.4).
 *
 * collectChangedFields(original, current, schema) → partial 산출.
 *
 * 정신:
 *   - getPath 응답 안 password 필드 = sentinel (`null` + `$masked`, 또는
 *     `'••••'`). 본인이 변경 안 했으면 currentValue 가 sentinel 그대로 →
 *     partial 에서 생략 (덮어쓰기 방지).
 *   - 본인이 새 값 입력 = currentValue 가 일반 string → partial 에 포함.
 *   - 비-password 필드 = 값 변경 있으면 포함, 변경 안 했으면 생략
 *     (spec 6.4 "변경된 필드만 추출" 정신).
 *   - 중첩 object / 배열 안 객체 = 재귀 (각 child 단위로 같은 정합).
 *
 * 본 모듈 = 순수 함수. DOM 의존성 없음. mock 객체 없음.
 */

import type { FieldSchema } from "./widgets/widget";

const MASK_CHAR = "•";

export function isMaskedSentinel(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  for (const ch of value) {
    if (ch !== MASK_CHAR) return false;
  }
  return true;
}

function isPasswordSchema(schema: FieldSchema | undefined): boolean {
  return schema?.["x-ui"]?.widget === "password";
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (
      !deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      )
    )
      return false;
  }
  return true;
}

function diffField(
  original: unknown,
  current: unknown,
  schema: FieldSchema | undefined,
): { changed: boolean; value: unknown } {
  if (isPasswordSchema(schema)) {
    if (isMaskedSentinel(current)) return { changed: false, value: undefined };
    if (deepEqual(original, current)) return { changed: false, value: undefined };
    return { changed: true, value: current };
  }

  if (schema?.type === "object" && schema.properties) {
    const sub = collectChangedFields(
      (original ?? {}) as Record<string, unknown>,
      (current ?? {}) as Record<string, unknown>,
      schema,
    );
    if (Object.keys(sub).length === 0) return { changed: false, value: undefined };
    return { changed: true, value: sub };
  }

  if (schema?.type === "array" && Array.isArray(current)) {
    const origArr = Array.isArray(original) ? original : [];
    if (deepEqual(origArr, current)) return { changed: false, value: undefined };
    if (schema.items?.type === "object" && schema.items.properties) {
      const mapped = current.map((item, i) => {
        const origItem = origArr[i];
        const sub = collectChangedFields(
          (origItem ?? {}) as Record<string, unknown>,
          (item ?? {}) as Record<string, unknown>,
          schema.items as FieldSchema,
        );
        return Object.keys(sub).length === 0 ? (item as Record<string, unknown>) : sub;
      });
      return { changed: true, value: mapped };
    }
    return { changed: true, value: current };
  }

  if (deepEqual(original, current)) return { changed: false, value: undefined };
  return { changed: true, value: current };
}

export function collectChangedFields(
  original: Record<string, unknown>,
  current: Record<string, unknown>,
  schema: FieldSchema,
): Record<string, unknown> {
  const partial: Record<string, unknown> = {};
  const properties = schema.properties ?? {};
  const keys = new Set<string>([
    ...Object.keys(properties),
    ...Object.keys(current ?? {}),
  ]);
  for (const key of keys) {
    if (key === "$masked" || key === "$secretsSet") continue;
    const childSchema = properties[key];
    const { changed, value } = diffField(
      (original ?? {})[key],
      (current ?? {})[key],
      childSchema,
    );
    if (changed) partial[key] = value;
  }
  return partial;
}
