/**
 * Settings Page (Phase 5.5 / sub-phase 5.5.7 — W3 + Phase 5.6 W3 → W7 본격 두 슬롯)
 *
 * 페이지 진입 흐름:
 *   1) GET /settings/schema + GET /settings + GET /federation/apps 병렬 호출
 *   2) 메모리 탭 = LLM 두 슬롯 섹션 (Phase 5.6 W7 — 의미 추출 AI + 데이터 정리 AI)
 *      + renderForm(나머지 그룹)
 *   3) 어댑터 탭 = renderAdapterTab — federation 통로 라우트 same-origin 호출 + 자동 폼
 *   4) 메모리 탭 submit = 변경된 슬롯 payload + 나머지 그룹 collectChangedFields
 *      합쳐서 PUT /settings
 *
 * settings.html 이 초기 호스트.
 *
 * Phase 5.6 W7 정착 핵심:
 *   - LLM 공통 슬롯 UX — 두 슬롯 각각
 *     enabled 토글 + provider 드롭다운 + 갈래 동적 폼 + 슬롯별 추가 칸
 *     (extractor: mode 라디오 + backfillIntervalMin / cleanup: intervalDays)
 *   - 갈래 전환 시 form-state 보존 (DOM display:none — silent 데이터 손실 0)
 *   - 저장 시 변경된 슬롯만 PUT body 에 박힘 → mergeShallowGroups + mergeLlmSlots
 *     덕에 다른 슬롯 + 비활성 갈래 옛 4 필드는 디스크에 그대로 살아남음
 *   - 빈 password 명시 생략 → applyMaskingShield 가 옛 키 자동 복원
 */

import { initTheme } from "./ui/theme-switch";
initTheme();

import { renderForm } from "./form/form-renderer";
import type { ManifestAction } from "./form/actions";
import { showToast } from "./form/toast";
import { createActiveModeNoticeCard } from "./active-mode-notice";
import { renderSynonymPanel } from "./synonym-panel";
import { renderEntityManagementPanel } from "./entity-management-panel";
import {
  renderConceptAliasPanel,
  createConceptAliasPanelApi,
} from "./concept-alias-panel";
import { apiFetch } from "./api-fetch";
import { renderNavRail } from "./nav-rail";
import { renderBackupSection } from "./settings-backup-section";
import { STORAGE_LOCATION_LABELS } from "./settings-storage-labels";
import {
  readLlmGroup,
  renderCleanupSection,
  renderSemanticExtractionSection,
} from "./settings-llm-section";
import { renderDangerZone } from "./settings-danger-zone";
import { renderDocumentOcrSettingsPanelWith } from "./settings-document-ocr-panel";
import { DOCUMENT_OCR_API_PROVIDER_LABELS } from "./settings-document-ocr-labels";
import { createDocumentProcessingApi, linkedDocumentId, renderDocumentProcessingPanel } from "./settings-document-processing";
import { renderConnectionDiagnostics } from "./settings-diagnostics";
import { RESTART_LABELS } from "./settings-restart-labels";
import { CLEANUP_EXTRA_LABELS } from "./settings-cleanup-extra-labels.ts";
import { readCleanupExtraValue, renderCleanupExtra } from "./settings-cleanup-extra.ts";
import {
  adapterDescription,
  renderAdapterTokenManagementPanel,
} from "./settings-adapter-tokens";

type SchemaResponse = Record<string, unknown> & {
  properties?: Record<string, unknown>;
};

/** manifest.settings 노출 (Phase 5.5.7 W2 DTO 보강 정합). */
interface FederationAppSettingsDTO {
  schemaPath: string;
  getPath: string;
  putPath: string;
}

/** actions 항목에 path 포함 (Phase 5.5.7 W2 DTO 보강 정합). */
interface FederationAppActionDTO {
  id: string;
  label: string;
  method: "GET" | "POST";
  path: string;
  returns: "toast" | "enum" | "redirect";
  needsConfirm: boolean;
}

interface FederationAppDTO {
  id: string;
  name: string;
  version: string;
  manifestVersion?: number;
  endpoint: string;
  health: "ok" | "down" | "unknown";
  lastHealthCheckAt?: number;
  lastHealthLatencyMs?: number;
  icon?: string;
  description?: string;
  tags?: string[];
  settings: FederationAppSettingsDTO;
  actions: FederationAppActionDTO[];
}

const SETTINGS_BASE = "/settings";
const FEDERATION_BASE = "/federation";
const MEMORY_TAB_ID = "memory";
const SYNONYM_TAB_ID = "synonym";
const ENTITY_MANAGEMENT_TAB_ID = "entity-management";
const ALIAS_TAB_ID = "concept-aliases";
const ADAPTER_MANAGEMENT_TAB_ID = "adapter-management";
const ADAPTER_HEALTH_LABELS: Record<FederationAppDTO["health"], string> = {
  ok: "연결됨",
  down: "연결 불가",
  unknown: "확인 안 됨",
};

type MemorySectionId =
  | "basic"
  | "ai"
  | "cleanup"
  | "documents"
  | "advanced"
  | "implementation";

interface MemorySectionDescriptor {
  id: MemorySectionId;
  label: string;
  description?: string;
}

const MEMORY_SECTIONS: MemorySectionDescriptor[] = [
  {
    id: "basic",
    label: "기본",
  },
  {
    id: "ai",
    label: "자동 처리",
  },
  {
    id: "cleanup",
    label: "정리",
  },
  {
    id: "documents",
    label: "문서",
  },
  {
    id: "advanced",
    label: "운영",
  },
  {
    id: "implementation",
    label: "실험값",
  },
];

const MEMORY_SECTION_PATHS: Record<MemorySectionId, string[]> = {
  basic: ["ui.startPage", "db.path"],
  ai: ["metadataInfer.enabled"],
  cleanup: [
    "autoCleanup.enabled",
    "trashManagement.enabled",
    "trashManagement.retentionDays",
    "trashManagement.warningDays",
  ],
  documents: ["documents.ocr"],
  advanced: [
    "db.host",
    "db.port",
    "writeGuard",
    "metadataInfer.sessionGapMinutes",
    "autoCleanup.valueThreshold",
    "trashManagement.cronTime",
    "reranker.enabled",
    "assets.dir",
    "images.preserveMode",
    "images.passthroughMaxMb",
    "images.animatedPassthroughMaxMb",
    "images.autoConceptLink.enabled",
  ],
  implementation: [
    "metadataInfer.batchSize",
    "cleanupDeepPass.summary.atomicThreshold",
    "cleanupDeepPass.summary.batchSize",
    "cleanupDeepPass.summary.relationConfidenceThreshold",
    "cleanupDeepPass.summary.firstParagraphMaxChars",
    "cleanupDeepPass.summary.searchChannelDefault",
    "cleanupDeepPass.entityRegister.batchSize",
    "autoCleanup.throttleSeconds",
    "search",
    "reranker.model",
    "reranker.topK_input",
    "reranker.topK_output",
    "reranker.maxPairTokens",
    "llm.extractor.maxOutputTokens",
    "reranker.host",
    "valueDecay",
    "images.passthroughMaxPx",
    "images.searchCopyMaxPx",
    "images.searchCopyFormat",
    "images.previewMaxPx",
    "images.searchSimilarityBoost",
    "images.autoConceptLink.threshold",
    "chunking.tokenCap",
    "chunking.minChunkTokens",
    "chunking.maxContextTokens",
    "security",
  ],
};

const MEMORY_SCHEMA_OVERRIDES: Record<
  string,
  { title?: string; description?: string; "x-ui"?: Record<string, unknown> }
> = {
  "db.path": { title: STORAGE_LOCATION_LABELS.dbPathTitle, description: STORAGE_LOCATION_LABELS.dbPathDescription },
  "ui.startPage": {
    title: "첫 화면",
    description: "",
    "x-ui": {
      widget: "select",
      enumLabels: {
        dashboard: "대시보드",
        graph: "그래프",
      },
    },
  },
  "cleanupDeepPass.entityRegister": { title: CLEANUP_EXTRA_LABELS.implementationGroupTitle, description: "" },
  "cleanupDeepPass.entityRegister.batchSize": { title: CLEANUP_EXTRA_LABELS.batchSizeTitle, description: "" },
  metadataInfer: {
    title: "빈 장소·시간 채우기 제안",
    description: "",
  },
  "metadataInfer.enabled": {
    title: "빈 장소·시간 채우기 제안",
    description: "",
  },
  "autoCleanup.enabled": {
    title: "낮은 가치 메모리 휴지통 보내기",
    description: "",
  },
  "trashManagement.enabled": {
    title: "휴지통 자동 관리",
    description: "",
  },
  "trashManagement.retentionDays": {
    title: "휴지통 보관 기간",
    description: "",
  },
  "trashManagement.warningDays": {
    title: "삭제 전 알림 기간",
    description: "",
  },
  cleanupDeepPass: {
    title: "데이터 정리 세부값",
    description: "",
  },
  "cleanupDeepPass.summary": {
    title: "요약·관계 찾기 세부값",
    description: "",
  },
  "db.host": {
    title: "서버 주소",
    description: "",
  },
  "db.port": {
    title: "서버 포트",
    description: "",
  },
  "metadataInfer.sessionGapMinutes": {
    title: "같은 사건으로 볼 시간(분)",
    description: "",
  },
  "metadataInfer.batchSize": {
    title: "한 번에 살펴볼 메모 수",
    description: "",
  },
  "autoCleanup.valueThreshold": {
    title: "휴지통 후보 기준 점수",
    description: "",
  },
  "autoCleanup.throttleSeconds": {
    title: "자동 정리 최소 간격(초)",
    description: "",
  },
  "trashManagement.cronTime": {
    title: "휴지통 정리 시각",
    description: "",
  },
  "assets.dir": { title: STORAGE_LOCATION_LABELS.assetsDirTitle, description: STORAGE_LOCATION_LABELS.assetsDirDescription },
  "images.preserveMode": {
    title: "이미지 저장 방식",
    description: "",
    "x-ui": {
      widget: "select",
      enumLabels: {
        smart: "자동 선택",
        original: "원본 그대로",
        resized: "검색용 사본만",
      },
    },
  },
  "images.passthroughMaxMb": {
    title: "원본 유지 한도(MB)",
    description: "",
  },
  "images.animatedPassthroughMaxMb": {
    title: "움직이는 이미지 원본 한도(MB)",
    description: "",
  },
  "images.autoConceptLink.enabled": {
    title: "이미지 태그 자동 연결",
    description: "",
  },
  "documents.ocr": {
    title: "스캔 문서 읽기",
    description: "",
  },
  "documents.ocr.mode": {
    title: "읽는 방법",
    description: "",
    "x-ui": {
      widget: "select",
      enumLabels: {
        manual: "직접 붙여넣기",
        local: "서버에 설치된 AI로 처리",
        api: "AI API 사용",
        pc_companion: "내 PC 보조 프로그램 사용",
      },
    },
  },
  "documents.ocr.resourceProfile": {
    title: "자원 자동 선택",
    description: "",
    "x-ui": {
      widget: "select",
      enumLabels: {
        low_power: "가볍게",
        balanced: "균형",
        gpu: "GPU 사용",
      },
    },
  },
  "documents.ocr.schedule": {
    title: "처리 주기",
    description: "",
  },
  "documents.ocr.schedule.intervalMin": {
    title: "처리 간격(분)",
    description: "",
  },
  "documents.ocr.schedule.batchSize": {
    title: "한 번에 처리할 문서 수",
    description: "",
  },
  "documents.ocr.schedule.leaseSeconds": {
    title: "작업 보관 시간(초)",
    description: "",
  },
  "documents.ocr.schedule.timeoutMs": {
    title: "처리 제한 시간(ms)",
    description: "",
  },
  "documents.ocr.local": {
    title: "서버에 설치된 AI",
    description: "",
  },
  "documents.ocr.local.provider": {
    title: "선택 AI",
    description: "",
    "x-ui": {
      widget: "select",
      enumLabels: {
        ollama_vision: "Ollama",
        lmstudio_vision: "LM Studio",
        command: "직접 실행 명령",
      },
    },
  },
  "documents.ocr.local.ollamaUrl": {
    title: "Ollama 연결(고급)",
    description: "",
  },
  "documents.ocr.local.ollamaModel": {
    title: "Ollama 모델",
    description: "",
  },
  "documents.ocr.local.lmstudioUrl": {
    title: "LM Studio 연결(고급)",
    description: "",
  },
  "documents.ocr.local.lmstudioModel": {
    title: "LM Studio 모델",
    description: "",
  },
  "documents.ocr.local.commandJson": {
    title: "직접 실행 명령(JSON)",
    description: "",
  },
  "documents.ocr.api": {
    title: "AI API 사용",
    description: "",
  },
  "documents.ocr.api.provider": {
    title: "API 업체",
    description: "",
    "x-ui": {
      widget: "select",
      enumLabels: DOCUMENT_OCR_API_PROVIDER_LABELS,
    },
  },
  "documents.ocr.api.endpointUrl": {
    title: "API 연결(고급)",
    description: "",
  },
  "documents.ocr.api.model": {
    title: "모델",
    description: "",
  },
  "documents.ocr.api.apiKey": {
    title: "API 키",
    description: "",
  },
  "documents.ocr.api.responseFormat": {
    title: "응답 형식",
    description: "",
    "x-ui": {
      widget: "select",
      enumLabels: {
        markdown: "Markdown",
        json_markdown: "JSON 안의 Markdown",
      },
    },
  },
  "documents.ocr.pcCompanion": {
    title: "내 PC 보조 프로그램",
    description: "",
  },
  "documents.ocr.pcCompanion.workerId": {
    title: "보조 프로그램 ID",
    description: "",
  },
  "documents.ocr.pcCompanion.pollSeconds": {
    title: "확인 간격(초)",
    description: "",
  },
  "documents.ocr.pcCompanion.commandSource": {
    title: "명령 사용 방식",
    description: "",
    "x-ui": {
      widget: "select",
      enumLabels: {
        local: "PC 쪽 명령만",
        server: "서버 설정 명령 허용",
      },
    },
  },
  "documents.ocr.pcCompanion.commandJson": {
    title: "서버 제공 명령(JSON)",
    description: "",
  },
  "documents.ocr.pcCompanion.allowedStatuses": {
    title: "자동 처리할 상태",
    description: "",
  },
  search: {
    title: "검색 점수 기준",
    description: "",
  },
  "search.mergeSimThreshold": {
    title: "중복으로 볼 기준",
    description: "",
  },
  "search.conflictCheckMin": {
    title: "충돌 검사 시작 기준",
    description: "",
  },
  "search.conflictSameMax": {
    title: "같은 사실로 볼 기준",
    description: "",
  },
  "search.mentionBoost": {
    title: "사람 이름 보너스",
    description: "",
  },
  "search.precisionStrengthWeight": {
    title: "정확히 닮은 결과 보너스",
    description: "",
  },
  "search.baselineFloorMode": {
    title: "낮은 유사도 처리",
    description: "",
    "x-ui": {
      widget: "select",
      enumLabels: {
        off: "그대로 사용",
        gate: "낮은 값 제외",
        "tmm-min": "낮은 값을 기준점으로",
      },
    },
  },
  "search.baselineVectorCosine": {
    title: "글 유사도 하한",
    description: "",
  },
  "search.baselineImageVecCosine": {
    title: "이미지 유사도 하한",
    description: "",
  },
  reranker: {
    title: "검색 결과 재정렬",
    description: "",
  },
  "reranker.enabled": {
    title: "검색 결과 재정렬",
    description: "",
  },
  "reranker.model": {
    title: "재정렬 모델",
    description: "",
  },
  "reranker.topK_input": {
    title: "재정렬할 후보 수",
    description: "",
  },
  "reranker.topK_output": {
    title: "최종 결과 수",
    description: "",
  },
  "reranker.maxPairTokens": {
    title: "재정렬 글 길이 한도(토큰)",
    description: "",
  },
  // 추출 출력 한도는 스키마 설명(한도·시간 제한·Ollama 창 관계)이 사용자에게 보여야 해서 빈 설명으로 덮지 않고 표시만 켠다(spec 3.1).
  "llm.extractor.maxOutputTokens": { "x-ui": { showDescription: true } },
  "reranker.host": {
    title: "재정렬 실행 위치",
    description: "",
  },
  valueDecay: {
    title: "시간이 지난 메모리 점수",
    description: "",
  },
  "valueDecay.importanceDecay": {
    title: "중요도 감소 속도",
    description: "",
  },
  "valueDecay.recencyHalfLifeDays": {
    title: "최근성 반감기(일)",
    description: "",
  },
  "valueDecay.importanceHalfLifeDays": {
    title: "중요도 반감기(일)",
    description: "",
  },
  "cleanupDeepPass.summary.atomicThreshold": {
    title: "요약할 청크 기준",
    description: "",
  },
  "cleanupDeepPass.summary.batchSize": {
    title: "한 번에 요약할 청크 수",
    description: "",
  },
  "cleanupDeepPass.summary.relationConfidenceThreshold": {
    title: "관계 연결 기준",
    description: "",
  },
  "cleanupDeepPass.summary.firstParagraphMaxChars": {
    title: "대체 요약 길이",
    description: "",
  },
  "cleanupDeepPass.summary.searchChannelDefault": {
    title: "요약도 검색에 포함",
    description: "",
  },
  "images.passthroughMaxPx": {
    title: "원본 유지 한도(px)",
    description: "",
  },
  "images.searchCopyMaxPx": {
    title: "검색용 사본 한도(px)",
    description: "",
  },
  "images.searchCopyFormat": {
    title: "검색용 사본 형식",
    description: "",
  },
  "images.previewMaxPx": {
    title: "미리보기 크기(px)",
    description: "",
  },
  "images.searchSimilarityBoost": {
    title: "이미지 검색 보너스",
    description: "",
  },
  "images.autoConceptLink.threshold": {
    title: "이미지 태그 연결 기준",
    description: "",
  },
  "chunking.tokenCap": {
    title: "청크 길이 한도",
    description: "",
  },
  "chunking.minChunkTokens": {
    title: "짧은 청크 합치기 기준",
    description: "",
  },
  "chunking.maxContextTokens": {
    title: "주변 청크 함께 보기 한도",
    description: "",
  },
  security: {
    title: "입력 크기 제한",
    description: "",
  },
  "security.maxTextBytes": {
    title: "글 입력 크기 제한",
    description: "",
  },
  "security.maxAssetBytes": {
    title: "파일 입력 크기 제한",
    description: "",
  },
};

/** GET → JSON 헬퍼. 실패 시 throw — silent fallback 금지. */
async function fetchJson<T>(url: string): Promise<T> {
  const res = await apiFetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${url} 실패 — HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  return (await res.json()) as T;
}

export interface InitState {
  schema: SchemaResponse;
  value: Record<string, unknown>;
  apps: FederationAppDTO[];
}

async function loadInitState(): Promise<InitState> {
  const [schema, value, federation] = await Promise.all([
    fetchJson<SchemaResponse>(`${SETTINGS_BASE}/schema`),
    fetchJson<Record<string, unknown>>(`${SETTINGS_BASE}/`),
    fetchJson<{ apps: FederationAppDTO[] }>(`${FEDERATION_BASE}/apps`),
  ]);
  if (!Array.isArray(federation.apps)) {
    throw new Error(
      `GET /federation/apps 응답에 apps 배열이 없다 — 응답: ${JSON.stringify(federation)}`,
    );
  }
  return { schema, value, apps: federation.apps };
}

function clearChildren(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

interface TabDescriptor {
  id: string;
  label: string;
  health?: "ok" | "down" | "unknown";
  render: (panel: HTMLElement) => void | Promise<void>;
}

function renderTabBar(
  bar: HTMLElement,
  panel: HTMLElement,
  tabs: TabDescriptor[],
  initialId: string,
): void {
  clearChildren(bar);
  const buttons = new Map<string, HTMLButtonElement>();

  function activate(id: string): void {
    for (const [tabId, btn] of buttons.entries()) {
      btn.setAttribute("aria-selected", tabId === id ? "true" : "false");
    }
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    clearChildren(panel);
    const loading = document.createElement("p");
    loading.className = "panel-loading";
    loading.textContent = "불러오는 중...";
    panel.appendChild(loading);
    Promise.resolve(tab.render(panel)).catch((err: unknown) => {
      clearChildren(panel);
      const errBox = document.createElement("p");
      errBox.className = "panel-error";
      errBox.textContent =
        err instanceof Error ? err.message : String(err);
      panel.appendChild(errBox);
    });
  }

  for (const tab of tabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab-button";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", "false");
    btn.dataset.tabId = tab.id;
    btn.textContent = tab.label;
    if (tab.health) {
      const badge = document.createElement("span");
      badge.className = `tab-health ${tab.health}`;
      badge.textContent = ADAPTER_HEALTH_LABELS[tab.health];
      btn.appendChild(badge);
    }
    btn.addEventListener("click", () => activate(tab.id));
    buttons.set(tab.id, btn);
    bar.appendChild(btn);
  }

  activate(initialId);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("schema node 가 객체가 아니다");
  }
  return value as Record<string, unknown>;
}

function getSchemaProperties(node: unknown): Record<string, unknown> {
  const props = asRecord(node).properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    return {};
  }
  return props as Record<string, unknown>;
}

function pickSchemaPath(source: unknown, parts: string[]): unknown {
  if (parts.length === 0) return cloneJson(source);
  const key = parts[0];
  if (key === undefined) {
    throw new Error("settings schema 경로가 비어 있다");
  }
  const rest = parts.slice(1);
  const props = getSchemaProperties(source);
  const child = props[key];
  if (!child) {
    throw new Error(`settings schema 경로를 찾을 수 없다: ${parts.join(".")}`);
  }
  const shell = cloneJson(source) as Record<string, unknown>;
  shell.properties = { [key]: pickSchemaPath(child, rest) };
  const required = shell.required;
  if (Array.isArray(required)) {
    shell.required = required.filter((item) => item === key);
  }
  return shell;
}

function mergeSchemaNode(target: Record<string, unknown>, picked: unknown): void {
  const pickedRec = asRecord(picked);
  const pickedProps = getSchemaProperties(pickedRec);
  if (!target.properties || typeof target.properties !== "object") {
    target.properties = {};
  }
  const targetProps = target.properties as Record<string, unknown>;
  for (const [key, pickedChild] of Object.entries(pickedProps)) {
    const existing = targetProps[key];
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      Object.keys(getSchemaProperties(existing)).length > 0 &&
      Object.keys(getSchemaProperties(pickedChild)).length > 0
    ) {
      mergeSchemaNode(existing as Record<string, unknown>, pickedChild);
    } else {
      targetProps[key] = cloneJson(pickedChild);
    }
  }

  const pickedRequired = pickedRec.required;
  if (Array.isArray(pickedRequired)) {
    const current = Array.isArray(target.required)
      ? (target.required as unknown[])
      : [];
    target.required = Array.from(new Set([...current, ...pickedRequired]));
  }
}

function getSchemaNode(root: unknown, path: string): Record<string, unknown> | null {
  let cursor: unknown = root;
  for (const part of path.split(".").filter(Boolean)) {
    const props = getSchemaProperties(cursor);
    cursor = props[part];
    if (!cursor) return null;
  }
  return asRecord(cursor);
}

function applyFriendlySchemaLabels(schema: SchemaResponse): void {
  for (const [path, override] of Object.entries(MEMORY_SCHEMA_OVERRIDES)) {
    const node = getSchemaNode(schema, path);
    if (!node) continue;
    if (override.title) node.title = override.title;
    if ("description" in override) node.description = override.description;
    if (override["x-ui"]) {
      const prev =
        node["x-ui"] && typeof node["x-ui"] === "object"
          ? (node["x-ui"] as Record<string, unknown>)
          : {};
      node["x-ui"] = { ...prev, ...override["x-ui"] };
    }
  }
}

function inlineImplementationSingletonGroups(
  schema: Record<string, unknown>,
  sectionId: MemorySectionId,
): void {
  if (sectionId !== "implementation") return;
  const cleanupDeepPass = getSchemaNode(schema, "cleanupDeepPass");
  if (!cleanupDeepPass) return;
  const childKeys = Object.keys(getSchemaProperties(cleanupDeepPass));
  if (childKeys.length !== 1 || childKeys[0] !== "summary") return;
  const prev =
    cleanupDeepPass["x-ui"] && typeof cleanupDeepPass["x-ui"] === "object"
      ? (cleanupDeepPass["x-ui"] as Record<string, unknown>)
      : {};
  cleanupDeepPass["x-ui"] = { ...prev, widget: "inline-object" };
}

export function createMemorySectionSchema(
  schema: SchemaResponse,
  sectionId: MemorySectionId,
): SchemaResponse {
  const section = MEMORY_SECTIONS.find((item) => item.id === sectionId);
  if (!section) throw new Error(`알 수 없는 메모리 설정 섹션: ${sectionId}`);

  const scoped = cloneJson(schema) as Record<string, unknown>;
  scoped.title = section.label;
  scoped.description = section.description ?? "";
  scoped.properties = {};
  scoped.required = [];

  for (const path of MEMORY_SECTION_PATHS[sectionId]) {
    mergeSchemaNode(scoped, pickSchemaPath(schema, path.split(".")));
  }
  applyFriendlySchemaLabels(scoped as SchemaResponse);
  inlineImplementationSingletonGroups(scoped, sectionId);
  return scoped as SchemaResponse;
}

function createSectionIntro(sectionId: MemorySectionId): HTMLElement {
  const section = MEMORY_SECTIONS.find((item) => item.id === sectionId);
  if (!section) throw new Error(`알 수 없는 메모리 설정 섹션: ${sectionId}`);
  const intro = document.createElement("div");
  intro.className = "memory-section-intro";
  const title = document.createElement("h2");
  title.textContent = section.label;
  intro.appendChild(title);
  if (section.description) {
    const desc = document.createElement("p");
    desc.textContent = section.description;
    intro.appendChild(desc);
  }
  return intro;
}

function createSaveStatus(): HTMLParagraphElement {
  const status = document.createElement("p");
  status.className = "save-status";
  status.textContent = "";
  return status;
}

function hasPayload(payload: Record<string, unknown>): boolean {
  return Object.keys(payload).length > 0;
}

/** 저장 결과 — 실제로 저장했으면 true(바뀐 것이 없거나 실패하면 false). */
async function saveMemorySettings(
  state: InitState,
  payload: Record<string, unknown>,
  status: HTMLElement,
): Promise<boolean> {
  if (!hasPayload(payload)) {
    status.textContent = "바뀐 설정이 없습니다.";
    status.classList.remove("error");
    return false;
  }

  status.textContent = "저장 중...";
  status.classList.remove("error");
  try {
    const res = await apiFetch(`${SETTINGS_BASE}/`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      errors?: string[];
    } & Record<string, unknown>;
    if (!res.ok) {
      const detail = Array.isArray(body.errors)
        ? body.errors.join("\n")
        : body.error ?? `HTTP ${res.status}`;
      throw new Error(detail);
    }
    state.value = body;
    status.textContent = RESTART_LABELS.savedNeedsRestart;
    status.classList.remove("error");
    showToast("설정 저장 완료", "success");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    status.textContent = `저장 실패: ${message}`;
    status.classList.add("error");
    showToast(`저장 실패: ${message}`, "error");
    return false;
  }
}

function renderScopedSettingsForm(
  host: HTMLElement,
  state: InitState,
  sectionId: MemorySectionId,
  transformPayload?: (payload: Record<string, unknown>) => Record<string, unknown>,
  onSaved?: () => void,
): void {
  const originalValue = cloneJson(state.value);
  const schema = createMemorySectionSchema(state.schema, sectionId);
  const status = createSaveStatus();
  const form = renderForm({
    schema: schema as Parameters<typeof renderForm>[0]["schema"],
    initialValue: state.value,
    originalValue,
    onSubmit: async (payload) => {
      const finalPayload = transformPayload ? transformPayload(payload) : payload;
      const saved = await saveMemorySettings(state, finalPayload, status);
      if (saved && onSaved) onSaved();
    },
  });
  host.appendChild(form.element);
  host.appendChild(status);
}

function renderBasicMemorySection(host: HTMLElement, state: InitState): void {
  host.appendChild(createSectionIntro("basic"));
  renderScopedSettingsForm(host, state, "basic");
}

function renderAiMemorySection(host: HTMLElement, state: InitState): void {
  host.appendChild(createSectionIntro("ai"));
  // 저장 뒤에는 서버 응답(state.value — 가린 키 + $secretsSet)으로 LLM 칸을 다시 그린다. 그래야 "저장된 키가
  // 있습니다" 안내가 뜨고, 키 칸이 비워져 다음 저장 때 같은 키를 다시 보내지 않으며, 변경 감지 기준도 새 값이 된다.
  const llmHost = document.createElement("div");
  host.appendChild(llmHost);
  const mount = () => {
    const section = renderSemanticExtractionSection(
      readLlmGroup(state.value),
      readLlmGroup(cloneJson(state.value)),
    );
    llmHost.replaceChildren(section.element);
    return section;
  };
  let semantic = mount();
  renderScopedSettingsForm(
    host,
    state,
    "ai",
    (payload) => {
      const finalPayload: Record<string, unknown> = { ...payload };
      if (semantic.isChanged()) {
        finalPayload.llm = semantic.getChangedSlotsPayload();
      }
      return finalPayload;
    },
    () => {
      semantic = mount();
    },
  );
}

export function buildCleanupLinkedPayload(
  cleanupEnabled: boolean,
  entityRegisterAutoApply: boolean,
): Record<string, unknown> {
  return {
    cleanupDeepPass: {
      regexStrengthen: { enabled: cleanupEnabled },
      summary: { enabled: cleanupEnabled },
      // 2026-10-10 spec 7.1 — 항목·일정 자동 등록 단계도 정리 AI 스위치와 함께 켜진다.
      entityRegister: { enabled: cleanupEnabled, autoApply: entityRegisterAutoApply },
    },
  };
}

export { renderDocumentProcessingPanel, createDocumentProcessingApi } from "./settings-document-processing";

/** 문서 OCR 설정 패널 — 본체는 settings-document-ocr-panel.ts, 저장은 이 화면의 공통 저장 함수. */
export function renderDocumentOcrSettingsPanel(state: InitState): HTMLElement {
  return renderDocumentOcrSettingsPanelWith({
    save: (payload, status) => saveMemorySettings(state, payload, status),
    createStatus: createSaveStatus,
    currentValue: () => state.value,
  });
}

/** 서버 자동 처리 모드(로컬·API)인지 — 문서 카드의 "서버에서 다시 읽기" 버튼을 보일지. */
function isServerOcrModeValue(value: Record<string, unknown>): boolean {
  const ocr = (value.documents as { ocr?: { mode?: unknown } } | undefined)?.ocr;
  return ocr?.mode === "local" || ocr?.mode === "api";
}

function renderCleanupMemorySection(host: HTMLElement, state: InitState): void {
  host.appendChild(createSectionIntro("cleanup"));

  // 저장 뒤에는 서버 응답으로 정리 AI 칸(+ 정리 시점 조각)을 다시 그린다(키 저장 안내·키 칸 비우기·변경 기준 갱신).
  const cleanupHost = document.createElement("div");
  host.appendChild(cleanupHost);
  const mount = () => {
    const section = renderCleanupSection(
      readLlmGroup(state.value).cleanup,
      readLlmGroup(cloneJson(state.value)).cleanup,
    );
    const extraPart = renderCleanupExtra(readCleanupExtraValue(state.value), section.interval);
    cleanupHost.replaceChildren(section.element, extraPart.element);
    return { cleanup: section, extra: extraPart };
  };
  let { cleanup, extra } = mount();

  const included = document.createElement("div");
  included.className = "memory-info-note";
  included.textContent =
    "데이터 정리 AI를 켜면 긴 문서 요약과 관계 찾기도 포함됩니다. 세부 기준은 ‘실험값’ 메뉴에서 조정할 수 있습니다.";
  host.appendChild(included);

  renderScopedSettingsForm(
    host,
    state,
    "cleanup",
    (payload) => {
      const cleanupPayload = cleanup.getPayload();
      const cleanupEnabled = cleanupPayload.enabled === true;
      return {
        ...payload,
        llm: { cleanup: { ...cleanupPayload, trigger: extra.getTrigger() } },
        ...buildCleanupLinkedPayload(cleanupEnabled, extra.getAutoApply()),
      };
    },
    () => {
      ({ cleanup, extra } = mount());
    },
  );
}

function renderDocumentMemorySection(host: HTMLElement, state: InitState): void {
  host.appendChild(createSectionIntro("documents"));
  host.appendChild(
    renderDocumentProcessingPanel(createDocumentProcessingApi(), { serverOcrEnabled: isServerOcrModeValue(state.value) }),
  );
  host.appendChild(renderDocumentOcrSettingsPanel(state));
}

function renderAdvancedMemorySection(host: HTMLElement, state: InitState): void {
  host.appendChild(createSectionIntro("advanced"));
  const warning = document.createElement("p");
  warning.className = "memory-advanced-note";
  warning.textContent =
    "서버 연결과 보관 방식을 설정합니다. 검색·처리 기준을 세밀하게 조정하려면 ‘실험값’ 메뉴를 이용하세요.";
  host.appendChild(warning);
  renderScopedSettingsForm(host, state, "advanced");
  host.appendChild(renderBackupSection());
  host.appendChild(renderDangerZone());
}

function renderImplementationMemorySection(host: HTMLElement, state: InitState): void {
  host.appendChild(createSectionIntro("implementation"));
  const warning = document.createElement("p");
  warning.className = "memory-advanced-note";
  warning.textContent =
    "메모리 처리 결과를 비교하며 조정하는 고급 설정입니다. 특별히 조정할 필요가 없다면 기본값을 유지하세요.";
  host.appendChild(warning);
  renderScopedSettingsForm(host, state, "implementation");
}

function renderMemorySubsection(
  host: HTMLElement,
  state: InitState,
  sectionId: MemorySectionId,
): void {
  clearChildren(host);
  if (sectionId === "basic") renderBasicMemorySection(host, state);
  else if (sectionId === "ai") renderAiMemorySection(host, state);
  else if (sectionId === "cleanup") renderCleanupMemorySection(host, state);
  else if (sectionId === "documents") renderDocumentMemorySection(host, state);
  else if (sectionId === "advanced") renderAdvancedMemorySection(host, state);
  else renderImplementationMemorySection(host, state);
}

export function renderMemoryTab(
  panel: HTMLElement,
  state: InitState,
): void {
  clearChildren(panel);

  const layout = document.createElement("div");
  layout.className = "memory-settings-layout";
  const nav = document.createElement("nav");
  nav.className = "memory-settings-nav";
  nav.setAttribute("aria-label", "메모리 설정 세부 메뉴");
  const content = document.createElement("section");
  content.className = "memory-settings-content";

  const buttons = new Map<MemorySectionId, HTMLButtonElement>();
  function activate(sectionId: MemorySectionId): void {
    for (const [id, button] of buttons.entries()) {
      button.setAttribute("aria-selected", id === sectionId ? "true" : "false");
    }
    renderMemorySubsection(content, state, sectionId);
  }

  for (const section of MEMORY_SECTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "memory-settings-nav-button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", "false");
    button.textContent = section.label;
    button.addEventListener("click", () => activate(section.id));
    buttons.set(section.id, button);
    nav.appendChild(button);
  }

  layout.appendChild(nav);
  layout.appendChild(content);
  panel.appendChild(layout);
  activate(linkedDocumentId() ? "documents" : "basic");
}


/**
 * 동의어 설정 탭 렌더링 (웨이브3 항목12 B3).
 *
 * 사용자가 검색 동의어를 직접 추가·삭제하는 통로. 기본 사전(yaml) 쌍은 출처
 * "기본" 으로 읽기전용 표시하고, 사용자가 추가한 쌍만 삭제 버튼이 붙는다.
 * renderSynonymPanel 이 createSynonymPanelApi() 로 B2 라우트(/api/synonyms)를
 * same-origin 호출한다. query expansion 이 BM25/FTS 키워드 검색에만 들어가고
 * 임베딩 검색엔 안 들어가는 한계는 패널 위 고정 안내문으로 노출한다(조용한
 * fallback 금지). 목록 0건은 "등록된 동의어 없음" 안내만 — 가짜 샘플 0.
 */
function renderSynonymTab(panel: HTMLElement): void {
  clearChildren(panel);
  panel.appendChild(renderSynonymPanel());
}

/**
 * 엔티티 관리 통합 탭 렌더링 (엔티티 관리 통합 S6).
 *
 * 옛 '분류 어휘'·'엔티티 종류' 두 탭을 한 표로 합친다. 한 행 = 한 엔티티 종류. 분류 이름
 * (표시명 + 동의어)·영문키(type_name)·하위분류·칸·라벨을 한자리에서 보고, 코드 10종·기본
 * 어휘는 읽기전용·사용자가 더한 종류·어휘만 삭제한다. renderEntityManagementPanel 이
 * createEntityManagementPanelApi() 로 기존 세 라우트(/api/entity-types·/api/classify-vocab·
 * /api/relation-vocab)를 병렬 호출해 조인한다(새 라우트 없음). 라벨 칸에서 관계 키('주인'
 * 등)는 빠지고, 끈 값(가림표)도 칩에서 빠진다. fetch 실패 시 명시 에러(빈 표 위장 0).
 * 추가·수정 모달은 엔티티 관리 패널이 배선한다.
 */
function renderEntityManagementTab(panel: HTMLElement): void {
  clearChildren(panel);
  panel.appendChild(renderEntityManagementPanel());
}

/**
 * 별칭 후보 게이트 탭 렌더링 (Phase 6b T10 / 사용자 결정 1 = 대시보드 게이트).
 *
 * 메모리가 0.95+ 로 가까운 두 개념을 찾으면 자동 합류 대신 여기 후보로 쌓아 둔다.
 * 사용자가 두 개념과 유사도를 보고 [합치기]/[거절] 을 직접 누른다(자동 합류 금지).
 * createConceptAliasPanelApi() 가 T10 라우트(/api/concept-aliases)를 same-origin
 * 호출한다. 후보 0건은 "후보 없음" 안내만 — 빈 목록으로 가리지 않는다.
 */
function renderConceptAliasTab(panel: HTMLElement): void {
  clearChildren(panel);
  panel.appendChild(renderConceptAliasPanel(createConceptAliasPanelApi()));
}

function renderAdapterManagementTab(panel: HTMLElement): void {
  clearChildren(panel);
  panel.appendChild(renderAdapterTokenManagementPanel());
}

/**
 * 어댑터 탭 렌더링 (Phase 5.5.7 W3).
 *
 * 진입 흐름:
 *   1) 헤더 (이름 + 버전 + endpoint + description + health 배지) 표시.
 *   2) health = down → 안내 메시지 + 폼 차단.
 *   3) health = ok →
 *      - GET /federation/apps/:id/schema 호출 → 어댑터 schema 수신
 *      - GET /federation/apps/:id/settings 호출 → 현재 settings 수신
 *      - renderForm 호출 (메모리 탭 패턴 그대로)
 *      - submit = PUT /federation/apps/:id/settings
 *      - appContext.actions = manifest.actions 그대로, endpoint = /federation/apps/:id/actions 통로
 *   4) 저장 후 토스트 + 상태 메시지.
 *
 * fetch 실패 시 명시 에러 UI — 자동 빈 폼 / mock 데이터 없음.
 */
async function renderAdapterTab(
  panel: HTMLElement,
  app: FederationAppDTO,
): Promise<void> {
  clearChildren(panel);

  // ── 헤더 ───────────────────────────────────────────────────────────────────

  const header = document.createElement("div");
  header.className = "adapter-header";
  header.style.cssText = "margin-bottom:12px;display:flex;flex-direction:column;gap:4px;";

  const titleRow = document.createElement("div");
  titleRow.style.cssText = "display:flex;align-items:center;gap:8px;";

  const title = document.createElement("h2");
  title.style.cssText = "margin:0;font-size:1.05rem;";
  title.textContent = `${app.name} v${app.version}`;
  titleRow.appendChild(title);

  const healthBadge = document.createElement("span");
  healthBadge.className = `adapter-health-badge ${app.health}`;
  healthBadge.style.cssText =
    "font-size:0.75rem;padding:2px 7px;border-radius:10px;font-weight:600;" +
    (app.health === "ok"
      ? "background:#d6f0e0;color:#1e6b3c;"
      : app.health === "down"
        ? "background:#fde8e8;color:#c0392b;"
        : "background:#f0f0f0;color:#707070;");
  healthBadge.textContent = ADAPTER_HEALTH_LABELS[app.health];
  titleRow.appendChild(healthBadge);
  header.appendChild(titleRow);

  const meta = document.createElement("p");
  meta.style.cssText = "margin:0;font-size:0.82rem;color:var(--text-dim);";
  meta.textContent = `연결 주소: ${app.endpoint}`;
  header.appendChild(meta);

  if (app.description) {
    const desc = document.createElement("p");
    desc.style.cssText = "margin:0;font-size:0.88rem;color:var(--text-soft);";
    desc.textContent = adapterDescription(app.id, app.description);
    header.appendChild(desc);
  }

  panel.appendChild(header);

  // ── 능동 모드 안내 카드 (Phase 5.7.1 W6) ─────────────────────────────────
  // 봇 어댑터(`bot-discord`) 한정 정적 안내 — Phase 10 정착 전까지 입력 칸 0.
  // 다른 어댑터는 null 반환 → 아무것도 박지 않는다.
  const activeModeNotice = createActiveModeNoticeCard(app.id);
  if (activeModeNotice !== null) {
    panel.appendChild(activeModeNotice);
  }

  // ── health = down → 안내 + 폼 차단 ─────────────────────────────────────────

  if (app.health !== "ok") {
    const notice = document.createElement("p");
    notice.className = "panel-placeholder";
    notice.style.cssText = "color:#d23535;margin-top:8px;";
    notice.textContent =
      "연결을 확인할 수 없어 설정을 불러오지 못했습니다. 앱의 실행 상태와 연결 주소를 확인한 뒤 페이지를 새로고침하세요.";
    panel.appendChild(notice);
    return;
  }

  // ── health = ok → schema + settings 가져온 뒤 폼 렌더링 ───────────────────

  const schemaUrl = `${FEDERATION_BASE}/apps/${app.id}/schema`;
  const settingsUrl = `${FEDERATION_BASE}/apps/${app.id}/settings`;

  let schema: SchemaResponse;
  let currentSettings: Record<string, unknown>;

  try {
    [schema, currentSettings] = await Promise.all([
      fetchJson<SchemaResponse>(schemaUrl),
      fetchJson<Record<string, unknown>>(settingsUrl),
    ]);
  } catch (err) {
    const errBox = document.createElement("p");
    errBox.className = "panel-error";
    errBox.textContent =
      err instanceof Error
        ? `어댑터 설정 불러오기 실패: ${err.message}`
        : `어댑터 설정 불러오기 실패: ${String(err)}`;
    panel.appendChild(errBox);
    return;
  }

  const originalValue = JSON.parse(
    JSON.stringify(currentSettings),
  ) as Record<string, unknown>;

  // 어댑터 actions — manifest.actions 를 ManifestAction 형태로 그대로 사용.
  // endpoint 는 메모리 federation 통로 (/federation/apps/:id/actions) 로 지정.
  const adapterActionsEndpoint = `${FEDERATION_BASE}/apps/${app.id}/actions`;
  const adapterActions: ManifestAction[] = app.actions.map((a) => ({
    id: a.id,
    label: a.label,
    method: a.method,
    path: `/${a.id}`,
    returns: a.returns,
    needsConfirm: a.needsConfirm,
  }));

  const status = document.createElement("p");
  status.className = "save-status";
  status.textContent = "";

  const form = renderForm({
    schema: schema as Parameters<typeof renderForm>[0]["schema"],
    initialValue: currentSettings,
    originalValue,
    appContext: {
      endpoint: adapterActionsEndpoint,
      actions: adapterActions,
    },
    onSubmit: async (payload) => {
      status.textContent = "저장 중...";
      status.classList.remove("error");
      try {
        const res = await apiFetch(`${FEDERATION_BASE}/apps/${app.id}/settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          errors?: string[];
        };
        if (!res.ok) {
          const detail = Array.isArray(body.errors)
            ? body.errors.join("\n")
            : body.error ?? `HTTP ${res.status}`;
          throw new Error(detail);
        }
        status.textContent = "저장 완료 — 어댑터가 새 설정을 반영한다.";
        status.classList.remove("error");
        showToast("어댑터 설정 저장 완료", "success");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        status.textContent = `저장 실패: ${message}`;
        status.classList.add("error");
        showToast(`저장 실패: ${message}`, "error");
      }
    },
  });

  panel.appendChild(form.element);
  panel.appendChild(status);
}

async function bootstrap(): Promise<void> {
  const railHost = document.getElementById("settings-nav-rail");
  if (railHost) {
    railHost.replaceChildren(renderNavRail("settings"));
  }

  const bar = document.getElementById("tab-bar");
  const panel = document.getElementById("tab-panel");
  if (!bar || !panel) {
    throw new Error("settings.html 구조가 맞지 않다 — #tab-bar / #tab-panel 부재");
  }

  let state: InitState;
  try {
    state = await loadInitState();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errBox = document.createElement("p");
    errBox.className = "panel-error";
    errBox.textContent = `초기 로드 실패: ${message}`;
    panel.appendChild(errBox);
    return;
  }

  const tabs: TabDescriptor[] = [
    {
      id: MEMORY_TAB_ID,
      label: "메모리",
      render: (p) => renderMemoryTab(p, state),
    },
    {
      id: SYNONYM_TAB_ID,
      label: "동의어",
      render: (p) => renderSynonymTab(p),
    },
    {
      id: ENTITY_MANAGEMENT_TAB_ID,
      label: "엔티티 관리",
      render: (p) => renderEntityManagementTab(p),
    },
    {
      id: ALIAS_TAB_ID,
      label: "개념 합치기",
      render: (p) => renderConceptAliasTab(p),
    },
    {
      id: ADAPTER_MANAGEMENT_TAB_ID,
      label: "어댑터 관리",
      render: (p) => renderAdapterManagementTab(p),
    },
    {
      id: "connections",
      label: "연결·진단",
      render: (p) => { p.replaceChildren(renderConnectionDiagnostics()); },
    },
    ...state.apps.map<TabDescriptor>((app) => ({
      id: app.id,
      label: app.name,
      health: app.health,
      render: (p) => renderAdapterTab(p, app),
    })),
  ];

  renderTabBar(bar, panel, tabs, !linkedDocumentId() && window.location.hash === "#connections" ? "connections" : MEMORY_TAB_ID);
}

// 본 모듈 import 시점에 자동 가동. test 환경 (DOM 안 #tab-bar 미박힘) 에선
// bootstrap 진입 검증이 throw — promise reject 가 unhandled 박힘 자리 회피 위해
// 명시 가드. 옛 settings.html 흐름은 #tab-bar 박힘 + script type=module 정합.
if (typeof document !== "undefined" && document.getElementById("tab-bar")) {
  void bootstrap();
}
