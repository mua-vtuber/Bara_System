import { describe, expect, test } from "bun:test";
import { readLlmGroup } from "./settings-llm-types";
import { MEMORY_DEFAULTS } from "../../src/settings/memory-schema";

function serverValue(secretsSet: unknown): Record<string, unknown> {
  return { ...structuredClone(MEMORY_DEFAULTS), $secretsSet: secretsSet };
}

describe("readLlmGroup — 저장된 키 여부($secretsSet)", () => {
  test("슬롯마다 자기 경로의 키 칸만 savedKeyFields 로 읽는다", () => {
    const group = readLlmGroup(
      serverValue(["llm.cleanup.gptApiKey", "llm.vision.anthropicApiKey", "documents.ocr.api.apiKey"]),
    );
    expect(group.extractor.savedKeyFields).toEqual([]);
    expect(group.cleanup.savedKeyFields).toEqual(["gptApiKey"]);
    expect(group.vision.savedKeyFields).toEqual(["anthropicApiKey"]);
  });

  test("$secretsSet 이 없으면 빈 목록으로 덮지 않고 멈춘다", () => {
    expect(() => readLlmGroup(serverValue(undefined))).toThrow("$secretsSet");
  });

  test("GPT·Gemini 칸을 그대로 읽고, 표 밖 provider 는 거절", () => {
    const value = serverValue([]);
    const llm = value.llm as Record<string, Record<string, unknown>>;
    llm.extractor!.provider = "google";
    llm.extractor!.geminiModel = "gemini-2.5-flash";
    expect(readLlmGroup(value).extractor.geminiModel).toBe("gemini-2.5-flash");
    llm.extractor!.provider = "pc_companion";
    expect(() => readLlmGroup(value)).toThrow("enum 밖");
  });
});
