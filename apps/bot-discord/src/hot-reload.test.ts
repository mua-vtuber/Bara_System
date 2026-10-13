/**
 * hot-reload 통합 — reload-bus emit → config 재읽기 → 토큰 변경 시 client 재로그인
 * (Phase 5.5.6 / S16).
 *
 * index.ts main() 의 reload-bus 구독 로직과 같은 형태를 단위 검증 안에서 재현.
 * 봇 부팅을 트리거하지 않도록 main() 은 import 하지 않고, 같은 패턴을 그대로
 * 다시 짜 검증.
 *
 * 본인 production data/ 와 무관 — 임시 settings 경로 한정.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { loadBotConfig, type BotConfig } from "./config.ts";
import { ReloadBus } from "./reload-bus.ts";
import {
  reloginWithNewToken,
  type MinimalDiscordClient,
} from "./relogin.ts";

const TMP_ROOT = join(import.meta.dir, "_tmp-hot-reload");
let tmpDir: string;
let counter = 0;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "DISCORD_APPLICATION_ID",
  "DISCORD_MEMO_CHANNEL_ID",
  "DISCORD_GUILD_ID",
  "MEMORY_API_URL",
  "DISCORD_AUTO_EXTRACT",
];

function uniqueDir(): string {
  counter += 1;
  return join(TMP_ROOT, `case-${process.pid}-${Date.now()}-${counter}`);
}

function writeSettings(path: string, partial: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(partial, null, 2), "utf-8");
}

function baseSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    // Phase 5.7.1 W2 정합 — 8 필드 한정. 옛 activeMode / ollamaUrl /
    // ollamaModel 칸은 schema 폐기 (Phase 10 능동 모드 신규 시점 재 신설).
    discordToken: "tok-A",
    ownerId: "100",
    applicationId: "",
    guildId: "",
    memoryApiUrl: "http://127.0.0.1:3001",
    activeChannels: [],
    evolverNotify: false,
    evolverPollIntervalMin: 60,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = uniqueDir();
  mkdirSync(tmpDir, { recursive: true });
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.DISCORD_APPLICATION_ID = "999";
  process.env.DISCORD_MEMO_CHANNEL_ID = "888";
  delete process.env.DISCORD_GUILD_ID;
  delete process.env.MEMORY_API_URL;
  delete process.env.DISCORD_AUTO_EXTRACT;
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// 각 케이스 서브폴더는 afterEach 가 지우지만, TMP_ROOT 껍데기(빈 디렉토리)가
// 소스 트리에 잔재로 남는다 — 파일 전체 끝나면 TMP_ROOT 자체도 지운다.
afterAll(() => {
  if (existsSync(TMP_ROOT)) {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
});

/**
 * index.ts main() 의 구독 로직과 같은 모양을 helper 로 추출 — 단위 검증 가능.
 * caller 가 settingsPath 를 직접 넘겨 격리.
 */
function attachReloadHandler(
  reloadBus: ReloadBus,
  client: MinimalDiscordClient,
  settingsPath: string,
): { snapshot: () => BotConfig } {
  let snapshot: BotConfig = loadBotConfig(settingsPath);
  reloadBus.subscribe(() => {
    let next: BotConfig;
    try {
      next = loadBotConfig(settingsPath);
    } catch {
      return;
    }
    const tokenChanged = next.token !== snapshot.token;
    snapshot = next;
    if (tokenChanged) {
      void reloginWithNewToken(client, next.token);
    }
  });
  return { snapshot: () => snapshot };
}

describe("hot-reload — reload-bus 구독 + 토큰 변경 흐름", () => {
  test("settings 갱신 + 토큰 동일 = client 재로그인 안 함, snapshot 만 갱신", async () => {
    const path = join(tmpDir, "bot-settings.json");
    writeSettings(path, baseSettings({ discordToken: "same-tok", evolverNotify: false }));

    const reloadBus = new ReloadBus();
    const calls: string[] = [];
    const client: MinimalDiscordClient = {
      async destroy() {
        calls.push("destroy");
      },
      async login(t: string) {
        calls.push(`login:${t}`);
      },
    };
    const handle = attachReloadHandler(reloadBus, client, path);
    expect(handle.snapshot().notifyEvolverDiscord).toBe(false);

    // 토큰은 그대로, evolverNotify 만 변경
    writeSettings(path, baseSettings({ discordToken: "same-tok", evolverNotify: true }));
    reloadBus.emit();
    // 비동기 reloginWithNewToken 시도가 한 사이클 뒤 실행될 수 있어 한 틱 대기.
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toEqual([]); // 재로그인 0회
    expect(handle.snapshot().notifyEvolverDiscord).toBe(true); // snapshot 갱신
  });

  test("settings 갱신 + 토큰 변경 = destroy + 새 토큰 login", async () => {
    const path = join(tmpDir, "bot-settings.json");
    writeSettings(path, baseSettings({ discordToken: "tok-OLD" }));

    const reloadBus = new ReloadBus();
    const calls: string[] = [];
    const client: MinimalDiscordClient = {
      async destroy() {
        calls.push("destroy");
      },
      async login(t: string) {
        calls.push(`login:${t}`);
      },
    };
    const handle = attachReloadHandler(reloadBus, client, path);
    expect(handle.snapshot().token).toBe("tok-OLD");

    writeSettings(path, baseSettings({ discordToken: "tok-NEW" }));
    reloadBus.emit();
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toEqual(["destroy", "login:tok-NEW"]);
    expect(handle.snapshot().token).toBe("tok-NEW");
  });

  test("settings 갱신 시 손상된 JSON = warn 후 옛 snapshot 유지", async () => {
    const path = join(tmpDir, "bot-settings.json");
    writeSettings(path, baseSettings({ discordToken: "tok-init" }));
    const reloadBus = new ReloadBus();
    const calls: string[] = [];
    const client: MinimalDiscordClient = {
      async destroy() {
        calls.push("destroy");
      },
      async login(t: string) {
        calls.push(`login:${t}`);
      },
    };
    const handle = attachReloadHandler(reloadBus, client, path);
    const before = handle.snapshot();

    // 잘못된 JSON 으로 덮어쓰기
    writeFileSync(path, "{ invalid json", "utf-8");
    reloadBus.emit();
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toEqual([]); // 재로그인 안 함
    expect(handle.snapshot()).toEqual(before); // snapshot 그대로
  });
});
