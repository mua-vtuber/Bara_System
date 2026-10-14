/**
 * node-repository.delete-by-source.test.ts — 출처 삭제 동기화가 계보 파생 노드까지 지운다 (WP-B1-20, DA-4).
 *
 * 실제 SQLite + 실제 bge-m3 + 실제 저장 경로(saveTextInput, ingestDocument, addImageCaption)와
 * 실제 REST 라우트(DELETE /memories/by-source, POST /search). 청크 추출은 실제 MemoryExtractor 가
 * 실제 OllamaClient 로 이 파일이 띄운 루프백 HTTP 서버(Ollama /api/chat 응답 형식)를 부르고,
 * 백필은 실제 startBackfillScheduler 사이클이다. regex 원자는 실제 builtin 양식이 만든다.
 *
 *  - 긴 Discord 글을 지우면 원문·청크·청크의 추출 자식·regex 원자가 모두 지워지고 검색 0건.
 *  - 두 원문이 공유한 자식(regex 원자, 추출 자식)은 한쪽 삭제 뒤에도 남고, 다른 쪽까지 지우면 지워진다.
 *  - regex 원자로 흡수된 독립 기억(같은 본문을 먼저 저장한 다른 메시지)은 지워지지 않는다.
 *  - 계보를 추이적으로 따라가고(원문 → 청크 → 주장), 순환은 멈춘다.
 *  - 문서·이미지 원문은 청크·캡션 자식까지 지운다. images 행은 기존 노드 삭제 트리거가 지운다.
 *
 * WP-B1-20T T2 — "누가 저장했는가"는 노드 metadata 가 아니라 서버 전용 출처 표
 * (memory_node_sources) 행으로 판정한다(설계 3.1·3.3·5.12). 흡수된 직접 저장은 그 노드에 출처 행을
 * 남기고, 출처 행도 살아 남는 계보 부모도 없는 노드는 지워진다(설계 3.4 생존 규칙). 예전 데이터
 * 추론(언급 횟수·출처 사건 행으로 남김)은 없다(설계 16절).
 *
 * WP-B1-20T T4 — 뿌리는 metadata 의 messageId 표시가 아니라 그 메시지의 출처 행을 가진 노드다(설계
 * 5.3). 원문 metadata 를 물려받은 추출 자식은 출처 행이 없어 뿌리가 아니고, 계보로 닿아 지워지면
 * derivedDeletedIds 에 든다. 응답은 keptIds(메시지 행을 잃었지만 남은 뿌리)와 archivePurgedIds(휴지통
 * 정리)를 더한다. 같은 본문 두 메시지(H1)·보관표 정리는 memories-delete-by-source.sources.test.ts.
 */

import { TEST_EXTRACTION_BACKFILL_RETRY } from "../../test-utils/backfill-retry.ts";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";

import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { SqliteMemoryStore } from "../store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { MemoryExtractor } from "../../memory/extractor.ts";
import { OllamaClient } from "../../llm/ollama-client.ts";
import { RegexL0Extractor } from "../../memory/regex-l0/extractor.ts";
import { ingestDocument } from "../../memory/ingest-document.ts";
import { startBackfillScheduler } from "../../scheduler.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-schema.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import { buildMemoryApi } from "../../server.ts";
import { saveTextInput, type SaveTextChunkingSettings } from "../../server-internal/save-input.ts";
import { NodeSourceRepository } from "./node-source-repository.ts";
import { sourceKeyOf } from "../../memory/node-sources/source-ref.ts";
import { lineageOrphans } from "../../test-utils/lineage-invariant.ts";
import { ASSET_FILE_REMOVER_MISSING } from "./asset-release.ts";
import { assetLedgerRef } from "./asset-repository.ts";

const EXTRACTION_MODEL = "extraction-fixture";
const AUTHOR = "owner";
const PLATFORM = "discord";
const DISCORD_SOURCE = "discord-channel";
/** 첨부 파일을 하나도 해제하지 않은 메시지 삭제의 파일 단계 결과(WP-B1-20U 설계 17.17). */
const NO_ASSET_CLEANUP = { documentIds: [], removedSha256s: [], missingSha256s: [], failed: [] };

// 문단 하나는 청크 한도(80) 아래, 글 전체는 한도 위 — 문단마다 청크 하나. 문단마다 두 문장이라
// 짧은 단일 의미 건너뛰기(shouldSkipExtraction)에 걸리지 않고 LLM 추출을 받는다.
const PARAGRAPH_CHUNKING: SaveTextChunkingSettings = { tokenCap: 80, minChunkTokens: 1 };
/** 실제 builtin regex 양식이 원자 두 개("운영팀 채널로 보내기로 확정했다." 등)를 만드는 문장. */
const REGEX_SENTENCE = "배포 알림은 앞으로 운영팀 채널로 보내기로 확정했다.";
const REGEX_ATOM = "운영팀 채널로 보내기로 확정했다.";
const LONG_PARAGRAPHS = [
  "첫 문단은 금요일 오후 창구를 쓴다. 이유는 주말 대응 인력 때문이다.",
  `둘째 문단은 알림 결론이다. ${REGEX_SENTENCE}`,
  "셋째 문단은 점검 목록을 정한다. 배포 전날 저녁에 다시 확인한다.",
];
const CHUNK_FACTS = [
  "배포 창구는 금요일 오후다",
  "배포 알림 경로는 운영팀 채널이다",
  "점검 목록은 배포 전날 저녁에 다시 본다",
];

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
  extractor: MemoryExtractor;
  llm: ReturnType<typeof Bun.serve>;
}

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) {
    h.llm.stop(true);
    h.db.close();
  }
});

/** 루프백 추출 서버 — 요청마다 CHUNK_FACTS 를 차례로 하나씩 돌려준다(청크마다 다른 사실). */
function startLoopbackLlm(): ReturnType<typeof Bun.serve> {
  let calls = 0;
  return Bun.serve({
    port: 0,
    fetch: (request) => {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/api/chat") {
        return new Response("not found", { status: 404 });
      }
      const fact = CHUNK_FACTS[calls % CHUNK_FACTS.length]!;
      calls += 1;
      return Response.json({
        model: EXTRACTION_MODEL,
        message: { role: "assistant", content: JSON.stringify([{ content: fact, memoryType: "fact", importance: 0.8 }]) },
        done: true,
      });
    },
  });
}

function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  const llm = startLoopbackLlm();
  const extractor = new MemoryExtractor(
    new OllamaClient({ baseUrl: `http://127.0.0.1:${llm.port}`, model: EXTRACTION_MODEL }),
    store, embedder, { duplicateSim: 0.999, minImportance: 0 },
  );
  const app = buildMemoryApi({
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(),
    getSettings: () => settings,
  });
  const h = { app, db, store, extractor, llm };
  harnesses.push(h);
  return h;
}

function builtinRegexL0(): RegexL0Extractor {
  return new RegexL0Extractor({ patternPaths: [], boosterPaths: [], userRepo: undefined, langs: ["ko"] });
}

/** Discord 봇이 보내는 모양 그대로 저장한다(messageId·source 칸, regex 켬). */
async function saveDiscord(h: Harness, content: string, messageId: string, regex = true) {
  const saved = await saveTextInput(h.store, {
    content, source: PLATFORM, author: AUTHOR, force: true, chunking: PARAGRAPH_CHUNKING,
    extraMetadata: { messageId, source: DISCORD_SOURCE },
    ...(regex ? { regexL0: builtinRegexL0(), regexEnabled: true } : {}),
  });
  return { origin: saved.originNodeId!, chunks: saved.chunkNodeIds, regexAtoms: saved.extracted };
}

async function deleteBySourceRoute(h: Harness, messageId: string) {
  const res = await h.app.request(`/memories/by-source?messageId=${messageId}&platform=${PLATFORM}`, { method: "DELETE" });
  expect(res.status).toBe(200);
  // WP-B1-20U 설계 17.0 — 메시지 삭제 뒤에도 살아 있는 노드는 모두 자기 출처 행이나 살아 있는 계보 부모를 가진다.
  expect(lineageOrphans(h.db)).toEqual([]);
  return await res.json() as {
    deletedCount: number; deletedIds: number[]; derivedDeletedIds: number[]; keptIds: number[]; archivePurgedIds: number[];
  };
}

async function searchCount(h: Harness, query: string): Promise<number> {
  const res = await h.app.request("/search", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, limit: 20 }),
  });
  expect(res.status).toBe(200);
  return (await res.json() as { count: number }).count;
}

function liveIds(db: Database): number[] {
  return (db.query("SELECT id FROM knowledge_nodes ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
}

function regexParents(db: Database, id: number): number[] {
  return (db.query(`SELECT target_id FROM knowledge_edges
    WHERE source_id = ? AND relation = 'merged_into' AND provenance = 'regex' ORDER BY target_id`)
    .all(id) as Array<{ target_id: number }>).map((r) => r.target_id);
}

function lineageEdge(sourceId: number, targetId: number, relation: "merged_into" | "parent_of") {
  return { sourceId, targetId, relation, provenance: "system", sourceNodeId: sourceId, weight: 1.0 } as const;
}

const ascending = (ids: number[]) => [...ids].sort((a, b) => a - b);

describe("긴 Discord 글 삭제", () => {
  test("원문·청크·청크의 추출 자식·regex 원자가 모두 지워지고 검색 0건", async () => {
    const h = makeHarness();
    const { origin, chunks, regexAtoms } = await saveDiscord(h, LONG_PARAGRAPHS.join("\n\n"), "msg-long");
    expect(chunks).toHaveLength(LONG_PARAGRAPHS.length);
    expect(regexAtoms.length).toBeGreaterThan(0);
    for (const id of regexAtoms) expect(regexParents(h.db, id)).toEqual([origin]);

    const handle = startBackfillScheduler(h.extractor, h.store, { intervalMs: 60_000, batchSize: 10, retry: TEST_EXTRACTION_BACKFILL_RETRY });
    try {
      expect((await handle.tickNow()).failures).toBe(0);
    } finally {
      await handle.stop();
    }
    const chunkChildren = (h.db.query(`SELECT e.source_id AS id FROM knowledge_edges e
      JOIN knowledge_nodes n ON n.id = e.source_id
      WHERE e.relation = 'merged_into' AND n.source_type = 'llm_extract' AND e.target_id IN (${chunks.join(",")})`)
      .all() as Array<{ id: number }>).map((r) => r.id);
    expect(chunkChildren).toHaveLength(CHUNK_FACTS.length);
    // 청크와 그 자식은 원문의 messageId 를 갖지 않는다 — 옛 삭제는 이들을 남겼다.
    for (const node of await h.store.getNodesByIds([...chunks, ...chunkChildren, ...regexAtoms])) {
      expect(node.metadata.messageId).toBeUndefined();
    }
    expect(await searchCount(h, "배포 알림 운영팀 채널")).toBeGreaterThan(0);

    const everythingElse = liveIds(h.db).filter((id) => id !== origin);
    const body = await deleteBySourceRoute(h, "msg-long");
    expect(body.deletedIds).toEqual([origin]);
    expect(body.deletedCount).toBe(1);
    expect(body.derivedDeletedIds).toEqual(everythingElse);
    expect(body.derivedDeletedIds).toEqual(expect.arrayContaining([...chunks, ...chunkChildren, ...regexAtoms]));

    expect(liveIds(h.db)).toEqual([]);
    expect((h.db.query("SELECT COUNT(*) AS n FROM vec_nodes").get() as { n: number }).n).toBe(0);
    expect((h.db.query("SELECT COUNT(*) AS n FROM knowledge_edges").get() as { n: number }).n).toBe(0);
    expect(await searchCount(h, "배포 알림 운영팀 채널")).toBe(0);
    expect(await searchCount(h, "점검 목록")).toBe(0);
  }, 120_000);
});

describe("공유 자식", () => {
  test("두 메시지가 공유한 regex 원자는 한쪽 삭제 뒤 남고, 다른 쪽까지 지우면 지워진다", async () => {
    const h = makeHarness();
    const a = await saveDiscord(h, REGEX_SENTENCE, "msg-share-a");
    const b = await saveDiscord(h, `회의 결론으로 ${REGEX_SENTENCE}`, "msg-share-b");
    const shared = a.regexAtoms.filter((id) => b.regexAtoms.includes(id));
    expect(shared.length).toBeGreaterThan(0);
    for (const id of shared) expect(regexParents(h.db, id)).toEqual(ascending([a.origin, b.origin]));
    const onlyA = a.regexAtoms.filter((id) => !shared.includes(id));

    const first = await deleteBySourceRoute(h, "msg-share-a");
    expect(first.deletedIds).toEqual([a.origin]);
    expect(first.derivedDeletedIds).toEqual(ascending(onlyA));
    for (const id of shared) {
      expect(await h.store.getNode(id)).not.toBeNull();
      expect(regexParents(h.db, id)).toEqual([b.origin]);
    }

    const second = await deleteBySourceRoute(h, "msg-share-b");
    expect(second.deletedIds).toEqual([b.origin]);
    expect(second.derivedDeletedIds).toEqual(expect.arrayContaining(shared));
    expect(liveIds(h.db)).toEqual([]);
    expect(await searchCount(h, REGEX_ATOM)).toBe(0);
  }, 120_000);

  test("messageId 를 물려받은 추출 자식도 살아 있는 다른 원문에서 파생됐으면 남는다", async () => {
    const h = makeHarness();
    const originA = await h.store.addNode({ content: "원문 A 본문이다", metadata: { messageId: "msg-a", source: DISCORD_SOURCE } });
    const originB = await h.store.addNode({ content: "원문 B 본문이다", metadata: { messageId: "msg-b", source: DISCORD_SOURCE } });
    const inherit = { messageId: "msg-a", source: DISCORD_SOURCE };
    const sharedChild = await h.store.addNode({ content: "두 원문의 공통 사실", sourceType: "llm_extract", metadata: inherit });
    const ownChild = await h.store.addNode({ content: "원문 A 만의 사실", sourceType: "llm_extract", metadata: inherit });
    await h.store.addEdge(lineageEdge(sharedChild, originA, "merged_into"));
    await h.store.addEdge(lineageEdge(sharedChild, originB, "merged_into"));
    await h.store.addEdge(lineageEdge(ownChild, originA, "merged_into"));

    // WP-B1-20T 설계 5.3 — 물려받은 messageId 는 뿌리를 정하지 않는다(출처 행이 없다). ownChild 는 계보로
    // 함께 지워지고, sharedChild 는 살아 남는 원문 B 가 붙잡는다.
    const result = await h.store.deleteBySource({ messageId: "msg-a", platform: PLATFORM });
    expect(result).toEqual({
      deletedIds: [originA], derivedDeletedIds: [ownChild], keptIds: [], archivePurgedIds: [], revisionBodiesCleared: 0,
      retractedDerivedDeletedIds: [], assetCleanup: NO_ASSET_CLEANUP,
    });
    expect(liveIds(h.db)).toEqual(ascending([originB, sharedChild]));
  }, 120_000);

  test("regex 원자로 흡수된 독립 기억은 다른 메시지를 지워도 남는다", async () => {
    const h = makeHarness();
    // 같은 본문을 먼저 독립 기억으로 저장한 메시지(regex 끔) — A 의 regex 원자가 content_hash 로 이 노드에 흡수된다.
    const independent = await saveDiscord(h, REGEX_ATOM, "msg-independent", false);
    const a = await saveDiscord(h, REGEX_SENTENCE, "msg-absorb-a");
    expect(a.regexAtoms).toContain(independent.origin);
    expect(regexParents(h.db, independent.origin)).toEqual([a.origin]);

    const body = await deleteBySourceRoute(h, "msg-absorb-a");
    expect(body.deletedIds).toEqual([a.origin]);
    expect(body.derivedDeletedIds).not.toContain(independent.origin);
    expect(await h.store.getNode(independent.origin)).not.toBeNull();
  }, 120_000);
});

/** 대시보드 저장(흡수 대상 판정은 저장 경로가 한다 — 같은 본문이면 기존 노드로 흡수된다). */
async function saveDashboard(h: Harness, content: string) {
  return await saveTextInput(h.store, { content, source: "dashboard", author: AUTHOR });
}

async function searchIds(h: Harness, query: string): Promise<number[]> {
  const res = await h.app.request("/search", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, limit: 20 }),
  });
  expect(res.status).toBe(200);
  return (await res.json() as { results: Array<{ id: number }> }).results.map((r) => r.id);
}

/** 노드의 출처 행 키(정렬). */
function sourceKeys(db: Database, id: number): string[] {
  return new NodeSourceRepository(db).listSync([id]).get(id)!.map((row) => row.key);
}

function mentionCount(db: Database, id: number): number {
  return (db.query("SELECT mention_count FROM knowledge_nodes WHERE id = ?").get(id) as { mention_count: number }).mention_count;
}

const DASHBOARD_SAVE_KEY = sourceKeyOf({ kind: "direct_save", channel: "dashboard", actor: AUTHOR });
const messageKey = (messageId: string) => sourceKeyOf({ kind: "message", platform: PLATFORM, messageId });

function lineageParentCount(db: Database, id: number): number {
  return (db.query(`SELECT COUNT(*) AS n FROM knowledge_edges
    WHERE source_id = ? AND relation IN ('merged_into', 'parent_of')`).get(id) as { n: number }).n;
}

describe("파생 노드에 흡수된 독립 저장", () => {
  test("QA 재현: Discord 글의 regex 원자에 흡수된 대시보드 저장은 글을 지워도 남고 검색된다", async () => {
    const h = makeHarness();
    const discord = await saveDiscord(h, REGEX_SENTENCE, "msg-qa");
    const dashboard = await saveDashboard(h, REGEX_ATOM);
    expect(dashboard.cacheHit).toBe(true);
    const absorbed = dashboard.originNodeId!;
    expect(discord.regexAtoms).toContain(absorbed);
    // 파생 노드가 직접 저장을 흡수하면 그 저장의 출처 행이 남는다(설계 3.4·3.6). 같은 메시지
    // 재전송은 원문에 아무것도 더하지 않는다(설계 5.2).
    expect(sourceKeys(h.db, absorbed)).toEqual([DASHBOARD_SAVE_KEY]);
    const mentionsBeforeResend = mentionCount(h.db, discord.origin);
    expect((await saveDiscord(h, REGEX_SENTENCE, "msg-qa")).origin).toBe(discord.origin);
    expect(sourceKeys(h.db, discord.origin)).toEqual([messageKey("msg-qa")]);
    expect(mentionCount(h.db, discord.origin)).toBe(mentionsBeforeResend);

    const body = await deleteBySourceRoute(h, "msg-qa");
    expect(body.deletedIds).toEqual([discord.origin]);
    expect(body.derivedDeletedIds).toEqual(ascending(discord.regexAtoms.filter((id) => id !== absorbed)));
    expect(liveIds(h.db)).toEqual([absorbed]);
    // 삭제된 원문으로 가는 계보 엣지는 사라져, 남은 노드는 부모 없는 독립 기억이다.
    expect(lineageParentCount(h.db, absorbed)).toBe(0);
    expect(await searchIds(h, REGEX_ATOM)).toContain(absorbed);
  }, 120_000);

  test("LLM 추출 자식에 흡수된 대시보드 저장도 원문 삭제 뒤 남고 검색된다", async () => {
    const h = makeHarness();
    const discord = await saveDiscord(h, "배포 창구를 정했다. 금요일 오후로 확정했다.", "msg-llm", false);
    const handle = startBackfillScheduler(h.extractor, h.store, { intervalMs: 60_000, batchSize: 10, retry: TEST_EXTRACTION_BACKFILL_RETRY });
    try {
      expect((await handle.tickNow()).failures).toBe(0);
    } finally {
      await handle.stop();
    }
    const dashboard = await saveDashboard(h, CHUNK_FACTS[0]!);
    expect(dashboard.cacheHit).toBe(true);
    const child = (await h.store.getNode(dashboard.originNodeId!))!;
    expect(child.sourceType).toBe("llm_extract");
    // 추출 자식은 원문의 messageId 를 물려받지만 그 메시지의 출처 행은 없다 — 계보로 닿는다(설계 5.3).
    expect(child.metadata.messageId).toBe("msg-llm");
    expect(sourceKeys(h.db, child.id)).toEqual([DASHBOARD_SAVE_KEY]);

    const body = await deleteBySourceRoute(h, "msg-llm");
    expect(body.deletedIds).toEqual([discord.origin]);
    expect(body.derivedDeletedIds).toEqual([]);
    expect(body.keptIds).toEqual([]);
    expect(liveIds(h.db)).toEqual([child.id]);
    expect(lineageParentCount(h.db, child.id)).toBe(0);
    expect(await searchIds(h, CHUNK_FACTS[0]!)).toContain(child.id);
  }, 120_000);

  // WP-B1-20T 설계 3.4·16절 — 예전 흡수 흔적 추론("계보로 설명되지 않는 언급 횟수면 남김")은 없다.
  // 생존은 출처 행 또는 살아 남는 계보 부모로만 정해진다. 언급 횟수는 출처가 아니다.
  test("출처 행 없이 언급만 오른 파생 노드는 원문과 함께 지워진다", async () => {
    const h = makeHarness();
    const discord = await saveDiscord(h, REGEX_SENTENCE, "msg-legacy");
    const [bumped] = discord.regexAtoms;
    await h.store.bumpMention(bumped!);
    expect(sourceKeys(h.db, bumped!)).toEqual([]);

    const body = await deleteBySourceRoute(h, "msg-legacy");
    expect(body.deletedIds).toEqual([discord.origin]);
    expect(body.derivedDeletedIds).toEqual(ascending(discord.regexAtoms));
    expect(liveIds(h.db)).toEqual([]);
  }, 120_000);

  // WP-B1-20T 설계 3.3·D5 — 출처 사건 행(memory_source_events)은 근거·재전송 원장이고, 생존은 출처 행만
  // 본다. AI 저장은 사건 행과 함께 save:mcp:<actor> 출처 행을 남긴다(memories-source-rows.test.ts).
  test("출처 사건 행만 있고 출처 행이 없는 파생 노드는 원문과 함께 지워진다", async () => {
    const h = makeHarness();
    const discord = await saveDiscord(h, REGEX_SENTENCE, "msg-legacy-event");
    const [eventOnly] = discord.regexAtoms;
    h.db.query("INSERT INTO memory_source_events (event_key, node_id, evidence_json, created_at) VALUES (?, ?, '{}', ?)")
      .run("event-without-source-row", eventOnly!, "2026-09-01T00:00:00+09:00");
    expect(sourceKeys(h.db, eventOnly!)).toEqual([]);

    const body = await deleteBySourceRoute(h, "msg-legacy-event");
    expect(body.derivedDeletedIds).toEqual(ascending(discord.regexAtoms));
    expect(liveIds(h.db)).toEqual([]);
  }, 120_000);
});

/** Discord 봇 buildBaseMetadata 가 보내는 칸 그대로(channelId·guildId 포함) 저장한다. */
async function saveDiscordFull(h: Harness, content: string, messageId: string) {
  const saved = await saveTextInput(h.store, {
    content, source: PLATFORM, author: AUTHOR, force: true, chunking: PARAGRAPH_CHUNKING,
    extraMetadata: { messageId, source: DISCORD_SOURCE, user_id: "discord-user", channelId: "channel-1", guildId: "guild-1" },
    regexL0: builtinRegexL0(), regexEnabled: true,
  });
  return { origin: saved.originNodeId!, chunks: saved.chunkNodeIds, regexAtoms: saved.extracted };
}

function storedMetadataJson(db: Database, id: number): string {
  return (db.query("SELECT metadata_json FROM knowledge_nodes WHERE id = ?").get(id) as { metadata_json: string }).metadata_json;
}

describe("원문 자체에 흡수된 독립 저장", () => {
  test("Discord 글과 같은 본문의 대시보드 저장은 메시지를 지워도 남고, 같은 메시지 재전송은 원문 metadata 를 바꾸지 않는다", async () => {
    const h = makeHarness();
    const discord = await saveDiscordFull(h, REGEX_SENTENCE, "msg-same");
    expect(discord.regexAtoms.length).toBeGreaterThan(0);
    const beforeResend = storedMetadataJson(h.db, discord.origin);
    // 같은 메시지 재전송 — 흡수는 되지만(언급) 원문 metadata 는 그대로다.
    expect((await saveDiscordFull(h, REGEX_SENTENCE, "msg-same")).origin).toBe(discord.origin);
    expect(storedMetadataJson(h.db, discord.origin)).toBe(beforeResend);

    const dashboard = await saveDashboard(h, REGEX_SENTENCE);
    expect(dashboard.cacheHit).toBe(true);
    expect(dashboard.originNodeId).toBe(discord.origin);
    // 원문에 흡수된 대시보드 저장은 출처 행으로 남는다(설계 3.6). 흡수는 metadata 를 바꾸지 않는다.
    expect(sourceKeys(h.db, discord.origin)).toEqual([DASHBOARD_SAVE_KEY, messageKey("msg-same")].sort());
    expect(storedMetadataJson(h.db, discord.origin)).toBe(beforeResend);
    const afterSave = storedMetadataJson(h.db, discord.origin);
    expect((await saveDiscordFull(h, REGEX_SENTENCE, "msg-same")).origin).toBe(discord.origin);
    expect(storedMetadataJson(h.db, discord.origin)).toBe(afterSave);

    const body = await deleteBySourceRoute(h, "msg-same");
    expect(body).toMatchObject({
      deletedCount: 0, deletedIds: [], derivedDeletedIds: [], keptIds: [discord.origin], archivePurgedIds: [],
    });

    // 원문은 남고 출처 메시지 표시만 빠진다. 계보(regex 원자)는 그대로다.
    const kept = (await h.store.getNode(discord.origin))!;
    expect(kept.content).toBe(REGEX_SENTENCE);
    expect(kept.metadata).not.toHaveProperty("messageId");
    expect(kept.metadata).not.toHaveProperty("channelId");
    expect(kept.metadata).not.toHaveProperty("guildId");
    expect(kept.metadata).toMatchObject({ source: DISCORD_SOURCE });
    // 지운 메시지의 출처 행은 빠지고 대시보드 저장의 행이 노드를 붙잡는다.
    expect(sourceKeys(h.db, discord.origin)).toEqual([DASHBOARD_SAVE_KEY]);
    expect(liveIds(h.db)).toEqual(ascending([discord.origin, ...discord.regexAtoms]));
    for (const id of discord.regexAtoms) expect(regexParents(h.db, id)).toEqual([discord.origin]);
    expect(await searchIds(h, REGEX_SENTENCE)).toContain(discord.origin);

    // 출처 표시가 빠져 같은 삭제를 다시 받아도 아무것도 일치하지 않는다.
    expect(await h.store.findNodesBySource({ messageId: "msg-same", platform: PLATFORM })).toEqual([]);
  }, 120_000);

  test("긴 Discord 글과 같은 본문을 저장했으면 메시지를 지워도 원문·청크·regex 원자가 모두 남는다", async () => {
    const h = makeHarness();
    const content = LONG_PARAGRAPHS.join("\n\n");
    const discord = await saveDiscordFull(h, content, "msg-long-same");
    expect(discord.chunks).toHaveLength(LONG_PARAGRAPHS.length);
    expect((await saveDashboard(h, content)).originNodeId).toBe(discord.origin);
    const before = liveIds(h.db);

    const result = await h.store.deleteBySource({ messageId: "msg-long-same", platform: PLATFORM });
    expect(result).toEqual({
      deletedIds: [], derivedDeletedIds: [], keptIds: [discord.origin], archivePurgedIds: [], revisionBodiesCleared: 0,
      retractedDerivedDeletedIds: [], assetCleanup: NO_ASSET_CLEANUP,
    });
    expect(liveIds(h.db)).toEqual(before);
    for (const id of discord.chunks) expect(lineageParentCount(h.db, id)).toBe(1);
    expect((await h.store.getNode(discord.origin))!.metadata).not.toHaveProperty("messageId");
  }, 120_000);

  test("대시보드 저장이 없는 원문은 재전송을 여러 번 받아도 메시지 삭제와 함께 지워진다", async () => {
    const h = makeHarness();
    const discord = await saveDiscordFull(h, REGEX_SENTENCE, "msg-resent");
    const mentionsBefore = mentionCount(h.db, discord.origin);
    await saveDiscordFull(h, REGEX_SENTENCE, "msg-resent");
    await saveDiscordFull(h, REGEX_SENTENCE, "msg-resent");
    // 재전송은 출처 행을 더하지도, 언급을 올리지도 않는다(설계 5.2).
    expect(sourceKeys(h.db, discord.origin)).toEqual([messageKey("msg-resent")]);
    expect(mentionCount(h.db, discord.origin)).toBe(mentionsBefore);

    const result = await h.store.deleteBySource({ messageId: "msg-resent", platform: PLATFORM });
    expect(result.deletedIds).toEqual([discord.origin]);
    expect(liveIds(h.db)).toEqual([]);
  }, 120_000);
});

describe("추이·순환", () => {
  test("원문 → 청크 → 주장을 끝까지 따라가고, 순환은 멈추며, 바깥 부모가 있는 가지는 통째로 남는다", async () => {
    const h = makeHarness();
    const origin = await h.store.addNode({ content: "순환 시험 원문", metadata: { messageId: "msg-cycle", source: DISCORD_SOURCE } });
    const outside = await h.store.addNode({ content: "살아 남는 다른 원문" });
    const chunk = await h.store.addNode({ content: "순환 시험 청크", sourceType: "document_chunk" });
    const claim = await h.store.addNode({ content: "순환 시험 주장", sourceType: "llm_extract" });
    const sharedClaim = await h.store.addNode({ content: "바깥에서도 온 주장", sourceType: "llm_extract" });
    const grandChild = await h.store.addNode({ content: "공유 주장의 자식", sourceType: "llm_extract" });
    await h.store.addEdge(lineageEdge(chunk, origin, "parent_of"));
    await h.store.addEdge(lineageEdge(claim, chunk, "merged_into"));
    await h.store.addEdge(lineageEdge(chunk, claim, "merged_into")); // 순환
    await h.store.addEdge(lineageEdge(sharedClaim, chunk, "merged_into"));
    await h.store.addEdge(lineageEdge(sharedClaim, outside, "merged_into"));
    await h.store.addEdge(lineageEdge(grandChild, sharedClaim, "merged_into"));

    const result = await h.store.deleteBySource({ messageId: "msg-cycle" });
    expect(result).toEqual({
      deletedIds: [origin], derivedDeletedIds: ascending([chunk, claim]), keptIds: [], archivePurgedIds: [], revisionBodiesCleared: 0,
      retractedDerivedDeletedIds: [], assetCleanup: NO_ASSET_CLEANUP,
    });
    expect(liveIds(h.db)).toEqual(ascending([outside, sharedClaim, grandChild]));
  }, 120_000);
});

describe("문서·이미지 원문", () => {
  test("문서 원문을 지우면 document_chunk 자식까지 지운다", async () => {
    const h = makeHarness();
    h.store.upsertAssetFile({ sha256: "docsha", assetType: "text", assetPath: "/x/docsha.md", byteSize: 50 });
    const documentId = h.store.createDocument({ assetSha256: "docsha", title: "회의록", documentType: "meeting_log" });
    const doc = await ingestDocument(h.store, {
      documentId, assetSha256: "docsha", title: "회의록", rawContent: "회의록\n\n첫 청크\n\n둘째 청크",
      documentType: "meeting_log", chunks: [{ text: "첫 청크", index: 0 }, { text: "둘째 청크", index: 1 }],
      author: AUTHOR, platform: PLATFORM, documentMetadata: { messageId: "msg-doc", source: DISCORD_SOURCE },
    });

    const result = await h.store.deleteBySource({ messageId: "msg-doc", platform: PLATFORM });
    expect(result).toEqual({
      deletedIds: [doc.documentNodeId], derivedDeletedIds: ascending(doc.chunkNodeIds), keptIds: [], archivePurgedIds: [], revisionBodiesCleared: 0,
      retractedDerivedDeletedIds: [],
      // WP-B1-20U 설계 17.17 — 문서 노드가 주인인 문서 기록이 지워지고 sha 가 참조를 잃는다. 이 저장소에는 파일 지우기
      // 함수를 넣지 않아 파일은 지우지 않고 failed 로 알린다(asset_files 행은 대기).
      assetCleanup: {
        documentIds: [documentId], removedSha256s: [], missingSha256s: [],
        failed: [{ sha256: "docsha", path: "/x/docsha.md", error: ASSET_FILE_REMOVER_MISSING }],
      },
    });
    expect(liveIds(h.db)).toEqual([]);
  }, 120_000);

  test("이미지 원문을 지우면 캡션 자식과 images 행까지 지운다", async () => {
    const h = makeHarness();
    h.store.upsertAssetFile({ sha256: "imgsha", assetType: "image", assetPath: "/x/imgsha.png", byteSize: 10 });
    h.db.query(`INSERT INTO images (asset_sha256, thumb_sha256, width, height, mime, preserve_mode, is_animated, warnings_json)
      VALUES ('imgsha', NULL, 1, 1, 'image/png', 'original', 0, '[]')`).run();
    const image = await h.store.addNode({
      content: "이미지 자산 imgsha", sourceType: "image_asset",
      metadata: { asset_sha256: "imgsha", messageId: "msg-img", source: DISCORD_SOURCE },
    });
    // ingest-image 가 이미지 노드마다 쓰는 원장 행(`image:<node_id>`) — 해제는 metadata 가 아니라 이 행으로 sha 를 찾는다
    // (WP-B1-20U 설계 17.18 D33).
    h.store.addAssetImport({
      assetSha256: "imgsha", source: DISCORD_SOURCE, sourceRef: assetLedgerRef({ kind: "image", nodeId: image }),
      author: AUTHOR, userId: AUTHOR,
    });
    const caption = await h.store.addImageCaption({ parentNodeId: image, assetSha256: "imgsha", caption: "고양이 사진", captionRole: "auto" });

    const result = await h.store.deleteBySource({ messageId: "msg-img", platform: PLATFORM });
    expect(result).toEqual({
      deletedIds: [image], derivedDeletedIds: [caption], keptIds: [], archivePurgedIds: [], revisionBodiesCleared: 0,
      retractedDerivedDeletedIds: [],
      assetCleanup: {
        documentIds: [], removedSha256s: [], missingSha256s: [],
        failed: [{ sha256: "imgsha", path: "/x/imgsha.png", error: ASSET_FILE_REMOVER_MISSING }],
      },
    });
    expect(liveIds(h.db)).toEqual([]);
    expect(h.db.query("SELECT 1 FROM images WHERE asset_sha256 = 'imgsha'").get()).toBeNull();
  }, 120_000);
});
