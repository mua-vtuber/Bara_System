/**
 * memory/eval/polarity-eval.test.ts — polarity 한정 query 필터 측정
 * (공통 인프라 1.1c T3 / spec 5.5 / D7).
 *
 * T1 이 세운 측정 토대(EQ6 polarity 분별 query + design_warm·design_cozy positive /
 * design_game_dislike negative / design_plain_neutral neutral 라벨 노드) 위에서,
 * T3 가 retriever 에 실배선한 RetrieveOptions.polarity 후보 축소를 측정한다.
 *
 * 옛 enriched-harness.test.ts 의 polarity 게이트는 T1 시점의 *후처리 시뮬레이션*
 * (retrieve 결과를 코퍼스 라벨로 거름)이었다. 이 파일은 같은 분별을 *실제 검색
 * 경로*(retriever 가 RRF 합산 전 후보를 polarity 로 줄임)로 다시 증명한다.
 *
 * 실 bun:sqlite + 실 bge-m3 + :memory: DB. mock 없음. 운영 DB 불변경.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../retriever.ts";
import {
  buildPolarityMap,
  CUE_POLARITY_RETRIEVAL_LIMIT,
  loadEnrichedCorpus,
  runCuePolarityHarness,
} from "./harness.ts";
import { ENRICHED_QUERIES } from "../../../test-fixtures/sandbox/eval-enriched-queries.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

describe("polarity 한정 query 필터 — 1.1c T3 실배선 측정", () => {
  test("폴라리티-off vs 폴라리티-on — EQ6 recall 수치 보고(실 retriever 배선)", async () => {
    const snap = await runCuePolarityHarness(embedder);
    const eq6 = (name: string) =>
      snap.variants
        .find((v) => v.variant === name)!
        .perQuery.find((q) => q.id === "EQ6")!;
    const off = eq6("polarity-off");
    const on = eq6("polarity-on");
    // plan Evidence 칸 기록용 — polarity-off 는 필터 미전달(전 후보) / polarity-on 은
    // RetrieveOptions.polarity 전달(RRF 합산 전 positive 후보 축소).
    console.log(
      `[1.1c T3 polarity] EQ6 polarity-off recall=${off.recall.toFixed(4)} ` +
        `ndcg=${off.ndcg.toFixed(4)} / polarity-on recall=${on.recall.toFixed(4)} ` +
        `ndcg=${on.ndcg.toFixed(4)}`,
    );
    // positive 가족(design_warm·design_cozy)은 둘 다 positive 라벨이라 polarity-on
    // 에서도 회수된다 — recall > 0. 정답이 전부 positive 이므로 필터가 recall 을
    // 깎지 않는다(정답 보존 + 비-positive 제외 = 분별).
    expect(on.recall).toBeGreaterThan(0);
    expect(on.recall).toBeLessThanOrEqual(off.recall + 1e-9);
  });

  test("polarity-on 이 RRF 합산 전 후보를 positive 만 남긴다(실 retriever)", async () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    const keyToNodeId = await loadEnrichedCorpus(store);
    const polarityById = buildPolarityMap(keyToNodeId);
    const retriever = new HybridRetriever(store, embedder);
    const eq6 = ENRICHED_QUERIES.find((q) => q.id === "EQ6")!;

    // 필터 미전달(body polarity 부재) = 전 후보 통과 — positive 아닌 노드도 섞인다.
    const before = await retriever.retrieve(eq6.query, {
      limit: CUE_POLARITY_RETRIEVAL_LIMIT,
    });
    const beforeIds = before.map((r) => r.node.id);
    const nonPositiveBefore = beforeIds.filter(
      (id) => polarityById.get(id) !== "positive",
    );
    // 필터 전 창에 positive 아닌 노드(negative/neutral/NULL)가 섞여 있어야 분별이
    // vacuous 가 아니다 — 코퍼스가 polarity 효과를 실제로 잴 수 있음을 보장.
    expect(nonPositiveBefore.length).toBeGreaterThan(0);

    // 필터 전달(RetrieveOptions.polarity='positive') = retriever 가 RRF 합산 전
    // 후보를 positive 로 줄인다. 결과는 전부 positive 라벨 노드여야 한다.
    const after = await retriever.retrieve(eq6.query, {
      limit: CUE_POLARITY_RETRIEVAL_LIMIT,
      polarity: "positive",
    });
    const afterIds = after.map((r) => r.node.id);
    expect(afterIds.length).toBeGreaterThan(0); // positive 정답이 있으니 빈 결과 아님
    expect(afterIds.length).toBeLessThan(beforeIds.length); // 비-positive 제거됨
    for (const id of afterIds) {
      // 실 retriever 가 노출한 도메인 polarity 칸(rowToNode 매핑 / T3)이 positive.
      expect(after.find((r) => r.node.id === id)!.node.polarity).toBe("positive");
      // 코퍼스 라벨 교차 확인 — 측정 토대와 도메인 노출이 정합.
      expect(polarityById.get(id)).toBe("positive");
    }
    db.close();
  });

  test("negative·neutral query 는 그 라벨 노드만 회수(positive 제외)", async () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    await loadEnrichedCorpus(store);
    const retriever = new HybridRetriever(store, embedder);

    // 디자인 주제로 넓게 검색하되 polarity=negative 로 거른다 — negative 라벨
    // (design_game_dislike)만 남고 positive·neutral·NULL 은 제외된다.
    const neg = await retriever.retrieve("디자인 취향", {
      limit: 20,
      polarity: "negative",
    });
    expect(neg.length).toBeGreaterThan(0);
    for (const r of neg) expect(r.node.polarity).toBe("negative");

    const neu = await retriever.retrieve("디자인 취향", {
      limit: 20,
      polarity: "neutral",
    });
    expect(neu.length).toBeGreaterThan(0);
    for (const r of neu) expect(r.node.polarity).toBe("neutral");
    db.close();
  });

  test("body 부재(미적용) ≠ 노드 NULL(제외) — 두 경우 명확 구분", async () => {
    // plan 회귀 함정 4 — body 에 polarity 칸이 *없으면* 필터 통째 skip(전 후보,
    // NULL 노드 포함) / 지정 시 NULL 노드 제외. 같은 query 로 두 경우를 대조한다.
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);

    // NULL polarity 노드 + positive 노드를 한 주제로 적재(라벨 유무만 다름).
    await store.addNode({ content: "산뜻한 파스텔 배색 디자인을 골랐다" }); // polarity NULL
    await store.addNode({
      content: "밝고 환한 톤의 디자인을 무척 좋아한다",
      polarity: "positive",
    });
    const retriever = new HybridRetriever(store, embedder);

    // (1) body polarity 부재 = 미적용 → NULL 노드도 후보로 통과(전 후보).
    const noFilter = await retriever.retrieve("디자인 배색", { limit: 20 });
    const hasNull = noFilter.some((r) => r.node.polarity === null);
    expect(hasNull).toBe(true); // 미지정이면 NULL 노드가 살아 있다(필터 skip).

    // (2) body polarity='positive' = 적용 → NULL 노드 제외(라벨된 자산만).
    const filtered = await retriever.retrieve("디자인 배색", {
      limit: 20,
      polarity: "positive",
    });
    const filteredHasNull = filtered.some((r) => r.node.polarity === null);
    expect(filteredHasNull).toBe(false); // 지정이면 NULL 노드가 제외된다.
    for (const r of filtered) expect(r.node.polarity).toBe("positive");
    db.close();
  });

  test("graceful — 일치 polarity 라벨 0개면 빈 결과(에러 아님)", async () => {
    // 운영 DB 현실 모사: 라벨 없는(NULL) 노드만 있는 상태에서 polarity 필터를
    // 지정하면 후보가 전부 제외돼 빈 결과가 된다. 이건 정직한 빈 상태지 에러가
    // 아니다(자동 채움 Phase 6 전까지의 (a) 결정 귀결). 빈 결과를 fallback 으로
    // 채우지 않는다(Mock Policy / 회귀 함정 4).
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    await store.addNode({ content: "라벨 없는 디자인 메모 하나" }); // polarity NULL
    await store.addNode({ content: "또 다른 라벨 없는 디자인 메모" }); // polarity NULL
    const retriever = new HybridRetriever(store, embedder);

    const result = await retriever.retrieve("디자인 메모", {
      limit: 20,
      polarity: "positive",
    });
    expect(result).toEqual([]); // 빈 결과 — 에러 throw 안 함.
    db.close();
  });
});

describe("filterNodeIdsByPolarity — 후보 축소 단위(SearchRepository)", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  beforeAll(() => {});

  test("polarity 일치 노드만 Set 으로 반환 / NULL 제외", async () => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    const pos = await store.addNode({ content: "긍정 노드", polarity: "positive" });
    const neg = await store.addNode({ content: "부정 노드", polarity: "negative" });
    const nul = await store.addNode({ content: "라벨 없는 노드" }); // NULL

    const allowed = store.filterNodeIdsByPolarity([pos, neg, nul], "positive");
    expect(allowed.has(pos)).toBe(true);
    expect(allowed.has(neg)).toBe(false); // 다른 polarity 제외
    expect(allowed.has(nul)).toBe(false); // NULL 제외(라벨된 자산만)
    expect(allowed.size).toBe(1);
    db.close();
  });

  test("후보 0개 = 빈 Set(에러 아님)", async () => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    const allowed = store.filterNodeIdsByPolarity([], "positive");
    expect(allowed.size).toBe(0);
    db.close();
  });
});
