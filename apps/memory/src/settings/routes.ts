/**
 * Memory Core Settings Routes (Phase 5.5 / sub-phase 5.5.5 — S9)
 *
 * 메모리 코어 설정 HTTP 엔드포인트 모음.
 *   - GET  /schema                    → MEMORY_SCHEMA 그대로 반환
 *   - GET  /                          → 현 settings + 패스워드 마스킹
 *   - PUT  /                          → 검증 + 저장 + reload-bus emit
 *   - POST /actions/list-ollama-models → Ollama tags API 정규화 (dynamic-enum)
 *   - POST /actions/list-lmstudio-models → LM Studio OpenAI-compatible models 정규화
 *   - POST /actions/list-provider-models → Anthropic·OpenAI·Google·LM Studio 모델 목록 (routes-provider-models.ts)
 *
 * 메모리 라우터는 *mount 경로 없음* — caller 가 `app.route("/settings", ...)` 로 mount.
 * silent fallback 금지 정신 (CLAUDE.md): 검증 실패 = 400 + errors, 액션 실패 = 500.
 */

import { Hono } from "hono";
import type { Context } from "hono";

import { MEMORY_SCHEMA } from "./memory-schema";
import { mergeShallowGroups } from "./memory-settings-merge";
import {
  getMemorySettings,
  maskSecrets,
  MemorySettingsValidationError,
  putMemorySettings,
  validateMemorySettings,
  type MemorySettings,
  type MemorySettingsPartial,
} from "./memory-settings";
import type { ReloadBus } from "./reload-bus";
import { registerProviderModelsRoute } from "./routes-provider-models";
import { lmStudioModelsUrl, normalizeOpenAiModels, type FixedAddressOverrides } from "../llm/model-listing";

export interface SettingsRoutesOptions {
  reloadBus: ReloadBus;
  /**
   * settings 파일 경로. 필수 — 라우트는 env MEMORY_SETTINGS_PATH 를 스스로 읽지 않는다(PUT 이 이 파일을 쓴다).
   * index.ts 가 부팅 때 정한 경로를 넘기고, 테스트는 임시 디렉토리 경로를 넘긴다.
   */
  settingsPath: string;
  /**
   * 비밀값 파일 경로. 필수 — PUT 이 API 키를 이 파일에 쓴다. index.ts 가 resolveSettingsFilePaths 로 정한
   * 한 쌍(env BARA_SECRETS_PATH → settings 옆 secrets.json)을 넘기고, 테스트는 임시 경로를 넘긴다.
   */
  secretsPath: string;
  /**
   * Ollama URL provider — 호출 시점에 현 settings 의 `llm.extractor.ollamaUrl`
   * 을 반환 (Phase 5.6 W5 정합). 디폴트 = settings 파일에서 매 호출마다 다시 읽기.
   */
  ollamaUrl?: () => string;
  /**
   * fetch 주입 (테스트에서 stub 가능). 디폴트 = 전역 fetch.
   */
  fetchImpl?: typeof fetch;
  /**
   * list-provider-models 의 고정 주소(Anthropic·OpenAI·Google)를 테스트 대역 서버로 바꾼다.
   * 운영 배선(index.ts)은 넘기지 않는다 — 입력한 키는 고정 공급자 주소에만 간다.
   */
  providerApiBaseUrlsForTest?: FixedAddressOverrides;
}

interface ModelOption {
  id: string;
  name: string;
}

interface OllamaTagsResponse {
  models?: Array<{ name?: unknown; model?: unknown }>;
}

interface OllamaShowResponse {
  capabilities?: unknown;
}

function badJson(c: Context, message: string) {
  return c.json({ error: message }, 400);
}

function serverError(c: Context, message: string) {
  return c.json({ error: message }, 500);
}

/**
 * Ollama `/api/tags` 응답 → dynamic-enum 위젯 표준 형식으로 정규화.
 *
 * 반환: `[{ id, name }, ...]` 배열 직접 — `returns: "enum"` 표준 (배열 직접 반환).
 * 위젯 schema 에 `labelField: "name"`, `valueField: "id"` 로 선언되어 있어
 * 배열 직접 반환 형식과 호환된다.
 *
 * 응답 형태가 어긋나면 throw — silent fallback 금지.
 */
function normalizeOllamaTags(data: unknown): ModelOption[] {
  if (typeof data !== "object" || data === null) {
    throw new Error("Ollama 응답 형식 불일치: 객체 필요");
  }
  const models = (data as OllamaTagsResponse).models;
  if (!Array.isArray(models)) {
    throw new Error("Ollama 응답 형식 불일치: models 배열 필요");
  }
  const result: ModelOption[] = [];
  for (const entry of models) {
    if (typeof entry === "object" && entry !== null) {
      const rec = entry as { name?: unknown; model?: unknown };
      const name = typeof rec.name === "string" ? rec.name : rec.model;
      if (typeof name === "string" && name.length > 0) {
        result.push({ id: name, name });
      }
    }
  }
  return result;
}

function ollamaUrlFromSettings(opts: SettingsRoutesOptions): string {
  if (opts.ollamaUrl) return opts.ollamaUrl();
  return getMemorySettings(opts.settingsPath, opts.secretsPath).llm.extractor.ollamaUrl;
}

async function filterOllamaByCapability(
  fetchImpl: typeof fetch,
  baseUrl: string,
  models: ModelOption[],
  capability: string,
): Promise<ModelOption[]> {
  const result: ModelOption[] = [];
  const showUrl = `${baseUrl.replace(/\/$/, "")}/api/show`;
  for (const model of models) {
    const res = await fetchImpl(showUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: model.id }),
    });
    if (!res.ok) {
      throw new Error(`Ollama 모델 상세 조회 실패 — HTTP ${res.status} (${model.id})`);
    }
    const body = (await res.json()) as OllamaShowResponse;
    const capabilities = body.capabilities;
    if (
      Array.isArray(capabilities) &&
      capabilities.some((item) => item === capability)
    ) {
      result.push(model);
    }
  }
  return result;
}

export function createSettingsRoutes(opts: SettingsRoutesOptions): Hono {
  // strict: false — `app.route("/settings", ...)` 로 mount 했을 때 `/settings`
  // 와 `/settings/` (trailing slash) 양쪽 모두 라우터 root `/` 핸들러에 매칭
  // 되도록 한다. Hono 기본 strict 모드는 trailing slash 유무를 다른 path 로
  // 취급해 `/settings/` 가 404 로 떨어졌다 (2026-05-18 dashboard settings 페이지
  // 초기 로드 실패 회귀 fix — Phase 5.5.5 S9 후속).
  const app = new Hono({ strict: false });
  const reloadBus = opts.reloadBus;
  const { settingsPath, secretsPath } = opts;
  const readSettings = (): MemorySettings => getMemorySettings(settingsPath, secretsPath);
  const fetchImpl = opts.fetchImpl ?? fetch;

  // ── GET /schema ──────────────────────────────────────────────────────────
  app.get("/schema", (c) => {
    return c.json(MEMORY_SCHEMA);
  });

  // ── GET / ────────────────────────────────────────────────────────────────
  app.get("/", (c) => {
    try {
      const current = readSettings();
      const masked = maskSecrets(current);
      return c.json(masked);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return serverError(c, `settings 읽기 실패: ${message}`);
    }
  });

  // ── PUT / ────────────────────────────────────────────────────────────────
  app.put("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return badJson(c, "invalid JSON body");
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return badJson(c, "body 가 객체 형태여야 한다");
    }

    // 1) 들어온 partial 을 현재 값에 얹은 *예상 결과* 로 사전 검증.
    //    putMemorySettings 내부에서도 검증하지만, 메모리 라우터는 명시적 400 응답을
    //    위해 한 번 더 점검 후 errors 배열을 그대로 노출한다. 얹는 규칙은 저장과
    //    같은 mergeShallowGroups 한 곳만 쓴다 — 라우트에 따로 둔 얕은 병합 사본은
    //    cleanupDeepPass 하위 묶음을 통째로 갈아끼워, 저장이라면 통과할 부분 갱신
    //    ({ summary: { enabled } } 등)을 "필수 필드 누락" 400 으로 막았다.
    let current: MemorySettings;
    try {
      current = readSettings();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return serverError(c, `settings 읽기 실패: ${message}`);
    }

    const candidate = mergeShallowGroups(current, body as MemorySettingsPartial);
    const validation = validateMemorySettings(candidate);
    if (!validation.ok) {
      return c.json({ error: "검증 실패", errors: validation.errors }, 400);
    }

    // 2) 저장 — putMemorySettings 가 applyMaskingShield + atomic write 처리.
    try {
      putMemorySettings(body as Partial<MemorySettings>, settingsPath, secretsPath);
    } catch (err) {
      if (err instanceof MemorySettingsValidationError) {
        return c.json({ error: "검증 실패", errors: err.errors }, 400);
      }
      const message = err instanceof Error ? err.message : String(err);
      return serverError(c, `settings 저장 실패: ${message}`);
    }

    // 3) reload-bus 신호 송출.
    reloadBus.emit();

    // 4) 갱신 결과 (마스킹 적용) 반환.
    try {
      const refreshed = readSettings();
      return c.json(maskSecrets(refreshed));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return serverError(c, `settings 재읽기 실패: ${message}`);
    }
  });

  // ── POST /actions/list-ollama-models ─────────────────────────────────────
  app.post("/actions/list-ollama-models", async (c) => {
    let url: string;
    try {
      url = ollamaUrlFromSettings(opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return serverError(
        c,
        `settings 읽기 실패 — ollamaUrl 획득 불가: ${message}`,
      );
    }

    const fullUrl = `${url.replace(/\/$/, "")}/api/tags`;

    let data: unknown;
    try {
      const res = await fetchImpl(fullUrl);
      if (!res.ok) {
        return serverError(
          c,
          `Ollama 호출 실패 — HTTP ${res.status} (${fullUrl})`,
        );
      }
      data = await res.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return serverError(c, `Ollama 호출 실패 — ${message} (${fullUrl})`);
    }

    try {
      const models = normalizeOllamaTags(data);
      if (c.req.query("capability") === "vision") {
        return c.json(
          await filterOllamaByCapability(fetchImpl, url, models, "vision"),
        );
      }
      return c.json(models);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return serverError(c, message);
    }
  });

  // ── POST /actions/list-lmstudio-models ───────────────────────────────────
  app.post("/actions/list-lmstudio-models", async (c) => {
    let url: string;
    try {
      url = readSettings().documents.ocr.local.lmstudioUrl;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return serverError(
        c,
        `settings 읽기 실패 — lmstudioUrl 획득 불가: ${message}`,
      );
    }

    const fullUrl = lmStudioModelsUrl(url);
    try {
      const res = await fetchImpl(fullUrl);
      if (!res.ok) {
        return serverError(
          c,
          `LM Studio 호출 실패 — HTTP ${res.status} (${fullUrl})`,
        );
      }
      return c.json(normalizeOpenAiModels(await res.json(), "LM Studio"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return serverError(c, `LM Studio 호출 실패 — ${message} (${fullUrl})`);
    }
  });

  // ── POST /actions/list-provider-models ───────────────────────────────────
  registerProviderModelsRoute(app, {
    readSettings,
    ...(opts.providerApiBaseUrlsForTest ? { fixedAddressOverrides: opts.providerApiBaseUrlsForTest } : {}),
  });

  return app;
}
