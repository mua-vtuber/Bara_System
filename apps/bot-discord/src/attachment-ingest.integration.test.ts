/**
 * attachment-ingest.integration.test.ts — 글루 함수 ingestAttachment 통합 검증
 * (Phase 14b T5 후속 + Phase 11a T7 갱신).
 *
 * 순수 함수(classifyAttachment·buildIngestPayload·formatIngestResponse)는
 * attachment-ingest.test.ts 가 덮는다. 여기서는 비어 있던 글루 가지 — 실제
 * 다운로드(fetch) → 인코딩 → postIngest 흐름 — 을 진짜 동작으로 검증한다.
 *
 * mock 객체 없음 (CLAUDE.md 정책):
 *   - IngestCaller 는 진짜 MemoryApiClient (apps/memory/src/api-client.ts).
 *   - 메모리 서버는 실 SQLite(:memory:) + 실 Bgem3Embedder + 실 AssetStore 로 띄운
 *     buildMemoryApi 를 Bun.serve 로 진짜 URL 에 노출 → 그 URL 로 MemoryApiClient 생성.
 *   - 첨부 다운로드는 또 하나의 Bun.serve 가 fixture 바이트를 정해진 경로에 내려준다.
 *   - 진짜 fetch 사용. fetch 를 가로채거나 교체하지 않는다.
 *
 * 덮는 가지 (각각 AttachmentOutcome 의 status/reason/documentId 직접 대조):
 *   1. 텍스트(.md)   → status=ingested + documentId + 실 DB 에 document/chunk 들어감
 *   2. 문서(.pdf)    → base64 인코딩 → status=ingested (텍스트와 다른 경로)
 *   3. 다운로드 비2xx → status=failed + reason 에 HTTP 상태
 *   4. 다운로드 예외  → status=failed + reason 비어 있지 않음 (서버 unreachable)
 *   5. 판정 거부(svg+xml) → 11a T7 받는 이미지 5 종 외 — 다운로드 안 함 + rejected
 *   6. postIngest 실패 → /ingest 가 500 돌려주는 진짜 서버 → status=failed + reason
 *   7. 메시지 출처(WP-B1-20U 설계 17.8) → 문서 노드에 첨부 키 행 → 진짜 deleteBySource 가 문서 노드·청크를 지운다
 *
 * 11a T7 갱신: 옛 "png 거부" 가닥이 *받음* 으로 의미 바뀌어 (5 번) — 받지 않는
 * 이미지(svg+xml) 거부 가닥으로 갱신. PNG 받음 가닥(ingestImage 통로) 통합 검증은
 * 별 image embedder 부담이 커 본 묶음에 합류 안 함 — 단위 test 가 분기 합류를
 * 덮는다(classify·buildPayload·formatIngestResponse 한 묶음).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bgem3Embedder } from "../../memory/src/embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../memory/src/db/migrations.ts";
import { SqliteMemoryStore } from "../../memory/src/db/store.ts";
import { HybridRetriever } from "../../memory/src/memory/retriever.ts";
import { ContextAssembler } from "../../memory/src/memory/context-assembler.ts";
import { AssetStore } from "../../memory/src/assets/asset-store.ts";
import { getMemorySettings } from "../../memory/src/settings/memory-settings.ts";
import { buildMemoryApi } from "../../memory/src/server.ts";
import { MemoryApiClient } from "../../memory/src/api-client.ts";
import { NodeSourceRepository } from "../../memory/src/db/store-internal/node-source-repository.ts";
import { lineageOrphans } from "../../memory/src/test-utils/lineage-invariant.ts";
import {
  ingestAttachment,
  type AttachmentMetaLike,
  type AttachmentSourceMessage,
} from "./attachment-ingest.ts";

// ── fixture 바이트 (repo 안 기존 자산 재사용, 새 바이너리 안 만듦) ──────────────

// text.pdf = "Hello bara" — 추출 가능한 텍스트가 있는 작은 유효 PDF.
const PDF_FIXTURE_BYTES = readFileSync(
  join(
    import.meta.dir,
    "../../memory/src/memory/canonicalize/__fixtures__/text.pdf",
  ),
);
const MARKDOWN_TEXT =
  "# 첨부 다리 통합 검증\n\n바라는 콘텐츠 어디든 붙어 쓸 수 있는 메모리 모듈입니다.";

// ── 첨부 다운로드용 정적 파일 서버 경로 ──────────────────────────────────────

const PATH_NOTE_MD = "/note.md";
const PATH_DOC_PDF = "/doc.pdf";
const PATH_MISSING = "/missing";

// ── 공통 attribution ─────────────────────────────────────────────────────────

const ATTRIBUTION = { author: "테스터", userId: "u-attach-1" };
const SOURCE = "discord:dm";
/** 첨부를 보낸 메시지 — index.ts 가 MessageCreate 에서 만드는 모양(DM 이라 서버 없음). */
const MESSAGE: AttachmentSourceMessage = {
  platform: "discord",
  messageId: "msg-attach-1",
  channelId: "dm-channel-1",
  guildId: null,
};

// ── 테스트 전역 — 임베더는 비싸니 한 번만 load ───────────────────────────────

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

// ── 테스트별 harness ────────────────────────────────────────────────────────

let dir: string;
let db: Database;
let store: SqliteMemoryStore;
let memoryServer: Server<undefined>;
let fileServer: Server<undefined>;
let apiClient: MemoryApiClient;
let fileBaseUrl: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bara-attach-"));
  // Bgem3Embedder(1024)와 짝을 명시한다 — store 임베딩 차원과 DB vec 차원이
  // 어긋나면 삽입이 500 으로 실패하므로 embedder.dimension 과 같은 값을 둔다.
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const assetStore = new AssetStore(dir);
  const settings = getMemorySettings("/nonexistent-default-attach-test", "/nonexistent-default-attach-test.secrets.json");
  const app = buildMemoryApi({
    store,
    retriever,
    assembler,
    assetStore,
    getSettings: () => settings,
  });

  // 메모리 API 를 진짜 URL 에 노출 → 진짜 MemoryApiClient 가 그 URL 로 부른다.
  memoryServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  apiClient = new MemoryApiClient(`http://127.0.0.1:${memoryServer.port}`);

  // 첨부 다운로드용 정적 파일 서버 — fixture 바이트를 정해진 경로에 내려준다.
  fileServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === PATH_NOTE_MD) {
        return new Response(MARKDOWN_TEXT, {
          status: 200,
          headers: { "content-type": "text/markdown" },
        });
      }
      if (pathname === PATH_DOC_PDF) {
        return new Response(PDF_FIXTURE_BYTES, {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }
      // /missing 등 그 외 경로 → 404.
      return new Response("not found", { status: 404 });
    },
  });
  fileBaseUrl = `http://127.0.0.1:${fileServer.port}`;
});

afterEach(() => {
  memoryServer.stop(true);
  fileServer.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── 테스트 가족 ─────────────────────────────────────────────────────────────

describe("ingestAttachment — 글루 실제 동작", () => {
  // ── 1. 텍스트(.md) 경로 ─────────────────────────────────────────────────
  test("텍스트(.md) 첨부 → ingested + documentId + 실 DB 에 document/chunk 저장", async () => {
    const attachment: AttachmentMetaLike = {
      id: "att-int-1",
      name: "note.md",
      contentType: "text/markdown",
      url: `${fileBaseUrl}${PATH_NOTE_MD}`,
      size: MARKDOWN_TEXT.length,
    };

    const outcome = await ingestAttachment(apiClient, attachment, SOURCE, ATTRIBUTION, MESSAGE);

    expect(outcome.status).toBe("ingested");
    if (outcome.status !== "ingested") return;
    expect(outcome.name).toBe("note.md");
    expect(outcome.documentId).toMatch(/^doc_/);

    // 진짜 ingest 동작 확인 — 메모리 DB 에 해당 document 가 들어갔는지 후속 조회.
    const doc = store.getDocument(outcome.documentId);
    expect(doc).not.toBeNull();
    // document 노드 + 최소 1개 chunk 노드가 생성됐는지 — chunk 가 실제로 들어갔다는 증거.
    const docNodeCount = (
      db.prepare("SELECT COUNT(*) AS c FROM knowledge_nodes").get() as { c: number }
    ).c;
    expect(docNodeCount).toBeGreaterThanOrEqual(2);
  });

  // ── 2. 문서(.pdf) 경로 — base64 인코딩 흐름 ───────────────────────────────
  test("문서(.pdf) 첨부 → base64 인코딩 → ingested + documentId", async () => {
    const attachment: AttachmentMetaLike = {
      id: "att-int-2",
      name: "doc.pdf",
      contentType: "application/pdf",
      url: `${fileBaseUrl}${PATH_DOC_PDF}`,
      size: PDF_FIXTURE_BYTES.length,
    };

    const outcome = await ingestAttachment(apiClient, attachment, SOURCE, ATTRIBUTION, MESSAGE);

    expect(outcome.status).toBe("ingested");
    if (outcome.status !== "ingested") return;
    expect(outcome.name).toBe("doc.pdf");
    expect(outcome.documentId).toMatch(/^doc_/);
    // PDF 가 base64 로 갔는데도 메모리쪽이 정상 처리 — document 가 실제 저장됐는지.
    const doc = store.getDocument(outcome.documentId);
    expect(doc).not.toBeNull();
  });

  // ── 3. 다운로드 비2xx → failed + HTTP 상태 사유 ───────────────────────────
  test("다운로드 비2xx(404) → failed + reason 에 HTTP 상태", async () => {
    const attachment: AttachmentMetaLike = {
      id: "att-int-3",
      name: "missing.md",
      contentType: "text/markdown",
      url: `${fileBaseUrl}${PATH_MISSING}`,
      size: 10,
    };

    const outcome = await ingestAttachment(apiClient, attachment, SOURCE, ATTRIBUTION, MESSAGE);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.name).toBe("missing.md");
    // 사람이 읽을 형태 — HTTP 상태 코드가 사유에 담겼는지.
    expect(outcome.reason).toContain("다운로드 실패");
    expect(outcome.reason).toContain("404");
  });

  // ── 4. 다운로드 예외 — 서버 unreachable ───────────────────────────────────
  test("다운로드 예외(서버 unreachable) → failed + reason 비어 있지 않음", async () => {
    // 멈춘 파일 서버 포트로 URL 을 둔다 — 연결 자체가 실패.
    const deadPort = fileServer.port;
    fileServer.stop(true);

    const attachment: AttachmentMetaLike = {
      id: "att-int-4",
      name: "unreachable.md",
      contentType: "text/markdown",
      url: `http://127.0.0.1:${deadPort}${PATH_NOTE_MD}`,
      size: 10,
    };

    const outcome = await ingestAttachment(apiClient, attachment, SOURCE, ATTRIBUTION, MESSAGE);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.name).toBe("unreachable.md");
    expect(outcome.reason).toContain("다운로드 실패");
    expect(outcome.reason.length).toBeGreaterThan("다운로드 실패".length);

    // afterEach 의 두 번째 stop 이 터지지 않도록 살아 있는 서버로 되돌린다.
    fileServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  });

  // ── 5. 판정 거부(svg+xml) — 11a T7 받는 이미지 5 종 외 ────────────────────
  // 옛 14b 가닥은 png 거부 검증이었으나, 11a T7 가 png/jpeg/gif/webp/apng 5 종을
  // 받기 시작 — 거부 검증은 받지 않는 이미지(svg+xml/tiff/bmp 등) 로 의미가 갱신된다.
  test("이미지(svg+xml) 첨부 → 다운로드 없이 rejected + 이미지 형식 안내 사유", async () => {
    // url 을 살아 있는 파일 서버의 404 경로로 둬도, classify 거부라 다운로드 자체가 없어야 한다.
    const attachment: AttachmentMetaLike = {
      id: "att-int-5",
      name: "벡터.svg",
      contentType: "image/svg+xml",
      url: `${fileBaseUrl}${PATH_MISSING}`,
      size: 2048,
    };

    const outcome = await ingestAttachment(apiClient, attachment, SOURCE, ATTRIBUTION, MESSAGE);

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    expect(outcome.name).toBe("벡터.svg");
    expect(outcome.reason.length).toBeGreaterThan(0);
    // 11a T7 — image/* 갈래 정직 알림(받는 5 종 안내 동반).
    expect(outcome.reason).toContain("이미지 형식");
    expect(outcome.reason).toContain("svg+xml");
    // rejected 면 메모리 DB 에 노드가 하나도 안 들어가야 한다 (다운로드·ingest 안 함).
    const nodeCount = (
      db.prepare("SELECT COUNT(*) AS c FROM knowledge_nodes").get() as { c: number }
    ).c;
    expect(nodeCount).toBe(0);
  });

  // ── 6. postIngest 실패 — /ingest 가 500 돌려주는 진짜 서버 ─────────────────
  test("postIngest 비2xx(500) → failed + reason 에 'POST /ingest 실패'", async () => {
    // /ingest 에 500 을 돌려주는 작은 진짜 Bun.serve — 클라이언트는 진짜, 서버 응답만 에러.
    const errorServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response(JSON.stringify({ error: "강제 500" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const errorClient = new MemoryApiClient(`http://127.0.0.1:${errorServer.port}`);

    const attachment: AttachmentMetaLike = {
      id: "att-int-6",
      name: "note.md",
      contentType: "text/markdown",
      url: `${fileBaseUrl}${PATH_NOTE_MD}`,
      size: MARKDOWN_TEXT.length,
    };

    const outcome = await ingestAttachment(errorClient, attachment, SOURCE, ATTRIBUTION, MESSAGE);

    errorServer.stop(true);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.name).toBe("note.md");
    expect(outcome.reason).toContain("POST /ingest 실패");
  });

  // ── 7. 메시지 출처 — 메시지 삭제가 첨부 기억을 지운다(WP-B1-20U 설계 17.8) ─────
  test("sourceMessage 를 실은 .md 첨부 → 문서 노드에 첨부 키 행 → deleteBySource 가 문서 노드·청크를 지운다", async () => {
    const attachment: AttachmentMetaLike = {
      id: "att-md-1",
      name: "note.md",
      contentType: "text/markdown",
      url: `${fileBaseUrl}${PATH_NOTE_MD}`,
      size: MARKDOWN_TEXT.length,
    };

    const outcome = await ingestAttachment(apiClient, attachment, SOURCE, ATTRIBUTION, MESSAGE);

    expect(outcome.status).toBe("ingested");
    const documentNode = db.query("SELECT id FROM knowledge_nodes WHERE source_type = 'document'").get() as { id: number };
    const rows = new NodeSourceRepository(db).listSync([documentNode.id]).get(documentNode.id)!;
    expect(rows.map((row) => row.key)).toEqual([`msg:discord:${MESSAGE.messageId}:att:att-md-1`]);
    expect(rows[0]!.detail).toMatchObject({ channelId: MESSAGE.channelId, guildId: null, attachmentId: "att-md-1" });

    const deleted = await apiClient.deleteBySource({ messageId: MESSAGE.messageId, platform: "discord" });

    expect(deleted.deletedIds).toEqual([documentNode.id]);
    expect(deleted.derivedDeletedIds.length).toBeGreaterThan(0);
    expect((db.query("SELECT COUNT(*) AS c FROM knowledge_nodes").get() as { c: number }).c).toBe(0);
    expect(lineageOrphans(db)).toEqual([]);
  });
});
