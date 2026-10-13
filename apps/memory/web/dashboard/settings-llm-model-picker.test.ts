/**
 * 설정 화면 LLM 공급자 폼·모델 드롭다운 (2026-10-11 llm-api-providers spec T9).
 *
 * 대시보드 코드가 보내는 요청은 실제 HTTP 로 로컬 서버에 간다: 그 서버는 진짜 설정 라우터
 * (createSettingsRoutes + 임시 설정 파일)이고, 라우터가 부르는 공급자 API 자리에는 진짜 로컬 대역 서버를
 * 세운다. 대시보드의 상대 경로("/settings/…")만 그 로컬 서버 주소로 이어 붙인다(mock 클래스 0).
 */
import "../../test-setup-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";

import { _resetTokenCacheForTest } from "./api-fetch";
import { createSlotCommonControls, type SlotCommonControls, type SlotKey } from "./settings-llm-controls";
import { renderCleanupSection } from "./settings-llm-section";
import { MANUAL_ENTRY_VALUE } from "./settings-llm-model-picker";
import { readLlmGroup, type LlmGroupValue } from "./settings-llm-types";
import { createSettingsRoutes } from "../../src/settings/routes";
import { ReloadBus } from "../../src/settings/reload-bus";
import { getMemorySettings, maskSecrets, putMemorySettings, type MemorySettingsPartial } from "../../src/settings/memory-settings";
import { startProviderStandIn, type ProviderStandIn } from "../../src/test-utils/provider-stand-in";

const TMP_ROOT = join(import.meta.dir, "_tmp-model-picker");
const TYPED_KEY = "sk-test-DASH-TYPED-1234";
const SAVED_KEY = "sk-test-DASH-SAVED-5678";

let providerApi: ProviderStandIn;
let dashboardServer: ReturnType<typeof Bun.serve>;
let tmpDir = "";
let counter = 0;
const nativeFetch = globalThis.fetch;

function paths() {
  return { settingsPath: join(tmpDir, "memory-settings.json"), secretsPath: join(tmpDir, "secrets.json") };
}

beforeAll(() => {
  providerApi = startProviderStandIn();
  const root = new Hono();
  root.get("/dashboard/sse-token", (c) => c.json({ token: "dash-token" }));
  root.all("/settings/*", (c) => {
    const settingsApp = createSettingsRoutes({
      reloadBus: new ReloadBus(),
      ...paths(),
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
  dashboardServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: root.fetch });
  const origin = `http://127.0.0.1:${dashboardServer.port}`;
  // 대시보드의 상대 경로 요청을 위 로컬 서버로 잇는다(브라우저가 같은 출처로 보내는 것과 같은 길).
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return nativeFetch(url.startsWith("/") ? `${origin}${url}` : url, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = nativeFetch;
  providerApi.stop();
  void dashboardServer.stop(true);
  if (existsSync(TMP_ROOT) && readdirSync(TMP_ROOT).length === 0) rmSync(TMP_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  counter += 1;
  tmpDir = join(TMP_ROOT, `case-${process.pid}-${Date.now()}-${counter}`);
  mkdirSync(tmpDir, { recursive: true });
  window.sessionStorage.setItem("bara.dashboard.token", "dash-token");
  _resetTokenCacheForTest();
});

afterEach(() => {
  providerApi.requests.length = 0;
  window.sessionStorage.removeItem("bara.dashboard.token");
  _resetTokenCacheForTest();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

/** 임시 설정 파일에 저장하고, 서버 GET 응답과 같은 모양(가린 키 + $secretsSet)으로 화면 값을 읽는다. */
function savedGroup(partial: MemorySettingsPartial): LlmGroupValue {
  putMemorySettings(partial, paths().settingsPath, paths().secretsPath);
  const masked = maskSecrets(getMemorySettings(paths().settingsPath, paths().secretsPath));
  return readLlmGroup(JSON.parse(JSON.stringify(masked)) as Record<string, unknown>);
}

function controls(slot: SlotKey, group: LlmGroupValue): SlotCommonControls {
  return createSlotCommonControls(slot, "제목", "", group[slot], group[slot], { showDesc: false, showHints: false });
}

function optionTexts(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map((o) => o.textContent ?? "");
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((r) => setTimeout(r, 5));
}

const OPENAI_MODELS = {
  data: [
    { id: "gpt-4.1", created: 300 },
    { id: "whisper-1", created: 200 },
    { id: "gpt-4o", created: 100, shutdown_date: "2027-01-01" },
  ],
};

describe("API 공급자 폼 — 키 안내와 처음 상태", () => {
  test("저장된 키가 없으면 '키를 입력하세요.' + '키를 입력한 뒤…' 안내, 목록 요청 0", async () => {
    const group = savedGroup({ llm: { cleanup: { provider: "openai" } } });
    const ctrl = controls("cleanup", group);
    await settle();
    const form = ctrl.section.querySelector("#llm-cleanup-gpt-form") as HTMLElement;
    expect(form.style.display).toBe("");
    expect(form.textContent).toContain("OpenAI API 키");
    expect(form.querySelector('[data-role="key-hint"]')?.textContent).toBe("키를 입력하세요.");
    expect(ctrl.pickers.openai.notice.textContent).toBe("키를 입력한 뒤 [목록 불러오기]를 누르세요.");
    expect(optionTexts(ctrl.pickers.openai.select)).toEqual(["(모델 미선택)", "직접 입력…"]);
    expect(providerApi.requests).toHaveLength(0);
  });

  test("저장된 키가 있으면 '저장된 키가 있습니다…' + 화면 진입 때 저장된 키로 목록을 한 번 불러온다", async () => {
    providerApi.reply = () => ({ body: OPENAI_MODELS });
    const group = savedGroup({ llm: { cleanup: { enabled: true, provider: "openai", gptApiKey: SAVED_KEY, gptModel: "gpt-4o" } } });
    const ctrl = controls("cleanup", group);
    await settle();
    const form = ctrl.section.querySelector("#llm-cleanup-gpt-form") as HTMLElement;
    expect(form.querySelector('[data-role="key-hint"]')?.textContent).toBe("저장된 키가 있습니다. 바꿀 때만 새로 입력하세요.");
    expect(providerApi.requests).toHaveLength(1);
    expect(providerApi.requests[0]!.headers.authorization).toBe(`Bearer ${SAVED_KEY}`);
    // 대화 모델만 + 지원 종료 예정 표시 + 마지막 직접 입력…, 저장된 값은 그대로 선택.
    expect(optionTexts(ctrl.pickers.openai.select)).toEqual(["gpt-4.1", "gpt-4o (지원 종료 예정)", "직접 입력…"]);
    expect(ctrl.pickers.openai.select.value).toBe("gpt-4o");
    expect(ctrl.pickers.openai.notice.textContent).toContain("OpenAI는 대화용 모델만 보여 줍니다.");
    // 화면 어디에도 키 문자열이 없다.
    expect(ctrl.section.innerHTML).not.toContain(SAVED_KEY);
  });
});

describe("모델 드롭다운 상태 전이", () => {
  test("방금 입력한 키로 [목록 불러오기] → 목록, 비어 있던 값은 '(모델 미선택)' 유지(아무 모델이나 고르지 않음)", async () => {
    providerApi.reply = () => ({ body: OPENAI_MODELS });
    const ctrl = controls("extractor", savedGroup({ llm: { extractor: { provider: "openai" } } }));
    ctrl.keyInputs.openai.value = TYPED_KEY;
    ctrl.pickers.openai.loadButton.click();
    await ctrl.pickers.openai.load();
    expect(providerApi.requests).toHaveLength(1);
    expect(providerApi.requests[0]!.headers.authorization).toBe(`Bearer ${TYPED_KEY}`);
    expect(optionTexts(ctrl.pickers.openai.select)).toEqual(["(모델 미선택)", "gpt-4.1", "gpt-4o (지원 종료 예정)", "직접 입력…"]);
    expect(ctrl.pickers.openai.getValue()).toBe("");
  });

  test("저장된 값이 목록에 없으면 맨 위 '(목록에 없음)' 으로 남기고 선택 유지", async () => {
    providerApi.reply = () => ({ body: OPENAI_MODELS });
    const ctrl = controls("cleanup", savedGroup({ llm: { cleanup: { enabled: true, provider: "openai", gptApiKey: SAVED_KEY, gptModel: "gpt-4.5-org-only" } } }));
    await settle();
    expect(optionTexts(ctrl.pickers.openai.select)[0]).toBe("gpt-4.5-org-only (목록에 없음)");
    expect(ctrl.pickers.openai.getValue()).toBe("gpt-4.5-org-only");
  });

  test("실패 → 저장된 값 '(저장된 값 — 목록을 못 불러옴)' + 빨간 줄에 서버 오류 문장(키 없음)", async () => {
    providerApi.reply = () => ({ status: 401, body: { error: { message: `Incorrect API key provided: ${TYPED_KEY}` } } });
    const ctrl = controls("cleanup", savedGroup({ llm: { cleanup: { provider: "openai", gptModel: "gpt-4.1" } } }));
    ctrl.keyInputs.openai.value = TYPED_KEY;
    await ctrl.pickers.openai.load();
    expect(optionTexts(ctrl.pickers.openai.select)).toEqual(["gpt-4.1 (저장된 값 — 목록을 못 불러옴)", "직접 입력…"]);
    expect(ctrl.pickers.openai.error.style.display).toBe("");
    expect(ctrl.pickers.openai.error.textContent).toContain("401");
    expect(ctrl.pickers.openai.error.textContent).not.toContain(TYPED_KEY);
    expect(ctrl.pickers.openai.getValue()).toBe("gpt-4.1");
  });

  test("성공·0개 → '이 키로 쓸 수 있는 모델이 없습니다.' + 저장된 값만", async () => {
    providerApi.reply = () => ({ body: {} });
    const ctrl = controls("extractor", savedGroup({ llm: { extractor: { provider: "google", geminiModel: "gemini-old" } } }));
    ctrl.keyInputs.google.value = TYPED_KEY;
    await ctrl.pickers.google.load();
    expect(ctrl.pickers.google.notice.textContent).toBe("이 키로 쓸 수 있는 모델이 없습니다.");
    expect(optionTexts(ctrl.pickers.google.select)).toEqual(["gemini-old", "직접 입력…"]);
  });

  test("vision 슬롯 Anthropic — 이미지를 못 받는 모델을 뺀 개수를 알린다", async () => {
    providerApi.reply = () => ({
      body: {
        data: [
          { id: "claude-a", display_name: "Claude A", capabilities: { image_input: { supported: true } } },
          { id: "claude-t", display_name: "Claude T", capabilities: { image_input: { supported: false } } },
        ],
        has_more: false,
      },
    });
    const ctrl = controls("vision", savedGroup({ llm: { vision: { enabled: true, provider: "anthropic", anthropicApiKey: SAVED_KEY, anthropicModel: "claude-a" } } }));
    await settle();
    expect(ctrl.pickers.anthropic.notice.textContent).toBe("이미지를 못 받는 모델 1개를 뺐습니다.");
    expect(optionTexts(ctrl.pickers.anthropic.select)).toEqual(["Claude A", "직접 입력…"]);
  });

  test("같은 조합 요청이 진행 중이면 겹쳐 보내지 않는다", async () => {
    providerApi.reply = () => ({ body: OPENAI_MODELS });
    const ctrl = controls("cleanup", savedGroup({ llm: { cleanup: { provider: "openai" } } }));
    ctrl.keyInputs.openai.value = TYPED_KEY;
    await Promise.all([ctrl.pickers.openai.load(), ctrl.pickers.openai.load()]);
    expect(providerApi.requests).toHaveLength(1);
  });

  test("직접 입력… → 글 칸이 열리고 그 값이 저장 값", async () => {
    const ctrl = controls("cleanup", savedGroup({ llm: { cleanup: { provider: "google" } } }));
    const picker = ctrl.pickers.google;
    picker.select.value = MANUAL_ENTRY_VALUE;
    picker.select.dispatchEvent(new Event("change"));
    expect(picker.manualInput.style.display).toBe("");
    picker.manualInput.value = " gemini-private-tuned ";
    expect(picker.getValue()).toBe("gemini-private-tuned");
  });

  test("LM Studio — 키 없이 화면 진입 때 지금 주소로 목록을 불러오고 거르지 않는다", async () => {
    providerApi.reply = () => ({ body: { data: [{ id: "local-a" }, { id: "text-embedding-x" }] } });
    const ctrl = controls("cleanup", savedGroup({ llm: { cleanup: { enabled: true, provider: "openai_compatible", openaiBaseUrl: `${providerApi.origin}/v1`, openaiModel: "local-a" } } }));
    await settle();
    expect(providerApi.requests[0]!.path).toBe("/v1/models");
    expect(optionTexts(ctrl.pickers.openai_compatible.select)).toEqual(["local-a", "text-embedding-x", "직접 입력…"]);
  });
});

describe("자동 목록은 켜진 슬롯에서만 · 늦은 응답은 버린다", () => {
  test("꺼진 슬롯(설정 카드 숨김)은 저장된 키가 있어도 목록을 부르지 않고, 켜는 순간 부른다", async () => {
    providerApi.reply = () => ({ body: OPENAI_MODELS });
    const ctrl = controls("cleanup", savedGroup({ llm: { cleanup: { enabled: false, provider: "openai", gptApiKey: SAVED_KEY } } }));
    await settle();
    expect(ctrl.configBox.style.display).toBe("none");
    expect(providerApi.requests).toHaveLength(0);
    ctrl.enabledInput.checked = true;
    ctrl.enabledInput.dispatchEvent(new Event("change"));
    await settle();
    expect(providerApi.requests).toHaveLength(1);
  });

  test("켜진 슬롯에서 공급자를 바꾸면 그 공급자 목록을 부른다", async () => {
    providerApi.reply = () => ({ body: { models: [{ name: "models/gemini-x", supportedGenerationMethods: ["generateContent"] }] } });
    const ctrl = controls("cleanup", savedGroup({ llm: { cleanup: { enabled: true, provider: "anthropic", geminiApiKey: SAVED_KEY } } }));
    await settle();
    expect(providerApi.requests).toHaveLength(0);
    ctrl.providerSelect.value = "google";
    ctrl.providerSelect.dispatchEvent(new Event("change"));
    await settle();
    expect(providerApi.requests).toHaveLength(1);
    expect(providerApi.requests[0]!.path).toBe("/v1beta/models");
  });

  test("다른 키로 다시 부르면 늦게 도착한 옛 응답이 새 결과를 덮어쓰지 않는다", async () => {
    providerApi.reply = (req) =>
      req.headers.authorization === "Bearer sk-test-OLD"
        ? { delayMs: 300, body: { data: [{ id: "gpt-4-old-only", created: 1 }] } }
        : { body: { data: [{ id: "gpt-5-new-only", created: 2 }] } };
    const ctrl = controls("cleanup", savedGroup({ llm: { cleanup: { provider: "openai" } } }));
    const picker = ctrl.pickers.openai;
    ctrl.keyInputs.openai.value = "sk-test-OLD";
    const first = picker.load();
    ctrl.keyInputs.openai.value = "sk-test-NEW";
    const second = picker.load();
    await Promise.all([first, second]);
    expect(providerApi.requests).toHaveLength(2);
    expect(optionTexts(picker.select)).toEqual(["(모델 미선택)", "gpt-5-new-only", "직접 입력…"]);
    expect(picker.select.disabled).toBe(false);
  });
});

describe("저장 payload — 공급자 표 기반 공통 함수", () => {
  test("GPT: 새 키는 싣고 모델은 고른 값, 빈 키는 빼서 서버가 저장된 키를 지킨다", () => {
    const group = savedGroup({ llm: { cleanup: { provider: "openai", gptApiKey: SAVED_KEY, gptModel: "gpt-4.1" } } });
    providerApi.reply = () => ({ body: OPENAI_MODELS });
    const handle = renderCleanupSection(group.cleanup, group.cleanup);
    expect(handle.isChanged()).toBe(false);
    const payload = handle.getPayload();
    expect(payload.provider).toBe("openai");
    expect(payload.gptModel).toBe("gpt-4.1");
    expect("gptApiKey" in payload).toBe(false);
    expect("anthropicModel" in payload).toBe(false);

    const keyInput = handle.element.querySelector("#llm-cleanup-gpt-key") as HTMLInputElement;
    keyInput.value = TYPED_KEY;
    expect(handle.isChanged()).toBe(true);
    expect(handle.getPayload().gptApiKey).toBe(TYPED_KEY);
  });

  test("공급자를 Gemini 로 바꾸면 payload 에 gemini 칸만, 바뀐 것으로 본다", () => {
    const group = savedGroup({ llm: { cleanup: { provider: "anthropic" } } });
    const handle = renderCleanupSection(group.cleanup, group.cleanup);
    const select = handle.element.querySelector("#llm-cleanup-provider") as HTMLSelectElement;
    select.value = "google";
    select.dispatchEvent(new Event("change"));
    expect((handle.element.querySelector("#llm-cleanup-gemini-form") as HTMLElement).style.display).toBe("");
    expect((handle.element.querySelector("#llm-cleanup-anthropic-form") as HTMLElement).style.display).toBe("none");
    expect(handle.isChanged()).toBe(true);
    const payload = handle.getPayload();
    expect(payload.provider).toBe("google");
    expect(payload.geminiModel).toBe("");
    expect("geminiApiKey" in payload).toBe(false);
  });
});
