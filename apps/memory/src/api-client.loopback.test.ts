/**
 * MemoryApiClient ↔ 실제 코어, 요청을 기록하는 루프백 서버(WP-B1-20U 설계 17.18 설계 8, 17.19 설계 6 M4).
 *
 * api-client.test.ts 가 800줄을 넘어 그 파일 끝의 루프백 코어 하네스와 describe 셋(헤더 중앙화·토큰 인자, 문서 OCR 메서드,
 * postIngest)을 이 파일로 옮겼다. 시험은 하나도 빼거나 바꾸지 않았고, 각 파일이 자기 bge-m3 임베더를 적재한다.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bgem3Embedder } from "./embedding/bge-m3.ts";
import { openMemoryDatabase } from "./db/migrations.ts";
import { SqliteMemoryStore } from "./db/store.ts";
import { HybridRetriever } from "./memory/retriever.ts";
import { ContextAssembler } from "./memory/context-assembler.ts";
import { AssetStore } from "./assets/asset-store.ts";
import { getMemorySettings } from "./settings/memory-settings.ts";
import { buildMemoryApi } from "./server.ts";
import { withDocumentOcrRuntime } from "./test-utils/document-ocr-runtime.ts";
import { MemoryApiClient, MemoryApiError } from "./api-client.ts";
import { FederationRegistry } from "./federation/registry.ts";
import { createFederationRoutes } from "./federation/routes.ts";
import { SseTokenStore } from "./federation/sse-tokens.ts";
import type { AppManifest } from "./federation/manifest-schema.ts";
import { readDocumentParseMetadata } from "./memory/document-parse-status.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

// ── 요청 기록 루프백 서버 + 실제 코어 (WP-B1-20U 설계 17.18 설계 8) ──────────────
//
// 헤더·토큰·OCR 메서드는 전역 fetch 함수를 바꾸지 않고 본다: 루프백 Bun.serve 가 요청(메서드·경로·authorization·
// 본문)을 적은 뒤 실제 코어(buildMemoryApi — 실제 SQLite·bge-m3·AssetStore·SseTokenStore)로 그대로 넘기고, 응답은
// 코어가 실제 조건으로 만든다. 클라이언트는 실제 MemoryApiClient 다.

interface RecordedRequest {
  method: string;
  /** 경로 + 쿼리(서버가 받은 그대로, 퍼센트 인코딩 유지). */
  target: string;
  authorization: string | null;
  contentType: string | null;
  body: string;
}

interface Core {
  requests: RecordedRequest[];
  store: SqliteMemoryStore;
  sseTokens: SseTokenStore;
  federation: FederationRegistry;
  client: (token?: string) => MemoryApiClient;
}

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function startCore(settings = getMemorySettings("/nonexistent-default-apiclient-recorded", "/nonexistent-default-apiclient-recorded.secrets.json")): Core {
  const dir = mkdtempSync(join(tmpdir(), "bara-apiclient-recorded-"));
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const sseTokens = new SseTokenStore(join(dir, "tokens.json"));
  const app = buildMemoryApi(withDocumentOcrRuntime({
    store,
    retriever: new HybridRetriever(store, embedder),
    assembler: new ContextAssembler(),
    assetStore: new AssetStore(join(dir, "assets")),
    sseTokens,
    getSettings: () => settings,
  }));
  const federation = new FederationRegistry();
  app.route("/federation", createFederationRoutes(federation));
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req, bunServer) => {
      const url = new URL(req.url);
      requests.push({
        method: req.method,
        target: url.pathname + url.search,
        authorization: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
        body: await req.clone().text(),
      });
      return app.fetch(req, bunServer);
    },
  });
  stops.push(() => {
    server.stop(true);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    requests,
    store,
    sseTokens,
    federation,
    client: (token) => new MemoryApiClient(`http://127.0.0.1:${server.port}`, token === undefined ? undefined : { token }),
  };
}

/** 기록된 요청을 [메서드, 경로+쿼리, authorization] 로 줄여 비우며 돌려준다. */
function takeRequests(core: Core): Array<[string, string, string | null]> {
  return core.requests.splice(0).map((r) => [r.method, r.target, r.authorization]);
}

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (e) {
    return e;
  }
  throw new Error("요청이 성공했다 — 오류를 기대했다");
}

function adapterManifest(endpoint: string): AppManifest {
  return {
    id: "bot-discord",
    name: "App bot-discord",
    version: "0.1.0",
    manifestVersion: 1,
    endpoint,
    health: "/health",
    settings: { schemaPath: "/settings/schema", getPath: "/settings", putPath: "/settings" },
    actions: [],
    description: "루프백 어댑터",
    tags: ["test"],
  };
}

describe("MemoryApiClient 헤더 중앙화 + 토큰 인자", () => {
  test("토큰 주입 시 POST 요청에 Authorization 헤더가 붙는다", async () => {
    const core = startCore();
    expect(await core.client("abc").search("테스트 질문")).toEqual([]);
    expect(takeRequests(core)).toEqual([["POST", "/search", "Bearer abc"]]);
  });

  test("토큰 없이 생성하면 Authorization 헤더가 붙지 않는다", async () => {
    const core = startCore();
    await core.client().search("쿼리");
    expect(takeRequests(core)).toEqual([["POST", "/search", null]]);
  });

  test("GET 메서드도 토큰을 싣는다", async () => {
    const core = startCore();
    expect(await core.client("tok").recent(5)).toEqual([]);
    expect(takeRequests(core)).toEqual([["GET", "/memories?recent=5", "Bearer tok"]]);
  });

  test("DELETE 메서드도 토큰을 싣는다", async () => {
    const core = startCore();
    expect((await core.client("del-tok").deleteBySource({ messageId: "m1" })).deletedCount).toBe(0);
    expect(takeRequests(core)).toEqual([["DELETE", "/memories/by-source?messageId=m1", "Bearer del-tok"]]);
  });

  test("Content-Type 헤더는 POST 메서드에서 토큰과 함께 붙는다", async () => {
    const core = startCore();
    await core.client("post-tok").ingest({ content: "안녕" });
    expect(core.requests.map((r) => [r.method, r.target, r.authorization, r.contentType])).toEqual([
      ["POST", "/memories", "Bearer post-tok", "application/json"],
    ]);
  });

  test("enrollAdapterToken 은 POST /adapter-enroll 로 신청 body 를 보내고 토큰은 싣지 않는다", async () => {
    const core = startCore();
    const body = { adapterId: "bot-discord", displayName: "Discord Bot" };
    const result = await core.client("old-token").enrollAdapterToken(body);
    expect(JSON.parse(core.requests[0]!.body)).toEqual(body);
    expect(takeRequests(core)).toEqual([["POST", "/adapter-enroll", null]]);
    expect(result).toEqual({
      status: "pending",
      adapterId: "bot-discord",
      requestId: expect.stringMatching(/^atr_/),
      pickupSecret: expect.any(String),
    });
    // 신청은 실제 승인 큐에 들어갔다.
    expect(core.sseTokens.getTokenRequest(result.requestId)).toMatchObject({ ...body, status: "pending" });
  });

  test("enrollAdapterToken 은 adminToken 을 body 에 실어 보내고 승인 뒤 코어가 그 값을 보관한다 (P1-통합 I1)", async () => {
    const core = startCore();
    const body = {
      adapterId: "bot-discord",
      displayName: "Discord Bot",
      endpoint: "http://127.0.0.1:3100",
      adminToken: "ADMIN-TOKEN-XYZ",
    };
    const enrolled = await core.client().enrollAdapterToken(body);
    expect(JSON.parse(core.requests[0]!.body)).toEqual(body);

    core.sseTokens.approveTokenRequest(enrolled.requestId);
    const picked = await core.client().pickupAdapterToken(enrolled.requestId, enrolled.pickupSecret);
    expect(picked.status).toBe("approved");
    expect(core.sseTokens.getAdapterAdminToken("bot-discord")).toBe("ADMIN-TOKEN-XYZ");
  });

  test("enrollAdapterToken 은 existingToken 을 body 에 실어 보내고, 기존 토큰 소유를 증명하면 코어가 자동 승인한다", async () => {
    const core = startCore();
    const first = await core.client().enrollAdapterToken({ adapterId: "bot-discord", endpoint: "http://127.0.0.1:3100" });
    core.sseTokens.approveTokenRequest(first.requestId);
    const issued = await core.client().pickupAdapterToken(first.requestId, first.pickupSecret);
    if (issued.status !== "approved") throw new Error(`토큰이 발급되지 않았다: ${issued.status}`);
    core.requests.length = 0;

    const body = {
      adapterId: "bot-discord",
      endpoint: "http://127.0.0.1:3100",
      existingToken: issued.token,
      adminToken: "ADMIN-TOKEN-XYZ",
    };
    const second = await core.client().enrollAdapterToken(body);
    expect(JSON.parse(core.requests[0]!.body)).toEqual(body);
    expect(second.status).toBe("approved");
  });

  test("getFederationAppSettings 는 adapter settings 프록시를 인증 헤더로 호출한다", async () => {
    const core = startCore();
    // 어댑터(봇) 자리는 루프백 HTTP 응답기다 — 코어의 프록시가 실제 HTTP 로 이 주소를 부른다.
    const adapter = Bun.serve({
      port: 0,
      fetch: (req) => new URL(req.url).pathname === "/settings"
        ? Response.json({ ok: true })
        : new Response("not found", { status: 404 }),
    });
    stops.push(() => adapter.stop(true));
    core.federation.register(adapterManifest(`http://127.0.0.1:${adapter.port}`), "adapter-dir");

    expect(await core.client("adapter-token").getFederationAppSettings("bot-discord")).toEqual({ ok: true });
    expect(takeRequests(core)).toEqual([["GET", "/federation/apps/bot-discord/settings", "Bearer adapter-token"]]);
  });

  test("pickupAdapterToken 은 pickupSecret query 로 토큰을 회수한다", async () => {
    const core = startCore();
    const enrolled = await core.client().enrollAdapterToken({ adapterId: "bot-discord" });
    core.sseTokens.approveTokenRequest(enrolled.requestId);
    core.requests.length = 0;

    const result = await core.client().pickupAdapterToken(enrolled.requestId, enrolled.pickupSecret);
    expect(takeRequests(core)).toEqual([
      ["GET", `/adapter-enroll/${enrolled.requestId}/token?pickupSecret=${enrolled.pickupSecret}`, null],
    ]);
    expect(result.status).toBe("approved");
    if (result.status === "approved") expect(core.sseTokens.verifyToken(result.token)).toBe("bot-discord");

    // 공백이 든 비밀은 실제로 맞을 수 없어 코어가 404 로 거절한다 — 서버가 받은 query 에서 '+' 인코딩을 본다.
    const wrong = await rejection(() => core.client().pickupAdapterToken(enrolled.requestId, "secret value"));
    expect(wrong).toBeInstanceOf(MemoryApiError);
    expect((wrong as MemoryApiError).status).toBe(404);
    expect(takeRequests(core)).toEqual([
      ["GET", `/adapter-enroll/${enrolled.requestId}/token?pickupSecret=secret+value`, null],
    ]);
  });
});

describe("MemoryApiClient document OCR methods", () => {
  const SCANNED_PDF = join(import.meta.dir, "memory", "canonicalize", "__fixtures__", "scanned.pdf");

  /** 스캔 PDF 를 실제 POST /ingest 로 올려 needs_ocr 문서를 만든다. 올린 요청 기록은 비운다. */
  async function ingestScannedPdf(core: Core): Promise<{ documentId: string; assetSha256: string }> {
    const result = await core.client().postIngest({
      source: "dashboard:manual",
      content: {
        type: "auto",
        data: readFileSync(SCANNED_PDF).toString("base64"),
        mimeType: "application/pdf",
        originalName: "scanned.pdf",
      },
      attribution: { author: "테스터", userId: "u-apiclient-ocr" },
    });
    if (!("documentId" in result)) throw new Error("expected document ingest result");
    core.requests.length = 0;
    return result;
  }

  const parseOf = (core: Core, documentId: string) =>
    readDocumentParseMetadata(core.store.getDocument(documentId)!.sourceMetadata);

  test("listOcrCandidates 는 query 와 Authorization 헤더를 보낸다", async () => {
    const core = startCore();
    const ingested = await ingestScannedPdf(core);
    const got = await core.client("ocr-token").listOcrCandidates({ status: ["needs_ocr", "ocr_failed"], limit: 7 });
    expect(got.map((c) => [c.documentId, c.parse?.status])).toEqual([[ingested.documentId, "needs_ocr"]]);
    expect(takeRequests(core)).toEqual([
      ["GET", "/api/documents/ocr-candidates?status=needs_ocr%2Cocr_failed&limit=7", "Bearer ocr-token"],
    ]);
  });

  test("claimDocumentOcrJob 는 workerId 와 leaseSeconds 를 POST 하고 코어가 lease 를 남긴다", async () => {
    const core = startCore();
    const ingested = await ingestScannedPdf(core);
    const client = core.client("ocr-token");
    const job = await client.claimDocumentOcrJob({ workerId: "worker-a", leaseSeconds: 120 });
    expect(job?.documentId).toBe(ingested.documentId);
    expect(JSON.parse(core.requests[0]!.body)).toEqual({ workerId: "worker-a", leaseSeconds: 120 });
    expect(takeRequests(core)).toEqual([["POST", "/api/documents/ocr-jobs/claim", "Bearer ocr-token"]]);
    expect(parseOf(core, ingested.documentId)?.lease?.workerId).toBe("worker-a");
    // lease 가 살아 있는 문서만 남았으니 다른 worker 의 claim 은 job=null 이다.
    expect(await client.claimDocumentOcrJob({ workerId: "worker-b" })).toBeNull();
  });

  test("getDocumentOcrRuntimeConfig 는 OCR 실행 설정을 GET 한다(비밀값은 hasApiKey 로만)", async () => {
    const settings = getMemorySettings("/nonexistent-custom-apiclient-ocr-config", "/nonexistent-custom-apiclient-ocr-config.secrets.json");
    settings.documents.ocr.mode = "pc_companion";
    settings.documents.ocr.resourceProfile = "gpu";
    settings.documents.ocr.api.apiKey = "sk-ocr-secret";
    settings.documents.ocr.pcCompanion.workerId = "pc-gpu";
    settings.documents.ocr.pcCompanion.pollSeconds = 7;
    (settings.documents.ocr.pcCompanion as unknown as { allowedStatuses: string[] }).allowedStatuses = [
      "needs_ocr",
      "parse_failed",
      "ocr_failed",
    ];
    const core = startCore(settings);
    const config = await core.client("ocr-token").getDocumentOcrRuntimeConfig();
    expect(config.mode).toBe("pc_companion");
    expect(config.resourceProfile).toBe("gpu");
    expect(config.api.hasApiKey).toBe(true);
    expect(JSON.stringify(config)).not.toContain("sk-ocr-secret");
    expect(config.pcCompanion.workerId).toBe("pc-gpu");
    expect(config.pcCompanion.allowedStatuses).toEqual(["needs_ocr", "parse_failed", "ocr_failed"]);
    expect(takeRequests(core)).toEqual([["GET", "/api/documents/ocr-runtime-config", "Bearer ocr-token"]]);
  });

  test("failure/apply/download OCR helpers 는 URL 과 body 를 맞추고 코어가 상태를 바꾼다", async () => {
    const core = startCore();
    const ingested = await ingestScannedPdf(core);
    const client = core.client("ocr-token");
    const failureBody = { errorMessage: "failed", source: "companion" as const, workerId: "worker-a" };
    const resultBody = {
      markdown: "# OCR\n\n## 품목\n\n연필 세 자루와 공책 두 권",
      source: "companion" as const,
      workerId: "worker-a",
    };

    await client.claimDocumentOcrJob({ workerId: "worker-a" });
    const failed = await client.reportDocumentOcrFailure(ingested.documentId, failureBody);
    expect(failed.documentId).toBe(ingested.documentId);
    expect(parseOf(core, ingested.documentId)?.status).toBe("ocr_failed");

    const applied = await client.applyDocumentOcrResult(ingested.documentId, resultBody);
    expect(applied.documentId).toBe(ingested.documentId);
    expect(applied.chunkCount).toBeGreaterThan(0);
    expect(applied.nodeIds.length).toBeGreaterThan(0);
    expect(parseOf(core, ingested.documentId)?.status).toBe("ocr_succeeded");

    const asset = await client.downloadAsset(applied.assetSha256);
    expect(asset.contentType).toBe("text/markdown");
    expect(new TextDecoder().decode(asset.arrayBuffer)).toBe(resultBody.markdown);

    const id = encodeURIComponent(ingested.documentId);
    const [claim, failure, result, download] = core.requests;
    expect(claim!.target).toBe("/api/documents/ocr-jobs/claim");
    expect([failure!.method, failure!.target, JSON.parse(failure!.body)]).toEqual(["POST", `/api/documents/${id}/ocr-failure`, failureBody]);
    expect([result!.method, result!.target, JSON.parse(result!.body)]).toEqual(["POST", `/api/documents/${id}/ocr-result`, resultBody]);
    expect([download!.method, download!.target]).toEqual(["GET", `/assets/${applied.assetSha256}`]);
    expect(core.requests).toHaveLength(4);
    expect(core.requests.every((r) => r.authorization === "Bearer ocr-token")).toBe(true);
  });

  test("downloadAsset 은 올린 PDF 원본을 같은 바이트로 내려받는다", async () => {
    const core = startCore();
    const ingested = await ingestScannedPdf(core);
    const asset = await core.client("ocr-token").downloadAsset(ingested.assetSha256);
    expect(asset.contentType).toBe("application/pdf");
    expect(new Uint8Array(asset.arrayBuffer)).toEqual(new Uint8Array(readFileSync(SCANNED_PDF)));
    expect(takeRequests(core)).toEqual([["GET", `/assets/${ingested.assetSha256}`, "Bearer ocr-token"]]);
  });

  test("문서 id 는 URL 경로에서 인코딩되어 나가고, 없는 문서는 MemoryApiError(404)", async () => {
    const core = startCore();
    const client = core.client("ocr-token");
    const apply = await rejection(() => client.applyDocumentOcrResult("doc a", { markdown: "# OCR" }));
    const failure = await rejection(() => client.reportDocumentOcrFailure("doc a", { errorMessage: "failed" }));
    expect([apply, failure].map((e) => (e as MemoryApiError).status)).toEqual([404, 404]);
    expect(takeRequests(core).map(([method, target]) => [method, target])).toEqual([
      ["POST", "/api/documents/doc%20a/ocr-result"],
      ["POST", "/api/documents/doc%20a/ocr-failure"],
    ]);
  });

  test("OCR helper 비2xx 는 MemoryApiError 로 전파한다(다른 worker 의 lease 문서 → 409)", async () => {
    // claimDocumentOcrJob 자체는 409 를 내는 실제 조건이 없어(후보가 없으면 job=null) 같은 OCR 헬퍼 군의 실제
    // 409 — lease 를 쥔 worker 가 따로 있는 문서에 다른 worker 가 실패를 기록 — 로 본다.
    const core = startCore();
    const ingested = await ingestScannedPdf(core);
    const client = core.client();
    await client.claimDocumentOcrJob({ workerId: "worker-a" });
    const thrown = await rejection(() =>
      client.reportDocumentOcrFailure(ingested.documentId, { errorMessage: "끼어들기", workerId: "worker-b" }),
    );
    expect(thrown).toBeInstanceOf(MemoryApiError);
    expect((thrown as MemoryApiError).status).toBe(409);
    expect((thrown as MemoryApiError).message).toContain("다른 OCR worker");
    expect(parseOf(core, ingested.documentId)?.status).toBe("needs_ocr");
  });
});

// ── postIngest → 진짜 POST /ingest(문서 라우트) 통합 검증 (Phase 14b T4) ──────
//
// 기존 client.ingest() 는 POST /memories 를 부르지만, postIngest 는 14a 의
// 문서 라우트 POST /ingest 를 부른다. assetStore 를 주입한 harness 로 실 흐름을
// 검증한다(mock 없음 — 실 DB + 실 임베더 + 실 AssetStore tmp dir + 실 ingest 라우트).

describe("MemoryApiClient.postIngest → POST /ingest", () => {
  let assetDir: string;
  let db: Database;
  let server: ReturnType<typeof Bun.serve>;
  let client: MemoryApiClient;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    assetDir = mkdtempSync(join(tmpdir(), "bara-apiclient-ingest-"));
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    const retriever = new HybridRetriever(store, embedder);
    const assembler = new ContextAssembler();
    const assetStore = new AssetStore(assetDir);
    const settings = getMemorySettings("/nonexistent-default-apiclient-ingest", "/nonexistent-default-apiclient-ingest.secrets.json");
    const app = buildMemoryApi({
      store,
      retriever,
      assembler,
      assetStore,
      getSettings: () => settings,
    });
    server = Bun.serve({ port: 0, fetch: app.fetch });
    client = new MemoryApiClient(`http://127.0.0.1:${server.port}`);
  });

  afterEach(() => {
    server.stop(true);
    db.close();
    rmSync(assetDir, { recursive: true, force: true });
  });

  test("텍스트 문서 → ok + documentId + nodeIds(>=2) + warnings=[] + detection.kind=passthrough", async () => {
    const result = await client.postIngest({
      source: "discord:dm",
      content: {
        type: "text",
        data: "바라 시스템 개요\n\n바라는 콘텐츠 어디든 붙어 쓸 수 있는 메모리 모듈입니다.",
        mimeType: "text/markdown",
        originalName: "overview.md",
      },
      attribution: { author: "테스터", userId: "u-postingest-1" },
    });

    expect(result.ok).toBe(true);
    if (!("documentId" in result)) {
      throw new Error("expected document ingest result");
    }
    expect(result.assetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.documentId).toMatch(/^doc_/);
    expect(result.nodeIds.length).toBeGreaterThanOrEqual(2);
    expect(result.cacheHit).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.detection.kind).toBe("passthrough");
    expect(result.detection.extractedCharCount).toBeGreaterThan(0);

    // 저장 흐름 검증 — document 노드가 실제로 store 에 들어갔는지.
    const doc = store.getDocument(result.documentId);
    expect(doc).not.toBeNull();
    expect(doc!.assetSha256).toBe(result.assetSha256);
  });

  test("hashtags + classification 전달 → metadata.tags 보존", async () => {
    const result = await client.postIngest({
      source: "dashboard:manual",
      content: {
        type: "text",
        data: "태그 보존 검증용 문서입니다.",
        mimeType: "text/markdown",
        originalName: "tagged.md",
      },
      attribution: { author: "u", userId: "u1" },
      classification: { document_type: "free" },
      hashtags: ["메모리모듈", "바라"],
    });
    expect(result.ok).toBe(true);
    const documentNodeId = result.nodeIds[0]!;
    const node = await store.getNode(documentNodeId);
    expect(node).not.toBeNull();
    expect(node!.metadata.tags).toEqual(["메모리모듈", "바라"]);
  });

  test("content 없는 잘못된 입력 → 비2xx → 구체 Error throw(silent 빈 결과 아님)", async () => {
    let thrown: unknown = null;
    try {
      // @ts-expect-error — content 누락은 컴파일 타임에도 막히지만, 런타임 비2xx 처리를 검증.
      await client.postIngest({
        source: "x",
        attribution: { author: "u", userId: "u1" },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("memory-api");
  });
});
