/**
 * 추출 출력 한도 옛 기본값(1024) 이관 (2026-10-20 사용자 결정).
 * 실제 이관 함수와 실제 설정 파일(임시 폴더)만 쓴다.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyKeys } from "./migrate-legacy-keys";
import { getSettingsAt } from "../test-utils/settings-files.ts";
import {
  EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT,
  EXTRACTOR_MAX_OUTPUT_TOKENS_KEY,
  EXTRACTOR_MAX_OUTPUT_TOKENS_LEGACY_DEFAULT,
} from "../memory/extractor-output-limit.ts";

function limitOf(migrated: Record<string, unknown>): unknown {
  const llm = migrated.llm as Record<string, unknown>;
  return (llm.extractor as Record<string, unknown>).maxOutputTokens;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bara-extractor-limit-migrate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("migrateLegacyKeys — 추출 출력 한도 옛 기본값 이관", () => {
  test("옛 기본값 1024 는 새 기본값으로 올라가고 경고에 칸 경로가 든다", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      llm: { extractor: { provider: "anthropic", maxOutputTokens: EXTRACTOR_MAX_OUTPUT_TOKENS_LEGACY_DEFAULT } },
    });
    expect(limitOf(migrated)).toBe(EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT);
    expect(warnings.some((w) => w.includes(EXTRACTOR_MAX_OUTPUT_TOKENS_KEY))).toBe(true);
  });

  test("1024 가 아닌 값은 사용자가 정한 값이라 그대로 둔다", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      llm: { extractor: { provider: "anthropic", maxOutputTokens: 2048 } },
    });
    expect(limitOf(migrated)).toBe(2048);
    expect(warnings.some((w) => w.includes(EXTRACTOR_MAX_OUTPUT_TOKENS_KEY))).toBe(false);
  });

  test("멱등: 올린 결과를 다시 이관해도 값이 같고 경고가 없다", () => {
    const once = migrateLegacyKeys({
      llm: { extractor: { provider: "anthropic", maxOutputTokens: EXTRACTOR_MAX_OUTPUT_TOKENS_LEGACY_DEFAULT } },
    }).migrated;
    const twice = migrateLegacyKeys(once);
    expect(limitOf(twice.migrated)).toBe(EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT);
    expect(twice.warnings.some((w) => w.includes(EXTRACTOR_MAX_OUTPUT_TOKENS_KEY))).toBe(false);
  });

  test("칸이 없는 파일은 건드리지 않는다(기본값 병합이 채운다)", () => {
    const { migrated } = migrateLegacyKeys({ llm: { extractor: { provider: "anthropic" } } });
    const slot = (migrated.llm as Record<string, unknown>).extractor as Record<string, unknown>;
    expect("maxOutputTokens" in slot).toBe(false);
  });

  test("설정 파일을 읽으면 1024 가 4096 으로 읽힌다", () => {
    const path = join(dir, "s.json");
    writeFileSync(path, JSON.stringify({ llm: { extractor: { provider: "anthropic", maxOutputTokens: 1024 } } }));
    expect(getSettingsAt(path).llm.extractor.maxOutputTokens).toBe(EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT);
  });
});
