/**
 * retrieve-config — HybridRetriever.retrieve() 의 설정 해석 단계 추출(H-3 분해).
 *
 * retrieve() 한 메서드 안에 살던 설정 const 60여 개 중 *순수 계산* 부분(옵션·
 * sweep tuning·cue 검출·모듈 default fallback 우선순위)을 한 순수 함수로 모았다.
 * this.store / this.embedder 접근이 없는 부분만 옮긴다 — 채널 수집은 클래스
 * private 메서드로 남는다.
 *
 * 동작 보존(behavior-preserving): 모든 `?? 모듈상수` fallback 우선순위 체인과
 * cue 적용 규칙을 retrieve() 안에 있던 그대로 옮겼다 — 연산자·순서 byte 동일.
 * RRF 점수식 코어(rrf.ts·scoring.ts·search-tuning.ts·calibration.ts)는 한 글자도
 * 안 건드린다.
 *
 * RetrieveOptions / RetrieveTuning 타입 정의를 여기로 옮기고 retriever.ts 가
 * re-export 한다 — 외부 import 표면(`{ RetrieveTuning } from "./retriever.ts"`)을
 * 깨지 않으면서 retrieve-config.ts 가 retriever.ts 에 값-레벨로 의존하지 않게
 * 순환을 끊는다.
 */

import type { MemoryType, Polarity } from "./types.ts";
import type { ResolvedMemoryScope } from "./shared-memory-contract.ts";
import { detectCues, type SearchCues } from "./search-cues.ts";
import {
  RRF_BLEND_WEIGHT,
  BM25_CROSS_WEIGHT,
  SOURCE_BOOST,
  PRECISION_STRENGTH_MODE,
  PRECISION_STRENGTH_WEIGHT,
  VECTOR_CALIBRATION_METHOD,
  IMAGE_VEC_CALIBRATION_METHOD,
  BASELINE_FLOOR_MODE,
  VECTOR_COSINE_BASELINE,
  IMAGE_VEC_COSINE_BASELINE,
  type PrecisionStrengthMode,
  type CalibrationMethod,
  type BaselineFloorMode,
} from "./search-tuning.ts";
import {
  DEFAULT_RETRIEVAL_LIMIT,
  DEFAULT_VECTOR_K,
  DEFAULT_FTS_LIMIT,
  DEFAULT_GRAPH_MAX_HOPS,
  DEFAULT_GRAPH_LIMIT,
  DEFAULT_GRAPH_SEED_TOP,
  DEFAULT_RECENCY_HALF_LIFE_DAYS,
  DEFAULT_IMPORTANCE_HALF_LIFE_DAYS,
  DEFAULT_IMAGE_VEC_K,
  MENTION_BOOST_PER_COUNT,
} from "./retrieve-constants.ts";

// ── Tuning / option types (retriever.ts 가 re-export) ─────────────────────

/**
 * 검색 평가 sweep 전용 튜닝 오버라이드.
 * 미지정 시 search-tuning.ts 모듈 상수를 그대로 쓴다(운영 default 불변).
 *
 * - blend.rrf / blend.bm25 : RRF_BLEND_WEIGHT / BM25_CROSS_WEIGHT 를 덮어씀.
 * - graphBoost             : SOURCE_BOOST.graph 만 덮어씀.
 *                            (bm25/vector/concept boost 는 모듈값 유지 — 추후 sweep 확장 가능)
 * - imageVecBoost          : SOURCE_BOOST.imageVec 만 덮어씀(image-search-foundation
 *                            T7 / c-C1). sweep 이 boost 값별 이미지 순위를 측정한다.
 *                            운영 경로는 RetrieveOptions.imageVecBoost(settings 경유)로
 *                            덮으며, sweep tuning 이 더 우선한다(sweep 격리 보존).
 * - missingRankFloor       : true 이면 후보 pool 에는 들었지만 특정 채널에는
 *                            순위가 없는 노드에 1/(RRF_K + fetchK + 1) 최소 기여를 준다.
 *                            미지정 = false(floor-중립 — 현행 동작 불변).
 */
export interface RetrieveTuning {
  blend?: { rrf: number; bm25: number };
  graphBoost?: number;
  imageVecBoost?: number;
  missingRankFloor?: boolean;
  /**
   * 강도-반영 정밀 재채점(설계 §4.2 / T4) sweep 오버라이드. 미지정 =
   * search-tuning.ts 의 PRECISION_* 모듈 상수(운영 default). magnitude-fusion-
   * regression.test.ts 가 이 칸들로 D-N1 후보별 측정 표를 만든다.
   *
   * - precisionStrengthWeight : λ. 0 이면 정밀 강도 미적용(현행 RRF = T1 baseline).
   * - precisionStrengthMode   : "max" | "sum" | "weighted-rrf" 결합 방식.
   * - vectorCalibrationMethod / imageVecCalibrationMethod : 채널별 "tmm" | "dbsf".
   */
  precisionStrengthWeight?: number;
  precisionStrengthMode?: PrecisionStrengthMode;
  vectorCalibrationMethod?: CalibrationMethod;
  imageVecCalibrationMethod?: CalibrationMethod;
  /**
   * 채널별 절대 baseline floor(강도-반영 융합 §8.3·§8.6 후속 / D-N2) sweep
   * 오버라이드. 미지정 = search-tuning.ts 의 BASELINE_FLOOR_* 모듈 상수(운영 default).
   * magnitude-fusion-regression.test.ts 가 이 칸들로 baseline 방식·값 측정 표를 만든다.
   *
   * - baselineFloorMode  : "off" | "gate" | "tmm-min". baseline floor 적용 방식.
   * - vectorBaseline      : vector 채널 절대 baseline cosine. raw 가 이 값 미만이면 강도 0.
   * - imageVecBaseline    : imageVec 채널 절대 baseline cosine.
   *
   * mode="off" 또는 baseline=0 이면 baseline floor 가 한 노드도 안 깎아 finalScore 가
   * baseline floor 도입 전과 byte 동일하다(λ=0 byte-동일 불변 양식 정합).
   */
  baselineFloorMode?: BaselineFloorMode;
  vectorBaseline?: number;
  imageVecBaseline?: number;
}

export interface RetrieveOptions {
  scope?: ResolvedMemoryScope;
  includeInactive?: boolean;
  limit?: number;
  vectorK?: number;
  ftsLimit?: number;
  graphMaxHops?: number;
  graphLimit?: number;
  graphSeedTop?: number;
  recencyHalfLifeDays?: number;
  importanceHalfLifeDays?: number;
  /**
   * 검색 평가 sweep 용 채널 토글. 미지정 = 전 채널 ON(운영 동작 불변).
   * false 인 채널은 hits 가 빈 배열이 되어 RRF 에 0개 기여한다. concept
   * 채널은 1.1a T5 에서 합류했다 — query→개념 매칭→연결 자산 글.
   */
  channelMask?: {
    vector: boolean;
    fts: boolean;
    graph: boolean;
    concept: boolean;
    /** image_vec(SigLIP) 채널 — Phase 11b T5. 미지정 시 true(운영 default ON). */
    imageVec?: boolean;
    /**
     * 프로젝트 엔티티 검색 채널 — 1.2 T8. 프로젝트 hit → 그 프로젝트의 글 +
     * 참여자 글을 후보로 끌어온다. 미지정 시 true(운영 default ON). false 면 호출
     * 자체를 건너뛰어 후보 0개 → RRF 안 0 기여(sweep 격리 / 빈 배열 = 수학적 동일).
     */
    project?: boolean;
    /**
     * 사람 엔티티 검색 채널 — 1.2 T8. 사람 hit → 그 사람의 글(node_person_edges) +
     * 참여 프로젝트 글을 후보로 끌어온다. 미지정 시 true(운영 default ON). false 면
     * 호출 자체를 건너뛴다(project 채널과 같은 양식).
     */
    person?: boolean;
  };
  /** image_vec KNN 후보 한도 — 미지정 시 DEFAULT_IMAGE_VEC_K(=20). */
  imageVecK?: number;
  /**
   * image-search-foundation T7 (c-C1) — image_vec(SigLIP) 채널 전용 출처 boost
   * 의 운영 경로 오버라이드. 운영(search 라우트)은 settings.images.searchSimilarityBoost
   * 를 이 칸으로 흘려보내 SOURCE_BOOST.imageVec default 를 덮는다. 미지정 =
   * SOURCE_BOOST.imageVec(운영 default). "유사 우선, 연결 보조" — 이미지 유사도를
   * 순위에 더 싣되 글 노드는 imageVec 기여 0 이라 글 검색 결과는 불변이다.
   * sweep tuning.imageVecBoost 가 지정되면 그쪽이 우선한다(sweep 격리).
   */
  imageVecBoost?: number;
  /**
   * 강도-반영 정밀 재채점 가중치 λ(설계 §4.2 / T4)의 운영 경로 오버라이드.
   * 운영(search 라우트)은 settings.search.precisionStrengthWeight 를 이 칸으로
   * 흘려보내 PRECISION_STRENGTH_WEIGHT default 를 덮는다. 미지정 = 모듈 default.
   * 0 이면 정밀 강도 미적용(현행 RRF). sweep tuning.precisionStrengthWeight 가
   * 지정되면 그쪽이 우선한다(sweep 격리 — imageVecBoost 와 같은 우선순위 양식).
   */
  precisionStrengthWeight?: number;
  /**
   * 재언급 1회당 검색 점수 가산량(post-RRF)의 운영 경로 오버라이드(P3 G3-d).
   * 운영(search 라우트)은 settings.search.mentionBoost 를 이 칸으로 흘려보내
   * MENTION_BOOST_PER_COUNT(0.05) default 를 덮는다. 미지정 = 모듈 default 라
   * 노브를 안 바꾼 검색은 도입 전과 byte 동일하다(회귀 0). mentionCount 와 곱하고
   * MENTION_BOOST_CAP 으로 상한한다(CAP 은 사용자 노브 없는 모듈 상수 — retrieve-
   * assemble.ts). precisionStrengthWeight 와 같은 우선순위 양식이나, 이 값은 sweep
   * tuning 오버라이드가 없다(검색 화면 노브 한 갈래 — sweep 격리 대상 아님).
   */
  mentionBoostPerCount?: number;
  /**
   * 채널별 절대 baseline floor(강도-반영 융합 §8.3·§8.6 후속 / D-N2)의 운영 경로
   * 오버라이드. 운영(search 라우트)은 settings.search.baselineFloorMode /
   * baselineVectorCosine / baselineImageVecCosine 를 이 칸들로 흘려보내 모듈
   * default 를 덮는다. 미지정 = search-tuning.ts 모듈 상수. mode="off" 또는
   * baseline=0 이면 baseline floor 미적용(현행 RRF). sweep tuning 의 같은 칸이
   * 지정되면 그쪽이 우선한다(sweep 격리 — precisionStrengthWeight 와 같은 우선순위 양식).
   */
  baselineFloorMode?: BaselineFloorMode;
  vectorBaseline?: number;
  imageVecBaseline?: number;
  /**
   * D8 — 프로젝트 어휘 expansion(spec 5.4). 프로젝트 id 를 지정하면
   * project_vocabularies 에서 (term → expanded_meaning) 매핑을 읽어
   * BM25 + 임베딩 둘 다 합류(synonym 이 BM25 한정인 것과 다른 점).
   * 미지정 = expansion 0 → 1.1a 동작 불변(자연 degrade).
   */
  project?: string;
  /**
   * D7 — polarity 한정 query 필터(spec 5.5 / 1.1c T3). 지정하면 RRF 합산 *전*
   * 후보 pool 을 polarity 일치 노드로 줄인다(NULL 라벨 노드 제외 = 라벨된 자산만).
   * 미지정(undefined) = 필터 통째 미적용(전 후보 통과 / 1.1b·T2 동작 불변).
   *
   * body 에 polarity 칸 부재(미지정)와 노드 polarity NULL(라벨 없음)은 명확히
   * 구분된다 — 미지정이면 이 필터를 *건너뛰고*, 지정이면 NULL 노드를 *제외* 한다
   * (plan 회귀 함정 4 / Mock Policy). RRF 동등 합산 코어(rrf.ts)는 불변 — 입력
   * 후보만 줄인다([[retriever-fusion-rrf]]).
   */
  polarity?: Polarity;
  /**
   * 학술 분류 필터(spec 5.7 / 1.1c T4). `{ character: '흰머리토끼귀' }` 또는
   * `{ review: '만화' }` 처럼 (분류 키 → 분류 값) 매핑을 받아, 각 *값* 에 매칭되는
   * concept_nodes.name UNIQUE 노드의 연결 자산으로 후보 pool 을 RRF 합산 *전*
   * 교집합 제한한다. role 무관 매칭(tag·classification 전부)이라 `#만화` 태그와
   * `review:만화` 분류가 같은 `만화` concept 노드로 통합된다(spec 3.5.5).
   *
   * 여러 key 는 AND(모든 분류를 만족하는 노드만 — 값별 매칭 Set 의 교집합).
   * 미지정(undefined 또는 빈 객체) = 필터 통째 미적용(전 후보 통과 / 1.1b·T2·T3
   * 동작 불변). polarity 필터와 같은 단계(step 4.5)에서 후보를 줄이며, 둘 다
   * 지정되면 두 축소가 함께 교집합으로 적용된다.
   *
   * RRF 동등 합산 코어(rrf.ts)는 불변 — 입력 후보 pool 만 줄인다(plan 회귀
   * 함정 1 / [[retriever-fusion-rrf]]). graceful: 값에 매칭되는 concept 0개 →
   * 후보 0개 → 빈 결과(에러 아님 / "그 분류로 라벨된 자산 없음").
   *
   * 활용 단계4 태그 칸 = 이 filter 재사용(신규 칸 없음 / D4). 단계4 의 '태그/키워드
   * 하드 정확매칭' 역할을 이 filter 가 그대로 짊어진다 — getNodeIdsByConceptName 이
   * name UNIQUE·role 무관 매칭이라 `#만화` 태그와 `review:만화` 분류가 같은 concept
   * 으로 통합돼 과거 글 태그를 정확 name 으로 잡는다. 진짜 FTS5 토큰 매칭은 단계4
   * 불필요(정확 name 으로 충분) — 신규 태그 칸 코드를 더하지 않는다.
   */
  filter?: Record<string, string>;
  /**
   * Phase 7 갈래 1 (Task 5) — 검색 시간 범위 hard filter. 검색어(또는 명시
   * 파라미터)의 닫힌 시간 표현("지난주"·"5월"·"5월 25일")을 eventDateRange 가 푼
   * [since, until] ISO 날짜(YYYY-MM-DD) 구간. 지정하면 RRF 합산 *전* 후보 pool 을
   * COALESCE(event_at, created_at) 가 그 구간(양 끝 포함)에 드는 노드로 줄인다
   * (가중치가 아니라 *축소* — polarity·분류 필터와 같은 step 4.5 통로).
   *
   * 미지정(undefined) = 필터 통째 미적용(전 후보 통과) → 시간 표현 없는 검색은
   * 결과가 도입 전과 byte 동일하다(회귀 0). RRF 동등 합산 코어(rrf.ts)는 불변 —
   * 입력 후보만 줄인다([[retriever-fusion-rrf]]). graceful: 구간 일치 노드 0개 →
   * 후보 0개 → 빈 결과(에러 아님 / "그 시간대 자산 없음").
   */
  dateRange?: { since: string; until: string };
  /**
   * 활용 단계4 T2·T3 (search-field-filter D6) — 장소 칸 *소프트* 가산 신호. 날짜·
   * polarity·filter·dateRange 가 RRF 합산 *전* 후보를 *축소* 하는 하드 필터인 것과
   * 달리, placeValue 는 후보를 한 노드도 안 줄이고 step 9 blended 식에 소프트 *가산점*
   * 만 더한다(D1). retriever 가 이 값으로 searchPlaceNodeScores(placeValue)(T1)를
   * step 사이에서 1회 조회해 매칭 글에 PLACE_SOFT_BOOST_* 가중 가산한다.
   * '강남' 검색이 '강남 A마트' 글을 통째 탈락 없이 순위만 올리는 표기 흔들림 대응.
   *
   * 미지정(undefined) = 미적용 = byte 동일. T3 가 placeValue 미지정이면 placeBonus
   * 계산 코드 경로 자체를 건너뛰어(0 더하기 아님) blended 식이 도입 전과 *연산 순서까지*
   * 글자 동일하다(IEEE754 결합 순서 불변 / 회귀 0). RRF 동등 합산 코어(rrf.ts)는 불변.
   */
  placeValue?: string;
  /**
   * 1.2 T8 — memory_type 한정 query 필터(통일 원칙 / spec). 지정하면 RRF 합산 *전*
   * 후보 pool 을 memory_type 일치 노드로 줄인다. polarity·filter·dateRange 와 같은
   * step 4.5 통과 Set 통로다(가중치가 아니라 *축소*). memory_type 은 NOT NULL
   * DEFAULT 'fact' 라 NULL 미묘함이 없다 — polarity 의 NULL 제외와 다른 점.
   *
   * 미지정(undefined) = 필터 통째 미적용(전 후보 통과) → memory_type 없는 검색은
   * 결과가 도입 전과 byte 동일하다(회귀 0). RRF 동등 합산 코어(rrf.ts)는 불변 —
   * 입력 후보만 줄인다([[retriever-fusion-rrf]]). graceful: 일치 노드 0개 →
   * 후보 0개 → 빈 결과(에러 아님 / "그 종류 자산 없음").
   */
  memoryType?: MemoryType;
  /**
   * 활용 단계6 T4 — 종류(KIND_CATEGORY="종류") 한정 검색 캡슐. 지정하면 RRF 합산
   * *전* 후보 pool 을 그 종류로 분류된 글로 줄인다. retriever 가
   * store.getNodeIdsByConceptName(kind)(T3b 가 addClassificationTag 로 심은 종류
   * 분류 링크 / name UNIQUE·role 무관)로 통과 Set 을 더한다 — polarity·filter·
   * dateRange 와 같은 step 4.5 통과 Set 통로다(가중치가 아니라 *축소*).
   *
   * 미지정(undefined 또는 빈 문자열) = 필터 통째 미적용(전 후보 통과) → 종류 없는
   * 검색은 결과가 도입 전과 byte 동일하다(회귀 0). 미지정이면 passSets 에 push 자체를
   * 안 해 RRF 점수·순위가 byte 동일하다(점수식 6파일 미접촉). RRF 동등 합산 코어
   * (rrf.ts)는 불변 — 입력 후보만 줄인다. graceful: concept_nodes 에 없는 종류 이름이면
   * 빈 Set → 빈 결과(에러 아님 / "그 종류 글 없음").
   */
  kind?: string;
  /**
   * 활용 단계6 T4 — 종류별 칸(글-칸) 한정 검색 캡슐. (키 → 값) 쌍 목록을 받아, 각
   * 쌍에 매칭되는 글로 후보 pool 을 RRF 합산 *전* 교집합 *축소* 한다. retriever 가
   * 각 쌍마다 store.getNodeIdsByMetadataField(key, value)(T3b 가 metadata_json.fields
   * 에 저장한 글-칸 / 정확 일치)로 통과 Set 을 더한다 — 여러 쌍은 자연히 AND(모든
   * 칸을 만족하는 글만). kind 와 함께 지정되면 종류·칸이 함께 교집합(AND)이 된다.
   *
   * 미지정(undefined 또는 빈 배열) = 필터 통째 미적용(전 후보 통과 / 회귀 0).
   * 미지정이면 passSets 에 push 자체를 안 해 RRF 점수·순위가 byte 동일하다(점수식
   * 6파일 미접촉). RRF 동등 합산 코어(rrf.ts)는 불변 — 입력 후보만 줄인다. graceful:
   * 값에 매칭되는 글 0개 → 후보 0개 → 빈 결과(에러 아님 / "그 칸값 글 없음").
   */
  fieldFilters?: Array<{ key: string; value: string }>;
  /**
   * T5 sweep 전용 튜닝 오버라이드. 미지정 = search-tuning.ts 모듈 상수(운영 default).
   * RetrieveTuning 참조.
   */
  tuning?: RetrieveTuning;
}

// ── Resolved config ──────────────────────────────────────────────────────

/**
 * retrieve() 설정 해석 단계가 만드는 모든 값. retrieve() 는 이 구조체 하나를
 * 받아 메서드 안에서 config.X 로 참조한다 — 지역 const 60개가 한 스코프에 살던
 * 문제를 한 순수 함수 안에 가둔다.
 */
export interface ResolvedRetrieveConfig {
  limit: number;
  vectorK: number;
  ftsLimit: number;
  graphMaxHops: number;
  graphLimit: number;
  graphSeedTop: number;
  halfLifeDays: number;
  importanceHalfLifeDays: number;
  effectiveRrfBlendWeight: number;
  effectiveBm25CrossWeight: number;
  cueGraphBoostFactor: number;
  effectiveGraphBoost: number;
  effectiveBm25Boost: number;
  effectiveVectorBoost: number;
  effectiveConceptBoost: number;
  effectiveImageVecBoost: number;
  missingRankFloor: boolean;
  effectivePrecisionWeight: number;
  /**
   * 재언급 1회당 검색 점수 가산량(P3 G3-d). options.mentionBoostPerCount(settings
   * 경유) 미지정이면 MENTION_BOOST_PER_COUNT 모듈 default. retrieve() 가 이 값을
   * assembleNodeScore 로 넘긴다.
   */
  effectiveMentionBoostPerCount: number;
  effectivePrecisionMode: PrecisionStrengthMode;
  effectiveVectorCalibration: CalibrationMethod;
  effectiveImageVecCalibration: CalibrationMethod;
  effectiveBaselineFloorMode: BaselineFloorMode;
  effectiveVectorBaseline: number;
  effectiveImageVecBaseline: number;
  imageVecK: number;
  /**
   * 정규화된 채널 마스크 — `?? true` 정규화를 여기서 끝내 7칸 전부 확정 boolean.
   * retrieve() 안에서 mask.X 를 바로 읽는다(maskImageVec 같은 별도 const 불필요).
   */
  mask: {
    vector: boolean;
    fts: boolean;
    graph: boolean;
    concept: boolean;
    imageVec: boolean;
    project: boolean;
    person: boolean;
  };
}

/**
 * retrieve() 의 설정 해석부를 순수 함수로 추출. this.store / this.embedder 접근이
 * 없는 순수 계산이다 — 옵션·sweep tuning·cue 검출·모듈 default fallback 우선순위.
 *
 * 모든 `?? 모듈상수` fallback 체인과 cue 적용 규칙은 retrieve() 안에 있던 그대로
 * 옮겼다(연산자·순서 byte 동일 / 동작 보존).
 *
 * @param deps.defaultVectorBaseline 모델 연동 운영 default(server.ts 가 주입).
 * @param deps.searchCues 정규식 cue 추가 어휘(부팅 주입 / 미주입이면 builtin 만).
 */
export function resolveRetrieveConfig(
  query: string,
  options: RetrieveOptions,
  deps: { defaultVectorBaseline?: number; searchCues?: SearchCues },
): ResolvedRetrieveConfig {
  const limit = options.limit ?? DEFAULT_RETRIEVAL_LIMIT;
  const vectorK = options.vectorK ?? DEFAULT_VECTOR_K;
  const ftsLimit = options.ftsLimit ?? DEFAULT_FTS_LIMIT;
  const graphMaxHops = options.graphMaxHops ?? DEFAULT_GRAPH_MAX_HOPS;
  const graphLimit = options.graphLimit ?? DEFAULT_GRAPH_LIMIT;
  const graphSeedTop = options.graphSeedTop ?? DEFAULT_GRAPH_SEED_TOP;
  const halfLifeDays =
    options.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
  const importanceHalfLifeDays =
    options.importanceHalfLifeDays ?? DEFAULT_IMPORTANCE_HALF_LIFE_DAYS;

  // T5 튜닝 오버라이드 — 미지정 = search-tuning.ts 모듈 상수(운영 default 불변).
  const tuning = options.tuning;
  const effectiveRrfBlendWeight = tuning?.blend?.rrf ?? RRF_BLEND_WEIGHT;
  const effectiveBm25CrossWeight = tuning?.blend?.bm25 ?? BM25_CROSS_WEIGHT;

  // 0.5 정규식 cue 검출(1.1c T2 / spec 5.3) — query 에서 관계·주제 cue 를 검출해
  //     graph 채널 가중치를 올린다. 결정적 연산(LLM 호출 0 / 0.01초). query 토큰은
  //     안 건드린다 — query *전체* 를 정규식 검사만 한다([[retriever-fusion-rrf]]
  //     동등 합산 불변 / synonym·project expansion 과 분리).
  //
  //     우선순위 규칙: sweep 이 tuning.graphBoost 를 *명시* 하면 cue 를 적용하지
  //     않는다(sweep 격리 보존 — harness 의 cue-on 시뮬레이션이 tuning.graphBoost
  //     로 cue 효과를 직접 재현하므로, 거기에 cue 를 또 곱하면 이중 적용이 된다).
  //     cue 는 운영 경로(tuning.graphBoost 미지정)에서만 기본 graphBoost 에 곱한다.
  const cue = detectCues(query, deps.searchCues);
  const cueAppliesToGraphBoost = tuning?.graphBoost === undefined;
  const cueGraphBoostFactor = cueAppliesToGraphBoost ? cue.graphBoost : 1.0;
  const effectiveGraphBoost =
    (tuning?.graphBoost ?? SOURCE_BOOST.graph) * cueGraphBoostFactor;
  // graphBoost 만 오버라이드 — bm25/vector/concept boost 는 모듈값 유지.
  // 추후 sweep 확장 시 아래 상수들도 tuning 에 추가 가능하도록 주석으로 위치 표기.
  const effectiveBm25Boost = SOURCE_BOOST.bm25;    // tuning?.bm25Boost 추가 시 여기
  const effectiveVectorBoost = SOURCE_BOOST.vector; // tuning?.vectorBoost 추가 시 여기
  const effectiveConceptBoost = SOURCE_BOOST.concept; // tuning?.conceptBoost 추가 시 여기
  // image_vec 전용 boost(image-search-foundation T7 / c-C1) — 옛 vector boost
  // 재활용을 끊고 imageVec 채널만의 가중치로 derive 한다. 우선순위는 다른
  // effectiveXBoost 와 같은 양식: sweep tuning > 운영 options(settings 경유) >
  // SOURCE_BOOST.imageVec 모듈 default. 글 노드는 imageVec 기여 0 이라 이 값을
  // 올려도 글 검색 결과는 불변(아래 boostedRrf 합산 참조).
  const effectiveImageVecBoost =
    tuning?.imageVecBoost ?? options.imageVecBoost ?? SOURCE_BOOST.imageVec;
  // missingRankFloor 운영 default = false(floor-중립) — T5 실측 확정(spec 5-2,
  // 2026-08-03). 확장 손 정답 셋(코퍼스 90줄·42문항)을 ext harness 로 wide(상한
  // 20)·tight(상한 3) 두 창에서 OFF/ON 각 2회씩(결정성 확인) 돌린 결과, 6-metric
  // (nDCG/recall/MRR/precision/F1/MAP) 전부가 두 창 모두에서 소수점 6자리까지
  // OFF·ON 완전 동일했다(회귀도 개선도 0 — decision rule 상 "결과 동일" → OFF
  // 유지, 상세 수치는 task-5-report.md). retriever.test.ts 의 missingRankFloor
  // describe 블록이 floor 가 실제로는 무해한 죽은 코드가 아님(boost≠1 인 채널에
  // 개입해 boostedRrf 를 수식대로 바꿈)을 증명하되, 이 확장 코퍼스 규모에서는
  // 그 delta 가 최종 순위를 못 뒤집을 만큼 작았다는 것으로 위 실측 결과를 설명한다.
  //
  // 이 값은 순위(rank) 기반이지 유사도(similarity) 기반이 아니다(RRF_K·fetchK
  // 로만 결정) — 모델(bge-m3 등)을 바꿔도 의미가 안 바뀌므로 embedding factory
  // 맵(EMBEDDING_DIMENSIONS/EMBEDDING_VECTOR_BASELINES/... 시리즈)에는 절대
  // 넣지 않는다.
  const missingRankFloor = tuning?.missingRankFloor ?? false;

  // 강도-반영 정밀 재채점 파라미터(설계 §4.2 / T4). 우선순위는 imageVecBoost 와
  // 같은 양식: sweep tuning > 운영 options(settings 경유) > 모듈 default.
  // λ=0 이면 정밀 강도 가산이 0 → 현행 RRF(= T1 baseline)와 byte 동일하게 강등.
  const effectivePrecisionWeight =
    tuning?.precisionStrengthWeight ??
    options.precisionStrengthWeight ??
    PRECISION_STRENGTH_WEIGHT;

  // 재언급 1회당 검색 점수 가산량(P3 G3-d). 운영 경로 options(settings.search.
  // mentionBoost 경유) 미지정이면 MENTION_BOOST_PER_COUNT 모듈 default. settings
  // default(0.05)가 이 상수와 같은 값이라 노브를 안 바꾸면 회귀 0. sweep tuning
  // 오버라이드는 없다 — 검색 화면 노브 한 갈래(precisionStrengthWeight 와 달리 sweep
  // 격리 대상 아님).
  const effectiveMentionBoostPerCount =
    options.mentionBoostPerCount ?? MENTION_BOOST_PER_COUNT;
  const effectivePrecisionMode: PrecisionStrengthMode =
    tuning?.precisionStrengthMode ?? PRECISION_STRENGTH_MODE;
  const effectiveVectorCalibration: CalibrationMethod =
    tuning?.vectorCalibrationMethod ?? VECTOR_CALIBRATION_METHOD;
  const effectiveImageVecCalibration: CalibrationMethod =
    tuning?.imageVecCalibrationMethod ?? IMAGE_VEC_CALIBRATION_METHOD;

  // 채널별 절대 baseline floor(강도-반영 융합 §8.3·§8.6 후속 / D-N2). 우선순위는
  // precisionStrengthWeight 와 같은 양식: sweep tuning > 운영 options(settings 경유)
  // > 모듈 default. mode="off" 또는 baseline=0 이면 baseline floor 가 한 노드도
  // 안 깎아 finalScore 가 baseline floor 도입 전과 byte 동일하다.
  const effectiveBaselineFloorMode: BaselineFloorMode =
    tuning?.baselineFloorMode ??
    options.baselineFloorMode ??
    BASELINE_FLOOR_MODE;
  // vector baseline 우선순위(2026-06-01 모델 연동 전환): sweep tuning > 운영
  // options(settings 가 0..1 로 명시 오버라이드) > 모델 연동 default(server.ts 가
  // vectorBaselineOf(model) 로 주입) > 모듈 상수(모델조차 모르는 최후 fallback).
  // settings 가 음수 sentinel(미지정 의미)을 흘리면 search 라우트가 options 로 안
  // 넘겨 모델 연동 default 가 이긴다.
  const effectiveVectorBaseline =
    tuning?.vectorBaseline ??
    options.vectorBaseline ??
    deps.defaultVectorBaseline ??
    VECTOR_COSINE_BASELINE;
  const effectiveImageVecBaseline =
    tuning?.imageVecBaseline ??
    options.imageVecBaseline ??
    IMAGE_VEC_COSINE_BASELINE;

  // channelMask 미지정 = 전 채널 ON → 운영 동작 불변(개념 채널도 이제 켜짐).
  // sweep(검색 평가 harness)에서만 한 채널을 끄고 켜 원인을 분리한다.
  const rawMask = options.channelMask ?? {
    vector: true,
    fts: true,
    graph: true,
    concept: true,
    imageVec: true,
    project: true,
    person: true,
  };
  // imageVec / project / person 칸이 옛 mask 객체(11a·1.2 이전 호출자)에는
  // undefined 일 수 있다 — 미지정 = true 정합(운영 default ON / 자연 degrade).
  // sweep 에서만 false 로 한 채널을 끈다.
  const mask = {
    vector: rawMask.vector,
    fts: rawMask.fts,
    graph: rawMask.graph,
    concept: rawMask.concept,
    imageVec: rawMask.imageVec ?? true,
    project: rawMask.project ?? true,
    person: rawMask.person ?? true,
  };
  const imageVecK = options.imageVecK ?? DEFAULT_IMAGE_VEC_K;

  return {
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
    imageVecK,
    mask,
  };
}
