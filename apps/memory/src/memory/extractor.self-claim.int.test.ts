/**
 * extractor.self-claim.int.test.ts — 추출 자식이 붙는 곳과 자기 주장 규칙(WP-B1-20T T3, 설계 6.2·3.6.1·5.9).
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 실제 MemoryExtractor·ConflictChecker·OllamaClient. LLM 은 테스트 안
 * 루프백 서버(test-utils/prompt-ollama-chat-server.ts)가 원문마다 정해 둔 항목을 돌려준다. 백필은 실제
 * startBackfillScheduler 주기(tickNow)로 돈다.
 *
 *  - storeExtraction 은 lineage 도 childSource 도 없으면(또는 둘 다면) 아무것도 쓰지 않고 멈춘다.
 *  - 여러 항목: 원문과 다른 항목은 자식(계보 엣지 → 원문), 원문과 같은 항목은 자기 주장(자식·엣지·언급·출처
 *    그대로, selfClaimNodeIds). 원문과 거의 같은 항목(유사 흡수 대상이 원문)도 자기 주장이다.
 *  - 자식은 자기 원문과, 자기 주장인 원문은 자기 자식과 충돌 후보로 이어지지 않는다.
 *  - 한 문장 원문의 백필: 자기 엣지 없이 원문이 다른 AI 의 반대 주장과 충돌 후보가 된다(설계 5.9, 9절 위험 3).
 */

import { TEST_EXTRACTION_BACKFILL_RETRY } from "../test-utils/backfill-retry.ts";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { EMBEDDING_CONFLICT_THRESHOLDS } from "../embedding/factory.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { NodeSourceRepository } from "../db/store-internal/node-source-repository.ts";
import { OllamaClient } from "../llm/ollama-client.ts";
import { startBackfillScheduler } from "../scheduler.ts";
import {
  startPromptOllamaChatServer,
  type ExtractionReply,
  type PromptOllamaChatServer,
} from "../test-utils/prompt-ollama-chat-server.ts";
import { inputChildSource } from "../test-utils/extraction-placement.ts";
import { ConflictChecker } from "./conflict-checker.ts";
import { MemoryExtractor, originExtractionLineage, type ExtractInput } from "./extractor.ts";
import { describeInputSource } from "./node-sources/source-ref.ts";
import { listOpenConflicts } from "./open-conflicts.ts";
import { readSharedMemory } from "./shared-memory-contract.ts";

const OWNER = "owner";
const BGE_M3 = EMBEDDING_CONFLICT_THRESHOLDS["bge-m3"];

/** 두 문장 원문 — 원문과 같은 항목(자기 주장)과 다른 항목(자식, 원문 유사도 실측 0.832)을 함께 돌려받는다. */
const MULTI_ORIGIN = "답변은 한국어로 해 주세요. 코드 주석도 한국어로 남겨 주세요.";
const MULTI_CHILD = "코드 주석도 한국어로 남겨 주세요";
/** 원문과 거의 같은 항목 — 원문 유사도 실측 0.923(중복 흡수 임계 0.85 이상), 같은 작성자라 원문이 흡수 대상. */
const NEAR_ORIGIN = "답변은 한국어로 해 주세요. 부탁드립니다.";
const NEAR_CLAIM = "답변은 한국어로 해 주세요";
/**
 * 한 문장 원문(Codex)과 다른 AI(Claude)의 반대 주장 — 원문끼리 유사도 실측 0.915(충돌 상한 0.85 이상, 작성
 * AI 가 달라 충돌 후보). 원문과 다른 항목의 원문 유사도는 실측 0.794 라 자식이 된다.
 */
const BACKFILL_ORIGIN = "앞으로 모든 답변은 영어로 작성하고 코드 주석도 영어로 남겨 주세요";
const BACKFILL_CHILD = "코드 주석은 영어로 남긴다";
const OPPOSITE_CLAIM = "앞으로 모든 답변은 한국어로 작성하고 코드 주석도 한국어로 남겨 주세요";

const preference = (content: string) => ({ content, memoryType: "preference", importance: 0.8 });
const REPLIES: readonly ExtractionReply[] = [
  // 자식 항목이 먼저 온다 — 자기 주장 검사 때 원문의 자식이 이미 있어도 후보에서 빠지는지 본다.
  { source: MULTI_ORIGIN, items: [preference(MULTI_CHILD), preference(MULTI_ORIGIN)] },
  { source: NEAR_ORIGIN, items: [preference(NEAR_CLAIM)] },
  { source: BACKFILL_ORIGIN, items: [preference(BACKFILL_ORIGIN), preference(BACKFILL_CHILD)] },
];

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

interface Harness {
  db: Database;
  store: SqliteMemoryStore;
  llm: PromptOllamaChatServer;
  extractor: MemoryExtractor;
}

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) {
    h.llm.stop();
    h.db.close();
  }
});

function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const llm = startPromptOllamaChatServer(REPLIES);
  const extractor = new MemoryExtractor(
    new OllamaClient({ baseUrl: llm.url, model: "test-model" }), store, embedder,
    { conflictChecker: new ConflictChecker(store, { simLow: BGE_M3.conflictLow, simHigh: BGE_M3.conflictHigh }), duplicateSim: BGE_M3.dedupSim },
  );
  const h = { db, store, llm, extractor };
  harnesses.push(h);
  return h;
}

/** 대시보드 직접 저장으로 원문을 둔다(출처 행 1개). */
async function addOrigin(h: Harness, content: string, author = OWNER, sourceType: "auto_capture" | "user_explicit" = "auto_capture") {
  return h.store.addNode({
    content, author, memoryType: "preference", sourceType,
    provenance: { kind: "source", source: describeInputSource({ source: "dashboard:manual", author }) },
  });
}

function extractInput(content: string, author = OWNER): ExtractInput {
  return { text: content, author, platform: "dashboard:manual", skipHashtagWiring: true };
}

function nodeState(db: Database, id: number): { mention_count: number; metadata_json: string } {
  return db.query("SELECT mention_count, metadata_json FROM knowledge_nodes WHERE id = ?")
    .get(id) as { mention_count: number; metadata_json: string };
}

function llmExtractContents(db: Database): string[] {
  return (db.query("SELECT content FROM knowledge_nodes WHERE source_type = 'llm_extract' ORDER BY id").all() as Array<{ content: string }>)
    .map((row) => row.content);
}

function edges(db: Database, relation: string): Array<{ source_id: number; target_id: number }> {
  return db.query("SELECT source_id, target_id FROM knowledge_edges WHERE relation = ? ORDER BY source_id, target_id")
    .all(relation) as Array<{ source_id: number; target_id: number }>;
}

function selfEdgeCount(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM knowledge_edges WHERE source_id = target_id").get() as { n: number }).n;
}

function sourceKeys(db: Database, id: number): string[] {
  return (new NodeSourceRepository(db).listSync([id]).get(id) ?? []).map((row) => row.key);
}

function nodeCount(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }).n;
}

describe("자식이 붙는 곳(설계 6.2)", () => {
  test("lineage 도 childSource 도 없으면 아무것도 쓰지 않고 멈춘다 — extractAndStore 는 LLM 도 부르지 않는다", async () => {
    const h = makeHarness();
    const input = extractInput(MULTI_ORIGIN);
    const prepared = await h.extractor.prepareExtraction(input);
    expect(h.llm.requestCount()).toBe(1);

    await expect(h.extractor.storeExtraction(prepared, input, {} as never))
      .rejects.toThrow("lineage 도 childSource 도 없습니다");
    await expect(h.extractor.extractAndStore(input, {} as never))
      .rejects.toThrow("lineage 도 childSource 도 없습니다");
    expect(h.llm.requestCount()).toBe(1);
    expect(nodeCount(h.db)).toBe(0);
  }, 60_000);

  test("lineage 와 childSource 를 함께 주면 아무것도 쓰지 않고 멈춘다", async () => {
    const h = makeHarness();
    const origin = await addOrigin(h, MULTI_ORIGIN);
    const input = extractInput(MULTI_ORIGIN);
    const prepared = await h.extractor.prepareExtraction(input);

    await expect(h.extractor.storeExtraction(prepared, input, {
      lineage: originExtractionLineage(origin), ...inputChildSource(input),
    } as never)).rejects.toThrow("lineage 와 childSource 를 함께 받았습니다");
    expect(nodeCount(h.db)).toBe(1);
  }, 60_000);
});

describe("자기 주장 규칙(설계 3.6.1)", () => {
  test("여러 항목 — 원문과 다른 항목은 자식, 원문과 같은 항목은 자기 주장이고 원문은 바뀌지 않는다", async () => {
    const h = makeHarness();
    const origin = await addOrigin(h, MULTI_ORIGIN);
    const before = nodeState(h.db, origin);
    const input = extractInput(MULTI_ORIGIN);

    const result = await h.extractor.storeExtraction(
      await h.extractor.prepareExtraction(input), input, { lineage: originExtractionLineage(origin) },
    );

    expect(llmExtractContents(h.db)).toEqual([MULTI_CHILD]);
    expect(result.storedNodeIds).toHaveLength(1);
    const child = result.storedNodeIds[0]!;
    expect(result).toMatchObject({ storedNodeIds: [child], bumpedNodeIds: [], selfClaimNodeIds: [origin] });
    expect(edges(h.db, "merged_into")).toEqual([{ source_id: child, target_id: origin }]);
    expect(selfEdgeCount(h.db)).toBe(0);
    // 원문의 언급·metadata·출처 행이 그대로다.
    expect(nodeState(h.db, origin)).toEqual(before);
    expect(sourceKeys(h.db, origin)).toEqual([describeInputSource({ source: "dashboard:manual", author: OWNER }).key]);
    expect(sourceKeys(h.db, child)).toEqual([]);
    // 자식은 자기 원문과, 자기 주장인 원문은 먼저 저장된 자기 자식과 충돌 후보로 이어지지 않는다.
    expect(edges(h.db, "contradicts")).toEqual([]);
    expect(result.conflictsDetected).toBe(0);
    expect(readSharedMemory(JSON.parse(nodeState(h.db, child).metadata_json)).status).toBe("active");
  }, 60_000);

  test("유사 흡수 대상이 원문 자신인 항목도 자기 주장이다 — 자식도 언급 증가도 없다", async () => {
    const h = makeHarness();
    const origin = await addOrigin(h, NEAR_ORIGIN);
    const before = nodeState(h.db, origin);
    const input = extractInput(NEAR_ORIGIN);

    const result = await h.extractor.storeExtraction(
      await h.extractor.prepareExtraction(input), input, { lineage: originExtractionLineage(origin) },
    );

    expect(result).toMatchObject({ storedNodeIds: [], bumpedNodeIds: [], selfClaimNodeIds: [origin] });
    expect(llmExtractContents(h.db)).toEqual([]);
    expect(nodeState(h.db, origin)).toEqual(before);
    expect(edges(h.db, "merged_into")).toEqual([]);
  }, 60_000);

  test("childSource — 원문이 없으면 원문과 같은 본문 항목도 자식이 되고 자식마다 입력 출처 행이 남는다", async () => {
    const h = makeHarness();
    const input = extractInput(MULTI_ORIGIN);

    const result = await h.extractor.storeExtraction(
      await h.extractor.prepareExtraction(input), input, inputChildSource(input),
    );

    expect(result.selfClaimNodeIds).toEqual([]);
    expect(llmExtractContents(h.db)).toEqual([MULTI_CHILD, MULTI_ORIGIN]);
    const inputKey = describeInputSource({ source: "dashboard:manual", author: OWNER }).key;
    for (const id of result.storedNodeIds) expect(sourceKeys(h.db, id)).toEqual([inputKey]);
    expect(edges(h.db, "merged_into")).toEqual([]);
  }, 60_000);
});

describe("백필(설계 5.9) — 백필과 즉시 추출이 같은 규칙", () => {
  test("한 문장 원문의 백필: 자기 엣지가 없고, 원문이 다른 AI 의 반대 주장과 충돌 후보가 된다", async () => {
    const h = makeHarness();
    // Claude 가 남긴 반대 주장(백필 후보 종류가 아니다).
    const opposite = await addOrigin(h, OPPOSITE_CLAIM, "claude-code", "user_explicit");
    // Codex 가 남긴 한 문장 원문 — 아직 추출하지 않은 백필 후보.
    const origin = await addOrigin(h, BACKFILL_ORIGIN, "codex");
    const mentionsBefore = nodeState(h.db, origin).mention_count;
    const scheduler = startBackfillScheduler(h.extractor, h.store, { intervalMs: 60_000, batchSize: 5, retry: TEST_EXTRACTION_BACKFILL_RETRY });
    try {
      const summary = await scheduler.tickNow();
      expect(summary).toMatchObject({ candidatesFound: 1, processed: 1, storedNodes: 1, failures: 0 });
    } finally {
      await scheduler.stop();
    }

    // 원문과 같은 항목은 자식이 되지 않고 원문에 흡수되지도 않는다 — 자기 엣지·언급 증가 없음.
    expect(llmExtractContents(h.db)).toEqual([BACKFILL_CHILD]);
    const child = (h.db.query("SELECT id FROM knowledge_nodes WHERE content = ?").get(BACKFILL_CHILD) as { id: number }).id;
    expect(selfEdgeCount(h.db)).toBe(0);
    expect(edges(h.db, "merged_into")).toEqual([{ source_id: child, target_id: origin }]);
    expect(nodeState(h.db, origin).mention_count).toBe(mentionsBefore);
    expect(JSON.parse(nodeState(h.db, origin).metadata_json)).toMatchObject({ extracted: 1, extractedTo: [child] });

    // 충돌 검사가 원문으로 돌았다 — 원문이 다른 AI 의 주장과 contradicts 로 이어지고 disputed 가 된다.
    expect(edges(h.db, "contradicts")).toContainEqual({ source_id: origin, target_id: opposite });
    expect(readSharedMemory(JSON.parse(nodeState(h.db, origin).metadata_json)).status).toBe("disputed");
    expect(readSharedMemory(JSON.parse(nodeState(h.db, opposite).metadata_json)).status).toBe("active");
    // 원문에 붙은 충돌이 열린 충돌 읽기 경로에 그대로 보인다(설계 9절 위험 3).
    expect(listOpenConflicts(h.db, [origin]).get(origin)).toContain(opposite);
    // 자식은 자기 원문과 충돌 후보로 이어지지 않는다.
    expect(edges(h.db, "contradicts").some((edge) =>
      (edge.source_id === child && edge.target_id === origin) || (edge.source_id === origin && edge.target_id === child)))
      .toBe(false);
  }, 60_000);

  test("백필 자식은 자기 원문과 충돌 후보로 이어지지 않는다", async () => {
    const h = makeHarness();
    const origin = await addOrigin(h, MULTI_ORIGIN);
    const scheduler = startBackfillScheduler(h.extractor, h.store, { intervalMs: 60_000, batchSize: 5, retry: TEST_EXTRACTION_BACKFILL_RETRY });
    try {
      expect(await scheduler.tickNow()).toMatchObject({ processed: 1, storedNodes: 1, failures: 0 });
    } finally {
      await scheduler.stop();
    }
    const [childContent] = llmExtractContents(h.db);
    expect(childContent).toBe(MULTI_CHILD);
    expect(edges(h.db, "contradicts")).toEqual([]);
    expect(selfEdgeCount(h.db)).toBe(0);
    expect(readSharedMemory(JSON.parse(nodeState(h.db, origin).metadata_json)).status).toBe("active");
  }, 60_000);
});
