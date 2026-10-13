/**
 * GPT·Gemini 설정 칸 — 옛 설정 파일 읽기와 비밀 파일 분리 (2026-10-11 llm-api-providers spec T1).
 * 실제 임시 파일만 쓴다(mock 0).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getSettingsAt, putSettingsAt } from "../test-utils/settings-files";
import { SecretStore } from "./secrets";
import { validateMemorySettings } from "./memory-settings";

const TMP_ROOT = join(import.meta.dir, "_tmp");
let tmpDir: string;
let counter = 0;

beforeEach(() => {
  counter += 1;
  tmpDir = join(TMP_ROOT, `llm-provider-fields-${process.pid}-${Date.now()}-${counter}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
  if (existsSync(TMP_ROOT) && readdirSync(TMP_ROOT).length === 0) {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
});

// 진짜 키가 아닌 추측 불가 fixture.
const FAKE_ANTHROPIC = "sk-ant-test-OLD-FAKE-0000aaaa";
const FAKE_GPT = { extractor: "sk-gpt-test-EXT-1111", cleanup: "sk-gpt-test-CLN-2222", vision: "sk-gpt-test-VIS-3333" };
const FAKE_GEMINI = { extractor: "gm-test-EXT-4444", cleanup: "gm-test-CLN-5555", vision: "gm-test-VIS-6666" };

describe("새 칸이 없는 옛 설정 파일", () => {
  test("읽으면 새 칸은 기본값(빈 칸), 기존 공급자·키·모델은 그대로", () => {
    const path = join(tmpDir, "memory-settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        llm: {
          extractor: { enabled: true, provider: "anthropic", anthropicModel: "claude-haiku-4-5" },
          cleanup: { enabled: true, provider: "openai_compatible", openaiModel: "qwen3:32b" },
        },
      }),
      "utf-8",
    );
    new SecretStore(join(tmpDir, "secrets.json")).set("llm.extractor.anthropicApiKey", FAKE_ANTHROPIC);

    const loaded = getSettingsAt(path);
    expect(loaded.llm.extractor.provider).toBe("anthropic");
    expect(loaded.llm.extractor.anthropicApiKey).toBe(FAKE_ANTHROPIC);
    expect(loaded.llm.extractor.anthropicModel).toBe("claude-haiku-4-5");
    expect(loaded.llm.cleanup.provider).toBe("openai_compatible");
    expect(loaded.llm.cleanup.openaiModel).toBe("qwen3:32b");
    for (const slot of ["extractor", "cleanup", "vision"] as const) {
      expect(loaded.llm[slot].gptApiKey).toBe("");
      expect(loaded.llm[slot].gptModel).toBe("");
      expect(loaded.llm[slot].geminiApiKey).toBe("");
      expect(loaded.llm[slot].geminiModel).toBe("");
    }
    expect(validateMemorySettings(loaded).ok).toBe(true);
  });
});

describe("GPT·Gemini 키 6칸 — 비밀 파일 분리", () => {
  test("저장하면 키는 비밀 파일로 가고 설정 json 에는 평문이 남지 않는다", () => {
    const path = join(tmpDir, "memory-settings.json");
    putSettingsAt(
      {
        llm: {
          extractor: { provider: "openai", gptApiKey: FAKE_GPT.extractor, gptModel: "gpt-4.1-mini", geminiApiKey: FAKE_GEMINI.extractor },
          cleanup: { provider: "google", gptApiKey: FAKE_GPT.cleanup, geminiApiKey: FAKE_GEMINI.cleanup, geminiModel: "gemini-2.5-pro" },
          vision: { gptApiKey: FAKE_GPT.vision, geminiApiKey: FAKE_GEMINI.vision },
        },
      },
      path,
    );

    const raw = readFileSync(path, "utf-8");
    for (const key of [...Object.values(FAKE_GPT), ...Object.values(FAKE_GEMINI)]) {
      expect(raw).not.toContain(key);
    }
    const onDisk = JSON.parse(raw);
    expect(onDisk.llm.extractor.gptApiKey).toBe("");
    expect(onDisk.llm.cleanup.geminiApiKey).toBe("");
    expect(onDisk.llm.extractor.gptModel).toBe("gpt-4.1-mini");
    expect(onDisk.llm.cleanup.geminiModel).toBe("gemini-2.5-pro");

    const store = new SecretStore(join(tmpDir, "secrets.json"));
    for (const slot of ["extractor", "cleanup", "vision"] as const) {
      expect(store.get(`llm.${slot}.gptApiKey`)).toBe(FAKE_GPT[slot]);
      expect(store.get(`llm.${slot}.geminiApiKey`)).toBe(FAKE_GEMINI[slot]);
    }

    // 다시 읽으면 호출처는 키를 그대로 본다.
    const loaded = getSettingsAt(path);
    expect(loaded.llm.extractor.provider).toBe("openai");
    expect(loaded.llm.extractor.gptApiKey).toBe(FAKE_GPT.extractor);
    expect(loaded.llm.cleanup.provider).toBe("google");
    expect(loaded.llm.cleanup.geminiApiKey).toBe(FAKE_GEMINI.cleanup);
  });

  test("빈 키로 다시 저장해도 저장된 키를 지킨다", () => {
    const path = join(tmpDir, "memory-settings.json");
    putSettingsAt({ llm: { extractor: { gptApiKey: FAKE_GPT.extractor } } }, path);
    putSettingsAt({ llm: { extractor: { gptApiKey: "", gptModel: "gpt-4o" } } }, path);
    const loaded = getSettingsAt(path);
    expect(loaded.llm.extractor.gptApiKey).toBe(FAKE_GPT.extractor);
    expect(loaded.llm.extractor.gptModel).toBe("gpt-4o");
  });

  test("표 밖 provider 값은 검증에서 거절", () => {
    const loaded = getSettingsAt(join(tmpDir, "absent.json"));
    const bad = structuredClone(loaded) as unknown as { llm: { cleanup: { provider: string } } };
    bad.llm.cleanup.provider = "pc_companion";
    const result = validateMemorySettings(bad as never);
    expect(result.ok).toBe(false);
  });
});
