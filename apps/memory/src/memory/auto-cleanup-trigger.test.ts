/**
 * startAutoCleanupTrigger 단위 테스트 — Phase 5.7.3 W3.
 *
 * 결정성 확보 = 시각 + setTimeout 함수 주입 패턴. 실 Date.now / 전역
 * setTimeout 의존 X — 테스트 안에서 시간 흐름 + timer 발사 시점 직접 제어.
 *
 * 정리 본체(runAutoCleanup)가 쓰는 store 는 실 SqliteMemoryStore(실 SQLite :memory:)
 * 다 — 가짜 store 를 만들지 않는다(CLAUDE.md "Mock 객체 금지"). 가동 횟수는 가동
 * 한 번마다 store 가 `evolver_activity` 에 남기는 활동 로그 행 수로 센다
 * (`getEvolverActivity`) — throttle 정합 검증 핵심.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  startAutoCleanupTrigger,
  type DataChangeReason,
} from "./auto-cleanup-trigger.ts";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";

/** 활동 로그 조회 상한 — getEvolverActivity 의 서버측 상한(100)과 같다. 테스트의 가동 횟수는 이보다 훨씬 적다. */
const ACTIVITY_LOG_LIMIT = 100;

/** 지금까지 끝난 자동 정리 가동 횟수 = 실 store 의 활동 로그 행 수. */
async function cleanupCycles(store: SqliteMemoryStore): Promise<number> {
  return (await store.getEvolverActivity(ACTIVITY_LOG_LIMIT)).length;
}

/**
 * 진행 중인 가동 한 사이클(쓰기 잠금 대기 → 정리 → 활동 로그)이 끝나도록 이벤트
 * 루프를 한 바퀴 돌린다. 빈 DB 의 사이클은 마이크로태스크와 동기 SQLite 로만
 * 이뤄져 매크로태스크 한 번이면 모두 끝난다.
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * 시간 흐름 + setTimeout 발사 시점 직접 제어용 시계.
 *
 * 트리거의 `now`·`setTimeout`·`clearTimeout` 옵션(운영 코드가 열어 둔 주입 지점)으로
 * 넘기는 시간 원천이다 — 다른 객체를 흉내 내지 않는다. 실 시계로는 throttle 30초를
 * 케이스마다 기다려야 해서 쓴다.
 *
 * `nowMs` = 현재 시각 (밀리초). `advance(deltaMs)` 호출 시 nowMs 갱신 +
 * 등록된 timer 중 fire 시각 ≤ 새 nowMs 인 것 모두 발사.
 */
class ManualClock {
  public nowMs: number;
  private nextHandle = 1;
  private timers = new Map<number, { fireAtMs: number; fn: () => void }>();

  constructor(startMs = 0) {
    this.nowMs = startMs;
  }

  now = (): number => this.nowMs;

  setTimeout = (fn: () => void, ms: number): number => {
    const handle = this.nextHandle++;
    this.timers.set(handle, { fireAtMs: this.nowMs + ms, fn });
    return handle;
  };

  clearTimeout = (handle: unknown): void => {
    if (typeof handle === "number") this.timers.delete(handle);
  };

  /** 가상 시각을 deltaMs 전진 + 발사 시각 도달한 timer 다 호출. */
  async advance(deltaMs: number): Promise<void> {
    this.nowMs += deltaMs;
    // 발사 시각 도달 timer 모두 모음 (재진입 안전 위해 snapshot).
    const fired: Array<() => void> = [];
    for (const [handle, t] of [...this.timers]) {
      if (t.fireAtMs <= this.nowMs) {
        fired.push(t.fn);
        this.timers.delete(handle);
      }
    }
    for (const fn of fired) fn();
    // 발사된 timer 가 시작한 가동 사이클이 끝나도록 이벤트 루프를 돌린다.
    await settle();
  }

  pendingTimerCount(): number {
    return this.timers.size;
  }
}

describe("startAutoCleanupTrigger", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  // 빈 DB 의 정리 사이클은 임베딩을 쓰지 않아 모델을 load 하지 않는다.
  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, new Bgem3Embedder());
  });

  afterEach(() => {
    db.close();
  });

  test("emit 1회 → runAutoCleanup 1회 가동 + lastRunAt 갱신", async () => {
    const clock = new ManualClock(1_000_000);
    const handle = startAutoCleanupTrigger({
      throttleMs: 30_000,
      store,
      enabled: () => true,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    handle.emit("raw-memory-added");
    // 동기 emit 흐름 — runOnce 안 await chain(잠금 대기 → 정리 → 활동 로그)이
    // 모두 끝나도록 이벤트 루프를 돌린다.
    await settle();

    expect(await cleanupCycles(store)).toBe(1);
    const summary = handle.lastSummary();
    expect(summary).not.toBeNull();
    expect(summary!.clusterEdgesAdded).toBe(0);
    expect(summary!.nodesArchived).toBe(0);

    await handle.stop();
  });

  test("30초 throttle 윈도우 안 emit 5회 → runAutoCleanup 1회만 (silent skip 정합)", async () => {
    const clock = new ManualClock(1_000_000);
    const handle = startAutoCleanupTrigger({
      throttleMs: 30_000,
      store,
      enabled: () => true,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    // 첫 emit = 즉시 가동 (lastRunAt = 0 → sinceLast >= throttleMs).
    handle.emit("raw-memory-added");
    await settle();
    expect(await cleanupCycles(store)).toBe(1);

    // 5초 후 신규 emit 4건 — throttle 윈도우 안 silent skip + 첫 추가
    // emit 이 pending timer 박음.
    await clock.advance(5_000);
    handle.emit("atomic-memory-added");
    handle.emit("node-edited");
    handle.emit("hashtag-concept-added");
    handle.emit("external-sdk-write");
    // 가동 횟수는 그대로 1 — pending timer 안 발사. 돌았다면 활동 로그에 찍히도록 사이클을 끝낸 뒤 센다.
    await settle();
    expect(await cleanupCycles(store)).toBe(1);
    // pending timer 정확히 1개 (첫 추가 emit 만 박음).
    expect(clock.pendingTimerCount()).toBe(1);

    await handle.stop();
  });

  test("31초 후 emit 1회 → runAutoCleanup 1회 추가 가동 (윈도우 종료 정합)", async () => {
    const clock = new ManualClock(1_000_000);
    const handle = startAutoCleanupTrigger({
      throttleMs: 30_000,
      store,
      enabled: () => true,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    handle.emit("raw-memory-added");
    await settle();
    expect(await cleanupCycles(store)).toBe(1);

    // 31초 전진 — 마지막 가동 후 throttleMs (30s) 초과.
    await clock.advance(31_000);

    handle.emit("node-deleted");
    await settle();
    expect(await cleanupCycles(store)).toBe(2);

    await handle.stop();
  });

  test("enabled() = false 토글 → emit 호출해도 runAutoCleanup 가동 0", async () => {
    const clock = new ManualClock(1_000_000);
    let enabled = false;
    const handle = startAutoCleanupTrigger({
      throttleMs: 30_000,
      store,
      enabled: () => enabled,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    handle.emit("raw-memory-added");
    handle.emit("atomic-memory-added");
    handle.emit("external-sdk-write");
    await settle();
    expect(await cleanupCycles(store)).toBe(0);

    // 토글 ON 후 emit → 가동 1회.
    enabled = true;
    handle.emit("node-edited");
    await settle();
    expect(await cleanupCycles(store)).toBe(1);

    await handle.stop();
  });

  test("윈도우 종료 시점에 pending timer 발사 → runAutoCleanup 1회 가동", async () => {
    const clock = new ManualClock(1_000_000);
    const handle = startAutoCleanupTrigger({
      throttleMs: 30_000,
      store,
      enabled: () => true,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    // 첫 emit → 즉시 가동.
    handle.emit("raw-memory-added");
    await settle();
    expect(await cleanupCycles(store)).toBe(1);

    // 윈도우 안 추가 emit → pending timer 박음.
    await clock.advance(10_000);
    handle.emit("atomic-memory-added");
    expect(clock.pendingTimerCount()).toBe(1);
    await settle();
    expect(await cleanupCycles(store)).toBe(1);

    // 윈도우 종료까지 전진 (남은 20초) → pending timer 발사 + 가동.
    await clock.advance(20_000);
    expect(await cleanupCycles(store)).toBe(2);
    expect(clock.pendingTimerCount()).toBe(0);

    await handle.stop();
  });

  test("stop() → 진행 중 pending timer 정리 + 신규 emit 차단", async () => {
    const clock = new ManualClock(1_000_000);
    const handle = startAutoCleanupTrigger({
      throttleMs: 30_000,
      store,
      enabled: () => true,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    handle.emit("raw-memory-added");
    await settle();
    expect(await cleanupCycles(store)).toBe(1);

    await clock.advance(5_000);
    handle.emit("atomic-memory-added");
    expect(clock.pendingTimerCount()).toBe(1);

    // stop → pending timer 정리.
    await handle.stop();
    expect(clock.pendingTimerCount()).toBe(0);

    // stop 후 emit 시도 — 차단.
    await clock.advance(60_000);
    handle.emit("external-sdk-write");
    await settle();
    expect(await cleanupCycles(store)).toBe(1);
  });

  test("DataChangeReason 6 형태 모두 emit 흐름 정합 (타입 + silent skip 무관 호출)", async () => {
    const clock = new ManualClock(1_000_000);
    const handle = startAutoCleanupTrigger({
      throttleMs: 30_000,
      store,
      enabled: () => true,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    const reasons: DataChangeReason[] = [
      "raw-memory-added",
      "atomic-memory-added",
      "node-edited",
      "hashtag-concept-added",
      "external-sdk-write",
      "node-deleted",
    ];

    // 첫 emit 즉시 가동, 나머지 5개 = 같은 윈도우 안 silent skip + 한 timer.
    for (const r of reasons) handle.emit(r);
    await settle();
    expect(await cleanupCycles(store)).toBe(1);
    expect(clock.pendingTimerCount()).toBe(1);

    await handle.stop();
  });
});

// ── 그래프 라이브 연출 2d — onGraphEmerge 콜백 발행 (Task 7) ───────────────────
//
// emerge 가 진짜 개념을 만든/합류시킨 자리에서 onGraphEmerge 가 항목 수만큼 불리는지,
// 승격 0 이면 0 회인지 검증한다. emerge 집계·승격은 DB·임베딩·Kiwi 토큰화 의존이라
// 실 SqliteMemoryStore 를 emergeStore 로 쓴다(Mock 0 — CLAUDE.md "DB/임베딩 의존
// 모듈은 실제 구현체와 통합 검증"). 정리 본체(AutoCleanupStore)도 같은 실 store 다.
describe("startAutoCleanupTrigger — onGraphEmerge 발행 (2d)", () => {
  let embedder: Bgem3Embedder;

  beforeAll(async () => {
    embedder = new Bgem3Embedder();
    await embedder.load();
  });

  /** 실 store 에 글 한 개 저장(실 임베딩 경유). */
  async function addDoc(store: SqliteMemoryStore, content: string): Promise<void> {
    await store.addNode({
      content,
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
  }

  test("emerge 가 개념을 승격하면 onGraphEmerge 가 항목마다 한 번 불린다", async () => {
    const db: Database = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const emergeStore = new SqliteMemoryStore(db, embedder);
    // "커피" 가 3개 distinct 글에 등장 → threshold 2 로 승격된다.
    await addDoc(emergeStore, "커피 한잔 마셨다");
    await addDoc(emergeStore, "커피 향이 좋다");
    await addDoc(emergeStore, "커피 또 마셨다");

    const signals: Array<{ nodeId: string; fromSources: string[] }> = [];
    const handle = startAutoCleanupTrigger({
      throttleMs: 30_000,
      store: emergeStore,
      emergeStore,
      emergeOptions: { threshold: 2, wordOptions: { minLength: 2 } },
      onGraphEmerge: (sig) => signals.push(sig),
      enabled: () => true,
    });

    handle.emit("raw-memory-added");
    // runOnce 안 runAutoCleanup → emergeRepeatedWords(실 토큰화·임베딩) await chain 이
    // 길어 여러 마이크로태스크 회전이 필요하다. 실제 비동기라 짧게 대기도 섞는다.
    for (let i = 0; i < 50; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 200));

    // "커피" 한 개념이 승격 → 콜백 1회, nodeId 형식·출처 채워짐 확인.
    expect(signals.length).toBeGreaterThanOrEqual(1);
    const coffee = signals.find((s) => s.fromSources.length >= 2);
    expect(coffee).toBeDefined();
    expect(coffee!.nodeId).toMatch(/^concept:/);
    expect(coffee!.fromSources.length).toBeGreaterThanOrEqual(2);

    await handle.stop();
    db.close();
  });

  test("emerge 승격 0(반복 단어 없음)이면 onGraphEmerge 0 회", async () => {
    const db: Database = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const emergeStore = new SqliteMemoryStore(db, embedder);
    // 반복 없는 글 → 높은 임계로 후보 0.
    await addDoc(emergeStore, "오늘은 산책을 했다");
    await addDoc(emergeStore, "내일은 영화를 본다");

    const signals: Array<{ nodeId: string; fromSources: string[] }> = [];
    const handle = startAutoCleanupTrigger({
      throttleMs: 30_000,
      store: emergeStore,
      emergeStore,
      emergeOptions: { threshold: 50 },
      onGraphEmerge: (sig) => signals.push(sig),
      enabled: () => true,
    });

    handle.emit("raw-memory-added");
    for (let i = 0; i < 50; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 200));

    expect(signals.length).toBe(0);

    await handle.stop();
    db.close();
  });

  test("onGraphEmerge 미주입이면 emerge 가 돌아도 no-op(옛 흐름 보존)", async () => {
    const db: Database = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const emergeStore = new SqliteMemoryStore(db, embedder);
    await addDoc(emergeStore, "커피 한잔 마셨다");
    await addDoc(emergeStore, "커피 향이 좋다");

    // onGraphEmerge 미주입 — 콜백 없이도 정리·emerge 사이클이 정상 가동되어야 한다.
    const handle = startAutoCleanupTrigger({
      throttleMs: 30_000,
      store: emergeStore,
      emergeStore,
      emergeOptions: { threshold: 2, wordOptions: { minLength: 2 } },
      enabled: () => true,
    });

    handle.emit("raw-memory-added");
    for (let i = 0; i < 50; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 200));

    // 정리 본체는 정상 1회 가동(콜백 부재가 사이클을 깨지 않는다).
    expect(await cleanupCycles(emergeStore)).toBe(1);

    await handle.stop();
    db.close();
  });
});
