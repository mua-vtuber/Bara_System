/**
 * 백필 재시도 설정 세 칸 — 기본값·범위·두 칸 관계 검사가 저장·읽기에서 모두 거부하는지 (2026-10-14 spec 4.4).
 * 실제 설정 파일(임시 폴더)과 실제 검사 함수만 쓴다.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateMemorySettings } from "./memory-settings-validate.ts";
import { getSettingsAt, putSettingsAt } from "../test-utils/settings-files.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bara-backfill-retry-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("llm.extractor.backfill 재시도 설정", () => {
  test("기본값은 5회·30분·1440분이고 검사를 통과한다", () => {
    const s = getSettingsAt(join(dir, "none.json"));
    expect(s.llm.extractor.backfill).toMatchObject({ maxAttempts: 5, retryDelayMin: 30, retryMaxDelayMin: 1440 });
    expect(validateMemorySettings(s)).toEqual({ ok: true, errors: [] });
  });

  test("최대 대기가 첫 대기보다 작으면 칸 경로를 든 오류로 거부한다", () => {
    const s = structuredClone(getSettingsAt(join(dir, "none.json")));
    s.llm.extractor.backfill.retryDelayMin = 60;
    s.llm.extractor.backfill.retryMaxDelayMin = 30;
    const r = validateMemorySettings(s);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain(
      "llm.extractor.backfill.retryMaxDelayMin: llm.extractor.backfill.retryDelayMin(60) 이상 필요 (받은 값 30)",
    );
  });

  test("범위를 벗어나면 스키마 검사가 거부한다", () => {
    const s = structuredClone(getSettingsAt(join(dir, "none.json")));
    s.llm.extractor.backfill.maxAttempts = 51;
    s.llm.extractor.backfill.retryDelayMin = 0;
    const r = validateMemorySettings(s);
    expect(r.errors).toContain("llm.extractor.backfill.maxAttempts: 50 이하 필요");
    expect(r.errors).toContain("llm.extractor.backfill.retryDelayMin: 1 이상 필요");
  });

  test("저장도 거부하고 파일을 쓰지 않는다", () => {
    const path = join(dir, "s.json");
    expect(() => putSettingsAt({ llm: { extractor: { backfill: { retryDelayMin: 60, retryMaxDelayMin: 30 } } } }, path))
      .toThrow("llm.extractor.backfill.retryMaxDelayMin");
    expect(existsSync(path)).toBe(false);
  });

  test("손으로 고친 파일이 최대 < 첫 대기면 읽기에서 멈춘다(조용히 맞춰 쓰지 않음)", () => {
    const path = join(dir, "s.json");
    writeFileSync(path, JSON.stringify({ llm: { extractor: { backfill: { retryDelayMin: 60, retryMaxDelayMin: 30 } } } }));
    expect(() => getSettingsAt(path)).toThrow("memory-settings 검증 실패");
  });

  test("세 칸이 없는 옛 파일은 기본값으로 채워 읽힌다", () => {
    const path = join(dir, "s.json");
    writeFileSync(path, JSON.stringify({ llm: { extractor: { backfill: { intervalMin: 30, batchSize: 10, minImportance: 0 } } } }));
    expect(getSettingsAt(path).llm.extractor.backfill).toMatchObject({ maxAttempts: 5, retryDelayMin: 30, retryMaxDelayMin: 1440 });
  });
});

describe("llm.vision.backfill 재시도 설정", () => {
  test("기본값과 두 칸 관계 검사", () => {
    const s = structuredClone(getSettingsAt(join(dir, "none.json")));
    expect(s.llm.vision.backfill).toMatchObject({ maxAttempts: 5, retryDelayMin: 30, retryMaxDelayMin: 1440 });
    s.llm.vision.backfill.retryDelayMin = 20;
    s.llm.vision.backfill.retryMaxDelayMin = 10;
    expect(validateMemorySettings(s).errors).toContain(
      "llm.vision.backfill.retryMaxDelayMin: llm.vision.backfill.retryDelayMin(20) 이상 필요 (받은 값 10)",
    );
  });
});
