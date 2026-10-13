/**
 * memories-delete-by-source.sources.test.ts — 메시지 삭제가 출처 행 기준으로 동작한다(WP-B1-20T T4, 설계 5.3·5.5).
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 실제 저장 경로(saveTextInput, builtin regex 양식) + 실제 Hono 라우트
 * (DELETE /memories/by-source, POST /memories/:id/trash, GET /archive, POST /search). 출처 행은 실제
 * NodeSourceRepository 로 읽는다.
 *
 *  - H1: 같은 본문을 두 메시지가 보내면 한 노드에 행 {M1, M2}. M1 삭제 뒤 노드는 남고 검색되며, M2 삭제 뒤
 *    노드와 그 파생(regex 원자)이 모두 지워지고 그 본문은 검색되지 않는다. 일정 입력(본문 없는 #일정)과
 *    엔티티 태그가 붙은 글도 같은 흡수 통로라 같다.
 *  - 보관표 정리(설계 5.5): 원문을 휴지통에 옮긴 뒤 그 메시지를 지우면 원문과 archived_lineage 로 이어진
 *    파생까지 휴지통에서 영구 삭제된다. 다른 메시지 행이 남은 보관 노드는 남는다. 살아 있는 원문이 지워지면
 *    그 원문만 부모로 가졌던 보관 노드도 지워진다.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";

import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { NodeSourceRepository } from "../../db/store-internal/node-source-repository.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { RegexL0Extractor } from "../../memory/regex-l0/extractor.ts";
import { sourceKeyOf, archivedLineageKeyOf } from "../../memory/node-sources/source-ref.ts";
import { buildMemoryApi } from "../../server.ts";
import { saveTextInput } from "../save-input.ts";
import type { AssetCleanup } from "../../api-client-types.ts";

const AUTHOR = "owner";
const PLATFORM = "discord";
const DISCORD_SOURCE = "discord-channel";
/** 실제 builtin regex 양식이 원자를 만드는 문장. */
const REGEX_SENTENCE = "배포 알림은 앞으로 운영팀 채널로 보내기로 확정했다.";

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
  const app = buildMemoryApi({ store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler() });
  const h = { app, db, store };
  harnesses.push(h);
  return h;
}

/** Discord 봇이 보내는 모양 그대로(messageId·channelId·source 칸, regex 켬) 저장한다. */
async function saveDiscord(h: Harness, content: string, messageId: string) {
  const saved = await saveTextInput(h.store, {
    content, source: PLATFORM, author: AUTHOR, force: true,
    extraMetadata: { messageId, channelId: "channel-1", source: DISCORD_SOURCE },
    regexL0: new RegexL0Extractor({ patternPaths: [], boosterPaths: [], userRepo: undefined, langs: ["ko"] }),
    regexEnabled: true,
  });
  return { origin: saved.originNodeId!, regexAtoms: saved.extracted, reused: saved.cacheHit };
}

interface DeleteBody {
  messageId: string;
  platform: string | null;
  deletedCount: number;
  deletedIds: number[];
  derivedDeletedIds: number[];
  keptIds: number[];
  archivePurgedIds: number[];
  revisionBodiesCleared: number;
  retractedDerivedDeletedIds: number[];
  assetCleanup: AssetCleanup;
}

async function deleteMessage(h: Harness, messageId: string): Promise<DeleteBody> {
  const res = await h.app.request(`/memories/by-source?messageId=${messageId}&platform=${PLATFORM}`, { method: "DELETE" });
  expect(res.status).toBe(200);
  return await res.json() as DeleteBody;
}

async function trash(h: Harness, id: number): Promise<number[]> {
  const res = await h.app.request(`/memories/${id}/trash`, { method: "POST" });
  expect(res.status).toBe(200);
  return (await res.json() as { cascadeTrashedIds: number[] }).cascadeTrashedIds;
}

async function search(h: Harness, query: string): Promise<Array<{ id: number; content: string }>> {
  const res = await h.app.request("/search", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, limit: 20 }),
  });
  expect(res.status).toBe(200);
  return (await res.json() as { results: Array<{ id: number; content: string }> }).results;
}

/** 지운 본문이 검색 결과에도, 저장소에도 남지 않았다. */
async function expectTextGone(h: Harness, content: string, removedIds: readonly number[]): Promise<void> {
  const results = await search(h, content);
  expect(results.filter((r) => r.content === content)).toEqual([]);
  expect(results.filter((r) => removedIds.includes(r.id))).toEqual([]);
  expect((h.db.query("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE content = ?").get(content) as { n: number }).n).toBe(0);
}

function liveIds(db: Database): number[] {
  return (db.query("SELECT id FROM knowledge_nodes ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
}

function archivedIds(db: Database): number[] {
  return (db.query("SELECT id FROM knowledge_nodes_archive ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
}

function sourceKeys(db: Database, id: number): string[] {
  return new NodeSourceRepository(db).listSync([id]).get(id)!.map((row) => row.key);
}

function archivedSourceKeys(db: Database, id: number): string[] {
  return (db.query("SELECT source_key FROM memory_node_sources_archive WHERE node_id = ? ORDER BY source_key")
    .all(id) as Array<{ source_key: string }>).map((r) => r.source_key);
}

const messageKey = (messageId: string) => sourceKeyOf({ kind: "message", platform: PLATFORM, messageId });
const ascending = (ids: readonly number[]) => [...ids].sort((a, b) => a - b);

describe("H1 — 같은 본문을 보낸 두 메시지", () => {
  test("M1 삭제 뒤 노드는 남고 검색되며, M2 삭제 뒤 노드와 regex 원자가 지워지고 검색 0건", async () => {
    const h = makeHarness();
    const first = await saveDiscord(h, REGEX_SENTENCE, "msg-h1-a");
    expect(first.regexAtoms.length).toBeGreaterThan(0);
    const second = await saveDiscord(h, REGEX_SENTENCE, "msg-h1-b");
    expect(second).toMatchObject({ origin: first.origin, reused: true });
    expect(sourceKeys(h.db, first.origin)).toEqual([messageKey("msg-h1-a"), messageKey("msg-h1-b")]);

    const firstDelete = await deleteMessage(h, "msg-h1-a");
    expect(firstDelete).toEqual({
      deletedCount: 0, deletedIds: [], derivedDeletedIds: [], keptIds: [first.origin], archivePurgedIds: [],
      messageId: "msg-h1-a", platform: PLATFORM, revisionBodiesCleared: 0, retractedDerivedDeletedIds: [],
      // WP-B1-20U 설계 17.17 — 문서·이미지 노드가 없어 해제한 첨부가 없다.
      assetCleanup: { documentIds: [], removedSha256s: [], missingSha256s: [], failed: [] },
    });
    expect(sourceKeys(h.db, first.origin)).toEqual([messageKey("msg-h1-b")]);
    expect(liveIds(h.db)).toEqual(ascending([first.origin, ...first.regexAtoms]));
    expect((await search(h, REGEX_SENTENCE)).map((r) => r.id)).toContain(first.origin);
    // 남는 원문은 지운 메시지의 표시를 더는 갖지 않는다(설계 5.3 3단계).
    expect((await h.store.getNode(first.origin))!.metadata).not.toHaveProperty("messageId");

    const secondDelete = await deleteMessage(h, "msg-h1-b");
    expect(secondDelete).toMatchObject({
      deletedCount: 1, deletedIds: [first.origin], derivedDeletedIds: ascending(first.regexAtoms), keptIds: [],
      archivePurgedIds: [],
    });
    expect(liveIds(h.db)).toEqual([]);
    await expectTextGone(h, REGEX_SENTENCE, [first.origin, ...first.regexAtoms]);

    // 같은 삭제를 다시 받아도 아무것도 일치하지 않는다.
    expect(await deleteMessage(h, "msg-h1-b")).toMatchObject({ deletedIds: [], keptIds: [], archivePurgedIds: [] });
  }, 120_000);

  test("두 원문이 공유한 regex 원자도 두 메시지가 모두 지워질 때 지워지고 검색 0건", async () => {
    const h = makeHarness();
    const a = await saveDiscord(h, REGEX_SENTENCE, "msg-atom-a");
    const b = await saveDiscord(h, `회의 결론으로 ${REGEX_SENTENCE}`, "msg-atom-b");
    const shared = a.regexAtoms.filter((id) => b.regexAtoms.includes(id));
    expect(shared.length).toBeGreaterThan(0);
    const sharedContents = (await h.store.getNodesByIds(shared)).map((node) => node.content);

    const first = await deleteMessage(h, "msg-atom-a");
    expect(first.deletedIds).toEqual([a.origin]);
    expect(first.derivedDeletedIds).toEqual(ascending(a.regexAtoms.filter((id) => !shared.includes(id))));
    for (const content of sharedContents) {
      const hits = (await search(h, content)).map((r) => r.id);
      expect(shared.some((id) => hits.includes(id))).toBe(true);
    }

    const second = await deleteMessage(h, "msg-atom-b");
    expect(second.deletedIds).toEqual([b.origin]);
    expect(second.derivedDeletedIds).toEqual(expect.arrayContaining(shared));
    expect(liveIds(h.db)).toEqual([]);
    for (const content of sharedContents) await expectTextGone(h, content, shared);
  }, 120_000);

  test("일정 입력(본문 없는 #일정)의 두 메시지 — M1 삭제 뒤 남고, M2 삭제 뒤 지워지고 검색 0건", async () => {
    const h = makeHarness();
    const input = "#일정:정기 치과 검진 #날짜:내일";
    const first = await saveDiscord(h, input, "msg-schedule-a");
    const schedule = (await h.store.getNode(first.origin))!;
    expect(schedule.content).toBe("정기 치과 검진");
    expect((await saveDiscord(h, input, "msg-schedule-b")).origin).toBe(first.origin);

    expect(await deleteMessage(h, "msg-schedule-a")).toMatchObject({ deletedIds: [], keptIds: [first.origin] });
    expect((await search(h, schedule.content)).map((r) => r.id)).toContain(first.origin);

    expect(await deleteMessage(h, "msg-schedule-b")).toMatchObject({ deletedIds: [first.origin], keptIds: [] });
    await expectTextGone(h, schedule.content, [first.origin]);
  }, 120_000);

  test("엔티티 태그가 붙은 글의 두 메시지 — M1 삭제 뒤 남고, M2 삭제 뒤 지워지고 검색 0건", async () => {
    const h = makeHarness();
    // 본문이 앞에 오는 글 — 태그만 앞선 `#인물:대상 ...` 은 노드 없는 엔티티 프로필 패치 갈래다.
    const input = "김민수는 아침마다 따뜻한 보리차를 마신다 #인물:김민수";
    const first = await saveDiscord(h, input, "msg-entity-a");
    expect(first.origin).toBeGreaterThan(0);
    const origin = (await h.store.getNode(first.origin))!;
    expect((await saveDiscord(h, input, "msg-entity-b")).origin).toBe(first.origin);
    expect(sourceKeys(h.db, first.origin)).toEqual([messageKey("msg-entity-a"), messageKey("msg-entity-b")]);

    expect(await deleteMessage(h, "msg-entity-a")).toMatchObject({ deletedIds: [], keptIds: [first.origin] });
    expect((await search(h, "김민수 보리차")).map((r) => r.id)).toContain(first.origin);

    const second = await deleteMessage(h, "msg-entity-b");
    expect(second.deletedIds).toEqual([first.origin]);
    expect(liveIds(h.db)).toEqual([]);
    await expectTextGone(h, origin.content, [first.origin, ...second.derivedDeletedIds]);
  }, 120_000);
});

describe("보관표 정리 (설계 5.5)", () => {
  test("휴지통으로 옮긴 원문의 메시지를 지우면 원문과 archived_lineage 로 이어진 파생까지 영구 삭제된다", async () => {
    const h = makeHarness();
    const discord = await saveDiscord(h, REGEX_SENTENCE, "msg-archived");
    expect(await trash(h, discord.origin)).toEqual(ascending(discord.regexAtoms));
    expect(archivedIds(h.db)).toEqual(ascending([discord.origin, ...discord.regexAtoms]));
    // 원문의 메시지 행은 보관 출처 표로 옮겨지고, 행 없는 파생은 그 순간의 계보 부모를 기록한다(설계 5.4).
    expect(archivedSourceKeys(h.db, discord.origin)).toEqual([messageKey("msg-archived")]);
    for (const id of discord.regexAtoms) {
      expect(archivedSourceKeys(h.db, id)).toEqual([archivedLineageKeyOf(discord.origin)]);
    }

    const body = await deleteMessage(h, "msg-archived");
    expect(body).toMatchObject({
      deletedIds: [], derivedDeletedIds: [], keptIds: [],
      archivePurgedIds: ascending([discord.origin, ...discord.regexAtoms]),
    });
    expect(archivedIds(h.db)).toEqual([]);
    expect((h.db.query("SELECT COUNT(*) AS n FROM memory_node_sources_archive").get() as { n: number }).n).toBe(0);
    const archive = await h.app.request("/archive");
    expect(await archive.json()).toMatchObject({ archive: [], total: 0 });
  }, 120_000);

  test("다른 메시지 행이 남은 보관 노드는 남고, 그 메시지까지 지우면 지워진다", async () => {
    const h = makeHarness();
    const content = "두 메시지가 보낸 글을 휴지통에 넣었다";
    const first = await saveDiscord(h, content, "msg-archived-a");
    expect((await saveDiscord(h, content, "msg-archived-b")).origin).toBe(first.origin);
    await trash(h, first.origin);

    expect(await deleteMessage(h, "msg-archived-a")).toMatchObject({ archivePurgedIds: [] });
    expect(archivedIds(h.db)).toContain(first.origin);
    expect(archivedSourceKeys(h.db, first.origin)).toEqual([messageKey("msg-archived-b")]);

    expect((await deleteMessage(h, "msg-archived-b")).archivePurgedIds).toEqual(
      expect.arrayContaining([first.origin]),
    );
    expect(archivedIds(h.db)).not.toContain(first.origin);
  }, 120_000);

  test("살아 있는 원문이 메시지 삭제로 지워지면, 그 원문만 부모로 두고 휴지통에 있던 파생도 지워진다", async () => {
    const h = makeHarness();
    const discord = await saveDiscord(h, REGEX_SENTENCE, "msg-live-origin");
    const [trashedAtom, ...liveAtoms] = discord.regexAtoms;
    expect(await trash(h, trashedAtom!)).toEqual([]);
    expect(archivedSourceKeys(h.db, trashedAtom!)).toEqual([archivedLineageKeyOf(discord.origin)]);

    const body = await deleteMessage(h, "msg-live-origin");
    expect(body).toMatchObject({
      deletedIds: [discord.origin], derivedDeletedIds: ascending(liveAtoms), archivePurgedIds: [trashedAtom!],
    });
    expect(archivedIds(h.db)).toEqual([]);
    expect(liveIds(h.db)).toEqual([]);
  }, 120_000);
});
