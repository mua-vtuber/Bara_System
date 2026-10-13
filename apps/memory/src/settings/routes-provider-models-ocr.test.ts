/**
 * POST /settings/actions/list-provider-models — slot="ocr" (2026-10-11 document-ocr spec T9).
 * 실제 설정 라우터 + 임시 설정 파일 + 공급자 자리의 진짜 로컬 HTTP 서버(mock 0).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ReloadBus } from "./reload-bus";
import { createSettingsRoutes } from "./routes";
import { putMemorySettings } from "./memory-settings";
import { startProviderStandIn, type ProviderStandIn } from "../test-utils/provider-stand-in";

const TMP_ROOT = join(import.meta.dir, "_tmp_ocr_models");
let tmpDir: string;
let counter = 0;
let standIn: ProviderStandIn;
const OCR_KEY = "sk-test-OCR-SAVED-3344";
const VISION_KEY = "sk-test-VISION-SAVED-5566";

beforeAll(() => {
  standIn = startProviderStandIn();
});
afterAll(() => {
  standIn.stop();
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
});
beforeEach(() => {
  counter += 1;
  tmpDir = join(TMP_ROOT, `${process.pid}-${Date.now()}-${counter}`);
  mkdirSync(tmpDir, { recursive: true });
});
afterEach(() => {
  standIn.requests.length = 0;
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function paths() {
  return { settingsPath: join(tmpDir, "memory-settings.json"), secretsPath: join(tmpDir, "secrets.json") };
}

async function post(body: unknown): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const app = createSettingsRoutes({
    reloadBus: new ReloadBus(),
    ...paths(),
    providerApiBaseUrlsForTest: { anthropic: standIn.origin, openai: `${standIn.origin}/v1`, google: `${standIn.origin}/v1beta` },
  });
  const res = await app.request("/actions/list-provider-models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

const ANTHROPIC_MODELS = {
  data: [
    { id: "claude-a", display_name: "A", capabilities: { image_input: { supported: true } } },
    { id: "claude-b", display_name: "B", capabilities: { image_input: { supported: false } } },
  ],
  has_more: false,
};

describe("slot=ocr", () => {
  test("저장된 키는 documents.ocr.api 에서 읽는다(이미지 캡션 키를 쓰지 않음)", async () => {
    putMemorySettings(
      { llm: { vision: { anthropicApiKey: VISION_KEY } }, documents: { ocr: { api: { anthropicApiKey: OCR_KEY } } } },
      paths().settingsPath,
      paths().secretsPath,
    );
    standIn.reply = () => ({ body: ANTHROPIC_MODELS });
    const res = await post({ slot: "ocr", provider: "anthropic" });
    expect(res.status).toBe(200);
    expect(res.json.keySource).toBe("saved");
    expect(standIn.requests[0]!.headers["x-api-key"]).toBe(OCR_KEY);
    expect(res.text).not.toContain(OCR_KEY);
  });

  test("이미지를 못 받는 모델은 거른다(vision 과 같은 판정)", async () => {
    standIn.reply = () => ({ body: ANTHROPIC_MODELS });
    const res = await post({ slot: "ocr", provider: "anthropic", apiKey: "sk-typed" });
    expect((res.json.models as Array<{ id: string }>).map((m) => m.id)).toEqual(["claude-a"]);
    expect(res.json.filter).toEqual({ kind: "image-input", removed: 1 });
  });

  test("키가 없으면 400 — 칸 이름은 documents.ocr.api.<칸>", async () => {
    const res = await post({ slot: "ocr", provider: "openai" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("documents.ocr.api.gptApiKey 가 비어 있음 — 키를 입력하거나 저장하라");
  });

  test("OpenAI 호환 주소는 documents.ocr.api.openaiBaseUrl 에서 읽고, 없으면 그 칸 이름으로 400", async () => {
    const missing = await post({ slot: "ocr", provider: "openai_compatible" });
    expect(missing.status).toBe(400);
    expect(missing.json.error).toBe("documents.ocr.api.openaiBaseUrl 가 비어 있음 — 주소를 입력하거나 저장하라");

    putMemorySettings({ documents: { ocr: { api: { openaiBaseUrl: `${standIn.origin}/v1` } } } }, paths().settingsPath, paths().secretsPath);
    standIn.reply = () => ({ body: { data: [{ id: "lm-vlm" }] } });
    const res = await post({ slot: "ocr", provider: "openai_compatible" });
    expect(res.status).toBe(200);
    expect(standIn.requests[0]!.path).toBe("/v1/models");
  });

  test("ollama 는 거절한다(로컬 모드 목록은 기존 액션)", async () => {
    const res = await post({ slot: "ocr", provider: "ollama" });
    expect(res.status).toBe(400);
  });

  test("기존 세 슬롯은 그대로 llm.<slot> 칸을 쓴다", async () => {
    const res = await post({ slot: "vision", provider: "openai" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("llm.vision.gptApiKey 가 비어 있음 — 키를 입력하거나 저장하라");
  });
});
