import "../../../../test-setup-dom";
import { describe, test, expect } from "bun:test";
import { renderPasswordWidget, isMaskedValue } from "./password";
import type { WidgetContext } from "./widget";

function makeCtx(partial: Partial<WidgetContext>): WidgetContext {
  return {
    key: partial.key ?? "discordToken",
    path: partial.path ?? "discordToken",
    schema: partial.schema ?? { type: "string", "x-ui": { widget: "password" } },
    value: partial.value,
    onChange: partial.onChange ?? (() => {}),
    required: partial.required,
  };
}

describe("isMaskedValue", () => {
  test("null = sentinel", () => {
    expect(isMaskedValue(null)).toBe(true);
  });

  test("'••••' = sentinel", () => {
    expect(isMaskedValue("••••")).toBe(true);
  });

  test("'••••••••' = sentinel (다양 길이)", () => {
    expect(isMaskedValue("••••••••")).toBe(true);
  });

  test("일반 string = sentinel X", () => {
    expect(isMaskedValue("secret123")).toBe(false);
  });

  test("빈 string = sentinel X (placeholder 패턴 분리)", () => {
    expect(isMaskedValue("")).toBe(false);
  });

  test("undefined = sentinel X (값 미존재)", () => {
    expect(isMaskedValue(undefined)).toBe(false);
  });
});

describe("renderPasswordWidget", () => {
  test("type=password + 라벨 + path dataset", () => {
    const el = renderPasswordWidget(
      makeCtx({
        schema: {
          type: "string",
          title: "디스코드 토큰",
          "x-ui": { widget: "password" },
        },
        value: "actual-secret",
      }),
    );
    expect(el.dataset.widget).toBe("password");
    expect(el.dataset.path).toBe("discordToken");
    const input = el.querySelector("input") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("actual-secret");
    expect(el.querySelector(".form-label")?.textContent).toContain("디스코드 토큰");
  });

  test("$masked sentinel (null) = 빈 input + placeholder '현 값 유지'", () => {
    const el = renderPasswordWidget(makeCtx({ value: null }));
    const input = el.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("현 값 유지");
    expect(el.dataset.masked).toBe("true");
  });

  test("'••••' sentinel = 빈 input + placeholder", () => {
    const el = renderPasswordWidget(makeCtx({ value: "••••" }));
    const input = el.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("현 값 유지");
    expect(el.dataset.masked).toBe("true");
  });

  test("입력 = onChange 호출 + masked dataset 해제", () => {
    const captured: { path?: string; value?: unknown } = {};
    const el = renderPasswordWidget(
      makeCtx({
        path: "secrets.discordToken",
        value: null,
        onChange: (p, v) => {
          captured.path = p;
          captured.value = v;
        },
      }),
    );
    expect(el.dataset.masked).toBe("true");
    const input = el.querySelector("input") as HTMLInputElement;
    input.value = "new-secret";
    input.dispatchEvent(new Event("input"));
    expect(captured.path).toBe("secrets.discordToken");
    expect(captured.value).toBe("new-secret");
    expect(el.dataset.masked).toBe("false");
  });

  test("description = 기본 숨김", () => {
    const el = renderPasswordWidget(
      makeCtx({
        schema: {
          type: "string",
          description: "Discord Developer Portal 의 봇 토큰",
          "x-ui": { widget: "password" },
        },
      }),
    );
    expect(el.querySelector(".form-description")).toBeNull();
  });

  test("x-ui.showDescription = true 일 때만 도움말 표시", () => {
    const el = renderPasswordWidget(
      makeCtx({
        schema: {
          type: "string",
          description: "새 키를 넣을 때만 바뀐다",
          "x-ui": { widget: "password", showDescription: true },
        },
      }),
    );
    expect(el.querySelector(".form-description")?.textContent).toBe(
      "새 키를 넣을 때만 바뀐다",
    );
  });

  test("pattern + minLength 반영 (sentinel 상태에서는 required 강제 안 함)", () => {
    const el = renderPasswordWidget(
      makeCtx({
        schema: {
          type: "string",
          pattern: "^[A-Za-z0-9._-]+$",
          minLength: 10,
          "x-ui": { widget: "password" },
        },
        value: null,
        required: true,
      }),
    );
    const input = el.querySelector("input") as HTMLInputElement;
    expect(input.pattern).toBe("^[A-Za-z0-9._-]+$");
    expect(input.minLength).toBe(10);
    expect(input.required).toBe(false);
  });
});
