/**
 * memories-delete.retracted-derivatives.test.ts — 메시지를 지운 뒤에도 다른 출처로 남는 기억 아래에, 그 메시지의 동기
 * 수정(PATCH by-source 같은 id 수정)이 계보 무효화로 철회한 옛 파생 기억이 남지 않는다(WP-B1-20U 설계 17.7, Q4 기본값).
 *
 * 같은 id 메시지 수정은 주장이 바뀌면 출처 없는 추출 자식을 retracted 로 바꾸고 sharedMemory.invalidatedByRevision 에 그
 * 수정 이력 행 id 를 적는다. 메시지 삭제는 그 메시지의 동기 수정 이력 행을 모아, 살아 있는 고친 노드에서 계보 자손을
 * 걸어 그 이력 id 로 철회되고 자기 출처 행이 없는 노드를 explicit/cascade 로 영구 삭제한다(설계 17.3 함수 재사용).
 * 대시보드·AI 의 by-id 편집으로 철회된 자식과 자기 출처 행이 있어 철회되지 않은 자식(설계 5.8)은 남는다.
 *
 * Real bun:sqlite(:memory:) + real bge-m3 + 실제 라우트(buildMemoryApi) + 실제 즉시 추출·백필(MemoryExtractor 가 실제
 * OllamaClient 로 테스트 안 Bun.serve 루프백 LLM 을 부른다). mock 0. 모든 메시지 삭제 뒤 계보 불변식 도우미를 부른다.
 */

import { TEST_EXTRACTION_BACKFILL_RETRY } from "../../test-utils/backfill-retry.ts";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";

import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { OllamaClient } from "../../llm/ollama-client.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { MemoryExtractor } from "../../memory/extractor.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { readSharedMemory, type SharedMemoryState } from "../../memory/shared-memory-contract.ts";
import { startBackfillScheduler } from "../../scheduler.ts";
import { buildMemoryApi } from "../../server.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import type { DeleteBySourceResult, EditBySourceResult } from "../../api-client-types.ts";
import { lineageOrphans } from "../../test-utils/lineage-invariant.ts";
import {
  startPromptOllamaChatServer,
  type ExtractionReply,
  type PromptOllamaChatServer,
} from "../../test-utils/prompt-ollama-chat-server.ts";

const OWNER = "owner";
const PLATFORM = "discord";
const MESSAGE_EDITOR = "discord-user-1";
const MESSAGE_EDIT_REASON = "discord message edit";
const EXTRACTION_IMPORTANCE = 0.9;
/** 중복 흡수는 같은 문장만 — 새로 뽑힌 사실이 자기 원문에 흡수되지 않게 한다(memories-edit.rederive.test.ts 와 같은 값). */
const SAME_SENTENCE_ONLY = 0.999;

/** QA 재현: 메시지 원문 → 같은 id 수정 → 대시보드가 새 문장 저장 → 메시지 삭제. */
const QA_OLD = "이번 분기 워크숍 장소는 강릉 바닷가 펜션으로 잡았다. 출발은 금요일 아침 여덟시다.";
const QA_OLD_CHILD = "이번 분기 워크숍 장소는 강릉 펜션이다";
const QA_NEW = "이번 분기 워크숍 장소는 속초 호텔 회의실로 바꿨다. 출발은 금요일 아침 여덟시다.";
const QA_NEW_CHILD = "이번 분기 워크숍 장소는 속초 호텔이다";
/** 대시보드 by-id 편집으로 철회된 자식. */
const BY_ID_OLD = "다음 달 팀 회식은 종로 고깃집에서 하기로 했다. 예약은 총무가 맡는다.";
const BY_ID_OLD_CHILD = "다음 달 팀 회식 장소는 종로 고깃집이다";
const BY_ID_NEW = "다음 달 팀 회식은 을지로 횟집으로 옮겼다. 예약은 총무가 맡는다.";
/** 자기 출처 행(대시보드 저장)이 있어 철회되지 않는 자식. */
const OWN_OLD = "새 사무실 출입 카드는 일층 안내 데스크에서 받는다. 분실하면 바로 신고한다.";
const OWN_OLD_CHILD = "출입 카드는 일층 안내 데스크에서 받는다";
const OWN_NEW = "새 사무실 출입 카드는 이층 총무팀에서 받도록 바뀌었다. 분실하면 바로 신고한다.";
/** 같은 id 수정 뒤 분리 수정 — 고친 노드가 더는 이 메시지의 출처 행을 갖지 않는 경우. */
const SPLIT_OLD = "주간 보고서 마감은 매주 목요일 오후 다섯시다. 제출은 공유 폴더로 한다.";
const SPLIT_OLD_CHILD = "주간 보고서 마감은 목요일 오후 다섯시다";
const SPLIT_NEW = "주간 보고서 마감은 매주 금요일 오전 열시로 바뀌었다. 제출은 공유 폴더로 한다.";
const SPLIT_NEWER = "주간 보고서 마감은 매주 금요일 오후 두시로 다시 바뀌었다. 제출은 공유 폴더로 한다.";

const item = (content: string) => ({ content, memoryType: "fact", importance: EXTRACTION_IMPORTANCE });
const EXTRACTION: ExtractionReply[] = [
  { source: QA_OLD, items: [item(QA_OLD_CHILD)] },
  { source: QA_NEW, items: [item(QA_NEW_CHILD)] },
  { source: BY_ID_OLD, items: [item(BY_ID_OLD_CHILD)] },
  { source: OWN_OLD, items: [item(OWN_OLD_CHILD)] },
  { source: SPLIT_OLD, items: [item(SPLIT_OLD_CHILD)] },
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
  llm: PromptOllamaChatServer;
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
  const llm = startPromptOllamaChatServer(EXTRACTION);
  const extractor = new MemoryExtractor(
    new OllamaClient({ baseUrl: llm.url, model: "test-model" }),
    store,
    embedder,
    { duplicateSim: SAME_SENTENCE_ONLY, minImportance: 0 },
  );
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  settings.llm.extractor.enabled = true;
  settings.llm.extractor.mode = "immediate";
  settings.extractor.regex.enabled = false;
  const app = buildMemoryApi({
    store,
    retriever: new HybridRetriever(store, embedder),
    assembler: new ContextAssembler(),
    extractor,
    getSettings: () => settings,
  });
  const h = { app, db, store, extractor, llm };
  harnesses.push(h);
  return h;
}

type Json = Record<string, unknown>;

async function call(h: Harness, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await h.app.request(path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() as Json };
}

function liveNodes(db: Database): Array<{ id: number; content: string }> {
  return db.query("SELECT id, content FROM knowledge_nodes ORDER BY id").all() as Array<{ id: number; content: string }>;
}

function nodeIdByContent(db: Database, content: string): number {
  const row = db.query("SELECT id FROM knowledge_nodes WHERE content = ?").get(content) as { id: number } | null;
  if (row === null) throw new Error(`기억 '${content}' 가 저장되지 않았습니다`);
  return row.id;
}

/** Discord 메시지 저장(즉시 추출) → [원문, 추출 자식]. */
async function saveDiscordMessage(
  h: Harness,
  messageId: string,
  content: string,
  child: string,
): Promise<{ origin: number; child: number }> {
  const saved = await call(h, "POST", "/memories", {
    content, author: OWNER, platform: PLATFORM,
    metadata: { messageId, channelId: "c1", guildId: "g1", source: "discord-channel" },
  });
  expect(saved.status).toBe(201);
  return { origin: saved.body.id as number, child: nodeIdByContent(h.db, child) };
}

async function saveDashboard(h: Harness, content: string): Promise<number> {
  const saved = await call(h, "POST", "/memories", { content, author: OWNER, platform: "dashboard", force: true });
  expect(saved.status).toBe(201);
  return saved.body.id as number;
}

async function editMessage(h: Harness, messageId: string, content: string): Promise<EditBySourceResult> {
  const edited = await call(h, "PATCH", "/memories/by-source", {
    messageId, platform: PLATFORM, content, reason: MESSAGE_EDIT_REASON, editor: MESSAGE_EDITOR, source: PLATFORM,
  });
  expect(edited.status).toBe(200);
  return edited.body as unknown as EditBySourceResult;
}

/** 메시지 삭제 동기화. 지운 뒤 계보 불변식을 확인한다. */
async function deleteMessage(h: Harness, messageId: string): Promise<DeleteBySourceResult> {
  const deleted = await call(h, "DELETE", `/memories/by-source?messageId=${messageId}&platform=${PLATFORM}`);
  expect(deleted.status).toBe(200);
  expect(lineageOrphans(h.db)).toEqual([]);
  return deleted.body as unknown as DeleteBySourceResult;
}

async function runBackfill(h: Harness): Promise<void> {
  const handle = startBackfillScheduler(h.extractor, h.store, { intervalMs: 60_000, batchSize: 10, retry: TEST_EXTRACTION_BACKFILL_RETRY });
  try {
    expect(await handle.tickNow()).toMatchObject({ processed: 1, failures: 0 });
  } finally {
    await handle.stop();
  }
}

function stateOf(db: Database, id: number): SharedMemoryState {
  const row = db.query("SELECT metadata_json FROM knowledge_nodes WHERE id = ?").get(id) as { metadata_json: string } | null;
  if (row === null) throw new Error(`기억 ${id} 가 없습니다`);
  return readSharedMemory(JSON.parse(row.metadata_json) as Record<string, unknown>);
}

/** 그 메시지의 동기 수정이 남긴 이력 행 id(오름차순). */
function messageRevisionIds(db: Database, messageId: string): number[] {
  return (db.query("SELECT id FROM memory_revisions WHERE source_message_id = ? ORDER BY id").all(messageId) as Array<{ id: number }>)
    .map((row) => row.id);
}

function revisionCount(db: Database, id: number): number {
  return (db.query("SELECT COUNT(*) AS n FROM memory_revisions WHERE old_node_id = ? OR new_node_id = ?")
    .get(id, id) as { n: number }).n;
}

/** 살아 있는 노드·보관표·수정 이력에 그 글이 남은 수. */
function textCount(db: Database, text: string): { live: number; archive: number; revisions: number } {
  const count = (sql: string, ...args: string[]) => (db.query(sql).get(...args) as { n: number }).n;
  return {
    live: count("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE instr(content, ?) > 0", text),
    archive: count("SELECT COUNT(*) AS n FROM knowledge_nodes_archive WHERE instr(content, ?) > 0", text),
    revisions: count(
      `SELECT COUNT(*) AS n FROM memory_revisions
       WHERE instr(COALESCE(old_content, ''), ?) > 0 OR instr(COALESCE(new_content, ''), ?) > 0`,
      text, text,
    ),
  };
}

const NO_TEXT = { live: 0, archive: 0, revisions: 0 };

async function searchContents(h: Harness, query: string): Promise<string[]> {
  const res = await call(h, "POST", "/search", { query, limit: 30 });
  expect(res.status).toBe(200);
  return (res.body.results as Array<{ content: string }>).map((r) => r.content);
}

describe("메시지 삭제가 남는 기억 아래의 철회된 옛 파생을 지운다 (설계 17.7)", () => {
  test("QA 재현: 메시지 수정 → 대시보드가 새 문장 저장 → 메시지 삭제: 원문은 남고 철회된 c1 은 이력까지 영구 삭제, 백필 새 자식은 남는다", async () => {
    const h = makeHarness();
    const { origin, child: c1 } = await saveDiscordMessage(h, "m-qa", QA_OLD, QA_OLD_CHILD);
    // c1 의 수정 이력 행(본문 포함)을 만든다 — 분류만 바꾼 편집이라 본문 그대로 이력에 남는다.
    const classified = await call(h, "PATCH", `/memories/${c1}`, {
      capture: { kind: "idea", source: "user" }, expectedRevision: stateOf(h.db, c1).revision, editor: OWNER, source: "dashboard",
    });
    expect(classified.status).toBe(200);
    expect(revisionCount(h.db, c1)).toBe(1);

    expect(await editMessage(h, "m-qa", QA_NEW)).toMatchObject({ editedIds: [origin], splits: [] });
    const [editRevision] = messageRevisionIds(h.db, "m-qa");
    expect(editRevision).toBeDefined();
    expect(stateOf(h.db, c1)).toMatchObject({ status: "retracted", invalidatedBy: origin, invalidatedByRevision: editRevision });

    await runBackfill(h);
    const c2 = nodeIdByContent(h.db, QA_NEW_CHILD);
    expect(await saveDashboard(h, QA_NEW)).toBe(origin);
    expect(liveNodes(h.db).map((n) => n.id)).toEqual([origin, c1, c2]);

    const deleted = await deleteMessage(h, "m-qa");
    expect(deleted).toEqual({
      messageId: "m-qa", platform: PLATFORM, deletedCount: 0, deletedIds: [], derivedDeletedIds: [], keptIds: [origin],
      archivePurgedIds: [], revisionBodiesCleared: 1, retractedDerivedDeletedIds: [c1],
      // WP-B1-20U 설계 17.17 — 문서·이미지 노드가 없어 해제한 첨부가 없다.
      assetCleanup: { documentIds: [], removedSha256s: [], missingSha256s: [], failed: [] },
    });
    expect(liveNodes(h.db)).toEqual([{ id: origin, content: QA_NEW }, { id: c2, content: QA_NEW_CHILD }]);
    expect(stateOf(h.db, c2).status).toBe("active");
    expect(revisionCount(h.db, c1)).toBe(0);
    expect(textCount(h.db, QA_OLD_CHILD)).toEqual(NO_TEXT);
    expect(textCount(h.db, QA_OLD)).toEqual(NO_TEXT);
    expect((await call(h, "GET", `/memories/${c1}`)).status).toBe(404);
    expect((await searchContents(h, QA_OLD_CHILD)).filter((content) => content.includes(QA_OLD_CHILD))).toEqual([]);
  }, 300_000);

  test("대시보드 by-id 편집으로 철회된 자식은 메시지 동기 수정이 아니라 메시지 삭제 뒤에도 남는다", async () => {
    const h = makeHarness();
    const { origin, child } = await saveDiscordMessage(h, "m-by-id", BY_ID_OLD, BY_ID_OLD_CHILD);
    const edited = await call(h, "PATCH", `/memories/${origin}`, { content: BY_ID_NEW, editor: OWNER, source: "dashboard" });
    expect(edited.status).toBe(200);
    const byIdRevision = (h.db.query("SELECT id, source_message_id FROM memory_revisions WHERE old_node_id = ?")
      .get(origin) as { id: number; source_message_id: string | null });
    expect(byIdRevision.source_message_id).toBeNull();
    expect(stateOf(h.db, child)).toMatchObject({ status: "retracted", invalidatedBy: origin, invalidatedByRevision: byIdRevision.id });
    expect(await saveDashboard(h, BY_ID_NEW)).toBe(origin);

    const deleted = await deleteMessage(h, "m-by-id");
    expect(deleted).toMatchObject({ deletedIds: [], derivedDeletedIds: [], keptIds: [origin], retractedDerivedDeletedIds: [] });
    expect(liveNodes(h.db).map((n) => n.id)).toEqual([origin, child]);
    expect(stateOf(h.db, child)).toMatchObject({ status: "retracted", invalidatedByRevision: byIdRevision.id });
  }, 300_000);

  test("자기 출처 행이 있는 자식은 철회되지 않으므로(설계 5.8) 메시지 삭제의 영향을 받지 않는다", async () => {
    const h = makeHarness();
    const { origin, child } = await saveDiscordMessage(h, "m-own", OWN_OLD, OWN_OLD_CHILD);
    expect(await saveDashboard(h, OWN_OLD_CHILD)).toBe(child);

    expect(await editMessage(h, "m-own", OWN_NEW)).toMatchObject({ editedIds: [origin] });
    const childState = stateOf(h.db, child);
    expect(childState.status).toBe("active");
    expect(childState.invalidatedByRevision).toBeUndefined();
    expect(await saveDashboard(h, OWN_NEW)).toBe(origin);

    const deleted = await deleteMessage(h, "m-own");
    expect(deleted).toMatchObject({ deletedIds: [], keptIds: [origin], retractedDerivedDeletedIds: [] });
    expect(liveNodes(h.db).map((n) => n.id)).toEqual([origin, child]);
    expect(stateOf(h.db, child).status).toBe("active");
  }, 300_000);

  test("같은 id 수정 뒤 분리 수정으로 고친 노드가 이 메시지 행을 잃었어도, 그 노드 아래 철회된 옛 파생은 지워진다", async () => {
    const h = makeHarness();
    const { origin, child } = await saveDiscordMessage(h, "m-split", SPLIT_OLD, SPLIT_OLD_CHILD);
    await editMessage(h, "m-split", SPLIT_NEW);
    const [sameIdRevision] = messageRevisionIds(h.db, "m-split");
    expect(stateOf(h.db, child)).toMatchObject({ status: "retracted", invalidatedByRevision: sameIdRevision });
    expect(await saveDashboard(h, SPLIT_NEW)).toBe(origin);

    const split = await editMessage(h, "m-split", SPLIT_NEWER);
    expect(split.editedIds).toEqual([]);
    expect(split.splits).toHaveLength(1);
    const { newNodeId } = split.splits[0]!;

    const deleted = await deleteMessage(h, "m-split");
    expect(deleted).toMatchObject({
      deletedIds: [newNodeId], derivedDeletedIds: [], keptIds: [], revisionBodiesCleared: 1, retractedDerivedDeletedIds: [child],
    });
    expect(liveNodes(h.db)).toEqual([{ id: origin, content: SPLIT_NEW }]);
    expect(textCount(h.db, SPLIT_OLD_CHILD)).toEqual(NO_TEXT);
    expect(textCount(h.db, SPLIT_OLD)).toEqual(NO_TEXT);
  }, 300_000);

  test("invalidatedByRevision 은 서버 관리 칸(sharedMemory) 안이라 클라이언트 저장이 400 으로 막힌다", async () => {
    const h = makeHarness();
    const rejected = await call(h, "POST", "/memories", {
      content: "클라이언트가 철회 표시를 위조하려는 저장", author: OWNER, platform: "dashboard",
      metadata: { sharedMemory: { status: "retracted", invalidatedByRevision: 1 } },
    });
    expect(rejected.status).toBe(400);
    expect(liveNodes(h.db)).toEqual([]);
  }, 60_000);
});
