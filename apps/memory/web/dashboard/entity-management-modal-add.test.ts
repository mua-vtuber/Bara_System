/**
 * entity-management-modal-add.test.ts — 새 종류 추가 모달 DOM 검증 (엔티티 관리 통합 S7a).
 *
 * 검증 정신 — fetch mock 0·Mock 객체 0:
 *   openAddModal 은 onSave 오케스트레이터(plain 함수)·onReload 를 주입받는다. fetch 는 안
 *   부른다 — 저장 클릭이 주입한 onSave 를 모은 입력으로 부르는지, 부분 실패가 모달을 안
 *   닫는지, 형식 빈값이 저장 직전 막히는지를 확인한다(데이터·콜백 fixture).
 *
 * 핵심 갈래:
 *   - 필드 존재(표시명·영문키·접두사·칩 에디터 3칸). 관계 칸 부재.
 *   - 접두사 자동 추천 + prefixTouched 정지.
 *   - 저장 클릭 → onSave 가 모은 입력으로 호출.
 *   - 빈값·형식은 onSave 부르기 전 .modal-error 로 막힌다.
 *   - 부분 실패(allOk=false) → 모달 안 닫힘·실패 칩 안내.
 *   - 전부 성공(allOk) → 모달 닫힘.
 */

import "../../test-setup-dom";
import { describe, test, expect } from "bun:test";
import { openAddModal, type AddModalInput } from "./entity-management-modal-add";
import type { AddResultSummary } from "./entity-management-save";

function freshHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

function pressKey(input: HTMLInputElement, key: string): void {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

const allOkSummary: AddResultSummary = {
  typeCreated: true,
  failures: [],
  succeeded: [],
  allOk: true,
};

describe("openAddModal — 추가 모달 DOM", () => {
  test("필드가 다 있다(표시명·영문키·접두사·칩 3칸) + 관계 입력 칸은 없다", () => {
    const host = freshHost();
    const overlay = openAddModal(
      { onSave: async () => allOkSummary, onReload: () => {} },
      host,
    );
    expect(overlay.querySelector('[data-field="koName"]')).not.toBeNull();
    expect(overlay.querySelector('[data-field="typeName"]')).not.toBeNull();
    expect(overlay.querySelector('[data-field="idPrefix"]')).not.toBeNull();
    expect(overlay.querySelector('[data-chip-editor="synonyms"]')).not.toBeNull();
    expect(overlay.querySelector('[data-chip-editor="subcategories"]')).not.toBeNull();
    expect(overlay.querySelector('[data-chip-editor="attributes"]')).not.toBeNull();
    // 칸 로컬 에디터(S8) — 칸 이름 입력·라디오 2개(기본 글자형)·추가 버튼이 있다(안내만 아님).
    const colSection = overlay.querySelector("[data-section='entity-mgmt-add-columns']");
    expect(colSection).not.toBeNull();
    expect(colSection!.querySelector("[data-column-key-input]")).not.toBeNull();
    expect(colSection!.querySelector('[data-column-type="text"]')).not.toBeNull();
    expect(colSection!.querySelector('[data-column-type="number"]')).not.toBeNull();
    // 관계 입력 칸은 S7b 몫 — 가짜 입력 0(안내 문구만).
    expect(overlay.querySelector('[data-chip-editor="relation"]')).toBeNull();
    expect(overlay.querySelector('[data-field="relation"]')).toBeNull();
  });

  test("칸 섹션이 라벨 칩 에디터보다 DOM 앞에 그려진다(중요도 순·수정 모달 정합)", () => {
    const host = freshHost();
    const overlay = openAddModal(
      { onSave: async () => allOkSummary, onReload: () => {} },
      host,
    );
    const colSection = overlay.querySelector("[data-section='entity-mgmt-add-columns']")!;
    const attrEditor = overlay.querySelector('[data-chip-editor="attributes"]')!;
    // 칸 섹션이 라벨 에디터보다 문서상 앞(DOCUMENT_POSITION_FOLLOWING = 라벨이 칸 뒤).
    const pos = colSection.compareDocumentPosition(attrEditor);
    expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("영문키 입력 → 접두사 자동 추천, 접두사 직접 수정 후엔 추천 정지", () => {
    const host = freshHost();
    const overlay = openAddModal(
      { onSave: async () => allOkSummary, onReload: () => {} },
      host,
    );
    const keyInput = overlay.querySelector('[data-field="typeName"]') as HTMLInputElement;
    const prefixInput = overlay.querySelector('[data-field="idPrefix"]') as HTMLInputElement;
    keyInput.value = "equipment";
    keyInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(prefixInput.value).toBe("equ_");
    // 사용자가 접두사를 직접 건드리면 추천 정지.
    prefixInput.value = "myprefix_";
    prefixInput.dispatchEvent(new Event("input", { bubbles: true }));
    keyInput.value = "vehicle";
    keyInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(prefixInput.value).toBe("myprefix_");
  });

  test("저장 클릭 → onSave 가 모은 입력(필드 + 칩)으로 호출된다", async () => {
    const host = freshHost();
    let received: AddModalInput | null = null;
    const overlay = openAddModal(
      {
        onSave: async (input) => {
          received = input;
          return allOkSummary;
        },
        onReload: () => {},
      },
      host,
    );
    (overlay.querySelector('[data-field="koName"]') as HTMLInputElement).value = "장비";
    (overlay.querySelector('[data-field="typeName"]') as HTMLInputElement).value = "equipment";
    const synInput = overlay.querySelector('[data-chip-input="synonyms"]') as HTMLInputElement;
    synInput.value = "키보드";
    pressKey(synInput, "Enter");

    // 칸 로컬 에디터에 글자형 칸 '메모' + 숫자형 칸 '무게'를 더한다(저장 전 로컬·POST 0).
    const colSection = overlay.querySelector("[data-section='entity-mgmt-add-columns']")!;
    const colInput = colSection.querySelector("[data-column-key-input]") as HTMLInputElement;
    const colForm = colSection.querySelector(".entity-mgmt-column-add") as HTMLFormElement;
    colInput.value = "메모"; // 기본 글자형.
    colForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    colInput.value = "무게";
    (colSection.querySelector('[data-column-type="number"]') as HTMLInputElement).checked = true;
    colForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    (overlay.querySelector("[data-modal-save]") as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(received).not.toBeNull();
    expect(received!.koName).toBe("장비");
    expect(received!.typeName).toBe("equipment");
    expect(received!.chips.synonyms).toEqual(["키보드"]);
    // 칸도 onSave 입력에 로컬로 모여 전달된다(이름 + 타입).
    expect(received!.columns).toEqual([
      { key: "메모", dataType: "text" },
      { key: "무게", dataType: "number" },
    ]);
  });

  test("빈값·형식은 저장 직전 막힌다 — onSave 안 부르고 .modal-error 노출", async () => {
    const host = freshHost();
    let called = false;
    const overlay = openAddModal(
      {
        onSave: async () => {
          called = true;
          return allOkSummary;
        },
        onReload: () => {},
      },
      host,
    );
    // 영문키를 대문자로(형식 불일치).
    (overlay.querySelector('[data-field="koName"]') as HTMLInputElement).value = "장비";
    (overlay.querySelector('[data-field="typeName"]') as HTMLInputElement).value = "Equipment";
    (overlay.querySelector("[data-modal-save]") as HTMLButtonElement).click();
    await Promise.resolve();
    expect(called).toBe(false);
    const err = overlay.querySelector("[data-modal-error]") as HTMLElement;
    expect(err.textContent).toContain("영문 소문자");
  });

  test("부분 실패(allOk=false) → 모달 안 닫힘 + 실패 칩 안내", async () => {
    const host = freshHost();
    const overlay = openAddModal(
      {
        onSave: async () => ({
          typeCreated: true,
          failures: [{ slot: "synonyms", value: "소설", message: "동의어와 중복" }],
          succeeded: [],
          allOk: false,
        }),
        onReload: () => {},
      },
      host,
    );
    (overlay.querySelector('[data-field="koName"]') as HTMLInputElement).value = "작품2";
    (overlay.querySelector('[data-field="typeName"]') as HTMLInputElement).value = "work2";
    (overlay.querySelector("[data-modal-save]") as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // 모달은 그대로 떠 있다(닫히지 않음).
    expect(overlay.parentElement).not.toBeNull();
    const failLines = overlay.querySelectorAll("[data-fail-line]");
    expect(failLines.length).toBe(1);
    expect(failLines[0]!.textContent).toContain("소설");
    expect(failLines[0]!.textContent).toContain("동의어와 중복");
  });

  test("종류 생성 throw(코드 10종 충돌) → .modal-error 에 라우트 메시지 그대로", async () => {
    const host = freshHost();
    const overlay = openAddModal(
      {
        onSave: async () => {
          throw new Error("addEntityType: 'person' 은 코드 상수 10종이라 새 종류로 더할 수 없다");
        },
        onReload: () => {},
      },
      host,
    );
    (overlay.querySelector('[data-field="koName"]') as HTMLInputElement).value = "사람2";
    (overlay.querySelector('[data-field="typeName"]') as HTMLInputElement).value = "person";
    (overlay.querySelector("[data-modal-save]") as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    const err = overlay.querySelector("[data-modal-error]") as HTMLElement;
    expect(err.textContent).toContain("코드 상수 10종");
    expect(overlay.parentElement).not.toBeNull();
  });

  test("전부 성공(allOk) → onReload 후 모달 닫힘", async () => {
    const host = freshHost();
    let reloaded = false;
    const overlay = openAddModal(
      {
        onSave: async () => allOkSummary,
        onReload: () => {
          reloaded = true;
        },
      },
      host,
    );
    (overlay.querySelector('[data-field="koName"]') as HTMLInputElement).value = "장비";
    (overlay.querySelector('[data-field="typeName"]') as HTMLInputElement).value = "equipment";
    (overlay.querySelector("[data-modal-save]") as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(reloaded).toBe(true);
    expect(overlay.parentElement).toBeNull();
  });
});

describe("openAddModal — 칸 로컬 에디터(S8·추가 모달 칸 단계)", () => {
  function openWithColumns(): HTMLElement {
    const host = freshHost();
    return openAddModal(
      { onSave: async () => allOkSummary, onReload: () => {} },
      host,
    );
  }

  test("칸 추가(글자형 기본) → 로컬 칩 + [글자] 배지", () => {
    const overlay = openWithColumns();
    const sec = overlay.querySelector("[data-section='entity-mgmt-add-columns']")!;
    const input = sec.querySelector("[data-column-key-input]") as HTMLInputElement;
    const form = sec.querySelector(".entity-mgmt-column-add") as HTMLFormElement;
    input.value = "메모";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const chip = sec.querySelector("[data-column-chip]")!;
    expect(chip.textContent).toContain("메모");
    expect(chip.querySelector('[data-data-type="text"]')).not.toBeNull();
    expect(chip.textContent).toContain("글자");
    // 입력은 추가 후 비워진다(재입력 준비).
    expect(input.value).toBe("");
  });

  test("숫자형 라디오 선택 후 추가 → [숫자] 배지", () => {
    const overlay = openWithColumns();
    const sec = overlay.querySelector("[data-section='entity-mgmt-add-columns']")!;
    const input = sec.querySelector("[data-column-key-input]") as HTMLInputElement;
    const form = sec.querySelector(".entity-mgmt-column-add") as HTMLFormElement;
    input.value = "금액";
    (sec.querySelector('[data-column-type="number"]') as HTMLInputElement).checked = true;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const chip = sec.querySelector("[data-column-chip]")!;
    expect(chip.querySelector('[data-data-type="number"]')).not.toBeNull();
    expect(chip.textContent).toContain("숫자");
  });

  test("날짜형 라디오 선택 후 추가 → [날짜] 배지", () => {
    const overlay = openWithColumns();
    const sec = overlay.querySelector("[data-section='entity-mgmt-add-columns']")!;
    const input = sec.querySelector("[data-column-key-input]") as HTMLInputElement;
    const form = sec.querySelector(".entity-mgmt-column-add") as HTMLFormElement;
    input.value = "구입일";
    (sec.querySelector('[data-column-type="date"]') as HTMLInputElement).checked = true;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const chip = sec.querySelector("[data-column-chip]")!;
    expect(chip.querySelector('[data-data-type="date"]')).not.toBeNull();
    expect(chip.textContent).toContain("날짜");
  });

  test("✕ 삭제 → 그 칸 칩이 사라진다(로컬 배열에서 제거)", () => {
    const overlay = openWithColumns();
    const sec = overlay.querySelector("[data-section='entity-mgmt-add-columns']")!;
    const input = sec.querySelector("[data-column-key-input]") as HTMLInputElement;
    const form = sec.querySelector(".entity-mgmt-column-add") as HTMLFormElement;
    input.value = "메모";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(sec.querySelectorAll("[data-column-chip]").length).toBe(1);
    (sec.querySelector("[data-column-remove]") as HTMLButtonElement).click();
    expect(sec.querySelectorAll("[data-column-chip]").length).toBe(0);
  });

  test("같은 칸 키 로컬 중복은 안 만든다(소문자 비교)", () => {
    const overlay = openWithColumns();
    const sec = overlay.querySelector("[data-section='entity-mgmt-add-columns']")!;
    const input = sec.querySelector("[data-column-key-input]") as HTMLInputElement;
    const form = sec.querySelector(".entity-mgmt-column-add") as HTMLFormElement;
    input.value = "금액";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    input.value = "금액"; // 같은 키 다시.
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(sec.querySelectorAll("[data-column-chip]").length).toBe(1);
  });

  test("빈값 추가는 칩으로 안 만든다(약한 가드)", () => {
    const overlay = openWithColumns();
    const sec = overlay.querySelector("[data-section='entity-mgmt-add-columns']")!;
    const input = sec.querySelector("[data-column-key-input]") as HTMLInputElement;
    const form = sec.querySelector(".entity-mgmt-column-add") as HTMLFormElement;
    input.value = "   ";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(sec.querySelectorAll("[data-column-chip]").length).toBe(0);
  });
});
