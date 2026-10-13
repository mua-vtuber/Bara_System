/**
 * ingest-pdf-asset-bytes.test.ts — POST /ingest 로 올린 PDF 원본이 같은 바이트로 저장되는가(U9a 회귀).
 *
 * U9a 부터 /ingest 는 원본 sha 를 먼저 계산하고 같은 Uint8Array 를 canonicalize 에 넘긴 뒤 그 바이트를 원본 파일로
 * 쓴다. pdf.js(unpdf)가 그 ArrayBuffer 를 넘겨(transfer) 비우자 `content/{sha}.pdf` 가 0바이트로, asset_files.byte_size
 * 가 0 으로 남았고 GET /assets/:sha 도 빈 바이트를 돌려줬다. 텍스트 레이어 PDF(원본 + 변환본 .md)와 스캔 PDF(원본만)
 * 두 갈래에서 디스크 파일·asset_files 행·GET /assets 응답이 올린 바이트와 같은지 본다.
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 임시 디렉터리의 실제 AssetStore + 실제 Hono 라우트 + 저장소의 실제 PDF fixture.
 * mock 0.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssetStore, assetSha256, extOfAssetPath } from "../../assets/asset-store.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { buildMemoryApi } from "../../server.ts";
import { getMemorySettings } from "../../settings/memory-settings.ts";
import { assetInvariantViolations } from "../../test-utils/asset-invariant.ts";

const SOURCE = "dashboard:manual";
const ATTRIBUTION = { author: "테스터", userId: "u-pdf-bytes" };
const PDF_MIME = "application/pdf";
const FIXTURES = join(import.meta.dir, "..", "..", "memory", "canonicalize", "__fixtures__");

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
  const dir = mkdtempSync(join(tmpdir(), "bara-ingest-pdf-bytes-"));
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const assetStore = new AssetStore(dir);
  const settings = getMemorySettings("/nonexistent-default-ingest-pdf-bytes-test", "/nonexistent-default-ingest-pdf-bytes-test.secrets.json");
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
  parse: { originalAssetSha256: string; canonicalAssetSha256?: string; status: string };
}

async function ingestPdf(h: Harness, name: string, uploaded: Uint8Array): Promise<IngestBody> {
  const res = await h.app.request("/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: SOURCE,
      content: { type: "auto", data: Buffer.from(uploaded).toString("base64"), mimeType: PDF_MIME, originalName: name },
      attribution: ATTRIBUTION,
    }),
  });
  expect(res.status).toBe(201);
  return await res.json() as IngestBody;
}

interface StoredAsset { sha: string; byteSize: number; fileBytes: Uint8Array }

/** asset_files 행마다 그 행이 가리키는 디스크 파일의 바이트와 byte_size(sha 순). */
function storedAssets(h: Harness): StoredAsset[] {
  const rows = h.db.query("SELECT sha256, asset_path, byte_size FROM asset_files ORDER BY sha256").all() as Array<{
    sha256: string;
    asset_path: string;
    byte_size: number;
  }>;
  return rows.map((row) => ({
    sha: row.sha256,
    byteSize: row.byte_size,
    fileBytes: h.assetStore.read(row.sha256, extOfAssetPath(row.asset_path)!),
  }));
}

describe("POST /ingest PDF — 원본 파일이 올린 바이트 그대로 저장된다", () => {
  for (const fixture of ["text.pdf", "scanned.pdf"]) {
    test(`${fixture} — content/{sha}.pdf·asset_files.byte_size·GET /assets 가 올린 바이트와 같다`, async () => {
      const h = makeHarness();
      const uploaded = new Uint8Array(readFileSync(join(FIXTURES, fixture)));
      expect(uploaded.byteLength).toBeGreaterThan(0);

      const body = await ingestPdf(h, fixture, uploaded);
      expect(body.assetSha256).toBe(assetSha256(uploaded));
      expect(body.parse.originalAssetSha256).toBe(body.assetSha256);

      // 원본 파일: 기록된 확장자(.pdf) 자리의 바이트가 올린 바이트와 같고, byte_size 가 그 길이다.
      expect(new Uint8Array(readFileSync(h.assetStore.path(body.assetSha256, "pdf")))).toEqual(uploaded);
      const original = storedAssets(h).find((a) => a.sha === body.assetSha256)!;
      expect(original.byteSize).toBe(uploaded.byteLength);

      // 모든 자산 파일(텍스트 PDF 는 변환본 .md 포함)이 자기 sha 와 byte_size 에 맞는 내용이다.
      for (const asset of storedAssets(h)) {
        expect({ sha: assetSha256(asset.fileBytes), byteSize: asset.fileBytes.byteLength }).toEqual({
          sha: asset.sha,
          byteSize: asset.byteSize,
        });
      }

      const res = await h.app.request(`/assets/${body.assetSha256}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(PDF_MIME);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(uploaded);
      expect(assetInvariantViolations(h.db, h.dir)).toEqual([]);
    }, 60_000);
  }
});
