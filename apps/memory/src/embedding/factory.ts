import type { ProgressCallback } from "@huggingface/transformers";
import type { Embedder, ImageEmbedder } from "./types";
import { Bgem3Embedder } from "./bge-m3";
import { Siglip2Embedder, siglip2Embedder } from "./siglip2";

/**
 * 선택 가능한 임베더 모델 식별자 — `memory-schema.ts db.embeddingModel` enum 과 정합.
 *
 * - "bge-m3" — 1024 dim, BAAI bge-m3. **현 운영 default** (2026-06-01 정식
 *   전환). A1 실측에서 무관 글 cosine 0.28~0.49 / 진짜 관련 글 0.559 로 갈라져
 *   baseline 0.5 컷으로 노란후드·농구·좀비 모두 정답이 1위로 떴다.
 *   기준 스키마 vec_nodes `float[1024]`와 정합.
 */
export type EmbedderModel = "bge-m3";

const VALID_MODELS: readonly EmbedderModel[] = ["bge-m3"];

/**
 * 현 운영 default 글 임베딩 모델 — createEmbedder 미지정 시 값이자, settings 를
 * 모르는 모듈 상수(예: concept-alias-detect CONCEPT_ALIAS_THRESHOLD)가 모델별
 * 임계 맵에서 값을 얻을 때 쓰는 모델 식별자 단일 출처.
 */
export const DEFAULT_EMBEDDER_MODEL: EmbedderModel = "bge-m3";

/**
 * 모델 식별자 → 글/개념 임베딩 차원 단일 출처.
 *
 * 글 벡터(vec_nodes)·개념 벡터(concept_vec) 차원이 모델에서 결정되도록 한 곳에
 * 모은다. 옛날에는 기준 스키마 SQL 의 `float[384]` 리터럴 + self-check.ts 의 별도
 * 맵 + factory 주석에 같은 값이 흩어져 있었다 — 이 맵이 그 흩어진 하드코딩을
 * 거두어 단일 권위로 만든다.
 *
 * - bge-m3 → 1024 (BAAI bge-m3, 2026-06-01 운영 default)
 *
 * 주의: 이미지 SigLIP 벡터(image_vec · concept_siglip_vec, 768-dim)는 글 임베딩
 * 모델과 무관한 별 공간이라 이 맵 밖이다 — 글 임베딩 모델을 바꿔도 SigLIP 768 은
 * 불변.
 */
export const EMBEDDING_DIMENSIONS: Readonly<Record<EmbedderModel, number>> = {
  "bge-m3": 1024,
};

/**
 * 모델 식별자 → 글 유사도(vector) 채널 절대 baseline cosine 단일 출처.
 *
 * baseline floor(gate)가 raw cosine < 이 값인 글의 정밀 강도를 0 으로 컷해
 * "무관 글이 baseline 잡음으로 진짜 답 위에 끼어드는" 흠을 막는다. 모델마다 무관
 * 글에 주는 cosine 척도가 달라(아래) baseline 도 모델에 연동된다 — 차원
 * (EMBEDDING_DIMENSIONS)과 같은 양식으로 모델에서 자동 결정한다.
 *
 * - bge-m3 → 0.5 (A1 실측 — 무관 글 cosine 0.28~0.49 / 관련 글 0.559.
 *                 0.5 컷이 무관 글을 정확히 가른다)
 *
 * 운영 흐름: server.ts 가 settings.db.embeddingModel → 이 값으로 변환해
 * HybridRetriever 생성자 default 로 흘린다(차원이 openMemoryDatabase 로 흐르는 것과
 * 같은 경로). settings.search.baselineVectorCosine 이 0..1 로 *명시* 되면 그 값이
 * 우선(사용자 오버라이드 보존), 음수 sentinel(미지정 의미)이면 이 모델 baseline 이
 * 운영 default 가 된다. search-tuning.ts 의 VECTOR_COSINE_BASELINE 은 모델조차 알
 * 수 없는 최후 fallback 으로 남는다.
 *
 * 주의: 이미지 SigLIP baseline 은 글 모델과 무관하다 — SigLIP 한 모델 고정이라
 * search-tuning.ts 의 IMAGE_VEC_COSINE_BASELINE 단일 상수로 둔다(이 맵 밖).
 */
export const EMBEDDING_VECTOR_BASELINES: Readonly<
  Record<EmbedderModel, number>
> = {
  "bge-m3": 0.5,
};

/**
 * 모델 식별자에서 글/개념 임베딩 차원을 돌려준다. 알 수 없는 값이면
 * createEmbedder 와 같은 정신으로 명시 throw (mock/silent fallback 금지).
 *
 * openMemoryDatabase 가 기준 스키마의 글 벡터 차원을 이 값으로 치환하고,
 * server.ts 가 settings.db.embeddingModel → 차원으로 변환해 DB 와 임베더를
 * 한 모델로 일관 구성한다.
 */
export function embeddingDimensionOf(model: EmbedderModel): number {
  const dim = EMBEDDING_DIMENSIONS[model];
  if (dim === undefined) {
    throw new Error(
      `Unknown embedding model="${model}". Valid values: ${VALID_MODELS.join(", ")}`,
    );
  }
  return dim;
}

/**
 * 모델 식별자에서 글 유사도(vector) 채널 절대 baseline cosine 을 돌려준다.
 * embeddingDimensionOf 와 같은 양식 — 알 수 없는 값이면 명시 throw
 * (mock/silent fallback 금지).
 *
 * server.ts 가 settings.db.embeddingModel → 이 값으로 변환해 HybridRetriever
 * 생성자 default(defaultVectorBaseline)로 전달한다.
 */
export function vectorBaselineOf(model: EmbedderModel): number {
  const baseline = EMBEDDING_VECTOR_BASELINES[model];
  if (baseline === undefined) {
    throw new Error(
      `Unknown embedding model="${model}". Valid values: ${VALID_MODELS.join(", ")}`,
    );
  }
  return baseline;
}

/**
 * 모델 식별자 → 충돌·중복 판정 임계 단일 출처.
 *
 * 충돌 해소(supersede)와 중복 병합(dedup)은 두 글이 *얼마나 비슷하면* 같은
 * 사실로 볼지를 cosine 임계로 가른다. 그런데 모델마다 비슷한 글에 주는 cosine
 * 척도가 다르다 — vector baseline(EMBEDDING_VECTOR_BASELINES)이 모델에 연동되는
 * 것과 똑같은 이유로 이 임계도 모델에 연동된다. 한 곳에 모아 모델을 바꾸면
 * 임계가 같이 따라오게 한다.
 *
 * 칸 의미:
 * - conflictLow  — 충돌 검사 시작점. 두 글의 cosine 이 이 값 이상이어야 충돌
 *                  후보로 본다(conflict-checker isConflictSimilarity 하한).
 * - conflictHigh — 사실상 동일 처리 상한. 이 값 이상은 충돌이 아닌 같은 글로
 *                  보고 supersede 대신 별도 처리(isConflictSimilarity 상한).
 * - dedupSim     — 중복 병합 임계. 추출 항목이 기존 노드와 이 값 이상 닮으면
 *                  새 노드를 만들지 않고 mention_count 만 올린다(extractor).
 *
 * - bge-m3 → { conflictLow 0.55, conflictHigh 0.85, dedupSim 0.85 }
 *     **A1 실측 분포 기반 추정값** — 진짜 관련 글 cosine ≈ 0.559 / 무관 글
 *     0.28~0.49(bge-m3.ts 주석·CLAUDE.md). conflictLow 0.55 는 관련 글(0.559)은
 *     통과시키고 무관 글(≤0.49)은 거르는 분기점으로 잡았고, dedup/conflictHigh
 *     0.85 는 "거의 같은 글"만 잡도록 관련 분포 위쪽에 두었다. **추정인 이유**:
 *     운영 DB 에 실제 글 쌍을 넣고 sweep 으로 supersede/dedup precision·recall 을
 *     재서 확정해야 한다 — 그 sweep 토대(eval harness 코퍼스 확장)는 감사 보고서
 *     H1 작업이라 아직 미완이다. H1 후 sweep 결과로 이 세 값을 갱신한다.
 */
export const EMBEDDING_CONFLICT_THRESHOLDS: Readonly<
  Record<
    EmbedderModel,
    { conflictLow: number; conflictHigh: number; dedupSim: number }
  >
> = {
  "bge-m3": { conflictLow: 0.55, conflictHigh: 0.85, dedupSim: 0.85 },
};

/**
 * 모델 식별자에서 충돌·중복 임계 묶음을 돌려준다. vectorBaselineOf 와 같은
 * 양식 — 알 수 없는 값이면 명시 throw (mock/silent fallback 금지).
 *
 * server.ts 가 settings.db.embeddingModel → 이 값으로 변환해 ConflictChecker
 * 생성자(simLow/simHigh)와 MemoryExtractor(duplicateSim) default 로 흘린다.
 * settings.search 의 해당 칸이 음수 sentinel(미지정)이면 이 모델값이, 0..1 로
 * 명시되면 사용자값이 이긴다 — baselineVectorCosine 과 같은 규칙.
 */
export function conflictThresholdsOf(model: EmbedderModel): {
  conflictLow: number;
  conflictHigh: number;
  dedupSim: number;
} {
  const thresholds = EMBEDDING_CONFLICT_THRESHOLDS[model];
  if (thresholds === undefined) {
    throw new Error(
      `Unknown embedding model="${model}". Valid values: ${VALID_MODELS.join(", ")}`,
    );
  }
  return thresholds;
}

/**
 * 모델 식별자 → 개념 별칭 후보 판정 임계 단일 출처.
 *
 * 별칭 검출(concept-alias-detect / spec 8.3)은 새 개념과 기존 개념의 concept_vec
 * cosine 이 이 값 이상이면 concept_alias_suggestions 에 pending 후보로 적재한다.
 * 모델마다 동의어 쌍에 주는 cosine 척도가 다르다 — 충돌·중복 임계
 * (EMBEDDING_CONFLICT_THRESHOLDS)와 똑같은 이유로 이 임계도 모델에 연동한다.
 *
 * - bge-m3 → 0.68
 *     **2026-07-10 본 PC 실측 확정값** — 운영 동일 경로(Xenova/bge-m3 q8 ·
 *     cls pooling · normalize, 개념 이름 단독 임베딩)로 43쌍 측정. 분포:
 *       참 별칭(한↔영 12쌍 + 표기변형 11쌍) 0.71~0.93
 *         (자동차↔automobile 0.8774 / 머신러닝↔머신 러닝 0.9275 / 고양이↔cat 0.7106)
 *       관련-비별칭 0.49~0.82 (커피↔카페 0.8228 / 자동차↔트럭 0.57~0.60)
 *       무관쌍 0.22~0.45
 *     0.70 에서 참 별칭 22/23 검출 + 무관 오탐 0. 0.68 은 경계 참 별칭
 *     (고양이↔cat 0.7106)의 실행 간 ±0.04 변동(배치 구성에 따른 q8 수치 흔들림
 *     실측)에 여유를 둔 값 — 관련-비별칭 오탐 수는 0.70 과 동일하다. 별칭
 *     suggestion 은 대시보드 소유자 승인 게이트를 거치므로 오탐 저비용·미탐
 *     고비용 — 낮은 쪽을 택했다.
 *
 * 이력: 옛 상수 0.95(concept-alias-detect.ts 직접 기재)는 Granite(384-dim)
 * 시절 보정값이었다(자동차↔automobile 0.9600, 2026-05-27 측정). Granite 는
 * c9401687 에서 제거됐고 bge-m3 는 같은 쌍에 0.8774 를 줘, 0.95 로는 별칭
 * 검출이 사실상 정지 상태였다.
 */
export const EMBEDDING_ALIAS_THRESHOLDS: Readonly<Record<EmbedderModel, number>> =
  {
    "bge-m3": 0.68,
  };

/**
 * 모델 식별자에서 개념 별칭 후보 판정 임계를 돌려준다. vectorBaselineOf 와 같은
 * 양식 — 알 수 없는 값이면 명시 throw (mock/silent fallback 금지).
 *
 * 소비 흐름: concept-alias-detect.ts 의 CONCEPT_ALIAS_THRESHOLD 가
 * DEFAULT_EMBEDDER_MODEL 로 이 값을 얻어 store 의 검출·적재 경로
 * (findSimilarConcepts → detectAndSaveAliasSuggestions) default 로 흐른다.
 */
export function aliasThresholdOf(model: EmbedderModel): number {
  const threshold = EMBEDDING_ALIAS_THRESHOLDS[model];
  if (threshold === undefined) {
    throw new Error(
      `Unknown embedding model="${model}". Valid values: ${VALID_MODELS.join(", ")}`,
    );
  }
  return threshold;
}

/**
 * 모델 식별자 → 저장 시 유사-중복 차단 임계 단일 출처.
 *
 * store 경로가 들어온 글의 임베딩을 기존 기억과 견주어 이 값 이상이면 "이미
 * 있는 기억"으로 보고 저장을 막는다. 관측 단위가 **원문(raw memory)** 이라는
 * 점이 핵심이다 — EMBEDDING_CONFLICT_THRESHOLDS.dedupSim(0.85)은 extractor 가
 * 뽑아낸 *항목(fact)* 단위 임계라 척도가 다르다. 그 값을 그대로 옮겨오면
 * 안 되고, 원문 단위로 따로 재야 한다(2026-07-10 fail 21건 사건의 교훈 —
 * 측정 → 등록 → 활성화 순서).
 *
 * - bge-m3 → 0.89
 *     **2026-08-03 본 PC 실측 확정값** — 운영 동일 경로(Xenova/bge-m3 q8 ·
 *     cls pooling · normalize, 원문 1건씩 개별 embed)로 95쌍 측정.
 *     쌍 구성은 실제 store_memory 입력 문체(한국어 주도 + 기술 영어 혼재,
 *     한 문장~짧은 문단)를 손으로 작성했다.
 *
 *     갈래별 분포 (min / p50 / max):
 *       진짜 중복 32쌍        0.7156 / 0.9348 / 1.0000  (mean 0.9142)
 *         - verbatim 변형 10쌍      0.9314 / 0.9723 / 1.0000
 *         - 경미한 바꿔쓰기 12쌍    0.7156 / 0.8545 / 0.8925
 *         - 사소한 덧붙임 10쌍      0.8667 / 0.9463 / 0.9755
 *       관련-비중복 33쌍      0.3997 / 0.6065 / 0.8514  (mean 0.6131)
 *         - 같은 주제 다른 결정 9쌍 0.4639 / 0.6053 / 0.8514
 *         - 같은 대상 다른 사건 8쌍 0.5291 / 0.5801 / 0.6748
 *         - 정보를 더하는 후속 8쌍  0.5967 / 0.6979 / 0.7822
 *         - 같은 종류 다른 주제 8쌍 0.3997 / 0.5700 / 0.6991
 *       무관 30쌍             0.2764 / 0.3640 / 0.4737  (mean 0.3584)
 *
 *     **오탐 0 제약이 값을 결정한다.** 관련-비중복의 최고값은 0.8514 —
 *     "conflictLow 임계는 0.55" 대 "conflictHigh 임계는 0.85" 쌍으로,
 *     문장 뼈대가 거의 같고 토큰 하나씩만 다르지만 명백히 별개 기억이다.
 *     여기에 q8 수치 흔들림 여유 ±0.04(2026-07-10 별칭 작업 실측)를 더한
 *     0.8914 를 올림 정리해 0.89 로 잡았다.
 *
 *     **맞바꾼 것**: 0.89 에서 진짜 중복 검출은 19/32(59.4%)에 그친다.
 *     못 잡는 13쌍은 전부 경미한 바꿔쓰기 갈래(0.7156~0.8925)로, 사람이
 *     읽으면 같은 말이지만 낱말을 갈아끼워 cosine 이 관련-비중복 구간까지
 *     내려온 쌍들이다. 이 미탐을 줄이려 임계를 낮추면 0.86 미만부터 R07 같은
 *     별개 기억을 막기 시작한다. 미탐은 downstream 중복 정리가 걷어가고
 *     에이전트에게 force 우회도 있어 회복 가능하지만, 오탐은 사용자가 남기려던
 *     기억을 조용히 되돌려보내 왕복을 한 번 더 물린다 — 그래서 오탐 0 쪽을
 *     택했다(spec D-A 판단 그대로).
 *
 *     계측기 건전성: 세 갈래 분포가 서로 겹치지 않고 벌어져 있어 압축·천장
 *     붙음이 없다(T2 handoff 주의사항 대조 완료). 동일 조건 2회 연속 실행이
 *     소수점 4자리까지 완전 일치 — 원문 1건씩 개별 embed 경로는 결정적이다.
 */
export const EMBEDDING_STORE_DUPLICATE_THRESHOLDS: Readonly<
  Record<EmbedderModel, number>
> = {
  "bge-m3": 0.89,
};

/**
 * 모델 식별자에서 저장 시 유사-중복 차단 임계를 돌려준다. aliasThresholdOf 와
 * 같은 양식 — 알 수 없는 값이면 명시 throw (mock/silent fallback 금지).
 */
export function storeDuplicateThresholdOf(model: EmbedderModel): number {
  const threshold = EMBEDDING_STORE_DUPLICATE_THRESHOLDS[model];
  if (threshold === undefined) {
    throw new Error(
      `Unknown embedding model="${model}". Valid values: ${VALID_MODELS.join(", ")}`,
    );
  }
  return threshold;
}

/**
 * 결과 하한선 적용 방식 — T20 이 이 판별자로 갈래를 고른다.
 *
 * - "absolute"       : 결과의 raw vector cosine 이 floor 미만이면 버린다.
 * - "baselineMargin" : 질의별 배경 유사도 + margin 을 하한으로 쓴다.
 *
 * 두 방식을 다 실측한 결과 bge-m3 에서는 absolute 가 이겼다(아래 맵 주석).
 * baselineMargin 갈래는 다른 모델에서 역전될 수 있어 타입에 남긴다 — 지금
 * 등록된 모델이 없으므로 T20 은 absolute 갈래만 구현하면 되고, 새 방식이
 * 등록되기 전까지 이 판별자는 항상 "absolute" 다.
 */
export type ResultFloorParams =
  | { mode: "absolute"; floor: number }
  | { mode: "baselineMargin"; baselinePercentile: number; margin: number };

/**
 * 모델 식별자 → AI 검색 결과 하한선(무관 결과 컷) 단일 출처.
 *
 * **관측 대상은 `RetrievalResult.components.vectorRawCosine`** — 보정 전 raw
 * vector cosine 이다. 융합 최종 점수(`result.score`)가 아니라는 점이 핵심이다.
 * 실측에서 unanswerable 문항의 최종 점수 최대값(0.3828)이 gold 최대값(0.3828)과
 * 완전히 같아, 융합 점수로는 어떤 값을 잡아도 무관 결과와 정답이 안 갈린다.
 * RRF 는 순위만 보고 절대 강도를 버리기 때문이다. raw cosine 은 절대 강도를
 * 보존해 두 갈래가 갈린다(아래 분포).
 *
 * 이미 있는 `EMBEDDING_VECTOR_BASELINES`(0.5)와는 하는 일이 다르다 — 그쪽은
 * `applyBaselineFloor` 가 *정밀 강도를 0 으로 깎는* 게이트라 결과를 지우지
 * 않는다. 이 값은 *결과를 목록에서 버리는* 하한이라 척도가 같아도 값이 다르다.
 *
 * - bge-m3 → { mode: "absolute", floor: 0.44 }
 *     **2026-08-03 본 PC 실측 확정값** — 운영 동일 경로(임시 :memory: DB +
 *     실제 bge-m3 + 실제 HybridRetriever)로 확장 손 정답 셋 42문항을 넓은 창
 *     (상한 20)·좁은 창(상한 3) 양쪽에서 측정.
 *
 *     raw cosine 분포 (넓은 창 / min·p50·max):
 *       gold 결과 45건          0.4788 / 0.6638 / 0.8675
 *       비-gold 결과 735건      0.3117 / 0.4181 / 0.6782
 *       unanswerable 결과 60건  0.3762 / 0.4297 / 0.5686
 *
 *     **두 방식을 다 재고 absolute 를 골랐다.** baselineMargin(질의별 결과
 *     cosine 분위수 + margin)은 어느 조합에서도 absolute 를 못 이겼다 — 예를
 *     들어 좁은 창 p75+margin 0.02 는 42문항 중 37문항의 정답을 통째로 날려
 *     nDCG 가 0 이 됐다. 질의마다 결과 분포 폭이 달라 분위수 기준선이 정답이
 *     빽빽한 질의에서 정답 한가운데를 잘라버리기 때문이다. 절대 cosine 척도가
 *     모델 고정이라 질의별 재추정보다 안정적이었다.
 *
 *     **회수 손실 0 상한은 0.4788** (gold 최저값 EX19). 0.479 부터 곧바로
 *     정답을 잃는다. 거기 딱 붙이지 않고 0.44 로 내린 이유는 q8 수치 흔들림
 *     ±0.04(2026-07-10 별칭 작업 실측)다 — 0.4788 에 걸면 흔들림 한 번에
 *     정답이 사라진다. 0.44 는 최저 gold 아래로 0.0388 여유를 둔다.
 *
 *     **효과**(0.44 / 넓은 창 → 좁은 창):
 *       nDCG·recall·MRR·MAP  변화 0 (소수점 6자리까지 동일 — 꼬리만 걷고
 *                            순위는 안 건드린다는 설계 의도 그대로)
 *       precision            0.0551 → 0.3271 / 0.3419 → 0.4444
 *       F1                   0.1039 → 0.4226 / 0.4940 → 0.5752
 *       비-gold 꼬리 제거     62.0% (456/735) / 18.7% (14/75)
 *
 *     **못 한 것 — 정직 기록**: unanswerable 3문항 중 1문항만 완전히 비웠다
 *     (3/3 → 2/3 이 결과를 반환). EX41("작년 겨울에 스키장 어디로 갔었지?")이
 *     무관 결과에 0.5686 을 받는데, 이는 gold 최저값 0.4788 보다 높다. 즉 두
 *     갈래 분포가 실제로 겹쳐 있어 **어떤 하한값으로도 회수 손실 없이 세 문항을
 *     다 비울 수 없다**. 세 문항을 다 비우려면 floor 0.57 이 필요하고 그때
 *     정답 4~5건을 잃는다(넓은 창 회수손실 4문항). 사용자 결정 D-B 는 회수
 *     손실 0 이 상위 제약이므로 부분 효과를 택했다. 남은 무관 결과는 정리
 *     대상으로 남는다.
 *
 *     계측기 건전성: 동일 조건 2회 연속 실행이 완전 일치(결정적).
 */
export const EMBEDDING_RESULT_FLOOR_PARAMS: Readonly<
  Record<EmbedderModel, ResultFloorParams>
> = {
  "bge-m3": { mode: "absolute", floor: 0.44 },
};

/**
 * 모델 식별자에서 결과 하한선 파라미터를 돌려준다. storeDuplicateThresholdOf 와
 * 같은 양식 — 알 수 없는 값이면 명시 throw (mock/silent fallback 금지).
 *
 * T20 이 AI 경로 검색 결과를 거를 때 이 값을 읽는다. 반환값의 `mode` 로 갈래를
 * 고르고, 관측 대상은 `RetrievalResult.components.vectorRawCosine` 이다.
 */
export function resultFloorParamsOf(model: EmbedderModel): ResultFloorParams {
  const params = EMBEDDING_RESULT_FLOOR_PARAMS[model];
  if (params === undefined) {
    throw new Error(
      `Unknown embedding model="${model}". Valid values: ${VALID_MODELS.join(", ")}`,
    );
  }
  return params;
}

export interface CreateEmbedderOptions {
  /** memory-schema embedding.model 값. 미지정 시 bge-m3 디폴트. */
  model?: EmbedderModel;
}

/**
 * Embedder factory — `memory-schema db.embeddingModel` 식별자 그대로 받아 인스턴스를 만든다.
 *
 * 기본값은 `"bge-m3"` (2026-06-01 정식 전환 — A1 실측에서 글 유사도 분별이
 * 확실히 나음). 알 수 없는 값이면 본 프로젝트의 mock/silent fallback 금지 정책에
 * 따라 명시적으로 throw 한다.
 *
 * S10 정착 (2026-05-19) 후 env 직접 읽기는 제거 — caller (server.ts createMemoryApi)
 * 가 settings.embedding.model 을 명시적으로 전달한다. 옛 `EMBEDDING_MODEL` env 는
 * `data/memory-settings.json` 의 embedding.model 로 이전.
 *
 * 반환값은 인스턴스만 — `load()` 호출은 caller 책임 (server.ts·smoke 패턴 유지).
 */
export function createEmbedder(opts: CreateEmbedderOptions = {}): Embedder {
  const model = opts.model ?? DEFAULT_EMBEDDER_MODEL;

  if (!(VALID_MODELS as readonly string[]).includes(model)) {
    throw new Error(
      `Unknown embedding model="${model}". Valid values: ${VALID_MODELS.join(", ")}`,
    );
  }

  return new Bgem3Embedder();
}

export interface CreateImageEmbedderOptions {
  /** 모델 로드 중 파일별 다운로드 진행을 받을 콜백(선택, prefetch 전용). */
  progressCallback?: ProgressCallback;
}

/**
 * Image embedder factory — Phase 11a T2 정착. 운영 default = SigLIP 2
 * base-256 (`onnx-community/siglip2-base-patch16-256-ONNX`, 768-dim).
 *
 * 단일 모델 운영 흐름이라 인자 없이 singleton 을 돌려준다. 향후 모델
 * 변체 (예: large-384) 도입 시 텍스트 factory 정합으로 `model` 옵션을
 * 추가한다. 단위 test 는 결정성을 위해 `new Siglip2Embedder()` 직접
 * 인스턴스화 가능.
 */
export function createImageEmbedder(
  opts: CreateImageEmbedderOptions = {},
): ImageEmbedder {
  // 진행 콜백은 첫 설치 prefetch 스크립트 전용 — 콜백이 있을 때만 별도 인스턴스를
  // 만들고, 없으면 운영 singleton 을 그대로 돌려줘 서버 동작은 달라지지 않는다.
  if (opts.progressCallback) {
    return new Siglip2Embedder({ progressCallback: opts.progressCallback });
  }
  return siglip2Embedder;
}
