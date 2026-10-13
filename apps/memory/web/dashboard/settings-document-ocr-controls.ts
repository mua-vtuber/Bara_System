/**
 * dashboard/settings-document-ocr-controls.ts — 문서 처리 화면의 작은 입력 부품 (settings.ts 에서 옮김, 동작 불변).
 *
 * 라벨 칸·글/숫자/선택 칸·로컬 모델 드롭다운 채우기·로컬 모델 목록 액션 읽기를 모은다. 문서 OCR 설정 패널과
 * API 패널·상태 패널이 같이 쓴다.
 */

import { apiFetch } from "./api-fetch";

export interface ModelOption {
  id: string;
  name: string;
}

/** 설정 라우터 경로 머리. */
export const SETTINGS_BASE = "/settings";

/** 라벨(첫 글자 덩어리) + 칸 [+ 회색 안내]. 테스트는 첫 자식 글로 칸을 찾는다. */
export function createLabeledControl(labelText: string, control: HTMLElement, hintText?: string): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "document-ocr-field";
  const span = document.createElement("span");
  span.textContent = labelText;
  label.appendChild(span);
  label.appendChild(control);
  if (hintText) {
    const hint = document.createElement("small");
    hint.className = "document-ocr-hint";
    hint.textContent = hintText;
    label.appendChild(hint);
  }
  return label;
}

export function createTextInput(value: string, opts: { type?: string; placeholder?: string } = {}): HTMLInputElement {
  const input = document.createElement("input");
  input.type = opts.type ?? "text";
  input.value = value;
  if (opts.placeholder) input.placeholder = opts.placeholder;
  return input;
}

export function createNumberInput(value: number, min = 1): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min);
  input.step = "1";
  input.value = String(value);
  return input;
}

export function createTextarea(value: string, placeholder = ""): HTMLTextAreaElement {
  const textarea = document.createElement("textarea");
  textarea.rows = 4;
  textarea.value = value;
  textarea.placeholder = placeholder;
  return textarea;
}

export function createSelect<T extends string>(
  value: T,
  options: ReadonlyArray<{ value: T; label: string }>,
): HTMLSelectElement {
  const select = document.createElement("select");
  for (const option of options) {
    const opt = document.createElement("option");
    opt.value = option.value;
    opt.textContent = option.label;
    select.appendChild(opt);
  }
  select.value = value;
  return select;
}

export function createModelSelect(value: string, emptyLabel: string): HTMLSelectElement {
  const select = document.createElement("select");
  setModelSelectOptions(select, value, [], emptyLabel);
  return select;
}

/** 목록으로 채우되 지금 값은 지킨다(목록에 없으면 맨 위 "(목록에 없음)"). */
export function setModelSelectOptions(
  select: HTMLSelectElement,
  preferredValue: string,
  options: ReadonlyArray<ModelOption>,
  emptyLabel: string,
): void {
  select.replaceChildren();
  const seen = new Set<string>();
  let matched = false;

  for (const option of options) {
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    const element = document.createElement("option");
    element.value = option.id;
    element.textContent = option.name || option.id || emptyLabel;
    if (option.id === preferredValue) {
      element.selected = true;
      matched = true;
    }
    select.appendChild(element);
  }

  if (preferredValue && !matched) {
    const element = document.createElement("option");
    element.value = preferredValue;
    element.textContent = `${preferredValue} (목록에 없음)`;
    element.selected = true;
    select.insertBefore(element, select.firstChild);
  }

  if (select.options.length === 0) {
    const element = document.createElement("option");
    element.value = preferredValue;
    element.textContent = preferredValue || emptyLabel;
    element.selected = true;
    select.appendChild(element);
  }
}

export function parseResponseError(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const rec = body as Record<string, unknown>;
    if (typeof rec.error === "string") return rec.error;
  }
  return fallback;
}

/** 로컬 모델 목록 액션(list-ollama-models / list-lmstudio-models) 결과 읽기. 실패는 던진다. */
export async function fetchModelOptions(actionPath: string): Promise<ModelOption[]> {
  const res = await apiFetch(`${SETTINGS_BASE}${actionPath}`, { method: "POST" });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    throw new Error(parseResponseError(body, `모델 목록 조회 실패 (HTTP ${res.status})`));
  }
  if (!Array.isArray(body)) {
    throw new Error(`모델 목록 응답이 배열 형태가 아님 (type=${typeof body})`);
  }
  const result: ModelOption[] = [];
  for (const item of body) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = rec.id;
    if (typeof id !== "string" && typeof id !== "number") continue;
    const name = rec.name;
    result.push({
      id: String(id),
      name: typeof name === "string" || typeof name === "number" ? String(name) : String(id),
    });
  }
  return result;
}

/**
 * 숫자 칸 값을 정수로 읽는다. 정수가 아니면 칸 경로를 대며 던진다 — 다른 값으로 바꿔 저장하지 않는다
 * (범위 검사는 서버 저장 검사가 칸 이름과 함께 알린다).
 */
export function readIntegerInput(input: HTMLInputElement, path: string): number {
  const value = Number(input.value);
  if (input.value.trim() === "" || !Number.isInteger(value)) {
    throw new Error(`${path} 값이 정수가 아님 — "${input.value}"`);
  }
  return value;
}

export function renderOcrPanelTitle(text: string): HTMLHeadingElement {
  const title = document.createElement("h3");
  title.className = "document-ocr-panel-title";
  title.textContent = text;
  return title;
}

export function createDocumentOcrNote(text: string): HTMLParagraphElement {
  const note = document.createElement("p");
  note.className = "document-ocr-note";
  note.textContent = text;
  return note;
}
