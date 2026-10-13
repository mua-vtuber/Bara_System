/**
 * memories-edit-attachments.test.ts — 메시지 수정에서 뺀 첨부의 기억 삭제(WP-B1-20U 설계 17.9, Q6 기본값, U7).
 *
 * PATCH /memories/by-source 의 attachmentIds 는 수정 뒤 그 메시지에 남은 첨부 id 전부다. 목록에 없는 첨부의 출처 행은
 * 메시지 삭제와 같은 제거 루틴으로 지워져, 그 첨부의 문서 노드·청크, 문서 기록·원장 행·파일까지 정리된다(assetCleanup,
 * 설계 17.17). 같은 파일을 다른 메시지도 가졌으면 노드와 파일이 남는다. content 와 attachmentIds 중 하나는 있어야 하고,
 * attachmentIds 만 있으면 글 수정은 하지 않는다. expectedRevision 이 어긋난 409 는 첨부도 지우지 않는다.
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 임시 디렉터리의 실제 AssetStore + 실제 Hono 라우트(POST /ingest·/memories,
 * POST /memories/:id/trash, PATCH /memories/by-source). 파일 지우기 함수는 서버 부팅과 같은 installAssetFileRemover 로
 * 넣는다. 모든 제거 뒤 계보·자산 불변식 도우미가 빈 목록이다. mock 0.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssetStore } from "../../assets/asset-store.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { NodeSourceRepository } from "../../db/store-internal/node-source-repository.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { buildMemoryApi } from "../../server.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import type { EditBySourceAttachmentRemoval, EditBySourceResult } from "../../api-client-types.ts";
import { installAssetFileRemover } from "../asset-file-remover-boot.ts";
import { lineageOrphans } from "../../test-utils/lineage-invariant.ts";
import { assetContentFiles, assetInvariantViolations } from "../../test-utils/asset-invariant.ts";

const PLATFORM = "discord";
const DISCORD_SOURCE = "discord-channel";
const CHANNEL_ID = "channel-1";
const GUILD_ID = "guild-1";
const AUTHOR = "owner";
const ATTRIBUTION = { author: AUTHOR, userId: "user-1" };
const JSON_HEADERS = { "content-type": "application/json" };

const TEXT = "이번 주 금요일 저녁 회의는 화상으로 진행한다. 안건은 다음 분기 예산이다.";
const TEXT_EDITED = "이번 주 금요일 저녁 회의는 본사 삼층 회의실에서 진행한다. 안건은 다음 분기 예산이다.";
const NOTE_MD = "# 분기 워크숍 준비 메모\n\n워크숍 장소는 양평 숲속 연수원으로 정했다. 버스는 토요일 아침 일곱시에 출발한다.";
const NOTE_TXT = "주말 등산 계획\n\n토요일 아침 여덟시에 북한산 입구에서 만난다. 점심은 각자 준비한다.";

/** 첨부·글 출처 행 키 — 키 형식은 첫 배포 때 굳으므로 리터럴로 고정한다(설계 17.8). */
const attachmentKey = (messageId: string, attachmentId: string) => `msg:${PLATFORM}:${messageId}:att:${attachmentId}`;
const textKey = (messageId: string) => `msg:${PLATFORM}:${messageId}`;

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
}, 180_000);

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
  dir: string;
}

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "bara-edit-attachments-"));
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  const assetStore = new AssetStore(dir);
  await installAssetFileRemover(store, assetStore);
  const app = buildMemoryApi({
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(),
    assetStore, getSettings: () => settings,
  });
  const h = { app, db, store, dir };
  harnesses.push(h);
  return h;
}

type Json = Record<string, unknown>;

async function call(h: Harness, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await h.app.request(path, {
    method,
    ...(body === undefined ? {} : { headers: JSON_HEADERS, body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() as Json };
}

/** Discord 봇 글 모양(POST /memories, platform discord, metadata 메시지 표시). */
async function postDiscordText(h: Harness, content: string, messageId: string): Promise<number> {
  const res = await call(h, "POST", "/memories", {
    content, platform: PLATFORM, author: AUTHOR, force: true,
    metadata: { source: DISCORD_SOURCE, user_id: ATTRIBUTION.userId, messageId, channelId: CHANNEL_ID, guildId: GUILD_ID },
  });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

interface IngestedFile { documentNodeId: number; chunkIds: number[]; documentId: string; assetSha256: string }

/** 봇 첨부 모양의 .md·.txt 파일(파일 이름이 있어 문서 갈래)과 그 메시지 출처. */
async function ingestAttachment(
  h: Harness, messageId: string, attachmentId: string, name: string, mimeType: string, data: string,
): Promise<IngestedFile> {
  const res = await call(h, "POST", "/ingest", {
    source: DISCORD_SOURCE,
    content: { type: "text", data, mimeType, originalName: name },
    attribution: ATTRIBUTION,
    sourceMessage: { platform: PLATFORM, messageId, channelId: CHANNEL_ID, guildId: GUILD_ID, attachmentId },
  });
  expect(res.status).toBe(201);
  const [documentNodeId, ...chunkIds] = res.body.nodeIds as number[];
  return { documentNodeId: documentNodeId!, chunkIds, documentId: res.body.documentId as string, assetSha256: res.body.assetSha256 as string };
}

async function patchBySource(h: Harness, body: Json): Promise<{ status: number; body: Json }> {
  return call(h, "PATCH", "/memories/by-source", { platform: PLATFORM, editor: "discord-owner", source: PLATFORM, ...body });
}

async function editMessage(h: Harness, body: Json): Promise<EditBySourceResult> {
  const res = await patchBySource(h, body);
  expect(res.status).toBe(200);
  return res.body as unknown as EditBySourceResult;
}

function sourceKeys(db: Database, id: number): string[] {
  return new NodeSourceRepository(db).listSync([id]).get(id)!.map((row) => row.key);
}

function liveIds(db: Database): number[] {
  return (db.query("SELECT id FROM knowledge_nodes ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
}

function archivedIds(db: Database): number[] {
  return (db.query("SELECT id FROM knowledge_nodes_archive ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
}

/** 원장 행의 source_ref(정렬). */
function ledgerRefs(db: Database): string[] {
  return (db.query("SELECT source_ref AS ref FROM asset_file_imports ORDER BY source_ref").all() as Array<{ ref: string }>)
    .map((row) => row.ref);
}

function removal(partial: Partial<EditBySourceAttachmentRemoval>): EditBySourceAttachmentRemoval {
  return {
    removedAttachmentKeys: [], deletedIds: [], derivedDeletedIds: [], keptIds: [], archivePurgedIds: [],
    assetCleanup: { documentIds: [], removedSha256s: [], missingSha256s: [], failed: [] },
    ...partial,
  };
}

function expectInvariants(h: Harness): void {
  expect(lineageOrphans(h.db)).toEqual([]);
  expect(assetInvariantViolations(h.db, h.dir)).toEqual([]);
}

const sortedIds = (ids: readonly number[]) => [...ids].sort((a, b) => a - b);

describe("PATCH /memories/by-source attachmentIds — 수정에서 뺀 첨부", () => {
  test("글 + 첨부 둘(a1, a2)에서 a1 을 빼면 a1 의 문서 노드·청크와 문서 기록·원장 행·파일이 지워지고 a2·글 노드는 그대로다", async () => {
    const h = await makeHarness();
    const textId = await postDiscordText(h, TEXT, "msg-1");
    const a1 = await ingestAttachment(h, "msg-1", "a1", "workshop.md", "text/markdown", NOTE_MD);
    const a2 = await ingestAttachment(h, "msg-1", "a2", "hiking.txt", "text/plain", NOTE_TXT);
    expect(a1.chunkIds.length).toBeGreaterThan(0);
    expect(ledgerRefs(h.db)).toEqual([`document:${a1.documentId}`, `document:${a2.documentId}`].sort());
    expect(assetContentFiles(h.dir)).toEqual([`${a1.assetSha256}.md`, `${a2.assetSha256}.txt`].sort());
    const a2Before = await h.store.getNode(a2.documentNodeId);
    const textBefore = await h.store.getNode(textId);

    const edited = await editMessage(h, { messageId: "msg-1", content: TEXT, attachmentIds: ["a2"] });

    expect(edited.changed).toBe(true);
    expect(edited.editedIds).toEqual([]);
    expect(edited.attachmentRemoval).toEqual(removal({
      removedAttachmentKeys: [attachmentKey("msg-1", "a1")],
      deletedIds: [a1.documentNodeId],
      derivedDeletedIds: sortedIds(a1.chunkIds),
      assetCleanup: { documentIds: [a1.documentId], removedSha256s: [a1.assetSha256], missingSha256s: [], failed: [] },
    }));
    for (const id of [a1.documentNodeId, ...a1.chunkIds]) expect(await h.store.getNode(id)).toBeNull();
    expect(h.store.getDocument(a1.documentId)).toBeNull();
    expect(ledgerRefs(h.db)).toEqual([`document:${a2.documentId}`]);
    expect(assetContentFiles(h.dir)).toEqual([`${a2.assetSha256}.txt`]);

    expect(await h.store.getNode(a2.documentNodeId)).toEqual(a2Before);
    expect(sourceKeys(h.db, a2.documentNodeId)).toEqual([attachmentKey("msg-1", "a2")]);
    expect(h.store.getDocument(a2.documentId)).not.toBeNull();
    expect(await h.store.getNode(textId)).toEqual(textBefore);
    expect(sourceKeys(h.db, textId)).toEqual([textKey("msg-1")]);
    expectInvariants(h);
  }, 120_000);

  test("글이 빈 메시지(첨부만)는 content 없이 attachmentIds 만으로 수정되고 글 수정은 하지 않는다", async () => {
    const h = await makeHarness();
    const a1 = await ingestAttachment(h, "msg-files", "a1", "workshop.md", "text/markdown", NOTE_MD);
    const a2 = await ingestAttachment(h, "msg-files", "a2", "hiking.txt", "text/plain", NOTE_TXT);

    const edited = await editMessage(h, { messageId: "msg-files", attachmentIds: [" a2 "] });

    expect(edited).toMatchObject({ changed: true, matchedCount: 0, editedCount: 0, editedIds: [], skippedIds: [], revisions: [], splits: [] });
    expect(edited.warnings).toEqual([]);
    expect(edited.attachmentRemoval).toMatchObject({
      removedAttachmentKeys: [attachmentKey("msg-files", "a1")], deletedIds: [a1.documentNodeId], keptIds: [],
    });
    expect(edited.attachmentRemoval.assetCleanup.removedSha256s).toEqual([a1.assetSha256]);
    expect(liveIds(h.db)).toEqual(sortedIds([a2.documentNodeId, ...a2.chunkIds]));
    expect(assetContentFiles(h.dir)).toEqual([`${a2.assetSha256}.txt`]);
    expectInvariants(h);

    const again = await editMessage(h, { messageId: "msg-files", attachmentIds: ["a2"] });
    expect(again.changed).toBe(false);
    expect(again.attachmentRemoval).toEqual(removal({}));
  }, 120_000);

  test("content 와 attachmentIds 가 둘 다 없거나 attachmentIds 모양이 틀리면 400 이고 아무것도 지우지 않는다", async () => {
    const h = await makeHarness();
    const a1 = await ingestAttachment(h, "msg-bad", "a1", "workshop.md", "text/markdown", NOTE_MD);
    const before = liveIds(h.db);

    const missing = await patchBySource(h, { messageId: "msg-bad" });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("content or attachmentIds is required");
    for (const attachmentIds of ["a1", [""], [1], null]) {
      const bad = await patchBySource(h, { messageId: "msg-bad", attachmentIds });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe("attachmentIds must be an array of non-empty strings");
    }
    const emptyContent = await patchBySource(h, { messageId: "msg-bad", content: " ", attachmentIds: [] });
    expect(emptyContent.status).toBe(400);
    expect(emptyContent.body.error).toBe("content must be a non-empty string");

    expect(liveIds(h.db)).toEqual(before);
    expect(sourceKeys(h.db, a1.documentNodeId)).toEqual([attachmentKey("msg-bad", "a1")]);
    expect(assetContentFiles(h.dir)).toEqual([`${a1.assetSha256}.md`]);
  }, 120_000);

  test("뺀 첨부의 노드가 휴지통에 있으면 보관표에서 지우고 파일도 지운다", async () => {
    const h = await makeHarness();
    const textId = await postDiscordText(h, TEXT, "msg-trash");
    const a1 = await ingestAttachment(h, "msg-trash", "a1", "workshop.md", "text/markdown", NOTE_MD);
    expect((await call(h, "POST", `/memories/${a1.documentNodeId}/trash`)).status).toBe(200);
    const trashed = archivedIds(h.db);
    expect(trashed).toContain(a1.documentNodeId);
    // 휴지통 이동은 원장을 건드리지 않는다 — 휴지통의 저장도 파일을 붙잡는다.
    expect(ledgerRefs(h.db)).toEqual([`document:${a1.documentId}`]);
    expectInvariants(h);

    const edited = await editMessage(h, { messageId: "msg-trash", content: TEXT, attachmentIds: [] });

    expect(edited.attachmentRemoval).toEqual(removal({
      removedAttachmentKeys: [attachmentKey("msg-trash", "a1")],
      archivePurgedIds: trashed,
      assetCleanup: { documentIds: [a1.documentId], removedSha256s: [a1.assetSha256], missingSha256s: [], failed: [] },
    }));
    expect(archivedIds(h.db)).toEqual([]);
    expect(h.db.query("SELECT COUNT(*) AS c FROM memory_node_sources_archive").get()).toEqual({ c: 0 });
    expect(assetContentFiles(h.dir)).toEqual([]);
    expect(liveIds(h.db)).toEqual([textId]);
    expectInvariants(h);
  }, 120_000);

  test("같은 파일을 다른 메시지도 보냈으면 첨부를 빼도 노드·기록·파일이 남고, 이 메시지 표시만 거둔다", async () => {
    const h = await makeHarness();
    const mine = await ingestAttachment(h, "msg-mine", "a1", "workshop.md", "text/markdown", NOTE_MD);
    const other = await ingestAttachment(h, "msg-other", "b1", "workshop.md", "text/markdown", NOTE_MD);
    expect(other.documentNodeId).toBe(mine.documentNodeId);
    expect((await h.store.getNode(mine.documentNodeId))!.metadata).toMatchObject({ messageId: "msg-mine" });

    const edited = await editMessage(h, { messageId: "msg-mine", attachmentIds: [] });

    expect(edited.attachmentRemoval).toEqual(removal({
      removedAttachmentKeys: [attachmentKey("msg-mine", "a1")], keptIds: [mine.documentNodeId],
    }));
    const kept = (await h.store.getNode(mine.documentNodeId))!;
    expect(kept.content).toBe(NOTE_MD);
    expect(kept.metadata).not.toHaveProperty("messageId");
    expect(sourceKeys(h.db, mine.documentNodeId)).toEqual([attachmentKey("msg-other", "b1")]);
    expect(h.store.getDocument(mine.documentId)).not.toBeNull();
    expect(h.store.getDocument(other.documentId)).not.toBeNull();
    expect(assetContentFiles(h.dir)).toEqual([`${mine.assetSha256}.md`]);
    expectInvariants(h);
  }, 120_000);

  test("뺀 첨부의 노드가 같은 메시지의 글 행도 가졌으면(같은 본문 흡수) 노드와 메시지 표시가 남는다", async () => {
    const h = await makeHarness();
    const doc = await ingestAttachment(h, "msg-same", "a1", "workshop.md", "text/markdown", NOTE_MD);
    expect(await postDiscordText(h, NOTE_MD, "msg-same")).toBe(doc.documentNodeId);
    expect(sourceKeys(h.db, doc.documentNodeId)).toEqual([textKey("msg-same"), attachmentKey("msg-same", "a1")].sort());

    const edited = await editMessage(h, { messageId: "msg-same", attachmentIds: [] });

    expect(edited.attachmentRemoval).toEqual(removal({
      removedAttachmentKeys: [attachmentKey("msg-same", "a1")], keptIds: [doc.documentNodeId],
    }));
    expect(sourceKeys(h.db, doc.documentNodeId)).toEqual([textKey("msg-same")]);
    expect((await h.store.getNode(doc.documentNodeId))!.metadata).toMatchObject({ messageId: "msg-same" });
    expect(assetContentFiles(h.dir)).toEqual([`${doc.assetSha256}.md`]);
    expectInvariants(h);
  }, 120_000);

  test("expectedRevision 이 어긋난 409 는 글도 첨부도 바꾸지 않는다", async () => {
    const h = await makeHarness();
    const textId = await postDiscordText(h, TEXT, "msg-409");
    const a1 = await ingestAttachment(h, "msg-409", "a1", "workshop.md", "text/markdown", NOTE_MD);

    const res = await patchBySource(h, { messageId: "msg-409", content: TEXT_EDITED, expectedRevision: 99, attachmentIds: [] });

    expect(res.status).toBe(409);
    expect((await h.store.getNode(textId))!.content).toBe(TEXT);
    expect(sourceKeys(h.db, a1.documentNodeId)).toEqual([attachmentKey("msg-409", "a1")]);
    expect(assetContentFiles(h.dir)).toEqual([`${a1.assetSha256}.md`]);
  }, 120_000);

  test("글과 첨부를 함께 고치면 글 노드를 같은 id 로 고치고 뺀 첨부를 지운다 — attachmentIds 없는 글 수정은 첨부를 건드리지 않는다", async () => {
    const h = await makeHarness();
    const textId = await postDiscordText(h, TEXT, "msg-both");
    const a1 = await ingestAttachment(h, "msg-both", "a1", "workshop.md", "text/markdown", NOTE_MD);

    const textOnly = await editMessage(h, { messageId: "msg-both", content: TEXT_EDITED });
    expect(textOnly).toMatchObject({ changed: true, editedIds: [textId], skippedIds: [a1.documentNodeId] });
    expect(textOnly.attachmentRemoval).toEqual(removal({}));
    expect(sourceKeys(h.db, a1.documentNodeId)).toEqual([attachmentKey("msg-both", "a1")]);

    // 글 수정이 먼저라 첨부 노드는 글 수정 대상에서 건너뛴 뒤(skippedIds) 첨부 제거가 지운다.
    const both = await editMessage(h, { messageId: "msg-both", content: TEXT, attachmentIds: [] });
    expect(both).toMatchObject({ changed: true, editedIds: [textId], skippedIds: [a1.documentNodeId] });
    expect((await h.store.getNode(textId))!.content).toBe(TEXT);
    expect(both.attachmentRemoval).toMatchObject({
      removedAttachmentKeys: [attachmentKey("msg-both", "a1")], deletedIds: [a1.documentNodeId],
    });
    expect(liveIds(h.db)).toEqual([textId]);
    expect(assetContentFiles(h.dir)).toEqual([]);
    expectInvariants(h);
  }, 120_000);
});
