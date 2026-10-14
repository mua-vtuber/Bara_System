/**
 * memory-schema-groups-backfill-retry.ts — 자동 추출·캡션 백필의 재시도 설정 스키마 조각 (2026-10-14 backfill-retry-ledger spec 4.4).
 *
 * memory-schema-groups-pipeline.ts 가 이미 800줄을 넘어 새 칸은 이 파일에 두고 그쪽은 끼우기만 한다.
 * 추출(llm.extractor.backfill)과 캡션(llm.vision.backfill)이 같은 세 칸을 쓴다 — 설명의 대상 이름만 다르다.
 * 두 칸 관계(최대 대기 ≥ 첫 대기)는 한 칸 검사로 볼 수 없어 memory-settings-validate.ts 의 backfillRetryDelayErrors 가 본다.
 */

/** 재시도 대기 칸의 상한(분) — 7일. */
export const BACKFILL_RETRY_DELAY_MAX_MIN = 10080;
/** 자동 재시도 최대 횟수 칸의 상한. */
export const BACKFILL_MAX_ATTEMPTS_LIMIT = 50;

export const BACKFILL_RETRY_REQUIRED = ["maxAttempts", "retryDelayMin", "retryMaxDelayMin"] as const;

/** 대상 이름이 들어간 설명 조각 — 예: { subject: "같은 글이", object: "실패한 글을" }. */
function retryProperties(words: { subject: string; object: string }) {
  return {
    maxAttempts: {
      type: "integer",
      title: "자동 재시도 최대 횟수",
      description: `${words.subject} 이만큼 실패하면(시간 초과 포함) 자동 재시도를 멈추고 설정 화면의 멈춘 목록에 보인다. 연결 실패와 일시 장애(429·5xx)는 세지 않는다. default 5.`,
      default: 5,
      minimum: 1,
      maximum: BACKFILL_MAX_ATTEMPTS_LIMIT,
    },
    retryDelayMin: {
      type: "integer",
      title: "첫 재시도 대기 (분)",
      description: `${words.object} 다시 시도하기 전 기다리는 시간. 실패할 때마다 대기가 배수로 늘고 최대 재시도 대기에서 멈춘다. default 30.`,
      default: 30,
      minimum: 1,
      maximum: BACKFILL_RETRY_DELAY_MAX_MIN,
    },
    retryMaxDelayMin: {
      type: "integer",
      title: "최대 재시도 대기 (분)",
      description: "늘어나는 대기 시간의 상한. 첫 재시도 대기보다 작으면 저장을 거부한다. default 1440 (하루).",
      default: 1440,
      minimum: 1,
      maximum: BACKFILL_RETRY_DELAY_MAX_MIN,
    },
  } as const;
}

export const extractorBackfillRetryProperties = retryProperties({ subject: "같은 글이", object: "실패한 글을" });
export const visionBackfillRetryProperties = retryProperties({ subject: "같은 이미지가", object: "실패한 이미지를" });
