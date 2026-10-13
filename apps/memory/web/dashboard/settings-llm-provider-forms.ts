/**
 * dashboard/settings-llm-provider-forms.ts — 공급자별 입력 폼 + 저장 payload (2026-10-11 llm-api-providers spec D10).
 *
 *   - API 공급자(Anthropic·OpenAI·Google): "<공급자> API 키" 비밀 칸 + 모델 드롭다운(목록 불러오기).
 *     저장된 키가 있으면 "저장된 키가 있습니다…", 없으면 "키를 입력하세요." 안내.
 *   - LM Studio / OpenAI 호환: 주소 + 키(선택) + 모델 드롭다운.
 *
 * 저장 payload 와 변경 감지는 공급자 표의 칸(modelField / apiKeyField / baseUrlField)을 따라 세 슬롯이 같이
 * 쓴다(buildProviderPayload / isProviderChanged). 키 칸이 비면 payload 에서 빼서 서버가 저장된 키를 지킨다.
 */

import {
  LLM_PROVIDER_SPECS,
  type LlmApiKeyField,
  type LlmModelField,
  type LlmProvider,
  type LlmProviderFieldName,
} from "../../src/llm/provider-registry";
import { LLM_LABELS, LLM_PROVIDER_KEY_NAMES } from "./settings-llm-labels";
import { createModelPicker, type ModelPickerHandle, type PickerSlotKey } from "./settings-llm-model-picker";
import type { StyleProfile } from "./settings-llm-style";
import type { LlmSlotCommonValue } from "./settings-llm-types";

/** 폼 칸 하나를 읽는 손잡이. */
export interface FieldReader {
  getValue: () => string;
}

/** 공급자 표가 가리키는 모든 칸의 손잡이 — payload·변경 감지가 공급자 표로 칸을 고른다. */
export type ProviderFieldReaders = Record<LlmProviderFieldName, FieldReader>;

export type ApiProvider = "anthropic" | "openai" | "google";

export interface ProviderFormIds {
  form: string;
  key: string;
  model: string;
}

/** 폼이 읽는 공급자 칸 값 — LLM 슬롯과 문서 OCR(documents.ocr.api)이 같은 칸 이름을 가진다. */
export type ProviderFormValues = Pick<
  LlmSlotCommonValue,
  | "anthropicApiKey"
  | "anthropicModel"
  | "gptApiKey"
  | "gptModel"
  | "geminiApiKey"
  | "geminiModel"
  | "openaiBaseUrl"
  | "openaiModel"
  | "openaiApiKey"
  | "savedKeyFields"
>;

/** OpenAI 호환 폼 문구를 바꿔 쓸 때(문서 OCR). 없으면 LLM 슬롯 문구. */
export interface CompatFormLabels {
  urlLabel: string;
  urlPlaceholder: string;
  urlHint: string;
  keyLabel: string;
  keyEmptyHint: string;
}

export interface FormContext {
  slotKey: PickerSlotKey;
  current: ProviderFormValues;
  profile: StyleProfile;
  /** "class" 면 키 칸을 비워 두고(서버가 가려 보냄) 저장 여부 안내, "inline" 이면 draft 값 복원. */
  styling: "class" | "inline";
  showHints: boolean;
}

export interface ApiProviderForm {
  element: HTMLElement;
  keyInput: HTMLInputElement;
  picker: ModelPickerHandle;
}

export interface CompatProviderForm {
  element: HTMLElement;
  baseUrlInput: HTMLInputElement;
  keyInput: HTMLInputElement;
  picker: ModelPickerHandle;
}

function hasSavedKey(current: ProviderFormValues, field: LlmApiKeyField): boolean {
  return current.savedKeyFields.includes(field);
}

function keyRow(
  ctx: FormContext,
  id: string,
  labelText: string,
  field: LlmApiKeyField,
  emptyHint: string,
): { row: HTMLElement; input: HTMLInputElement } {
  const row = document.createElement("div");
  ctx.profile.applyFieldRow(row);
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = labelText;
  row.appendChild(label);
  const input = document.createElement("input");
  input.id = id;
  input.type = "password";
  input.autocomplete = "off";
  // 서버는 키를 가려 보내므로 화면 칸은 비어 있다. 빈 칸으로 저장하면 서버가 저장된 키를 지킨다.
  input.value = ctx.styling === "inline" ? ctx.current[field] : "";
  row.appendChild(input);
  const hint = document.createElement("div");
  ctx.profile.applyHint(hint);
  hint.dataset.role = "key-hint";
  hint.textContent = hasSavedKey(ctx.current, field) ? LLM_LABELS.keySaved : emptyHint;
  row.appendChild(hint);
  return { row, input };
}

/** Anthropic·OpenAI·Google 공통 폼 — 키 + 모델 드롭다운. */
export function createApiProviderForm(
  provider: ApiProvider,
  ids: ProviderFormIds,
  ctx: FormContext,
): ApiProviderForm {
  const spec = LLM_PROVIDER_SPECS[provider];
  const keyField = spec.apiKeyField as LlmApiKeyField;
  const form = document.createElement("div");
  ctx.profile.applyBranchForm(form);
  form.id = ids.form;

  const key = keyRow(ctx, ids.key, LLM_LABELS.keyLabel(LLM_PROVIDER_KEY_NAMES[provider]), keyField, LLM_LABELS.keyMissing);
  form.appendChild(key.row);

  const picker = createModelPicker({
    id: ids.model,
    slotKey: ctx.slotKey,
    provider,
    initialValue: ctx.current[spec.modelField as Exclude<LlmModelField, "ollamaModel">],
    profile: ctx.profile,
    apiKeyRequired: spec.apiKeyRequired,
    hasSavedKey: hasSavedKey(ctx.current, keyField),
    typedKey: () => key.input.value,
  });
  form.appendChild(picker.row);

  // 키를 새로 적고 칸을 벗어나면 그 키로 목록을 불러온다(버튼으로도 가능).
  key.input.addEventListener("change", () => {
    if (key.input.value.trim().length > 0) void picker.load();
  });
  return { element: form, keyInput: key.input, picker };
}

/** LM Studio / OpenAI 호환 폼 — 주소 + 키(선택) + 모델 드롭다운. */
export function createCompatProviderForm(
  ids: { form: string; baseUrl: string; key: string; model: string },
  ctx: FormContext,
  labels?: CompatFormLabels,
): CompatProviderForm {
  const form = document.createElement("div");
  ctx.profile.applyBranchForm(form);
  form.id = ids.form;

  const urlRow = document.createElement("div");
  ctx.profile.applyFieldRow(urlRow);
  const urlLabel = document.createElement("label");
  urlLabel.htmlFor = ids.baseUrl;
  urlLabel.textContent = labels?.urlLabel ?? LLM_LABELS.compatUrlLabel;
  urlRow.appendChild(urlLabel);
  const baseUrlInput = document.createElement("input");
  baseUrlInput.id = ids.baseUrl;
  baseUrlInput.type = "text";
  baseUrlInput.value = ctx.current.openaiBaseUrl;
  baseUrlInput.placeholder = labels?.urlPlaceholder ?? "http://127.0.0.1:1234/v1";
  urlRow.appendChild(baseUrlInput);
  if (ctx.styling === "class" && ctx.showHints) {
    const hint = document.createElement("div");
    ctx.profile.applyHint(hint);
    hint.textContent = labels?.urlHint ?? LLM_LABELS.compatUrlHint;
    urlRow.appendChild(hint);
  }
  form.appendChild(urlRow);

  const key = keyRow(
    ctx,
    ids.key,
    labels?.keyLabel ?? LLM_LABELS.compatKeyLabel,
    "openaiApiKey",
    labels?.keyEmptyHint ?? (ctx.styling === "class" ? LLM_LABELS.compatKeyEmptyHint : LLM_LABELS.compatKeyInlineHint),
  );

  const picker = createModelPicker({
    id: ids.model,
    slotKey: ctx.slotKey,
    provider: "openai_compatible",
    initialValue: ctx.current.openaiModel,
    profile: ctx.profile,
    apiKeyRequired: false,
    hasSavedKey: hasSavedKey(ctx.current, "openaiApiKey"),
    typedKey: () => key.input.value,
    baseUrl: () => baseUrlInput.value,
  });
  form.appendChild(key.row);
  form.appendChild(picker.row);

  baseUrlInput.addEventListener("change", () => void picker.load());
  key.input.addEventListener("change", () => {
    if (key.input.value.trim().length > 0) void picker.load();
  });
  return { element: form, baseUrlInput, keyInput: key.input, picker };
}

/**
 * 고른 공급자의 칸만 담은 payload 조각. 모델·주소는 늘 싣고, 키는 새로 적었을 때만 싣는다(빈 키 = 저장된 키 유지).
 * 다른 공급자의 칸은 싣지 않는다 — 서버가 슬롯 단위 얕은 병합을 하므로 디스크의 옛 값이 그대로 남는다.
 */
export function buildProviderPayload(fields: ProviderFieldReaders, provider: LlmProvider): Record<string, unknown> {
  const spec = LLM_PROVIDER_SPECS[provider];
  const payload: Record<string, unknown> = {};
  if (spec.baseUrlField !== null) payload[spec.baseUrlField] = fields[spec.baseUrlField].getValue().trim();
  payload[spec.modelField] = fields[spec.modelField].getValue().trim();
  if (spec.apiKeyField !== null) {
    const key = fields[spec.apiKeyField].getValue();
    if (key.length > 0) payload[spec.apiKeyField] = key;
  }
  return payload;
}

/** 고른 공급자의 칸이 옛 값과 달라졌는지(키는 새로 적었으면 바뀐 것). */
export function isProviderChanged(
  fields: ProviderFieldReaders,
  original: LlmSlotCommonValue,
  provider: LlmProvider,
): boolean {
  const spec = LLM_PROVIDER_SPECS[provider];
  if (spec.baseUrlField !== null && fields[spec.baseUrlField].getValue().trim() !== original[spec.baseUrlField]) {
    return true;
  }
  if (fields[spec.modelField].getValue().trim() !== original[spec.modelField]) return true;
  return spec.apiKeyField !== null && fields[spec.apiKeyField].getValue().length > 0;
}
