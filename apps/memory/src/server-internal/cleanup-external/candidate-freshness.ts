/**
 * cleanup-external/candidate-freshness.ts — 외부 제출의 후보 신선도 검사(옛 submitExternalProposal 7~9단).
 * 일반 제안 제출과 entity_register 제출이 같은 검사를 쓰도록 떼어 냈다(순환 import 없이 공유).
 *
 * 세 검사를 차례로 한다 — 문구·상태 코드·current 는 옮기기 전과 같다.
 *   7단. candidate.stageVersion 이 계약 버전과 다름 → 409 + current(계약 버전).
 *   8단. 원장 재제출 대조 — 완료 원장에 이미 기록된 같은 후보(같은 지문·버전)의 재제출은 409.
 *        timeout 재시도가 pending 큐에 중복 제안을 쌓거나, 펫과 서버 사이클이 같은 메모를 두 번
 *        반영하는 길을 막는다. 원장 행은 proposalId 를 안 들고 있어 멱등 회신이 아니라 409 확정.
 *   9단. 서버 지문 재계산 — 대상 부재 404(targetKey 명시), 불일치 409 + current(재계산값).
 *        클라이언트가 낸 지문은 믿지 않는다.
 */
import type { MemoryApiDeps } from "../types.ts";
import { getStageResult } from "../../memory/cleanup-deep-pass/stage-results-ledger.ts";
import { recomputeExternalFingerprint } from "./candidates.ts";
import type { ExternalCandidateStage, ExternalStageContract } from "./stage-map.ts";

/** 등록 대조에 쓰는 candidate 블록(칸 결손 = 400 — 자유 등록 불허, D-6). */
export interface ExternalCandidateRef {
  stage: string;
  targetKey: string;
  inputFingerprint: string;
  stageVersion: number;
}

export type FreshnessFailure = {
  ok: false;
  httpStatus: 404 | 409;
  message: string;
  current?: { inputFingerprint: string; stageVersion: number };
};

export async function checkCandidateFreshness(
  deps: MemoryApiDeps,
  contract: ExternalStageContract,
  stage: ExternalCandidateStage,
  candidate: ExternalCandidateRef,
): Promise<{ ok: true } | FreshnessFailure> {
  // 7단 — candidate.stageVersion 이 계약 버전과 다름 → 409 + current.
  if (candidate.stageVersion !== contract.stageVersion) {
    return {
      ok: false,
      httpStatus: 409,
      message: `stageVersion 불일치 — candidate.stageVersion=${candidate.stageVersion}, 현행 계약=${contract.stageVersion}`,
      current: {
        inputFingerprint: candidate.inputFingerprint,
        stageVersion: contract.stageVersion,
      },
    };
  }

  const db = deps.store.getRawDb();

  // 8단 — 원장 재제출 대조(spec 6.2 "원장 대조").
  const ledgerRow = getStageResult(db, contract.ledgerStage, candidate.targetKey);
  if (
    ledgerRow &&
    (ledgerRow.status === "completed" || ledgerRow.status === "completed_noop") &&
    ledgerRow.inputFingerprint === candidate.inputFingerprint &&
    ledgerRow.stageVersion === candidate.stageVersion
  ) {
    return {
      ok: false,
      httpStatus: 409,
      message: `이미 처리된 후보(원장 completed) — targetKey=${candidate.targetKey}`,
      current: {
        inputFingerprint: ledgerRow.inputFingerprint,
        stageVersion: ledgerRow.stageVersion,
      },
    };
  }

  // 9단 — 서버 지문 재계산. 대상 부재 → 404(targetKey 명시). 불일치 → 409 + current(재계산값).
  const recomputed = await recomputeExternalFingerprint(
    deps,
    stage,
    candidate.targetKey,
  );
  if (recomputed === null) {
    return {
      ok: false,
      httpStatus: 404,
      message: `대상 부재 — targetKey '${candidate.targetKey}' 가 가리키는 노드/엔티티 없음`,
    };
  }
  if (recomputed !== candidate.inputFingerprint) {
    return {
      ok: false,
      httpStatus: 409,
      message: `inputFingerprint 불일치 — 재료가 바뀐 뒤 후보 재조회 필요 (targetKey=${candidate.targetKey})`,
      current: {
        inputFingerprint: recomputed,
        stageVersion: contract.stageVersion,
      },
    };
  }

  return { ok: true };
}
