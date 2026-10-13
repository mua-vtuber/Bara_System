/**
 * 백업 다운로드 사본에서 GPT·Gemini 키 6칸도 비워지는지 (2026-10-11 llm-api-providers, QA 지적 6).
 * 데이터 fixture(설정 JSON 바이트)만 쓴다.
 */
import { describe, expect, test } from "bun:test";
import { assertNoDownloadSecrets, RestoreError, sanitizeDownloadSettings } from "./restore-validation.ts";

const SLOTS = ["extractor", "cleanup", "vision"] as const;

function settingsWithKeys(): Record<string, unknown> {
  const llm: Record<string, unknown> = {};
  for (const slot of SLOTS) {
    llm[slot] = {
      provider: "openai",
      gptApiKey: `sk-test-BACKUP-GPT-${slot}`,
      gptModel: "gpt-4.1",
      geminiApiKey: `gm-test-BACKUP-GEM-${slot}`,
      geminiModel: "gemini-2.5-flash",
    };
  }
  return { llm };
}

describe("sanitizeDownloadSettings — 새 키 6칸", () => {
  test("gptApiKey·geminiApiKey 를 세 슬롯 모두 빈 문자열로, 모델 이름은 그대로", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(settingsWithKeys()));
    const out = new TextDecoder().decode(sanitizeDownloadSettings(bytes));
    expect(out).not.toContain("sk-test-BACKUP-GPT");
    expect(out).not.toContain("gm-test-BACKUP-GEM");
    const parsed = JSON.parse(out) as { llm: Record<string, Record<string, string>> };
    for (const slot of SLOTS) {
      expect(parsed.llm[slot]!.gptApiKey).toBe("");
      expect(parsed.llm[slot]!.geminiApiKey).toBe("");
      expect(parsed.llm[slot]!.gptModel).toBe("gpt-4.1");
      expect(parsed.llm[slot]!.geminiModel).toBe("gemini-2.5-flash");
    }
    expect(() => assertNoDownloadSecrets(parsed)).not.toThrow();
  });

  test("다운로드 사본 검사는 새 키 칸에 값이 남아 있으면 거절한다", () => {
    for (const slot of SLOTS) {
      for (const field of ["gptApiKey", "geminiApiKey"] as const) {
        const settings = { llm: { [slot]: { [field]: "leftover" } } };
        expect(() => assertNoDownloadSecrets(settings)).toThrow(RestoreError);
      }
    }
  });
});
