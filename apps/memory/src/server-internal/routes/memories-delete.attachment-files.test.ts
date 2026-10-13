/**
 * memories-delete.attachment-files.test.ts — 메시지를 지우면 그 첨부 파일과 기록·원장 행도 지워진다(WP-B1-20U 설계 17.17,
 * Q5 확정, U9a).
 *
 * QA 재현: "메시지를 지워도 content/ 의 파일과 documents·asset_* 행이 남는다." 이제 메시지 삭제(DELETE
 * /memories/by-source)가 영구 삭제한 문서·이미지 노드가 주인인 문서 기록(documents 행)과 원장 행(asset_file_imports,
 * source_ref `document:<id>`/`image:<node_id>`)을 같은 트랜잭션에서 지우고, 커밋 뒤 같은 쓰기 잠금 안에서 참조를 모두
 * 잃은 sha 의 파일과 asset_files 행을 지운다. 같은 파일을 다른 저장(다른 메시지·대시보드·휴지통의 저장)이 쓰면 남는다.
 * 파일 지우기 실패는 응답 assetCleanup.failed 에 경로·원인으로 알리고 행을 대기로 남겨, 서버 시작 때 다시 지운다.
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 실제 SigLIP + 임시 디렉터리의 실제 AssetStore + 실제 Hono 라우트(POST /ingest,
 * POST /memories/:id/trash, DELETE /memories/by-source, GET /assets/:sha). 파일 지우기 함수는 서버 부팅과 같은
 * installAssetFileRemover 로 넣는다. 실패는 가짜 AssetStore 가 아니라 실제 조건(파일 자리의 비어 있지 않은 디렉터리,
 * 함수를 넣지 않은 저장소)으로 만든다. 모든 제거 뒤 계보·자산 불변식 도우미가 빈 목록이다. mock 0.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssetStore, assetSha256 } from "../../assets/asset-store.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { ASSET_FILE_REMOVER_MISSING } from "../../db/store-internal/asset-release.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { createImageEmbedder } from "../../embedding/factory.ts";
import type { ImageEmbedder } from "../../embedding/types.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { buildMemoryApi } from "../../server.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import type { AssetCleanup, DeleteBySourceResult } from "../../api-client-types.ts";
import { ensureAssetFolderPairing, installAssetFileRemover } from "../asset-file-remover-boot.ts";
import { lineageOrphans } from "../../test-utils/lineage-invariant.ts";
import { assetContentFiles, assetInvariantViolations } from "../../test-utils/asset-invariant.ts";

const PLATFORM = "discord";
const DISCORD_SOURCE = "discord-channel";
const DASHBOARD_SOURCE = "dashboard:manual";
const ATTRIBUTION = { author: "owner", userId: "user-1" };
const JSON_HEADERS = { "content-type": "application/json" };

const NOTE_TXT = "주말 등산 계획\n\n토요일 아침 여덟시에 북한산 입구에서 만난다. 점심은 각자 준비한다.";
const NOTE_MD = "# 독서 모임 메모\n\n다음 모임 책은 '코스모스'이고, 장소는 시립도서관 세미나실이다.";
const PNG_FIXTURE = join(import.meta.dir, "..", "..", "memory", "image-preserve", "__fixtures__", "static-small.png");

let embedder: Bgem3Embedder;
let imageEmbedder: ImageEmbedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
  imageEmbedder = createImageEmbedder();
}, 180_000);

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
  assetStore: AssetStore;
  dir: string;
  settings: MemorySettings;
}

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

/** remover = false 면 파일 지우기 함수를 넣지 않은 저장소(createMemoryApi 밖에서 연 저장소, 설계 17.17 한계 3). */
async function makeHarness(opts: { remover?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "bara-attachment-files-"));
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  const assetStore = new AssetStore(dir);
  // remover 없는 저장소도 실제 부팅처럼 첨부를 저장하기 전에 DB·첨부 폴더 짝을 먼저 맺는다(설계 17.19 설계 4).
  if (opts.remover !== false) await installAssetFileRemover(store, assetStore);
  else await ensureAssetFolderPairing(store, assetStore);
  const app = buildMemoryApi({
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(),
    assetStore, imageEmbedder, getSettings: () => settings,
  });
  const h = { app, db, store, assetStore, dir, settings };
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

function sourceMessage(messageId: string, attachmentId: string): Json {
  return { platform: PLATFORM, messageId, channelId: "channel-1", guildId: "guild-1", attachmentId };
}

/** 봇 첨부 모양의 .txt·.md 파일(파일 이름이 있어 문서 갈래). message 가 없으면 대시보드 저장. */
async function ingestTextFile(
  h: Harness, name: string, mimeType: string, data: string, message?: Json,
): Promise<{ documentNodeId: number; documentId: string; assetSha256: string }> {
  const res = await call(h, "POST", "/ingest", {
    source: message ? DISCORD_SOURCE : DASHBOARD_SOURCE,
    content: { type: "text", data, mimeType, originalName: name },
    attribution: ATTRIBUTION,
    ...(message ? { sourceMessage: message } : {}),
  });
  expect(res.status).toBe(201);
  return {
    documentNodeId: (res.body.nodeIds as number[])[0]!,
    documentId: res.body.documentId as string,
    assetSha256: res.body.assetSha256 as string,
  };
}

interface IngestedImage { nodeId: number; assetSha256: string; thumbSha256: string }

/** PNG 이미지 입력. message 가 없으면 대시보드 저장. */
async function ingestImage(h: Harness, message?: Json): Promise<IngestedImage> {
  const res = await call(h, "POST", "/ingest", {
    source: message ? DISCORD_SOURCE : DASHBOARD_SOURCE,
    content: { type: "image", data: readFileSync(PNG_FIXTURE).toString("base64"), mimeType: "image/png", originalName: "plant.png" },
    attribution: ATTRIBUTION,
    ...(message ? { sourceMessage: message } : {}),
  });
  expect(res.status).toBe(201);
  const [image] = res.body.images as IngestedImage[];
  return image!;
}

async function deleteMessage(h: Harness, messageId: string): Promise<DeleteBySourceResult> {
  const res = await call(h, "DELETE", `/memories/by-source?messageId=${messageId}&platform=${PLATFORM}`);
  expect(res.status).toBe(200);
  return res.body as unknown as DeleteBySourceResult;
}

async function trash(h: Harness, id: number): Promise<void> {
  expect((await call(h, "POST", `/memories/${id}/trash`)).status).toBe(200);
}

function count(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

/** 자산 표 네 개의 행 수 — 문서 기록·원장·파일 행·이미지 행. */
function assetRowCounts(db: Database): Record<string, number> {
  return {
    documents: count(db, "documents"),
    asset_file_imports: count(db, "asset_file_imports"),
    asset_files: count(db, "asset_files"),
    images: count(db, "images"),
  };
}

const NO_ASSET_ROWS = { documents: 0, asset_file_imports: 0, asset_files: 0, images: 0 };

/** 원장 행(asset_sha256 → source_ref 목록, 정렬). */
function ledger(db: Database): Array<{ sha: string; ref: string }> {
  return db.query("SELECT asset_sha256 AS sha, source_ref AS ref FROM asset_file_imports ORDER BY asset_sha256, source_ref")
    .all() as Array<{ sha: string; ref: string }>;
}

function expectInvariants(h: Harness, pendingSha256s: readonly string[] = []): void {
  expect(lineageOrphans(h.db)).toEqual([]);
  expect(assetInvariantViolations(h.db, h.dir, pendingSha256s)).toEqual([]);
}

function cleanup(partial: Partial<AssetCleanup>): AssetCleanup {
  return { documentIds: [], removedSha256s: [], missingSha256s: [], failed: [], ...partial };
}

/** content/ 훑기가 지울 것도 알릴 것도 없을 때의 결과(시작 정리 반환값의 strayFiles). */
const NO_STRAY_FILES = { removed: [], failed: [], unrecognized: [] };

const sortedShas = (...shas: string[]) => [...new Set(shas)].sort();

describe("메시지 삭제 — 첨부 문서 파일과 기록", () => {
  test("QA 재현: .txt 첨부 메시지를 지우면 content/ 의 파일과 documents·asset_* 행이 모두 지워진다({sha}.md 사본은 처음부터 없다)", async () => {
    const h = await makeHarness();
    const doc = await ingestTextFile(h, "hiking.txt", "text/plain", NOTE_TXT, sourceMessage("msg-txt", "att-txt"));

    // 한 sha 에 디스크 파일 하나 — 변환본이 원본과 sha 가 같아 `.md` 사본을 쓰지 않는다.
    expect(assetContentFiles(h.dir)).toEqual([`${doc.assetSha256}.txt`]);
    expect(ledger(h.db)).toEqual([{ sha: doc.assetSha256, ref: `document:${doc.documentId}` }]);
    expectInvariants(h);

    const deleted = await deleteMessage(h, "msg-txt");

    expect(deleted.deletedIds).toEqual([doc.documentNodeId]);
    expect(deleted.assetCleanup).toEqual(cleanup({ documentIds: [doc.documentId], removedSha256s: [doc.assetSha256] }));
    expect(assetContentFiles(h.dir)).toEqual([]);
    expect(assetRowCounts(h.db)).toEqual(NO_ASSET_ROWS);
    expectInvariants(h);
  }, 120_000);

  test("같은 .md 를 두 메시지가 보내 문서 노드가 흡수되면, 하나를 지워도 모두 남고 둘 다 지우면 두 기록·파일이 지워진다", async () => {
    const h = await makeHarness();
    const first = await ingestTextFile(h, "book.md", "text/markdown", NOTE_MD, sourceMessage("msg-md-1", "att-1"));
    const second = await ingestTextFile(h, "book.md", "text/markdown", NOTE_MD, sourceMessage("msg-md-2", "att-2"));
    expect(second.documentNodeId).toBe(first.documentNodeId);
    expect(second.documentId).not.toBe(first.documentId);
    // 두 기록의 주인은 서버 전용 주인 표(v46)의 같은 노드 — 노드 metadata 는 바뀌지 않는다(설계 17.18 D32).
    const metadata = (await h.store.getNode(first.documentNodeId))!.metadata;
    expect(metadata.documentId).toBe(first.documentId);
    expect(metadata).not.toHaveProperty("absorbedDocumentIds");
    expect(h.db.query("SELECT document_id AS documentId, node_id AS nodeId FROM document_record_owners ORDER BY document_id").all())
      .toEqual([first.documentId, second.documentId].sort().map((documentId) => ({ documentId, nodeId: first.documentNodeId })));
    expect(assetContentFiles(h.dir)).toEqual([`${first.assetSha256}.md`]);

    const afterFirst = await deleteMessage(h, "msg-md-1");
    expect(afterFirst.keptIds).toEqual([first.documentNodeId]);
    expect(afterFirst.assetCleanup).toEqual(cleanup({}));
    expect(assetRowCounts(h.db)).toEqual({ documents: 2, asset_file_imports: 2, asset_files: 1, images: 0 });
    expect(assetContentFiles(h.dir)).toEqual([`${first.assetSha256}.md`]);
    expectInvariants(h);

    const afterSecond = await deleteMessage(h, "msg-md-2");
    expect(afterSecond.deletedIds).toEqual([first.documentNodeId]);
    expect(afterSecond.assetCleanup).toEqual(cleanup({
      documentIds: [first.documentId, second.documentId].sort(), removedSha256s: [first.assetSha256],
    }));
    expect(assetContentFiles(h.dir)).toEqual([]);
    expect(assetRowCounts(h.db)).toEqual(NO_ASSET_ROWS);
    expectInvariants(h);
  }, 120_000);

  test("문서 노드에 같은 본문의 글 저장이 흡수돼 있으면 메시지를 지워도 노드·기록·파일이 남는다", async () => {
    const h = await makeHarness();
    const doc = await ingestTextFile(h, "book.md", "text/markdown", NOTE_MD, sourceMessage("msg-doc", "att-doc"));
    const typed = await call(h, "POST", "/memories", {
      content: NOTE_MD, platform: "dashboard", author: ATTRIBUTION.author, force: true,
    });
    expect(typed.status).toBe(201);
    expect(typed.body.id).toBe(doc.documentNodeId);

    const deleted = await deleteMessage(h, "msg-doc");
    expect(deleted.keptIds).toEqual([doc.documentNodeId]);
    expect(deleted.assetCleanup).toEqual(cleanup({}));
    expect(await h.store.getNode(doc.documentNodeId)).not.toBeNull();
    expect(h.store.getDocument(doc.documentId)).not.toBeNull();
    expect(assetContentFiles(h.dir)).toEqual([`${doc.assetSha256}.md`]);
    expectInvariants(h);
  }, 120_000);

  test("지운 뒤 같은 파일을 다시 저장하면 파일과 행이 새로 생겨 GET /assets/:sha 가 200", async () => {
    const h = await makeHarness();
    const first = await ingestTextFile(h, "hiking.txt", "text/plain", NOTE_TXT, sourceMessage("msg-a", "att-a"));
    await deleteMessage(h, "msg-a");
    expect((await h.app.request(`/assets/${first.assetSha256}`)).status).toBe(404);

    const again = await ingestTextFile(h, "hiking.txt", "text/plain", NOTE_TXT, sourceMessage("msg-b", "att-b"));
    expect(again.assetSha256).toBe(first.assetSha256);
    const res = await h.app.request(`/assets/${again.assetSha256}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(NOTE_TXT);
    expectInvariants(h);
  }, 120_000);
});

describe("메시지 삭제 — 첨부 이미지 파일", () => {
  test("이미지 첨부와 같은 이미지를 대시보드에도 저장했으면, 메시지를 지워도 보존 사본·미리보기가 남는다", async () => {
    const h = await makeHarness();
    const attached = await ingestImage(h, sourceMessage("msg-img", "att-img"));
    const dashboard = await ingestImage(h);
    expect(dashboard.assetSha256).toBe(attached.assetSha256);
    // 원장 — 이미지 노드마다 보존 사본·미리보기 한 행씩.
    expect(ledger(h.db)).toEqual([
      { sha: attached.assetSha256, ref: `image:${attached.nodeId}` },
      { sha: attached.assetSha256, ref: `image:${dashboard.nodeId}` },
      { sha: attached.thumbSha256, ref: `image:${attached.nodeId}` },
      { sha: attached.thumbSha256, ref: `image:${dashboard.nodeId}` },
    ].sort((a, b) => (a.sha + a.ref < b.sha + b.ref ? -1 : 1)));
    expect(assetContentFiles(h.dir)).toEqual([`${attached.assetSha256}.png`, `${attached.thumbSha256}.png`].sort());

    const deleted = await deleteMessage(h, "msg-img");
    expect(deleted.deletedIds).toEqual([attached.nodeId]);
    expect(deleted.assetCleanup).toEqual(cleanup({}));
    expect(assetContentFiles(h.dir)).toEqual([`${attached.assetSha256}.png`, `${attached.thumbSha256}.png`].sort());
    expect(ledger(h.db).map((row) => row.ref)).toEqual([`image:${dashboard.nodeId}`, `image:${dashboard.nodeId}`]);
    expectInvariants(h);
  }, 180_000);

  test("휴지통에 있는 첨부 이미지 노드도 메시지 삭제로 파일까지 지워진다", async () => {
    const h = await makeHarness();
    const image = await ingestImage(h, sourceMessage("msg-trash", "att-trash"));
    await trash(h, image.nodeId);
    // 휴지통 이동은 원장을 건드리지 않는다 — 휴지통의 저장도 파일을 붙잡는다.
    expect(ledger(h.db)).toHaveLength(2);
    expectInvariants(h);

    const deleted = await deleteMessage(h, "msg-trash");
    expect(deleted.archivePurgedIds).toEqual([image.nodeId]);
    expect(deleted.assetCleanup).toEqual(cleanup({ removedSha256s: sortedShas(image.assetSha256, image.thumbSha256) }));
    expect(assetContentFiles(h.dir)).toEqual([]);
    expect(assetRowCounts(h.db)).toEqual(NO_ASSET_ROWS);
    expectInvariants(h);
  }, 180_000);

  test("휴지통의 첨부 이미지 노드를 메시지 삭제로 지워도, 같은 이미지가 다른 메시지에 살아 있으면 파일이 남는다", async () => {
    const h = await makeHarness();
    const trashed = await ingestImage(h, sourceMessage("msg-old", "att-old"));
    const alive = await ingestImage(h, sourceMessage("msg-alive", "att-alive"));
    await trash(h, trashed.nodeId);

    const deleted = await deleteMessage(h, "msg-old");
    expect(deleted.archivePurgedIds).toEqual([trashed.nodeId]);
    expect(deleted.assetCleanup).toEqual(cleanup({}));
    expect(assetContentFiles(h.dir)).toEqual([`${alive.assetSha256}.png`, `${alive.thumbSha256}.png`].sort());
    expect(ledger(h.db).map((row) => row.ref)).toEqual([`image:${alive.nodeId}`, `image:${alive.nodeId}`]);
    expectInvariants(h);
  }, 180_000);

  test("같은 입력을 보존 모드 둘로 저장하면(사본 둘, 미리보기 하나) 하나를 지워도 미리보기가 남는다", async () => {
    const h = await makeHarness();
    h.settings.images.preserveMode = "original";
    const original = await ingestImage(h, sourceMessage("msg-original", "att-1"));
    h.settings.images.preserveMode = "resized";
    const resized = await ingestImage(h, sourceMessage("msg-resized", "att-2"));
    expect(resized.assetSha256).not.toBe(original.assetSha256);
    expect(resized.thumbSha256).toBe(original.thumbSha256);

    const deleted = await deleteMessage(h, "msg-original");
    expect(deleted.assetCleanup).toEqual(cleanup({ removedSha256s: [original.assetSha256] }));
    expect(assetContentFiles(h.dir).map((name) => name.split(".")[0])).toEqual(
      sortedShas(resized.assetSha256, resized.thumbSha256),
    );
    expectInvariants(h);
  }, 180_000);
});

describe("파일 지우기 실패와 시작 때 다시 지우기", () => {
  test("파일 자리에 비어 있지 않은 디렉터리가 있으면 failed 에 경로·원인을 담고 기억은 지우며 행은 대기로 남는다 — 치운 뒤 시작 때 다시 지운다", async () => {
    const h = await makeHarness();
    const doc = await ingestTextFile(h, "hiking.txt", "text/plain", NOTE_TXT, sourceMessage("msg-locked", "att"));
    const filePath = h.assetStore.path(doc.assetSha256, "txt");
    unlinkSync(filePath);
    mkdirSync(filePath);
    writeFileSync(join(filePath, "occupant.txt"), "자리 차지");

    const deleted = await deleteMessage(h, "msg-locked");
    expect(deleted.deletedIds).toEqual([doc.documentNodeId]);
    expect(await h.store.getNode(doc.documentNodeId)).toBeNull();
    expect(deleted.assetCleanup.documentIds).toEqual([doc.documentId]);
    expect(deleted.assetCleanup.removedSha256s).toEqual([]);
    expect(deleted.assetCleanup.failed).toHaveLength(1);
    expect(deleted.assetCleanup.failed[0]).toMatchObject({ sha256: doc.assetSha256, path: filePath });
    expect(deleted.assetCleanup.failed[0]!.error).toContain(filePath);
    // 기록·원장 행은 지워졌고 asset_files 행만 지우기 대기 표시로 남는다.
    expect(assetRowCounts(h.db)).toEqual({ documents: 0, asset_file_imports: 0, asset_files: 1, images: 0 });
    expectInvariants(h, [doc.assetSha256]);

    // 잠긴 파일이 풀린 상황 — 디렉터리를 치우고 파일이 그 자리에 있다. 서버 시작 때 같은 함수로 다시 지운다.
    rmSync(filePath, { recursive: true, force: true });
    writeFileSync(filePath, NOTE_TXT);
    const restart = await installAssetFileRemover(h.store, h.assetStore);
    expect(restart).toEqual({ cleanup: cleanup({ removedSha256s: [doc.assetSha256] }), strayFiles: NO_STRAY_FILES });
    expect(assetContentFiles(h.dir)).toEqual([]);
    expect(assetRowCounts(h.db)).toEqual(NO_ASSET_ROWS);
    expectInvariants(h);
  }, 120_000);

  test("지울 파일이 이미 없으면 행을 지우고 missingSha256s 로 알린다", async () => {
    const h = await makeHarness();
    const doc = await ingestTextFile(h, "hiking.txt", "text/plain", NOTE_TXT, sourceMessage("msg-gone", "att"));
    unlinkSync(h.assetStore.path(doc.assetSha256, "txt"));

    const deleted = await deleteMessage(h, "msg-gone");
    expect(deleted.assetCleanup).toEqual(cleanup({ documentIds: [doc.documentId], missingSha256s: [doc.assetSha256] }));
    expect(assetRowCounts(h.db)).toEqual(NO_ASSET_ROWS);
    expectInvariants(h);
  }, 120_000);

  test("파일 지우기 함수를 넣지 않은 저장소는 failed 에 setAssetFileRemover 미설정을 담고 행을 대기로 남긴다 — 시작 때 정리된다", async () => {
    const h = await makeHarness({ remover: false });
    const doc = await ingestTextFile(h, "hiking.txt", "text/plain", NOTE_TXT, sourceMessage("msg-no-remover", "att"));
    const filePath = h.assetStore.path(doc.assetSha256, "txt");

    const deleted = await deleteMessage(h, "msg-no-remover");
    expect(deleted.deletedIds).toEqual([doc.documentNodeId]);
    expect(deleted.assetCleanup).toEqual(cleanup({
      documentIds: [doc.documentId],
      failed: [{ sha256: doc.assetSha256, path: filePath, error: ASSET_FILE_REMOVER_MISSING }],
    }));
    expect(deleted.assetCleanup.failed[0]!.error).toContain("setAssetFileRemover");
    expect(assetContentFiles(h.dir)).toEqual([`${doc.assetSha256}.txt`]);
    expect(assetRowCounts(h.db)).toEqual({ documents: 0, asset_file_imports: 0, asset_files: 1, images: 0 });
    expectInvariants(h, [doc.assetSha256]);

    const boot = await installAssetFileRemover(h.store, h.assetStore);
    expect(boot).toEqual({ cleanup: cleanup({ removedSha256s: [doc.assetSha256] }), strayFiles: NO_STRAY_FILES });
    expect(assetContentFiles(h.dir)).toEqual([]);
    expectInvariants(h);
  }, 120_000);

  test("시작 때 다시 지우기는 쓰이는 파일을 건드리지 않는다", async () => {
    const h = await makeHarness();
    const doc = await ingestTextFile(h, "hiking.txt", "text/plain", NOTE_TXT, sourceMessage("msg-live", "att"));
    expect(await installAssetFileRemover(h.store, h.assetStore)).toEqual({ cleanup: cleanup({}), strayFiles: NO_STRAY_FILES });
    expect(assetContentFiles(h.dir)).toEqual([`${doc.assetSha256}.txt`]);
    expect(assetSha256(readFileSync(h.assetStore.path(doc.assetSha256, "txt")))).toBe(doc.assetSha256);
    expectInvariants(h);
  }, 120_000);
});
