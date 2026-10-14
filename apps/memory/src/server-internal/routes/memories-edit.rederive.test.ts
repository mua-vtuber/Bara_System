/**
 * memories-edit.rederive.test.ts — 편집 뒤 파생물 재생성 (WP-B1-06: SL-2 · PS-1 · SL-12).
 *
 * 실제 SQLite + 실제 bge-m3 + buildMemoryApi REST 라우트로 끝까지 본다. 추출은 실제
 * MemoryExtractor 가 실제 OllamaClient 로, 이 파일이 띄운 루프백 HTTP 서버(Ollama
 * /api/chat 응답 형식)를 부른다. 백필은 실제 startBackfillScheduler 사이클이다.
 *
 *  - 태그만 바꾼 편집(태그 추가 라우트, Discord by-source 태그 변경)은 추출 자식과 원문 표시를 유지한다.
 *  - 본문 주장을 바꾼 편집은 자식을 철회하고 원문을 추출 대기로 돌린다. 다음 백필은 새 본문을
 *    추출하고, 바뀌지 않은 문장의 사실도 철회된 옛 자식에 흡수되지 않고 새 기억이 된다.
 *  - 이 수정 이전의 편집으로 자식이 모두 철회된 원문은 저장 행을 고치지 않은 채 다시 후보가 된다.
 *  - 긴 글을 고치면 옛 청크는 철회되고 새 본문 청크가 후보가 된다. 짧게 고치면 원문이 직접 후보다.
 *  - 분류만 바꾸는 PATCH 는 임베딩을 다시 계산하지 않고 'node-edited' 신호도 보내지 않는다.
 */

import { TEST_EXTRACTION_BACKFILL_RETRY } from "../../test-utils/backfill-retry.ts";
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";

import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { MemoryExtractor } from "../../memory/extractor.ts";
import { OllamaClient } from "../../llm/ollama-client.ts";
import { readMemoryVisibility } from "../../memory/shared-memory-read.ts";
import { readSharedMemory } from "../../memory/shared-memory-contract.ts";
import { startAutoCleanupTrigger } from "../../memory/auto-cleanup-trigger.ts";
import { startBackfillScheduler, type BackfillCycleSummary } from "../../scheduler.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-schema.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import { buildMemoryApi } from "../../server.ts";
import { saveTextInput, type SaveTextChunkingSettings } from "../save-input.ts";

const EXTRACTION_MODEL = "extraction-fixture";
const AUTHOR = "owner";
const JSON_HEADERS = { "Content-Type": "application/json" };

const TWO_SENTENCES = "배포 창구는 금요일 오후로 정했다. 롤백 담당은 운영팀이 맡는다.";
const EDITED_TWO_SENTENCES = "배포 창구는 화요일 오전으로 옮겼다. 롤백 담당은 운영팀이 맡는다.";
/** 편집 전후 모두 본문에 있는 문장에서 뽑힌 사실. */
const KEPT_FACT = "롤백 담당은 운영팀이 맡는다";
const NEW_FACT = "배포 창구는 화요일 오전이다";

// 문단 하나는 청크 한도(60) 아래, 글 전체는 한도 위 — 문단마다 청크 하나.
const PARAGRAPH_CHUNKING: SaveTextChunkingSettings = { tokenCap: 60, minChunkTokens: 1 };
const LONG_PARAGRAPHS = [
  "배포 결정문의 첫 문단은 금요일 오후 창구를 쓰기로 한 이유를 적는다.",
  "둘째 문단은 롤백 담당과 알림 경로를 운영팀 채널로 고정한다.",
  "셋째 문단은 점검 목록을 배포 전날 저녁에 한 번 더 확인한다고 정한다.",
];
const EDITED_LONG_PARAGRAPHS = [
  "개정 결정문의 첫 문단은 화요일 오전 창구로 옮긴 이유를 적는다.",
  "둘째 문단은 롤백 담당을 플랫폼팀으로 바꾸고 알림을 메일로 보낸다.",
  "셋째 문단은 점검 목록을 배포 당일 아침에 다시 확인한다고 정한다.",
];
const SHORTENED = "배포 결정은 다음 회의로 미룬다.";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

interface LoopbackLlm {
  server: ReturnType<typeof Bun.serve>;
  /** 다음 /api/chat 응답이 돌려줄 추출 항목. */
  items: unknown[];
  /** 요청마다 마지막 user 메시지(추출 대상 본문이 든다). */
  prompts: string[];
}

/** 실제 OllamaClient 가 부르는 루프백 서버 — Ollama /api/chat 응답 형식으로 items 를 돌려준다. */
function startLoopbackLlm(): LoopbackLlm {
  const llm: Omit<LoopbackLlm, "server"> = { items: [], prompts: [] };
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/api/chat") {
        return new Response("not found", { status: 404 });
      }
      const body = await request.json() as { messages?: Array<{ role: string; content: string }> };
      llm.prompts.push(body.messages?.filter((m) => m.role === "user").at(-1)?.content ?? "");
      return Response.json({
        model: EXTRACTION_MODEL,
        message: { role: "assistant", content: JSON.stringify(llm.items) },
        done: true,
      });
    },
  });
  return Object.assign(llm, { server });
}

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
  llm: LoopbackLlm;
  extractor: MemoryExtractor;
  settings: MemorySettings;
}

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) {
    h.llm.server.stop(true);
    h.db.close();
  }
});

/** chunking 을 주면 편집 뒤 재청크가 그 한도로 긴 글을 판정한다(없으면 기본 한도). */
function makeHarness(chunking?: SaveTextChunkingSettings): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  settings.llm.extractor.enabled = true;
  settings.llm.extractor.mode = "immediate";
  if (chunking?.tokenCap !== undefined) settings.chunking.tokenCap = chunking.tokenCap;
  if (chunking?.minChunkTokens !== undefined) settings.chunking.minChunkTokens = chunking.minChunkTokens;
  const llm = startLoopbackLlm();
  // 중복 흡수는 같은 문장(유사도 1)만 — 백필에서 문장 사실이 자기 원문(두 문장 전체)에
  // 흡수되지 않게 해, 흡수 여부를 철회된 옛 자식 하나로만 가른다.
  const extractor = new MemoryExtractor(
    new OllamaClient({ baseUrl: `http://127.0.0.1:${llm.server.port}`, model: EXTRACTION_MODEL }),
    store, embedder, { duplicateSim: 0.999, minImportance: 0 },
  );
  const app = buildMemoryApi({
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(),
    getSettings: () => settings,
  });
  const h = { app, db, store, llm, extractor, settings };
  harnesses.push(h);
  return h;
}

function extractionItem(content: string) {
  return { content, memoryType: "episode", importance: 0.8 };
}

/** 즉시 추출로 저장한 원문과 그 추출 자식(운영의 짧은 글 저장과 같은 모양). */
async function saveExtracted(h: Harness, content: string, extraMetadata?: Record<string, unknown>) {
  h.llm.items = [extractionItem(KEPT_FACT)];
  const saved = await saveTextInput(h.store, {
    content, source: "discord", author: AUTHOR, force: true, extraMetadata,
    extractor: h.extractor, extractorSettings: h.settings.llm.extractor,
  });
  expect(saved.immediateExtractionRan).toBe(true);
  expect(saved.extracted).toHaveLength(1);
  return { origin: saved.originNodeId!, child: saved.extracted[0]! };
}

async function saveLong(h: Harness) {
  const saved = await saveTextInput(h.store, {
    content: LONG_PARAGRAPHS.join("\n\n"), source: "test", author: AUTHOR, force: true, chunking: PARAGRAPH_CHUNKING,
  });
  expect(saved.chunkNodeIds).toHaveLength(LONG_PARAGRAPHS.length);
  return { origin: saved.originNodeId!, chunks: saved.chunkNodeIds };
}

async function patchJson(h: Harness, path: string, body: unknown, method = "PATCH") {
  const res = await h.app.request(path, { method, headers: JSON_HEADERS, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function candidateIds(h: Harness): Promise<number[]> {
  return (await h.store.getBackfillCandidates({ limit: 50 })).map((node) => node.id);
}

function activeChunkIds(h: Harness, origin: number): number[] {
  return (h.db.query(`SELECT e.source_id AS id FROM knowledge_edges e JOIN knowledge_nodes c ON c.id = e.source_id
    WHERE e.target_id = ? AND e.relation = 'parent_of'
      AND COALESCE(c.metadata_json ->> '$.sharedMemory.status', 'active') = 'active' ORDER BY e.source_id`)
    .all(origin) as Array<{ id: number }>).map((row) => row.id);
}

function totalChanges(db: Database): number {
  return (db.query("SELECT total_changes() AS n").get() as { n: number }).n;
}

async function runBackfill(h: Harness): Promise<BackfillCycleSummary> {
  const handle = startBackfillScheduler(h.extractor, h.store, { intervalMs: 60_000, batchSize: 10, retry: TEST_EXTRACTION_BACKFILL_RETRY });
  try {
    return await handle.tickNow();
  } finally {
    await handle.stop();
  }
}

async function expectVisible(h: Harness, ids: number[], visible: boolean): Promise<void> {
  const allowed = readMemoryVisibility(h.store).allowedIds;
  for (const id of ids) expect(allowed === undefined || allowed.has(id)).toBe(visible);
}

describe("태그만 바꾼 편집", () => {
  test("태그 추가·Discord 태그 변경은 추출 자식과 원문 추출 표시를 유지한다", async () => {
    const h = makeHarness();
    const { origin, child } = await saveExtracted(h, TWO_SENTENCES, { messageId: "msg-tags-1", source: "discord-channel" });

    const tagged = await patchJson(h, `/memories/${origin}/tags`, { tag: "배포" }, "POST");
    expect(tagged.status).toBe(200);
    expect(tagged.body.changed).toBe(true);
    const synced = await patchJson(h, "/memories/by-source", {
      messageId: "msg-tags-1", platform: "discord", content: `${TWO_SENTENCES} #배포 #운영`, source: "discord",
    });
    expect(synced.status).toBe(200);
    expect(synced.body.editedIds).toEqual([origin]);
    expect(synced.body.warnings).toEqual([]);

    const originNode = (await h.store.getNode(origin))!;
    expect(originNode.content).toContain("#운영");
    expect(originNode.metadata).toMatchObject({ extracted: 1, extractedTo: [child] });
    const childState = readSharedMemory((await h.store.getNode(child))!.metadata);
    expect(childState.status).toBe("active");
    expect(childState.invalidatedBy).toBeUndefined();
    await expectVisible(h, [origin, child], true);
    expect(await candidateIds(h)).not.toContain(origin);
    expect(h.store.nodeRepo.isBackfillCandidateEligible(origin)).toBe(false);
  });
});

describe("본문 주장을 바꾼 편집", () => {
  test("자식을 철회하고 원문을 추출 대기로 돌린 뒤, 다음 백필이 새 본문에서 다시 추출한다", async () => {
    const h = makeHarness();
    const { origin, child } = await saveExtracted(h, TWO_SENTENCES);
    const childMentions = (await h.store.getNode(child))!.mentionCount;

    const edited = await patchJson(h, `/memories/${origin}`, { content: EDITED_TWO_SENTENCES });
    expect(edited.status).toBe(200);
    expect((await h.store.getNode(child))!.metadata.sharedMemory)
      .toMatchObject({ status: "retracted", invalidatedBy: origin });
    const pending = (await h.store.getNode(origin))!;
    expect(pending.metadata.extracted).toBe(0);
    expect(pending.metadata).not.toHaveProperty("extractedTo");
    expect(await candidateIds(h)).toEqual([origin]);
    expect(h.store.nodeRepo.isBackfillCandidateEligible(origin)).toBe(true);

    h.llm.items = [extractionItem(KEPT_FACT), extractionItem(NEW_FACT)];
    const summary = await runBackfill(h);
    expect(summary).toMatchObject({ candidatesFound: 1, processed: 1, storedNodes: 2, bumpedNodes: 0, failures: 0 });
    expect(h.llm.prompts.at(-1)).toContain("화요일 오전으로 옮겼다");

    const extracted = (await h.store.getNode(origin))!;
    expect(extracted.metadata.extracted).toBe(1);
    const newChildren = extracted.metadata.extractedTo as number[];
    expect(newChildren).toHaveLength(2);
    expect(newChildren).not.toContain(child);
    const children = await h.store.getNodesByIds(newChildren);
    expect(children.map((node) => node.content).sort()).toEqual([KEPT_FACT, NEW_FACT].sort());
    for (const node of children) {
      expect(node.metadata).not.toHaveProperty("extracted");
      expect(node.metadata).not.toHaveProperty("extractedTo");
    }
    await expectVisible(h, [origin, ...newChildren], true);
    // 바뀌지 않은 문장의 사실은 철회된 옛 자식에 mention 으로 흡수되지 않았다.
    await expectVisible(h, [child], false);
    expect((await h.store.getNode(child))!.mentionCount).toBe(childMentions);
    expect(await candidateIds(h)).toEqual([]);
  }, 120_000);

  test("이 수정 이전 편집으로 자식이 모두 철회된 원문은 저장 행을 고치지 않고 다시 후보가 된다", async () => {
    const h = makeHarness();
    const { origin, child } = await saveExtracted(h, TWO_SENTENCES);
    // 옛 편집 경로가 남긴 모양: 태그만 바꾼 편집도 자식을 철회했고 원문 표시는 그대로 뒀다.
    h.db.query("UPDATE knowledge_nodes SET metadata_json = json_set(metadata_json, '$.sharedMemory', json(?)) WHERE id = ?")
      .run(JSON.stringify({ status: "retracted", revision: 1, assertionKind: "unknown", invalidatedBy: origin }), child);
    const storedBefore = h.db.query("SELECT metadata_json FROM knowledge_nodes WHERE id = ?").get(origin);

    const changesBefore = totalChanges(h.db);
    expect(await candidateIds(h)).toEqual([origin]);
    expect(await candidateIds(h)).toEqual([origin]);
    expect(totalChanges(h.db)).toBe(changesBefore);
    expect(h.db.query("SELECT metadata_json FROM knowledge_nodes WHERE id = ?").get(origin)).toEqual(storedBefore);

    h.llm.items = [extractionItem(KEPT_FACT)];
    expect(await runBackfill(h)).toMatchObject({ processed: 1, storedNodes: 1, failures: 0 });
    const repaired = (await h.store.getNode(origin))!;
    expect(repaired.metadata.extracted).toBe(1);
    const [restored] = repaired.metadata.extractedTo as number[];
    expect(restored).toBeDefined();
    expect(restored).not.toBe(child);
    await expectVisible(h, [restored!], true);
    expect((await h.store.getNode(child))!.metadata.sharedMemory).toMatchObject({ status: "retracted" });
    expect(await candidateIds(h)).toEqual([]);
  }, 120_000);
});

describe("긴 글 편집의 재청크", () => {
  test("긴 글을 고치면 옛 청크는 철회되고 새 본문 청크가 추출 후보가 된다", async () => {
    const h = makeHarness(PARAGRAPH_CHUNKING);
    const { origin, chunks } = await saveLong(h);
    expect(await candidateIds(h)).toEqual(chunks);

    const edited = await patchJson(h, `/memories/${origin}`, { content: EDITED_LONG_PARAGRAPHS.join("\n\n") });
    expect(edited.status).toBe(200);
    expect(edited.body.warnings).toEqual([]);
    for (const id of chunks) {
      expect((await h.store.getNode(id))!.metadata.sharedMemory).toMatchObject({ status: "retracted", invalidatedBy: origin });
    }
    const rechunked = activeChunkIds(h, origin);
    expect(rechunked).toHaveLength(EDITED_LONG_PARAGRAPHS.length);
    const newChunks = await h.store.getNodesByIds(rechunked);
    expect(newChunks.map((node) => node.content).sort()).toEqual([...EDITED_LONG_PARAGRAPHS].sort());
    for (const node of newChunks) {
      expect(node.sourceType).toBe("document_chunk");
      expect(node.metadata).toMatchObject({ parentNodeId: origin, sharedMemory: { status: "active", revision: 0 } });
      expect(node.metadata.sharedMemory).not.toHaveProperty("evidenceRefs");
    }
    expect((await h.store.getNode(origin))!.metadata).not.toHaveProperty("extracted");
    expect(await candidateIds(h)).toEqual(rechunked);
    await expectVisible(h, rechunked, true);
    await expectVisible(h, chunks, false);
  }, 120_000);

  test("긴 글을 짧게 고치면 옛 청크가 모두 철회되고 원문이 직접 후보가 된다", async () => {
    const h = makeHarness(PARAGRAPH_CHUNKING);
    const { origin, chunks } = await saveLong(h);

    const edited = await patchJson(h, `/memories/${origin}`, { content: SHORTENED });
    expect(edited.status).toBe(200);
    expect(edited.body.warnings).toEqual([]);
    for (const id of chunks) {
      expect((await h.store.getNode(id))!.metadata.sharedMemory).toMatchObject({ status: "retracted", invalidatedBy: origin });
    }
    expect(activeChunkIds(h, origin)).toEqual([]);
    expect((await h.store.getNode(origin))!.metadata.extracted).toBe(0);
    expect(await candidateIds(h)).toEqual([origin]);
  }, 120_000);
});

describe("분류만 바꾸는 PATCH (PS-1)", () => {
  test("임베딩을 다시 계산하지 않고 node-edited 신호를 보내지 않는다 — 본문 편집은 둘 다 한다", async () => {
    const h = makeHarness();
    const trigger = startAutoCleanupTrigger({ store: h.store, throttleMs: 0, enabled: () => false });
    h.store.setAutoCleanupTrigger(trigger);
    const saved = await saveTextInput(h.store, { content: "분류를 바꿀 짧은 메모다.", source: "test", author: AUTHOR, force: true });
    const id = saved.originNodeId!;
    const vectorBefore = await h.store.getVectorById(id);
    const emitted = spyOn(trigger, "emit");
    const embed = spyOn(embedder, "embed");
    try {
      const classified = await patchJson(h, `/memories/${id}`, { capture: { kind: "idea", source: "user" }, expectedRevision: 0 });
      expect(classified.status).toBe(200);
      expect(classified.body.changed).toBe(true);
      expect(embed).toHaveBeenCalledTimes(0);
      expect(emitted.mock.calls.filter(([reason]) => reason === "node-edited")).toHaveLength(0);
      const node = (await h.store.getNode(id))!;
      expect(node.metadata).toMatchObject({ capture: { kind: "idea", source: "user" }, sharedMemory: { revision: 1 } });
      expect(await h.store.getVectorById(id)).toEqual(vectorBefore);

      const edited = await patchJson(h, `/memories/${id}`, { content: "분류를 바꾼 뒤 고친 메모다.", expectedRevision: 1 });
      expect(edited.status).toBe(200);
      expect(embed).toHaveBeenCalled();
      expect(emitted.mock.calls.filter(([reason]) => reason === "node-edited")).toHaveLength(1);
    } finally {
      embed.mockRestore();
      emitted.mockRestore();
      await trigger.stop();
    }
  }, 120_000);
});
