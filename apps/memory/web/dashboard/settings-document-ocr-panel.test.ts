/**
 * 설정 › 메모리 › 문서 처리 — 스캔 문서 읽기 패널·서버 처리 상태·문서 카드 다시 읽기 (2026-10-11 document-ocr spec T10·T11).
 *
 * 대시보드 코드가 보내는 요청은 실제 HTTP 로 로컬 서버에 간다: /settings/* 는 진짜 설정 라우터(임시 설정 파일),
 * /api/* 와 /adapter-tokens 는 진짜 메모리 API(buildMemoryApi + 실제 SQLite + 실제 OCR 실행기 관리자)다. 그 뒤의
 * 공급자 API·Ollama·LM Studio 자리에는 진짜 로컬 대역 서버를 세운다(mock 클래스 0, 실키 없음). 대시보드의 상대
 * 경로만 그 로컬 서버 주소로 잇는다.
 */
import "../../test-setup-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";

import { _resetTokenCacheForTest } from "./api-fetch";
import { renderDocumentOcrSettingsPanel, renderDocumentProcessingPanel, type InitState } from "./settings";
import { DOCUMENT_OCR_API_PROVIDERS } from "../../src/settings/document-ocr-api-providers";
import { DOCUMENT_OCR_API_PROVIDER_LABELS, DOCUMENT_OCR_LABELS as L } from "./settings-document-ocr-labels";
import { describeDocumentOcrStatus, readDocumentOcrServerStatus } from "./settings-document-ocr-status";
import { MANUAL_ENTRY_VALUE } from "./settings-llm-model-picker";
import { createSettingsRoutes } from "../../src/settings/routes";
import { ReloadBus } from "../../src/settings/reload-bus";
import { getMemorySettings, maskSecrets, putMemorySettings, type MemorySettingsPartial } from "../../src/settings/memory-settings";
import { SecretStore } from "../../src/settings/secrets";
import { openMemoryDatabase } from "../../src/db/migrations";
import { SqliteMemoryStore } from "../../src/db/store";
import { Bgem3Embedder } from "../../src/embedding/bge-m3";
import { HybridRetriever } from "../../src/memory/retriever";
import { ContextAssembler } from "../../src/memory/context-assembler";
import { AssetStore } from "../../src/assets/asset-store";
import { SseTokenStore } from "../../src/federation/sse-tokens";
import type { MemoryApiDeps } from "../../src/server-internal/types";
import { registerDocumentRoutes } from "../../src/server-internal/routes/documents";
import { registerAdapterTokenRoutes } from "../../src/server-internal/routes/adapter-tokens";
import { withDocumentOcrRuntime } from "../../src/test-utils/document-ocr-runtime";
import { startProviderStandIn, type ProviderStandIn } from "../../src/test-utils/provider-stand-in";
import type { DocumentOcrServerStatus } from "../../src/api-client-types";
import type { DocumentOcrRuntime } from "../../src/server-internal/document-ocr/runtime-types";

const TMP_ROOT = join(import.meta.dir, "_tmp-document-ocr-panel");
const OCR_KEY = "sk-test-DASH-OCR-SAVED-9911";
const TYPED_KEY = "sk-test-DASH-OCR-TYPED-2233";

let providerApi: ProviderStandIn;
let dashboardServer: ReturnType<typeof Bun.serve>;
let tmpDir = "";
let counter = 0;
let db: Database;
let runtime: DocumentOcrRuntime;
let memoryApp: Hono;

/** 이 화면이 부르는 진짜 메모리 API 라우트(문서·연결 토큰)만 등록한 앱. */
function buildMemoryApi(deps: MemoryApiDeps): Hono {
  const app = new Hono({ strict: false });
  registerDocumentRoutes(app, deps);
  if (deps.sseTokens) registerAdapterTokenRoutes(app, { sseTokens: deps.sseTokens, remoteAddrOf: () => "127.0.0.1" });
  return app;
}
const nativeFetch = globalThis.fetch;

function paths() {
  return { settingsPath: join(tmpDir, "memory-settings.json"), secretsPath: join(tmpDir, "secrets.json") };
}

function liveSettings() {
  return getMemorySettings(paths().settingsPath, paths().secretsPath);
}

beforeAll(() => {
  providerApi = startProviderStandIn();
  const root = new Hono();
  root.get("/dashboard/sse-token", (c) => c.json({ token: "dash-token" }));
  root.all("/settings/*", (c) => {
    const reloadBus = new ReloadBus();
    reloadBus.subscribe(() => { void runtime.reconfigure(); });
    const settingsApp = createSettingsRoutes({
      reloadBus,
      ...paths(),
      ollamaUrl: () => providerApi.origin,
      providerApiBaseUrlsForTest: {
        anthropic: providerApi.origin,
        openai: `${providerApi.origin}/v1`,
        google: `${providerApi.origin}/v1beta`,
      },
    });
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace(/^\/settings/, "");
    return settingsApp.fetch(new Request(url, c.req.raw));
  });
  root.all("*", (c) => memoryApp.fetch(c.req.raw));
  dashboardServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: root.fetch });
  const origin = `http://127.0.0.1:${dashboardServer.port}`;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return nativeFetch(url.startsWith("/") ? `${origin}${url}` : url, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = nativeFetch;
  providerApi.stop();
  void dashboardServer.stop(true);
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  counter += 1;
  tmpDir = join(TMP_ROOT, `case-${process.pid}-${Date.now()}-${counter}`);
  mkdirSync(tmpDir, { recursive: true });
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  // 임베더는 불러오지 않는다 — 이 시험은 글을 저장하지 않고 설정·상태·목록 라우트만 쓴다.
  const embedder = new Bgem3Embedder();
  const store = new SqliteMemoryStore(db, embedder);
  const deps = withDocumentOcrRuntime(
    {
      store,
      retriever: new HybridRetriever(store, embedder),
      assembler: new ContextAssembler(),
      assetStore: new AssetStore(join(tmpDir, "assets")),
      sseTokens: new SseTokenStore(join(tmpDir, "tokens.json")),
      getSettings: liveSettings,
    },
    { setTimeoutFn: () => ({}), clearTimeoutFn: () => {} },
  );
  runtime = deps.documentOcrRuntime!;
  memoryApp = buildMemoryApi(deps);
  window.sessionStorage.setItem("bara.dashboard.token", "dash-token");
  _resetTokenCacheForTest();
  document.body.textContent = "";
});

afterEach(async () => {
  await runtime.stop();
  db.close();
  providerApi.requests.length = 0;
  providerApi.reply = () => ({ status: 404, body: "not found" });
  window.sessionStorage.removeItem("bara.dashboard.token");
  _resetTokenCacheForTest();
  document.body.textContent = "";
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

/** 임시 설정 파일에 저장하고 서버 GET 응답과 같은 모양(가린 키 + $secretsSet)으로 화면 상태를 만든다. */
function savedState(partial: MemorySettingsPartial = {}): InitState {
  if (Object.keys(partial).length > 0) putMemorySettings(partial, paths().settingsPath, paths().secretsPath);
  const masked = maskSecrets(liveSettings());
  return { schema: {}, value: JSON.parse(JSON.stringify(masked)) as Record<string, unknown>, apps: [] };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

function field(root: ParentNode, labelText: string): HTMLElement {
  const found = Array.from(root.querySelectorAll(".document-ocr-field")).find(
    (el) => (el.firstChild?.textContent ?? "").trim() === labelText,
  ) as HTMLElement | undefined;
  if (!found) throw new Error(`field not found: ${labelText}`);
  return found;
}

function control<T extends HTMLElement>(root: ParentNode, labelText: string): T {
  const el = field(root, labelText).querySelector("input, textarea, select") as T | null;
  if (!el) throw new Error(`control not found: ${labelText}`);
  return el;
}

function choose(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event("change"));
}

function mountPanel(state: InitState): HTMLElement {
  const panel = renderDocumentOcrSettingsPanel(state);
  document.body.appendChild(panel);
  return panel;
}

async function submit(panel: HTMLElement): Promise<void> {
  (panel.querySelector(".form-submit") as HTMLButtonElement).click();
  await settle();
}

describe("AI API 패널", () => {
  test("업체 다섯 개가 표 순서대로, 고른 업체 폼만 보인다", async () => {
    const panel = mountPanel(savedState());
    choose(control<HTMLSelectElement>(panel, "읽는 방법"), "api");
    const provider = control<HTMLSelectElement>(panel, L.apiProviderLabel);
    expect(Array.from(provider.options).map((o) => o.value)).toEqual([...DOCUMENT_OCR_API_PROVIDERS]);
    expect(Array.from(provider.options).map((o) => o.textContent)).toEqual(
      DOCUMENT_OCR_API_PROVIDERS.map((p) => DOCUMENT_OCR_API_PROVIDER_LABELS[p]),
    );
    expect(provider.value).toBe("http_file_api");
    for (const name of DOCUMENT_OCR_API_PROVIDERS) {
      const form = panel.querySelector(`#document-ocr-api-${name}`) as HTMLElement;
      expect(form.hidden).toBe(name !== "http_file_api");
    }
    choose(provider, "google");
    expect((panel.querySelector("#document-ocr-api-google") as HTMLElement).hidden).toBe(false);
    expect((panel.querySelector("#document-ocr-api-http_file_api") as HTMLElement).hidden).toBe(true);
    // 옛 하드코딩(모델 이름 목록·OpenAI 기본 주소)이 화면에 없다.
    expect(panel.textContent ?? "").not.toContain("gpt-5.5");
    expect(panel.innerHTML).not.toContain("api.openai.com/v1/chat/completions");
  });

  test("저장된 OCR 키가 있으면 안내하고, 실제 목록을 slot=ocr 로 불러와 이미지 못 받는 모델을 뺀다", async () => {
    const panel = mountPanel(
      savedState({ documents: { ocr: { mode: "api", api: { provider: "anthropic", anthropicApiKey: OCR_KEY, anthropicModel: "claude-a" } } } }),
    );
    providerApi.reply = () => ({
      body: {
        data: [
          { id: "claude-a", display_name: "Claude A", capabilities: { image_input: { supported: true } } },
          { id: "claude-text", display_name: "Text only", capabilities: { image_input: { supported: false } } },
        ],
        has_more: false,
      },
    });
    choose(control<HTMLSelectElement>(panel, "읽는 방법"), "api");
    await settle();
    const form = panel.querySelector("#document-ocr-api-anthropic") as HTMLElement;
    expect(form.textContent).toContain("저장된 키가 있습니다");
    const select = form.querySelector("#document-ocr-api-anthropic-model") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["claude-a", MANUAL_ENTRY_VALUE]);
    expect(select.value).toBe("claude-a");
    expect(form.textContent).toContain("이미지를 못 받는 모델 1개를 뺐습니다.");
    expect(providerApi.requests[0]!.headers["x-api-key"]).toBe(OCR_KEY);
  });

  test("목록 실패는 빨간 줄로 서버 오류를 보이고 저장된 값을 남긴다", async () => {
    const panel = mountPanel(
      savedState({ documents: { ocr: { mode: "api", api: { provider: "openai", gptApiKey: OCR_KEY, gptModel: "gpt-saved" } } } }),
    );
    providerApi.reply = () => ({ status: 500, body: { error: { message: "upstream broke" } } });
    choose(control<HTMLSelectElement>(panel, "읽는 방법"), "api");
    await settle();
    const form = panel.querySelector("#document-ocr-api-openai") as HTMLElement;
    const error = form.querySelector('[data-role="model-error"]') as HTMLElement;
    expect(error.textContent).toContain("upstream broke");
    const select = form.querySelector("#document-ocr-api-openai-model") as HTMLSelectElement;
    expect(select.value).toBe("gpt-saved");
  });

  test("저장 payload — 고른 업체 칸과 공통 칸, 입력한 키는 비밀 파일로, 빈 키는 보내지 않음", async () => {
    const panel = mountPanel(savedState());
    choose(control<HTMLSelectElement>(panel, "읽는 방법"), "api");
    choose(control<HTMLSelectElement>(panel, L.apiProviderLabel), "openai");
    const form = panel.querySelector("#document-ocr-api-openai") as HTMLElement;
    (form.querySelector("#document-ocr-api-openai-key") as HTMLInputElement).value = TYPED_KEY;
    const select = form.querySelector("#document-ocr-api-openai-model") as HTMLSelectElement;
    choose(select, MANUAL_ENTRY_VALUE);
    (form.querySelector("#document-ocr-api-openai-model-manual") as HTMLInputElement).value = "gpt-typed-model";
    control<HTMLInputElement>(panel, L.pagesPerDayLabel).value = "40";
    await submit(panel);

    const saved = liveSettings().documents.ocr;
    expect(saved.mode).toBe("api");
    expect(saved.api.provider).toBe("openai");
    expect(saved.api.gptModel).toBe("gpt-typed-model");
    expect(saved.api.gptApiKey).toBe(TYPED_KEY);
    expect(saved.schedule.maxPagesPerDay).toBe(40);
    expect(readFileSync(paths().settingsPath, "utf-8")).not.toContain(TYPED_KEY);
    expect(new SecretStore(paths().secretsPath).get("documents.ocr.api.gptApiKey")).toBe(TYPED_KEY);
    expect(panel.textContent).toContain(L.savedApplied);
  });

  test("파일 업로드 API — 주소·모델(글 칸)·키 왕복, 빈 키는 저장된 키 유지", async () => {
    putMemorySettings({ documents: { ocr: { api: { apiKey: OCR_KEY } } } }, paths().settingsPath, paths().secretsPath);
    const panel = mountPanel(savedState({ documents: { ocr: { api: { endpointUrl: "https://ocr.example.com/v1/parse" } } } }));
    choose(control<HTMLSelectElement>(panel, "읽는 방법"), "api");
    const form = panel.querySelector("#document-ocr-api-http_file_api") as HTMLElement;
    const endpoint = control<HTMLInputElement>(form, L.httpEndpointLabel);
    expect(endpoint.value).toBe("https://ocr.example.com/v1/parse");
    expect(field(form, L.httpModelLabel).textContent).toContain(L.httpModelHint);
    expect(control<HTMLInputElement>(form, L.httpModelLabel).tagName).toBe("INPUT");
    expect(field(form, L.httpKeyLabel).textContent).toContain("저장된 키가 있습니다");
    endpoint.value = "https://ocr.example.com/v2/parse";
    control<HTMLInputElement>(form, L.httpModelLabel).value = "ocr-model";
    await submit(panel);
    const saved = liveSettings().documents.ocr.api;
    expect(saved.endpointUrl).toBe("https://ocr.example.com/v2/parse");
    expect(saved.model).toBe("ocr-model");
    expect(saved.apiKey).toBe(OCR_KEY);
  });
});

describe("엄격한 설정 읽기", () => {
  test("칸이 없으면 기본값으로 메우지 않고 칸 이름 오류를 보인다", () => {
    const state = savedState();
    const ocr = (state.value.documents as { ocr: Record<string, unknown> }).ocr;
    delete ocr.maxOutputTokensPerPage;
    const panel = mountPanel(state);
    expect(panel.querySelector(".document-ocr-read-error")?.textContent).toContain("documents.ocr.maxOutputTokensPerPage");
    expect(panel.querySelector("form")).toBeNull();
  });
});

describe("로컬·보조 프로그램 패널", () => {
  test("로컬 Ollama — 이미지 모델 목록, 선택 AI별 모델 값 보존, 입력 여유 칸", async () => {
    providerApi.reply = (req) => {
      if (req.path === "/api/tags") return { body: { models: [{ name: "qwen3-vl:4b" }, { name: "text-only" }] } };
      if (req.path === "/api/show") {
        const model = (req.body as { model?: string }).model;
        return { body: { capabilities: model === "qwen3-vl:4b" ? ["completion", "vision"] : ["completion"] } };
      }
      if (req.path === "/v1/models") return { body: { data: [{ id: "llava-v1.6" }] } };
      return { status: 404, body: "no" };
    };
    const panel = mountPanel(
      savedState({ documents: { ocr: { local: { ollamaModel: "qwen3-vl:4b", lmstudioUrl: `${providerApi.origin}/v1` } } } }),
    );
    choose(control<HTMLSelectElement>(panel, "읽는 방법"), "local");
    await settle();
    const localPanel = panel.querySelector('[data-mode="local"]') as HTMLElement;
    const model = control<HTMLSelectElement>(localPanel, L.modelLabel);
    const values = Array.from(model.options).map((o) => o.value);
    expect(values).toContain("qwen3-vl:4b");
    expect(values).not.toContain("text-only"); // 이미지를 못 받는 모델은 목록 액션이 거른다.
    expect(field(localPanel, L.ollamaReserveLabel).hidden).toBe(false);
    choose(control<HTMLSelectElement>(localPanel, L.localProviderLabel), "lmstudio_vision");
    await settle();
    expect(field(localPanel, L.ollamaReserveLabel).hidden).toBe(true);
    choose(model, "llava-v1.6");
    await submit(panel);
    const saved = liveSettings().documents.ocr;
    expect(saved.mode).toBe("local");
    expect(saved.local.provider).toBe("lmstudio_vision");
    expect(saved.local.lmstudioModel).toBe("llava-v1.6");
    expect(saved.local.ollamaModel).toBe("qwen3-vl:4b");
  });

  test("보조 프로그램 패널은 연결 승인 상태를 보이고 저장한다(빈 선택 → 세 상태: 기존 동작 그대로)", async () => {
    const panel = mountPanel(savedState());
    choose(control<HTMLSelectElement>(panel, "읽는 방법"), "pc_companion");
    await settle();
    expect(panel.textContent).toContain(L.tokenNone);
    control<HTMLInputElement>(panel, L.pcWorkerId).value = "pc-gpu";
    for (const box of Array.from(panel.querySelectorAll<HTMLInputElement>(".document-ocr-status-checks input"))) box.checked = false;
    await submit(panel);
    const saved = liveSettings().documents.ocr.pcCompanion;
    expect(saved.workerId).toBe("pc-gpu");
    expect(saved.allowedStatuses).toEqual(["needs_ocr", "parse_failed", "ocr_failed"]);
  });

  test("숫자 칸이 비면 칸 이름을 대며 저장하지 않는다(다른 값으로 바꾸지 않음)", async () => {
    const panel = mountPanel(savedState());
    choose(control<HTMLSelectElement>(panel, "읽는 방법"), "api");
    control<HTMLInputElement>(panel, L.pagesPerCycleLabel).value = "";
    await submit(panel);
    expect(panel.textContent).toContain("documents.ocr.schedule.maxPagesPerCycle 값이 정수가 아님");
    expect(liveSettings().documents.ocr.mode).toBe("manual");
  });
});

describe("서버 처리 상태", () => {
  function statusOf(state: DocumentOcrServerStatus["state"], extra: Partial<DocumentOcrServerStatus> = {}): DocumentOcrServerStatus {
    return {
      state, reason: "사유 칸 documents.ocr.api.gptModel", mode: "api", intervalMin: 30, nextRunAt: "2026-10-12T01:15:00.000Z",
      lastCycle: null, today: { day: "2026-10-12", pageCalls: 4, maxPagesPerDay: 100 },
      queue: { waitingRetry: 2, terminal: 1, inProgress: [], notServerProcessable: [{ reason: "docx 는 서버 OCR 대상이 아님", count: 3 }], absorbedSharingResult: 0, legacyMergedRecords: 0 },
      ...extra,
    };
  }
  const text = (s: DocumentOcrServerStatus) => describeDocumentOcrStatus(s).map((el) => el.textContent).join("\n");

  test("상태별 문구", () => {
    expect(text(statusOf("off"))).toContain("서버 자동 처리 꺼짐 — 사유 칸 documents.ocr.api.gptModel");
    expect(text(statusOf("config_error"))).toContain("설정 문제로 멈춤 — 사유 칸 documents.ocr.api.gptModel");
    expect(describeDocumentOcrStatus(statusOf("config_error"))[0]!.classList.contains("error")).toBe(true);
    expect(text(statusOf("daily_cap_reached"))).toContain("오늘 한도(100쪽)에 닿아 내일 이어서 처리합니다.");
    expect(text(statusOf("idle"))).toContain("오늘 4/100쪽");
    expect(text(statusOf("running", { queue: { waitingRetry: 0, terminal: 0, notServerProcessable: [], absorbedSharingResult: 0, legacyMergedRecords: 0, inProgress: [{ documentId: "d", title: "스캔.pdf", completedPages: 2, pageCount: 5 }] } })))
      .toContain("처리 중… (스캔.pdf 2/5쪽)");
    const common = text(statusOf("idle"));
    expect(common).toContain("재시도 대기 2건 · 자동 재시도 멈춤 1건");
    expect(common).toContain("서버 처리 대상 아님: docx 는 서버 OCR 대상이 아님 3건");
    const withCycle = statusOf("idle", {
      lastCycle: {
        startedAt: "2026-10-12T00:00:00.000Z", durationMs: 10, documentsTouched: 1, documentsApplied: 1, documentsFailed: 0,
        pagesSucceeded: 3, pagesTransientFailed: 0, pagesDeterministicFailed: 0, pageCalls: 3, pagesBlank: 2,
        stoppedBy: "done", configError: null, error: null,
      },
    });
    expect(text(withCycle)).toContain("빈 쪽 2개");
    expect(common).not.toContain("그 문서와 함께 쓰는 기록");
    expect(common).not.toContain("잘못 합쳐진 기록");
    const notOwnedQueue = statusOf("idle", {
      queue: { waitingRetry: 0, terminal: 0, inProgress: [], notServerProcessable: [], absorbedSharingResult: 2, legacyMergedRecords: 3 },
    });
    expect(text(notOwnedQueue)).toContain("같은 파일이 이미 있어 그 문서와 함께 쓰는 기록 2건 (따로 읽지 않음)");
    expect(text(notOwnedQueue)).toContain("예전 버전에서 잘못 합쳐진 기록 3건 · 다시 올려 주세요");
    expect(text(statusOf("error", { reason: "쪽 그림 준비 실패" }))).toContain("처리 중 오류로 멈춤 — 쪽 그림 준비 실패");
  });

  test("상태 응답 모양 확인 — 화면이 읽는 queue 칸이 빠지면 칸 이름을 든 오류(0 으로 읽지 않음)", () => {
    const ok = statusOf("idle");
    expect(readDocumentOcrServerStatus(ok)).toBe(ok);
    for (const key of ["waitingRetry", "terminal", "absorbedSharingResult", "legacyMergedRecords"] as const) {
      const broken = structuredClone(ok) as unknown as { queue: Record<string, unknown> };
      delete broken.queue[key];
      expect(() => readDocumentOcrServerStatus(broken)).toThrow(`응답 status.queue.${key} 가 숫자가 아님`);
    }
    const noQueue = structuredClone(ok) as unknown as Record<string, unknown>;
    delete noQueue.queue;
    expect(() => readDocumentOcrServerStatus(noQueue)).toThrow("응답 status.queue 가 없음");
    expect(() => readDocumentOcrServerStatus(null)).toThrow("응답에 status 가 없음");
  });

  test("실제 상태 라우트 — 수동이면 꺼짐, AI API 로 저장하면 바로 켜져 다음 처리 시각", async () => {
    const panel = mountPanel(savedState());
    const statusSection = panel.querySelector('[data-section="ocr-server-status"]') as HTMLElement;
    expect(statusSection.hidden).toBe(true);
    choose(control<HTMLSelectElement>(panel, "읽는 방법"), "api");
    await settle();
    expect(statusSection.hidden).toBe(false);
    expect(statusSection.textContent).toContain("서버 자동 처리 꺼짐");

    putMemorySettings({ documents: { ocr: { api: { endpointUrl: "https://ocr.example.com/parse" } } } }, paths().settingsPath, paths().secretsPath);
    const fresh = mountPanel(savedState());
    choose(control<HTMLSelectElement>(fresh, "읽는 방법"), "api");
    await submit(fresh);
    await runtime.reconfigure();
    (fresh.querySelector(".document-ocr-status-refresh") as HTMLButtonElement).click();
    await settle();
    expect(fresh.querySelector('[data-section="ocr-server-status"]')!.textContent).toContain("다음 처리:");
  });

  test("불러오기 실패는 빨간 줄(빈 상태로 바꾸지 않음)", async () => {
    // 실행기 관리자를 붙이지 않은 진짜 메모리 API — 상태 라우트가 503 과 이름 있는 사유를 돌려준다.
    const embedder = new Bgem3Embedder();
    const store = new SqliteMemoryStore(db, embedder);
    memoryApp = buildMemoryApi({
      store,
      retriever: new HybridRetriever(store, embedder),
      assembler: new ContextAssembler(),
      assetStore: new AssetStore(join(tmpDir, "assets")),
      getSettings: liveSettings,
    });
    const panel = mountPanel(savedState({ documents: { ocr: { mode: "api" } } }));
    await settle();
    const line = panel.querySelector('[data-section="ocr-server-status"] .error') as HTMLElement;
    expect(line.textContent).toBe("처리 상태를 불러오지 못했습니다: documentOcrRuntime 미주입 — documents.ocr 설정을 읽을 수 없음");
  });
});

describe("문서 카드 — 서버에서 다시 읽기", () => {
  function insertFailedDocument(id = "doc_card", mime = "application/pdf", lease?: Record<string, string>): string {
    const sha = id.padEnd(64, "c").slice(0, 64);
    db.run("INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, mime_type, first_imported_at) VALUES (?, 'document', ?, 1, ?, 1)", [sha, `/x/${sha}.pdf`, mime]);
    const parse = { status: "ocr_failed", method: "ocr", originalAssetSha256: sha, warnings: [], errorMessage: "1쪽: 잘림", ...(lease ? { lease } : {}) };
    db.run(
      `INSERT INTO documents (document_id, asset_sha256, title, document_type, source_metadata, created_at, updated_at)
       VALUES (?, ?, '스캔.pdf', 'free', ?, '2026-10-12 00:00:00', '2026-10-12 00:00:00')`,
      [id, sha, JSON.stringify({ parse })],
    );
    db.run("INSERT INTO knowledge_nodes (content, source_type, metadata_json) VALUES ('문서', 'document', ?)", [JSON.stringify({ documentId: id })]);
    return id;
  }

  test("빈 쪽이 있던 문서 카드는 빈 쪽 수를 한국어로 보인다", async () => {
    const sha = "d".repeat(64);
    db.run("INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, mime_type, first_imported_at) VALUES (?, 'document', ?, 1, 'application/pdf', 1)", [sha, `/x/${sha}.pdf`]);
    db.run(
      `INSERT INTO documents (document_id, asset_sha256, title, document_type, source_metadata, created_at, updated_at)
       VALUES ('doc_blank', ?, '빈쪽.pdf', 'free', ?, '2026-10-12 00:00:00', '2026-10-12 00:00:00')`,
      [sha, JSON.stringify({ parse: { status: "ocr_succeeded", method: "ocr", originalAssetSha256: sha, warnings: [], blankPageCount: 2 } })],
    );
    db.run("INSERT INTO knowledge_nodes (content, source_type, metadata_json) VALUES ('문서', 'document', ?)", [JSON.stringify({ documentId: "doc_blank" })]);
    window.history.replaceState(null, "", "/web/settings.html?documentId=doc_blank");
    try {
      document.body.appendChild(renderDocumentProcessingPanel(undefined, { serverOcrEnabled: true }));
      await settle();
      expect(document.querySelector(".document-processing-blank")?.textContent).toBe(L.blankPages(2));
    } finally {
      window.history.replaceState(null, "", "/web/settings.html");
    }
  });

  test("서버가 읽을 수 없는 문서(docx)·보조 프로그램이 잡은 문서에는 버튼이 없다", async () => {
    insertFailedDocument("doc_docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    insertFailedDocument("doc_leased", "application/pdf", { workerId: "pc-ocr", claimedAt: "2026-01-01 00:00:00", leaseUntil: "2999-01-01 00:00:00" });
    document.body.appendChild(renderDocumentProcessingPanel(undefined, { serverOcrEnabled: true }));
    await settle();
    expect(document.querySelectorAll(".document-processing-item").length).toBe(2);
    expect(document.querySelector(".document-processing-rerun")).toBeNull();
  });

  test("서버 모드에서만 ocr_failed 카드에 버튼이 보이고, 실패하면 카드 상태 줄에 사유", async () => {
    insertFailedDocument();
    document.body.appendChild(renderDocumentProcessingPanel(undefined, { serverOcrEnabled: false }));
    await settle();
    expect(document.querySelector(".document-processing-rerun")).toBeNull();
    document.body.textContent = "";

    putMemorySettings({ documents: { ocr: { mode: "api", api: { provider: "openai", gptApiKey: OCR_KEY } } } }, paths().settingsPath, paths().secretsPath);
    document.body.appendChild(renderDocumentProcessingPanel(undefined, { serverOcrEnabled: true }));
    await settle();
    const button = document.querySelector(".document-processing-rerun") as HTMLButtonElement;
    expect(button.textContent).toBe(L.rerunOnServer);
    button.click();
    await settle();
    const status = document.querySelector(".document-processing-status") as HTMLElement;
    expect(status.classList.contains("error")).toBe(true);
    expect(status.textContent).toContain("documents.ocr.api.gptModel");
    expect(status.textContent).not.toContain(OCR_KEY);
  });
});
