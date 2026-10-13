/**
 * runTrashManagement + startTrashCron 단위 테스트 — Phase 5.7.3 W4.
 *
 * 옛 evolver.test.ts 안 단계 4 (purgeOldArchive + soonToPurgeCount) 단위
 * 정신을 trash-manager 분리 산출에 정착. 단계 1+2+3+5 는 W2
 * auto-cleanup-runner.test.ts 가 담당.
 *
 * 결정성 확보 전략:
 *  - 실 SqliteMemoryStore (in-memory DB) + 실 Bgem3Embedder 사용 — W2 패턴 정합.
 *  - archived_at 컬럼 직접 UPDATE 로 35일+ archive / 7일 안 임박 archive 재현.
 *  - startTrashCron mock 시각 + setTimeout 주입 패턴 (W3 trigger 패턴 정합).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { EventRepository } from "../db/store-internal/event-repository.ts";
import { setTimeZone } from "../db/store-internal/helpers.ts";
import {
  runTrashManagement,
  startTrashCron,
  type TrashActivitySummary,
  type TrashCronOptions,
} from "./trash-manager.ts";

// bge-m3 임베딩 dim — 기준 스키마 vec_nodes float[1024] 와 정합.
const DIM = 1024;

function basisVector(index: number): Float32Array {
  const v = new Float32Array(DIM);
  v[index] = 1.0;
  return v;
}

/** archived_at 직접 UPDATE — N일 전 시각 SQLite 형식. */
function setArchivedAtDaysAgo(db: Database, id: number, daysAgo: number): void {
  const ts = new Date(Date.now() - daysAgo * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  db.prepare("UPDATE knowledge_nodes_archive SET archived_at = ? WHERE id = ?").run(ts, id);
}

let embedder: Bgem3Embedder;
let db: Database;
let store: SqliteMemoryStore;

beforeAll(() => {
  embedder = new Bgem3Embedder(); // load() 호출 안 함 — embedding 직접 주입
});

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
});

afterEach(() => {
  db.close();
});

describe("runTrashManagement", () => {
  test("빈 휴지통 가동 시 summary = nodesPurged:0 + soonToPurgeCount:0 + durationMs 측정값", async () => {
    const summary = await runTrashManagement(store, {
      retentionDays: 30,
      warningDays: 7,
    });

    expect(summary.nodesPurged).toBe(0);
    expect(summary.soonToPurgeCount).toBe(0);
    expect(typeof summary.startedAt).toBe("string");
    expect(summary.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof summary.durationMs).toBe("number");
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("35일 archive 노드 → 영구 삭제 + summary.nodesPurged = 1", async () => {
    const id = await store.addNode({
      content: "옛 노드",
      importance: 0.1,
      embedding: basisVector(0),
    });
    await store.trashNodes([id], "cascade");
    setArchivedAtDaysAgo(db, id, 35);

    const summary = await runTrashManagement(store, {
      retentionDays: 30,
      warningDays: 7,
    });

    expect(summary.nodesPurged).toBe(1);
    expect(summary.soonToPurgeCount).toBe(0);

    // archive 테이블에 잔존 노드 없음
    const remaining = await store.getArchive();
    expect(remaining.find((n) => n.id === id)).toBeUndefined();
  });

  test("25일 archive 노드 → 영구 삭제 임박 → summary.soonToPurgeCount = 1", async () => {
    const id = await store.addNode({
      content: "임박 노드",
      importance: 0.1,
      embedding: basisVector(1),
    });
    await store.trashNodes([id], "cascade");
    setArchivedAtDaysAgo(db, id, 25); // 25 + 7 = 32 > 30 → 임박 윈도우 안

    const summary = await runTrashManagement(store, {
      retentionDays: 30,
      warningDays: 7,
    });

    expect(summary.nodesPurged).toBe(0);
    expect(summary.soonToPurgeCount).toBe(1);

    // 임박 노드는 아직 잔존
    const remaining = await store.getArchive();
    expect(remaining.find((n) => n.id === id)).toBeDefined();
  });

  test("활동 로그 한 줄 추가 — evolver_activity 테이블 안 nodes_purged + soon_to_purge_count 컬럼 채움", async () => {
    const id = await store.addNode({
      content: "삭제 대상",
      importance: 0.1,
      embedding: basisVector(2),
    });
    await store.trashNodes([id], "cascade");
    setArchivedAtDaysAgo(db, id, 40);

    await runTrashManagement(store, { retentionDays: 30, warningDays: 7 });

    const acts = await store.getEvolverActivity(5);
    expect(acts.length).toBeGreaterThanOrEqual(1);
    expect(acts[0]!.nodesPurged).toBe(1);
    expect(acts[0]!.clusterEdgesAdded).toBe(0); // W4 산출은 cluster 정보 미보유
    expect(acts[0]!.nodesArchived).toBe(0);
  });
});

// ── startTrashCron — mock 시각 + setTimeout 주입 패턴 ──────────────────────

/** FakeClock — W3 auto-cleanup-trigger.test.ts 패턴 재사용. */
class FakeClock {
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

  /** 가상 시각을 deltaMs 전진 + 발사 시각 도달 timer 다 호출 (FIFO 정합). */
  async advance(deltaMs: number): Promise<void> {
    this.nowMs += deltaMs;
    const fired: Array<() => void> = [];
    for (const [handle, t] of [...this.timers]) {
      if (t.fireAtMs <= this.nowMs) {
        fired.push(t.fn);
        this.timers.delete(handle);
      }
    }
    for (const fn of fired) fn();
    // runTrashManagement 안 async chain (purgeOldArchive / getArchiveSoonToPurge /
    // logTrashActivity) 마이크로태스크 flush.
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  pendingTimerCount(): number {
    return this.timers.size;
  }

  /** 단일 pending timer 의 지연값 (밀리초). 없거나 2개 이상이면 -1. */
  singleTimerDelayMs(): number {
    if (this.timers.size !== 1) return -1;
    const t = [...this.timers.values()][0]!;
    return t.fireAtMs - this.nowMs;
  }
}

describe("startTrashCron", () => {
  test("cronTime = '03:00' + 현재 04:00 KST → 다음 가동 = 23h 후", () => {
    // 본인 PC TZ = KST 정합 — A1 systemd Environment=TZ=Asia/Seoul 동일.
    // 04:00 KST 시점 = startMs 임의값 + Date 인스턴스 hh = 4 강제.
    const targetNow = new Date();
    targetNow.setHours(4, 0, 0, 0); // 로컬 04:00:00.000
    const startMs = targetNow.getTime();
    const clock = new FakeClock(startMs);

    // FakeClock.now 만으로 new Date() 가 동일 시각 되지 않으므로 옛
    // Date.now 직접 mocking 없이 검증 갈래 = scheduleNext 의 첫 호출 직후
    // singleTimerDelayMs 확인. 본 테스트 가동 시점 (Date.now) 의 시/분 값을
    // 기준 시각으로 사용 — cronTime 이 현재 시각보다 과거면 다음 날 가동.
    const handle = startTrashCron({
      cronTime: "03:00",
      store,
      managementOptions: { retentionDays: 30, warningDays: 7 },
      enabled: () => true,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      // FakeClock.now 가 보존한 startMs 를 기준으로 다음 가동 시각 계산.
      timeSource: () => new Date(clock.nowMs),
    });

    // 현재 04:00 → 다음 03:00 = 다음 날 = 23시간 후.
    const expectedDelay = 23 * 3600 * 1000;
    const tolerance = 60 * 1000; // 1분 허용 — 초/밀리초 자투리
    const actualDelay = clock.singleTimerDelayMs();

    expect(actualDelay).toBeGreaterThanOrEqual(expectedDelay - tolerance);
    expect(actualDelay).toBeLessThanOrEqual(expectedDelay + tolerance);

    handle.stop();
  });

  test("cronTime = '03:00' + 현재 02:00 → 다음 가동 = 1h 후 (같은 날)", () => {
    const targetNow = new Date();
    targetNow.setHours(2, 0, 0, 0);
    const startMs = targetNow.getTime();
    const clock = new FakeClock(startMs);

    const handle = startTrashCron({
      cronTime: "03:00",
      store,
      managementOptions: { retentionDays: 30, warningDays: 7 },
      enabled: () => true,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      timeSource: () => new Date(clock.nowMs),
    });

    const expectedDelay = 1 * 3600 * 1000;
    const tolerance = 60 * 1000;
    const actualDelay = clock.singleTimerDelayMs();

    expect(actualDelay).toBeGreaterThanOrEqual(expectedDelay - tolerance);
    expect(actualDelay).toBeLessThanOrEqual(expectedDelay + tolerance);

    handle.stop();
  });

  test("tickNow() 직접 호출 → 즉시 runTrashManagement 가동 + summary 반환", async () => {
    const id = await store.addNode({
      content: "tickNow 검증",
      importance: 0.1,
      embedding: basisVector(3),
    });
    await store.trashNodes([id], "cascade");
    setArchivedAtDaysAgo(db, id, 40);

    const targetNow = new Date();
    targetNow.setHours(4, 0, 0, 0);
    const startMs = targetNow.getTime();
    const clock = new FakeClock(startMs);

    const handle = startTrashCron({
      cronTime: "03:00",
      store,
      managementOptions: { retentionDays: 30, warningDays: 7 },
      enabled: () => true,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      timeSource: () => new Date(clock.nowMs),
    });

    const summary = await handle.tickNow();
    expect(summary).not.toBeNull();
    expect(summary!.nodesPurged).toBe(1);

    handle.stop();
  });

  test("enabled() = false 토글 → cron timer 발사 시점에도 가동 0", async () => {
    const id = await store.addNode({
      content: "OFF 토글 검증",
      importance: 0.1,
      embedding: basisVector(4),
    });
    await store.trashNodes([id], "cascade");
    setArchivedAtDaysAgo(db, id, 40);

    const targetNow = new Date();
    targetNow.setHours(2, 0, 0, 0);
    const startMs = targetNow.getTime();
    const clock = new FakeClock(startMs);

    const handle = startTrashCron({
      cronTime: "03:00",
      store,
      managementOptions: { retentionDays: 30, warningDays: 7 },
      enabled: () => false, // OFF
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      timeSource: () => new Date(clock.nowMs),
    });

    // 1시간 후 timer 발사 시점까지 전진 — runTrashManagement 호출 안 됨.
    await clock.advance(1 * 3600 * 1000 + 60 * 1000);

    // archive 35일+ 노드 그대로 잔존 (영구 삭제 안 함).
    const remaining = await store.getArchive();
    expect(remaining.find((n) => n.id === id)).toBeDefined();

    // 활동 로그도 한 줄 추가 X.
    const acts = await store.getEvolverActivity(5);
    expect(acts).toHaveLength(0);

    handle.stop();
  });

  test("stop() → pending timer 정리 + 가동 차단", async () => {
    const targetNow = new Date();
    targetNow.setHours(2, 0, 0, 0);
    const clock = new FakeClock(targetNow.getTime());

    const handle = startTrashCron({
      cronTime: "03:00",
      store,
      managementOptions: { retentionDays: 30, warningDays: 7 },
      enabled: () => true,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      timeSource: () => new Date(clock.nowMs),
    });

    expect(clock.pendingTimerCount()).toBe(1);

    handle.stop();
    expect(clock.pendingTimerCount()).toBe(0);

    // stop 후 시간 전진해도 가동 0.
    await clock.advance(24 * 3600 * 1000);
    const acts = await store.getEvolverActivity(5);
    expect(acts).toHaveLength(0);
  });

  test("timer 발사 후 한 사이클 가동 → 다음 가동 시각 = 24h 후 재예약", async () => {
    const id = await store.addNode({
      content: "재예약 검증",
      importance: 0.1,
      embedding: basisVector(5),
    });
    await store.trashNodes([id], "cascade");
    setArchivedAtDaysAgo(db, id, 40);

    const targetNow = new Date();
    targetNow.setHours(2, 0, 0, 0); // 다음 가동 = 1시간 후
    const clock = new FakeClock(targetNow.getTime());

    const handle = startTrashCron({
      cronTime: "03:00",
      store,
      managementOptions: { retentionDays: 30, warningDays: 7 },
      enabled: () => true,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      timeSource: () => new Date(clock.nowMs),
    });

    // 첫 timer 발사 — 1시간 + 자투리 전진.
    await clock.advance(1 * 3600 * 1000 + 60 * 1000);

    // 한 사이클 가동 정착 — archive 35일+ 노드 영구 삭제 + 활동 로그 한 줄.
    const acts = await store.getEvolverActivity(5);
    expect(acts.length).toBeGreaterThanOrEqual(1);
    expect(acts[0]!.nodesPurged).toBe(1);

    // 다음 가동 timer 재예약 정합 — 현재 03:01 (= 1h + 60s 전진 후) 시점에
    // 03:00 cron 은 이미 과거 → 다음 03:00 = 다음 날 = 약 24h - 60s 후.
    const expectedNext = 24 * 3600 * 1000 - 60 * 1000;
    const tolerance = 5 * 60 * 1000; // 5분 허용 — 가동 + 자투리 변동
    const actualNext = clock.singleTimerDelayMs();
    expect(actualNext).toBeGreaterThanOrEqual(expectedNext - tolerance);
    expect(actualNext).toBeLessThanOrEqual(expectedNext + tolerance);

    handle.stop();
  });

  test("TrashCronOptions 안 timeSource 미주입 시 default = new Date() — 실 가동 흐름 정합", () => {
    // 본 단위는 timeSource 옵션이 정확히 선택적 정합 검증. cron 가동 즉시
    // stop 호출로 실 timer 정리.
    const handle = startTrashCron({
      cronTime: "03:00",
      store,
      managementOptions: { retentionDays: 30, warningDays: 7 },
      enabled: () => true,
    } as TrashCronOptions);

    // pending timer 한 개 등록 (실 setTimeout 사용 — clock 검사 X).
    handle.stop(); // 실 timer 정리.
  });

  test("type 검증 — TrashActivitySummary 7 필드 (P3 G3-c events 2필드, WP-B1-20U assetCleanup 추가)", async () => {
    const summary: TrashActivitySummary = await runTrashManagement(store, {
      retentionDays: 30,
      warningDays: 7,
    });

    // 타입 표면 = archive 4필드 + P3 G3-c events 2필드(eventsPurged / eventsClampedToCursor)
    // + WP-B1-20U 설계 17.17 첨부 파일 정리 1필드(assetCleanup).
    expect(Object.keys(summary).sort()).toEqual(
      [
        "assetCleanup",
        "durationMs",
        "eventsClampedToCursor",
        "eventsPurged",
        "nodesPurged",
        "soonToPurgeCount",
        "startedAt",
      ].sort(),
    );
    // clusterEdgesAdded / nodesArchived 필드 X (W2 산출과 분리).
    expect((summary as unknown as Record<string, unknown>).clusterEdgesAdded).toBeUndefined();
    expect((summary as unknown as Record<string, unknown>).nodesArchived).toBeUndefined();
    // 빈 휴지통 — 해제한 첨부가 없다.
    expect(summary.assetCleanup).toEqual({ documentIds: [], removedSha256s: [], missingSha256s: [], failed: [] });
    // eventsStore 미주입이면 events 정리 미가동 — 0 + 커서 침범 없음.
    expect(summary.eventsPurged).toBe(0);
    expect(summary.eventsClampedToCursor).toBe(false);
  });
});

// ── P3 G3-c — events 보존 정리가 trash cron 사이클에 합류 ────────────────────

describe("runTrashManagement — events 보존 정리 합류(P3 G3-c)", () => {
  test("eventsStore 미주입이면 events 정리 미가동 — eventsPurged=0", async () => {
    const summary = await runTrashManagement(store, {
      retentionDays: 30,
      warningDays: 7,
      eventsRetentionDays: 90,
    });
    expect(summary.eventsPurged).toBe(0);
  });

  test("eventsStore + eventsRetentionDays 주입 시 오래된 events 를 같은 사이클에 정리", async () => {
    setTimeZone("Asia/Seoul");
    const eventRepo = new EventRepository(db);
    // 100일 전 이벤트 직접 삽입 + 방금 이벤트 하나.
    const oldTs = new Date(Date.now() - 100 * 24 * 3600 * 1000).toLocaleString(
      "sv-SE",
      { timeZone: "Asia/Seoul", hour12: false },
    );
    db.query(
      "INSERT INTO events (type, payload_json, created_at) VALUES (?, ?, ?)",
    ).run("old", "{}", oldTs);
    eventRepo.append("fresh", {});

    const summary = await runTrashManagement(
      store,
      { retentionDays: 30, warningDays: 7, eventsRetentionDays: 90 },
      eventRepo,
    );

    expect(summary.eventsPurged).toBe(1);
    expect(summary.eventsClampedToCursor).toBe(false);
    // fresh 만 남는다.
    expect(eventRepo.listSince(0).map((e) => e.type)).toEqual(["fresh"]);
    setTimeZone("Asia/Seoul");
  });

  test("무제한(-1)이면 events 삭제 0 — eventsPurged=0", async () => {
    setTimeZone("Asia/Seoul");
    const eventRepo = new EventRepository(db);
    const oldTs = new Date(Date.now() - 1000 * 24 * 3600 * 1000).toLocaleString(
      "sv-SE",
      { timeZone: "Asia/Seoul", hour12: false },
    );
    db.query(
      "INSERT INTO events (type, payload_json, created_at) VALUES (?, ?, ?)",
    ).run("ancient", "{}", oldTs);

    const summary = await runTrashManagement(
      store,
      { retentionDays: 30, warningDays: 7, eventsRetentionDays: -1 },
      eventRepo,
    );

    expect(summary.eventsPurged).toBe(0);
    expect(eventRepo.listSince(0)).toHaveLength(1);
    setTimeZone("Asia/Seoul");
  });
});
