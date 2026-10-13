/**
 * memory/eval/harness-cue-polarity.ts — cue·polarity 분별력 sweep (P3 G5-a 분할).
 *
 * harness.ts 파사드의 cue·polarity 갈래 본문(공통 인프라 1.1c T1 측정 토대 / T2
 * cue 실배선) — 동작 불변.
 *
 * 1.1b enriched 코퍼스는 vector-only recall 이 포화라 cue·polarity 순효과를 못
 * 잰다. 1.1c T1 이 더한 EQ5(관계 cue + graph-hop 정답)·EQ6(polarity 분별)가
 * cue/polarity variant 가 점수를 올릴 수 있는 틈을 낸다. 이 sweep 은 그 틈을
 * 숫자로 보인다.
 *
 * cue-on 은 T2 실배선 후 retriever 의 실제 정규식 검출(detectCues)에 맡긴다 —
 * EQ5 query("왜 바꿨더라")의 관계 cue 가 자동으로 graph boost 를 올려 graph-hop
 * 답을 끌어올린다. cue-off 는 graphBoost 1.0 을 명시해 그 가중치 적용을 끈 중립
 * 기준선이다(cue 검출은 항상 가동하되 가중치 적용만 게이트 — measured-win gate).
 * polarity-filter 는 T3 실배선 후 retriever 의 실제 후보 축소(RetrieveOptions.polarity)
 * 에 맡긴다 — query.polarity 를 retrieve 에 전달하면 retriever 가 RRF 합산 전 후보
 * pool 을 polarity 일치 노드로 줄인다(NULL·불일치 제외). 옛 후처리 시뮬레이션(retrieve
 * 결과를 polarity 라벨로 거르던 방식)은 T3 실배선으로 대체됐다 — 같은 분별력을
 * 실제 검색 경로로 측정한다(plan T3 측정 게이트).
 */
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../retriever.ts";
import type { Embedder } from "../../embedding/types.ts";
import type { RetrieveTuning } from "../retriever.ts";
import { computeNdcg, computeRecallByGroup, computeMrr } from "./metrics.ts";
import {
  ENRICHED_QUERIES,
  toEnrichedAnswerGroups,
  mapKeyGroupsToNodeIds,
} from "./answer-map.ts";
import { ENRICHED_NODES } from "../../../test-fixtures/sandbox/enriched-corpus.ts";
import type { Polarity } from "../types.ts";
import type {
  ChannelMask,
  QueryScore,
  VariantSnapshot,
  EvalSnapshot,
} from "./harness-flat.ts";
import { loadEnrichedCorpus } from "./harness-enriched.ts";

/**
 * cue·polarity variant 한 줄. mask 위에 cue-on / polarity-filter 토글.
 *  - cueOn        : true 이면 tuning 미지정으로 retriever 의 실제 cue 검출에 맡긴다
 *                   (1.1c T2 실배선) / false 이면 graphBoost 1.0 명시로 cue 가중치 끔.
 *  - polarityFilter: true 이면 query.polarity 를 retrieve 의 RetrieveOptions.polarity
 *                   로 전달해 retriever 가 RRF 합산 전 후보를 polarity 로 줄인다
 *                   (NULL·불일치 제외 — 1.1c T3 실배선). false 면 polarity 미전달.
 */
export interface CuePolarityVariant {
  mask: ChannelMask;
  cueOn: boolean;
  polarityFilter: boolean;
}

/**
 * cue·polarity sweep variant 집합. 운영 default(중립) 대비 cue-on / polarity-filter
 * 를 따로 켜 분별력을 측정한다. 좁은 창(retrievalLimit)에서 cue 틈이 드러난다.
 *  - cue-off        : 전 채널 ON + cue 중립(graph boost 1.0) — 운영 default 기준.
 *  - cue-on         : 전 채널 ON + 관계 cue graph boost 적용 — cue 효과 측정.
 *  - polarity-off   : 전 채널 ON + polarity 필터 미적용 — 운영 default 기준.
 *  - polarity-on    : 전 채널 ON + polarity 필터 적용 — polarity 분별 측정.
 */
export const CUE_POLARITY_VARIANTS: Record<string, CuePolarityVariant> = {
  "cue-off": {
    mask: { vector: true, fts: true, graph: true, concept: true },
    cueOn: false,
    polarityFilter: false,
  },
  "cue-on": {
    mask: { vector: true, fts: true, graph: true, concept: true },
    cueOn: true,
    polarityFilter: false,
  },
  "polarity-off": {
    mask: { vector: true, fts: true, graph: true, concept: true },
    cueOn: false,
    polarityFilter: false,
  },
  "polarity-on": {
    mask: { vector: true, fts: true, graph: true, concept: true },
    cueOn: false,
    polarityFilter: true,
  },
};

/**
 * cue 분별 측정용 좁은 retrieval 창. 1.1b 의 기본 창(20)은 작은 코퍼스에서 거의
 * 모든 노드를 회수해 recall 이 포화한다. graph-hop 정답(theme_reason)이 cue 중립일
 * 때 창 밖에 머무는 틈을 내려면 더 좁은 창이 필요하다. spec 5.8 의 좁은 창 측정
 * 정신(개념 채널 trade-off 가 좁은 창에서 드러남)과 정합.
 */
export const CUE_POLARITY_RETRIEVAL_LIMIT = 4;

/**
 * 코퍼스 정의(ENRICHED_NODES)의 polarity 라벨을 nodeId 키 맵으로 옮긴다.
 * polarity-filter variant 가 retrieve 결과를 이 맵으로 후처리 거른다.
 *
 * rowToNode 가 polarity 를 도메인 노드에 노출하는 것은 T3 몫이다 — T1 은 코퍼스
 * 정의에서 직접 읽어 측정 토대를 자족적으로 세운다(운영 코드 도메인 미노출).
 */
export function buildPolarityMap(
  keyToNodeId: ReadonlyMap<string, number>,
): Map<number, Polarity | undefined> {
  const polarityById = new Map<number, Polarity | undefined>();
  for (const node of ENRICHED_NODES) {
    const id = keyToNodeId.get(node.key);
    if (id === undefined) {
      throw new Error(`buildPolarityMap: 노드 key "${node.key}" 매핑 없음`);
    }
    polarityById.set(id, node.polarity);
  }
  return polarityById;
}

/**
 * cue·polarity variant 한 갈래의 점수표. EQ1~EQ6 를 좁은 창으로 채점한다.
 *  - cueOn=true        : retriever 의 실제 cue 검출(detectCues)에 맡긴다 — tuning
 *                        미지정이면 retriever 가 query 의 관계·주제 cue 를 자동
 *                        검출해 graph boost 를 올린다(1.1c T2 실배선).
 *  - polarityFilter=true: query.polarity 가 있는 query 의 결과를 polarity 라벨로
 *                        거른다(라벨 일치 노드만 ranked 에 남김).
 *
 * cue-off 격리(1.1c T2 실배선 후 갱신): T2 가 cue 검출을 retriever 에 배선하면서,
 * tuning 미지정일 때 EQ5 query("왜 바꿨더라")의 관계 cue 가 *자동* 으로 graph boost
 * 를 올린다. 그래서 진짜 cue-off(중립)는 tuning.graphBoost=1.0 을 *명시* 해 cue 의
 * 가중치 적용을 끈 상태로 측정한다(retriever 우선순위 규칙 — graphBoost 명시 시 cue
 * 미적용). cue 검출 자체(정규식)는 항상 가동하되 가중치 적용만 게이트(plan 회귀
 * 함정 3 / measured-win gate 정신).
 *
 * polarity-filter(1.1c T3 실배선 후 갱신): polarityFilter=true 이고 q.polarity 가
 * 있으면 retrieve 의 RetrieveOptions.polarity 로 전달한다 — retriever 가 RRF 합산
 * 전 후보를 polarity 로 줄인다(NULL·불일치 제외). polarityById 는 더 이상 후처리
 * 필터에 쓰지 않고, 측정 코퍼스의 polarity 라벨이 도메인 노드(rowToNode)로도 정합
 * 노출되는지 교차 확인용 참조로만 남긴다(T3 가 rowToNode 매핑을 더했다).
 */
export async function runCuePolarityVariant(
  retriever: HybridRetriever,
  variant: string,
  config: CuePolarityVariant,
  keyToNodeId: ReadonlyMap<string, number>,
  polarityById: ReadonlyMap<number, Polarity | undefined>,
  retrievalLimit: number = CUE_POLARITY_RETRIEVAL_LIMIT,
): Promise<VariantSnapshot> {
  // cue-on = graphBoost 미지정 → retriever 가 실제 정규식 검출로 graph boost 자동 적용.
  // cue-off = graphBoost 1.0 명시 → cue 가중치 적용을 끈 중립 기준선(가중치 게이트).
  //
  // 두 갈래 모두 precisionStrengthWeight=0 으로 T4(강도-반영 정밀 재채점)를 끈다 —
  // cue·polarity 분별을 *격리* 측정하기 위해서다. T4 는 유사도 채널 보정 강도를
  // finalScore 에 가산하는 직교 채널이라(설계 §4.2), 운영 default(λ=0.2)로 켜두면
  // 좁은 창(retrievalLimit 4)에서 vector-유사 노드를 끌어올려 graph-hop 정답(EQ5
  // theme_reason)을 창 밖으로 밀어내 cue 의 graph-boost 순효과를 가린다. cue-on
  // 은 graphBoost 를 *지정하지 않으므로* precisionStrengthWeight 만 0 으로 둬도
  // 정규식 cue 자동 검출은 그대로 가동한다(retriever 우선순위 규칙 정합). T4 측정
  // 권위는 magnitude-fusion-regression.test.ts.
  const tuning: RetrieveTuning = config.cueOn
    ? { precisionStrengthWeight: 0 }
    : { graphBoost: 1.0, precisionStrengthWeight: 0 };

  // polarityById 는 T3 실배선 후 후처리 필터에 안 쓴다 — retriever 가 후보 축소를
  // 담당한다. 측정 토대 자족성 교차 확인용으로만 참조한다(아래 void 로 명시).
  void polarityById;

  const perQuery: QueryScore[] = [];
  for (const q of ENRICHED_QUERIES) {
    const groups = mapKeyGroupsToNodeIds(toEnrichedAnswerGroups(q), keyToNodeId);
    // polarity-filter 실배선(1.1c T3) — polarityFilter=true 이고 q.polarity 가 있으면
    // RetrieveOptions.polarity 로 전달해 retriever 가 RRF 합산 전 후보를 줄인다.
    // 미지정 query 는 polarity 미전달 → 필터 미적용(전 후보 통과 / 동작 불변).
    const usePolarity =
      config.polarityFilter && q.polarity ? q.polarity : undefined;
    const results = await retriever.retrieve(q.query, {
      limit: retrievalLimit,
      channelMask: config.mask,
      tuning,
      ...(usePolarity ? { polarity: usePolarity } : {}),
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
    mask: config.mask,
    avgNdcg: perQuery.reduce((s, q) => s + q.ndcg, 0) / n,
    avgRecall: perQuery.reduce((s, q) => s + q.recall, 0) / n,
    avgMrr: perQuery.reduce((s, q) => s + q.mrr, 0) / n,
    perQuery,
  };
}

/**
 * cue·polarity harness — 임시 :memory: DB 적재 + CUE_POLARITY_VARIANTS sweep +
 * snapshot 조립. enriched runEnrichedHarness 와 평행 구조(운영 DB 불변경).
 *
 * 세 번째 기준선 — cue/polarity variant 가 운영 default(중립) 대비 EQ5·EQ6 에서
 * 분별력을 갖는지 측정한다(T2·T3 가 실제 메커니즘을 배선하기 전 측정 토대).
 */
export async function runCuePolarityHarness(
  embedder: Embedder,
  options: {
    variants?: Record<string, CuePolarityVariant>;
    retrievalLimit?: number;
  } = {},
): Promise<EvalSnapshot> {
  const variants = options.variants ?? CUE_POLARITY_VARIANTS;
  const retrievalLimit = options.retrievalLimit ?? CUE_POLARITY_RETRIEVAL_LIMIT;

  // 운영 DB 불변경 — 별도 :memory: DB.
  const db: Database = openMemoryDatabase(":memory:", { embeddingDim: embedder.dimension });
  const store = new SqliteMemoryStore(db, embedder);
  const keyToNodeId = await loadEnrichedCorpus(store);
  const polarityById = buildPolarityMap(keyToNodeId);
  const retriever = new HybridRetriever(store, embedder);

  const variantSnapshots: VariantSnapshot[] = [];
  for (const [variant, config] of Object.entries(variants)) {
    variantSnapshots.push(
      await runCuePolarityVariant(
        retriever,
        variant,
        config,
        keyToNodeId,
        polarityById,
        retrievalLimit,
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
