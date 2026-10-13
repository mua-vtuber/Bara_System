/**
 * dashboard/settings-llm-model-picker.ts — 공급자 모델 드롭다운 (2026-10-11 llm-api-providers spec D10·8장).
 *
 * Anthropic·OpenAI·Google·LM Studio 네 공급자가 같이 쓴다(Ollama 는 기존 list-ollama-models 드롭다운).
 * 서버 액션 POST /settings/actions/list-provider-models 로 실제 목록을 받아 채운다.
 *
 * 화면 상태:
 *   - 처음: 지금 값 한 개(비었으면 "(모델 미선택)"). 키가 필요한데 저장된 키가 없으면 "키를 입력한 뒤…" 안내.
 *   - 불러오는 중: 드롭다운 비활성 + "목록을 불러오는 중…".
 *   - 성공: 목록 + 지금 값이 목록에 없으면 맨 위에 "(목록에 없음)" + 지원 종료 예정 표시 + 마지막 "직접 입력…".
 *     지금 값이 비어 있으면 "(모델 미선택)"을 맨 위에 두고 선택을 유지한다 — 아무 모델이나 고르지 않는다.
 *   - 성공·0개: 지금 값만 + "이 키로 쓸 수 있는 모델이 없습니다."
 *   - 실패: 지금 값 한 개를 "(저장된 값 — 목록을 못 불러옴)" 으로 남기고, 드롭다운 아래 빨간 줄에 서버 오류
 *     문장을 그대로 보인다(토스트로 끝내지 않음). 가짜 목록은 만들지 않는다.
 *   - 직접 입력: "직접 입력…"을 고르면 아래 글 칸이 열리고 그 값이 저장 값이 된다.
 */

import { apiFetch } from "./api-fetch";
import { LLM_LABELS } from "./settings-llm-labels";
import type { StyleProfile } from "./settings-llm-style";
import type { ModelListingProvider } from "../../src/llm/model-listing";

/** 목록 액션 경로. */
export const LIST_PROVIDER_MODELS_PATH = "/settings/actions/list-provider-models";

/** "직접 입력…" 선택지 값 — 모델 이름과 겹치지 않는 표식. */
export const MANUAL_ENTRY_VALUE = "__bara_manual_model_entry__";

export type PickerSlotKey = "extractor" | "cleanup" | "vision" | "ocr";

export interface ModelPickerOptions {
  /** 드롭다운 id. 직접 입력 칸은 `${id}-manual`, 버튼은 `${id}-load`. */
  id: string;
  slotKey: PickerSlotKey;
  provider: ModelListingProvider;
  /** 지금 값(디스크/draft). */
  initialValue: string;
  profile: StyleProfile;
  /** 키가 반드시 있어야 하는 공급자인지. */
  apiKeyRequired: boolean;
  /** 서버에 키가 저장돼 있는지($secretsSet). */
  hasSavedKey: boolean;
  /** 화면에 방금 적은 키. 빈 문자열이면 서버가 저장된 키를 쓴다. */
  typedKey: () => string;
  /** openai_compatible 한정 — 지금 적힌 주소. */
  baseUrl?: () => string;
}

export interface ModelPickerHandle {
  row: HTMLElement;
  select: HTMLSelectElement;
  manualInput: HTMLInputElement;
  loadButton: HTMLButtonElement;
  /** 안내 줄(회색). */
  notice: HTMLElement;
  /** 실패 줄(빨간색). */
  error: HTMLElement;
  /** 저장할 모델 값. */
  getValue: () => string;
  /** 목록 불러오기. 같은 조합 요청이 진행 중이면 그 요청을 기다린다. */
  load: () => Promise<void>;
  /** 키가 필요 없거나 저장된 키가 있고, 아직 목록을 못 받았으면 한 번 불러온다. */
  autoLoad: () => void;
}

interface ListedModel {
  id: string;
  label: string;
  deprecated: boolean;
}

interface ParsedList {
  models: ListedModel[];
  filter: { kind: string; removed: number };
}

function parseListResponse(data: unknown): ParsedList {
  const rec = data as { models?: unknown; filter?: unknown } | null;
  if (!rec || !Array.isArray(rec.models) || !rec.filter || typeof rec.filter !== "object") {
    throw new Error(LLM_LABELS.modelListBadResponse);
  }
  const models: ListedModel[] = [];
  for (const item of rec.models) {
    const m = item as { id?: unknown; label?: unknown; deprecated?: unknown };
    if (typeof m.id !== "string" || typeof m.label !== "string" || typeof m.deprecated !== "boolean") {
      throw new Error(LLM_LABELS.modelListBadResponse);
    }
    models.push({ id: m.id, label: m.label, deprecated: m.deprecated });
  }
  const filter = rec.filter as { kind?: unknown; removed?: unknown };
  if (typeof filter.kind !== "string" || typeof filter.removed !== "number") {
    throw new Error(LLM_LABELS.modelListBadResponse);
  }
  return { models, filter: { kind: filter.kind, removed: filter.removed } };
}

function option(value: string, text: string): HTMLOptionElement {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = text;
  return opt;
}

export function createModelPicker(opts: ModelPickerOptions): ModelPickerHandle {
  const row = document.createElement("div");
  opts.profile.applyFieldRow(row);
  row.dataset.provider = opts.provider;

  const label = document.createElement("label");
  label.htmlFor = opts.id;
  label.textContent = LLM_LABELS.modelLabel;
  row.appendChild(label);

  const controls = document.createElement("div");
  controls.className = "llm-model-picker-controls";
  const select = document.createElement("select");
  select.id = opts.id;
  controls.appendChild(select);
  const loadButton = document.createElement("button");
  loadButton.type = "button";
  loadButton.id = `${opts.id}-load`;
  loadButton.className = "llm-model-load-btn";
  loadButton.textContent = LLM_LABELS.loadModels;
  controls.appendChild(loadButton);
  row.appendChild(controls);

  const manualInput = document.createElement("input");
  manualInput.type = "text";
  manualInput.id = `${opts.id}-manual`;
  manualInput.placeholder = LLM_LABELS.manualEntryPlaceholder;
  manualInput.style.display = "none";
  row.appendChild(manualInput);

  const notice = document.createElement("div");
  opts.profile.applyHint(notice);
  notice.dataset.role = "model-notice";
  row.appendChild(notice);

  const error = document.createElement("div");
  error.className = "llm-field-error";
  error.dataset.role = "model-error";
  error.style.display = "none";
  row.appendChild(error);

  /** 드롭다운에서 고른(또는 처음) 모델 값 — 목록을 다시 그려도 이 값을 지킨다. */
  let chosen = opts.initialValue.trim();
  let manualMode = false;
  let loaded = false;
  let inflight: { key: string; promise: Promise<void> } | null = null;
  /** 요청 순번 — 늦게 도착한 옛 요청의 응답이 더 새 요청의 결과를 덮어쓰지 않게 한다. */
  let requestSeq = 0;

  function setNotice(text: string): void {
    notice.textContent = text;
    notice.style.display = text ? "" : "none";
  }
  function setError(text: string): void {
    error.textContent = text;
    error.style.display = text ? "" : "none";
  }
  function applyManualVisibility(): void {
    manualInput.style.display = manualMode ? "" : "none";
  }

  function currentLabel(text: (v: string) => string): string {
    return chosen ? text(chosen) : LLM_LABELS.noModelSelected;
  }

  /** 지금 값 한 개 + 직접 입력… (처음·실패·0개 상태). */
  function renderSingle(labelFor: (v: string) => string): void {
    select.replaceChildren(option(chosen, currentLabel(labelFor)), option(MANUAL_ENTRY_VALUE, LLM_LABELS.manualEntry));
    select.value = manualMode ? MANUAL_ENTRY_VALUE : chosen;
  }

  function renderList(models: ListedModel[]): void {
    const options: HTMLOptionElement[] = [];
    const inList = models.some((m) => m.id === chosen);
    if (!inList) {
      options.push(option(chosen, chosen ? LLM_LABELS.notInList(chosen) : LLM_LABELS.noModelSelected));
    }
    for (const m of models) {
      options.push(option(m.id, m.deprecated ? LLM_LABELS.deprecated(m.label) : m.label));
    }
    options.push(option(MANUAL_ENTRY_VALUE, LLM_LABELS.manualEntry));
    select.replaceChildren(...options);
    select.value = manualMode ? MANUAL_ENTRY_VALUE : chosen;
  }

  function requestKey(): string {
    const typed = opts.typedKey().trim();
    return `${opts.provider}|${typed ? `typed:${typed}` : "saved"}|${opts.baseUrl ? opts.baseUrl().trim() : ""}`;
  }

  async function doLoad(): Promise<void> {
    const seq = ++requestSeq;
    const isStale = (): boolean => seq !== requestSeq;
    const typed = opts.typedKey().trim();
    const body: Record<string, unknown> = { slot: opts.slotKey, provider: opts.provider };
    if (typed) body.apiKey = typed;
    if (opts.baseUrl) body.baseUrl = opts.baseUrl().trim();

    select.disabled = true;
    loadButton.disabled = true;
    select.replaceChildren(option(chosen, LLM_LABELS.loadingModels));
    setError("");
    setNotice("");
    try {
      const res = await apiFetch(LIST_PROVIDER_MODELS_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      // 그 사이 다른 키·주소로 새 요청을 보냈으면 이 응답은 버린다(화면은 새 요청이 그린다).
      if (isStale()) return;
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!res.ok) {
        const serverError = (data as { error?: unknown } | null)?.error;
        throw new Error(typeof serverError === "string" && serverError ? serverError : LLM_LABELS.modelListFailed(res.status));
      }
      const parsed = parseListResponse(data);
      loaded = true;
      const notices: string[] = [];
      if (opts.provider === "openai") notices.push(LLM_LABELS.openaiChatOnly);
      // 이미지를 못 받는 모델을 걸렀으면(vision·ocr 자리 — 서버가 filter.kind 로 알려 줌) 개수를 밝힌다.
      if (parsed.filter.kind === "image-input" && parsed.filter.removed > 0) {
        notices.push(LLM_LABELS.visionFiltered(parsed.filter.removed));
      }
      if (parsed.models.length === 0) {
        notices.push(LLM_LABELS.emptyList);
        renderSingle((v) => v);
      } else {
        renderList(parsed.models);
      }
      setNotice(notices.join(" "));
    } catch (err) {
      if (isStale()) return;
      renderSingle(LLM_LABELS.savedButFailed);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!isStale()) {
        select.disabled = false;
        loadButton.disabled = false;
      }
    }
  }

  function load(): Promise<void> {
    const key = requestKey();
    if (inflight && inflight.key === key) return inflight.promise;
    const promise = doLoad().finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
    inflight = { key, promise };
    return promise;
  }

  function ready(): boolean {
    return !opts.apiKeyRequired || opts.hasSavedKey || opts.typedKey().trim().length > 0;
  }

  function autoLoad(): void {
    if (loaded || !ready()) return;
    void load();
  }

  select.addEventListener("change", () => {
    if (select.value === MANUAL_ENTRY_VALUE) {
      manualMode = true;
      if (!manualInput.value) manualInput.value = chosen;
    } else {
      manualMode = false;
      chosen = select.value;
    }
    applyManualVisibility();
  });
  loadButton.addEventListener("click", () => {
    void load();
  });

  renderSingle((v) => v);
  if (opts.apiKeyRequired && !opts.hasSavedKey) setNotice(LLM_LABELS.needKeyFirst);
  else setNotice("");
  applyManualVisibility();

  return {
    row,
    select,
    manualInput,
    loadButton,
    notice,
    error,
    getValue: () => (manualMode ? manualInput.value.trim() : chosen),
    load,
    autoLoad,
  };
}
