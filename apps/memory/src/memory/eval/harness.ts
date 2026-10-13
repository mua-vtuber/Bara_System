/**
 * memory/eval/harness.ts — 검색 평가 harness (상위 spec 단락 5.8).
 *
 * corpus 를 별도 임시 DB 에 적재(운영 DB 불변경) → 실제 HybridRetriever 통과
 * → 채널 토글 sweep → nDCG/recall/MRR JSON snapshot. 측정 대상 = 임베딩 모델
 * 단독이 아니라 실제 RRF 파이프라인 출력(단락 5.8.2).
 *
 * P3 G5-a — 본문은 갈래별 모듈 4개로 분할하고, 이 파일은 옛 import 경로
 * (`./harness.ts`)의 export 심볼을 이름 그대로 유지하는 파사드로 남긴다(동작 불변).
 *  - harness-flat.ts         : flat 코퍼스 sweep + 공용 타입(ChannelMask 등)
 *  - harness-enriched.ts     : enriched 코퍼스 적재·sweep
 *  - harness-reranker.ts     : +reranker variant(POST-RRF 재정렬) 측정
 *  - harness-cue-polarity.ts : cue·polarity 분별력 sweep
 *  - harness-ext.ts          : 확장 손 정답 셋 6-metric sweep(T2 동결 기준선)
 */
export {
  SWEEP_VARIANTS,
  loadCorpus,
  runVariant,
  runHarness,
} from "./harness-flat.ts";
export type {
  ChannelMask,
  QueryScore,
  VariantSnapshot,
  EvalSnapshot,
} from "./harness-flat.ts";

export {
  ENRICHED_SWEEP_VARIANTS,
  DEFAULT_ENRICHED_RETRIEVAL_LIMIT,
  loadEnrichedCorpus,
  runEnrichedVariant,
  runEnrichedHarness,
} from "./harness-enriched.ts";

export {
  runRerankerVariant,
  runEnrichedRerankerVariant,
  rerankerMeasuredWin,
} from "./harness-reranker.ts";
export type { RerankerVariantOptions } from "./harness-reranker.ts";

export {
  CUE_POLARITY_VARIANTS,
  CUE_POLARITY_RETRIEVAL_LIMIT,
  buildPolarityMap,
  runCuePolarityVariant,
  runCuePolarityHarness,
} from "./harness-cue-polarity.ts";
export type { CuePolarityVariant } from "./harness-cue-polarity.ts";

export {
  EXT_CORPUS_PATH,
  EXT_RETRIEVAL_LIMIT,
  EXT_TIGHT_RETRIEVAL_LIMIT,
  runExtVariant,
  runExtHarness,
} from "./harness-ext.ts";
export type {
  ExtQueryScore,
  ExtVariantSnapshot,
  ExtEvalSnapshot,
} from "./harness-ext.ts";
