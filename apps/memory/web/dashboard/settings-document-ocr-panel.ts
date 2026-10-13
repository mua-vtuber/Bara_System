/**
 * dashboard/settings-document-ocr-panel.ts — 설정 › 메모리 › 문서 처리 "스캔 문서 읽기" 패널
 * (settings.ts 에서 옮김 + 2026-10-11 document-ocr spec 8장).
 *
 * 읽는 방법 네 가지: 직접 붙여넣기 / 서버에 설치된 AI(Ollama·LM Studio) / AI API(업체 다섯) / 내 PC 보조 프로그램.
 * 로컬·API 일 때는 서버 처리 상태(settings-document-ocr-status.ts)와 공통 처리 칸(간격·한도·실패 규칙)이 보인다.
 * 설정 읽기는 엄격하다(칸이 없으면 칸 이름 오류 — 기본값으로 메우지 않음). 저장은 지금 보이는 방법의 칸만 싣는다.
 */

import { createAdapterTokenManagementApi } from "./settings-adapter-tokens";
import { showToast } from "./form/toast";
import { DOCUMENT_OCR_LABELS as L } from "./settings-document-ocr-labels";
import {
  readDocumentOcrSettings,
  type DocumentOcrMode,
  type DocumentOcrSettingsValue,
  type VisibleDocumentOcrLocalProvider,
} from "./settings-document-ocr-types";
import { createDocumentOcrApiPanel } from "./settings-document-ocr-api-panel";
import { renderDocumentOcrStatusPanel, type DocumentOcrStatusPanel } from "./settings-document-ocr-status";
import {
  createDocumentOcrNote,
  createLabeledControl,
  createModelSelect,
  createNumberInput,
  createSelect,
  createTextarea,
  createTextInput,
  fetchModelOptions,
  readIntegerInput,
  renderOcrPanelTitle,
  setModelSelectOptions,
} from "./settings-document-ocr-controls";

export interface DocumentOcrPanelDeps {
  /** PUT /settings — 성공하면 true(설정 화면 공통 저장 함수). */
  save: (payload: Record<string, unknown>, status: HTMLElement) => Promise<boolean>;
  createStatus: () => HTMLElement;
  /** 저장 뒤 다시 그릴 때 읽을 지금 설정 응답. */
  currentValue: () => Record<string, unknown>;
}

type AutoStatus = DocumentOcrSettingsValue["pcCompanion"]["allowedStatuses"][number];
const AUTO_STATUSES: readonly AutoStatus[] = ["needs_ocr", "parse_failed", "ocr_failed"];

function isServerOcrMode(mode: DocumentOcrMode): boolean {
  return mode === "local" || mode === "api";
}

function visibleLocalProvider(provider: DocumentOcrSettingsValue["local"]["provider"]): VisibleDocumentOcrLocalProvider {
  return provider === "lmstudio_vision" ? "lmstudio_vision" : "ollama_vision";
}

function localModelActionPath(provider: VisibleDocumentOcrLocalProvider): string {
  return provider === "ollama_vision" ? "/actions/list-ollama-models?capability=vision" : "/actions/list-lmstudio-models";
}

function renderCompanionTokenStatus(root: HTMLElement): void {
  const status = document.createElement("p");
  status.className = "document-ocr-token-status";
  status.textContent = L.tokenChecking;
  root.appendChild(status);
  void createAdapterTokenManagementApi()
    .list()
    .then((data) => {
      const issued = data.issued.some((item) => item.adapterId === "ocr-companion");
      const pending = data.requests.some((item) => item.adapterId === "ocr-companion" && item.status === "pending");
      status.textContent = issued ? L.tokenIssued : pending ? L.tokenPending : L.tokenNone;
    })
    .catch((err: unknown) => {
      status.classList.add("error");
      status.textContent = L.tokenFailed(err instanceof Error ? err.message : String(err));
    });
}

/** 패널 바깥 틀 — 저장 뒤 서버 응답으로 안쪽을 다시 그린다. */
export function renderDocumentOcrSettingsPanelWith(deps: DocumentOcrPanelDeps): HTMLElement {
  const root = document.createElement("section");
  root.className = "document-ocr-settings-panel";
  // 저장 결과 줄은 다시 그려도 그대로 둔다(저장 직후 안내가 사라지지 않게).
  const status = deps.createStatus();
  const mount = () => root.replaceChildren(...renderInner(deps, status, mount), status);
  mount();
  return root;
}

function renderInner(deps: DocumentOcrPanelDeps, status: HTMLElement, remount: () => void): HTMLElement[] {
  const title = document.createElement("h2");
  title.textContent = L.panelTitle;
  let current: DocumentOcrSettingsValue;
  try {
    current = readDocumentOcrSettings(deps.currentValue());
  } catch (err) {
    const error = document.createElement("p");
    error.className = "document-ocr-read-error error";
    error.textContent = L.readFailed(err instanceof Error ? err.message : String(err));
    return [title, error];
  }

  const form = document.createElement("form");
  form.className = "document-ocr-settings-form";
  form.noValidate = true;

  const mode = createSelect<DocumentOcrMode>(current.mode, [
    { value: "manual", label: L.modeManual },
    { value: "local", label: L.modeLocal },
    { value: "api", label: L.modeApi },
    { value: "pc_companion", label: L.modePcCompanion },
  ]);
  const topGrid = document.createElement("div");
  topGrid.className = "document-ocr-grid";
  topGrid.appendChild(createLabeledControl(L.modeLabel, mode));
  form.appendChild(topGrid);

  const statusPanel: DocumentOcrStatusPanel = renderDocumentOcrStatusPanel();
  form.appendChild(statusPanel.element);

  const panels: Record<DocumentOcrMode, HTMLElement> = {
    manual: document.createElement("div"),
    local: document.createElement("div"),
    api: document.createElement("div"),
    pc_companion: document.createElement("div"),
  };
  for (const [panelMode, panel] of Object.entries(panels) as Array<[DocumentOcrMode, HTMLElement]>) {
    panel.className = "document-ocr-mode-panel";
    panel.dataset.mode = panelMode;
    form.appendChild(panel);
  }

  panels.manual.appendChild(renderOcrPanelTitle(L.manualTitle));
  panels.manual.appendChild(createDocumentOcrNote(L.manualNote));

  // ── 서버에 설치된 AI ─────────────────────────────────────────────
  const localProvider = createSelect<VisibleDocumentOcrLocalProvider>(visibleLocalProvider(current.local.provider), [
    { value: "ollama_vision", label: L.localOllama },
    { value: "lmstudio_vision", label: L.localLmStudio },
  ]);
  const localModelValues: Record<VisibleDocumentOcrLocalProvider, string> = {
    ollama_vision: current.local.ollamaModel,
    lmstudio_vision: current.local.lmstudioModel,
  };
  let activeLocalProvider = localProvider.value as VisibleDocumentOcrLocalProvider;
  let localModelRequestId = 0;
  const localModel = createModelSelect(localModelValues[activeLocalProvider], L.modelLoading);
  localModel.addEventListener("change", () => {
    localModelValues[activeLocalProvider] = localModel.value;
  });
  async function loadLocalModels(): Promise<void> {
    const provider = localProvider.value as VisibleDocumentOcrLocalProvider;
    const requestId = ++localModelRequestId;
    const preferredValue = localModelValues[provider];
    setModelSelectOptions(localModel, preferredValue, [], L.modelLoading);
    try {
      const models = await fetchModelOptions(localModelActionPath(provider));
      if (requestId !== localModelRequestId || localProvider.value !== provider) return;
      setModelSelectOptions(localModel, localModelValues[provider], models, L.modelNone);
      localModelValues[provider] = localModel.value;
    } catch (err) {
      if (requestId !== localModelRequestId || localProvider.value !== provider) return;
      setModelSelectOptions(localModel, preferredValue, [], L.modelLoadFailed);
      const label = provider === "ollama_vision" ? L.localOllama : L.localLmStudio;
      showToast(L.modelListFailedToast(label, err instanceof Error ? err.message : String(err)), "error");
    }
  }
  panels.local.appendChild(renderOcrPanelTitle(L.localTitle));
  panels.local.appendChild(createLabeledControl(L.localProviderLabel, localProvider));
  const localModelField = createLabeledControl(L.modelLabel, localModel);
  localModelField.dataset.provider = "selected_local_model";
  panels.local.appendChild(localModelField);
  const ollamaReserve = createNumberInput(current.local.ollamaInputTokenReserve, 256);
  const ollamaReserveField = createLabeledControl(L.ollamaReserveLabel, ollamaReserve, L.ollamaReserveHint);
  panels.local.appendChild(ollamaReserveField);
  localProvider.addEventListener("change", () => {
    localModelValues[activeLocalProvider] = localModel.value;
    activeLocalProvider = localProvider.value as VisibleDocumentOcrLocalProvider;
    ollamaReserveField.hidden = activeLocalProvider !== "ollama_vision";
    void loadLocalModels();
  });
  ollamaReserveField.hidden = activeLocalProvider !== "ollama_vision";

  // ── AI API ──────────────────────────────────────────────────────
  const apiPanel = createDocumentOcrApiPanel(current);
  panels.api.appendChild(renderOcrPanelTitle(L.apiTitle));
  panels.api.appendChild(apiPanel.element);

  // ── 내 PC 보조 프로그램 ─────────────────────────────────────────
  const workerId = createTextInput(current.pcCompanion.workerId);
  const pollSeconds = createNumberInput(current.pcCompanion.pollSeconds);
  const commandSource = createSelect<DocumentOcrSettingsValue["pcCompanion"]["commandSource"]>(current.pcCompanion.commandSource, [
    { value: "local", label: L.pcCommandLocal },
    { value: "server", label: L.pcCommandServer },
  ]);
  const pcCommandJson = createTextarea(current.pcCompanion.commandJson, '["python","ocr.py","{input}","{output}"]');
  const statusChecks = document.createElement("div");
  statusChecks.className = "document-ocr-status-checks";
  const statusInputs = new Map<AutoStatus, HTMLInputElement>();
  for (const status of AUTO_STATUSES) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = current.pcCompanion.allowedStatuses.includes(status);
    statusInputs.set(status, checkbox);
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(status));
    statusChecks.appendChild(label);
  }
  panels.pc_companion.appendChild(renderOcrPanelTitle(L.pcTitle));
  renderCompanionTokenStatus(panels.pc_companion);
  panels.pc_companion.appendChild(createLabeledControl(L.pcServerAddress, createTextInput(location.origin)));
  panels.pc_companion.appendChild(createLabeledControl(L.pcWorkerId, workerId));
  panels.pc_companion.appendChild(createLabeledControl(L.pcPollSeconds, pollSeconds));
  panels.pc_companion.appendChild(createLabeledControl(L.pcCommandSource, commandSource));
  panels.pc_companion.appendChild(createLabeledControl(L.pcCommandJson, pcCommandJson));
  panels.pc_companion.appendChild(createDocumentOcrNote(L.pcCommandNote));
  panels.pc_companion.appendChild(createLabeledControl(L.pcAllowedStatuses, statusChecks));

  // ── 공통 처리 칸(로컬·API) ──────────────────────────────────────
  const scheduleSection = document.createElement("section");
  scheduleSection.className = "document-ocr-mode-panel";
  scheduleSection.dataset.section = "ocr-schedule";
  scheduleSection.appendChild(renderOcrPanelTitle(L.scheduleTitle));
  const scheduleGrid = document.createElement("div");
  scheduleGrid.className = "document-ocr-grid";
  const intervalMin = createNumberInput(current.schedule.intervalMin);
  const batchSize = createNumberInput(current.schedule.batchSize);
  const leaseSeconds = createNumberInput(current.schedule.leaseSeconds, 60);
  const timeoutMs = createNumberInput(current.schedule.timeoutMs, 1000);
  const maxOutput = createNumberInput(current.maxOutputTokensPerPage, 256);
  const pageEdge = createNumberInput(current.pageImage.maxEdgePx, 512);
  const pagesPerCycle = createNumberInput(current.schedule.maxPagesPerCycle);
  const pagesPerDay = createNumberInput(current.schedule.maxPagesPerDay);
  scheduleGrid.appendChild(createLabeledControl(L.intervalLabel, intervalMin));
  scheduleGrid.appendChild(createLabeledControl(L.batchLabel, batchSize));
  scheduleGrid.appendChild(createLabeledControl(L.leaseLabel, leaseSeconds));
  scheduleGrid.appendChild(createLabeledControl(L.timeoutLabel, timeoutMs));
  scheduleGrid.appendChild(createLabeledControl(L.maxOutputLabel, maxOutput, L.maxOutputHint));
  scheduleGrid.appendChild(createLabeledControl(L.pageEdgeLabel, pageEdge, L.pageEdgeHint));
  scheduleGrid.appendChild(createLabeledControl(L.pagesPerCycleLabel, pagesPerCycle));
  scheduleGrid.appendChild(createLabeledControl(L.pagesPerDayLabel, pagesPerDay, L.pagesPerDayHint));
  scheduleSection.appendChild(scheduleGrid);
  const advanced = document.createElement("details");
  const advancedSummary = document.createElement("summary");
  advancedSummary.textContent = L.advancedSummary;
  advanced.appendChild(advancedSummary);
  const maxAttempts = createNumberInput(current.reliability.maxAttemptsPerPage);
  const retryDelay = createNumberInput(current.reliability.retryDelayMinutes);
  const breaker = createNumberInput(current.reliability.circuitBreakerThreshold);
  advanced.appendChild(createLabeledControl(L.maxAttemptsLabel, maxAttempts));
  advanced.appendChild(createLabeledControl(L.retryDelayLabel, retryDelay));
  advanced.appendChild(createLabeledControl(L.breakerLabel, breaker));
  scheduleSection.appendChild(advanced);
  form.appendChild(scheduleSection);

  function updatePanels(): void {
    const selected = mode.value as DocumentOcrMode;
    for (const [panelMode, panel] of Object.entries(panels) as Array<[DocumentOcrMode, HTMLElement]>) {
      panel.hidden = panelMode !== selected;
    }
    const server = isServerOcrMode(selected);
    scheduleSection.hidden = !server;
    statusPanel.element.hidden = !server;
    if (server) void statusPanel.refresh();
    if (selected === "local") void loadLocalModels();
    if (selected === "api") apiPanel.onShown();
  }
  mode.addEventListener("change", updatePanels);
  updatePanels();

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "form-submit";
  submit.textContent = L.save;
  form.appendChild(submit);

  function buildPayload(): Record<string, unknown> {
    const selected = mode.value as DocumentOcrMode;
    const ocr: Record<string, unknown> = { mode: selected };
    if (isServerOcrMode(selected)) {
      ocr.maxOutputTokensPerPage = readIntegerInput(maxOutput, "documents.ocr.maxOutputTokensPerPage");
      ocr.pageImage = { maxEdgePx: readIntegerInput(pageEdge, "documents.ocr.pageImage.maxEdgePx") };
      ocr.schedule = {
        intervalMin: readIntegerInput(intervalMin, "documents.ocr.schedule.intervalMin"),
        batchSize: readIntegerInput(batchSize, "documents.ocr.schedule.batchSize"),
        leaseSeconds: readIntegerInput(leaseSeconds, "documents.ocr.schedule.leaseSeconds"),
        timeoutMs: readIntegerInput(timeoutMs, "documents.ocr.schedule.timeoutMs"),
        maxPagesPerCycle: readIntegerInput(pagesPerCycle, "documents.ocr.schedule.maxPagesPerCycle"),
        maxPagesPerDay: readIntegerInput(pagesPerDay, "documents.ocr.schedule.maxPagesPerDay"),
      };
      ocr.reliability = {
        maxAttemptsPerPage: readIntegerInput(maxAttempts, "documents.ocr.reliability.maxAttemptsPerPage"),
        retryDelayMinutes: readIntegerInput(retryDelay, "documents.ocr.reliability.retryDelayMinutes"),
        circuitBreakerThreshold: readIntegerInput(breaker, "documents.ocr.reliability.circuitBreakerThreshold"),
      };
    }
    if (selected === "local") {
      const provider = localProvider.value as VisibleDocumentOcrLocalProvider;
      localModelValues[provider] = localModel.value;
      ocr.local = {
        provider,
        ollamaModel: localModelValues.ollama_vision,
        lmstudioModel: localModelValues.lmstudio_vision,
        ollamaInputTokenReserve: readIntegerInput(ollamaReserve, "documents.ocr.local.ollamaInputTokenReserve"),
      };
    }
    if (selected === "api") ocr.api = apiPanel.getPayload();
    if (selected === "pc_companion") {
      const allowed = AUTO_STATUSES.filter((s) => statusInputs.get(s)?.checked === true);
      ocr.pcCompanion = {
        workerId: workerId.value,
        pollSeconds: readIntegerInput(pollSeconds, "documents.ocr.pcCompanion.pollSeconds"),
        commandSource: commandSource.value,
        commandJson: pcCommandJson.value,
        // 빈 선택 → 세 상태 전부: 보조 프로그램 칸의 기존 동작(이번 작업 범위 밖 — spec Q10 그대로 둠).
        allowedStatuses: allowed.length > 0 ? allowed : [...AUTO_STATUSES],
      };
    }
    return { documents: { ocr } };
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    let payload: Record<string, unknown>;
    try {
      payload = buildPayload();
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
      status.classList.add("error");
      return;
    }
    if (await deps.save(payload, status)) {
      remount();
      status.textContent = L.savedApplied;
    }
  });

  return [title, form];
}
