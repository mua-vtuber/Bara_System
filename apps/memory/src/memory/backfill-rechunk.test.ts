/**
 * backfill-rechunk.test.ts — 청크가 필요한 긴 원문은 백필이 통째로 추출하지 않고 재청크한다(WP-B1-31).
 *
 * 실제 파일 SQLite(WAL) + 실제 bge-m3 + 실제 MemoryExtractor·OllamaClient 가 테스트 안 Bun.serve
 * (Ollama /api/chat 형식, test-utils/delayed-ollama-chat-server.ts)를 부른다. 백필은 실제
 * startBackfillScheduler 사이클이다.
 *
 * 재청크 실패 재현: 같은 DB 파일에 연 두 번째 연결이 BEGIN IMMEDIATE 로 쓰기 잠금을 쥔다(운영에서
 * sqlite3 CLI·백업 도구가 쓰기 잠금을 오래 쥔 경우). 서버 연결은 busy_timeout(DB_BUSY_TIMEOUT_MS)
 * 만큼 기다린 뒤 SQLITE_BUSY("database is locked")로 실패한다 — 코드가 이미 거부하는 실제 실패다.
 *
 *  1. 편집 뒤 재청크가 실패해 청크 없이 추출 대기로 남은 긴 원문: 백필은 LLM 을 부르지 않고 재청크하며,
 *     원문을 추출 완료로 표시하지 않는다. 다음 주기에 새 청크를 청크 단위로 추출한다.
 *  2. 백필의 재청크도 실패하면 이유(노드·원인)를 로그에 남기고 원문은 추출 대기 그대로다. 실패 기록(2026-10-14 spec 4.3)에
 *     세는 실패로 남아 재시도 시각까지 후보에서 빠지고, 그 뒤 다시 시도한다. 쓰기 잠금 때문에 기록 표 쓰기까지 실패하면
 *     주기를 "ledger_write_failed" 로 멈추고 기록은 남지 않는다.
 *  3. WP-B1-06 이전 편집으로 청크가 모두 계보 무효화된 긴 원문(대기 표시 없음)은 백필 한 주기 뒤 새 청크를 갖는다.
 *  4. 청크가 모두 계보 무효화된 짧은 원문은 한 번 직접 추출되고, 그 뒤에는 다시 후보가 되지 않는다.
 */

import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { cleanupTempDir, makeWalTempDir } from "../db/wal-test-helpers.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { OllamaClient } from "../llm/ollama-client.ts";
import { startBackfillScheduler, type BackfillCycleSummary } from "../scheduler.ts";
import { TEST_EXTRACTION_BACKFILL_RETRY } from "../test-utils/backfill-retry.ts";
import { BackfillAttemptsLedger } from "./backfill-attempts/ledger.ts";
import { rewireEditedNodeContent } from "../server-internal/routes/memories-shared.ts";
import { saveTextInput, type SaveTextChunkingSettings } from "../server-internal/save-input.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-schema.ts";
import type { MemorySettings } from "../settings/memory-settings.ts";
import {
  startDelayedOllamaChatServer,
  type DelayedOllamaChatServer,
} from "../test-utils/delayed-ollama-chat-server.ts";
import { ContextAssembler } from "./context-assembler.ts";
import { MemoryExtractor } from "./extractor.ts";
import { HybridRetriever } from "./retriever.ts";
import { withMemoryMutationLock } from "./shared-memory-mutation-lock.ts";
import { invalidateSharedMemoryDerivatives } from "./shared-memory-invalidation.ts";

const AUTHOR = "owner";
// 문단 하나는 청크 한도(60) 아래, 글 전체는 한도 위 — 문단마다 청크 하나.
const CHUNKING: SaveTextChunkingSettings = { tokenCap: 60, minChunkTokens: 1 };
const LONG_PARAGRAPHS = [
  "배포 결정문의 첫 문단은 금요일 오후 창구를 쓰기로 한 이유를 적는다.",
  "둘째 문단은 롤백 담당과 알림 경로를 운영팀 채널로 고정한다.",
  "셋째 문단은 점검 목록을 배포 전날 저녁에 한 번 더 확인한다고 정한다.",
];
// 문단마다 두 문장 — 짧은 단일 의미 건너뛰기(shouldSkipExtraction)에 걸리지 않아 청크마다 LLM 을 부른다.
const EDITED_LONG_PARAGRAPHS = [
  "개정 결정문은 화요일 오전 창구를 쓴다. 금요일 배포는 멈춘다.",
  "롤백 담당은 플랫폼팀이 맡는다. 알림은 메일로 보낸다.",
  "점검 목록은 배포 당일 아침에 본다. 결과는 채널에 남긴다.",
];
const EXTRACTED_FACT = "배포 창구는 화요일 오전이다";
const CLOCK_START_MS = Date.UTC(2026, 9, 14, 0, 0, 0);
const MINUTE_MS = 60_000;
/** 첫 재시도 대기(기본 30분)를 넘기는 간격. */
const PAST_FIRST_DELAY_MS = (TEST_EXTRACTION_BACKFILL_RETRY.policy.retryDelayMin + 1) * MINUTE_MS;

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

interface Harness {
  dir: string;
  file: string;
  db: Database;
  store: SqliteMemoryStore;
  server: DelayedOllamaChatServer;
  extractor: MemoryExtractor;
}

const harnesses: Harness[] = [];
const lockHolders: Database[] = [];
afterEach(() => {
  for (const holder of lockHolders.splice(0)) {
    if (holder.inTransaction) holder.run("ROLLBACK");
    holder.close();
  }
  for (const h of harnesses.splice(0)) {
    h.server.stop();
    h.db.close();
    cleanupTempDir(h.dir);
  }
});

function makeHarness(): Harness {
  clockMs = CLOCK_START_MS;
  const { dir, file } = makeWalTempDir("bara-backfill-rechunk-");
  const db = openMemoryDatabase(file, { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const server = startDelayedOllamaChatServer({
    delayMs: 0,
    content: JSON.stringify([{ content: EXTRACTED_FACT, memoryType: "fact", importance: 0.8 }]),
  });
  const extractor = new MemoryExtractor(
    new OllamaClient({ baseUrl: server.url, model: "test-model" }),
    store, embedder, { duplicateSim: 0.999, minImportance: 0 },
  );
  const h = { dir, file, db, store, server, extractor };
  harnesses.push(h);
  return h;
}

/** 같은 DB 파일에 두 번째 연결을 열어 쓰기 잠금을 쥔다. release 전까지 서버 연결의 쓰기는 SQLITE_BUSY 로 끝난다. */
function holdWriteLock(h: Harness): { release: () => void } {
  const holder = new Database(h.file);
  lockHolders.push(holder);
  holder.run("BEGIN IMMEDIATE");
  return { release: () => holder.run("ROLLBACK") };
}

async function saveLong(h: Harness): Promise<{ origin: number; chunks: number[] }> {
  const saved = await saveTextInput(h.store, {
    content: LONG_PARAGRAPHS.join("\n\n"), source: "test", author: AUTHOR, force: true, chunking: CHUNKING,
  });
  expect(saved.chunkNodeIds).toHaveLength(LONG_PARAGRAPHS.length);
  return { origin: saved.originNodeId!, chunks: saved.chunkNodeIds };
}

/** 본문 주장을 바꾸는 편집 — 옛 청크는 철회되고 원문은 추출 대기(extracted = 0)가 된다. */
async function editLongClaim(h: Harness, origin: number): Promise<string> {
  const content = EDITED_LONG_PARAGRAPHS.join("\n\n");
  const edited = await withMemoryMutationLock(h.store, () => h.store.editNodeContent({ nodeId: origin, content }));
  expect(edited?.claimChanged).toBe(true);
  return content;
}

/** 시험의 시계 — 고정 시작 시각에서 시험이 직접 움직인다(실제 시각에 기대지 않는다). */
let clockMs = CLOCK_START_MS;

async function runBackfill(h: Harness): Promise<BackfillCycleSummary> {
  const handle = startBackfillScheduler(h.extractor, h.store, {
    intervalMs: 60_000, batchSize: 10, chunking: CHUNKING, retry: TEST_EXTRACTION_BACKFILL_RETRY, now: () => clockMs,
  });
  try {
    return await handle.tickNow();
  } finally {
    await handle.stop();
  }
}

function activeChunkIds(h: Harness, origin: number): number[] {
  return (h.db.query(`SELECT e.source_id AS id FROM knowledge_edges e JOIN knowledge_nodes c ON c.id = e.source_id
    WHERE e.target_id = ? AND e.relation = 'parent_of'
      AND COALESCE(c.metadata_json ->> '$.sharedMemory.status', 'active') = 'active' ORDER BY e.source_id`)
    .all(origin) as Array<{ id: number }>).map((row) => row.id);
}

function extractChildCount(h: Harness): number {
  return (h.db.query("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE source_type = 'llm_extract'").get() as { n: number }).n;
}

async function candidateIds(h: Harness): Promise<number[]> {
  return (await h.store.getBackfillCandidates({ limit: 50 })).map((node) => node.id);
}

function logLines(spy: ReturnType<typeof spyOn>): string[] {
  return spy.mock.calls.map((call: unknown[]) => call.map(String).join(" "));
}

/** 재청크가 만든 청크가 새 본문 문단이고, 원문은 추출 기록 없이 청크를 가진 긴 글로 돌아왔다. */
async function expectRechunked(h: Harness, origin: number): Promise<number[]> {
  const chunks = activeChunkIds(h, origin);
  expect((await h.store.getNodesByIds(chunks)).map((node) => node.content).sort())
    .toEqual([...EDITED_LONG_PARAGRAPHS].sort());
  expect((await h.store.getNode(origin))!.metadata).not.toHaveProperty("extracted");
  expect(h.store.nodeRepo.isBackfillCandidateEligible(origin)).toBe(false);
  expect(await candidateIds(h)).toEqual(chunks);
  return chunks;
}

describe("재청크 실패로 청크 없이 추출 대기인 긴 원문", () => {
  test("편집 뒤 재청크가 SQLITE_BUSY 로 실패해도, 백필은 원문 전체를 LLM 에 보내지 않고 재청크한다", async () => {
    const h = makeHarness();
    const { origin } = await saveLong(h);
    const content = await editLongClaim(h, origin);

    // 편집은 커밋됐고, 그 뒤 재청크 차례에 다른 연결이 쓰기 잠금을 쥐고 있다.
    const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
    settings.chunking.tokenCap = CHUNKING.tokenCap!;
    settings.chunking.minChunkTokens = CHUNKING.minChunkTokens!;
    const deps = {
      store: h.store,
      retriever: new HybridRetriever(h.store, embedder),
      assembler: new ContextAssembler(),
      getSettings: () => settings,
    };
    const lock = holdWriteLock(h);
    const warn = spyOn(console, "warn");
    let warnings: string[];
    try {
      warnings = await withMemoryMutationLock(h.store, () => rewireEditedNodeContent(h.store, deps, origin, content));
    } finally {
      lock.release();
      warn.mockRestore();
    }
    expect(warnings.filter((line) => line.startsWith("rechunk failed:"))).toHaveLength(1);
    expect(warnings.find((line) => line.startsWith("rechunk failed:"))).toContain("locked");
    expect((await h.store.getNode(origin))!.metadata.extracted).toBe(0);
    expect(activeChunkIds(h, origin)).toEqual([]);
    expect(await candidateIds(h)).toEqual([origin]);

    const rechunkCycle = await runBackfill(h);
    expect(h.server.requestCount()).toBe(0);
    // WP-B1-08R (Minor 3) — a re-chunked candidate is now counted on the summary (rechunked: 1),
    // not just in the log line.
    expect(rechunkCycle).toMatchObject({ candidatesFound: 1, processed: 0, storedNodes: 0, failures: 0, rechunked: 1, discarded: 0 });
    expect(extractChildCount(h)).toBe(0);
    const chunks = await expectRechunked(h, origin);

    // 다음 주기는 새 청크를 청크 단위로 추출한다. 원문은 여전히 추출 기록이 없다.
    const extractCycle = await runBackfill(h);
    expect(h.server.requestCount()).toBe(chunks.length);
    expect(extractCycle).toMatchObject({ candidatesFound: chunks.length, processed: chunks.length, failures: 0 });
    for (const chunk of await h.store.getNodesByIds(chunks)) expect(chunk.metadata.extracted).toBe(1);
    expect((await h.store.getNode(origin))!.metadata).not.toHaveProperty("extracted");
    expect(await candidateIds(h)).toEqual([]);
  }, 60_000);

  test("백필의 재청크가 쓰기 잠금 때문에 실패하면 기록 표 쓰기도 실패해 주기를 ledger_write_failed 로 멈추고, 기록은 남지 않는다", async () => {
    const h = makeHarness();
    const { origin } = await saveLong(h);
    await editLongClaim(h, origin);
    expect(activeChunkIds(h, origin)).toEqual([]);

    const lock = holdWriteLock(h);
    const errors = spyOn(console, "error");
    let failedCycle: BackfillCycleSummary;
    let logged: string[];
    try {
      failedCycle = await runBackfill(h);
      logged = logLines(errors);
    } finally {
      lock.release();
      errors.mockRestore();
    }
    expect(failedCycle).toMatchObject({
      candidatesFound: 1, processed: 0, storedNodes: 0, failures: 1,
      retry: { retryWait: 0, stopped: 0, cycleStopped: "ledger_write_failed" },
    });
    const failedLines = logged.filter((line) => line.includes(`backfill failed for node ${origin}`));
    expect(failedLines).toHaveLength(1);
    expect(failedLines[0]).toContain("재청크");
    expect(failedLines[0]).toContain("locked");
    expect(logged.some((line) => line.includes("cycle stopped (ledger_write_failed)"))).toBe(true);
    expect(new BackfillAttemptsLedger(h.db).rows("extraction")).toEqual([]);
    expect(h.server.requestCount()).toBe(0);
    expect(extractChildCount(h)).toBe(0);
    expect(activeChunkIds(h, origin)).toEqual([]);
    expect((await h.store.getNode(origin))!.metadata.extracted).toBe(0);
    expect(await candidateIds(h)).toEqual([origin]);

    // 잠금이 풀리면 기록이 없는 원문은 곧바로 다시 후보가 되어 재청크된다.
    await runBackfill(h);
    expect(h.server.requestCount()).toBe(0);
    await expectRechunked(h, origin);
  }, 60_000);

  test("재청크가 잠금 밖 원인으로 실패하면 세는 실패로 기록해 재시도 시각까지 후보에서 빼고, 시각이 지나면 다시 시도해 줄을 지운다", async () => {
    const h = makeHarness();
    const { origin } = await saveLong(h);
    await editLongClaim(h, origin);
    expect(activeChunkIds(h, origin)).toEqual([]);

    // 청크 노드 저장만 막는 실제 DB 트리거 — 재청크 트랜잭션이 이 원인으로 실패한다(쓰기 잠금과 무관).
    h.db.run(`CREATE TRIGGER block_chunk_insert BEFORE INSERT ON knowledge_nodes
      WHEN NEW.source_type = 'document_chunk'
      BEGIN SELECT RAISE(ABORT, 'chunk insert blocked by test'); END`);
    const ledger = new BackfillAttemptsLedger(h.db);
    const errors = spyOn(console, "error");
    let failedCycle: BackfillCycleSummary;
    try {
      failedCycle = await runBackfill(h);
    } finally {
      errors.mockRestore();
    }
    expect(failedCycle).toMatchObject({
      candidatesFound: 1, failures: 1, retry: { retryWait: 1, stopped: 0, cycleStopped: null },
    });
    expect(ledger.get("extraction", String(origin))).toMatchObject({ status: "retryable_failure", attemptCount: 1 });
    expect(ledger.get("extraction", String(origin))!.lastError).toContain("재청크");
    expect(ledger.get("extraction", String(origin))!.lastError).toContain("blocked");
    expect(h.server.requestCount()).toBe(0);

    // 재시도 시각 전에는 후보에서 빠진다.
    expect((await runBackfill(h)).candidatesFound).toBe(0);

    // 시각이 지나면 다시 후보가 되고, 원인을 치웠으니 재청크되어 줄이 지워진다.
    clockMs += PAST_FIRST_DELAY_MS;
    h.db.run("DROP TRIGGER block_chunk_insert");
    expect(await runBackfill(h)).toMatchObject({ candidatesFound: 1, failures: 0, rechunked: 1 });
    expect(h.server.requestCount()).toBe(0);
    await expectRechunked(h, origin);
    expect(ledger.get("extraction", String(origin))).toBeNull();
  }, 60_000);
});

describe("WP-B1-06 이전 편집으로 청크가 모두 계보 무효화된 원문", () => {
  /** 옛 편집 경로가 남긴 모양: 파생물(청크)만 계보 무효화하고 원문에는 추출 대기 표시를 남기지 않았다. */
  async function invalidateLikeLegacyEdit(h: Harness, origin: number): Promise<void> {
    const node = (await h.store.getNode(origin))!;
    h.db.transaction(() => invalidateSharedMemoryDerivatives(h.db, node))();
    expect(h.store.nodeRepo.getOriginChunkState(origin))
      .toEqual({ pending: false, activeChunk: false, invalidatedChunk: true });
  }

  test("긴 원문은 백필 한 주기 뒤 LLM 호출 없이 새 청크를 갖는다", async () => {
    const h = makeHarness();
    const { origin, chunks: oldChunks } = await saveLong(h);
    // 옛 편집이 본문을 바꾸고 청크를 거뒀다 — 본문 변경은 행을 직접 고쳐 옛 경로의 결과만 남긴다.
    h.db.query("UPDATE knowledge_nodes SET content = ? WHERE id = ?").run(EDITED_LONG_PARAGRAPHS.join("\n\n"), origin);
    await invalidateLikeLegacyEdit(h, origin);
    expect(await candidateIds(h)).toEqual([origin]);

    const summary = await runBackfill(h);
    expect(h.server.requestCount()).toBe(0);
    expect(summary).toMatchObject({ candidatesFound: 1, processed: 0, failures: 0 });
    const chunks = await expectRechunked(h, origin);
    expect(chunks.some((id) => oldChunks.includes(id))).toBe(false);
  }, 60_000);

  test("짧은 원문은 한 번 직접 추출되고, 그 뒤에는 다시 후보가 되지 않는다", async () => {
    const h = makeHarness();
    const origin = await h.store.addNode({
      content: "배포 결정은 다음 회의로 미룬다. 롤백 담당은 운영팀이 맡는다.", sourceType: "auto_capture", author: AUTHOR,
    });
    const chunk = await h.store.addNode({
      content: "배포 결정문의 옛 문단이다.", sourceType: "document_chunk", author: AUTHOR,
      metadata: { parentNodeId: origin, chunkIndex: 0 },
    });
    await h.store.addEdge({ sourceId: chunk, targetId: origin, relation: "parent_of", provenance: "system", sourceNodeId: chunk, weight: 1 });
    await invalidateLikeLegacyEdit(h, origin);
    expect(await candidateIds(h)).toEqual([origin]);

    const first = await runBackfill(h);
    expect(first).toMatchObject({ candidatesFound: 1, processed: 1, storedNodes: 1, failures: 0 });
    expect(h.server.requestCount()).toBe(1);
    expect((await h.store.getNode(origin))!.metadata.extracted).toBe(1);
    expect(activeChunkIds(h, origin)).toEqual([]);

    const second = await runBackfill(h);
    expect(second.candidatesFound).toBe(0);
    expect(h.server.requestCount()).toBe(1);
  }, 60_000);
});
