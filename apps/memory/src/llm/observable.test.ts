import { describe, expect, test } from "bun:test";
import { OllamaClient } from "./ollama-client.ts";
import { asObservableLlmClient } from "./observable.ts";
import type { LlmClient } from "./types.ts";

describe("asObservableLlmClient", () => {
  test("chatDetailed 를 가진 실제 OllamaClient 는 그대로 통과한다", () => {
    const client = new OllamaClient({
      baseUrl: "http://127.0.0.1:11434",
      model: "test-model",
    });
    expect(asObservableLlmClient(client, "llm.cleanup")).toBe(client);
  });

  test("chatDetailed 가 없는 데이터 객체는 slotPath 가 든 문장으로 거부된다", () => {
    // 메서드가 없는 { name } 데이터 — 인터페이스 구현체(mock 클래스)가 아니다.
    const plain = { name: "plain-client" } as unknown as LlmClient;
    expect(() => asObservableLlmClient(plain, "llm.extraction")).toThrow(
      "llm.extraction LLM 클라이언트(plain-client)가 chatDetailed 를 구현하지 않음 — ObservableLlmClient 필요",
    );
  });
});
