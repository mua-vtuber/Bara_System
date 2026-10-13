import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../retriever.ts";
import {
  buildPolarityMap,
  CUE_POLARITY_RETRIEVAL_LIMIT,
  loadEnrichedCorpus,
  runCuePolarityHarness,
  runEnrichedHarness,
} from "./harness.ts";
import { ENRICHED_QUERIES } from "../../../test-fixtures/sandbox/eval-enriched-queries.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

describe("enriched harness — 실 SQLite + bge-m3 / 그래프·개념 채널 측정", () => {
  test("두 번째 기준선 산출 — full-rrf+concept / no-graph 수치 보고 + 질문 6종", async () => {
    const snap = await runEnrichedHarness(embedder);
    expect(snap.embedderDim).toBe(1024);
    const withConcept = snap.variants.find((v) => v.variant === "full-rrf+concept");
    expect(withConcept).toBeDefined();
    expect(withConcept!.perQuery.length).toBe(6); // EQ1~EQ6 (1.1c T1 이 EQ5·EQ6 추가)
    const noGraph = snap.variants.find((v) => v.variant === "no-graph")!;
    // 두 번째 기준선 수치 — plan Evidence 칸 기록용(그래프 델타가 보이게 둘 다).
    console.log(
      `[enriched 기준선] full-rrf+concept ` +
        `avgNdcg=${withConcept!.avgNdcg.toFixed(4)} ` +
        `avgRecall=${withConcept!.avgRecall.toFixed(4)} ` +
        `avgMrr=${withConcept!.avgMrr.toFixed(4)}`,
    );
    console.log(
      `[enriched 대조] no-graph ` +
        `avgNdcg=${noGraph.avgNdcg.toFixed(4)} ` +
        `avgRecall=${noGraph.avgRecall.toFixed(4)} ` +
        `avgMrr=${noGraph.avgMrr.toFixed(4)}`,
    );
  });

  test("코퍼스 분별력 — vector-only 가 전부 1.0 이 아니다(튜닝 틈 존재)", async () => {
    const snap = await runEnrichedHarness(embedder);
    const v = snap.variants.find((x) => x.variant === "vector-only")!;
    // distractor 가 vector 를 일부러 틀리게 함 → nDCG 1.0 미만(DCL-2).
    expect(v.avgNdcg).toBeLessThan(1.0);
  });

  test("그래프 델타 — full-rrf+concept 가 no-graph 보다 recall 안 깎음 + muryo 도달", async () => {
    const snap = await runEnrichedHarness(embedder);
    const withG = snap.variants.find((x) => x.variant === "full-rrf+concept")!;
    const noG = snap.variants.find((x) => x.variant === "no-graph")!;
    expect(withG.avgRecall).toBeGreaterThanOrEqual(noG.avgRecall - 1e-9);
    const eq1 = withG.perQuery.find((q) => q.id === "EQ1")!;
    expect(eq1.recall).toBeGreaterThan(0); // muryo 가 그래프 체인으로 도달돼 회수됨
  });

  test("개념 가산성 — full-rrf+concept 가 full-rrf(개념 끈) 보다 recall 안 깎음", async () => {
    const snap = await runEnrichedHarness(embedder);
    const withC = snap.variants.find((x) => x.variant === "full-rrf+concept")!;
    const noC = snap.variants.find((x) => x.variant === "full-rrf")!;
    expect(withC.avgRecall).toBeGreaterThanOrEqual(noC.avgRecall - 1e-9);
  });
});

describe("cue·polarity 분별력 — 공통 인프라 1.1c T1 측정 토대", () => {
  test("세 번째 기준선 — cue-off/cue-on/polarity-off/polarity-on 수치 보고", async () => {
    const snap = await runCuePolarityHarness(embedder);
    const cueOff = snap.variants.find((v) => v.variant === "cue-off")!;
    const cueOn = snap.variants.find((v) => v.variant === "cue-on")!;
    const polOff = snap.variants.find((v) => v.variant === "polarity-off")!;
    const polOn = snap.variants.find((v) => v.variant === "polarity-on")!;
    const eq5 = (v: typeof cueOff) => v.perQuery.find((q) => q.id === "EQ5")!;
    const eq6 = (v: typeof cueOff) => v.perQuery.find((q) => q.id === "EQ6")!;
    // 세 번째 기준선 수치 — plan Evidence 칸 기록용.
    console.log(
      `[1.1c cue] EQ5 cue-off recall=${eq5(cueOff).recall.toFixed(4)} ndcg=${eq5(cueOff).ndcg.toFixed(4)} mrr=${eq5(cueOff).mrr.toFixed(4)} ` +
        `/ cue-on recall=${eq5(cueOn).recall.toFixed(4)} ndcg=${eq5(cueOn).ndcg.toFixed(4)} mrr=${eq5(cueOn).mrr.toFixed(4)}`,
    );
    console.log(
      `[1.1c polarity] EQ6 polarity-off recall=${eq6(polOff).recall.toFixed(4)} ` +
        `/ polarity-on recall=${eq6(polOn).recall.toFixed(4)}`,
    );
  });

  test("측정 게이트 cue — EQ5 cue-off recall < 1.0(graph-hop 답 직접 미회수 틈)", async () => {
    const snap = await runCuePolarityHarness(embedder);
    const cueOff = snap.variants.find((v) => v.variant === "cue-off")!;
    const eq5Off = cueOff.perQuery.find((q) => q.id === "EQ5")!;
    // theme_reason 은 좁은 창에서 graph 중립이면 회수되지 않는다(측정 틈 존재).
    expect(eq5Off.recall).toBeLessThan(1.0);
  });

  test("측정 게이트 cue — cue-on 이 EQ5 에서 비회귀(recall·ndcg 안 깎음)", async () => {
    const snap = await runCuePolarityHarness(embedder);
    const eq5 = (name: string) =>
      snap.variants.find((v) => v.variant === name)!.perQuery.find((q) => q.id === "EQ5")!;
    const off = eq5("cue-off");
    const on = eq5("cue-on");
    // measured-win 부재(2026-07-10 bge-m3 재측정) — EQ5 정답이 vector 채널로 직접
    // 회수돼 graph-hop 전제 붕괴, boost 는 중립 1.0 복귀(search-tuning.ts 이력).
    // strict-lift 대신 비회귀 단언 — cue 배선이 점수를 안 깎는다.
    expect(on.recall).toBeGreaterThanOrEqual(off.recall - 1e-9);
    expect(on.ndcg).toBeGreaterThanOrEqual(off.ndcg - 1e-9);
  });

  test("측정 게이트 polarity — EQ6 polarity-on 이 positive 가족만 회수(분별)", async () => {
    const snap = await runCuePolarityHarness(embedder);
    const eq6 = (name: string) =>
      snap.variants.find((v) => v.variant === name)!.perQuery.find((q) => q.id === "EQ6")!;
    const off = eq6("polarity-off");
    const on = eq6("polarity-on");
    // positive 가족(design_warm·design_cozy)은 polarity-on 에서도 회수됨.
    expect(on.recall).toBeGreaterThan(0);
    // 필터 미적용 대비 분별 — positive 가족이 둘 다 라벨됐으므로 recall 은 깎이지
    // 않고, negative·neutral 노드를 거른다(perQuery recall 은 positive 정답 기준).
    expect(on.recall).toBeLessThanOrEqual(off.recall + 1e-9);
  });

  test("측정 게이트 polarity — EQ6 필터가 negative·neutral·NULL 노드를 실제로 제외", async () => {
    // 직접 retrieve 로 필터 전/후를 비교해 분별을 증명한다. 필터 전 창에는
    // positive 가 아닌 노드(negative/neutral/NULL)가 섞여 있어야 분별이 vacuous
    // 가 아니다(아니면 코퍼스가 polarity 효과를 못 잼).
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    const keyToNodeId = await loadEnrichedCorpus(store);
    const polarityById = buildPolarityMap(keyToNodeId);
    const retriever = new HybridRetriever(store, embedder);
    const eq6 = ENRICHED_QUERIES.find((q) => q.id === "EQ6")!;

    const results = await retriever.retrieve(eq6.query, {
      limit: CUE_POLARITY_RETRIEVAL_LIMIT,
    });
    const beforeIds = results.map((r) => r.node.id);
    const afterIds = beforeIds.filter((id) => polarityById.get(id) === eq6.polarity);

    // 필터 전 창에 positive 아닌 노드가 섞여 있다(분별 대상 존재).
    const nonPositiveBefore = beforeIds.filter(
      (id) => polarityById.get(id) !== "positive",
    );
    expect(nonPositiveBefore.length).toBeGreaterThan(0);
    // 필터가 그 노드들을 실제로 제거한다(필터 후 전부 positive).
    expect(afterIds.length).toBeLessThan(beforeIds.length);
    for (const id of afterIds) {
      expect(polarityById.get(id)).toBe("positive");
    }
    db.close();
  });
});

// ── 단계2 T7: 칸·라벨·관계 적재 확장 + bge-m3 baseline ────────────────────────

describe("감사 H1 — loadEnrichedCorpus 칸·라벨·관계 적재(단계2 T7)", () => {
  test("칸(전용 물리 컬럼)이 실제로 채워진다 — 장소 주소·섭취 유통기한(일정은 0칸)", async () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    await loadEnrichedCorpus(store);

    // 단계4 T4 — 전용 칸(places.address 등)이 범용 본체 entity_attributes(is_column=1·
    // attr_key=snake_case)로 옮겨졌다. 칸 값을 그 본체에서 직접 읽어 같은 사실을 단정한다.
    const readAttr = (entityId: string, attrKey: string): string | null => {
      const r = db
        .prepare(
          "SELECT attr_value FROM entity_attributes WHERE entity_id = ? AND attr_key = ?",
        )
        .get(entityId, attrKey) as { attr_value: string } | undefined;
      return r ? r.attr_value : null;
    };

    // 일정(schedule)은 0칸 종류다(2026-06-28 a8a30a3·전용 날짜 칸 제거). 코퍼스 schedule
    // 행은 columns=[] 라 entity_attributes 에 event_at 칸이 안 생긴다 — 일정 날짜의 정상
    // 통로는 글 event_at(달력 위젯·본문 #날짜: reserved key) 하나다. 행 자체는 적재된다.
    const schedule = await store.entitiesRepo.findByName("schedule", "월말 회의");
    expect(schedule).not.toBeNull();
    expect(readAttr(schedule!.id, "event_at")).toBeNull();
    const place = await store.entitiesRepo.findByName("place", "강남 사무실");
    expect(place).not.toBeNull();
    expect(readAttr(place!.id, "address")).toBe("서울시 강남구 테헤란로 1");
    const intake = await store.entitiesRepo.findByName("intake", "우유");
    expect(intake).not.toBeNull();
    expect(readAttr(intake!.id, "expires_at")).toBe("2026-07-10");
    db.close();
  });

  test("라벨(has_attribute) 엣지가 실제로 생긴다 — 작품 장르(생물 종류 라벨은 어휘 부재로 제거)", async () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    await loadEnrichedCorpus(store);

    const work = await store.entitiesRepo.findByName("work", "데못죽");
    expect(work).not.toBeNull();
    const workLabels = store.getEntityConceptEdges("work", work!.id, "has_attribute");
    expect(workLabels.length).toBe(1);

    // 생물(creature) "보리" 의 `종류:강아지` 라벨은 생물 어휘 정의(attributes [주인])에
    // `종류` 키가 없어 코퍼스에서 뺐다(어휘 정합·안 쓸 라벨 제거). 라벨 행이 사라져 "보리"
    // 는 loadEnrichedCorpus 로 생성되지 않는다 — null 을 정직하게 단언(거짓 통과 아님).
    const creature = await store.entitiesRepo.findByName("creature", "보리");
    expect(creature).toBeNull();
    db.close();
  });

  test("엔티티 관계(entity_relation_edges)가 실제로 생긴다 — 작품→사람 created_by", async () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    await loadEnrichedCorpus(store);

    const work = await store.entitiesRepo.findByName("work", "데못죽");
    expect(work).not.toBeNull();
    const relations = store.getRelationsFromSource("work", work!.id);
    expect(relations.length).toBeGreaterThanOrEqual(1);
    expect(relations.some((r) => r.relation === "created_by")).toBe(true);
    db.close();
  });
});

describe("감사 H1 — bge-m3(dim 1024) baseline 재측정(단계2 T7)", () => {
  let bge: Bgem3Embedder;
  beforeAll(async () => {
    bge = new Bgem3Embedder();
    await bge.load();
  });

  test("enriched sweep 을 bge-m3 로 돌려 7채널 점수표 snapshot 기록(측정만)", async () => {
    const snap = await runEnrichedHarness(bge);
    expect(snap.embedderDim).toBe(1024); // bge-m3 dim.
    const withConcept = snap.variants.find((v) => v.variant === "full-rrf+concept")!;
    expect(withConcept.perQuery.length).toBe(6);
    // baseline snapshot 숫자 — plan Evidence 칸 기록용(칸·라벨·관계가 적재된 코퍼스 위).
    for (const v of snap.variants) {
      console.log(
        `[bge-m3 baseline] ${v.variant} ` +
          `avgNdcg=${v.avgNdcg.toFixed(4)} ` +
          `avgRecall=${v.avgRecall.toFixed(4)} ` +
          `avgMrr=${v.avgMrr.toFixed(4)}`,
      );
    }
  }, 120_000);
});
