/**
 * memory/eval/harness-reranker.ts — +reranker variant 측정 (P3 G5-a 분할).
 *
 * harness.ts 파사드의 reranker 갈래 본문(Phase 6b T7 / spec 11.2·11.3.1) — 동작
 * 불변. reranker 는 채널 마스크가 아니라 POST-RRF 단계다 — full-rrf 결과(모든 채널
 * 합산 = 운영 default 중립 RRF + cue)를 cross-encoder 로 다시 정렬한 뒤 채점한다.
 * 그래서 channelMask 메커니즘에 끼워 넣지 않고 별도 진입점(runRerankerVariant /
 * runEnrichedRerankerVariant)으로 둔다. metrics.ts·answer-map.ts·기존 채널 sweep
 * variant 는 *불변* — 이건 한 갈래의 추가 측정 경로다(공통 인프라 1.1 권위 보존).
 *
 * 측정 창 주의: Reranker.rerank 는 topKInput 만 채점하고 topKOutput 만 회신한다.
 * 운영 default(topK_output 5)는 nDCG 창(20)을 못 채우므로 측정에서는 호출부가
 * topKInput·topKOutput 을 eval 창 크기 이상으로 키운 Reranker 를 주입한다(spec
 * 11.1 "상위 채점" 정신 보존, 측정 창만 확대). 운영 default 값은 spec 11.3.1 유지.
 */
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../retriever.ts";
import type { Embedder } from "../../embedding/types.ts";
import type { RetrieveTuning } from "../retriever.ts";
import type { Reranker } from "../reranker.ts";
import { computeNdcg, computeRecallByGroup, computeMrr } from "./metrics.ts";
import { EVAL_QUERIES, toAnswerGroups, mapGroupsToNodeIds } from "./answer-map.ts";
import {
  ENRICHED_QUERIES,
  toEnrichedAnswerGroups,
  mapKeyGroupsToNodeIds,
} from "./answer-map.ts";
import { loadCorpus } from "./harness-flat.ts";
import type { ChannelMask, QueryScore, VariantSnapshot } from "./harness-flat.ts";
import {
  loadEnrichedCorpus,
  DEFAULT_ENRICHED_RETRIEVAL_LIMIT,
} from "./harness-enriched.ts";

/** +reranker variant 측정 옵션(flat·enriched 공통 모양). */
export interface RerankerVariantOptions {
  /** 점수표 이름(예 "full-rrf+reranker"). */
  variant: string;
  /** 채널 마스크 — full-rrf 결과를 모으는 데 쓴다(rerank 입력 후보). */
  mask: ChannelMask;
  /** retrieve 창 크기. flat 기본 20 / enriched 기본 DEFAULT_ENRICHED_RETRIEVAL_LIMIT. */
  retrievalLimit?: number;
  /** 모든 query 에 동일 적용할 튜닝 오버라이드. 미지정 = 운영 default(중립). */
  tuning?: RetrieveTuning;
}

/**
 * flat 코퍼스 +reranker variant 점수표. full-rrf retrieve → reranker.rerank →
 * 재정렬 순서로 nDCG/recall/MRR 채점. 운영 DB 불변경(별도 :memory:).
 *
 * reranker 는 *주입* — 측정 호출부가 모델을 로드해 가용성을 확인한 뒤 넘긴다.
 * reranker.available=false(모델 부재)면 rerank 가 RRF 순서를 그대로 회신하므로
 * 점수가 baseline 과 같아진다(graceful degrade — 가짜 점수 없음). 그 경우 호출부가
 * available 단언으로 BLOCKED 를 드러낸다(No-fabrication).
 */
export async function runRerankerVariant(
  embedder: Embedder,
  reranker: Reranker,
  options: RerankerVariantOptions,
): Promise<VariantSnapshot> {
  const retrievalLimit = options.retrievalLimit ?? 20;

  const db: Database = openMemoryDatabase(":memory:", { embeddingDim: embedder.dimension });
  const store = new SqliteMemoryStore(db, embedder);
  const lineToNodeId = await loadCorpus(
    store,
    join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "test-fixtures",
      "sandbox",
      "embedding-corpus.txt",
    ),
  );
  const retriever = new HybridRetriever(store, embedder);

  const perQuery: QueryScore[] = [];
  for (const q of EVAL_QUERIES) {
    const groups = mapGroupsToNodeIds(toAnswerGroups(q), lineToNodeId);
    // 1단계: full-rrf 후보 회수(운영 default = 중립 RRF + cue).
    const rrfResults = await retriever.retrieve(q.query, {
      limit: retrievalLimit,
      channelMask: options.mask,
      tuning: options.tuning,
    });
    // 2단계: POST-RRF 재정렬(cross-encoder). 모델 부재면 RRF 순서 그대로(degrade).
    const reranked = await reranker.rerank(q.query, rrfResults);
    const ranked = reranked.map((r) => r.node.id);
    perQuery.push({
      id: q.id,
      ndcg: computeNdcg(ranked, groups),
      recall: computeRecallByGroup(ranked, groups),
      mrr: computeMrr(ranked, groups),
    });
  }
  db.close();

  const n = perQuery.length || 1;
  return {
    variant: options.variant,
    mask: options.mask,
    avgNdcg: perQuery.reduce((s, q) => s + q.ndcg, 0) / n,
    avgRecall: perQuery.reduce((s, q) => s + q.recall, 0) / n,
    avgMrr: perQuery.reduce((s, q) => s + q.mrr, 0) / n,
    perQuery,
  };
}

/**
 * enriched 코퍼스 +reranker variant 점수표. loadEnrichedCorpus 적재 후 full-rrf
 * +concept retrieve → reranker.rerank → 재정렬 채점. flat 과 평행 구조.
 */
export async function runEnrichedRerankerVariant(
  embedder: Embedder,
  reranker: Reranker,
  options: RerankerVariantOptions,
): Promise<VariantSnapshot> {
  const retrievalLimit = options.retrievalLimit ?? DEFAULT_ENRICHED_RETRIEVAL_LIMIT;

  const db: Database = openMemoryDatabase(":memory:", { embeddingDim: embedder.dimension });
  const store = new SqliteMemoryStore(db, embedder);
  const keyToNodeId = await loadEnrichedCorpus(store);
  const retriever = new HybridRetriever(store, embedder);

  const perQuery: QueryScore[] = [];
  for (const q of ENRICHED_QUERIES) {
    const groups = mapKeyGroupsToNodeIds(toEnrichedAnswerGroups(q), keyToNodeId);
    const rrfResults = await retriever.retrieve(q.query, {
      limit: retrievalLimit,
      channelMask: options.mask,
      tuning: options.tuning,
    });
    const reranked = await reranker.rerank(q.query, rrfResults);
    const ranked = reranked.map((r) => r.node.id);
    perQuery.push({
      id: q.id,
      ndcg: computeNdcg(ranked, groups),
      recall: computeRecallByGroup(ranked, groups),
      mrr: computeMrr(ranked, groups),
    });
  }
  db.close();

  const n = perQuery.length || 1;
  return {
    variant: options.variant,
    mask: options.mask,
    avgNdcg: perQuery.reduce((s, q) => s + q.ndcg, 0) / n,
    avgRecall: perQuery.reduce((s, q) => s + q.recall, 0) / n,
    avgMrr: perQuery.reduce((s, q) => s + q.mrr, 0) / n,
    perQuery,
  };
}

/**
 * reranker measured-win gate(sweep.ts pickBest 패턴 정합). +reranker variant 의
 * avgNdcg 가 baseline(운영 default = 중립 RRF + cue) avgNdcg 보다 허용오차(1e-9)
 * 초과로 높을 때만 adopt=true. 동률·하락이면 adopt=false(spec 11.2 보수적 default).
 *
 * nDCG 를 기준으로 한다 — reranker 는 순서 미세 적합도를 다듬는 단계라 recall 은
 * 보통 불변(후보 회수는 RRF 가 끝냄), 효과는 순서(nDCG/MRR)로 드러난다.
 */
export function rerankerMeasuredWin(
  baseline: VariantSnapshot,
  reranked: VariantSnapshot,
): { adopt: boolean; gain: number; reason: string } {
  const gain = reranked.avgNdcg - baseline.avgNdcg;
  if (gain > 1e-9) {
    return {
      adopt: true,
      gain,
      reason:
        `measured-win: +reranker nDCG ${reranked.avgNdcg.toFixed(4)} > ` +
        `baseline nDCG ${baseline.avgNdcg.toFixed(4)} (+${gain.toFixed(4)})`,
    };
  }
  return {
    adopt: false,
    gain,
    reason:
      `measured-win gate 미통과: +reranker nDCG ${reranked.avgNdcg.toFixed(4)} ≤ ` +
      `baseline nDCG ${baseline.avgNdcg.toFixed(4)} (delta ${gain.toFixed(4)}). ` +
      `reranker default OFF 유지(spec 11.2 보수적 default).`,
  };
}
