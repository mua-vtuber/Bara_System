/**
 * search-index-mode.test.ts — 2단계 검색 index 모드 (T21 / spec C).
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder + 실 HybridRetriever. mock 객체 0 —
 * 호출 횟수 관측은 실제 메서드를 감싸 횟수만 세는 counting wrapper 다(T4/T16 선례).
 *
 * 검증 항목(브리핑 Tests 절):
 *   1. full 모드 byte 불변 — responseMode 미지정·"full"·오타가 도입 전과 동일.
 *   2. index 회신 형태 — 6칸만·본문 없음·포인터 문구 존재.
 *   3. oneLine 두 갈래 — 청크요약 있음 / 없음(본문 첫 문장) + 글자 상한.
 *   4. index 모드에서 store.embedQuery 미호출(새 종류 존재 fixture).
 *   5. limit — index 별도 default(settings) + 하드 최대 100 clamp.
 *   6. 캐시 공유 — 같은 질의·같은 limit 이면 full→index 2회차가 캐시 hit.
 *   7. 하한선(T20)이 index 모드에도 걸린다 — 무관 질의 0건 + 정직한 processing_info.
 *
 * 코퍼스 cosine 실측은 search-result-floor.test.ts 헤더와 같은 값을 쓴다(같은 코퍼스·
 * 같은 질의·같은 임베더). 임계(0.44)와의 간격이 이미 확인된 조합이라 재측정 없이 쓴다.
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
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import { runSearchPipeline, INDEX_MODE_LIMIT_MAX } from "./search-service.ts";
import {
  buildOneLine,
  firstSentence,
  truncateToCap,
  parseResponseMode,
  resolveIndexDate,
  ONE_LINE_MAX_CHARS,
  POINTER_SENTENCE,
  TRUNCATION_SUFFIX,
} from "./search-index-mode.ts";
import type { MemoryApiDeps } from "../types.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

/** search-result-floor.test.ts 와 같은 코퍼스(실측 cosine 확인된 조합). */
const CORPUS = [
  "지난 주말에 친구들과 한강에서 자전거를 탔다",
  "냉장고에 우유가 떨어져서 마트에 들러야 한다",
  "회사 회의에서 다음 분기 예산안을 논의했다",
  "고양이가 새벽 세 시에 울어서 잠을 설쳤다",
  "새로 산 키보드의 타건감이 아주 좋다",
];

/** 정답이 있는 질의 — 자전거 글 cosine 0.6317(실측, 하한선 0.44 위 여유 0.19). */
const ANSWERABLE = "자전거";
/** 저장한 기억이 하나도 닿지 않는 질의 — 전건 cosine 0.34 이하(실측). */
const UNANSWERABLE = "심해 열수구에 사는 관벌레의 화학합성 대사";

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
  deps: MemoryApiDeps;
  settings: MemorySettings;
  /** 실제 store.embedQuery 호출 횟수 — index 모드 생략 단언용. */
  embedQueryCalls: () => number;
  /** 실제 retriever.retrieveWithStats 호출 횟수 — 캐시 hit 판정용. */
  retrieveCalls: () => number;
}

interface HarnessOptions {
  indexModeLimit?: number;
  resultFloor?: Partial<MemorySettings["search"]["resultFloor"]>;
  /** SearchCache 를 주입해 캐시 공유 시험을 켠다(미지정이면 캐시 없음). */
  withCache?: boolean;
}

/**
 * settings 를 명시 주입하는 harness. embedQuery·retrieveWithStats 는 *실제*
 * 메서드를 감싸 호출 횟수만 센다 — 반환값·인자·동작은 원본 그대로다(가짜 구현체
 * 아님 / search.cache.test.ts 의 counting wrapper 선례와 같은 양식).
 */
function makeHarness(options?: HarnessOptions): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);

  let embedCalls = 0;
  const realEmbedQuery = store.embedQuery.bind(store);
  store.embedQuery = ((q: string) => {
    embedCalls += 1;
    return realEmbedQuery(q);
  }) as typeof store.embedQuery;

  const retriever = new HybridRetriever(store, embedder);
  let retrieves = 0;
  const realRetrieveWithStats = retriever.retrieveWithStats.bind(retriever);
  retriever.retrieveWithStats = ((query, opts) => {
    retrieves += 1;
    return realRetrieveWithStats(query, opts);
  }) as typeof retriever.retrieveWithStats;

  const assembler = new ContextAssembler();
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  if (options?.indexModeLimit !== undefined) {
    settings.search.indexModeLimit = options.indexModeLimit;
  }
  if (options?.resultFloor) {
    settings.search.resultFloor = {
      ...settings.search.resultFloor,
      ...options.resultFloor,
    };
  }
  const deps: MemoryApiDeps = {
    store,
    retriever,
    assembler,
    getSettings: () => settings,
  };
  if (options?.withCache) deps.searchCache = new SearchCache();
  const app = buildMemoryApi(deps);
  return {
    app,
    db,
    store,
    deps,
    settings,
    embedQueryCalls: () => embedCalls,
    retrieveCalls: () => retrieves,
  };
}

/**
 * 코퍼스 > limit 조건을 만드는 확장분(search-result-floor.test.ts 와 같은 목록).
 * 12건이면 limit 3 검색에서 retriever 의 limit 절단이 실제로 일어나, 절단 *전* 수와
 * 생존자 수의 모집단 차이가 드러난다 — afterFiltering 시험이 의미를 갖는 fixture 모양.
 */
const CORPUS_EXTRA = [
  "동네 도서관에서 소설책을 빌려 왔다",
  "주말에 친구 결혼식에 다녀왔다",
  "점심으로 김치찌개를 먹었다",
  "겨울 코트를 세탁소에 맡겼다",
  "새 이어폰 배터리가 하루도 못 간다",
  "화분에 물 주는 걸 자꾸 잊는다",
  "지하철에서 우산을 두고 내렸다",
];

async function seed(h: Harness, extra = false): Promise<number[]> {
  const ids: number[] = [];
  for (const content of CORPUS) ids.push(await h.store.addNode({ content }));
  if (extra) {
    for (const content of CORPUS_EXTRA) ids.push(await h.store.addNode({ content }));
  }
  return ids;
}

interface IndexItem {
  id: number;
  memoryType: string;
  oneLine: string;
  entities: string[];
  date: string;
  score: number;
}
interface SearchResponse {
  query: string;
  responseMode?: string;
  pointer?: string;
  count: number;
  results: Array<Record<string, unknown>>;
  processing_info: {
    totalFound: number;
    afterFiltering: number;
    returned: number;
    trimmedByBudget: number;
  };
}

/**
 * byte 불변 비교용 정규화 — `lastAccessedAt` 만 고정값으로 바꾼다.
 *
 * 검색은 열람 기록이라 결과 노드의 last_accessed_at 을 매 호출 갱신한다. 그래서
 * *같은 코드로 두 번 부르기만 해도* 이 칸은 1초 경계에서 달라진다 — responseMode
 * 와 무관한 시간 변동이다. 이 칸을 그대로 두고 비교하면 시험이 실제 회귀가 아니라
 * 시계를 재는 셈이라, 이 칸만 지우고 나머지 전 칸을 byte 비교한다.
 *
 * 지우는 대상을 이 한 칸으로 좁힌 것이 요점이다 — score·components·순서·칸 구성은
 * 전부 비교 대상으로 남아 responseMode 도입이 만든 차이는 그대로 잡힌다.
 */
function normalizeForByteCompare(response: SearchResponse): string {
  return JSON.stringify(response, (key, value) =>
    key === "lastAccessedAt" ? "<normalized>" : value,
  );
}

/** AI 경로 — MCP search_memory 와 같은 호출 형태(applyResultFloor:true). */
async function searchAiPath(
  h: Harness,
  payload: Record<string, unknown>,
): Promise<SearchResponse> {
  const response = await runSearchPipeline(h.deps, payload, new URLSearchParams(), {
    applyResultFloor: true,
  });
  return response as unknown as SearchResponse;
}

/** 대시보드 경로 — REST POST /search(하한선 플래그 OFF). */
async function postSearchRest(
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

// ── 1. full 모드 byte 불변 (spec C 계약 1) ──────────────────────────────────

describe("full 모드 byte 불변 — responseMode 도입 전과 동일한 응답", () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness();
    await seed(h);
  });
  afterEach(() => h.db.close());

  test("responseMode 미지정 == 'full' 명시 — 응답 전체가 완전히 같다", async () => {
    const omitted = await postSearchRest(h, { query: ANSWERABLE, limit: 20 });
    const explicit = await postSearchRest(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "full",
    });
    // JSON 직렬화 결과까지 같아야 byte 불변이다(칸 추가·순서 변화 0).
    expect(normalizeForByteCompare(explicit)).toBe(
      normalizeForByteCompare(omitted),
    );
  });

  test("오타·비문자열 responseMode 도 full 로 떨어진다(방어 파싱)", async () => {
    const baseline = await postSearchRest(h, { query: ANSWERABLE, limit: 20 });
    for (const bad of ["indx", "INDEX", "", 1, true, null, {}]) {
      const got = await postSearchRest(h, {
        query: ANSWERABLE,
        limit: 20,
        responseMode: bad,
      });
      expect(normalizeForByteCompare(got)).toBe(
        normalizeForByteCompare(baseline),
      );
    }
  });

  test("full 응답에는 index 전용 칸(responseMode·pointer)이 없다", async () => {
    const full = await postSearchRest(h, { query: ANSWERABLE, limit: 20 });
    expect(Object.keys(full)).not.toContain("responseMode");
    expect(Object.keys(full)).not.toContain("pointer");
    // 본문은 그대로 실린다(full 모드의 정체).
    expect(full.results[0]).toHaveProperty("content");
  });

  test("parseResponseMode 단위 — 'index' 만 index, 나머지 전부 full", () => {
    expect(parseResponseMode("index")).toBe("index");
    for (const bad of [undefined, null, "full", "INDEX", "", 0, {}, []]) {
      expect(parseResponseMode(bad)).toBe("full");
    }
  });
});

// ── 2. index 회신 형태 + 포인터 문구 (spec C 계약 2) ────────────────────────

describe("index 회신 형태 — 6칸만 + 포인터 문구", () => {
  let h: Harness;
  let ids: number[];
  beforeEach(async () => {
    h = makeHarness();
    ids = await seed(h);
  });
  afterEach(() => h.db.close());

  test("항목이 정확히 6칸 — 본문(content)은 실리지 않는다", async () => {
    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    expect(idx.results.length).toBeGreaterThan(0);
    for (const item of idx.results) {
      expect(Object.keys(item).sort()).toEqual(
        ["date", "entities", "id", "memoryType", "oneLine", "score"].sort(),
      );
      // 본문·개념 펼침·인접 청크 등 full 전용 칸이 하나도 없다.
      expect(item).not.toHaveProperty("content");
      expect(item).not.toHaveProperty("concepts");
      expect(item).not.toHaveProperty("neighbors");
    }
  });

  test("포인터 문구가 회신에 실린다 — 절단을 본문으로 오인하지 않게(spec C)", async () => {
    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    expect(idx.pointer).toBe(POINTER_SENTENCE);
    expect(idx.responseMode).toBe("index");
    // 문구가 두 가지를 말해야 한다: 절단분이라는 사실 + 본문 통로(get_memory).
    expect(POINTER_SENTENCE).toContain("truncated");
    expect(POINTER_SENTENCE).toContain("get_memory");
  });

  test("id·score·date 가 full 모드와 같은 값 — 성형이 순위·점수를 안 바꾼다", async () => {
    const full = await searchAiPath(h, { query: ANSWERABLE, limit: 20 });
    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    expect(idx.results.map((r) => r.id)).toEqual(full.results.map((r) => r.id));
    expect(idx.results.map((r) => r.score)).toEqual(
      full.results.map((r) => r.score),
    );
  });

  test("date = COALESCE(eventAt, createdAt) 의 날짜 부분(T11 표식과 같은 규칙)", async () => {
    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    for (const item of idx.results as unknown as IndexItem[]) {
      expect(item.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // eventAt 이 있으면 그쪽이 이긴다 — 순수 함수로 직접 확인.
    const node = { eventAt: "2020-01-02T03:04:05Z", createdAt: "2026-08-03T00:00:00Z" };
    expect(resolveIndexDate(node as never)).toBe("2020-01-02");
    const noEvent = { eventAt: null, createdAt: "2026-08-03T00:00:00Z" };
    expect(resolveIndexDate(noEvent as never)).toBe("2026-08-03");
  });

  test("개념이 안 붙은 글의 entities 는 빈 배열(진짜 0개 — 생략이 아님)", async () => {
    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    for (const item of idx.results as unknown as IndexItem[]) {
      expect(item.entities).toEqual([]);
    }
    expect(ids.length).toBe(CORPUS.length);
  });
});

// WP-B1-10S(Medium 5) — index 모드의 열린 충돌 표시(WP-B1-10) 검증은
// search-index-mode-conflicts.test.ts 로 옮겼다(이 파일이 800줄 하드 한도를 넘어 있어
// 이미 초과한 파일은 키우지 않는다).

// ── 2-b. entities 실제 채움 (수정 1회차 High) ───────────────────────────────

describe("entities — 붙은 개념 이름이 실제로 실린다(배치 질의 1회)", () => {
  let h: Harness;
  afterEach(() => h.db.close());

  test("개념이 붙은 글 — 그 이름이 entities 로 회신된다", async () => {
    h = makeHarness();
    const nodeId = await h.store.addNode({
      content: "지난 주말에 친구들과 한강에서 자전거를 탔다",
    });
    const conceptId = await h.store.findOrCreateConcept("자전거");
    await h.store.addNodeConceptEdge(nodeId, conceptId, "tag", "user_input", null);

    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    const item = idx.results.find((r) => r.id === nodeId) as unknown as IndexItem;
    // 빈 배열이면 AI 에게 "엔티티 없음"이라는 거짓 신호가 간다 — 실제 이름이 와야 한다.
    expect(item.entities).toEqual(["자전거"]);
  });

  test("개념 여러 개 — 전부 실리고 순서가 재현 가능하다", async () => {
    h = makeHarness();
    const nodeId = await h.store.addNode({
      content: "지난 주말에 친구들과 한강에서 자전거를 탔다",
    });
    for (const name of ["한강", "자전거", "주말"]) {
      const cid = await h.store.findOrCreateConcept(name);
      await h.store.addNodeConceptEdge(nodeId, cid, "tag", "user_input", null);
    }
    const first = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    const second = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    const a = (first.results[0] as unknown as IndexItem).entities;
    const b = (second.results[0] as unknown as IndexItem).entities;
    expect(a.length).toBe(3);
    // 집합으로는 세 이름이 다 있다(sort 로 원본을 흔들지 않게 복사본에서 비교).
    expect([...a].sort()).toEqual(["자전거", "주말", "한강"]);
    // 같은 입력은 같은 순서 — concept_id 오름차순 안정 정렬.
    expect(b).toEqual(a);
  });

  test("결과 N건이어도 개념 조회는 배치 1회 — 결과당 질의 아님(D-D)", async () => {
    h = makeHarness();
    // 5건 전부에 개념을 붙인다 — 결과당 질의면 5회가 돼야 하는 조건.
    for (const content of CORPUS) {
      const id = await h.store.addNode({ content });
      const cid = await h.store.findOrCreateConcept(`개념${id}`);
      await h.store.addNodeConceptEdge(id, cid, "tag", "user_input", null);
    }
    // 실 메서드를 감싸 호출 횟수만 센다(counting wrapper — 가짜 구현 아님).
    let calls = 0;
    const real = h.store.getNodeConceptNamesByIds.bind(h.store);
    h.store.getNodeConceptNamesByIds = ((ids: readonly number[]) => {
      calls += 1;
      return real(ids);
    }) as typeof h.store.getNodeConceptNamesByIds;

    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
      // 하한선을 꺼 여러 건이 남게 한다(배치 의미가 드러나는 조건).
    });
    void idx;
    // 결과가 몇 건이든 회신 1건당 1회다.
    expect(calls).toBe(1);
  });

  test("개념 펼침(getNodeConceptExpansion)은 여전히 안 부른다 — 무거운 후처리 생략 유지", async () => {
    h = makeHarness();
    const nodeId = await h.store.addNode({
      content: "지난 주말에 친구들과 한강에서 자전거를 탔다",
    });
    const cid = await h.store.findOrCreateConcept("자전거");
    await h.store.addNodeConceptEdge(nodeId, cid, "tag", "user_input", null);

    let expansions = 0;
    const realExp = h.store.getNodeConceptExpansion.bind(h.store);
    h.store.getNodeConceptExpansion = ((id: number) => {
      expansions += 1;
      return realExp(id);
    }) as typeof h.store.getNodeConceptExpansion;

    await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    // 이름만 배치로 받고, 이웃 1단계까지 도는 펼침은 index 모드에서 안 돈다.
    expect(expansions).toBe(0);
  });
});

// ── 3. oneLine 두 갈래 + 글자 상한 (spec C 계약 3) ──────────────────────────

describe("oneLine — 요약 우선 → 본문 첫 문장, 글자 상한 고정", () => {
  test("firstSentence — 마침표·물음표·느낌표에서 끊는다", () => {
    expect(firstSentence("첫 문장이다. 둘째 문장이다.")).toBe("첫 문장이다.");
    expect(firstSentence("이게 맞나? 아닌가.")).toBe("이게 맞나?");
    expect(firstSentence("놀랍다! 정말로.")).toBe("놀랍다!");
  });

  test("firstSentence — 줄바꿈이 먼저면 그 줄이 첫 문장(부호 없는 목록·제목)", () => {
    expect(firstSentence("제목 줄\n본문 줄이다.")).toBe("제목 줄");
    expect(firstSentence("- 항목 하나\n- 항목 둘")).toBe("- 항목 하나");
  });

  test("firstSentence — 문장 끝이 없으면 본문 전체, 빈 글은 빈 문자열", () => {
    expect(firstSentence("끝맺음 부호 없는 한 덩어리")).toBe(
      "끝맺음 부호 없는 한 덩어리",
    );
    expect(firstSentence("   ")).toBe("");
    expect(firstSentence("")).toBe("");
  });

  test("truncateToCap — 상한 이하는 그대로, 초과분은 상한 *안* 에서 자른다", () => {
    expect(truncateToCap("짧다", 10)).toBe("짧다");
    const long = "가".repeat(200);
    const cut = truncateToCap(long, 120);
    // 말줄임표를 포함해도 상한을 넘지 않는 것이 계약이다(토큰 산법의 근거).
    expect(cut.length).toBe(120);
    expect(cut.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  test("buildOneLine — 요약이 있으면 요약이 이긴다(본문 첫 문장보다 우선)", () => {
    const line = buildOneLine("본문 첫 문장이다. 둘째 문장.", "사람이 읽는 요약");
    expect(line).toBe("사람이 읽는 요약");
  });

  test("buildOneLine — 요약이 null·빈 문자열이면 본문 첫 문장으로 떨어진다", () => {
    expect(buildOneLine("본문 첫 문장이다. 둘째.", null)).toBe("본문 첫 문장이다.");
    expect(buildOneLine("본문 첫 문장이다. 둘째.", "   ")).toBe("본문 첫 문장이다.");
  });

  test("buildOneLine — 긴 요약도 상한을 탄다(생성기가 길이를 정해도 회신은 닫힌다)", () => {
    const longSummary = "요".repeat(500);
    expect(buildOneLine("본문", longSummary).length).toBe(ONE_LINE_MAX_CHARS);
  });

  test("buildOneLine — 본문·요약이 둘 다 비면 빈 문자열(가짜 문구로 안 채운다)", () => {
    expect(buildOneLine("", null)).toBe("");
    expect(buildOneLine("   ", null)).toBe("");
  });
});

describe("oneLine 통합 — 실 DB 두 갈래(요약 있음 / 없음)", () => {
  let h: Harness;
  afterEach(() => h.db.close());

  test("요약 없는 일반 노드 — 본문 첫 문장이 oneLine 이 된다", async () => {
    h = makeHarness();
    await h.store.addNode({
      content: "지난 주말에 친구들과 한강에서 자전거를 탔다. 날씨가 아주 좋았다.",
    });
    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    const item = idx.results[0] as unknown as IndexItem;
    expect(item.oneLine).toBe("지난 주말에 친구들과 한강에서 자전거를 탔다.");
    // 둘째 문장은 안 실린다(절단이 실제로 일어났다).
    expect(item.oneLine).not.toContain("날씨가");
  });

  test("긴 본문 — oneLine 이 글자 상한을 넘지 않는다", async () => {
    h = makeHarness();
    // 문장 부호·줄바꿈 없는 한 덩어리라 절단만이 길이를 정한다.
    await h.store.addNode({ content: "자전거 " + "타기 좋은 날 ".repeat(60) });
    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    const item = idx.results[0] as unknown as IndexItem;
    expect(item.oneLine.length).toBeLessThanOrEqual(ONE_LINE_MAX_CHARS);
    expect(item.oneLine.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  test("청크요약이 붙은 노드 — 요약이 oneLine 으로 실린다", async () => {
    h = makeHarness();
    const nodeId = await h.store.addNode({
      content: "지난 주말에 친구들과 한강에서 자전거를 탔다. 날씨가 아주 좋았다.",
    });
    // chunk_summaries 는 실제 documents 행 FK 를 요구한다 — store.test.ts 의
    // 같은 fixture 양식으로 자산·문서 행을 먼저 만든 뒤 실 store 통로로 요약을
    // 심는다(데이터 fixture / 인터페이스 가짜 구현 아님).
    const sha = "c".repeat(64);
    const now = Date.now();
    h.db.run(
      `INSERT INTO asset_files
        (sha256, asset_type, asset_path, byte_size, mime_type, original_name, first_imported_at)
       VALUES (?, 'document', ?, 10, 'text/markdown', 'd.md', ?)`,
      [sha, `/content/${sha}.md`, now],
    );
    h.db.run(
      `INSERT INTO documents
        (document_id, asset_sha256, title, document_type, chunk_count, created_at, updated_at)
       VALUES ('doc-idx', ?, '문서', 'markdown', 1, ?, ?)`,
      [sha, now, now],
    );
    await h.store.insertChunkSummary({
      summaryId: "cs_idx_1",
      parentChunkId: nodeId,
      parentDocumentId: "doc-idx",
      summaryText: "한강 자전거 나들이 기록",
      generatedBy: "user_edit",
    });
    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    const item = idx.results.find(
      (r) => r.id === nodeId,
    ) as unknown as IndexItem;
    expect(item.oneLine).toBe("한강 자전거 나들이 기록");
  });
});

// ── 4. index 모드에서 embedQuery 미호출 (spec C 계약 4) ─────────────────────

describe("index 모드는 엔티티 채널 embedQuery 를 부르지 않는다(D-D)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness();
    await seed(h);
    // 새 종류(사용자 정의 엔티티 종류)가 *존재해야* full 모드가 embedQuery 를
    // 부른다 — 그 전제를 만들어야 "index 가 생략한다"는 단언이 의미를 갖는다.
    h.store.entityTypeRegistryDb.addEntityType({
      typeName: "vehicle",
      koName: "탈것",
      idPrefix: "veh_",
    });
  });
  afterEach(() => h.db.close());

  test("full 모드는 부르고(대조군), index 모드는 부르지 않는다", async () => {
    // 전제 확인 — 새 종류가 실제로 등록됐다.
    expect(
      h.store.entityTypeRegistryDb.listUserEntityTypes().length,
    ).toBeGreaterThan(0);

    const before = h.embedQueryCalls();
    await searchAiPath(h, { query: ANSWERABLE, limit: 20 });
    const afterFull = h.embedQueryCalls();
    // 대조군 — full 모드는 엔티티 채널 때문에 쿼리 임베딩을 만든다.
    expect(afterFull).toBeGreaterThan(before);

    await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    // index 모드는 그 호출에 도달조차 하지 않는다 — 횟수가 그대로다.
    expect(h.embedQueryCalls()).toBe(afterFull);
  });

  test("index 응답에는 entityHits 칸 자체가 없다(채널을 안 돌렸다)", async () => {
    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    expect(Object.keys(idx)).not.toContain("entityHits");
  });
});

// ── 5. limit — index 별도 상한 (spec C 계약 5) ──────────────────────────────

describe("index limit — full(50) 과 별도 상한 + 하드 최대 100", () => {
  let h: Harness;
  afterEach(() => h.db.close());

  test("limit 미지정 index — settings.search.indexModeLimit 을 default 로 쓴다", async () => {
    h = makeHarness({ indexModeLimit: 3 });
    await seed(h); // 5건
    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: undefined,
      responseMode: "index",
      // 하한선을 꺼야 건수 상한만 관측된다(하한선은 별 시험에서 본다).
    });
    // settings 3 이 default 로 먹었다 — full 의 default(10)가 아니다.
    expect(idx.processing_info.totalFound).toBe(CORPUS.length);
    expect(idx.results.length).toBeLessThanOrEqual(3);
  });

  test("full 은 여전히 default 10 / 최대 50 — index 상한이 안 샌다", async () => {
    h = makeHarness({ indexModeLimit: 3 });
    await seed(h);
    // full 모드에 indexModeLimit(3)이 새면 3건으로 잘렸을 것이다.
    const full = await postSearchRest(h, { query: ANSWERABLE });
    expect(full.results.length).toBe(CORPUS.length); // 5건 < default 10
  });

  test("index limit 100 초과는 100 으로 clamp(거부 아님 — 기존 limit 관례)", async () => {
    h = makeHarness();
    await seed(h);
    // clamp 를 직접 관측하려면 retriever 가 받은 limit 을 봐야 한다. 캐시 키에
    // 그 값이 실리므로, limit 101 과 limit 100 이 같은 캐시 슬롯을 쓰는지로 본다.
    const cached = makeHarness({ withCache: true });
    await seed(cached);
    await searchAiPath(cached, {
      query: ANSWERABLE,
      limit: INDEX_MODE_LIMIT_MAX,
      responseMode: "index",
    });
    const afterFirst = cached.retrieveCalls();
    await searchAiPath(cached, {
      query: ANSWERABLE,
      limit: INDEX_MODE_LIMIT_MAX + 1,
      responseMode: "index",
    });
    // 101 이 100 으로 접혔으므로 캐시 키가 같아 retriever 를 다시 안 돌린다.
    expect(cached.retrieveCalls()).toBe(afterFirst);
    cached.db.close();
  });

  test("INDEX_MODE_LIMIT_MAX 는 spec C 가 고정한 100", () => {
    expect(INDEX_MODE_LIMIT_MAX).toBe(100);
  });
});

// ── 6. 캐시 공유 — full/index 가 같은 RRF 캐시를 쓴다 (spec C 계약 5) ───────

describe("RRF 캐시 공유 — responseMode 는 캐시 키에 안 들어간다", () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness({ withCache: true });
    await seed(h);
  });
  afterEach(() => h.db.close());

  test("같은 질의·같은 limit — full 다음 index 는 retriever 재실행 없이 캐시 hit", async () => {
    const full = await searchAiPath(h, { query: ANSWERABLE, limit: 20 });
    expect(h.retrieveCalls()).toBe(1);

    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    // 캐시 키에 responseMode 칸이 없으므로 두 번째는 hit — retriever 가 안 돈다.
    expect(h.retrieveCalls()).toBe(1);
    // 캐시를 공유해도 결과 id 집합은 같다(같은 RRF 산출을 성형만 달리했다).
    expect(idx.results.map((r) => r.id)).toEqual(full.results.map((r) => r.id));
  });

  test("limit 이 다르면 기존 캐시 키 칸(limit)이 갈라 miss 가 난다(정상)", async () => {
    await searchAiPath(h, { query: ANSWERABLE, limit: 20, responseMode: "index" });
    expect(h.retrieveCalls()).toBe(1);
    await searchAiPath(h, { query: ANSWERABLE, limit: 7, responseMode: "index" });
    // limit 은 이미 캐시 키 칸(9)이라 신설 칸 없이 자연히 갈린다.
    expect(h.retrieveCalls()).toBe(2);
  });
});

// ── 7. 하한선(T20)이 index 모드에도 걸린다 (브리핑 항목6) ───────────────────

describe("결과 하한선 — index 모드도 같은 AI 경로·같은 플래그로 탄다", () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness();
    await seed(h);
  });
  afterEach(() => h.db.close());

  test("무관 질의 index — 0건 + totalFound>0 + afterFiltering 0(정직한 회신)", async () => {
    const idx = await searchAiPath(h, {
      query: UNANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    expect(idx.results.length).toBe(0);
    expect(idx.count).toBe(0);
    // "기억이 아예 없음"이 아니라 "있었지만 관련 있는 게 없음"이 보인다(D-B).
    expect(idx.processing_info.totalFound).toBeGreaterThan(0);
    expect(idx.processing_info.afterFiltering).toBe(0);
    expect(idx.processing_info.returned).toBe(0);
    // 0건이어도 포인터 문구는 그대로 — 회신 양식이 흔들리지 않는다.
    expect(idx.pointer).toBe(POINTER_SENTENCE);
  });

  test("하한선 적용 순서 — index 성형은 하한선 *뒤*(탈락분이 목록에 없다)", async () => {
    const rest = await postSearchRest(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    const ai = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    // 대시보드 REST 는 하한선 OFF 라 꼬리까지 색인이 나온다(대조군).
    expect(rest.results.length).toBe(CORPUS.length);
    // AI 경로는 하한선이 걸려 더 적다 — 성형이 하한선 뒤라는 증거.
    expect(ai.results.length).toBeLessThan(rest.results.length);
    expect(ai.processing_info.afterFiltering).toBe(ai.results.length);
  });

  test("하한선 OFF 토글 — index 모드도 꼬리를 그대로 회신한다", async () => {
    const offH = makeHarness({ resultFloor: { enabled: false } });
    await seed(offH);
    const idx = await searchAiPath(offH, {
      query: UNANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    expect(idx.results.length).toBe(CORPUS.length);
    offH.db.close();
  });

  test("index 응답의 trimmedByBudget 은 0 — 컨텍스트 조립을 안 한다(정직한 값)", async () => {
    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
      contextBudget: 500,
    });
    // contextBudget 을 줘도 index 모드는 조립 단계에 도달하지 않는다.
    expect(idx.processing_info.trimmedByBudget).toBe(0);
    expect(Object.keys(idx)).not.toContain("context");
  });
});

// ── 9. 자식→부모 치환 (수정 1회차 Medium 2) ────────────────────────────────
//
// 포인터 문구는 "이 목록의 id 로 get_memory 를 부르면 본문을 받는다"고 약속한다.
// 자식 청크(llm_extract·image_caption) id 가 그대로 실리면 그 약속이 깨진다 —
// 그 id 로 조회하면 저장된 기억이 아니라 파편이 온다.

/** 원본(auto_capture) + 추출(llm_extract) 자식 + merged_into 엣지(기존 선례 양식). */
async function addRawWithExtract(
  store: SqliteMemoryStore,
  rawContent: string,
  extractContent: string,
): Promise<{ rawId: number; extractId: number }> {
  const rawId = await store.addNode({ content: rawContent, sourceType: "auto_capture" });
  const extractId = await store.addNode({
    content: extractContent,
    sourceType: "llm_extract",
  });
  await store.addEdge({
    sourceId: extractId,
    targetId: rawId,
    relation: "merged_into",
    provenance: "user_input",
    sourceNodeId: null,
    weight: 1.0,
  });
  return { rawId, extractId };
}

describe("index 목록의 id 는 조회 가능한 기억이어야 한다(포인터 계약)", () => {
  let h: Harness;
  afterEach(() => h.db.close());

  test("자식 추출이 걸리면 부모 원본 id 로 치환된다 — 자식 id 는 안 실린다", async () => {
    h = makeHarness();
    const { rawId, extractId } = await addRawWithExtract(
      h.store,
      "지난 주말에 친구들과 한강에서 자전거를 탔다. 날씨가 좋았다.",
      "자전거를 탔다",
    );
    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    const ids = idx.results.map((r) => r.id);
    expect(ids).toContain(rawId);
    // 자식 id 가 실리면 get_memory 가 파편을 준다 — 계약 위반.
    expect(ids).not.toContain(extractId);
  });

  test("부모·자식이 둘 다 걸려도 한 항목으로 합친다(같은 기억 중복 표시 0)", async () => {
    h = makeHarness();
    const { rawId } = await addRawWithExtract(
      h.store,
      "지난 주말에 친구들과 한강에서 자전거를 탔다",
      "한강에서 자전거를 탔다",
    );
    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    const occurrences = idx.results.filter((r) => r.id === rawId).length;
    expect(occurrences).toBe(1);
    // 항목 수와 고유 id 수가 같다 — 목록 어디에도 중복이 없다.
    const uniqueIds = new Set(idx.results.map((r) => r.id));
    expect(uniqueIds.size).toBe(idx.results.length);
  });

  test("치환된 항목의 oneLine·date 는 부모 기준 — 목록과 본문이 같은 기억을 가리킨다", async () => {
    h = makeHarness();
    const { rawId } = await addRawWithExtract(
      h.store,
      "지난 주말에 친구들과 한강에서 자전거를 탔다. 날씨가 좋았다.",
      "자전거를 탔다",
    );
    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    const item = idx.results.find((r) => r.id === rawId) as unknown as IndexItem;
    // 부모 본문의 첫 문장이어야 한다(자식 본문 "자전거를 탔다" 가 아니라).
    expect(item.oneLine).toBe("지난 주말에 친구들과 한강에서 자전거를 탔다.");
  });

  test("고아 자식(merged_into 엣지 없음)은 자식 그대로 남는다(가짜 부모 0)", async () => {
    h = makeHarness();
    const orphanId = await h.store.addNode({
      content: "자전거를 탔다",
      sourceType: "llm_extract",
    });
    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    // 부모가 없으면 없는 부모를 지어내지 않고 자식을 그대로 회신한다.
    expect(idx.results.map((r) => r.id)).toContain(orphanId);
  });

  test("자식이 없으면 부모 풀이 질의를 아예 안 한다(비용 0)", async () => {
    h = makeHarness();
    await seed(h); // 전부 일반 노드
    let parentLookups = 0;
    const realCap = h.store.getImageAssetParentsOfCaptions.bind(h.store);
    h.store.getImageAssetParentsOfCaptions = ((ids: readonly number[]) => {
      if (ids.length > 0) parentLookups += 1;
      return realCap(ids);
    }) as typeof h.store.getImageAssetParentsOfCaptions;
    const realExt = h.store.getRawParentsOfExtracts.bind(h.store);
    h.store.getRawParentsOfExtracts = ((ids: readonly number[]) => {
      if (ids.length > 0) parentLookups += 1;
      return realExt(ids);
    }) as typeof h.store.getRawParentsOfExtracts;

    await searchAiPath(h, { query: ANSWERABLE, limit: 20, responseMode: "index" });
    // 자식 후보가 0건이면 빈 배열이 넘어가 질의 진입조차 안 한다.
    expect(parentLookups).toBe(0);
  });

  test("full 모드와 index 모드가 같은 부모를 고른다(두 통로 판정 일치)", async () => {
    h = makeHarness();
    const { rawId } = await addRawWithExtract(
      h.store,
      "지난 주말에 친구들과 한강에서 자전거를 탔다",
      "자전거를 탔다",
    );
    const full = await searchAiPath(h, { query: ANSWERABLE, limit: 20 });
    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    expect(full.results.map((r) => r.id)).toContain(rawId);
    expect(idx.results.map((r) => r.id)).toEqual(full.results.map((r) => r.id));
  });
});

// ── 10. contextBudget 캐시 분할 방지 (수정 1회차 Medium 1) ──────────────────

describe("contextBudget 이 index 캐시를 가르지 않는다", () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness({ withCache: true });
    await seed(h);
  });
  afterEach(() => h.db.close());

  test("budget 없는 full 다음 index(budget 있음) — 같은 슬롯(0 고정의 실효)", async () => {
    // full 은 budget 미지정 → ctx 0. index 는 budget 500 을 줘도 0 으로 고정된다.
    // 두 호출이 같은 RRF 산출을 공유하는 것이 이 고정의 목적이다.
    await searchAiPath(h, { query: ANSWERABLE, limit: 20 });
    expect(h.retrieveCalls()).toBe(1);

    await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      contextBudget: 500,
      responseMode: "index",
    });
    // 고정이 없었다면 ctx 500 으로 키가 갈려 retriever 가 한 번 더 돌았다.
    expect(h.retrieveCalls()).toBe(1);
  });

  test("budget 있는 full 은 index 와 슬롯이 갈린다 — 그쪽은 실제로 조립했다", async () => {
    // 고정이 못 메우는 갈래를 정직하게 고정한다. full(budget>0)은 컨텍스트를 정말
    // 조립하므로 "조립 분기" 칸의 값이 다른 것이 맞다 — 같은 슬롯에 넣으면 캐시가
    // 거짓말을 하게 된다. index 끼리 뭉치는 것이 이 수정의 실제 이득이다.
    await searchAiPath(h, { query: ANSWERABLE, limit: 20, contextBudget: 500 });
    expect(h.retrieveCalls()).toBe(1);
    await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      contextBudget: 500,
      responseMode: "index",
    });
    expect(h.retrieveCalls()).toBe(2);
  });

  test("index 끼리 budget 이 달라도 같은 슬롯(어차피 조립을 안 한다)", async () => {
    await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      contextBudget: 0,
      responseMode: "index",
    });
    expect(h.retrieveCalls()).toBe(1);
    await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      contextBudget: 900,
      responseMode: "index",
    });
    expect(h.retrieveCalls()).toBe(1);
  });

  test("index 에 budget 을 줘도 context 는 안 조립된다(0 고정이 거짓말이 아님)", async () => {
    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      contextBudget: 900,
      responseMode: "index",
    });
    expect(Object.keys(idx)).not.toContain("context");
    expect(idx.processing_info.trimmedByBudget).toBe(0);
  });
});

// ── 11. afterFiltering 생존자 기준 (수정 1회차 Low) ─────────────────────────

describe("index processing_info — 하한선 토글과 무관하게 생존자 기준", () => {
  let h: Harness;
  afterEach(() => h.db.close());

  test("하한선 OFF + 코퍼스 > limit — afterFiltering 이 절단 전 수를 쓰지 않는다", async () => {
    h = makeHarness({ resultFloor: { enabled: false } });
    await seed(h, true); // 12건

    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 3,
      responseMode: "index",
    });
    const pi = idx.processing_info;

    // fixture 전제 — 절단이 실제로 일어나는 조건.
    expect(pi.totalFound).toBe(CORPUS.length + CORPUS_EXTRA.length);
    expect(pi.totalFound).toBeGreaterThan(3);

    // 옛 구현은 여기서 stats.afterFiltering(절단 전 12)을 실어 returned(3)와
    // 다른 모집단을 셌다. 지금은 손에 든 결과 수를 센다.
    expect(pi.afterFiltering).toBe(idx.results.length);
    expect(pi.afterFiltering).toBeLessThanOrEqual(3);
    // 세 수가 단조롭다.
    expect(pi.totalFound).toBeGreaterThanOrEqual(pi.afterFiltering);
    expect(pi.afterFiltering).toBeGreaterThanOrEqual(pi.returned);
  });

  test("하한선 ON — 여전히 생존자 기준(도입 시 동작 유지)", async () => {
    h = makeHarness();
    await seed(h, true);
    const idx = await searchAiPath(h, {
      query: UNANSWERABLE,
      limit: 50,
      responseMode: "index",
    });
    expect(idx.processing_info.totalFound).toBeGreaterThan(0);
    expect(idx.processing_info.afterFiltering).toBe(0);
    expect(idx.processing_info.returned).toBe(0);
  });

  test("full 모드의 afterFiltering 의미는 안 바뀐다(index 수정이 안 샌다)", async () => {
    h = makeHarness({ resultFloor: { enabled: false } });
    await seed(h, true);
    const rest = await postSearchRest(h, { query: UNANSWERABLE, limit: 3 });
    // full·하한선 미적용 경로는 옛 의미(limit 절단 전 수) 그대로 — byte 동일 계약.
    expect(rest.processing_info.afterFiltering).toBe(
      CORPUS.length + CORPUS_EXTRA.length,
    );
    expect(rest.results.length).toBe(3);
  });
});

// ── 8. 토큰 상한 계약 — 회신 총량이 위에서 닫힌다 ──────────────────────────

describe("토큰 상한 — indexModeLimit × 건당 상한으로 닫힌다(spec C 산법)", () => {
  let h: Harness;
  afterEach(() => h.db.close());

  test("긴 본문 5건 — 모든 oneLine 이 상한 이하라 총량이 계산 가능하다", async () => {
    h = makeHarness();
    for (let i = 0; i < 5; i++) {
      await h.store.addNode({ content: `자전거 ${"매우 긴 본문 내용 ".repeat(80)}` });
    }
    const idx = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      responseMode: "index",
    });
    expect(idx.results.length).toBeGreaterThan(0);
    for (const item of idx.results as unknown as IndexItem[]) {
      expect(item.oneLine.length).toBeLessThanOrEqual(ONE_LINE_MAX_CHARS);
    }
    // 건당 상한 × 건수가 실제 총량의 상한이다(계약이 산술로 닫힌다).
    const totalOneLineChars = (idx.results as unknown as IndexItem[]).reduce(
      (sum, r) => sum + r.oneLine.length,
      0,
    );
    expect(totalOneLineChars).toBeLessThanOrEqual(
      idx.results.length * ONE_LINE_MAX_CHARS,
    );
  });
});
