/**
 * memory/eval/harness-ext.ts — 확장 손 정답 셋 sweep (T2 / spec 5-1).
 *
 * 기존 harness-flat.ts 는 Q1~Q10 + embedding-corpus.txt 로 동결돼 있고 여러 회귀
 * 테스트가 그 수치를 기준선으로 쓴다. 확장 문항을 거기에 섞으면 기준선이 통째로
 * 흔들리므로, 확장분은 이 모듈이 별도 코퍼스·별도 질문 셋으로 나란히 측정한다.
 *
 * 측정 대상은 동일하다 — 임시 :memory: DB 에 코퍼스를 적재하고 실제
 * HybridRetriever 를 통과시킨 출력(운영 DB 불변경). 기존과 다른 점은 metric 이
 * 6종(nDCG/recall/MRR/precision/F1/MAP)이라는 것뿐이다.
 *
 * 정답 0개(unanswerable) 문항 처리 — metric 함수들은 그룹 0개에 0 을 돌려주는데,
 * 이 0 은 "회수 실패"가 아니라 "측정 대상 없음"이다. 평균에 섞으면 파이프라인이
 * 정상 동작해도 baseline 이 상수만큼 눌려 회귀 감지가 둔해진다. 그래서 평균은
 * 정답이 있는 문항만으로 내고(answerable), 정답 없는 문항은 "상위에 무엇이든
 * 끌어올렸는가"를 따로 센다(zeroResultTopHits — 낮을수록 정직).
 */
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../retriever.ts";
import type { Embedder } from "../../embedding/types.ts";
import type { SynonymDictionary } from "../synonym-dictionary.ts";
import {
  computeNdcg,
  computeRecallByGroup,
  computeMrr,
  computePrecision,
  computeF1,
  computeMap,
} from "./metrics.ts";
import { EVAL_QUERIES_EXT, toExtAnswerGroups } from "./answer-map.ts";
import type { EvalQueryKind } from "./answer-map.ts";
import { loadCorpus, type ChannelMask } from "./harness-flat.ts";
import type { RetrieveTuning } from "../retriever.ts";

/** 확장 코퍼스 경로 — 기존 embedding-corpus.txt 와 별개 파일(동결 보존). */
export const EXT_CORPUS_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "test-fixtures",
  "sandbox",
  "embedding-corpus-ext.txt",
);

/** 확장 sweep 의 검색 반환 상한 — flat harness(20) 와 동일 조건. */
export const EXT_RETRIEVAL_LIMIT = 20;

/**
 * 좁은 창 측정 상한.
 *
 * 왜 별도로 재는가 — 코퍼스 90줄에 상한 20 이면 한 질의가 코퍼스의 22% 를 돌려받는다.
 * 그 창에서는 정답이 1위든 15위든 recall 이 똑같이 1.0 이라, recall 이 천장에
 * 붙어 회귀를 못 잡는다(2026-08-03 실측: 상한 20·10 에서 recall 1.0000 / 상한 5
 * 에서 0.9744 / 상한 3 에서 0.9402 / 상한 1 에서 0.8803). 즉 순위 변별력은 실재하는데
 * 넓은 창이 그걸 가린다. T14·T19 가 임계값을 움직였을 때 품질 하락을 *수치로*
 * 보려면 천장에 안 붙은 계측기가 필요하므로, 넓은 창(기존 관례 정합)과 좁은 창
 * (회귀 감지용)을 둘 다 동결한다.
 */
export const EXT_TIGHT_RETRIEVAL_LIMIT = 3;

export interface ExtQueryScore {
  id: string;
  kind: EvalQueryKind;
  /** 정답 그룹 0개 문항 = false. 평균 집계에서 제외된다. */
  answerable: boolean;
  ndcg: number;
  recall: number;
  mrr: number;
  precision: number;
  f1: number;
  map: number;
  /** 반환 건수 — unanswerable 문항의 0건 정직성 확인용. */
  returned: number;
}

export interface ExtVariantSnapshot {
  variant: string;
  mask: ChannelMask;
  /** 이 variant 를 잰 반환 상한 — 넓은 창/좁은 창 수치를 구분해 읽기 위함. */
  limit: number;
  /** 아래 평균 6종은 모두 answerable 문항만으로 낸다. */
  avgNdcg: number;
  avgRecall: number;
  avgMrr: number;
  avgPrecision: number;
  avgF1: number;
  avgMap: number;
  answerableCount: number;
  unanswerableCount: number;
  /** 정답 없는 문항에서 무언가를 반환한 문항 수(참고 지표 — 단언 대상 아님). */
  zeroResultTopHits: number;
  perQuery: ExtQueryScore[];
}

export interface ExtEvalSnapshot {
  takenAt: string;
  embedderDim: number;
  corpusLines: number;
  queryCount: number;
  variants: ExtVariantSnapshot[];
}

/** 확장 문항 한 variant 측정 — 6 metric 전부. */
export async function runExtVariant(
  retriever: HybridRetriever,
  variant: string,
  mask: ChannelMask,
  lineToNodeId: ReadonlyMap<number, number>,
  tuning?: RetrieveTuning,
  limit: number = EXT_RETRIEVAL_LIMIT,
): Promise<ExtVariantSnapshot> {
  const perQuery: ExtQueryScore[] = [];
  for (const q of EVAL_QUERIES_EXT) {
    const groups = toExtAnswerGroups(q, lineToNodeId);
    const results = await retriever.retrieve(q.query, {
      limit,
      channelMask: mask,
      tuning,
    });
    const ranked = results.map((r) => r.node.id);
    perQuery.push({
      id: q.id,
      kind: q.kind,
      answerable: groups.length > 0,
      ndcg: computeNdcg(ranked, groups),
      recall: computeRecallByGroup(ranked, groups),
      mrr: computeMrr(ranked, groups),
      precision: computePrecision(ranked, groups),
      f1: computeF1(ranked, groups),
      map: computeMap(ranked, groups),
      returned: ranked.length,
    });
  }

  const answerable = perQuery.filter((q) => q.answerable);
  const unanswerable = perQuery.filter((q) => !q.answerable);
  const n = answerable.length || 1;
  const avg = (pick: (q: ExtQueryScore) => number): number =>
    answerable.reduce((s, q) => s + pick(q), 0) / n;

  return {
    variant,
    mask,
    limit,
    avgNdcg: avg((q) => q.ndcg),
    avgRecall: avg((q) => q.recall),
    avgMrr: avg((q) => q.mrr),
    avgPrecision: avg((q) => q.precision),
    avgF1: avg((q) => q.f1),
    avgMap: avg((q) => q.map),
    answerableCount: answerable.length,
    unanswerableCount: unanswerable.length,
    zeroResultTopHits: unanswerable.filter((q) => q.returned > 0).length,
    perQuery,
  };
}

/** 확장 harness — 임시 DB 적재 + variant sweep + snapshot 조립. */
export async function runExtHarness(
  embedder: Embedder,
  options: {
    variants?: Record<string, ChannelMask>;
    corpusPath?: string;
    // synonymDict 주입 시 retriever fts 채널만 동의어 확장(임베딩 채널은 원본
    // 그대로 — spec 13.3). flat harness 와 동일 의미.
    synonymDict?: SynonymDictionary;
    tuning?: RetrieveTuning;
    /** 미지정 = EXT_RETRIEVAL_LIMIT(넓은 창). 좁은 창 측정 시 명시. */
    limit?: number;
  } = {},
): Promise<ExtEvalSnapshot> {
  const variants = options.variants ?? {
    "full-rrf": { vector: true, fts: true, graph: true, concept: false },
  };
  const corpusPath = options.corpusPath ?? EXT_CORPUS_PATH;

  // 운영 DB 불변경 — 별도 :memory: DB.
  const db: Database = openMemoryDatabase(":memory:", {
    embeddingDim: embedder.dimension,
  });
  const store = new SqliteMemoryStore(db, embedder);
  const lineToNodeId = await loadCorpus(store, corpusPath);
  // 생성자 옵션 추가 시 flat/ext 양쪽 동시 갱신(harness-flat.ts runHarness 참조) —
  // 한쪽만 늘리면 같은 파이프라인을 잰다는 전제가 조용히 깨진다.
  const retriever = new HybridRetriever(store, embedder, {
    synonymDict: options.synonymDict,
  });

  const variantSnapshots: ExtVariantSnapshot[] = [];
  for (const [variant, mask] of Object.entries(variants)) {
    variantSnapshots.push(
      await runExtVariant(
        retriever,
        variant,
        mask,
        lineToNodeId,
        options.tuning,
        options.limit ?? EXT_RETRIEVAL_LIMIT,
      ),
    );
  }
  db.close();

  return {
    takenAt: new Date().toISOString(),
    embedderDim: embedder.dimension,
    corpusLines: lineToNodeId.size,
    queryCount: EVAL_QUERIES_EXT.length,
    variants: variantSnapshots,
  };
}
