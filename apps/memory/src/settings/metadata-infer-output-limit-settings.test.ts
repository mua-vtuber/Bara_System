/**
 * metadataInfer.maxOutputTokens 설정 칸 — 스키마·기본값·범위 검사·저장·읽기·Ollama 컨텍스트 창 관계.
 * 추출 출력 한도 칸(extractor-output-limit-settings.test.ts)과 같은 규칙을 따르는지 본다.
 * 실제 설정 파일(임시 폴더)과 실제 검사 함수만 쓴다. 환경 변수는 afterEach 에서 되돌린다.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_DEFAULTS, MEMORY_SCHEMA } from "./memory-schema.ts";
import { validateMemorySettings } from "./memory-settings-validate.ts";
import { getSettingsAt, putSettingsAt } from "../test-utils/settings-files.ts";
import {
  METADATA_INFER_MAX_OUTPUT_TOKENS_DEFAULT,
  METADATA_INFER_MAX_OUTPUT_TOKENS_KEY,
  METADATA_INFER_MAX_OUTPUT_TOKENS_MAX,
  METADATA_INFER_MAX_OUTPUT_TOKENS_MIN,
  METADATA_INFER_OLLAMA_INPUT_TOKEN_RESERVE,
  metadataInferMaxOutputTokensError,
  metadataInferOutputExceedsOllamaContextError,
} from "../memory/metadata-infer-output-limit.ts";
import { DEFAULT_OLLAMA_NUM_CTX } from "../llm/constants.ts";
import { OLLAMA_NUM_CTX_ENV } from "../llm/ollama-num-ctx.ts";

/** 기본 창(8192)에서 입력 여유를 뺀 최대 허용 한도. */
const OLLAMA_DEFAULT_CTX_MAX = DEFAULT_OLLAMA_NUM_CTX - METADATA_INFER_OLLAMA_INPUT_TOKEN_RESERVE;

let dir: string;
let savedNumCtx: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bara-metadata-infer-output-"));
  savedNumCtx = process.env[OLLAMA_NUM_CTX_ENV];
  delete process.env[OLLAMA_NUM_CTX_ENV];
});
afterEach(() => {
  if (savedNumCtx === undefined) delete process.env[OLLAMA_NUM_CTX_ENV];
  else process.env[OLLAMA_NUM_CTX_ENV] = savedNumCtx;
  rmSync(dir, { recursive: true, force: true });
});

type GroupSchema = { properties: Record<string, Record<string, unknown>>; required: readonly string[] };
function metadataInferSchema(): GroupSchema {
  return MEMORY_SCHEMA.properties.metadataInfer as unknown as GroupSchema;
}

describe("범위 상수와 검사 함수", () => {
  test("칸 경로·범위·기본값", () => {
    expect(METADATA_INFER_MAX_OUTPUT_TOKENS_KEY).toBe("metadataInfer.maxOutputTokens");
    expect(METADATA_INFER_MAX_OUTPUT_TOKENS_DEFAULT).toBe(1024);
    expect(METADATA_INFER_MAX_OUTPUT_TOKENS_MIN).toBe(256);
    expect(METADATA_INFER_MAX_OUTPUT_TOKENS_MAX).toBe(32768);
  });

  test.each([[255], [32769], [1024.5], ["1024"], [null]])("%p 는 칸 경로가 든 문장", (v) => {
    expect(metadataInferMaxOutputTokensError(v)).toContain(METADATA_INFER_MAX_OUTPUT_TOKENS_KEY);
  });

  test.each([[256], [1024], [32768]])("%p 는 통과", (v) => {
    expect(metadataInferMaxOutputTokensError(v)).toBeNull();
  });

  test("한도 + 입력 여유 ≤ num_ctx 만 통과", () => {
    expect(metadataInferOutputExceedsOllamaContextError(OLLAMA_DEFAULT_CTX_MAX, DEFAULT_OLLAMA_NUM_CTX)).toBeNull();
    const message = metadataInferOutputExceedsOllamaContextError(OLLAMA_DEFAULT_CTX_MAX + 1, DEFAULT_OLLAMA_NUM_CTX);
    expect(message).toContain(METADATA_INFER_MAX_OUTPUT_TOKENS_KEY);
    expect(message).toContain(OLLAMA_NUM_CTX_ENV);
  });
});

describe("metadataInfer.maxOutputTokens 스키마·기본값", () => {
  test("스키마의 default·minimum·maximum 이 상수와 같고 required 에 있다", () => {
    const field = metadataInferSchema().properties.maxOutputTokens!;
    expect(field.type).toBe("integer");
    expect(field.default).toBe(METADATA_INFER_MAX_OUTPUT_TOKENS_DEFAULT);
    expect(field.minimum).toBe(METADATA_INFER_MAX_OUTPUT_TOKENS_MIN);
    expect(field.maximum).toBe(METADATA_INFER_MAX_OUTPUT_TOKENS_MAX);
    expect(metadataInferSchema().required).toContain("maxOutputTokens");
  });

  test("MEMORY_DEFAULTS 의 값이 1024 이고 기본 설정이 검사를 통과한다", () => {
    expect(MEMORY_DEFAULTS.metadataInfer.maxOutputTokens).toBe(1024);
    expect(validateMemorySettings(getSettingsAt(join(dir, "none.json")))).toEqual({ ok: true, errors: [] });
  });

  test.each([[METADATA_INFER_MAX_OUTPUT_TOKENS_MIN - 1], [METADATA_INFER_MAX_OUTPUT_TOKENS_MAX + 1], [1024.5]])(
    "validateMemorySettings 가 %p 를 칸 경로 문장으로 거부한다",
    (v) => {
      const s = structuredClone(getSettingsAt(join(dir, "none.json")));
      s.metadataInfer.maxOutputTokens = v;
      const r = validateMemorySettings(s);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes(METADATA_INFER_MAX_OUTPUT_TOKENS_KEY))).toBe(true);
    },
  );
});

describe("저장·읽기 검사", () => {
  test("칸 없는 옛 파일은 기본값 1024 로 읽힌다", () => {
    const path = join(dir, "s.json");
    writeFileSync(path, JSON.stringify({ metadataInfer: { enabled: true, sessionGapMinutes: 180, batchSize: 200 } }));
    expect(getSettingsAt(path).metadataInfer.maxOutputTokens).toBe(1024);
  });

  test("범위 안 값은 저장되고 다른 metadataInfer 칸은 그대로다", () => {
    const path = join(dir, "s.json");
    putSettingsAt({ metadataInfer: { batchSize: 77 } }, path);
    putSettingsAt({ metadataInfer: { maxOutputTokens: 2048 } }, path);
    const saved = getSettingsAt(path).metadataInfer;
    expect(saved.maxOutputTokens).toBe(2048);
    expect(saved.batchSize).toBe(77);
  });

  test("최소값 미만 저장은 칸 경로로 던지고 파일은 바뀌지 않는다", () => {
    const path = join(dir, "s.json");
    putSettingsAt({ metadataInfer: { maxOutputTokens: 2048 } }, path);
    const before = readFileSync(path, "utf8");
    expect(() =>
      putSettingsAt({ metadataInfer: { maxOutputTokens: METADATA_INFER_MAX_OUTPUT_TOKENS_MIN - 1 } }, path),
    ).toThrow(METADATA_INFER_MAX_OUTPUT_TOKENS_KEY);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("손으로 범위 밖 값을 적은 파일은 읽기에서 칸 경로가 든 오류로 던진다", () => {
    const path = join(dir, "s.json");
    writeFileSync(path, JSON.stringify({ metadataInfer: { maxOutputTokens: METADATA_INFER_MAX_OUTPUT_TOKENS_MAX + 1 } }));
    expect(() => getSettingsAt(path)).toThrow(METADATA_INFER_MAX_OUTPUT_TOKENS_KEY);
  });
});

describe("Ollama 컨텍스트 창 관계 (추출 한도와 같은 규칙 — 같은 llm.extractor 클라이언트)", () => {
  test("ollama + 창을 넘는 한도 저장은 관계 문장으로 거부하고 파일은 안 바뀐다", () => {
    const path = join(dir, "s.json");
    putSettingsAt({ llm: { extractor: { provider: "ollama" } }, metadataInfer: { maxOutputTokens: 2048 } }, path);
    const before = readFileSync(path, "utf8");
    expect(() =>
      putSettingsAt({ metadataInfer: { maxOutputTokens: OLLAMA_DEFAULT_CTX_MAX + 1 } }, path),
    ).toThrow(/memory-settings 검증 실패.*metadataInfer\.maxOutputTokens.*Ollama 컨텍스트 창/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("ollama + 창 경계값은 통과한다", () => {
    const path = join(dir, "s.json");
    putSettingsAt(
      { llm: { extractor: { provider: "ollama" } }, metadataInfer: { maxOutputTokens: OLLAMA_DEFAULT_CTX_MAX } },
      path,
    );
    expect(getSettingsAt(path).metadataInfer.maxOutputTokens).toBe(OLLAMA_DEFAULT_CTX_MAX);
  });

  test("OLLAMA_NUM_CTX 를 키우면 큰 한도도 통과한다", () => {
    process.env[OLLAMA_NUM_CTX_ENV] = String(DEFAULT_OLLAMA_NUM_CTX * 2);
    const path = join(dir, "s.json");
    putSettingsAt(
      { llm: { extractor: { provider: "ollama" } }, metadataInfer: { maxOutputTokens: OLLAMA_DEFAULT_CTX_MAX + 1 } },
      path,
    );
    expect(getSettingsAt(path).metadataInfer.maxOutputTokens).toBe(OLLAMA_DEFAULT_CTX_MAX + 1);
  });

  test("anthropic 이면 창 관계를 보지 않는다", () => {
    const path = join(dir, "s.json");
    putSettingsAt(
      { llm: { extractor: { provider: "anthropic" } }, metadataInfer: { maxOutputTokens: OLLAMA_DEFAULT_CTX_MAX + 1 } },
      path,
    );
    expect(getSettingsAt(path).metadataInfer.maxOutputTokens).toBe(OLLAMA_DEFAULT_CTX_MAX + 1);
  });

  test("손으로 ollama + 창 넘는 한도를 적은 파일은 읽기에서 관계 문장으로 던진다", () => {
    const path = join(dir, "s.json");
    writeFileSync(
      path,
      JSON.stringify({
        llm: { extractor: { provider: "ollama" } },
        metadataInfer: { maxOutputTokens: OLLAMA_DEFAULT_CTX_MAX + 1 },
      }),
    );
    expect(() => getSettingsAt(path)).toThrow(/memory-settings 검증 실패.*metadataInfer\.maxOutputTokens/);
  });
});
