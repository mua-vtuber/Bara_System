/**
 * dashboard/settings-llm-controls.ts — LLM 슬롯 공통 컨트롤 빌더 (단일 정본).
 *
 * 한 슬롯(extractor / cleanup / vision)의 enabled 토글·처리 방법·선택 AI 드롭다운·공급자별 폼을 조립한다.
 * 공급자 목록·분류(서버 AI / AI API)·칸 대응은 공급자 표(src/llm/provider-registry.ts), 화면 문구는
 * settings-llm-labels.ts, API·LM Studio 폼과 모델 드롭다운은 settings-llm-provider-forms.ts /
 * settings-llm-model-picker.ts, 스타일 프로필은 settings-llm-style.ts 에 있다.
 *
 * 처리 방법은 "서버에 설치된 AI로 처리" / "AI API 사용" 두 가지다(2026-10-11 — 준비 중이던 PC 보조
 * 프로그램 항목 제거. 문서 OCR 의 pc_companion 은 별개 기능으로 그대로).
 *
 * 기본값은 section/field id "llm-" 접두사 + kebab 체계, CSS 클래스 스타일,
 * Ollama 모델 서버 목록 드롭다운(자동 fetch)이다. 임베드된 소형 폼이 필요할 때만
 * options 로 id·표시 방식을 주입한다.
 */

import { showToast } from "./form/toast";
import { apiFetch } from "./api-fetch";
import type { LlmProvider, LlmSlotCommonValue } from "./settings-llm-types";
import {
  LLM_PROCESSING_MODES,
  LLM_PROVIDERS,
  LLM_PROVIDER_SPECS,
  providersForMode,
  type LlmProcessingMode,
} from "../../src/llm/provider-registry";
import { LLM_LABELS, LLM_METHOD_LABELS, LLM_PROVIDER_LABELS } from "./settings-llm-labels";
import { CLASS_PROFILE, INLINE_PROFILE, type StyleProfile } from "./settings-llm-style";
import {
  createApiProviderForm,
  createCompatProviderForm,
  type ProviderFieldReaders,
} from "./settings-llm-provider-forms";
import type { ModelPickerHandle } from "./settings-llm-model-picker";

const SETTINGS_BASE = "/settings";

/** 슬롯 식별 키. */
export type SlotKey = "extractor" | "cleanup" | "vision";

/**
 * 한 슬롯 DOM 요소들의 id 모음 — 다른 코드가 이 id 로 입력칸을 읽으므로, 호출자가 자기 화면의 기존 id 를
 * 그대로 넘겨야 한다.
 */
export interface SlotControlIds {
  section: string;
  enabled: string;
  config: string;
  provider: string;
  ollamaForm: string;
  ollamaUrl: string;
  ollamaModel: string;
  anthropicForm: string;
  anthropicKey: string;
  anthropicModel: string;
  openaiForm: string;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiKey: string;
  gptForm: string;
  gptKey: string;
  gptModel: string;
  geminiForm: string;
  geminiKey: string;
  geminiModel: string;
}

/**
 * 빌더 동작 옵션 — 생략 시 settings 화면 동작(CSS 클래스 + 모델 드롭다운 + "llm-" 접두사 kebab id).
 */
export interface SlotControlsOptions {
  /** 슬롯 요소 id 모음. 생략 시 settings 기본 id 체계("llm-slot-${k}" 등). */
  ids?: SlotControlIds;
  /**
   * 스타일 부여 방식 — "class"(기본: llm-section 등 CSS 클래스) /
   * "inline"(임베드용: section·heading·enabled 에 인라인 스타일 + field-row / field-hint 클래스).
   */
  styling?: "class" | "inline";
  /**
   * Ollama 모델 칸 모드 — "dropdown"(기본: 서버 목록 자동 fetch 드롭다운) /
   * "text"(직접 입력 텍스트 칸, 자동 fetch 0).
   */
  modelFieldMode?: "dropdown" | "text";
  /** Ollama URL 노출 방식 — "visible" / "advanced"(settings 기본, 접힌 고급 영역) / "hidden". */
  ollamaUrlVisibility?: "visible" | "advanced" | "hidden";
  /** desc 단락 노출 여부. 생략 시 class 스타일에서 노출. */
  showDesc?: boolean;
  /** 설정 화면의 보조 설명 문장 노출 여부. 기본값은 true. 키 저장 여부·모델 목록 안내는 늘 보인다. */
  showHints?: boolean;
}

/** 모델 드롭다운을 쓰는 공급자(Ollama 는 별도 드롭다운). */
export type PickerProvider = "anthropic" | "openai" | "google" | "openai_compatible";

export interface SlotCommonControls {
  /** enabled 토글 input. enabled=false 면 슬롯 LLM 호출 0. */
  enabledInput: HTMLInputElement;
  /** 선택 AI 드롭다운. */
  providerSelect: HTMLSelectElement;
  /** Ollama URL text input. */
  ollamaUrlInput: HTMLInputElement;
  /** Ollama 모델 드롭다운 (modelFieldMode="dropdown"). text 모드면 null. */
  ollamaModelSelect: HTMLSelectElement | null;
  /** Ollama 모델 칸 — 드롭다운 또는 텍스트 input 의 단일 접근자. */
  ollamaModelField: HTMLSelectElement | HTMLInputElement;
  /** 공급자 표의 모든 칸 손잡이 — buildProviderPayload / isProviderChanged 가 쓴다. */
  fields: ProviderFieldReaders;
  /** 공급자별 모델 드롭다운. */
  pickers: Record<PickerProvider, ModelPickerHandle>;
  /** 공급자별 키 입력칸. */
  keyInputs: Record<PickerProvider, HTMLInputElement>;
  /** 슬롯 root 섹션 DOM. */
  section: HTMLElement;
  /** config 카드 (enabled=true 일 때만 노출). */
  configBox: HTMLElement;
}

/** settings 기본 id 체계 — "llm-slot-${k}" / "llm-${k}-${field}" (kebab). */
function defaultSettingsIds(slotKey: SlotKey): SlotControlIds {
  return {
    section: `llm-slot-${slotKey}`,
    enabled: `llm-${slotKey}-enabled`,
    config: `llm-${slotKey}-config`,
    provider: `llm-${slotKey}-provider`,
    ollamaForm: `llm-${slotKey}-ollama-form`,
    ollamaUrl: `llm-${slotKey}-ollama-url`,
    ollamaModel: `llm-${slotKey}-ollama-model`,
    anthropicForm: `llm-${slotKey}-anthropic-form`,
    anthropicKey: `llm-${slotKey}-anthropic-key`,
    anthropicModel: `llm-${slotKey}-anthropic-model`,
    openaiForm: `llm-${slotKey}-openai-form`,
    openaiBaseUrl: `llm-${slotKey}-openai-base-url`,
    openaiModel: `llm-${slotKey}-openai-model`,
    openaiKey: `llm-${slotKey}-openai-key`,
    gptForm: `llm-${slotKey}-gpt-form`,
    gptKey: `llm-${slotKey}-gpt-key`,
    gptModel: `llm-${slotKey}-gpt-model`,
    geminiForm: `llm-${slotKey}-gemini-form`,
    geminiKey: `llm-${slotKey}-gemini-key`,
    geminiModel: `llm-${slotKey}-gemini-model`,
  };
}

/** 이 처리 방법의 선택지로 드롭다운을 다시 채운다. 원하는 공급자가 없으면 표 순서 첫 공급자. */
function applyProviderChoices(
  select: HTMLSelectElement,
  mode: LlmProcessingMode,
  preferredProvider: LlmProvider,
): void {
  const choices = providersForMode(mode);
  const selected = choices.includes(preferredProvider) ? preferredProvider : choices[0];
  select.replaceChildren();
  for (const provider of choices) {
    const option = document.createElement("option");
    option.value = provider;
    option.textContent = LLM_PROVIDER_LABELS[provider];
    select.appendChild(option);
  }
  // 옵션마다 selected 를 거는 대신 다 붙인 뒤 값을 한 번에 정한다 — 붙이는 도중 선택이 앞 옵션으로
  // 옮겨 가 저장된 공급자가 아닌 다른 공급자로 보이던 문제(Google 저장 → OpenAI 표시)를 막는다.
  if (selected !== undefined) select.value = selected;
}

interface OllamaPart {
  form: HTMLElement;
  urlInput: HTMLInputElement;
  modelSelect: HTMLSelectElement | null;
  modelField: HTMLSelectElement | HTMLInputElement;
  /** 드롭다운 모드에서 Ollama 목록 자동 fetch. */
  autoFetch: (() => Promise<void>) | null;
}

/** Ollama 갈래 폼 — 주소(고급 영역) + 모델 드롭다운/글 칸. */
function createOllamaPart(
  slotKey: SlotKey,
  ids: SlotControlIds,
  current: LlmSlotCommonValue,
  profile: StyleProfile,
  styling: "class" | "inline",
  modelFieldMode: "dropdown" | "text",
  urlVisibility: "visible" | "advanced" | "hidden",
  showHints: boolean,
): OllamaPart {
  const form = document.createElement("div");
  profile.applyBranchForm(form);
  form.id = ids.ollamaForm;

  const urlRow = document.createElement("div");
  profile.applyFieldRow(urlRow);
  const urlLabel = document.createElement("label");
  urlLabel.htmlFor = ids.ollamaUrl;
  urlLabel.textContent = LLM_LABELS.ollamaUrlLabel;
  urlRow.appendChild(urlLabel);
  const urlInput = document.createElement("input");
  urlInput.id = ids.ollamaUrl;
  urlInput.type = "text";
  urlInput.value = current.ollamaUrl;
  urlInput.placeholder = "http://127.0.0.1:11434";
  urlRow.appendChild(urlInput);
  if (styling === "class" && showHints) {
    const hint = document.createElement("div");
    profile.applyHint(hint);
    hint.textContent = LLM_LABELS.ollamaUrlHint;
    urlRow.appendChild(hint);
  }
  if (urlVisibility === "advanced") {
    const advanced = document.createElement("details");
    advanced.className = "llm-ollama-advanced";
    const summary = document.createElement("summary");
    summary.textContent = LLM_LABELS.ollamaAdvancedSummary;
    advanced.appendChild(summary);
    if (showHints) {
      const advancedHint = document.createElement("p");
      advancedHint.className = "llm-field-hint";
      advancedHint.textContent = LLM_LABELS.ollamaAdvancedHint;
      advanced.appendChild(advancedHint);
    }
    advanced.appendChild(urlRow);
    form.appendChild(advanced);
  } else {
    form.appendChild(urlRow);
    if (urlVisibility === "hidden") urlRow.style.display = "none";
  }

  const modelRow = document.createElement("div");
  profile.applyFieldRow(modelRow);
  const modelLabel = document.createElement("label");
  modelLabel.htmlFor = ids.ollamaModel;
  modelLabel.textContent = LLM_LABELS.ollamaModelLabel;
  modelRow.appendChild(modelLabel);

  let modelSelect: HTMLSelectElement | null = null;
  let modelField: HTMLSelectElement | HTMLInputElement;
  if (modelFieldMode === "dropdown") {
    const select = document.createElement("select");
    select.id = ids.ollamaModel;
    // 초기 옵션 = 옛 디스크 값 한 개 (자동 fetch 실패 시에도 이 값이 남는다).
    const initial = document.createElement("option");
    initial.value = current.ollamaModel;
    initial.textContent = current.ollamaModel || LLM_LABELS.noModelSelected;
    initial.selected = true;
    select.appendChild(initial);
    modelRow.appendChild(select);
    modelSelect = select;
    modelField = select;
  } else {
    const input = document.createElement("input");
    input.id = ids.ollamaModel;
    input.type = "text";
    input.value = current.ollamaModel;
    // 텍스트 칸 placeholder — schema default 와 동기. cleanup=빈 태그.
    input.placeholder = slotKey === "cleanup" ? "" : "qwen3:4b-instruct";
    modelRow.appendChild(input);
    modelField = input;
  }
  if (showHints && (styling === "class" || modelFieldMode === "text")) {
    const hint = document.createElement("div");
    profile.applyHint(hint);
    hint.textContent = styling === "class" ? LLM_LABELS.ollamaModelHint : LLM_LABELS.ollamaModelTextHint;
    modelRow.appendChild(hint);
  }
  form.appendChild(modelRow);

  // 드롭다운 모드만 list-ollama-models 자동 fetch. 실패 = 명시 toast + 옛 디스크 값 유지(가짜 목록 0).
  const autoFetch = modelSelect
    ? async (): Promise<void> => {
        const select = modelSelect as HTMLSelectElement;
        try {
          const res = await apiFetch(`${SETTINGS_BASE}/actions/list-ollama-models`, { method: "POST" });
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(LLM_LABELS.ollamaListFailed(res.status, text));
          }
          const data = (await res.json()) as unknown;
          if (!Array.isArray(data)) throw new Error(LLM_LABELS.ollamaListNotArray(typeof data));
          const previousValue = select.value;
          select.innerHTML = "";
          let matched = false;
          for (const item of data) {
            if (!item || typeof item !== "object") continue;
            const rec = item as Record<string, unknown>;
            const id = rec.id;
            const name = rec.name;
            if (typeof id !== "string" && typeof id !== "number") continue;
            const opt = document.createElement("option");
            opt.value = String(id);
            opt.textContent = typeof name === "string" || typeof name === "number" ? String(name) : String(id);
            if (opt.value === previousValue) matched = true;
            select.appendChild(opt);
          }
          // 옛 디스크 값이 새 목록에 없으면 명시 항목으로 한 번 추가 — 모르는 새 다른 값으로 덮지 않게.
          if (!matched && previousValue) {
            const opt = document.createElement("option");
            opt.value = previousValue;
            opt.textContent = LLM_LABELS.notInList(previousValue);
            select.insertBefore(opt, select.firstChild);
          }
          // 옛 값 선택을 끝에 한 번에 정한다(옵션마다 selected 를 걸면 붙이는 도중 선택이 옮겨 갈 수 있다).
          if (previousValue) select.value = previousValue;
        } catch (err) {
          showToast(LLM_LABELS.ollamaDown(err instanceof Error ? err.message : String(err)), "error");
        }
      }
    : null;

  return { form, urlInput, modelSelect, modelField, autoFetch };
}

/**
 * 한 슬롯 (extractor / cleanup / vision) 공통 컨트롤을 만든다.
 *
 * @param slotKey 슬롯 식별 (id 산출·목록 요청).
 * @param titleText 섹션 헤더 라벨.
 * @param descText desc 단락 글 (styling="inline" / showDesc=false 면 미노출).
 * @param current 옛 디스크/draft 값 (form 초기 채움). savedKeyFields 로 키 저장 여부를 안다.
 * @param _original 옛 디스크 값 — 변경 감지는 settings-llm-section.ts 가 isProviderChanged 로 한다.
 * @param options 빌더 동작 옵션.
 */
export function createSlotCommonControls(
  slotKey: SlotKey,
  titleText: string,
  descText: string,
  current: LlmSlotCommonValue,
  _original: LlmSlotCommonValue,
  options?: SlotControlsOptions,
): SlotCommonControls {
  const ids = options?.ids ?? defaultSettingsIds(slotKey);
  const styling = options?.styling ?? "class";
  const modelFieldMode = options?.modelFieldMode ?? "dropdown";
  const ollamaUrlVisibility = options?.ollamaUrlVisibility ?? (styling === "class" ? "advanced" : "visible");
  const showDesc = options?.showDesc ?? styling === "class";
  const showHints = options?.showHints ?? true;
  const profile = styling === "inline" ? INLINE_PROFILE : CLASS_PROFILE;

  const section = document.createElement("section");
  profile.applySection(section);
  section.id = ids.section;
  section.appendChild(profile.makeHeading(titleText));
  if (showDesc) {
    const desc = profile.makeDesc(descText);
    if (desc) section.appendChild(desc);
  }

  // ── enabled 토글 ─────────────────────────────────────────────────────────
  const enabledRow = document.createElement("div");
  const enabledLabel = document.createElement("label");
  enabledLabel.htmlFor = ids.enabled;
  const enabledInput = document.createElement("input");
  enabledInput.type = "checkbox";
  enabledInput.id = ids.enabled;
  enabledInput.checked = current.enabled;
  enabledLabel.appendChild(enabledInput);
  enabledLabel.appendChild(document.createTextNode(LLM_LABELS.enabledLabel));
  enabledRow.appendChild(enabledLabel);
  profile.applyEnabledRow(enabledRow, enabledLabel);
  section.appendChild(enabledRow);

  // ── config 카드 (enabled=true 일 때만 노출) ────────────────────────────────
  const configBox = document.createElement("div");
  configBox.id = ids.config;
  profile.applyConfigBox(configBox);

  const providerSelect = document.createElement("select");
  providerSelect.id = ids.provider;
  if (styling === "class") {
    const methodRow = document.createElement("div");
    profile.applyFieldRow(methodRow);
    const methodLabel = document.createElement("label");
    methodLabel.htmlFor = `${ids.provider}-mode`;
    methodLabel.textContent = LLM_LABELS.methodLabel;
    methodRow.appendChild(methodLabel);
    const processingModeSelect = document.createElement("select");
    processingModeSelect.id = `${ids.provider}-mode`;
    const currentMode = LLM_PROVIDER_SPECS[current.provider].mode;
    for (const mode of LLM_PROCESSING_MODES) {
      const option = document.createElement("option");
      option.value = mode;
      option.textContent = LLM_METHOD_LABELS[mode];
      processingModeSelect.appendChild(option);
    }
    processingModeSelect.value = currentMode;
    methodRow.appendChild(processingModeSelect);
    configBox.appendChild(methodRow);
    applyProviderChoices(providerSelect, currentMode, current.provider);
    processingModeSelect.addEventListener("change", () => {
      applyProviderChoices(
        providerSelect,
        processingModeSelect.value as LlmProcessingMode,
        providerSelect.value as LlmProvider,
      );
      providerSelect.dispatchEvent(new Event("change"));
    });
  } else {
    // 인라인 임베드 갈래(현재 호출처 없음) — 같은 공급자 표로 선택지를 만든다.
    for (const provider of LLM_PROVIDERS) {
      const o = document.createElement("option");
      o.value = provider;
      o.textContent = LLM_PROVIDER_LABELS[provider];
      providerSelect.appendChild(o);
    }
    providerSelect.value = current.provider;
  }

  const providerRow = document.createElement("div");
  profile.applyFieldRow(providerRow);
  const providerLabel = document.createElement("label");
  providerLabel.htmlFor = ids.provider;
  providerLabel.textContent = styling === "class" ? LLM_LABELS.providerLabel : LLM_LABELS.providerLabelInline;
  providerRow.appendChild(providerLabel);
  providerRow.appendChild(providerSelect);
  configBox.appendChild(providerRow);

  // ── 공급자별 폼 ──────────────────────────────────────────────────────────
  const ollama = createOllamaPart(
    slotKey, ids, current, profile, styling, modelFieldMode, ollamaUrlVisibility, showHints,
  );
  const ctx = { slotKey, current, profile, styling, showHints };
  const anthropic = createApiProviderForm(
    "anthropic", { form: ids.anthropicForm, key: ids.anthropicKey, model: ids.anthropicModel }, ctx,
  );
  const gpt = createApiProviderForm("openai", { form: ids.gptForm, key: ids.gptKey, model: ids.gptModel }, ctx);
  const gemini = createApiProviderForm(
    "google", { form: ids.geminiForm, key: ids.geminiKey, model: ids.geminiModel }, ctx,
  );
  const compat = createCompatProviderForm(
    { form: ids.openaiForm, baseUrl: ids.openaiBaseUrl, key: ids.openaiKey, model: ids.openaiModel },
    ctx,
  );

  const forms: Record<LlmProvider, HTMLElement> = {
    ollama: ollama.form,
    openai_compatible: compat.element,
    anthropic: anthropic.element,
    openai: gpt.element,
    google: gemini.element,
  };
  for (const provider of LLM_PROVIDERS) configBox.appendChild(forms[provider]);
  section.appendChild(configBox);

  const pickers: Record<PickerProvider, ModelPickerHandle> = {
    anthropic: anthropic.picker,
    openai: gpt.picker,
    google: gemini.picker,
    openai_compatible: compat.picker,
  };
  const keyInputs: Record<PickerProvider, HTMLInputElement> = {
    anthropic: anthropic.keyInput,
    openai: gpt.keyInput,
    google: gemini.keyInput,
    openai_compatible: compat.keyInput,
  };
  const fields: ProviderFieldReaders = {
    ollamaUrl: { getValue: () => ollama.urlInput.value },
    ollamaModel: { getValue: () => ollama.modelField.value },
    openaiBaseUrl: { getValue: () => compat.baseUrlInput.value },
    openaiModel: { getValue: compat.picker.getValue },
    openaiApiKey: { getValue: () => compat.keyInput.value },
    anthropicApiKey: { getValue: () => anthropic.keyInput.value },
    anthropicModel: { getValue: anthropic.picker.getValue },
    gptApiKey: { getValue: () => gpt.keyInput.value },
    gptModel: { getValue: gpt.picker.getValue },
    geminiApiKey: { getValue: () => gemini.keyInput.value },
    geminiModel: { getValue: gemini.picker.getValue },
  };

  /**
   * 고른 공급자의 모델 목록을 (조건이 되면) 한 번 불러온다. 슬롯이 꺼져 있으면(설정 카드가 숨겨져 있으면)
   * 부르지 않는다 — 켜는 순간에 부른다(spec D10 "폼이 보이는 공급자"). Ollama 목록은 기존 동작 그대로.
   */
  function autoListCurrent(): void {
    const value = providerSelect.value as LlmProvider;
    if (value === "ollama") {
      if (ollama.autoFetch) void ollama.autoFetch();
    } else if (enabledInput.checked) {
      pickers[value].autoLoad();
    }
  }

  /** 지금 고른 공급자 폼만 보인다. */
  function onProviderShown(): void {
    const value = providerSelect.value as LlmProvider;
    for (const provider of LLM_PROVIDERS) forms[provider].style.display = provider === value ? "" : "none";
    autoListCurrent();
  }
  onProviderShown();
  providerSelect.addEventListener("change", onProviderShown);

  // enabled 토글에 따라 config 카드 노출/숨김. 비활성 상태에서도 입력값은 DOM 에 남는다.
  function applyEnabledVisibility(): void {
    configBox.style.display = enabledInput.checked ? "" : "none";
  }
  applyEnabledVisibility();
  enabledInput.addEventListener("change", () => {
    applyEnabledVisibility();
    const value = providerSelect.value as LlmProvider;
    if (enabledInput.checked && value !== "ollama") pickers[value].autoLoad();
  });

  return {
    enabledInput,
    providerSelect,
    ollamaUrlInput: ollama.urlInput,
    ollamaModelSelect: ollama.modelSelect,
    ollamaModelField: ollama.modelField,
    fields,
    pickers,
    keyInputs,
    section,
    configBox,
  };
}
