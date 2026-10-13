/**
 * memories-permanent-delete.attachment-files.test.ts — 단건 영구 삭제와 휴지통 보관 만료도 그 기억의 첨부 파일과 문서
 * 기록·원장 행을 지운다(WP-B1-20U 설계 17.17, Q7 확정, U9b).
 *
 * QA 재현: "단건 영구 삭제·보관 만료 뒤에도 파일과 기록이 남는다." 이제 DELETE /memories/:id(봇 /forget 이 부르는 라우트)와
 * 휴지통 보관 만료(runTrashManagement → store.purgeOldArchive)가 메시지 삭제와 같은 루틴을 거친다: 영구 삭제한 문서·이미지
 * 노드가 주인인 문서 기록(documents 행)과 원장 행(asset_file_imports)을 같은 트랜잭션에서 지우고, 커밋 뒤 같은 쓰기 잠금
 * 안에서 참조를 모두 잃은 sha 의 파일과 asset_files 행을 지운다. 결과는 응답·요약의 assetCleanup 에 담긴다. 청크는 기록의
 * 주인이 아니라 청크만 지우면(OCR 청크 교체 포함) 기록·파일이 남는다. 같은 파일을 다른 저장(살아 있는 저장·휴지통의
 * 저장)이 쓰면 파일이 남는다.
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 실제 SigLIP + 임시 디렉터리의 실제 AssetStore + 실제 Hono 라우트(POST /ingest,
 * DELETE /memories/:id, POST /memories/:id/trash, POST /api/documents/:id/ocr-result). 봇 /forget 은 루프백 Bun.serve 에
 * 붙인 실제 MemoryApiClient.forget. 보관 만료는 실제 runTrashManagement. 파일 지우기 함수는 서버 부팅과 같은
 * installAssetFileRemover 로 넣는다. 실패는 실제 조건(파일 자리의 비어 있지 않은 디렉터리)으로 만든다. 모든 제거 뒤
 * 계보·자산 불변식 도우미가 빈 목록이다. mock 0.
 */

import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssetStore } from "../../assets/asset-store.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { createImageEmbedder } from "../../embedding/factory.ts";
import type { ImageEmbedder } from "../../embedding/types.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { runTrashManagement, type TrashActivitySummary } from "../../memory/trash-manager.ts";
import { buildMemoryApi } from "../../server.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import { MemoryApiClient } from "../../api-client.ts";
import type { AssetCleanup, ForgetResult } from "../../api-client-types.ts";
import { installAssetFileRemover } from "../asset-file-remover-boot.ts";
import { lineageOrphans } from "../../test-utils/lineage-invariant.ts";
import { assetContentFiles, assetInvariantViolations } from "../../test-utils/asset-invariant.ts";

const DASHBOARD_SOURCE = "dashboard:manual";
const ATTRIBUTION = { author: "owner", userId: "user-1" };
const JSON_HEADERS = { "content-type": "application/json" };

const NOTE_TXT = "주말 등산 계획\n\n토요일 아침 여덟시에 북한산 입구에서 만난다. 점심은 각자 준비한다.";
const NOTE_MD = "# 독서 모임 메모\n\n다음 모임 책은 '코스모스'이고, 장소는 시립도서관 세미나실이다.";
/** 제목 둘 — 청크 노드가 생기는 문서. */
const SECTIONED_MD = [
  "# 이사 준비",
  "",
  "## 짐 싸기",
  "",
  "책장은 금요일까지 상자 열두 개에 나눠 담는다. 깨지는 그릇은 신문지로 따로 싼다.",
  "",
  "## 주소 변경",
  "",
  "은행과 통신사 주소는 이사 다음 날 한꺼번에 바꾼다. 우편물 전송 신청도 같이 한다.",
].join("\n");
const OCR_MD = "# 스캔 영수증\n\n## 품목\n\n연필 세 자루와 공책 두 권을 샀다.\n\n## 결제\n\n카드로 오천 원을 냈다.";
const PNG_FIXTURE = join(import.meta.dir, "..", "..", "memory", "image-preserve", "__fixtures__", "static-small.png");
const SCANNED_PDF_FIXTURE = join(import.meta.dir, "..", "..", "memory", "canonicalize", "__fixtures__", "scanned.pdf");
/** 보관 기간이 지난 보관 시각. 보관 0일이어도 같은 초에 넣고 지우면 `archived_at < 컷오프` 가 거짓이라 앞당긴다. */
const LONG_AGO = "2000-01-01 00:00:00";

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
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const h of harnesses.splice(0)) {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "bara-permanent-delete-files-"));
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  const assetStore = new AssetStore(dir);
  await installAssetFileRemover(store, assetStore);
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

interface IngestedDocument { documentNodeId: number; chunkNodeIds: number[]; documentId: string; assetSha256: string }

/** 대시보드에 올린 파일(파일 이름이 있어 문서 갈래). */
async function uploadDocument(h: Harness, name: string, mimeType: string, data: string): Promise<IngestedDocument> {
  const res = await call(h, "POST", "/ingest", {
    source: DASHBOARD_SOURCE,
    content: { type: "text", data, mimeType, originalName: name },
    attribution: ATTRIBUTION,
  });
  expect(res.status).toBe(201);
  const [documentNodeId, ...chunkNodeIds] = res.body.nodeIds as number[];
  return {
    documentNodeId: documentNodeId!,
    chunkNodeIds,
    documentId: res.body.documentId as string,
    assetSha256: res.body.assetSha256 as string,
  };
}

interface IngestedImage { nodeId: number; assetSha256: string; thumbSha256: string }

/** 대시보드에 올린 PNG 이미지. */
async function uploadImage(h: Harness): Promise<IngestedImage> {
  const res = await call(h, "POST", "/ingest", {
    source: DASHBOARD_SOURCE,
    content: { type: "image", data: readFileSync(PNG_FIXTURE).toString("base64"), mimeType: "image/png", originalName: "plant.png" },
    attribution: ATTRIBUTION,
  });
  expect(res.status).toBe(201);
  const [image] = res.body.images as IngestedImage[];
  return image!;
}

async function permanentlyDelete(h: Harness, id: number): Promise<Json> {
  const res = await call(h, "DELETE", `/memories/${id}`);
  expect(res.status).toBe(200);
  return res.body;
}

async function trash(h: Harness, id: number): Promise<void> {
  expect((await call(h, "POST", `/memories/${id}/trash`)).status).toBe(200);
}

/** 휴지통의 모든 노드를 보관 기간이 지난 상태로 두고, 실제 휴지통 관리 한 사이클(보관 0일)을 돌린다. */
async function expireTrash(h: Harness): Promise<TrashActivitySummary> {
  h.db.query("UPDATE knowledge_nodes_archive SET archived_at = ?").run(LONG_AGO);
  return runTrashManagement(h.store, { retentionDays: 0, warningDays: 0 });
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

/** 원장 행(sha·source_ref, 정렬). */
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
const ascending = (ids: readonly number[]) => [...ids].sort((a, b) => a - b);

describe("DELETE /memories/:id — 대시보드에 올린 문서", () => {
  test("QA 재현: 대시보드에 올린 문서 노드를 영구 삭제하면 문서 기록·원장 행·파일이 모두 지워진다", async () => {
    const h = await makeHarness();
    const doc = await uploadDocument(h, "hiking.txt", "text/plain", NOTE_TXT);
    expect(assetContentFiles(h.dir)).toEqual([`${doc.assetSha256}.txt`]);
    expect(ledger(h.db)).toEqual([{ sha: doc.assetSha256, ref: `document:${doc.documentId}` }]);
    expectInvariants(h);

    const removed = await permanentlyDelete(h, doc.documentNodeId);

    expect(removed).toEqual({
      deleted: doc.documentNodeId,
      derivedDeletedIds: ascending(doc.chunkNodeIds),
      archivePurgedIds: [],
      assetCleanup: cleanup({ documentIds: [doc.documentId], removedSha256s: [doc.assetSha256] }),
    });
    expect(count(h.db, "knowledge_nodes")).toBe(0);
    expect(assetContentFiles(h.dir)).toEqual([]);
    expect(assetRowCounts(h.db)).toEqual(NO_ASSET_ROWS);
    expectInvariants(h);
  }, 120_000);

  test("같은 .md 를 대시보드에 두 번 올려 문서 노드가 흡수되면, 노드 영구 삭제가 그 노드가 주인인 두 기록을 지운다", async () => {
    const h = await makeHarness();
    const first = await uploadDocument(h, "book.md", "text/markdown", NOTE_MD);
    const second = await uploadDocument(h, "book.md", "text/markdown", NOTE_MD);
    expect(second.documentNodeId).toBe(first.documentNodeId);
    expect(second.documentId).not.toBe(first.documentId);
    // 두 기록의 주인은 서버 전용 주인 표(v46)의 같은 노드 — 노드 metadata 는 바뀌지 않는다(설계 17.18 D32).
    const metadata = (await h.store.getNode(first.documentNodeId))!.metadata;
    expect(metadata.documentId).toBe(first.documentId);
    expect(metadata).not.toHaveProperty("absorbedDocumentIds");
    expect(h.db.query("SELECT document_id AS documentId, node_id AS nodeId FROM document_record_owners ORDER BY document_id").all())
      .toEqual([first.documentId, second.documentId].sort().map((documentId) => ({ documentId, nodeId: first.documentNodeId })));
    expect(assetRowCounts(h.db)).toEqual({ documents: 2, asset_file_imports: 2, asset_files: 1, images: 0 });

    const removed = await permanentlyDelete(h, first.documentNodeId);

    expect(removed.assetCleanup).toEqual(cleanup({
      documentIds: [first.documentId, second.documentId].sort(), removedSha256s: [first.assetSha256],
    }));
    expect(assetContentFiles(h.dir)).toEqual([]);
    expect(assetRowCounts(h.db)).toEqual(NO_ASSET_ROWS);
    expectInvariants(h);
  }, 120_000);

  test("청크 하나만 영구 삭제하면 청크는 기록의 주인이 아니라 문서 기록·원장 행·파일이 남는다", async () => {
    const h = await makeHarness();
    const doc = await uploadDocument(h, "moving.md", "text/markdown", SECTIONED_MD);
    expect(doc.chunkNodeIds.length).toBeGreaterThan(0);
    const ledgerBefore = ledger(h.db);
    const [chunk] = doc.chunkNodeIds;

    const removed = await permanentlyDelete(h, chunk!);

    expect(removed).toEqual({ deleted: chunk, derivedDeletedIds: [], archivePurgedIds: [], assetCleanup: cleanup({}) });
    expect(await h.store.getNode(doc.documentNodeId)).not.toBeNull();
    expect(h.store.getDocument(doc.documentId)).not.toBeNull();
    expect(ledger(h.db)).toEqual(ledgerBefore);
    expect(assetContentFiles(h.dir)).toEqual([`${doc.assetSha256}.md`]);
    expectInvariants(h);
  }, 120_000);

  test("같은 파일을 휴지통의 저장이 가지면, 다시 올린 문서 노드를 영구 삭제해도 파일이 남는다", async () => {
    const h = await makeHarness();
    const trashed = await uploadDocument(h, "hiking.txt", "text/plain", NOTE_TXT);
    await trash(h, trashed.documentNodeId);
    const again = await uploadDocument(h, "hiking.txt", "text/plain", NOTE_TXT);
    expect(again.documentNodeId).not.toBe(trashed.documentNodeId);
    expect(again.assetSha256).toBe(trashed.assetSha256);

    const removed = await permanentlyDelete(h, again.documentNodeId);

    expect(removed.assetCleanup).toEqual(cleanup({ documentIds: [again.documentId] }));
    expect(h.store.getDocument(trashed.documentId)).not.toBeNull();
    expect(ledger(h.db)).toEqual([{ sha: trashed.assetSha256, ref: `document:${trashed.documentId}` }]);
    expect(assetContentFiles(h.dir)).toEqual([`${trashed.assetSha256}.txt`]);
    expectInvariants(h);
  }, 120_000);
});

describe("DELETE /memories/:id — 대시보드에 올린 이미지", () => {
  test("이미지 노드를 영구 삭제하면 보존 사본·미리보기와 그 행이 지워진다", async () => {
    const h = await makeHarness();
    const image = await uploadImage(h);
    expect(assetContentFiles(h.dir)).toEqual([`${image.assetSha256}.png`, `${image.thumbSha256}.png`].sort());

    const removed = await permanentlyDelete(h, image.nodeId);

    expect(removed.assetCleanup).toEqual(cleanup({ removedSha256s: sortedShas(image.assetSha256, image.thumbSha256) }));
    expect(assetContentFiles(h.dir)).toEqual([]);
    expect(assetRowCounts(h.db)).toEqual(NO_ASSET_ROWS);
    expectInvariants(h);
  }, 180_000);

  test("같은 이미지를 두 번 올렸으면 하나를 지워도 파일이 남고, 나머지도 지우면 지워진다", async () => {
    const h = await makeHarness();
    const first = await uploadImage(h);
    const second = await uploadImage(h);
    expect(second.nodeId).not.toBe(first.nodeId);
    expect(second.assetSha256).toBe(first.assetSha256);

    const removedFirst = await permanentlyDelete(h, first.nodeId);
    expect(removedFirst.assetCleanup).toEqual(cleanup({}));
    expect(assetContentFiles(h.dir)).toEqual([`${first.assetSha256}.png`, `${first.thumbSha256}.png`].sort());
    expect(ledger(h.db).map((row) => row.ref)).toEqual([`image:${second.nodeId}`, `image:${second.nodeId}`]);
    expectInvariants(h);

    const removedSecond = await permanentlyDelete(h, second.nodeId);
    expect(removedSecond.assetCleanup).toEqual(cleanup({ removedSha256s: sortedShas(first.assetSha256, first.thumbSha256) }));
    expect(assetContentFiles(h.dir)).toEqual([]);
    expect(assetRowCounts(h.db)).toEqual(NO_ASSET_ROWS);
    expectInvariants(h);
  }, 180_000);

  test("보존 모드 둘로 올려 미리보기 하나를 함께 쓰면, 하나를 지워도 미리보기가 남는다", async () => {
    const h = await makeHarness();
    h.settings.images.preserveMode = "original";
    const original = await uploadImage(h);
    h.settings.images.preserveMode = "resized";
    const resized = await uploadImage(h);
    expect(resized.assetSha256).not.toBe(original.assetSha256);
    expect(resized.thumbSha256).toBe(original.thumbSha256);

    const removed = await permanentlyDelete(h, original.nodeId);

    expect(removed.assetCleanup).toEqual(cleanup({ removedSha256s: [original.assetSha256] }));
    expect(assetContentFiles(h.dir).map((name) => name.split(".")[0])).toEqual(
      sortedShas(resized.assetSha256, resized.thumbSha256),
    );
    expectInvariants(h);
  }, 180_000);
});

describe("봇 /forget — 루프백 코어에 붙인 실제 MemoryApiClient.forget", () => {
  test("문서 노드를 잊으면 응답 assetCleanup 에 지운 기록·파일이 담기고 파일이 지워진다", async () => {
    const h = await makeHarness();
    const doc = await uploadDocument(h, "hiking.txt", "text/plain", NOTE_TXT);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
    servers.push(server);
    const client = new MemoryApiClient(`http://127.0.0.1:${server.port}`);

    const result: ForgetResult | null = await client.forget(doc.documentNodeId);

    expect(result).toEqual({
      deleted: doc.documentNodeId,
      derivedDeletedIds: ascending(doc.chunkNodeIds),
      archivePurgedIds: [],
      assetCleanup: cleanup({ documentIds: [doc.documentId], removedSha256s: [doc.assetSha256] }),
    });
    expect(assetContentFiles(h.dir)).toEqual([]);
    expect(assetRowCounts(h.db)).toEqual(NO_ASSET_ROWS);
    expect(await client.forget(doc.documentNodeId)).toBeNull();
    expectInvariants(h);
  }, 120_000);
});

describe("OCR 청크 교체 — store.deleteNode 로 옛 청크를 지운다", () => {
  test("OCR 재적용이 옛 청크를 영구 삭제해도 문서 기록·원장 행·파일은 그대로다", async () => {
    const h = await makeHarness();
    const res = await call(h, "POST", "/ingest", {
      source: DASHBOARD_SOURCE,
      content: { type: "auto", data: readFileSync(SCANNED_PDF_FIXTURE).toString("base64"), mimeType: "application/pdf", originalName: "receipt.pdf" },
      attribution: ATTRIBUTION,
    });
    expect(res.status).toBe(201);
    const documentId = res.body.documentId as string;
    const applyOcr = async () => {
      const applied = await call(h, "POST", `/api/documents/${documentId}/ocr-result`, { markdown: OCR_MD, source: "manual" });
      expect(applied.status).toBe(200);
    };
    await applyOcr();
    const oldChunks = h.store.listDocumentChunkNodeIds(documentId);
    expect(oldChunks.length).toBeGreaterThan(0);
    const documentBefore = h.store.getDocument(documentId);
    const ledgerBefore = ledger(h.db);
    const filesBefore = assetContentFiles(h.dir);
    expect(ledgerBefore.map((row) => row.ref)).toContain(`document:${documentId}`);
    expectInvariants(h);

    // 같은 Markdown 재적용 — 변환본 sha 가 같아 기록이 가리키는 파일이 바뀌지 않고, 옛 청크만 store.deleteNode 로 지워진다.
    await applyOcr();

    for (const id of oldChunks) expect(await h.store.getNode(id)).toBeNull();
    expect(h.store.listDocumentChunkNodeIds(documentId).some((id) => oldChunks.includes(id))).toBe(false);
    expect(h.store.getDocument(documentId)).toMatchObject({
      documentId, assetSha256: documentBefore!.assetSha256,
    });
    expect(ledger(h.db)).toEqual(ledgerBefore);
    expect(assetContentFiles(h.dir)).toEqual(filesBefore);
    expectInvariants(h);
  }, 120_000);
});

describe("휴지통 보관 만료 — runTrashManagement", () => {
  test("휴지통의 문서·이미지 노드가 보관 만료로 영구 삭제되면 요약 assetCleanup 에 담기고 기록·원장 행·파일이 지워진다", async () => {
    const h = await makeHarness();
    const doc = await uploadDocument(h, "hiking.txt", "text/plain", NOTE_TXT);
    const image = await uploadImage(h);
    await trash(h, doc.documentNodeId);
    await trash(h, image.nodeId);
    const archived = count(h.db, "knowledge_nodes_archive");
    // 휴지통 이동은 원장을 건드리지 않는다 — 휴지통의 저장도 파일을 붙잡는다.
    expect(assetContentFiles(h.dir)).toHaveLength(3);
    expectInvariants(h);

    const summary = await expireTrash(h);

    expect(summary.nodesPurged).toBe(archived);
    expect(summary.assetCleanup).toEqual(cleanup({
      documentIds: [doc.documentId],
      removedSha256s: sortedShas(doc.assetSha256, image.assetSha256, image.thumbSha256),
    }));
    expect(count(h.db, "knowledge_nodes_archive")).toBe(0);
    expect(assetContentFiles(h.dir)).toEqual([]);
    expect(assetRowCounts(h.db)).toEqual(NO_ASSET_ROWS);
    expectInvariants(h);
  }, 180_000);

  test("같은 파일을 살아 있는 저장이 가지면 보관 만료가 휴지통의 기록만 지우고 파일은 남긴다", async () => {
    const h = await makeHarness();
    const trashed = await uploadDocument(h, "hiking.txt", "text/plain", NOTE_TXT);
    await trash(h, trashed.documentNodeId);
    const alive = await uploadDocument(h, "hiking.txt", "text/plain", NOTE_TXT);

    const summary = await expireTrash(h);

    expect(summary.assetCleanup).toEqual(cleanup({ documentIds: [trashed.documentId] }));
    expect(h.store.getDocument(trashed.documentId)).toBeNull();
    expect(await h.store.getNode(alive.documentNodeId)).not.toBeNull();
    expect(ledger(h.db)).toEqual([{ sha: alive.assetSha256, ref: `document:${alive.documentId}` }]);
    expect(assetContentFiles(h.dir)).toEqual([`${alive.assetSha256}.txt`]);
    expectInvariants(h);
  }, 120_000);
});

describe("파일 지우기 실패 — 기억 삭제는 확정하고 행은 대기로 남긴다", () => {
  /** 파일 자리를 비어 있지 않은 디렉터리로 바꾼다(지우기 실패의 실제 조건). 반환: 그 경로. */
  function occupyFilePath(h: Harness, sha256: string, ext: string): string {
    const filePath = h.assetStore.path(sha256, ext);
    unlinkSync(filePath);
    mkdirSync(filePath);
    writeFileSync(join(filePath, "occupant.txt"), "자리 차지");
    return filePath;
  }

  test("DELETE /memories/:id: 파일 자리에 디렉터리가 있으면 failed 에 경로·원인을 담고, 치운 뒤 시작 때 다시 지운다", async () => {
    const h = await makeHarness();
    const doc = await uploadDocument(h, "hiking.txt", "text/plain", NOTE_TXT);
    const filePath = occupyFilePath(h, doc.assetSha256, "txt");

    const removed = await permanentlyDelete(h, doc.documentNodeId);

    expect(removed.deleted).toBe(doc.documentNodeId);
    expect(await h.store.getNode(doc.documentNodeId)).toBeNull();
    const assetCleanup = removed.assetCleanup as AssetCleanup;
    expect(assetCleanup.documentIds).toEqual([doc.documentId]);
    expect(assetCleanup.removedSha256s).toEqual([]);
    expect(assetCleanup.failed).toHaveLength(1);
    expect(assetCleanup.failed[0]).toMatchObject({ sha256: doc.assetSha256, path: filePath });
    expect(assetCleanup.failed[0]!.error).toContain(filePath);
    // 기록·원장 행은 지워졌고 asset_files 행만 지우기 대기 표시로 남는다.
    expect(assetRowCounts(h.db)).toEqual({ documents: 0, asset_file_imports: 0, asset_files: 1, images: 0 });
    expectInvariants(h, [doc.assetSha256]);

    rmSync(filePath, { recursive: true, force: true });
    writeFileSync(filePath, NOTE_TXT);
    expect(await installAssetFileRemover(h.store, h.assetStore)).toEqual({ cleanup: cleanup({ removedSha256s: [doc.assetSha256] }), strayFiles: NO_STRAY_FILES });
    expect(assetContentFiles(h.dir)).toEqual([]);
    expect(assetRowCounts(h.db)).toEqual(NO_ASSET_ROWS);
    expectInvariants(h);
  }, 120_000);

  test("보관 만료: 지우지 못한 파일은 요약 failed 에 담기고 휴지통 관리가 오류 로그를 남긴다", async () => {
    const h = await makeHarness();
    const doc = await uploadDocument(h, "hiking.txt", "text/plain", NOTE_TXT);
    await trash(h, doc.documentNodeId);
    const filePath = occupyFilePath(h, doc.assetSha256, "txt");
    const errors = spyOn(console, "error");

    let summary: TrashActivitySummary;
    let errorLines: string[];
    try {
      summary = await expireTrash(h);
      // mockRestore 가 기록한 호출을 비우므로 그 전에 읽는다.
      errorLines = errors.mock.calls.map((args) => args.map(String).join(" "));
    } finally {
      errors.mockRestore();
    }

    expect(summary.nodesPurged).toBeGreaterThan(0);
    expect(summary.assetCleanup.documentIds).toEqual([doc.documentId]);
    expect(summary.assetCleanup.failed).toHaveLength(1);
    expect(summary.assetCleanup.failed[0]).toMatchObject({ sha256: doc.assetSha256, path: filePath });
    const trashCronLines = errorLines.filter((line) => line.startsWith("[trash-cron]"));
    expect(trashCronLines).toHaveLength(1);
    expect(trashCronLines[0]).toContain(doc.assetSha256);
    expect(trashCronLines[0]).toContain(filePath);
    expect(assetRowCounts(h.db)).toEqual({ documents: 0, asset_file_imports: 0, asset_files: 1, images: 0 });
    expectInvariants(h, [doc.assetSha256]);
  }, 120_000);
});
