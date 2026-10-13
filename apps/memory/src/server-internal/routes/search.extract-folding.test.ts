/**
 * search.extract-folding.test.ts — 입력 통로 통합 Task 4: llm_extract 자식 노드 →
 * 부모 원본 검색 매핑(치환 + dedup + 점수 승계 + 고아 graceful) E2E 검증.
 *
 * 설계 권위 = `docs/decisions/2026-06-01-input-pipeline-unification-spec.md` §5 / D8.
 * 후처리는 search 라우트 enriched 단계(RRF·리랭커 뒤, 캐시 밖 — neighbor-chunks·
 * 캡션 치환과 같은 라인)에 들어가며 RRF 코어·리랭커·순위 계산을 호출조차 하지 않는다.
 * 이 테스트는 그 변환만 검증한다(점수 산출은 retriever 책임).
 *
 * 캡션 치환(search.caption-mapping.test.ts)과 같은 정신이되, 자식 종류가 llm_extract,
 * 부모 종류가 auto_capture·document 라는 점만 다르다. merged_into 엣지로 부모를 찾는다.
 *
 * 검증 항목:
 *   1. llm_extract 노드가 검색되면 부모 원본(auto_capture)으로 치환돼 나온다.
 *   2. 같은 원본이 추출 경로 + 원본 직접 경로 둘 다면 dedup 으로 1건.
 *   3. 점수 승계 — 두 경로 중 높은 점수를 부모 원본이 받는다.
 *   4. 고아 추출(merged_into 엣지 없음) → 추출 노드 그대로(가짜 부모 0).
 *   5. 추출 노드 0건 일반 글 검색은 이 단계 전후 결과 불변(회귀 0).
 *
 * 실 Bgem3Embedder + bun:sqlite :memory: — mock 0. 운영 DB 절대 비접근.
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

interface SearchResultItem {
  id: number;
  content: string;
  score: number;
  sourceType: string;
}

interface SearchResponse {
  query: string;
  count: number;
  results: SearchResultItem[];
}

async function search(
  app: Hono,
  query: string,
  limit = 10,
): Promise<SearchResponse> {
  const res = await app.request("/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SearchResponse;
}

/** 원본(auto_capture) + 추출(llm_extract) 자식 + merged_into 엣지를 함께 적재. */
async function addRawWithExtract(
  store: SqliteMemoryStore,
  rawContent: string,
  extractContent: string,
): Promise<{ rawId: number; extractId: number }> {
  const rawId = await store.addNode({
    content: rawContent,
    sourceType: "auto_capture",
  });
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

describe("POST /search — Task 4 llm_extract → 부모 원본 치환 매핑", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("추출 노드가 검색되면 부모 원본으로 치환돼 나온다", async () => {
    // 원본 content 는 검색어와 안 겹치는 라벨(추출 경로로만 뜨게).
    const { rawId } = await addRawWithExtract(
      h.store,
      "원본 라벨 zzqx",
      "회의에서 다음 주 출시 일정을 확정했다",
    );

    const body = await search(h.app, "출시 일정 확정");

    // 결과에 부모 원본이 나온다(추출 노드가 아니라).
    const hit = body.results.find((r) => r.id === rawId);
    expect(hit).toBeDefined();
    expect(hit!.sourceType).toBe("auto_capture");
    // 추출 노드(source_type='llm_extract') 자체는 결과에 안 남는다(치환됨).
    expect(body.results.some((r) => r.sourceType === "llm_extract")).toBe(
      false,
    );
  });

  test("같은 원본이 추출 + 원본 두 경로면 dedup 으로 1건", async () => {
    // 원본 content 도 검색어와 매칭되게 → 원본이 직접 결과에 들고, 추출도 같은
    // 부모를 가리켜 결과에 든다. 두 경로가 같은 부모라 dedup 후 1건이어야 한다.
    const { rawId } = await addRawWithExtract(
      h.store,
      "프로젝트 예산 보고서 초안",
      "프로젝트 예산 보고서를 초안으로 작성했다",
    );

    const body = await search(h.app, "프로젝트 예산 보고서");

    const hits = body.results.filter((r) => r.id === rawId);
    expect(hits.length).toBe(1);
    expect(body.results.some((r) => r.sourceType === "llm_extract")).toBe(
      false,
    );
  });

  test("점수 승계 — 두 경로 중 높은 점수를 부모 원본이 받는다", async () => {
    const { rawId } = await addRawWithExtract(
      h.store,
      "주말 등산 계획 정리",
      "주말에 친구들과 등산 계획을 세웠다",
    );

    const body = await search(h.app, "주말 등산 계획");
    const merged = body.results.find((r) => r.id === rawId);
    expect(merged).toBeDefined();

    // retriever 직접 결과에서 원본·추출 두 노드의 RRF 점수를 확인하고, 치환된
    // 부모 점수가 그중 최댓값과 일치하는지 단언한다(임의 고정값 아님).
    const retriever = new HybridRetriever(h.store, embedder);
    const raw = await retriever.retrieve("주말 등산 계획", { limit: 10 });
    const rawHit = raw.find((r) => r.node.id === rawId);
    const extractHit = raw.find(
      (r) => r.node.sourceType === "llm_extract",
    );
    const expectedScore = Math.max(
      rawHit ? rawHit.score : -Infinity,
      extractHit ? extractHit.score : -Infinity,
    );
    expect(merged!.score).toBeCloseTo(expectedScore, 10);
  });

  test("고아 추출(merged_into 엣지 없음) → 추출 노드 그대로 표시(가짜 부모 0)", async () => {
    // merged_into 엣지·부모 없이 추출 노드만 직접 적재(데이터 이상 재현).
    const orphanId = await h.store.addNode({
      content: "엣지 없는 추출 사실 — 단풍 구경",
      sourceType: "llm_extract",
    });

    const body = await search(h.app, "단풍 구경");

    const orphan = body.results.find((r) => r.id === orphanId);
    expect(orphan).toBeDefined();
    expect(orphan!.sourceType).toBe("llm_extract");
  });

  test("추출 0건 일반 글 검색 — 치환 단계 전후 결과 불변(회귀 0)", async () => {
    await h.store.addNode({ content: "오늘 회의록 요약입니다" });
    await h.store.addNode({ content: "내일 일정 정리" });
    await h.store.addNode({ content: "커피를 마셨다" });

    const retriever = new HybridRetriever(h.store, embedder);
    const raw = await retriever.retrieve("회의록 일정", { limit: 10 });
    const body = await search(h.app, "회의록 일정");

    expect(body.count).toBe(raw.length);
    for (let i = 0; i < raw.length; i++) {
      expect(body.results[i]!.id).toBe(raw[i]!.node.id);
      expect(body.results[i]!.score).toBeCloseTo(raw[i]!.score, 10);
      expect(body.results[i]!.sourceType).not.toBe("llm_extract");
    }
  });
});
