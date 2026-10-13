import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../migrations.ts";
import {
  DEFAULT_EVENT_LIMIT,
  EVENTS_RETENTION_UNLIMITED,
  EventRepository,
} from "./event-repository.ts";
import { getConfiguredTimeZone, setTimeZone } from "./helpers.ts";

let db: Database;
let repo: EventRepository;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
  repo = new EventRepository(db);
});

afterEach(() => {
  db.close();
  // 전역 zone 오염 차단 — 다른 테스트가 KST 를 가정한다.
  setTimeZone("Asia/Seoul");
});

describe("EventRepository", () => {
  test("(1) append — 단조 증가 id 회신 + 행 적재", () => {
    const id1 = repo.append("cleanup_proposals_ready", { count: 3 });
    const id2 = repo.append("cleanup_proposals_ready", { count: 1 });
    // AUTOINCREMENT 라 두 번째 id 가 첫 번째보다 크다(SSE 커서 단조성).
    expect(id2).toBeGreaterThan(id1);

    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
    expect(cnt).toBe(2);
  });

  test("(2) append — payload JSON 직렬화 + created_at 채움", () => {
    const id = repo.append("cleanup_proposals_ready", { count: 5, kind: "metadata_fill" });
    const row = db
      .prepare("SELECT type, payload_json, created_at FROM events WHERE id = ?")
      .get(id) as { type: string; payload_json: string; created_at: string };
    expect(row.type).toBe("cleanup_proposals_ready");
    expect(JSON.parse(row.payload_json)).toEqual({ count: 5, kind: "metadata_fill" });
    // P3 G3-c — append 가 nowInZone(설정 zone)을 명시 저장 → "YYYY-MM-DD HH:MM:SS".
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("(3) listSince — lastId 초과 이벤트만 id 오름차순", () => {
    const id1 = repo.append("a", { n: 1 });
    const id2 = repo.append("b", { n: 2 });
    const id3 = repo.append("c", { n: 3 });

    // id1 다음부터 이어받기 — id2·id3 만, 오름차순.
    const since1 = repo.listSince(id1);
    expect(since1.map((e) => e.id)).toEqual([id2, id3]);
    expect(since1.map((e) => e.type)).toEqual(["b", "c"]);
    expect(since1[0]!.payload).toEqual({ n: 2 });

    // id3 다음 = 새 이벤트 없음(진짜 빈 상태 — 실패 위장 아님).
    expect(repo.listSince(id3)).toEqual([]);

    // 0 부터 = 전부.
    expect(repo.listSince(0).map((e) => e.id)).toEqual([id1, id2, id3]);
  });

  test("(4) listSince limit — 초과분 중 앞에서 limit 개만", () => {
    const first = repo.append("ev", { i: 0 });
    const second = repo.append("ev", { i: 1 });
    for (let i = 2; i < 5; i++) repo.append("ev", { i });

    const page = repo.listSince(0, 2);
    expect(page.map((e) => e.id)).toEqual([first, second]);
  });

  test("(5) listSince — limit 미지정 시 DEFAULT_EVENT_LIMIT", () => {
    for (let i = 0; i < 3; i++) repo.append("ev", { i });
    // 기본값(100)이 3건보다 크므로 전부 회신 — 기본값 경로 가동 확인.
    const all = repo.listSince(0);
    expect(all.length).toBe(3);
    expect(DEFAULT_EVENT_LIMIT).toBe(100);
  });

  test("(6) listRecent — 최신 id 내림차순 limit 개", () => {
    const id1 = repo.append("a", { n: 1 });
    const id2 = repo.append("b", { n: 2 });
    const id3 = repo.append("c", { n: 3 });

    const recent = repo.listRecent(2);
    // id DESC — 가장 새 이벤트가 첫 원소.
    expect(recent.map((e) => e.id)).toEqual([id3, id2]);
    expect(recent[0]!.type).toBe("c");
    void id1;
  });

  test("(7) listRecent — 빈 큐는 빈 배열(진짜 빈 상태)", () => {
    expect(repo.listRecent()).toEqual([]);
  });
});

/**
 * 설정 zone 기준 N일 전 시각을 events.created_at 양식("YYYY-MM-DD HH:MM:SS")으로.
 * append 가 실제로 쓰는 nowInZone(설정 zone)과 같은 zone 이라 컷오프 비교가 정확하다.
 */
function pastInZone(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 3600 * 1000).toLocaleString(
    "sv-SE",
    { timeZone: getConfiguredTimeZone(), hour12: false },
  );
}

/** 지정 created_at 으로 events 행을 직접 넣는다(과거 시각 시뮬레이션). id 반환. */
function insertEventAt(db: Database, type: string, createdAt: string): number {
  const r = db
    .query("INSERT INTO events (type, payload_json, created_at) VALUES (?, ?, ?)")
    .run(type, "{}", createdAt);
  return Number(r.lastInsertRowid);
}

describe("purgeOldEvents — 보존정책(P3 G3-c)", () => {
  test("retentionDays 지난 이벤트만 삭제, 최근 이벤트는 남긴다", () => {
    setTimeZone("Asia/Seoul");
    const old1 = insertEventAt(db, "old", pastInZone(100));
    const old2 = insertEventAt(db, "old", pastInZone(95));
    repo.append("fresh", { n: 1 }); // 방금(설정 zone) — 보존
    void old2;

    const result = repo.purgeOldEvents(90);
    expect(result.deleted).toBe(2);
    expect(result.skippedUnlimited).toBe(false);
    expect(result.clampedToCursor).toBe(false);
    // 최근 이벤트만 남는다.
    const remaining = repo.listSince(0);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.type).toBe("fresh");
    void old1;
  });

  test("무제한 sentinel(-1)이면 삭제 0 — 정직한 비활성", () => {
    setTimeZone("Asia/Seoul");
    insertEventAt(db, "ancient", pastInZone(1000));
    const result = repo.purgeOldEvents(EVENTS_RETENTION_UNLIMITED);
    expect(result.deleted).toBe(0);
    expect(result.skippedUnlimited).toBe(true);
    expect(repo.listSince(0)).toHaveLength(1);
  });

  test("UTC zone: 저장·컷오프가 함께 이동해도 정확히 걸린다", () => {
    setTimeZone("UTC");
    insertEventAt(db, "old", pastInZone(100));
    repo.append("fresh", {}); // nowInZone(UTC)
    const result = repo.purgeOldEvents(90);
    expect(result.deleted).toBe(1);
    const remaining = repo.listSince(0);
    expect(remaining.map((e) => e.type)).toEqual(["fresh"]);
  });

  test("재연결 커서 보호: protectAfterId 이후 이벤트는 시간과 무관하게 남긴다", () => {
    setTimeZone("Asia/Seoul");
    // 셋 다 100일 전(보존 창 밖)이지만, 커서(cursorId) 이후 둘은 재연결 이어받기
    // 대상이라 지우면 "유실 0" 계약이 깨진다.
    const before = insertEventAt(db, "before-cursor", pastInZone(100));
    const cursorId = insertEventAt(db, "at-cursor", pastInZone(100));
    const after1 = insertEventAt(db, "after-cursor-1", pastInZone(100));
    const after2 = insertEventAt(db, "after-cursor-2", pastInZone(100));
    void before;
    void after1;
    void after2;

    const result = repo.purgeOldEvents(90, cursorId);
    // cursorId 이하(before + at-cursor)만 삭제. after 둘은 시간 밖이어도 보호.
    expect(result.deleted).toBe(2);
    // 컷오프만으로는 after 둘도 지웠을 것이므로 커서 침범 신호 true.
    expect(result.clampedToCursor).toBe(true);
    const remaining = repo.listSince(0);
    expect(remaining.map((e) => e.type)).toEqual([
      "after-cursor-1",
      "after-cursor-2",
    ]);
  });

  test("커서 보호: 삭제 대상이 전부 커서 이하면 clampedToCursor=false", () => {
    setTimeZone("Asia/Seoul");
    const a = insertEventAt(db, "old-a", pastInZone(100));
    const b = insertEventAt(db, "old-b", pastInZone(95));
    // 커서를 가장 최근 id 로 두면 삭제 대상(둘 다)이 전부 커서 이하 — 침범 없음.
    const result = repo.purgeOldEvents(90, b);
    expect(result.deleted).toBe(2);
    expect(result.clampedToCursor).toBe(false);
    void a;
  });

  test("retentionDays=0 이면 방금 이벤트를 뺀 모든 과거를 삭제(경계)", () => {
    setTimeZone("Asia/Seoul");
    insertEventAt(db, "yesterday", pastInZone(1));
    // 0일 컷오프 = 지금(설정 zone). 1일 전은 컷오프 미만이라 삭제.
    const result = repo.purgeOldEvents(0);
    expect(result.deleted).toBe(1);
  });
});
