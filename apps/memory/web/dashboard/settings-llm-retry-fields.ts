/**
 * dashboard/settings-llm-retry-fields.ts — 추출·캡션 블록의 자동 재시도 설정 숫자 칸 세 개 (2026-10-14 spec 4.4·6장).
 *
 * 두 블록이 같은 칸을 쓰므로 만들기·읽기·바뀜 판정을 한 곳에 둔다. 서버 값 읽기(readRetryPolicyValue)는 칸이 빠지면 칸
 * 경로를 든 오류로 멈춘다(기본값으로 메우지 않음). 입력값이 숫자로 읽히지 않으면 이 화면의 다른 숫자 칸과 같이 0 을
 * 실어 보낸다 — 서버 설정 검사가 칸 경로를 든 "1 이상 필요" 오류로 저장을 거부해 저장 상태 줄에 보인다.
 */
import { BACKFILL_RETRY_FIELD_LABELS as L } from "./settings-backfill-attempts-labels";

export interface RetryPolicyValue {
  maxAttempts: number;
  retryDelayMin: number;
  retryMaxDelayMin: number;
}

export const RETRY_FIELD_KEYS = ["maxAttempts", "retryDelayMin", "retryMaxDelayMin"] as const;
type RetryFieldKey = (typeof RETRY_FIELD_KEYS)[number];

/** 서버 설정 값의 backfill 객체에서 세 칸을 읽는다. path 는 오류 문장용 칸 경로(예: "llm.extractor.backfill"). */
export function readRetryPolicyValue(backfill: Record<string, unknown>, path: string): RetryPolicyValue {
  const out = {} as Record<RetryFieldKey, number>;
  for (const key of RETRY_FIELD_KEYS) {
    const value = backfill[key];
    if (typeof value !== "number") {
      throw new Error(`${path}.${key} 가 number 아님 — schema default 채움 검토 필요.`);
    }
    out[key] = value;
  }
  return out;
}

export interface RetryFieldsHandle {
  element: HTMLElement;
  read(): RetryPolicyValue;
  isChanged(original: RetryPolicyValue): boolean;
}

/** 세 칸을 만든다. 입력 id = `${idPrefix}-${칸 이름}` (예: llm-extractor-backfill-maxAttempts). */
export function renderRetryFields(idPrefix: string, current: RetryPolicyValue): RetryFieldsHandle {
  const element = document.createElement("div");
  element.className = "llm-retry-fields";
  element.dataset.section = `${idPrefix}-retry`;
  const inputs = {} as Record<RetryFieldKey, HTMLInputElement>;
  for (const key of RETRY_FIELD_KEYS) {
    const row = document.createElement("div");
    row.className = "llm-field-row";
    const label = document.createElement("label");
    label.htmlFor = `${idPrefix}-${key}`;
    label.textContent = L[key];
    const input = document.createElement("input");
    input.type = "number";
    input.id = `${idPrefix}-${key}`;
    input.min = "1";
    input.step = "1";
    input.value = String(current[key]);
    row.append(label, input);
    element.appendChild(row);
    inputs[key] = input;
  }

  function read(): RetryPolicyValue {
    const out = {} as Record<RetryFieldKey, number>;
    for (const key of RETRY_FIELD_KEYS) {
      const parsed = Number.parseInt(inputs[key].value, 10);
      out[key] = Number.isFinite(parsed) ? parsed : 0;
    }
    return out;
  }

  function isChanged(original: RetryPolicyValue): boolean {
    const now = read();
    return RETRY_FIELD_KEYS.some((key) => now[key] !== original[key]);
  }

  return { element, read, isChanged };
}
