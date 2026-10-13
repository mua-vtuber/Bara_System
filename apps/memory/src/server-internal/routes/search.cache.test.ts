/**
 * server-internal/routes/search.cache.test.ts — POST /search 캐시 wiring 검증 (6b T3).
 *
 * R4 검증 항목 (spec 10.2.3 / 10.2.4):
 *   1. 같은 query 2회 → 2번째는 retriever 재실행 없이 캐시 hit(retriever 호출
 *      횟수 spy 로 확인). 결과·점수는 1회차와 완전 동일.
 *   2. addNode 후 같은 query → db_revision 이 올라 캐시 키가 달라져 miss → 새 결과.
 *   3. 회귀 0 — 캐시를 거친 검색 결과·점수가 캐시 없이 직접 retrieve 한 결과와 동일.
 *   4. db_revision getter 가 addNode / deleteNode / updateNodeImportance 후 단조 증가.
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder + 실 SearchCache. mock 없음.
 * retriever 호출 횟수는 *실제* HybridRetriever 인스턴스의 retrieve 메서드를 감싼
 * 카운터로 측정한다(가짜 구현체 아님 — 실제 메서드를 그대로 호출하며 횟수만 센다).
 */

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
import type { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { SearchCache } from "../../memory/search-cache.ts";
import { buildMemoryApi } from "../../server.ts";

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
  searchCache: SearchCache;
  /** 실제 retriever.retrieve 호출 횟수 — 캐시 hit 판정용. */
  retrieveCalls: () => number;
}

/**
 * 실제 HybridRetriever 의 retrieveWithStats 를 감싸 호출 횟수만 센다. 반환값·인자·
 * 동작은 원본 그대로 — 가짜 구현체가 아니라 실제 메서드를 그대로 호출하는 counting
 * spy. T10 이전에는 search-retrieval.ts 가 retrieve() 를 직접 불렀지만, T10 이후는
 * retrieveWithStats() 를 부른다(retrieve() 는 그 위의 얇은 래퍼로 바뀜) — 캐시
 * hit/miss 계측 지점을 실제 호출 경로에 맞춘다.
 */
function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  let calls = 0;
  const realRetrieveWithStats = retriever.retrieveWithStats.bind(retriever);
  retriever.retrieveWithStats = ((query, options) => {
    calls += 1;
    return realRetrieveWithStats(query, options);
  }) as typeof retriever.retrieveWithStats;
  const assembler = new ContextAssembler();
  const searchCache = new SearchCache();
  const app = buildMemoryApi({ store, retriever, assembler, searchCache });
  return { app, db, store, searchCache, retrieveCalls: () => calls };
}

interface SearchResultRow {
  id: number;
  content: string;
  score: number;
  sources: string[];
  components: Record<string, number>;
  concepts: { direct: unknown[]; neighbors: unknown[] };
}
interface SearchResponse {
  query: string;
  count: number;
  results: SearchResultRow[];
}

async function postSearch(
  h: Harness,
  payload: Record<string, unknown>,
): Promise<SearchResponse> {
  const res = await h.app.request("/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SearchResponse;
}

async function ingestDirect(h: Harness, content: string): Promise<number> {
  return h.store.addNode({ content });
}

// ── db_revision 카운터 (store 단위) ────────────────────────────────────────

describe("store.getDbRevision — CRUD 후 단조 증가", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("addNode / updateNodeImportance / deleteNode 각각 revision 을 올린다", async () => {
    const r0 = h.store.getDbRevision();
    const id = await h.store.addNode({ content: "리비전 카운터 검증 자산" });
    const r1 = h.store.getDbRevision();
    expect(r1).toBeGreaterThan(r0);

    await h.store.updateNodeImportance(id, 0.9);
    const r2 = h.store.getDbRevision();
    expect(r2).toBeGreaterThan(r1);

    await h.store.deleteNode(id);
    const r3 = h.store.getDbRevision();
    expect(r3).toBeGreaterThan(r2);
  });
});

// ── 캐시 hit / miss / 회귀 ───────────────────────────────────────────────────

describe("POST /search — R4 캐시 hit/miss/회귀 (6b T3)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness();
    await ingestDirect(h, "bara_system 은 검색 기능을 제공하는 메모리 모듈이다");
    await ingestDirect(h, "커피를 마시며 코드를 작성했다");
    await ingestDirect(h, "분산 시스템 설계를 검토했다");
  });
  afterEach(() => {
    h.db.close();
  });

  test("같은 query 2회 — 2번째는 retriever 재실행 없이 캐시 hit + 결과 동일", async () => {
    const first = await postSearch(h, { query: "메모리 검색", limit: 5 });
    const afterFirst = h.retrieveCalls();
    expect(afterFirst).toBe(1);

    const second = await postSearch(h, { query: "메모리 검색", limit: 5 });
    const afterSecond = h.retrieveCalls();
    // 2번째 호출은 캐시 hit — retriever 가 다시 안 돈다.
    expect(afterSecond).toBe(1);

    // 결과·점수 완전 동일(캐시는 같은 입력을 그대로 재생).
    expect(second.count).toBe(first.count);
    expect(second.results.map((r) => r.id)).toEqual(first.results.map((r) => r.id));
    expect(second.results.map((r) => r.score)).toEqual(
      first.results.map((r) => r.score),
    );
  });

  test("addNode 후 같은 query — db_revision 상승으로 캐시 miss → retriever 재실행", async () => {
    await postSearch(h, { query: "분산 설계", limit: 5 });
    expect(h.retrieveCalls()).toBe(1);

    // 같은 query 재호출 = hit (retriever 횟수 그대로).
    await postSearch(h, { query: "분산 설계", limit: 5 });
    expect(h.retrieveCalls()).toBe(1);

    // DB 갱신 — db_revision 이 올라 캐시 키가 달라진다.
    await ingestDirect(h, "또 다른 분산 설계 메모를 추가했다");

    // 같은 query 가 이제 miss → retriever 가 다시 돈다(옛 결과 재사용 금지).
    await postSearch(h, { query: "분산 설계", limit: 5 });
    expect(h.retrieveCalls()).toBe(2);
  });

  test("dbRevision 을 안 올리는 가시성 변경(원시 SQL)도 visibilityGeneration 이 캐시를 가른다", async () => {
    const hidden = await ingestDirect(h, "분산 설계 검토 회의록은 금요일에 공유한다");
    const setStatus = (status: string) =>
      h.db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?")
        .run(JSON.stringify({ sharedMemory: { status, revision: 1, assertionKind: "unknown" } }), hidden);
    setStatus("retracted");

    const first = await postSearch(h, { query: "분산 설계 검토", limit: 5 });
    expect(first.results.map((r) => r.id)).not.toContain(hidden);
    await postSearch(h, { query: "분산 설계 검토", limit: 5 });
    expect(h.retrieveCalls()).toBe(1);

    // 원시 SQL 복원 — 이 프로세스의 dbRevision 은 그대로이고 v43 트리거만 번호를 올린다.
    const revision = h.store.getDbRevision();
    setStatus("active");
    expect(h.store.getDbRevision()).toBe(revision);

    // 옛 키(dbRevision·validityEpoch 만)였다면 캐시 hit 로 복원된 기억이 빠진 결과를 재생했다.
    const restored = await postSearch(h, { query: "분산 설계 검토", limit: 5 });
    expect(h.retrieveCalls()).toBe(2);
    expect(restored.results.map((r) => r.id)).toContain(hidden);
  });

  test("회귀 0 — 캐시 경유 결과가 캐시 없는 직접 retrieve 결과와 동일", async () => {
    // touch 가 recency 를 흔드는 것을 막으려고 *별도 store* 에 같은 자산을 적재해
    // 캐시 없는 직접 retrieve 기준선을 만든다(같은 입력 → 같은 RRF 산출 검증).
    const db2 = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store2 = new SqliteMemoryStore(db2, embedder);
    await store2.addNode({ content: "bara_system 은 검색 기능을 제공하는 메모리 모듈이다" });
    await store2.addNode({ content: "커피를 마시며 코드를 작성했다" });
    await store2.addNode({ content: "분산 시스템 설계를 검토했다" });
    const directRetriever = new HybridRetriever(store2, embedder);
    const direct = await directRetriever.retrieve("메모리 검색", { limit: 5 });

    // 캐시 경유 라우트 결과(첫 store).
    const viaCache = await postSearch(h, { query: "메모리 검색", limit: 5 });

    expect(viaCache.results.map((r) => r.id)).toEqual(direct.map((r) => r.node.id));
    expect(viaCache.results.map((r) => r.score)).toEqual(direct.map((r) => r.score));
    db2.close();
  });
});
