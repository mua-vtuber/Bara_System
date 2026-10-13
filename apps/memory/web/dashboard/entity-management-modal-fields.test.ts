/**
 * entity-management-modal-fields.test.ts — 모달 공통 부품 순수 DOM 검증 (엔티티 관리 통합 S7a).
 *
 * 검증 정신 — fetch mock 0·Mock 객체 0:
 *   createModalShell·createChipEditor·createTextInputRow 는 *순수 DOM 조립*이다. 콜백 주입으로
 *   입력→추가·✕→삭제를 확인한다(네트워크 없음).
 */

import "../../test-setup-dom";
import { describe, test, expect } from "bun:test";
import {
  createModalShell,
  createChipEditor,
  createTextInputRow,
} from "./entity-management-modal-fields";

/** 엔터 키 이벤트를 input 에 보낸다(칩 추가 트리거). */
function pressKey(input: HTMLInputElement, key: string): void {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("createChipEditor — 로컬 칩 에디터(순수 DOM)", () => {
  test("입력 + 엔터로 칩 추가 → onChange 가 현재 배열을 준다", () => {
    let last: string[] = [];
    const editor = createChipEditor("synonyms", [], (vals) => {
      last = vals;
    });
    const input = editor.wrap.querySelector("[data-chip-input]") as HTMLInputElement;
    input.value = "키보드";
    pressKey(input, "Enter");
    expect(editor.values()).toEqual(["키보드"]);
    expect(last).toEqual(["키보드"]);
    // 칩 DOM 도 생긴다.
    expect(editor.wrap.querySelectorAll("[data-editor-chip]").length).toBe(1);
  });

  test("쉼표로도 칩 추가", () => {
    const editor = createChipEditor("subcategories");
    const input = editor.wrap.querySelector("[data-chip-input]") as HTMLInputElement;
    input.value = "입력장치";
    pressKey(input, ",");
    expect(editor.values()).toEqual(["입력장치"]);
  });

  test("칩 ✕ 클릭 → 그 칩만 제거 + onChange", () => {
    let last: string[] = [];
    const editor = createChipEditor("attributes", ["무선", "유선"], (vals) => {
      last = vals;
    });
    expect(editor.values()).toEqual(["무선", "유선"]);
    const removeBtns = editor.wrap.querySelectorAll("[data-chip-remove]");
    (removeBtns[0] as HTMLButtonElement).click();
    expect(editor.values()).toEqual(["유선"]);
    expect(last).toEqual(["유선"]);
  });

  test("빈/공백·중복(소문자 비교)은 칩으로 안 만든다", () => {
    const editor = createChipEditor("synonyms");
    const input = editor.wrap.querySelector("[data-chip-input]") as HTMLInputElement;
    for (const v of [" ", "Manga", "manga", "MANGA"]) {
      input.value = v;
      pressKey(input, "Enter");
    }
    expect(editor.values()).toEqual(["Manga"]);
  });
});

describe("createModalShell — 모달 셸(순수 DOM)", () => {
  test("제목·닫기 ✕·에러 줄을 그린다", () => {
    const shell = createModalShell("새 종류 추가", () => {});
    expect(shell.overlay.querySelector(".entity-mgmt-modal-title")!.textContent).toBe(
      "새 종류 추가",
    );
    expect(shell.overlay.querySelector("[data-modal-close]")).not.toBeNull();
    expect(shell.overlay.querySelector("[data-modal-error]")).not.toBeNull();
  });

  test("닫기 ✕ 클릭 → onClose 호출", () => {
    let closed = false;
    const shell = createModalShell("x", () => {
      closed = true;
    });
    (shell.overlay.querySelector("[data-modal-close]") as HTMLButtonElement).click();
    expect(closed).toBe(true);
  });

  test("setError/clearError 가 .modal-error 를 채우고 비운다", () => {
    const shell = createModalShell("x", () => {});
    const errLine = shell.overlay.querySelector("[data-modal-error]") as HTMLElement;
    shell.setError("코드 10종 충돌");
    expect(errLine.textContent).toBe("코드 10종 충돌");
    shell.clearError();
    expect(errLine.textContent).toBe("");
  });

  test("close() 가 오버레이를 DOM 에서 뗀다", () => {
    const shell = createModalShell("x", () => {});
    document.body.appendChild(shell.overlay);
    expect(shell.overlay.parentElement).not.toBeNull();
    shell.close();
    expect(shell.overlay.parentElement).toBeNull();
  });
});

describe("createTextInputRow — 텍스트 입력 행(순수 DOM)", () => {
  test("onInput 이 현재 값을 매 입력마다 준다(접두사 추천 통로)", () => {
    const seen: string[] = [];
    const rowEl = createTextInputRow("영문키", "typeName", (v) => seen.push(v));
    rowEl.input.value = "eq";
    rowEl.input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(seen).toEqual(["eq"]);
    expect(rowEl.value()).toBe("eq");
  });
});
