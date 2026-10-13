/**
 * document-record-owners.test.ts — 문서 기록의 주인은 서버 전용 주인 표(document_record_owners, v46) 하나다(WP-B1-20U 설계
 * 17.18 설계 1·2, 결정 D32~D34, 단계 U10a).
 *
 * 재QA 재현(먼저 옮긴 빨간 테스트): 주인 판정이 클라이언트가 쓸 수 있는 노드 metadata(absorbedDocumentIds)를 믿어,
 *   A1 — POST /memories 의 metadata 에 남의 문서 기록 id 를 넣은 메모를 지우면 그 살아 있는 기록과 파일이 지워졌다.
 *   A2 — 그 칸이 배열이 아닌 메시지 기억은 메시지 삭제·단건 삭제가 500 으로 멈췄다.
 *   A3 — 그런 휴지통 기억 하나가 보관 만료 전체를 멈췄다.
 *   B2 — 글 + 같은 본문 .txt 첨부(흡수) 뒤 대시보드 by-id 편집으로 글 노드 자체가 재추출되면, 그 자식이 부모 metadata 의
 *        absorbedDocumentIds 를 물려받아 자식 하나를 /forget 하면 살아 있는 기록과 파일이 지워졌다.
 *   B1 — 같은 흐름에서 편집 없이 백필하면 추출 대상은 첨부의 청크라 HEAD 20c52cc4 에서도 통과한다(재QA 의 B1 재현도 HEAD 사본에서 통과).
 *        자식이 어느 쪽에서 나오든 기록을 지우지 않는다는 회귀 방지로 둔다.
 * 이제 metadata 는 주인 판정에 쓰이지 않는다: 주인 행은 addDocumentGraphAtomic 이 노드 저장과 같은 트랜잭션에서 쓰고,
 * 영구 삭제는 지운 노드 id 로 그 표를 찾는다. 더해서: 같은 .md 두 번(주인 행 2 → 노드 영구 삭제로 둘 다 해제), 글 + 같은
 * 본문 .txt(글 노드가 주인 → 휴지통·복원 뒤 그대로 → 메시지 삭제로 해제), 휴지통 주인의 보관 만료 해제, 설계 2 오류(외래
 * 키를 끄고 기록 행을 지워 만든 상태 → 기록 id 를 담은 오류로 멈추고 아무것도 지우지 않는다). 재QA2 Minor(설계 17.19 설계 6)
 * M1: 그 500 의 응답 본문 error 에 기록 id 가 실리고(바깥 앱에 route("/", app) 으로 붙여도 같다), M2: 같은 DB 를 다시 시작하면
 * 시작 정리 (c) 가 그 기록의 document: 원장 행도 지워 파일·asset_files 행까지 0 이 된다.
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 실제 SigLIP + 임시 디렉터리의 실제 AssetStore + 실제 Hono 라우트. 추출은 루프백
 * Ollama 호환 서버(startPromptOllamaChatServer)에 붙인 실제 OllamaClient·MemoryExtractor 와 실제 백필 주기. 보관 만료는
 * 실제 runTrashManagement. 파일 지우기 함수는 서버 부팅과 같은 installAssetFileRemover 로 넣는다. 모든 제거 뒤 계보·자산
 * 불변식 도우미가 빈 목록이다(설계 2 사례는 도우미가 정확히 그 어긋남을 알리는지 본다). mock 0.
 */

import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssetStore } from "../../assets/asset-store.ts";
import type { AssetCleanup } from "../../assets/released-asset-files.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { OwnedDocumentRecordMissingError } from "../../db/store-internal/asset-release.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { createImageEmbedder } from "../../embedding/factory.ts";
import type { ImageEmbedder } from "../../embedding/types.ts";
import { OllamaClient } from "../../llm/ollama-client.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { MemoryExtractor } from "../../memory/extractor.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { runTrashManagement } from "../../memory/trash-manager.ts";
import { startBackfillScheduler } from "../../scheduler.ts";
import { buildMemoryApi } from "../../server.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import { installAssetFileRemover } from "../asset-file-remover-boot.ts";
import { assetContentFiles, assetInvariantViolations } from "../../test-utils/asset-invariant.ts";
import { lineageOrphans } from "../../test-utils/lineage-invariant.ts";
import {
  startPromptOllamaChatServer,
  type ExtractionReply,
  type PromptOllamaChatServer,
} from "../../test-utils/prompt-ollama-chat-server.ts";

const PLATFORM = "discord";
const DISCORD_SOURCE = "discord-channel";
const DASHBOARD_SOURCE = "dashboard:manual";
const ATTRIBUTION = { author: "owner", userId: "user-1" };
const JSON_HEADERS = { "content-type": "application/json" };
/** 보관 기간이 지난 보관 시각 — 보관 0일이어도 같은 초에 넣고 지우면 `archived_at < 컷오프` 가 거짓이라 앞당긴다. */
const LONG_AGO = "2000-01-01 00:00:00";

const NOTE_TXT = "캠핑 준비물\n\n텐트와 침낭은 금요일 저녁까지 차에 싣는다. 버너 가스는 두 통 챙긴다.";
const NOTE_MD = "# 독서 모임 메모\n\n다음 모임 책은 '코스모스'이고, 장소는 시립도서관 세미나실이다.";
const TEXT = "이번 달 독서 모임 책은 토지 1권이고 모임 장소는 시립도서관 세미나실이다";
const CHILD = "이번 달 독서 모임 책은 토지 1권이다";
const EDIT = "이번 달 독서 모임 책은 토지 2권이고 모임 장소는 구립도서관 세미나실이다";
const EDIT_CHILD = "이번 달 독서 모임 책은 토지 2권이다";
const EXTRACTION_REPLIES: ExtractionReply[] = [
  { source: TEXT, items: [{ content: CHILD, memoryType: "fact", importance: 0.8 }] },
  { source: EDIT, items: [{ content: EDIT_CHILD, memoryType: "fact", importance: 0.8 }] },
];

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
  dir: string;
  extractor: MemoryExtractor | null;
}

const harnesses: Harness[] = [];
const llmServers: PromptOllamaChatServer[] = [];
afterEach(() => {
  for (const llm of llmServers.splice(0)) llm.stop();
  for (const h of harnesses.splice(0)) {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

/** withExtractor 면 루프백 LLM 에 붙인 실제 추출기와 백필 모드 설정을 함께 묶는다. */
async function makeHarness(withExtractor = false): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "bara-document-owners-"));
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const assetStore = new AssetStore(dir);
  await installAssetFileRemover(store, assetStore);
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  let extractor: MemoryExtractor | null = null;
  if (withExtractor) {
    const llm = startPromptOllamaChatServer(EXTRACTION_REPLIES);
    llmServers.push(llm);
    extractor = new MemoryExtractor(new OllamaClient({ baseUrl: llm.url, model: "test-model" }), store, embedder, {
      duplicateSim: 0.999, minImportance: 0,
    });
    settings.llm.extractor.enabled = true;
    settings.llm.extractor.mode = "backfill";
  }
  const app = buildMemoryApi({
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(),
    ...(extractor ? { extractor } : {}), assetStore, imageEmbedder, getSettings: () => settings,
  });
  const h = { app, db, store, dir, extractor };
  harnesses.push(h);
  return h;
}

type Json = Record<string, unknown>;

async function callApp(app: Hono, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await app.request(path, {
    method,
    ...(body === undefined ? {} : { headers: JSON_HEADERS, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) as Json : { text } };
}

function call(h: Harness, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  return callApp(h.app, method, path, body);
}

interface IngestedDocument { documentNodeId: number; documentId: string; assetSha256: string }

/** 파일 이름이 있는 글 파일(문서 갈래). messageId 가 있으면 봇 첨부, 없으면 대시보드 업로드. */
async function ingestTextFile(
  h: Harness, name: string, mimeType: string, data: string, messageId?: string,
): Promise<IngestedDocument> {
  const res = await call(h, "POST", "/ingest", {
    source: messageId ? DISCORD_SOURCE : DASHBOARD_SOURCE,
    content: { type: "text", data, mimeType, originalName: name },
    attribution: ATTRIBUTION,
    ...(messageId
      ? { sourceMessage: { platform: PLATFORM, messageId, channelId: "channel-1", attachmentId: `att-${messageId}` } }
      : {}),
  });
  expect(res.status).toBe(201);
  return {
    documentNodeId: (res.body.nodeIds as number[])[0]!,
    documentId: res.body.documentId as string,
    assetSha256: res.body.assetSha256 as string,
  };
}

/** 메시지 글 저장(봇 모양). extraMetadata 는 클라이언트가 함께 보낸 metadata 칸. */
async function saveMessageText(h: Harness, content: string, messageId: string, extraMetadata: Json = {}): Promise<number> {
  const res = await call(h, "POST", "/memories", {
    content, author: ATTRIBUTION.author, platform: PLATFORM,
    metadata: { messageId, channelId: "channel-1", source: DISCORD_SOURCE, ...extraMetadata },
  });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

async function permanentlyDelete(h: Harness, id: number): Promise<Json> {
  const res = await call(h, "DELETE", `/memories/${id}`);
  expect(res.status).toBe(200);
  return res.body;
}

async function deleteMessage(h: Harness, messageId: string): Promise<Json> {
  const res = await call(h, "DELETE", `/memories/by-source?messageId=${messageId}&platform=${PLATFORM}`);
  expect(res.status).toBe(200);
  return res.body;
}

async function trash(h: Harness, id: number): Promise<void> {
  expect((await call(h, "POST", `/memories/${id}/trash`)).status).toBe(200);
}

async function expireTrash(h: Harness): Promise<Awaited<ReturnType<typeof runTrashManagement>>> {
  h.db.query("UPDATE knowledge_nodes_archive SET archived_at = ?").run(LONG_AGO);
  return runTrashManagement(h.store, { retentionDays: 0, warningDays: 0 });
}

/** 실제 백필 주기 한 번(루프백 LLM). */
async function backfillOnce(h: Harness): Promise<void> {
  const handle = startBackfillScheduler(h.extractor!, h.store, { intervalMs: 60_000, batchSize: 10 });
  try {
    await handle.tickNow();
  } finally {
    await handle.stop();
  }
}

function nodeIdByContent(db: Database, content: string): number {
  const row = db.query("SELECT id FROM knowledge_nodes WHERE content = ?").get(content) as { id: number } | null;
  expect(row).not.toBeNull();
  return row!.id;
}

function count(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

/** 주인 표의 행(기록 id 순). */
function owners(db: Database): Array<{ documentId: string; nodeId: number }> {
  return db.query("SELECT document_id AS documentId, node_id AS nodeId FROM document_record_owners ORDER BY document_id")
    .all() as Array<{ documentId: string; nodeId: number }>;
}

function expectInvariants(h: Harness): void {
  expect(lineageOrphans(h.db)).toEqual([]);
  expect(assetInvariantViolations(h.db, h.dir)).toEqual([]);
}

function cleanup(partial: Partial<AssetCleanup>): AssetCleanup {
  return { documentIds: [], removedSha256s: [], missingSha256s: [], failed: [], ...partial };
}

describe("재QA 재현 — 클라이언트 metadata 는 주인을 정하지 못한다", () => {
  test("A1: 남의 문서 기록 id 를 metadata.absorbedDocumentIds 에 넣은 메모를 지워도 그 기록·파일은 남는다", async () => {
    const h = await makeHarness();
    const doc = await ingestTextFile(h, "camp.txt", "text/plain", NOTE_TXT);
    const note = await call(h, "POST", "/memories", {
      content: "다음 주 회의 안건 정리", author: ATTRIBUTION.author, metadata: { absorbedDocumentIds: [doc.documentId] },
    });
    expect(note.status).toBe(201);

    const removed = await permanentlyDelete(h, note.body.id as number);

    expect(removed.assetCleanup).toEqual(cleanup({}));
    expect(await h.store.getNode(doc.documentNodeId)).not.toBeNull();
    expect(h.store.getDocument(doc.documentId)).not.toBeNull();
    expect(owners(h.db)).toEqual([{ documentId: doc.documentId, nodeId: doc.documentNodeId }]);
    expect(assetContentFiles(h.dir)).toEqual([`${doc.assetSha256}.txt`]);
    expectInvariants(h);
  }, 120_000);

  test("A2: metadata.absorbedDocumentIds 가 배열이 아닌 메시지 기억도 메시지 삭제·단건 삭제가 200 으로 지운다", async () => {
    const h = await makeHarness();
    const viaMessage = await saveMessageText(h, "토요일 아침 산책 코스는 강변으로 정했다", "msg-a2", { absorbedDocumentIds: "not-an-array" });
    const viaForget = await saveMessageText(h, "일요일 저녁 장보기 목록은 우유와 달걀이다", "msg-a2b", { absorbedDocumentIds: { bad: 1 } });

    const deleted = await deleteMessage(h, "msg-a2");
    expect(deleted.deletedIds).toEqual([viaMessage]);
    expect(deleted.assetCleanup).toEqual(cleanup({}));
    const removed = await permanentlyDelete(h, viaForget);
    expect(removed.assetCleanup).toEqual(cleanup({}));

    expect(count(h.db, "knowledge_nodes")).toBe(0);
    expectInvariants(h);
  }, 120_000);

  test("A3: 그런 기억 하나가 휴지통에 있어도 보관 만료가 휴지통을 모두 비운다", async () => {
    const h = await makeHarness();
    const normal = await call(h, "POST", "/memories", { content: "화분에 물은 일주일에 두 번 준다", author: ATTRIBUTION.author });
    const poisoned = await call(h, "POST", "/memories", {
      content: "회의실 예약은 오전에 한다", author: ATTRIBUTION.author, metadata: { absorbedDocumentIds: 42 },
    });
    await trash(h, normal.body.id as number);
    await trash(h, poisoned.body.id as number);

    const summary = await expireTrash(h);

    expect(summary.nodesPurged).toBe(2);
    expect(summary.assetCleanup).toEqual(cleanup({}));
    expect(count(h.db, "knowledge_nodes_archive")).toBe(0);
    expectInvariants(h);
  }, 120_000);

  test("B1: 글 + 같은 본문 .txt 첨부(흡수)를 백필한 추출 자식(첨부 청크의 자식)을 /forget 해도 기록·파일은 남는다", async () => {
    const h = await makeHarness(true);
    const textId = await saveMessageText(h, TEXT, "msg-b1");
    const doc = await ingestTextFile(h, "book.txt", "text/plain", TEXT, "msg-b1");
    expect(doc.documentNodeId).toBe(textId);
    expect(owners(h.db)).toEqual([{ documentId: doc.documentId, nodeId: textId }]);
    expect((await h.store.getNode(textId))!.metadata).not.toHaveProperty("absorbedDocumentIds");
    await backfillOnce(h);
    const childId = nodeIdByContent(h.db, CHILD);

    const removed = await permanentlyDelete(h, childId);

    expect(removed.assetCleanup).toEqual(cleanup({}));
    expect(h.store.getDocument(doc.documentId)).not.toBeNull();
    expect(owners(h.db)).toEqual([{ documentId: doc.documentId, nodeId: textId }]);
    expect(assetContentFiles(h.dir)).toEqual([`${doc.assetSha256}.txt`]);
    expectInvariants(h);
  }, 240_000);

  test("B2: by-id 편집 뒤 재추출한 자식을 /forget 해도 기록·파일은 남고, 메시지를 지우면 글 노드와 함께 해제된다", async () => {
    const h = await makeHarness(true);
    const textId = await saveMessageText(h, TEXT, "msg-b2");
    const doc = await ingestTextFile(h, "book.txt", "text/plain", TEXT, "msg-b2");
    expect(doc.documentNodeId).toBe(textId);
    await backfillOnce(h);
    expect((await call(h, "PATCH", `/memories/${textId}`, { content: EDIT })).status).toBe(200);
    await backfillOnce(h);
    const editChildId = nodeIdByContent(h.db, EDIT_CHILD);

    const forgotten = await permanentlyDelete(h, editChildId);
    expect(forgotten.assetCleanup).toEqual(cleanup({}));
    expect(h.store.getDocument(doc.documentId)).not.toBeNull();
    expect(assetContentFiles(h.dir)).toEqual([`${doc.assetSha256}.txt`]);
    expectInvariants(h);

    const deleted = await deleteMessage(h, "msg-b2");
    expect(deleted.deletedIds).toEqual([textId]);
    expect(deleted.assetCleanup).toEqual(cleanup({ documentIds: [doc.documentId], removedSha256s: [doc.assetSha256] }));
    expect(h.store.getDocument(doc.documentId)).toBeNull();
    expect(owners(h.db)).toEqual([]);
    expect(assetContentFiles(h.dir)).toEqual([]);
    expectInvariants(h);
  }, 240_000);
});

describe("주인 표 — 흡수·휴지통·보관 만료", () => {
  test("같은 .md 를 두 번 올리면 주인 행 2개가 같은 문서 노드를 가리키고, 노드 영구 삭제가 둘 다 해제한다", async () => {
    const h = await makeHarness();
    const first = await ingestTextFile(h, "book.md", "text/markdown", NOTE_MD);
    const second = await ingestTextFile(h, "book.md", "text/markdown", NOTE_MD);
    expect(second.documentNodeId).toBe(first.documentNodeId);
    const bothIds = [first.documentId, second.documentId].sort();
    expect(owners(h.db)).toEqual(bothIds.map((documentId) => ({ documentId, nodeId: first.documentNodeId })));
    expect((await h.store.getNode(first.documentNodeId))!.metadata).not.toHaveProperty("absorbedDocumentIds");
    expectInvariants(h);

    const removed = await permanentlyDelete(h, first.documentNodeId);

    expect(removed.assetCleanup).toEqual(cleanup({ documentIds: bothIds, removedSha256s: [first.assetSha256] }));
    expect(owners(h.db)).toEqual([]);
    expect(count(h.db, "documents")).toBe(0);
    expect(assetContentFiles(h.dir)).toEqual([]);
    expectInvariants(h);
  }, 120_000);

  test("글 + 같은 본문 .txt: 글 노드가 주인이고 휴지통 이동·복원 뒤에도 그대로이며, 메시지 삭제로 해제된다", async () => {
    const h = await makeHarness();
    const textId = await saveMessageText(h, NOTE_TXT, "msg-text");
    const doc = await ingestTextFile(h, "camp.txt", "text/plain", NOTE_TXT, "msg-text");
    expect(doc.documentNodeId).toBe(textId);
    const owned = [{ documentId: doc.documentId, nodeId: textId }];
    expect(owners(h.db)).toEqual(owned);

    await trash(h, textId);
    expect(await h.store.getNode(textId)).toBeNull();
    expect(owners(h.db)).toEqual(owned);
    expect(h.store.getDocument(doc.documentId)).not.toBeNull();
    expect(assetContentFiles(h.dir)).toEqual([`${doc.assetSha256}.txt`]);
    expectInvariants(h);

    expect((await call(h, "POST", `/archive/${textId}/restore`)).status).toBe(200);
    expect(await h.store.getNode(textId)).not.toBeNull();
    expect(owners(h.db)).toEqual(owned);
    expectInvariants(h);

    const deleted = await deleteMessage(h, "msg-text");
    expect(deleted.deletedIds).toEqual([textId]);
    expect(deleted.assetCleanup).toEqual(cleanup({ documentIds: [doc.documentId], removedSha256s: [doc.assetSha256] }));
    expect(owners(h.db)).toEqual([]);
    expect(assetContentFiles(h.dir)).toEqual([]);
    expectInvariants(h);
  }, 120_000);

  test("휴지통에 있는 주인 노드의 보관 만료가 그 기록·원장 행·파일을 해제한다", async () => {
    const h = await makeHarness();
    const doc = await ingestTextFile(h, "camp.txt", "text/plain", NOTE_TXT);
    await trash(h, doc.documentNodeId);
    expect(owners(h.db)).toEqual([{ documentId: doc.documentId, nodeId: doc.documentNodeId }]);

    const summary = await expireTrash(h);

    expect(summary.assetCleanup).toEqual(cleanup({ documentIds: [doc.documentId], removedSha256s: [doc.assetSha256] }));
    expect(owners(h.db)).toEqual([]);
    expect(count(h.db, "documents")).toBe(0);
    expect(count(h.db, "asset_file_imports")).toBe(0);
    expect(assetContentFiles(h.dir)).toEqual([]);
    expectInvariants(h);
  }, 120_000);
});

/** 외래 키를 끈 외부 도구가 documents 행만 지운 상태 — 주인 행·원장 행·파일은 남는다(설계 2 의 사례, 재현 P1). */
function dropDocumentRecordRow(h: Harness, documentId: string): void {
  h.db.run("PRAGMA foreign_keys = OFF");
  h.db.run("DELETE FROM documents WHERE document_id = ?", [documentId]);
  h.db.run("PRAGMA foreign_keys = ON");
}

describe("설계 2 — 주인 행이 없는 기록을 가리키면 기록 id 를 담은 오류로 멈춘다", () => {
  test("외래 키를 끄고 기록 행을 지운 DB: 영구 삭제가 기록 id 를 본문에 실은 500 으로 멈추고(바깥 앱에 붙여도 같다) 아무것도 지우지 않으며, 불변식 도우미가 그 어긋남을 알린다", async () => {
    const h = await makeHarness();
    const doc = await ingestTextFile(h, "camp.txt", "text/plain", NOTE_TXT);
    dropDocumentRecordRow(h, doc.documentId);
    const nodesBefore = count(h.db, "knowledge_nodes");

    const errors = spyOn(console, "error");
    let direct: { status: number; body: Json };
    let mounted: { status: number; body: Json };
    let logged: string[];
    try {
      direct = await call(h, "DELETE", `/memories/${doc.documentNodeId}`);
      // 재QA2 M1: 같은 앱을 바깥 앱에 route("/", app) 으로 붙여도 본문이 Hono 기본 문구로 바뀌지 않는다.
      mounted = await callApp(new Hono().route("/", h.app), "DELETE", `/memories/${doc.documentNodeId}`);
      logged = errors.mock.calls.map((args) => args.map(String).join(" "));
    } finally {
      errors.mockRestore();
    }
    expect(direct.status).toBe(500);
    expect(direct.body.error).toContain(doc.documentId);
    expect(mounted).toEqual(direct);
    expect(logged.some((line) => line.includes(doc.documentId))).toBe(true);

    let thrown: unknown = null;
    try {
      await h.store.deleteNode(doc.documentNodeId);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OwnedDocumentRecordMissingError);
    expect((thrown as OwnedDocumentRecordMissingError).documentIds).toEqual([doc.documentId]);
    expect((thrown as Error).message).toContain(doc.documentId);
    expect(direct.body.error).toBe((thrown as Error).message);

    // 트랜잭션이 되돌아가 노드·주인 행·원장 행·파일이 그대로다.
    expect(count(h.db, "knowledge_nodes")).toBe(nodesBefore);
    expect(owners(h.db)).toEqual([{ documentId: doc.documentId, nodeId: doc.documentNodeId }]);
    expect(count(h.db, "asset_file_imports")).toBe(1);
    expect(assetContentFiles(h.dir)).toEqual([`${doc.assetSha256}.txt`]);
    const ledgerImportId = (h.db.query("SELECT import_id FROM asset_file_imports").get() as { import_id: string }).import_id;
    expect(assetInvariantViolations(h.db, h.dir)).toEqual([
      `asset_file_imports ${ledgerImportId}: source_ref(document:${doc.documentId}) 가 있는 기록·노드를 가리키지 않음`,
      `document 노드 ${doc.documentNodeId}: metadata.documentId(${doc.documentId}) 가 자기 주인 행이 아님`,
      "foreign_key_check: document_record_owners -> documents",
    ].sort());
  }, 120_000);

  test("재QA2 M2: 같은 DB 를 다시 시작하면 시작 정리 (c) 가 그 기록의 document: 원장 행도 지워 주인 행·원장 행·asset_files 행·파일이 0 이 되고, 남은 문서 노드는 평소처럼 영구 삭제된다", async () => {
    const h = await makeHarness();
    const doc = await ingestTextFile(h, "camp.txt", "text/plain", NOTE_TXT);
    dropDocumentRecordRow(h, doc.documentId);

    const logs = spyOn(console, "log");
    let boot: Awaited<ReturnType<typeof installAssetFileRemover>>;
    let logged: string[];
    try {
      boot = await installAssetFileRemover(h.store, new AssetStore(h.dir));
      logged = logs.mock.calls.map((args) => args.map(String).join(" "));
    } finally {
      logs.mockRestore();
    }

    expect(boot.cleanup).toEqual(cleanup({ removedSha256s: [doc.assetSha256] }));
    expect(logged).toContain(
      "[memory-api] 시작 때 문서 기록 정리 — 주인 행 없는 기록 해제 0, 주인 노드가 없는 기록 해제 0, " +
        "기록 없는 주인 행 지움 1, 그 기록의 원장 행이 가리키던 파일 1",
    );
    expect(owners(h.db)).toEqual([]);
    expect(count(h.db, "asset_file_imports")).toBe(0);
    expect(count(h.db, "asset_files")).toBe(0);
    expect(assetContentFiles(h.dir)).toEqual([]);
    // (c) 는 노드를 건드리지 않는다 — 남는 어긋남은 주인 행이 없는 문서 노드 한 줄뿐이다.
    expect(assetInvariantViolations(h.db, h.dir)).toEqual([
      `document 노드 ${doc.documentNodeId}: metadata.documentId(${doc.documentId}) 가 자기 주인 행이 아님`,
    ]);
    // 주인 행이 없어졌으니 그 노드의 영구 삭제는 더 이상 멈추지 않고, 지운 뒤 두 불변식이 선다.
    const removed = await permanentlyDelete(h, doc.documentNodeId);
    expect(removed.assetCleanup).toEqual(cleanup({}));
    expect(count(h.db, "knowledge_nodes")).toBe(0);
    expectInvariants(h);
  }, 120_000);
});
