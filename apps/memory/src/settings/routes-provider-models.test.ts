/**
 * POST /settings/actions/list-provider-models (2026-10-11 llm-api-providers spec T8).
 * 실제 설정 라우터 + 임시 설정 파일 + 공급자 자리의 진짜 로컬 HTTP 서버로 검증한다(mock 0).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ReloadBus } from "./reload-bus";
import { createSettingsRoutes } from "./routes";
import { putMemorySettings } from "./memory-settings";
import { startProviderStandIn, type ProviderStandIn, type RecordedRequest } from "../test-utils/provider-stand-in";

const TMP_ROOT = join(import.meta.dir, "_tmp");
let tmpDir: string;
let counter = 0;
let standIn: ProviderStandIn;

const TYPED_KEY = "sk-test-TYPED-aaaa1111";
const SAVED_KEY = "sk-test-SAVED-bbbb2222";

beforeAll(() => {
  standIn = startProviderStandIn();
});
afterAll(() => {
  standIn.stop();
  if (existsSync(TMP_ROOT) && readdirSync(TMP_ROOT).length === 0) rmSync(TMP_ROOT, { recursive: true, force: true });
});
beforeEach(() => {
  counter += 1;
  tmpDir = join(TMP_ROOT, `provider-models-${process.pid}-${Date.now()}-${counter}`);
  mkdirSync(tmpDir, { recursive: true });
});
afterEach(() => {
  standIn.requests.length = 0;
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function paths() {
  return { settingsPath: join(tmpDir, "memory-settings.json"), secretsPath: join(tmpDir, "secrets.json") };
}

function app() {
  return createSettingsRoutes({
    reloadBus: new ReloadBus(),
    ...paths(),
    providerApiBaseUrlsForTest: {
      anthropic: standIn.origin,
      openai: `${standIn.origin}/v1`,
      google: `${standIn.origin}/v1beta`,
    },
  });
}

async function post(body: unknown): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const res = await app().request("/actions/list-provider-models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

const OPENAI_MODELS = {
  object: "list",
  data: [
    { id: "gpt-4o", created: 100, owned_by: "openai" },
    { id: "text-embedding-3-small", created: 300, owned_by: "openai" },
    { id: "gpt-5", created: 500, owned_by: "openai" },
    { id: "gpt-4o-realtime-preview", created: 400, owned_by: "openai" },
    { id: "gpt-3.5-turbo", created: 50, owned_by: "openai", shutdown_date: "2026-12-01" },
  ],
};

describe("키 고르기", () => {
  test("입력한 키가 있으면 그 키(Bearer 헤더, URL 에 없음) — keySource=typed", async () => {
    putMemorySettings({ llm: { cleanup: { gptApiKey: SAVED_KEY } } }, paths().settingsPath, paths().secretsPath);
    standIn.reply = () => ({ body: OPENAI_MODELS });
    const res = await post({ slot: "cleanup", provider: "openai", apiKey: TYPED_KEY });
    expect(res.status).toBe(200);
    expect(res.json.keySource).toBe("typed");
    const req = standIn.requests[0]!;
    expect(req.path).toBe("/v1/models");
    expect(req.headers.authorization).toBe(`Bearer ${TYPED_KEY}`);
    expect(req.path + req.search).not.toContain(TYPED_KEY);
  });

  test("입력한 키가 없으면 저장된 키 — keySource=saved", async () => {
    putMemorySettings({ llm: { vision: { gptApiKey: SAVED_KEY } } }, paths().settingsPath, paths().secretsPath);
    standIn.reply = () => ({ body: OPENAI_MODELS });
    const res = await post({ slot: "vision", provider: "openai", apiKey: "  " });
    expect(res.status).toBe(200);
    expect(res.json.keySource).toBe("saved");
    expect(standIn.requests[0]!.headers.authorization).toBe(`Bearer ${SAVED_KEY}`);
    expect(res.text).not.toContain(SAVED_KEY);
  });

  test("키가 필요한데 입력·저장 둘 다 없으면 400 + 칸 이름, 공급자 호출 0", async () => {
    const res = await post({ slot: "cleanup", provider: "openai" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("llm.cleanup.gptApiKey 가 비어 있음 — 키를 입력하거나 저장하라");
    expect(standIn.requests).toHaveLength(0);
  });

  test("고정 주소 공급자에 주소가 오면 400 (입력한 키를 남의 주소로 보내지 않음)", async () => {
    const res = await post({ slot: "cleanup", provider: "google", apiKey: TYPED_KEY, baseUrl: "http://evil.example" });
    expect(res.status).toBe(400);
    expect(standIn.requests).toHaveLength(0);
  });

  test("형식 오류 — 모르는 slot·provider 는 400", async () => {
    expect((await post({ slot: "other", provider: "openai", apiKey: "k" })).status).toBe(400);
    expect((await post({ slot: "cleanup", provider: "ollama", apiKey: "k" })).status).toBe(400);
  });
});

describe("공급자 실패 → 502 + 가림", () => {
  test("공급자가 오류 본문에 키를 되돌려 줘도 응답에는 키가 없다", async () => {
    standIn.reply = () => ({
      status: 401,
      body: { error: { message: `Incorrect API key provided: ${TYPED_KEY}`, code: "invalid_api_key" } },
    });
    const res = await post({ slot: "extractor", provider: "openai", apiKey: TYPED_KEY });
    expect(res.status).toBe(502);
    expect(res.json.status).toBe(401);
    expect(res.text).not.toContain(TYPED_KEY);
    expect(String(res.json.error)).toContain("401");
  });
});

describe("OpenAI — 대화 모델 이름 규칙(OpenAI 에만)", () => {
  test("대화 모델만 남기고 걸러 낸 개수, 만든 날짜 최신순, shutdown_date 는 지원 종료 예정", async () => {
    standIn.reply = () => ({ body: OPENAI_MODELS });
    const res = await post({ slot: "cleanup", provider: "openai", apiKey: TYPED_KEY });
    expect(res.json.filter).toEqual({ kind: "name-rule", removed: 2 });
    expect(res.json.models).toEqual([
      { id: "gpt-5", label: "gpt-5", imageInput: null, deprecated: false },
      { id: "gpt-4o", label: "gpt-4o", imageInput: null, deprecated: false },
      { id: "gpt-3.5-turbo", label: "gpt-3.5-turbo", imageInput: null, deprecated: true },
    ]);
  });

  test("LM Studio 목록에는 이름 규칙을 쓰지 않는다 + 입력한 주소 사용", async () => {
    standIn.reply = () => ({ body: OPENAI_MODELS });
    const res = await post({ slot: "cleanup", provider: "openai_compatible", baseUrl: `${standIn.origin}/v1` });
    expect(res.status).toBe(200);
    expect(res.json.keySource).toBe("none");
    expect(res.json.filter).toEqual({ kind: "none", removed: 0 });
    expect((res.json.models as unknown[]).length).toBe(5);
    expect(standIn.requests[0]!.headers.authorization).toBeUndefined();
  });

  test("LM Studio 는 주소를 입력하지 않으면 저장된 주소를 쓴다", async () => {
    putMemorySettings({ llm: { vision: { openaiBaseUrl: `${standIn.origin}/v1` } } }, paths().settingsPath, paths().secretsPath);
    standIn.reply = () => ({ body: { data: [{ id: "local-vlm" }] } });
    const res = await post({ slot: "vision", provider: "openai_compatible" });
    expect(res.status).toBe(200);
    expect(res.json.models).toEqual([{ id: "local-vlm", label: "local-vlm", imageInput: null, deprecated: false }]);
  });
});

describe("Anthropic — 페이지 반복·이미지 거르기", () => {
  function anthropicPages(req: RecordedRequest) {
    const after = new URLSearchParams(req.search).get("after_id");
    if (after === null) {
      return {
        body: {
          data: [
            { id: "claude-a", display_name: "Claude A", capabilities: { image_input: { supported: true } } },
            { id: "claude-b", display_name: "Claude B", capabilities: { image_input: { supported: false } }, lifecycle: "deprecated" },
          ],
          has_more: true,
          last_id: "claude-b",
        },
      };
    }
    return { body: { data: [{ id: "claude-c", display_name: "Claude C" }], has_more: false, last_id: "claude-c" } };
  }

  test("has_more/last_id 로 이어 받고 x-api-key·anthropic-version 헤더를 싣는다", async () => {
    standIn.reply = anthropicPages;
    const res = await post({ slot: "cleanup", provider: "anthropic", apiKey: TYPED_KEY });
    expect(res.status).toBe(200);
    expect(standIn.requests).toHaveLength(2);
    expect(standIn.requests[0]!.path).toBe("/v1/models");
    expect(new URLSearchParams(standIn.requests[0]!.search).get("limit")).toBe("1000");
    expect(new URLSearchParams(standIn.requests[1]!.search).get("after_id")).toBe("claude-b");
    expect(standIn.requests[0]!.headers["x-api-key"]).toBe(TYPED_KEY);
    expect(standIn.requests[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(res.json.filter).toEqual({ kind: "none", removed: 0 });
    expect(res.json.models).toEqual([
      { id: "claude-a", label: "Claude A", imageInput: true, deprecated: false },
      { id: "claude-b", label: "Claude B", imageInput: false, deprecated: true },
      { id: "claude-c", label: "Claude C", imageInput: null, deprecated: false },
    ]);
  });

  test("vision 슬롯은 이미지를 못 받는 모델을 빼고 개수를 알린다", async () => {
    standIn.reply = anthropicPages;
    const res = await post({ slot: "vision", provider: "anthropic", apiKey: TYPED_KEY });
    expect(res.json.filter).toEqual({ kind: "image-input", removed: 1 });
    expect((res.json.models as Array<{ id: string }>).map((m) => m.id)).toEqual(["claude-a", "claude-c"]);
  });

  test("페이지 상한(10번)을 넘으면 502 — 받은 데까지로 꾸며 내지 않는다", async () => {
    let n = 0;
    standIn.reply = () => {
      n += 1;
      return { body: { data: [{ id: `m-${n}` }], has_more: true, last_id: `m-${n}` } };
    };
    const res = await post({ slot: "cleanup", provider: "anthropic", apiKey: TYPED_KEY });
    expect(res.status).toBe(502);
    expect(standIn.requests).toHaveLength(10);
    expect(res.json.status).toBeNull();
  });
});

describe("Gemini — generateContent 거르기·앞머리 제거·페이지", () => {
  test("generateContent 를 못 하는 모델을 빼고 id 는 models/ 를 뗀 값, 키는 헤더에만", async () => {
    standIn.reply = (req) => {
      const token = new URLSearchParams(req.search).get("pageToken");
      if (token === null) {
        return {
          body: {
            models: [
              { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent", "countTokens"] },
              { name: "models/text-embedding-004", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
            ],
            nextPageToken: "p2",
          },
        };
      }
      return { body: { models: [{ name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] }] } };
    };
    const res = await post({ slot: "vision", provider: "google", apiKey: TYPED_KEY });
    expect(res.status).toBe(200);
    expect(res.json.filter).toEqual({ kind: "generate-content", removed: 1 });
    expect(res.json.models).toEqual([
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", imageInput: null, deprecated: false },
      { id: "gemini-2.5-pro", label: "gemini-2.5-pro", imageInput: null, deprecated: false },
    ]);
    const first = standIn.requests[0]!;
    expect(first.path).toBe("/v1beta/models");
    expect(new URLSearchParams(first.search).get("pageSize")).toBe("1000");
    expect(first.search).not.toContain(TYPED_KEY);
    expect(first.headers["x-goog-api-key"]).toBe(TYPED_KEY);
    expect(new URLSearchParams(standIn.requests[1]!.search).get("pageToken")).toBe("p2");
  });

  test("성공했지만 볼 수 있는 모델이 0개면 빈 목록(실패가 아님)", async () => {
    standIn.reply = () => ({ body: {} });
    const res = await post({ slot: "extractor", provider: "google", apiKey: TYPED_KEY });
    expect(res.status).toBe(200);
    expect(res.json.models).toEqual([]);
  });
});
