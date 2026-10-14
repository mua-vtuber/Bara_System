/**
 * save-input.attribution.test.ts — DA-2: 클라이언트가 준 원래 출처(extraMetadata.
 * platform/source) 가 args.source(body.platform) 에 덮여 linkAuthorPerson 이 Discord
 * 판별을 놓치는 경로를 고정한다.
 *
 * 근본 원인(docs/decisions/2026-09-27-audit-fix-plan-memory-core.md WP-B1-19):
 * save-input-plain.ts·save-input-immediate.ts·save-input-entity-branches.ts 세 갈래가
 * linkAuthorPerson 에 args.source 만 platform 으로 넘기고, 즉시 추출 준비
 * (prepareImmediateExtraction)가 만드는 입력의 metadata.source 도 args.source 로
 * 덮여 클라이언트가 준 원래 출처를 잃었다. resolveInputPlatform 이
 * (args.source → extraMetadata.platform → extraMetadata.source) 순서로 원래 출처를
 * 복원하는지 세 갈래 모두에서 검증한다.
 *
 * save-input.test.ts 는 이미 800줄을 넘겨(879줄) 새 테스트를 더하지 않는다(감사 수정
 * 공통 지침). 이 파일은 그 파일의 harness 패턴을 그대로 따른다.
 *
 * mock 0 — 실제 SqliteMemoryStore + 실제 Bgem3Embedder + 실제 OllamaClient(루프백
 * 서버 test-utils/delayed-ollama-chat-server.ts). LlmClient 인터페이스를 흉내 내는
 * 객체를 만들지 않는다(CLAUDE.md "테스트 정책" — Mock 객체 금지, WP-B1-19R).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { saveTextInput } from "./save-input.ts";
import { prepareImmediateExtraction } from "./save-input-immediate.ts";
import { MemoryExtractor } from "../memory/extractor.ts";
import { OllamaClient } from "../llm/ollama-client.ts";
import {
  startDelayedOllamaChatServer,
  type DelayedOllamaChatServer,
} from "../test-utils/delayed-ollama-chat-server.ts";
import type { MemorySettings } from "../settings/memory-settings.ts";
import { EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT } from "../memory/extractor-output-limit.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

function extractorSlot(
  mode: "immediate" | "backfill",
  enabled = true,
): MemorySettings["llm"]["extractor"] {
  return {
    enabled,
    provider: "ollama",
    ollamaUrl: "http://127.0.0.1:11434",
    ollamaModel: "exaone3.5:32b",
    anthropicApiKey: "",
    anthropicModel: "",
    openaiBaseUrl: "http://127.0.0.1:1234/v1",
    openaiModel: "qwen3:4b-instruct",
    openaiApiKey: "",
    gptApiKey: "",
    gptModel: "",
    geminiApiKey: "",
    geminiModel: "",
    mode,
    minImportance: 0.3,
    forceJsonFormat: false,
    timeoutMs: 900000,
    maxOutputTokens: EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT,
    backfill: { intervalMin: 30, batchSize: 10, minImportance: 0, maxAttempts: 5, retryDelayMin: 30, retryMaxDelayMin: 1440 },
  };
}

/** 이번 테스트에서 띄운 루프백 Ollama 서버 — afterEach 가 전부 정리한다. */
let ollamaServers: DelayedOllamaChatServer[] = [];

/** 고정 fixture 응답을 내는 루프백 Ollama 서버 + 실제 OllamaClient 로 만든 MemoryExtractor. */
function fixtureExtractor(store: SqliteMemoryStore, content: string): MemoryExtractor {
  const server = startDelayedOllamaChatServer({
    delayMs: 0,
    content: JSON.stringify([{ content, memoryType: "fact", importance: 0.8 }]),
  });
  ollamaServers.push(server);
  const llm = new OllamaClient({ baseUrl: server.url, model: "test-model" });
  return new MemoryExtractor(llm, store, embedder, { duplicateSim: 0.99 });
}

async function authoredByCount(store: SqliteMemoryStore, nodeId: number): Promise<number> {
  const row = store
    .getRawDb()
    .query(
      "SELECT COUNT(*) AS n FROM node_person_edges WHERE node_id = ? AND relation = 'authored_by'",
    )
    .get(nodeId) as { n: number };
  return row.n;
}

let db: Database;
let store: SqliteMemoryStore;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
});
afterEach(() => {
  db.close();
  for (const server of ollamaServers) server.stop();
  ollamaServers = [];
});

describe("saveTextInput — plain 갈래(긴 글) 원래 출처 보존", () => {
  test("source 미지정(빈 값) + extraMetadata.source='discord-channel' → authored_by 0건", async () => {
    // body.platform 이 없거나 빈 값으로 온 요청(예: 호출처가 platform 을 못 채운 경우)이
    // extraMetadata.source 로 원래 출처를 실어 보낸다 — resolveInputPlatform 이
    // args.source(빈 값)를 건너뛰고 extraMetadata.source 를 봐야 한다.
    const raw = "첫 번째 문단입니다.\n\n두 번째 문단입니다.";
    const result = await saveTextInput(store, {
      content: raw,
      source: "",
      author: "타니아",
      userId: "u-123",
      chunking: { tokenCap: 2 },
      extraMetadata: { source: "discord-channel" },
    });
    expect(await authoredByCount(store, result.originNodeId!)).toBe(0);
    // 클라이언트가 준 원래 출처는 metadata.source 로 보존된다(작성자 메타 보존 정책).
    expect((await store.getNode(result.originNodeId!))?.metadata).toMatchObject({
      source: "discord-channel",
    });
  });

  test("source 미지정(빈 값) + extraMetadata.platform='discord' → authored_by 0건", async () => {
    const raw = "첫 번째 문단입니다.\n\n두 번째 문단입니다.";
    const result = await saveTextInput(store, {
      content: raw,
      source: "",
      author: "타니아",
      userId: "u-123",
      chunking: { tokenCap: 2 },
      extraMetadata: { platform: "discord" },
    });
    expect(await authoredByCount(store, result.originNodeId!)).toBe(0);
  });

  test("args.source 가 이미 채워져 있으면 extraMetadata 보다 우선(계약 순서 고정)", async () => {
    // args.source(body.platform)="slack" 이 비어 있지 않으므로, extraMetadata.source
    // 에 다른 값이 있어도 resolveInputPlatform 은 첫 비어있지 않은 값(args.source)을 쓴다.
    const raw = "첫 번째 문단입니다.\n\n두 번째 문단입니다.";
    const result = await saveTextInput(store, {
      content: raw,
      source: "slack",
      author: "타니아",
      userId: "u-123",
      chunking: { tokenCap: 2 },
      extraMetadata: { source: "discord-channel" },
    });
    expect(await authoredByCount(store, result.originNodeId!)).toBe(1);
  });

  test("extraMetadata 없이 비Discord source → 옛 동작대로 authored_by 1건", async () => {
    const raw = "첫 번째 문단입니다.\n\n두 번째 문단입니다.";
    const result = await saveTextInput(store, {
      content: raw,
      source: "slack",
      author: "타니아",
      userId: "u-123",
      chunking: { tokenCap: 2 },
    });
    expect(await authoredByCount(store, result.originNodeId!)).toBe(1);
  });
});

describe("saveTextInput — immediate 추출 갈래(짧은 글) 원래 출처 보존", () => {
  test("source 없이 extraMetadata.source='discord-channel' → 원본·추출 자식 모두 authored_by 0건", async () => {
    const content = "Bara System은 TypeScript 메모리 코어다";
    const result = await saveTextInput(store, {
      content,
      source: "",
      author: "타니아",
      userId: "u-123",
      chunking: { tokenCap: 2000 },
      extraMetadata: { source: "discord-channel" },
      extractor: fixtureExtractor(store, content),
      extractorSettings: extractorSlot("immediate"),
    });

    expect(result.immediateExtractionRan).toBe(true);
    expect(await authoredByCount(store, result.originNodeId!)).toBe(0);
    for (const childId of result.extracted) {
      expect(await authoredByCount(store, childId)).toBe(0);
    }
  }, 120_000);

  test("prepareImmediateExtraction 으로 잠금 밖 준비한 경로도 같은 원래 출처를 본다", async () => {
    const content = "Bara System은 잠금 밖에서 준비한 짧은 사실이다";
    const args = {
      content,
      source: "",
      author: "타니아",
      userId: "u-123",
      chunking: { tokenCap: 2000 },
      extraMetadata: { source: "discord-channel" },
      extractor: fixtureExtractor(store, content),
      extractorSettings: extractorSlot("immediate"),
    };
    const preparedExtraction = await prepareImmediateExtraction(store, args);
    expect(preparedExtraction).toBeDefined();
    expect(preparedExtraction!.outcome.kind).toBe("extracted");

    const result = await saveTextInput(store, { ...args, preparedExtraction });
    expect(result.immediateExtractionRan).toBe(true);
    expect(await authoredByCount(store, result.originNodeId!)).toBe(0);
    for (const childId of result.extracted) {
      expect(await authoredByCount(store, childId)).toBe(0);
    }
  }, 120_000);

  test("source 없이 extraMetadata.source='slack' → 비Discord 는 authored_by 1건 유지", async () => {
    const content = "Bara System은 슬랙에서 온 짧은 사실이다";
    const result = await saveTextInput(store, {
      content,
      source: "",
      author: "타니아",
      userId: "u-123",
      chunking: { tokenCap: 2000 },
      extraMetadata: { source: "slack" },
      extractor: fixtureExtractor(store, content),
      extractorSettings: extractorSlot("immediate"),
    });

    expect(result.immediateExtractionRan).toBe(true);
    expect(await authoredByCount(store, result.originNodeId!)).toBe(1);
  }, 120_000);
});

describe("saveTextInput — entity_patch/일정 갈래 원래 출처 보존", () => {
  test("일정 발생 입력 — source 미지정(빈 값) + extraMetadata.source='discord-channel' → authored_by 0건", async () => {
    const result = await saveTextInput(store, {
      content: "#일정:치과 예약 #날짜:2026-10-01",
      source: "",
      author: "타니아",
      userId: "u-123",
      extraMetadata: { source: "discord-channel" },
    });
    expect(result.originNodeId).not.toBeNull();
    expect(await authoredByCount(store, result.originNodeId!)).toBe(0);
  });
});
