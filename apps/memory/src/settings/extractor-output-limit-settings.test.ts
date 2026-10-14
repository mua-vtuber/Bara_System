/**
 * llm.extractor.maxOutputTokens 설정 칸 — 스키마·기본값·검사·저장·읽기·Ollama 컨텍스트 창 관계
 * (2026-10-15 extractor-output-limit spec 3.1·3.2·3.3·5.1).
 * 실제 설정 파일(임시 폴더)과 실제 검사 함수만 쓴다. 환경 변수는 afterEach 에서 되돌린다.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_DEFAULTS, MEMORY_SCHEMA } from "./memory-schema.ts";
import { validateMemorySettings } from "./memory-settings-validate.ts";
import { getSettingsAt, putSettingsAt } from "../test-utils/settings-files.ts";
import {
  EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT,
  EXTRACTOR_MAX_OUTPUT_TOKENS_KEY,
  EXTRACTOR_MAX_OUTPUT_TOKENS_MAX,
  EXTRACTOR_MAX_OUTPUT_TOKENS_MIN,
} from "../memory/extractor-output-limit.ts";
import { OLLAMA_NUM_CTX_ENV } from "../llm/ollama-num-ctx.ts";

let dir: string;
let savedNumCtx: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bara-extractor-output-"));
  savedNumCtx = process.env[OLLAMA_NUM_CTX_ENV];
  delete process.env[OLLAMA_NUM_CTX_ENV];
});
afterEach(() => {
  if (savedNumCtx === undefined) delete process.env[OLLAMA_NUM_CTX_ENV];
  else process.env[OLLAMA_NUM_CTX_ENV] = savedNumCtx;
  rmSync(dir, { recursive: true, force: true });
});

type ExtractorSchema = { properties: Record<string, Record<string, unknown>>; required: readonly string[] };
function extractorSchema(): ExtractorSchema {
  return MEMORY_SCHEMA.properties.llm.properties.extractor as unknown as ExtractorSchema;
}

describe("llm.extractor.maxOutputTokens 스키마·기본값", () => {
  test("스키마의 default·minimum·maximum 이 상수와 같고 required 에 있다", () => {
    const field = extractorSchema().properties.maxOutputTokens!;
    expect(field.type).toBe("integer");
    expect(field.default).toBe(EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT);
    expect(field.minimum).toBe(EXTRACTOR_MAX_OUTPUT_TOKENS_MIN);
    expect(field.maximum).toBe(EXTRACTOR_MAX_OUTPUT_TOKENS_MAX);
    expect(extractorSchema().required).toContain("maxOutputTokens");
  });

  test("MEMORY_DEFAULTS 의 값이 기본 상수와 같고 검사를 통과한다", () => {
    expect(MEMORY_DEFAULTS.llm.extractor.maxOutputTokens).toBe(EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT);
    expect(validateMemorySettings(getSettingsAt(join(dir, "none.json")))).toEqual({ ok: true, errors: [] });
  });

  test.each([[EXTRACTOR_MAX_OUTPUT_TOKENS_MIN - 1], [EXTRACTOR_MAX_OUTPUT_TOKENS_MAX + 1], [1024.5]])(
    "validateMemorySettings 가 %p 를 칸 경로 문장으로 거부한다",
    (v) => {
      const s = structuredClone(getSettingsAt(join(dir, "none.json")));
      s.llm.extractor.maxOutputTokens = v;
      const r = validateMemorySettings(s);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes(EXTRACTOR_MAX_OUTPUT_TOKENS_KEY))).toBe(true);
    },
  );
});

describe("저장·읽기 검사", () => {
  test("최소값 미만 저장은 던지고 파일은 바뀌지 않는다", () => {
    const path = join(dir, "s.json");
    putSettingsAt({ llm: { extractor: { maxOutputTokens: EXTRACTOR_MAX_OUTPUT_TOKENS_MIN + 1 } } }, path);
    const before = readFileSync(path, "utf8");
    expect(() =>
      putSettingsAt({ llm: { extractor: { maxOutputTokens: EXTRACTOR_MAX_OUTPUT_TOKENS_MIN - 1 } } }, path),
    ).toThrow(EXTRACTOR_MAX_OUTPUT_TOKENS_KEY);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("칸 없는 옛 파일은 기본 상수로 읽힌다", () => {
    const path = join(dir, "s.json");
    writeFileSync(path, JSON.stringify({ llm: { extractor: { provider: "anthropic" } } }));
    expect(getSettingsAt(path).llm.extractor.maxOutputTokens).toBe(EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT);
  });

  test("손으로 범위 밖 값을 적은 파일은 읽기에서 칸 경로가 든 오류로 던진다", () => {
    const path = join(dir, "s.json");
    writeFileSync(path, JSON.stringify({ llm: { extractor: { maxOutputTokens: EXTRACTOR_MAX_OUTPUT_TOKENS_MAX + 7232 } } }));
    expect(() => getSettingsAt(path)).toThrow(EXTRACTOR_MAX_OUTPUT_TOKENS_KEY);
  });
});

describe("Ollama 컨텍스트 창 관계 (spec 3.3)", () => {
  test("ollama + 5000(환경 변수 없음, 창 8192) 저장은 관계 문장으로 거부하고 파일은 안 바뀐다", () => {
    const path = join(dir, "s.json");
    putSettingsAt({ llm: { extractor: { provider: "ollama", maxOutputTokens: 2048 } } }, path);
    const before = readFileSync(path, "utf8");
    expect(() => putSettingsAt({ llm: { extractor: { maxOutputTokens: 5000 } } }, path)).toThrow(
      "Ollama 컨텍스트 창",
    );
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("ollama + 5000 인데 OLLAMA_NUM_CTX 가 16384 면 통과한다", () => {
    process.env[OLLAMA_NUM_CTX_ENV] = "16384";
    const path = join(dir, "s.json");
    putSettingsAt({ llm: { extractor: { provider: "ollama", maxOutputTokens: 5000 } } }, path);
    expect(getSettingsAt(path).llm.extractor.maxOutputTokens).toBe(5000);
  });

  test("anthropic + 5000 은 통과한다", () => {
    const path = join(dir, "s.json");
    putSettingsAt({ llm: { extractor: { provider: "anthropic", maxOutputTokens: 5000 } } }, path);
    expect(getSettingsAt(path).llm.extractor.maxOutputTokens).toBe(5000);
  });

  test("anthropic + OLLAMA_NUM_CTX=abc 는 환경 변수를 읽지 않아 통과한다", () => {
    process.env[OLLAMA_NUM_CTX_ENV] = "abc";
    const path = join(dir, "s.json");
    putSettingsAt({ llm: { extractor: { provider: "anthropic", maxOutputTokens: 5000 } } }, path);
    expect(getSettingsAt(path).llm.extractor.maxOutputTokens).toBe(5000);
  });

  test("ollama + OLLAMA_NUM_CTX=abc 는 OLLAMA_NUM_CTX 가 든 검증 실패로 저장을 거부한다", () => {
    process.env[OLLAMA_NUM_CTX_ENV] = "abc";
    const path = join(dir, "s.json");
    expect(() =>
      putSettingsAt({ llm: { extractor: { provider: "ollama", maxOutputTokens: 2048 } } }, path),
    ).toThrow(/memory-settings 검증 실패.*OLLAMA_NUM_CTX/);
    expect(existsSync(path)).toBe(false);
  });

  test("손으로 ollama + 6000 을 적은 파일은 읽기에서 관계 문장으로 던진다", () => {
    const path = join(dir, "s.json");
    writeFileSync(path, JSON.stringify({ llm: { extractor: { provider: "ollama", maxOutputTokens: 6000 } } }));
    expect(() => getSettingsAt(path)).toThrow(/memory-settings 검증 실패.*Ollama 컨텍스트 창/);
  });
});

describe("부분 저장", () => {
  test("maxOutputTokens 만 보내면 그 값만 바뀌고 다른 추출기 칸·비밀 칸은 그대로다", () => {
    const path = join(dir, "s.json");
    putSettingsAt(
      {
        llm: {
          extractor: {
            provider: "anthropic",
            anthropicApiKey: "sk-ant-test-key",
            anthropicModel: "model-x",
            timeoutMs: 123456,
            backfill: { intervalMin: 45 },
          },
        },
      },
      path,
    );
    const before = getSettingsAt(path).llm.extractor;
    putSettingsAt({ llm: { extractor: { maxOutputTokens: 2048 } } }, path);
    const after = getSettingsAt(path).llm.extractor;
    expect(after.maxOutputTokens).toBe(2048);
    expect({ ...after, maxOutputTokens: before.maxOutputTokens }).toEqual(before);
    expect(after.anthropicApiKey).toBe("sk-ant-test-key");
  });
});
