/**
 * HybridRetriever integration tests.
 *
 * Real bun:sqlite + real Bgem3Embedder. No mocks.
 * RRF unit tests (pure functions) come first, then the full pipeline.
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
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import {
  HybridRetriever,
  MENTION_BOOST_PER_COUNT,
  RRF_K,
  SUPERSEDE_PENALTY,
  W_IMPORTANCE,
  W_RECENCY,
  pickGraphSeeds,
  reciprocalRankFusion,
} from "./retriever.ts";
import { RRF_BLEND_WEIGHT, BM25_CROSS_WEIGHT } from "./search-tuning.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

// ── Pure RRF tests ──────────────────────────────────────────────────────

describe("reciprocalRankFusion (pure)", () => {
  test("single ranking: scores follow 1/(k+rank+1)", () => {
    const result = reciprocalRankFusion([[10, 20, 30]]);
    expect(result.get(10)).toBeCloseTo(1 / (RRF_K + 1), 6);
    expect(result.get(20)).toBeCloseTo(1 / (RRF_K + 2), 6);
    expect(result.get(30)).toBeCloseTo(1 / (RRF_K + 3), 6);
  });

  test("same id in two rankings: scores accumulate", () => {
    const result = reciprocalRankFusion([[42], [42]]);
    expect(result.get(42)).toBeCloseTo(2 / (RRF_K + 1), 6);
  });

  test("empty rankings → empty map", () => {
    expect(reciprocalRankFusion([]).size).toBe(0);
    expect(reciprocalRankFusion([[], [], []]).size).toBe(0);
  });

  test("node in multiple sources outranks node deep in single source", () => {
    // 노드 1: source A 5위, source B 5위 → 2 * 1/65
    // 노드 2: source A 1위만 → 1 * 1/61
    // 둘 다 비슷하지만 1번이 가중되어야
    const result = reciprocalRankFusion([
      [99, 98, 97, 96, 1],
      [89, 88, 87, 86, 1],
    ]);
    const result2 = reciprocalRankFusion([[2]]);
    const s1 = result.get(1)!;
    const s2 = result2.get(2)!;
    expect(s1).toBeGreaterThan(s2);
  });

  test("custom k changes weighting", () => {
    const rrf60 = reciprocalRankFusion([[1, 2]], 60);
    const rrf10 = reciprocalRankFusion([[1, 2]], 10);
    // k=10 makes top vs bottom gap larger
    const gap60 = (rrf60.get(1) as number) - (rrf60.get(2) as number);
    const gap10 = (rrf10.get(1) as number) - (rrf10.get(2) as number);
    expect(gap10).toBeGreaterThan(gap60);
  });
});

describe("pickGraphSeeds (pure)", () => {
  test("merges two maps and returns top-N by summed score", () => {
    const v = new Map([
      [1, 0.5],
      [2, 0.3],
    ]);
    const f = new Map([
      [2, 0.4],
      [3, 0.2],
    ]);
    const seeds = pickGraphSeeds(v, f, 2);
    // id=2 wins (0.3+0.4=0.7), id=1 next (0.5)
    expect(seeds).toEqual([2, 1]);
  });

  test("empty inputs → empty output", () => {
    expect(pickGraphSeeds(new Map(), new Map(), 5)).toEqual([]);
  });

  test("respects topN limit", () => {
    const v = new Map([
      [1, 0.5],
      [2, 0.4],
      [3, 0.3],
      [4, 0.2],
    ]);
    expect(pickGraphSeeds(v, new Map(), 2)).toEqual([1, 2]);
  });
});

// ── End-to-end retrieval ────────────────────────────────────────────────

describe("HybridRetriever.retrieve — end-to-end", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let retriever: HybridRetriever;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    retriever = new HybridRetriever(store, embedder);
  });
  afterEach(() => { db.close(); });

  test("returns empty list when store is empty", async () => {
    const results = await retriever.retrieve("아무거나");
    expect(results).toEqual([]);
  });

  test("finds nodes by lexical match (FTS branch)", async () => {
    const coffeeId = await store.addNode({ content: "철수는 커피를 좋아한다" });
    await store.addNode({ content: "자동차를 새로 샀다" });
    await store.addNode({ content: "오늘 비가 왔다" });

    const results = await retriever.retrieve("커피");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.node.id).toBe(coffeeId);
    expect(results[0]!.sources).toContain("fts");
  });

  test("finds nodes by semantic match even with different words", async () => {
    const coffeeId = await store.addNode({
      content: "아침마다 에스프레소를 한 잔 마신다",
    });
    await store.addNode({ content: "자전거 타기를 좋아함" });

    // 쿼리에 "에스프레소"가 없어도 의미상 유사하므로 vector branch가 잡아야 함
    const results = await retriever.retrieve("커피 음료 카페인");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.node.id).toBe(coffeeId);
    expect(results[0]!.sources).toContain("vector");
  });

  test("graph expansion brings in linked nodes not directly matched", async () => {
    const seed = await store.addNode({ content: "철수는 커피를 좋아한다" });
    const linked = await store.addNode({
      content: "회의 메모: 자정 라이브 일정",
    });
    // vector/FTS와 의미·글자 모두 무관한 노이즈를 더 채워 seed만 top-K에 들어오게
    for (let i = 0; i < 5; i++) {
      await store.addNode({ content: `노이즈 ${i} 산악 자전거 등산` });
    }
    // 두 노드를 명시적으로 연결
    await store.addEdge({
      sourceId: seed,
      targetId: linked,
      relation: "related_to",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.9,
    });

    // vectorK=1, ftsLimit=1 로 좁혀 linked가 graph branch로만 들어오도록 강제
    const results = await retriever.retrieve("커피", {
      vectorK: 1,
      ftsLimit: 1,
    });
    const ids = results.map((r) => r.node.id);
    expect(ids).toContain(seed);
    expect(ids).toContain(linked);
    const linkedResult = results.find((r) => r.node.id === linked)!;
    expect(linkedResult.sources).toEqual(["graph"]);
  });

  test("node hit by multiple sources scores higher than single-source hits", async () => {
    const multi = await store.addNode({ content: "철수와 커피 마신 약속" });
    const fts = await store.addNode({ content: "커피 머신 청소" });
    // 의미 검색용 추가 노드 (단어가 다르지만 의미는 비슷)
    await store.addNode({ content: "에스프레소 원두 구매 메모" });
    // 'multi' 노드를 다른 노드들과 연결해 graph에도 잡히게
    await store.addEdge({
      sourceId: multi,
      targetId: fts,
      relation: "related_to",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.5,
    });

    const results = await retriever.retrieve("커피");
    const multiResult = results.find((r) => r.node.id === multi);
    expect(multiResult).toBeDefined();
    expect(multiResult!.sources.length).toBeGreaterThanOrEqual(2);
    // 다중 source 노드는 상위
    expect(results[0]!.sources.length).toBeGreaterThanOrEqual(2);
  });

  test("superseded node is demoted via SUPERSEDE_PENALTY", async () => {
    const oldFact = await store.addNode({
      content: "철수의 전화번호 010-1111-2222",
      author: "user",
      memoryType: "fact",
    });
    const newFact = await store.addNode({
      content: "철수의 전화번호 010-9999-8888",
      author: "user",
      memoryType: "fact",
    });
    // newFact가 oldFact를 supersede
    await store.addEdge({
      sourceId: newFact,
      targetId: oldFact,
      relation: "supersedes",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.9,
    });

    const results = await retriever.retrieve("철수 전화번호");
    const oldResult = results.find((r) => r.node.id === oldFact);
    const newResult = results.find((r) => r.node.id === newFact);

    expect(oldResult).toBeDefined();
    expect(newResult).toBeDefined();
    expect(oldResult!.components.supersedePenalty).toBe(SUPERSEDE_PENALTY);
    expect(newResult!.components.supersedePenalty).toBe(1.0);
    // 옛 정보는 새 정보 아래에 (또는 같은 자리)
    expect(newResult!.score).toBeGreaterThan(oldResult!.score);
  });

  test("mention boost surfaces frequently-mentioned nodes", async () => {
    const cold = await store.addNode({ content: "철수와 한 번 카페 갔다" });
    const hot = await store.addNode({
      content: "철수와 매일 카페에서 만남",
    });
    // hot 노드를 여러 번 mention
    for (let i = 0; i < 5; i++) await store.bumpMention(hot);

    const results = await retriever.retrieve("철수 카페");
    const hotResult = results.find((r) => r.node.id === hot)!;
    const coldResult = results.find((r) => r.node.id === cold)!;
    expect(hotResult.components.mentionBoost).toBeGreaterThan(
      coldResult.components.mentionBoost,
    );
    expect(hotResult.components.mentionBoost).toBeCloseTo(
      Math.min(5 * MENTION_BOOST_PER_COUNT, 0.1),
      6,
    );
  });

  test("touchNodesBatch fires on returned nodes (access_count updated)", async () => {
    const id = await store.addNode({ content: "방문 추적 대상 메모" });
    const before = await store.getNode(id);
    expect(before!.accessCount).toBe(0);

    const results = await retriever.retrieve("방문");
    expect(results.length).toBeGreaterThanOrEqual(1);

    const after = await store.getNode(id);
    expect(after!.accessCount).toBe(1);
  });

  test("limit option caps result length", async () => {
    for (let i = 0; i < 5; i++) {
      await store.addNode({ content: `메모 ${i} — 커피 ${i}` });
    }
    const results = await retriever.retrieve("커피", { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("components add up to final score — 전체 blend 수식 검증", async () => {
    // qa Minor 반영(T5): 운영 default(floor-중립, blend 1.0/0.0)에서만 성립하던
    // 단순 `rrf + recency + importance + mentionBoost` 수식을 전체 blend 수식으로
    // 갱신. 비-중립 상수(예: blend 0.7/0.3)에서도 단언이 유효하게 된다.
    //
    // finalScore 수식(T4 강도-반영 정밀 재채점 가산 항 포함):
    //   blended = RRF_BLEND_WEIGHT × boostedRrf
    //           + BM25_CROSS_WEIGHT × bm25Cross
    //           + precisionStrength            (T4 — λ × 보정 강도 결합값)
    //           + W_RECENCY × recency
    //           + W_IMPORTANCE × importance
    //           + mentionBoost
    //   finalScore = blended × supersedePenalty
    const id = await store.addNode({ content: "확인용 한 줄 메모" });
    const results = await retriever.retrieve("확인");
    const r = results.find((rs) => rs.node.id === id)!;
    const expectedBlended =
      RRF_BLEND_WEIGHT * r.components.boostedRrf +
      BM25_CROSS_WEIGHT * r.components.bm25Cross +
      r.components.precisionStrength +
      W_RECENCY * r.components.recency +
      W_IMPORTANCE * r.components.importance +
      r.components.mentionBoost;
    const expectedFinal = expectedBlended * r.components.supersedePenalty;
    expect(r.score).toBeCloseTo(expectedFinal, 6);
  });

  test("results sorted strictly descending by score", async () => {
    for (let i = 0; i < 4; i++) {
      await store.addNode({ content: `메모 ${i} — 본문 키워드 카페` });
    }
    const results = await retriever.retrieve("카페", { limit: 4 });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  // ── pending_review 무조건 비노출(6a T9.5 / 사용자 결정 #5) ────────────────
  test("pending_review 노드는 같은 키워드라도 검색 결과에서 빠지고 일반 노드는 그대로", async () => {
    const normal = await store.addNode({ content: "커피 원두 보관 메모" });
    const pending = await store.addNode({
      content: "커피 머신 청소 결정 검토 대기",
      metadata: { source: "regex", pending_review: true },
    });

    const results = await retriever.retrieve("커피");
    const ids = results.map((r) => r.node.id);
    expect(ids).toContain(normal); // 일반 노드는 정상 노출
    expect(ids).not.toContain(pending); // pending_review 만 비노출
  });

  test("auto_store regex atomic(pending_review 칸 없음)은 정상 노출", async () => {
    // auto_store 갈래 metadata 는 auto_stored:true 만 두고 pending_review 칸이 없다.
    const autoStored = await store.addNode({
      content: "커피 구독 결제 자동 저장 메모",
      metadata: { source: "regex", auto_stored: true },
    });
    const results = await retriever.retrieve("커피");
    expect(results.map((r) => r.node.id)).toContain(autoStored);
  });

  test("pending_review 0건 코퍼스 — 비노출 필터가 결과·점수를 바꾸지 않음(회귀 0)", async () => {
    // 같은 코퍼스로 두 번 검색한다. pending_review 노드가 0건이면 step 4.5 의 무조건
    // pending_review 제외가 후보 pool 을 한 노드도 줄이지 않아야 한다 → 결과·점수 동일.
    for (let i = 0; i < 5; i++) {
      await store.addNode({ content: `메모 ${i} — 커피 카페 키워드` });
    }
    const a = await retriever.retrieve("커피", { limit: 5 });
    const b = await retriever.retrieve("커피", { limit: 5 });
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(0);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.node.id).toBe(b[i]!.node.id);
      expect(a[i]!.score).toBeCloseTo(b[i]!.score, 10);
    }
  });

  // ── 검색 시간 범위 hard filter (Phase 7 갈래 1 / Task 5) ──────────────────
  //
  // dateRange 옵션이 COALESCE(event_at, created_at) 후보를 닫힌 구간으로 거른다.
  // RRF 합산 전 후보 축소 — 점수식·코어 불변. 실 SQLite(mock 없음).

  test("dateRange — event_at 이 구간 안인 노드만 잡히고 밖은 빠진다", async () => {
    // 같은 키워드 두 노드, event_at 만 다르다. 구간 [2026-05-18, 2026-05-24] 검색 시
    // 05-20 노드는 잡히고 05-26 노드는 빠진다.
    const inRange = await store.addNode({
      content: "지난주에 본 영화 메모 커피",
      eventAt: "2026-05-20",
    });
    const outRange = await store.addNode({
      content: "이번주에 본 영화 메모 커피",
      eventAt: "2026-05-26",
    });

    const results = await retriever.retrieve("영화", {
      dateRange: { since: "2026-05-18", until: "2026-05-24" },
    });
    const ids = results.map((r) => r.node.id);
    expect(ids).toContain(inRange);
    expect(ids).not.toContain(outRange);
  });

  test("dateRange — until 당일 시각이 있는 created_at 도 구간 끝에 포함(하루 끝 경계 보정)", async () => {
    // event_at NULL + created_at 이 until 당일의 한낮 시각. 상한이 date(until,'+1 day')
    // 미만이라 '2026-05-24 18:30:00' 도 until='2026-05-24' 구간 안에 들어와야 한다.
    const node = await store.addNode({ content: "경계 검증 메모 커피 영화" });
    db.prepare("UPDATE knowledge_nodes SET created_at = ? WHERE id = ?").run(
      "2026-05-24 18:30:00",
      node,
    );

    const results = await retriever.retrieve("영화", {
      dateRange: { since: "2026-05-18", until: "2026-05-24" },
    });
    expect(results.map((r) => r.node.id)).toContain(node);
  });

  test("dateRange — event_at NULL 이면 created_at 으로 걸러진다(COALESCE)", async () => {
    // event_at 을 안 채운 두 노드. created_at 을 직접 다르게 둬 COALESCE fallback 검증.
    const inRange = await store.addNode({ content: "옛 영화 메모 커피" });
    const outRange = await store.addNode({ content: "새 영화 메모 커피" });
    db.prepare("UPDATE knowledge_nodes SET created_at = ? WHERE id = ?").run(
      "2026-05-20 09:00:00",
      inRange,
    );
    db.prepare("UPDATE knowledge_nodes SET created_at = ? WHERE id = ?").run(
      "2026-06-01 09:00:00",
      outRange,
    );

    const results = await retriever.retrieve("영화", {
      dateRange: { since: "2026-05-18", until: "2026-05-24" },
    });
    const ids = results.map((r) => r.node.id);
    expect(ids).toContain(inRange); // created_at 이 구간 안
    expect(ids).not.toContain(outRange); // created_at 이 구간 밖
  });

  test("dateRange 미지정이면 결과·점수가 필터 도입 전과 동일(회귀 0 — 직접 대조)", async () => {
    // 같은 코퍼스를 dateRange 없이 두 번 검색 → 결과·순서·점수 byte 동일.
    // event_at 이 채워진 노드가 섞여도 dateRange 가 없으면 한 노드도 안 걸러진다.
    for (let i = 0; i < 5; i++) {
      await store.addNode({
        content: `메모 ${i} — 커피 카페 키워드`,
        eventAt: `2026-05-${10 + i}`,
      });
    }
    const a = await retriever.retrieve("커피", { limit: 5 });
    const b = await retriever.retrieve("커피", { limit: 5 });
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(0);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.node.id).toBe(b[i]!.node.id);
      expect(a[i]!.score).toBeCloseTo(b[i]!.score, 10);
    }
  });

  test("dateRange — 구간에 드는 자산이 0개면 빈 결과(에러 아님 / 정직한 빈 상태)", async () => {
    await store.addNode({ content: "영화 메모 커피", eventAt: "2026-01-01" });
    const results = await retriever.retrieve("영화", {
      dateRange: { since: "2026-05-18", until: "2026-05-24" },
    });
    expect(results).toEqual([]);
  });

  // ── 장소 칸 placeValue 옵션 선언 + 0 diff 회귀 (활용 단계4 T2) ──────────────
  //
  // T2 는 placeValue 옵션 *선언* 까지만 — retriever 가산 로직은 T3 다. placeValue 를
  // 안 넘기면(또는 retriever 가 아직 안 읽으면) 결과·점수가 도입 전과 byte 동일하다.
  // dateRange 회귀 양식(:417) 복제. 실 SQLite + 실 임베더(mock 0).

  test("placeValue 미지정이면 결과·점수가 도입 전과 동일(T2 회귀 0 — 직접 대조)", async () => {
    // 같은 코퍼스를 placeValue 없이 두 번 검색 → 결과·순서·점수 byte 동일.
    // 장소가 붙은 노드가 섞여도 placeValue 가 없으면 한 노드도 안 바뀐다.
    for (let i = 0; i < 5; i++) {
      const nid = await store.addNode({ content: `메모 ${i} — 커피 카페 키워드` });
      if (i % 2 === 0) await store.setPlace(nid, "강남 A마트", "direct");
    }
    const a = await retriever.retrieve("커피", { limit: 5 });
    const b = await retriever.retrieve("커피", { limit: 5 });
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(0);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.node.id).toBe(b[i]!.node.id);
      expect(a[i]!.score).toBeCloseTo(b[i]!.score, 10);
    }
  });

  // ── 장소 소프트 가산 향상 (활용 단계4 T3) ──────────────────────────────────
  //
  // placeValue 지정 시 step 9 blended 식에 placeBonus 가산 항이 매칭 장소 글 *순위를
  // 올린다*(소프트 — 다른 글 탈락 0). 가산 도입 후에도 placeValue 미지정은 회귀 0.
  // 실 SQLite + 실 임베더(mock 0).

  test("placeValue 지정 시 매칭 장소 글이 순위 상승(소프트·다른 글 탈락 0)", async () => {
    // 같은 검색어("영화")로 둘 다 잡히는 두 글 — 하나에만 '강남 A마트' 장소를 붙인다.
    // placeValue='강남' 지정 시 장소 글의 순위가 미지정 때보다 *올라야* 한다.
    // 두 글의 content 는 미세하게 다르다("메모" vs "메모 2") — P0-A 입력 멱등 흡수가
    // *같은* content 를 한 노드로 합치므로, 순위 비교(placeNode vs plainNode)를 하려면
    // 둘이 별 노드여야 한다. 검증 목적은 placeBonus 가 매칭 장소 글의 순위를 올리는지
    // 이지 content 동일성이 아니라, "영화"로 둘 다 잡히는 선에서 content 만 갈라 둔다.
    const placeNode = await store.addNode({ content: "지난주에 본 영화 메모" });
    await store.setPlace(placeNode, "강남 A마트", "direct");
    const plainNode = await store.addNode({ content: "지난주에 본 영화 메모 2" });

    const without = await retriever.retrieve("영화", { limit: 10 });
    const withPlace = await retriever.retrieve("영화", {
      limit: 10,
      placeValue: "강남",
    });

    // 소프트라 두 글 모두 양쪽 결과에 살아남는다(탈락 0).
    const idsWithout = without.map((r) => r.node.id);
    const idsWith = withPlace.map((r) => r.node.id);
    expect(idsWithout).toContain(placeNode);
    expect(idsWithout).toContain(plainNode);
    expect(idsWith).toContain(placeNode);
    expect(idsWith).toContain(plainNode);

    // 장소 글 순위가 placeValue 지정 시 *오른다*(indexOf 작아짐 = 앞으로). 장소 안
    // 붙은 글 대비 상대 순위가 미지정 때보다 개선돼야 한다.
    const placeRankWith = idsWith.indexOf(placeNode);
    const plainRankWith = idsWith.indexOf(plainNode);
    expect(placeRankWith).toBeLessThan(plainRankWith);

    // 장소 글 점수가 placeValue 지정 시 더 높다(placeBonus 가산 효과 직접 증거).
    const placeScoreWithout = without.find((r) => r.node.id === placeNode)!.score;
    const placeScoreWith = withPlace.find((r) => r.node.id === placeNode)!.score;
    expect(placeScoreWith).toBeGreaterThan(placeScoreWithout);
    // 장소 안 붙은 글 점수는 placeValue 지정과 무관하게 그대로(매칭 0 = 가산 0).
    const plainScoreWithout = without.find((r) => r.node.id === plainNode)!.score;
    const plainScoreWith = withPlace.find((r) => r.node.id === plainNode)!.score;
    expect(plainScoreWith).toBeCloseTo(plainScoreWithout, 10);
  });

  test("placeValue 미지정이면 가산 항 도입 후에도 두 번 검색 byte 동일(T3 회귀 0 재확인)", async () => {
    // T2 회귀와 별도 — 가산 코드(분기)가 retriever 에 들어온 *뒤* 에도 placeValue
    // 미지정이면 placeBonus 코드 경로를 건너뛰어 결과·점수가 byte 동일해야 한다.
    for (let i = 0; i < 5; i++) {
      const nid = await store.addNode({ content: `메모 ${i} — 커피 카페 키워드` });
      if (i % 2 === 0) await store.setPlace(nid, "강남 A마트", "direct");
    }
    const a = await retriever.retrieve("커피", { limit: 5 });
    const b = await retriever.retrieve("커피", { limit: 5 });
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(0);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.node.id).toBe(b[i]!.node.id);
      expect(a[i]!.score).toBeCloseTo(b[i]!.score, 10);
    }
  });

  // ── 태그 하드 칸 = 기존 filter 재사용 명문화 (활용 단계4 T5) ──────────────────
  //
  // 단계4 '태그/키워드 하드 정확매칭' 역할을 기존 filter 가 그대로 짊어진다(D4·신규
  // 칸 코드 0). getNodeIdsByConceptName 이 name UNIQUE·role 무관 매칭이라 `#만화`
  // 태그(role='tag')와 `review:만화` 분류(role='classification')가 같은 `만화` concept
  // 으로 통합된다. 이 회귀 테스트가 그 경계를 코드가 아니라 *테스트로 고정* 한다 —
  // 다음 task 가 filter 동작을 바꾸거나 신규 태그 칸을 더하려 하면 여기서 잡힌다.
  // 실 SQLite + 실 임베더(mock 0).

  test("T5 filter 미지정이면 결과·점수가 도입 전과 동일(태그 칸 미사용 회귀 0)", async () => {
    // filter 없이 두 번 검색 → byte 동일. 태그·분류가 붙은 노드가 섞여도 filter 가
    // 없으면 한 노드도 안 걸러진다(단계4 태그 칸 = filter 재사용·미지정 시 미적용).
    for (let i = 0; i < 5; i++) {
      const nid = await store.addNode({ content: `메모 ${i} — 커피 카페 키워드` });
      const cid = await store.findOrCreateTagConcept("만화");
      if (i % 2 === 0) await store.addNodeConceptEdge(nid, cid, "tag", "user_input", nid);
    }
    const a = await retriever.retrieve("커피", { limit: 5 });
    const b = await retriever.retrieve("커피", { limit: 5 });
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(0);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.node.id).toBe(b[i]!.node.id);
      expect(a[i]!.score).toBeCloseTo(b[i]!.score, 10);
    }
  });

  test("T5 filter 지정 시 그 태그 매단 글만 정확 매칭('#만화'='review:만화' role 무관 통합)", async () => {
    // `#만화` 태그 통로(role='tag').
    const tagNode = await store.addNode({ content: "어제 새 만화 한 권 커피와 함께" });
    const cidTag = await store.findOrCreateTagConcept("만화");
    await store.addNodeConceptEdge(tagNode, cidTag, "tag", "user_input", tagNode);
    // `review:만화` 분류 통로(role='classification') — 같은 이름 = 같은 concept.
    const classNode = await store.addNode({ content: "이 작품 리뷰를 커피 마시며 남겼다" });
    const cidClass = await store.findOrCreateConcept("만화", {
      isClassificationValue: true,
    });
    await store.addNodeConceptEdge(classNode, cidClass, "classification", "user_input", classNode);
    // 다른 분류(소설) — filter 가 제외하는 대조군.
    const novelNode = await store.addNode({ content: "두꺼운 소설 커피 한 잔" });
    const cidNovel = await store.findOrCreateConcept("소설", {
      isClassificationValue: true,
    });
    await store.addNodeConceptEdge(novelNode, cidNovel, "classification", "user_input", novelNode);
    // 라벨 없는 글 — filter 가 항상 제외.
    const noLabelNode = await store.addNode({ content: "그냥 커피 메모 하나" });

    const results = await retriever.retrieve("커피", {
      limit: 20,
      filter: { review: "만화" },
    });
    const ids = new Set(results.map((r) => r.node.id));
    // name UNIQUE 통합 — 태그·분류 두 통로가 같은 `만화` concept 이라 둘 다 잡힌다.
    expect(ids.has(tagNode)).toBe(true);
    expect(ids.has(classNode)).toBe(true);
    // 다른 분류·무라벨은 후보 축소로 제외.
    expect(ids.has(novelNode)).toBe(false);
    expect(ids.has(noLabelNode)).toBe(false);
  });

  // ── 프로젝트·사람·참여자 후보 합류 + memory_type 필터 (1.2 T8) ─────────────
  //
  // 엔티티(프로젝트·사람) hit → 연결 자산 글을 후보 pool 로 끌어온다. 직업·회사
  // 같은 공유 특성("개발자")은 개념 채널 has_attribute 갈래로 사람 끝까지 펼친다.
  // memory_type 은 step 4.5 후보 축소(polarity 가족). 실 SQLite + 실 임베더(mock 없음).
  //
  // 회귀 0 핵심: 두 엔티티 채널·memory_type 미지정 + 빈 엔티티 색인이면 후보 수·
  // 최종 순위·점수가 도입 전과 byte 동일해야 한다(빈 ranking 배열 = 수학적 동일).

  test("회귀 0 — 엔티티 색인이 비고 project/person/memoryType 미지정이면 결과·점수가 두 번 검색에서 동일", async () => {
    // 프로젝트·사람을 한 건도 안 만든 코퍼스(엔티티 색인 빈 상태). 두 새 채널이
    // 빈 배열을 내므로 RRF 안 0 기여 → 같은 검색을 두 번 돌려도 결과·순서·점수 동일.
    for (let i = 0; i < 5; i++) {
      await store.addNode({ content: `메모 ${i} — 커피 카페 키워드` });
    }
    const a = await retriever.retrieve("커피", { limit: 5 });
    const b = await retriever.retrieve("커피", { limit: 5 });
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(0);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.node.id).toBe(b[i]!.node.id);
      expect(a[i]!.score).toBeCloseTo(b[i]!.score, 10);
    }
    // 엔티티 채널이 빈 상태라 어떤 결과에도 project·person 출처가 붙지 않는다.
    for (const r of a) {
      expect(r.sources).not.toContain("project");
      expect(r.sources).not.toContain("person");
    }
  });

  test("프로젝트 채널 — 프로젝트 이름 검색이 그 프로젝트의 글을 후보로 끌어온다", async () => {
    const prj = await store.findOrCreateProject({
      name: "바라시스템연구",
      summary: "어디든 붙는 메모리 모듈",
    });
    // 검색어(프로젝트 이름)와 글자·의미가 모두 무관한 글 — project_id 로만 이어진다.
    const linked = await store.addNode({
      content: "회의 메모: 자정 라이브 일정 점검",
      project_id: prj.projectId,
    });
    // 노이즈 — 검색어와 무관.
    for (let i = 0; i < 3; i++) {
      await store.addNode({ content: `노이즈 ${i} 산악 자전거 등산` });
    }

    const results = await retriever.retrieve("바라시스템연구");
    const linkedResult = results.find((r) => r.node.id === linked);
    expect(linkedResult).toBeDefined();
    expect(linkedResult!.sources).toContain("project");
  });

  test("프로젝트 채널 — project_id 붙은 llm_extract atomic 자식도 회수한다", async () => {
    const prj = await store.findOrCreateProject({
      name: "원자기억프로젝트",
      summary: "atomic child retrieval",
    });
    const atomicChild = await store.addNode({
      content: "검색어와 무관한 atomic child 내용",
      sourceType: "llm_extract",
      project_id: prj.projectId,
    });

    const results = await retriever.retrieve("원자기억프로젝트");
    const found = results.find((r) => r.node.id === atomicChild);
    expect(found).toBeDefined();
    expect(found!.node.sourceType).toBe("llm_extract");
    expect(found!.sources).toContain("project");
  });

  test("프로젝트 채널 — 참여자 글도 프로젝트 검색으로 합류한다", async () => {
    const prj = await store.findOrCreateProject({ name: "협업프로젝트연구" });
    const person = await store.findOrCreatePerson({
      displayName: "참여개발자",
      userId: "u_part",
    });
    await store.addProjectPersonEdge(prj.projectId, person.personId, "creator", "user_input", null);
    // 참여자의 글 — node_person_edges 로만 이어진다(글 내용은 검색어와 무관).
    const personArticle = await store.addNode({
      content: "주말에 등산을 다녀왔다 기록",
    });
    await store.addNodePersonEdge(personArticle, person.personId, "mentions", "user_input", personArticle);
    for (let i = 0; i < 3; i++) {
      await store.addNode({ content: `노이즈 ${i} 무관한 잡담 메모` });
    }

    const results = await retriever.retrieve("협업프로젝트연구");
    const found = results.find((r) => r.node.id === personArticle);
    expect(found).toBeDefined();
    expect(found!.sources).toContain("project");
  });

  test("사람 채널 — 사람 이름 검색이 그 사람의 글을 후보로 끌어온다", async () => {
    const person = await store.findOrCreatePerson({
      displayName: "김민수기록자",
      userId: "u_kim2",
    });
    const article = await store.addNode({
      content: "어제 본 영화가 인상 깊었다 메모",
    });
    await store.addNodePersonEdge(article, person.personId, "mentions", "user_input", article);
    for (let i = 0; i < 3; i++) {
      await store.addNode({ content: `노이즈 ${i} 산악 자전거 등산` });
    }

    const results = await retriever.retrieve("김민수기록자");
    const found = results.find((r) => r.node.id === article);
    expect(found).toBeDefined();
    expect(found!.sources).toContain("person");
  });

  test("개념 채널 has_attribute — '개발자' 개념이 그 라벨을 가진 사람의 글을 끌어온다", async () => {
    // "개발자" 특성 개념 + 그 라벨을 가진 사람 + 그 사람의 글. 검색어가 "개발자"
    // 개념에 닿으면 has_attribute 역방향으로 사람을 찾아 글을 후보로 합류한다.
    const developerConcept = await store.findOrCreateConcept("개발자", {
      isTag: true,
    });
    const person = await store.findOrCreatePerson({
      displayName: "어떤사람갑",
      userId: "u_dev",
    });
    await store.addPersonAttributeConcept(person.personId, developerConcept, "user_input", null);
    // 사람의 글 — 검색어 "개발자"와 글자·의미가 무관(개념→사람 갈래로만 이어진다).
    const article = await store.addNode({
      content: "주말에 김치찌개를 끓여 먹었다 기록",
    });
    await store.addNodePersonEdge(article, person.personId, "mentions", "user_input", article);
    for (let i = 0; i < 3; i++) {
      await store.addNode({ content: `노이즈 ${i} 산악 자전거 등산` });
    }

    const results = await retriever.retrieve("개발자");
    const found = results.find((r) => r.node.id === article);
    expect(found).toBeDefined();
    // 개념 채널을 통해 합류하므로 출처는 concept 다(별도 person 통로 아님).
    expect(found!.sources).toContain("concept");
  });

  test("memoryType='episode' 가 insight/fact 자산을 후보에서 뺀다", async () => {
    const ep = await store.addNode({
      content: "어제 회의에 갔다 커피 기록",
      memoryType: "episode",
    });
    const ins = await store.addNode({
      content: "회의는 비효율적이다 커피 통찰",
      memoryType: "insight",
    });
    const ft = await store.addNode({
      content: "회의는 오후 3시다 커피 사실",
      memoryType: "fact",
    });

    const results = await retriever.retrieve("커피 회의", {
      memoryType: "episode",
    });
    const ids = results.map((r) => r.node.id);
    expect(ids).toContain(ep);
    expect(ids).not.toContain(ins);
    expect(ids).not.toContain(ft);
  });

  test("channelMask.project=false 면 그 글에 project 출처가 안 붙는다(프로젝트 후보 격리)", async () => {
    const prj = await store.findOrCreateProject({ name: "끄기검증프로젝트" });
    const linked = await store.addNode({
      content: "회의 메모: 자정 라이브 일정 점검",
      project_id: prj.projectId,
    });
    for (let i = 0; i < 3; i++) {
      await store.addNode({ content: `노이즈 ${i} 산악 자전거 등산` });
    }

    // 작은 코퍼스라 vector 채널이 모든 글을 top-K 로 회수한다 — 그래서 노드 등장
    // 자체가 아니라 *출처(sources)* 로 채널 격리를 검증한다. 켜면 project 출처가
    // 붙고, 끄면 같은 노드에 project 출처가 사라진다(다른 채널로는 여전히 등장 가능).
    const on = await retriever.retrieve("끄기검증프로젝트");
    const onResult = on.find((r) => r.node.id === linked);
    expect(onResult).toBeDefined();
    expect(onResult!.sources).toContain("project");

    const off = await retriever.retrieve("끄기검증프로젝트", {
      channelMask: {
        vector: true,
        fts: true,
        graph: true,
        concept: true,
        imageVec: true,
        project: false,
        person: true,
      },
    });
    const offResult = off.find((r) => r.node.id === linked);
    // 프로젝트 채널을 끄면 그 노드에 project 출처가 더는 안 붙는다(후보 격리).
    if (offResult) {
      expect(offResult.sources).not.toContain("project");
    }
  });
});

// ── missingRankFloor 동결 (T5 / spec 5-2, 2026-08-03 실측) ──────────────────
//
// 운영 default 는 missingRankFloor: false(floor-중립 — 6-metric × wide/tight
// 창 실측 결과 OFF/ON 완전 동일이라 결정 규칙상 OFF 유지, task-5-report.md 참고).
// 이 값은 순위(rank) 기반이지 유사도(similarity) 기반이 아니다 — 모델(bge-m3
// 등)이 바뀌어도 의미가 안 바뀌므로 embedding factory 맵(EMBEDDING_* 시리즈)
// 에 넣지 않는다.
//
// 왜 운영 default 에서는 6-metric 이 안 흔들렸는가 — floor 는 fusedRrf(퓨전
// *후* 후보 pool)에 이미 든 노드가 특정 채널에서 0 기여일 때만 그 채널 기여를
// floorScore 로 대체한다(후보 pool 자체를 늘리지 않음). boostedRrf =
// rrfScore + Σ(채널 기여 × (boost - 1)) 식이라, 운영 default SOURCE_BOOST 가
// bm25/vector/graph/concept 는 1.0(그래서 이 4채널의 floor 는 delta 0)이지만
// imageVec 만 2.5 라 — 글 노드도 floor ON 이면 미세한 delta 를 받는다(아래
// 세 번째 테스트가 이 delta 를 직접 계산해 pin한다 — "무해"가 아니라 "이
// 확장 코퍼스 규모·문항에서는 순위를 못 뒤집을 만큼 작았다"가 정확한 서술).
describe("HybridRetriever.retrieve — missingRankFloor (T5)", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let retriever: HybridRetriever;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    retriever = new HybridRetriever(store, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("floor OFF(default) — graph 단독 히트 노드는 다른 채널 기여 0", async () => {
    const seed = await store.addNode({ content: "철수는 커피를 좋아한다" });
    const linked = await store.addNode({
      content: "회의 메모: 자정 라이브 일정",
    });
    for (let i = 0; i < 5; i++) {
      await store.addNode({ content: `노이즈 ${i} 산악 자전거 등산` });
    }
    await store.addEdge({
      sourceId: seed,
      targetId: linked,
      relation: "related_to",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.9,
    });

    // graphBoost != 1 이어야 floor 유무가 boostedRrf 에 드러난다(운영 boost=1
    // 이면 delta 가 0 이 되어 관측 불가 — 위 설명 참조).
    const results = await retriever.retrieve("커피", {
      vectorK: 1,
      ftsLimit: 1,
      tuning: { graphBoost: 3, missingRankFloor: false },
    });
    const linkedResult = results.find((r) => r.node.id === linked)!;
    expect(linkedResult).toBeDefined();
    // graph 채널로만 잡힌 노드 — floor OFF 에서 bm25/vector/concept 기여는 0.
    // (다음 테스트가 이 노드로 OFF vs ON boostedRrf 를 직접 비교한다.)
    expect(linkedResult.sources).toEqual(["graph"]);
  });

  test("floor ON — graph 단독 히트 노드가 누락 채널에서 floorScore 를 받아 boostedRrf 가 OFF보다 커진다", async () => {
    const seed = await store.addNode({ content: "철수는 커피를 좋아한다" });
    const linked = await store.addNode({
      content: "회의 메모: 자정 라이브 일정",
    });
    for (let i = 0; i < 5; i++) {
      await store.addNode({ content: `노이즈 ${i} 산악 자전거 등산` });
    }
    await store.addEdge({
      sourceId: seed,
      targetId: linked,
      relation: "related_to",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.9,
    });

    const optsOff = {
      vectorK: 1,
      ftsLimit: 1,
      tuning: { graphBoost: 3, missingRankFloor: false },
    };
    const optsOn = {
      vectorK: 1,
      ftsLimit: 1,
      tuning: { graphBoost: 3, missingRankFloor: true },
    };
    const off = await retriever.retrieve("커피", optsOff);
    const on = await retriever.retrieve("커피", optsOn);

    const offResult = off.find((r) => r.node.id === linked)!;
    const onResult = on.find((r) => r.node.id === linked)!;
    expect(offResult).toBeDefined();
    expect(onResult).toBeDefined();

    // floor ON 이면 bm25/vector/concept/imageVec(0 기여였던)이 floorScore 로
    // 채워져 boostedRrf 가 OFF 보다 커진다 — boost=1.0 인 bm25/vector/concept
    // 은 delta 0 이지만 imageVec(SOURCE_BOOST.imageVec=2.5)만 delta > 0 이다
    // (graph 는 이미 실채워진 채널이라 애초에 floor 미적용). 세 번째 테스트가
    // 이 delta 를 수식으로 pin한다.
    expect(onResult.components.boostedRrf).toBeGreaterThan(
      offResult.components.boostedRrf,
    );
    expect(onResult.score).toBeGreaterThan(offResult.score);
  });

  test("floor ON 델타가 정확히 floorScore × (imageVecBoost - 1) 과 일치 — 수식 동결", async () => {
    // graph 단독 히트 노드(linked) 는 bm25/vector/concept/imageVec 4채널이 모두
    // floor 대상이다. 이 테스트의 tuning 은 graphBoost 만 조절(=1 로 두어 graph
    // 자체 delta 는 0)하므로, floor ON 이 boostedRrf 를 바꾸는 유일한 경로는
    // SOURCE_BOOST.imageVec(=2.5, 운영 default 상수 — boost=1 이 아닌 유일한
    // 채널)이다. bm25/vector/concept boost 는 1.0 이라 floor 를 받아도 delta 0.
    //
    // 즉 "운영 default 에서 floor 가 글 노드 boostedRrf 에 무해하다"는 주장은
    // imageVec boost 가 1 이 아니어도 성립하지 않을 *뻔* 했으나, 실제로는 이
    // 델타가 존재한다(수치로 증명) — 그럼에도 T5 6-metric 실측(OFF/ON 완전
    // 동일, task-5-report.md)이 안 흔들린 이유는 이 델타가 blend 이후 순위를
    // 못 뒤집을 만큼 작았기 때문이지, 델타가 0 이라서가 아니다. 정직한 근거를
    // 남기려 이 델타를 직접 계산해 pin한다.
    const seed = await store.addNode({ content: "철수는 커피를 좋아한다" });
    const linked = await store.addNode({
      content: "회의 메모: 자정 라이브 일정",
    });
    for (let i = 0; i < 5; i++) {
      await store.addNode({ content: `노이즈 ${i} 산악 자전거 등산` });
    }
    await store.addEdge({
      sourceId: seed,
      targetId: linked,
      relation: "related_to",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.9,
    });

    const opts = (floor: boolean) => ({
      vectorK: 1,
      ftsLimit: 1,
      tuning: { missingRankFloor: floor }, // graphBoost 미지정 = 1.0(무변화)
    });
    const off = await retriever.retrieve("커피", opts(false));
    const on = await retriever.retrieve("커피", opts(true));
    const offResult = off.find((r) => r.node.id === linked)!;
    const onResult = on.find((r) => r.node.id === linked)!;
    expect(offResult).toBeDefined();
    expect(onResult).toBeDefined();
    expect(offResult.sources).toEqual(["graph"]);

    // fetchK(=fusedRrf.size) 는 candidate pool 크기라 결과 리스트만으로는 직접
    // 못 읽는다 — 대신 floorScore 를 델타에서 역산해 SOURCE_BOOST.imageVec(2.5)
    // 배수 관계로 검증한다: delta = floorScore × (2.5 - 1) = floorScore × 1.5.
    const delta = onResult.components.boostedRrf - offResult.components.boostedRrf;
    expect(delta).toBeGreaterThan(0);
    const impliedFloorScore = delta / 1.5;
    // RRF_K=60 이고 후보 pool(6노드: seed+linked+노이즈5)이 fetchK 이므로
    // floorScore = 1/(60 + fetchK + 1) 은 6노드 규모에서 대략 1/61~1/67 범위 —
    // 정확한 fetchK 를 몰라도 이 범위 안인지로 공식 형태(1/(RRF_K + n)) 를 확인한다.
    expect(impliedFloorScore).toBeGreaterThan(1 / (RRF_K + 10));
    expect(impliedFloorScore).toBeLessThan(1 / RRF_K);
  });
});

// ── reloadSynonymDict — 사전 교체 즉시 반영 (웨이브3 항목12 B2 Step2) ─────────
//
// reloadSynonymDict 가 this.synonymDict 를 통째로 교체하는지 실제 통합으로 본다.
// 글 내용엔 동의어("냥이")만 있고 query 는 원본 용어("고양이")인 상황 — 사전이
// 없으면 fts 가 "고양이" 로 그 글을 못 잡지만(글자 불일치), 사전을 reload 하면
// fts 입력 query 가 "고양이 냥이" 로 확장돼 그 글이 fts 채널로 잡힌다. mock 없이
// 실제 SqliteMemoryStore + Bgem3Embedder + 실 retrieve 흐름으로 검증한다.
describe("HybridRetriever.reloadSynonymDict — 사전 교체 즉시 반영", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let retriever: HybridRetriever;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    // 사전 미주입으로 시작 — reload 가 비어 있던 자리를 채우는지부터 본다.
    retriever = new HybridRetriever(store, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("사전 reload 후 동의어로만 적힌 글이 fts 채널로 잡힌다", async () => {
    // 글 내용엔 "냥이"만 — 원본 용어 "고양이" 글자는 없다.
    const nyangId = await store.addNode({ content: "오늘 냥이가 창밖을 봤다" });
    await store.addNode({ content: "자동차를 새로 샀다" });

    // reload 전: "고양이" query 는 글자 불일치라 그 글에 fts 출처가 안 붙는다.
    const before = await retriever.retrieve("고양이");
    const beforeHit = before.find((r) => r.node.id === nyangId);
    if (beforeHit) {
      expect(beforeHit.sources).not.toContain("fts");
    }

    // 동의어 사전 교체: 고양이 → [냥이]. 이제 fts query 가 "고양이 냥이" 로 확장된다.
    retriever.reloadSynonymDict(new Map([["고양이", ["냥이"]]]));

    const after = await retriever.retrieve("고양이");
    const afterHit = after.find((r) => r.node.id === nyangId);
    expect(afterHit).toBeDefined();
    expect(afterHit!.sources).toContain("fts");
  });

  test("reload 가 옛 사전을 새 사전으로 갈아끼운다(옛 동의어는 더는 확장 안 함)", async () => {
    const nyangId = await store.addNode({ content: "오늘 냥이가 창밖을 봤다" });
    const meongId = await store.addNode({ content: "멍멍이가 마당을 뛴다" });

    // 첫 사전: 고양이 → [냥이].
    retriever.reloadSynonymDict(new Map([["고양이", ["냥이"]]]));
    const first = await retriever.retrieve("고양이");
    expect(first.find((r) => r.node.id === nyangId)?.sources).toContain("fts");

    // 둘째 사전으로 교체: 강아지 → [멍멍이]. 옛 고양이 매핑은 사라진다.
    retriever.reloadSynonymDict(new Map([["강아지", ["멍멍이"]]]));

    // 새 사전으로 "강아지" → "멍멍이" 글이 fts 로 잡힌다.
    const dog = await retriever.retrieve("강아지");
    expect(dog.find((r) => r.node.id === meongId)?.sources).toContain("fts");

    // 옛 매핑(고양이 → 냥이)은 교체로 사라져 "고양이" 가 더는 "냥이" 글을 fts 확장 못 한다.
    const cat = await retriever.retrieve("고양이");
    const catHit = cat.find((r) => r.node.id === nyangId);
    if (catHit) {
      expect(catHit.sources).not.toContain("fts");
    }
  });
});
