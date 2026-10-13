/**
 * memory/eval/harness-flat.ts — flat 코퍼스 sweep + harness 공용 타입 (P3 G5-a 분할).
 *
 * harness.ts 파사드의 flat 갈래 본문 — 동작 불변. corpus 를 별도 임시 DB 에
 * 적재(운영 DB 불변경) → 실제 HybridRetriever 통과 → 채널 토글 sweep →
 * nDCG/recall/MRR JSON snapshot. 측정 대상 = 임베딩 모델 단독이 아니라 실제
 * RRF 파이프라인 출력(단락 5.8.2). ChannelMask·VariantSnapshot 등 공용 타입도
 * 이 모듈이 단일 출처다(enriched·reranker·cue-polarity 갈래가 재사용).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../retriever.ts";
import type { Embedder } from "../../embedding/types.ts";
import type { SynonymDictionary } from "../synonym-dictionary.ts";
import { computeNdcg, computeRecallByGroup, computeMrr } from "./metrics.ts";
import { EVAL_QUERIES, toAnswerGroups, mapGroupsToNodeIds } from "./answer-map.ts";
import type { RetrieveTuning } from "../retriever.ts";

/** 채널 마스크 — true 인 채널만 RRF 합류. retriever 옵션으로 전달. */
export interface ChannelMask {
  vector: boolean;
  fts: boolean;
  graph: boolean;
  concept: boolean; // T5 이후 의미. T1 기준선 시점엔 false 고정.
}

export const SWEEP_VARIANTS: Record<string, ChannelMask> = {
  "vector-only": { vector: true, fts: false, graph: false, concept: false },
  "fts-only": { vector: false, fts: true, graph: false, concept: false },
  "graph-only": { vector: false, fts: false, graph: true, concept: false },
  "full-rrf": { vector: true, fts: true, graph: true, concept: false },
};

export interface QueryScore {
  id: string;
  ndcg: number;
  recall: number;
  mrr: number;
}
export interface VariantSnapshot {
  variant: string;
  mask: ChannelMask;
  avgNdcg: number;
  avgRecall: number;
  avgMrr: number;
  perQuery: QueryScore[];
}
export interface EvalSnapshot {
  takenAt: string;
  embedderDim: number;
  corpusLines: number;
  variants: VariantSnapshot[];
}

/**
 * corpus 를 임시 store 에 줄 순서대로 적재. 줄(1-based) → 노드 id 매핑 반환.
 *
 * 코퍼스 무중복 요건(P0-A 입력 멱등성): store.addNode 는 같은 정규화 content 를
 * 한 노드로 흡수하므로(content_hash 흡수), 코퍼스에 중복 줄이 있으면 여러 줄이
 * 같은 노드 id 로 매핑돼 lineToNodeId 가 어긋나고 nDCG 측정이 뒤틀린다. 실제로
 * embedding-corpus.txt 는 "낯가림이 심하다" 가 줄37·줄46 두 번 있어(사전 데이터
 * 결함) P0-A 흡수 도입 후 112줄이 111노드가 돼 flat full-rrf nDCG 가 0.8882→0.8513
 * 로 떨어졌다(magnitude-fusion-regression T4 gate). 줄46 을 "낯가림이 조금 심하다"
 * 로 갈라 112 고유 노드·baseline 0.8882 를 원복했다. 앞으로 코퍼스에 줄을 더할 때
 * *중복 줄 금지* — 흡수로 노드 수가 줄어 측정이 어긋난다.
 */
export async function loadCorpus(
  store: SqliteMemoryStore,
  corpusPath: string,
): Promise<Map<number, number>> {
  const lines = readFileSync(corpusPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // P3 G5-d — 건별 addNode(줄 수만큼 임베딩 모델 호출) 대신 배치 통로. addNodesBatch
  // 는 순차 addNode 와 의미 동일(중복 줄 흡수·mention bump 포함)하되 임베딩만
  // embedBatch 1회로 계산한다. 반환 배열이 입력 순서라 줄→노드 매핑이 유지된다.
  const results = await store.addNodesBatch(
    lines.map((content) => ({ content })),
  );
  const lineToNodeId = new Map<number, number>();
  for (let i = 0; i < results.length; i++) {
    lineToNodeId.set(i + 1, results[i]!.id); // 1-based 줄 번호 매핑
  }
  return lineToNodeId;
}

/**
 * 한 variant 의 검색 점수표. retriever.retrieve 가 channelMask 를 받도록
 * RetrieveOptions 확장(T5 에서 concept 합류). 마스크 미지원 채널은 무시.
 * tuning 옵션을 지정하면 sweep 용 상수 오버라이드를 retriever 에 전달한다.
 */
export async function runVariant(
  retriever: HybridRetriever,
  variant: string,
  mask: ChannelMask,
  lineToNodeId: ReadonlyMap<number, number>,
  tuning?: RetrieveTuning,
): Promise<VariantSnapshot> {
  const perQuery: QueryScore[] = [];
  for (const q of EVAL_QUERIES) {
    const groups = mapGroupsToNodeIds(toAnswerGroups(q), lineToNodeId);
    const results = await retriever.retrieve(q.query, { limit: 20, channelMask: mask, tuning });
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

/** 전체 harness — 임시 DB 적재 + 모든 variant sweep + snapshot 조립. */
export async function runHarness(
  embedder: Embedder,
  options: {
    variants?: Record<string, ChannelMask>;
    corpusPath?: string;
    // synonymDict 주입 시 retriever fts 채널만 동의어 확장(T2 sweep 측정용 /
    // 임베딩 채널은 원본 그대로 — spec 13.3). 운영 wiring 은 T6.
    synonymDict?: SynonymDictionary;
    /**
     * T5 sweep 용 튜닝 오버라이드. 모든 variant 에 동일하게 적용된다.
     * 미지정 = search-tuning.ts 모듈 상수(운영 default 불변).
     */
    tuning?: RetrieveTuning;
  } = {},
): Promise<EvalSnapshot> {
  const variants = options.variants ?? SWEEP_VARIANTS;
  const corpusPath =
    options.corpusPath ??
    join(import.meta.dir, "..", "..", "..", "test-fixtures", "sandbox", "embedding-corpus.txt");

  // 운영 DB 불변경 — 별도 :memory: DB.
  const db: Database = openMemoryDatabase(":memory:", { embeddingDim: embedder.dimension });
  const store = new SqliteMemoryStore(db, embedder);
  const lineToNodeId = await loadCorpus(store, corpusPath);
  // 생성자 옵션 추가 시 flat/ext 양쪽 동시 갱신(harness-ext.ts runExtHarness 참조) —
  // 한쪽만 늘리면 같은 파이프라인을 잰다는 전제가 조용히 깨진다.
  const retriever = new HybridRetriever(store, embedder, {
    synonymDict: options.synonymDict,
  });

  const variantSnapshots: VariantSnapshot[] = [];
  for (const [variant, mask] of Object.entries(variants)) {
    variantSnapshots.push(await runVariant(retriever, variant, mask, lineToNodeId, options.tuning));
  }
  db.close();

  return {
    takenAt: new Date().toISOString(),
    embedderDim: embedder.dimension,
    corpusLines: lineToNodeId.size,
    variants: variantSnapshots,
  };
}
