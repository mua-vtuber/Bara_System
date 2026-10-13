/**
 * archive-restore.race.test.ts — 휴지통 복원과 메시지 삭제의 경쟁(WP-B1-20U 설계 17.4, U2).
 *
 * 옛 복원은 보관 행을 읽고 임베딩을 기다리는 동안 쓰기 잠금 밖에 있었다. 그 사이 메시지 삭제가 보관 노드를
 * 영구 삭제해도 먼저 읽은 행으로 노드를 되살리고, 되돌릴 출처 행이 없으니 restore: 출처 행까지 붙였다(지운
 * 메시지 본문 부활, QA 재현). 같은 id 복원 두 건이 겹치면 두 번째가 기본 키 충돌로 500 이었다. 이제 임베딩은
 * 잠금 밖, 잠금 안 한 트랜잭션에서 보관 행을 다시 읽어 스냅샷과 견준다: 없으면 404, 본문이나 보관 시각이
 * 바뀌었으면 409(ArchivedNodeChangedError), 같으면 복원하고 검색 캐시 키(dbRevision)를 올린다.
 *
 * 순서 고정(잠깐 기다리기로 순서를 맞추지 않는다): 테스트가 쓰기 잠금을 쥐고, 그 안에서 복원 요청을 잠금 밖
 * 흐름으로 보낸다(outsideMemoryMutationContext). 복원은 요청을 보낸 그 자리에서(첫 await 전) 보관 행 스냅샷을
 * 읽으므로, 이어서 잠금 안에서 하는 메시지 삭제·보관 행 교체는 늘 스냅샷 뒤이고 복원의 잠금 안 단계 앞이다.
 * 스냅샷이 정말 그 자리에서 읽힌다는 것은 409 테스트가 드러낸다 — 교체 뒤에 읽었다면 409 가 아니라 200 이다.
 *
 * Real bun:sqlite(:memory:) + real bge-m3 + 실제 라우트(buildMemoryApi) + 실제 검색 캐시(SearchCache). mock 0.
 * 보관 시각만 바꾸는 한 경우는 실제 보관 행 칸을 SQL 로 고치는 데이터 픽스처다.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";

import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { SearchCache } from "../../memory/search-cache.ts";
import { outsideMemoryMutationContext, withMemoryMutationLock } from "../../memory/shared-memory-mutation-lock.ts";
import { sourceKeyOf } from "../../memory/node-sources/source-ref.ts";
import { buildMemoryApi } from "../../server.ts";
import { lineageOrphans } from "../../test-utils/lineage-invariant.ts";

const OWNER = "owner";
const PLATFORM = "discord";
/** QA 재현 원문 — 메시지 삭제 뒤 어디에도 남으면 안 되는 본문. */
const ORIGIN_TEXT = "경합 시험 원문은 비밀 회의 장소가 지하 이층이라는 내용이다";
/** 초기화 뒤 같은 번호로 휴지통에 들어가는 다른 기억. */
const REPLACEMENT_TEXT = "초기화 뒤 같은 번호로 휴지통에 들어간 다른 기억이다";
/** 보관 시각만 바꾸는 데이터 픽스처 값 — 실제 보관 시각과 다른 과거 시각. */
const OTHER_ARCHIVED_AT = "2020-01-01 00:00:00";
const NOT_FOUND = { error: "archived node not found" };

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
}

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.db.close();
});

function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const app = buildMemoryApi({
    store,
    retriever: new HybridRetriever(store, embedder),
    assembler: new ContextAssembler(),
    searchCache: new SearchCache(),
  });
  const h = { app, db, store };
  harnesses.push(h);
  return h;
}

type Json = Record<string, unknown>;
interface Reply { status: number; body: Json }

async function call(h: Harness, method: string, path: string, body?: unknown): Promise<Reply> {
  const res = await h.app.request(path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() as Json };
}

/** Discord 메시지 저장 → 원문 노드 id(추출기 없음 — 노드 하나). */
async function saveDiscordMessage(h: Harness, messageId: string): Promise<number> {
  const saved = await call(h, "POST", "/memories", {
    content: ORIGIN_TEXT,
    author: OWNER,
    platform: PLATFORM,
    metadata: { messageId, channelId: "c1", guildId: "g1", source: "discord-channel" },
  });
  expect(saved.status).toBe(201);
  const origin = saved.body.id as number;
  expect(liveIds(h.db)).toEqual([origin]);
  expect(sourceKeys(h.db, origin)).toEqual([messageKey(messageId)]);
  return origin;
}

async function trash(h: Harness, id: number): Promise<void> {
  const trashed = await call(h, "POST", `/memories/${id}/trash`);
  expect(trashed).toEqual({ status: 200, body: { trashed: id, cascadeTrashedIds: [] } });
  expect(archivedIds(h.db)).toEqual([id]);
  expect(lineageOrphans(h.db)).toEqual([]);
}

const restore = (h: Harness, id: number) => call(h, "POST", `/archive/${id}/restore`);
const dropMessage = (h: Harness, messageId: string) =>
  call(h, "DELETE", `/memories/by-source?messageId=${messageId}&platform=${PLATFORM}`);

/**
 * 쓰기 잠금을 쥔 채 그 안에서 복원 요청을 잠금 밖 흐름으로 보내고(보내는 그 자리에서 보관 행 스냅샷을 읽는다),
 * 이어서 lockedWork 를 잠금 안에서 한다. 잠금을 놓은 뒤에야 복원이 잠금 안 단계에 든다.
 */
async function restoreAroundLockedWork<T>(
  h: Harness,
  id: number,
  lockedWork: () => Promise<T>,
): Promise<{ restored: Reply; worked: T }> {
  let restoring: Promise<Reply> | undefined;
  const worked = await withMemoryMutationLock(h.store, async () => {
    restoring = outsideMemoryMutationContext(() => restore(h, id));
    return lockedWork();
  });
  if (restoring === undefined) throw new Error("복원 요청이 잠금 안에서 시작되지 않았습니다");
  return { restored: await restoring, worked };
}

function liveIds(db: Database): number[] {
  return (db.query("SELECT id FROM knowledge_nodes ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
}

function archivedIds(db: Database): number[] {
  return (db.query("SELECT id FROM knowledge_nodes_archive ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
}

function sourceKeys(db: Database, id: number): string[] {
  return (db.query("SELECT source_key FROM memory_node_sources WHERE node_id = ? ORDER BY source_key")
    .all(id) as Array<{ source_key: string }>).map((r) => r.source_key);
}

function restoreRowCount(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM memory_node_sources WHERE kind = 'restore'").get() as { n: number }).n;
}

function textCount(db: Database, text: string): { live: number; archive: number } {
  const like = `%${text}%`;
  return {
    live: (db.query("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE content LIKE ?").get(like) as { n: number }).n,
    archive: (db.query("SELECT COUNT(*) AS n FROM knowledge_nodes_archive WHERE content LIKE ?").get(like) as { n: number }).n,
  };
}

async function searchContents(h: Harness, query: string): Promise<string[]> {
  const res = await call(h, "POST", "/search", { query, limit: 30 });
  expect(res.status).toBe(200);
  return (res.body.results as Array<{ content: string }>).map((r) => r.content);
}

/** 지운 메시지 본문이 살아 있는 노드·휴지통 어디에도 없고, restore: 행도 없고, 불변식이 선다. */
function expectMessageTextGone(db: Database): void {
  expect(textCount(db, ORIGIN_TEXT)).toEqual({ live: 0, archive: 0 });
  expect(restoreRowCount(db)).toBe(0);
  expect(lineageOrphans(db)).toEqual([]);
}

const messageKey = (messageId: string) => sourceKeyOf({ kind: "message", platform: PLATFORM, messageId });

describe("휴지통 복원과 메시지 삭제의 경쟁", () => {
  test("QA 재현 — 복원과 메시지 삭제를 함께 보내면 어느 순서로 끝나든 지운 메시지 본문이 되살아나지 않는다", async () => {
    const h = makeHarness();
    const origin = await saveDiscordMessage(h, "m-race");
    await trash(h, origin);

    const [restored, dropped] = await Promise.all([restore(h, origin), dropMessage(h, "m-race")]);
    expect(dropped.status).toBe(200);
    expect([200, 404]).toContain(restored.status);
    expect(liveIds(h.db)).toEqual([]);
    expect(archivedIds(h.db)).toEqual([]);
    expectMessageTextGone(h.db);
  }, 120_000);

  test("순서 고정 — 복원이 스냅샷을 읽은 뒤 잠금에 들기 전에 메시지 삭제가 끝나면 404, 아무것도 쓰지 않는다", async () => {
    const h = makeHarness();
    const origin = await saveDiscordMessage(h, "m-ordered");
    await trash(h, origin);

    const { restored, worked } = await restoreAroundLockedWork(h, origin, async () => {
      const dropped = await dropMessage(h, "m-ordered");
      expectMessageTextGone(h.db);
      return { dropped, revision: h.store.getDbRevision() };
    });
    expect(worked.dropped).toEqual({
      status: 200,
      body: {
        messageId: "m-ordered", platform: PLATFORM, deletedCount: 0,
        deletedIds: [], derivedDeletedIds: [], keptIds: [], archivePurgedIds: [origin],
        revisionBodiesCleared: 0, retractedDerivedDeletedIds: [],
        // WP-B1-20U 설계 17.17 — 문서·이미지 노드가 없어 해제한 첨부가 없다.
        assetCleanup: { documentIds: [], removedSha256s: [], missingSha256s: [], failed: [] },
      },
    });
    expect(restored).toEqual({ status: 404, body: NOT_FOUND });
    expect(h.store.getDbRevision()).toBe(worked.revision);
    expect(liveIds(h.db)).toEqual([]);
    expect(archivedIds(h.db)).toEqual([]);
    expectMessageTextGone(h.db);
  }, 120_000);

  test("반대 순서 — 복원이 먼저 끝나면 200(메시지 출처 행이 돌아오고 검색 캐시 키가 올라감), 이어진 메시지 삭제가 지운다", async () => {
    const h = makeHarness();
    const origin = await saveDiscordMessage(h, "m-reverse");
    await trash(h, origin);
    // 휴지통에 있는 동안의 검색 결과가 지금 캐시 키로 캐시된다.
    expect(await searchContents(h, ORIGIN_TEXT)).not.toContain(ORIGIN_TEXT);
    const revisionBefore = h.store.getDbRevision();

    const restored = await restore(h, origin);
    expect(restored.status).toBe(200);
    expect((restored.body.restored as { id: number; content: string })).toMatchObject({ id: origin, content: ORIGIN_TEXT });
    expect(h.store.getDbRevision()).toBeGreaterThan(revisionBefore);
    expect(sourceKeys(h.db, origin)).toEqual([messageKey("m-reverse")]);
    expect(restoreRowCount(h.db)).toBe(0);
    expect(archivedIds(h.db)).toEqual([]);
    expect(lineageOrphans(h.db)).toEqual([]);
    // 캐시 키가 올라 같은 검색이 캐시된 옛 결과가 아니라 되살린 기억을 찾는다.
    expect(await searchContents(h, ORIGIN_TEXT)).toContain(ORIGIN_TEXT);

    const dropped = await dropMessage(h, "m-reverse");
    expect(dropped.body).toMatchObject({ deletedIds: [origin], derivedDeletedIds: [], keptIds: [], archivePurgedIds: [] });
    expect(liveIds(h.db)).toEqual([]);
    expectMessageTextGone(h.db);
  }, 120_000);

  test("같은 id 복원 두 건이 겹치면 200 하나·404 하나 — 기본 키 충돌 500 없음", async () => {
    const h = makeHarness();
    const origin = await saveDiscordMessage(h, "m-twice");
    await trash(h, origin);
    const revisionBefore = h.store.getDbRevision();

    const replies = await Promise.all([restore(h, origin), restore(h, origin)]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 404]);
    expect(replies.find((reply) => reply.status === 404)?.body).toEqual(NOT_FOUND);
    expect(h.store.getDbRevision()).toBe(revisionBefore + 1);
    expect(liveIds(h.db)).toEqual([origin]);
    expect(sourceKeys(h.db, origin)).toEqual([messageKey("m-twice")]);
    expect(archivedIds(h.db)).toEqual([]);
    expect(lineageOrphans(h.db)).toEqual([]);
  }, 120_000);
});

describe("복원 준비 뒤 같은 번호의 보관 행이 바뀌면 409", () => {
  test("초기화 뒤 같은 번호로 다른 기억이 휴지통에 들어오면 409(기억 번호와 다시 시도 안내), 아무것도 쓰지 않는다", async () => {
    const h = makeHarness();
    const origin = await saveDiscordMessage(h, "m-reused");
    await trash(h, origin);

    const { restored, worked } = await restoreAroundLockedWork(h, origin, async () => {
      h.store.resetAllMemory();
      const replacement = await h.store.addNode({ content: REPLACEMENT_TEXT, author: OWNER, platform: "dashboard" });
      expect((await h.store.trashNodes([replacement], "cascade")).movedIds).toEqual([replacement]);
      return { replacement, revision: h.store.getDbRevision() };
    });
    expect(worked.replacement).toBe(origin);
    expect(restored.status).toBe(409);
    expect(restored.body.error).toContain(`기억 ${origin}`);
    expect(restored.body.error).toContain("다시 시도");
    expect(h.store.getDbRevision()).toBe(worked.revision);
    expect(liveIds(h.db)).toEqual([]);
    expect(archivedIds(h.db)).toEqual([origin]);
    expect(textCount(h.db, REPLACEMENT_TEXT)).toEqual({ live: 0, archive: 1 });
    expectMessageTextGone(h.db);
  }, 120_000);

  test("본문이 같아도 보관 시각이 바뀌었으면 409, 다시 시도하면 200", async () => {
    const h = makeHarness();
    const origin = await saveDiscordMessage(h, "m-rearchived");
    await trash(h, origin);

    const { restored } = await restoreAroundLockedWork(h, origin, async () => {
      h.db.query("UPDATE knowledge_nodes_archive SET archived_at = ? WHERE id = ?").run(OTHER_ARCHIVED_AT, origin);
    });
    expect(restored.status).toBe(409);
    expect(restored.body.error).toContain(`기억 ${origin}`);
    expect(liveIds(h.db)).toEqual([]);
    expect(archivedIds(h.db)).toEqual([origin]);
    expect(lineageOrphans(h.db)).toEqual([]);

    const retried = await restore(h, origin);
    expect(retried.status).toBe(200);
    expect(liveIds(h.db)).toEqual([origin]);
    expect(sourceKeys(h.db, origin)).toEqual([messageKey("m-rearchived")]);
    expect(archivedIds(h.db)).toEqual([]);
    expect(lineageOrphans(h.db)).toEqual([]);
  }, 120_000);
});
