/**
 * HybridRetriever — three-source fusion retrieval with RRF.
 *
 * Sources:
 *   1. Vector similarity   (SqliteMemoryStore.searchByVector — vec0 KNN)
 *   2. Lexical FTS5        (SqliteMemoryStore.searchByFts — prefix-OR query)
 *   3. Graph expansion     (SqliteMemoryStore.getConnectedNodes — BFS)
 *   4. Concept matching    (query→개념 매칭→연결 자산 글 / 1.1a T5)
 *
 * Fusion strategy: **Reciprocal Rank Fusion** (Cormack et al. 2009). Each
 * source emits its own ranked list using its native ordering signal —
 * vector by cosine distance (ascending), FTS by BM25 (descending), graph
 * by maximum edge weight along the BFS path (descending). RRF then sums
 * `1 / (k + rank)` across the three rankings; nodes that appear in more
 * than one source naturally bubble to the top.
 *
 * Post-processing on top of the fused RRF score:
 *   - Recency  : exponential decay applied to the RRF score so that stale
 *                nodes drop relative to recently-accessed ones.
 *   - Importance: small additive boost from each node's importance field.
 *   - Mention boost: short-term boost proportional to mention_count, capped.
 *   - Supersede penalty: nodes that are the target of a 'supersedes' edge
 *                are scaled down — they're "old facts" that newer ones replaced.
 *
 * The chosen design intentionally keeps each source's *internal* ranker
 * native (no 3-factor scoring inside) — that's what makes RRF tuning-free.
 * Stanford 3-factor signals enter as post-processing instead. Decision
 * recorded in docs/status.md (2026-05-15).
 */

import type { Embedder } from "../embedding/types.ts";
import type { SqliteMemoryStore } from "../db/store.ts";
import { computeEffectiveImportance, computeRecency } from "./scoring.ts";
import type { MemoryNode } from "./types.ts";
import type { SynonymDictionary } from "./synonym-dictionary.ts";
import { expandQueryWithSynonyms } from "./query-expansion.ts";
import { expandQueryWithProjectVocab } from "./project-vocab.ts";
import { getMemoryVisibilitySnapshot } from "./shared-memory-read.ts";
// 벡터·FTS 채널의 가시성·필터 공급(통과 집합·제외 방식)은 retrieve-visibility-pushdown.ts 로
// 옮겼다(WP-B1-02 — 가시성 스냅샷 재사용과 제외 방식 KNN).
import {
  hasClassificationFilter,
  planVisibleSupply,
  searchVisibleFts,
  searchVisibleVectors,
} from "./retrieve-visibility-pushdown.ts";
import type { SearchCues } from "./search-cues.ts";
// RRF 순수 함수·상수는 하층 공용 모듈 rrf.ts 로 추출했다(1.1a T2 — db·memory
// 두 층 공용 / 순환 의존 차단). 기존 호출처·테스트가 retriever.ts 에서 가져오던
// 것을 깨지 않게 여기서 re-export 한다(동작 변경 0).
export { RRF_K, reciprocalRankFusion } from "./rrf.ts";
import { RRF_K, reciprocalRankFusion } from "./rrf.ts";
// 설정 해석부(설정 const 60여 개)는 retrieve-config.ts 로 추출했다(H-3 분해).
// RetrieveOptions / RetrieveTuning 타입 정의도 그쪽으로 옮기고 여기서 re-export 해
// 외부 import 표면(`{ RetrieveTuning } from "./retriever.ts"`)을 보존한다.
export type { RetrieveOptions, RetrieveTuning } from "./retrieve-config.ts";
import {
  resolveRetrieveConfig,
  type RetrieveOptions,
} from "./retrieve-config.ts";
// 채널 수집 4개는 retrieve-channels.ts 자유 함수로 추출했다(H-3 분해 후속 — 800줄
// 천장 정착). retrieve() 가 this.store 를 첫 인자로 넘겨 호출한다(동작 변경 0).
import {
  collectConceptChannel,
  collectImageVecChannel,
  collectProjectChannel,
  collectPersonChannel,
} from "./retrieve-channels.ts";
// 후처리 점수 루프는 retrieve() 안에 그대로 남는다(불변식 2 / byte 동일). 그 루프가
// 직접 읽는 search-tuning 상수·calibration 타입만 여기서 import 한다.
import {
  COSINE_THEORETICAL_MIN,
  type CalibrationMethod,
} from "./search-tuning.ts";
import {
  calibrateTmm,
  calibrateDbsf,
  applyBaselineFloor,
  CALIBRATION_FLOOR,
} from "./calibration.ts";
// 노드별 점수 조립 순수 함수는 retrieve-assemble.ts 로 추출했다(L7 분해 — retrieve()
// step 9 루프 본체 byte 동일). 식·결합 순서·placeScore 두 갈래 분기가 그 함수 안에 있다.
import { assembleNodeScore } from "./retrieve-assemble.ts";
// 질의 임베딩 LRU 캐시 — 배치 결정·모델 교체 안전·복사 규약은 그 모듈 헤더 참조.
import { QueryEmbeddingCache, embedQueryCached } from "./query-embedding-cache.ts";
import { StageTimer, buildRetrieveTimings, type RetrieveStageTimings } from "./stage-timer.ts";

// ── Tunables ─────────────────────────────────────────────────────────────
//
// 검색 튜닝 상수는 leaf 모듈 retrieve-constants.ts 로 추출했다(H-3 분해 — retriever.ts
// 와 retrieve-config.ts 가 함께 읽어 순환 의존을 끊는다). 외부 import 표면을 보존하기
// 위해 여기서 그대로 re-export 한다(동작 변경 0).
export {
  DEFAULT_VECTOR_K,
  DEFAULT_FTS_LIMIT,
  DEFAULT_GRAPH_LIMIT,
  DEFAULT_GRAPH_SEED_TOP,
  DEFAULT_CONCEPT_FTS_LIMIT,
  DEFAULT_CONCEPT_VECTOR_K,
  DEFAULT_CONCEPT_NODE_LIMIT,
  PARENT_OF_EXPANSION_MIN_WEIGHT,
  PARENT_OF_EXPANSION_LIMIT,
  DEFAULT_IMAGE_VEC_K,
  DEFAULT_PROJECT_FTS_LIMIT,
  DEFAULT_PROJECT_VECTOR_K,
  DEFAULT_PERSON_FTS_LIMIT,
  DEFAULT_PERSON_VECTOR_K,
  DEFAULT_PROJECT_NODE_LIMIT,
  DEFAULT_GRAPH_MAX_HOPS,
  DEFAULT_RETRIEVAL_LIMIT,
  DEFAULT_RECENCY_HALF_LIFE_DAYS,
  DEFAULT_IMPORTANCE_HALF_LIFE_DAYS,
  MENTION_BOOST_PER_COUNT,
  MENTION_BOOST_CAP,
  SUPERSEDE_PENALTY,
  W_RRF,
  W_RECENCY,
  W_IMPORTANCE,
} from "./retrieve-constants.ts";
// 점수 결합 상수(MENTION_BOOST_*·SUPERSEDE_PENALTY·W_RECENCY·W_IMPORTANCE·PLACE_SOFT_
// BOOST_*)는 노드별 점수 조립을 옮겨간 retrieve-assemble.ts 가 직접 import 한다(L7 분해).
// retriever 본체는 더 이상 이 값들을 직접 읽지 않아 값-import 를 제거했다 — 위 re-export
// 블록은 외부 import 표면(retriever.test.ts 등) 보존용으로 그대로 둔다(동작 변경 0).

// ── Public surface ───────────────────────────────────────────────────────

export type RetrievalSource =
  | "vector"
  | "fts"
  | "graph"
  | "concept"
  | "imageVec"
  | "project"
  | "person";

export interface RetrievalResult {
  node: MemoryNode;
  /** Final fused score after post-processing. Higher = better. */
  score: number;
  /** Every source that contributed to this node's score. */
  sources: RetrievalSource[];
  /** Component breakdown for debugging / future tuning. */
  components: {
    rrf: number;
    boostedRrf: number;
    bm25Cross: number;
    recency: number;
    importance: number;
    mentionBoost: number;
    supersedePenalty: number;
    /**
     * 강도-반영 정밀 재채점 가산값(설계 §4.2 / T4) = λ × (보정 강도 결합값).
     * λ=0(운영 default 가 0 이면)이면 0 → 현행 RRF 와 동일. 디버깅·후속 sweep 위해
     * 채널 boostedRrf 와 분리해 기록한다.
     */
    precisionStrength: number;
    /**
     * 정규식 cue 검출이 graph 채널에 적용한 가중치(1.0 = 중립). 1.1c T2 —
     * 관계/주제 cue 검출 시 RELATION/TOPIC_CUE_GRAPH_BOOST 를 적용한다(2026-07-10
     * 중립화로 둘 다 1.0 — search-tuning.ts 이력 주석 / 검출·기록 인프라는 유지).
     * sweep 명시 graphBoost 오버라이드가 있으면 cue 는 적용하지 않으므로 1.0
     * 으로 기록한다.
     */
    cueGraphBoost: number;
    /**
     * 보정 *전* raw vector cosine(= 1 - cosine distance). audit 표시 전용 —
     * baseline floor 의 바닥선 값을 데이터로 정하기 위한 노출(강도-반영 융합
     * §8.3 후속 / D-N2). vector 채널에 안 뜬 노드는 undefined(칸 미포함) —
     * "채널에 안 뜸"과 "cosine 0"을 구분한다(0 은 실제 raw 값일 때만 기록).
     * 점수·순위·정밀강도 계산엔 안 쓴다 — 이미 계산된 raw 값을 읽어 담을 뿐이다.
     */
    vectorRawCosine?: number;
    /**
     * 보정 *전* raw imageVec(SigLIP) cosine(= 1 - cosine distance). audit 표시
     * 전용 — vectorRawCosine 과 같은 양식. imageVec 채널에 안 뜬 노드는 undefined.
     */
    imageVecRawCosine?: number;
  };
}

// RetrieveTuning / RetrieveOptions 타입 정의는 retrieve-config.ts 로 옮겼다(H-3
// 분해 — 순환 의존 차단). 위 export type 줄이 외부 import 표면을 보존한다.

/**
 * retrieve() 파이프라인의 계측값 out-channel(T10 — 검색 메타 spec B).
 *
 * 라우트가 processing_info 응답 칸을 조립할 때 *이미 retrieve() 안에서 계산된*
 * 값을 그대로 노출한다(D-D — 추가 DB 조회·재계산 0). 계약:
 *   - totalFound     : 공급 단계 필터를 통과한 후보 수 — 7채널이 같은 통과 Set(pending_review·
 *                       가시성·polarity·분류·dateRange·memoryType·kind·fieldFilters)을 거친 뒤의
 *                       합집합 크기(fusedRrf.size). 약점: 필터가 몇 개를 걸러냈는지는 이 값으로
 *                       알 수 없다(2026-10 사용자 결정, 옵션 A).
 *   - afterFiltering : 위 후보로 조립한 결과 수(trim 전, results.length) — 여기서는 totalFound 와
 *                       같다. T20 하한선이 돌면 라우트가 생존자 수로 바꿔 더 작아진다.
 *   - returned       : trim(step 10, limit 적용) 후 실제 반환된 결과 수. 호출부가
 *                       trimmed.length 를 그대로 읽으면 되므로 여기 채우지 않는다 —
 *                       라우트가 retrieve() 반환 배열 길이로 직접 채운다.
 */
export interface RetrieveStats {
  totalFound: number;
  afterFiltering: number;
}

/** retrieveWithStats() 반환 묶음 — results 는 retrieve() 와 완전히 동일한 배열. */
export interface RetrieveWithStatsResult {
  results: RetrievalResult[];
  stats: RetrieveStats;
  /** 단계별 시간 — 검색 캐시에 저장하지 않는다(호출부가 stats 만 캐시에 넣는다). */
  timings: RetrieveStageTimings;
}

// ── Pure RRF ─────────────────────────────────────────────────────────────
//
// reciprocalRankFusion·RRF_K 는 rrf.ts 로 추출했다(위 re-export 참조). 단위
// 테스트(retriever.test.ts)는 여전히 retriever.ts 에서 import 한다 — re-export
// 가 그 단언을 보존한다.

/**
 * Return the top-N seed ids by summed score from two ranked maps. Used
 * to feed the graph BFS — we want the most confident hits across vector
 * and FTS as starting points.
 */
export function pickGraphSeeds(
  vectorRrf: Map<number, number>,
  ftsRrf: Map<number, number>,
  topN: number,
): number[] {
  const merged = new Map<number, number>();
  for (const [id, v] of vectorRrf) merged.set(id, v);
  for (const [id, v] of ftsRrf) merged.set(id, (merged.get(id) ?? 0) + v);
  return [...merged.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([id]) => id);
}

// ── HybridRetriever class ────────────────────────────────────────────────

/**
 * HybridRetriever 생성자 옵션. 선택적 — 미주입이면 기존 동작 불변.
 *
 * synonymDict 를 주입하면 fts 계열 채널(searchByFts·searchConceptsByFts) 입력
 * query 만 동의어로 확장한다(D9 / spec 13.3). 임베딩 채널 query 는 원본 그대로.
 * 미주입이면 expansion 이 0이라 1.1a 동작과 동일하다(자연 degrade). 운영 부팅
 * 주입은 T6 — T2 시점은 생성자 옵션 칸 + 테스트/harness 주입까지.
 */
export interface HybridRetrieverOptions {
  synonymDict?: SynonymDictionary;
  /**
   * 정규식 cue 추가 어휘(search-cues.yaml 로드 산출). 미주입이면 builtin 정규식만
   * 가동한다(1.1c T2 — builtin 은 코드 상수라 항상 검출 / 자연 degrade). 운영
   * 부팅 주입은 search 라우트 통합(T5). detectCues 가 query 검사 시 합집합으로 쓴다.
   */
  searchCues?: SearchCues;
  /**
   * 글 유사도(vector) 채널 절대 baseline cosine 의 *모델 연동 운영 default*
   * (2026-06-01 bge-m3 정식 전환). server.ts 가 선택 임베딩 모델에서
   * vectorBaselineOf(model) 로 구한 값을 넣는다(bge-m3 → 0.5 / bge-m3 →
   * 0.17). 차원이 모델에서 자동으로 정해지는 것과 같은 양식 — 모델을 바꾸면
   * baseline 도 따라 바뀐다.
   *
   * retrieve() 의 baseline 우선순위: sweep tuning.vectorBaseline > 운영
   * options.vectorBaseline(settings 가 0..1 로 명시 오버라이드) > 이 모델 연동
   * default > search-tuning.ts VECTOR_COSINE_BASELINE(모델조차 모르는 최후
   * fallback). 미주입이면 기존 동작 그대로 — 모듈 상수가 최후 fallback 으로 가동.
   */
  defaultVectorBaseline?: number;
}

export class HybridRetriever {
  // readonly 를 뺀다 — reloadSynonymDict 가 부팅 후 사전을 통째로 교체할 수 있어야
  // 한다. 다른 두 칸(searchCues·defaultVectorBaseline)은 그대로 readonly 보존.
  private synonymDict?: SynonymDictionary;
  private readonly searchCues?: SearchCues;
  private readonly defaultVectorBaseline?: number;
  /** 질의 임베딩 LRU 캐시 — embedder 필드(private readonly)와 같은 인스턴스 수명이라
   *  모델 교체 = 새 retriever 생성 → 다른 차원 stale 벡터 적중이 구조적으로 불가.
   *  외부는 관측(stats())만 — set/get 직접 호출은 지원 경로 아님. */
  readonly queryEmbeddingCache = new QueryEmbeddingCache();

  constructor(
    private readonly store: SqliteMemoryStore,
    private readonly embedder: Embedder,
    options: HybridRetrieverOptions = {},
  ) {
    this.synonymDict = options.synonymDict;
    this.searchCues = options.searchCues;
    this.defaultVectorBaseline = options.defaultVectorBaseline;
  }

  /**
   * 동의어 사전을 통째로 교체한다(웨이브3 항목12 B2 Step2). 대시보드 동의어 탭에서
   * 사용자가 쌍을 추가·삭제하면 server.ts 가 yaml+user 행을 다시 합쳐(mergeSynonymDict)
   * 이 메서드로 *같은 retriever 인스턴스* 의 사전을 갈아끼운다. 그래서 재시작 없이
   * 다음 검색부터 새 동의어가 fts 계열 채널 query 확장에 반영된다.
   *
   * 이 교체는 fts 계열 채널(searchByFts·searchConceptsByFts) 입력 query 확장 한 곳에만
   * 닿는다 — 랭킹·점수·RRF·임베딩 채널 query 는 전혀 건드리지 않는다(additive / D9·spec 13.3).
   */
  reloadSynonymDict(dict: SynonymDictionary): void {
    this.synonymDict = dict;
  }

  /**
   * retrieve() 의 얇은 래퍼 — 기존 호출부(search-retrieval.ts 등)의 시그니처를
   * 그대로 보존한다(T10 이전 동작 byte 동일). stats out-channel 이 필요한
   * 호출부는 retrieveWithStats() 를 대신 쓴다. 두 메서드는 같은 내부 로직을
   * 공유하므로 점수·순위·후보 계산은 완전히 동일하다(중복 구현 0).
   */
  async retrieve(
    query: string,
    options: RetrieveOptions = {},
  ): Promise<RetrievalResult[]> {
    const { results } = await this.retrieveWithStats(query, options);
    return results;
  }

  /**
   * retrieve() 와 동일한 검색을 수행하되, processing_info 조립에 필요한 계측값을
   * 함께 반환한다(T10 — 검색 메타 spec B). RRF 코어·점수식·필터 로직은 한 글자도
   * 안 건드린다 — stats 는 이미 계산되는 중간값을 담아 회신할 뿐이다.
   */
  async retrieveWithStats(
    query: string,
    options: RetrieveOptions = {},
  ): Promise<RetrieveWithStatsResult> {
    // 설정 해석부(설정 const 60여 개)는 retrieve-config.ts 로 추출했다(H-3 분해).
    // 모든 `?? 모듈상수` fallback 체인·cue 적용 규칙·mask `?? true` 정규화가 그
    // 순수 함수 안에 byte 동일하게 들어간다. 아래에서 config.X 로 참조하고, 자주
    // 쓰는 값만 구조분해해 읽는다(값은 동일).
    const timer = new StageTimer();
    const config = resolveRetrieveConfig(query, options, {
      defaultVectorBaseline: this.defaultVectorBaseline,
      searchCues: this.searchCues,
    });
    const {
      limit,
      vectorK,
      ftsLimit,
      graphMaxHops,
      graphLimit,
      graphSeedTop,
      halfLifeDays,
      importanceHalfLifeDays,
      effectiveRrfBlendWeight,
      effectiveBm25CrossWeight,
      cueGraphBoostFactor,
      effectiveGraphBoost,
      effectiveBm25Boost,
      effectiveVectorBoost,
      effectiveConceptBoost,
      effectiveImageVecBoost,
      missingRankFloor,
      effectivePrecisionWeight,
      effectiveMentionBoostPerCount,
      effectivePrecisionMode,
      effectiveVectorCalibration,
      effectiveImageVecCalibration,
      effectiveBaselineFloorMode,
      effectiveVectorBaseline,
      effectiveImageVecBaseline,
      mask,
    } = config;

    // 1. project expansion(D8) — BM25 + 임베딩 둘 다 합류(spec 5.4).
    //    synonym(BM25 한정)과 달리 project expansion 은 임베딩 입력에도 합류한다.
    //    미지정 = baseQuery = query 그대로 → 1.1a 동작 불변(자연 degrade).
    let baseQuery = query;
    if (options.project) {
      const vocab = this.store.loadProjectVocab(options.project); // store facade 위임 — retriever 는 db 직접 접근 X
      baseQuery = expandQueryWithProjectVocab(query, vocab);
    }

    // 1.5 임베딩 채널 = project 확장 baseQuery 로 임베딩(원본+expanded_meaning 합친
    //     텍스트로 1회). synonym 은 여기 합류 X — spec 13.3 중복 가중 회피.
    //     같은 baseQuery 반복 검색은 LRU 적중으로 모델 재실행(실측 37~60ms)을 건너
    //     뛴다. 키 = 확장 *후* 텍스트라 project vocab 이 바뀌면 키도 달라져 stale 없음.
    timer.lap("prepMs");
    const embedHitsBefore = this.queryEmbeddingCache.stats().hits;
    const queryVec = await embedQueryCached(
      this.queryEmbeddingCache,
      this.embedder,
      baseQuery,
    );
    timer.lap("embedMs");
    const embedCacheHit = this.queryEmbeddingCache.stats().hits > embedHitsBefore;

    // 1.6 fts 계열 채널 입력 query — baseQuery 위에 synonym 확장(BM25 한정).
    //     미주입이면 baseQuery 그대로(1.1a 동작 불변). 임베딩 입력(queryVec)과는
    //     *분리된 변수* — D9 / spec 13.3 의 핵심 회귀 함정 차단.
    const ftsQuery = this.synonymDict
      ? expandQueryWithSynonyms(baseQuery, this.synonymDict)
      : baseQuery;

    // 1.8 벡터·FTS 채널의 가시성·필터 공급(T4 재판정 계약 + WP-B1-02 제외 방식).
    //
    //     풀려는 문제 — 사후 필터(step 4.5)는 채널이 이미 상위 k 개로 *잘라낸* 후보만
    //     걸러낸다. 그래서 필터를 통과하는 최선의 글이 전역 상위 k 밖에 있으면 그 글은
    //     필터에 도달조차 못 하고, 검색은 답이 DB 에 있는데도 빈 결과를 돌려준다
    //     (T3 §3-2 실측: 39문항 중 27건 빈 결과, 회수율 0.2821). 그래서 KNN 전에 허용
    //     노드를 알려 준다. sqlite-vec 의 `node_id IN` 은 `|통과 집합| <= k` 일 때만
    //     pre-filter 로 동작하므로(T4 1차 실측 반증) 통과 집합은 VEC0_MAX_K 조각으로
    //     나눠 순위화한다 — 크기 임계로 사후 필터에 내리는 갈래는 두지 않는다((B) 재정
    //     2026-08-03, 근거와 조각 수별 실측은 search-repo-vec-fts.ts VEC0_MAX_K).
    //
    //     갈래 세 개(unfiltered / exclusion / passSet)는 결과가 같고 비용만 다르다 —
    //     retrieve-visibility-pushdown.ts 헤더. 필터가 없고 제외 노드도 없으면 현행
    //     질의(ORDER BY distance LIMIT ?)를 글자 그대로 돌린다(회귀 0).
    //
    //     가시성은 스냅샷에서 읽는다 — 가시성 변경 번호(v43 트리거)가 같고 유효 구간
    //     안이면 knowledge_nodes 를 다시 훑지 않는다(shared-memory-read.ts).
    //
    //     검색 캐시 키(SearchCacheKeyInput) — 갈래 선택은 (필터 칸, 가시성 스냅샷,
    //     pending_review)의 결정 함수이고 결과는 갈래와 무관하다. 가시성 변화는
    //     visibilityGeneration·validityEpoch 칸, 그 밖의 DB 변경은 dbRevision 칸이 가른다.
    const visibilitySnapshot = getMemoryVisibilitySnapshot(this.store);
    const visibility = visibilitySnapshot.view(options.scope, options.includeInactive);
    const supply = planVisibleSupply(this.store, options, visibilitySnapshot, visibility, vectorK);

    // 2. Run vector + FTS in parallel — they don't depend on each other.
    //    마스크가 끈 채널은 빈 배열로 대체해 RRF 합류에서 빠진다. 벡터=queryVec
    //    (project 확장 baseQuery 임베딩 / synonym 은 합류 X) / fts=ftsQuery
    //    (baseQuery 위에 synonym 확장한 글자 query) — 입력 분리.
    // let — step 4.5 polarity 필터가 hits 를 polarity 통과 후보로 재할당할 수 있다.
    // 두 공급 모두 상위 vectorK·ftsLimit 로 잘라 돌려준다(retrieve-visibility-pushdown.ts).
    timer.lap("planMs");
    let [vectorHits, ftsHits] = await Promise.all([
      mask.vector
        ? searchVisibleVectors(this.store, supply, options, queryVec, vectorK)
        : Promise.resolve([]),
      mask.fts
        ? searchVisibleFts(this.store, supply, ftsQuery, ftsLimit)
        : Promise.resolve([]),
    ]);

    timer.lap("vectorFtsMs");

    // T2(강도-반영 융합) — vector 채널 원시 cosine 강도 노출. VectorHit.distance
    // 는 cosine distance(0 = 동일 / args-types.ts:49). 강도 = 1 - distance
    // (image-vec-channel.ts:15-16 변환 양식 정합 — 낮은 distance = 높은 강도).
    // *이 task 는 데이터만 노출한다 — 점수 계산엔 안 쓴다(T4 가 정밀 점수에 사용).*
    // 동작·순위·점수 0 변경: 이 맵은 어디서도 읽히지 않는 부수 산출일 뿐이다.
    const vectorMagnitude = new Map<number, number>();
    for (const h of vectorHits) vectorMagnitude.set(h.nodeId, 1 - h.distance);

    // 3. RRF for vector and FTS independently — graph seed 선택에만 사용.
    //    step 5 에서 동일 배열로 bm25RrfRaw/vectorRrfRaw 를 다시 계산하므로
    //    여기서는 seed 선택 목적 변수로만 둔다(중복 계산이지만 캐시 불필요,
    //    pickGraphSeeds 의존성을 분리하기 위함).
    const vectorRrfForSeeds = reciprocalRankFusion([vectorHits.map((h) => h.nodeId)]);
    const ftsRrfForSeeds = reciprocalRankFusion([ftsHits.map((h) => h.nodeId)]);

    // 3.5 개념 채널 — query → 개념(글자+의미) → 연결 자산 글. graph seed 와 무관한
    //     독립 채널. 채널 로직은 retrieve-channels.ts 자유 함수로 추출했다(H-3 분해 —
    //     byte 동일). mask.concept 가 false 면 빈 배열을 회신한다.
    let conceptNodeIds = await collectConceptChannel(this.store, ftsQuery, queryVec, config);
    timer.lap("conceptMs");

    // 3.7 image_vec 채널 — Phase 11b T5. 로직은 collectImageVecChannel 로 추출했다
    //     (H-3 분해 — byte 동일). magnitude 맵을 함께 회신한다 — 후처리 루프의
    //     vectorRawCosine 짝(imageVecRawCosine)·survivingImageVecMag 가 읽는다.
    const { ids: imageVecCandidatesInit, magnitude: imageVecMagnitude } =
      await collectImageVecChannel(this.store, query, config);
    let imageVecCandidates = imageVecCandidatesInit;
    timer.lap("imageVecMs");

    // 3.8 프로젝트 엔티티 채널 — 1.2 T8. 로직은 collectProjectChannel 로 추출했다
    //     (H-3 분해 — byte 동일). mask.project 가 false 면 빈 배열을 회신한다.
    let projectNodeIds = await collectProjectChannel(this.store, ftsQuery, queryVec, config);
    timer.lap("projectMs");

    // 3.9 사람 엔티티 채널 — 1.2 T8. 로직은 collectPersonChannel 로 추출했다
    //     (H-3 분해 — byte 동일). mask.person 이 false 면 빈 배열을 회신한다.
    let personNodeIds = await collectPersonChannel(this.store, ftsQuery, queryVec, config);
    timer.lap("personMs");

    // 4. Graph expansion from top seeds. 마스크가 graph 를 끄면 seed 단계를
    //    통째로 건너뛰어 graphHits 가 빈 배열이 된다.
    const seedIds = mask.graph ? pickGraphSeeds(vectorRrfForSeeds, ftsRrfForSeeds, graphSeedTop) : [];
    let graphHits = seedIds.length === 0
      ? []
      : await this.store.getConnectedNodes(seedIds, {
          maxHops: graphMaxHops,
          limit: graphLimit,
        });
    timer.lap("graphMs");

    // 4.5 후보 축소 필터(RRF 합산 *전*) — pending_review 무조건 제외(6a T9.5 /
    //     결정 #5) + polarity(D7 / spec 5.5 / 1.1c T3) + 학술 분류 filter(spec 5.7 /
    //     1.1c T4). 셋 다 RRF 합산 전에 후보 pool 을 줄이는 필터다(가중치가 아니라
    //     *축소*). 줄인 hits 가 아래 step 5 이후의 모든 RRF 계산에 들어가므로 RRF
    //     동등 합산 코어(rrf.ts)는 시그니처·동작 0 변경 — 입력 후보 pool 만 줄어든다
    //     (plan 회귀 함정 1·4 / [[retriever-fusion-rrf]]).
    //
    //     pending_review 제외는 *무조건* 적용한다 — opt-in 아님. Level 0 정규식이
    //     3~4점 후보를 pending_review atomic 노드로 저장하므로(metadata.pending_review
    //     =true), 검토 전 자산을 검색 결과에서 항상 뺀다. Phase 7 cleanup-AI 가 검토를
    //     마치면 이 칸을 비워 자연 노출된다. 회귀 0 핵심: pending_review 노드가 0건이면
    //     이 통과 Set 이 candidateUnion 전체와 같아 한 노드도 줄지 않고 기존 검색
    //     결과·점수가 완전히 동일하다.
    //
    //     polarity·filter 는 지정 시에만 통과 Set 을 더한다 — 여러 통과 Set 은 채널
    //     hits 가 *모두* 만족해야 살아남으므로 자연히 교집합(AND)이 된다.
    //
    //     polarity NULL 처리: filterNodeIdsByPolarity 가 NULL 노드를 제외한다(라벨된
    //     자산만 — 의도된 필터 의미). filter 매칭 0개·polarity 일치 0개면 모든 채널
    //     hits 가 빈 배열이 되어 step 5 에서 fusedRrf.size === 0 → 빈 결과(에러 아님 /
    //     "그 라벨 자산 없음" = 정직한 빈 상태). 빈 결과를 fallback 으로 안 채운다.
    const hasFilter = hasClassificationFilter(options);
    const candidateUnion = new Set<number>();
    for (const h of vectorHits) candidateUnion.add(h.nodeId);
    for (const h of ftsHits) candidateUnion.add(h.nodeId);
    for (const [id] of graphHits) candidateUnion.add(id);
    for (const id of conceptNodeIds) candidateUnion.add(id);
    for (const id of imageVecCandidates) candidateUnion.add(id);
    for (const id of projectNodeIds) candidateUnion.add(id);
    for (const id of personNodeIds) candidateUnion.add(id);

    // totalFound 는 통과 Set 을 거친 뒤(아래 step 5)에 센다 — candidateUnion.size 는 채널마다 시점이 달랐다.

    // 통과 Set 들을 모은다 — 채널 hits 는 모든 Set 을 통과해야 살아남는다(AND).
    const passSets: ReadonlySet<number>[] = [];

    // (a) pending_review 무조건 제외(6a T9.5 / 결정 #5) — 항상 추가. pending_review
    //     =true 노드만 빠지고 칸 없음·false·NULL 은 통과(0건이면 candidateUnion 전체).
    passSets.push(this.store.filterOutPendingReview([...candidateUnion]));
    if (visibility.allowedIds !== undefined) passSets.push(visibility.allowedIds);

    // (b) polarity 축소(1.1c T3) — 지정 시에만.
    if (options.polarity) {
      passSets.push(
        this.store.filterNodeIdsByPolarity(
          [...candidateUnion],
          options.polarity,
        ),
      );
    }

    // (c) 학술 분류 filter 축소(1.1c T4 / spec 5.7) — 지정 시에만. filter 의
    //     여러 key 는 AND(모든 분류 만족) — 값별 매칭 Set 을 각각 통과 Set 으로
    //     더하면 자연히 교집합이 된다. 값은 concept_nodes.name UNIQUE 로 매칭되며
    //     role 무관(tag·classification 전부)이라 `#만화`/`review:만화` 통합.
    if (hasFilter) {
      for (const value of Object.values(options.filter!)) {
        passSets.push(this.store.getNodeIdsByConceptName(value));
      }
    }

    // (d) 시간 범위 축소(Phase 7 갈래 1 / Task 5) — 지정 시에만. 검색어의 닫힌
    //     시간 표현("지난주"·"5월")을 eventDateRange 가 푼 [since, until] 구간으로
    //     COALESCE(event_at, created_at) 후보를 거른다. polarity·filter 와 같은
    //     통과 Set 이라 함께 지정되면 자연히 교집합(AND)이 된다. 미지정이면 이
    //     Set 을 안 더해 후보가 한 노드도 안 줄어 검색 결과·점수가 도입 전과
    //     byte 동일하다(시간 표현 없는 검색 회귀 0). RRF 코어는 불변.
    if (options.dateRange) {
      passSets.push(
        this.store.filterNodeIdsByDateRange(
          [...candidateUnion],
          options.dateRange.since,
          options.dateRange.until,
        ),
      );
    }

    // (e) memory_type 축소(1.2 T8 / 통일 원칙) — 지정 시에만. polarity·filter·
    //     dateRange 와 같은 통과 Set 이라 함께 지정되면 자연히 교집합(AND)이 된다.
    //     미지정이면 이 Set 을 안 더해 후보가 한 노드도 안 줄어 검색 결과·점수가
    //     도입 전과 byte 동일하다(memory_type 없는 검색 회귀 0). RRF 코어는 불변.
    if (options.memoryType) {
      passSets.push(
        this.store.filterNodeIdsByMemoryType(
          [...candidateUnion],
          options.memoryType,
        ),
      );
    }

    // (f) 종류 축소(활용 단계6 T4) — 지정 시에만. T3b 가 addClassificationTag 로 심은
    //     종류 분류 링크를 store.getNodeIdsByConceptName(kind)(name UNIQUE·role 무관)로
    //     읽어 그 종류 글로 후보를 줄인다. polarity·filter·dateRange 와 같은 통과 Set
    //     이라 함께 지정되면 자연히 교집합(AND)이 된다. 미지정(undefined·빈 문자열)이면
    //     이 Set 을 안 더해 후보가 한 노드도 안 줄어 검색 결과·점수가 도입 전과 byte
    //     동일하다(종류 없는 검색 회귀 0 / 점수식 6파일 미접촉). RRF 코어는 불변.
    if (options.kind !== undefined && options.kind.trim().length > 0) {
      passSets.push(this.store.getNodeIdsByConceptName(options.kind));
    }

    // (g) 종류별 칸 축소(활용 단계6 T4) — 지정 시에만. 각 (키 → 값) 쌍을
    //     store.getNodeIdsByMetadataField(key, value)(T3b 글-칸 정확 일치)로 통과 Set
    //     을 더하면 여러 쌍은 자연히 AND(모든 칸 만족 글). kind 와 함께면 종류·칸이
    //     함께 교집합이 된다. 미지정(undefined·빈 배열)이면 push 자체를 안 해 후보가
    //     한 노드도 안 줄어 검색 결과·점수가 도입 전과 byte 동일하다(칸 없는 검색 회귀
    //     0 / 점수식 6파일 미접촉). RRF 코어는 불변.
    if (options.fieldFilters !== undefined && options.fieldFilters.length > 0) {
      for (const ff of options.fieldFilters) {
        passSets.push(this.store.getNodeIdsByMetadataField(ff.key, ff.value));
      }
    }

    // 채널 hits 를 모든 통과 Set 을 만족하는 노드로 제한(AND / 교집합).
    //
    // 채널 간 비대칭(T4 / 후속 후보): 벡터 채널만 필터 pushdown 이 적용돼 절단 *전*
    // 에 이미 통과 집합 안에서 뽑혔고, 나머지 채널(FTS·graph·concept·imageVec·
    // project·person)은 여전히 여기서 절단 *후* 에 걸러진다. 즉 T3 §3-2 가 잰
    // "정답이 전역 상위 k 밖" 결함은 벡터 채널에서만 해소된 상태다. 다른 채널은
    // 각자 다른 질의 형태(FTS5 는 vec0 가 아니라 JOIN 안 MATCH)를 써서 같은 처치를
    // 그대로 옮길 수 없어 별도 실사가 필요하다 — T3 이 실측한 범위가 벡터 채널까지였다.
    // 벡터 채널에 대한 이 재확인은 무해하다(같은 Set 으로 두 번 거르면 결과 동일 / 멱등).
    const passesAll = (id: number) => passSets.every((s) => s.has(id));
    vectorHits = vectorHits.filter((h) => passesAll(h.nodeId));
    ftsHits = ftsHits.filter((h) => passesAll(h.nodeId));
    graphHits = graphHits.filter(([id]) => passesAll(id));
    conceptNodeIds = conceptNodeIds.filter((id) => passesAll(id));
    imageVecCandidates = imageVecCandidates.filter((id) => passesAll(id));
    projectNodeIds = projectNodeIds.filter((id) => passesAll(id));
    personNodeIds = personNodeIds.filter((id) => passesAll(id));

    // 5. 7채널 통합 RRF — [[retriever-fusion-rrf]] 동등 합산 코어 불변.
    //    reciprocalRankFusion 시그니처·동작 변경 0 (1.2 T8: project·person 두 ranking
    //    추가 — 두 채널이 빈 배열이면 옛 5채널 결과와 수학적 동일 / image_vec 선례).
    //    출처 boost 는 post-RRF 후처리 단계(step 9)에서 채널별 기여에 곱한다.
    const fusedRrf = reciprocalRankFusion([
      vectorHits.map((h) => h.nodeId),
      ftsHits.map((h) => h.nodeId),
      graphHits.map(([id]) => id),
      conceptNodeIds,
      imageVecCandidates,
      projectNodeIds, // 1.2 T8 — 빈 배열이면 수학적 동일(image_vec 채널 선례)
      personNodeIds, // 1.2 T8
    ]);

    // T10 stats — 7채널이 같은 통과 Set 을 거친 합집합이라 fusedRrf.size 가 곧 필터 통과 후보 수(추가 질의·순회 0).
    const totalFound = fusedRrf.size;

    // boost 적용을 위해 채널별 단독 RRF 기여량을 별도 추적한다.
    // 이 Map 들은 통합 RRF 를 바꾸지 않는다 — post-RRF 단계에서만 읽힌다.
    const bm25RrfRaw = reciprocalRankFusion([ftsHits.map((h) => h.nodeId)]);
    const vectorRrfRaw = reciprocalRankFusion([vectorHits.map((h) => h.nodeId)]);
    const graphRrfRaw = reciprocalRankFusion([graphHits.map(([id]) => id)]);
    const conceptRrfRaw = reciprocalRankFusion([conceptNodeIds]);
    const imageVecRrfRaw = reciprocalRankFusion([imageVecCandidates]);

    // T4(강도-반영 정밀 재채점 / 설계 §4.2·§5) — T2 가 노출한 원시 cosine 강도
    // (vectorMagnitude / imageVecMagnitude)를 T3(calibration.ts)으로 *채널 안에서*
    // [0,1] 보정한다. 채널마다 같은 cosine 숫자가 다른 의미라(SigLIP 0.14=좋은 매치
    // vs bge-m3 0.5=글 baseline) 채널 분포 기준으로 "얼마나 강한 매치인가"를 보정해야
    // 채널 간 가산이 공정해진다(설계 §5 / 무-LLM 순수 수학).
    //
    // 보정 대상 = step 4.5 필터를 통과해 fusedRrf 후보가 된 노드만(polarity·분류
    // 필터로 잘려나간 노드는 채널 분포에서도 빠진다 — 통계가 점수 대상과 일치).
    // 빈 입력(채널 hits 0개)·단일 후보·전부 동일값은 calibration.ts 가 안전 처리한다.
    //
    // 누락 채널 floor(설계 §5): 한 채널에만 잡힌 노드(이미지가 imageVec 에만)는
    // 그 채널 보정 Map 에 없으므로 finalScore 합산에서 CALIBRATION_FLOOR 로 채운다
    // (0 으로 뭉개지 않음 — 외톨이 부당 감점 차단). 정밀 강도 미적용(λ=0)이면 이
    // 보정값은 어디서도 안 읽혀 finalScore 가 현행 RRF(T1 baseline)와 byte 동일하다.
    // 채널 강도 보정 + 채널별 절대 baseline floor(D-N2). baseline floor 방식 두 갈래:
    //   - "tmm-min" : calibrateTmm 의 theoreticalMin 을 채널 baseline 으로 올린다 —
    //                 tmm 정규화 하한이 baseline 이라 baseline 이하 raw 가 0 으로 clip.
    //                 dbsf 운영 전환 비교용(측정 후보). 이때 채널 보정 방식은 tmm 고정.
    //   - "gate"    : 운영 보정 방식(dbsf/tmm)으로 보정한 뒤, raw < baseline 인 노드의
    //                 보정 강도를 0 으로 덮는다(applyBaselineFloor). dbsf 분별력 유지 +
    //                 baseline 잡음만 컷. **측정 채택 default.**
    //   - "off"     : baseline floor 미적용 — 운영 보정 방식 그대로(baseline 도입 전 동작).
    // mode="off" 또는 baseline<=0 이면 한 노드도 안 깎여 보정 강도가 도입 전과 동일하다.
    const calibrateChannel = (
      raw: ReadonlyMap<number, number>,
      method: CalibrationMethod,
      baseline: number,
    ): Map<number, number> => {
      if (effectiveBaselineFloorMode === "tmm-min") {
        // baseline 을 tmm 의 theoreticalMin 으로 — baseline 이하 raw 는 0 으로 clip.
        return calibrateTmm(raw, baseline);
      }
      const calibrated =
        method === "dbsf"
          ? calibrateDbsf(raw)
          : calibrateTmm(raw, COSINE_THEORETICAL_MIN);
      if (effectiveBaselineFloorMode === "gate") {
        return applyBaselineFloor(calibrated, raw, baseline);
      }
      // "off" — baseline floor 미적용(보정 강도 그대로).
      return calibrated;
    };

    // 필터 생존 노드로 좁힌 채널 강도 — 채널 분포가 점수 대상 후보와 일치하게 한다.
    const survivingVectorMag = new Map<number, number>();
    for (const h of vectorHits) {
      const m = vectorMagnitude.get(h.nodeId);
      if (m !== undefined) survivingVectorMag.set(h.nodeId, m);
    }
    const survivingImageVecMag = new Map<number, number>();
    for (const id of imageVecCandidates) {
      const m = imageVecMagnitude.get(id);
      if (m !== undefined) survivingImageVecMag.set(id, m);
    }

    const calibratedVector = calibrateChannel(
      survivingVectorMag,
      effectiveVectorCalibration,
      effectiveVectorBaseline,
    );
    const calibratedImageVec = calibrateChannel(
      survivingImageVecMag,
      effectiveImageVecCalibration,
      effectiveImageVecBaseline,
    );

    // 방식별 누락 floor — 그 채널에 매치 기록이 없는 노드의 정직한 하한.
    const vectorFloor = CALIBRATION_FLOOR[effectiveVectorCalibration];
    const imageVecFloor = CALIBRATION_FLOOR[effectiveImageVecCalibration];

    if (fusedRrf.size === 0) {
      return { results: [], stats: { totalFound, afterFiltering: 0 }, timings: buildRetrieveTimings(timer, embedCacheHit) };
    }

    // 6. Source attribution for each hit.
    const vectorIds = new Set(vectorHits.map((h) => h.nodeId));
    const ftsIds = new Set(ftsHits.map((h) => h.nodeId));
    const graphIds = new Set(graphHits.map(([id]) => id));
    const conceptIdsSet = new Set(conceptNodeIds);
    const imageVecIdsSet = new Set(imageVecCandidates);
    const projectIdsSet = new Set(projectNodeIds);
    const personIdsSet = new Set(personNodeIds);

    // 7. Load nodes once for all candidates.
    const candidateIds = [...fusedRrf.keys()];
    const nodes = await this.store.getNodesByIds(candidateIds);
    const nodeMap = new Map(nodes.map((n) => [n.id, n] as const));

    // 8. Supersede penalty lookup (single query for all candidates).
    const superseded = await this.store.getSupersededNodeIds(candidateIds);

    // 8.5. BM25 cross-score — 후보 노드들의 단일-doc FTS5 bm25() 점수.
    //      ftsQuery(synonym·project 확장 포함)를 그대로 재활용한다.
    //      결정적 연산 — LLM 호출 0.
    //
    //      성능 가드: effectiveBm25CrossWeight 가 0 이면 blend 에 합류하지 않으므로
    //      매 검색마다 불필요한 FTS 조회를 건너뛴다. 운영 default(0.0)에서는 이
    //      경로가 작동하지 않아 현행 RRF 와 동일 비용·동일 결과가 된다. T5 가
    //      cross weight 를 양수로 채택하면 그때만 조회가 켜진다.
    const bm25CrossScores =
      effectiveBm25CrossWeight > 0
        ? await this.store.computeBM25Cross(ftsQuery, candidateIds)
        : new Map<number, number>();

    // 8.7. missing-rank floor — missingRankFloor = true 이면 fusedRrf 에서 누락된
    //      채널이 있는 노드에 1/(RRF_K + fetchK + 1) floor 기여를 더한다.
    //      floor = false(default) = 현행 동작 불변.
    //
    //      fetchK = 전체 후보 수(fusedRrf.size) — 나중에 결합한 노드에게 최소 기여를 준다.
    const fetchK = fusedRrf.size;
    const floorScore = missingRankFloor
      ? 1 / (RRF_K + fetchK + 1)
      : 0;

    // 9. Post-process: 출처 boost + BM25 blend + recency / importance / mention / supersede.
    //
    //    출처 boost 적용 방식(post-RRF):
    //      boostedRrf = Σ (채널별 단독 RRF 기여 × boost)
    //    이 합산은 통합 RRF(fusedRrf) 와 *수학적으로 동등*하되 채널별 가중치를 더한다.
    //    통합 RRF 순위를 기준점으로 쓰고, boost 는 최종 score 에만 반영한다.
    //
    //    missing-rank floor 적용: 채널에 0 기여인 노드에 floorScore 를 더해
    //    해당 채널에서의 최소 기여로 인정한다.
    //
    //    finalScore 조립:
    //      bm25Contrib  = (bm25RrfRaw ?? floorScore) × effectiveBm25Boost
    //      vecContrib   = (vectorRrfRaw ?? floorScore) × effectiveVectorBoost
    //      graphContrib = (graphRrfRaw ?? floorScore) × effectiveGraphBoost
    //      cptContrib   = (conceptRrfRaw ?? floorScore) × effectiveConceptBoost
    //      boostedRrf = rrfScore + Σ (채널 기여 × (boost - 1))  [floor 미적용 채널은 0]
    //      blended = effectiveRrfBlendWeight × boostedRrf
    //              + effectiveBm25CrossWeight × bm25Cross
    //              + W_RECENCY × recency + W_IMPORTANCE × importance + mentionBoost
    //      finalScore = blended × supersedePenalty
    //
    //    장소 칸 소프트 가산(활용 단계4 T3 / D1) — placeValue 지정 시에만 아래에서
    //    placeBonus 를 blended 에 더한다. searchPlaceNodeScores(T1)를 루프 *밖* 에서
    //    1회만 조회해 매 노드 N번 조회를 피한다(placeValue 미지정이면 조회조차 안 함 →
    //    placeScores 가 빈 Map 이 아니라 undefined 라, 아래 분기가 코드 경로 자체를
    //    건너뛴다 / 0 더하기 아님 → blended 식 글자·결합 순서 byte 동일·회귀 0).
    const placeScores = options.placeValue
      ? this.store.searchPlaceNodeScores(options.placeValue)
      : undefined;
    const results: RetrievalResult[] = [];
    for (const [nodeId, rrfScore] of fusedRrf) {
      const node = nodeMap.get(nodeId);
      if (!node) continue;

      const recency = computeRecency(node.lastAccessedAt, halfLifeDays);
      const effectiveImportance = computeEffectiveImportance(
        node.importance,
        node.lastAccessedAt,
        importanceHalfLifeDays,
      );

      const bm25Cross = bm25CrossScores.get(nodeId) ?? 0;

      // post-RRF 출처 boost: rrfScore + 채널별 (기여 × delta) 합산.
      //   boostedRrf = rrfScore + Σ (채널 기여 × (boost - 1))
      //
      // floor 모드: 해당 채널에 0 기여인 노드에 floorScore 를 채널 기여로 인정.
      // floor = false 이면 floorScore = 0 → 기존 동작 동일.
      const bm25Contrib   = (bm25RrfRaw.get(nodeId) ?? floorScore);
      const vectorContrib = (vectorRrfRaw.get(nodeId) ?? floorScore);
      const graphContrib  = (graphRrfRaw.get(nodeId) ?? floorScore);
      const conceptContrib = (conceptRrfRaw.get(nodeId) ?? floorScore);
      // image_vec(SigLIP) 채널 — Phase 11b T5 / image-search-foundation T7(c-C1).
      // 옛 11b 는 vector boost 를 재활용했으나, "유사 우선, 연결 보조" 를 위해
      // imageVec 전용 boost(effectiveImageVecBoost / SOURCE_BOOST.imageVec)로 분리한다.
      // 글 노드는 imageVecContrib 가 floorScore(floor off 시 0)라 가산 delta 가
      // 0 → 글 검색 결과 불변. 이미지 노드만 유사도 기여가 커진다.
      const imageVecContrib = (imageVecRrfRaw.get(nodeId) ?? floorScore);

      // T4(강도-반영 정밀 재채점 / 설계 §4.2) — 유사도 채널(vector·imageVec)의
      // 보정 강도. 누락 채널은 CALIBRATION_FLOOR 로 채워 외톨이 노드를 부당 감점하지
      // 않는다(설계 §5). λ=0 이면 정밀 항이 0 → 현행 RRF(T1 baseline)와 동일.
      const calVec = calibratedVector.get(nodeId) ?? vectorFloor;
      const calImg = calibratedImageVec.get(nodeId) ?? imageVecFloor;

      // 노드별 점수 조립은 순수 함수 assembleNodeScore 로 떼어냈다(L7 분해). 식·결합
      // 순서·placeScore 두 갈래 분기는 retrieve-assemble.ts 안에 byte 동일하게 들어간다.
      // placeScores 가 undefined(미지정)면 placeScore: undefined 로 넘겨 함수가 else
      // 갈래(placeBonus 항 빠진 식)를 쓴다 — IEEE754 결합 순서 보존. 지정이면 그 노드의
      // 장소 매칭 점수(없으면 0)를 넘긴다.
      const assembled = assembleNodeScore({
        rrfScore,
        bm25Contrib,
        vectorContrib,
        graphContrib,
        conceptContrib,
        imageVecContrib,
        effectiveBm25Boost,
        effectiveVectorBoost,
        effectiveGraphBoost,
        effectiveConceptBoost,
        effectiveImageVecBoost,
        effectiveRrfBlendWeight,
        effectiveBm25CrossWeight,
        bm25Cross,
        calVec,
        calImg,
        effectivePrecisionMode,
        effectivePrecisionWeight,
        recency,
        effectiveImportance,
        mentionCount: node.mentionCount,
        // P3 G3-d — settings.search.mentionBoost 노브가 config 를 거쳐 흘러온 값.
        // 운영 default(0.05)면 MENTION_BOOST_PER_COUNT 와 같아 회귀 0.
        mentionBoostPerCount: effectiveMentionBoostPerCount,
        isSuperseded: superseded.has(nodeId),
        placeScore:
          placeScores !== undefined ? (placeScores.get(nodeId) ?? 0) : undefined,
      });
      const {
        finalScore,
        boostedRrf,
        mentionBoost,
        supersedePenalty,
        precisionStrengthScore,
      } = assembled;

      const sources: RetrievalSource[] = [];
      if (vectorIds.has(nodeId)) sources.push("vector");
      if (ftsIds.has(nodeId)) sources.push("fts");
      if (graphIds.has(nodeId)) sources.push("graph");
      if (conceptIdsSet.has(nodeId)) sources.push("concept");
      if (imageVecIdsSet.has(nodeId)) sources.push("imageVec");
      if (projectIdsSet.has(nodeId)) sources.push("project");
      if (personIdsSet.has(nodeId)) sources.push("person");

      // 보정 전 raw cosine 노출(audit 전용 / D-N2). vectorMagnitude·imageVecMagnitude
      // 는 step 2·3.7 에서 채운 *보정 전* 원시 cosine 맵이다 — 이미 계산된 값을
      // 읽어 components 에 담을 뿐 점수·순위·정밀강도엔 안 쓴다. 채널에 안 뜬
      // 노드는 .get() 이 undefined → 칸 미포함(정직한 생략 / 가짜 0 금지).
      const vectorRawCosine = vectorMagnitude.get(nodeId);
      const imageVecRawCosine = imageVecMagnitude.get(nodeId);

      results.push({
        node,
        score: finalScore,
        sources,
        components: {
          rrf: rrfScore,       // 통합 RRF(boost 미적용) — 기존 W_RRF 기준값
          boostedRrf,           // 채널별 boost 적용 합산값(floor 포함)
          bm25Cross,
          recency,
          importance: effectiveImportance,
          mentionBoost,
          supersedePenalty,
          precisionStrength: precisionStrengthScore, // T4 — λ × 보정 강도 결합값
          cueGraphBoost: cueGraphBoostFactor, // 1.1c T2 — cue 가 graph 에 적용한 가중치
          // raw cosine audit 칸 — number 일 때만 담아 채널 미등장 노드는 키 자체를
          // 생략한다(undefined 칸은 직렬화 시 빠진다 / 화면 줄도 생략됨).
          ...(vectorRawCosine !== undefined ? { vectorRawCosine } : {}),
          ...(imageVecRawCosine !== undefined ? { imageVecRawCosine } : {}),
        },
      });
    }

    // T10 stats out-channel — step 4.5 필터 통과 후 RRF 융합 후보 수. results.length
    // (trim *전*)을 쓴다 — fusedRrf.size 와 값은 같지만 nodeMap 조회 실패로 스킵된
    // id 가 있으면(드묾) results.length 가 실제 조립된 후보 수를 더 정확히 반영한다.
    const afterFiltering = results.length;

    // 10. Sort by final score and trim.
    results.sort((a, b) => b.score - a.score);
    const trimmed = results.slice(0, limit);
    timer.lap("scoreMs");

    // 11. Touch returned nodes so recency reflects access patterns.
    if (trimmed.length > 0) {
      await this.store.touchNodesBatch(trimmed.map((r) => r.node.id));
      timer.lap("touchMs");
    }

    return { results: trimmed, stats: { totalFound, afterFiltering }, timings: buildRetrieveTimings(timer, embedCacheHit) };
  }
}
