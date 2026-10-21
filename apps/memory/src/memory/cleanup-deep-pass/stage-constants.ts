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
 * 여러 개를 함께 싣는 구조화 초안이라 다른 단계보다 입력·출력이 크다. 출력 한도는
 * 엔티티 수에 비례한다(아래 맵 항목 주석의 계산).
 *
 * 한도 값만 바꾸는 것은 stageVersion 을 올릴 사유가 아니다(재평가 신호는 프롬프트·파서
 * 계약 변경 전용). 잘림으로 terminal 이 된 대상은 한도만 올려서는 다시 후보가 되지 않는다.
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
 * 생각(thinking) 몫 — 대상 수와 무관하게 한 호출이 먼저 쓰는 출력 토큰. 실측(2026-10-10,
 * claude-haiku-5-5, entity_register 메모 10개 묶음): 생각만 1293~1512 토큰을 썼다. 2048 =
 * 실측 최대치 1512 + 여유 536. 다른 단계는 아직 따로 잰 값이 없어 이 단일 실측을 같이 쓴다
 * (단계별로 재면 그 단계 항목만 고친다). 생각이 없는 모델에는 쓰지 않은 한도가 과금되지 않는다.
 */
const THINKING_RESERVE_TOKENS = 2048;

/**
 * 정규식 강화 답 글 몫 — 후보 글 하나에 대한 양식 제안 배열. 원소 하나 = pattern·score·category·
 * polarity·exampleInput·exampleExtracted·description·rationale 8칸 약 200~250 토큰(예문·설명이 한국어
 * 한두 문장), 확실한 것만 내라는 지시라 보통 1~3개 → 최대 약 750. 옛 고정 한도 768 이 바로 이 답 글
 * 몫이었고, 생각 몫이 따로 없어 생각을 쓰는 모델에서는 답 글 전에 한도가 찼다.
 */
const REGEX_STRENGTHEN_ANSWER_TOKENS = 768;

/**
 * 단계별 LLM 상수 단일 출처(spec 5.B-3 표 그대로). 값을 이 맵 밖 리터럴로
 * 남기지 않는다 — 새 stage 추가 시 이 맵에 함께 등록한다.
 */
export const CLEANUP_STAGE_LLM_LIMITS: Readonly<
  Record<CleanupStageLlmKey, CleanupStageLlmLimits>
> = {
  // 정규식 강화 — 호출 하나에 후보 글 하나라 대상 몫(outputTokensPerItem)이 없다.
  // 한도 = 생각 2048 + 답 글 768 = 2816. 잘림 재호출 상한 = 2816 × 2 = 5632(실행층이 2배로 올릴
  // 여지를 그대로 남긴다 — 옛 상한 3072 는 2배 재호출이 256 토큰밖에 못 늘렸다).
  regex_strengthen: {
    maxOutputTokens: THINKING_RESERVE_TOKENS + REGEX_STRENGTHEN_ANSWER_TOKENS,
    maxOutputTokensCap: 2 * (THINKING_RESERVE_TOKENS + REGEX_STRENGTHEN_ANSWER_TOKENS),
    stageVersion: 1,
  },
  // 요약 — 호출 하나에 한 문서의 청크 여러 개. 청크마다 답 글이 늘어난다.
  //   청크요약 원소 {"chunk_id":숫자,"summary_text":"한 문장","confidence":0~1} = 틀 약 20 + 한국어
  //   한 문장 약 60~80 → 약 100 토큰.
  //   관계요약 원소 {"from_concept_id":"cpt_<uuid>","to_concept_id":"cpt_<uuid>","relation_name",
  //   "summary_text","confidence"} = id 둘 약 50 + 틀 약 25 + 이름·한 문장 약 65 → 약 140 토큰.
  //   관계 수는 청크 수에 묶여 있지 않아 청크당 관계 하나로 잡는다 → 청크당 약 240 → 256.
  //   기본 몫 = 생각 2048. 한 호출 청크 상한은 cleanupStageMaxItemsPerCall 이 이 값들로 계산한다:
  //   (6144 - 2048 - 1) / 256 → 15개(2048 + 15 × 256 = 5888 < 6144). 문서 청크가 더 많으면 사이클이
  //   15개씩 나눠 부른다. 지시문·답 형식을 고치면 stageVersion 을 올린다(2: 관계 발굴 개념을 그 호출
  //   청크로 한정 + "문서 일부일 수 있다" 지시 — 2026-10-19).
  summary: {
    maxOutputTokens: THINKING_RESERVE_TOKENS,
    outputTokensPerItem: 256,
    maxOutputTokensCap: 6144,
    stageVersion: 2,
  },
  // 사람 연결 — 호출 하나에 메모(노드) 여러 개. 메모마다 답 글 원소 하나, 그 안에 연결 목록:
  //   {"nodeId":숫자,"links":[{"personId":"psn_<uuid>","candidateText":"민수","confidence":0.95,
  //   "evidence":"근거 한 줄","uncertain":false}]}
  //   원소 틀(nodeId·links) 약 15 토큰. 연결 하나 = personId(psn_ + uuid) 약 25 + 키·틀 약 30 +
  //   본문 후보 약 5 + 한국어 근거 한 줄 약 40 → 약 100~110 토큰. 메모 하나에 보통 사람 1~2명 →
  //   15 + 2 × 110 = 235 → 256(연결이 없는 메모는 약 15 라 묶음 평균으로는 여유가 더 있다).
  //   기본 몫 = 생각 2048(옛 고정 768 은 생각 몫이 없어 생각을 쓰는 모델에서 답 글 전에 찼다).
  //   한 호출 메모 상한은 cleanupStageMaxItemsPerCall 이 계산: (6144 - 2048 - 1) / 256 → 15개
  //   (2048 + 15 × 256 = 5888 < 6144). 사이클이 15개씩 나눠 부른다. stageVersion 은 사용자 결정으로
  //   1 그대로(2026-10-20 — 이미 처리된 메모를 새 답 형식으로 다시 돌리지 않는다).
  person_link: {
    maxOutputTokens: THINKING_RESERVE_TOKENS,
    outputTokensPerItem: 256,
    maxOutputTokensCap: 6144,
    stageVersion: 1,
    prefilterTopK: 5,
  },
  // 렌즈 초안 — 호출 하나에 엔티티 여러 개. 엔티티마다 답 글 원소 하나:
  //   {"typeName":"종류","entityId":"<접두사><uuid>","values":{"columns":{},"labels":{},"relations":{},"metadata":{}}}
  //   틀·키 약 45 + entityId(uuid) 약 25 + 종류 약 5 → 약 75 토큰.
  //   채운 값 "키":"값" 하나 = 키 약 5 + 한국어 짧은 값 약 15~20 → 약 25 토큰, 엔티티당 빈 칸·라벨·
  //   metadata 최대 약 6개 → 약 150. 합 약 225 → 256(relations 는 2026-10-19 부터 항상 {} 라 몫 0).
  //   기본 몫 = 생각 2048. 옛 상한 4096 이면 (4096 - 2048 - 1) / 256 → 7개라 기본 batchSize 20 이
  //   호출 3번(생각 3번 과금)으로 쪼개진다 — 상한을 요약·항목 등록과 같은 6144 로 올려 한 호출
  //   15개(2048 + 15 × 256 = 5888 < 6144)를 담는다. 한 호출 상한은 cleanupStageMaxItemsPerCall 이 계산.
  //   stageVersion 2 = 관계(relations) 채우기 요청 폐기(2026-10-19 지시문 변경).
  lens_draft: {
    maxOutputTokens: THINKING_RESERVE_TOKENS,
    outputTokensPerItem: 256,
    maxOutputTokensCap: 6144,
    stageVersion: 2,
  },
  // 항목·일정 자동 등록(2026-10-10 spec). 메모 묶음당 메모별 항목 목록 + 날짜 + 제목 JSON 이라
  // 출력이 묶음 크기에 비례한다 — 한도는 cleanupStageMaxOutputTokensFor 가 묶음 메모 수로 정한다.
  // 실측(2026-10-10, claude-haiku-5-5, 메모 10개): 생각(thinking) 1293~1512 토큰 + 답 글 약 760 토큰
  // (메모당 약 76). 옛 고정 1536 은 생각만으로 다 차서 잘렸다. 기본 몫 2048 = 생각 실측 최대치 +
  // 여유, 메모당 128 = 실측 76 의 여유분. 생각이 없는 모델에는 쓰지 않은 한도가 과금되지 않는다.
  // 지시문·답 형식을 고치면 stageVersion 을 올린다(전체 메모 1회 재처리 — 의도된 동작).
  entity_register: { maxOutputTokens: THINKING_RESERVE_TOKENS, outputTokensPerItem: 128, maxOutputTokensCap: 6144, stageVersion: 1 },
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

/**
 * 대상을 여러 개 싣는 단계가 한 호출에 실을 수 있는 최대 대상 수. 기본 몫 + n × 대상 몫이
 * maxOutputTokensCap 보다 *작은* 가장 큰 n — 첫 호출이 이미 상한에 닿으면 잘림이 나도 실행층이
 * 한도를 더 올릴 수 없어 재호출이 같은 잘림을 되풀이(유료 호출 낭비)하기 때문이다. 사이클이 이
 * 값으로 대상을 나눠 부른다. 대상 몫이 없는 단계(호출당 대상 하나)나 상한이 기본 몫 + 대상 하나도
 * 못 담는 잘못된 맵이면 던진다(조용한 기본값 금지).
 */
export function cleanupStageMaxItemsPerCall(stage: CleanupStageLlmKey): number {
  const limits = cleanupStageLlmLimitsOf(stage);
  if (limits.outputTokensPerItem === undefined) {
    throw new Error(`cleanup stage="${stage}" 는 대상 몫(outputTokensPerItem)이 없는 단계 — 호출당 대상 수 상한 없음`);
  }
  const maxItems = Math.floor(
    (limits.maxOutputTokensCap - limits.maxOutputTokens - 1) / limits.outputTokensPerItem,
  );
  if (maxItems < 1) {
    throw new Error(
      `cleanup stage="${stage}" 한도 맵 결함: 상한 ${limits.maxOutputTokensCap} 이 기본 몫 ${limits.maxOutputTokens} + 대상 하나 ${limits.outputTokensPerItem} 를 못 담음`,
    );
  }
  return maxItems;
}
