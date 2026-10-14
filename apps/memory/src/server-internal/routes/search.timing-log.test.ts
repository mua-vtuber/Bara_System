/**
 * search.timing-log.test.ts — POST /search 가 [search-timing] 로그 한 줄을 남기는지 검증
 * (speed-step1 Task 11 / spec 5.2).
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder + 실 SearchCache. mock 없음.
 * console.log 는 spyOn 으로 출력만 엿본다(원래 함수는 그대로 호출되지 않도록 빈 구현으로 가린다).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
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
import { SEARCH_TIMING_LOG_PREFIX } from "./search-timing.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
}, 180_000);
afterAll(() => {});

const QUERY = "비밀스러운 검색어 하나";

let db: Database;
let app: Hono;
let logSpy: ReturnType<typeof spyOn<Console, "log">>;

beforeEach(async () => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  app = buildMemoryApi({
    store,
    retriever,
    assembler: new ContextAssembler(),
    searchCache: new SearchCache(),
  });
  await store.addNode({ content: "검색어에 대한 메모를 하나 적어 둔다" });
  await store.addNode({ content: "커피를 마시며 코드를 작성했다" });
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  db.close();
});

async function postSearch(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await app.request("/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** 이번 호출까지 쌓인 [search-timing] 줄만 모은다. */
function timingLines(): string[] {
  return logSpy.mock.calls
    .map((args) => String(args[0]))
    .filter((line) => line.startsWith(SEARCH_TIMING_LOG_PREFIX));
}

describe("POST /search — [search-timing] 한 줄", () => {
  test("첫 호출은 줄 정확히 1개: cache=miss, 단계 칸에 숫자, 리랭커 없음은 rerank=-[off]", async () => {
    const body = await postSearch({ query: QUERY, limit: 5 });
    const lines = timingLines();
    expect(lines.length).toBe(1);
    const line = lines[0]!;
    expect(line).toMatch(/^\[search-timing\] total=\d+ms mode=full floor=off /);
    expect(line).toContain(`queryChars=${QUERY.length}`);
    expect(line).toContain("[strict cache=miss ");
    expect(line).toMatch(/prep=\d+ms embed=\d+ms\(hit=(yes|no)\) plan=\d+ms vecfts=\d+ms/);
    expect(line).toContain("rerank=-[off]");
    expect(line).toContain("entity=-[skipped] assemble=-");
    expect(line).not.toContain("\n");
    // 응답 본문에는 시간 칸이 새지 않는다.
    expect(JSON.stringify(body)).not.toContain("timings");
  });

  test("같은 호출을 한 번 더 하면 cache=hit 이고 단계 칸은 -", async () => {
    await postSearch({ query: QUERY, limit: 5 });
    logSpy.mockClear();
    await postSearch({ query: QUERY, limit: 5 });
    const lines = timingLines();
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(
      "[strict cache=hit prep=- embed=-(hit=-) plan=- vecfts=- concept=- image=- " +
        "project=- person=- graph=- score=- touch=-]",
    );
  });

  test("index 갈래는 mode=index 와 index 칸", async () => {
    await postSearch({ query: QUERY, responseMode: "index" });
    const lines = timingLines();
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(" mode=index ");
    expect(lines[0]).toMatch(/ floor=\d+ms index=\d+ms$/);
    expect(lines[0]).not.toContain("enrich=");
  });

  test("질의 글은 줄에 없다(길이만)", async () => {
    await postSearch({ query: QUERY, limit: 5 });
    await postSearch({ query: QUERY, responseMode: "index" });
    const lines = timingLines();
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line).not.toContain(QUERY);
      expect(line).not.toContain("비밀스러운");
    }
  });
});
