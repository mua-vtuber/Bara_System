/**
 * extractor 통합 테스트 — 실제 Ollama 또는 Anthropic을 호출.
 *
 * 기본 스킵: BARA_TEST_LLM 환경변수가 "ollama" 또는 "anthropic"이 아니면
 * 본 파일 전체 skip. CI나 일상 `bun test`에선 부담 0.
 *
 * 사용 예:
 *   BARA_TEST_LLM=ollama OLLAMA_MODEL=qwen3:8b bun test extractor.int.test.ts
 *   BARA_TEST_LLM=anthropic ANTHROPIC_API_KEY=... bun test extractor.int.test.ts
 *
 * 무엇을 검증하나:
 *   - LLM이 실제로 JSON 배열을 돌려주는가
 *   - 추출 → 임베딩 → 저장까지 한 사이클 동작
 *   - 같은 텍스트를 두 번 던지면 dedup이 작동해 두 번째는 bump만 일어나는가
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { OllamaClient } from "../llm/ollama-client.ts";
import { AnthropicClient } from "../llm/anthropic-client.ts";
import type { ObservableLlmClient } from "../llm/types.ts";
import { inputChildSource } from "../test-utils/extraction-placement.ts";
import { MemoryExtractor } from "./extractor.ts";

const PROVIDER = process.env.BARA_TEST_LLM as
  | "ollama"
  | "anthropic"
  | undefined;

function buildClient(): ObservableLlmClient | null {
  if (PROVIDER === "ollama") {
    return new OllamaClient({
      baseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
      model: process.env.OLLAMA_MODEL ?? "exaone3.5:32b",
    });
  }
  if (PROVIDER === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;
    return new AnthropicClient({
      apiKey,
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    });
  }
  return null;
}

const client = buildClient();

// describe.skip 흐름: client 없으면 노출만 한 줄 남기고 모두 skip.
const maybe = client ? describe : describe.skip;

let embedder: Bgem3Embedder;
let db: Database;
let store: SqliteMemoryStore;
let extractor: MemoryExtractor;

beforeAll(async () => {
  if (!client) {
    console.log(
      "[extractor.int.test] BARA_TEST_LLM 미설정 — 통합 테스트 skip",
    );
    return;
  }
  console.log(`[extractor.int.test] using ${client.name}`);
  embedder = new Bgem3Embedder();
  await embedder.load();
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  extractor = new MemoryExtractor(client, store, embedder);
});

afterAll(() => {
  if (db) db.close();
});

maybe("MemoryExtractor — end-to-end with real LLM", () => {
  test(
    "한국어 입력에서 여러 atomic 메모리 추출 + 저장",
    async () => {
      const input =
        "나는 Bun 런타임을 Node보다 선호한다. RTX 4080S를 쓰고 있고 Phase 2.1 개발 중이다.";
      // 저장된 원문 없이 추출만 본다 — 자식은 이 입력의 직접 출처(메시지)를 받는다(WP-B1-20T 설계 6.2).
      const extractInput = {
        text: input,
        author: "owner",
        platform: "test",
        metadata: {
          messageId: "passthrough-msg-1",
          channelId: "ch-1",
        },
      };
      const result = await extractor.extractAndStore(extractInput, inputChildSource(extractInput));

      expect(result.items.length).toBeGreaterThan(0);
      expect(result.storedNodeIds.length).toBeGreaterThan(0);

      // 저장된 노드 한 개를 가져와 sourceType / metadata 검증
      const firstId = result.storedNodeIds[0]!;
      const node = await store.getNode(firstId);
      expect(node).not.toBeNull();
      expect(node!.sourceType).toBe("llm_extract");
      expect(node!.confidence).toBeCloseTo(0.8, 2);
      expect(node!.author).toBe("owner");
      expect(node!.platform).toBe("test");
      expect(node!.metadata.source).toBe("llm_extract");
      // 패스스루: 호출자가 전달한 messageId/channelId가 자식 노드에 박혀
      // 있어야 store.deleteBySource로 한꺼번에 청소할 수 있다.
      expect(node!.metadata.messageId).toBe("passthrough-msg-1");
      expect(node!.metadata.channelId).toBe("ch-1");
    },
    120_000, // LLM 호출 + 임베딩 여러 회 → 큰 타임아웃
  );

  test(
    "같은 입력 두 번 → 두 번째는 dedup으로 bump만 발생",
    async () => {
      const text = "사용자는 Phase 2.1을 2026-05-15에 시작했다";
      // 같은 작성자의 반복 저장 — 자식 출처는 (채널, 작성자) 직접 저장이라 흡수는 언급 +1 이다(설계 5.2).
      const first = await extractor.extractAndStore({
        text,
        author: "owner",
      }, inputChildSource({ author: "owner" }));
      const second = await extractor.extractAndStore({
        text,
        author: "owner",
      }, inputChildSource({ author: "owner" }));

      // 두 번째 실행에선 같은 사실이 dedup에 걸려 새로 추가되지 않아야 함.
      // 단, LLM이 다른 표현으로 추출하면 dedup 못 잡을 수 있어 약한 가드.
      expect(second.storedNodeIds.length).toBeLessThanOrEqual(
        first.storedNodeIds.length,
      );
      // bump 또는 stored 어딘가는 일어났어야 함
      expect(
        second.storedNodeIds.length + second.bumpedNodeIds.length,
      ).toBeGreaterThan(0);
    },
    180_000,
  );
});
