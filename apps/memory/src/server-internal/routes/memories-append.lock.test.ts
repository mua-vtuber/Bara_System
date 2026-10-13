/**
 * memories-append.lock.test.ts — 즉시 추출 LLM 호출을 쓰기 잠금 밖으로 뺀 REST 저장(WP-B1-08, SL-7).
 *
 * LLM 은 테스트 안 로컬 HTTP 서버(Bun.serve)가 Ollama /api/chat 형식으로 지연 응답하고, 실제
 * OllamaClient 가 그 서버를 부른다. 저장은 실제 SQLite + 실제 bge-m3 임베딩, 라우트는 실제
 * buildMemoryApi 조립이다. mock 0.
 *
 * 검증:
 *  1. append 즉시 추출의 LLM 지연 동안 다른 흐름의 잠금 작업이 기다리지 않고, 응답 칸은 옛 형식 그대로다.
 *  2. LLM 지연 동안 대상이 철회되면 409, 지워지면 404 — 덧붙임도 추출 자식도 저장하지 않는다.
 *  3. 준비 때 있던 같은 본문 기억이 잠금 전에 지워지면 409 CONFLICT — LLM 0회, 저장 0건.
 *  4. evidence 가 있는 POST /memories(saveSharedMemoryInput 경유)도 LLM 지연 동안 잠금이 비어 있고,
 *     즉시 추출 응답 칸(extracted·bumped·extractor)이 옛 형식 그대로다.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { MemoryExtractor } from "../../memory/extractor.ts";
import { OllamaClient } from "../../llm/ollama-client.ts";
import { withMemoryMutationLock } from "../../memory/shared-memory-mutation-lock.ts";
import { retractSharedMemory } from "../../memory/shared-memory-mutations.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import { buildMemoryApi } from "../../server.ts";
import {
  startDelayedOllamaChatServer,
  type DelayedOllamaChatServer,
} from "../../test-utils/delayed-ollama-chat-server.ts";

const LLM_DELAY_MS = 3_000;
/** 잠금이 비어 있으면 bumpMention 한 번은 LLM 지연보다 훨씬 짧다. */
const LOCK_WAIT_LIMIT_MS = 1_000;
/** 여러 절이 있는 글 — 짧은 단일 의미 입력은 추출기가 LLM 을 건너뛴다(shouldSkipExtraction). */
const APPEND_TEXT =
  "나는 매일 아침 커피를 마신다. 나는 주말마다 북한산에 오른다. 나는 저녁마다 추리소설을 읽는다.";
const CHILD_CONTENT = "나는 매일 아침 커피를 마신다";
/** 중복 흡수(bump) 없이 자식이 새 노드가 되게 하는 임계 — 생성자 옵션으로 넘긴다. */
const NO_DEDUP_SIM = 0.999;
/**
 * 잠금을 쥔 동안 요청의 잠금 밖 준비(본문 파싱·대상 조회·같은 본문 원본 조회 — DB 읽기 몇 번)가
 * 끝나기를 기다리는 시간. 이 안에 끝나지 않으면 LLM 호출 수 단언이 실패로 드러낸다.
 */
const PREPARE_SETTLE_MS = 1_000;
/** 옛 append 응답 칸 — 바뀌면 이 테스트가 잡는다. */
const APPEND_RESPONSE_KEYS = ["appendedId", "bumped", "extracted", "node", "nodeIds", "targetId", "warnings"];
/** 옛 POST /memories 즉시 추출 응답 칸. */
const IMMEDIATE_RESPONSE_KEYS = ["bumped", "cacheHit", "extracted", "extractor", "id", "node", "originNodeId", "type"];

type Json = Record<string, unknown>;

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let db: Database;
let store: SqliteMemoryStore;
let llm: DelayedOllamaChatServer;
let app: Hono;
let extractor: MemoryExtractor;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  llm = startDelayedOllamaChatServer({
    delayMs: LLM_DELAY_MS,
    content: JSON.stringify([{ content: CHILD_CONTENT, memoryType: "fact", importance: 0.6 }]),
  });
  extractor = new MemoryExtractor(
    new OllamaClient({ baseUrl: llm.url, model: "test-model" }),
    store,
    embedder,
    { duplicateSim: NO_DEDUP_SIM },
  );
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  settings.llm.extractor.enabled = true;
  settings.llm.extractor.mode = "immediate";
  app = buildMemoryApi({
    store,
    retriever: new HybridRetriever(store, embedder),
    assembler: new ContextAssembler(),
    extractor,
    getSettings: () => settings,
  });
});

afterEach(() => {
  llm.stop();
  db.close();
});

async function post(path: string, body: Json): Promise<{ status: number; body: Json }> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

function llmChildIds(): number[] {
  return (db.query("SELECT id FROM knowledge_nodes WHERE source_type = 'llm_extract' ORDER BY id").all() as Array<{ id: number }>)
    .map((row) => row.id);
}

function nodeCount(): number {
  return (db.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }).n;
}

/** 요청을 보내고 LLM 요청이 도착할 때까지 기다린다. 응답은 LLM 지연 뒤에 온다. */
async function startWhileLlmWaits(path: string, body: Json) {
  const arrived = llm.nextRequest();
  let finished = false;
  const reply = post(path, body).then((result) => { finished = true; return result; });
  await arrived;
  return { reply, finished: () => finished };
}

/** 다른 흐름의 잠금 작업 하나가 걸린 시간(ms). */
async function timedLockedWrite(nodeId: number): Promise<number> {
  const start = performance.now();
  await withMemoryMutationLock(store, () => store.bumpMention(nodeId));
  return performance.now() - start;
}

describe("POST /memories/:id/append — 즉시 추출 LLM 은 잠금 밖", () => {
  test("LLM 지연 중 다른 잠금 작업이 기다리지 않고, 응답 칸과 저장 결과는 옛 흐름과 같다", async () => {
    const target = await store.addNode({ content: "덧붙일 대상이 되는 기존 기억", sourceType: "user_explicit" });
    const other = await store.addNode({ content: "잠금 작업 대상 기억", sourceType: "user_explicit" });

    const pending = await startWhileLlmWaits(`/memories/${target}/append`, { content: APPEND_TEXT, author: "tester" });
    const lockWaitMs = await timedLockedWrite(other);
    expect(pending.finished()).toBe(false);
    expect(lockWaitMs).toBeLessThan(LOCK_WAIT_LIMIT_MS);

    const { status, body } = await pending.reply;
    expect(status).toBe(201);
    expect(Object.keys(body).sort()).toEqual(APPEND_RESPONSE_KEYS);
    const [child] = llmChildIds();
    expect(body).toMatchObject({ targetId: target, extracted: [child], bumped: [], warnings: [] });
    const appendedId = body.appendedId as number;
    expect(body.nodeIds).toEqual([appendedId]);
    expect((await store.getNode(child!))?.content).toBe(CHILD_CONTENT);
    expect((await store.getNode(appendedId))?.metadata).toMatchObject({ appendedTo: target, extracted: 1, extractedTo: [child] });
    expect(db.query("SELECT COUNT(*) AS n FROM knowledge_edges WHERE source_id = ? AND target_id = ? AND relation = 'links_to'")
      .get(appendedId, target)).toEqual({ n: 1 });
    expect(db.query("SELECT COUNT(*) AS n FROM knowledge_edges WHERE source_id = ? AND target_id = ? AND relation = 'merged_into'")
      .get(child!, appendedId)).toEqual({ n: 1 });
    expect(llm.requestCount()).toBe(1);
  }, 30_000);

  test("LLM 지연 중 대상이 철회되면 409 — 덧붙임도 추출 자식도 저장하지 않는다", async () => {
    const target = await store.addNode({ content: "곧 철회될 대상 기억", sourceType: "user_explicit" });
    const before = nodeCount();

    const pending = await startWhileLlmWaits(`/memories/${target}/append`, { content: APPEND_TEXT });
    await retractSharedMemory(store, { nodeId: target, expectedRevision: 0, requestId: "retract-during-append", actor: "tester" });
    expect(pending.finished()).toBe(false);

    const { status, body } = await pending.reply;
    expect(status).toBe(409);
    expect(body).toEqual({ error: `memory ${target} is not a current memory` });
    expect(nodeCount()).toBe(before);
    expect(llmChildIds()).toEqual([]);
  }, 30_000);

  test("LLM 지연 중 대상이 지워지면 404 — 덧붙임도 추출 자식도 저장하지 않는다", async () => {
    const target = await store.addNode({ content: "곧 지워질 대상 기억", sourceType: "user_explicit" });

    const pending = await startWhileLlmWaits(`/memories/${target}/append`, { content: APPEND_TEXT });
    await withMemoryMutationLock(store, () => store.deleteNode(target));

    const { status, body } = await pending.reply;
    expect(status).toBe(404);
    expect(body).toEqual({ error: `memory ${target} not found` });
    expect(nodeCount()).toBe(0);
  }, 30_000);
});

describe("POST /memories/:id/append — 준비 결과를 쓸 수 없게 되면 409 CONFLICT", () => {
  test("준비 때 있던 같은 본문 기억이 잠금 전에 지워지면 409 + 재전송 안내, LLM 0회, 아무것도 저장하지 않는다", async () => {
    const target = await store.addNode({ content: "덧붙일 대상이 되는 기존 기억", sourceType: "user_explicit" });
    // 같은 본문 원본이 있으면 준비는 LLM 을 부르지 않고 "같은 본문 원본 있음"으로 끝난다.
    const sameBody = await store.addNode({ content: APPEND_TEXT, sourceType: "auto_capture" });

    // 잠금을 쥔 채 요청을 보내 준비(잠금 밖, DB 읽기만)가 끝나고 잠금 줄에 서게 한 뒤, 잠금 안에서
    // 같은 본문 원본을 지운다. 준비가 삭제 뒤에 돌았다면 LLM 을 불렀을 것이라 requestCount 로 드러난다.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = withMemoryMutationLock(store, async () => {
      await gate;
      await store.deleteNode(sameBody);
    });
    const reply = post(`/memories/${target}/append`, { content: APPEND_TEXT });
    await Bun.sleep(PREPARE_SETTLE_MS);
    release();
    await holder;

    const { status, body } = await reply;
    expect(status).toBe(409);
    expect(body.code).toBe("CONFLICT");
    expect(body.error).toContain("다시 보내 주세요");
    expect(llm.requestCount()).toBe(0);
    expect(nodeCount()).toBe(1);
    expect(llmChildIds()).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM knowledge_edges WHERE target_id = ? AND relation = 'links_to'").get(target))
      .toEqual({ n: 0 });
  }, 30_000);
});

describe("POST /memories (evidence) — saveSharedMemoryInput 즉시 추출도 잠금 밖", () => {
  test("LLM 지연 중 다른 잠금 작업이 기다리지 않고, 즉시 추출 응답 칸은 옛 형식 그대로다", async () => {
    const other = await store.addNode({ content: "잠금 작업 대상 기억", sourceType: "user_explicit" });

    const pending = await startWhileLlmWaits("/memories", {
      content: APPEND_TEXT,
      evidence: { assertionKind: "user_statement", sourceEventId: "rest-event-1" },
    });
    const lockWaitMs = await timedLockedWrite(other);
    expect(pending.finished()).toBe(false);
    expect(lockWaitMs).toBeLessThan(LOCK_WAIT_LIMIT_MS);

    const { status, body } = await pending.reply;
    expect(status).toBe(201);
    expect(Object.keys(body).sort()).toEqual(IMMEDIATE_RESPONSE_KEYS);
    const [child] = llmChildIds();
    expect(body).toMatchObject({
      type: "memory", extracted: [child], bumped: [], extractor: { provider: extractor.llmName }, cacheHit: false,
    });
    expect(body.originNodeId).toBe(body.id);
    expect(llm.requestCount()).toBe(1);
  }, 30_000);
});
