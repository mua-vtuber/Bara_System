import "../../../../test-setup-dom";
import { describe, test, expect } from "bun:test";
import { renderTextWidget } from "./text";
import { renderNumberWidget } from "./number";
import { renderBooleanWidget } from "./boolean";
import { renderEnumWidget } from "./enum";
import { renderArrayWidget } from "./array";
import { renderObjectWidget } from "./object";
import type { WidgetContext } from "./widget";

function makeCtx(partial: Partial<WidgetContext>): WidgetContext {
  return {
    key: partial.key ?? "field",
    path: partial.path ?? "field",
    schema: partial.schema ?? { type: "string" },
    value: partial.value,
    onChange: partial.onChange ?? (() => {}),
    required: partial.required,
  };
}

describe("renderTextWidget", () => {
  test("type=text + value 반영 + 라벨 표시", () => {
    const el = renderTextWidget(
      makeCtx({
        schema: { type: "string", title: "이름" },
        value: "안녕",
      }),
    );
    expect(el.dataset.widget).toBe("text");
    const input = el.querySelector("input") as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(input.value).toBe("안녕");
    expect(el.querySelector(".form-label")?.textContent).toContain("이름");
  });

  test("required = label 별 + input.required + ' *' 표시", () => {
    const el = renderTextWidget(
      makeCtx({
        schema: { type: "string", title: "이름" },
        value: "",
        required: true,
      }),
    );
    const input = el.querySelector("input") as HTMLInputElement;
    expect(input.required).toBe(true);
    expect(el.querySelector(".form-required")?.textContent).toBe(" *");
  });

  test("x-ui.widget=textarea = textarea 렌더링", () => {
    const el = renderTextWidget(
      makeCtx({
        schema: { type: "string", "x-ui": { widget: "textarea" } },
        value: "여러\n줄",
      }),
    );
    expect(el.dataset.widget).toBe("textarea");
    const ta = el.querySelector("textarea") as HTMLTextAreaElement;
    expect(ta).not.toBeNull();
    expect(ta.value).toBe("여러\n줄");
  });

  // password 위젯 테스트는 별도 모듈 (widgets/password.test.ts) 에서 커버 — S6 (5.5.3)
  // 마스킹 약속이 본 위젯과 무관하기 때문.

  test("input change = onChange 호출", () => {
    const captured: { path?: string; value?: unknown } = {};
    const el = renderTextWidget(
      makeCtx({
        path: "user.name",
        value: "",
        onChange: (path, value) => {
          captured.path = path;
          captured.value = value;
        },
      }),
    );
    const input = el.querySelector("input") as HTMLInputElement;
    input.value = "안녕";
    input.dispatchEvent(new Event("input"));
    expect(captured.path).toBe("user.name");
    expect(captured.value).toBe("안녕");
  });

  test("description = 기본 숨김", () => {
    const el = renderTextWidget(
      makeCtx({
        schema: { type: "string", description: "본인 이름" },
      }),
    );
    expect(el.querySelector(".form-description")).toBeNull();
  });

  test("x-ui.showDescription = true 일 때만 도움말 표시", () => {
    const el = renderTextWidget(
      makeCtx({
        schema: {
          type: "string",
          description: "모델 변경 시 빈 DB 필요",
          "x-ui": { showDescription: true },
        },
      }),
    );
    expect(el.querySelector(".form-description")?.textContent).toBe(
      "모델 변경 시 빈 DB 필요",
    );
  });

  test("pattern + min/max length 반영", () => {
    const el = renderTextWidget(
      makeCtx({
        schema: {
          type: "string",
          pattern: "^[a-z]+$",
          minLength: 2,
          maxLength: 8,
        },
      }),
    );
    const input = el.querySelector("input") as HTMLInputElement;
    expect(input.pattern).toBe("^[a-z]+$");
    expect(input.minLength).toBe(2);
    expect(input.maxLength).toBe(8);
  });
});

describe("renderNumberWidget", () => {
  test("type=number + value 반영 + min/max/step (integer)", () => {
    const el = renderNumberWidget(
      makeCtx({
        schema: {
          type: "integer",
          minimum: 0,
          maximum: 100,
          title: "비율",
        },
        value: 42,
      }),
    );
    const input = el.querySelector("input") as HTMLInputElement;
    expect(input.type).toBe("number");
    expect(input.value).toBe("42");
    expect(input.min).toBe("0");
    expect(input.max).toBe("100");
    expect(input.step).toBe("1");
  });

  test("input change = number 변환", () => {
    let captured: unknown = null;
    const el = renderNumberWidget(
      makeCtx({
        schema: { type: "number" },
        value: 0,
        onChange: (_p, v) => {
          captured = v;
        },
      }),
    );
    const input = el.querySelector("input") as HTMLInputElement;
    input.value = "3.14";
    input.dispatchEvent(new Event("input"));
    expect(captured).toBe(3.14);
  });

  test("빈 입력 = undefined emit", () => {
    let captured: unknown = "init";
    const el = renderNumberWidget(
      makeCtx({
        schema: { type: "number" },
        value: 1,
        onChange: (_p, v) => {
          captured = v;
        },
      }),
    );
    const input = el.querySelector("input") as HTMLInputElement;
    input.value = "";
    input.dispatchEvent(new Event("input"));
    expect(captured).toBeUndefined();
  });
});

describe("renderBooleanWidget", () => {
  test("checkbox + 디폴트 false + change 동작", () => {
    let captured: unknown = null;
    const el = renderBooleanWidget(
      makeCtx({
        schema: { type: "boolean", title: "활성" },
        value: false,
        onChange: (_p, v) => {
          captured = v;
        },
      }),
    );
    expect(el.dataset.widget).toBe("boolean");
    const input = el.querySelector("input") as HTMLInputElement;
    expect(input.type).toBe("checkbox");
    expect(input.checked).toBe(false);
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    expect(captured).toBe(true);
  });

  test("value=true = checked", () => {
    const el = renderBooleanWidget(
      makeCtx({ schema: { type: "boolean" }, value: true }),
    );
    const input = el.querySelector("input") as HTMLInputElement;
    expect(input.checked).toBe(true);
  });
});

describe("renderEnumWidget", () => {
  test("드롭다운 + enum 옵션 노출 + 선택 반영", () => {
    const el = renderEnumWidget(
      makeCtx({
        schema: {
          type: "string",
          enum: ["compact", "full"],
          title: "보기 방식",
        },
        value: "compact",
        required: true,
      }),
    );
    expect(el.dataset.widget).toBe("enum");
    const select = el.querySelector("select") as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option"));
    expect(options.map((o) => o.value)).toEqual(["compact", "full"]);
    expect(select.value).toBe("compact");
  });

  test("enumLabels = 한글 라벨", () => {
    const el = renderEnumWidget(
      makeCtx({
        schema: {
          type: "string",
          enum: ["a", "b"],
          "x-ui": { enumLabels: { a: "에이", b: "비" } },
        },
        value: "a",
        required: true,
      }),
    );
    const options = Array.from(el.querySelectorAll("option"));
    expect(options.map((o) => o.textContent)).toEqual(["에이", "비"]);
  });

  test("required=false = '— 선택 —' 빈 옵션 추가", () => {
    const el = renderEnumWidget(
      makeCtx({
        schema: { type: "string", enum: ["a"] },
        required: false,
      }),
    );
    const firstOpt = el.querySelector("option") as HTMLOptionElement;
    expect(firstOpt.value).toBe("");
    expect(firstOpt.textContent).toBe("— 선택 —");
  });

  test("change = onChange + 원래 type 보존", () => {
    let captured: unknown = null;
    const el = renderEnumWidget(
      makeCtx({
        schema: { type: "number", enum: [1, 2, 3] },
        required: true,
        onChange: (_p, v) => {
          captured = v;
        },
      }),
    );
    const select = el.querySelector("select") as HTMLSelectElement;
    select.value = "2";
    select.dispatchEvent(new Event("change"));
    expect(captured).toBe(2);
  });
});

describe("renderArrayWidget", () => {
  test("초기 배열 = 각 원소마다 행 렌더링", () => {
    const el = renderArrayWidget(
      makeCtx({
        schema: { type: "array", items: { type: "string" } },
        value: ["a", "b"],
      }),
    );
    expect(el.dataset.widget).toBe("array");
    const inputs = el.querySelectorAll("input");
    expect(inputs.length).toBe(2);
    expect((inputs[0] as HTMLInputElement).value).toBe("a");
  });

  test("추가 버튼 = 새 행 + onChange 호출", () => {
    let captured: unknown[] = [];
    const el = renderArrayWidget(
      makeCtx({
        schema: { type: "array", items: { type: "string" } },
        value: [],
        onChange: (_p, v) => {
          captured = v as unknown[];
        },
      }),
    );
    const addBtn = el.querySelector(".form-array-add") as HTMLButtonElement;
    addBtn.click();
    expect(captured).toEqual([""]);
    expect(el.querySelectorAll(".form-array-row").length).toBe(1);
  });

  test("삭제 버튼 = 행 제거 + 인덱스 재정렬", () => {
    let captured: unknown[] = [];
    const el = renderArrayWidget(
      makeCtx({
        schema: { type: "array", items: { type: "string" } },
        value: ["a", "b", "c"],
        onChange: (_p, v) => {
          captured = v as unknown[];
        },
      }),
    );
    const rows = el.querySelectorAll(".form-array-row");
    const removeBtn = rows[1]!.querySelector(
      ".form-array-remove",
    ) as HTMLButtonElement;
    removeBtn.click();
    expect(captured).toEqual(["a", "c"]);
    expect(el.querySelectorAll(".form-array-row").length).toBe(2);
  });

  test("items.type=number = 행마다 숫자 입력 + 변환", () => {
    let captured: unknown[] = [];
    const el = renderArrayWidget(
      makeCtx({
        schema: { type: "array", items: { type: "number" } },
        value: [1, 2],
        onChange: (_p, v) => {
          captured = v as unknown[];
        },
      }),
    );
    const inputs = el.querySelectorAll("input");
    const first = inputs[0] as HTMLInputElement;
    expect(first.type).toBe("number");
    first.value = "5";
    first.dispatchEvent(new Event("input"));
    expect(captured).toEqual([5, 2]);
  });
});

describe("renderObjectWidget", () => {
  test("details 요소 + 자식 렌더링 콜백 호출", () => {
    let calledWith: HTMLElement | null = null;
    const el = renderObjectWidget(
      makeCtx({
        schema: {
          type: "object",
          title: "evolver",
          properties: { enabled: { type: "boolean" } },
        },
        value: {},
      }),
      {
        renderChildren: (parent) => {
          calledWith = parent;
          const stub = document.createElement("p");
          stub.textContent = "child";
          parent.appendChild(stub);
        },
      },
    );
    expect(el.dataset.widget).toBe("object");
    const details = el.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(calledWith).not.toBeNull();
    expect(el.querySelector(".form-object-children p")?.textContent).toBe(
      "child",
    );
  });

  test("openByDefault=false = details.open false", () => {
    const el = renderObjectWidget(
      makeCtx({ schema: { type: "object" }, value: {} }),
      { renderChildren: () => {}, openByDefault: false },
    );
    const details = el.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
  });
});
