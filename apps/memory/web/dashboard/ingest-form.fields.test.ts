/**
 * ingest-form 동적 칸 DOM 헬퍼 단위 테스트 (그래프 입력검색 보강 S1).
 *
 * 검증 정신 — mock 0:
 *   entity-fields-widget.js 의 두 DOM 헬퍼(collectDynamicFields·renderEntityFields)를
 *   happy-dom 전역 위에서 fixture 데이터로 검증한다. 이 둘은 공용 picker
 *   (entity-type-field-picker.ts)의 getFields·renderFields 와 *같은 계약*을 따르게 한
 *   정의다 — 입력 폼(ingest-form.js)과 검색 모달이 칸을 같은 규칙으로 읽고 그린다
 *   (중복 0·결정 6). fetch / FileReader / mountIngestForm 부수효과는 여기서 안 건드린다
 *   (라이브 수동 확인이 맡는다).
 *
 * 검증 갈래:
 *   1) collectDynamicFields — [data-field-key] input 에서 값 있는 칸만 {칸키:값}, 공백·빈 칸 생략.
 *   2) renderEntityFields — columns 를 label+input 으로 그리고 number/date 타입을 input 속성으로 반영.
 */

import "../../test-setup-dom";
import { test, expect, describe } from "bun:test";
import { collectDynamicFields, renderEntityFields } from "./entity-fields-widget.js";
import { isValidNumericInput } from "./ingest-form.js";

describe("collectDynamicFields — 동적 칸 읽기(picker.getFields 와 같은 계약)", () => {
  test("값 있는 칸만 {칸키:값}, 공백·빈 칸은 생략", () => {
    const fieldsEl = document.createElement("div");
    const a = document.createElement("input");
    a.dataset.fieldKey = "항목";
    a.value = "우유";
    const b = document.createElement("input");
    b.dataset.fieldKey = "메모";
    b.value = "  "; // 공백 → 생략
    const c = document.createElement("input");
    c.dataset.fieldKey = "금액";
    c.value = "3000";
    fieldsEl.append(a, b, c);
    expect(collectDynamicFields(fieldsEl)).toEqual({ 항목: "우유", 금액: "3000" });
  });

  test("data-field-key 없는 input 은 무시", () => {
    const fieldsEl = document.createElement("div");
    const plain = document.createElement("input");
    plain.value = "무시됨";
    fieldsEl.append(plain);
    expect(collectDynamicFields(fieldsEl)).toEqual({});
  });

  test("null·비DOM 입력은 빈 객체(방어)", () => {
    expect(collectDynamicFields(null)).toEqual({});
  });
});

describe("renderEntityFields — 동적 칸 렌더(picker.renderFields 와 같은 규칙)", () => {
  test("columns 를 label+input 으로 그리고 fieldKey 를 dataset 에 단다", () => {
    const fieldsEl = document.createElement("div");
    renderEntityFields(fieldsEl, [
      { key: "항목", label: "항목" },
      { key: "금액", label: "금액", dataType: "number" },
    ]);
    const inputs = fieldsEl.querySelectorAll<HTMLInputElement>("[data-field-key]");
    expect(inputs.length).toBe(2);
    expect(inputs[0]!.dataset.fieldKey).toBe("항목");
    expect(inputs[1]!.dataset.fieldKey).toBe("금액");
    // 숫자형 칸만 numeric 표지·inputmode 가 붙는다.
    expect(inputs[0]!.dataset.numeric).toBeUndefined();
    expect(inputs[1]!.dataset.numeric).toBe("1");
    expect(inputs[1]!.getAttribute("inputmode")).toBe("decimal");
  });

  test("label 은 textContent 로 그린다(XSS 안전)", () => {
    const fieldsEl = document.createElement("div");
    renderEntityFields(fieldsEl, [{ key: "메모", label: "<b>주의</b>" }]);
    const span = fieldsEl.querySelector(".ingest-field-label");
    // textContent 로 넣으므로 태그가 해석되지 않고 글자 그대로 남는다.
    expect(span!.textContent).toBe("<b>주의</b>");
    expect(span!.querySelector("b")).toBeNull();
  });

  test("재호출 시 기존 칸을 비우고 다시 그린다(replaceChildren)", () => {
    const fieldsEl = document.createElement("div");
    renderEntityFields(fieldsEl, [{ key: "항목", label: "항목" }]);
    renderEntityFields(fieldsEl, [{ key: "제목", label: "제목" }]);
    const inputs = fieldsEl.querySelectorAll<HTMLInputElement>("[data-field-key]");
    expect(inputs.length).toBe(1);
    expect(inputs[0]!.dataset.fieldKey).toBe("제목");
  });

  test("비배열 columns 는 빈 렌더(방어)", () => {
    const fieldsEl = document.createElement("div");
    // @ts-expect-error 비배열 방어 경로 검증
    renderEntityFields(fieldsEl, undefined);
    expect(fieldsEl.querySelectorAll("[data-field-key]").length).toBe(0);
  });

  test("숫자형 칸 input — isValidNumericInput 비숫자 차단(되돌리기)", () => {
    const fieldsEl = document.createElement("div");
    renderEntityFields(fieldsEl, [{ key: "금액", label: "금액", dataType: "number" }]);
    const input = fieldsEl.querySelector<HTMLInputElement>('[data-field-key="금액"]')!;
    // 숫자는 통과해 마지막 유효값으로 남는다.
    input.value = "3000";
    input.dispatchEvent(new Event("input"));
    expect(input.value).toBe("3000");
    // 비숫자(한글)는 직전 유효값으로 되돌린다.
    input.value = "삼천원";
    input.dispatchEvent(new Event("input"));
    expect(input.value).toBe("3000");
    // 같은 규칙을 isValidNumericInput 한 정의가 판단한다(picker 와 공유).
    expect(isValidNumericInput("3000")).toBe(true);
    expect(isValidNumericInput("삼천원")).toBe(false);
  });

  test("날짜형 칸 input — input type=date 로 그린다", () => {
    const fieldsEl = document.createElement("div");
    renderEntityFields(fieldsEl, [{ key: "구입일", label: "구입일", dataType: "date" }]);
    const input = fieldsEl.querySelector<HTMLInputElement>('[data-field-key="구입일"]')!;
    expect(input.type).toBe("date");
    expect(input.dataset.date).toBe("1");
    expect(input.dataset.numeric).toBeUndefined();
  });
});
