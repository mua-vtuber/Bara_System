/**
 * search.revision.test.ts — Phase 7 ④ Task 7: 검색 결과 revision 양방향 플래그 첨부 검증.
 *
 * 설계 권위 = `docs/decisions/2026-06-02-phase7-redesign-design.md` ④ Revision.
 * superseded 노드는 검색에 *남되*(SUPERSEDE_PENALTY 0.5 감점 보존 — 숨기지 않음) 양방향
 * 작은 플래그만 붙는다. 옛 노드(바뀜)=superseded, 새 노드(갱신함)=supersedes.
 *
 * 첨부는 buildEnriched *후처리*(RRF·리랭커·dedup 뒤, 캐시 밖)에서 batch 두 조회로 채운다
 * (N+1 회피). RRF 코어(rrf.ts/search-tuning.ts/retriever.ts)는 호출조차 하지 않으며 점수·
 * 순위·count 는 불변이다 — 표시 칸 revision 만 늘어난다.
 *
 * 검증 항목:
 *   1. 옛 노드(바뀜) → revision.superseded=true / supersedes=false.
 *   2. 새 노드(갱신함) → revision.supersedes=true / superseded=false.
 *   3. revision 관계 없는 일반 노드 → 둘 다 false.
 *   4. revision 첨부가 RRF 순위·점수·count 를 안 바꾼다(회귀 0 — retriever 직접 결과 대조).
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

interface SearchRevisionFlag {
  superseded: boolean;
  supersedes: boolean;
}

interface SearchResultItem {
  id: number;
  content: string;
  score: number;
  sourceType: string;
  revision: SearchRevisionFlag;
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

/** 옛 노드 → 새 노드 supersede 한 쌍(supersedes 엣지 + revision 행). */
async function makeSupersedePair(
  store: SqliteMemoryStore,
  oldContent: string,
  newContent: string,
): Promise<{ oldId: number; newId: number }> {
  const oldId = await store.addNode({ content: oldContent });
  const newId = await store.addNode({ content: newContent });
  await store.addEdge({
    sourceId: newId,
    targetId: oldId,
    relation: "supersedes",
    provenance: "user_input",
    sourceNodeId: null,
    weight: 0.85,
  });
  await store.insertRevision({
    oldNodeId: oldId,
    newNodeId: newId,
    revisionType: "conflict_supersede",
    reason: "충돌 감지",
    similarityScore: 0.85,
  });
  return { oldId, newId };
}

describe("POST /search — Phase 7 ④ Task 7 revision 양방향 플래그 첨부", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("옛·새 노드 둘 다 검색되면 양방향 플래그가 갈린다", async () => {
    // 두 글이 같은 검색어에 함께 잡히게 어휘를 공유한다.
    const { oldId, newId } = await makeSupersedePair(
      h.store,
      "다음 회의 장소는 강남 사무실",
      "다음 회의 장소는 판교 사무실로 변경",
    );

    const body = await search(h.app, "다음 회의 장소 사무실");

    const oldR = body.results.find((r) => r.id === oldId);
    const newR = body.results.find((r) => r.id === newId);
    expect(oldR).toBeDefined();
    expect(newR).toBeDefined();

    // 옛 노드 = 바뀜(다른 노드에 덮임).
    expect(oldR!.revision.superseded).toBe(true);
    expect(oldR!.revision.supersedes).toBe(false);
    // 새 노드 = 갱신함(다른 노드를 덮음).
    expect(newR!.revision.supersedes).toBe(true);
    expect(newR!.revision.superseded).toBe(false);
  });

  test("superseded 옛 노드는 검색에 남는다(숨기지 않음 — 플래그만)", async () => {
    const { oldId } = await makeSupersedePair(
      h.store,
      "프로젝트 마감일은 6월 말",
      "프로젝트 마감일은 7월 초로 변경",
    );

    const body = await search(h.app, "프로젝트 마감일");
    // 감점은 받되 결과에서 사라지지 않는다.
    const oldR = body.results.find((r) => r.id === oldId);
    expect(oldR).toBeDefined();
    expect(oldR!.revision.superseded).toBe(true);
  });

  test("revision 관계 없는 일반 노드 → 둘 다 false", async () => {
    const id = await h.store.addNode({
      content: "오늘 아침 커피를 마시며 책을 읽었다",
    });

    const body = await search(h.app, "아침 커피 책");
    const hit = body.results.find((r) => r.id === id);
    expect(hit).toBeDefined();
    expect(hit!.revision.superseded).toBe(false);
    expect(hit!.revision.supersedes).toBe(false);
  });

  test("revision 첨부가 RRF 순위·점수·count 를 안 바꾼다(회귀 0)", async () => {
    // supersede 쌍 + 무관 노드를 섞어 적재. revision 첨부 전후로 retriever 직접 결과와
    // 검색 응답의 id 순서·점수·개수가 일치해야 한다(첨부는 표시 칸만 더한다).
    await makeSupersedePair(
      h.store,
      "예전 운동 루틴은 달리기 위주",
      "새 운동 루틴은 수영 위주로 변경",
    );
    await h.store.addNode({ content: "운동 후 단백질 보충이 중요하다" });
    await h.store.addNode({ content: "운동 기록을 노트에 적는다" });

    const retriever = new HybridRetriever(h.store, embedder);
    const raw = await retriever.retrieve("운동 루틴 기록", { limit: 10 });
    const body = await search(h.app, "운동 루틴 기록");

    expect(body.count).toBe(raw.length);
    for (let i = 0; i < raw.length; i++) {
      expect(body.results[i]!.id).toBe(raw[i]!.node.id);
      expect(body.results[i]!.score).toBeCloseTo(raw[i]!.score, 10);
      // 모든 항목에 revision 칸이 채워져 있다(default 또는 batch 판별).
      expect(typeof body.results[i]!.revision.superseded).toBe("boolean");
      expect(typeof body.results[i]!.revision.supersedes).toBe("boolean");
    }
  });
});
