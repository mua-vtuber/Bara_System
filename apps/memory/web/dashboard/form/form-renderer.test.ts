import "../../../test-setup-dom";
import { describe, test, expect } from "bun:test";
import { renderForm } from "./form-renderer";
import type { FieldSchema } from "./widgets/widget";

describe("renderForm — 기본 동작", () => {
  test("스키마의 properties 마다 위젯 한 개씩 렌더링", () => {
    const schema: FieldSchema = {
      type: "object",
      properties: {
        name: { type: "string", title: "이름" },
        age: { type: "integer", title: "나이" },
        active: { type: "boolean", title: "활성" },
      },
    };
    const form = renderForm({
      schema,
      initialValue: { name: "본인", age: 30, active: true },
    });
    const fields = form.element.querySelectorAll(".form-field");
    expect(fields.length).toBe(3);
  });

  test("onChange 호출 = getValue 결과 갱신", () => {
    const schema: FieldSchema = {
      type: "object",
      properties: { name: { type: "string" } },
    };
    const form = renderForm({ schema, initialValue: { name: "" } });
    const input = form.element.querySelector(
      "input[name='name']",
    ) as HTMLInputElement;
    input.value = "안녕";
    input.dispatchEvent(new Event("input"));
    expect(form.getValue()).toEqual({ name: "안녕" });
  });

  test("x-ui.widget=select 는 enum 드롭다운으로 렌더링", () => {
    const schema: FieldSchema = {
      type: "object",
      properties: {
        startPage: {
          type: "string",
          title: "첫 화면",
          enum: ["dashboard", "graph"],
          "x-ui": {
            widget: "select",
            enumLabels: {
              dashboard: "대시보드",
              graph: "그래프",
            },
          },
        },
      },
      required: ["startPage"],
    };
    const form = renderForm({
      schema,
      initialValue: { startPage: "dashboard" },
    });

    const select = form.element.querySelector(
      "select[name='startPage']",
    ) as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "대시보드",
      "그래프",
    ]);

    select.value = "graph";
    select.dispatchEvent(new Event("change"));
    expect(form.getValue()).toEqual({ startPage: "graph" });
  });

  test("중첩 객체 = 재귀 렌더링 + path 점 표기법", () => {
    const schema: FieldSchema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          title: "사용자",
          properties: {
            name: { type: "string", title: "이름" },
          },
        },
      },
    };
    const form = renderForm({
      schema,
      initialValue: { user: { name: "본인" } },
    });
    const input = form.element.querySelector(
      "input[name='user.name']",
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("본인");
    input.value = "다른";
    input.dispatchEvent(new Event("input"));
    expect(form.getValue()).toEqual({ user: { name: "다른" } });
  });

  test("x-ui.widget=inline-object 는 부모 박스만 풀고 하위 path 는 보존한다", () => {
    const schema: FieldSchema = {
      type: "object",
      properties: {
        cleanupDeepPass: {
          type: "object",
          title: "데이터 정리 세부값",
          "x-ui": { widget: "inline-object" },
          properties: {
            summary: {
              type: "object",
              title: "요약·관계 찾기 세부값",
              properties: {
                atomicThreshold: { type: "integer", title: "요약할 청크 기준" },
              },
            },
          },
        },
      },
    };
    const form = renderForm({
      schema,
      initialValue: {
        cleanupDeepPass: { summary: { atomicThreshold: 4 } },
      },
    });

    expect(
      form.element.querySelector('.form-field[data-path="cleanupDeepPass"]'),
    ).toBeNull();
    expect(
      form.element.querySelector('.form-field[data-path="cleanupDeepPass.summary"]'),
    ).not.toBeNull();

    const input = form.element.querySelector(
      'input[name="cleanupDeepPass.summary.atomicThreshold"]',
    ) as HTMLInputElement;
    expect(input.value).toBe("4");
    input.value = "6";
    input.dispatchEvent(new Event("input"));

    expect(form.getValue()).toEqual({
      cleanupDeepPass: { summary: { atomicThreshold: 6 } },
    });
  });

  test("if/then 매칭 = 의존 필드 노출 (재렌더링)", () => {
    const schema: FieldSchema & { if?: FieldSchema; then?: FieldSchema } = {
      type: "object",
      properties: {
        enabled: { type: "boolean", title: "활성" },
      },
      if: {
        properties: { enabled: { const: true } as FieldSchema },
      },
      then: {
        properties: { token: { type: "string", title: "토큰" } },
      },
    };
    const form = renderForm({ schema, initialValue: { enabled: false } });
    expect(form.element.querySelector("input[name='token']")).toBeNull();
    const checkbox = form.element.querySelector(
      "input[name='enabled']",
    ) as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    expect(form.element.querySelector("input[name='token']")).not.toBeNull();
  });

  test("setValue = 외부 값 통째 교체 + 재렌더링", () => {
    const schema: FieldSchema = {
      type: "object",
      properties: { name: { type: "string" } },
    };
    const form = renderForm({ schema, initialValue: { name: "초기" } });
    form.setValue({ name: "외부 갱신" });
    const input = form.element.querySelector(
      "input[name='name']",
    ) as HTMLInputElement;
    expect(input.value).toBe("외부 갱신");
    expect(form.getValue()).toEqual({ name: "외부 갱신" });
  });

  test("validate = 검증 에러 반환 (required)", () => {
    const schema: FieldSchema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    const form = renderForm({ schema, initialValue: { name: "" } });
    const errors = form.validate();
    expect(errors.length).toBe(1);
    expect(errors[0]!.path).toBe("name");
  });

  test("submit 이벤트 = 검증 통과 시 onSubmit 호출", async () => {
    const schema: FieldSchema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    const captured: { value?: Record<string, unknown> } = {};
    const form = renderForm({
      schema,
      initialValue: { name: "OK" },
      onSubmit: (v) => {
        captured.value = v;
      },
    });
    form.element.dispatchEvent(new Event("submit", { cancelable: true }));
    await Promise.resolve();
    expect(captured.value).toEqual({ name: "OK" });
  });

  test("submit 이벤트 = 검증 실패 시 onSubmit X + 에러 표시", async () => {
    const schema: FieldSchema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    let submitted = false;
    const form = renderForm({
      schema,
      initialValue: { name: "" },
      onSubmit: () => {
        submitted = true;
      },
    });
    form.element.dispatchEvent(new Event("submit", { cancelable: true }));
    await Promise.resolve();
    expect(submitted).toBe(false);
    const errorEl = form.element.querySelector(".form-root-errors");
    expect(errorEl?.textContent).toContain("name");
  });
});
