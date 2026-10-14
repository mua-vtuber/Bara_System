/**
 * 설정 › 자동 처리 — 추출·캡션 실패 기록 패널 (2026-10-14 backfill-retry-ledger spec 6장).
 *
 * 대시보드 코드가 보내는 요청은 실제 HTTP 로 로컬 서버에 간다: /api/* 는 진짜 메모리 API 라우트(registerBackfillAttemptsRoutes
 * + 실제 SQLite + 실제 기록 표)다(mock 클래스 0). 대시보드의 상대 경로만 그 로컬 서버 주소로 잇는다.
 */
import "../../test-setup-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { _resetTokenCacheForTest } from "./api-fetch";
import { BACKFILL_ATTEMPTS_LABELS as L } from "./settings-backfill-attempts-labels";
import { describeBackfillAttempts, readBackfillAttemptsStatus, renderBackfillAttemptsPanel } from "./settings-backfill-attempts-panel";
import { readLlmGroup } from "./settings-llm-types";
import { renderSemanticExtractionSection } from "./settings-llm-section";
import { MEMORY_DEFAULTS } from "../../src/settings/memory-schema";
import { openMemoryDatabase } from "../../src/db/migrations";
import { SqliteMemoryStore } from "../../src/db/store";
import { Bgem3Embedder } from "../../src/embedding/bge-m3";
import { HybridRetriever } from "../../src/memory/retriever";
import { ContextAssembler } from "../../src/memory/context-assembler";
import { BackfillAttemptsLedger, type BackfillRetryPolicy } from "../../src/memory/backfill-attempts/ledger";
import type { BackfillAttemptsStatusResponse } from "../../src/memory/backfill-attempts/contract";
import { registerBackfillAttemptsRoutes } from "../../src/server-internal/routes/backfill-attempts";

const POLICY: BackfillRetryPolicy = { maxAttempts: 2, retryDelayMin: 30, retryMaxDelayMin: 1440 };
/** 기록 시각 판정용 고정 시계(벽시계 무관). */
const NOW_MS = Date.UTC(2026, 9, 14, 0, 0, 0);
const nativeFetch = globalThis.fetch;
let server: ReturnType<typeof Bun.serve>;
let memoryApp: Hono;
let db: Database;
let ledger: BackfillAttemptsLedger;

function memoryAppFor(target: Database): Hono {
  const embedder = new Bgem3Embedder();
  const store = new SqliteMemoryStore(target, embedder);
  const app = new Hono();
  registerBackfillAttemptsRoutes(app, { store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler() });
  return app;
}

beforeAll(() => {
  const root = new Hono();
  root.get("/dashboard/sse-token", (c) => c.json({ token: "dash-token" }));
  root.all("*", (c) => memoryApp.fetch(c.req.raw));
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: root.fetch });
  const origin = `http://127.0.0.1:${server.port}`;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return nativeFetch(url.startsWith("/") ? `${origin}${url}` : url, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = nativeFetch;
  void server.stop(true);
});

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  ledger = new BackfillAttemptsLedger(db);
  memoryApp = memoryAppFor(db);
  window.sessionStorage.setItem("bara.dashboard.token", "dash-token");
  _resetTokenCacheForTest();
  document.body.textContent = "";
});
afterEach(() => {
  db.close();
  window.sessionStorage.removeItem("bara.dashboard.token");
  _resetTokenCacheForTest();
  document.body.textContent = "";
});

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

function insertMemo(content: string): number {
  return Number(
    db.query("INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES (?, 'auto_capture', '2026-10-14 09:00:00')").run(content).lastInsertRowid,
  );
}

function fail(nodeId: number, times: number): void {
  for (let i = 0; i < times; i += 1) {
    ledger.recordCounted({ kind: "extraction", targetKey: String(nodeId), nodeId, fingerprint: "fp", error: "timeout", policy: POLICY }, NOW_MS);
  }
}

const TIMEOUT_TEXT = "Ollama /api/chat timeout (900000ms 초과)";
const SAMPLE: BackfillAttemptsStatusResponse = {
  kind: "extraction",
  waitingRetry: 1,
  stopped: 1,
  truncated: false,
  items: [
    { targetKey: "70", nodeId: 70, preview: "회의에서 예산을 정했다", attemptCount: 5, lastError: TIMEOUT_TEXT, lastAttemptAt: "2026-10-14 09:00:00", status: "terminal_failure", nextRetryAt: null },
    { targetKey: "71", nodeId: 71, preview: "다음 주 일정", attemptCount: 1, lastError: TIMEOUT_TEXT, lastAttemptAt: "2026-10-14 08:30:00", status: "retryable_failure", nextRetryAt: "2026-10-14 09:00:00" },
  ],
};

function mount(nodes: HTMLElement[]): HTMLElement {
  const root = document.createElement("div");
  root.append(...nodes);
  return root;
}

describe("상태 → 화면 줄(순수)", () => {
  test("요약 줄·기억별 줄·기억별 다시 시도, 멈춤이 있으면 모두 다시 시도", () => {
    const root = mount(describeBackfillAttempts(SAMPLE));
    expect(root.querySelector(".backfill-attempts-line")!.textContent).toBe(L.summary(1, 1));
    const items = Array.from(root.querySelectorAll(".backfill-attempts-item"));
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain(L.memoryNumber(70));
    expect(items[0]!.textContent).toContain(L.statusStopped);
    expect(items[0]!.textContent).toContain(L.attempts(5));
    expect(items[0]!.textContent).toContain("회의에서 예산을 정했다");
    expect(items[0]!.textContent).toContain(L.lastError(TIMEOUT_TEXT));
    expect(items[0]!.textContent).toContain(L.lastAttempt("2026-10-14 09:00:00"));
    expect(items[1]!.textContent).toContain(L.nextRetry("2026-10-14 09:00:00"));
    expect(root.querySelectorAll('button[data-action="retry-one"]')).toHaveLength(2);
    expect(root.querySelectorAll('button[data-action="retry-all"]')).toHaveLength(1);
  });

  test("멈춤이 없으면 모두 다시 시도 버튼이 없다", () => {
    const root = mount(describeBackfillAttempts({ ...SAMPLE, stopped: 0, items: [SAMPLE.items[1]!] }));
    expect(root.querySelector('button[data-action="retry-all"]')).toBeNull();
  });

  test("실패 중인 기억이 없으면(서버가 0건을 돌려줌) 빈 안내", () => {
    const root = mount(describeBackfillAttempts({ ...SAMPLE, waitingRetry: 0, stopped: 0, items: [] }));
    expect(root.textContent).toContain(L.empty);
  });

  test("목록이 잘렸으면 알린다", () => {
    const root = mount(describeBackfillAttempts({ ...SAMPLE, truncated: true }));
    expect(root.textContent).toContain(L.truncated(2));
  });
});

describe("응답 모양 확인 — 칸이 빠지면 칸 이름을 든 오류(0·빈 목록으로 읽지 않음)", () => {
  const cases: Array<[string, unknown, string]> = [
    ["객체가 아님", null, L.responseNotObject],
    ["kind 다름", { ...SAMPLE, kind: "caption" }, L.responseKindMismatch("extraction", "caption")],
    ["waitingRetry 없음", { ...SAMPLE, waitingRetry: undefined }, L.responseFieldInvalid("waitingRetry", "숫자")],
    ["truncated 없음", { ...SAMPLE, truncated: undefined }, L.responseFieldInvalid("truncated", "참거짓")],
    ["items 가 배열 아님", { ...SAMPLE, items: null }, L.responseFieldInvalid("items", "배열")],
    ["항목 칸 없음", { ...SAMPLE, items: [{ ...SAMPLE.items[0]!, lastError: undefined }] }, L.responseFieldInvalid("items[0].lastError", "문자열")],
    ["항목 nextRetryAt 형 어긋남", { ...SAMPLE, items: [{ ...SAMPLE.items[0]!, nextRetryAt: 3 }] }, L.responseFieldInvalid("items[0].nextRetryAt", "문자열 또는 null")],
  ];
  test.each(cases)("%s", (_name, raw, message) => {
    expect(() => readBackfillAttemptsStatus(raw, "extraction")).toThrow(message);
  });
});

describe("실제 API 와 함께", () => {
  test("불러오고, 기억별 다시 시도 뒤 다시 불러온다", async () => {
    const a = insertMemo("멈춘 기억");
    const b = insertMemo("기다리는 기억");
    fail(a, 2);
    fail(b, 1);
    const panel = renderBackfillAttemptsPanel("extraction");
    document.body.appendChild(panel.element);
    await panel.refresh();
    expect(panel.element.querySelectorAll(".backfill-attempts-item")).toHaveLength(2);
    (panel.element.querySelector(`button[data-action="retry-one"][data-target-key="${a}"]`) as HTMLButtonElement).click();
    await settle();
    expect(ledger.get("extraction", String(a))).toBeNull();
    expect(panel.element.querySelectorAll(".backfill-attempts-item")).toHaveLength(1);
  });

  test("모두 다시 시도는 그 종류의 줄을 모두 지운다", async () => {
    fail(insertMemo("가"), 2);
    fail(insertMemo("나"), 1);
    const panel = renderBackfillAttemptsPanel("extraction");
    await panel.refresh();
    (panel.element.querySelector('button[data-action="retry-all"]') as HTMLButtonElement).click();
    await settle();
    expect(ledger.rows("extraction")).toEqual([]);
    expect(panel.element.textContent).toContain(L.empty);
  });

  test("불러오기 실패는 빨간 줄(빈 목록으로 바꾸지 않음)", async () => {
    memoryApp = new Hono(); // 라우트 없음 → 404
    const panel = renderBackfillAttemptsPanel("extraction");
    await panel.refresh();
    expect(panel.element.querySelector(".backfill-attempts-line.error")!.textContent).toBe(L.loadFailed("HTTP 404"));
    expect(panel.element.querySelector(".backfill-attempts-item")).toBeNull();
    expect(panel.element.textContent).not.toContain(L.empty);
  });

  test("다시 시도 실패도 빨간 줄", async () => {
    fail(insertMemo("가"), 2);
    const panel = renderBackfillAttemptsPanel("extraction");
    await panel.refresh();
    memoryApp = new Hono(); // 다시 시도 경로가 없어진 서버 → 404
    (panel.element.querySelector('button[data-action="retry-all"]') as HTMLButtonElement).click();
    await settle();
    expect(panel.element.querySelector(".backfill-attempts-line.error")!.textContent).toBe(L.retryFailed("HTTP 404"));
  });
});

describe("설정 화면에 놓는 곳", () => {
  test("추출 블록에는 extraction, 이미지 캡션 블록에는 caption 패널이 붙는다", async () => {
    const group = readLlmGroup({ ...structuredClone(MEMORY_DEFAULTS), $secretsSet: [] } as Record<string, unknown>);
    const section = renderSemanticExtractionSection(group, group);
    expect(section.element.querySelector('[data-section="backfill-attempts-extraction"]')).not.toBeNull();
    expect(section.element.querySelector('[data-section="backfill-attempts-caption"]')).not.toBeNull();
    await settle();
    expect(section.element.querySelector('[data-section="backfill-attempts-extraction"]')!.textContent).toContain(L.empty);
  });
});
