/**
 * backfill-extraction.test.ts — 백필 LLM 호출을 쓰기 잠금 밖으로 옮긴 흐름(WP-B1-07, SL-7·SL-8).
 *
 * LLM 은 테스트 안 로컬 HTTP 서버(Bun.serve)가 Ollama /api/chat 형식으로 지연 응답하고, 실제
 * OllamaClient 가 그 서버를 호출한다. 저장은 실제 SQLite + 실제 bge-m3 임베딩이다.
 *
 * 검증:
 *  1. LLM 이 3초 지연하는 동안 다른 비동기 흐름의 withMemoryMutationLock 작업이 기다리지 않고 끝난다.
 *  2. 준비 뒤 원문이 편집되면 LLM 결과를 저장하지 않고 이유를 로그에 남기며, 원문은 다음 주기 후보다.
 *  3. 준비 뒤 원문이 후보 조건을 벗어나면(다른 흐름이 추출 완료 표시) 결과를 버리고 이유를 남긴다.
 *  4. 추출 한 건에서 자식 N개가 생겨도 가시성 스냅샷 계산은 1회다(countMemoryVisibilityComputations).
 */

import { TEST_EXTRACTION_BACKFILL_RETRY } from "../test-utils/backfill-retry.ts";
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { OllamaClient } from "../llm/ollama-client.ts";
import { startBackfillScheduler } from "../scheduler.ts";
import {
  startDelayedOllamaChatServer,
  type DelayedOllamaChatServer,
} from "../test-utils/delayed-ollama-chat-server.ts";
import { BackfillAttemptsLedger } from "./backfill-attempts/ledger.ts";
import { MemoryExtractor, originExtractionLineage } from "./extractor.ts";
import { withMemoryMutationLock } from "./shared-memory-mutation-lock.ts";
import { countMemoryVisibilityComputations } from "./shared-memory-read.ts";

const LLM_DELAY_MS = 3_000;
/** 잠금이 비어 있으면 bumpMention 한 번은 LLM 지연보다 훨씬 짧다. */
const LOCK_WAIT_LIMIT_MS = 1_000;
const AUTHOR = "user-a";
const SOURCE_TEXT =
  "나는 매일 아침 커피를 마신다. 나는 주말마다 북한산에 오른다. 나는 저녁마다 추리소설을 읽는다.";
const CHILD_CONTENTS = [
  "나는 매일 아침 커피를 마신다",
  "나는 주말마다 북한산에 오른다",
  "나는 저녁마다 추리소설을 읽는다",
];
/** 중복 흡수(bump) 없이 자식이 모두 새 노드가 되게 하는 임계 — 생성자 옵션으로 넘긴다. */
const NO_DEDUP_SIM = 0.999;

function extractionResponse(contents: readonly string[]): string {
  return JSON.stringify(contents.map((content) => ({ content, memoryType: "fact", importance: 0.6 })));
}

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let db: Database;
let store: SqliteMemoryStore;
let server: DelayedOllamaChatServer | null = null;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
});
afterEach(() => {
  server?.stop();
  server = null;
  db.close();
});

function extractorFor(url: string): MemoryExtractor {
  return new MemoryExtractor(
    new OllamaClient({ baseUrl: url, model: "test-model" }),
    store,
    embedder,
    { duplicateSim: NO_DEDUP_SIM },
  );
}

async function addCandidate(): Promise<number> {
  return store.addNode({
    content: SOURCE_TEXT,
    sourceType: "auto_capture",
    importance: 0.5,
    author: AUTHOR,
  });
}

function extractChildIds(): number[] {
  return (db.query("SELECT id FROM knowledge_nodes WHERE source_type = 'llm_extract' ORDER BY id").all() as Array<{ id: number }>)
    .map((row) => row.id);
}

function warnings(spy: ReturnType<typeof spyOn>): string[] {
  return spy.mock.calls.map((call: unknown[]) => call.map(String).join(" "));
}

describe("백필 — LLM 호출 동안 쓰기 잠금이 비어 있다", () => {
  test("LLM 3초 지연 중 다른 흐름의 잠금 작업이 기다리지 않고 끝나고, 결과는 그 뒤 저장된다", async () => {
    server = startDelayedOllamaChatServer({ delayMs: LLM_DELAY_MS, content: extractionResponse(CHILD_CONTENTS.slice(0, 1)) });
    const candidate = await addCandidate();
    const other = await store.addNode({ content: "잠금 작업 대상 기억", sourceType: "user_explicit", author: AUTHOR });
    const handle = startBackfillScheduler(extractorFor(server.url), store, { intervalMs: 60_000, batchSize: 5, retry: TEST_EXTRACTION_BACKFILL_RETRY });

    const llmCalled = server.nextRequest();
    let cycleDone = false;
    const cycle = handle.tickNow().then((summary) => { cycleDone = true; return summary; });
    await llmCalled;
    const lockStart = performance.now();
    await withMemoryMutationLock(store, () => store.bumpMention(other));
    const lockWaitMs = performance.now() - lockStart;

    expect(cycleDone).toBe(false);
    expect(lockWaitMs).toBeLessThan(LOCK_WAIT_LIMIT_MS);

    const summary = await cycle;
    await handle.stop();
    expect(summary).toMatchObject({ candidatesFound: 1, processed: 1, storedNodes: 1, failures: 0 });
    const [child] = extractChildIds();
    expect((await store.getNode(child!))?.content).toBe(CHILD_CONTENTS[0]);
    expect((await store.getNode(candidate))?.metadata).toMatchObject({ extracted: 1, extractedTo: [child] });
    expect(db.query("SELECT COUNT(*) AS n FROM knowledge_edges WHERE source_id = ? AND target_id = ? AND relation = 'merged_into'")
      .get(child!, candidate)).toEqual({ n: 1 });
  }, 30_000);
});

describe("백필 — 잠금 안 재확인이 어긋나면 LLM 결과를 버린다", () => {
  test("준비 뒤 원문 본문이 편집되면 저장하지 않고 이유를 남기며, 원문은 다음 주기 후보다", async () => {
    server = startDelayedOllamaChatServer({ delayMs: LLM_DELAY_MS, content: extractionResponse(CHILD_CONTENTS) });
    const candidate = await addCandidate();
    const handle = startBackfillScheduler(extractorFor(server.url), store, { intervalMs: 60_000, batchSize: 5, retry: TEST_EXTRACTION_BACKFILL_RETRY });
    const warn = spyOn(console, "warn");
    try {
      const llmCalled = server.nextRequest();
      const cycle = handle.tickNow();
      await llmCalled;
      const edited = await withMemoryMutationLock(store, () => store.editNodeContent({
        nodeId: candidate,
        content: "나는 매일 아침 녹차를 마신다. 나는 주말마다 한강에서 자전거를 탄다.",
      }));
      expect(edited?.claimChanged).toBe(true);

      const summary = await cycle;
      await handle.stop();
      // WP-B1-08R (Minor 3) — a discarded prepared result is now counted on the summary (discarded: 1).
      expect(summary).toMatchObject({ candidatesFound: 1, processed: 0, storedNodes: 0, failures: 0, discarded: 1, rechunked: 0 });
      expect(extractChildIds()).toEqual([]);
      const logged = warnings(warn).filter((line) => line.includes(`backfill result discarded for node ${candidate}`));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("원문 본문이 바뀌었다");
    } finally {
      warn.mockRestore();
    }
    expect(store.nodeRepo.isBackfillCandidateEligible(candidate)).toBe(true);
    // 2026-10-14 spec 4.3 — 준비 중 후보가 바뀌어 버린 결과는 실패가 아니다. 기록하지 않는다.
    expect(new BackfillAttemptsLedger(db).rows("extraction")).toEqual([]);
    expect((await store.getBackfillCandidates({ limit: 5 })).map((node) => node.id)).toEqual([candidate]);
  }, 30_000);

  test("준비 뒤 다른 흐름이 추출 완료로 표시하면 후보 조건을 벗어나 결과를 버린다", async () => {
    server = startDelayedOllamaChatServer({ delayMs: LLM_DELAY_MS, content: extractionResponse(CHILD_CONTENTS) });
    const candidate = await addCandidate();
    const handle = startBackfillScheduler(extractorFor(server.url), store, { intervalMs: 60_000, batchSize: 5, retry: TEST_EXTRACTION_BACKFILL_RETRY });
    const warn = spyOn(console, "warn");
    try {
      const llmCalled = server.nextRequest();
      const cycle = handle.tickNow();
      await llmCalled;
      await withMemoryMutationLock(store, () => store.markNodeExtracted(candidate, []));

      const summary = await cycle;
      await handle.stop();
      // WP-B1-08R (Minor 3) — a discarded prepared result is now counted on the summary (discarded: 1).
      expect(summary).toMatchObject({ processed: 0, storedNodes: 0, failures: 0, discarded: 1, rechunked: 0 });
      expect(extractChildIds()).toEqual([]);
      const logged = warnings(warn).filter((line) => line.includes(`backfill result discarded for node ${candidate}`));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("백필 후보 조건을 벗어났다");
    } finally {
      warn.mockRestore();
    }
    expect((await store.getNode(candidate))?.metadata).toMatchObject({ extracted: 1, extractedTo: [] });
  }, 30_000);
});

describe("추출 한 건당 가시성 스냅샷 1회 (SL-8)", () => {
  /**
   * 추출 원문과 같은 작성자·종류이고 FTS 로 자식마다 걸리는, 계보 밖의 기억. 자식의 충돌 검사는 자기
   * 추출 원문을 후보에서 뺀다(WP-B1-20T T3 — 원문을 먼저 저장해도 자식이 자기 원문과 충돌로 이어지지
   * 않게). 그래서 자식마다 가시성 판정까지 가는 후보로 이 기억을 둔다. 백필 후보 종류가 아니라(user_explicit)
   * 백필 주기가 이 기억을 추출하지 않는다.
   */
  async function addOutsideLineageMemory(): Promise<number> {
    return store.addNode({
      content: "나는 매일 저녁 녹차를 마신다. 나는 주말마다 한강에 오른다. 나는 아침마다 신문을 읽는다.",
      sourceType: "user_explicit",
      importance: 0.5,
      author: AUTHOR,
    });
  }

  /**
   * 자식마다 충돌 검사가 가시성 판정까지 가는 조건 — 추출 원문(충돌 후보에서 빠진다) 말고도 같은 작성자·종류의
   * FTS 후보가 있다.
   */
  async function expectEveryChildReachesVisibilityFilter(
    childIds: readonly number[],
    originId: number,
  ): Promise<void> {
    for (const id of childIds) {
      const child = (await store.getNode(id))!;
      const hits = await store.getNodesByIds((await store.ftsSearch(child.content, 10)).map(([hitId]) => hitId));
      expect(hits.some((hit) => hit.id !== id && hit.id !== originId && hit.author === AUTHOR &&
        hit.memoryType === child.memoryType)).toBe(true);
    }
  }

  test("백필 한 사이클: 자식 3개를 저장해도 스냅샷 계산은 후보 조회 때 1회뿐이다", async () => {
    server = startDelayedOllamaChatServer({ delayMs: 0, content: extractionResponse(CHILD_CONTENTS) });
    const candidate = await addCandidate();
    await addOutsideLineageMemory();
    const handle = startBackfillScheduler(extractorFor(server.url), store, { intervalMs: 60_000, batchSize: 5, retry: TEST_EXTRACTION_BACKFILL_RETRY });

    const before = countMemoryVisibilityComputations(store);
    const summary = await handle.tickNow();
    await handle.stop();

    expect(summary).toMatchObject({ processed: 1, storedNodes: CHILD_CONTENTS.length, failures: 0 });
    expect(countMemoryVisibilityComputations(store) - before).toBe(1);
    await expectEveryChildReachesVisibilityFilter(extractChildIds(), candidate);
  }, 60_000);

  test("extractAndStore(스냅샷 미전달): 자식 3개의 충돌 검사가 스냅샷 1개를 함께 쓴다", async () => {
    server = startDelayedOllamaChatServer({ delayMs: 0, content: extractionResponse(CHILD_CONTENTS) });
    const candidate = await addCandidate();
    await addOutsideLineageMemory();
    const extractor = extractorFor(server.url);

    const before = countMemoryVisibilityComputations(store);
    // 자식은 후보 원문의 파생이다(WP-B1-20T 설계 5.9 — 계보 엣지는 저장소가 자식 저장과 함께 쓴다).
    const result = await extractor.extractAndStore(
      { text: SOURCE_TEXT, author: AUTHOR, skipHashtagWiring: true },
      { lineage: originExtractionLineage(candidate) },
    );

    expect(result.storedNodeIds).toHaveLength(CHILD_CONTENTS.length);
    expect(countMemoryVisibilityComputations(store) - before).toBe(1);
    await expectEveryChildReachesVisibilityFilter(result.storedNodeIds, candidate);
  }, 60_000);
});
