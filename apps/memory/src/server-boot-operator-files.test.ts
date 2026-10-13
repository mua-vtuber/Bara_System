/**
 * server-boot-operator-files.test.ts — 부팅 도우미가 운영 파일에 닿지 않는다는 회귀 테스트.
 *
 * 재QA 재현(먼저 옮긴 빨간 테스트): apps/memory/.env 에 SSE_TOKEN_PATH 를 README 처럼 적어 두면, createMemoryApi 를
 * 부르는 테스트(server-boot·tools-cleanup)가 운영 data/sse-tokens.json 에 full 권한 dashboard 토큰과 scope 없는
 * claude-code 토큰을 써 넣었다. settings 없이 부팅한 테스트는 운영 설정의 API 키를 비밀값 파일로 옮겨 쓰기도 했다.
 * 같은 부류로 /settings 라우트는 임시 settings 경로를 받아도 env BARA_SECRETS_PATH 를 먼저 따라 운영 비밀값 파일에 썼다.
 *
 * 설정 파일을 직접 읽고 쓰는 테스트(get/putMemorySettings 호출 약 200곳)도 env BARA_SECRETS_PATH 를 먼저 따라 운영 비밀값 파일에 썼다.
 *
 * 이 파일은 env 세 개(SSE_TOKEN_PATH·MEMORY_SETTINGS_PATH·BARA_SECRETS_PATH)를 진짜처럼 생긴 운영 파일로 가리킨 채
 * createMemoryApi·createSettingsRoutes·get/putMemorySettings 를 임시 경로로 부른다. 운영 폴더는 바이트 단위로 그대로여야
 * 하고, 쓰기는 넘긴 임시 파일에만 생겨야 한다. env 는 afterAll 에서 원래 값으로 되돌린다.
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder 부팅(createMemoryApi) — mock 객체 없음. 모델 로드로 느려 timeout 을 넉넉히 둔다.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReloadBus } from "./settings/reload-bus.ts";
import { createSettingsRoutes } from "./settings/routes.ts";
import { SecretStore } from "./settings/secrets.ts";
import { SseTokenStore } from "./federation/sse-tokens.ts";
import { createMemoryApi } from "./server.ts";
import { MEMORY_DEFAULTS } from "./settings/memory-schema.ts";
import {
  getMemorySettings,
  putMemorySettings,
  resolveSettingsFilePaths,
  type MemorySettings,
} from "./settings/memory-settings.ts";

const ENV_KEYS = ["SSE_TOKEN_PATH", "MEMORY_SETTINGS_PATH", "BARA_SECRETS_PATH"] as const;
const savedEnv = new Map<string, string | undefined>();
const API_KEY_PATH = "llm.extractor.anthropicApiKey";

let root: string;
let operatorDir: string;

const realLookingToken = () => randomBytes(32).toString("base64url");
const realLookingKey = () => `sk-ant-api03-${randomBytes(24).toString("base64url")}`;

/** 운영 폴더 전체를 이름 → 바이트(hex)로 찍는다. 새 파일이 생기거나 한 바이트라도 바뀌면 달라진다. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) out[name] = readFileSync(join(dir, name)).toString("hex");
  return out;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "bara-operator-files-"));
  operatorDir = join(root, "operator-data");
  mkdirSync(operatorDir);
  writeFileSync(join(operatorDir, "sse-tokens.json"), `${JSON.stringify({
    version: 2,
    tokens: { "bot-discord": realLookingToken(), "pet-desktop": realLookingToken() },
    tokenMeta: {
      "bot-discord": { issuedAt: "2026-09-20T03:11:42.118Z", scope: "mcp-standard", endpoint: "http://127.0.0.1:3101" },
      "pet-desktop": { issuedAt: "2026-09-25T10:02:07.554Z", scope: "read-only" },
    },
    requests: {},
  }, null, 2)}\n`);
  // 옛 운영 설정처럼 json 안에 키가 남아 있다 — 이 파일을 읽기만 해도 비밀값 파일로 옮겨 쓰는 경로가 돈다.
  writeFileSync(join(operatorDir, "memory-settings.json"), `${JSON.stringify({ llm: { extractor: { anthropicApiKey: realLookingKey() } } }, null, 2)}\n`);
  writeFileSync(join(operatorDir, "secrets.json"), `${JSON.stringify({ version: 1, secrets: { "llm.cleanup.anthropicApiKey": realLookingKey() } }, null, 2)}\n`);
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.SSE_TOKEN_PATH = join(operatorDir, "sse-tokens.json");
  process.env.MEMORY_SETTINGS_PATH = join(operatorDir, "memory-settings.json");
  process.env.BARA_SECRETS_PATH = join(operatorDir, "secrets.json");
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("부팅 도우미는 넘긴 임시 파일만 쓰고 운영 파일(env 가 가리키는 파일)은 바이트 그대로 둔다", () => {
  test("createMemoryApi — 토큰은 sseTokenFilePath 에만, 운영 토큰·설정·비밀값 파일은 그대로", async () => {
    const before = snapshot(operatorDir);
    const testDir = join(root, "boot");
    const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
    settings.reranker.enabled = false;
    settings.db.embeddingModel = "bge-m3";
    settings.backup.dir = join(testDir, "backups");
    const sseTokenFilePath = join(testDir, "sse-tokens.json");
    const api = await createMemoryApi({
      dbPath: ":memory:",
      assetDir: join(testDir, "assets"),
      sseTokenFilePath,
      settingsFilePath: join(testDir, "memory-settings.json"),
      llmProvider: "none",
      settings,
    });
    let claudeToken: string;
    try {
      // tools-cleanup (f) 처럼 부팅 인스턴스로 scope 없는 토큰을 하나 더 발급한다 — 이것도 임시 파일로만 가야 한다.
      claudeToken = api.sseTokens.issueToken("claude-code");
    } finally {
      api.shutdown();
    }

    expect(snapshot(operatorDir)).toEqual(before);
    const written = new SseTokenStore(sseTokenFilePath);
    expect(written.getTokenScope("dashboard")).toBe("full");
    expect(written.verifyToken(claudeToken)).toBe("claude-code");
  }, 120_000);

  test("createSettingsRoutes — 임시 settingsPath·secretsPath 로 읽고 쓰며 env BARA_SECRETS_PATH 를 따르지 않는다", async () => {
    const before = snapshot(operatorDir);
    const testDir = join(root, "settings-routes");
    mkdirSync(testDir);
    const settingsPath = join(testDir, "memory-settings.json");
    const secretsPath = join(testDir, "secrets.json");
    // json 안 키 — GET 이 읽으면서 비밀값 파일로 옮긴다(옮겨 쓰는 곳이 secretsPath 여야 한다).
    writeFileSync(settingsPath, JSON.stringify({ llm: { extractor: { anthropicApiKey: "sk-ant-test-inline" } } }));
    const app = createSettingsRoutes({ reloadBus: new ReloadBus(), settingsPath, secretsPath });

    const got = await app.request("/");
    expect(got.status).toBe(200);
    expect(new SecretStore(secretsPath).get(API_KEY_PATH)).toBe("sk-ant-test-inline");

    const put = await app.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llm: { extractor: { anthropicApiKey: "sk-ant-test-put" } } }),
    });
    expect(put.status).toBe(200);
    expect(new SecretStore(secretsPath).get(API_KEY_PATH)).toBe("sk-ant-test-put");
    expect(snapshot(operatorDir)).toEqual(before);
  });

  test("get/putMemorySettings — 넘긴 settings·비밀값 한 쌍만 읽고 쓰며 env 가 가리키는 운영 파일은 그대로", () => {
    const before = snapshot(operatorDir);
    const testDir = join(root, "settings-io");
    mkdirSync(testDir);
    const settingsPath = join(testDir, "memory-settings.json");
    const secretsPath = join(testDir, "secrets.json");
    // json 안 키 — 읽기만으로 비밀값 파일로 옮겨 쓰는 경로가 돈다(옮겨 쓰는 곳이 secretsPath 여야 한다).
    writeFileSync(settingsPath, JSON.stringify({ llm: { extractor: { anthropicApiKey: "sk-ant-test-inline" } } }));

    expect(getMemorySettings(settingsPath, secretsPath).llm.extractor.anthropicApiKey).toBe("sk-ant-test-inline");
    putMemorySettings({ llm: { cleanup: { anthropicApiKey: "sk-ant-test-put" } } }, settingsPath, secretsPath);

    const written = new SecretStore(secretsPath);
    expect(written.get(API_KEY_PATH)).toBe("sk-ant-test-inline");
    expect(written.get("llm.cleanup.anthropicApiKey")).toBe("sk-ant-test-put");
    expect(snapshot(operatorDir)).toEqual(before);
  });
});

describe("resolveSettingsFilePaths — 부팅이 env 로 정하는 settings·비밀값 한 쌍", () => {
  test("BARA_SECRETS_PATH 가 있으면 그 파일, 없으면 settings 옆 secrets.json, 둘 다 없으면 data/ 기본값", () => {
    const settingsPath = join("conf", "memory-settings.json");
    expect(resolveSettingsFilePaths({ MEMORY_SETTINGS_PATH: settingsPath, BARA_SECRETS_PATH: " keys/private.json " })).toEqual({
      settingsPath,
      secretsPath: "keys/private.json",
    });
    expect(resolveSettingsFilePaths({ MEMORY_SETTINGS_PATH: settingsPath })).toEqual({
      settingsPath,
      secretsPath: join("conf", "secrets.json"),
    });
    expect(resolveSettingsFilePaths({})).toEqual({
      settingsPath: "data/memory-settings.json",
      secretsPath: join("data", "secrets.json"),
    });
  });
});
