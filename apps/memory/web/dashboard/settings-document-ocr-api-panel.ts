/**
 * dashboard/settings-document-ocr-api-panel.ts — 문서 OCR "AI API 사용" 패널 (2026-10-11 document-ocr spec 8.1).
 *
 * 업체 다섯 개: Anthropic·OpenAI·Google 은 LLM 슬롯과 같은 폼(키 + 실제 목록 모델 드롭다운 + 직접 입력…),
 * OpenAI 호환은 주소 + 키 + 모델 드롭다운, 파일 업로드 API 는 주소·모델(글 칸)·키. 모델 목록은 slot="ocr" 로
 * 불러와 OCR 전용 키를 쓴다. 모델 이름·업체 주소를 화면 코드에 박아 두지 않는다.
 *
 * 저장 payload 는 고른 업체의 칸만 싣는다. 키 칸이 비면 빼서 서버가 저장된 키를 지킨다.
 */

import { LLM_PROVIDER_SPECS, type LlmApiKeyField } from "../../src/llm/provider-registry";
import {
  DOCUMENT_OCR_API_PROVIDERS,
  isDocumentOcrVisionApiProvider,
  type DocumentOcrApiProvider,
  type DocumentOcrVisionApiProvider,
} from "../../src/settings/document-ocr-api-providers";
import {
  createApiProviderForm,
  createCompatProviderForm,
  type FormContext,
} from "./settings-llm-provider-forms";
import type { ModelPickerHandle } from "./settings-llm-model-picker";
import { CLASS_PROFILE } from "./settings-llm-style";
import { LLM_LABELS } from "./settings-llm-labels";
import { DOCUMENT_OCR_API_PROVIDER_LABELS, DOCUMENT_OCR_LABELS as L } from "./settings-document-ocr-labels";
import type { DocumentOcrSettingsValue } from "./settings-document-ocr-types";
import { createLabeledControl, createSelect, createTextInput } from "./settings-document-ocr-controls";

export interface DocumentOcrApiPanel {
  element: HTMLElement;
  /** documents.ocr.api 에 보낼 조각(고른 업체 칸만). */
  getPayload(): Record<string, unknown>;
  /** 패널이 보일 때 — 고른 업체의 모델 목록을 (키가 있으면) 한 번 불러온다. */
  onShown(): void;
  providerSelect: HTMLSelectElement;
}

interface VisionForm {
  element: HTMLElement;
  keyInput: HTMLInputElement;
  baseUrlInput: HTMLInputElement | null;
  picker: ModelPickerHandle;
}

const ID_PREFIX = "document-ocr-api";

function visionForm(provider: DocumentOcrVisionApiProvider, ctx: FormContext): VisionForm {
  if (provider === "openai_compatible") {
    const form = createCompatProviderForm(
      {
        form: `${ID_PREFIX}-${provider}`,
        baseUrl: `${ID_PREFIX}-${provider}-url`,
        key: `${ID_PREFIX}-${provider}-key`,
        model: `${ID_PREFIX}-${provider}-model`,
      },
      ctx,
      {
        urlLabel: L.compatUrlLabel,
        urlPlaceholder: L.compatUrlPlaceholder,
        urlHint: L.compatUrlHint,
        keyLabel: L.compatKeyLabel,
        keyEmptyHint: L.compatKeyEmptyHint,
      },
    );
    return { element: form.element, keyInput: form.keyInput, baseUrlInput: form.baseUrlInput, picker: form.picker };
  }
  const form = createApiProviderForm(
    provider,
    { form: `${ID_PREFIX}-${provider}`, key: `${ID_PREFIX}-${provider}-key`, model: `${ID_PREFIX}-${provider}-model` },
    ctx,
  );
  return { element: form.element, keyInput: form.keyInput, baseUrlInput: null, picker: form.picker };
}

function fileUploadForm(current: DocumentOcrSettingsValue): {
  element: HTMLElement;
  endpoint: HTMLInputElement;
  model: HTMLInputElement;
  key: HTMLInputElement;
} {
  const element = document.createElement("div");
  element.id = `${ID_PREFIX}-http_file_api`;
  const endpoint = createTextInput(current.api.endpointUrl, { placeholder: L.httpEndpointPlaceholder });
  const model = createTextInput(current.api.model);
  const key = createTextInput("", { type: "password", placeholder: L.httpKeyPlaceholder });
  element.appendChild(createLabeledControl(L.httpEndpointLabel, endpoint));
  element.appendChild(createLabeledControl(L.httpModelLabel, model, L.httpModelHint));
  element.appendChild(
    createLabeledControl(L.httpKeyLabel, key, current.httpFileKeySaved ? LLM_LABELS.keySaved : LLM_LABELS.keyMissing),
  );
  return { element, endpoint, model, key };
}

export function createDocumentOcrApiPanel(current: DocumentOcrSettingsValue): DocumentOcrApiPanel {
  const element = document.createElement("div");
  const providerSelect = createSelect<DocumentOcrApiProvider>(
    current.api.provider,
    DOCUMENT_OCR_API_PROVIDERS.map((value) => ({ value, label: DOCUMENT_OCR_API_PROVIDER_LABELS[value] })),
  );
  element.appendChild(createLabeledControl(L.apiProviderLabel, providerSelect));

  const ctx: FormContext = {
    slotKey: "ocr",
    current: { ...current.api, savedKeyFields: current.savedKeyFields },
    profile: CLASS_PROFILE,
    styling: "class",
    showHints: true,
  };
  const forms = new Map<DocumentOcrVisionApiProvider, VisionForm>();
  for (const provider of DOCUMENT_OCR_API_PROVIDERS) {
    if (!isDocumentOcrVisionApiProvider(provider)) continue;
    const form = visionForm(provider, ctx);
    forms.set(provider, form);
    element.appendChild(form.element);
  }
  const fileForm = fileUploadForm(current);
  element.appendChild(fileForm.element);

  const note = document.createElement("p");
  note.className = "document-ocr-note";
  note.textContent = L.imageOnlyNote;
  element.appendChild(note);

  function selected(): DocumentOcrApiProvider {
    return providerSelect.value as DocumentOcrApiProvider;
  }

  function showSelected(): void {
    const provider = selected();
    for (const [name, form] of forms) form.element.hidden = name !== provider;
    fileForm.element.hidden = provider !== "http_file_api";
    note.hidden = provider === "http_file_api";
  }

  function onShown(): void {
    const provider = selected();
    if (isDocumentOcrVisionApiProvider(provider)) forms.get(provider)?.picker.autoLoad();
  }

  providerSelect.addEventListener("change", () => {
    showSelected();
    onShown();
  });
  showSelected();

  function getPayload(): Record<string, unknown> {
    const provider = selected();
    if (provider === "http_file_api") {
      const payload: Record<string, unknown> = {
        provider,
        endpointUrl: fileForm.endpoint.value.trim(),
        model: fileForm.model.value.trim(),
        responseFormat: current.api.responseFormat,
      };
      if (fileForm.key.value.length > 0) payload.apiKey = fileForm.key.value;
      return payload;
    }
    const form = forms.get(provider)!;
    const spec = LLM_PROVIDER_SPECS[provider];
    const payload: Record<string, unknown> = { provider, [spec.modelField]: form.picker.getValue() };
    if (spec.baseUrlField !== null && form.baseUrlInput) payload[spec.baseUrlField] = form.baseUrlInput.value.trim();
    const key = form.keyInput.value;
    if (spec.apiKeyField !== null && key.length > 0) payload[spec.apiKeyField as LlmApiKeyField] = key;
    return payload;
  }

  return { element, getPayload, onShown, providerSelect };
}
