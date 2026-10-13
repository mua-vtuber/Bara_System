import { describe, test, expect } from "bun:test";
import {
  evaluateIf,
  resolveConditional,
  resolveDependentSchemas,
  getActiveProperties,
} from "./dependency";
import type { FieldSchema } from "./widgets/widget";

describe("evaluateIf", () => {
  test("const 매칭 = true", () => {
    const ifSchema: FieldSchema = {
      properties: { enabled: { const: true } as FieldSchema },
    };
    expect(evaluateIf(ifSchema, { enabled: true })).toBe(true);
    expect(evaluateIf(ifSchema, { enabled: false })).toBe(false);
  });

  test("enum 매칭", () => {
    const ifSchema: FieldSchema = {
      properties: { mode: { enum: ["a", "b"] } },
    };
    expect(evaluateIf(ifSchema, { mode: "a" })).toBe(true);
    expect(evaluateIf(ifSchema, { mode: "c" })).toBe(false);
  });

  test("type 매칭", () => {
    const ifSchema: FieldSchema = {
      properties: { name: { type: "string" } },
    };
    expect(evaluateIf(ifSchema, { name: "hello" })).toBe(true);
    expect(evaluateIf(ifSchema, { name: 123 })).toBe(false);
  });

  test("undefined ifSchema = false", () => {
    expect(evaluateIf(undefined, {})).toBe(false);
  });
});

describe("resolveConditional", () => {
  test("if 매칭 = then 반환", () => {
    const then: FieldSchema = { properties: { ext: { type: "string" } } };
    const result = resolveConditional(
      {
        if: { properties: { enabled: { const: true } as FieldSchema } },
        then,
      },
      { enabled: true },
    );
    expect(result).toBe(then);
  });

  test("if 미매칭 = else 반환", () => {
    const elseSchema: FieldSchema = { properties: { fb: { type: "string" } } };
    const result = resolveConditional(
      {
        if: { properties: { enabled: { const: true } as FieldSchema } },
        then: { properties: {} },
        else: elseSchema,
      },
      { enabled: false },
    );
    expect(result).toBe(elseSchema);
  });

  test("if 없음 = undefined", () => {
    expect(resolveConditional({}, {})).toBeUndefined();
  });
});

describe("resolveDependentSchemas", () => {
  test("값이 채워진 key 의 schema 만 반환", () => {
    const aSchema: FieldSchema = { properties: { x: { type: "string" } } };
    const bSchema: FieldSchema = { properties: { y: { type: "string" } } };
    const active = resolveDependentSchemas(
      { a: aSchema, b: bSchema },
      { a: "set", b: "" },
    );
    expect(active).toEqual([aSchema]);
  });

  test("undefined dependentSchemas = 빈 배열", () => {
    expect(resolveDependentSchemas(undefined, {})).toEqual([]);
  });
});

describe("getActiveProperties — if/then 결과 properties merge", () => {
  test("if 매칭 = then.properties 합쳐짐", () => {
    const schema: FieldSchema & {
      if?: FieldSchema;
      then?: FieldSchema;
    } = {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      if: { properties: { enabled: { const: true } as FieldSchema } },
      then: { properties: { extra: { type: "string" } } },
    };
    const active = getActiveProperties(schema, { enabled: true });
    expect(Object.keys(active).sort()).toEqual(["enabled", "extra"]);
  });

  test("if 미매칭 = then.properties 합쳐지지 않음", () => {
    const schema: FieldSchema & {
      if?: FieldSchema;
      then?: FieldSchema;
    } = {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      if: { properties: { enabled: { const: true } as FieldSchema } },
      then: { properties: { extra: { type: "string" } } },
    };
    const active = getActiveProperties(schema, { enabled: false });
    expect(Object.keys(active)).toEqual(["enabled"]);
  });

  test("dependentSchemas 조건 일치 = 합쳐짐", () => {
    const schema: FieldSchema & {
      dependentSchemas?: Record<string, FieldSchema>;
    } = {
      type: "object",
      properties: { ssl: { type: "boolean" } },
      dependentSchemas: {
        ssl: { properties: { cert: { type: "string" } } },
      },
    };
    const active = getActiveProperties(schema, { ssl: true });
    expect(Object.keys(active).sort()).toEqual(["cert", "ssl"]);
  });
});
