/**
 * cleanup.lock.test.ts — POST /cleanup 도 백필과 같은 "잠금 밖 LLM, 잠금 안 재확인 뒤 저장"을 쓴다(WP-B1-31).
 *
 * 실제 SQLite + 실제 bge-m3 + buildMemoryApi 라우트. LLM 은 테스트 안 Bun.serve 가 Ollama /api/chat
 * 형식으로 지연 응답하고(test-utils/delayed-ollama-chat-server.ts), 실제 MemoryExtractor·OllamaClient 가 부른다.
 *
 *  1. LLM 을 기다리는 동안 원문을 편집하면 LLM 결과는 버려지고(응답 discarded 에 이유), 편집이 남긴
 *     추출 대기 표시가 그대로 남는다. 그 사이 다른 흐름의 쓰기 잠금 작업은 LLM 을 기다리지 않는다.
 *  2. 재확인이 맞으면 옛 응답 칸 그대로 저장·merged_into·추출 완료 표시를 한다.
 *  3. 청크가 필요한 긴 원문은 LLM 을 부르지 않고 재청크한다.
 */

import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { OllamaClient } from "../../llm/ollama-client.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { MemoryExtractor } from "../../memory/extractor.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { withMemoryMutationLock } from "../../memory/shared-memory-mutation-lock.ts";
import { buildMemoryApi } from "../../server.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-schema.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import {
  startDelayedOllamaChatServer,
  type DelayedOllamaChatServer,
} from "../../test-utils/delayed-ollama-chat-server.ts";
import { saveTextInput } from "../save-input.ts";

const LLM_DELAY_MS = 3_000;
/** 잠금이 비어 있으면 bumpMention 한 번은 LLM 지연보다 훨씬 짧다. */
const LOCK_WAIT_LIMIT_MS = 1_000;
const AUTHOR = "user-a";
const SOURCE_TEXT =
  "나는 매일 아침 커피를 마신다. 나는 주말마다 북한산에 오른다. 나는 저녁마다 추리소설을 읽는다.";
const EDITED_TEXT = "나는 매일 아침 녹차를 마신다. 나는 주말마다 한강에서 자전거를 탄다.";
const CHILD_CONTENTS = ["나는 매일 아침 커피를 마신다", "나는 주말마다 북한산에 오른다"];
const CHUNK_TOKEN_CAP = 60;
const LONG_PARAGRAPHS = [
  "개정 결정문은 화요일 오전 창구를 쓴다. 금요일 배포는 멈춘다.",
  "롤백 담당은 플랫폼팀이 맡는다. 알림은 메일로 보낸다.",
  "점검 목록은 배포 당일 아침에 본다. 결과는 채널에 남긴다.",
];

interface CleanupResponse {
  candidatesFound: number;
  processed: number;
  stored: number;
  bumped: number;
  rechunked: number;
  failures: number;
  errors: Array<{ nodeId: number; error: string }>;
  discarded: Array<{ nodeId: number; reason: string }>;
}

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
  server: DelayedOllamaChatServer;
}

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) {
    h.server.stop();
    h.db.close();
  }
});

/** chunkTokenCap 을 주면 settings.chunking 한도를 그 값으로 낮춘다(없으면 기본 설정). */
function makeHarness(delayMs: number, chunkTokenCap?: number): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const server = startDelayedOllamaChatServer({
    delayMs,
    content: JSON.stringify(CHILD_CONTENTS.map((content) => ({ content, memoryType: "fact", importance: 0.6 }))),
  });
  const extractor = new MemoryExtractor(
    new OllamaClient({ baseUrl: server.url, model: "test-model" }),
    store, embedder, { duplicateSim: 0.999, minImportance: 0 },
  );
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  if (chunkTokenCap !== undefined) {
    settings.chunking.tokenCap = chunkTokenCap;
    settings.chunking.minChunkTokens = 1;
  }
  const app = buildMemoryApi({
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(),
    extractor, getSettings: () => settings,
  });
  const h = { app, db, store, server };
  harnesses.push(h);
  return h;
}

async function postCleanup(h: Harness): Promise<Response> {
  return h.app.request("/cleanup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 10 }),
  });
}

function extractChildIds(h: Harness): number[] {
  return (h.db.query("SELECT id FROM knowledge_nodes WHERE source_type = 'llm_extract' ORDER BY id").all() as Array<{ id: number }>)
    .map((row) => row.id);
}

describe("POST /cleanup — LLM 을 기다리는 동안의 편집", () => {
  test("편집된 원문의 LLM 결과는 버려지고 이유가 응답에 남으며, 추출 대기 표시가 그대로다", async () => {
    const h = makeHarness(LLM_DELAY_MS);
    const candidate = await h.store.addNode({ content: SOURCE_TEXT, sourceType: "auto_capture", author: AUTHOR });
    const other = await h.store.addNode({ content: "잠금 작업 대상 기억", sourceType: "user_explicit", author: AUTHOR });

    const warn = spyOn(console, "warn");
    let body: CleanupResponse;
    let lockWaitMs: number;
    try {
      const llmCalled = h.server.nextRequest();
      const response = postCleanup(h);
      await llmCalled;
      const lockStart = performance.now();
      await withMemoryMutationLock(h.store, () => h.store.bumpMention(other));
      lockWaitMs = performance.now() - lockStart;
      const edited = await withMemoryMutationLock(h.store, () =>
        h.store.editNodeContent({ nodeId: candidate, content: EDITED_TEXT }));
      expect(edited?.claimChanged).toBe(true);

      const res = await response;
      expect(res.status).toBe(200);
      body = await res.json() as CleanupResponse;
      expect(warn.mock.calls.map((call) => call.map(String).join(" "))
        .filter((line) => line.includes(`[cleanup] 기억 ${candidate} 추출 결과 버림`))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }

    expect(lockWaitMs).toBeLessThan(LOCK_WAIT_LIMIT_MS);
    expect(body).toMatchObject({ candidatesFound: 1, processed: 0, stored: 0, bumped: 0, rechunked: 0, failures: 0 });
    expect(body.discarded).toHaveLength(1);
    expect(body.discarded[0]!.nodeId).toBe(candidate);
    expect(body.discarded[0]!.reason).toContain("원문 본문이 바뀌었다");
    expect(extractChildIds(h)).toEqual([]);
    const node = (await h.store.getNode(candidate))!;
    expect(node.content).toBe(EDITED_TEXT);
    expect(node.metadata.extracted).toBe(0);
    expect(node.metadata).not.toHaveProperty("extractedTo");
    expect(h.store.nodeRepo.isBackfillCandidateEligible(candidate)).toBe(true);
  }, 30_000);
});

describe("POST /cleanup — 재확인이 맞으면 저장한다", () => {
  test("옛 응답 칸 그대로 자식 저장·merged_into·추출 완료 표시를 한다", async () => {
    const h = makeHarness(0);
    const candidate = await h.store.addNode({
      content: SOURCE_TEXT, sourceType: "auto_capture", author: AUTHOR, metadata: { messageId: "msg-cleanup-1" },
    });

    const res = await postCleanup(h);
    expect(res.status).toBe(200);
    const body = await res.json() as CleanupResponse;
    expect(body).toMatchObject({
      candidatesFound: 1, processed: 1, stored: CHILD_CONTENTS.length, bumped: 0, rechunked: 0, failures: 0,
      errors: [], discarded: [],
    });
    const children = extractChildIds(h);
    expect(children).toHaveLength(CHILD_CONTENTS.length);
    expect((await h.store.getNode(candidate))!.metadata).toMatchObject({ extracted: 1, extractedTo: children });
    for (const child of children) {
      expect(h.db.query("SELECT COUNT(*) AS n FROM knowledge_edges WHERE source_id = ? AND target_id = ? AND relation = 'merged_into'")
        .get(child, candidate)).toEqual({ n: 1 });
      // 백필과 같이 원문 metadata(messageId 추적)를 자식이 이어받는다.
      expect((await h.store.getNode(child))!.metadata.messageId).toBe("msg-cleanup-1");
    }
    expect(h.store.nodeRepo.isBackfillCandidateEligible(candidate)).toBe(false);
  }, 60_000);
});

describe("POST /cleanup — 청크가 필요한 긴 원문", () => {
  test("청크 없이 추출 대기인 긴 원문은 LLM 을 부르지 않고 재청크한다", async () => {
    const h = makeHarness(0, CHUNK_TOKEN_CAP);
    const saved = await saveTextInput(h.store, {
      content: "배포 결정문 초안이다. 세부 내용은 다음 회의에서 정한다.", source: "test", author: AUTHOR, force: true,
      chunking: { tokenCap: CHUNK_TOKEN_CAP, minChunkTokens: 1 },
    });
    const origin = saved.originNodeId!;
    // 편집으로 긴 본문이 됐고, 편집 뒤 재청크가 돌지 않은(실패한) 상태 — 청크 없이 추출 대기.
    await withMemoryMutationLock(h.store, () =>
      h.store.editNodeContent({ nodeId: origin, content: LONG_PARAGRAPHS.join("\n\n") }));
    expect((await h.store.getNode(origin))!.metadata.extracted).toBe(0);

    const res = await postCleanup(h);
    const body = await res.json() as CleanupResponse;
    expect(h.server.requestCount()).toBe(0);
    expect(body).toMatchObject({ candidatesFound: 1, processed: 0, stored: 0, rechunked: 1, failures: 0, discarded: [] });
    const chunks = h.db.query(`SELECT c.content FROM knowledge_edges e JOIN knowledge_nodes c ON c.id = e.source_id
      WHERE e.target_id = ? AND e.relation = 'parent_of' ORDER BY c.id`).all(origin) as Array<{ content: string }>;
    expect(chunks.map((row) => row.content)).toEqual(LONG_PARAGRAPHS);
    expect((await h.store.getNode(origin))!.metadata).not.toHaveProperty("extracted");
    expect(h.store.nodeRepo.isBackfillCandidateEligible(origin)).toBe(false);
  }, 60_000);
});
