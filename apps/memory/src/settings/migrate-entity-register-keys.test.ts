import { describe, expect, test } from "bun:test";
import { migrateLegacyKeys } from "./migrate-legacy-keys";
import { ENTITY_REGISTER_BATCH_SIZE_MAX } from "../memory/cleanup-deep-pass/stage-constants.ts";
import { ENTITY_REGISTER_ALLOCATION_SHARE } from "./migrate-entity-register-keys";
import { deepMergeWithDefaults } from "./memory-settings-merge";
import { validateStageAllocation } from "../memory/cleanup-deep-pass/cycle-budget.ts";

function allocationOf(migrated: Record<string, unknown>): Record<string, number> {
  const deep = migrated.cleanupDeepPass as Record<string, unknown>;
  const budget = deep.budget as Record<string, unknown>;
  return budget.stageAllocation as Record<string, number>;
}

describe("migrateLegacyKeys — entityRegister 배분 이관 (2026-10-10 사용자 결정)", () => {
  test("old default four quarters become five fifths", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      cleanupDeepPass: { budget: { stageAllocation: { regexStrengthen: 0.25, summary: 0.25, personLink: 0.25, lensDraft: 0.25 } } },
    });
    const alloc = allocationOf(migrated);
    for (const key of ["regexStrengthen", "summary", "personLink", "lensDraft", "entityRegister"]) {
      expect(alloc[key]).toBeCloseTo(0.2, 10);
    }
    expect(warnings.some((w) => w.includes("entityRegister"))).toBe(true);
  });

  test("a user's own ratios keep their proportions and the sum stays 1.0", () => {
    const { migrated } = migrateLegacyKeys({
      cleanupDeepPass: { budget: { stageAllocation: { regexStrengthen: 0.1, summary: 0.5, personLink: 0.3, lensDraft: 0.1 } } },
    });
    const alloc = allocationOf(migrated);
    expect(alloc.regexStrengthen).toBeCloseTo(0.08, 10);
    expect(alloc.summary).toBeCloseTo(0.4, 10);
    expect(alloc.personLink).toBeCloseTo(0.24, 10);
    expect(alloc.lensDraft).toBeCloseTo(0.08, 10);
    expect(alloc.entityRegister).toBeCloseTo(ENTITY_REGISTER_ALLOCATION_SHARE, 10);
    expect(alloc.summary! / alloc.personLink!).toBeCloseTo(0.5 / 0.3, 10);
    expect(validateStageAllocation(alloc as never)).toEqual({ ok: true });
  });

  test("a file that already has entityRegister is left untouched (idempotent)", () => {
    const input = {
      cleanupDeepPass: { budget: { stageAllocation: { regexStrengthen: 0.2, summary: 0.2, personLink: 0.2, lensDraft: 0.2, entityRegister: 0.2 } } },
    };
    const once = migrateLegacyKeys(input).migrated;
    const twice = migrateLegacyKeys(once).migrated;
    expect(allocationOf(twice)).toEqual(allocationOf(once));
    expect(allocationOf(once).summary).toBe(0.2);
  });

  test("a file without stageAllocation gets nothing here (defaults fill it)", () => {
    const { migrated } = migrateLegacyKeys({ cleanupDeepPass: { budget: { maxCallsPerCycle: 10 } } });
    const budget = (migrated.cleanupDeepPass as Record<string, unknown>).budget as Record<string, unknown>;
    expect("stageAllocation" in budget).toBe(false);
  });

  test("a non-numeric old ratio stops with the key name instead of guessing", () => {
    expect(() =>
      migrateLegacyKeys({
        cleanupDeepPass: { budget: { stageAllocation: { regexStrengthen: "x", summary: 0.5, personLink: 0.25, lensDraft: 0.25 } } },
      }),
    ).toThrow("cleanupDeepPass.budget.stageAllocation.regexStrengthen");
  });
});

describe("migrateLegacyKeys — 정리 AI 를 켠 기존 설치는 entityRegister 도 켠다", () => {
  function stageOf(migrated: Record<string, unknown>): Record<string, unknown> | undefined {
    const deep = migrated.cleanupDeepPass as Record<string, unknown> | undefined;
    return deep?.entityRegister as Record<string, unknown> | undefined;
  }

  test("cleanup enabled and no entityRegister.enabled key: the stage is turned on, autoApply stays the default true", () => {
    const { migrated, warnings } = migrateLegacyKeys({ llm: { cleanup: { enabled: true } }, cleanupDeepPass: { budget: { maxCallsPerCycle: 10 } } });
    expect(stageOf(migrated)).toEqual({ enabled: true });
    expect(warnings.some((w) => w.includes("cleanupDeepPass.entityRegister.enabled"))).toBe(true);
    const merged = deepMergeWithDefaults(migrated as never);
    expect(merged.cleanupDeepPass.entityRegister).toMatchObject({ enabled: true, autoApply: true });
  });

  test("a file without a cleanupDeepPass block still gets the stage turned on", () => {
    const { migrated } = migrateLegacyKeys({ llm: { cleanup: { enabled: true } } });
    expect(stageOf(migrated)).toEqual({ enabled: true });
  });

  test("an existing entityRegister.enabled value is the user's choice and is left untouched (idempotent)", () => {
    const input = { llm: { cleanup: { enabled: true } }, cleanupDeepPass: { entityRegister: { enabled: false, batchSize: 5 } } };
    const once = migrateLegacyKeys(input);
    expect(stageOf(once.migrated)).toEqual({ enabled: false, batchSize: 5 });
    expect(once.warnings.some((w) => w.includes("cleanupDeepPass.entityRegister.enabled"))).toBe(false);
    const turnedOn = migrateLegacyKeys({ llm: { cleanup: { enabled: true } } }).migrated;
    const twice = migrateLegacyKeys(turnedOn);
    expect(stageOf(twice.migrated)).toEqual({ enabled: true });
    expect(twice.warnings.some((w) => w.includes("cleanupDeepPass.entityRegister.enabled"))).toBe(false);
  });

  test("cleanup disabled or absent leaves the stage to the default (off)", () => {
    expect(stageOf(migrateLegacyKeys({ llm: { cleanup: { enabled: false } } }).migrated)).toBeUndefined();
    expect(stageOf(migrateLegacyKeys({}).migrated)).toBeUndefined();
  });
});


describe("migrateLegacyKeys — entityRegister.batchSize 상한 내림", () => {
  const sizeOf = (m: Record<string, unknown>) =>
    ((m.cleanupDeepPass as Record<string, unknown>).entityRegister as Record<string, unknown>).batchSize;

  test("상한을 넘는 값은 상한으로 내리고 키·옛 값·새 값을 경고에 남긴다 (멱등)", () => {
    const once = migrateLegacyKeys({ cleanupDeepPass: { entityRegister: { batchSize: 50 } } });
    expect(sizeOf(once.migrated)).toBe(ENTITY_REGISTER_BATCH_SIZE_MAX);
    const warning = once.warnings.find((w) => w.includes("cleanupDeepPass.entityRegister.batchSize"));
    expect(warning).toBeDefined();
    expect(warning).toContain("50");
    expect(warning).toContain(String(ENTITY_REGISTER_BATCH_SIZE_MAX));
    const twice = migrateLegacyKeys(once.migrated);
    expect(sizeOf(twice.migrated)).toBe(ENTITY_REGISTER_BATCH_SIZE_MAX);
    expect(twice.warnings.some((w) => w.includes("entityRegister.batchSize"))).toBe(false);
  });

  test("상한 이하 값은 건드리지 않는다", () => {
    const { migrated, warnings } = migrateLegacyKeys({ cleanupDeepPass: { entityRegister: { batchSize: 10 } } });
    expect(sizeOf(migrated)).toBe(10);
    expect(warnings.some((w) => w.includes("entityRegister.batchSize"))).toBe(false);
  });
});
