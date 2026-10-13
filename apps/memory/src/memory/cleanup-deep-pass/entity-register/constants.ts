/**
 * entity-register/constants.ts — 항목·일정 자동 등록 단계(2026-10-10 spec)의 이름·상수 단일 출처.
 * 단계 LLM 한도·stageVersion 은 stage-constants.ts(CLEANUP_STAGE_LLM_LIMITS.entity_register)가,
 * 언어 의존 단어는 lang/ko.yaml 이 단일 출처다 — 여기에는 이 단계 고유의 구조 상수만 둔다.
 */
import type { CleanupStage } from "../stage-fingerprint.ts";
import type { CycleStage } from "../cycle-budget.ts";
import type { Provenance } from "../../provenance-vocabulary.ts";
import { placementTypeNames } from "../../concept-type-vocabulary.ts";
import type { RecordDecidedBy } from "./types.ts";

export const ENTITY_REGISTER_KIND = "entity_register";
export const ENTITY_REGISTER_LEDGER_STAGE: CleanupStage = "entity_register";
export const ENTITY_REGISTER_CYCLE_STAGE: CycleStage = "entityRegister";
export const ENTITY_REGISTER_EXTERNAL_STAGE = "entityRegister" as const;

/** AI 지시문에 설명을 붙여 보내는 기본 종류 — 1.1 실험 지시문의 8종. */
export const ENTITY_REGISTER_STATIC_TYPES = [
  "person", "creature", "thing", "intake", "usable", "work", "material", "place",
] as const;

/** 이 단계가 만들지 않는 배치 종류. project 는 명시 태그로만, schedule 은 일정 노드로 다룬다. */
export const ENTITY_REGISTER_EXCLUDED_TYPES: ReadonlySet<string> = new Set(["project", "schedule"]);

export const ENTITY_REGISTER_LIMITS = {
  /** 항목 이름 최대 글자 수 — 넘으면 AI 답을 버린다(문장을 이름으로 돌려준 경우). */
  nameMaxChars: 60,
  /** 일정 제목 최대 글자 수 — 넘으면 제목을 고쳐 승인하는 제안으로 보낸다(지시문은 15자 이내 요청). */
  titleMaxChars: 30,
  /** 지시문이 AI에게 요청하는 일정 제목 길이 — titleMaxChars 는 검사기의 하드 상한이고, 이 값은 요청 문구용이다. */
  titleRequestChars: 15,
  /** 메모 하나에서 받는 항목 수 상한 — 넘는 답은 형식 오류로 본다. */
  maxEntitiesPerMemo: 30,
  /** 비슷한 이름(spec 4.3)·호칭 분리(4.2)에서 짧은 쪽이 가져야 할 최소 글자 수. */
  minSimilarNameChars: 2,
  /** 한 사이클에 모으는 후보 메모 수 상한(예산이 먼저 막으면 그보다 적다). */
  maxCandidatesPerCycle: 200,
  /** 후보 메모를 훑을 때 한 번에 읽는 행 수(원장 거름 뒤 상한까지 반복). */
  candidateScanPageSize: 500,
  /** 최근 자동 등록 목록 한 번 조회 상한. */
  recentListMaxLimit: 100,
  /** 최근 자동 등록 목록에서 limit 을 주지 않았을 때 한 번에 돌려주는 수(대시보드는 limit 을 보내지 않는다). */
  recentListDefaultLimit: 20,
  /** run 결과에 남기는 실패 사유 개수 상한. */
  failureReasonsKept: 10,
} as const;

export const ENTITY_REGISTER_TRIGGER_TIMING = {
  /** 저장 뒤 같은 대기열로 모으는 시간 — 연속 저장을 한 회차로 묶는다. */
  debounceMs: 3_000,
  /** 다른 정리 회차가 도는 중이면 다시 시도하기까지 기다리는 시간. */
  busyRetryMs: 60_000,
} as const;

/** 연결 엣지 출처 — 자동 반영은 정리 AI 추출(llm_extract), 승인 반영은 사용자 승인(evolver, 기존 승인 라우트와 같음). */
export const ENTITY_REGISTER_EDGE_PROVENANCE: Readonly<Record<RecordDecidedBy, Provenance>> = {
  auto: "llm_extract",
  approved: "evolver",
};

/** 일정 노드 metadata 칸 이름 — #일정: 입력(save-input-entity-branches.ts)과 같은 표시 칸. */
export const SCHEDULE_OCCURRENCE_KEY = "scheduleOccurrence";
/** 일정 노드가 어느 원본 메모에서 나왔는지 — 달력 중복 제거(buildDateOccurrences)가 읽는다. */
export const SCHEDULE_SOURCE_NODE_KEY = "scheduleSourceNodeId";
/** 일정 노드 metadata 의 이 단계 기록 칸({ runId, decidedBy }). */
export const ENTITY_REGISTER_METADATA_KEY = "entityRegister";

/** AI가 고를 수 있는 종류 — 배치 가능 종류(정적 10 + 사용자 종류) 중 제외 종류를 뺀 것. */
export function entityRegisterTypeNames(): string[] {
  return placementTypeNames().filter((t) => !ENTITY_REGISTER_EXCLUDED_TYPES.has(t));
}
