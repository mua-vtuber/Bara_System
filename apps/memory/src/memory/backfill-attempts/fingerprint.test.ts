/**
 * 백필 입력 지문 — spec 4.2 (순수 함수).
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_CAPTION_PROMPT } from "../../llm/vision/caption-flow.ts";
import { captionFingerprint, extractionFingerprint } from "./fingerprint.ts";

const SHA = "a".repeat(64);

const identity = (llmName: string, maxOutputTokens = 4096) => ({ llmName, maxOutputTokens });

describe("추출 지문 — 공급자·모델 + 출력 한도 + LLM 에 보낸 본문(태그를 뺀 본문)", () => {
  test("같은 입력이면 같은 sha256 16진 64자", () => {
    const fp = extractionFingerprint(identity("ollama:qwen3:4b-instruct"), "오늘 회의를 했다. 내일은 쉰다.");
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(extractionFingerprint(identity("ollama:qwen3:4b-instruct"), "오늘 회의를 했다. 내일은 쉰다.")).toBe(fp);
  });
  test("모델·공급자가 바뀌면 달라진다", () => {
    const text = "오늘 회의를 했다. 내일은 쉰다.";
    expect(extractionFingerprint(identity("ollama:a"), text)).not.toBe(extractionFingerprint(identity("ollama:b"), text));
    expect(extractionFingerprint(identity("ollama:a"), text)).not.toBe(extractionFingerprint(identity("anthropic:a"), text));
  });
  test("출력 한도만 다르면 달라지고, 같으면 같다", () => {
    const text = "오늘 회의를 했다. 내일은 쉰다.";
    expect(extractionFingerprint(identity("ollama:a", 1024), text)).not.toBe(extractionFingerprint(identity("ollama:a", 2048), text));
    expect(extractionFingerprint(identity("ollama:a", 2048), text)).toBe(extractionFingerprint(identity("ollama:a", 2048), text));
  });
  test("본문이 바뀌면 달라지고, LLM 에 보내지 않는 태그만 다르면 같다", () => {
    expect(extractionFingerprint(identity("ollama:a"), "본문 하나")).not.toBe(extractionFingerprint(identity("ollama:a"), "본문 둘"));
    expect(extractionFingerprint(identity("ollama:a"), "#일기 본문 하나")).toBe(extractionFingerprint(identity("ollama:a"), "#메모 본문 하나"));
  });
});

describe("캡션 지문 — 공급자·모델·asset_sha256·캡션 지시문", () => {
  const base = { provider: "ollama", model: "qwen3-vl:4b-instruct", captionPrompt: undefined, assetSha256: SHA };
  test("지시문을 비우면 실제로 쓰는 기본 지시문과 같은 지문", () => {
    expect(captionFingerprint(base)).toBe(captionFingerprint({ ...base, captionPrompt: "" }));
    expect(captionFingerprint(base)).toBe(captionFingerprint({ ...base, captionPrompt: DEFAULT_CAPTION_PROMPT }));
  });
  test("지시문·모델·공급자·자산이 바뀌면 달라진다", () => {
    const fp = captionFingerprint(base);
    expect(captionFingerprint({ ...base, captionPrompt: "만화 그림체 위주로" })).not.toBe(fp);
    expect(captionFingerprint({ ...base, model: "other" })).not.toBe(fp);
    expect(captionFingerprint({ ...base, provider: "anthropic" })).not.toBe(fp);
    expect(captionFingerprint({ ...base, assetSha256: "b".repeat(64) })).not.toBe(fp);
  });
  test("추출 지문과 영역이 섞이지 않는다", () => {
    expect(captionFingerprint(base)).not.toBe(extractionFingerprint(identity("ollama:qwen3-vl:4b-instruct"), SHA));
  });
});
