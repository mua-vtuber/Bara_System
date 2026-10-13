/**
 * entity-management-modal-fields.ts — 모달 공통 DOM 부품 (엔티티 관리 통합 S7a).
 *
 * 추가·수정 모달이 함께 쓰는 순수 DOM 부품 — 모달 셸(오버레이·제목·닫기 ✕)·칩 에디터
 * (입력 + 칩 목록 + ✕)·텍스트 입력 행. fetch 를 일절 안 부른다(네트워크는 모달 본체
 * 책임). 순수 검증 함수(suggestIdPrefix·validateTypeName)는 entity-management-save 에서
 * 다시 내보내, 모달 코드가 한 곳에서 가져오게 한다.
 */

import {
  suggestIdPrefix,
  validateTypeName,
  validateAddForm,
  validateColumnKey,
  type LocalColumn,
  type ColumnDataType,
} from "./entity-management-save";

export { suggestIdPrefix, validateTypeName, validateAddForm };

/** 사용자 노출 문구 한 곳 모음 — 흩뿌리지 않는다(중앙화·i18n 대비). */
export const MODAL_LABELS = {
  close: "닫기",
  chipAddHint: "엔터 또는 쉼표로 추가",
  chipRemove: "삭제",
  chipRemoveTitle: "이 항목 빼기",
  // 로컬 칸 에디터(추가 모달 칸 단계·S8).
  columnAddHint: "칸 이름 (예: 금액)",
  columnTypeText: "글자형",
  columnTypeNumber: "숫자형",
  columnTypeDate: "날짜형",
  columnAdd: "추가",
  columnBadgeText: "글자",
  columnBadgeNumber: "숫자",
  columnBadgeDate: "날짜",
  columnRemove: "삭제",
  columnRemoveTitle: "이 칸 빼기",
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 모달 셸 — 오버레이 + 박스 + 제목 + 닫기 ✕ + 내용 host + 에러 줄. */
export interface ModalShell {
  /** document.body 에 붙일 오버레이(닫기 시 통째 제거). */
  overlay: HTMLElement;
  /** 내용을 채울 곳(필드·칩 에디터·버튼을 여기 append). */
  body: HTMLElement;
  /** 에러 메시지 줄(.modal-error) — setError 로 채운다. */
  setError(message: string): void;
  /** 에러 줄을 비운다. */
  clearError(): void;
  /** 오버레이를 DOM 에서 뗀다(저장 성공·닫기 버튼). */
  close(): void;
}

/**
 * 모달 셸 생성(순수 DOM). 오버레이 + 박스 + 제목 + 닫기 ✕ + 내용 host + 에러 줄.
 * 닫기 버튼·오버레이 바깥 클릭은 onClose 콜백을 부른다(네트워크는 호출자 책임).
 */
export function createModalShell(
  title: string,
  onClose: () => void,
): ModalShell {
  const overlay = el("div", "entity-mgmt-modal-overlay");
  overlay.dataset.section = "entity-mgmt-modal";

  const box = el("div", "entity-mgmt-modal-box");
  // 오버레이 바깥(박스 밖) 클릭은 닫기, 박스 안 클릭은 전파 차단.
  overlay.addEventListener("click", () => onClose());
  box.addEventListener("click", (e) => e.stopPropagation());

  const head = el("div", "entity-mgmt-modal-head");
  head.appendChild(el("h3", "entity-mgmt-modal-title", title));
  const closeBtn = el("button", "entity-mgmt-modal-close", "✕");
  closeBtn.type = "button";
  closeBtn.title = MODAL_LABELS.close;
  closeBtn.dataset.modalClose = "true";
  closeBtn.addEventListener("click", () => onClose());
  head.appendChild(closeBtn);
  box.appendChild(head);

  const body = el("div", "entity-mgmt-modal-body");
  box.appendChild(body);

  const errorLine = el("p", "modal-error");
  errorLine.dataset.modalError = "true";
  errorLine.style.display = "none";
  box.appendChild(errorLine);

  overlay.appendChild(box);

  return {
    overlay,
    body,
    setError(message: string): void {
      errorLine.textContent = message;
      errorLine.style.display = "";
    },
    clearError(): void {
      errorLine.textContent = "";
      errorLine.style.display = "none";
    },
    close(): void {
      if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
    },
  };
}

/** 텍스트 입력 행(라벨 + input). value getter 로 현재 값을 읽는다. */
export interface TextInputRow {
  wrap: HTMLElement;
  input: HTMLInputElement;
  value(): string;
}

/** 라벨 + 한 줄 텍스트 입력(순수 DOM). onInput 은 매 입력마다 현재 값을 준다(접두사 추천용). */
export function createTextInputRow(
  labelText: string,
  fieldKey: string,
  onInput?: (value: string) => void,
): TextInputRow {
  const wrap = el("label", "entity-mgmt-field");
  wrap.appendChild(el("span", "entity-mgmt-field-label", labelText));
  const input = el("input", "entity-mgmt-field-input");
  input.type = "text";
  input.dataset.field = fieldKey;
  if (onInput) {
    input.addEventListener("input", () => onInput(input.value));
  }
  wrap.appendChild(input);
  return { wrap, input, value: () => input.value };
}

/**
 * 로컬 칩 에디터 — 입력 + 칩 목록. 입력에 단어를 적고 엔터/쉼표로 칩 추가, 칩 ✕로 제거.
 * 저장 전이라 로컬 배열만 다룬다(아직 종류가 없어 POST 불가). 추가·제거는 onChange 로
 * 현재 칩 배열을 알린다. values() 로 현재 배열을 읽는다(저장 시점).
 */
export interface ChipEditor {
  wrap: HTMLElement;
  values(): string[];
}

/**
 * 칩 에디터 생성(순수 DOM·로컬 배열). onAdd/onRemove 콜백은 테스트가 입력→추가·✕→제거를
 * 확인하는 통로다(네트워크 없음). 같은 값(소문자 비교) 중복·빈값은 칩으로 안 만든다.
 */
export function createChipEditor(
  fieldKey: string,
  initial: string[] = [],
  onChange?: (values: string[]) => void,
): ChipEditor {
  const values: string[] = [];
  const wrap = el("div", "entity-mgmt-chip-editor");
  wrap.dataset.chipEditor = fieldKey;

  const list = el("div", "entity-mgmt-chip-editor-list");
  list.dataset.chipList = "true";

  const input = el("input", "entity-mgmt-chip-editor-input");
  input.type = "text";
  input.dataset.chipInput = fieldKey;
  input.placeholder = MODAL_LABELS.chipAddHint;

  function notify(): void {
    if (onChange) onChange([...values]);
  }

  function removeAt(index: number): void {
    values.splice(index, 1);
    redraw();
    notify();
  }

  function redraw(): void {
    list.textContent = "";
    values.forEach((value, index) => {
      const chip = el("span", "entity-mgmt-editor-chip");
      chip.dataset.editorChip = "true";
      chip.appendChild(el("span", "entity-mgmt-editor-chip-text", value));
      const rm = el("button", "entity-mgmt-editor-chip-remove", "✕");
      rm.type = "button";
      rm.title = MODAL_LABELS.chipRemoveTitle;
      rm.dataset.chipRemove = "true";
      rm.addEventListener("click", () => removeAt(index));
      chip.appendChild(rm);
      list.appendChild(chip);
    });
  }

  function tryAdd(raw: string): void {
    const value = raw.trim();
    if (value.length === 0) return;
    const key = value.toLowerCase();
    if (values.some((v) => v.toLowerCase() === key)) return;
    values.push(value);
    redraw();
    notify();
  }

  input.addEventListener("keydown", (e) => {
    const ev = e as KeyboardEvent;
    if (ev.key === "Enter" || ev.key === ",") {
      ev.preventDefault();
      tryAdd(input.value);
      input.value = "";
    }
  });

  for (const v of initial) tryAdd(v);

  wrap.appendChild(input);
  wrap.appendChild(list);

  return { wrap, values: () => [...values] };
}

/**
 * 로컬 칸 에디터 — 칸 이름 입력 + 글자형/숫자형/날짜형 라디오 3개(기본 글자형) + 추가 → 로컬 칸 칩
 * 목록(타입 배지 [숫자]/[글자]/[날짜] + ✕). 저장 전이라 네트워크 없이 로컬 배열만 다룬다(아직 종류가
 * 없어 칸 POST 불가·종류 저장 후 순차 POST 한다). 칩/배지/입력은 S8 .entity-mgmt-column-*
 * CSS 를 그대로 쓴다(수정 모달 칸 섹션과 같은 모양). 같은 칸 키(소문자 비교)·빈값은 안 만든다.
 */
export interface ColumnEditor {
  wrap: HTMLElement;
  values(): LocalColumn[];
}

export function createColumnEditor(): ColumnEditor {
  const columns: LocalColumn[] = [];
  const wrap = el("div", "entity-mgmt-column-section");
  wrap.dataset.section = "entity-mgmt-add-columns";

  // ── 추가 폼: 칸 이름 + 라디오 3개(기본 글자형) + 추가 버튼 ─────────────────────────
  const addForm = el("form", "entity-mgmt-column-add");

  const keyInput = el("input", "entity-mgmt-column-input");
  keyInput.type = "text";
  keyInput.dataset.columnKeyInput = "true";
  keyInput.placeholder = MODAL_LABELS.columnAddHint;
  addForm.appendChild(keyInput);

  const radioWrap = el("div", "entity-mgmt-column-radio-wrap");
  let numberRadio: HTMLInputElement | undefined;
  let dateRadio: HTMLInputElement | undefined;
  const radioName = "entity-mgmt-add-column-type";
  const mkRadio = (
    value: ColumnDataType,
    labelText: string,
    checked: boolean,
  ): HTMLInputElement => {
    const label = el("label", "entity-mgmt-column-radio");
    const radio = el("input");
    radio.type = "radio";
    radio.name = radioName;
    radio.value = value;
    radio.checked = checked;
    radio.dataset.columnType = value;
    label.appendChild(radio);
    label.appendChild(el("span", "entity-mgmt-column-radio-text", labelText));
    radioWrap.appendChild(label);
    return radio;
  };
  mkRadio("text", MODAL_LABELS.columnTypeText, true);
  numberRadio = mkRadio("number", MODAL_LABELS.columnTypeNumber, false);
  dateRadio = mkRadio("date", MODAL_LABELS.columnTypeDate, false);
  addForm.appendChild(radioWrap);

  const addBtn = el("button", "entity-mgmt-column-add-btn", MODAL_LABELS.columnAdd);
  addBtn.type = "submit";
  addForm.appendChild(addBtn);
  wrap.appendChild(addForm);

  // ── 로컬 칸 칩 목록 ─────────────────────────────────────────────────────────
  const list = el("div", "entity-mgmt-column-chip-wrap");
  list.dataset.columnList = "true";
  wrap.appendChild(list);

  function redraw(): void {
    list.textContent = "";
    columns.forEach((col, index) => {
      const chip = el("span", "entity-mgmt-column-chip");
      chip.dataset.columnChip = "true";
      chip.dataset.dataType = col.dataType;
      chip.appendChild(el("span", "entity-mgmt-column-chip-text", col.key));
      const badge = el(
        "span",
        `entity-mgmt-column-type-badge entity-mgmt-column-type-badge--${col.dataType}`,
        col.dataType === "number"
          ? MODAL_LABELS.columnBadgeNumber
          : col.dataType === "date"
            ? MODAL_LABELS.columnBadgeDate
            : MODAL_LABELS.columnBadgeText,
      );
      badge.dataset.dataType = col.dataType;
      chip.appendChild(badge);
      const rm = el("button", "entity-mgmt-column-chip-remove", MODAL_LABELS.columnRemove);
      rm.type = "button";
      rm.title = MODAL_LABELS.columnRemoveTitle;
      rm.dataset.columnRemove = "true";
      rm.addEventListener("click", () => {
        columns.splice(index, 1);
        redraw();
      });
      chip.appendChild(rm);
      list.appendChild(chip);
    });
  }

  function tryAdd(): void {
    const key = keyInput.value.trim();
    if (!validateColumnKey(key).ok) return; // 빈값은 칩으로 안 만든다(약한 가드).
    const lower = key.toLowerCase();
    if (columns.some((c) => c.key.toLowerCase() === lower)) {
      // 같은 칸 키 로컬 중복은 안 만든다(라우트 중복 400 전에 화면에서 막음). 입력만 비운다.
      keyInput.value = "";
      return;
    }
    const dataType: ColumnDataType = dateRadio?.checked
      ? "date"
      : numberRadio?.checked
        ? "number"
        : "text";
    columns.push({ key, dataType });
    keyInput.value = "";
    redraw();
  }

  addForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    tryAdd();
  });

  return { wrap, values: () => columns.map((c) => ({ ...c })) };
}
