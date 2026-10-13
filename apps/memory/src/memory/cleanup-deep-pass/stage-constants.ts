/**
 * stage-constants.ts — 깊은 패스 단계별 LLM 상수 단일 출처 맵 (spec 5.B-3).
 *
 * `EMBEDDING_DIMENSIONS`/`EMBEDDING_VECTOR_BASELINES`(embedding/factory.ts) 선례와
 * 같은 양식 — 단계별 maxOutputTokens·maxOutputTokensCap·stageVersion(+person_link
 * prefilterTopK)이 이 맵 하나에서만 나온다. 이전에는 regex-strengthen-cycle.ts·
 * summary-cycle.ts·person-link-infer-cycle.ts·index.ts 에 같은 값이 각자 모듈
 * 상수·인라인 리터럴로 흩어져 있었다 — 이 맵이 그 흩어진 하드코딩을 거두어 단일
 * 권위로 만든다.
 *
 * `stageVersion` 은 결과 원장(cleanup_stage_results, spec 4.A-3)의 재평가 신호가
 * 사는 곳이다 — 프롬프트·파서 계약을 고치면 여기서 올린다. relation_discovery 는
 * summary-cycle.ts 사이클 안에 사는 stage 라 별도 맵 항목이 없다(summary 항목의
 * stageVersion 을 그대로 공유 — plan Task 9 지시).
 *
 * DCL-2: maxOutputTokens/temperature 설정 승격은 0(프롬프트·파서와 짝인 내부
 * 계약 — 여는 순간 파싱 실패를 사용자가 유발하는 통로). `personLink.batchSize`·
 * `lensDraft.batchSize` 만 설정으로 승격한다(이 맵 밖, B-3b/B-2/C-2 소관).
 * metadata_fill 의 512 는 extractor 계열 소관이라 이 맵 밖(C-1 결정).
 *
 * lens_draft 는 C-2b 에서 합류한 4번째 단계다 — 한 엔티티당 렌즈 계약 + 근거 노드
 * 여러 개를 함께 싣는 구조화 초안이라 다른 단계보다 입력·출력이 크다. maxOutputTokens
 * 1024(다중 칸·라벨·관계 초안 JSON)·maxOutputTokensCap 4096(잘림 재호출 상한 — 큰
 * 배치 입력 대비 넉넉히).
 */

/** 이 맵에 등록된 깊은 패스 LLM 단계 식별자. */
export type CleanupStageLlmKey =
  | "regex_strengthen"
  | "summary"
  | "person_link"
  | "lens_draft"
  | "entity_register";

/** 단계별 LLM 호출 한도 + 계약 버전. person_link 만 prefilterTopK 를 더 갖는다. */
export interface CleanupStageLlmLimits {
  /** 정상 호출 출력 상한(spec 5.B-3 표). */
  maxOutputTokens: number;
  /** max_tokens 잘림 시 2배 재호출 출력 상한(spec 5.B-3 표). */
  maxOutputTokensCap: number;
  /** 결과 원장 재평가 신호 — 프롬프트·파서 계약을 고치면 올린다. */
  stageVersion: number;
  /** person_link 전용 — 결정적 top-K 사전 필터 상한(spec 4.A-7). */
  prefilterTopK?: number;
  /**
   * 한 호출에 대상 여러 개를 싣는 단계 전용 — 대상 하나당 더하는 출력 몫. 이 칸이 있으면
   * maxOutputTokens 는 "대상 수와 무관한 기본 몫"(생각 여유 + 답 틀)이 되고, 실제 호출 한도는
   * cleanupStageMaxOutputTokensFor(stage, 대상 수) 가 기본 몫 + 대상 수 × 이 값(cap 이하)으로 정한다.
   */
  outputTokensPerItem?: number;
}

/**
 * 단계별 LLM 상수 단일 출처(spec 5.B-3 표 그대로). 값을 이 맵 밖 리터럴로
 * 남기지 않는다 — 새 stage 추가 시 이 맵에 함께 등록한다.
 */
export const CLEANUP_STAGE_LLM_LIMITS: Readonly<
  Record<CleanupStageLlmKey, CleanupStageLlmLimits>
> = {
  regex_strengthen: { maxOutputTokens: 768, maxOutputTokensCap: 3072, stageVersion: 1 },
  summary: { maxOutputTokens: 1536, maxOutputTokensCap: 6144, stageVersion: 1 },
  person_link: {
    maxOutputTokens: 768,
    maxOutputTokensCap: 3072,
    stageVersion: 1,
    prefilterTopK: 5,
  },
  lens_draft: { maxOutputTokens: 1024, maxOutputTokensCap: 4096, stageVersion: 1 },
  // 항목·일정 자동 등록(2026-10-10 spec). 메모 묶음당 메모별 항목 목록 + 날짜 + 제목 JSON 이라
  // 출력이 묶음 크기에 비례한다 — 한도는 cleanupStageMaxOutputTokensFor 가 묶음 메모 수로 정한다.
  // 실측(2026-10-10, claude-haiku-5-5, 메모 10개): 생각(thinking) 1293~1512 토큰 + 답 글 약 760 토큰
  // (메모당 약 76). 옛 고정 1536 은 생각만으로 다 차서 잘렸다. 기본 몫 2048 = 생각 실측 최대치 +
  // 여유, 메모당 128 = 실측 76 의 여유분. 생각이 없는 모델에는 쓰지 않은 한도가 과금되지 않는다.
  // 지시문·답 형식을 고치면 stageVersion 을 올린다(전체 메모 1회 재처리 — 의도된 동작).
  entity_register: { maxOutputTokens: 2048, outputTokensPerItem: 128, maxOutputTokensCap: 6144, stageVersion: 1 },
};

/**
 * 항목·일정 자동 등록 묶음 크기(batchSize) 상한 — 설정 스키마(maximum)와 설정 이관(clamp)이 함께 읽는 단일 출처.
 * 32개 이상이면 첫 호출부터 출력 한도 상한(maxOutputTokensCap)에 닿아, 잘림이 나도 한도를 더 올릴 수 없고
 * 메모 하나씩 다시 보내는 길뿐이다. 30개면 기본 몫 + 30 × 대상 몫이 상한 아래라 잘림 재호출 여지가 남는다.
 */
export const ENTITY_REGISTER_BATCH_SIZE_MAX = 30;

/**
 * 깊은 패스 LLM 호출 온도 — 4 stage 공유(spec 5.B-3). 강한 모델이라도 재현성을
 * 높여 과넓은 규칙·환각을 줄인다(추출 흐름·갈래2 와 같은 보수값).
 */
export const CLEANUP_STAGE_TEMPERATURE = 0.1;

const VALID_STAGE_KEYS: readonly CleanupStageLlmKey[] = [
  "regex_strengthen",
  "summary",
  "person_link",
  "lens_draft",
  "entity_register",
];

/**
 * stage 식별자에서 LLM 한도를 돌려준다. `embeddingDimensionOf`/`vectorBaselineOf`
 * 와 같은 정신 — 미등록 stage 는 명시 throw(mock/silent fallback 금지). lens_draft
 * 등 아직 이 맵에 없는 stage 를 조회하면 여기서 걸린다.
 */
export function cleanupStageLlmLimitsOf(stage: CleanupStageLlmKey): CleanupStageLlmLimits {
  const limits = CLEANUP_STAGE_LLM_LIMITS[stage];
  if (limits === undefined) {
    throw new Error(
      `Unknown cleanup stage="${stage}". Valid values: ${VALID_STAGE_KEYS.join(", ")}`,
    );
  }
  return limits;
}

/**
 * 대상 itemCount 개를 한 번에 싣는 호출의 출력 한도. outputTokensPerItem 이 있는 단계는
 * 기본 몫 + itemCount × 대상 몫을 maxOutputTokensCap 으로 자르고, 없는 단계는 maxOutputTokens
 * 그대로다. itemCount 가 1 이상 정수가 아니면 던진다(호출부 결함을 조용히 넘기지 않는다).
 */
export function cleanupStageMaxOutputTokensFor(stage: CleanupStageLlmKey, itemCount: number): number {
  if (!Number.isInteger(itemCount) || itemCount < 1) {
    throw new Error(`cleanup stage="${stage}" 출력 한도 계산: 대상 수는 1 이상 정수여야 함 (받은 값: ${itemCount})`);
  }
  const limits = cleanupStageLlmLimitsOf(stage);
  if (limits.outputTokensPerItem === undefined) return limits.maxOutputTokens;
  return Math.min(limits.maxOutputTokens + limits.outputTokensPerItem * itemCount, limits.maxOutputTokensCap);
}
