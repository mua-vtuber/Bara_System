/**
 * server-internal/routes/tag-suggest.test.ts — # 태그 자동완성 데이터 통로 통합 검증
 * (그래프 입력 해시태그 개편 S6 / 결정 3).
 *
 * 검증 가족:
 *   (a) GET /api/tag-suggest → 200 + {tags:[{name,count}]} (저장된 개념의 name + usage_count).
 *   (b) 정렬 — listConcepts 의 tag_usage_count DESC 를 그대로 보존(자주 쓴 태그가 위로).
 *   (c) ?prefix=작업 → 접두 일치만(서버 통로). 빈 접두면 전체.
 *   (d) 후보 0건 → 빈 배열(가짜 항목 0 · 정직한 빈 상태).
 *   (e) store(listConcepts) 미주입 → 503(빈 배열 위장 금지 · No-fallback).
 *
 * 실 SQLite(:memory:) + 실 SqliteMemoryStore + 실 concept 노드. mock 0 — 개념을 실제로
 * 저장해 라우트가 그 데이터를 정직히 회신하는지 본다(인터페이스 mock 구현체 없음·정책).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi } from "../../server.ts";
import { registerTagSuggestRoutes } from "./tag-suggest.ts";
import type { MemoryApiDeps } from "../types.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
}

function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const app = buildMemoryApi({ store, retriever, assembler });
  return { app, db, store };
}

interface SuggestResponse {
  tags: Array<{ name: string; count: number }>;
}

describe("tag-suggest 라우트", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.db.close();
  });

  test("GET /api/tag-suggest → 200 + 저장된 개념을 {name,count} 로 회신", async () => {
    // 태그 개념 두 개를 실제로 저장한다(usage_count 1 씩 — findOrCreateTagConcept 가 증가).
    await h.store.findOrCreateTagConcept("작업컴퓨터");
    await h.store.findOrCreateTagConcept("치과");

    const res = await h.app.request("/api/tag-suggest");
    expect(res.status).toBe(200);
    const json = (await res.json()) as SuggestResponse;
    const names = json.tags.map((t) => t.name).sort();
    expect(names).toEqual(["작업컴퓨터", "치과"]);
    // count 칸이 usage_count(합)를 들고 온다 — 한 번 저장이라 1 이상.
    for (const tag of json.tags) {
      expect(tag.count).toBeGreaterThanOrEqual(1);
    }
  });

  test("정렬 — 자주 쓴 태그가 위로(tag_usage_count DESC 보존)", async () => {
    // 작업컴퓨터를 세 번 저장(usage_count 누적), 치과는 한 번 — 정렬상 작업컴퓨터가 위.
    await h.store.findOrCreateTagConcept("작업컴퓨터");
    await h.store.findOrCreateTagConcept("작업컴퓨터");
    await h.store.findOrCreateTagConcept("작업컴퓨터");
    await h.store.findOrCreateTagConcept("치과");

    const res = await h.app.request("/api/tag-suggest");
    const json = (await res.json()) as SuggestResponse;
    expect(json.tags[0]?.name).toBe("작업컴퓨터");
    expect(json.tags[0]!.count).toBeGreaterThan(json.tags[1]!.count);
  });

  test("?prefix=작업 → 접두 일치만(서버 통로)", async () => {
    await h.store.findOrCreateTagConcept("작업컴퓨터");
    await h.store.findOrCreateTagConcept("치과");

    const res = await h.app.request("/api/tag-suggest?prefix=" + encodeURIComponent("작업"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as SuggestResponse;
    expect(json.tags.map((t) => t.name)).toEqual(["작업컴퓨터"]);
  });

  test("빈 prefix → 전체 회신(거르지 않는다)", async () => {
    await h.store.findOrCreateTagConcept("작업컴퓨터");
    await h.store.findOrCreateTagConcept("치과");

    const res = await h.app.request("/api/tag-suggest?prefix=" + encodeURIComponent("   "));
    const json = (await res.json()) as SuggestResponse;
    expect(json.tags.length).toBe(2);
  });

  test("후보 0건 → 빈 배열(정직한 빈 상태)", async () => {
    const res = await h.app.request("/api/tag-suggest");
    expect(res.status).toBe(200);
    const json = (await res.json()) as SuggestResponse;
    expect(json.tags).toEqual([]);
  });
});

describe("tag-suggest 라우트 — store 미주입 503", () => {
  // listConcepts 가 없는 deps 로 라우트만 단독 등록해, 가드가 빈 배열로 가리지 않고 정직히
  // 503 을 내는지 본다(실제 부팅에선 store 가 항상 있으나, 가드 자체가 silent fallback 금지
  // 보장으로 존재해야 한다 · entity-types 503 가드 양식 미러).
  function appWithoutStore(): Hono {
    const app = new Hono({ strict: false });
    const deps = {
      store: {} as MemoryApiDeps["store"],
    } as unknown as MemoryApiDeps;
    registerTagSuggestRoutes(app, deps);
    return app;
  }

  test("GET = 503", async () => {
    const res = await appWithoutStore().request("/api/tag-suggest");
    expect(res.status).toBe(503);
  });
});
