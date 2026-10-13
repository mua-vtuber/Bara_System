/**
 * search.summary-channel.test.ts — Phase 7 깊은 패스 둘째 단계 Task 8 + Task 15 정밀화:
 * 요약 검색 옵션 채널 후처리 + 열람 표시 조회 검증(개념 id 흐름).
 *
 * 설계 권위 = docs/decisions/2026-06-05-phase7-summary-stage-spec.md 단락 5.2(검색
 * 합류 RRF 0줄)·5.4(열람 표시 — 개념·사람 중심), plan Task 8·15.
 *
 * 요약 텍스트는 검색에 *RRF 합산 후 후처리* 로만 합류한다(14b 인접 청크 선례) —
 * results 배열·순서·점수·count 를 안 바꾸고 표시 칸(chunkSummary·relationSummaries)
 * 만 더한다. 토글은 body.withSummaries 별 파라미터(search-cache.ts include 충돌 회피)
 * 이고 캐시 키에 안 넣는다. 관계요약은 confidence 로 엣지 유무(보류 라벨)를 판정한다.
 *
 * Task 15 정정: 관계요약 from/to 가 *개념 id*(cpt_/psn_ TEXT)로 바뀌었다. 검색 결과
 * 글 노드는 그 노드에 붙은 개념(node_concept_edges)을 거쳐 그 개념의 관계요약을 모은다 —
 * 옛 글 노드 id 직접 조회(listRelationSummariesForNode)를 노드→개념→관계 매핑으로 갈음.
 *
 * 검증 항목:
 *   1. withSummaries:true → 청크 노드 결과 enriched 에 chunkSummary 한 문장 채움.
 *   2. withSummaries:true → 결과 노드의 개념이 든 관계요약을 relationSummaries 목록으로 채움
 *      (relation_name + 요약 문장 + 엣지 유무 판정용 confidence + 개념 id from/to).
 *   3. withSummaries:false / 미주입 → 두 칸 빈 상태(default null / 빈 배열).
 *   4. withSummaries on/off 가 RRF 순위·점수·count 를 byte 동일로 유지(불변식 — retriever
 *      직접 결과 + on↔off 응답 대조).
 *   5. 요약 0건 노드 → chunkSummary null / relationSummaries 빈 배열(정직한 빈 표시).
 *   6. 열람 조회 메서드(store.getChunkSummary · listRelationSummariesForConcept) 직접 회신.
 *
 * 실 bun:sqlite(:memory:) + 실 Bgem3Embedder. mock 0. 운영 DB 비접근.
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
}

function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  // reranker 미주입 — 라우트가 리랭커 단계를 건너뛰어 RRF 순서·점수가 그대로다.
  const app = buildMemoryApi({ store, retriever, assembler });
  return { app, db, store };
}

interface RelationSummaryDisplay {
  summaryId: string;
  fromConceptId: string;
  toConceptId: string;
  relationName: string;
  summaryText: string;
  confidence: number;
  edgePresent: boolean;
}

interface ChunkSummaryDisplay {
  summaryText: string;
  generatedBy: string;
}

interface SearchResultItem {
  id: number;
  content: string;
  score: number;
  sourceType: string;
  chunkSummary: ChunkSummaryDisplay | null;
  relationSummaries: RelationSummaryDisplay[];
}

interface SearchResponse {
  query: string;
  count: number;
  results: SearchResultItem[];
}

async function search(
  app: Hono,
  query: string,
  opts: { limit?: number; withSummaries?: boolean } = {},
): Promise<SearchResponse> {
  const body: Record<string, unknown> = { query, limit: opts.limit ?? 10 };
  if (opts.withSummaries !== undefined) body.withSummaries = opts.withSummaries;
  const res = await app.request("/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SearchResponse;
}

/**
 * 청크 노드 한 개를 만들고, 그 노드를 가리키는 chunk_summaries 한 행을 저장한다.
 * chunk_summaries 는 parent_document_id → documents → asset_files FK 사슬을 요구하므로
 * 실 자산·문서 행을 먼저 만든다(document-repository.test.ts 양식 정합). 실 임베딩으로
 * vec 행까지 들어간다(요약 채널이 의미 검색에 쓰는 그 자료).
 */
async function makeChunkWithSummary(
  h: Harness,
  content: string,
  summaryText: string,
): Promise<number> {
  const chunkId = await h.store.addNode({ content });
  const sha = `sha_${chunkId}`;
  h.db
    .prepare(
      `INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, first_imported_at)
       VALUES (?, 'text', '/assets/${sha}.md', 1, ?)`,
    )
    .run(sha, Date.now());
  const docId = h.store.createDocument({
    assetSha256: sha,
    title: `문서 ${chunkId}`,
    documentType: "text",
  });
  await h.store.insertChunkSummary({
    summaryId: `cs_${chunkId}`,
    parentChunkId: chunkId,
    parentDocumentId: docId,
    summaryText,
    generatedBy: "llm",
  });
  return chunkId;
}

/**
 * 글 노드를 만들고 그 노드에 한 개념(name 으로 생성·연결)을 붙인다. 검색 결과 노드 →
 * 개념 → 관계요약 매핑(Task 15)의 재료. 회신 = 글 노드 id + 개념 id.
 */
async function makeNodeWithConcept(
  h: Harness,
  content: string,
  conceptName: string,
): Promise<{ nodeId: number; conceptId: string }> {
  const nodeId = await h.store.addNode({ content });
  const conceptId = await h.store.findOrCreateConcept(conceptName);
  await h.store.addNodeConceptEdge(nodeId, conceptId, "tag", "user_input", nodeId);
  return { nodeId, conceptId };
}

/**
 * documents 행 + document 노드를 만들고 그 document_id 를 회신(관계요약 source_document_id 용).
 * 운영 ingest(ingest-document-flow)는 documents 행마다 document 노드를 함께 만든다 — 검색은
 * 관계요약을 그 document 노드가 이번 응답에서 허용일 때만 싣는다(WP-B1-03 출처 판정).
 */
async function makeDocument(h: Harness, tag: string): Promise<string> {
  const sha = `sha_doc_${tag}`;
  h.db
    .prepare(
      `INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, first_imported_at)
       VALUES (?, 'text', '/assets/${sha}.md', 1, ?)`,
    )
    .run(sha, Date.now());
  const title = `문서 ${tag}`;
  const documentId = h.store.createDocument({
    assetSha256: sha,
    title,
    documentType: "text",
  });
  await h.store.addNode({
    content: title,
    sourceType: "document",
    metadata: { documentId, title },
  });
  return documentId;
}

describe("POST /search — Task 8·15 요약 검색 채널 후처리 (RRF 0줄 / 개념 id 흐름)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("withSummaries:true → 청크 결과 enriched 에 청크요약 한 문장 채움", async () => {
    const id = await makeChunkWithSummary(
      h,
      "회의에서 신제품 출시 일정과 마케팅 예산을 길게 논의했다",
      "신제품 출시 일정과 마케팅 예산 논의",
    );
    const body = await search(h.app, "신제품 출시 일정 마케팅 예산", {
      withSummaries: true,
    });
    const hit = body.results.find((r) => r.id === id);
    expect(hit).toBeDefined();
    expect(hit!.chunkSummary).not.toBeNull();
    expect(hit!.chunkSummary!.summaryText).toBe(
      "신제품 출시 일정과 마케팅 예산 논의",
    );
    expect(hit!.chunkSummary!.generatedBy).toBe("llm");
  });

  test("withSummaries:true → 결과 노드의 개념이 든 관계요약을 목록으로 채움(개념 id 흐름)", async () => {
    // 두 글 노드 각각에 개념을 붙이고, 두 개념 사이 관계요약을 저장한다.
    const a = await makeNodeWithConcept(
      h,
      "라이벌 팀 A 는 공격 전술이 강하다",
      "팀에이",
    );
    const b = await makeNodeWithConcept(
      h,
      "라이벌 팀 B 는 수비 전술이 강하다",
      "팀비",
    );
    const docId = await makeDocument(h, "rivals");
    await h.store.insertRelationSummary({
      summaryId: `rs_${a.conceptId}_${b.conceptId}`,
      fromConceptId: a.conceptId,
      toConceptId: b.conceptId,
      relationName: "라이벌",
      summaryText: "두 팀은 오랜 라이벌 관계다",
      confidence: 0.8,
      generatedBy: "llm",
      sourceDocumentId: docId,
    });

    const body = await search(h.app, "라이벌 팀 전술 공격 수비", {
      withSummaries: true,
    });
    const fromR = body.results.find((r) => r.id === a.nodeId);
    expect(fromR).toBeDefined();
    expect(fromR!.relationSummaries.length).toBe(1);
    expect(fromR!.relationSummaries[0]!.relationName).toBe("라이벌");
    expect(fromR!.relationSummaries[0]!.summaryText).toBe(
      "두 팀은 오랜 라이벌 관계다",
    );
    expect(fromR!.relationSummaries[0]!.fromConceptId).toBe(a.conceptId);
    expect(fromR!.relationSummaries[0]!.toConceptId).toBe(b.conceptId);
    expect(fromR!.relationSummaries[0]!.confidence).toBeCloseTo(0.8, 10);
    // confidence 0.8 ≥ 임계(default 0.6) → 엣지 승격됨(연결됨).
    expect(fromR!.relationSummaries[0]!.edgePresent).toBe(true);

    // to 개념을 가진 노드에서도 같은 관계가 보인다(양방향 조회).
    const toR = body.results.find((r) => r.id === b.nodeId);
    expect(toR).toBeDefined();
    expect(toR!.relationSummaries.length).toBe(1);
    expect(toR!.relationSummaries[0]!.relationName).toBe("라이벌");
  });

  test("관계요약 confidence 보류분 → edgePresent=false (발굴됨/연결 보류 라벨)", async () => {
    const p = await makeNodeWithConcept(
      h,
      "취미로 도자기 빚기를 시작했다",
      "도자기",
    );
    const q = await makeNodeWithConcept(
      h,
      "취미로 유화 그리기를 배운다",
      "유화",
    );
    const docId = await makeDocument(h, "hobby");
    // confidence 0.4 < 임계(default 0.6) → 엣지 미승격(보류).
    await h.store.insertRelationSummary({
      summaryId: `rs_${p.conceptId}_${q.conceptId}_low`,
      fromConceptId: p.conceptId,
      toConceptId: q.conceptId,
      relationName: "취미관련",
      summaryText: "두 취미는 손으로 만드는 공예라는 점에서 닿아 있다",
      confidence: 0.4,
      generatedBy: "llm",
      sourceDocumentId: docId,
    });

    const body = await search(h.app, "취미 도자기 유화 공예 손", {
      withSummaries: true,
    });
    const pr = body.results.find((r) => r.id === p.nodeId);
    expect(pr).toBeDefined();
    expect(pr!.relationSummaries.length).toBe(1);
    expect(pr!.relationSummaries[0]!.confidence).toBeCloseTo(0.4, 10);
    expect(pr!.relationSummaries[0]!.edgePresent).toBe(false);
  });

  test("withSummaries:false → 두 칸 빈 상태(default null / 빈 배열)", async () => {
    const id = await makeChunkWithSummary(
      h,
      "주말 등산 코스와 준비물을 정리했다",
      "주말 등산 코스 준비물 정리",
    );
    const body = await search(h.app, "주말 등산 코스 준비물", {
      withSummaries: false,
    });
    const hit = body.results.find((r) => r.id === id);
    expect(hit).toBeDefined();
    expect(hit!.chunkSummary).toBeNull();
    expect(hit!.relationSummaries).toEqual([]);
  });

  test("withSummaries 미주입 → 두 칸 빈 상태(채널 후처리 미적용)", async () => {
    const id = await makeChunkWithSummary(
      h,
      "독서 모임에서 추천받은 책 목록을 적었다",
      "독서 모임 추천 책 목록",
    );
    const body = await search(h.app, "독서 모임 추천 책 목록");
    const hit = body.results.find((r) => r.id === id);
    expect(hit).toBeDefined();
    expect(hit!.chunkSummary).toBeNull();
    expect(hit!.relationSummaries).toEqual([]);
  });

  test("요약 0건 노드 → 청크요약 null / 관계 빈 배열(정직한 빈 표시)", async () => {
    const id = await h.store.addNode({
      content: "아침에 가벼운 산책을 다녀왔다",
    });
    const body = await search(h.app, "아침 산책", { withSummaries: true });
    const hit = body.results.find((r) => r.id === id);
    expect(hit).toBeDefined();
    expect(hit!.chunkSummary).toBeNull();
    expect(hit!.relationSummaries).toEqual([]);
  });

  test("withSummaries on↔off 가 RRF 순위·점수·count 를 byte 동일로 유지(불변식)", async () => {
    // 청크요약·관계요약을 섞어 적재해도 검색 점수·순서·개수는 안 바뀐다.
    await makeChunkWithSummary(
      h,
      "정원 가꾸기에서 봄철 씨앗 심기와 물 주기를 다뤘다",
      "봄철 씨앗 심기와 물 주기",
    );
    const a = await makeNodeWithConcept(h, "봄철 정원 꽃 심기 계획", "꽃심기");
    const b = await makeNodeWithConcept(h, "봄철 정원 흙 고르기 작업", "흙고르기");
    const docId = await makeDocument(h, "garden");
    await h.store.insertRelationSummary({
      summaryId: "rs_garden",
      fromConceptId: a.conceptId,
      toConceptId: b.conceptId,
      relationName: "선후관계",
      summaryText: "흙 고르기 뒤에 꽃 심기를 한다",
      confidence: 0.7,
      generatedBy: "llm",
      sourceDocumentId: docId,
    });

    const query = "봄철 정원 심기 물 주기 흙";
    const retriever = new HybridRetriever(h.store, embedder);
    const raw = await retriever.retrieve(query, { limit: 10 });

    const on = await search(h.app, query, { withSummaries: true });
    const off = await search(h.app, query, { withSummaries: false });

    expect(on.count).toBe(off.count);
    expect(off.count).toBe(raw.length);
    for (let i = 0; i < raw.length; i++) {
      // 순서·id 가 retriever 직접 결과와 일치(후처리는 순서를 안 건드림).
      expect(off.results[i]!.id).toBe(raw[i]!.node.id);
      expect(on.results[i]!.id).toBe(off.results[i]!.id);
      // 점수가 on↔off byte 동일 + retriever 직접 점수와 일치.
      expect(off.results[i]!.score).toBeCloseTo(raw[i]!.score, 10);
      expect(on.results[i]!.score).toBe(off.results[i]!.score);
    }
  });
});

describe("store 열람 조회 메서드 (Task 14 개념 id — Task 15 직접 검증)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("getChunkSummary 한 청크 노드의 청크요약 회신 / 없으면 null", async () => {
    const id = await makeChunkWithSummary(
      h,
      "장문의 회고 글 — 한 해의 배움을 정리했다",
      "한 해 배움 회고 요약",
    );
    const got = h.store.getChunkSummary(id);
    expect(got).not.toBeNull();
    expect(got!.summaryText).toBe("한 해 배움 회고 요약");

    const empty = await h.store.addNode({ content: "요약 없는 짧은 메모" });
    expect(h.store.getChunkSummary(empty)).toBeNull();
  });

  test("listRelationSummariesForConcept 개념 양방향 회신 / 엣지 보류 confidence 동반", async () => {
    const x = await h.store.findOrCreateConcept("개념엑스");
    const y = await h.store.findOrCreateConcept("개념와이");
    const docId = await makeDocument(h, "xy");
    // confidence 0.4 = 보류(엣지 미승격 — 표시만 "발굴됨").
    await h.store.insertRelationSummary({
      summaryId: "rs_xy_low",
      fromConceptId: x,
      toConceptId: y,
      relationName: "약한관련",
      summaryText: "X 와 Y 는 약하게 관련된다",
      confidence: 0.4,
      generatedBy: "llm",
      sourceDocumentId: docId,
    });

    const fromX = h.store.listRelationSummariesForConcept(x);
    expect(fromX.length).toBe(1);
    expect(fromX[0]!.confidence).toBeCloseTo(0.4, 10);
    expect(fromX[0]!.fromConceptId).toBe(x);
    expect(fromX[0]!.toConceptId).toBe(y);

    const fromY = h.store.listRelationSummariesForConcept(y);
    expect(fromY.length).toBe(1);
    expect(fromY[0]!.relationName).toBe("약한관련");

    const none = await h.store.findOrCreateConcept("외톨이개념");
    expect(h.store.listRelationSummariesForConcept(none)).toEqual([]);
  });
});
