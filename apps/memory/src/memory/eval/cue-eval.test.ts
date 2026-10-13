/**
 * cue-eval.test.ts — 정규식 cue 실제 retriever 배선 measured-win gate (공통 인프라 1.1c T2).
 *
 * T1 의 cue-on 은 *시뮬레이션* 이었다(harness 가 tuning.graphBoost 로 cue 효과를
 * 직접 재현). T2 는 정규식 검출(detectCues)을 실제 retriever 에 배선한다 — 이 테스트는
 * 그 *실제 배선* 이 EQ5(관계 cue + graph-hop 정답)를 끌어올리는지 측정한다.
 *
 * 측정 게이트(1.1b DCL-5 귀결 / measured-win gate):
 *  - EQ5 query("그 테마로 왜 바꿨더라")는 관계 cue("왜"·"바꿨")를 담아 실제 retriever
 *    가 cue graph boost(RELATION_CUE_GRAPH_BOOST)를 자동 적용한다.
 *  - 2026-07-10 bge-m3 재측정에서 measured-win 부재(boost 1.0~2.0 전 구간 EQ5
 *    recall 0 — 정답 theme_reason 이 vector 채널로 직접 회수돼 graph-hop 전제 붕괴)
 *    로 boost 는 중립 1.0 으로 복귀했다(search-tuning.ts 이력 주석). 이 파일의
 *    gate 단언은 strict-lift 대신 *비회귀*(cue 배선이 점수를 안 깎음)로 지킨다.
 *
 * 실제 bge-m3 + bun:sqlite + :memory: DB — mock 0(운영 data/bara.sqlite 불변경).
 * cue 검출은 결정적 연산(LLM 호출 0 / 0.01초) — 정규식 test 한 번.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../retriever.ts";
import { loadEnrichedCorpus } from "./harness.ts";
import { mapKeyGroupsToNodeIds, toEnrichedAnswerGroups } from "./answer-map.ts";
import { ENRICHED_QUERIES } from "../../../test-fixtures/sandbox/eval-enriched-queries.ts";
import { computeNdcg, computeRecallByGroup } from "./metrics.ts";
import { detectCues } from "../search-cues.ts";
import { RELATION_CUE_GRAPH_BOOST } from "../search-tuning.ts";

/** cue 측정용 좁은 retrieval 창(T1 CUE_POLARITY_RETRIEVAL_LIMIT 정합). */
const CUE_LIMIT = 4;

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

describe("정규식 cue 실제 배선 — query 토큰 불변(회귀 함정 2)", () => {
  test("detectCues 는 EQ5 query 의 관계 cue 를 검출하고 query 를 안 건드린다", () => {
    const eq5 = ENRICHED_QUERIES.find((q) => q.id === "EQ5")!;
    const before = eq5.query;
    const cue = detectCues(eq5.query);
    expect(cue.relation).toBe(true);
    expect(cue.graphBoost).toBe(RELATION_CUE_GRAPH_BOOST);
    // query 문자열은 검출 후에도 원본 그대로 — cue 는 토큰을 추가·삭제하지 않는다.
    expect(eq5.query).toBe(before);
  });
});

describe("cue measured-win gate — 실제 retriever 배선(EQ5 graph-hop)", () => {
  test("cue 어휘 query 가 graph 채널 가중치를 자동 적용(components.cueGraphBoost)", async () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    await loadEnrichedCorpus(store);
    const retriever = new HybridRetriever(store, embedder);

    // 관계 cue 가 든 EQ5 query → retriever 가 detectCues 로 graph boost 자동 적용.
    const eq5 = ENRICHED_QUERIES.find((q) => q.id === "EQ5")!;
    const withCue = await retriever.retrieve(eq5.query, { limit: CUE_LIMIT });
    expect(withCue.length).toBeGreaterThan(0);
    // 결과 components 에 cue 가중치가 기록된다(관계 cue 적용 = RELATION_CUE_GRAPH_BOOST
    // — 2026-07-10 중립화로 값은 1.0 이지만 검출·기록 인프라는 원설계대로 유지).
    expect(withCue[0]!.components.cueGraphBoost).toBe(RELATION_CUE_GRAPH_BOOST);

    // cue 어휘가 없는 query 는 graph 채널 중립(1.0).
    const noCue = await retriever.retrieve("주술회전 최강자의 필살기 이름", {
      limit: CUE_LIMIT,
    });
    expect(noCue[0]!.components.cueGraphBoost).toBe(1.0);
    db.close();
  });

  test("cue-on 이 EQ5 에서 cue-off 대비 비회귀(recall·nDCG 안 깎음)", async () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    const keyToNodeId = await loadEnrichedCorpus(store);
    const retriever = new HybridRetriever(store, embedder);

    const eq5 = ENRICHED_QUERIES.find((q) => q.id === "EQ5")!;
    const groups = mapKeyGroupsToNodeIds(toEnrichedAnswerGroups(eq5), keyToNodeId);

    // cue-on = 실제 query(관계 cue 포함) → retriever 가 cue graph boost 자동 적용.
    // precisionStrengthWeight=0 으로 T4(강도-반영 정밀 재채점)를 끈다 — 좁은 창에서
    // T4 가 vector-유사 노드를 끌어올려 graph-hop 정답을 밀어내면 cue 순효과가 가려진다.
    // graphBoost 는 미지정이라 정규식 cue 자동 검출은 그대로 가동(T4 측정은 별 파일).
    const onResults = await retriever.retrieve(eq5.query, {
      limit: CUE_LIMIT,
      tuning: { precisionStrengthWeight: 0 },
    });
    const onRanked = onResults.map((r) => r.node.id);
    const onRecall = computeRecallByGroup(onRanked, groups);
    const onNdcg = computeNdcg(onRanked, groups);

    // cue-off = 같은 query 이되 graph 채널을 중립(1.0)으로 강제 — sweep 오버라이드로
    // cue 적용을 끈다(tuning.graphBoost 명시 시 cue 미적용 / retriever 우선순위 규칙).
    // precisionStrengthWeight=0 으로 T4 도 함께 끈다(cue 분별 격리 — cue-on 과 동일 조건).
    const offResults = await retriever.retrieve(eq5.query, {
      limit: CUE_LIMIT,
      tuning: { graphBoost: 1.0, precisionStrengthWeight: 0 },
    });
    const offRanked = offResults.map((r) => r.node.id);
    const offRecall = computeRecallByGroup(offRanked, groups);
    const offNdcg = computeNdcg(offRanked, groups);

    console.log(
      `[1.1c cue 실배선] EQ5 cue-off recall=${offRecall.toFixed(4)} ndcg=${offNdcg.toFixed(4)} ` +
        `/ cue-on recall=${onRecall.toFixed(4)} ndcg=${onNdcg.toFixed(4)}`,
    );

    // measured-win 부재(2026-07-10 bge-m3 재측정): boost 1.0~2.0 전 구간 EQ5 recall
    // 0 — 정답 theme_reason 이 vector 채널로 직접 회수돼 graph-hop 전제가 붕괴했다.
    // strict-lift 단언 대신 비회귀 단언 — cue 배선이 켜져 있어도 점수를 안 깎는다.
    expect(onRecall).toBeGreaterThanOrEqual(offRecall - 1e-9);
    expect(onNdcg).toBeGreaterThanOrEqual(offNdcg - 1e-9);
    db.close();
  });

  test("cue-off(graph 중립) 는 EQ5 graph-hop 정답을 좁은 창에서 못 잡는다(틈 존재)", async () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    const keyToNodeId = await loadEnrichedCorpus(store);
    const retriever = new HybridRetriever(store, embedder);

    const eq5 = ENRICHED_QUERIES.find((q) => q.id === "EQ5")!;
    const groups = mapKeyGroupsToNodeIds(toEnrichedAnswerGroups(eq5), keyToNodeId);

    // graph 중립 강제 → theme_reason 이 좁은 창 밖 → recall < 1.0(측정 틈).
    // precisionStrengthWeight=0 으로 T4 도 끈다(cue 분별 격리 — 위 cue-on/off 동일 조건).
    const offResults = await retriever.retrieve(eq5.query, {
      limit: CUE_LIMIT,
      tuning: { graphBoost: 1.0, precisionStrengthWeight: 0 },
    });
    const offRecall = computeRecallByGroup(
      offResults.map((r) => r.node.id),
      groups,
    );
    expect(offRecall).toBeLessThan(1.0);
    db.close();
  });
});
