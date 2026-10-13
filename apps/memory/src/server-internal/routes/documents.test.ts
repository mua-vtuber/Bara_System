/**
 * routes/documents.test.ts — 문서 OCR 후보/결과 적용 API 통합 검증.
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder + 실 AssetStore. OCR 엔진은 v1 범위가
 * 아니므로 스캔 PDF fixture 를 OCR 필요 상태로 만들고 Markdown 결과만 적용한다.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
import { readDocumentParseMetadata } from "../../memory/document-parse-status.ts";
import { getMemorySettings } from "../../settings/memory-settings.ts";
import { buildMemoryApi } from "../../server.ts";
import { lineageOrphans } from "../../test-utils/lineage-invariant.ts";
import { withDocumentOcrRuntime } from "../../test-utils/document-ocr-runtime.ts";
import { startProviderStandIn, type ProviderStandIn } from "../../test-utils/provider-stand-in.ts";

let embedder: Bgem3Embedder;
let standIn: ProviderStandIn;
let dir: string;
let db: Database;
let store: SqliteMemoryStore;
let app: Hono;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
  standIn = startProviderStandIn();
});

afterAll(() => standIn.stop());

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bara-documents-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const assetStore = new AssetStore(dir);
  const settings = getMemorySettings("/nonexistent-default-documents-test", "/nonexistent-default-documents-test.secrets.json");
  app = buildMemoryApi(withDocumentOcrRuntime({ store, retriever, assembler, assetStore, getSettings: () => settings }));
  standIn.requests.length = 0;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function buildAppWithSettings(settings: ReturnType<typeof getMemorySettings>): Hono {
  return buildMemoryApi(withDocumentOcrRuntime({
    store,
    retriever: new HybridRetriever(store, embedder),
    assembler: new ContextAssembler(),
    assetStore: new AssetStore(dir),
    getSettings: () => settings,
  }));
}

/** 파일 업로드 API 를 대역 서버 경로로 가리키는 설정. */
function fileApiSettings(path: string): ReturnType<typeof getMemorySettings> {
  const settings = getMemorySettings(`/nonexistent-server-ocr-${path}-test`, `/nonexistent-server-ocr-${path}-test.secrets.json`);
  settings.documents.ocr.mode = "api";
  settings.documents.ocr.api.provider = "http_file_api";
  settings.documents.ocr.api.endpointUrl = `${standIn.origin}/${path}`;
  return settings;
}

async function ingestScannedPdf(
  targetApp: Hono = app,
): Promise<{ documentId: string; assetSha256: string }> {
  const scannedPath = join(
    import.meta.dir,
    "../../memory/canonicalize/__fixtures__/scanned.pdf",
  );
  const pdfBytes = readFileSync(scannedPath);
  const res = await targetApp.request("/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "dashboard:manual",
      content: {
        type: "auto",
        data: Buffer.from(pdfBytes).toString("base64"),
        mimeType: "application/pdf",
        originalName: "scanned.pdf",
      },
      attribution: { author: "테스터", userId: "u-doc-ocr" },
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { documentId: string; assetSha256: string };
  return body;
}

describe("documents OCR routes", () => {
  test("GET /api/documents/ocr-candidates — needs_ocr 문서 목록 반환", async () => {
    const ingested = await ingestScannedPdf();
    const res = await app.request("/api/documents/ocr-candidates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      candidates: Array<{
        documentId: string;
        parse: { status: string } | null;
        originalAssetSha256: string;
        assetUrl: string;
        assetMimeType: string | null;
        originalName: string | null;
      }>;
    };
    const candidate = body.candidates.find((item) => item.documentId === ingested.documentId);
    expect(candidate).toBeDefined();
    expect(candidate!.parse?.status).toBe("needs_ocr");
    expect(candidate!.originalAssetSha256).toBe(ingested.assetSha256);
    expect(candidate!.assetUrl).toBe(`/assets/${ingested.assetSha256}`);
    expect(candidate!.assetMimeType).toBe("application/pdf");
    expect(candidate!.originalName).toBe("scanned.pdf");
  });

  test("GET /api/documents/ocr-runtime-config — 비밀값 숨김 + 자동 상태 password 제외", async () => {
    const custom = getMemorySettings("/nonexistent-custom-documents-test", "/nonexistent-custom-documents-test.secrets.json");
    custom.documents.ocr.mode = "pc_companion";
    custom.documents.ocr.resourceProfile = "gpu";
    custom.documents.ocr.schedule.leaseSeconds = 600;
    custom.documents.ocr.api.apiKey = "sk-ocr-secret";
    custom.documents.ocr.pcCompanion.workerId = "pc-gpu";
    custom.documents.ocr.pcCompanion.pollSeconds = 7;
    custom.documents.ocr.pcCompanion.commandSource = "server";
    custom.documents.ocr.pcCompanion.commandJson = '["ocr","{input}","{output}"]';
    (custom.documents.ocr.pcCompanion as unknown as { allowedStatuses: string[] }).allowedStatuses = [
      "needs_ocr",
      "password_required",
      "ocr_failed",
    ];
    const localApp = buildMemoryApi(withDocumentOcrRuntime({
      store,
      retriever: new HybridRetriever(store, embedder),
      assembler: new ContextAssembler(),
      assetStore: new AssetStore(dir),
      getSettings: () => custom,
    }));

    const res = await localApp.request("/api/documents/ocr-runtime-config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: {
        mode: string;
        resourceProfile: string;
        schedule: { leaseSeconds: number };
        api: { hasApiKey: boolean; apiKey?: string };
        pcCompanion: {
          workerId: string;
          pollSeconds: number;
          commandSource: string;
          commandJson: string;
          allowedStatuses: string[];
        };
      };
    };
    expect(body.config.mode).toBe("pc_companion");
    expect(body.config.resourceProfile).toBe("gpu");
    expect(body.config.schedule.leaseSeconds).toBe(600);
    expect(body.config.api.hasApiKey).toBe(true);
    expect(body.config.api.apiKey).toBeUndefined();
    expect(body.config.pcCompanion.workerId).toBe("pc-gpu");
    expect(body.config.pcCompanion.pollSeconds).toBe(7);
    expect(body.config.pcCompanion.commandSource).toBe("server");
    expect(body.config.pcCompanion.commandJson).toBe('["ocr","{input}","{output}"]');
    expect(body.config.pcCompanion.allowedStatuses).toEqual(["needs_ocr", "ocr_failed"]);
  });

  test("POST /api/documents/ocr-jobs/run-server-once — manual/companion 모드는 서버 OCR 을 실행하지 않는다", async () => {
    const res = await app.request("/api/documents/ocr-jobs/run-server-once", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ran: boolean; reason: string };
    expect(body).toEqual({
      ok: true,
      ran: false,
      reason: "documents.ocr.mode=manual — 서버 OCR 실행 안 함",
    });
    expect(standIn.requests.length).toBe(0);
  });

  test("POST /api/documents/ocr-jobs/run-server-once — http_file_api 성공 시 OCR Markdown 을 적용한다", async () => {
    const settings = fileApiSettings("run");
    settings.documents.ocr.api.model = "ocr-model";
    settings.documents.ocr.api.apiKey = "server-api-token";
    settings.documents.ocr.api.responseFormat = "markdown";
    const localApp = buildAppWithSettings(settings);
    const ingested = await ingestScannedPdf(localApp);
    standIn.reply = () => ({ body: "# OCR\n\nSERVER_API_UNIQUE_TOKEN_20260702" });

    const res = await localApp.request(
      `/api/documents/ocr-jobs/run-server-once?documentId=${ingested.documentId}`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      ran: boolean;
      documentId: string;
      parse: { status: string; providerName?: string };
      chunkCount: number;
    };
    expect(body.ok).toBe(true);
    expect(body.ran).toBe(true);
    expect(body.documentId).toBe(ingested.documentId);
    expect(body.parse.status).toBe("ocr_succeeded");
    expect(body.parse.providerName).toBe("server-api:http_file_api");
    expect(body.chunkCount).toBeGreaterThan(0);

    expect(standIn.requests.length).toBe(1);
    const req = standIn.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/run");
    expect(req.headers.authorization).toBe("Bearer server-api-token");
    expect(req.headers["content-type"]).toContain("multipart/form-data");
    const form = String(req.body);
    expect(form).toContain(ingested.documentId);
    expect(form).toContain("ocr-model");
    expect(form).toContain('name="file"');

    const doc = store.getDocument(ingested.documentId)!;
    const parse = readDocumentParseMetadata(doc.sourceMetadata);
    expect(parse?.status).toBe("ocr_succeeded");

    const searchRes = await localApp.request("/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "SERVER_API_UNIQUE_TOKEN_20260702", limit: 5 }),
    });
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as { results: Array<{ content: string }> };
    expect(
      searchBody.results.some((result) =>
        result.content.includes("SERVER_API_UNIQUE_TOKEN_20260702"),
      ),
    ).toBe(true);
  });

  test("POST /api/documents/ocr-jobs/run-server-once — 빈 Markdown 은 ocr_failed 로 기록한다", async () => {
    const localApp = buildAppWithSettings(fileApiSettings("empty"));
    const ingested = await ingestScannedPdf(localApp);
    standIn.reply = () => ({ body: "   " });
    const res = await localApp.request(
      `/api/documents/ocr-jobs/run-server-once?documentId=${ingested.documentId}`,
      { method: "POST" },
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      ok: boolean;
      ran: boolean;
      error: string;
      parse: { status: string; errorMessage?: string };
    };
    expect(body.ok).toBe(false);
    expect(body.ran).toBe(true);
    expect(body.error).toContain("빈 Markdown");
    expect(body.parse.status).toBe("ocr_failed");
    expect(body.parse.errorMessage).toContain("빈 Markdown");
  });

  test("POST /api/documents/ocr-jobs/run-server-once — API 실패도 ocr_failed 로 기록한다", async () => {
    const localApp = buildAppWithSettings(fileApiSettings("fail"));
    const ingested = await ingestScannedPdf(localApp);
    standIn.reply = () => ({ status: 503, body: "provider unavailable" });
    const res = await localApp.request(
      `/api/documents/ocr-jobs/run-server-once?documentId=${ingested.documentId}`,
      { method: "POST" },
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      ok: boolean;
      error: string;
      parse: { status: string; errorMessage?: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("OCR API HTTP 503");
    expect(body.parse.status).toBe("ocr_failed");
    expect(body.parse.errorMessage).toContain("provider unavailable");
  });

  test("POST /api/documents/ocr-jobs/claim — 미임대 후보 1개를 lease 와 함께 반환한다", async () => {
    const ingested = await ingestScannedPdf();
    const res = await app.request("/api/documents/ocr-jobs/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "worker-a", leaseSeconds: 120 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      job: {
        documentId: string;
        parse: { lease?: { workerId: string; claimedAt: string; leaseUntil: string } };
        assetMimeType: string | null;
        originalName: string | null;
      } | null;
    };
    expect(body.job?.documentId).toBe(ingested.documentId);
    expect(body.job?.parse.lease?.workerId).toBe("worker-a");
    expect(body.job?.parse.lease?.leaseUntil).toBeTruthy();
    expect(body.job?.assetMimeType).toBe("application/pdf");
    expect(body.job?.originalName).toBe("scanned.pdf");

    const doc = store.getDocument(ingested.documentId);
    const parse = readDocumentParseMetadata(doc!.sourceMetadata);
    expect(parse?.lease?.workerId).toBe("worker-a");
  });

  test("password_required 문서는 목록에 보이지만 claim/result/failure 자동 경로에서는 제외된다", async () => {
    const ingested = await ingestScannedPdf();
    const doc = store.getDocument(ingested.documentId)!;
    const parse = readDocumentParseMetadata(doc.sourceMetadata)!;
    store.updateDocumentSourceMetadata({
      documentId: ingested.documentId,
      sourceMetadata: {
        ...doc.sourceMetadata,
        parse: {
          ...parse,
          status: "password_required",
        },
      },
    });

    const list = await app.request("/api/documents/ocr-candidates?status=password_required");
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      candidates: Array<{ documentId: string; parse: { status: string } }>;
    };
    expect(listBody.candidates.some((item) => item.documentId === ingested.documentId)).toBe(true);

    const claim = await app.request("/api/documents/ocr-jobs/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: "worker-a",
        statuses: ["password_required", "needs_ocr"],
      }),
    });
    expect(claim.status).toBe(200);
    expect((await claim.json()) as { ok: true; job: unknown }).toEqual({
      ok: true,
      job: null,
    });

    const result = await app.request(`/api/documents/${ingested.documentId}/ocr-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: "암호 문서 결과", source: "manual" }),
    });
    expect(result.status).toBe(409);

    const failure = await app.request(`/api/documents/${ingested.documentId}/ocr-failure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ errorMessage: "암호 필요", source: "manual" }),
    });
    expect(failure.status).toBe(409);
  });

  test("활성 lease 문서는 다른 worker 가 claim 하지 못하고 만료 뒤 다시 claim 된다", async () => {
    const ingested = await ingestScannedPdf();
    const first = await app.request("/api/documents/ocr-jobs/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "worker-a", leaseSeconds: 120 }),
    });
    expect(first.status).toBe(200);

    const second = await app.request("/api/documents/ocr-jobs/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "worker-b", leaseSeconds: 120 }),
    });
    expect(second.status).toBe(200);
    expect((await second.json()) as { ok: true; job: unknown }).toEqual({
      ok: true,
      job: null,
    });

    const doc = store.getDocument(ingested.documentId)!;
    const parse = readDocumentParseMetadata(doc.sourceMetadata)!;
    store.updateDocumentSourceMetadata({
      documentId: ingested.documentId,
      sourceMetadata: {
        ...doc.sourceMetadata,
        parse: {
          ...parse,
          lease: {
            workerId: "worker-a",
            claimedAt: "2026-07-01 09:00:00",
            leaseUntil: "2026-07-01 09:00:01",
          },
        },
      },
    });

    const reclaimed = await app.request("/api/documents/ocr-jobs/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "worker-b", leaseSeconds: 120 }),
    });
    expect(reclaimed.status).toBe(200);
    const body = (await reclaimed.json()) as {
      job: { documentId: string; parse: { lease?: { workerId: string } } } | null;
    };
    expect(body.job?.documentId).toBe(ingested.documentId);
    expect(body.job?.parse.lease?.workerId).toBe("worker-b");
  });

  test("POST /api/documents/:id/ocr-failure — 실패 기록 후 후보 목록에 다시 노출한다", async () => {
    const ingested = await ingestScannedPdf();
    const claim = await app.request("/api/documents/ocr-jobs/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    expect(claim.status).toBe(200);

    const failure = await app.request(`/api/documents/${ingested.documentId}/ocr-failure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        errorMessage: "OCR command failed",
        source: "companion",
        providerName: "fixture-ocr",
        workerId: "worker-a",
      }),
    });
    expect(failure.status).toBe(200);
    const failureBody = (await failure.json()) as {
      parse: { status: string; errorMessage?: string; lease?: unknown };
    };
    expect(failureBody.parse.status).toBe("ocr_failed");
    expect(failureBody.parse.errorMessage).toBe("OCR command failed");
    expect(failureBody.parse.lease).toBeUndefined();

    const list = await app.request("/api/documents/ocr-candidates?status=ocr_failed");
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      candidates: Array<{ documentId: string; parse: { status: string; errorMessage?: string } }>;
    };
    expect(listBody.candidates.some((item) => item.documentId === ingested.documentId)).toBe(true);
    expect(listBody.candidates[0]!.parse.status).toBe("ocr_failed");
  });

  test("활성 lease 중 다른 worker 의 result/failure 는 409, 같은 worker result 는 성공", async () => {
    const ingested = await ingestScannedPdf();
    const claim = await app.request("/api/documents/ocr-jobs/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    expect(claim.status).toBe(200);

    const otherFailure = await app.request(`/api/documents/${ingested.documentId}/ocr-failure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        errorMessage: "not mine",
        source: "companion",
        workerId: "worker-b",
      }),
    });
    expect(otherFailure.status).toBe(409);

    const otherResult = await app.request(`/api/documents/${ingested.documentId}/ocr-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        markdown: "다른 worker 결과",
        source: "companion",
        workerId: "worker-b",
      }),
    });
    expect(otherResult.status).toBe(409);

    const sameResult = await app.request(`/api/documents/${ingested.documentId}/ocr-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        markdown: "같은 worker OCR 결과",
        source: "companion",
        workerId: "worker-a",
      }),
    });
    expect(sameResult.status).toBe(200);
    const body = (await sameResult.json()) as { parse: { status: string; lease?: unknown } };
    expect(body.parse.status).toBe("ocr_succeeded");
    expect(body.parse.lease).toBeUndefined();
  });

  test("POST /api/documents/:id/ocr-result — 같은 documentId 에 OCR Markdown 적용 + 검색 반영", async () => {
    const ingested = await ingestScannedPdf();
    const markdown = "# OCR 결과\n\nBARA_OCR_UNIQUE_TOKEN_20260701 문서 본문입니다.";

    const res = await app.request(`/api/documents/${ingested.documentId}/ocr-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown, source: "manual", providerName: "manual-test" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      documentId: string;
      assetSha256: string;
      chunkCount: number;
      parse: { status: string; providerName?: string };
      nodeIds: number[];
    };
    expect(body.documentId).toBe(ingested.documentId);
    expect(body.assetSha256).not.toBe(ingested.assetSha256);
    expect(body.chunkCount).toBeGreaterThan(0);
    expect(body.parse.status).toBe("ocr_succeeded");
    expect(body.parse.providerName).toBe("manual-test");

    const doc = store.getDocument(ingested.documentId);
    expect(doc).not.toBeNull();
    expect(doc!.assetSha256).toBe(body.assetSha256);
    expect(doc!.chunkCount).toBe(body.chunkCount);
    expect((doc!.sourceMetadata.parse as { status: string }).status).toBe("ocr_succeeded");

    const chunk = await store.getNode(body.nodeIds[1] as number);
    expect(chunk?.sourceType).toBe("document_chunk");
    expect(chunk?.content.startsWith("# OCR 결과\n")).toBe(true);
    const metadata = chunk?.metadata as Record<string, unknown>;
    expect(metadata.chunkingStrategy).toBe("heading_path");
    expect(metadata.headingPath).toEqual(["OCR 결과"]);
    expect(metadata.headingTitle).toBe("OCR 결과");
    expect(metadata.headingDepth).toBe(1);
    expect(metadata.parentHeadingPath).toEqual([]);
    expect(metadata.sectionChunkIndex).toBe(0);
    expect(metadata.sectionChunkCount).toBe(1);

    const searchRes = await app.request("/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "BARA_OCR_UNIQUE_TOKEN_20260701", limit: 5 }),
    });
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as {
      results: Array<{ content: string; documentRef: { parentId: string } | null }>;
    };
    expect(
      searchBody.results.some(
        (result) =>
          result.content.includes("BARA_OCR_UNIQUE_TOKEN_20260701") ||
          result.documentRef?.parentId === ingested.documentId,
      ),
    ).toBe(true);
  });

  test("OCR 재적용은 옛 청크를 계보 정리와 함께 지운다 — 출처 없는 청크 자식도 남지 않는다(WP-B1-20U 설계 17.3)", async () => {
    const ingested = await ingestScannedPdf();
    const applyOcr = async (markdown: string) => {
      const res = await app.request(`/api/documents/${ingested.documentId}/ocr-result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown, source: "manual" }),
      });
      expect(res.status).toBe(200);
    };
    await applyOcr("첫 OCR 결과 문단입니다.");
    const oldChunks = store.listDocumentChunkNodeIds(ingested.documentId);
    expect(oldChunks.length).toBeGreaterThan(0);
    // 옛 청크에서 파생된, 자기 출처 행이 없는 기억(실제 저장 경로의 계보 파생).
    const chunkChild = await store.addNode({
      content: "옛 OCR 청크에서 뽑은 사실",
      sourceType: "llm_extract",
      provenance: { kind: "derived", parentId: oldChunks[0]!, relation: "merged_into", edgeProvenance: "system" },
    });

    await applyOcr("두 번째 OCR 결과 문단입니다.");
    const newChunks = store.listDocumentChunkNodeIds(ingested.documentId);
    expect(newChunks.length).toBeGreaterThan(0);
    for (const id of [...oldChunks, chunkChild]) expect(await store.getNode(id)).toBeNull();
    expect(newChunks.some((id) => oldChunks.includes(id))).toBe(false);
    expect(lineageOrphans(db)).toEqual([]);
  });

  test("OCR 완료 문서가 downstream 산출물을 갖고 있으면 재적용 409", async () => {
    const ingested = await ingestScannedPdf();
    const first = await app.request(`/api/documents/${ingested.documentId}/ocr-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: "첫 OCR 결과입니다.", source: "manual" }),
    });
    expect(first.status).toBe(200);

    db.prepare("UPDATE documents SET has_extracted = 1 WHERE document_id = ?").run(
      ingested.documentId,
    );

    const second = await app.request(`/api/documents/${ingested.documentId}/ocr-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: "두 번째 OCR 결과입니다.", source: "manual" }),
    });
    expect(second.status).toBe(409);
  });
});
