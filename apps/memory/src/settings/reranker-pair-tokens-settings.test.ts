/**
 * reranker.maxPairTokens 설정 칸 — 스키마·기본값·검사·저장·읽기 (2026-10-14 speed-step1 spec 3.1·3.2).
 * 실제 설정 파일(임시 폴더)과 실제 검사 함수만 쓴다.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_SCHEMA } from "./memory-schema.ts";
import { validateMemorySettings } from "./memory-settings-validate.ts";
import { getSettingsAt, putSettingsAt } from "../test-utils/settings-files.ts";
import {
  RERANKER_MAX_PAIR_TOKENS_MAX,
  RERANKER_MAX_PAIR_TOKENS_MIN,
} from "../memory/reranker-limits.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bara-pair-tokens-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("reranker.maxPairTokens", () => {
  test("스키마의 default·minimum·maximum 이 상수와 같다", () => {
    const field = (MEMORY_SCHEMA.properties.reranker.properties as Record<string, Record<string, unknown>>).maxPairTokens!;
    expect(field.type).toBe("integer");
    expect(field.default).toBe(512);
    expect(field.minimum).toBe(RERANKER_MAX_PAIR_TOKENS_MIN);
    expect(field.maximum).toBe(RERANKER_MAX_PAIR_TOKENS_MAX);
    expect(MEMORY_SCHEMA.properties.reranker.required).toContain("maxPairTokens");
  });

  test("기본값 512 는 검사를 통과한다", () => {
    const s = getSettingsAt(join(dir, "none.json"));
    expect(s.reranker.maxPairTokens).toBe(512);
    expect(validateMemorySettings(s)).toEqual({ ok: true, errors: [] });
  });

  test.each([[63], [8193], [512.5]])("검사가 %p 를 키 이름 문장으로 거부한다", (v) => {
    const s = structuredClone(getSettingsAt(join(dir, "none.json")));
    s.reranker.maxPairTokens = v;
    const r = validateMemorySettings(s);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("reranker.maxPairTokens"))).toBe(true);
  });

  test("저장에 63 을 넣으면 던지고 파일은 바뀌지 않는다", () => {
    const path = join(dir, "s.json");
    putSettingsAt({ reranker: { maxPairTokens: 600 } }, path);
    const before = readFileSync(path, "utf8");
    expect(() => putSettingsAt({ reranker: { maxPairTokens: 63 } }, path)).toThrow("reranker.maxPairTokens");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("저장에 63 을 넣어도 새 파일이 생기지 않는다", () => {
    const path = join(dir, "new.json");
    expect(() => putSettingsAt({ reranker: { maxPairTokens: 63 } }, path)).toThrow("reranker.maxPairTokens");
    expect(existsSync(path)).toBe(false);
  });

  test("칸이 없는 옛 파일은 512 로 읽힌다", () => {
    const path = join(dir, "s.json");
    writeFileSync(path, JSON.stringify({ reranker: { topK_input: 30 } }));
    expect(getSettingsAt(path).reranker.maxPairTokens).toBe(512);
  });

  test("손으로 9000 을 적은 파일은 읽기에서 던진다", () => {
    const path = join(dir, "s.json");
    writeFileSync(path, JSON.stringify({ reranker: { maxPairTokens: 9000 } }));
    expect(() => getSettingsAt(path)).toThrow("memory-settings 검증 실패");
  });
});
