/**
 * config — settings 전용 합산 (Phase 5.7.2 정합).
 *
 * Phase 5.7.2 single-path 정착 — 옛 autoExtract 변수 + BotConfig 필드 통째 제거.
 * loadBotConfig 는 settings-store 만 읽어 BotConfig 반환 + autoExtract 자리
 * 0 (필드 제거됨). mode='immediate' / 'backfill' 결정은 메모리 코어 권위.
 * settings.json 임시 경로로 격리 — 본인 production data/ 와 무관.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { loadBotConfig } from "./config.ts";

const TMP_ROOT = join(import.meta.dir, "_tmp-config");
let tmpDir: string;
let counter = 0;

function uniqueDir(): string {
  counter += 1;
  return join(TMP_ROOT, `case-${process.pid}-${Date.now()}-${counter}`);
}

function writeSettings(path: string, partial: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(partial, null, 2), "utf-8");
}

// MEMORY_API_URL 은 서비스 단위(systemd unit)가 넣어 주는 어댑터 계약 환경변수다.
// 개발자 셸에 남은 값이 settings 시험을 흔들지 않도록 시험마다 비우고 되돌린다.
let savedMemoryApiUrl: string | undefined;

beforeEach(() => {
  tmpDir = uniqueDir();
  mkdirSync(tmpDir, { recursive: true });
  savedMemoryApiUrl = process.env.MEMORY_API_URL;
  delete process.env.MEMORY_API_URL;
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  if (savedMemoryApiUrl === undefined) delete process.env.MEMORY_API_URL;
  else process.env.MEMORY_API_URL = savedMemoryApiUrl;
});

// 각 케이스 서브폴더는 afterEach 가 지우지만, TMP_ROOT 껍데기(빈 디렉토리)가
// 소스 트리에 잔재로 남는다 — 파일 전체 끝나면 TMP_ROOT 자체도 지운다.
afterAll(() => {
  if (existsSync(TMP_ROOT)) {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
});

describe("loadBotConfig — settings 전용 합산 (Phase 5.7.2)", () => {
  test("settings 안 8 필드 = 합산된 BotConfig + autoExtract 필드 잔존 0 (single-path 정착)", () => {
    const path = join(tmpDir, "bot-settings.json");
    writeSettings(path, {
      discordToken: "tok-abc",
      ownerId: "1234567890",
      applicationId: "999000111",
      guildId: "",
      memoryApiUrl: "http://127.0.0.1:3001",
      activeChannels: ["777666555"],
      evolverNotify: true,
      evolverPollIntervalMin: 1,
    });

    const cfg = loadBotConfig(path);

    expect(cfg.token).toBe("tok-abc");
    expect(cfg.ownerUserId).toBe("1234567890");
    expect(cfg.applicationId).toBe("999000111");
    expect(cfg.memoChannelId).toBe("777666555");
    expect(cfg.guildId).toBeUndefined();
    expect(cfg.memoryApiUrl).toBe("http://127.0.0.1:3001");
    // Phase 5.7.2 single-path 정착 — BotConfig 안 autoExtract 자리 0.
    // mode 결정은 메모리 코어 권위 (settings.llm.extractor.mode).
    expect((cfg as unknown as Record<string, unknown>).autoExtract).toBeUndefined();
    expect(cfg.notifyEvolverDiscord).toBe(true);
    expect(cfg.evolverPollIntervalMin).toBe(1);
  });

  test("settings.memoryApiUrl trailing slash 정리 + guildId 채움 + autoExtract 자리 0", () => {
    const path = join(tmpDir, "bot-settings.json");
    writeSettings(path, {
      discordToken: "tok-z",
      ownerId: "111",
      applicationId: "999000111",
      guildId: "111222333",
      memoryApiUrl: "http://127.0.0.1:3001/",
      activeChannels: [],
      evolverNotify: false,
      evolverPollIntervalMin: 60,
    });

    const cfg = loadBotConfig(path);
    expect(cfg.memoryApiUrl).toBe("http://127.0.0.1:3001");
    expect(cfg.guildId).toBe("111222333");
    // Phase 5.7.2 single-path — autoExtract 자리 0.
    expect((cfg as unknown as Record<string, unknown>).autoExtract).toBeUndefined();
  });

  test("activeChannels 빈 배열 = memoChannelId 빈 문자열 (DM 전용 흐름)", () => {
    const path = join(tmpDir, "bot-settings.json");
    writeSettings(path, {
      discordToken: "tok-abc",
      ownerId: "1234",
      applicationId: "999",
      guildId: "",
      memoryApiUrl: "http://127.0.0.1:3001",
      activeChannels: [],
      evolverNotify: false,
      evolverPollIntervalMin: 60,
    });

    const cfg = loadBotConfig(path);
    expect(cfg.memoChannelId).toBe("");
  });

  test("applicationId 빈 문자열 = BotConfig.applicationId 빈 문자열 (슬래시 등록 건너뜀)", () => {
    const path = join(tmpDir, "bot-settings.json");
    writeSettings(path, {
      discordToken: "tok",
      ownerId: "1",
      applicationId: "",
      guildId: "",
      memoryApiUrl: "http://127.0.0.1:3001",
      activeChannels: [],
      evolverNotify: false,
      evolverPollIntervalMin: 60,
    });
    // applicationId 부재는 더 이상 throw 안 함 — register-commands 가 경고 후 건너뜀
    const cfg = loadBotConfig(path);
    expect(cfg.applicationId).toBe("");
  });

  test("settings.discordToken 빈 문자열 = throw + 사용자 안내", () => {
    const path = join(tmpDir, "bot-settings.json");
    writeSettings(path, {
      discordToken: "",
      ownerId: "1111",
      applicationId: "",
      guildId: "",
      memoryApiUrl: "http://127.0.0.1:3001",
      activeChannels: [],
      evolverNotify: false,
      evolverPollIntervalMin: 60,
    });

    expect(() => loadBotConfig(path)).toThrow(/discordToken/);
  });

  test("settings 파일 부재 + 디폴트 = throw + 첫 가동 안내", () => {
    const path = join(tmpDir, "absent.json");
    // 파일 안 만들고 호출 — 디폴트는 빈 토큰이라 throw 가 자연.
    expect(() => loadBotConfig(path)).toThrow(/첫 가동|settings\.json/);
  });

  test("settings.memoryApiUrl 미입력 = 디폴트 http://127.0.0.1:3001 적용", () => {
    const path = join(tmpDir, "bot-settings.json");
    // memoryApiUrl 을 빈 문자열로 — 디폴트 정합 검증
    writeSettings(path, {
      discordToken: "tok",
      ownerId: "111",
      applicationId: "",
      guildId: "",
      memoryApiUrl: "",
      activeChannels: [],
      evolverNotify: false,
      evolverPollIntervalMin: 60,
    });
    const cfg = loadBotConfig(path);
    expect(cfg.memoryApiUrl).toBe("http://127.0.0.1:3001");
  });

  test("옛 settings.json (autoExtract / activeMode / ollama* 잔존) = settings-store silent skip + BotConfig 안 자리 0 (Phase 5.7.2)", () => {
    // 옛 디스크 파일 형태 시뮬레이션 — 봇이 5.7.1 W2 cutover 직전에 저장한 fixture.
    // settings-store mergeWithDefaults 가 BOT_FIELD_KEYS 만 순회 → 옛 4 칸이
    // BotSettings 안에 들어가지 않음 → BotConfig 에도 자리 0.
    // Phase 5.7.2 single-path 정착 — 옛 autoExtract 변수 + BotConfig 필드 통째
    // 폐기. migrate-legacy-bot-keys helper 가 디스크 잔존 옛 키 명시 삭제 권위.
    const path = join(tmpDir, "bot-settings.json");
    writeSettings(path, {
      discordToken: "tok-legacy",
      ownerId: "1111",
      applicationId: "",
      guildId: "",
      memoryApiUrl: "http://127.0.0.1:3001",
      activeChannels: [],
      evolverNotify: false,
      evolverPollIntervalMin: 60,
      // 옛 4 칸 들어가 있음 — 사용자 디스크에 잔존 (migrate helper 권위).
      autoExtract: false,
      activeMode: false,
      ollamaUrl: "http://127.0.0.1:11434",
      ollamaModel: "qwen3:8b",
    });

    const cfg = loadBotConfig(path);
    // 옛 디스크 값 흡수 X (store 가 흘려보내지 않음). Phase 5.7.2 single-path —
    // BotConfig 안 autoExtract 자리 0 (필드 통째 폐기).
    expect((cfg as unknown as Record<string, unknown>).autoExtract).toBeUndefined();
    // 옛 다른 옵션도 BotConfig 에 없음 — silent skip 정합.
    expect((cfg as unknown as Record<string, unknown>).activeMode).toBeUndefined();
    expect((cfg as unknown as Record<string, unknown>).ollamaUrl).toBeUndefined();
    expect((cfg as unknown as Record<string, unknown>).ollamaModel).toBeUndefined();
  });
});

describe("loadBotConfig — MEMORY_API_URL 환경변수 (어댑터 계약)", () => {
  function writeBase(memoryApiUrl: string): string {
    const path = join(tmpDir, "bot-settings.json");
    writeSettings(path, {
      discordToken: "tok",
      ownerId: "111",
      applicationId: "",
      guildId: "",
      memoryApiUrl,
      activeChannels: [],
      evolverNotify: false,
      evolverPollIntervalMin: 60,
    });
    return path;
  }

  test("MEMORY_API_URL 이 있으면 settings.memoryApiUrl 보다 먼저 쓴다 (끝 슬래시 정리)", () => {
    const path = writeBase("http://127.0.0.1:3001");
    process.env.MEMORY_API_URL = "http://127.0.0.1:4100/";
    expect(loadBotConfig(path).memoryApiUrl).toBe("http://127.0.0.1:4100");
  });

  test("MEMORY_API_URL 이 공백뿐이면 settings.memoryApiUrl 을 쓴다", () => {
    const path = writeBase("http://10.0.0.5:3001");
    process.env.MEMORY_API_URL = "   ";
    expect(loadBotConfig(path).memoryApiUrl).toBe("http://10.0.0.5:3001");
  });

  test("MEMORY_API_URL 도 settings 도 비면 기존 기본 주소를 쓴다", () => {
    const path = writeBase("");
    expect(loadBotConfig(path).memoryApiUrl).toBe("http://127.0.0.1:3001");
  });

  test("MEMORY_API_URL 이 주소 형식이 아니면 그 이름을 담은 오류로 멈춘다", () => {
    const path = writeBase("http://127.0.0.1:3001");
    process.env.MEMORY_API_URL = "not a url";
    expect(() => loadBotConfig(path)).toThrow(/MEMORY_API_URL/);
  });

  test("MEMORY_API_URL 이 http/https 가 아니면 그 이름을 담은 오류로 멈춘다", () => {
    const path = writeBase("http://127.0.0.1:3001");
    process.env.MEMORY_API_URL = "ftp://127.0.0.1:3001";
    expect(() => loadBotConfig(path)).toThrow(/MEMORY_API_URL/);
  });

  test("MEMORY_API_URL 이 비-loopback 평문 http 면 settings 와 같은 규칙으로 거부한다", () => {
    const path = writeBase("http://127.0.0.1:3001");
    process.env.MEMORY_API_URL = "http://memory.example.com:3001";
    expect(() => loadBotConfig(path)).toThrow(/MEMORY_API_URL/);
    process.env.MEMORY_API_URL = "https://memory.example.com:3001";
    expect(loadBotConfig(path).memoryApiUrl).toBe("https://memory.example.com:3001");
  });
});
