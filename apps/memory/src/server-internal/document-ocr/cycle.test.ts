/**
 * 서버 OCR 사이클 — 실제 SQLite·실제 마이그레이션·실제 bge-m3·실제 자산 저장소·실제 PDF fixture·대역 공급자 서버
 * (2026-10-11 document-ocr spec T7). 재과금 방지는 대역 서버가 받은 요청 수로 확인한다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
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
import { getMemorySettings, type DocumentOcrSettings, type MemorySettings } from "../../settings/memory-settings.ts";
import { buildMemoryApi } from "../../server.ts";
import type { MemoryApiDeps } from "../types.ts";
import { startProviderStandIn, type ProviderStandIn, type StandInReply } from "../../test-utils/provider-stand-in.ts";
import { runDocumentOcrCycle } from "./cycle.ts";
import { DocumentOcrLedger } from "./ledger.ts";
import { createDocumentPageImageSource } from "./page-images.ts";
import { createDocumentOcrReader } from "./page-reader.ts";

let embedder: Bgem3Embedder;
let standIn: ProviderStandIn;
let dir: string;
let db: Database;
let store: SqliteMemoryStore;
let deps: MemoryApiDeps;
let settings: MemorySettings;
let ledger: DocumentOcrLedger;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
  standIn = startProviderStandIn();
});
afterAll(() => standIn.stop());

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bara-ocr-cycle-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  settings = getMemorySettings("/nonexistent-ocr-cycle-test", "/nonexistent-ocr-cycle-test.secrets.json");
  const ocr = settings.documents.ocr;
  ocr.mode = "api";
  ocr.api.provider = "openai_compatible";
  ocr.api.openaiBaseUrl = `${standIn.origin}/v1`;
  ocr.api.openaiModel = "vlm-test";
  ocr.schedule.timeoutMs = 5000;
  ocr.schedule.leaseSeconds = 120;
  ocr.schedule.batchSize = 5;
  ocr.pageImage.maxEdgePx = 512;
  deps = {
    store,
    retriever: new HybridRetriever(store, embedder),
    assembler: new ContextAssembler(),
    assetStore: new AssetStore(dir),
    getSettings: () => settings,
  };
  ledger = new DocumentOcrLedger(db);
  standIn.requests.length = 0;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let ingestCount = 0;
const ids = () => (ingestCount += 1);

async function ingestPdf(file = "scanned-3page.pdf", suffix = ""): Promise<string> {
  const app = buildMemoryApi(deps);
  // suffix 를 붙이면 내용이 달라져 다른 원본 자산·문서가 된다(같은 PDF 를 여러 번 넣는 시험).
  const bytes = Buffer.concat([readFileSync(join(import.meta.dir, "__fixtures__", file)), Buffer.from(suffix)]);
  const res = await app.request("/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "dashboard:manual",
      content: { type: "auto", data: Buffer.from(bytes).toString("base64"), mimeType: "application/pdf", originalName: suffix ? `starve${ids()}-${file}` : file },
      attribution: { author: "테스터", userId: "u-ocr-cycle" },
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { documentId: string };
  expect(parseStatus(body.documentId)).toBe("needs_ocr");
  return body.documentId;
}

function parseStatus(documentId: string): string | undefined {
  return readDocumentParseMetadata(store.getDocument(documentId)!.sourceMetadata)?.status;
}

function ocrOk(text: string): StandInReply {
  return { body: { choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } } };
}
function ocrTruncated(): StandInReply {
  return { body: { choices: [{ message: { content: "앞부분" }, finish_reason: "length" }] } };
}

/** 요청 순서대로 응답을 정한다(n 번째 요청 → replies[n], 넘치면 마지막). */
function replySequence(replies: StandInReply[]): void {
  let n = 0;
  standIn.reply = () => replies[Math.min(n++, replies.length - 1)]!;
}

function cycle(ocr: DocumentOcrSettings = settings.documents.ocr, documentId?: string) {
  return runDocumentOcrCycle(
    { api: deps, ledger, settings: ocr, pageImages: createDocumentPageImageSource(), createReader: (s) => createDocumentOcrReader(s) },
    documentId ? { documentId } : {},
  );
}

/**
 * 문서의 updated_at 을 정한다 — 후보는 updated_at 오래된 순으로 고르는데 시각이 초 단위라, 같은 초에 넣은 문서끼리는
 * 무작위 document_id 로 순서가 갈린다. 처리 순서가 결과를 좌우하는 시험은 이 값으로 순서를 못박는다.
 */
function setUpdatedAt(documentId: string, updatedAt: string): void {
  db.run("UPDATE documents SET updated_at = ? WHERE document_id = ?", [updatedAt, documentId]);
}

/** 재시도 대기를 지난 것으로 만든다(시계를 흉내 내지 않고 원장 시각을 과거로). */
function expireRetryWaits(): void {
  db.run("UPDATE document_ocr_page_results SET next_retry_at = '2000-01-01 00:00:00' WHERE next_retry_at IS NOT NULL");
}

describe("정상 흐름", () => {
  test("3쪽 문서 — 쪽마다 한 번 부르고 이어 붙여 적용, 원장 비움, ocr_succeeded", async () => {
    const doc = await ingestPdf();
    replySequence([ocrOk("# 1쪽 CYCLE_A"), ocrOk("2쪽 CYCLE_B"), ocrOk("3쪽 CYCLE_C")]);
    const summary = await cycle();
    expect(summary).toMatchObject({ stoppedBy: "done", documentsApplied: 1, pagesSucceeded: 3, pageCalls: 3 });
    expect(standIn.requests.length).toBe(3);
    expect(parseStatus(doc)).toBe("ocr_succeeded");
    expect(readDocumentParseMetadata(store.getDocument(doc)!.sourceMetadata)?.providerName).toBe("server-api:openai_compatible");
    expect(ledger.rowsForDocument(doc)).toEqual([]);
    const nodeId = store.findDocumentNodeId(doc)!;
    expect((await store.getNode(nodeId))!.content).toBe("# 1쪽 CYCLE_A\n\n2쪽 CYCLE_B\n\n3쪽 CYCLE_C");
    expect(ledger.dailyCalls(new Date().toLocaleString("sv-SE", { timeZone: settings.time.zone }).slice(0, 10))).toBe(3);
  });
});

describe("영구 재과금 없음", () => {
  test("2쪽이 잘리면 결정적 실패 — 3번 뒤 terminal, 그 뒤 사이클은 호출 0, 성공한 1쪽은 다시 안 부름", async () => {
    const doc = await ingestPdf();
    replySequence([ocrOk("1쪽"), ocrTruncated()]);
    await cycle();
    expect(standIn.requests.length).toBe(2);
    expect(parseStatus(doc)).toBe("ocr_failed");
    expect(readDocumentParseMetadata(store.getDocument(doc)!.sourceMetadata)?.errorMessage).toContain("documents.ocr.maxOutputTokensPerPage=8192");

    for (let attempt = 2; attempt <= 3; attempt += 1) {
      expireRetryWaits();
      standIn.requests.length = 0;
      replySequence([ocrTruncated()]);
      await cycle();
      expect(standIn.requests.length).toBe(1); // 1쪽은 원장 글을 재사용 — 2쪽만 다시 부른다.
    }
    const page2 = ledger.rowsForDocument(doc).find((r) => r.pageIndex === 1)!;
    expect(page2.status).toBe("terminal_failure");
    expect(page2.attemptCount).toBe(3);
    expect(readDocumentParseMetadata(store.getDocument(doc)!.sourceMetadata)?.errorMessage).toContain("자동 재시도 멈춤");

    for (let i = 0; i < 3; i += 1) {
      expireRetryWaits();
      standIn.requests.length = 0;
      const summary = await cycle();
      expect(summary.pageCalls).toBe(0);
      expect(standIn.requests.length).toBe(0);
    }

    // 한도 값을 바꾸면 지문이 바뀌어 다시 처리한다(1쪽부터 — 지문이 다르므로).
    const higher = structuredClone(settings.documents.ocr);
    higher.maxOutputTokensPerPage = 16384;
    standIn.requests.length = 0;
    replySequence([ocrOk("1쪽"), ocrOk("2쪽 전부"), ocrOk("3쪽")]);
    const summary = await cycle(higher);
    expect(summary.documentsApplied).toBe(1);
    expect(standIn.requests.length).toBe(3);
  });

  test("일시 실패(503) — 재시도 대기 전 호출 0, 지난 뒤 이어서 처리(성공한 쪽은 재호출 0)", async () => {
    const doc = await ingestPdf();
    replySequence([ocrOk("1쪽"), { status: 503, body: "busy" }]);
    await cycle();
    expect(standIn.requests.length).toBe(2);
    const page2 = ledger.rowsForDocument(doc).find((r) => r.pageIndex === 1)!;
    expect(page2.status).toBe("retryable_failure");
    expect(page2.attemptCount).toBe(0);
    expect(readDocumentParseMetadata(store.getDocument(doc)!.sourceMetadata)?.errorMessage).toContain("2쪽 일시 실패");

    standIn.requests.length = 0;
    expect((await cycle()).pageCalls).toBe(0);
    expect(standIn.requests.length).toBe(0);

    expireRetryWaits();
    replySequence([ocrOk("2쪽"), ocrOk("3쪽")]);
    const summary = await cycle();
    expect(summary.documentsApplied).toBe(1);
    expect(standIn.requests.length).toBe(2);
  });

  test("차단기 — 연속 일시 실패가 기준에 닿으면 사이클을 멈춘다", async () => {
    const docs = [await ingestPdf(), await ingestPdf("scanned-2page.pdf")];
    expect(docs.length).toBe(2);
    const ocr = structuredClone(settings.documents.ocr);
    ocr.reliability.circuitBreakerThreshold = 1;
    replySequence([{ status: 503, body: "busy" }]);
    const summary = await cycle(ocr);
    expect(summary.stoppedBy).toBe("circuit_breaker");
    expect(standIn.requests.length).toBe(1);
  });

  test("하루 한도 — 실패한 호출도 세고, 닿으면 호출 0", async () => {
    await ingestPdf();
    const ocr = structuredClone(settings.documents.ocr);
    ocr.schedule.maxPagesPerDay = 2;
    replySequence([ocrOk("1쪽"), { status: 422, body: "no" }]);
    await cycle(ocr);
    expect(standIn.requests.length).toBe(2);
    expireRetryWaits();
    standIn.requests.length = 0;
    const summary = await cycle(ocr);
    expect(summary.stoppedBy).toBe("daily_cap");
    expect(standIn.requests.length).toBe(0);
  });
});

describe("한도·동시 실행·대상", () => {
  test("쪽 한도 — 진행분을 남기고 임대를 풀며, 다음 사이클이 이어 받는다", async () => {
    const doc = await ingestPdf();
    const ocr = structuredClone(settings.documents.ocr);
    ocr.schedule.maxPagesPerCycle = 2;
    replySequence([ocrOk("1쪽"), ocrOk("2쪽"), ocrOk("3쪽")]);
    const first = await cycle(ocr);
    expect(first.stoppedBy).toBe("page_cap");
    expect(first.pageCalls).toBe(2);
    expect(ledger.rowsForDocument(doc).map((r) => r.status)).toEqual(["completed", "completed"]);
    expect(readDocumentParseMetadata(store.getDocument(doc)!.sourceMetadata)?.lease).toBeUndefined();
    const second = await cycle(ocr);
    expect(second.pageCalls).toBe(1);
    expect(second.documentsApplied).toBe(1);
    expect(standIn.requests.length).toBe(3);
  });

  test("보조 프로그램이 임대 중인 문서는 건너뛴다", async () => {
    const doc = await ingestPdf();
    const current = store.getDocument(doc)!;
    const parse = readDocumentParseMetadata(current.sourceMetadata)!;
    store.updateDocumentSourceMetadata({
      documentId: doc,
      sourceMetadata: { ...current.sourceMetadata, parse: { ...parse, lease: { workerId: "pc-ocr", claimedAt: "2026-01-01 00:00:00", leaseUntil: "2999-01-01 00:00:00" } } },
    });
    const summary = await cycle();
    expect(summary.stoppedBy).toBe("no_candidates");
    expect(standIn.requests.length).toBe(0);
  });

  test("처리 중 메타가 바뀌면(임대 연장 실패) 적용하지 않는다", async () => {
    const doc = await ingestPdf();
    let n = 0;
    standIn.reply = () => {
      n += 1;
      if (n === 1) {
        // 첫 쪽을 읽는 동안 다른 작업이 문서 메타를 바꾼다.
        const current = store.getDocument(doc)!;
        store.updateDocumentSourceMetadata({ documentId: doc, sourceMetadata: { ...current.sourceMetadata, touchedBy: "other" } });
      }
      return ocrOk(`${n}쪽`);
    };
    const summary = await cycle();
    expect(summary.documentsApplied).toBe(0);
    expect(standIn.requests.length).toBe(1);
    expect(parseStatus(doc)).toBe("needs_ocr");
  });

  test("docx 등 대상 아닌 문서는 원장 기록 없이 후보에서만 빠진다", async () => {
    const doc = await ingestPdf();
    const sha = readDocumentParseMetadata(store.getDocument(doc)!.sourceMetadata)!.originalAssetSha256;
    db.run("UPDATE asset_files SET mime_type = ? WHERE sha256 = ?", [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sha,
    ]);
    const summary = await cycle();
    expect(summary.stoppedBy).toBe("no_candidates");
    expect(ledger.rowsForDocument(doc)).toEqual([]);
    expect(standIn.requests.length).toBe(0);
  });

  test("설정 오류(401) — 문서 상태·원장을 건드리지 않고 사이클 중단", async () => {
    const doc = await ingestPdf();
    replySequence([{ status: 401, body: { error: { message: "bad key" } } }]);
    const summary = await cycle();
    expect(summary.stoppedBy).toBe("config_error");
    expect(summary.configError).toContain("401");
    expect(parseStatus(doc)).toBe("needs_ocr");
    expect(readDocumentParseMetadata(store.getDocument(doc)!.sourceMetadata)?.lease).toBeUndefined();
    expect(ledger.rowsForDocument(doc)).toEqual([]);
  });

  test("빈 칸 설정은 호출 없이 config_error(칸 이름)", async () => {
    await ingestPdf();
    const ocr = structuredClone(settings.documents.ocr);
    ocr.api.openaiModel = "";
    const summary = await cycle(ocr);
    expect(summary).toMatchObject({ stoppedBy: "config_error", pageCalls: 0 });
    expect(summary.configError).toContain("documents.ocr.api.openaiModel");
  });

  test("임대 시간이 한 쪽 한도보다 짧으면 config_error", async () => {
    const ocr = structuredClone(settings.documents.ocr);
    ocr.schedule.leaseSeconds = 60;
    ocr.schedule.timeoutMs = 30_000;
    const summary = await cycle(ocr);
    expect(summary.configError).toContain("documents.ocr.schedule.leaseSeconds");
  });
});

describe("빈 쪽 (사용자 결정 H3, QA PROBE-2)", () => {
  test("정상 종료 + 빈 글인 쪽은 실패가 아니라 빈 쪽 — 나머지 쪽으로 적용하고 빈 쪽 수를 남긴다", async () => {
    const doc = await ingestPdf("scanned-3page.pdf");
    replySequence([ocrOk("# 1쪽"), ocrOk(""), ocrOk("3쪽")]);
    const summary = await cycle();
    expect(summary).toMatchObject({ stoppedBy: "done", documentsApplied: 1, pagesSucceeded: 3, pagesBlank: 1, pageCalls: 3 });
    const parse = readDocumentParseMetadata(store.getDocument(doc)!.sourceMetadata)!;
    expect(parse.status).toBe("ocr_succeeded");
    expect(parse.blankPageCount).toBe(1);
    expect(parse.warnings.join(" ")).toContain("빈 쪽 1개");
    const nodeId = store.findDocumentNodeId(doc)!;
    expect((await store.getNode(nodeId))!.content).toBe("# 1쪽\n\n3쪽");
  });

  test("이미 빈 쪽으로 읽은 쪽은 다음 사이클에 다시 부르지 않는다", async () => {
    const doc = await ingestPdf("scanned-3page.pdf");
    const ocr = structuredClone(settings.documents.ocr);
    ocr.schedule.maxPagesPerCycle = 2;
    replySequence([ocrOk(""), ocrOk("2쪽")]);
    expect((await cycle(ocr)).stoppedBy).toBe("page_cap");
    expect(new DocumentOcrLedger(db).rowsForDocument(doc)[0]!.status).toBe("completed_blank");
    standIn.requests.length = 0;
    replySequence([ocrOk("3쪽")]);
    const second = await cycle(ocr);
    expect(second.documentsApplied).toBe(1);
    expect(standIn.requests.length).toBe(1);
    expect(readDocumentParseMetadata(store.getDocument(doc)!.sourceMetadata)!.blankPageCount).toBe(1);
  });

  test("모든 쪽이 빈 쪽이면 한국어 사유로 실패하고, 다시 읽기 전까지 다시 부르지 않는다", async () => {
    const doc = await ingestPdf("scanned-2page.pdf");
    replySequence([ocrOk("")]);
    await cycle();
    expect(standIn.requests.length).toBe(2);
    expect(parseStatus(doc)).toBe("ocr_failed");
    expect(readDocumentParseMetadata(store.getDocument(doc)!.sourceMetadata)!.errorMessage).toContain("모든 쪽(2쪽)이 빈 쪽");
    standIn.requests.length = 0;
    expireRetryWaits();
    expect((await cycle()).pageCalls).toBe(0);
    expect(standIn.requests.length).toBe(0);
  });

  test("잘림(max_tokens)은 글이 없어도 여전히 실패(Q1)", async () => {
    const doc = await ingestPdf("scanned-2page.pdf");
    replySequence([{ body: { choices: [{ message: { content: "" }, finish_reason: "length" }] } }]);
    await cycle();
    expect(parseStatus(doc)).toBe("ocr_failed");
    expect(new DocumentOcrLedger(db).rowsForDocument(doc)[0]!.status).toBe("retryable_failure");
  });
});

describe("공급자 400 (사용자 결정 M1)", () => {
  test("400 은 그 쪽의 결정적 실패 — 시도 상한에서 그 문서만 멈추고 사이클은 다음 문서로", async () => {
    const bad = await ingestPdf("scanned-2page.pdf", "\n%bad\n");
    const good = await ingestPdf("scanned-2page.pdf", "\n%good\n");
    // 대역 응답은 요청 순서대로 나가므로(첫 요청이 400) bad 를 먼저 처리하게 순서를 못박는다.
    setUpdatedAt(bad, "2000-01-01 00:00:00");
    setUpdatedAt(good, "2000-01-01 00:00:01");
    const ocr = structuredClone(settings.documents.ocr);
    ocr.reliability.maxAttemptsPerPage = 1;
    ocr.reliability.circuitBreakerThreshold = 3;
    replySequence([{ status: 400, body: { error: { message: "image rejected" } } }, ocrOk("1쪽"), ocrOk("2쪽")]);
    const summary = await cycle(ocr);
    expect(summary.stoppedBy).toBe("done");
    expect(summary.documentsFailed).toBe(1);
    expect(summary.documentsApplied).toBe(1);
    expect(new DocumentOcrLedger(db).rowsForDocument(bad)[0]!.status).toBe("terminal_failure");
    expect(parseStatus(good)).toBe("ocr_succeeded");
  });

  test("모든 문서가 400 이면(설정 탓) 연속 실패 차단기가 사이클을 멈춘다", async () => {
    for (let i = 0; i < 4; i += 1) {
      await ingestPdf("scanned-2page.pdf", `\n%all400-${i}\n`);
      await Bun.sleep(5);
    }
    const ocr = structuredClone(settings.documents.ocr);
    ocr.reliability.circuitBreakerThreshold = 2;
    replySequence([{ status: 400, body: { error: { message: "bad request" } } }]);
    const summary = await cycle(ocr);
    expect(summary.stoppedBy).toBe("circuit_breaker");
    expect(standIn.requests.length).toBe(2);
  });

  test("404(모델 없음)는 설정 — 사이클을 멈추고 문서 상태를 건드리지 않는다", async () => {
    const doc = await ingestPdf();
    replySequence([{ status: 404, body: { error: { message: "model not found" } } }]);
    const summary = await cycle();
    expect(summary.stoppedBy).toBe("config_error");
    expect(parseStatus(doc)).toBe("needs_ocr");
  });
});

describe("Gemini 잘못된 키(400 + API_KEY_INVALID) — 설정 문제 (QA P4)", () => {
  const GEMINI_KEY = "AIza-test-OCR-BADKEY-0099";
  function geminiSettings(): DocumentOcrSettings {
    const ocr = structuredClone(settings.documents.ocr);
    ocr.api.provider = "google";
    ocr.api.geminiApiKey = GEMINI_KEY;
    ocr.api.geminiModel = "gemini-2.5-flash";
    ocr.schedule.batchSize = 1;
    return ocr;
  }
  function geminiCycle(ocr: DocumentOcrSettings) {
    return runDocumentOcrCycle({
      api: deps, ledger, settings: ocr, pageImages: createDocumentPageImageSource(),
      createReader: (s) => createDocumentOcrReader(s, { geminiBaseUrl: `${standIn.origin}/v1beta` }),
    });
  }
  // 공식 오류 모델(AIP-193) 모양 — 공급자가 본문에 키를 되돌려 주는 경우도 함께 본다.
  const badKeyBody = {
    error: {
      code: 400,
      message: `API key not valid. Please pass a valid API key. (${GEMINI_KEY})`,
      status: "INVALID_ARGUMENT",
      details: [
        { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com", metadata: { service: "generativelanguage.googleapis.com" } },
      ],
    },
  };

  test("사이클은 config_error 로 멈추고, 원장에 시도를 남기지 않으며, 사유는 키 칸 이름을 대고 키 값은 없다", async () => {
    const doc = await ingestPdf();
    replySequence([{ status: 400, body: badKeyBody }]);
    const summary = await geminiCycle(geminiSettings());
    expect(summary.stoppedBy).toBe("config_error");
    expect(summary.configError).toContain("documents.ocr.api.geminiApiKey");
    expect(summary.configError).not.toContain(GEMINI_KEY);
    expect(ledger.rowsForDocument(doc)).toEqual([]);
    expect(parseStatus(doc)).toBe("needs_ocr");
  });

  test("PERMISSION_DENIED 도 설정 문제", async () => {
    await ingestPdf();
    replySequence([{ status: 403, body: { error: { code: 403, message: "denied", status: "PERMISSION_DENIED" } } }]);
    expect((await geminiCycle(geminiSettings())).stoppedBy).toBe("config_error");
  });

  test("사유 없는 400 INVALID_ARGUMENT 는 여전히 그 쪽의 실패", async () => {
    const doc = await ingestPdf();
    replySequence([{ status: 400, body: { error: { code: 400, message: "Unable to process input image", status: "INVALID_ARGUMENT" } } }]);
    const summary = await geminiCycle(geminiSettings());
    expect(summary.stoppedBy).not.toBe("config_error");
    expect(ledger.rowsForDocument(doc)[0]!.attemptCount).toBe(1);
  });
});

describe("후보 창 굶주림 없음 (QA PROBE-3)", () => {
  test("오래된 대상 아님 문서가 조회 창을 다 채워도 새 PDF 를 처리한다", async () => {
    const ocr = structuredClone(settings.documents.ocr);
    ocr.schedule.batchSize = 1; // 조회 창 = 1 × 20
    const ids: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      const id = await ingestPdf("scanned-2page.pdf", `\n%starve-${i}\n`);
      // 새 PDF(마지막)가 첫 조회 창(20개) 밖 21번째에 오도록 오래된 순서를 못박는다.
      setUpdatedAt(id, `2000-01-01 00:00:${String(i).padStart(2, "0")}`);
      ids.push(id);
    }
    for (const id of ids.slice(0, 20)) {
      const sha = readDocumentParseMetadata(store.getDocument(id)!.sourceMetadata)!.originalAssetSha256;
      db.run("UPDATE asset_files SET mime_type = ? WHERE sha256 = ?", [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sha,
      ]);
    }
    replySequence([ocrOk("1쪽"), ocrOk("2쪽")]);
    const summary = await cycle(ocr);
    expect(summary.stoppedBy).toBe("done");
    expect(summary.documentsApplied).toBe(1);
    expect(parseStatus(ids[20]!)).toBe("ocr_succeeded");
    expect(standIn.requests.length).toBe(2);
  });
});
