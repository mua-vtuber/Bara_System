/**
 * 설정 › 자동 처리 — 추출·캡션 자동 재시도 설정 칸 (2026-10-14 backfill-retry-ledger spec 4.4·6장).
 * 실제 설정 기본값(MEMORY_DEFAULTS)으로 화면을 만들고, 화면이 낸 payload 를 실제 서버 설정 병합·검사 함수에 넣어 본다.
 */
import "../../test-setup-dom";
import { describe, expect, test } from "bun:test";
import { MEMORY_DEFAULTS } from "../../src/settings/memory-schema";
import { mergeShallowGroups } from "../../src/settings/memory-settings-merge";
import { validateMemorySettings } from "../../src/settings/memory-settings-validate";
import type { MemorySettings, MemorySettingsPartial } from "../../src/settings/memory-settings";
import { BACKFILL_RETRY_FIELD_LABELS } from "./settings-backfill-attempts-labels";
import { readLlmGroup } from "./settings-llm-types";
import { renderSemanticExtractionSection } from "./settings-llm-section";
import { readRetryPolicyValue } from "./settings-llm-retry-fields";

function serverValue(): Record<string, unknown> {
  return { ...structuredClone(MEMORY_DEFAULTS), $secretsSet: [] } as Record<string, unknown>;
}

function section() {
  const group = readLlmGroup(serverValue());
  return renderSemanticExtractionSection(group, group);
}

function input(root: ParentNode, id: string): HTMLInputElement {
  const el = root.querySelector(`#${id}`) as HTMLInputElement | null;
  if (el === null) throw new Error(`input not found: ${id}`);
  return el;
}

describe("서버 값 읽기", () => {
  test("칸이 빠지면 칸 경로를 든 오류(기본값으로 메우지 않음)", () => {
    expect(() => readRetryPolicyValue({ maxAttempts: 5, retryDelayMin: 30 }, "llm.vision.backfill"))
      .toThrow("llm.vision.backfill.retryMaxDelayMin 가 number 아님");
  });

  test("readLlmGroup 이 두 블록의 세 칸을 읽는다", () => {
    const group = readLlmGroup(serverValue());
    expect(group.extractor.backfill).toMatchObject({ maxAttempts: 5, retryDelayMin: 30, retryMaxDelayMin: 1440 });
    expect(group.vision.backfill).toMatchObject({ maxAttempts: 5, retryDelayMin: 30, retryMaxDelayMin: 1440 });
  });
});

describe("화면 칸", () => {
  test("추출·캡션 블록에 세 칸씩 기본값과 문구 모듈의 라벨로 보인다", () => {
    const s = section();
    for (const prefix of ["llm-extractor-backfill", "llm-vision-backfill"]) {
      expect(input(s.element, `${prefix}-maxAttempts`).value).toBe("5");
      expect(input(s.element, `${prefix}-retryDelayMin`).value).toBe("30");
      expect(input(s.element, `${prefix}-retryMaxDelayMin`).value).toBe("1440");
      const label = s.element.querySelector(`label[for="${prefix}-maxAttempts"]`)!;
      expect(label.textContent).toBe(BACKFILL_RETRY_FIELD_LABELS.maxAttempts);
    }
  });

  test("값을 바꾸면 그 슬롯 payload 의 backfill 에 세 칸과 기존 칸이 함께 실린다", () => {
    const s = section();
    input(s.element, "llm-extractor-backfill-maxAttempts").value = "7";
    expect(s.isChanged()).toBe(true);
    const payload = s.getChangedSlotsPayload();
    expect((payload.extractor as Record<string, unknown>).backfill).toEqual({
      intervalMin: 30, batchSize: 10, minImportance: 0, maxAttempts: 7, retryDelayMin: 30, retryMaxDelayMin: 1440,
    });
    expect(payload.vision).toBeUndefined();
  });

  test("캡션 칸을 바꾸면 vision payload 의 backfill 에 실린다", () => {
    const s = section();
    input(s.element, "llm-vision-backfill-retryDelayMin").value = "60";
    const payload = s.getChangedSlotsPayload();
    expect((payload.vision as Record<string, unknown>).backfill).toEqual({
      batchSize: 10, maxAttempts: 5, retryDelayMin: 60, retryMaxDelayMin: 1440,
    });
  });

  test("화면 payload 는 서버 검사를 통과하고, 최대 < 첫 대기면 칸 경로 오류로 거부된다", () => {
    const s = section();
    input(s.element, "llm-vision-backfill-retryDelayMin").value = "20";
    input(s.element, "llm-vision-backfill-retryMaxDelayMin").value = "10";
    const current = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
    const merged = mergeShallowGroups(current, { llm: s.getChangedSlotsPayload() } as MemorySettingsPartial);
    expect(validateMemorySettings(merged).errors).toContain(
      "llm.vision.backfill.retryMaxDelayMin: llm.vision.backfill.retryDelayMin(20) 이상 필요 (받은 값 10)",
    );
    input(s.element, "llm-vision-backfill-retryMaxDelayMin").value = "120";
    const ok = mergeShallowGroups(structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings, { llm: s.getChangedSlotsPayload() } as MemorySettingsPartial);
    expect(validateMemorySettings(ok)).toEqual({ ok: true, errors: [] });
  });
});
