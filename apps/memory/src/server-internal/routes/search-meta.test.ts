/**
 * server-internal/routes/search-meta.test.ts — POST /search processing_info +
 * appliedFilters 검증 (T10 — 검색 메타 spec B).
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder + 실 SearchCache. mock 없음.
 *
 * 검증 항목(브리핑 Tests 절):
 *   1. N개 융합 후보, M개가 memoryType 필터로 걸러지는 시나리오 — 4개 숫자 정확 +
 *      appliedFilters 가 실제 지정한 필터를 그대로 echo.
 *   2. relaxed 모드 — appliedFilters/removedFilters 정합(반환 결과를 만든 pass 반영).
 *   3. 캐시 hit/miss — 같은 query 2회의 processing_info 가 동일(재계산 0 / D-D).
 *   4. 기존 응답 필드 byte 동일 회귀 — processing_info·appliedFilters 추가가
 *      results/count/searchMode 등 기존 칸을 건드리지 않는다(additive only).
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
import { applyHashtagWiring } from "../../memory/extractor.ts";
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
  searchCache?: SearchCache;
}

function makeHarness(opts?: { withCache?: boolean }): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const searchCache = opts?.withCache ? new SearchCache() : undefined;
  const app = buildMemoryApi({
    store,
    retriever,
    assembler,
    ...(searchCache ? { searchCache } : {}),
  });
  return { app, db, store, searchCache };
}

interface SearchResultRow {
  id: number;
  content: string;
  score: number;
}
interface ProcessingInfo {
  totalFound: number;
  afterFiltering: number;
  returned: number;
  trimmedByBudget: number;
}
interface AppliedFilters {
  dateRange?: { since: string; until: string };
  place?: string;
  polarity?: string;
  memoryType?: string;
  kind?: string;
  fieldFilters?: Array<{ key: string; value: string }>;
  filter?: Record<string, string>;
}
interface SearchResponse {
  query: string;
  count: number;
  results: SearchResultRow[];
  searchMode: string;
  relaxed: boolean;
  strictCount: number;
  removedFilters: string[];
  processing_info: ProcessingInfo;
  appliedFilters: AppliedFilters;
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

// ── 1. N개 융합 후보 / M개 memoryType 필터로 걸러지는 시나리오 ──────────────

describe("POST /search — processing_info 정확성(memoryType 필터로 후보 축소)", () => {
  let h: Harness;
  let episodeIds: number[];
  let factIds: number[];

  beforeEach(async () => {
    h = makeHarness();
    // 같은 어휘("여행")를 담은 자산을 memoryType 만 다르게 5+3 으로 나눠 심는다.
    // 필터가 없으면 후보(totalFound) 는 8개 전부, memoryType='episode' 필터를 걸면
    // totalFound·afterFiltering·returned 모두 5개로 줄어야 한다(fact 3개는 축소).
    // totalFound 는 "공급 단계 필터를 통과한 후보 수"라 필터 이전 8 이 아니다.
    episodeIds = [];
    for (let i = 0; i < 5; i++) {
      episodeIds.push(
        await h.store.addNode({
          content: `여행 에피소드 기록 ${i}`,
          memoryType: "episode",
        }),
      );
    }
    factIds = [];
    for (let i = 0; i < 3; i++) {
      factIds.push(
        await h.store.addNode({
          content: `여행 관련 사실 정보 ${i}`,
          memoryType: "fact",
        }),
      );
    }
  });
  afterEach(() => {
    h.db.close();
  });

  test("필터 없는 검색 — totalFound = afterFiltering = returned(예산 미지정 → trimmedByBudget=0)", async () => {
    const body = await postSearch(h, { query: "여행", limit: 20 });
    const { processing_info } = body;
    expect(processing_info.totalFound).toBe(8);
    expect(processing_info.afterFiltering).toBe(8);
    expect(processing_info.returned).toBe(body.results.length);
    expect(processing_info.returned).toBe(8);
    expect(processing_info.trimmedByBudget).toBe(0);
    // 필터 미지정 — appliedFilters 는 활성 축이 없다(빈 객체 / 키 생략).
    expect(body.appliedFilters).toEqual({});
  });

  test("memoryType='episode' — totalFound=afterFiltering=returned=5(공급 단계 필터 통과 후보)", async () => {
    const body = await postSearch(h, {
      query: "여행",
      limit: 20,
      memoryType: "episode",
    });
    const { processing_info } = body;
    // totalFound 는 공급 단계 필터를 통과한 후보 수 — fact 3개는 세지 않아 episode 5.
    expect(processing_info.totalFound).toBe(5);
    // afterFiltering·returned 도 필터 통과 후 — episode 5개만 남는다.
    expect(processing_info.afterFiltering).toBe(5);
    expect(processing_info.returned).toBe(5);
    expect(body.results.length).toBe(5);
    const returnedIds = new Set(body.results.map((r) => r.id));
    for (const id of episodeIds) expect(returnedIds.has(id)).toBe(true);
    for (const id of factIds) expect(returnedIds.has(id)).toBe(false);

    // appliedFilters 가 지정한 memoryType 을 그대로 echo.
    expect(body.appliedFilters).toEqual({ memoryType: "episode" });
  });

  test("limit 이 afterFiltering 보다 작으면 returned < afterFiltering(trim 은 별도 관측점)", async () => {
    const body = await postSearch(h, {
      query: "여행",
      limit: 2,
      memoryType: "episode",
    });
    const { processing_info } = body;
    // totalFound 도 limit 과 무관한 필터 통과 후보 수 — 5.
    expect(processing_info.totalFound).toBe(5);
    // afterFiltering 은 limit trim *이전* 필터 통과 후보 수 — limit 과 무관하게 5.
    expect(processing_info.afterFiltering).toBe(5);
    // returned 는 실제 반환 개수 — limit=2 로 trim.
    expect(processing_info.returned).toBe(2);
    expect(body.results.length).toBe(2);
  });

  // totalFound 정의 = "공급 단계 필터를 통과한 후보 수" — 7채널이 같은 통과 Set 을 거친
  // 뒤에 센다. 벡터·FTS 만 공급 단계에서 걸러지고 나머지 채널은 안 걸러진 채 세던 옛
  // 정의(채널마다 시점이 달랐다)로 돌아가면 아래 두 단언이 깨진다.
  test("graph 채널로만 닿는 필터 불일치 노드는 totalFound 를 올리지 않는다", async () => {
    // episode 와 엣지로 이어진 fact 노드 — 글자·의미가 질의("여행")와 무관해, memoryType
    // 필터가 걸리면 벡터·FTS 에는 못 오르고 episode 시드에서 퍼지는 graph 채널로만 닿는다.
    const linkedFact = await h.store.addNode({
      content: "산악 자전거 체인 정비 순서 메모",
      memoryType: "fact",
    });
    await h.store.addEdge({
      sourceId: episodeIds[0]!,
      targetId: linkedFact,
      relation: "related_to",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.9,
    });

    // 대조 — 필터가 없으면 이 노드도 후보라 totalFound 에 든다(후보 풀에 실제로 닿는다는 증명).
    const unfiltered = await postSearch(h, { query: "여행", limit: 20 });
    expect(unfiltered.processing_info.totalFound).toBe(9);
    expect(unfiltered.results.map((r) => r.id)).toContain(linkedFact);

    // 필터 — graph 로 닿은 fact 는 통과 Set 에서 빠지므로 totalFound 에 세지 않는다.
    const body = await postSearch(h, { query: "여행", limit: 20, memoryType: "episode" });
    expect(body.results.map((r) => r.id)).not.toContain(linkedFact);
    expect(body.processing_info.totalFound).toBe(5);
    expect(body.processing_info.afterFiltering).toBe(5);
    expect(body.processing_info.returned).toBe(5);
  });

  test("concept 채널로만 닿는 필터 불일치 노드도 totalFound 를 올리지 않는다", async () => {
    // #태그로 개념 "수영장" 에 묶인 본문 노드 — 검색어 "수영장" 이 개념 채널로 이 노드를
    // 끌어온다. 본문 노드의 memoryType 이 episode 가 아니라 memoryType 필터에는 걸린다.
    const wired = await applyHashtagWiring(h.store, "#수영장 오늘 레인 청소 당번표", { embedder });
    expect(wired.bodyNodeId).not.toBeNull();
    const bodyId = wired.bodyNodeId!;
    const bodyNode = await h.store.getNode(bodyId);
    expect(bodyNode?.memoryType).not.toBe("episode");

    // 대조 — 필터가 없으면 개념 채널이 이 노드를 끌어와 후보에 든다.
    const unfiltered = await postSearch(h, { query: "수영장", limit: 20 });
    expect(unfiltered.results.map((r) => r.id)).toContain(bodyId);

    // 필터 — episode 만 통과하므로 본문 노드는 totalFound 에 세지 않는다. 벡터 공급이
    // episode 5개 안에서 순위화하므로 후보는 정확히 그 5개다.
    const body = await postSearch(h, { query: "수영장", limit: 20, memoryType: "episode" });
    expect(body.results.map((r) => r.id)).not.toContain(bodyId);
    expect(body.processing_info.totalFound).toBe(episodeIds.length);
    expect(body.processing_info.afterFiltering).toBe(episodeIds.length);
  });

  test("contextBudget 지정 — trimmedByBudget 이 ContextAssembler.memoriesTrimmed 를 그대로 노출", async () => {
    // 예산을 아주 작게 줘서 대부분이 trim 되게 만든다(헤더+한 줄 겨우 들어갈 크기).
    const tiny = await postSearch(h, {
      query: "여행",
      limit: 20,
      memoryType: "episode",
      contextBudget: 40,
    });
    expect(tiny.processing_info.returned).toBe(5);
    // 예산이 작아 5개 전부가 memoryBlock 에 안 들어가면 trimmedByBudget > 0.
    // (context.memoriesTrimmed 와 동일해야 한다 — 같은 assemble() 산출 공유.)
    const context = (tiny as unknown as { context?: { memoriesTrimmed: number } }).context;
    expect(context).toBeDefined();
    expect(tiny.processing_info.trimmedByBudget).toBe(context!.memoriesTrimmed);
  });
});

// ── 2. relaxed 모드 — appliedFilters/removedFilters 정합 ───────────────────

describe("POST /search — relaxed 모드 appliedFilters/removedFilters 정합(T10 브리핑 항목4)", () => {
  let h: Harness;
  let movieNode: number;

  beforeEach(async () => {
    h = makeHarness();
    movieNode = await h.store.addNode({ content: "어제 본 영화 메모 한 줄" });
  });
  afterEach(() => {
    h.db.close();
  });

  test("relaxed 결과 — appliedFilters 는 빈 객체(모든 필터 축 제거), removedFilters 는 제거된 축 나열", async () => {
    const body = await postSearch(h, {
      query: "영화",
      limit: 20,
      memoryType: "episode", // movieNode 는 memoryType 미지정(fact 기본) → strict 0건
      relaxFilters: true,
    });
    expect(body.searchMode).toBe("relaxed");
    expect(body.relaxed).toBe(true);
    expect(body.strictCount).toBe(0);
    expect(body.removedFilters).toEqual(["memoryType"]);
    // relaxed pass 가 memoryType 을 제거하고 재검색해 movieNode 를 되찾았으므로
    // appliedFilters 는 반환된 결과를 만든 pass(필터 없음)를 반영 — 빈 객체.
    expect(body.appliedFilters).toEqual({});
    const ids = new Set(body.results.map((r) => r.id));
    expect(ids.has(movieNode)).toBe(true);
  });

  test("strict 결과(필터 1건 이상 매치) — appliedFilters 는 지정 필터 그대로", async () => {
    const body = await postSearch(h, {
      query: "영화",
      limit: 20,
      memoryType: "fact",
      relaxFilters: true, // strict 가 이미 결과를 찾았으므로 relaxed 로 안 감
    });
    expect(body.searchMode).toBe("strict");
    expect(body.relaxed).toBe(false);
    expect(body.appliedFilters).toEqual({ memoryType: "fact" });
  });
});

// ── 3. 캐시 hit/miss — processing_info 동일성 ───────────────────────────────

describe("POST /search — 캐시 hit/miss 간 processing_info 동일성(T10 브리핑 항목5)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = makeHarness({ withCache: true });
  });
  afterEach(() => {
    h.db.close();
  });

  test("같은 query 2회 — 2번째(캐시 hit)의 processing_info 가 1번째(캐시 miss)와 완전 동일", async () => {
    await h.store.addNode({ content: "bara_system 검색 메타 통합 테스트 글" });
    await h.store.addNode({ content: "커피를 마시며 코드를 작성했다" });

    const first = await postSearch(h, { query: "검색 메타", limit: 10 });
    const second = await postSearch(h, { query: "검색 메타", limit: 10 });

    expect(second.results.map((r) => r.id)).toEqual(first.results.map((r) => r.id));
    // processing_info 의 totalFound/afterFiltering 은 retriever 내부 계산값이라
    // 캐시 hit 이 retriever 를 다시 안 돌리면 재계산할 방법이 없다 — CachedSearch.stats
    // 로 결과와 함께 캐시돼야 hit/miss 가 동일 숫자를 낸다.
    expect(second.processing_info).toEqual(first.processing_info);
  });

  test("relaxed 결과도 캐시 hit 시 processing_info 동일(fallbackPass 캐시 키 경유)", async () => {
    await h.store.addNode({ content: "주말에 다녀온 여행 기록" });

    const firstRelaxed = await postSearch(h, {
      query: "여행",
      limit: 20,
      since: "2099-01-01",
      until: "2099-12-31",
      relaxFilters: true,
    });
    expect(firstRelaxed.relaxed).toBe(true);

    const secondRelaxed = await postSearch(h, {
      query: "여행",
      limit: 20,
      since: "2099-01-01",
      until: "2099-12-31",
      relaxFilters: true,
    });
    expect(secondRelaxed.relaxed).toBe(true);
    expect(secondRelaxed.results.map((r) => r.id)).toEqual(
      firstRelaxed.results.map((r) => r.id),
    );
    expect(secondRelaxed.processing_info).toEqual(firstRelaxed.processing_info);
    expect(secondRelaxed.appliedFilters).toEqual(firstRelaxed.appliedFilters);
  });
});

// ── 4. 기존 응답 필드 byte 동일 회귀 ────────────────────────────────────────

describe("POST /search — processing_info·appliedFilters 추가가 기존 응답 칸을 안 건드림(additive only)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = makeHarness();
    await h.store.addNode({ content: "회의에서 예산을 논의했다" });
    await h.store.addNode({ content: "내일 마트 일정이 있다" });
    await h.store.addNode({ content: "철수와 점심을 먹었다" });
  });
  afterEach(() => h.db.close());

  test("같은 query 두 번 검색 — 기존 칸(results·count·searchMode 등) byte 동일 + 새 칸도 존재", async () => {
    const a = await postSearch(h, { query: "예산 회의", limit: 10 });
    const b = await postSearch(h, { query: "예산 회의", limit: 10 });

    expect(a.count).toBe(b.count);
    expect(a.results.map((r) => r.id)).toEqual(b.results.map((r) => r.id));
    for (let i = 0; i < a.results.length; i++) {
      expect(a.results[i]!.score).toBeCloseTo(b.results[i]!.score, 10);
    }
    expect(a.searchMode).toBe(b.searchMode);
    expect(a.relaxed).toBe(b.relaxed);
    expect(a.strictCount).toBe(b.strictCount);
    expect(a.removedFilters).toEqual(b.removedFilters);

    // 새 칸 — 항상 존재(additive only).
    expect(a.processing_info).toBeDefined();
    expect(a.appliedFilters).toBeDefined();
    expect(a.processing_info.returned).toBe(a.results.length);
  });
});
