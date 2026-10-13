/**
 * cleanup-external/stage-map.ts — 정리 외부 표면 stage↔kind 대응 표 단일 출처 (spec 6.2).
 *
 * REST 3표면(후보 조회·제안 등록·무산출 신고)과 MCP 도구가 쓰는 외부 stage 이름
 * (regexStrengthen·personLink·lensDraft·entityRegister)을 내부 원장 stage(regex_strengthen 등)·제안 kind
 * (regex_pattern_add 등)·계약 버전으로 잇는다. 세 값이 이 표 하나에서만 나온다 — 라우트가
 * 문자열을 여러 곳에 직접 기재하지 않는다.
 *
 * stageVersion 은 CLEANUP_STAGE_LLM_LIMITS(stage-constants.ts) 단일 출처를 참조한다 —
 * 계약 버전을 여기서 다시 리터럴로 기재하지 않는다(모델 전환 시 조용히 어긋나는 것 차단).
 *
 * 역방향 조회(kind→stage)는 만들지 않는다 — 소비자 없는 죽은 API. D-3("metadata_fill 외부
 * 통로 없음")은 T9 검증 순서 4단의 stage↔kind 대조가 담당한다: 어떤 외부 stage 의 kind 도
 * metadata_fill 이 아니라(이 표에 없음) 항상 400 으로 걸린다.
 */

import type { CleanupStage } from "../../memory/cleanup-deep-pass/stage-fingerprint.ts";
import { CLEANUP_STAGE_LLM_LIMITS } from "../../memory/cleanup-deep-pass/stage-constants.ts";
import {
  ENTITY_REGISTER_EXTERNAL_STAGE,
  ENTITY_REGISTER_KIND,
  ENTITY_REGISTER_LEDGER_STAGE,
} from "../../memory/cleanup-deep-pass/entity-register/constants.ts";

/** 외부 표면이 노출하는 정리 후보 단계 이름(REST·MCP 공통). */
export const EXTERNAL_CANDIDATE_STAGES = [
  "regexStrengthen",
  "personLink",
  "lensDraft",
  ENTITY_REGISTER_EXTERNAL_STAGE,
] as const;

export type ExternalCandidateStage = (typeof EXTERNAL_CANDIDATE_STAGES)[number];

/** 한 외부 stage 의 내부 원장 stage·제안 kind·계약 버전. */
export interface ExternalStageContract {
  /** 결과 원장(cleanup_stage_results) stage 칸 값. */
  ledgerStage: CleanupStage;
  /** cleanup_proposals.kind 값(등록·무산출 신고가 쓰는 제안 종류). */
  kind: string;
  /** 계약 버전 — CLEANUP_STAGE_LLM_LIMITS 단일 출처 참조. */
  stageVersion: number;
}

/** 외부 stage → 계약 단일 출처(spec 6.2 stage↔kind 표). */
const CONTRACTS: Record<ExternalCandidateStage, ExternalStageContract> = {
  regexStrengthen: {
    ledgerStage: "regex_strengthen",
    kind: "regex_pattern_add",
    stageVersion: CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion,
  },
  personLink: {
    ledgerStage: "person_link",
    kind: "person_link",
    stageVersion: CLEANUP_STAGE_LLM_LIMITS.person_link.stageVersion,
  },
  lensDraft: {
    ledgerStage: "lens_draft",
    kind: "lens_draft",
    stageVersion: CLEANUP_STAGE_LLM_LIMITS.lens_draft.stageVersion,
  },
  [ENTITY_REGISTER_EXTERNAL_STAGE]: {
    ledgerStage: ENTITY_REGISTER_LEDGER_STAGE,
    kind: ENTITY_REGISTER_KIND,
    stageVersion: CLEANUP_STAGE_LLM_LIMITS.entity_register.stageVersion,
  },
};

/**
 * 외부 stage 문자열의 계약을 돌려준다. 표에 없는 문자열(원장 stage 명·metadata_fill·오타
 * 등)은 null — 라우트가 400 으로 옮긴다(silent fallback 금지, 정직한 미지원 판정).
 */
export function externalStageContractOf(stage: string): ExternalStageContract | null {
  return (CONTRACTS as Record<string, ExternalStageContract>)[stage] ?? null;
}
