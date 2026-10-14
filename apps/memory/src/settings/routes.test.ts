/**
 * Settings Routes — 단위 검증 (Phase 5.5 / S9).
 *
 * GET /schema · GET / · PUT / · POST /actions/list-ollama-models.
 * 본인 production data/bara.sqlite + data/memory-settings.json 과 무관 —
 * 임시 디렉토리만 건드린다.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Hono } from "hono";

import { ReloadBus } from "./reload-bus";
import { createSettingsRoutes } from "./routes";
import { MEMORY_DEFAULTS, MEMORY_SCHEMA } from "./memory-schema";

const TMP_ROOT = join(import.meta.dir, "_tmp");
let tmpDir: string;
let counter = 0;

function uniqueDir(): string {
  counter += 1;
  return join(TMP_ROOT, `routes-${process.pid}-${Date.now()}-${counter}`);
}

/** 비밀값 파일 — 라우트가 env BARA_SECRETS_PATH 를 보지 않게 케이스 임시 폴더 안 경로를 명시로 넘긴다. */
function secretsPathOf(): string {
  return join(tmpDir, "secrets.json");
}

beforeEach(() => {
  tmpDir = uniqueDir();
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TMP_ROOT("_tmp")는 secrets.test.ts · memory-settings.test.ts · routes.test.ts
// 세 테스트 파일이 공유한다 — 각자 자기 케이스 서브폴더만 지우고 끝나므로
// TMP_ROOT 껍데기가 남을 수 있다. 마지막으로 끝나는 파일이 이 껍데기를
// 마저 치우도록, "다른 파일이 아직 쓰는 중이 아닐 때"(디렉토리가 실제로
// 비어 있을 때)에 한해서만 TMP_ROOT 자체를 지운다 — 실행 중인 다른 테스트
// 파일의 서브폴더를 실수로 건드리지 않는다.
afterAll(() => {
  if (existsSync(TMP_ROOT) && readdirSync(TMP_ROOT).length === 0) {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
});

describe("settings routes — GET /schema", () => {
  test("MEMORY_SCHEMA 객체 그대로 반환", async () => {
    const bus = new ReloadBus();
    const app = createSettingsRoutes({
      reloadBus: bus,
      settingsPath: join(tmpDir, "absent.json"),
      secretsPath: secretsPathOf(),
    });
    const res = await app.request("/schema");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title?: unknown; properties?: unknown };
    expect(body.title).toBe(MEMORY_SCHEMA.title);
    expect(typeof body.properties).toBe("object");
  });
});

describe("settings routes — GET /", () => {
  test("파일 부재 = 디폴트 + $masked 첨부", async () => {
    const bus = new ReloadBus();
    const app = createSettingsRoutes({
      reloadBus: bus,
      settingsPath: join(tmpDir, "absent.json"),
      secretsPath: secretsPathOf(),
    });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      llm: {
        extractor: { anthropicApiKey: string; openaiApiKey: string };
        cleanup: { anthropicApiKey: string; openaiApiKey: string };
        vision: { anthropicApiKey: string; openaiApiKey: string };
      };
      db: { port: number; embeddingModel: string };
      $masked?: string[];
    };
    // Phase 5.7.1 W1 — 옛 embedding.model → db.embeddingModel 이전.
    // 2026-06-01 운영 default bge-m3 전환.
    expect(body.db.embeddingModel).toBe("bge-m3");
    expect(body.db.port).toBe(3001);
    expect(body.llm.extractor.anthropicApiKey).toBe("");
    expect(body.llm.extractor.openaiApiKey).toBe("");
    expect(body.llm.cleanup.anthropicApiKey).toBe("");
    expect(body.llm.cleanup.openaiApiKey).toBe("");
    expect(body.llm.vision.anthropicApiKey).toBe("");
    expect(body.llm.vision.openaiApiKey).toBe("");
    expect(body.$masked).toEqual([
      "llm.extractor.anthropicApiKey",
      "llm.extractor.openaiApiKey",
      "llm.extractor.gptApiKey",
      "llm.extractor.geminiApiKey",
      "llm.cleanup.anthropicApiKey",
      "llm.cleanup.openaiApiKey",
      "llm.cleanup.gptApiKey",
      "llm.cleanup.geminiApiKey",
      "llm.vision.anthropicApiKey",
      "llm.vision.openaiApiKey",
      "llm.vision.gptApiKey",
      "llm.vision.geminiApiKey",
      "documents.ocr.api.apiKey",
      "documents.ocr.api.anthropicApiKey",
      "documents.ocr.api.gptApiKey",
      "documents.ocr.api.geminiApiKey",
      "documents.ocr.api.openaiApiKey",
    ]);
  });

  test("저장된 키도 마스킹 적용 (extractor 슬롯)", async () => {
    const path = join(tmpDir, "with-key.json");
    writeFileSync(
      path,
      JSON.stringify({
        llm: {
          extractor: {
            enabled: true,
            provider: "anthropic",
            ollamaUrl: "http://127.0.0.1:11434",
            ollamaModel: "exaone3.5:32b",
            anthropicApiKey: "sk-ant-real",
            anthropicModel: "claude-sonnet-4-6",
            mode: "backfill",
            backfillIntervalMin: 30,
            minImportance: 0.3,
          },
        },
      }),
      "utf-8",
    );
    const bus = new ReloadBus();
    const app = createSettingsRoutes({ reloadBus: bus, settingsPath: path, secretsPath: secretsPathOf() });
    const res = await app.request("/");
    const body = (await res.json()) as {
      llm: { extractor: { anthropicApiKey: string } };
      $masked?: string[];
    };
    expect(body.llm.extractor.anthropicApiKey).toBe("");
    expect(body.$masked).toContain("llm.extractor.anthropicApiKey");
  });
});

describe("settings routes — $secretsSet (저장된 키 여부)", () => {
  const FAKE_GPT = "sk-gpt-test-SECRETSSET-9f8e7d6c";
  const FAKE_ANTHROPIC = "sk-ant-test-SECRETSSET-1a2b3c4d";

  test("GET — 값이 저장된 비밀 칸만 경로로 알리고 값은 응답 어디에도 없다", async () => {
    const path = join(tmpDir, "secrets-set.json");
    const app = createSettingsRoutes({ reloadBus: new ReloadBus(), settingsPath: path, secretsPath: secretsPathOf() });
    const put = await app.request("/", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        llm: { cleanup: { gptApiKey: FAKE_GPT }, vision: { anthropicApiKey: FAKE_ANTHROPIC } },
      }),
    });
    expect(put.status).toBe(200);
    const putText = await put.text();
    expect(putText).not.toContain(FAKE_GPT);
    expect(putText).not.toContain(FAKE_ANTHROPIC);
    expect((JSON.parse(putText) as { $secretsSet: string[] }).$secretsSet).toEqual([
      "llm.cleanup.gptApiKey",
      "llm.vision.anthropicApiKey",
    ]);

    const res = await app.request("/");
    const text = await res.text();
    expect(text).not.toContain(FAKE_GPT);
    expect(text).not.toContain(FAKE_ANTHROPIC);
    const body = JSON.parse(text) as { $secretsSet: string[]; $masked: string[]; llm: { cleanup: { gptApiKey: string } } };
    expect(body.$secretsSet).toEqual(["llm.cleanup.gptApiKey", "llm.vision.anthropicApiKey"]);
    expect(body.$masked).toContain("llm.extractor.gptApiKey");
    expect(body.llm.cleanup.gptApiKey).toBe("");
  });

  test("GET — 저장된 키가 없으면 빈 목록", async () => {
    const app = createSettingsRoutes({
      reloadBus: new ReloadBus(),
      settingsPath: join(tmpDir, "absent.json"),
      secretsPath: secretsPathOf(),
    });
    const body = (await (await app.request("/")).json()) as { $secretsSet: string[] };
    expect(body.$secretsSet).toEqual([]);
  });
});

describe("settings routes — PUT /", () => {
  describe("저장 검증 실패는 400 (서버 오류 500 이 아님)", () => {
    const savedNumCtx = process.env.OLLAMA_NUM_CTX;
    afterEach(() => {
      if (savedNumCtx === undefined) delete process.env.OLLAMA_NUM_CTX;
      else process.env.OLLAMA_NUM_CTX = savedNumCtx;
    });

    async function putAndCheckUnchanged(
      path: string,
      body: unknown,
      beforeBadPut?: () => void,
      setup: unknown = { db: { port: 4321 } },
    ) {
      const app = createSettingsRoutes({ reloadBus: new ReloadBus(), settingsPath: path, secretsPath: secretsPathOf() });
      const first = await app.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(setup),
      });
      expect(first.status).toBe(200);
      const before = readFileSync(path, "utf-8");
      beforeBadPut?.();
      const res = await app.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(readFileSync(path, "utf-8")).toBe(before);
      return res;
    }

    test("Ollama 추출기에서 출력 한도가 컨텍스트 창을 넘으면 400 + 관계 문장", async () => {
      delete process.env.OLLAMA_NUM_CTX;
      const res = await putAndCheckUnchanged(join(tmpDir, "limit-over-window.json"), {
        llm: { extractor: { provider: "ollama", maxOutputTokens: 8000 } },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; errors: string[] };
      expect(body.error).toBe("검증 실패");
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toContain("Ollama 컨텍스트 창");
    });

    test("잘못된 OLLAMA_NUM_CTX 는 400 + 환경 변수 이름이 든 문장", async () => {
      const res = await putAndCheckUnchanged(
        join(tmpDir, "bad-num-ctx.json"),
        { llm: { extractor: { provider: "ollama", maxOutputTokens: 4096 } } },
        () => {
          process.env.OLLAMA_NUM_CTX = "abc";
        },
        // 저장된 파일의 추출기는 ollama 가 아니라 읽기는 통과하고, 저장하려는 쪽(ollama 로 전환)에서만 걸린다.
        { llm: { extractor: { provider: "openai_compatible" } } },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors: string[] };
      expect(body.errors[0]).toContain("OLLAMA_NUM_CTX 가 양의 정수가 아님");
    });

    test("stageAllocation 합이 1.0 이 아니면 400", async () => {
      const res = await putAndCheckUnchanged(join(tmpDir, "stage-alloc.json"), {
        cleanupDeepPass: { budget: { stageAllocation: { regexStrengthen: 0.5 } } },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; errors: string[] };
      expect(body.error).toBe("검증 실패");
      expect(body.errors[0]).toContain("stageAllocation");
    });
  });

  test("정상 PUT = 200 + reload-bus emit + 갱신 값 반환", async () => {
    const bus = new ReloadBus();
    let reloadCount = 0;
    bus.subscribe(() => {
      reloadCount += 1;
    });
    const path = join(tmpDir, "put.json");
    const app = createSettingsRoutes({ reloadBus: bus, settingsPath: path, secretsPath: secretsPathOf() });

    const res = await app.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ db: { port: 4321 } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { db: { port: number } };
    expect(body.db.port).toBe(4321);
    expect(reloadCount).toBe(1);
  });

  test("ui.startPage graph 저장 후 다시 읽으면 보존", async () => {
    const bus = new ReloadBus();
    const path = join(tmpDir, "put-ui-start-page.json");
    const app = createSettingsRoutes({ reloadBus: bus, settingsPath: path, secretsPath: secretsPathOf() });

    const put = await app.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ui: { startPage: "graph" } }),
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { ui: { startPage: string } };
    expect(putBody.ui.startPage).toBe("graph");

    const get = await app.request("/");
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as { ui: { startPage: string } };
    expect(getBody.ui.startPage).toBe("graph");
  });

  test("정리 AI 켜기 저장(대시보드 정리 칸과 같은 부분 cleanupDeepPass)은 나머지 칸을 저장값으로 채워 통과", async () => {
    // 대시보드 정리 칸은 cleanupDeepPass 하위 묶음마다 enabled(·autoApply)만 보낸다.
    // 사전 검증이 하위 묶음을 통째로 갈아끼우면 batchSize 등이 사라져 400 이 난다.
    const bus = new ReloadBus();
    const path = join(tmpDir, "put-cleanup-linked.json");
    const app = createSettingsRoutes({ reloadBus: bus, settingsPath: path, secretsPath: secretsPathOf() });

    const res = await app.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llm: {
          cleanup: {
            enabled: true,
            provider: "anthropic",
            anthropicModel: "claude-sonnet-4-6",
            anthropicApiKey: "test-only-key",
            trigger: "on_save",
          },
        },
        cleanupDeepPass: {
          regexStrengthen: { enabled: true },
          summary: { enabled: true },
          entityRegister: { enabled: true, autoApply: false },
        },
      }),
    });
    const body = (await res.json()) as {
      errors?: string[];
      llm: { cleanup: { enabled: boolean; trigger: string } };
      cleanupDeepPass: {
        regexStrengthen: { enabled: boolean; batchSize: number };
        summary: { enabled: boolean; batchSize: number };
        entityRegister: { enabled: boolean; autoApply: boolean; batchSize: number };
      };
    };
    expect(body.errors).toBeUndefined();
    expect(res.status).toBe(200);
    expect(body.llm.cleanup.enabled).toBe(true);
    expect(body.llm.cleanup.trigger).toBe("on_save");
    const deep = body.cleanupDeepPass;
    expect(deep.regexStrengthen.enabled).toBe(true);
    expect(deep.regexStrengthen.batchSize).toBe(MEMORY_DEFAULTS.cleanupDeepPass.regexStrengthen.batchSize);
    expect(deep.summary.enabled).toBe(true);
    expect(deep.summary.batchSize).toBe(MEMORY_DEFAULTS.cleanupDeepPass.summary.batchSize);
    expect(deep.entityRegister).toEqual({
      enabled: true,
      autoApply: false,
      batchSize: MEMORY_DEFAULTS.cleanupDeepPass.entityRegister.batchSize,
    });
  });

  test("검증 실패 (enum 미일치) = 400 + errors 배열", async () => {
    const bus = new ReloadBus();
    let reloadCount = 0;
    bus.subscribe(() => {
      reloadCount += 1;
    });
    const app = createSettingsRoutes({
      reloadBus: bus,
      settingsPath: join(tmpDir, "invalid.json"),
      secretsPath: secretsPathOf(),
    });

    const res = await app.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      // Phase 5.7.1 W1 — 옛 embedding.model → db.embeddingModel 이전.
      body: JSON.stringify({ db: { embeddingModel: "no-such-model" } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; errors: string[] };
    expect(body.errors.some((e) => e.includes("enum 미일치"))).toBe(true);
    expect(reloadCount).toBe(0);
  });

  test("body 가 객체 아님 = 400", async () => {
    const bus = new ReloadBus();
    const app = createSettingsRoutes({
      reloadBus: bus,
      settingsPath: join(tmpDir, "x.json"),
      secretsPath: secretsPathOf(),
    });
    const res = await app.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "[]",
    });
    expect(res.status).toBe(400);
  });

  test("마스킹된 빈 패스워드 PUT = 옛 디스크 값 유지 (extractor 슬롯)", async () => {
    const path = join(tmpDir, "mask-shield.json");
    // 옛 키 저장 — 두 슬롯 본격 구조.
    writeFileSync(
      path,
      JSON.stringify({
        llm: {
          extractor: {
            enabled: true,
            provider: "anthropic",
            ollamaUrl: "http://127.0.0.1:11434",
            ollamaModel: "exaone3.5:32b",
            anthropicApiKey: "sk-ant-original",
            anthropicModel: "claude-sonnet-4-6",
            mode: "backfill",
            backfillIntervalMin: 30,
            minImportance: 0.3,
          },
        },
      }),
      "utf-8",
    );
    const bus = new ReloadBus();
    const app = createSettingsRoutes({ reloadBus: bus, settingsPath: path, secretsPath: secretsPathOf() });

    // 빈 패스워드 + 다른 필드 갱신 (한 슬롯 한정).
    const res = await app.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llm: {
          extractor: {
            ollamaModel: "qwen3:14b",
            anthropicApiKey: "",
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      llm: {
        extractor: { ollamaModel: string; anthropicApiKey: string };
      };
      $masked?: string[];
    };
    expect(body.llm.extractor.ollamaModel).toBe("qwen3:14b");
    // 응답 자체는 마스킹된 상태 (빈 문자열) — 실제 디스크에는 옛 값 유지.
    expect(body.llm.extractor.anthropicApiKey).toBe("");

    // 디스크 확인 — 라우터로 다시 읽어 $masked 만 보지 말고 직접 파일을 읽는다.
    // (memory-settings 가 마스킹 셰필드 적용 후 저장하므로 파일에는 옛 값이 살아있다.)
    const { getMemorySettings } = await import("./memory-settings");
    const onDisk = getMemorySettings(path, secretsPathOf());
    expect(onDisk.llm.extractor.anthropicApiKey).toBe("sk-ant-original");
  });
});

describe("settings routes — POST /actions/list-ollama-models", () => {
  // ── 응답 형식 표준: returns="enum" = 배열 직접 반환 ([{ id, name }]) ──────

  test("Ollama 응답 정규화 = [{id, name}] 배열 직접", async () => {
    // 옛 { options: [...] } 객체 형식 → dynamic-enum 위젯 isArray() 거부.
    // 본 테스트 = 신규 표준 형식 (배열 직접) 검증.
    const bus = new ReloadBus();
    const fetchImpl = (async (url: unknown) => {
      expect(String(url)).toBe("http://127.0.0.1:11434/api/tags");
      return new Response(
        JSON.stringify({
          models: [
            { name: "exaone3.5:32b", size: 0 },
            { name: "qwen3:14b", size: 0 },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const app = createSettingsRoutes({
      reloadBus: bus,
      settingsPath: join(tmpDir, "absent.json"),
      secretsPath: secretsPathOf(),
      fetchImpl,
    });
    const res = await app.request("/actions/list-ollama-models", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; name: string }>;
    // 배열 직접 반환 확인.
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0]).toEqual({ id: "exaone3.5:32b", name: "exaone3.5:32b" });
    expect(body[1]).toEqual({ id: "qwen3:14b", name: "qwen3:14b" });
  });

  test("models 빈 배열 = 빈 배열 직접 반환", async () => {
    // Ollama 호출 성공 + 모델 없음 → 빈 배열. 빈 배열 != 에러.
    const bus = new ReloadBus();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const app = createSettingsRoutes({
      reloadBus: bus,
      settingsPath: join(tmpDir, "absent.json"),
      secretsPath: secretsPathOf(),
      fetchImpl,
    });
    const res = await app.request("/actions/list-ollama-models", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(Array.isArray(body)).toBe(true);
    expect((body as unknown[]).length).toBe(0);
  });

  test("Ollama 호출 실패 = 500 + 에러 메시지", async () => {
    const bus = new ReloadBus();
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const app = createSettingsRoutes({
      reloadBus: bus,
      settingsPath: join(tmpDir, "absent.json"),
      secretsPath: secretsPathOf(),
      fetchImpl,
    });
    const res = await app.request("/actions/list-ollama-models", {
      method: "POST",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("ECONNREFUSED");
  });

  test("Ollama 응답 형식 어긋남 = 500 + 명시 에러", async () => {
    const bus = new ReloadBus();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ wrong: "shape" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const app = createSettingsRoutes({
      reloadBus: bus,
      settingsPath: join(tmpDir, "absent.json"),
      secretsPath: secretsPathOf(),
      fetchImpl,
    });
    const res = await app.request("/actions/list-ollama-models", {
      method: "POST",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("models 배열");
  });

  test("settings 읽기 실패 (파일 파싱 오류) = 500 + 명시 에러", async () => {
    // settingsPath 가 잘못된 JSON 을 담고 있으면 getMemorySettings 가 throw.
    // silent fallback 금지 — ollamaUrl 하드코딩 대신 500 + 원인 메시지 반환.
    const bus = new ReloadBus();
    const badPath = join(tmpDir, "broken.json");
    // 파싱 불가 내용 기록.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(badPath, "{ NOT VALID JSON", "utf-8");
    const app = createSettingsRoutes({
      reloadBus: bus,
      settingsPath: badPath,
      secretsPath: secretsPathOf(),
      // fetchImpl 주입 없음 — settings 읽기 단계에서 먼저 실패해야 한다.
    });
    const res = await app.request("/actions/list-ollama-models", {
      method: "POST",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    // 에러 메시지에 "ollamaUrl 획득 불가" 포함 확인.
    expect(body.error).toContain("ollamaUrl 획득 불가");
  });

  test("ollamaUrl 옵션 = 호출 URL 에 반영", async () => {
    const bus = new ReloadBus();
    let captured = "";
    const fetchImpl = (async (url: unknown) => {
      captured = String(url);
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const app = createSettingsRoutes({
      reloadBus: bus,
      settingsPath: join(tmpDir, "absent.json"),
      secretsPath: secretsPathOf(),
      ollamaUrl: () => "http://10.0.0.5:11434/",
      fetchImpl,
    });
    const res = await app.request("/actions/list-ollama-models", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(captured).toBe("http://10.0.0.5:11434/api/tags");
  });

  test("capability=vision 이면 Ollama /api/show capabilities 로 VL 모델만 남긴다", async () => {
    const bus = new ReloadBus();
    const shown: string[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target === "http://127.0.0.1:11434/api/tags") {
        return new Response(
          JSON.stringify({
            models: [
              { name: "qwen3-vl:4b-instruct" },
              { name: "qwen3:14b" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (target === "http://127.0.0.1:11434/api/show") {
        const body = JSON.parse(String(init?.body)) as { model: string };
        shown.push(body.model);
        return new Response(
          JSON.stringify({
            capabilities:
              body.model === "qwen3-vl:4b-instruct"
                ? ["completion", "vision"]
                : ["completion"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const app = createSettingsRoutes({
      reloadBus: bus,
      settingsPath: join(tmpDir, "absent.json"),
      secretsPath: secretsPathOf(),
      fetchImpl,
    });
    const res = await app.request("/actions/list-ollama-models?capability=vision", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; name: string }>;
    expect(body).toEqual([
      { id: "qwen3-vl:4b-instruct", name: "qwen3-vl:4b-instruct" },
    ]);
    expect(shown).toEqual(["qwen3-vl:4b-instruct", "qwen3:14b"]);
  });
});

describe("settings routes — POST /actions/list-lmstudio-models", () => {
  test("LM Studio /v1/models 응답을 [{id, name}] 배열로 정규화한다", async () => {
    const bus = new ReloadBus();
    let captured = "";
    const fetchImpl = (async (url: unknown) => {
      captured = String(url);
      return new Response(
        JSON.stringify({
          data: [
            { id: "qwen2.5-vl-7b-instruct" },
            { id: "llava-v1.6-mistral-7b" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const app = createSettingsRoutes({
      reloadBus: bus,
      settingsPath: join(tmpDir, "absent.json"),
      secretsPath: secretsPathOf(),
      fetchImpl,
    });

    const res = await app.request("/actions/list-lmstudio-models", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(captured).toBe("http://127.0.0.1:1234/v1/models");
    expect(await res.json()).toEqual([
      { id: "qwen2.5-vl-7b-instruct", name: "qwen2.5-vl-7b-instruct" },
      { id: "llava-v1.6-mistral-7b", name: "llava-v1.6-mistral-7b" },
    ]);
  });
});

// ── Production wiring 회귀 가드 ─────────────────────────────────────────
// 2026-05-18 dashboard settings 페이지 초기 로드 실패 — 브라우저가
// `${SETTINGS_BASE}/` 로 호출했는데 Hono strict 모드 기본값이라 `/settings/`
// 가 router root 핸들러에 매칭되지 않고 404 로 떨어졌다. 라우터를
// `strict: false` 로 만들고, mount 한 후 양 path 모두 200 임을 검증.
describe("settings routes — production wiring trailing slash", () => {
  test("`app.route('/settings', ...)` 후 /settings 와 /settings/ 둘 다 200", async () => {
    const bus = new ReloadBus();
    const sub = createSettingsRoutes({
      reloadBus: bus,
      settingsPath: join(tmpDir, "absent.json"),
      secretsPath: secretsPathOf(),
    });
    // production wiring 그대로 — buildMemoryApi 의 main Hono 도 strict:false.
    const app = new Hono({ strict: false });
    app.route("/settings", sub);

    const noSlash = await app.request("/settings");
    expect(noSlash.status).toBe(200);

    const withSlash = await app.request("/settings/");
    expect(withSlash.status).toBe(200);

    // /settings/schema 도 양쪽 모두 200 (sub-path 에도 strict:false
    // 효과 — 외부 fork 호출자 trailing slash 박더라도 같이 받음).
    const schemaNoSlash = await app.request("/settings/schema");
    expect(schemaNoSlash.status).toBe(200);
    const schemaWithSlash = await app.request("/settings/schema/");
    expect(schemaWithSlash.status).toBe(200);
  });
});
