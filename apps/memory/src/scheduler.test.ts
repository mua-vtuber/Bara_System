/**
 * 백필 스케줄러 구조 테스트.
 *
 * LLM 호출이 발생하지 않도록 DB에 `auto_capture` 후보를 0개로 유지한
 * 채 사이클을 돌린다 — 후보 없으면 extractor가 호출되지 않으므로 실제
 * Ollama 가동 없이 검증 가능.
 *
 * 실제 LLM 끼는 통합 시나리오는 별도 *.int.test.ts에서 다룬다 (TBD).
 */

import { TEST_CAPTION_BACKFILL_RETRY, TEST_EXTRACTION_BACKFILL_RETRY } from "./test-utils/backfill-retry.ts";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "./db/migrations.ts";
import { SqliteMemoryStore } from "./db/store.ts";
import { Bgem3Embedder } from "./embedding/bge-m3.ts";
import { MemoryExtractor } from "./memory/extractor.ts";
import { OllamaClient } from "./llm/ollama-client.ts";
import {
  DEFAULT_BACKFILL_INTERVAL_MIN,
  parseBackfillIntervalMin,
  startBackfillScheduler,
  startVisionBackfillScheduler,
} from "./scheduler.ts";
import { msUntilNextBoundary } from "./schedule-timing.ts";
import { AssetStore } from "./assets/asset-store.ts";
import { saveTextInput } from "./server-internal/save-input.ts";
import type { MemorySettings } from "./settings/memory-settings.ts";
import type { VisionProvider, VisionProviderSettings } from "./llm/vision/index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT } from "./memory/extractor-output-limit.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

describe("parseBackfillIntervalMin — bge-m3 migration B3 (2026-05-17)", () => {
  test("미설정 → 기본 30분 (extractor v2 정착)", () => {
    expect(parseBackfillIntervalMin(undefined)).toBe(30);
    expect(DEFAULT_BACKFILL_INTERVAL_MIN).toBe(30);
  });
  test("빈 문자열 → 기본 30분", () => {
    expect(parseBackfillIntervalMin("")).toBe(30);
    expect(parseBackfillIntervalMin("   ")).toBe(30);
  });
  test("'0' → 0 (비활성 신호)", () => {
    expect(parseBackfillIntervalMin("0")).toBe(0);
  });
  test("양의 정수 그대로 통과", () => {
    expect(parseBackfillIntervalMin("15")).toBe(15);
    expect(parseBackfillIntervalMin("60")).toBe(60);
  });
  test("음수·비숫자 → 기본 30분 fallback", () => {
    expect(parseBackfillIntervalMin("-5")).toBe(30);
    expect(parseBackfillIntervalMin("abc")).toBe(30);
  });
});

describe("startBackfillScheduler 입력 검증", () => {
  test("intervalMs가 60_000 미만이면 즉시 throw", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    const llm = new OllamaClient({
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3:4b-instruct",
    });
    const extractor = new MemoryExtractor(llm, store, embedder);

    expect(() =>
      startBackfillScheduler(extractor, store, { intervalMs: 59_999, retry: TEST_EXTRACTION_BACKFILL_RETRY }),
    ).toThrow();

    db.close();
  });
});

describe("스케줄러 사이클 — 후보 0개", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let extractor: MemoryExtractor;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    const llm = new OllamaClient({
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3:4b-instruct",
    });
    extractor = new MemoryExtractor(llm, store, embedder);
  });
  afterEach(() => { db.close(); });

  test("DB가 비어있으면 tickNow → candidatesFound 0, LLM 호출 없음", async () => {
    const handle = startBackfillScheduler(extractor, store, {
      intervalMs: 60_000,
      retry: TEST_EXTRACTION_BACKFILL_RETRY,
      batchSize: 5,
    });
    const summary = await handle.tickNow();
    expect(summary.candidatesFound).toBe(0);
    expect(summary.processed).toBe(0);
    expect(summary.storedNodes).toBe(0);
    expect(summary.failures).toBe(0);
    // WP-B1-08R (Minor 3) — rechunked/discarded now exposed on the summary, not just the log line.
    expect(summary.rechunked).toBe(0);
    expect(summary.discarded).toBe(0);
    await handle.stop();
  });

  test("llm_extract 노드만 있어도 후보로 안 잡힘 (source_type 필터)", async () => {
    await store.addNode({
      content: "이미 분해된 자식 노드",
      sourceType: "llm_extract",
    });
    const handle = startBackfillScheduler(extractor, store, {
      intervalMs: 60_000,
      retry: TEST_EXTRACTION_BACKFILL_RETRY,
      batchSize: 5,
    });
    const summary = await handle.tickNow();
    expect(summary.candidatesFound).toBe(0);
    await handle.stop();
  });

  test("minImportance 필터 적용 — 하한 미만은 건너뜀", async () => {
    await store.addNode({
      content: "낮은 importance",
      sourceType: "auto_capture",
      importance: 0.1,
    });
    const handle = startBackfillScheduler(extractor, store, {
      intervalMs: 60_000,
      retry: TEST_EXTRACTION_BACKFILL_RETRY,
      batchSize: 5,
      minImportance: 0.5,
    });
    const summary = await handle.tickNow();
    expect(summary.candidatesFound).toBe(0);
    await handle.stop();
  });

  test("stop() 후 tickNow는 즉시 빈 사이클 반환", async () => {
    const handle = startBackfillScheduler(extractor, store, {
      intervalMs: 60_000,
      retry: TEST_EXTRACTION_BACKFILL_RETRY,
    });
    await handle.stop();
    const summary = await handle.tickNow();
    expect(summary.candidatesFound).toBe(0);
    expect(summary.durationMs).toBe(0);
  });

  test("lastSummary는 첫 사이클 전엔 null, 한 번 돌리면 채워짐", async () => {
    const handle = startBackfillScheduler(extractor, store, {
      intervalMs: 60_000,
      retry: TEST_EXTRACTION_BACKFILL_RETRY,
    });
    expect(handle.lastSummary()).toBeNull();
    await handle.tickNow();
    expect(handle.lastSummary()).not.toBeNull();
    expect(handle.lastSummary()!.candidatesFound).toBe(0);
    await handle.stop();
  });

  test("onCycleComplete 콜백이 사이클마다 호출됨", async () => {
    const captured: Array<number> = [];
    const handle = startBackfillScheduler(extractor, store, {
      intervalMs: 60_000,
      retry: TEST_EXTRACTION_BACKFILL_RETRY,
      onCycleComplete: (s) => captured.push(s.candidatesFound),
    });
    await handle.tickNow();
    await handle.tickNow();
    expect(captured.length).toBe(2);
    expect(captured.every((c) => c === 0)).toBe(true);
    await handle.stop();
  });

  test("document_chunk 도 후보로 잡힌다 (입력 통로 통합 Task 5)", async () => {
    // 후보 조회 기준만 검증 — LLM 호출 없이. 스케줄러 runCycle 이
    // store.getBackfillCandidates 를 그대로 부르므로 store 후보 조회를 직접 본다.
    await store.addNode({
      content: "긴 글의 검색용 청크 — 미추출",
      sourceType: "document_chunk",
      metadata: { parentNodeId: 1, chunkIndex: 0 },
    });
    const candidates = await store.getBackfillCandidates({ limit: 10 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.sourceType).toBe("document_chunk");
  });

  test("철회·만료된 후보가 현재 기억의 백필 한도를 차지하지 않는다", async () => {
    await store.addNode({ content: "철회한 원문", metadata: { sharedMemory: { status: "retracted", revision: 1, assertionKind: "unknown" } } });
    await store.addNode({ content: "만료된 원문", metadata: { sharedMemory: { status: "active", revision: 0, assertionKind: "unknown", validUntil: "2000-01-01T00:00:00Z" } } });
    const active = await store.addNode({ content: "현재 유효한 원문" });
    expect((await store.getBackfillCandidates({ limit: 1 })).map((node) => node.id)).toEqual([active]);
  });
});

describe("startGenericBackfillScheduler — 시계 정렬 재예약 (extractor wrapper 경유)", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let extractor: MemoryExtractor;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    const llm = new OllamaClient({
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3:4b-instruct",
    });
    extractor = new MemoryExtractor(llm, store, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("첫 delay 가 msUntilNextBoundary 와 일치 + 사이클 후 다음 경계로 재예약", async () => {
    // setTimeout 을 주입해 콜백을 배열에 모으고 수동 실행한다(실제 타이머 대기 금지).
    // 빈 DB 라 사이클은 candidatesFound 0 으로 즉시 끝난다(LLM 호출 없음).
    const captured: { fn: () => void; ms: number }[] = [];
    let nowMs = new Date("2026-06-02T10:07:00+09:00").getTime();
    const handle = startBackfillScheduler(extractor, store, {
      intervalMs: 30 * 60_000,
      retry: TEST_EXTRACTION_BACKFILL_RETRY,
      now: () => nowMs,
      setTimeoutFn: (fn, ms) => {
        captured.push({ fn, ms });
        return captured.length;
      },
      clearTimeoutFn: () => {},
    });

    // 첫 사이클은 즉시 가동 X — 다음 경계(KST 자정 anchor + offset 0)까지 setTimeout.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.ms).toBe(msUntilNextBoundary(nowMs, 30, 0));

    // mock clock 을 그 경계 시각으로 전진시킨 뒤 콜백 수동 실행 → 사이클 + 재예약.
    nowMs += captured[0]!.ms;
    captured[0]!.fn();
    // tick().then(scheduleNext) 의 마이크로태스크 큐가 비워지길 기다린다.
    await new Promise((r) => setTimeout(r, 0));

    // 사이클 끝나면 다음 경계로 재예약 — 새 setTimeout 등록.
    expect(captured).toHaveLength(2);
    expect(captured[1]!.ms).toBe(msUntilNextBoundary(nowMs, 30, 0));

    await handle.stop();
  });

  test("offsetMin forward — vision 식 offset 격자로 첫 delay 정렬", async () => {
    // startBackfillScheduler 도 offsetMin 을 골격으로 forward 하는지 본다(extractor=0
    // 이 default 지만 인자 경로가 살아 있음을 검증). offset 15 격자로 delay 가 정렬.
    const captured: { fn: () => void; ms: number }[] = [];
    const nowMs = new Date("2026-06-02T10:07:00+09:00").getTime();
    const handle = startBackfillScheduler(extractor, store, {
      intervalMs: 30 * 60_000,
      retry: TEST_EXTRACTION_BACKFILL_RETRY,
      offsetMin: 15,
      now: () => nowMs,
      setTimeoutFn: (fn, ms) => {
        captured.push({ fn, ms });
        return captured.length;
      },
      clearTimeoutFn: () => {},
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.ms).toBe(msUntilNextBoundary(nowMs, 30, 15));
    // offset 0 격자와 다른 delay 여야 한다(forward 가 실제로 반영됨).
    expect(captured[0]!.ms).not.toBe(msUntilNextBoundary(nowMs, 30, 0));

    await handle.stop();
  });

  test("stop() 후엔 재예약 안 함 — clearTimeout 호출 + 신규 setTimeout 0", async () => {
    const captured: { fn: () => void; ms: number }[] = [];
    let cancelled = 0;
    const nowMs = new Date("2026-06-02T10:07:00+09:00").getTime();
    const handle = startBackfillScheduler(extractor, store, {
      intervalMs: 30 * 60_000,
      retry: TEST_EXTRACTION_BACKFILL_RETRY,
      now: () => nowMs,
      setTimeoutFn: (fn, ms) => {
        captured.push({ fn, ms });
        return captured.length;
      },
      clearTimeoutFn: () => {
        cancelled += 1;
      },
    });
    expect(captured).toHaveLength(1);

    await handle.stop();
    // 진행 중 timer 를 clearTimeout 으로 정리.
    expect(cancelled).toBe(1);
    // stop 후 setTimeout 신규 등록 0 — 더 늘지 않는다.
    expect(captured).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 입력 통로 통합 Task 5 — 추출 후 완료 마킹 (실제 extractor + Ollama 통합)
//
// 후보(raw·청크)를 추출한 뒤 그 노드 metadata 에 extracted/extractedTo 가 기록돼
// 다음 사이클에서 다시 줍히지 않는지 검증한다. LLM 출력은 비결정적이라 atomic
// 갯수를 단정하지 않고, "처리된 후보는 다음 사이클 후보에서 빠진다"는 불변식만 본다
// (Mock 금지 — 실제 bun:sqlite + 실제 Ollama extractor 통합).
//
// Ollama 미가동 환경에서는 extractAndStore 가 throw → scheduler 가 failures 로
// 집계하고 마킹을 건너뛴다(실패한 후보는 다음 주기 재시도 — 정직). 그 경우 "마킹됨"
// 단정이 깨지므로 Ollama 가용을 확인하고 미가동이면 skip 한다.
// ─────────────────────────────────────────────────────────────────────────────

let ollamaUp = false;
beforeAll(async () => {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(3000),
    });
    ollamaUp = res.ok;
  } catch {
    ollamaUp = false;
  }
});

describe("백필 사이클 — 추출 후 완료 마킹 (Task 5 / 실제 extractor)", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let extractor: MemoryExtractor;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    const llm = new OllamaClient({
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3:4b-instruct",
    });
    extractor = new MemoryExtractor(llm, store, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("raw·청크 추출 사이클 후 두 후보 모두 metadata 마킹 → 다음 사이클 0건", async () => {
    if (!ollamaUp) {
      console.warn(
        "[scheduler.test] Ollama(127.0.0.1:11434) 미가동 — 실제 추출 마킹 테스트 skip",
      );
      return;
    }
    const raw = await store.addNode({
      content: "본인은 어제 새 키보드를 샀다.",
      sourceType: "auto_capture",
      importance: 0.5,
    });
    const chunk = await store.addNode({
      content: "디롱이는 천둥을 무서워해서 책상 밑에 숨는다.",
      sourceType: "document_chunk",
      importance: 0.5,
      metadata: { parentNodeId: 999, chunkIndex: 0 },
    });

    // 사이클 전 — 둘 다 후보.
    expect(
      (await store.getBackfillCandidates({ limit: 10 }))
        .map((c) => c.id)
        .sort(),
    ).toEqual([raw, chunk].sort());

    const handle = startBackfillScheduler(extractor, store, {
      intervalMs: 60_000,
      retry: TEST_EXTRACTION_BACKFILL_RETRY,
      batchSize: 10,
    });
    const summary = await handle.tickNow();
    await handle.stop();

    // 두 후보 모두 처리(실패 0 — Ollama 가용 전제).
    expect(summary.candidatesFound).toBe(2);
    expect(summary.processed).toBe(2);
    expect(summary.failures).toBe(0);

    // 핵심 불변식 — 처리된 후보는 metadata 마킹으로 다음 사이클에서 빠진다.
    expect(await store.getBackfillCandidates({ limit: 10 })).toHaveLength(0);

    // 두 노드 모두 extracted 플래그 기록(추출 결과 0건이어도 표시됨). 정수 1 로 저장.
    const rawNode = await store.getNode(raw);
    const chunkNode = await store.getNode(chunk);
    expect((rawNode?.metadata as Record<string, unknown>).extracted).toBe(1);
    expect((chunkNode?.metadata as Record<string, unknown>).extracted).toBe(1);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-06-02 Q1 — backfill 경로 태그 전처리 (LLM 입력에서 #태그 제거)
//
// backfill 사이클이 prepareExtraction(LLM 준비)에 넘기는 text 가 #태그 제거된 cleanContent
// 인지 검증한다. 실제 MemoryExtractor 인스턴스를 만들고 그 인스턴스의
// prepareExtraction 단일 메서드를 인자 캡처 함수로 교체한다(가짜 인터페이스 구현
// = mock 클래스가 아니라, 실제 인스턴스 위 한 메서드 관찰). 그래야 LLM 가동 없이
// "어떤 text 가 전달되는가"를 결정적으로 본다. 캡처 후 빈 결과를 회신해 scheduler
// 의 후속 마킹 흐름까지 정상 진행시킨다.
// ─────────────────────────────────────────────────────────────────────────────

describe("백필 사이클 — Q1 태그 전처리 (prepareExtraction.text = cleanContent)", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let extractor: MemoryExtractor;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    const llm = new OllamaClient({
      baseUrl: "http://127.0.0.1:1",
      model: "qwen3:4b-instruct",
    });
    extractor = new MemoryExtractor(llm, store, embedder);
  });
  afterEach(() => {
    db.close();
  });

  /** 실제 extractor 의 prepareExtraction 을 캡처 래퍼로 교체. 인자만 본다. */
  function captureExtractInputs(): Array<{
    text: string;
    skipHashtagWiring?: boolean;
    projectId?: string | null;
  }> {
    const captured: Array<{
      text: string;
      skipHashtagWiring?: boolean;
      projectId?: string | null;
    }> = [];
    extractor.prepareExtraction = (async (input: {
      text: string;
      skipHashtagWiring?: boolean;
      projectId?: string | null;
    }) => {
      captured.push({
        text: input.text,
        skipHashtagWiring: input.skipHashtagWiring,
        projectId: input.projectId,
      });
      // 항목 0건 준비 결과 — 잠금 안 저장(storeExtraction)과 완료 마킹까지 실제로 흐른다.
      return { sourceText: input.text, now: new Date(), items: [], rawResponse: "" };
    }) as typeof extractor.prepareExtraction;
    return captured;
  }

  test("태그 선행 사실 메모 → LLM 입력에서 #태그 제거된 cleanContent 전달", async () => {
    await store.addNode({
      content: "#프로젝트 #바라 Bara System은 RAG 메모리 시스템이다",
      sourceType: "auto_capture",
      importance: 0.5,
    });
    const captured = captureExtractInputs();

    const handle = startBackfillScheduler(extractor, store, {
      intervalMs: 60_000,
      retry: TEST_EXTRACTION_BACKFILL_RETRY,
      batchSize: 10,
    });
    await handle.tickNow();
    await handle.stop();

    expect(captured).toHaveLength(1);
    // #프로젝트 / #바라 조각이 LLM 입력에서 사라지고 주어가 안 잘린다.
    expect(captured[0]!.text).toBe("Bara System은 RAG 메모리 시스템이다");
    expect(captured[0]!.text).not.toContain("#");
    // 그래프 wiring 은 계속 건너뛴다(skipHashtagWiring=true 유지).
    expect(captured[0]!.skipHashtagWiring).toBe(true);
  });

  test("태그만 입력(#만화) → cleanContent 빈 문자열이면 LLM 호출 없이 추출 완료 마킹", async () => {
    const nodeId = await store.addNode({
      content: "#만화",
      sourceType: "auto_capture",
      importance: 0.5,
    });
    const captured = captureExtractInputs();

    const handle = startBackfillScheduler(extractor, store, {
      intervalMs: 60_000,
      retry: TEST_EXTRACTION_BACKFILL_RETRY,
      batchSize: 10,
    });
    await handle.tickNow();
    await handle.stop();

    expect(captured).toHaveLength(0);
    const node = await store.getNode(nodeId);
    expect(node?.metadata.extracted).toBe(1);
    expect(node?.metadata.extractedTo).toEqual([]);
    const candidates = await store.getBackfillCandidates({ limit: 10 });
    expect(candidates.map((c) => c.id)).not.toContain(nodeId);
  });

  test("원본 노드(candidate.content)는 태그 포함 그대로 보존된다", async () => {
    const id = await store.addNode({
      content: "#프로젝트 Bara System은 메모리 시스템이다",
      sourceType: "auto_capture",
      importance: 0.5,
    });
    captureExtractInputs();

    const handle = startBackfillScheduler(extractor, store, {
      intervalMs: 60_000,
      retry: TEST_EXTRACTION_BACKFILL_RETRY,
      batchSize: 10,
    });
    await handle.tickNow();
    await handle.stop();

    // 추출은 cleanContent 로 했지만 원본 노드 content 는 태그 포함 불변 —
    // 태그 개념 노드 기능 + 재추출 가능성 보존.
    const node = await store.getNode(id);
    expect(node?.content).toBe("#프로젝트 Bara System은 메모리 시스템이다");
  });

  test("document_chunk backfill 후보의 projectId를 prepareExtraction으로 넘긴다", async () => {
    await store.addNode({
      content: "프로젝트 문서 청크 내용이다. 추출 대상 문장도 충분히 길다.",
      sourceType: "document_chunk",
      importance: 0.5,
      project_id: "prj_chunk",
    });
    const captured = captureExtractInputs();

    const handle = startBackfillScheduler(extractor, store, {
      intervalMs: 60_000,
      retry: TEST_EXTRACTION_BACKFILL_RETRY,
      batchSize: 10,
    });
    await handle.tickNow();
    await handle.stop();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.projectId).toBe("prj_chunk");
    expect(captured[0]!.skipHashtagWiring).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 11e G2-3 (T7 / DCL-1) — vision 백필 스케줄러
//
// extractor 스케줄러와 런타임 골격(intervalMs 가드·overlap·핸들)을 공유한다.
// caption flow 의 VLM 호출은 무거우므로, provider 를 object literal counting 구현
// (mock 클래스 아님 — FixtureAssetStore 선례 정합)으로 주입해 사이클의 *순수 로직*
// (후보 조회 → 캡션 생성 → has_caption_auto 전이 → 요약 집계)을 검증한다.
// ─────────────────────────────────────────────────────────────────────────────

const VISION_SETTINGS: VisionProviderSettings = {
  enabled: true,
  provider: "ollama",
  model: "qwen3-vl:4b",
  endpoint: "http://127.0.0.1:11434",
  apiKey: null,
  tokenCap: 500,
  forceCall: true,
};

/**
 * 캡션 호출을 세는 object literal provider. captionImage 호출 시 고정 캡션 글을
 * 회신하거나(성공) 정해진 sha 에서 throw(실패) 한다. mock 클래스 아님 —
 * VisionProvider 인터페이스 충족 object (FixtureAssetStore 선례 정합).
 */
function countingProvider(opts?: {
  failOnMime?: string;
}): VisionProvider & { calls: number } {
  return {
    name: "test:counting",
    calls: 0,
    async captionImage(_buffer, mimeType, _prompt, _options) {
      this.calls += 1;
      if (opts?.failOnMime && mimeType === opts.failOnMime) {
        throw new Error("VLM 호출 실패 (테스트 의도)");
      }
      return { caption: `테스트 캡션 ${mimeType}` };
    },
  };
}

/** image_asset 노드 + images row + 실 자산 파일을 한 묶음 만든다. */
async function seedImageWithAsset(
  db: Database,
  store: SqliteMemoryStore,
  assetStore: AssetStore,
  args: { mime: string; ext: string; createdAt: string; bytes: Uint8Array },
): Promise<{ nodeId: number; sha256: string }> {
  const w = assetStore.write(args.bytes, args.ext);
  db.prepare(
    `INSERT OR IGNORE INTO asset_files
       (sha256, asset_type, asset_path, byte_size, mime_type, original_name, first_imported_at)
     VALUES (?, 'image', ?, ?, ?, NULL, ?)`,
  ).run(w.sha256, assetStore.path(w.sha256, args.ext), args.bytes.byteLength, args.mime, Date.now());
  db.prepare(
    `INSERT INTO images
       (asset_sha256, thumb_sha256, width, height, mime, preserve_mode,
        is_animated, warnings_json, has_caption_auto, created_at)
     VALUES (?, ?, 1, 1, ?, 'smart', 0, '[]', 0, ?)`,
  ).run(w.sha256, w.sha256, args.mime, args.createdAt);
  const nodeId = await store.addNode({
    content: `이미지 자산 ${w.sha256.slice(0, 12)}`,
    sourceType: "image_asset",
    metadata: { asset_sha256: w.sha256 },
  });
  return { nodeId, sha256: w.sha256 };
}

describe("startVisionBackfillScheduler 입력 검증", () => {
  test("intervalMs<60_000 throw 가드 승계 (extractor 와 같은 안전선)", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    const tmp = mkdtempSync(join(tmpdir(), "bara-vis-guard-"));
    const assetStore = new AssetStore(tmp);
    expect(() =>
      startVisionBackfillScheduler(
        store,
        assetStore,
        VISION_SETTINGS,
        countingProvider(),
        { intervalMs: 59_999, retry: TEST_CAPTION_BACKFILL_RETRY },
      ),
    ).toThrow();
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("vision 백필 사이클 — runVisionBackfillCycle 통로 (tickNow)", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let assetStore: AssetStore;
  let tmpDir: string;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    tmpDir = mkdtempSync(join(tmpdir(), "bara-vis-cycle-"));
    assetStore = new AssetStore(tmpDir);
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("철회된 이미지는 캡션 후보에서 제외하고 다음 현재 이미지를 선택한다", async () => {
    const old = await seedImageWithAsset(db, store, assetStore, {
      mime: "image/png", ext: "png", createdAt: "2026-05-30 10:00:00", bytes: new Uint8Array([1, 2, 3]),
    });
    db.query("UPDATE knowledge_nodes SET metadata_json=json_set(metadata_json,'$.sharedMemory',json(?)) WHERE id=?")
      .run(JSON.stringify({ status: "retracted", revision: 1, assertionKind: "unknown" }), old.nodeId);
    const current = await seedImageWithAsset(db, store, assetStore, {
      mime: "image/png", ext: "png", createdAt: "2026-05-31 10:00:00", bytes: new Uint8Array([4, 5, 6]),
    });
    expect(store.getUncaptionedImageCandidates({ limit: 1 }).map((row) => row.nodeId)).toEqual([current.nodeId]);
  });

  test("미캡션 0건 → candidatesFound 0, provider 호출 0", async () => {
    const provider = countingProvider();
    const handle = startVisionBackfillScheduler(
      store,
      assetStore,
      VISION_SETTINGS,
      provider,
      { intervalMs: 60_000, batchSize: 5, retry: TEST_CAPTION_BACKFILL_RETRY },
    );
    const summary = await handle.tickNow();
    expect(summary.candidatesFound).toBe(0);
    expect(summary.processed).toBe(0);
    expect(summary.storedNodes).toBe(0);
    expect(summary.failures).toBe(0);
    expect(provider.calls).toBe(0);
    await handle.stop();
  });

  test("미캡션 이미지 캡션 성공 → storedNodes 집계 + has_caption_auto 0→1 전이", async () => {
    const { nodeId, sha256 } = await seedImageWithAsset(db, store, assetStore, {
      mime: "image/png",
      ext: "png",
      createdAt: "2026-05-30 10:00:00",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]),
    });
    // 처음엔 후보.
    expect(store.getUncaptionedImageCandidates({ limit: 10 })).toHaveLength(1);

    const provider = countingProvider();
    const handle = startVisionBackfillScheduler(
      store,
      assetStore,
      VISION_SETTINGS,
      provider,
      { intervalMs: 60_000, batchSize: 5, retry: TEST_CAPTION_BACKFILL_RETRY },
    );
    const summary = await handle.tickNow();
    expect(summary.candidatesFound).toBe(1);
    expect(summary.processed).toBe(1);
    expect(summary.storedNodes).toBe(1);
    expect(summary.failures).toBe(0);
    expect(provider.calls).toBe(1);

    // has_caption_auto 0→1 전이 → 후보에서 빠짐.
    expect(store.getUncaptionedImageCandidates({ limit: 10 })).toHaveLength(0);
    // image_caption 자식 노드 + parent_of 엣지 실제 생성 검증.
    const captions = store.getImageCaptions(nodeId);
    expect(captions.auto).toBe("테스트 캡션 image/png");
    expect(sha256).toHaveLength(64);

    await handle.stop();
  });

  test("캡션 실패(VLM throw) → failures 집계 + has_caption_auto=0 유지(다음 주기 재시도)", async () => {
    await seedImageWithAsset(db, store, assetStore, {
      mime: "image/jpeg",
      ext: "jpg",
      createdAt: "2026-05-30 10:00:00",
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 2]),
    });
    const provider = countingProvider({ failOnMime: "image/jpeg" });
    const handle = startVisionBackfillScheduler(
      store,
      assetStore,
      VISION_SETTINGS,
      provider,
      { intervalMs: 60_000, batchSize: 5, retry: TEST_CAPTION_BACKFILL_RETRY },
    );
    const summary = await handle.tickNow();
    expect(summary.candidatesFound).toBe(1);
    expect(summary.processed).toBe(1); // 호출 시도는 함
    expect(summary.storedNodes).toBe(0); // 캡션 노드 생성 0
    expect(summary.failures).toBe(1); // 실패로 정직 집계
    expect(provider.calls).toBe(1);

    // has_caption_auto 미갱신 → 여전히 후보(다음 주기 재시도). 실패를 성공으로 위장 안 함.
    expect(store.getUncaptionedImageCandidates({ limit: 10 })).toHaveLength(1);
    await handle.stop();
  });

  test("batchSize 만큼 한 사이클 처리 + 다음 사이클 남은 것 처리 (소진까지)", async () => {
    for (let i = 0; i < 3; i++) {
      await seedImageWithAsset(db, store, assetStore, {
        mime: "image/png",
        ext: "png",
        createdAt: `2026-05-30 1${i}:00:00`,
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, i + 10]),
      });
    }
    const provider = countingProvider();
    const handle = startVisionBackfillScheduler(
      store,
      assetStore,
      VISION_SETTINGS,
      provider,
      { intervalMs: 60_000, batchSize: 2, retry: TEST_CAPTION_BACKFILL_RETRY },
    );
    // 사이클 1 — 오래된 2건.
    const s1 = await handle.tickNow();
    expect(s1.candidatesFound).toBe(2);
    expect(s1.storedNodes).toBe(2);
    expect(store.getUncaptionedImageCandidates({ limit: 10 })).toHaveLength(1);

    // 사이클 2 — 남은 1건.
    const s2 = await handle.tickNow();
    expect(s2.candidatesFound).toBe(1);
    expect(s2.storedNodes).toBe(1);
    expect(store.getUncaptionedImageCandidates({ limit: 10 })).toHaveLength(0);

    // 사이클 3 — 소진, 0건.
    const s3 = await handle.tickNow();
    expect(s3.candidatesFound).toBe(0);

    expect(provider.calls).toBe(3);
    await handle.stop();
  });

  test("onCycleComplete 콜백 + lastSummary 동작", async () => {
    const captured: number[] = [];
    const handle = startVisionBackfillScheduler(
      store,
      assetStore,
      VISION_SETTINGS,
      countingProvider(),
      {
        intervalMs: 60_000,
        retry: TEST_CAPTION_BACKFILL_RETRY,
        onCycleComplete: (s) => captured.push(s.candidatesFound),
      },
    );
    expect(handle.lastSummary()).toBeNull();
    await handle.tickNow();
    expect(captured).toEqual([0]);
    expect(handle.lastSummary()).not.toBeNull();
    expect(handle.lastSummary()!.candidatesFound).toBe(0);
    await handle.stop();
  });

  // ── 회귀 차단: 운영 settings.forceCall=false 여도 백필은 캡션을 만든다 ──
  // 운영 설정은 llm.vision.forceCall=false 인데, 백필은 캡션 텍스트가 검색 목적이라
  // SigLIP 임베딩 가용 여부와 무관하게 강제 호출해야 한다. 백필이 applyVlmCaptionFlow
  // 에 forceCall:true 를 안 넘기던 게 A1 운영에서 매 사이클 0/N captioned 한 근본
  // 원인이었다(settings.forceCall=false → decideVlmInvocation 가 token 절약 skip).
  // 위 다른 테스트는 VISION_SETTINGS.forceCall=true 라 이 결함을 가렸다 — 여기서
  // 운영과 같은 forceCall=false 로 명시 검증한다.
  test("settings.forceCall=false + 임베딩 가용 이미지 → 백필이 강제 호출로 캡션 생성", async () => {
    await seedImageWithAsset(db, store, assetStore, {
      mime: "image/png",
      ext: "png",
      createdAt: "2026-05-30 09:00:00",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7]),
    });
    expect(store.getUncaptionedImageCandidates({ limit: 10 })).toHaveLength(1);

    const provider = countingProvider();
    // 운영 정합 — forceCall=false. 백필이 자체 forceCall:true 를 전달하지 않으면
    // decideVlmInvocation 이 hasEmbedding=true 에서 skip → calls 0 → storedNodes 0.
    const handle = startVisionBackfillScheduler(
      store,
      assetStore,
      { ...VISION_SETTINGS, forceCall: false },
      provider,
      { intervalMs: 60_000, batchSize: 5, retry: TEST_CAPTION_BACKFILL_RETRY },
    );
    const summary = await handle.tickNow();
    expect(summary.candidatesFound).toBe(1);
    expect(summary.processed).toBe(1);
    expect(summary.storedNodes).toBe(1);
    expect(summary.failures).toBe(0);
    // 핵심 단언 — provider 가 실제로 호출됐다(백필 forceCall override 동작).
    expect(provider.calls).toBe(1);
    // has_caption_auto 0→1 전이 → 후보에서 빠짐.
    expect(store.getUncaptionedImageCandidates({ limit: 10 })).toHaveLength(0);
    await handle.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 — 태그 wiring 중복 누적 0 (입력 시점 wiring + backfill 재처리 불변)
//
// 핵심: 태그 wiring 이 입력 시점 1회뿐이라, backfill 스케줄러가 같은 원본을 매
// 사이클 재추출(tickNow 반복)해도 tagged_with 가 안 늚(옛 22~24회 누적 bug 의 근본 =
// 추출 시점 wiring × 매 사이클 → 입력 시점 1회로 옮겨 차단). 추출 경로는
// skipHashtagWiring=true 라 태그 wiring 을 안 한다.
//
// 이 불변식은 LLM 가용과 무관하게 성립한다 — Ollama 미가동이면 scheduler 가 추출을
// failures 로 집계하지만 태그 wiring 은 어차피 추출 경로에서 안 도므로 tagged_with 가
// 늘지 않는다. 그래서 ollamaUp 게이트 없이 검증한다(실제 store + 실제 scheduler).
// ─────────────────────────────────────────────────────────────────────────────

describe("백필 재처리 — 태그 wiring 중복 누적 0 (T4)", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let extractor: MemoryExtractor;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    const llm = new OllamaClient({
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3:4b-instruct",
    });
    extractor = new MemoryExtractor(llm, store, embedder);
  });
  afterEach(() => {
    db.close();
  });

  /** backfill mode 슬롯 — saveTextInput 이 plain 갈래(입력 시점 wiring)로 가게. */
  function backfillSlot(): MemorySettings["llm"]["extractor"] {
    return {
      enabled: true,
      provider: "ollama",
      ollamaUrl: "http://127.0.0.1:11434",
      ollamaModel: "qwen3:4b-instruct",
      anthropicApiKey: "",
      anthropicModel: "",
      openaiBaseUrl: "http://127.0.0.1:1234/v1",
      openaiModel: "qwen3:4b-instruct",
      openaiApiKey: "",
      gptApiKey: "",
      gptModel: "",
      geminiApiKey: "",
      geminiModel: "",
      mode: "backfill",
      minImportance: 0.3,
      forceJsonFormat: false,
      timeoutMs: 900000,
      maxOutputTokens: EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT,
      backfill: { intervalMin: 30, batchSize: 10, minImportance: 0, maxAttempts: 5, retryDelayMin: 30, retryMaxDelayMin: 1440 },
    };
  }

  test("#태그 글 입력 후 backfill 3회 재처리 → tagged_with 증가 0", async () => {
    // 입력 시점 wiring — backfill mode 라 plain 갈래(추출 동기 안 함, 입력 시점 wiring 1회).
    const result = await saveTextInput(store, {
      content: "#만화 본문 메모",
      source: "dashboard:manual",
      chunking: { tokenCap: 2000 },
      extractorSettings: backfillSlot(),
    });

    const before = await store.listNodeConceptEdges({
      nodeId: result.originNodeId!,
      role: "tag",
    });
    expect(before).toHaveLength(1);

    // backfill 스케줄러를 3회 강제 가동 — 추출 경로는 skipHashtagWiring=true 라 태그
    // wiring 을 안 한다. Ollama 미가동이면 failures 로 집계되지만 어느 경우든 태그
    // 엣지는 늘지 않아야 한다(추출 사이클과 무관).
    const handle = startBackfillScheduler(extractor, store, {
      intervalMs: 60_000,
      retry: TEST_EXTRACTION_BACKFILL_RETRY,
      batchSize: 10,
    });
    await handle.tickNow();
    await handle.tickNow();
    await handle.tickNow();
    await handle.stop();

    const after = await store.listNodeConceptEdges({
      nodeId: result.originNodeId!,
      role: "tag",
    });
    expect(after).toHaveLength(1); // 증가 0.

    // 전체 tagged_with 엣지도 정확히 1개(다른 노드에 새 태그 엣지가 안 생김).
    const allTagEdges = await store.listNodeConceptEdges({ role: "tag" });
    expect(allTagEdges).toHaveLength(1);
  });
});
