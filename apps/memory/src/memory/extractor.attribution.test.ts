/**
 * extractor.attribution.test.ts — DA-5: 추출 자식의 Discord 작성자 판별 배선.
 *
 * extractAndStore 는 linkAuthorPerson 에 platform 을 scopedInput.platform 이 있으면
 * 그 값, 없으면 scopedInput.metadata.source 를 넘긴다(extractor.ts:477-486). platform
 * 이 빈 문자열이고 metadata.source="discord-channel" 인 입력이 이 대체 판별을 타는지,
 * 그리고 원래 출처가 비Discord 면 옛 동작대로 authored_by 가 생기는지 검증한다.
 *
 * extractor.test.ts 는 이미 800줄 하드 상한을 넘겨(1937줄) 새 테스트를 더 넣지 않는다
 * (감사 수정 공통 지침 — 이미 넘긴 파일은 키우지 않고 새 작은 모듈에 둔다). 이 파일은
 * extractor.dedup-scope.test.ts 와 같은 네이밍·구조 선례를 따른다.
 *
 * mock 0 — 실제 SqliteMemoryStore + 실제 Bgem3Embedder + 실제 OllamaClient(루프백
 * 서버 test-utils/delayed-ollama-chat-server.ts). LlmClient 인터페이스를 흉내 내는
 * 객체를 만들지 않는다(CLAUDE.md "테스트 정책" — Mock 객체 금지, WP-B1-19R).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { OllamaClient } from "../llm/ollama-client.ts";
import {
  startDelayedOllamaChatServer,
  type DelayedOllamaChatServer,
} from "../test-utils/delayed-ollama-chat-server.ts";
import { inputChildSource } from "../test-utils/extraction-placement.ts";
import { MemoryExtractor } from "./extractor.ts";

/** 고정 fixture 응답을 내는 루프백 Ollama 서버 + 실제 OllamaClient — LlmClient 배선. */
function fixtureLlm(content: string): { client: OllamaClient; server: DelayedOllamaChatServer } {
  const server = startDelayedOllamaChatServer({
    delayMs: 0,
    content: JSON.stringify([{ content, memoryType: "fact", importance: 0.8 }]),
  });
  const client = new OllamaClient({ baseUrl: server.url, model: "test-model" });
  return { client, server };
}

let embedder: Bgem3Embedder;
let db: Database;
let store: SqliteMemoryStore;
let ollamaServer: DelayedOllamaChatServer | undefined;

describe("extractAndStore — Discord 출처 판별 배선(DA-5)", () => {
  beforeEach(async () => {
    embedder = new Bgem3Embedder();
    await embedder.load();
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });

  afterEach(() => {
    db.close();
    ollamaServer?.stop();
    ollamaServer = undefined;
  });

  test("platform 빈 문자열 + metadata.source='discord-channel' — 추출 자식에 authored_by 없음", async () => {
    const { client, server } = fixtureLlm("디스코드 채널에서 뽑은 사실이다. 이 문장은 짧은글 게이트를 넘기려고 충분히 길게 썼다.");
    ollamaServer = server;
    const extractor = new MemoryExtractor(
      client,
      store,
      embedder,
      { duplicateSim: 0.99 },
    );
    // 저장된 원문 없이 추출 배선만 본다 — 자식은 이 입력의 직접 출처를 받는다(WP-B1-20T 설계 6.2).
    const input = {
      text: "디스코드 채널 메시지다. 이 문장은 짧은글 게이트를 넘기려고 충분히 길게 썼다.",
      author: "작성자",
      platform: "",
      metadata: { user_id: "discord-user-1", source: "discord-channel" },
      skipHashtagWiring: true,
    };
    const result = await extractor.extractAndStore(input, inputChildSource(input));

    expect(result.storedNodeIds).toHaveLength(1);
    const childId = result.storedNodeIds[0]!;
    expect(await store.listNodePersonEdges({ nodeId: childId, relation: "authored_by" }))
      .toHaveLength(0);
    expect(await store.listPersons({ limit: 10 })).toHaveLength(0);
  }, 120_000);

  test("비Discord 출처는 기존대로 authored_by 1건", async () => {
    const { client, server } = fixtureLlm("슬랙 채널에서 뽑은 사실이다. 이 문장도 짧은글 게이트를 넘기려고 충분히 길게 썼다.");
    ollamaServer = server;
    const extractor = new MemoryExtractor(
      client,
      store,
      embedder,
      { duplicateSim: 0.99 },
    );
    const input = {
      text: "슬랙 채널 메시지다. 이 문장도 짧은글 게이트를 넘기려고 충분히 길게 썼다.",
      author: "작성자",
      platform: "",
      metadata: { user_id: "slack-user-1", source: "slack-channel" },
      skipHashtagWiring: true,
    };
    const result = await extractor.extractAndStore(input, inputChildSource(input));

    expect(result.storedNodeIds).toHaveLength(1);
    const childId = result.storedNodeIds[0]!;
    const edges = await store.listNodePersonEdges({ nodeId: childId, relation: "authored_by" });
    expect(edges).toHaveLength(1);
  }, 120_000);
});
