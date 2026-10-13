/**
 * memory/eval/harness-enriched.ts — enriched 코퍼스 적재·sweep (P3 G5-a 분할).
 *
 * harness.ts 파사드의 enriched 갈래 본문 — 동작 불변. 그래프·개념 채널을 함께
 * 재는 평행 진입점(공통 인프라 1.1b T1). flat sweep(harness-flat.ts)은 그대로
 * 둔다 — flat 기준선 보존.
 */
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../retriever.ts";
import type { Embedder } from "../../embedding/types.ts";
import type { SynonymDictionary } from "../synonym-dictionary.ts";
import type { RetrieveTuning } from "../retriever.ts";
import { computeNdcg, computeRecallByGroup, computeMrr } from "./metrics.ts";
import {
  ENRICHED_QUERIES,
  toEnrichedAnswerGroups,
  mapKeyGroupsToNodeIds,
} from "./answer-map.ts";
import {
  ENRICHED_NODES,
  ENRICHED_EDGES,
  ENRICHED_ENTITY_ROWS,
  ENRICHED_LABEL_ATTRS,
  ENRICHED_RELATIONS,
} from "../../../test-fixtures/sandbox/enriched-corpus.ts";
import { applyEntityAttributes } from "../entity-attribute-wiring.ts";
import { SWEEP_VARIANTS } from "./harness-flat.ts";
import type {
  ChannelMask,
  QueryScore,
  VariantSnapshot,
  EvalSnapshot,
} from "./harness-flat.ts";

/**
 * enriched sweep variant. flat SWEEP_VARIANTS 에 concept 채널을 켠 두 갈래를 더한다.
 *  - full-rrf+concept: 네 채널 전부 ON — 그래프·개념을 포함한 전체 RRF.
 *  - no-graph: 그래프만 끈 대조군. full-rrf+concept 와의 차이가 그래프 델타.
 *
 * graph-only 단독 마스크는 의도적으로 빼지 않았다 — 그래프 BFS seed 가
 * vector∪fts 에서 나오므로(pickGraphSeeds), vector·fts 를 끄면 seed 가 0개라
 * graph-only 점수가 구조적으로 항상 0 이 된다(엣지 부재 탓이 아님, DCL-1).
 * 그래서 그래프 기여는 full-rrf+concept vs no-graph 델타로 측정한다.
 */
export const ENRICHED_SWEEP_VARIANTS: Record<string, ChannelMask> = {
  ...SWEEP_VARIANTS,
  "full-rrf+concept": { vector: true, fts: true, graph: true, concept: true },
  "no-graph": { vector: true, fts: true, graph: false, concept: true },
};

/**
 * 칸·라벨용 엔티티 행을 종류별 facade 로 만들어 id 를 돌려준다(감사 H1 / 단계2 T7).
 * 미지원 종류는 식별자 담은 loud throw(silent skip 금지).
 */
async function findOrCreateEnrichedEntity(
  store: SqliteMemoryStore,
  typeName: string,
  name: string,
): Promise<string> {
  // 단계4 T4 — 전용 facade 8개가 사라져 범용 본체 findOrCreateEntity 한 통로로 만든다.
  // 칸·라벨 적재가 다루는 종류만 명시 허용하고(옛 switch 와 같은 화이트리스트), 그 밖은
  // 식별자 담은 loud throw 로 막는다(silent skip 금지·동작 보존).
  const SUPPORTED = new Set([
    "schedule",
    "place",
    "intake",
    "usable",
    "work",
    "creature",
  ]);
  if (!SUPPORTED.has(typeName)) {
    throw new Error(
      `loadEnrichedCorpus: 칸·라벨 적재가 지원하지 않는 종류 "${typeName}" ("${name}")`,
    );
  }
  return (await store.entitiesRepo.findOrCreateEntity(typeName, name)).id;
}

/**
 * enriched 코퍼스를 임시 store 에 적재. 노드 + #태그 개념 + node↔node 엣지에 더해,
 * 단계2 T7(감사 H1)이 칸(전용 물리 컬럼)·라벨(has_attribute)·엔티티 관계
 * (entity_relation_edges)도 실 wiring/저장소로 적재한다 — 7채널 중 한 번도 안 재던
 * 칸·라벨·관계를 동등성 측정 토대에 함께 세운다. 노드 key → 노드 id 매핑을 돌려준다.
 *
 * 적재 순서: (1) 노드 addNodesBatch(projectId 포함·임베딩 embedBatch 1회) → key→id 매핑 (2) tags 마다
 * findOrCreateTagConcept + addNodeConceptEdge(role 'tag') (3) node↔node 엣지 addEdge
 * (4) 칸 채운 엔티티 행 applyEntityAttributes (5) 라벨 has_attribute 엣지 (6)
 * entity_relation_edges 관계. 적재 실패(미존재 key·미지원 종류·칸 갱신 실패)는 모두
 * 식별자 담은 loud throw(silent skip 금지). 운영 DB 불변경(:memory: 전용 store).
 */
export async function loadEnrichedCorpus(
  store: SqliteMemoryStore,
): Promise<Map<string, number>> {
  const keyToNodeId = new Map<string, number>();

  // 1. 노드 적재 + 개념 엣지. P3 G5-d — 건별 addNode 대신 배치 통로(임베딩
  //    embedBatch 1회). 반환 배열이 입력 순서라 key→id 매핑이 유지되고, 태그
  //    wiring 은 노드 배치 이후 기존 흐름 그대로 잇는다.
  const nodeResults = await store.addNodesBatch(
    ENRICHED_NODES.map((node) => ({
      content: node.content,
      project_id: node.projectId,
      // 공통 인프라 1.1c T1 — polarity 라벨 적재(미지정 NULL). EQ6 polarity 필터 측정.
      polarity: node.polarity,
    })),
  );
  for (let i = 0; i < ENRICHED_NODES.length; i++) {
    const node = ENRICHED_NODES[i]!;
    const nodeId = nodeResults[i]!.id;
    keyToNodeId.set(node.key, nodeId);
    for (const tag of node.tags ?? []) {
      const conceptId = await store.findOrCreateTagConcept(tag);
      await store.addNodeConceptEdge(nodeId, conceptId, "tag", "llm_extract", nodeId);
    }
  }

  // 2. node↔node 엣지 적재.
  for (const edge of ENRICHED_EDGES) {
    const sourceId = keyToNodeId.get(edge.source);
    const targetId = keyToNodeId.get(edge.target);
    if (sourceId === undefined) {
      throw new Error(`loadEnrichedCorpus: 엣지 source key "${edge.source}" 노드 없음`);
    }
    if (targetId === undefined) {
      throw new Error(`loadEnrichedCorpus: 엣지 target key "${edge.target}" 노드 없음`);
    }
    await store.addEdge({
      sourceId,
      targetId,
      relation: edge.relation,
      weight: edge.weight,
      provenance: "llm_extract",
      sourceNodeId: null,
    });
  }

  // 3. 칸이 채워진 엔티티 행(전용 물리 컬럼) — applyEntityAttributes 가 columnLabels
  //    키를 전용 컬럼에 채운다(정렬·필터 가능). 칸이 안 채워지면 loud throw.
  for (const row of ENRICHED_ENTITY_ROWS) {
    const entityId = await findOrCreateEnrichedEntity(store, row.typeName, row.name);
    const result = await applyEntityAttributes(
      store,
      row.typeName,
      entityId,
      row.columns,
      "llm_extract",
      null,
    );
    if (result.columnKeys.length !== row.columns.length) {
      throw new Error(
        `loadEnrichedCorpus: ${row.typeName} "${row.name}" 칸 적재 불완전 ` +
          `(기대 ${row.columns.length} 칸, 채움 ${result.columnKeys.length} — skipped: ` +
          `${result.skipped.map((s) => s.key).join(", ")})`,
      );
    }
  }

  // 4. 라벨(has_attribute) — 색인 없는 꼬리표. applyEntityAttributes 가 라벨 어휘면
  //    value 개념 + has_attribute 엣지를 만든다. 라벨이 안 생기면 loud throw.
  for (const item of ENRICHED_LABEL_ATTRS) {
    const entityId = await findOrCreateEnrichedEntity(store, item.typeName, item.name);
    const result = await applyEntityAttributes(
      store,
      item.typeName,
      entityId,
      item.labels,
      "llm_extract",
      null,
    );
    if (result.labelConceptIds.length !== item.labels.length) {
      throw new Error(
        `loadEnrichedCorpus: ${item.typeName} "${item.name}" 라벨 적재 불완전 ` +
          `(기대 ${item.labels.length} 라벨, 만듦 ${result.labelConceptIds.length} — skipped: ` +
          `${result.skipped.map((s) => s.key).join(", ")})`,
      );
    }
  }

  // 5. 엔티티 관계(entity_relation_edges) — 작품→사람 created_by 등. source·target 행을
  //    먼저 만들고 addEntityRelationEdge 로 잇는다(assertRelationName 가 unknown 관계 차단).
  for (const rel of ENRICHED_RELATIONS) {
    const sourceId = await findOrCreateEnrichedEntity(store, rel.sourceType, rel.sourceName);
    // 사람 행은 entity_relation_edges 에서 personId 를 식별자로 쓴다(production
    // createEntityRow("person") 가 person.personId 를 돌려주는 양식 정합).
    const target = await store.findOrCreatePersonByName(rel.targetName);
    const created = store.addEntityRelationEdge(
      rel.sourceType,
      sourceId,
      rel.targetType,
      target.personId,
      rel.relation,
      "llm_extract",
      null,
    );
    if (!created && store.getRelationsFromSource(rel.sourceType, sourceId).length === 0) {
      throw new Error(
        `loadEnrichedCorpus: 관계 적재 실패 ${rel.sourceType} "${rel.sourceName}" ` +
          `→ ${rel.targetType} "${rel.targetName}" (${rel.relation})`,
      );
    }
  }

  return keyToNodeId;
}

/**
 * enriched 질문 한 variant 의 점수표. ENRICHED_QUERIES 를 key→id 로 옮겨 채점.
 *
 * retrievalLimit 기본 20 — flat harness 와 같은 창. distractor 가 많은 enriched
 * 코퍼스라 이 창에서도 채널이 분별력 있게 갈린다(vector-only nDCG 0.77 / fts-only
 * recall 0.50 — vector 가 전부 1.0 이 아님 = T2~T5 튜닝 틈 존재). recall 가드레일
 * (개념·그래프가 어떤 query 의 정답도 창 밖으로 안 밀어냄)은 이 창에서 성립한다.
 *
 * DCL-2 실측 단서: 이 코퍼스에서 채널의 순기여는 recall 델타가 아니라 nDCG/MRR
 * 순서 차이로 드러난다. 좁은 창(예 5)에선 한 채널이 query A 정답을 넣으며 query B
 * 정답을 밀어내는 trade-off 가 생기고, 개념 채널은 getNodesByConcepts 가 삽입
 * 순서로 노드를 돌려줘(관련도 정렬 X) 늦게 삽입된 정답을 오히려 demote 할 수 있다
 * (T5 가 다룰 개념 채널 정렬 과제). 그래서 T1 은 가드레일 + 분별력 확인까지만
 * 보장하고, 채널별 가산성 튜닝은 후속 task 로 넘긴다.
 */
export const DEFAULT_ENRICHED_RETRIEVAL_LIMIT = 20;

export async function runEnrichedVariant(
  retriever: HybridRetriever,
  variant: string,
  mask: ChannelMask,
  keyToNodeId: ReadonlyMap<string, number>,
  retrievalLimit: number = DEFAULT_ENRICHED_RETRIEVAL_LIMIT,
  applyProjectVocab: boolean = false,
  tuning?: RetrieveTuning,
): Promise<VariantSnapshot> {
  const perQuery: QueryScore[] = [];
  for (const q of ENRICHED_QUERIES) {
    const groups = mapKeyGroupsToNodeIds(toEnrichedAnswerGroups(q), keyToNodeId);
    // applyProjectVocab = true 이고 q.project 가 있을 때만 options.project 전달.
    // false = project 미전달 → loadProjectVocab 호출조차 없음 → before 기준선 정확 격리.
    const results = await retriever.retrieve(q.query, {
      limit: retrievalLimit,
      channelMask: mask,
      tuning,
      ...(applyProjectVocab && q.project ? { project: q.project } : {}),
    });
    const ranked = results.map((r) => r.node.id);
    perQuery.push({
      id: q.id,
      ndcg: computeNdcg(ranked, groups),
      recall: computeRecallByGroup(ranked, groups),
      mrr: computeMrr(ranked, groups),
    });
  }
  const n = perQuery.length || 1;
  return {
    variant,
    mask,
    avgNdcg: perQuery.reduce((s, q) => s + q.ndcg, 0) / n,
    avgRecall: perQuery.reduce((s, q) => s + q.recall, 0) / n,
    avgMrr: perQuery.reduce((s, q) => s + q.mrr, 0) / n,
    perQuery,
  };
}

/**
 * enriched harness — 임시 :memory: DB 적재 + ENRICHED_SWEEP_VARIANTS sweep +
 * snapshot 조립. flat runHarness 와 평행 구조(둘 다 운영 DB 불변경).
 */
export async function runEnrichedHarness(
  embedder: Embedder,
  options: {
    variants?: Record<string, ChannelMask>;
    retrievalLimit?: number;
    // synonymDict 주입 시 retriever fts 채널만 동의어 확장(T2 before/after 측정용
    // / 임베딩 채널은 원본 그대로 — spec 13.3). 운영 wiring 은 T6.
    synonymDict?: SynonymDictionary;
    /**
     * T3 project expansion 배선 전/후 측정 격리 옵션(D8 / spec 5.4).
     * true 일 때만: (a) project_vocabularies 에 테스트 행을 INSERT 하고
     * (b) ENRICHED_QUERIES 의 project 칸을 retrieve options.project 로 전달.
     * false(기본) = 행 INSERT 없음 + project 미전달 → 1.1a 동작 그대로(before 기준선).
     */
    applyProjectVocab?: boolean;
    /**
     * T5 sweep 용 튜닝 오버라이드. 모든 variant 에 동일하게 적용된다.
     * 미지정 = search-tuning.ts 모듈 상수(운영 default 불변).
     */
    tuning?: RetrieveTuning;
  } = {},
): Promise<EvalSnapshot> {
  const variants = options.variants ?? ENRICHED_SWEEP_VARIANTS;
  const retrievalLimit = options.retrievalLimit ?? DEFAULT_ENRICHED_RETRIEVAL_LIMIT;

  // 운영 DB 불변경 — 별도 :memory: DB.
  const db: Database = openMemoryDatabase(":memory:", { embeddingDim: embedder.dimension });
  const store = new SqliteMemoryStore(db, embedder);
  const keyToNodeId = await loadEnrichedCorpus(store);

  // applyProjectVocab = true 일 때만 project_vocabularies 에 테스트 행을 INSERT.
  // EQ4 query("cleanup 작업") → bara_cleanup 의 의미를 넣어 두채널 expansion 측정.
  if (options.applyProjectVocab) {
    db.prepare(
      "INSERT INTO project_vocabularies(project_id, term, expanded_meaning, added_by) VALUES(?,?,?,?)",
    ).run("bara_system", "cleanup", "메모리 정리 AI", "harness");
  }

  const retriever = new HybridRetriever(store, embedder, {
    synonymDict: options.synonymDict,
  });

  const variantSnapshots: VariantSnapshot[] = [];
  for (const [variant, mask] of Object.entries(variants)) {
    variantSnapshots.push(
      await runEnrichedVariant(
        retriever,
        variant,
        mask,
        keyToNodeId,
        retrievalLimit,
        options.applyProjectVocab ?? false,
        options.tuning,
      ),
    );
  }
  db.close();

  return {
    takenAt: new Date().toISOString(),
    embedderDim: embedder.dimension,
    corpusLines: keyToNodeId.size,
    variants: variantSnapshots,
  };
}
