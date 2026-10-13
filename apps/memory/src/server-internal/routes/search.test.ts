/**
 * server-internal/routes/search.test.ts — POST /search 라우트 E2E 검증.
 *
 * 1.1b T6 검증 항목:
 *   1. project 칸이 있는 요청 — 200 + results 배열 + concepts/sources 필드 보존.
 *   2. project 칸이 없는 요청 — 200(1.1a 동작 그대로).
 *   3. project 가 빈 문자열 — project 칸 없는 요청과 동일하게 200 처리.
 *   4. 검색은 retriever 직행(LLM 의존성 주입 0).
 *
 * 1.1c T5 검증 항목(POST body 로 세 필터 동작 — 라우트가 retriever 에 전달):
 *   5. filter 칸 — `#만화` 태그 + `review:만화` 분류 자산이 한 query 로 둘 다
 *      잡힘(name UNIQUE 통합) + 다른 분류·무라벨 제외 + 무효 filter 미적용.
 *   6. polarity 칸 — positive 라벨 노드만 회수(negative·neutral·NULL 제외) +
 *      무효 polarity 문자열·body 부재 미적용.
 *   7. cue — "왜 바꿨더라" 관계 cue query 가 graph 채널 가중치 자동 검출
 *      (components.cueGraphBoost 가 라우트 응답에 보존됨 / 라우트 추가 파싱 0).
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder. mock 없음.
 * project_vocabularies 에 실제 행이 없어도 정상 검색 복귀(expansion 0 자연 degrade).
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
import { HybridRetriever, type RetrieveOptions } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi } from "../../server.ts";
import { getMemorySettings } from "../../settings/memory-settings.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import { detectCues } from "../../memory/search-cues.ts";
import { RELATION_CUE_GRAPH_BOOST } from "../../memory/search-tuning.ts";
import { resolvePlaceSignal } from "./search.ts";
import { SearchCache } from "../../memory/search-cache.ts";

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
  retrieveCalls: () => number;
  retrieveOptions: () => RetrieveOptions[];
}

/**
 * settings override 옵션 — 주입하면 search 라우트가 `deps.getSettings()` 로 그
 * 값을 읽어 `settings.chunking.maxContextTokens` 를 인접 청크 묶기 토큰 한도로
 * 쓴다(search.ts L222~223). 미주입이면 라우트가 DEFAULT_MAX_CONTEXT_TOKENS(2000)
 * 로 degrade — 14b T3 불변식 대조 테스트가 이 통로로 한도 0 vs 2000 을 만든다.
 */
function makeHarness(opts?: {
  maxContextTokens?: number;
  withCache?: boolean;
}): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  let calls = 0;
  const options: RetrieveOptions[] = [];
  // T10 — search-retrieval.ts 가 retrieve() 대신 retrieveWithStats() 를 부르므로
  // (retrieve() 는 그 위의 얇은 래퍼로 바뀜) 실제 호출 경로에 spy 를 건다.
  const realRetrieveWithStats = retriever.retrieveWithStats.bind(retriever);
  retriever.retrieveWithStats = ((query, retrieveOptions) => {
    calls += 1;
    options.push({ ...(retrieveOptions ?? {}) });
    return realRetrieveWithStats(query, retrieveOptions);
  }) as typeof retriever.retrieveWithStats;
  const assembler = new ContextAssembler();
  let getSettings: (() => MemorySettings) | undefined;
  if (opts?.maxContextTokens !== undefined) {
    const base = getMemorySettings("/nonexistent-default-search-test", "/nonexistent-default-search-test.secrets.json");
    const overridden: MemorySettings = {
      ...base,
      chunking: { ...base.chunking, maxContextTokens: opts.maxContextTokens },
    };
    getSettings = () => overridden;
  }
  // searchCache 는 createMemoryApi 만 자동 주입한다(buildMemoryApi 직호출은 미주입).
  // 0건 폴백 캐시 키 분리(T6 D6)를 검증하려면 캐시를 직접 주입해야 한다.
  const searchCache = opts?.withCache ? new SearchCache() : undefined;
  const app = buildMemoryApi({
    store,
    retriever,
    assembler,
    getSettings,
    ...(searchCache ? { searchCache } : {}),
  });
  return {
    app,
    db,
    store,
    searchCache,
    retrieveCalls: () => calls,
    retrieveOptions: () => options,
  };
}

async function jsonBody(res: Response): Promise<unknown> {
  return res.json();
}

// ── POST /search — T6 project 칸 검증 ──────────────────────────────────────

describe("POST /search — T6 project body 칸 + 1.1a 응답 형태 보존", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  async function ingest(content: string): Promise<number> {
    const res = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const body = (await jsonBody(res)) as { id: number };
    return body.id;
  }

  test("project 칸이 있을 때 — 200 + results 배열 + concepts/sources 필드 보존", async () => {
    await ingest("bara_system 은 메모리 모듈이다");
    await ingest("검색 기능을 제공한다");

    const res = await h.app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "메모리", project: "bara_system", limit: 5 }),
    });

    expect(res.status).toBe(200);

    const body = (await jsonBody(res)) as {
      query: string;
      count: number;
      results: Array<{
        id: number;
        content: string;
        score: number;
        sources: string[];
        components: Record<string, number>;
        concepts: { direct: unknown[]; neighbors: unknown[] };
      }>;
    };
    expect(body.query).toBe("메모리");
    expect(body.count).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.results)).toBe(true);

    // 검색은 LLM 없이 retriever 경로로 직행한다. 시간 단언은 콜드 임베딩 추론에 흔들린다.
    expect(h.retrieveCalls()).toBe(1);

    // 1.1a 응답 형태 보존 확인 (sources / components / concepts 필드)
    // concepts = { direct: [], neighbors: [] } 객체 (getNodeConceptExpansion 반환 형태)
    const first = body.results[0]!;
    expect(Array.isArray(first.sources)).toBe(true);
    expect(first.components).toBeDefined();
    expect(first.concepts).toBeDefined();
    expect(Array.isArray(first.concepts.direct)).toBe(true);
    expect(Array.isArray(first.concepts.neighbors)).toBe(true);
  });

  test("project 칸이 없을 때 — 200 (1.1a 동작 그대로)", async () => {
    await ingest("커피를 마셨다");

    const res = await h.app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "커피", limit: 5 }),
    });
    expect(res.status).toBe(200);

    const body = (await jsonBody(res)) as { count: number; results: unknown[] };
    expect(body.count).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.results)).toBe(true);
  });

  test("project 가 빈 문자열이면 200 + expansion 없이 정상 검색", async () => {
    await ingest("분산 시스템 이야기");

    const res = await h.app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "분산", project: "", limit: 5 }),
    });
    expect(res.status).toBe(200);

    const body = (await jsonBody(res)) as { count: number };
    expect(typeof body.count).toBe("number");
  });

  test("project 가 비문자열이면 무시하고 정상 검색", async () => {
    await ingest("그래프 탐색");

    const res = await h.app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "그래프", project: 42, limit: 5 }),
    });
    expect(res.status).toBe(200);

    const body = (await jsonBody(res)) as { count: number };
    expect(typeof body.count).toBe("number");
  });
});

// ── POST /search — 1.1c T5 polarity / filter / cue E2E ─────────────────────
//
// 라우트가 body polarity/filter 를 retriever 에 전달하고 cue 는 retriever 가
// 자동 검출함을 HTTP 경로로 검증한다. 데이터는 store 로 직접 적재한다(태그·분류·
// polarity 입력 통로 — HTTP ingest 라우트는 해시태그·분류·polarity 를 받지 않음).
// 검증 대상은 *라우트 wiring* 이다 — retriever 내부 동작은 T2~T4 eval 이 이미 덮음.

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
  searchMode: "strict" | "relaxed";
  relaxed: boolean;
  strictCount: number;
  removedFilters: string[];
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
  return (await jsonBody(res)) as SearchResponse;
}

describe("POST /search — 1.1c T5 filter 칸(학술 분류 / name UNIQUE 통합)", () => {
  let h: Harness;
  let mangaTagNode: number;
  let mangaClassNode: number;
  let novelNode: number;
  let noLabelNode: number;

  beforeEach(async () => {
    h = makeHarness();
    // `#만화` 태그 통로 자산(role='tag').
    mangaTagNode = await h.store.addNode({ content: "어제 새 만화 한 권을 다 읽었다" });
    const cidTag = await h.store.findOrCreateTagConcept("만화");
    await h.store.addNodeConceptEdge(mangaTagNode, cidTag, "tag", "user_input", mangaTagNode);
    // `review:만화` 분류 통로 자산(role='classification') — 같은 이름 = 같은 concept.
    mangaClassNode = await h.store.addNode({ content: "이 작품에 리뷰를 길게 남겼다" });
    const cidClass = await h.store.findOrCreateConcept("만화", { isClassificationValue: true });
    await h.store.addNodeConceptEdge(mangaClassNode, cidClass, "classification", "user_input", mangaClassNode);
    // 다른 분류(소설) — 필터가 제외해야 하는 대조군.
    novelNode = await h.store.addNode({ content: "두꺼운 소설을 읽기 시작했다" });
    const cidNovel = await h.store.findOrCreateConcept("소설", { isClassificationValue: true });
    await h.store.addNodeConceptEdge(novelNode, cidNovel, "classification", "user_input", novelNode);
    // 분류 라벨 없는 자산 — 필터가 항상 제외.
    noLabelNode = await h.store.addNode({ content: "그냥 라벨 없이 적은 메모 하나" });
  });
  afterEach(() => {
    h.db.close();
  });

  test("filter.review=만화 — #만화 태그 + review:만화 분류 자산 둘 다 회수 + 다른 분류 제외", async () => {
    const body = await postSearch(h, { query: "작품 메모", limit: 20, filter: { review: "만화" } });
    const ids = new Set(body.results.map((r) => r.id));

    // name UNIQUE 통합 — 두 통로(태그·분류)가 같은 `만화` concept 노드라 둘 다 잡힘.
    expect(ids.has(mangaTagNode)).toBe(true);
    expect(ids.has(mangaClassNode)).toBe(true);
    // 다른 분류·무라벨 제외(후보 축소).
    expect(ids.has(novelNode)).toBe(false);
    expect(ids.has(noLabelNode)).toBe(false);

    console.log(
      `[1.1c T5 E2E filter] POST filter.review=만화 → ${body.count}건 ` +
        `(#만화 태그·review:만화 분류 통합 / 소설·무라벨 제외)`,
    );
  });

  test("filter 미지정 vs 지정 — 후보 축소 효과(HTTP 경로)", async () => {
    const before = await postSearch(h, { query: "작품 메모", limit: 20 });
    const after = await postSearch(h, { query: "작품 메모", limit: 20, filter: { review: "만화" } });
    const beforeIds = new Set(before.results.map((r) => r.id));
    // 미지정 = 전 후보 — 무라벨/소설이 섞임(분별이 vacuous 가 아님).
    expect(beforeIds.has(novelNode) || beforeIds.has(noLabelNode)).toBe(true);
    expect(after.count).toBeGreaterThan(0);
    expect(after.count).toBeLessThan(before.count);
    console.log(`[1.1c T5 E2E filter] filter-off ${before.count}건 → filter-on ${after.count}건`);
  });

  test("무효 filter(비객체·빈 값) 미적용 — 1.1b 동작 불변", async () => {
    // filter 가 배열(비객체) — 라우트가 무시 → 전 후보.
    const arr = await postSearch(h, { query: "작품 메모", limit: 20, filter: [] });
    // filter 값이 빈 문자열 — 유효 항목 0개 → 라우트가 무시 → 전 후보.
    const empty = await postSearch(h, { query: "작품 메모", limit: 20, filter: { review: "  " } });
    const base = await postSearch(h, { query: "작품 메모", limit: 20 });
    expect(arr.count).toBe(base.count);
    expect(empty.count).toBe(base.count);
  });
});

describe("POST /search — 1.1c T5 polarity 칸(D7 후보 축소)", () => {
  let h: Harness;
  let posNode: number;
  let negNode: number;
  let neutralNode: number;
  let nullNode: number;

  beforeEach(async () => {
    h = makeHarness();
    posNode = await h.store.addNode({ content: "이 디자인 정말 마음에 든다", polarity: "positive" });
    negNode = await h.store.addNode({ content: "이 디자인은 영 별로였다", polarity: "negative" });
    neutralNode = await h.store.addNode({ content: "이 디자인은 그냥 무난하다", polarity: "neutral" });
    nullNode = await h.store.addNode({ content: "디자인에 대한 라벨 없는 메모" });
  });
  afterEach(() => {
    h.db.close();
  });

  test("polarity=positive — positive 라벨만 회수(negative·neutral·NULL 제외)", async () => {
    const body = await postSearch(h, { query: "디자인 감상", limit: 20, polarity: "positive" });
    const ids = new Set(body.results.map((r) => r.id));
    expect(ids.has(posNode)).toBe(true);
    expect(ids.has(negNode)).toBe(false);
    expect(ids.has(neutralNode)).toBe(false);
    expect(ids.has(nullNode)).toBe(false);
    // 회수된 모든 노드의 polarity 가 positive(도메인 노드 매핑 보존 — T3 rowToNode).
    for (const r of body.results) {
      const node = await h.store.getNode(r.id);
      expect(node?.polarity).toBe("positive");
    }
    console.log(`[1.1c T5 E2E polarity] POST polarity=positive → ${body.count}건(positive 만)`);
  });

  test("polarity body 부재 = 필터 미적용(전 후보 / NULL 포함)", async () => {
    const body = await postSearch(h, { query: "디자인 감상", limit: 20 });
    const ids = new Set(body.results.map((r) => r.id));
    // 미적용이면 라벨 무관 전 후보 통과 — 최소한 NULL·negative 도 후보에 들어옴.
    expect(ids.has(nullNode)).toBe(true);
  });

  test("무효 polarity 문자열 미적용 — 1.1b 동작 불변", async () => {
    const invalid = await postSearch(h, { query: "디자인 감상", limit: 20, polarity: "happy" });
    const base = await postSearch(h, { query: "디자인 감상", limit: 20 });
    expect(invalid.count).toBe(base.count);
  });
});

describe("POST /search — 1.1c T5 cue 자동 검출(라우트 추가 파싱 0)", () => {
  let h: Harness;
  let themeChange: number;
  let themeReason: number;

  beforeEach(async () => {
    h = makeHarness();
    // theme_change(seed) → theme_reason(graph-hop 정답) 1-hop 체인. theme_reason 은
    // query 토큰을 비워 vector·fts 직접 미도달 — graph 채널 가중치(cue)로만 끌어올림.
    themeChange = await h.store.addNode({ content: "메인 작업 테마를 새 배색으로 교체했다" });
    themeReason = await h.store.addNode({
      content: "오래 들여다봐도 눈이 덜 시린 차분한 색이 필요했기 때문이다",
    });
    await h.store.addEdge({ sourceId: themeChange, targetId: themeReason, relation: "related_to", weight: 0.8 ,
    provenance: "user_input",
    sourceNodeId: null,
});
  });
  afterEach(() => {
    h.db.close();
  });

  test("관계 cue query — cue 가중치 자동 적용·기록(components.cueGraphBoost)", async () => {
    // "왜·바꿨" 관계 cue 어휘 → retriever 가 RELATION_CUE_GRAPH_BOOST 를 적용한다
    // (라우트 추가 파싱 없음 — retriever 자동 검출). 2026-07-10 bge-m3 재측정에서
    // measured-win 부재로 boost 값은 중립 1.0 이지만(search-tuning.ts 이력 주석),
    // 검출→적용→components 기록 배선 자체는 원설계대로 유지됨을 E2E 로 확인한다.
    //
    // 중립화로 response 의 cueGraphBoost 값만으론 검출 발화(1.0)와 미발화(1.0)가
    // 구분되지 않는다. 그래서 검출 발화 증거는 retriever 가 실제 호출하는
    // detectCues 로 같은 query 를 직접 단언하고(retrieve-config.ts step 0.5 동일
    // 경로), E2E 쪽은 필드가 기록돼 존재함 + 상수 일치를 단언한다.
    const cueQuery = "그 테마로 왜 바꿨더라";
    const cue = detectCues(cueQuery);
    expect(cue.relation).toBe(true);
    expect(cue.graphBoost).toBe(RELATION_CUE_GRAPH_BOOST);

    const body = await postSearch(h, { query: cueQuery, limit: 10 });
    const seedRow = body.results.find((r) => r.id === themeChange);
    expect(seedRow).toBeDefined();
    // 기록 배선 증거 — 필드가 response 에 실제로 존재하고(생략 아님) 상수와 일치.
    expect(Object.hasOwn(seedRow!.components, "cueGraphBoost")).toBe(true);
    expect(seedRow!.components.cueGraphBoost).toBe(RELATION_CUE_GRAPH_BOOST);
    console.log(
      `[1.1c T5 E2E cue] 관계 cue query → cueGraphBoost=${seedRow!.components.cueGraphBoost} ` +
        `(graph-hop 정답 themeReason 회수 여부=${body.results.some((r) => r.id === themeReason)})`,
    );
  });

  test("cue 없는 query — cueGraphBoost 중립 1.0(현행 동작)", async () => {
    const body = await postSearch(h, { query: "테마 배색 교체", limit: 10 });
    const seedRow = body.results.find((r) => r.id === themeChange);
    expect(seedRow).toBeDefined();
    expect(seedRow!.components.cueGraphBoost).toBe(1.0);
  });
});

// ── POST /search — 14b T3 인접 청크 + 문서 ref 후처리 ───────────────────────
//
// 한 문서를 여러 청크로 store 에 직접 적재(document row + document_chunk 노드 +
// chunkIndex metadata)한 뒤 검색한다. 검증 대상은 *search 라우트 후처리* 다 —
// document_chunk 결과에 neighbors/documentRef 가 붙고, RRF 점수·순서·count 는
// 안 바뀌며, 일반 노드는 빈 neighbors + null documentRef 임을 HTTP 경로로 확인한다.

interface NeighborChunkRow {
  id: number;
  chunkIndex: number;
  content: string;
  headingPath?: string[];
  headingTitle?: string;
  headingDepth?: number;
  parentHeadingPath?: string[];
  sectionChunkIndex?: number;
  sectionChunkCount?: number;
  chunkingStrategy?: "paragraph" | "heading" | "heading_path";
}
interface DocumentRef {
  parentId: string;
  centerIndex: number;
  title: string | null;
  totalChunks: number | null;
  headingPath?: string[];
  headingTitle?: string;
  headingDepth?: number;
  parentHeadingPath?: string[];
  sectionChunkIndex?: number;
  sectionChunkCount?: number;
  chunkingStrategy?: "paragraph" | "heading" | "heading_path";
}
interface EnrichedChunkRow extends SearchResultRow {
  neighbors: NeighborChunkRow[];
  documentRef: DocumentRef | null;
}
interface EnrichedSearchResponse {
  query: string;
  count: number;
  results: EnrichedChunkRow[];
}

/**
 * 한 문서 + 청크 6개를 harness store 에 적재한다(14b T3 + 불변식 대조 공용).
 * 같은 sha·docId·청크 텍스트를 쓰는 두 harness 를 만들어, maxContextTokens 만
 * 다른 두 검색 결과를 직접 대조할 수 있게 한다(인접 청크 후처리가 results 의
 * id·score·count 를 안 바꾼다는 증거).
 *
 * 반환: { docId, chunkNodeIds } — 검증이 청크 노드를 식별할 근거.
 */
async function seedMeetingDoc(
  h: Harness,
  args: { sha: string; docTitle: string; chunkTexts: string[] },
): Promise<{ docId: string; chunkNodeIds: number[] }> {
  // documents 는 asset_files FK 를 참조하므로 자산 row 를 먼저 삽입한다.
  h.db
    .prepare(
      `INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, first_imported_at)
       VALUES (?, 'text', '/assets/${args.sha}.md', 1, ?)`,
    )
    .run(args.sha, Date.now());
  const docId = h.store.createDocument({
    assetSha256: args.sha,
    title: args.docTitle,
    documentType: "text",
  });
  const docNodeId = await h.store.addNode({
    content: args.docTitle,
    sourceType: "document",
    metadata: { documentId: docId, title: args.docTitle },
  });
  const chunkNodeIds: number[] = [];
  for (let i = 0; i < args.chunkTexts.length; i++) {
    const id = await h.store.addNode({
      content: args.chunkTexts[i]!,
      sourceType: "document_chunk",
      metadata: {
        parentId: docId,
        chunkIndex: i,
        headingPath: [args.docTitle, `청크 ${i}`],
        headingTitle: `청크 ${i}`,
        headingDepth: 2,
        parentHeadingPath: [args.docTitle],
        sectionChunkIndex: 0,
        sectionChunkCount: 1,
        chunkingStrategy: "heading_path",
      },
    });
    await h.store.addEdge({
      sourceId: id,
      targetId: docNodeId,
      relation: "parent_of",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 1.0,
    });
    chunkNodeIds.push(id);
  }
  h.store.setChunkCount(docId, args.chunkTexts.length);
  return { docId, chunkNodeIds };
}

async function postSearchEnriched(
  h: Harness,
  payload: Record<string, unknown>,
): Promise<EnrichedSearchResponse> {
  const res = await h.app.request("/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  expect(res.status).toBe(200);
  return (await jsonBody(res)) as EnrichedSearchResponse;
}

describe("POST /search — 14b T3 인접 청크 + 문서 ref 후처리", () => {
  let h: Harness;
  // 한 문서(docId) 청크 6개 + chunkIndex 0..5. 모두 '회의록' 어휘를 공유해
  // 검색에서 상위로 잡히게 한다. docId 는 createDocument 가 돌려준 'doc_<uuid>' —
  // 청크 metadata.parentId 가 documents.document_id 와 일치해야 documentRef 가 채워진다.
  let docId: string;
  const docTitle = "프로젝트 회의록";
  const chunkTexts = [
    "회의록 0 — 오늘 회의에서 일정 조율 안건을 먼저 다뤘다",
    "회의록 1 — 다음 회의에서 설계 검토를 이어가기로 했다",
    "회의록 2 — 회의 도중 예산 배분 논의가 길어졌다",
    "회의록 3 — 회의 후반에 배포 일정을 확정했다",
    "회의록 4 — 회의 막바지에 다음 담당자를 정했다",
    "회의록 5 — 회의록 정리는 다음 날 공유하기로 했다",
  ];
  let chunkNodeIds: number[];

  beforeEach(async () => {
    h = makeHarness();
    // docId = createDocument 반환값(doc_<uuid>) / 청크 metadata.parentId 가
    // documents.document_id 와 일치해야 documentRef 가 채워진다.
    const seeded = await seedMeetingDoc(h, { sha: "sha_t3", docTitle, chunkTexts });
    docId = seeded.docId;
    chunkNodeIds = seeded.chunkNodeIds;
  });
  afterEach(() => {
    h.db.close();
  });

  test("document_chunk 결과에 neighbors + documentRef 가 항상 붙는다", async () => {
    const body = await postSearchEnriched(h, { query: "회의 배포 일정", limit: 10 });

    // 한 청크라도 상위로 잡혀야 한다(검색이 vacuous 가 아님).
    const chunkRows = body.results.filter((r) => chunkNodeIds.includes(r.id));
    expect(chunkRows.length).toBeGreaterThanOrEqual(1);

    const row = chunkRows[0]!;
    // documentRef — 제목·전체 청크 수가 getDocument 로 채워진다.
    expect(row.documentRef).not.toBeNull();
    expect(row.documentRef!.parentId).toBe(docId);
    expect(row.documentRef!.title).toBe(docTitle);
    expect(row.documentRef!.totalChunks).toBe(chunkTexts.length);
    expect(typeof row.documentRef!.centerIndex).toBe("number");
    expect(row.documentRef!.headingPath).toEqual([
      docTitle,
      `청크 ${row.documentRef!.centerIndex}`,
    ]);
    expect(row.documentRef!.headingTitle).toBe(`청크 ${row.documentRef!.centerIndex}`);
    expect(row.documentRef!.headingDepth).toBe(2);
    expect(row.documentRef!.parentHeadingPath).toEqual([docTitle]);
    expect(row.documentRef!.sectionChunkIndex).toBe(0);
    expect(row.documentRef!.sectionChunkCount).toBe(1);
    expect(row.documentRef!.chunkingStrategy).toBe("heading_path");

    // neighbors — 같은 문서의 인접 청크(중심 제외). 본인은 빠지고, 나온 청크는
    // 모두 같은 문서 소속이며 중심 index 가 아니다.
    expect(Array.isArray(row.neighbors)).toBe(true);
    expect(row.neighbors.length).toBeGreaterThanOrEqual(1);
    for (const n of row.neighbors) {
      expect(chunkNodeIds).toContain(n.id);
      expect(n.id).not.toBe(row.id);
      expect(n.chunkIndex).not.toBe(row.documentRef!.centerIndex);
      expect(typeof n.content).toBe("string");
      expect(n.headingPath).toEqual([docTitle, `청크 ${n.chunkIndex}`]);
      expect(n.headingTitle).toBe(`청크 ${n.chunkIndex}`);
      expect(n.headingDepth).toBe(2);
      expect(n.parentHeadingPath).toEqual([docTitle]);
      expect(n.sectionChunkIndex).toBe(0);
      expect(n.sectionChunkCount).toBe(1);
      expect(n.chunkingStrategy).toBe("heading_path");
    }
    // 표시 순서는 chunkIndex 오름차순.
    const indices = row.neighbors.map((n) => n.chunkIndex);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });

  test("OCR 미완료 문서와 청크는 검색 결과에서 제외된다", async () => {
    h.db.prepare("UPDATE documents SET source_metadata = ? WHERE document_id = ?").run(
      JSON.stringify({
        parse: {
          status: "needs_ocr",
          method: "tier1",
          originalAssetSha256: "sha_t3",
          warnings: [],
        },
      }),
      docId,
    );

    const body = await postSearchEnriched(h, { query: "회의록", limit: 10 });
    expect(body.results.some((row) => chunkNodeIds.includes(row.id))).toBe(false);
    expect(body.results.some((row) => row.documentRef?.parentId === docId)).toBe(false);
    expect(body.results.some((row) => row.content === docTitle)).toBe(false);
  });

  test("불변식 — 인접 청크 후처리가 results 의 id 순서·score·count 를 안 바꾼다", async () => {
    // 같은 query 를 두 번 보내 결과의 id 배열·score 배열·count 가 동일함을 확인한다.
    // 후처리는 *필드만 추가* 하므로(neighbors/documentRef) RRF 산출은 불변이다.
    const a = await postSearchEnriched(h, { query: "회의 예산 논의", limit: 10 });
    const b = await postSearchEnriched(h, { query: "회의 예산 논의", limit: 10 });

    expect(a.count).toBe(b.count);
    expect(a.results.map((r) => r.id)).toEqual(b.results.map((r) => r.id));
    expect(a.results.map((r) => r.score)).toEqual(b.results.map((r) => r.score));

    // 모든 결과 항목이 1.1a 응답 형태(sources/components/concepts)를 그대로 보존하고
    // neighbors/documentRef 두 칸만 *추가* 됐는지 — 즉 코어 필드는 그대로다.
    for (const r of a.results) {
      expect(Array.isArray(r.sources)).toBe(true);
      expect(r.components).toBeDefined();
      expect(r.concepts).toBeDefined();
      expect(typeof r.score).toBe("number");
      expect("neighbors" in r).toBe(true);
      expect("documentRef" in r).toBe(true);
    }
  });

  test("불변식 직접 대조 — 인접 묶기 한도만 다른 두 검색의 results id·score·count 가 byte 동일(차이는 neighbors 채움뿐)", async () => {
    // 같은 데이터·같은 query 를 maxContextTokens 만 다르게 두 harness 로 검색한다.
    //   - h0: maxContextTokens=0 → assembleNeighborContext 가 인접을 하나도
    //         안 묶는다(neighbor-chunks.ts L84~87) → 모든 결과 neighbors=[].
    //   - hN: maxContextTokens=2000(default) → document_chunk 상위 결과에
    //         인접 청크가 실제로 묶인다.
    // 두 응답의 results 가 RRF 산출(id 순서·score·count)에서 byte 동일하고,
    // *유일한 차이* 가 neighbors 배열 채움뿐임을 직접 단언한다 — 후처리가 표시
    // 필드만 더할 뿐 코어를 안 건드린다는 증거(plan AC).
    const query = "회의 예산 논의";
    const sha = "sha_invariant";

    const h0 = makeHarness({ maxContextTokens: 0 });
    const hN = makeHarness({ maxContextTokens: 2000 });
    try {
      // 두 harness 에 *완전히 같은* 문서·청크를 적재한다(docId 는 uuid 라 다르지만
      // id 순서·score 는 같은 입력·같은 임베더라 동일하게 산출된다).
      await seedMeetingDoc(h0, { sha, docTitle, chunkTexts });
      await seedMeetingDoc(hN, { sha, docTitle, chunkTexts });

      const r0 = await postSearchEnriched(h0, { query, limit: 10 });
      const rN = await postSearchEnriched(hN, { query, limit: 10 });

      // 1) count·id 순서·score 배열이 byte 동일 — RRF 코어가 maxContextTokens 와
      //    무관함(후처리 한도가 코어를 안 건드림).
      expect(r0.count).toBe(rN.count);
      expect(r0.results.map((r) => r.id)).toEqual(rN.results.map((r) => r.id));
      expect(r0.results.map((r) => r.score)).toEqual(
        rN.results.map((r) => r.score),
      );

      // 2) h0(한도 0)는 모든 결과가 neighbors=[] — 인접이 하나도 안 묶임.
      for (const r of r0.results) {
        expect(r.neighbors).toEqual([]);
      }

      // 3) hN(한도 2000)는 적어도 한 document_chunk 결과에 인접 청크가 실제로
      //    묶임 — 즉 두 응답의 *유일한 차이* 가 neighbors 채움임을 확정한다
      //    (대조가 vacuous 가 아님 — 한도 켰을 때 실제로 채워진다).
      const enrichedRows = rN.results.filter((r) => r.neighbors.length > 0);
      expect(enrichedRows.length).toBeGreaterThanOrEqual(1);

      // 4) neighbors 를 뺀 results 의 *모든 코어 필드* 가 항목별로 동일 —
      //    documentRef 채움 여부·표시 필드 포함(한도 0 도 유효 청크면 documentRef
      //    는 채운다 / neighbor-chunks.ts L84 주석). neighbors 만 다르다.
      //    documentRef.parentId 는 createDocument 가 harness 별로 새 uuid 를 만들어
      //    DB 마다 다르므로(후처리 산출이 아닌 적재 시점 식별자) centerIndex·title·
      //    totalChunks 만 대조하고 parentId 는 "둘 다 채워짐/둘 다 null" 동치만 본다.
      for (let i = 0; i < rN.results.length; i++) {
        const a = r0.results[i]!;
        const b = rN.results[i]!;
        expect(a.id).toBe(b.id);
        expect(a.score).toBe(b.score);
        expect(a.content).toBe(b.content);
        expect(a.sources).toEqual(b.sources);
        expect(a.components).toEqual(b.components);
        expect(a.documentRef === null).toBe(b.documentRef === null);
        if (a.documentRef !== null && b.documentRef !== null) {
          expect(a.documentRef.centerIndex).toBe(b.documentRef.centerIndex);
          expect(a.documentRef.title).toBe(b.documentRef.title);
          expect(a.documentRef.totalChunks).toBe(b.documentRef.totalChunks);
          // parentId 는 양쪽 모두 doc_<uuid> 형태로 채워짐(둘 다 비어있지 않음).
          expect(a.documentRef.parentId.length).toBeGreaterThan(0);
          expect(b.documentRef.parentId.length).toBeGreaterThan(0);
        }
      }
    } finally {
      h0.db.close();
      hN.db.close();
    }
  });

  test("일반 노드(raw)는 빈 neighbors + null documentRef", async () => {
    const rawNode = await h.store.addNode({ content: "그냥 일상 메모 한 줄" });
    const body = await postSearchEnriched(h, { query: "일상 메모", limit: 10 });
    const rawRow = body.results.find((r) => r.id === rawNode);
    expect(rawRow).toBeDefined();
    expect(rawRow!.neighbors).toEqual([]);
    expect(rawRow!.documentRef).toBeNull();
  });

  test("문서 메타가 없으면 documentRef 는 제목/전체청크 null (정직)", async () => {
    // documents row 없이 document_chunk 노드만 만든 경우 — getDocument 가 null 을
    // 돌려주므로 title/totalChunks 는 null, parentId/centerIndex 는 청크 metadata 로 채운다.
    const orphanParent = "doc_orphan_t3";
    const orphanChunk = await h.store.addNode({
      content: "고아 청크 — 문서 메타 없음, 회의 키워드 포함",
      sourceType: "document_chunk",
      metadata: { parentId: orphanParent, chunkIndex: 0 },
    });
    const body = await postSearchEnriched(h, { query: "고아 청크 회의", limit: 10 });
    const orphanRow = body.results.find((r) => r.id === orphanChunk);
    expect(orphanRow).toBeDefined();
    expect(orphanRow!.documentRef).not.toBeNull();
    expect(orphanRow!.documentRef!.parentId).toBe(orphanParent);
    expect(orphanRow!.documentRef!.title).toBeNull();
    expect(orphanRow!.documentRef!.totalChunks).toBeNull();
  });
});

// ── POST /search — 검색 시간 범위 hard filter (Phase 7 갈래 1 / Task 5) ──────
//
// 라우트가 명시 since/until(우선) 또는 검색어 자동 추출(eventDateRange)로 시간
// 범위를 풀어 retriever.dateRange 로 흘려보냄을 HTTP 경로로 검증한다. event_at 은
// store 직접 적재(HTTP ingest 라우트는 event_at 을 안 받음). 검증 대상은 라우트
// wiring — 범위 필터 자체 동작은 retriever.test.ts 가 이미 덮음. mock 없음.

describe("POST /search — 검색 시간 범위 hard filter(명시 + 검색어 자동 추출)", () => {
  let h: Harness;
  let inRange: number;
  let outRange: number;

  beforeEach(async () => {
    h = makeHarness();
    // 같은 키워드 두 노드 — event_at 만 다르다.
    inRange = await h.store.addNode({
      content: "지난주에 본 영화 한 편",
      eventAt: "2026-05-20",
    });
    outRange = await h.store.addNode({
      content: "오래전에 본 영화 한 편",
      eventAt: "2026-01-10",
    });
  });
  afterEach(() => {
    h.db.close();
  });

  test("명시 since/until — 범위 안 자산만 회수, 밖은 제외", async () => {
    const body = await postSearch(h, {
      query: "영화",
      limit: 20,
      since: "2026-05-18",
      until: "2026-05-24",
    });
    const ids = new Set(body.results.map((r) => r.id));
    expect(ids.has(inRange)).toBe(true);
    expect(ids.has(outRange)).toBe(false);
  });

  test("검색어 자동 추출 — '5월'(닫힌 표현) 이 자동으로 범위 필터를 건다", async () => {
    // since/until 미지정 → 라우트가 query '5월' 을 eventDateRange 로 풀어 2026-05 구간
    // {2026-05-01, 2026-05-31} 으로 후보를 거른다. 05-20 자산만 잡히고 01-10 은 빠진다.
    const body = await postSearch(h, { query: "5월에 본 영화", limit: 20 });
    const ids = new Set(body.results.map((r) => r.id));
    expect(ids.has(inRange)).toBe(true);
    expect(ids.has(outRange)).toBe(false);
  });

  test("명시 파라미터가 검색어 자동 추출보다 우선", async () => {
    // query 에 '5월'(2026-05 구간) 이 있어도 명시 since/until(1월 구간) 이 이긴다 →
    // 01-10 자산이 잡히고 05-20 은 빠진다(검색어 추출 결과와 정반대 = 명시 우선 증거).
    const body = await postSearch(h, {
      query: "5월에 본 영화",
      limit: 20,
      since: "2026-01-01",
      until: "2026-01-31",
    });
    const ids = new Set(body.results.map((r) => r.id));
    expect(ids.has(outRange)).toBe(true);
    expect(ids.has(inRange)).toBe(false);
  });

  test("시간 표현 없는 검색어 + 명시 파라미터 없음 = 필터 미적용(전 후보 / 회귀 0)", async () => {
    // query '영화' 에는 닫힌 시간 표현이 없고 since/until 도 없다 → 범위 필터 미적용.
    // 두 자산(05-20·01-10) 모두 후보에 들어와야 한다.
    const body = await postSearch(h, { query: "영화", limit: 20 });
    const ids = new Set(body.results.map((r) => r.id));
    expect(ids.has(inRange)).toBe(true);
    expect(ids.has(outRange)).toBe(true);
  });

  test("절반 입력(since 만) 무시 + query 에도 표현 없음 = 필터 미적용", async () => {
    // since 만 있고 until 이 없으면 닫힌 구간이 아니다 → 명시 통로 건너뜀. query 에도
    // 시간 표현이 없어 자동 추출도 null → 전 후보 통과.
    const body = await postSearch(h, { query: "영화", limit: 20, since: "2026-05-18" });
    const ids = new Set(body.results.map((r) => r.id));
    expect(ids.has(inRange)).toBe(true);
    expect(ids.has(outRange)).toBe(true);
  });
});

// ── POST /search — 장소 칸 place body 선언 + 0 diff (활용 단계4 T2) ──────────
//
// T2 는 place body 칸 *선언* + parsePlace 방어 파싱 + retriever 전달까지만 — 가산
// 로직은 T3 다. place 를 안 보내거나 빈 값이면 retriever 가 placeValue 를 못 받아
// 결과가 도입 전과 동일하다. 검증 대상은 *라우트 wiring* (parsePlace 가 빈 값을
// 거르고, 유효 값만 흘림 — 라우트가 200 으로 정상 응답). mock 없음.

describe("POST /search — 장소 칸 place body 선언 + 0 diff(T2)", () => {
  let h: Harness;
  let placeNode: number;

  beforeEach(async () => {
    h = makeHarness();
    placeNode = await h.store.addNode({ content: "강남 카페에서 본 영화" });
    await h.store.setPlace(placeNode, "강남 A마트", "direct");
    await h.store.addNode({ content: "다른 곳에서 본 영화" });
  });
  afterEach(() => {
    h.db.close();
  });

  test("place 미전달 = 도입 전 결과와 동일(라우트 0 diff)", async () => {
    const a = await postSearch(h, { query: "영화", limit: 20 });
    const b = await postSearch(h, { query: "영화", limit: 20 });
    expect(a.results.map((r) => r.id)).toEqual(b.results.map((r) => r.id));
    for (let i = 0; i < a.results.length; i++) {
      expect(a.results[i]!.score).toBeCloseTo(b.results[i]!.score, 10);
    }
  });

  test("place 빈 문자열·공백·비문자열 = parsePlace 가 걸러 미전달(200 정상)", async () => {
    // 빈 값/공백/숫자는 parsePlace 가 undefined 로 거른다 → placeValue 미전달.
    // 라우트가 에러 없이 200 + 결과를 회신한다(방어 파싱 — project 칸 양식).
    for (const place of ["", "   ", 123, null, {}]) {
      const body = await postSearch(h, { query: "영화", limit: 20, place });
      expect(body.results.length).toBeGreaterThan(0);
    }
  });

  test("place 유효 값 전달 = 라우트가 placeValue 를 retriever 까지 흘려 장소 글 순위 상승(T3 end-to-end)", async () => {
    // 같은 검색어로 둘 다 잡히는 두 글 — placeNode 에만 '강남 A마트' 장소가 붙어 있다.
    // place 칸을 라우트가 parsePlace → placeValue → retriever step 9 가산까지 흘리면
    // 장소 글이 *순위 상승* 한다(소프트 — 다른 글 탈락 0). 라우트 wiring + T3 가산의
    // end-to-end 향상 검증(retriever.test.ts 가 retriever 단독은 이미 덮음).
    const both = await postSearch(h, { query: "영화", limit: 20, place: "강남" });
    const idsWithPlace = both.results.map((r) => r.id);
    expect(idsWithPlace).toContain(placeNode); // 소프트 — 두 글 다 살아남는다.

    const without = await postSearch(h, { query: "영화", limit: 20 });
    const idsWithout = without.results.map((r) => r.id);
    expect(idsWithout).toContain(placeNode);

    // 장소 글 순위가 place 전달 시 미전달 때보다 *앞으로*(indexOf 작아짐) 온다.
    expect(idsWithPlace.indexOf(placeNode)).toBeLessThanOrEqual(
      idsWithout.indexOf(placeNode),
    );
    // 장소 글 점수가 place 전달 시 더 높다(라우트→retriever placeBonus 가산 증거).
    const scoreWith = both.results.find((r) => r.id === placeNode)!.score;
    const scoreWithout = without.results.find((r) => r.id === placeNode)!.score;
    expect(scoreWith).toBeGreaterThan(scoreWithout);
  });
});

// ── 장소 자연어 신호 추출 resolvePlaceSignal (활용 단계4 T4) ──────────────────
//
// 명시 body.place 우선(resolveDateRange 명시>자동 선례), 없으면 query 에서 저장 장소
// leaf 이름 부분일치 자동 추출(A안·LLM 0). 여러 매칭이면 가장 긴 이름 우선. 매칭 0이면
// undefined → placeValue 미전달 → 회귀 0. 조사 정규식(B안) 미채택. 실 SQLite·mock 0.

describe("resolvePlaceSignal — 장소 자연어 신호 추출(T4)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("명시 place 가 query 자동 추출보다 우선(resolveDateRange 선례)", async () => {
    // query 에 저장 장소 '속초' 가 있어도, 명시 place='부산' 이 이긴다.
    const nid = await h.store.addNode({ content: "여행 메모" });
    await h.store.setPlace(nid, "속초", "direct");
    const signal = resolvePlaceSignal("부산", "속초에서 본 바다", h.store);
    expect(signal).toBe("부산");
  });

  test("명시 place 없으면 query 부분일치로 저장 장소 자동 추출(LLM 0)", async () => {
    const nid = await h.store.addNode({ content: "쇼핑 메모" });
    await h.store.setPlace(nid, "강남 A마트", "direct");
    // query 안에 저장 장소 '강남 a마트'(정규화값) 가 들어 있으면 신호로 잡힌다.
    const signal = resolvePlaceSignal(undefined, "어제 강남 A마트에서 산 것", h.store);
    expect(signal).toBe("강남 a마트");
  });

  test("추론(system) 장소도 자동 추출 대상(leaf 통로·places 행 없어도)", async () => {
    const nid = await h.store.addNode({ content: "거기 갔다" });
    // system 출처 = concept 위계만(places 행 0). listPlaceLeafNames 가 leaf 통로라 포함.
    await h.store.setPlace(nid, "속초", "system");
    const signal = resolvePlaceSignal(undefined, "지난주 속초 여행", h.store);
    expect(signal).toBe("속초");
  });

  test("query 에 저장 장소가 없으면 undefined(미전달 → 회귀 0)", async () => {
    const nid = await h.store.addNode({ content: "쇼핑 메모" });
    await h.store.setPlace(nid, "강남 A마트", "direct");
    // query 에 저장 장소 이름이 한 글자도 안 들어 있으면 신호 없음.
    expect(resolvePlaceSignal(undefined, "오늘 날씨 좋다", h.store)).toBeUndefined();
    // 장소가 한 건도 없는 store 면 자동 추출도 undefined.
    const empty = makeHarness();
    expect(resolvePlaceSignal(undefined, "강남 A마트 갔다", empty.store)).toBeUndefined();
    empty.db.close();
  });

  test("여러 매칭이면 가장 긴 이름 우선(구체적 우선)", async () => {
    // '강남' 과 '강남 A마트' 두 장소가 저장돼 있고 query 에 긴 쪽이 들어 있으면
    // 긴 이름('강남 a마트')을 신호로 잡는다(짧은 '강남' 우연 매칭보다 정확).
    const n1 = await h.store.addNode({ content: "메모1" });
    await h.store.setPlace(n1, "강남", "direct");
    const n2 = await h.store.addNode({ content: "메모2" });
    await h.store.setPlace(n2, "강남 A마트", "direct");
    const signal = resolvePlaceSignal(undefined, "어제 강남 A마트 방문", h.store);
    expect(signal).toBe("강남 a마트");
  });

  test("라우트 end-to-end — place 칸 없이 query 자동 추출만으로 장소 글 가산(자동 추출 → retriever)", async () => {
    // place 칸 없이 query 에 저장 장소 이름을 넣으면 라우트가 resolvePlaceSignal 로
    // 자동 추출해 placeValue 로 흘린다. 두 harness(장소 붙은 store / 안 붙은 store)로
    // 같은 글 내용·같은 query 를 대조해 자동 추출 신호의 효과를 격리한다 — base 점수는
    // 같고, 장소가 붙은 store 의 글만 placeBonus 가산을 받아 점수가 오른다.
    // (명시 place 의 retriever 흐름은 T3 가 덮음 — 여기는 자동 추출 통로 검증.)
    // query·글 내용에 시간 표현("지난주" 등)을 넣지 않는다 — 넣으면 eventDateRange
    // 가 dateRange 하드 필터를 걸어 장소 효과 격리를 깨므로(닫힌 시간 표현 자동 추출).
    const content = "강남 A마트에서 산 영화 메모";
    const placeNode = await h.store.addNode({ content });
    await h.store.setPlace(placeNode, "강남 A마트", "direct");

    const other = makeHarness();
    const plainNode = await other.store.addNode({ content });
    // other store 엔 장소 데이터 0 → listPlaceLeafNames 빈 배열 → 자동 추출 미발생.

    const query = "강남 A마트 영화";
    const withPlace = await postSearch(h, { query, limit: 20 });
    const withoutPlace = await postSearch(other, { query, limit: 20 });

    const scoreWith = withPlace.results.find((r) => r.id === placeNode)?.score;
    const scoreWithout = withoutPlace.results.find((r) => r.id === plainNode)
      ?.score;
    expect(scoreWith).toBeDefined();
    expect(scoreWithout).toBeDefined();
    // 자동 추출 신호가 있는 store(장소 붙음)의 글 점수가 더 높다(placeBonus 가산 증거).
    // 같은 글 내용·같은 query 라 base 점수는 같고 차이는 placeBonus 뿐이다.
    expect(scoreWith!).toBeGreaterThan(scoreWithout!);
    other.db.close();
  });
});

// ── POST /search — 1.2 T12 memory_type 한정 필터 ───────────────────────────
//
// 통일 원칙(spec) — memory_type 으로 검색 후보를 줄이는 통로. RRF 합산 *전* 후보를
// 그 종류 노드로 줄인다(가중치가 아니라 축소). polarity·filter 와 같은 통과 Set 이라
// 도입 전 동작(미지정 검색)은 그대로다. camelCase·snake_case 둘 다 받는다.
describe("POST /search — 1.2 T12 memory_type 한정 필터", () => {
  let h: Harness;
  let episodeNode: number;
  let factNode: number;

  beforeEach(async () => {
    h = makeHarness();
    // 같은 어휘를 담은 두 글을 종류만 다르게 둔다 — 종류 필터의 *축소* 만 본다.
    episodeNode = await h.store.addNode({
      content: "주말에 친구와 영화를 보러 갔던 하루",
      memoryType: "episode",
    });
    factNode = await h.store.addNode({
      content: "그 영화의 감독은 봉준호라는 사실",
      memoryType: "fact",
    });
  });
  afterEach(() => {
    h.db.close();
  });

  test("memory_type='episode' = episode 노드만 회수(fact 제외 / 후보 축소)", async () => {
    const body = await postSearch(h, {
      query: "영화",
      limit: 20,
      memory_type: "episode",
    });
    const ids = new Set(body.results.map((r) => r.id));
    expect(ids.has(episodeNode)).toBe(true);
    expect(ids.has(factNode)).toBe(false);
  });

  test("memoryType='fact'(camelCase) = fact 노드만 회수(같은 파싱)", async () => {
    const body = await postSearch(h, {
      query: "영화",
      limit: 20,
      memoryType: "fact",
    });
    const ids = new Set(body.results.map((r) => r.id));
    expect(ids.has(factNode)).toBe(true);
    expect(ids.has(episodeNode)).toBe(false);
  });

  test("무효 memory_type·부재 = 필터 미적용(두 종류 모두 후보 / 도입 전 동작 불변)", async () => {
    // 무효 문자열은 polarity 방어 패턴처럼 조용히 무시 — 전 후보 통과.
    const bad = await postSearch(h, {
      query: "영화",
      limit: 20,
      memory_type: "존재하지않는종류",
    });
    const badIds = new Set(bad.results.map((r) => r.id));
    expect(badIds.has(episodeNode)).toBe(true);
    expect(badIds.has(factNode)).toBe(true);

    // 칸 부재도 전 후보 통과(미지정 검색 회귀 0).
    const none = await postSearch(h, { query: "영화", limit: 20 });
    const noneIds = new Set(none.results.map((r) => r.id));
    expect(noneIds.has(episodeNode)).toBe(true);
    expect(noneIds.has(factNode)).toBe(true);
  });
});

// ── POST /memories — 1.2 T12 입력 시점 엔티티 wiring + Bug 2 회귀 가드 ───────
//
// 작성자는 메타데이터로 보존하고, 명시한 사람 태그는 의미 엔티티로 등록한다:
//   (1) Discord 작성자는 user_id가 있어도 authored_by를 만들지 않는다.
//   (2) 엔티티 wiring — content 의 `#사람:민수 #생일:3월` 은 의미 채널 사람(민수)을
//       만들고 그 사람에 생일 고유 사실을 채운다(wireHashtagEntitiesSafe). 선언된
//       사람(민수)에는 작성자 userId 를 찍지 않는다(귀속 축 분리).
describe("POST /memories — 엔티티 wiring + Discord 작성자 메타데이터", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  async function postMemory(
    body: Record<string, unknown>,
  ): Promise<{ id: number }> {
    const res = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    return (await jsonBody(res)) as { id: number };
  }

  test("`#사람:민수 #생일:3월` 입력 = 사람·생일 고유 사실이 채워진다", async () => {
    const saved = await postMemory({
      content: "오늘 만난 #사람:민수 #생일:3월",
    });
    expect(typeof saved.id).toBe("number");

    // 의미 채널 사람 '민수' 가 만들어지고 생일이 채워졌다.
    const persons = await h.store.listPersons({ limit: 50 });
    const minsu = persons.find((p) => p.displayName === "민수");
    expect(minsu).toBeDefined();
    expect(minsu!.birthday).toBe("3월");
    // 의미 채널 사람에는 작성자 userId 를 안 찍는다(귀속 축 분리) — external_refs 가 빔.
    expect(Object.keys(minsu!.externalRefs).length).toBe(0);
  });

  test("태그 없는 Discord 글도 작성자를 메타데이터로만 남긴다", async () => {
    const saved = await postMemory({
      content: "디스코드에서 적은 평범한 메모 한 줄",
      author: "타니아",
      platform: "discord",
      metadata: { user_id: "discord-12345", messageId: "m-1" },
    });

    const authoredEdges = await h.store.listNodePersonEdges({
      nodeId: saved.id,
      relation: "authored_by",
    });
    expect(authoredEdges).toHaveLength(0);
    expect(await h.store.listPersons({ limit: 10 })).toHaveLength(0);
    const node = (await h.store.getNode(saved.id))!;
    expect(node.author).toBe("타니아");
    expect(node.metadata).toMatchObject({ user_id: "discord-12345", messageId: "m-1" });
  });
});

// ── POST /search — strict 기본 + 명시 relaxed 검색(2026-06-28 spec) ───────────
//
// 기본 검색은 strict mode 라 조건 검색 0건을 그대로 0건으로 회신한다. 조건을 풀어
// 비슷한 결과를 찾는 relaxed 검색은 relaxFilters:true 가 있을 때만 2-pass 로 돈다.
// project 는 relaxed 에서도 유지하고, relaxed 결과는 별도 캐시 키(fallbackPass)로
// strict 결과와 섞이지 않는다. 실 SQLite + 실 임베더(mock 0).

describe("POST /search — strict 기본 + 명시 relaxed 검색", () => {
  let h: Harness;
  let movieNode: number;

  beforeEach(async () => {
    h = makeHarness();
    // query '영화' 로 잡히는 글 — 분류·장소·시간 칸은 안 붙인다(폴백 대조군).
    movieNode = await h.store.addNode({ content: "어제 본 영화 메모 한 줄" });
  });
  afterEach(() => {
    h.db.close();
  });

  test("필터 검색 0건 + relaxFilters 없음 → retriever 1회, 결과 0건, strict 응답", async () => {
    const body = await postSearch(h, {
      query: "영화",
      limit: 20,
      filter: { review: "존재하지않는분류값XYZ" },
    });
    expect(h.retrieveCalls()).toBe(1);
    expect(body.results).toEqual([]);
    expect(body.count).toBe(0);
    expect(body.searchMode).toBe("strict");
    expect(body.relaxed).toBe(false);
    expect(body.strictCount).toBe(0);
    expect(body.removedFilters).toEqual([]);
  });

  test("필터 검색 0건 + relaxFilters:false → retriever 1회, 결과 0건, strict 응답", async () => {
    const body = await postSearch(h, {
      query: "영화",
      limit: 20,
      filter: { review: "존재하지않는분류값XYZ" },
      relaxFilters: false,
    });
    expect(h.retrieveCalls()).toBe(1);
    expect(body.results).toEqual([]);
    expect(body.searchMode).toBe("strict");
    expect(body.relaxed).toBe(false);
    expect(body.strictCount).toBe(0);
    expect(body.removedFilters).toEqual([]);
  });

  test("필터 검색 0건 + relaxFilters:true → retriever 2회, relaxed 결과와 제거 필터 표시", async () => {
    const body = await postSearch(h, {
      query: "영화",
      limit: 20,
      filter: { review: "존재하지않는분류값XYZ" },
      relaxFilters: true,
    });
    const ids = new Set(body.results.map((r) => r.id));
    expect(h.retrieveCalls()).toBe(2);
    expect(ids.has(movieNode)).toBe(true);
    expect(body.searchMode).toBe("relaxed");
    expect(body.relaxed).toBe(true);
    expect(body.strictCount).toBe(0);
    expect(body.removedFilters).toEqual(["filter"]);
  });

  test("필터 검색 1건 이상 + relaxFilters:true → retriever 1회, strict 결과 반환", async () => {
    const body = await postSearch(h, {
      query: "영화",
      limit: 20,
      memoryType: "fact",
      relaxFilters: true,
    });
    const ids = new Set(body.results.map((r) => r.id));
    expect(h.retrieveCalls()).toBe(1);
    expect(ids.has(movieNode)).toBe(true);
    expect(body.searchMode).toBe("strict");
    expect(body.relaxed).toBe(false);
    expect(body.strictCount).toBeGreaterThan(0);
    expect(body.removedFilters).toEqual([]);
  });

  test("relaxed 검색은 dateRange 등 제거 필터를 응답에 나열한다", async () => {
    const body = await postSearch(h, {
      query: "영화",
      limit: 20,
      since: "2099-01-01",
      until: "2099-12-31",
      polarity: "negative",
      memoryType: "episode",
      kind: "가계부",
      fieldFilters: [{ key: "금액", value: "999" }],
      relaxFilters: true,
    });
    const ids = new Set(body.results.map((r) => r.id));
    expect(ids.has(movieNode)).toBe(true);
    expect(body.searchMode).toBe("relaxed");
    expect(body.removedFilters).toEqual([
      "dateRange",
      "polarity",
      "memoryType",
      "kind",
      "fieldFilters",
    ]);
  });

  test("relaxed 검색에서도 project 조건은 유지하고 제거 필터에는 넣지 않는다", async () => {
    const body = await postSearch(h, {
      query: "영화",
      limit: 20,
      project: "bara-system",
      filter: { review: "존재하지않는분류값XYZ" },
      relaxFilters: true,
    });
    expect(body.relaxed).toBe(true);
    expect(h.retrieveCalls()).toBe(2);
    const second = h.retrieveOptions()[1]!;
    expect(second.project).toBe("bara-system");
    expect(second.filter).toBeUndefined();
    expect(body.removedFilters).toEqual(["filter"]);
  });

  test("relaxed 결과는 별도 캐시 키(fallbackPass)로 strict 0건과 분리", async () => {
    const hc = makeHarness({ withCache: true });
    await hc.store.addNode({ content: "주말에 본 영화 한 편" });
    const cache = hc.searchCache!;

    // 1차 0건(2099 구간) + 명시 relaxed → strict 키 + relaxed 키 두 항목 보관.
    const first = await postSearch(hc, {
      query: "영화",
      limit: 20,
      since: "2099-01-01",
      until: "2099-12-31",
      relaxFilters: true,
    });
    expect(cache.size).toBe(2);
    expect(first.results.length).toBeGreaterThan(0);
    expect(first.relaxed).toBe(true);

    const second = await postSearch(hc, {
      query: "영화",
      limit: 20,
      since: "2099-01-01",
      until: "2099-12-31",
      relaxFilters: true,
    });
    expect(second.results.map((r) => r.id)).toEqual(
      first.results.map((r) => r.id),
    );
    expect(cache.size).toBe(2);

    // 같은 조건이라도 relaxFilters 없으면 strict 0건 캐시를 읽고 0건 그대로다.
    const strictAgain = await postSearch(hc, {
      query: "영화",
      limit: 20,
      since: "2099-01-01",
      until: "2099-12-31",
    });
    expect(strictAgain.results).toEqual([]);
    expect(strictAgain.relaxed).toBe(false);
    expect(cache.size).toBe(2);

    hc.db.close();
  });

  test("placeValue 가 캐시 키를 바꿔 stale 회피(점수 바꾸는 칸은 키에 들어감·T8 정합)", async () => {
    // 같은 query·코퍼스를 place 유무로 호출하면 캐시 키 suffix '|place:' 가 달라
    // 각각 별도 캐시 항목으로 보관된다. place 가 장소 글 순위를 바꾼 결과가 place
    // 없는 1차 캐시에 가려지지(stale) 않음을 size 로 확정한다(D6 — 점수 바꾸는 칸
    // 전부 키에). 한 키였다면 두 번째 호출이 첫 캐시를 hit 해 place 효과가 묻혔을 것.
    const hc = makeHarness({ withCache: true });
    const placeNode = await hc.store.addNode({ content: "강남 A마트에서 산 영화" });
    await hc.store.setPlace(placeNode, "강남 A마트", "direct");
    await hc.store.addNode({ content: "다른 곳에서 산 영화" });
    const cache = hc.searchCache!;

    // place 없는 검색 → 캐시 항목 1.
    await postSearch(hc, { query: "영화", limit: 20 });
    expect(cache.size).toBe(1);
    // 같은 query 에 place 명시 → 키가 '|place:강남 A마트' 로 달라 별도 항목(size 2).
    await postSearch(hc, { query: "영화", limit: 20, place: "강남 A마트" });
    expect(cache.size).toBe(2);
    // place 검색 재호출 → 새 항목 0(place 키 hit) — size 그대로 2.
    await postSearch(hc, { query: "영화", limit: 20, place: "강남 A마트" });
    expect(cache.size).toBe(2);

    hc.db.close();
  });
});

// ── POST /search byte 동일 회귀 (활용 단계5 T8) ──────────────────────────────
//
// 계산 경로(/compute)가 같은 app(buildMemoryApi)에 합류한 뒤에도 /search 가
// 단계5 도입 전과 같은 결과를 결정적으로 내는지 명시 확인한다. 계산 경로는 별
// 엔드포인트라(Q3=A) /search 파일·점수식·retriever 를 호출조차 안 하지만, 같은
// app 에 라우트가 늘었으니 회귀 표면이 0 임을 같은 query 두 번으로 확정한다.
describe("POST /search — 계산 경로 합류 후 byte 동일 회귀(단계5 T8)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness();
    await h.store.addNode({ content: "회의에서 예산을 논의했다" });
    await h.store.addNode({ content: "내일 마트 일정이 있다" });
    await h.store.addNode({ content: "철수와 점심을 먹었다" });
  });
  afterEach(() => h.db.close());

  test("같은 query 두 번 검색 → node.id 순서 + score toBeCloseTo(…,10) 일치", async () => {
    const a = await postSearch(h, { query: "예산 회의", limit: 10 });
    const b = await postSearch(h, { query: "예산 회의", limit: 10 });
    expect(a.count).toBe(b.count);
    expect(a.results.map((r) => r.id)).toEqual(b.results.map((r) => r.id));
    for (let i = 0; i < a.results.length; i++) {
      expect(a.results[i]!.score).toBeCloseTo(b.results[i]!.score, 10);
    }
  });
});

// ── POST /search — 새 종류 검색 별 통로 entityHits(분류 단계3 T5·D14) ──────────
//
// entityHits 는 글 results 와 완전히 분리된 칸이다. 새 종류 0개면 entityHits: []
// 로 직렬화되고 results 는 도입 전과 byte 동일하다(공백 1·2 무접촉). 새 종류
// 1개+면 그 엔티티가 entityHits 에 *엔티티 자체* 로 뜨되 results 는 영향 0.
describe("POST /search — 새 종류 검색 별 통로 entityHits(단계3 T5)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness();
    await h.store.addNode({ content: "회의에서 예산을 논의했다" });
    await h.store.addNode({ content: "내일 마트 일정이 있다" });
  });
  afterEach(() => h.db.close());

  /** raw JSON 으로 entityHits 칸까지 읽는다(SearchResponse 타입엔 results 만 있음). */
  async function postRaw(payload: Record<string, unknown>): Promise<{
    count: number;
    results: Array<{ id: number; score: number }>;
    entityHits: Array<{ id: string; typeName: string; name: string; score: number }>;
  }> {
    const res = await h.app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    return (await jsonBody(res)) as {
      count: number;
      results: Array<{ id: number; score: number }>;
      entityHits: Array<{
        id: string;
        typeName: string;
        name: string;
        score: number;
      }>;
    };
  }

  test("새 종류 0개 — entityHits: [] · results 는 도입 전과 byte 동일", async () => {
    const body = await postRaw({ query: "예산 회의", limit: 10 });
    // 새 종류가 하나도 없으니 별 통로는 빈 배열(정직).
    expect(body.entityHits).toEqual([]);
    // results 는 글 RRF 그대로 — 새 종류 0개여도 글 검색이 정상 작동.
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.count).toBe(body.results.length);
  });

  test("새 종류 1개+ — 그 엔티티가 entityHits 에 뜨고 글 results 는 영향 0", async () => {
    // 글 검색만으로 1차 결과를 잡아 둔다(새 종류 추가 전 results 기준선).
    const before = await postRaw({ query: "예산 회의", limit: 10 });

    // 새 종류 "장비" 등록 + 엔티티 "키보드" 입력 + 색인 적재(별 통로 입력).
    h.store.entityTypeRegistryDb.addEntityType({
      typeName: "equipment",
      koName: "장비",
      idPrefix: "eqp_",
    });
    const kbd = await h.store.entitiesRepo.findOrCreateEntity("equipment", "키보드");
    h.store.entitiesRepo.setAttribute(kbd.id, "제조사", "레오폴드", true);
    await h.store.entitiesRepo.applyEmbedding(kbd.id);

    // 새 종류 추가 후 같은 글 query 는 results 가 byte 동일(별 통로라 글 RRF 무접촉).
    const sameQuery = await postRaw({ query: "예산 회의", limit: 10 });
    expect(sameQuery.results.map((r) => r.id)).toEqual(
      before.results.map((r) => r.id),
    );
    for (let i = 0; i < before.results.length; i++) {
      expect(sameQuery.results[i]!.score).toBeCloseTo(before.results[i]!.score, 10);
    }
    // 글 query 에는 새 종류 엔티티가 안 떠도 정상(검색어 무관) — entityHits 는
    // 키보드 검색에서 뜬다.
    const kbdSearch = await postRaw({ query: "키보드", limit: 10 });
    expect(kbdSearch.entityHits.length).toBeGreaterThan(0);
    const hit = kbdSearch.entityHits.find((e) => e.id === kbd.id);
    expect(hit).toBeDefined();
    expect(hit!.typeName).toBe("equipment");
    expect(hit!.name).toBe("키보드");
    expect(hit!.score).toBeGreaterThan(0);
  });
});

// ── POST /search — NFC 유니코드 정규화 경계(G3-a) ────────────────────────────
//
// body.query 가 검증 직후 NFC 로 통일돼 하류(캐시 키·retriever·응답 echo)가 모두
// 같은 정규화 문자열을 씀을 검증한다. macOS(NFD 입력) 등에서 같은 질의가 다른
// 바이트로 들어와도 같은 캐시 키·같은 검색 결과를 내야 한다(spec G3-a).
describe("POST /search — NFC 유니코드 정규화 경계(G3-a)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness();
    await h.store.addNode({ content: "노란후드 티셔츠를 새로 샀다" });
  });
  afterEach(() => {
    h.db.close();
  });

  test("NFD 질의와 NFC 질의가 같은 검색 결과를 낸다", async () => {
    const nfc = "노란후드".normalize("NFC");
    const nfd = "노란후드".normalize("NFD");
    // 사전 조건 — 두 표현이 실제로 다른 바이트인지 확인(테스트 전제).
    expect(nfc).not.toBe(nfd);

    const byNfc = await postSearch(h, { query: nfc, limit: 10 });
    const byNfd = await postSearch(h, { query: nfd, limit: 10 });

    expect(byNfc.results.map((r) => r.id)).toEqual(
      byNfd.results.map((r) => r.id),
    );
    for (let i = 0; i < byNfc.results.length; i++) {
      expect(byNfc.results[i]!.score).toBeCloseTo(byNfd.results[i]!.score, 10);
    }
  });

  test("응답 query 필드는 NFC 로 정규화된 값을 회신한다", async () => {
    const nfd = "노란후드".normalize("NFD");
    const body = await postSearch(h, { query: nfd, limit: 10 });
    expect(body.query).toBe("노란후드".normalize("NFC"));
  });

  test("NFC 입력은 그대로 불변(회귀) — 이미 NFC 인 질의는 echo 도 동일 바이트", async () => {
    const nfc = "노란후드".normalize("NFC");
    const body = await postSearch(h, { query: nfc, limit: 10 });
    expect(body.query).toBe(nfc);
  });

  test("NFD 질의와 NFC 질의가 같은 캐시 키를 써 캐시를 공유한다(retriever 1회만 호출)", async () => {
    const hc = makeHarness({ withCache: true });
    await hc.store.addNode({ content: "노란후드 티셔츠를 새로 샀다" });
    const cache = hc.searchCache!;

    const nfc = "노란후드".normalize("NFC");
    const nfd = "노란후드".normalize("NFD");

    await postSearch(hc, { query: nfc, limit: 10 });
    expect(cache.size).toBe(1);
    expect(hc.retrieveCalls()).toBe(1);

    // NFD 질의는 라우트 진입 시 NFC 로 정규화되므로 같은 캐시 키를 히트한다 —
    // retriever 재호출 0(캐시 크기도 그대로 1).
    await postSearch(hc, { query: nfd, limit: 10 });
    expect(cache.size).toBe(1);
    expect(hc.retrieveCalls()).toBe(1);

    hc.db.close();
  });
});
