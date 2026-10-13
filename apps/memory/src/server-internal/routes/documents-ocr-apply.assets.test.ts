/**
 * documents-ocr-apply.assets.test.ts — OCR 변환본(canonical markdown)은 문서 기록의 자산 묶음으로 쓴다(WP-B1-20U 설계 17.18
 * 설계 4, 결정 D29·D32, 단계 U10d).
 *
 * 재QA 재현 E(먼저 옮긴 빨간 테스트): OCR 적용이 변환본을 항상 `.md` 로 쓰고(sha 가 행으로 이미 있는지 보지 않고) 원장 행도
 * 쓰지 않았다. 스캔 PDF 의 OCR 결과가 먼저 올린 `.txt` 문서와 같은 바이트면 같은 sha 의 `.md` 사본이 asset_files 행 없이 따로
 * 생기고, 그 문서를 지워도 `.txt` 파일이 남았다. 이제 변환본은 store.recordOcrCanonicalAsset(쓰기 잠금 안 자산 묶음)으로 쓴다:
 *   - 그 sha 의 행이 이미 있으면 그 행의 확장자를 쓴다(`.txt` 행이면 `.md` 사본이 생기지 않는다).
 *   - 그 기록의 원장 행(`document:<id>`, source·author `document-ocr`, user_id = 문서 노드 metadata user_id)을 같은 트랜잭션에서
 *     쓴다 — 변환본이 쓰이는 순간부터 기록에 묶여 다른 삭제가 지우지 못하고, 기록이 지워질 때 함께 지워진다.
 *   - 기록이 그 사이 지워졌으면 아무것도 쓰지 않고 404(파일·행 0).
 *   - 묶음의 바이트 확인(AssetBundleBytesMismatchError)을 그대로 거친다.
 * 더해서: 행 없는 sha 는 `.md` 파일과 원장 행 하나, 같은 Markdown 재적용은 원장 행을 겹쳐 쓰지 않음, 다른 Markdown 으로 다시
 * 적용하면 옛 변환본은 기록이 지워질 때까지 남았다가 함께 지워짐, 문서 노드 metadata 에 user_id 가 없으면 409 이고 아무것도
 * 쓰지 않음.
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 임시 디렉터리의 실제 AssetStore + 실제 Hono 라우트. 파일 지우기 함수는 서버 부팅과 같은
 * installAssetFileRemover 로 넣는다. 모든 제거 뒤 계보·자산 불변식 도우미가 빈 목록이다. mock 0.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssetStore, assetSha256 } from "../../assets/asset-store.ts";
import type { AssetCleanup } from "../../assets/released-asset-files.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { AssetBundleBytesMismatchError } from "../../db/store-internal/asset-repository.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { withMemoryMutationLock } from "../../memory/shared-memory-mutation-lock.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { buildMemoryApi } from "../../server.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import { installAssetFileRemover } from "../asset-file-remover-boot.ts";
import { assetContentFiles, assetInvariantViolations } from "../../test-utils/asset-invariant.ts";
import { lineageOrphans } from "../../test-utils/lineage-invariant.ts";

const DASHBOARD_SOURCE = "dashboard:manual";
const ATTRIBUTION = { author: "owner", userId: "user-1" };
const JSON_HEADERS = { "content-type": "application/json" };
const LOCK_SETTLE_MS = 500;
const OCR_ACTOR = "document-ocr";

const OCR_MD = "# 스캔 영수증\n\n## 품목\n\n연필 세 자루와 공책 두 권을 샀다.\n\n## 결제\n\n카드로 오천 원을 냈다.";
const OCR_MD_OTHER = "# 스캔 영수증 (재인식)\n\n## 품목\n\n연필 세 자루, 공책 두 권, 지우개 한 개를 샀다.\n\n## 결제\n\n카드로 육천 원을 냈다.";
const SCANNED_PDF_FIXTURE = join(import.meta.dir, "..", "..", "memory", "canonicalize", "__fixtures__", "scanned.pdf");
const PDF_NAME = "receipt.pdf";
const OCR_NAME = `${PDF_NAME}.ocr.md`;

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

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "bara-ocr-apply-assets-"));
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const assetStore = new AssetStore(dir);
  await installAssetFileRemover(store, assetStore);
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  const app = buildMemoryApi({
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(),
    assetStore, getSettings: () => settings,
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
  return { status: res.status, body: await res.json() as Json };
}

interface IngestedDocument { documentNodeId: number; documentId: string; assetSha256: string }

async function ingest(h: Harness, content: Json): Promise<IngestedDocument> {
  const res = await call(h, "POST", "/ingest", { source: DASHBOARD_SOURCE, content, attribution: ATTRIBUTION });
  expect(res.status).toBe(201);
  return {
    documentNodeId: (res.body.nodeIds as number[])[0]!,
    documentId: res.body.documentId as string,
    assetSha256: res.body.assetSha256 as string,
  };
}

/** 글자 그대로 올라온 파일(.txt) — 파일 이름이 있어 문서 갈래. */
function uploadText(h: Harness, name: string, data: string): Promise<IngestedDocument> {
  return ingest(h, { type: "text", data, mimeType: "text/plain", originalName: name });
}

/** 글자가 없는 스캔 PDF — 변환본이 없어 OCR 후보(needs_ocr)가 된다. */
function uploadScannedPdf(h: Harness): Promise<IngestedDocument> {
  return ingest(h, {
    type: "auto", data: readFileSync(SCANNED_PDF_FIXTURE).toString("base64"), mimeType: "application/pdf", originalName: PDF_NAME,
  });
}

function applyOcr(h: Harness, documentId: string, markdown: string): Promise<{ status: number; body: Json }> {
  return call(h, "POST", `/api/documents/${documentId}/ocr-result`, { markdown, source: "manual" });
}

async function permanentlyDelete(h: Harness, id: number): Promise<Json> {
  const res = await call(h, "DELETE", `/memories/${id}`);
  expect(res.status).toBe(200);
  return res.body;
}

function count(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

/** 자산 표 세 개의 행 수 — 문서 기록·원장·파일 행. */
function assetRowCounts(db: Database): Record<string, number> {
  return { documents: count(db, "documents"), asset_file_imports: count(db, "asset_file_imports"), asset_files: count(db, "asset_files") };
}
const NO_ASSET_ROWS = { documents: 0, asset_file_imports: 0, asset_files: 0 };

/** 원장 행(sha·source_ref, 정렬). */
function ledger(db: Database): Array<{ sha: string; ref: string }> {
  return db.query("SELECT asset_sha256 AS sha, source_ref AS ref FROM asset_file_imports ORDER BY asset_sha256, source_ref")
    .all() as Array<{ sha: string; ref: string }>;
}

function sortedLedger(rows: Array<{ sha: string; ref: string }>): Array<{ sha: string; ref: string }> {
  return [...rows].sort((a, b) => (a.sha === b.sha ? (a.ref < b.ref ? -1 : 1) : a.sha < b.sha ? -1 : 1));
}

function expectInvariants(h: Harness): void {
  expect(lineageOrphans(h.db)).toEqual([]);
  expect(assetInvariantViolations(h.db, h.dir)).toEqual([]);
}

function cleanup(partial: Partial<AssetCleanup>): AssetCleanup {
  return { documentIds: [], removedSha256s: [], missingSha256s: [], failed: [], ...partial };
}

const sortedShas = (...shas: string[]) => [...new Set(shas)].sort();
const sortedNames = (...names: string[]) => [...names].sort();
const markdownSha = (markdown: string) => assetSha256(new TextEncoder().encode(markdown));

describe("OCR 변환본이 올린 .txt 와 같은 바이트일 때", () => {
  test("재QA 재현 E: .md 사본이 따로 생기지 않고 두 문서 기록이 .txt 한 파일을 나눠 쓰며, 둘 다 지워야 파일이 지워진다", async () => {
    const h = await makeHarness();
    const txt = await uploadText(h, "receipt.txt", OCR_MD);
    const pdf = await uploadScannedPdf(h);
    const mdSha = markdownSha(OCR_MD);
    expect(txt.assetSha256).toBe(mdSha);

    const applied = await applyOcr(h, pdf.documentId, OCR_MD);
    expect(applied.status).toBe(200);
    expect(applied.body.assetSha256).toBe(mdSha);

    // 파일은 `.txt` 와 pdf 뿐 — `.md` 사본이 없다.
    expect(assetContentFiles(h.dir)).toEqual(sortedNames(`${mdSha}.txt`, `${pdf.assetSha256}.pdf`));
    expect(h.store.getAssetFile(mdSha)?.assetPath).toBe(h.assetStore.path(mdSha, "txt"));
    expect(ledger(h.db)).toEqual(sortedLedger([
      { sha: mdSha, ref: `document:${txt.documentId}` },
      { sha: mdSha, ref: `document:${pdf.documentId}` },
      { sha: pdf.assetSha256, ref: `document:${pdf.documentId}` },
    ]));
    expect(h.store.getDocument(pdf.documentId)?.assetSha256).toBe(mdSha);
    expectInvariants(h);

    // .txt 문서를 지워도 pdf 문서의 변환본이 그 파일을 쓰므로 파일이 남는다.
    const afterTxt = await permanentlyDelete(h, txt.documentNodeId);
    expect(afterTxt.assetCleanup).toEqual(cleanup({ documentIds: [txt.documentId] }));
    expect(assetContentFiles(h.dir)).toEqual(sortedNames(`${mdSha}.txt`, `${pdf.assetSha256}.pdf`));
    expect(ledger(h.db)).toEqual(sortedLedger([
      { sha: mdSha, ref: `document:${pdf.documentId}` },
      { sha: pdf.assetSha256, ref: `document:${pdf.documentId}` },
    ]));
    expectInvariants(h);

    // pdf 문서까지 지우면 변환본(.txt 파일)과 원본 pdf 가 모두 지워진다.
    const afterPdf = await permanentlyDelete(h, pdf.documentNodeId);
    expect(afterPdf.assetCleanup).toEqual(cleanup({
      documentIds: [pdf.documentId], removedSha256s: sortedShas(mdSha, pdf.assetSha256),
    }));
    expect(assetContentFiles(h.dir)).toEqual([]);
    expect(assetRowCounts(h.db)).toEqual(NO_ASSET_ROWS);
    expectInvariants(h);
  }, 180_000);
});

describe("OCR 변환본의 sha 에 행이 없을 때", () => {
  test(".md 파일과 원장 행 하나(document-ocr)로 기록에 묶이고, 기록을 지우면 함께 지워진다", async () => {
    const h = await makeHarness();
    const pdf = await uploadScannedPdf(h);
    const bytes = new TextEncoder().encode(OCR_MD);
    const mdSha = assetSha256(bytes);

    expect((await applyOcr(h, pdf.documentId, OCR_MD)).status).toBe(200);

    expect(assetContentFiles(h.dir)).toEqual(sortedNames(`${mdSha}.md`, `${pdf.assetSha256}.pdf`));
    expect(h.store.getAssetFile(mdSha)).toMatchObject({
      assetType: "text", assetPath: h.assetStore.path(mdSha, "md"), byteSize: bytes.byteLength,
      mimeType: "text/markdown", originalName: OCR_NAME,
    });
    const rows = h.db.query(
      "SELECT source, source_ref AS ref, author, user_id AS userId, original_name AS originalName FROM asset_file_imports WHERE asset_sha256 = ?",
    ).all(mdSha);
    expect(rows).toEqual([
      { source: OCR_ACTOR, ref: `document:${pdf.documentId}`, author: OCR_ACTOR, userId: ATTRIBUTION.userId, originalName: OCR_NAME },
    ]);
    expect(h.store.getDocument(pdf.documentId)?.assetSha256).toBe(mdSha);
    expectInvariants(h);

    const removed = await permanentlyDelete(h, pdf.documentNodeId);
    expect(removed.assetCleanup).toEqual(cleanup({
      documentIds: [pdf.documentId], removedSha256s: sortedShas(mdSha, pdf.assetSha256),
    }));
    expect(assetContentFiles(h.dir)).toEqual([]);
    expect(assetRowCounts(h.db)).toEqual(NO_ASSET_ROWS);
    expectInvariants(h);
  }, 180_000);

  test("같은 Markdown 재적용은 원장 행을 겹쳐 쓰지 않고, 다른 Markdown 이면 옛 변환본이 기록이 지워질 때까지 남았다가 함께 지워진다", async () => {
    const h = await makeHarness();
    const pdf = await uploadScannedPdf(h);
    const firstSha = markdownSha(OCR_MD);
    const secondSha = markdownSha(OCR_MD_OTHER);

    expect((await applyOcr(h, pdf.documentId, OCR_MD)).status).toBe(200);
    const ledgerAfterFirst = ledger(h.db);
    const filesAfterFirst = assetContentFiles(h.dir);

    expect((await applyOcr(h, pdf.documentId, OCR_MD)).status).toBe(200);
    expect(ledger(h.db)).toEqual(ledgerAfterFirst);
    expect(assetContentFiles(h.dir)).toEqual(filesAfterFirst);
    expectInvariants(h);

    expect((await applyOcr(h, pdf.documentId, OCR_MD_OTHER)).status).toBe(200);
    expect(h.store.getDocument(pdf.documentId)?.assetSha256).toBe(secondSha);
    // 밀려난 옛 변환본은 그대로 기록에 묶여 있다 — 기록이 지워질 때 함께 지워진다.
    expect(assetContentFiles(h.dir)).toEqual(sortedNames(`${firstSha}.md`, `${secondSha}.md`, `${pdf.assetSha256}.pdf`));
    expect(ledger(h.db)).toEqual(sortedLedger([
      { sha: firstSha, ref: `document:${pdf.documentId}` },
      { sha: secondSha, ref: `document:${pdf.documentId}` },
      { sha: pdf.assetSha256, ref: `document:${pdf.documentId}` },
    ]));
    expectInvariants(h);

    const removed = await permanentlyDelete(h, pdf.documentNodeId);
    expect(removed.assetCleanup).toEqual(cleanup({
      documentIds: [pdf.documentId], removedSha256s: sortedShas(firstSha, secondSha, pdf.assetSha256),
    }));
    expect(assetContentFiles(h.dir)).toEqual([]);
    expect(assetRowCounts(h.db)).toEqual(NO_ASSET_ROWS);
    expectInvariants(h);
  }, 180_000);
});

describe("OCR 적용이 기록·노드 상태와 어긋날 때", () => {
  test("기다리는 사이 잠금 보유자가 기록을 지웠으면 404 이고 파일·행·노드를 쓰지 않는다", async () => {
    const h = await makeHarness();
    const pdf = await uploadScannedPdf(h);

    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const holder = withMemoryMutationLock(h.store, async () => {
      await gate;
      // 라우트가 기록을 읽은 뒤 잠금을 기다리는 사이에 그 문서가 영구 삭제된다.
      await h.store.deleteNode(pdf.documentNodeId);
    });
    let finished = false;
    const reply = applyOcr(h, pdf.documentId, OCR_MD).then((res) => {
      finished = true;
      return res;
    });
    await Bun.sleep(LOCK_SETTLE_MS);
    expect(finished).toBe(false);
    open();
    await holder;

    expect(await reply).toEqual({ status: 404, body: { error: "문서 없음 — documentId 확인" } });
    expect(assetContentFiles(h.dir)).toEqual([]);
    expect(assetRowCounts(h.db)).toEqual(NO_ASSET_ROWS);
    expect(count(h.db, "knowledge_nodes")).toBe(0);
    expectInvariants(h);
  }, 180_000);

  test("문서 노드 metadata 에 user_id 가 없으면 409 이고 변환본 파일·원장 행을 쓰지 않는다", async () => {
    const h = await makeHarness();
    const pdf = await uploadScannedPdf(h);
    h.db.query("UPDATE knowledge_nodes SET metadata_json = json_remove(metadata_json, '$.user_id') WHERE id = ?")
      .run(pdf.documentNodeId);

    const res = await applyOcr(h, pdf.documentId, OCR_MD);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("user_id");
    expect(assetContentFiles(h.dir)).toEqual([`${pdf.assetSha256}.pdf`]);
    expect(ledger(h.db)).toEqual([{ sha: pdf.assetSha256, ref: `document:${pdf.documentId}` }]);
    expect(h.store.getDocument(pdf.documentId)?.assetSha256).toBe(pdf.assetSha256);
    expectInvariants(h);
  }, 180_000);
});

describe("store.recordOcrCanonicalAsset 는 자산 묶음의 바이트 확인을 그대로 거친다", () => {
  test("선언한 sha 와 다른 바이트는 행도 파일도 원장 행도 쓰지 않고 AssetBundleBytesMismatchError 로 멈춘다", async () => {
    const h = await makeHarness();
    const pdf = await uploadScannedPdf(h);
    const bytes = new TextEncoder().encode(OCR_MD);
    const other = new TextEncoder().encode(OCR_MD_OTHER);
    const ledgerBefore = ledger(h.db);
    const filesBefore = assetContentFiles(h.dir);
    const rowsBefore = assetRowCounts(h.db);

    await expect(h.store.recordOcrCanonicalAsset({
      writer: h.assetStore,
      documentId: pdf.documentId,
      file: {
        sha256: assetSha256(bytes), byteSize: bytes.byteLength, bytes: other, ext: "md",
        assetType: "text", mimeType: "text/markdown", originalName: OCR_NAME,
      },
      ledger: { source: OCR_ACTOR, author: OCR_ACTOR, userId: ATTRIBUTION.userId, originalName: OCR_NAME },
    })).rejects.toBeInstanceOf(AssetBundleBytesMismatchError);

    expect(assetContentFiles(h.dir)).toEqual(filesBefore);
    expect(ledger(h.db)).toEqual(ledgerBefore);
    expect(assetRowCounts(h.db)).toEqual(rowsBefore);
    expectInvariants(h);
  }, 180_000);
});
