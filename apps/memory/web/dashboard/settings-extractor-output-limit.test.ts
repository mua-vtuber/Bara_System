/**
 * 설정 › 실험값 — 추출 출력 한도(llm.extractor.maxOutputTokens) 칸 (2026-10-15 extractor-output-limit spec 3.1, Q3).
 *
 * 대시보드 요청은 실제 HTTP 로 진짜 설정 라우터(임시 설정 파일)에 간다 — 상대 경로만 로컬 서버 주소로 잇는다(mock 클래스 0).
 * 일반 칸 목록이 llm 아래 잎 경로를 그려도 "자동 처리" 화면의 추출 칸 그리기와 겹치지 않는지(값이 사라지거나 덮이지 않는지)를 본다.
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
import { putMemorySettings } from "../../src/settings/memory-settings";
import {
  EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT,
  EXTRACTOR_MAX_OUTPUT_TOKENS_MAX,
} from "../../src/memory/extractor-output-limit";

const TMP_ROOT = join(import.meta.dir, "_tmp-extractor-output-limit");
const FIELD_TITLE = "추출 출력 한도(토큰)";
const CHANGED_LIMIT = 2048;
const CHANGED_INTERVAL_MIN = 45;

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

async function serverExtractor(): Promise<{
  maxOutputTokens: number;
  ollamaUrl: string;
  backfill: { intervalMin: number };
}> {
  const saved = (await (await settingsApp().request("/")).json()) as {
    llm: { extractor: { maxOutputTokens: number; ollamaUrl: string; backfill: { intervalMin: number } } };
  };
  return saved.llm.extractor;
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

/** 제목 글자가 든 라벨에 이어진 입력 칸. 라벨이 정확히 하나가 아니면 던진다(중복 칸 검출 겸용). */
function fieldByTitle(panel: HTMLElement, title: string): HTMLInputElement {
  const labels = Array.from(panel.querySelectorAll<HTMLLabelElement>("label")).filter((l) =>
    (l.textContent ?? "").includes(title),
  );
  if (labels.length !== 1) throw new Error(`"${title}" 라벨이 ${labels.length}개 (정확히 1개여야 함)`);
  const label = labels[0]!;
  const input =
    (label.htmlFor ? panel.querySelector(`#${CSS.escape(label.htmlFor)}`) : null) ??
    label.querySelector("input") ??
    label.parentElement?.querySelector("input") ??
    null;
  if (!(input instanceof HTMLInputElement)) throw new Error(`"${title}" 라벨에 이어진 입력 칸 없음`);
  return input;
}

function typeValue(input: HTMLInputElement, value: number): void {
  input.value = String(value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("실험값 화면의 추출 출력 한도 칸", () => {
  test("칸이 한 번만 보이고 서버 값(기본 상수)으로 채워진다", async () => {
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    renderMemoryTab(panel, await initState());
    openSection(panel, "실험값");
    expect(fieldByTitle(panel, FIELD_TITLE).value).toBe(String(EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT));
  });

  test("스키마 설명이 칸 아래에 보인다(핵심 관계 문장 포함)", async () => {
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    renderMemoryTab(panel, await initState());
    openSection(panel, "실험값");
    expect(panel.textContent ?? "").toContain("컨텍스트 창");
    expect(panel.textContent ?? "").toContain("응답이 이 한도에 걸려 잘린 기억");
  });

  test("값을 바꿔 저장하면 PUT 본문이 llm.extractor.maxOutputTokens 하나뿐이고 서버 파일에 반영된다", async () => {
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    renderMemoryTab(panel, await initState());
    openSection(panel, "실험값");
    typeValue(fieldByTitle(panel, FIELD_TITLE), CHANGED_LIMIT);

    submitForm(panel);
    await settle();
    expect(putBodies).toEqual([{ llm: { extractor: { maxOutputTokens: CHANGED_LIMIT } } }]);
    const extractor = await serverExtractor();
    expect(extractor.maxOutputTokens).toBe(CHANGED_LIMIT);
    expect(extractor.ollamaUrl).toBe(CLOSED_OLLAMA_URL);
  });

  test("서버가 거부하는 값(상한 초과)은 파일을 바꾸지 않는다", async () => {
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    renderMemoryTab(panel, await initState());
    openSection(panel, "실험값");
    typeValue(fieldByTitle(panel, FIELD_TITLE), EXTRACTOR_MAX_OUTPUT_TOKENS_MAX + 1);

    submitForm(panel);
    await settle();
    expect((await serverExtractor()).maxOutputTokens).toBe(EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT);
  });
});

describe("자동 처리 화면과 겹치지 않는다 (같은 llm.extractor 슬롯)", () => {
  test("실험값에서 바꾼 한도가 있는 상태로 자동 처리 화면을 저장해도 한도가 유지되고 본문에 실리지 않는다", async () => {
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    renderMemoryTab(panel, await initState());
    openSection(panel, "실험값");
    typeValue(fieldByTitle(panel, FIELD_TITLE), CHANGED_LIMIT);
    submitForm(panel);
    await settle();
    expect(putBodies).toHaveLength(1);

    // 저장 응답이 state.value 로 돌아왔다. 이제 자동 처리 화면에서 다른 추출기 칸을 바꿔 저장한다.
    openSection(panel, "자동 처리");
    const interval = panel.querySelector("#llm-extractor-backfill-intervalMin") as HTMLInputElement;
    typeValue(interval, CHANGED_INTERVAL_MIN);
    submitForm(panel);
    await settle();

    expect(putBodies).toHaveLength(2);
    const extractorBody = (putBodies[1]!.llm as { extractor: Record<string, unknown> }).extractor;
    expect("maxOutputTokens" in extractorBody).toBe(false);
    const extractor = await serverExtractor();
    expect(extractor.maxOutputTokens).toBe(CHANGED_LIMIT);
    expect(extractor.backfill.intervalMin).toBe(CHANGED_INTERVAL_MIN);
  });

  test("자동 처리 화면에는 이 칸이 나오지 않는다(중복 칸 없음)", async () => {
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    renderMemoryTab(panel, await initState());
    openSection(panel, "자동 처리");
    expect(panel.textContent ?? "").not.toContain(FIELD_TITLE);
  });
});
