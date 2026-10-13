/**
 * retrieve-constants — HybridRetriever 검색 튜닝 상수의 leaf 모듈(H-3 분해).
 *
 * retriever.ts 와 retrieve-config.ts 둘 다 이 상수를 읽는다. 두 파일이 서로
 * 값을 import 하면 순환이 되므로, 의존 없는 leaf 모듈로 빼 양쪽이 함께 import
 * 한다. retriever.ts 가 이 상수들을 그대로 re-export 해 외부 import 표면
 * (`{ DEFAULT_VECTOR_K } from "./retriever.ts"`)을 보존한다(동작 변경 0).
 */

// ── Tunables ─────────────────────────────────────────────────────────────

/** How many candidates each source contributes to the fusion pool. */
export const DEFAULT_VECTOR_K = 20;
export const DEFAULT_FTS_LIMIT = 20;
export const DEFAULT_GRAPH_LIMIT = 30;

/** Top-N seeds from (vector ∪ FTS) feed the graph BFS. */
export const DEFAULT_GRAPH_SEED_TOP = 5;

/** 개념 매칭 채널 후보 한도(글자+의미 각각). */
export const DEFAULT_CONCEPT_FTS_LIMIT = 10;
export const DEFAULT_CONCEPT_VECTOR_K = 10;
/** 개념 후보 → 자산 글 합류 한도. */
export const DEFAULT_CONCEPT_NODE_LIMIT = 20;

/**
 * 콜론 위계 검색 펼침(spec §4.1 A) — 따라갈 parent_of weight 임계 + 펼침 후보 상한.
 * 0.7 임계 = 콜론 확정(0.9)은 따라가고 옛 순서 추측(0.3) 잔재는 거른다. 40 상한 =
 * 상위 분류 검색 시 자식 폭증 방어. 두 값은 planner-chosen 기본값이라 §7.2 measured-win
 * 튜닝 대상이다(하드코딩 금지 — 단일 출처).
 */
export const PARENT_OF_EXPANSION_MIN_WEIGHT = 0.7;
export const PARENT_OF_EXPANSION_LIMIT = 40;

/**
 * 엔티티 관계 1-hop 검색 펼침(4단계 Task 5) — 관계로 이어진 엔티티 글 후보 상한.
 * '데못죽' → 같은 창작자 아쿠타미 → 아쿠타미의 다른 작품 글까지 깊이 1 로 끌어올 때
 * 회수할 글 수 한도. 한 작가가 작품을 많이 가진 경우 후보 폭증 방어. planner-chosen
 * 기본값(하드코딩 금지 — 단일 출처). 후보 pool 확장만이라 RRF 점수식과 무관하다.
 */
export const ENTITY_RELATION_EXPANSION_LIMIT = 20;

/** image_vec(SigLIP) KNN 채널 후보 한도 — Phase 11b T5. */
export const DEFAULT_IMAGE_VEC_K = 20;

// 통과 집합 적응형 공급의 조각 크기 상수는 `VEC0_MAX_K`(= 4096)이며, 질의를 실제로
// 조각내는 모듈 `db/store-internal/search-repo-vec-fts.ts` 가 단일 출처로 보유한다
// (T4 (B) 재정 2026-08-03). 여기 있던 `VECTOR_PUSHDOWN_MAX_PASS_SET` 은 "이 크기를
// 넘으면 사후 필터로 내린다"는 *라우팅 임계* 였는데, 그 갈래가 불승인돼(초과 구간도
// 조각 합집합으로 라우팅) 임계라는 의미 자체가 사라졌으므로 제거했다. 값을 조각 크기
// 로만 남기면 상수가 두 군데에 생기므로 질의 모듈 쪽 하나로 모은다.

/** 프로젝트·사람 엔티티 검색 채널 후보 한도(글자+의미 각각 / 1.2 T8). */
export const DEFAULT_PROJECT_FTS_LIMIT = 10;
export const DEFAULT_PROJECT_VECTOR_K = 10;
export const DEFAULT_PERSON_FTS_LIMIT = 10;
export const DEFAULT_PERSON_VECTOR_K = 10;
/** 한 엔티티(프로젝트·사람) → 연결 자산 글 합류 한도. */
export const DEFAULT_PROJECT_NODE_LIMIT = 20;

/** BFS depth limit for graph expansion. */
export const DEFAULT_GRAPH_MAX_HOPS = 2;

/** Final result limit if caller doesn't override. */
export const DEFAULT_RETRIEVAL_LIMIT = 10;

/** Recency half-life in days for the post-processing decay. */
export const DEFAULT_RECENCY_HALF_LIFE_DAYS = 30;

/** Importance half-life in days for effectiveImportance decay. */
export const DEFAULT_IMPORTANCE_HALF_LIFE_DAYS = 90;

/**
 * Per-mention additive boost applied to the post-RRF score, multiplied by
 * `mention_count` and clamped at `MENTION_BOOST_CAP`. Mirrors the old
 * Python retriever's MEMORY_MENTION_BOOST_PER_COUNT.
 */
export const MENTION_BOOST_PER_COUNT = 0.05;
export const MENTION_BOOST_CAP = 0.1;

/**
 * 장소 칸 소프트 가산(활용 단계4 T3 / search-field-filter D1·D8). step 9 blended
 * 식에서 mentionBoost 옆에 더해지는 *post-RRF 가산 항* 이라 mentionBoost 상수 가족
 * (위 MENTION_BOOST_*)과 같은 파일·같은 양식에 둔다. settings 미노출 모듈 상수 —
 * MENTION_BOOST_CAP/PER_COUNT 와 동일(D8: 사용자 조정 노출은 Deferred).
 *
 *   placeBonus = min(PLACE_SOFT_BOOST_CAP,
 *                    PLACE_SOFT_BOOST_WEIGHT × searchPlaceNodeScores(placeValue).get(nodeId))
 *
 * searchPlaceNodeScores(T1)가 회신하는 0..1 매칭 점수(정확=1.0·부분<1.0)에 WEIGHT 를
 * 곱하고 CAP 으로 상한한다. CAP 0.1 = mentionBoost CAP 과 같은 스케일(post-RRF 가산이
 * RRF 1위 ≈ 0.016 보다 충분히 커 표기 흔들림 글을 *순위 상승* 시키되, 무관 글을 통째
 * 뒤집지는 않는 소프트 수준). 점수 마법수가 아니라 가중치 — T1 의 매칭 점수 결정식과
 * 분리(거기는 "얼마나 정확히 매칭됐나" 0..1·여기는 "그 신호를 점수에 얼마나 실을까").
 *
 * 미지정(placeValue 없음)이면 retriever 가 placeBonus 계산 코드 경로 자체를 건너뛰어
 * 이 상수가 어디서도 안 읽힌다 → blended 식이 도입 전과 글자 동일(IEEE754 결합 순서
 * 불변 / 회귀 0). retriever.invariant.test.ts 가 이 default 값을 글자 동결한다.
 */
export const PLACE_SOFT_BOOST_WEIGHT = 0.1;
export const PLACE_SOFT_BOOST_CAP = 0.1;

/**
 * Multiplier applied to the score of nodes targeted by a 'supersedes'
 * edge. < 1 demotes superseded nodes. Mirrors old MEMORY_SUPERSEDE_SCORE_PENALTY.
 */
export const SUPERSEDE_PENALTY = 0.5;

/**
 * Relative weights for blending RRF (the lexical/semantic/graph signal)
 * with importance and recency. RRF scores are tiny (sum of `1/(60+rank)`
 * terms ≈ 0.05 each), so importance/recency need their own additive
 * channels rather than fighting RRF directly. These coefficients can stay
 * fixed because RRF itself is tuning-free — the user only locked in
 * "equal weighting across the three sources," not these.
 */
export const W_RRF = 1.0;
export const W_RECENCY = 0.1;
export const W_IMPORTANCE = 0.1;
