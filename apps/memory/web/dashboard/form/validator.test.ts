import { describe, test, expect } from "bun:test";
import { validate } from "./validator";
import type { FieldSchema } from "./widgets/widget";

describe("validate — primitives", () => {
  test("required + 비어 있음 = 에러", () => {
    const schema: FieldSchema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    const result = validate(schema, { name: "" });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([{ path: "name", message: "필수 필드" }]);
  });

  test("type 일치 = 통과", () => {
    const schema: FieldSchema = {
      type: "object",
      properties: { age: { type: "integer" } },
    };
    expect(validate(schema, { age: 30 }).valid).toBe(true);
  });

  test("integer + 소수 = 에러", () => {
    const schema: FieldSchema = {
      type: "object",
      properties: { age: { type: "integer" } },
    };
    const r = validate(schema, { age: 3.14 });
    expect(r.valid).toBe(false);
    expect(r.errors[0]!.message).toContain("정수");
  });

  test("pattern 미일치 = 에러", () => {
    const schema: FieldSchema = {
      type: "object",
      properties: { id: { type: "string", pattern: "^[a-z]+$" } },
    };
    const r = validate(schema, { id: "ABC" });
    expect(r.valid).toBe(false);
    expect(r.errors[0]!.path).toBe("id");
    expect(r.errors[0]!.message).toContain("패턴");
  });

  test("minLength / maxLength", () => {
    const schema: FieldSchema = {
      type: "object",
      properties: { name: { type: "string", minLength: 3, maxLength: 5 } },
    };
    expect(validate(schema, { name: "ab" }).valid).toBe(false);
    expect(validate(schema, { name: "abcdef" }).valid).toBe(false);
    expect(validate(schema, { name: "abcd" }).valid).toBe(true);
  });

  test("minimum / maximum", () => {
    const schema: FieldSchema = {
      type: "object",
      properties: { score: { type: "number", minimum: 0, maximum: 1 } },
    };
    expect(validate(schema, { score: -0.5 }).valid).toBe(false);
    expect(validate(schema, { score: 1.5 }).valid).toBe(false);
    expect(validate(schema, { score: 0.5 }).valid).toBe(true);
  });

  test("enum 미일치 = 에러", () => {
    const schema: FieldSchema = {
      type: "object",
      properties: { color: { type: "string", enum: ["red", "blue"] } },
    };
    expect(validate(schema, { color: "green" }).valid).toBe(false);
    expect(validate(schema, { color: "red" }).valid).toBe(true);
  });

  test("재귀 — 중첩 객체의 에러 경로", () => {
    const schema: FieldSchema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: { age: { type: "integer" } },
          required: ["age"],
        },
      },
    };
    const r = validate(schema, { user: { age: undefined } });
    expect(r.valid).toBe(false);
    expect(r.errors[0]!.path).toBe("user.age");
  });

  test("재귀 — 배열 인덱스가 포함된 경로", () => {
    const schema: FieldSchema = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string", minLength: 2 },
        },
      },
    };
    const r = validate(schema, { tags: ["ok", "a"] });
    expect(r.valid).toBe(false);
    expect(r.errors[0]!.path).toBe("tags[1]");
  });

  test("required 아님 + 값 비어 있음 = 통과", () => {
    const schema: FieldSchema = {
      type: "object",
      properties: { note: { type: "string" } },
    };
    expect(validate(schema, {}).valid).toBe(true);
  });
});
