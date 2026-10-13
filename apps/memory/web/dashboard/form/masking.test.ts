import { describe, test, expect } from "bun:test";
import { collectChangedFields, isMaskedSentinel } from "./masking";
import type { FieldSchema } from "./widgets/widget";

describe("isMaskedSentinel", () => {
  test("null + '••••' + '••' = sentinel", () => {
    expect(isMaskedSentinel(null)).toBe(true);
    expect(isMaskedSentinel("••••")).toBe(true);
    expect(isMaskedSentinel("••")).toBe(true);
  });

  test("일반 string / 빈 string / undefined = sentinel X", () => {
    expect(isMaskedSentinel("real-secret")).toBe(false);
    expect(isMaskedSentinel("")).toBe(false);
    expect(isMaskedSentinel(undefined)).toBe(false);
  });
});

describe("collectChangedFields — password 필드", () => {
  const schema: FieldSchema = {
    type: "object",
    properties: {
      discordToken: { type: "string", "x-ui": { widget: "password" } },
      ownerId: { type: "string" },
    },
  };

  test("password 변경 안 함 (sentinel 그대로) = partial 에 없음", () => {
    const original = { discordToken: null, ownerId: "123" };
    const current = { discordToken: null, ownerId: "123" };
    const partial = collectChangedFields(original, current, schema);
    expect(partial).toEqual({});
  });

  test("password '••••' sentinel 그대로 = partial 에 없음", () => {
    const original = { discordToken: "••••", ownerId: "123" };
    const current = { discordToken: "••••", ownerId: "123" };
    const partial = collectChangedFields(original, current, schema);
    expect(partial).toEqual({});
  });

  test("password 새 값 입력 = partial 에 새 값 포함", () => {
    const original = { discordToken: null, ownerId: "123" };
    const current = { discordToken: "new-secret-token", ownerId: "123" };
    const partial = collectChangedFields(original, current, schema);
    expect(partial).toEqual({ discordToken: "new-secret-token" });
  });

  test("password sentinel 그대로 + 비-password 변경 = 비-password 만 포함", () => {
    const original = { discordToken: null, ownerId: "123" };
    const current = { discordToken: null, ownerId: "456" };
    const partial = collectChangedFields(original, current, schema);
    expect(partial).toEqual({ ownerId: "456" });
  });

  test("password + 비-password 둘 다 변경 = 둘 다 포함", () => {
    const original = { discordToken: null, ownerId: "123" };
    const current = { discordToken: "secret", ownerId: "456" };
    const partial = collectChangedFields(original, current, schema);
    expect(partial).toEqual({ discordToken: "secret", ownerId: "456" });
  });

  test("$masked 키는 partial 에 포함 안 됨 (메타데이터)", () => {
    const original = { discordToken: null, $masked: ["discordToken"] };
    const current = { discordToken: null, $masked: ["discordToken"] };
    const partial = collectChangedFields(original, current, schema);
    expect(partial).toEqual({});
    expect("$masked" in partial).toBe(false);
  });
});

describe("collectChangedFields — 비-password 필드", () => {
  const schema: FieldSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
      active: { type: "boolean" },
    },
  };

  test("값 변경 없음 = partial 비어 있음 (변경된 것만)", () => {
    const original = { name: "본인", age: 30, active: true };
    const current = { name: "본인", age: 30, active: true };
    const partial = collectChangedFields(original, current, schema);
    expect(partial).toEqual({});
  });

  test("일부 필드만 변경 = 변경된 필드만 포함", () => {
    const original = { name: "본인", age: 30, active: true };
    const current = { name: "본인", age: 31, active: true };
    const partial = collectChangedFields(original, current, schema);
    expect(partial).toEqual({ age: 31 });
  });

  test("original 에 없던 새 키 = partial 에 포함", () => {
    const original = { name: "본인" };
    const current = { name: "본인", age: 30 };
    const partial = collectChangedFields(original, current, schema);
    expect(partial).toEqual({ age: 30 });
  });
});

describe("collectChangedFields — 중첩 객체", () => {
  const schema: FieldSchema = {
    type: "object",
    properties: {
      llm: {
        type: "object",
        properties: {
          ollamaUrl: { type: "string" },
          anthropicApiKey: { type: "string", "x-ui": { widget: "password" } },
        },
      },
    },
  };

  test("중첩 password 변경 안 함 = 상위 partial 비어 있음", () => {
    const original = {
      llm: { ollamaUrl: "http://127.0.0.1:11434", anthropicApiKey: null },
    };
    const current = {
      llm: { ollamaUrl: "http://127.0.0.1:11434", anthropicApiKey: null },
    };
    const partial = collectChangedFields(original, current, schema);
    expect(partial).toEqual({});
  });

  test("중첩 password 변경 = 상위에 *해당 필드만* 포함", () => {
    const original = {
      llm: { ollamaUrl: "http://127.0.0.1:11434", anthropicApiKey: null },
    };
    const current = {
      llm: { ollamaUrl: "http://127.0.0.1:11434", anthropicApiKey: "sk-new" },
    };
    const partial = collectChangedFields(original, current, schema);
    expect(partial).toEqual({ llm: { anthropicApiKey: "sk-new" } });
  });

  test("중첩 비-password 변경 + password sentinel 그대로 = password 생략", () => {
    const original = {
      llm: { ollamaUrl: "http://127.0.0.1:11434", anthropicApiKey: null },
    };
    const current = {
      llm: { ollamaUrl: "http://127.0.0.1:11435", anthropicApiKey: null },
    };
    const partial = collectChangedFields(original, current, schema);
    expect(partial).toEqual({ llm: { ollamaUrl: "http://127.0.0.1:11435" } });
  });
});

describe("collectChangedFields — 배열 안 객체 재귀", () => {
  const schema: FieldSchema = {
    type: "object",
    properties: {
      adapters: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            token: { type: "string", "x-ui": { widget: "password" } },
          },
        },
      },
    },
  };

  test("배열 안 객체의 password sentinel 그대로 = 전체 변경 없음", () => {
    const original = {
      adapters: [
        { id: "bot-a", token: null },
        { id: "bot-b", token: "••••" },
      ],
    };
    const current = {
      adapters: [
        { id: "bot-a", token: null },
        { id: "bot-b", token: "••••" },
      ],
    };
    const partial = collectChangedFields(original, current, schema);
    expect(partial).toEqual({});
  });

  test("배열 안 password 에 새 값 = 변경된 인덱스만 partial", () => {
    const original = {
      adapters: [
        { id: "bot-a", token: null },
        { id: "bot-b", token: "••••" },
      ],
    };
    const current = {
      adapters: [
        { id: "bot-a", token: null },
        { id: "bot-b", token: "new-token-b" },
      ],
    };
    const partial = collectChangedFields(original, current, schema);
    expect(partial).toEqual({
      adapters: [{ id: "bot-a", token: null }, { token: "new-token-b" }],
    });
  });
});
