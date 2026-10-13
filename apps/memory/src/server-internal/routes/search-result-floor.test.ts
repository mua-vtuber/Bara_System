/**
 * search-result-floor.test.ts — AI 경로 검색 결과 하한선 (T20 / spec F / 결정 D-B).
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder + 실 HybridRetriever. mock 객체 0.
 *
 * 검증 항목(브리핑 Tests 절):
 *   1. 무관 질의 — AI 경로 0건 회신 + totalFound > 0 (있었지만 관련 없음이 보인다).
 *   2. 정답 있는 질의 — 정답이 하한선을 살아남는다(회수 회귀 0).
 *   3. undefined cosine 통과 — 순수 함수 직접 단언(강도 미관측 ≠ 무관).
 *   4. OFF 토글 — 두 경로 모두 byte 동일.
 *   5. 대시보드 REST 경로 — 토글 ON 이어도 미적용(전체 표시).
 *   6. afterFiltering 숫자 정확성(하한선 탈락분 반영).
 *   7. enrich 전 적용 — 탈락 노드의 후처리 미실행(관측 가능한 효과로 단언).
 *
 * ## 코퍼스 cosine 실측 (2026-08-03 본 PC / bge-m3 q8 / t20-probe.ts)
 *
 * 아래 코퍼스·질의 조합의 vectorRawCosine 을 미리 재서 임계(0.44) 와의 간격을
 * 확인하고 테스트를 짰다 — 추측으로 쓰면 임계 근처에서 조용히 깨진다.
 *
 *   "자전거"           → 자전거 글 0.6317(통과, 여유 0.19) / 나머지 0.2940~0.4399(탈락)
 *   "심해 열수구..."    → 전건 0.2690~0.3399 (전부 탈락 → 0건)
 *   "고대 수메르..."    → 전건 0.2137~0.3266 (전부 탈락 → 0건)
 *
 * 융합 점수로는 못 가른다는 T19 실측도 이 코퍼스에서 재현된다 — "심해 열수구"의
 * 최상위 무관 결과 score 0.3141 이 "자전거" 정답 score 0.3426 과 거의 같은 자리다.
 * 그래서 관측 대상이 raw cosine 이어야 한다.
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
import { Reranker } from "../../memory/reranker.ts";
import { buildMemoryApi } from "../../server.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import type { RetrievalResult } from "../../memory/retriever.ts";
import { runSearchPipeline } from "./search-service.ts";
import { passesResultFloor, applyResultFloor } from "./search-result-floor.ts";
import type { MemoryApiDeps } from "../types.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

/** 실측 확인된 코퍼스(위 헤더 주석 참조). */
const CORPUS = [
  "지난 주말에 친구들과 한강에서 자전거를 탔다",
  "냉장고에 우유가 떨어져서 마트에 들러야 한다",
  "회사 회의에서 다음 분기 예산안을 논의했다",
  "고양이가 새벽 세 시에 울어서 잠을 설쳤다",
  "새로 산 키보드의 타건감이 아주 좋다",
];

/**
 * 코퍼스 > limit 조건을 만들기 위한 확장분(수정 순환 1회차 High). 위 CORPUS 와
 * 합쳐 12건이 되어 limit 3 검색에서 retriever 의 limit 절단이 실제로 일어난다 —
 * `stats.afterFiltering`(절단 전)과 생존자 수(절단 후)의 모집단 차이가 드러나는
 * 유일한 fixture 모양이다.
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

/** 저장한 기억이 하나도 닿지 않는 질의 — 전건 cosine 0.34 이하(실측). */
const UNANSWERABLE = "심해 열수구에 사는 관벌레의 화학합성 대사";
/** 정답이 있는 질의 — 자전거 글 cosine 0.6317(실측, 하한선 위 여유 0.19). */
const ANSWERABLE = "자전거";

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
  deps: MemoryApiDeps;
}

interface HarnessOptions {
  resultFloor?: Partial<MemorySettings["search"]["resultFloor"]>;
  /**
   * 실 Reranker 를 load() 없이 주입한다. 모델 미로드 상태의 rerank 는 graceful
   * degrade 경로(reranker.ts — `byRrf.slice(0, topKOutput)`)를 타서, 모델 다운로드
   * 비용 0 으로 *진짜 topKOutput 절단*을 재현한다. 가짜 구현체가 아니라 운영
   * 클래스 그대로다(mock 금지 원칙 정합).
   */
  rerankerTopKOutput?: number;
}

/**
 * settings 를 명시 주입하는 harness. resultFloor 노브를 시험별로 갈아끼운다.
 * settings 미주입 갈래(default ON)는 별도 시험에서 따로 본다.
 */
function makeHarness(options?: HarnessOptions): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
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
  if (options?.rerankerTopKOutput !== undefined) {
    deps.reranker = new Reranker({
      model: settings.reranker.model,
      topKInput: settings.reranker.topK_input,
      topKOutput: options.rerankerTopKOutput,
      host: "local",
    });
  }
  const app = buildMemoryApi(deps);
  return { app, db, store, deps };
}

async function seed(h: Harness, extra = false): Promise<void> {
  for (const content of CORPUS) await h.store.addNode({ content });
  if (extra) for (const content of CORPUS_EXTRA) await h.store.addNode({ content });
}

interface SearchResponse {
  query: string;
  count: number;
  results: Array<{ id: number; content: string; score: number }>;
  processing_info: {
    totalFound: number;
    afterFiltering: number;
    returned: number;
    trimmedByBudget: number;
  };
}

/** 대시보드 경로 — REST POST /search(플래그 OFF). */
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

/**
 * AI 경로 — MCP search_memory 가 부르는 그 호출 형태를 그대로 재현한다
 * (runSearchPipeline + applyResultFloor:true). MCP 전송 계층까지 태우는 검증은
 * tools-memory.int.test.ts 몫이고, 여기서는 하한선 동작 자체를 본다.
 */
async function searchAiPath(
  h: Harness,
  payload: Record<string, unknown>,
): Promise<SearchResponse> {
  const response = await runSearchPipeline(
    h.deps,
    payload,
    new URLSearchParams(),
    { applyResultFloor: true },
  );
  return response as unknown as SearchResponse;
}

// ── 1. 무관 질의 — AI 경로 0건 + totalFound > 0 (D-B 정직한 빈 결과) ────────

describe("하한선 ON(AI 경로) — 무관 질의는 0건을 정직하게 회신한다", () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness();
    await seed(h);
  });
  afterEach(() => h.db.close());

  test("저장한 적 없는 주제 — results 0건 / totalFound > 0 / afterFiltering 0", async () => {
    const body = await searchAiPath(h, { query: UNANSWERABLE, limit: 20 });

    // D-B — top-k 무조건 채우기 폐기. 관련 없으면 빈 결과가 정직한 상태다.
    expect(body.results.length).toBe(0);
    expect(body.count).toBe(0);

    // "기억이 아예 없음"이 아니라 "있었지만 관련 있는 게 없음"이 보여야 한다.
    expect(body.processing_info.totalFound).toBeGreaterThan(0);
    expect(body.processing_info.afterFiltering).toBe(0);
    expect(body.processing_info.returned).toBe(0);
  });

  test("같은 질의라도 대시보드 REST 경로는 꼬리를 그대로 회신한다(단락 11 확정 3)", async () => {
    const rest = await postSearchRest(h, { query: UNANSWERABLE, limit: 20 });
    // 사람 눈 탐색은 낮은 점수도 단서 — 전체 표시 유지.
    expect(rest.results.length).toBe(CORPUS.length);
    expect(rest.processing_info.afterFiltering).toBe(CORPUS.length);
  });
});

// ── 2. 정답 있는 질의 — 회수 회귀 0 ────────────────────────────────────────

describe("하한선 ON(AI 경로) — 정답은 하한선을 살아남는다(회수 회귀 0)", () => {
  let h: Harness;
  let bikeId: number;
  beforeEach(async () => {
    h = makeHarness();
    bikeId = await h.store.addNode({ content: CORPUS[0]! });
    for (const content of CORPUS.slice(1)) await h.store.addNode({ content });
  });
  afterEach(() => h.db.close());

  test("정답 글이 결과에 남고, 무관 꼬리는 걸러진다", async () => {
    const ai = await searchAiPath(h, { query: ANSWERABLE, limit: 20 });
    const ids = ai.results.map((r) => r.id);

    // 회수 손실 0 — 정답은 반드시 살아남는다(실측 cosine 0.6317 / 하한 0.44).
    expect(ids).toContain(bikeId);
    // 꼬리는 걸렸다 — REST 경로가 5건을 낼 때 AI 경로는 그보다 적다.
    const rest = await postSearchRest(h, { query: ANSWERABLE, limit: 20 });
    expect(rest.results.length).toBe(CORPUS.length);
    expect(ai.results.length).toBeLessThan(rest.results.length);
    // 남은 결과의 순위·점수는 하한선이 안 건드린다 — REST 상위 결과와 같은 순서.
    const restKeptOrder = rest.results
      .filter((r) => ids.includes(r.id))
      .map((r) => r.id);
    expect(ids).toEqual(restKeptOrder);
  });

  test("afterFiltering = 하한선 통과 수 / returned 와 일치", async () => {
    const ai = await searchAiPath(h, { query: ANSWERABLE, limit: 20 });
    expect(ai.processing_info.totalFound).toBe(CORPUS.length);
    expect(ai.processing_info.afterFiltering).toBe(ai.results.length);
    expect(ai.processing_info.returned).toBe(ai.results.length);
    // 하한선이 실제로 뭔가를 걸렀다 — totalFound 보다 작다.
    expect(ai.processing_info.afterFiltering).toBeLessThan(
      ai.processing_info.totalFound,
    );
  });
});

// ── 2-b. 코퍼스 > limit — afterFiltering 모집단 정합 (수정 순환 1회차 High) ──
//
// 이 fixture 모양(코퍼스 12 > limit 3)에서만 드러나는 결함이 있었다. retriever 는
// `stats.afterFiltering` 을 limit 절단 *전* 에 재는데(retriever.ts — `results.length`
// 를 `slice(0, limit)` 앞에서 캡처), 하한선은 이미 절단된 배열을 거른다. 옛 구현이
// 두 수를 뺄셈해서(`stats.afterFiltering - dropped`) 모집단이 어긋났다 — 전건
// 탈락인데도 `totalFound 12 / afterFiltering 9 / returned 0` 이 나와 D-B 의 정직한
// 0 신호가 뒤집혔다. 지금은 생존자를 직접 센다.

describe("코퍼스 > limit — afterFiltering 이 생존자 기준으로 정합(High 회귀 고정)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness();
    await seed(h, true); // 12건
  });
  afterEach(() => h.db.close());

  test("전건 탈락 + limit 절단 동시 — totalFound>0 / afterFiltering=0 / returned=0", async () => {
    const ai = await searchAiPath(h, { query: UNANSWERABLE, limit: 3 });

    // limit 절단이 실제로 일어나는 조건인지부터 확인(fixture 가 의미를 갖는 전제).
    expect(ai.processing_info.totalFound).toBe(
      CORPUS.length + CORPUS_EXTRA.length,
    );
    expect(ai.processing_info.totalFound).toBeGreaterThan(3);

    // 하한선을 아무것도 통과 못 했으므로 0 이어야 한다. 옛 뺄셈 구현은 여기서 9 였다.
    expect(ai.processing_info.afterFiltering).toBe(0);
    expect(ai.processing_info.returned).toBe(0);
    expect(ai.results.length).toBe(0);
  });

  test("정답 있는 질의 + limit 절단 — 세 수가 단조롭다(totalFound >= afterFiltering >= returned)", async () => {
    const ai = await searchAiPath(h, { query: ANSWERABLE, limit: 3 });
    const pi = ai.processing_info;

    expect(pi.totalFound).toBeGreaterThanOrEqual(pi.afterFiltering);
    expect(pi.afterFiltering).toBeGreaterThanOrEqual(pi.returned);
    expect(pi.afterFiltering).toBe(ai.results.length);
    expect(pi.returned).toBe(ai.results.length);
    // 음수가 될 수 없다(옛 구현은 절단이 겹치면 음수도 가능했다).
    expect(pi.afterFiltering).toBeGreaterThanOrEqual(0);
  });

  test("대시보드 REST 경로는 이 조건에서도 옛 의미(limit 절단 전 수)를 그대로 유지한다", async () => {
    const rest = await postSearchRest(h, { query: UNANSWERABLE, limit: 3 });
    // 하한선 미적용 경로는 stats 값을 그대로 쓴다 — 도입 전 byte 동일.
    expect(rest.processing_info.afterFiltering).toBe(
      CORPUS.length + CORPUS_EXTRA.length,
    );
    expect(rest.results.length).toBe(3); // limit 절단만 적용
  });
});

// ── 2-c. 리랭커 topKOutput 절단이 겹칠 때 — 음수 불가 ──────────────────────

describe("리랭커 절단 + 하한선 — afterFiltering 이 음수가 되지 않는다(High 회귀 고정)", () => {
  let h: Harness;
  beforeEach(async () => {
    // 실 Reranker 를 load() 없이 주입 — graceful degrade 경로가 topKOutput 으로
    // 한 번 더 자른다(모델 다운로드 0). 절단이 두 겹이면 옛 뺄셈은 음수가 났다.
    h = makeHarness({ rerankerTopKOutput: 2 });
    await seed(h, true); // 12건
  });
  afterEach(() => h.db.close());

  test("무관 질의 — 리랭커가 2건으로 자른 뒤 전건 탈락해도 afterFiltering=0", async () => {
    const ai = await searchAiPath(h, { query: UNANSWERABLE, limit: 20 });
    const pi = ai.processing_info;

    expect(pi.totalFound).toBe(CORPUS.length + CORPUS_EXTRA.length);
    expect(pi.afterFiltering).toBe(0);
    expect(pi.afterFiltering).toBeGreaterThanOrEqual(0);
    expect(pi.returned).toBe(0);
  });

  test("정답 질의 — 리랭커 절단 뒤에도 단조성 유지 + 정답 보존", async () => {
    const ai = await searchAiPath(h, { query: ANSWERABLE, limit: 20 });
    const pi = ai.processing_info;

    expect(pi.totalFound).toBeGreaterThanOrEqual(pi.afterFiltering);
    expect(pi.afterFiltering).toBeGreaterThanOrEqual(pi.returned);
    expect(pi.afterFiltering).toBe(ai.results.length);
    // 리랭커 topKOutput=2 상한을 넘지 않는다.
    expect(ai.results.length).toBeLessThanOrEqual(2);
    // 정답은 살아남는다(회수 회귀 0).
    expect(ai.results.some((r) => r.content.includes("자전거"))).toBe(true);
  });
});

// ── 3. undefined cosine 통과 — 순수 함수 직접 단언 ─────────────────────────

describe("passesResultFloor — vectorRawCosine 미관측은 통과(강도 미관측 ≠ 무관)", () => {
  /** 판정에 필요한 최소 형태만 갖춘 데이터 fixture(인터페이스 구현체 아님). */
  function resultWith(components: Record<string, number>): RetrievalResult {
    return {
      node: { id: 1, content: "x" },
      score: 0.1,
      sources: ["fts"],
      components,
    } as unknown as RetrievalResult;
  }

  const ABSOLUTE = { mode: "absolute", floor: 0.44 } as const;

  test("vectorRawCosine 칸 자체가 없으면 통과한다", () => {
    // fts·graph 채널로만 올라온 노드 — vector 채널에 안 떠서 칸이 없다. 이걸
    // cosine 0 으로 읽으면 정상 결과를 버린다(T19 인계 항목2).
    expect(passesResultFloor(resultWith({ rrf: 0.3 }), ABSOLUTE)).toBe(true);
  });

  test("cosine 0 은 실제 관측값이므로 탈락한다(미관측과 구분)", () => {
    // 0 은 "vector 채널에 떴는데 전혀 안 닮음"이라는 진짜 측정값이다.
    expect(passesResultFloor(resultWith({ vectorRawCosine: 0 }), ABSOLUTE)).toBe(false);
  });

  test("임계 경계 — floor 정확값은 통과(>=), 바로 아래는 탈락", () => {
    expect(passesResultFloor(resultWith({ vectorRawCosine: 0.44 }), ABSOLUTE)).toBe(true);
    expect(passesResultFloor(resultWith({ vectorRawCosine: 0.4399 }), ABSOLUTE)).toBe(false);
  });

  test("미구현 방식(baselineMargin)은 조용히 통과시키지 않고 명시적으로 멈춘다", () => {
    // 게이트가 꺼진 걸 아무도 모르는 상태를 만들지 않는다.
    expect(() =>
      passesResultFloor(resultWith({ vectorRawCosine: 0.9 }), {
        mode: "baselineMargin",
        baselinePercentile: 50,
        margin: 0.02,
      }),
    ).toThrow(/not implemented/);
  });
});

// ── 4. OFF 토글 — 두 경로 byte 동일 ────────────────────────────────────────

describe("OFF 토글 — 하한선 도입 전과 byte 동일(spec F 테스트 의무)", () => {
  let onH: Harness;
  let offH: Harness;
  let modeOffH: Harness;
  beforeEach(async () => {
    onH = makeHarness();
    offH = makeHarness({ resultFloor: { enabled: false } });
    modeOffH = makeHarness({ resultFloor: { mode: "off" } });
    await seed(onH);
    await seed(offH);
    await seed(modeOffH);
  });
  afterEach(() => {
    onH.db.close();
    offH.db.close();
    modeOffH.db.close();
  });

  test("enabled=false — AI 경로가 REST 경로와 완전히 같은 결과를 낸다", async () => {
    const ai = await searchAiPath(offH, { query: UNANSWERABLE, limit: 20 });
    const rest = await postSearchRest(offH, { query: UNANSWERABLE, limit: 20 });

    expect(ai.results.map((r) => r.id)).toEqual(rest.results.map((r) => r.id));
    expect(ai.count).toBe(rest.count);
    expect(ai.processing_info).toEqual(rest.processing_info);
    // 토글 OFF 면 무관 질의에서도 꼬리가 그대로 온다(도입 전 동작).
    expect(ai.results.length).toBe(CORPUS.length);
  });

  test("mode='off' — enabled 와 무관하게 자르지 않는다", async () => {
    const ai = await searchAiPath(modeOffH, { query: UNANSWERABLE, limit: 20 });
    expect(ai.results.length).toBe(CORPUS.length);
    expect(ai.processing_info.afterFiltering).toBe(CORPUS.length);
  });

  test("ON 과 OFF 의 차이가 실제로 존재한다(토글이 죽은 노브가 아님)", async () => {
    const on = await searchAiPath(onH, { query: UNANSWERABLE, limit: 20 });
    const off = await searchAiPath(offH, { query: UNANSWERABLE, limit: 20 });
    expect(on.results.length).toBe(0);
    expect(off.results.length).toBe(CORPUS.length);
  });
});

// ── 5. 대시보드 REST 경로 — 토글 ON 이어도 미적용 ──────────────────────────

describe("대시보드 REST 경로 — 하한선 토글 ON 에서도 전체 표시(단락 11 확정 3)", () => {
  let floorOnH: Harness;
  let floorOffH: Harness;
  beforeEach(async () => {
    floorOnH = makeHarness({ resultFloor: { enabled: true } });
    floorOffH = makeHarness({ resultFloor: { enabled: false } });
    await seed(floorOnH);
    await seed(floorOffH);
  });
  afterEach(() => {
    floorOnH.db.close();
    floorOffH.db.close();
  });

  test("토글 ON/OFF 두 서버의 REST 응답이 완전히 동일하다", async () => {
    for (const query of [UNANSWERABLE, ANSWERABLE]) {
      const withFloorOn = await postSearchRest(floorOnH, { query, limit: 20 });
      const withFloorOff = await postSearchRest(floorOffH, { query, limit: 20 });

      expect(withFloorOn.results.map((r) => r.id)).toEqual(
        withFloorOff.results.map((r) => r.id),
      );
      expect(withFloorOn.count).toBe(withFloorOff.count);
      expect(withFloorOn.processing_info).toEqual(withFloorOff.processing_info);
      // 하한선 토글이 어떻든 대시보드는 전건을 본다.
      expect(withFloorOn.results.length).toBe(CORPUS.length);
    }
  });
});

// ── 6. enrich 전 적용 — 탈락 노드 후처리 미실행 ────────────────────────────

describe("적용 위치 — 하한선은 enrich 후처리 *앞*에서 돈다(D-D 비용 계약)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness();
    await seed(h);
  });
  afterEach(() => h.db.close());

  test("탈락 노드에 대해서는 요약 합류 조회(getNodeConcepts)를 하지 않는다", async () => {
    // enrich 단계(applySummaries)가 결과 노드마다 store.getNodeConcepts 를 부른다.
    // 하한선이 그 *앞*에 있으면 탈락 노드 id 로는 이 호출이 아예 안 일어난다.
    // 실제 store 메서드 호출을 세어 관측한다(mock 객체 아님 — 실 구현을 감싸
    // 호출 id 만 기록하고 원본을 그대로 위임한다).
    const askedFor: number[] = [];
    const realGetNodeConcepts = h.store.getNodeConcepts.bind(h.store);
    h.store.getNodeConcepts = async (id: number) => {
      askedFor.push(id);
      return realGetNodeConcepts(id);
    };

    const rest = await postSearchRest(h, {
      query: ANSWERABLE,
      limit: 20,
      withSummaries: true,
    });
    const restAsked = [...askedFor];
    askedFor.length = 0;

    const ai = await searchAiPath(h, {
      query: ANSWERABLE,
      limit: 20,
      withSummaries: true,
    });
    const aiAsked = [...askedFor];

    const keptIds = new Set(ai.results.map((r) => r.id));
    const droppedIds = rest.results
      .map((r) => r.id)
      .filter((id) => !keptIds.has(id));

    // 이 시험이 의미를 가지려면 실제로 탈락한 노드가 있어야 한다.
    expect(droppedIds.length).toBeGreaterThan(0);
    // 대시보드 경로는 전건에 대해 후처리를 했다(대조군).
    for (const id of droppedIds) expect(restAsked).toContain(id);
    // AI 경로는 탈락 노드 id 로 후처리를 하지 않았다 — 하한선이 enrich 앞이라는 증거.
    for (const id of droppedIds) expect(aiAsked).not.toContain(id);
    // 통과 노드에 대해서는 정상적으로 후처리했다(게이트가 전부를 막은 게 아님).
    for (const id of keptIds) expect(aiAsked).toContain(id);
  });
});

// ── 7. applyResultFloor 단위 — 미적용 시 입력 배열 그대로 ──────────────────

describe("applyResultFloor — 미적용 갈래는 입력을 그대로 돌려준다", () => {
  const results = [] as RetrievalResult[];

  test("플래그 false 면 settings 를 보지도 않고 그대로 통과(참조 동일 + applied=false)", () => {
    const outcome = applyResultFloor(results, undefined, false);
    expect(outcome.kept).toBe(results);
    // applied=false 라야 호출자가 stats.afterFiltering 을 그대로 쓴다(byte 동일).
    expect(outcome.applied).toBe(false);
  });

  test("토글 OFF 도 applied=false — 호출자가 옛 stats 를 쓰게 한다", () => {
    const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
    settings.search.resultFloor = {
      ...settings.search.resultFloor,
      enabled: false,
    };
    const outcome = applyResultFloor(results, settings, true);
    expect(outcome.kept).toBe(results);
    expect(outcome.applied).toBe(false);
  });

  test("settings 미주입 + 플래그 true — default ON 으로 동작하고 applied=true", () => {
    // buildMemoryApi 직호출 등 settings 없는 갈래에서도 AI 경로는 하한선이 산다
    // (스키마 default enabled=true 와 같은 값 — 조용히 꺼지지 않는다).
    const below = {
      node: { id: 1 },
      score: 0.1,
      sources: ["vector"],
      components: { vectorRawCosine: 0.2 },
    } as unknown as RetrievalResult;
    const outcome = applyResultFloor([below], undefined, true);
    expect(outcome.kept.length).toBe(0);
    // applied=true 라야 호출자가 생존자 수(0)를 afterFiltering 으로 쓴다 — D-B 신호.
    expect(outcome.applied).toBe(true);
  });
});
