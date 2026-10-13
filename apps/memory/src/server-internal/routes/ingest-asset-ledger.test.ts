/**
 * ingest-asset-ledger.test.ts — POST /ingest 문서 갈래의 원장 행과 "한 sha 에 디스크 파일 하나"(WP-B1-20U 설계 17.17
 * D26·D29, U9a).
 *
 * 문서 기록(documents 행)마다 그 기록이 쓰는 파일당 원장 행(asset_file_imports, source_ref `document:<document_id>`)이
 * 하나씩 생긴다 — 원본과, 원본과 sha 가 다를 때의 변환본. 다른 칸은 그 입력의 source·author·user_id·original_name.
 * 파일은 sha 를 먼저 계산해 쓴다: 변환본이 원본과 같은 sha 면 쓰지 않고(.txt 의 `{sha}.md` 사본 없음), 이미 asset_files
 * 행이 있는 sha 는 그 행의 확장자로 쓴다(같은 바이트가 다른 확장자로 와도 파일 하나). 이미지 원장은
 * memories-delete.attachment-files.test.ts 가 SigLIP 와 함께 본다.
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 임시 디렉터리의 실제 AssetStore + 실제 Hono 라우트. mock 0.
 * (ingest.test.ts 가 800줄 상한을 넘어 이 파일로 나눴다.)
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssetStore } from "../../assets/asset-store.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { buildMemoryApi } from "../../server.ts";
import { getMemorySettings } from "../../settings/memory-settings.ts";
import { assetContentFiles, assetInvariantViolations } from "../../test-utils/asset-invariant.ts";

const SOURCE = "dashboard:manual";
const ATTRIBUTION = { author: "테스터", userId: "u-ledger" };
const NOTE = "분기 보고서 초안\n\n매출은 지난 분기보다 늘었고, 다음 분기 목표는 신규 고객 확보다.";
const DOCX_FIXTURE = join(import.meta.dir, "..", "..", "memory", "canonicalize", "__fixtures__", "minimal.docx");
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

interface Harness { app: Hono; db: Database; dir: string; assetStore: AssetStore }
const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "bara-ingest-ledger-"));
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const assetStore = new AssetStore(dir);
  const settings = getMemorySettings("/nonexistent-default-ingest-ledger-test", "/nonexistent-default-ingest-ledger-test.secrets.json");
  const app = buildMemoryApi({
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(), assetStore,
    getSettings: () => settings,
  });
  const h = { app, db, dir, assetStore };
  harnesses.push(h);
  return h;
}

interface IngestBody {
  documentId: string;
  assetSha256: string;
  cacheHit: boolean;
  parse: { originalAssetSha256: string; canonicalAssetSha256?: string; status: string };
}

async function ingestFile(h: Harness, content: Record<string, string>): Promise<IngestBody> {
  const res = await h.app.request("/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: SOURCE, content, attribution: ATTRIBUTION }),
  });
  expect(res.status).toBe(201);
  return await res.json() as IngestBody;
}

interface LedgerRow { sha: string; ref: string; source: string; author: string; userId: string; originalName: string | null }

function ledger(db: Database): LedgerRow[] {
  return db.query(
    `SELECT asset_sha256 AS sha, source_ref AS ref, source, author, user_id AS userId, original_name AS originalName
     FROM asset_file_imports ORDER BY asset_sha256, source_ref`,
  ).all() as LedgerRow[];
}

function assetPathOf(db: Database, sha: string): string {
  return (db.query("SELECT asset_path FROM asset_files WHERE sha256 = ?").get(sha) as { asset_path: string }).asset_path;
}

const row = (sha: string, documentId: string, originalName: string): LedgerRow => ({
  sha, ref: `document:${documentId}`, source: SOURCE, author: ATTRIBUTION.author, userId: ATTRIBUTION.userId, originalName,
});

describe("POST /ingest 문서 갈래 — 원장 행과 한 sha 한 파일", () => {
  test(".txt 파일 → 원본 파일 하나({sha}.md 사본 없음) + 원장 행 document:<id> 하나", async () => {
    const h = makeHarness();
    const body = await ingestFile(h, { type: "text", data: NOTE, mimeType: "text/plain", originalName: "report.txt" });

    expect(body.parse.canonicalAssetSha256).toBe(body.assetSha256);
    expect(assetContentFiles(h.dir)).toEqual([`${body.assetSha256}.txt`]);
    expect(ledger(h.db)).toEqual([row(body.assetSha256, body.documentId, "report.txt")]);
    expect(assetInvariantViolations(h.db, h.dir)).toEqual([]);
  }, 60_000);

  test("같은 바이트가 .txt 다음 .md 로 오면 파일은 기록된 확장자(.txt) 하나, 문서 기록마다 원장 행", async () => {
    const h = makeHarness();
    const asTxt = await ingestFile(h, { type: "text", data: NOTE, mimeType: "text/plain", originalName: "report.txt" });
    const asMd = await ingestFile(h, { type: "text", data: NOTE, mimeType: "text/markdown", originalName: "report.md" });

    expect(asMd.assetSha256).toBe(asTxt.assetSha256);
    expect(asMd.documentId).not.toBe(asTxt.documentId);
    expect(asMd.cacheHit).toBe(true);
    expect(assetContentFiles(h.dir)).toEqual([`${asTxt.assetSha256}.txt`]);
    expect(assetPathOf(h.db, asTxt.assetSha256)).toBe(h.assetStore.path(asTxt.assetSha256, "txt"));
    expect(ledger(h.db)).toEqual([
      row(asTxt.assetSha256, asTxt.documentId, "report.txt"),
      row(asTxt.assetSha256, asMd.documentId, "report.md"),
    ].sort((a, b) => (a.ref < b.ref ? -1 : 1)));
    expect(assetInvariantViolations(h.db, h.dir)).toEqual([]);
  }, 60_000);

  test("docx → 원본 .docx 와 변환본 .md 파일, 두 파일 모두 같은 문서 기록의 원장 행", async () => {
    const h = makeHarness();
    const body = await ingestFile(h, {
      type: "auto", data: readFileSync(DOCX_FIXTURE).toString("base64"), mimeType: DOCX_MIME, originalName: "minimal.docx",
    });
    const canonical = body.parse.canonicalAssetSha256!;
    expect(canonical).not.toBe(body.assetSha256);
    expect(body.parse.originalAssetSha256).toBe(body.assetSha256);

    expect(assetContentFiles(h.dir)).toEqual([`${body.assetSha256}.docx`, `${canonical}.md`].sort());
    expect(ledger(h.db)).toEqual([
      row(body.assetSha256, body.documentId, "minimal.docx"),
      row(canonical, body.documentId, "minimal.docx"),
    ].sort((a, b) => (a.sha < b.sha ? -1 : 1)));
    expect(assetInvariantViolations(h.db, h.dir)).toEqual([]);
  }, 60_000);

  test("파싱 실패 문서도 원본 파일과 원장 행 document:<id> 를 남긴다", async () => {
    const h = makeHarness();
    const broken = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x62, 0x72, 0x6f, 0x6b]).toString("base64");
    const body = await ingestFile(h, { type: "auto", data: broken, mimeType: "application/pdf", originalName: "broken.pdf" });

    expect(body.parse.status).toBe("parse_failed");
    expect(assetContentFiles(h.dir)).toEqual([`${body.assetSha256}.pdf`]);
    expect(ledger(h.db)).toEqual([row(body.assetSha256, body.documentId, "broken.pdf")]);
    expect(assetInvariantViolations(h.db, h.dir)).toEqual([]);
  }, 60_000);
});
