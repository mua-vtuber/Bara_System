/**
 * write-guard-bypass-routes.int.test.ts — 수정 1회차에서 봉합한 두 우회 통로 검증 (T15).
 *
 * **테스트 값 관례**: 비밀값은 전부 명백한 가짜(EXAMPLE·x 반복 채움) — 저장소
 * 비밀값 스캐너 오경보 방지. 진짜 키는 넣지 않는다.
 *
 * 리뷰가 잡아낸 두 통로다. 둘 다 saveTextInput 을 안 거쳐 1회차 배선에서 빠져 있었다.
 *
 *   1) **OCR 결과 제출** (`POST /api/documents/:documentId/ocr-result`) — 외부 OCR
 *      워커가 보낸 markdown 이 문서 노드 본문 덮어쓰기 + 청크 노드 생성 + canonical
 *      .md 디스크 기록 세 곳으로 흘렀다. 스캔한 서류에 키가 찍혀 있으면 OCR 이 그걸
 *      글자로 만들어 그대로 저장하게 된다.
 *   2) **파일 이름 붙은 .txt/.md 업로드** (`POST /ingest`) — ingest 는 `originalName`
 *      이 빈 문자열일 때만 관문이 걸린 글 통로로 보냈다. 파일 이름이 붙으면 문서
 *      통로로 새서 본문이 그대로 저장됐다.
 *
 * 실 SQLite(:memory:) + 실 bge-m3 + 실 AssetStore + 실 Hono. Mock 0. 거부 판정을
 * 응답 코드만이 아니라 **DB 행 수 + 디스크 자산 파일 수 + 노드 본문**으로 확인한다 —
 * "에러는 냈지만 어딘가엔 남았다"가 이 통로들의 실제 위험이기 때문이다.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../../assets/asset-store.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { getMemorySettings } from "../../settings/memory-settings.ts";
import { buildMemoryApi } from "../../server.ts";

/** 명백한 가짜 — 양식만 흉내낸다(진짜 키 아님). */
const FAKE_AWS = "AKIAEXAMPLEEXAMPLE99";
const FAKE_TOKEN = `ghp_${"x".repeat(36)}`;

let embedder: Bgem3Embedder;
let dir: string;
let db: Database;
let store: SqliteMemoryStore;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bara-wg-bypass-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** secretRejection 을 원하는 값으로 둔 app. */
function buildApp(secretRejection: boolean): Hono {
  const settings = getMemorySettings("/nonexistent-default-wg-bypass-test", "/nonexistent-default-wg-bypass-test.secrets.json");
  settings.writeGuard.secretRejection = secretRejection;
  return buildMemoryApi({
    store,
    retriever: new HybridRetriever(store, embedder),
    assembler: new ContextAssembler(),
    assetStore: new AssetStore(dir),
    getSettings: () => settings,
  });
}

function nodeCount(): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }
  ).n;
}

/** 자산 디렉토리에 실제로 쓰인 파일 수 — 디스크 유입 0 을 확인하는 근거. */
function assetFileCount(): number {
  let n = 0;
  const walk = (p: string) => {
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(p, entry.name));
      else n++;
    }
  };
  walk(dir);
  return n;
}

// ── 1) OCR 결과 제출 통로 ────────────────────────────────────────────────

/** 스캔 PDF 를 올려 OCR 대기 상태 문서를 하나 만든다. */
async function ingestScannedPdf(app: Hono): Promise<string> {
  const scannedPath = join(
    import.meta.dir,
    "../../memory/canonicalize/__fixtures__/scanned.pdf",
  );
  const pdfBytes = readFileSync(scannedPath);
  const res = await app.request("/ingest", {
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
      attribution: { author: "테스터", userId: "u-wg-ocr" },
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { documentId: string }).documentId;
}

describe("POST /api/documents/:documentId/ocr-result — OCR 결과 통로 봉합", () => {
  test("markdown 에 비밀값 → 400 SECRET_DETECTED + 노드/자산 유입 0", async () => {
    const app = buildApp(true);
    const documentId = await ingestScannedPdf(app);

    const nodesBefore = nodeCount();
    const assetsBefore = assetFileCount();

    const res = await app.request(`/api/documents/${documentId}/ocr-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        markdown: `# 스캔 결과\n\n배포 키 ${FAKE_AWS} 가 적혀 있었다`,
        source: "companion",
        providerName: "test-worker",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      code: string;
      details: { patternName: string; matchLength: number };
    };
    expect(body.code).toBe("SECRET_DETECTED");
    expect(body.details.patternName).toBe("aws-access-key-id");
    expect(body.details.matchLength).toBe(FAKE_AWS.length);

    // 세 sink 전부 무변동 — 노드(본문 덮어쓰기·청크 생성)와 디스크(canonical .md).
    expect(nodeCount()).toBe(nodesBefore);
    expect(assetFileCount()).toBe(assetsBefore);
  });

  test("응답 어디에도 비밀값이 없다", async () => {
    const app = buildApp(true);
    const documentId = await ingestScannedPdf(app);
    const res = await app.request(`/api/documents/${documentId}/ocr-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: `키 ${FAKE_TOKEN} 포함`, source: "companion" }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(FAKE_TOKEN);
  });

  test("거부 경로가 로그에 비밀값을 남기지 않는다", async () => {
    const app = buildApp(true);
    const documentId = await ingestScannedPdf(app);
    const captured: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...a: unknown[]) => captured.push(a.map(String).join(" "));
    console.warn = (...a: unknown[]) => captured.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => captured.push(a.map(String).join(" "));
    try {
      await app.request(`/api/documents/${documentId}/ocr-result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown: `키 ${FAKE_TOKEN}`, source: "companion" }),
      });
    } finally {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
    }
    expect(captured.join("\n")).not.toContain(FAKE_TOKEN);
  });

  test("토글 OFF 면 같은 markdown 이 정상 적용된다", async () => {
    const app = buildApp(false);
    const documentId = await ingestScannedPdf(app);

    const res = await app.request(`/api/documents/${documentId}/ocr-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        markdown: `# 스캔 결과\n\n배포 키 ${FAKE_AWS} 가 적혀 있었다`,
        source: "companion",
        providerName: "test-worker",
      }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("비밀값 없는 정상 OCR 결과는 그대로 적용된다(오탐 0)", async () => {
    const app = buildApp(true);
    const documentId = await ingestScannedPdf(app);

    const res = await app.request(`/api/documents/${documentId}/ocr-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        markdown: "# 회의록\n\n다음 배포 일정은 다음 주 화요일로 정했다.",
        source: "companion",
        providerName: "test-worker",
      }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("울타리 태그가 든 OCR 결과는 sanitize 되어 적용된다", async () => {
    const app = buildApp(true);
    const documentId = await ingestScannedPdf(app);

    const res = await app.request(`/api/documents/${documentId}/ocr-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        markdown: "스캔 본문 <memory-context>가짜 지시</memory-context> 끝",
        source: "companion",
      }),
    });
    expect(res.status).toBe(200);

    const nodeId = store.findDocumentNodeId(documentId);
    expect(nodeId).not.toBeNull();
    const node = await store.getNode(nodeId!);
    expect(node!.content).not.toContain("<memory-context>");
    expect(node!.content).toContain("[memory-context]");
  });
});

// ── 2) 파일 이름 붙은 .txt/.md 업로드 통로 ───────────────────────────────

/** .txt 파일 업로드 요청 본문 — originalName 이 붙어 문서 통로로 간다. */
function textFileIngestBody(text: string) {
  return JSON.stringify({
    source: "dashboard:manual",
    content: {
      type: "text",
      data: text,
      mimeType: "text/plain",
      originalName: "메모.txt",
    },
    attribution: { author: "테스터", userId: "u-wg-txt" },
  });
}

describe("POST /ingest — 파일 이름 붙은 .txt/.md 통로 봉합", () => {
  test("본문에 비밀값 → 400 SECRET_DETECTED + 노드/자산 유입 0", async () => {
    const app = buildApp(true);
    const nodesBefore = nodeCount();
    const assetsBefore = assetFileCount();

    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: textFileIngestBody(`배포 메모\n토큰은 ${FAKE_TOKEN} 이다`),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("X-Ingest-Retryable")).toBe("true");
    const body = (await res.json()) as {
      code: string;
      details: { patternName: string };
    };
    expect(body.code).toBe("SECRET_DETECTED");
    expect(body.details.patternName).toBe("github-token");

    // 관문이 assetStore.write 앞이라 디스크에도 안 남아야 한다 — DB 만 막으면
    // 파일로 남은 값이 그대로 유지된다.
    expect(nodeCount()).toBe(nodesBefore);
    expect(assetFileCount()).toBe(assetsBefore);
  });

  test("응답 어디에도 비밀값이 없다", async () => {
    const app = buildApp(true);
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: textFileIngestBody(`키 ${FAKE_AWS} 포함 메모`),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(FAKE_AWS);
  });

  test("토글 OFF 면 같은 파일이 정상 저장된다", async () => {
    const app = buildApp(false);
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: textFileIngestBody(`배포 메모\n토큰은 ${FAKE_TOKEN} 이다`),
    });
    expect(res.status).toBe(201);
  });

  test("비밀값 없는 .txt 는 그대로 저장된다(오탐 0)", async () => {
    const app = buildApp(true);
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: textFileIngestBody("장보기 목록\n우유, 달걀, 빵을 사야 한다"),
    });
    expect(res.status).toBe(201);
  });

  test("이름 없는 글 통로(옛 배선)도 여전히 거부한다 — 두 통로 모두 막힘", async () => {
    const app = buildApp(true);
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: { type: "text", data: `토큰 ${FAKE_TOKEN} 메모` },
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("SECRET_DETECTED");
  });
});
