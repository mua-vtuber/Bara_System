/**
 * 서버 OCR 실행기 관리자·라우트 배선 — 실제 DB·bge-m3·자산 저장소·PDF·대역 공급자 서버 (2026-10-11 document-ocr spec T8).
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
import { getMemorySettings, type MemorySettings } from "../../settings/memory-settings.ts";
import { buildMemoryApi } from "../../server.ts";
import type { MemoryApiDeps } from "../types.ts";
import type { DocumentOcrServerStatus } from "../../api-client-types.ts";
import { startProviderStandIn, type ProviderStandIn } from "../../test-utils/provider-stand-in.ts";
import { withDocumentOcrRuntime } from "../../test-utils/document-ocr-runtime.ts";
import { DocumentOcrLedger } from "./ledger.ts";
import { documentOcrDay } from "./cycle.ts";
import type { DocumentOcrRuntime } from "./runtime-types.ts";

let embedder: Bgem3Embedder;
let standIn: ProviderStandIn;
let dir: string;
let db: Database;
let store: SqliteMemoryStore;
let settings: MemorySettings;
let deps: MemoryApiDeps;
let runtime: DocumentOcrRuntime;
let app: Hono;
let timers: Array<() => void> = [];

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
  standIn = startProviderStandIn();
});
afterAll(() => standIn.stop());

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bara-ocr-runtime-"));
  timers = [];
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  settings = getMemorySettings("/nonexistent-ocr-runtime-test", "/nonexistent-ocr-runtime-test.secrets.json");
  const ocr = settings.documents.ocr;
  ocr.api.openaiBaseUrl = `${standIn.origin}/v1`;
  ocr.api.openaiModel = "vlm-test";
  ocr.schedule.timeoutMs = 5000;
  ocr.schedule.leaseSeconds = 120;
  ocr.pageImage.maxEdgePx = 512;
  // 설정 객체를 통째로 바꿔 끼우는 저장 흐름을 흉내 낸다 — getSettings 는 늘 지금 값을 읽는다.
  deps = withDocumentOcrRuntime(
    {
      store,
      retriever: new HybridRetriever(store, embedder),
      assembler: new ContextAssembler(),
      assetStore: new AssetStore(dir),
      getSettings: () => settings,
    },
    // 정기 타이머는 시험 중 저절로 돌지 않게 아주 먼 미래로만 예약한다.
    // 정기 타이머는 저절로 돌지 않게 붙잡아 두고, 시험이 필요할 때 직접 터뜨린다.
    { setTimeoutFn: (fn: () => void) => { timers.push(fn); return {}; }, clearTimeoutFn: () => {} },
  );
  runtime = deps.documentOcrRuntime!;
  deps.backgroundWritersRunning = () => runtime.isRunning();
  app = buildMemoryApi(deps);
  standIn.requests.length = 0;
  standIn.reply = () => ({ body: { choices: [{ message: { content: "글" }, finish_reason: "stop" }] } });
});
afterEach(async () => {
  await runtime.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function useApiMode(patch: (s: MemorySettings) => void = () => {}): void {
  const next = structuredClone(settings);
  next.documents.ocr.mode = "api";
  next.documents.ocr.api.provider = "openai_compatible";
  patch(next);
  settings = next;
}

async function ingestPdf(file = "scanned-2page.pdf", originalName = file): Promise<string> {
  const bytes = readFileSync(join(import.meta.dir, "__fixtures__", file));
  const res = await app.request("/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "dashboard:manual",
      content: { type: "auto", data: Buffer.from(bytes).toString("base64"), mimeType: "application/pdf", originalName },
      attribution: { author: "테스터", userId: "u-ocr-runtime" },
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { documentId: string }).documentId;
}

async function status(): Promise<DocumentOcrServerStatus> {
  const res = await app.request("/api/documents/ocr-jobs/server-status");
  expect(res.status).toBe(200);
  return ((await res.json()) as { status: DocumentOcrServerStatus }).status;
}

describe("재구성 — 저장 즉시 반영", () => {
  test("api 로 켜면 idle·다음 처리 시각, manual 로 저장하면 off", async () => {
    useApiMode();
    await runtime.reconfigure();
    const on = await status();
    expect(on.state).toBe("idle");
    expect(on.nextRunAt).not.toBeNull();
    settings = structuredClone(settings);
    settings.documents.ocr.mode = "manual";
    await runtime.reconfigure();
    const off = await status();
    expect(off.state).toBe("off");
    expect(off.reason).toContain("documents.ocr.mode=manual");
    expect(off.nextRunAt).toBeNull();
  });

  test("간격을 바꾸면 새 간격으로 다시 만든다", async () => {
    useApiMode((s) => { s.documents.ocr.schedule.intervalMin = 30; });
    await runtime.reconfigure();
    useApiMode((s) => { s.documents.ocr.schedule.intervalMin = 120; });
    await runtime.reconfigure();
    expect((await status()).intervalMin).toBe(120);
  });

  test("빈 칸이면 config_error 와 칸 이름(키 값 없음)", async () => {
    useApiMode((s) => { s.documents.ocr.api.openaiModel = ""; });
    await runtime.reconfigure();
    const st = await status();
    expect(st.state).toBe("config_error");
    expect(st.reason).toContain("documents.ocr.api.openaiModel");
  });

  test("처리 중에는 수동 실행 409·데이터 초기화 409·상태 running, OCR 설정을 바꾸면 호출을 끊고 기다린 뒤 바꾼다", async () => {
    const doc = await ingestPdf();
    useApiMode();
    await runtime.reconfigure();
    standIn.reply = () => ({ delayMs: 2000, body: { choices: [{ message: { content: "글" }, finish_reason: "stop" }] } });
    const running = app.request("/api/documents/ocr-jobs/run-server-once", { method: "POST" });
    await Bun.sleep(150);
    expect(runtime.isRunning()).toBe(true);
    expect((await status()).state).toBe("running");
    const reset = await app.request("/admin/reset-memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "RESET ALL MEMORY" }),
    });
    expect(reset.status).toBe(409);
    const busy = await app.request("/api/documents/ocr-jobs/run-server-once", { method: "POST" });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toBe("서버 OCR 사이클이 이미 진행 중");

    settings = structuredClone(settings);
    settings.documents.ocr.mode = "manual";
    const startedAt = Date.now();
    await runtime.reconfigure();
    expect(Date.now() - startedAt).toBeLessThan(1500); // 2초 걸리는 호출을 끊었다.
    expect(runtime.isRunning()).toBe(false);
    const body = (await (await running).json()) as { summary: { stoppedBy: string } };
    expect(body.summary.stoppedBy).toBe("aborted");
    // 끊긴 쪽은 시도로 세지 않고, 문서 상태도 그대로이며 임대가 풀린다.
    expect(new DocumentOcrLedger(db).rowsForDocument(doc)).toEqual([]);
    const parse = readDocumentParseMetadata(store.getDocument(doc)!.sourceMetadata)!;
    expect(parse.status).toBe("needs_ocr");
    expect(parse.lease).toBeUndefined();
  });

  test("정기 사이클 도중 재구성해도 끝날 때까지 running 이고 두 사이클이 겹치지 않는다(QA PROBE-1)", async () => {
    const doc = await ingestPdf("scanned-3page.pdf");
    useApiMode();
    await runtime.reconfigure();
    expect(timers.length).toBe(1);
    standIn.reply = () => ({ delayMs: 300, body: { choices: [{ message: { content: "글" }, finish_reason: "stop" }] } });
    timers.shift()!(); // 정기 사이클이 시작된다.
    await Bun.sleep(100);
    expect(runtime.isRunning()).toBe(true);
    // OCR 이 아닌 설정만 저장 — 재구성은 아무것도 끊지 않는다.
    settings = structuredClone(settings);
    settings.chunking.tokenCap = settings.chunking.tokenCap + 1;
    await runtime.reconfigure();
    expect(runtime.isRunning()).toBe(true);
    const manual = await app.request("/api/documents/ocr-jobs/run-server-once", { method: "POST" });
    expect(manual.status).toBe(409);
    expect((await status()).state).toBe("running");
    // 새 스케줄러의 정기 tick 이 와도 새 사이클을 겹쳐 돌리지 않는다.
    while (runtime.isRunning()) await Bun.sleep(50);
    expect(standIn.requests.length).toBe(3); // 3쪽 = 정확히 3번
    expect(readDocumentParseMetadata(store.getDocument(doc)!.sourceMetadata)!.status).toBe("ocr_succeeded");
  });

  test("stop 은 진행 중 호출을 끊어 오래 기다리지 않는다", async () => {
    await ingestPdf();
    useApiMode((s) => { s.documents.ocr.schedule.timeoutMs = 60_000; });
    await runtime.reconfigure();
    standIn.reply = () => ({ hang: true });
    const running = runtime.tryRunOnce();
    await Bun.sleep(150);
    const startedAt = Date.now();
    await runtime.stop();
    expect(Date.now() - startedAt).toBeLessThan(2000);
    const result = await running;
    expect(result.kind === "ran" && result.summary.stoppedBy).toBe("aborted");
  });

  test("예상하지 못한 오류는 로그만이 아니라 마지막 사이클·상태에 남는다", async () => {
    useApiMode();
    // 쪽 그림 모듈을 준비하다 예상 밖으로 던지는 경우(시험 전용 주입 — 운영 배선은 넘기지 않음).
    const failing = withDocumentOcrRuntime(
      { store: deps.store, retriever: deps.retriever, assembler: deps.assembler, assetStore: deps.assetStore, getSettings: deps.getSettings },
      { pageImages: () => { throw new Error("쪽 그림 준비 실패(시험)"); }, setTimeoutFn: () => ({}), clearTimeoutFn: () => {} },
    ).documentOcrRuntime;
    try {
      const result = await failing.tryRunOnce();
      expect(result.kind === "ran" && result.summary.stoppedBy).toBe("error");
      expect(result.kind === "ran" && result.summary.error).toBe("쪽 그림 준비 실패(시험)");
      const st = failing.status();
      expect(st.lastCycle?.stoppedBy).toBe("error");
      expect(st.state).toBe("off"); // 아직 재구성 전이라 꺼짐이 우선 — 재구성하면 error 로 보인다.
      await failing.reconfigure();
      expect(failing.status().state).toBe("error");
      expect(failing.status().reason).toBe("쪽 그림 준비 실패(시험)");
    } finally {
      await failing.stop();
    }
  });
});

describe("수동 1회 실행·상태", () => {
  test("하루 한도에 닿았으면 409", async () => {
    useApiMode((s) => { s.documents.ocr.schedule.maxPagesPerDay = 1; });
    await runtime.reconfigure();
    new DocumentOcrLedger(db).incrementDailyCalls(documentOcrDay());
    const res = await app.request("/api/documents/ocr-jobs/run-server-once", { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("오늘 서버 OCR 한도(documents.ocr.schedule.maxPagesPerDay=1) 도달");
    expect((await status()).state).toBe("daily_cap_reached");
  });

  test("documentId 로 다시 읽으면 terminal 원장을 지우고 그 문서를 처리한다", async () => {
    const doc = await ingestPdf();
    useApiMode((s) => { s.documents.ocr.reliability.maxAttemptsPerPage = 1; });
    standIn.reply = () => ({ body: { choices: [{ message: { content: "잘림" }, finish_reason: "length" }] } });
    await app.request("/api/documents/ocr-jobs/run-server-once", { method: "POST" });
    const ledger = new DocumentOcrLedger(db);
    expect(ledger.rowsForDocument(doc).some((r) => r.status === "terminal_failure")).toBe(true);
    expect((await status()).queue.terminal).toBe(1);

    standIn.requests.length = 0;
    const blocked = await app.request("/api/documents/ocr-jobs/run-server-once", { method: "POST" });
    expect(((await blocked.json()) as { summary: { pageCalls: number } }).summary.pageCalls).toBe(0);

    standIn.reply = () => ({ body: { choices: [{ message: { content: "다시 읽음" }, finish_reason: "stop" }] } });
    const res = await app.request(`/api/documents/ocr-jobs/run-server-once?documentId=${doc}`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; parse: { status: string } };
    expect(body.ok).toBe(true);
    expect(body.parse.status).toBe("ocr_succeeded");
    expect(standIn.requests.length).toBe(2);
  });

  test("다시 읽기는 성공한 쪽을 다시 부르지 않고 실패한 쪽만 다시 읽는다(재과금 없음)", async () => {
    const doc = await ingestPdf("scanned-3page.pdf");
    useApiMode((s) => { s.documents.ocr.reliability.maxAttemptsPerPage = 1; });
    let n = 0;
    standIn.reply = () => {
      n += 1;
      return { body: { choices: [{ message: { content: n === 2 ? "잘림" : `${n}쪽` }, finish_reason: n === 2 ? "length" : "stop" }] } };
    };
    await app.request("/api/documents/ocr-jobs/run-server-once", { method: "POST" });
    expect(standIn.requests.length).toBe(2); // 1쪽 성공, 2쪽 잘림(terminal)
    standIn.requests.length = 0;
    standIn.reply = () => ({ body: { choices: [{ message: { content: "다시" }, finish_reason: "stop" }] } });
    const res = await app.request(`/api/documents/ocr-jobs/run-server-once?documentId=${doc}`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(standIn.requests.length).toBe(2); // 2쪽·3쪽만 — 1쪽은 원장 글 재사용
    expect(readDocumentParseMetadata(store.getDocument(doc)!.sourceMetadata)!.status).toBe("ocr_succeeded");
  });

  test("다시 읽기 — 서버가 읽을 수 없는 문서·다른 작업자 임대 문서는 원장을 지우기 전에 사유와 함께 409", async () => {
    const doc = await ingestPdf();
    useApiMode((s) => { s.documents.ocr.reliability.maxAttemptsPerPage = 1; });
    standIn.reply = () => ({ body: { choices: [{ message: { content: "잘림" }, finish_reason: "length" }] } });
    await app.request("/api/documents/ocr-jobs/run-server-once", { method: "POST" });
    const ledger = new DocumentOcrLedger(db);
    const before = ledger.rowsForDocument(doc).length;
    expect(before).toBeGreaterThan(0);

    const current = store.getDocument(doc)!;
    const parse = readDocumentParseMetadata(current.sourceMetadata)!;
    store.updateDocumentSourceMetadata({
      documentId: doc,
      sourceMetadata: { ...current.sourceMetadata, parse: { ...parse, lease: { workerId: "pc-ocr", claimedAt: "2026-01-01 00:00:00", leaseUntil: "2999-01-01 00:00:00" } } },
    });
    const leased = await app.request(`/api/documents/ocr-jobs/run-server-once?documentId=${doc}`, { method: "POST" });
    expect(leased.status).toBe(409);
    expect(((await leased.json()) as { error: string }).error).toContain("pc-ocr");
    expect(ledger.rowsForDocument(doc).length).toBe(before);

    db.run("UPDATE asset_files SET mime_type = ? WHERE sha256 = ?", [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document", parse.originalAssetSha256,
    ]);
    const docx = await app.request(`/api/documents/ocr-jobs/run-server-once?documentId=${doc}`, { method: "POST" });
    expect(docx.status).toBe(409);
    expect(((await docx.json()) as { error: string }).error).toContain("docx");
    expect(ledger.rowsForDocument(doc).length).toBe(before);
  });

  test("다시 읽기가 한도 때문에 아무 쪽도 못 읽으면 409 와 칸 이름 사유(부분 성공처럼 보이지 않음)", async () => {
    const doc = await ingestPdf();
    useApiMode((s) => { s.documents.ocr.reliability.maxAttemptsPerPage = 1; });
    standIn.reply = () => ({ status: 503, body: "busy" });
    await app.request("/api/documents/ocr-jobs/run-server-once", { method: "POST" }); // 1쪽 일시 실패 → 다시 시도 대기
    useApiMode((s) => { s.documents.ocr.schedule.maxPagesPerCycle = 1; s.documents.ocr.schedule.maxPagesPerDay = 1; });
    const res = await app.request(`/api/documents/ocr-jobs/run-server-once?documentId=${doc}`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; summary?: unknown };
    expect(body.error).toContain("documents.ocr.schedule.maxPagesPerDay");
    expect(body.summary).toBeUndefined();
  });

  test("같은 파일의 두 번째 기록 — 다시 읽기는 주인 문서를 알리는 409, 상태 화면은 따로 센다(휴지통으로 보지 않음)", async () => {
    const first = await ingestPdf("scanned-2page.pdf", "same.pdf");
    const second = await ingestPdf("scanned-2page.pdf", "same.pdf");
    expect(store.getDocumentRecordPlacement(second).kind).toBe("absorbed");
    useApiMode();
    const res = await app.request(`/api/documents/ocr-jobs/run-server-once?documentId=${second}`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(`글자 인식은 그 문서(${first})에 하세요`);
    expect(standIn.requests.length).toBe(0);
    const st = await status();
    expect(st.queue.absorbedSharingResult).toBe(1);
  });

  test("상태 화면 — 서버 OCR 대상이 아닌 문서를 사유별로 센다", async () => {
    const doc = await ingestPdf();
    const sha = readDocumentParseMetadata(store.getDocument(doc)!.sourceMetadata)!.originalAssetSha256;
    db.run("UPDATE asset_files SET mime_type = ? WHERE sha256 = ?", [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sha,
    ]);
    const st = await status();
    expect(st.queue.notServerProcessable).toEqual([{ reason: "docx 는 서버 OCR 대상이 아님 — 내 PC 보조 프로그램을 쓰세요", count: 1 }]);
  });

  test("ocr-runtime-config 는 저장 즉시 새 값을 보이고 고른 업체 칸만 싣는다(키 값 없음)", async () => {
    useApiMode((s) => { s.documents.ocr.api.openaiApiKey = "sk-test-RUNTIME-CFG"; });
    const res = await app.request("/api/documents/ocr-runtime-config");
    const config = ((await res.json()) as { config: { mode: string; maxOutputTokensPerPage: number; api: Record<string, unknown> } }).config;
    expect(config.mode).toBe("api");
    expect(config.maxOutputTokensPerPage).toBe(8192);
    expect(config.api).toEqual({
      provider: "openai_compatible",
      endpointUrl: `${standIn.origin}/v1`,
      model: "vlm-test",
      responseFormat: "markdown",
      hasApiKey: true,
    });
    expect(JSON.stringify(config)).not.toContain("sk-test-RUNTIME-CFG");
  });

  test("보조 프로그램이 서버 예약 ID 로 임대하면 400", async () => {
    const res = await app.request("/api/documents/ocr-jobs/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "bara-server-ocr" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("bara-server-ocr");
  });
});

describe("실행기 관리자 미주입", () => {
  test("세 라우트가 503 과 이름 있는 사유", async () => {
    const bare = buildMemoryApi({
      store,
      retriever: new HybridRetriever(store, embedder),
      assembler: new ContextAssembler(),
      assetStore: new AssetStore(dir),
      getSettings: () => settings,
    });
    for (const [method, path] of [
      ["GET", "/api/documents/ocr-runtime-config"],
      ["GET", "/api/documents/ocr-jobs/server-status"],
      ["POST", "/api/documents/ocr-jobs/run-server-once"],
    ] as const) {
      const res = await bare.request(path, { method });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe("documentOcrRuntime 미주입 — documents.ocr 설정을 읽을 수 없음");
    }
  });
});
