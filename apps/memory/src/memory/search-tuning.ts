/**
 * memory/search-tuning.ts — 검색 튜닝 상수 모듈 (1.1b T4 / DCL-5).
 *
 * retriever.ts 와 bm25-cross.ts 가 리터럴을 직접 기재하지 않고 이 모듈을
 * 참조한다. T5 가 sweep grid 를 읽어 최적 조합을 탐색했다.
 *
 * ## DCL-5 — 운영 default 는 측정으로 검증된 floor-중립값
 *
 * flat full-rrf 측정이 spec 직감 상수(boost bm25 1.08 / cross weight 0.3)를
 * 반증했다(기준선 0.8882 → 0.7967). 원인은 flat 코퍼스가 의미 정답 코퍼스라
 * FTS bm25() rank-1 노드가 구조적으로 잡음인 성질이다(plan 실측 기준선도
 * vector-only 0.9272 > full-rrf 0.8882 로 이 성질을 이미 기록했다). spec 직감
 * boost·cross weight 가 그 잡음 노드를 우대해 기준선을 깎는 것은 필연이다.
 *
 * ## T5 sweep 결과 (1.1b T5 — DCL-5 재확인)
 *
 * BLEND_SWEEP_GRID(6) × GRAPH_BOOST_SWEEP_GRID(5) × {floor on/off}(2) = 60 조합 측정.
 *
 *   best = blend 1.0/0.0, graphBoost 0.80, floor off → flatFullRrfNdcg 0.8882
 *   default(floor-중립) → 0.8882 (동일)
 *   spec default(blend 0.7/0.3, graphBoost 0.96, floor off) → 0.7967
 *   vector-only 기준선 → 0.9272
 *
 * measured-win gate 미통과: best 와 default 가 동일 nDCG 0.8882.
 * 결론: 운영 default(blend 1.0/0.0 / boost 전부 1.0) 유지. DCL-5 재확인.
 *
 * 게이트 비교 기준점은 운영 default(중립 0.8882)다 — spec default(0.7967)가
 * 아니다. DCL-5 가 운영 default 를 중립으로 바꾼 뒤 게이트 의미는 "지금 출시
 * 중인 동작보다 측정상 나을 때만 바꾼다" 이므로, 반증된 spec default(0.7967)를
 * 기준 삼으면 0.7967 보다 높지만 현행 0.8882 보다 낮은 조합을 채택해 회귀를
 * 부른다. 운영 default 기준이 회귀를 막으면서 진짜 win 은 놓치지 않는다.
 *
 * enriched 교차측정(핵심 3 조합 default/spec/best): 채택 조합(중립)이 enriched
 * full-rrf+concept nDCG 를 spec 조합 대비 깎지 않음 확인. full 60 조합 enriched
 * sweep 은 안 한다 — enriched recall 포화 + nDCG 잡음으로 변별 불가(sweep.ts
 * runSweep 주석 참조). 최종 enriched snapshot 권위는 T6 final-snapshot.
 *
 * missing-rank floor: floor on/off 동률(0.8882) → 미채택. floor-중립 유지.
 *
 * 이 코퍼스 구조에서 BM25 cross / 채널 boost 조정으로 vector-only 0.9272 를
 * 넘기는 조합이 존재하지 않음 확인. graphBoost 0.80 이 동률 best 인 것은
 * flat 코퍼스에 graph 엣지가 없어 graph 채널이 RRF 에 0 기여하기 때문이다
 * (graphBoost 값 무관 — 기여 0 × delta = 0).
 *
 * 그래서 운영 default 는 측정으로 검증된 floor-중립값으로 유지한다:
 *   - blend weight 1.0 / 0.0 — BM25 cross 를 최종 score 에 합류시키지 않는다.
 *   - 출처 boost 전부 1.0 — 채널별 가산 delta 가 0 이라 현행 RRF 와 정확히 같다.
 *
 * 메커니즘 자체는 실재하고 완전히 배선·테스트된다(retriever 의 boost·blend 경로,
 * bm25-cross.ts 의 단일-doc 점수 계산). 직감값과 downweighting 후보는 아래 sweep
 * grid 에 보존해, 더 풍부한 코퍼스(개념 적재 포함)에서 재측정 시 사용한다.
 * 죽은 코드가 아니라 측정 증거를 기다리는 보수적 default 다.
 *
 * 설계 원칙:
 *   - 결정적 연산만(LLM 호출 0).
 *   - 운영 default = floor-중립(blend 1.0/0.0 / boost 전부 1.0).
 *   - grid 는 T5 sweep 전용 — 운영 경로에서 직접 쓰지 않는다.
 */

// ── BM25 cross-score blend ────────────────────────────────────────────────

/**
 * boost 적용 RRF 에 곱하는 가중치. finalScore 의 주 신호.
 * DCL-5 운영 default = 1.0 (floor-중립). 직감값 0.7 은 BLEND_SWEEP_GRID 에 보존.
 */
export const RRF_BLEND_WEIGHT = 1.0;

/**
 * BM25 cross-score 에 곱하는 가중치. 단일-doc 매치 품질 신호.
 * DCL-5 운영 default = 0.0 (floor-중립 — flat 코퍼스에서 잡음 노드 우대를 피한다).
 * 직감값 0.3 은 BLEND_SWEEP_GRID 에 보존해 T5 가 측정으로 채택 판단한다.
 */
export const BM25_CROSS_WEIGHT = 0.0;

// ── 출처 boost (post-RRF, 채널별 기여에 곱함) ─────────────────────────────

/**
 * 채널별 RRF 기여에 곱하는 출처 boost.
 *
 * 적용 방식(1.1b T4 진단 결론):
 *   boostedRrf = rrfScore + Σ (채널 RRF 기여 × (boost - 1))
 *
 *   즉 boost 는 *가산 delta* 로 작동한다. delta 가 0(= boost 1.0)이면 현행
 *   통합 RRF 와 정확히 같은 결과가 나온다. 동점 노드의 순위 역전을 막으면서
 *   채널 선호를 최종 score 에 미세하게 반영하는 구조다.
 *
 * DCL-5 운영 default = 전부 1.0 (floor-중립). flat 측정이 보여준 대로 bm25
 * boost > 1.0 가 FTS rank-1 잡음 노드를 우대해 기준선을 깎으므로(0.8882 →
 * 0.8000), 측정으로 채택될 때까지 중립으로 둔다. 직감값(bm25 1.08 / graph 0.96
 * / concept 1.08)과 downweighting 후보는 sweep grid 에 보존한다.
 *
 *   bm25   : 1.0 — 직감 1.08 은 반증됨. 중립 유지.
 *   vector : 1.0 — 의미 신호 기준치.
 *   graph  : 1.0 — 직감 0.96(소폭 감쇄)도 측정 미검증. 중립 유지.
 *   concept: 1.0 — 직감 1.08 도 측정 미검증. 중립 유지.
 *
 * ## imageVec 전용 boost (image-search-foundation Task 7 / c-C1)
 *
 * "유사 우선, 연결 보조" — 이미지 유사도 채널(SigLIP image_vec)을 순위에 더
 * 싣는다. 사용자가 짚은 구체 흠: 유사도 1위인 맞는 이미지가, 유사도는 낮지만
 * 연결성(graph) 점수가 높은 딴 항목에 가산 합산으로 밀려난다. imageVec 전용
 * boost 를 1.0 보다 올리면 그 흠을 고친다.
 *
 * 핵심 성질 — 글 검색은 한 글자도 안 바뀐다: 글 노드는 imageVec 채널 기여가
 * 0(floor off 시 floorScore=0)이라 가산 delta `imageVecContrib × (boost-1)` 가
 * 글 노드에 대해 0 이다. 그래서 imageVec boost 를 올려도 이미지 노드만 점수가
 * 커지고 글 검색 결과(0.8882)는 구조적으로 불변이다. graph 채널을 전역으로
 * 낮추는 방식은 1.1c 의 graph cue measured-win 을 깎을 위험이 커 택하지 않는다.
 *
 *   imageVec: 2.5 — image-search-foundation T7 측정 확정값(아래 근거).
 *
 * T7 측정 절차(image-search-foundation-regression.test.ts) 결과 표:
 *   "노란 후드 입은 캐릭터" 검색에서, 맞는 이미지(imageVec rank-1)와 연결성 높은
 *   딴 한 항목(글자 일부 겹쳐 vector·fts·graph·concept 다채널 합류)을 두고 boost
 *   를 sweep 한 측정값(무관 글 1위 점수 = 0.198916 / boost 무관 불변):
 *
 *     boost  이미지점수   이미지>무관글
 *     1.00   0.182787     아니오 (rank 2 — 사용자가 짚은 흠 재현: 맞는 이미지가
 *                                 연결성 높은 딴 항목에 합산으로 밀림)
 *     1.10   0.184426     아니오 (rank 2)
 *     1.50   0.190984     아니오 (rank 2)
 *     2.00   0.199180     예    (rank 1 — crossover, 단 격차 +0.0003 으로 얇음)
 *     2.50   0.207377     예    (rank 1 — 격차 +0.0085 ≈ 4%, 안정 회수)
 *     3.00   0.215574     예    (rank 1)
 *
 *   crossover 는 boost 2.0 이지만 격차가 얇아 fragile 하다. 2.5 를 default 로
 *   고른 근거: 단일 연결성 딴 항목을 안정 격차(약 4%)로 넘어 사용자가 짚은 흠을
 *   확실히 고치되, 과하지 않다. boost 는 imageVec *rank* 기여에 곱하는 가산
 *   delta 라 rank-1(진짜 닮은) 이미지가 가장 크게 오르고 먼 rank 이미지는 비례해
 *   덜 오른다 — "유사 우선" 이 자연 내장된다. 더 두꺼운 5-항목 연결성 클러스터
 *   (스트레스 사례)는 crossover 가 더 높지만, 현실 단일 딴 항목 사례를 calibration
 *   기준으로 삼는다(극단 클러스터에 과적합하지 않는다 / dispatch "과하지 않은
 *   균형점"). default 는 settings(images.searchSimilarityBoost)로 노출돼 조정 가능.
 *
 * RRF 통합 합산 코어(rrf.ts)는 변경하지 않는다.
 */
export const SOURCE_BOOST: Record<
  "bm25" | "vector" | "graph" | "concept" | "imageVec",
  number
> = {
  bm25: 1.0,
  vector: 1.0,
  graph: 1.0,
  concept: 1.0,
  imageVec: 2.5,
};

// ── BM25 cross-score 정규화 — RRF-like rank 방식 ─────────────────────────
//
// 설계 근거(1.1b T4 진단):
//   FTS5 bm25() raw 는 음수 작은 값(-4 ~ -2 수준). sigmoid 정규화로는 출력이
//   0.56~0.60 처럼 절대값 수준에 쏠려 RRF 값(0.016 수준)을 압도한다. blend
//   weight 0.7/0.3 로도 균형을 잡을 수 없다.
//
//   해법 = RRF-like rank 정규화:
//     1. 후보 nodeId 를 bm25 raw ASC(더 음수 = 더 관련) 정렬.
//     2. 매치된 노드에 1/(BM25_RRF_K + rank + 1) 점수 부여 — RRF 와 동일 스케일.
//     3. 매치 없는 노드는 0.
//   결과: BM25 cross 1위 = 1/(60+1)=0.0164 — vector RRF 1위와 같은 스케일.
//   blend weight 0.7/0.3 이 이제 의미 있게 작동한다.
//
// BM25_NORM_SCALE 은 이 방식에서 사용하지 않지만, T5 가 sigmoid 방식으로
// 대안 실험할 경우를 위해 보존한다.

/**
 * BM25 cross-score 의 RRF rank 정규화에 쓰는 감쇄 상수.
 * RRF_K(=60)와 동일값을 사용해 스케일을 맞춘다.
 */
export const BM25_RRF_K = 60;

/**
 * sigmoid 정규화 방식의 스케일 — T5 대안 실험용으로 보존.
 * 운영 경로에서는 BM25_RRF_K 방식을 사용한다.
 */
export const BM25_NORM_SCALE = 10;

// ── cue 채널 가중치 (공통 인프라 1.1c / spec 5.3) ─────────────────────────
//
// 정규식 cue(관계·주제)가 query 에서 검출되면 graph 채널 가중치를 올린다 —
// 출처 boost(SOURCE_BOOST)와 같은 post-RRF 층. cue 는 query 토큰을 안 건드린다
// (synonym/project expansion 과 분리 / [[retriever-fusion-rrf]] 동등 합산 불변).
//
// 이 값들은 *운영 default(중립 1.0) 기준 measured-win gate* 를 통과해야 운영에
// 채택된다(1.1b DCL-5 귀결 / 점수를 깎으면 중립 유지 + DCL).
// T1 은 이 상수로 harness 안 cue-on variant 를 시뮬레이션해 측정 틈을 보인다.
// T2 가 정규식 검출(search-cues.ts)을 실제 retriever 에 배선한다.
//
// ## 이력 — T5(Granite 시절) measured-win gate 통과로 1.12/1.08 채택했었음
//
// cue-eval.test.ts(좁은 창 retrievalLimit 4 / EQ5 관계 cue + graph-hop 정답)
// 당시 실측: cue-off recall 0.0000 nDCG 0.0000 → cue-on recall 1.0000 nDCG 0.5000.
// Granite 임베딩에선 EQ5 정답 theme_reason 이 vector·fts·개념 직접 미도달이라
// graph-hop 으로만 도달 가능했고, cue 의 graph 가중치가 답을 좁은 창 안으로
// 끌어올렸다 — 그 근거로 1.12/1.08 을 운영 default 로 확정했었다.
//
// ## 2026-07-10 bge-m3 재측정 — measured-win 부재로 중립 1.0 복귀
//
// worktree 격리 sweep(boost 1.0~2.0 전 구간 + 진단 10.0)에서 EQ5 recall 전부 0 —
// 어떤 boost 값도 win 을 못 만든다. 원인: bge-m3 에선 EQ5 정답 theme_reason 이
// vector 채널 3위(rawCosine 0.5023)로 직접 회수돼 "graph-hop 으로만 도달" 전제가
// 붕괴. boost ≥1.3 은 EQ5 recall 0 인 채 EQ3/EQ4 nDCG 만 훼손(1.0→0.63).
// graphSeedTop 8/12/20 확대도 반증됨(EQ5 recall 0 유지 + 타 질의 훼손). 운영
// default 조건(T4-on)에선 boost 1.0 만으로 EQ5 recall 1.0 — boost 무영향.
// DCL-5 기준("현행보다 측정상 나을 때만 채택")에 따라 관계·주제 둘 다 한 결정으로
// 묶어 중립 1.0 으로 복귀한다. 복구 조건 = graph-hop 으로만 도달 가능한 정답을
// 다시 갖춘 코퍼스 재설계 후 measured-win gate 재통과.
// cue 검출 인프라(정규식 검출·components.cueGraphBoost 기록)는 원설계대로 유지 —
// 게이트 대상은 가중치 *값* 이지 장치가 아니다. cue 는 query 토큰 불변(채널 가중치
// 조정만 / [[retriever-fusion-rrf]] 동등 합산 코어 불변). 운영 경로는
// tuning.graphBoost 미지정일 때만 cue 가중치를 적용한다(sweep 격리 —
// retriever step 0.5 우선순위 규칙).

/**
 * 관계 cue("왜·이유·의도·변경·결정·바꿨·바꾼·어떻게") 검출 시 graph 채널 가중치
 * (spec 5.3.1). 1.0 = 중립. **2026-07-10 bge-m3 재측정에서 measured-win 부재로
 * 중립 1.0**(EQ5 정답이 vector 채널로 직접 회수돼 graph-hop 전제 붕괴 — 위 이력
 * 블록). 복구 조건 = 코퍼스 재설계 후 gate 재통과.
 */
export const RELATION_CUE_GRAPH_BOOST = 1.0;

/**
 * 주제 cue("전체·모두·전부·모든") 검출 시 graph 채널 가중치(spec 5.3.2).
 * 1.0 = 중립. 관계 cue 와 한 결정으로 묶어 2026-07-10 중립화(둘 다 검출 시
 * 관계 cue 값 우선 / search-cues.ts — 현재 둘 다 1.0 이라 값은 같다).
 */
export const TOPIC_CUE_GRAPH_BOOST = 1.0;

// ── T5 sweep grid (T5 전용 — 운영 경로 직접 사용 X) ──────────────────────

/**
 * blend 가중치 sweep grid.
 * 각 항목 = [rrfWeight, bm25Weight] 쌍. 합이 1.0 이 되도록 설계한다.
 * [1.0, 0.0] = DCL-5 운영 default(floor-중립) / [0.7, 0.3] = spec 직감값
 * (반증됨 — T5 measured-win gate 통과해야 채택). 둘 다 후보로 보존한다.
 */
export const BLEND_SWEEP_GRID: Array<[number, number]> = [
  [1.0, 0.0], // DCL-5 운영 default — blend 없음(현행 RRF 단독).
  [0.9, 0.1],
  [0.8, 0.2],
  [0.7, 0.3], // spec 직감값 — flat 측정 반증, T5 재검증 대상.
  [0.6, 0.4],
  [0.5, 0.5],
];

/**
 * graph boost sweep grid.
 * SOURCE_BOOST.graph 만 변화시키면서 T5 가 최적값을 탐색한다.
 * 1.00 = DCL-5 중립 default / 0.96 = spec 직감(소폭 감쇄, 미검증) / 0.80·0.88
 * = downweighting 후보. T5 가 measured-win gate 로 채택 판단한다.
 *
 * T5 가 graph 뿐 아니라 bm25/concept boost sweep 도 추가 검토한다(grid 추가
 * 구현은 T5 몫 — 여기서는 graph 축만 둔다).
 */
export const GRAPH_BOOST_SWEEP_GRID: number[] = [
  0.80, 0.88, 0.96, 1.00, 1.04,
];

/**
 * cue graph 가중치 sweep grid (공통 인프라 1.1c T2 — measured-win gate 후보).
 * 정규식 cue 검출 시 graph 채널에 곱할 가중치 후보값.
 *   1.00 = 중립(운영 default — 2026-07-10 중립화) / 1.08 = 주제 cue 직감값
 *   (spec 5.3.2) / 1.12 = 관계 cue 직감값(spec 5.3.1 — Granite 시절 채택 이력).
 * EQ5(관계 cue + graph-hop 정답)에서 cue-on 이 운영 default(중립) 대비 recall·nDCG
 * 를 올릴 때만 채택 / 깎으면 floor-중립(1.0) 유지 + DCL(1.1b DCL-5 귀결).
 * 2026-07-10 bge-m3 재측정에서 전 구간 win 부재 — 후보값은 이력으로 보존한다.
 */
export const CUE_GRAPH_BOOST_SWEEP_GRID: number[] = [1.0, 1.08, 1.12];

// ── 강도-반영 정밀 재채점 (강도-반영 융합 설계 §4.2·§5 / 무-LLM 코어) ──────────
//
// 설계 §4.2 의 "2단계 정밀 재채점" 을 운영 코드로 옮긴 상수다. T2 가 노출한 원시
// cosine 강도(vectorMagnitude / imageVecMagnitude)를 T3(calibration.ts)으로 채널
// 안에서 [0,1] 보정한 뒤, 그 강도를 finalScore 에 가산한다. RRF(rrf.ts)는 *회수*
// 역할 그대로 — 순위 합산 코어 0 변경. 정밀 강도는 이 가산 한 겹으로만 들어간다.
//
// ## 결합 방식 D-N1 (측정으로 확정 — magnitude-fusion-regression.test.ts)
//
// 유사도 채널(vector, imageVec)의 보정 강도를 점수에 싣는 세 후보:
//   - "max"   : finalScore += λ × max(보정 vector 강도, 보정 imageVec 강도).
//               어느 한 유사도 채널의 강한 매치가 점수를 끌어올린다(설계 §4.2
//               "강한 단일 매치 우세"). 연결(graph)은 기존 RRF 순위 기여로만 들어가
//               상한 보조 — 강한 유사도 매치를 못 뒤집는다. **측정 채택 default.**
//   - "sum"   : finalScore += λ × (보정 vector 강도 + 보정 imageVec 강도). 두 유사도
//               채널이 다 강하면 합산 우대 — 단일 강한 매치 우세 정신과 어긋날 수 있어
//               후보로만 보존(측정 비교용). 노란후드 케이스에선 강한 글이 imageVec
//               기여 floor(0) 라 max 와 동률이지만, 두 유사도 채널 다 강한 항목에서는
//               sum 이 단일 매치 우세 정신을 어긋낼 수 있어 max 를 default 로 둔다.
//   - "weighted-rrf" : 채널 RRF 기여 × 보정 강도(곱). 순위와 강도를 곱해 강한 매치를
//               우대하나, 측정상 RRF 기여(≈0.016)에 강도를 곱하면 가산폭이 너무 작아
//               (λ=0.2 에서도 노란후드 글 rank-8 불변) 흠을 못 고쳐 기각.
//
// ## 측정 결과 (magnitude-fusion-regression.test.ts — 2026-06-01 실측 / 리랭커-off)
//
// λ × mode × calibration sweep 표가 보인 핵심:
//   - **tmm 보정은 분별을 못 한다** — cosine 이론적 하한(-1)으로 정규화하면 살아남은
//     후보 강도가 대부분 ~1.0 근처로 압축돼 λ×강도가 거의 균일 offset 이 된다. 모든
//     노드를 똑같이 올려 노란후드 글이 rank-8 그대로(글>무관=아니오). tmm/tmm 는
//     λ 를 0.2 까지 올려도 흠을 못 고친다.
//   - **dbsf 보정이 분별한다** — 채널 분포 폭(mean±3σ) 기준이라 강한 글(높은 vector
//     cosine)이 약한 무관 글보다 보정 강도가 높다. λ=0.1 dbsf 에서 노란후드 글이
//     처음 무관 글 위로(margin 0.0116) / λ=0.2 dbsf 에서 안정 margin(0.0392).
//   - 게이트 통과 후보 4개 = {λ=0.1, λ=0.2} × {max, sum} × dbsf/dbsf. 노란후드 케이스
//     에선 max·sum 동률(강한 글이 imageVec floor) — 설계 §4.2 단일 매치 우세 정신으로
//     max 채택. λ=0.2 가 margin 0.0392 로 가장 안정 → 채택 default.
//   - 모든 dbsf 후보에서 글 nDCG 0.9272(개선) / recall 1.0(회귀 0) / graph-hop 보존.

/**
 * 정밀 강도 결합 방식(D-N1). magnitude-fusion-regression.test.ts 측정으로 확정.
 * 운영 default = "max" — 설계 §4.2 "강한 단일 매치 우세". 측정 표가 max 채택을
 * 증명했다(게이트 통과 후보 중 단일 매치 우세 정신 + 안정 margin).
 */
export type PrecisionStrengthMode = "max" | "sum" | "weighted-rrf";
export const PRECISION_STRENGTH_MODE: PrecisionStrengthMode = "max";

/**
 * 정밀 강도 결합 가중치 λ. finalScore += λ × (보정 강도 결합값). RRF 단일채널
 * 기여(1/(60+rank)≈0.016)와 보정 강도([0,1])의 척도를 맞추는 값이다. 너무 작으면
 * 강도가 순위를 못 뒤집고, 너무 크면 약한 매치까지 끌어올린다.
 *
 * **측정 확정 default = 0.2** (magnitude-fusion-regression sweep). dbsf 보정에서
 * λ=0.1 은 노란후드 글이 무관 다채널 글을 margin 0.0116 으로 겨우 넘어 fragile 하고,
 * λ=0.2 는 margin 0.0392 로 안정적이다(노란후드 글 rank-8 → rank-1). 글 nDCG 는
 * 0.8882 → 0.9272(개선) / recall 1.0(회귀 0) 으로 게이트를 모두 통과한다. 더 큰 λ 는
 * 약한 매치까지 과하게 끌어올릴 위험이 있어 게이트 통과 안정 최소 구간인 0.2 를 채택했다.
 */
export const PRECISION_STRENGTH_WEIGHT = 0.2;

/**
 * 유사도 채널 보정 방식(D-N1) — 채널별 다르게 줄 수 있다(설계 §5).
 *   - vector  : dbsf(distribution-based). 측정 결과 tmm(theoretical min-max)은
 *               cosine 이론적 하한(-1)으로 정규화하면 살아남은 후보 강도가 ~1.0 근처로
 *               압축돼 분별을 못 했다(균일 offset). dbsf 는 채널 분포 폭 기준이라 강한
 *               글을 약한 무관 글보다 높게 보정해 노란후드 분별을 실현한다.
 *   - imageVec: dbsf. SigLIP imageVec 도 같은 이유로 dbsf 가 분별력 있다(설계 §5 의
 *               "SigLIP 가끔 튀는 값에 이상치 강건" 정합).
 * "tmm" | "dbsf" 두 갈래. magnitude-fusion-regression 측정이 dbsf/dbsf 를 확정했다.
 */
export type CalibrationMethod = "tmm" | "dbsf";
export const VECTOR_CALIBRATION_METHOD: CalibrationMethod = "dbsf";
export const IMAGE_VEC_CALIBRATION_METHOD: CalibrationMethod = "dbsf";

/**
 * tmm 보정에 쓰는 cosine 유사도의 이론적 하한. vec0 distance_metric=cosine 에서
 * 강도 = 1 - distance = cosine 유사도 ∈ [-1, 1] 이므로 이론적 하한은 -1 이다.
 * L2 정규화 임베딩의 무관 쌍은 0 부근이라 실무 범위는 [0,1] 이지만, 보정 하한은
 * 수학적 하한(-1)을 쓴다 — 음의 cosine(반대 방향)도 정직하게 가장 낮은 강도로
 * 들어간다(데이터 max 만 잡는 tmm 의 쿼리 간 안정성 정신 §5).
 */
export const COSINE_THEORETICAL_MIN = -1;

// ── 채널별 절대 baseline floor (강도-반영 융합 §8.3·§8.6 후속 / 측정 확정) ──────
//
// dbsf 보정은 "채널 안 상대 분포"만 본다 — 절대 강도를 무시한다. 후보가 전부
// 무의미한 baseline 잡음이어도 그 중 상대 1위에 강도 1.0(최대)을 줘서, A1 실측
// "노란후드" 검색에서 내용이 "---"(마크다운 표 구분선 청크)인 노드가 vector 채널
// 상대 1위로 정밀 강도 최대를 받아 진짜 답인 이미지를 눌렀다. 채널별 절대 baseline
// floor 로 raw cosine 이 채널 baseline 미만인 매치의 정밀 강도를 0 으로 컷한다 —
// dbsf 분별력은 유지하되 baseline 잡음만 제거한다(청커 청소는 증상 쫓기라 안 한다).

/**
 * baseline floor 적용 방식(D-N2 / 측정 확정).
 *   - "off"     : baseline floor 미적용. λ=0 과 별개로, λ>0 이어도 baseline floor
 *                 만 끈 상태(보정 강도를 그대로 가산). baseline floor 도입 전 동작.
 *   - "gate"    : raw cosine < 채널 baseline 인 노드의 *보정 강도* 를 0 으로 덮는다
 *                 (calibration.applyBaselineFloor). dbsf 보정은 그대로 두고 baseline
 *                 잡음만 컷 — 분별력 유지 + 절대 잡음 제거. **측정 채택 default.**
 *   - "tmm-min" : 보정을 calibrateTmm(raw, baseline) 으로 호출(baseline 을
 *                 theoreticalMin 으로). tmm 정규화 하한을 baseline 으로 올려 baseline
 *                 이하를 0 으로 clip — 운영 dbsf 전환 비교용 후보(측정에서 약하면 기각).
 */
export type BaselineFloorMode = "off" | "gate" | "tmm-min";

/**
 * baseline floor 운영 default 방식. magnitude-fusion-regression.test.ts 측정으로
 * 확정한다 — gate(dbsf 분별 유지 + baseline 잡음 컷)가 junk 를 가장 안정적으로
 * 누르면서 글 nDCG 회귀 0 이면 채택. 측정 표가 게이트를 다 통과시킨 결과가 이 값.
 */
export const BASELINE_FLOOR_MODE: BaselineFloorMode = "gate";

/**
 * vector(글 임베딩) 채널 절대 baseline cosine 의 *모델 미상 최후 fallback*.
 *
 * 운영 경로는 server.ts 가 vectorBaselineOf(settings.db.embeddingModel)로 bge-m3
 * baseline 0.5를 HybridRetriever 생성자 defaultVectorBaseline 에 주입한다.
 * 이 상수는 retriever 직호출처럼 모델 주입이 없는 경로의 맨 끝 fallback 이다.
 * 합성 eval 코퍼스의 recall 회귀를 피하도록 legacy 보수값을 유지한다.
 */
export const VECTOR_COSINE_BASELINE = 0.17;

/**
 * imageVec(SigLIP) 채널 절대 baseline cosine. SigLIP 한 모델 고정이라 글 임베딩
 * 모델과 무관한 단일값이다. 무관 이미지 SigLIP cosine ≈ 0.057 /
 * 진짜 관련 이미지 0.117~0.138 (image-search-foundation §8 + 2026-06-01 A1 실측)이라
 * 그 사이 0.1 을 baseline 으로 본다 — 옛 0.05 는 무관 이미지를 통과시켜 너무 낮았다.
 * 측정 확정 0.1. vector baseline 과 숫자가 다른 것은 SigLIP 와 글
 * 임베딩의 cosine 척도가 다르기 때문(채널마다 같은 숫자가 다른 의미 — calibration.ts §).
 */
export const IMAGE_VEC_COSINE_BASELINE = 0.1;

/**
 * 정밀 강도 가중치 λ sweep grid(magnitude-fusion-regression.test.ts 전용).
 * 0.0 = 정밀 강도 미적용(현행 = T1 baseline 회귀 기준) / 양수 = 강도 가산.
 * 측정이 글 0.8882 회귀 0 + 노란후드 분별을 함께 만족하는 최소·안정값을 고른다.
 */
export const PRECISION_WEIGHT_SWEEP_GRID: number[] = [
  0.0, 0.02, 0.05, 0.1, 0.2, 0.3,
];

/**
 * vector 채널 baseline sweep grid(magnitude-fusion-regression.test.ts 전용).
 * 0 = baseline floor 비활성(잡음 컷 0) / 0.14·0.17·0.20 = 측정 후보. 측정이
 * junk 를 누르면서 진짜 매치(강한 글·이미지)를 안 죽이는 baseline 을 고른다.
 */
export const VECTOR_BASELINE_SWEEP_GRID: number[] = [0, 0.14, 0.17, 0.2];

/**
 * imageVec 채널 baseline sweep grid(magnitude-fusion-regression.test.ts 전용).
 * VECTOR_BASELINE_SWEEP_GRID 와 *index 정합* — 측정 harness 가 두 grid 를 같은
 * 인덱스로 짝지어(zip) 한 행으로 잰다. 그래서 채택 default 인덱스(vector grid
 * index 2 = VECTOR_COSINE_BASELINE 0.17)에 imageVec 채택값 0.1 을 맞춰 둔다.
 * 0 = 비활성(둘 다 0 = floor OFF 대조) / 0.05·0.1·0.15 = 측정 후보. SigLIP 무관
 * 이미지 ≈ 0.057 / 관련 이미지 0.117~0.138 (2026-06-01 A1 실측 — 채택 0.1 이 둘 사이).
 */
export const IMAGE_VEC_BASELINE_SWEEP_GRID: number[] = [0, 0.05, 0.1, 0.15];
