/**
 * 저장 뒤 LLM 칸 새로 그리기 (QA 지적 4, 2026-10-11 llm-api-providers).
 *
 * 저장하면 서버 응답(가린 키 + $secretsSet)으로 LLM 칸을 다시 그려야 "저장된 키가 있습니다" 안내가 뜨고, 키 칸이
 * 비워져 다음 저장 때 같은 키를 다시 보내지 않는다. 대시보드 요청은 실제 HTTP 로 진짜 설정 라우터(임시 설정
 * 파일)에 간다 — 상대 경로만 로컬 서버 주소로 잇는다(mock 클래스 0).
 */
import "../../test-setup-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";

import { _resetTokenCacheForTest } from "./api-fetch";
import { renderMemoryTab, type InitState } from "./settings";
import { createSettingsRoutes } from "../../src/settings/routes";
import { ReloadBus } from "../../src/settings/reload-bus";
import { MEMORY_SCHEMA } from "../../src/settings/memory-schema";
import { SecretStore } from "../../src/settings/secrets";
import { putMemorySettings } from "../../src/settings/memory-settings";

const TMP_ROOT = join(import.meta.dir, "_tmp-save-refresh");
const NEW_KEY = "sk-test-SAVE-REFRESH-4242";

let server: ReturnType<typeof Bun.serve>;
let tmpDir = "";
let counter = 0;
const putBodies: Array<Record<string, unknown>> = [];
const nativeFetch = globalThis.fetch;

function paths() {
  return { settingsPath: join(tmpDir, "memory-settings.json"), secretsPath: join(tmpDir, "secrets.json") };
}

function settingsApp() {
  return createSettingsRoutes({ reloadBus: new ReloadBus(), ...paths() });
}

beforeAll(() => {
  const root = new Hono();
  root.get("/dashboard/sse-token", (c) => c.json({ token: "dash-token" }));
  root.all("/settings/*", async (c) => {
    if (c.req.method === "PUT") putBodies.push((await c.req.raw.clone().json()) as Record<string, unknown>);
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace(/^\/settings/, "") || "/";
    return settingsApp().fetch(new Request(url, c.req.raw));
  });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: root.fetch });
  const origin = `http://127.0.0.1:${server.port}`;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return nativeFetch(url.startsWith("/") ? `${origin}${url}` : url, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = nativeFetch;
  void server.stop(true);
  if (existsSync(TMP_ROOT) && readdirSync(TMP_ROOT).length === 0) rmSync(TMP_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  counter += 1;
  tmpDir = join(TMP_ROOT, `case-${process.pid}-${Date.now()}-${counter}`);
  mkdirSync(tmpDir, { recursive: true });
  putBodies.length = 0;
  window.sessionStorage.setItem("bara.dashboard.token", "dash-token");
  _resetTokenCacheForTest();
  document.body.replaceChildren();
});

afterEach(() => {
  window.sessionStorage.removeItem("bara.dashboard.token");
  _resetTokenCacheForTest();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

/** Ollama 목록 자동 조회가 이 PC 의 실제 Ollama 에 닿지 않게, 닫힌 포트를 가리키게 해 둔다(조회는 실패 안내로 끝남). */
const CLOSED_OLLAMA_URL = "http://127.0.0.1:9";

async function initState(): Promise<InitState> {
  putMemorySettings({ llm: { extractor: { ollamaUrl: CLOSED_OLLAMA_URL } } }, paths().settingsPath, paths().secretsPath);
  const value = (await (await settingsApp().request("/")).json()) as Record<string, unknown>;
  return { schema: MEMORY_SCHEMA as unknown as InitState["schema"], value, apps: [] };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await new Promise<void>((r) => setTimeout(r, 5));
}

function openSection(panel: HTMLElement, label: string): void {
  const button = Array.from(panel.querySelectorAll<HTMLButtonElement>(".memory-settings-nav-button")).find(
    (b) => b.textContent === label,
  );
  if (!button) throw new Error(`메뉴 ${label} 없음`);
  button.click();
}

function submitForm(panel: HTMLElement): void {
  const form = panel.querySelector("form");
  if (!form) throw new Error("저장 폼 없음");
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function choose(panel: HTMLElement, id: string, value: string): void {
  const select = panel.querySelector(`#${id}`) as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new Event("change"));
}

describe("저장 뒤 LLM 칸을 서버 응답으로 다시 그린다", () => {
  test("정리 슬롯: GPT 키 저장 → '저장된 키가 있습니다' 안내 + 키 칸 비움 + 다음 저장 때 키를 다시 보내지 않음", async () => {
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    renderMemoryTab(panel, await initState());
    openSection(panel, "정리");

    const enabled = panel.querySelector("#llm-cleanup-enabled") as HTMLInputElement;
    enabled.checked = true;
    enabled.dispatchEvent(new Event("change"));
    choose(panel, "llm-cleanup-provider-mode", "api");
    choose(panel, "llm-cleanup-provider", "openai");
    (panel.querySelector("#llm-cleanup-gpt-key") as HTMLInputElement).value = NEW_KEY;

    submitForm(panel);
    await settle();
    expect(putBodies).toHaveLength(1);
    expect((putBodies[0]!.llm as { cleanup: Record<string, unknown> }).cleanup.gptApiKey).toBe(NEW_KEY);
    expect(new SecretStore(paths().secretsPath).get("llm.cleanup.gptApiKey")).toBe(NEW_KEY);

    // 다시 그린 칸: 공급자는 그대로 openai, 키 칸은 비었고, 저장된 키 안내가 뜬다.
    expect((panel.querySelector("#llm-cleanup-provider") as HTMLSelectElement).value).toBe("openai");
    expect((panel.querySelector("#llm-cleanup-gpt-key") as HTMLInputElement).value).toBe("");
    const hint = panel.querySelector('#llm-cleanup-gpt-form [data-role="key-hint"]');
    expect(hint?.textContent).toBe("저장된 키가 있습니다. 바꿀 때만 새로 입력하세요.");
    expect(panel.innerHTML).not.toContain(NEW_KEY);

    submitForm(panel);
    await settle();
    expect(putBodies).toHaveLength(2);
    expect("gptApiKey" in (putBodies[1]!.llm as { cleanup: Record<string, unknown> }).cleanup).toBe(false);
  });

  test("자동 처리(의미 추출) 슬롯: Gemini 키 저장 → 안내 갱신, 바뀐 것 없으면 다음 저장에 llm 칸을 싣지 않음", async () => {
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    renderMemoryTab(panel, await initState());
    openSection(panel, "자동 처리");

    choose(panel, "llm-extractor-provider-mode", "api");
    choose(panel, "llm-extractor-provider", "google");
    (panel.querySelector("#llm-extractor-gemini-key") as HTMLInputElement).value = NEW_KEY;

    submitForm(panel);
    await settle();
    expect(putBodies).toHaveLength(1);
    expect((putBodies[0]!.llm as { extractor: Record<string, unknown> }).extractor.geminiApiKey).toBe(NEW_KEY);
    expect((panel.querySelector("#llm-extractor-provider") as HTMLSelectElement).value).toBe("google");
    expect((panel.querySelector("#llm-extractor-gemini-key") as HTMLInputElement).value).toBe("");
    expect(panel.querySelector('#llm-extractor-gemini-form [data-role="key-hint"]')?.textContent).toBe(
      "저장된 키가 있습니다. 바꿀 때만 새로 입력하세요.",
    );

    submitForm(panel);
    await settle();
    // 바뀐 것이 없으면 저장 요청을 보내지 않는다(키도 다시 보내지 않음).
    expect(putBodies).toHaveLength(1);
  });
});
