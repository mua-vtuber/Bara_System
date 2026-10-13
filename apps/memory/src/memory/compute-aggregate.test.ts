/**
 * memory/compute-aggregate.test.ts — computeAggregate 실 SQLite 통합 검증 (단계5 T3).
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder. mock 0. 검증 항목(D4):
 *   (a) list = 후보 전부 나열 + created_at DESC
 *   (b) count = 개수 정확(노드 실체화 불요)
 *   (c) timeline = COALESCE(event_at, created_at) ASC 정렬 순서 정확
 *   (d) event_at 없는 노드는 created_at fallback 으로 정렬(정직한 근사)
 *   (e) log = timeline 과 같은 시간순 정렬(메타만 다름)
 *   (f) 후보 0개 → count 0·빈 목록(정직한 빈 상태)
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { computeAggregate } from "./compute-aggregate.ts";
import type { ComputeIntent } from "./compute-intent.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

const intent = (kind: ComputeIntent["kind"]): ComputeIntent => ({
  kind,
  matched: [kind],
});

describe("computeAggregate — 집계 종류별(D4)", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => db.close());

  /** event_at 을 직접 지정해 노드 하나 만들고 id 반환. */
  async function node(content: string, eventAt?: string): Promise<number> {
    return store.addNode({ content, eventAt });
  }

  test("(a) list = 후보 전부 나열 + created_at DESC", async () => {
    const a = await node("글1");
    const b = await node("글2");
    const c = await node("글3");
    const r = await computeAggregate(intent("list"), new Set([a, b, c]), store);
    expect(r.kind).toBe("list");
    expect(r.count).toBe(3);
    expect(r.orderedBy).toBe("created_desc");
    // 같은 created_at(같은 초)이면 id DESC → c, b, a.
    expect(r.items.map((n) => n.id)).toEqual([c, b, a]);
  });

  test("(b) count = 개수 정확(노드 실체화 불요·items 빈 배열)", async () => {
    const a = await node("글1");
    const b = await node("글2");
    const r = await computeAggregate(intent("count"), new Set([a, b]), store);
    expect(r.kind).toBe("count");
    expect(r.count).toBe(2);
    expect(r.items).toEqual([]);
    expect(r.orderedBy).toBe("none");
  });

  test("(c) timeline = event_at ASC 정렬 순서 정확", async () => {
    const late = await node("늦은 사건", "2026-05-20");
    const early = await node("이른 사건", "2026-05-01");
    const mid = await node("중간 사건", "2026-05-10");
    const r = await computeAggregate(
      intent("timeline"),
      new Set([late, early, mid]),
      store,
    );
    expect(r.kind).toBe("timeline");
    expect(r.orderedBy).toBe("event_asc");
    expect(r.items.map((n) => n.id)).toEqual([early, mid, late]);
  });

  test("(d) event_at 없는 노드는 created_at fallback 으로 정렬", async () => {
    // event_at 있는 노드(미래 사건) + 없는 노드(created_at = now 근방).
    const withEvent = await node("미래 사건", "2099-01-01");
    const noEvent = await node("사건 시각 없음"); // created_at = now (< 2099)
    const r = await computeAggregate(
      intent("timeline"),
      new Set([withEvent, noEvent]),
      store,
    );
    // noEvent 의 created_at(now) < withEvent 의 event_at(2099) → noEvent 가 먼저.
    expect(r.items.map((n) => n.id)).toEqual([noEvent, withEvent]);
  });

  test("(e) log = timeline 과 같은 시간순 정렬(메타만 다름)", async () => {
    const late = await node("나중 작업", "2026-06-10");
    const early = await node("먼저 작업", "2026-06-01");
    const r = await computeAggregate(
      intent("log"),
      new Set([late, early]),
      store,
    );
    expect(r.kind).toBe("log");
    expect(r.orderedBy).toBe("event_asc");
    expect(r.items.map((n) => n.id)).toEqual([early, late]);
  });

  test("(f) 후보 0개 → count 0·빈 목록(정직한 빈 상태)", async () => {
    const r = await computeAggregate(intent("list"), new Set(), store);
    expect(r.count).toBe(0);
    expect(r.items).toEqual([]);
  });

  test("getNodesByIds 순서 미보존을 집계기가 보정(입력 역순이어도 정렬 일관)", async () => {
    const early = await node("이른", "2026-05-01");
    const late = await node("늦은", "2026-05-30");
    // 입력 Set 순서를 역으로 줘도 event_asc 정렬은 early, late.
    const r = await computeAggregate(
      intent("timeline"),
      new Set([late, early]),
      store,
    );
    expect(r.items.map((n) => n.id)).toEqual([early, late]);
  });
});
