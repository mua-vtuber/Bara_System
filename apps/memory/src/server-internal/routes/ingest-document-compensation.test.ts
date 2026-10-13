/**
 * ingest-document-compensation.test.ts — POST /ingest 문서 갈래의 보상과 시작 기록 정리(WP-B1-20U 설계 17.18 설계 3, 단계 U10b).
 *
 * 재QA 재현 C(먼저 옮긴 빨간 테스트): 자산 묶음(store.recordDocumentAssets)이 문서 기록·원장 행·파일을 커밋한 뒤
 * ingestDocument 가 실패하면(여기서는 문서 노드 INSERT 를 막는 SQLite 트리거) 500 만 내고 기록·원장 행·asset_files 행·
 * 파일이 주인 없이 영영 남았다. 이제 500 직후 모두 0 이고, 응답 문구 끝과 오류 로그가 보상 결과를 알린다.
 * 더해서: 파싱 실패 갈래도 같음, 같은 파일을 다른 기록이 가지면 파일은 남음, 파일 지우기 함수를 넣지 않은 저장소는 문구에
 * 실패 수가 붙고 asset_files 행이 대기로 남았다가 설치 함수(시작)가 지움, documents 삭제도 막히면 두 원인이 함께 나가고
 * 트리거를 지운 뒤 시작 정리 (a) 가 해제, (b)·(c) 는 SQL 로 만든 상태에서 시작 정리가 처리, 노드 저장 커밋 뒤의 실패는
 * 기록을 그대로 둔다.
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 임시 디렉터리의 실제 AssetStore + 실제 Hono 라우트. 파일 지우기 함수는 서버
 * 부팅과 같은 installAssetFileRemover 로 넣는다. 실패는 실제 SQLite 트리거로 만든다(노드 저장 커밋 뒤 실패만 블록에 실제
 * ingestDocument 를 돌린 뒤 던지는 단계로 만든다). mock 0.
 */

import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssetStore, assetSha256 } from "../../assets/asset-store.ts";
import type { AssetCleanup } from "../../assets/released-asset-files.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { ASSET_FILE_REMOVER_MISSING } from "../../db/store-internal/asset-release.ts";
import { nowKst } from "../../db/store-internal/helpers.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { ingestDocument } from "../../memory/ingest-document.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { buildMemoryApi } from "../../server.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import { ensureAssetFolderPairing, installAssetFileRemover } from "../asset-file-remover-boot.ts";
import { assetContentFiles, assetInvariantViolations } from "../../test-utils/asset-invariant.ts";
import { lineageOrphans } from "../../test-utils/lineage-invariant.ts";
import { runDocumentRecordBlock } from "./ingest-document-compensation.ts";

const DISCORD_SOURCE = "discord-channel";
const DASHBOARD_SOURCE = "dashboard:manual";
const ATTRIBUTION = { author: "owner", userId: "user-1" };
const JSON_HEADERS = { "content-type": "application/json" };
const NOTE_TXT = "캠핑 준비물\n\n텐트와 침낭은 금요일 저녁까지 차에 싣는다. 버너 가스는 두 통 챙긴다.";
const NOTE_SHA = assetSha256(new TextEncoder().encode(NOTE_TXT));
/** 파싱이 실패하는 PDF(머리 글자만 있는 9바이트) — ingest-asset-ledger.test.ts 와 같은 바이트. */
const BROKEN_PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x62, 0x72, 0x6f, 0x6b]);
const NODE_INSERT_BLOCKED = "test: document node insert blocked";
const BLOCK_DOCUMENT_NODE =
  `CREATE TRIGGER block_document_node BEFORE INSERT ON knowledge_nodes WHEN NEW.source_type = 'document' ` +
  `BEGIN SELECT RAISE(ABORT, '${NODE_INSERT_BLOCKED}'); END;`;
const DOCUMENTS_DELETE_BLOCKED = "test: documents delete blocked";
const BLOCK_DOCUMENTS_DELETE =
  `CREATE TRIGGER block_documents_delete BEFORE DELETE ON documents BEGIN SELECT RAISE(ABORT, '${DOCUMENTS_DELETE_BLOCKED}'); END;`;
const SAVE_FAILED = `document 노드 저장 실패: ${NODE_INSERT_BLOCKED}`;

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
}, 180_000);

interface Harness { app: Hono; db: Database; store: SqliteMemoryStore; assetStore: AssetStore; dir: string }
const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

async function makeHarness(opts: { remover?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "bara-ingest-compensation-"));
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const assetStore = new AssetStore(dir);
  // remover 없는 저장소도 실제 부팅처럼 첨부를 저장하기 전에 DB·첨부 폴더 짝을 먼저 맺는다(설계 17.19 설계 4).
  if (opts.remover !== false) await installAssetFileRemover(store, assetStore);
  else await ensureAssetFolderPairing(store, assetStore);
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  const app = buildMemoryApi({
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(), assetStore,
    getSettings: () => settings,
  });
  const h = { app, db, store, assetStore, dir };
  harnesses.push(h);
  return h;
}

type Json = Record<string, unknown>;

async function call(h: Harness, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await h.app.request(path, {
    method,
    ...(body === undefined ? {} : { headers: JSON_HEADERS, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) as Json : { text } };
}

function count(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

function assetRowCounts(db: Database): Record<string, number> {
  return Object.fromEntries(
    ["documents", "document_record_owners", "asset_file_imports", "asset_files", "knowledge_nodes"].map((t) => [t, count(db, t)]),
  );
}

const NO_ROWS = { documents: 0, document_record_owners: 0, asset_file_imports: 0, asset_files: 0, knowledge_nodes: 0 };

function cleanup(partial: Partial<AssetCleanup>): AssetCleanup {
  return { documentIds: [], removedSha256s: [], missingSha256s: [], failed: [], ...partial };
}

/** content/ 훑기가 지울 것도 알릴 것도 없을 때의 결과(시작 정리 반환값의 strayFiles). */
const NO_STRAY_FILES = { removed: [], failed: [], unrecognized: [] };

function expectInvariants(h: Harness, pendingSha256s: readonly string[] = []): void {
  expect(lineageOrphans(h.db)).toEqual([]);
  expect(assetInvariantViolations(h.db, h.dir, pendingSha256s)).toEqual([]);
}

/** 파일 이름이 있는 글 파일(문서 갈래) — 대시보드 업로드. */
function uploadNote(h: Harness): Promise<{ status: number; body: Json }> {
  return call(h, "POST", "/ingest", {
    source: DASHBOARD_SOURCE,
    content: { type: "text", data: NOTE_TXT, mimeType: "text/plain", originalName: "camp.txt" },
    attribution: ATTRIBUTION,
  });
}

/** work 를 돌리는 동안 console 의 한 함수가 받은 줄(인자를 이어 붙인 글). */
async function captureConsole<T>(method: "error" | "log", work: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const spy = spyOn(console, method);
  try {
    const value = await work();
    return { value, lines: spy.mock.calls.map((args) => args.map(String).join(" ")) };
  } finally {
    spy.mockRestore();
  }
}

/** 저장소의 자산 묶음만으로 NOTE_TXT 의 문서 기록·원장 행·파일을 쓴다(노드 없음). */
function recordNote(h: Harness): Promise<{ documentId: string }> {
  const bytes = new TextEncoder().encode(NOTE_TXT);
  return h.store.recordDocumentAssets({
    writer: h.assetStore,
    files: [{ sha256: NOTE_SHA, byteSize: bytes.byteLength, bytes, ext: "txt", assetType: "text", mimeType: "text/plain" }],
    document: { assetSha256: NOTE_SHA, title: "camp.txt", documentType: "free", sourceMetadata: {} },
    ledger: { source: DASHBOARD_SOURCE, ...ATTRIBUTION },
  });
}

function onlyDocumentId(db: Database): string {
  const rows = db.query("SELECT document_id AS id FROM documents").all() as Array<{ id: string }>;
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

/** 시작 정리 로그 줄 — (a) 주인 행 없는 기록, (b) 주인 노드가 없는 기록, (c) 기록 없는 주인 행 수, (c) 가 지운 원장 행이 가리키던 파일 수. */
const startupRecordLog = (a: number, b: number, c: number, ledgerFiles = 0) =>
  `[memory-api] 시작 때 문서 기록 정리 — 주인 행 없는 기록 해제 ${a}, 주인 노드가 없는 기록 해제 ${b}, 기록 없는 주인 행 지움 ${c}, ` +
  `그 기록의 원장 행이 가리키던 파일 ${ledgerFiles}`;

describe("재QA 재현 C — 자산 묶음 커밋 뒤 문서 노드 저장이 실패하면 기록을 되돌린다", () => {
  test("C: 500 직후 기록·원장 행·asset_files 행·파일이 0 이고, 응답과 오류 로그가 원인과 되돌린 기록 id 를 알린다", async () => {
    const h = await makeHarness();
    h.db.exec(BLOCK_DOCUMENT_NODE);

    const { value: res, lines } = await captureConsole("error", () =>
      call(h, "POST", "/ingest", {
        source: DISCORD_SOURCE,
        content: { type: "text", data: NOTE_TXT, mimeType: "text/plain", originalName: "camp.txt" },
        attribution: ATTRIBUTION,
        sourceMessage: { platform: "discord", messageId: "msg-c", channelId: "channel-1", attachmentId: "att-1" },
      }));

    expect(res.status).toBe(500);
    const message = res.body.error as string;
    const match = /^document 노드 저장 실패: (.+) — 문서 기록 되돌림\((doc_[^)]+)\)$/.exec(message);
    expect(match).not.toBeNull();
    expect(match![1]).toContain(NODE_INSERT_BLOCKED);
    expect(lines).toContain(`[ingest] 문서 기록 ${match![2]}: ${message}`);
    expect(assetRowCounts(h.db)).toEqual(NO_ROWS);
    expect(count(h.db, "memory_node_sources")).toBe(0);
    expect(assetContentFiles(h.dir)).toEqual([]);
    expectInvariants(h);
  }, 120_000);

  test("파싱 실패 갈래도 같다 — 깨진 PDF 의 기록·원장 행·파일이 500 직후 0 이다", async () => {
    const h = await makeHarness();
    h.db.exec(BLOCK_DOCUMENT_NODE);

    const res = await call(h, "POST", "/ingest", {
      source: DASHBOARD_SOURCE,
      content: { type: "auto", data: BROKEN_PDF.toString("base64"), mimeType: "application/pdf", originalName: "broken.pdf" },
      attribution: ATTRIBUTION,
    });

    expect(res.status).toBe(500);
    expect(res.body.error as string).toMatch(new RegExp(`^${SAVE_FAILED} — 문서 기록 되돌림\\(doc_[^)]+\\)$`));
    expect(assetRowCounts(h.db)).toEqual(NO_ROWS);
    expect(assetContentFiles(h.dir)).toEqual([]);
    expectInvariants(h);
  }, 120_000);

  test("같은 파일을 다른 기록이 가지면 되돌린 기록의 원장 행만 지우고 파일·asset_files 행은 남는다", async () => {
    const h = await makeHarness();
    const first = await uploadNote(h);
    expect(first.status).toBe(201);
    const firstDocumentId = first.body.documentId as string;
    const firstNodeId = (first.body.nodeIds as number[])[0]!;
    // 휴지통 노드는 같은 본문 흡수 대상이 아니라 두 번째 업로드가 새 문서 노드를 INSERT 하려 한다.
    expect((await call(h, "POST", `/memories/${firstNodeId}/trash`)).status).toBe(200);
    h.db.exec(BLOCK_DOCUMENT_NODE);

    const second = await uploadNote(h);

    expect(second.status).toBe(500);
    const match = new RegExp(`^${SAVE_FAILED} — 문서 기록 되돌림\\((doc_[^)]+)\\)$`).exec(second.body.error as string);
    expect(match).not.toBeNull();
    expect(match![1]).not.toBe(firstDocumentId);
    expect(h.store.getDocument(match![1]!)).toBeNull();
    expect(h.store.getDocument(firstDocumentId)).not.toBeNull();
    expect(h.db.query("SELECT document_id AS documentId, node_id AS nodeId FROM document_record_owners").all())
      .toEqual([{ documentId: firstDocumentId, nodeId: firstNodeId }]);
    expect(h.db.query("SELECT source_ref AS ref FROM asset_file_imports").all()).toEqual([{ ref: `document:${firstDocumentId}` }]);
    expect(count(h.db, "asset_files")).toBe(1);
    expect(assetContentFiles(h.dir)).toEqual([`${NOTE_SHA}.txt`]);
    expectInvariants(h);
  }, 120_000);
});

describe("보상 결과 문구와 시작 정리", () => {
  test("파일 지우기 함수를 넣지 않은 저장소: 문구에 실패 수·원인이 붙고 asset_files 행이 대기로 남았다가 설치 함수가 지운다", async () => {
    const h = await makeHarness({ remover: false });
    h.db.exec(BLOCK_DOCUMENT_NODE);
    const filePath = h.assetStore.path(NOTE_SHA, "txt");

    const res = await uploadNote(h);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe(
      `${SAVE_FAILED} — 문서 기록은 되돌렸으나 파일 1개를 지우지 못함(다음 시작 때 다시 지움): ` +
        `${NOTE_SHA} ${filePath} — ${ASSET_FILE_REMOVER_MISSING}`,
    );
    expect(assetRowCounts(h.db)).toEqual({ ...NO_ROWS, asset_files: 1 });
    expect(assetContentFiles(h.dir)).toEqual([`${NOTE_SHA}.txt`]);
    expectInvariants(h, [NOTE_SHA]);

    const boot = await installAssetFileRemover(h.store, h.assetStore);
    expect(boot).toEqual({ cleanup: cleanup({ removedSha256s: [NOTE_SHA] }), strayFiles: NO_STRAY_FILES });
    expect(assetRowCounts(h.db)).toEqual(NO_ROWS);
    expect(assetContentFiles(h.dir)).toEqual([]);
    expectInvariants(h);
  }, 120_000);

  test("documents 삭제도 막히면 두 원인이 함께 나가고, 트리거를 지운 뒤 시작 정리 (a) 가 주인 행 없는 기록을 해제한다", async () => {
    const h = await makeHarness();
    h.db.exec(BLOCK_DOCUMENT_NODE);
    h.db.exec(BLOCK_DOCUMENTS_DELETE);

    const { value: res, lines } = await captureConsole("error", () => uploadNote(h));

    const expected = `${SAVE_FAILED} — 문서 기록 되돌리기도 실패: ${DOCUMENTS_DELETE_BLOCKED}(다음 시작 때 정리)`;
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(expected);
    const documentId = onlyDocumentId(h.db);
    expect(lines).toContain(`[ingest] 문서 기록 ${documentId}: ${expected}`);
    expect(assetRowCounts(h.db)).toEqual({ ...NO_ROWS, documents: 1, asset_file_imports: 1, asset_files: 1 });
    expect(assetContentFiles(h.dir)).toEqual([`${NOTE_SHA}.txt`]);
    expect(assetInvariantViolations(h.db, h.dir)).toEqual([`documents ${documentId}: 주인 행 없음`]);

    h.db.exec("DROP TRIGGER block_document_node");
    h.db.exec("DROP TRIGGER block_documents_delete");
    const { value: boot, lines: logs } = await captureConsole("log", () => installAssetFileRemover(h.store, h.assetStore));

    expect(boot).toEqual({ cleanup: cleanup({ documentIds: [documentId], removedSha256s: [NOTE_SHA] }), strayFiles: NO_STRAY_FILES });
    expect(logs).toContain(startupRecordLog(1, 0, 0));
    expect(assetRowCounts(h.db)).toEqual(NO_ROWS);
    expect(assetContentFiles(h.dir)).toEqual([]);
    expectInvariants(h);
  }, 120_000);

  test("시작 정리 (b): 주인 노드가 두 표 어디에도 없는 기록(SQL 로 만든 상태)을 같은 해제 루틴으로 지운다", async () => {
    const h = await makeHarness();
    const saved = await call(h, "POST", "/memories", { content: "화분에 물은 일주일에 두 번 준다", author: ATTRIBUTION.author });
    expect(saved.status).toBe(201);
    const goneNodeId = saved.body.id as number;
    expect((await call(h, "DELETE", `/memories/${goneNodeId}`)).status).toBe(200);
    const recorded = await recordNote(h);
    // 영구 삭제된 노드를 주인으로 적은 행 — 외부 도구가 노드만 지운 상태와 같다.
    h.db.run("INSERT INTO document_record_owners (document_id, node_id, created_at) VALUES (?, ?, ?)",
      [recorded.documentId, goneNodeId, nowKst()]);
    expect(assetInvariantViolations(h.db, h.dir))
      .toEqual([`documents ${recorded.documentId}: 주인 노드 ${goneNodeId} 가 두 표 어디에도 없음`]);

    const { value: boot, lines: logs } = await captureConsole("log", () => installAssetFileRemover(h.store, h.assetStore));

    expect(boot).toEqual({ cleanup: cleanup({ documentIds: [recorded.documentId], removedSha256s: [NOTE_SHA] }), strayFiles: NO_STRAY_FILES });
    expect(logs).toContain(startupRecordLog(0, 1, 0));
    expect(assetRowCounts(h.db)).toEqual(NO_ROWS);
    expect(assetContentFiles(h.dir)).toEqual([]);
    expectInvariants(h);
  }, 120_000);

  test("시작 정리 (c): 기록 없는 주인 행(외래 키를 끄고 기록 행을 지운 상태)과 그 기록의 원장 행을 지워 파일까지 정리하고 수를 로그한다", async () => {
    const h = await makeHarness();
    const up = await uploadNote(h);
    expect(up.status).toBe(201);
    const documentId = up.body.documentId as string;
    const documentNodeId = (up.body.nodeIds as number[])[0]!;
    h.db.run("PRAGMA foreign_keys = OFF");
    h.db.run("DELETE FROM documents WHERE document_id = ?", [documentId]);
    h.db.run("PRAGMA foreign_keys = ON");
    const nodesBefore = count(h.db, "knowledge_nodes");

    const { value: boot, lines: logs } = await captureConsole("log", () => installAssetFileRemover(h.store, h.assetStore));

    // (c) 는 주인 행과 그 기록의 원장 행(`document:<id>`)을 같은 트랜잭션에서 지운다(재QA2 M2). 그 파일은 참조를 잃어 같은
    // 시작의 참조 없는 행 지우기가 지운다 — 기록은 이미 없어 cleanup.documentIds 에는 오르지 않는다.
    expect(boot).toEqual({ cleanup: cleanup({ removedSha256s: [NOTE_SHA] }), strayFiles: NO_STRAY_FILES });
    expect(logs).toContain(startupRecordLog(0, 0, 1, 1));
    expect(assetRowCounts(h.db)).toEqual({ ...NO_ROWS, knowledge_nodes: nodesBefore });
    expect(assetContentFiles(h.dir)).toEqual([]);
    // 문서 노드는 (c) 의 대상이 아니라 남고, 주인 행이 없는 그 노드의 metadata 어긋남만 보인다.
    expect(assetInvariantViolations(h.db, h.dir)).toEqual([
      `document 노드 ${documentNodeId}: metadata.documentId(${documentId}) 가 자기 주인 행이 아님`,
    ]);
  }, 120_000);

  test("노드 저장이 커밋된 뒤의 실패는 기록·원장 행·파일을 그대로 두고 문구가 그렇게 알린다", async () => {
    const h = await makeHarness();
    const recorded = await recordNote(h);
    const afterCommit = "test: failure after the document node commit";
    let nodeId = 0;

    const result = await runDocumentRecordBlock(h.store, recorded.documentId, async () => {
      const ingested = await ingestDocument(h.store, {
        documentId: recorded.documentId, assetSha256: NOTE_SHA, title: "camp.txt", rawContent: NOTE_TXT,
        documentType: "free", chunks: [], author: ATTRIBUTION.author, platform: DASHBOARD_SOURCE,
      });
      nodeId = ingested.documentNodeId;
      throw new Error(afterCommit);
    });

    expect(result).toEqual({ ok: false, message: `document 노드 저장 실패: ${afterCommit} — 문서 노드는 저장됨(기록 유지)` });
    expect(h.db.query("SELECT document_id AS documentId, node_id AS nodeId FROM document_record_owners").all())
      .toEqual([{ documentId: recorded.documentId, nodeId }]);
    expect(assetRowCounts(h.db)).toEqual({
      documents: 1, document_record_owners: 1, asset_file_imports: 1, asset_files: 1, knowledge_nodes: 1,
    });
    expect(assetContentFiles(h.dir)).toEqual([`${NOTE_SHA}.txt`]);
    expectInvariants(h);
  }, 120_000);
});
