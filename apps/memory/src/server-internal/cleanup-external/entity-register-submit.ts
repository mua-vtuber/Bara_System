/**
 * cleanup-external/entity-register-submit.ts — 펫·MCP 의 entity_register 제출을 서버 판정으로 처리한다(D7).
 * AI 답(메모 하나)을 받아 신선도 검사 뒤 processEntityRegisterMemo(서버 사이클과 같은 함수)에 넘긴다.
 *
 * 그 함수가 결과 원장도 기록하므로, 펫이 처리한 메모는 서버 사이클이 건너뛰고 반대도 같다(낡은 지문·버전의
 * 늦은 제출은 신선도 검사가 409 로 거른다). 서버 단계 스위치(cleanupDeepPass.entityRegister.enabled)는 보지
 * 않는다 — 펫 사용자는 대개 서버 쪽 유료 정리 AI 를 켜지 않기 때문이다(D6). "확실한 것은 바로 반영"
 * (autoApply)과 처리 불가 시도 상한(reliability.maxAttemptsPerTarget)은 서버 설정을 따른다.
 */
import { CLEANUP_PROPOSALS_READY_EVENT } from "../../memory/person-link-infer-cycle.ts";
import { CleanupProposalsRepository } from "../../db/store-internal/cleanup-proposals-repository.ts";
import { entityRegisterFingerprint } from "../../memory/cleanup-deep-pass/stage-fingerprint.ts";
import { redactSecrets } from "../../memory/cleanup-deep-pass/redact-secrets.ts";
import { listAlreadyLinkedNames, readOriginalMemo } from "../../memory/cleanup-deep-pass/entity-register/candidate-query.ts";
import { ENTITY_REGISTER_KIND, entityRegisterTypeNames } from "../../memory/cleanup-deep-pass/entity-register/constants.ts";
import { judgeProfileFromLanguage } from "../../memory/cleanup-deep-pass/entity-register/judge.ts";
import { loadEntityNameIndex } from "../../memory/cleanup-deep-pass/entity-register/name-index.ts";
import { processEntityRegisterMemo } from "../../memory/cleanup-deep-pass/entity-register/process.ts";
import { parseEntityRegisterSingle } from "../../memory/cleanup-deep-pass/entity-register/prompt.ts";
import { EntityRegisterRecordsRepository } from "../../memory/cleanup-deep-pass/entity-register/records-repository.ts";
import type { EntityRegisterAiResult } from "../../memory/cleanup-deep-pass/entity-register/types.ts";
import type { MemoryApiDeps } from "../types.ts";
import { checkCandidateFreshness, type ExternalCandidateRef } from "./candidate-freshness.ts";
import type { SubmitProposalOutcome } from "./proposals.ts";
import type { ExternalCandidateStage, ExternalStageContract } from "./stage-map.ts";

export async function submitEntityRegisterExternal(
  deps: MemoryApiDeps,
  args: { payload: unknown; candidate: ExternalCandidateRef; contract: ExternalStageContract; stage: ExternalCandidateStage },
): Promise<SubmitProposalOutcome> {
  const nodeId = Number(args.candidate.targetKey);
  const raw = args.payload as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, httpStatus: 400, message: "entity_register payload 가 객체가 아님" };
  }
  // 서버 지시문은 AI 에게 nodeId 칸 없이 답하라고 하므로, 없으면 후보 열쇠로 채운다. 있는데 다르면 거부한다.
  if (raw.nodeId !== undefined && raw.nodeId !== nodeId) {
    return { ok: false, httpStatus: 400, message: `payload.nodeId 가 candidate.targetKey(${args.candidate.targetKey})와 다름` };
  }
  const p = { ...raw, nodeId };
  let result: EntityRegisterAiResult;
  try {
    result = parseEntityRegisterSingle(p, nodeId);
  } catch (e) {
    return { ok: false, httpStatus: 400, message: `entity_register 답 형식 어긋남 — ${e instanceof Error ? e.message : String(e)}` };
  }
  const fresh = await checkCandidateFreshness(deps, args.contract, args.stage, args.candidate);
  if (!fresh.ok) return fresh;
  const settings = deps.getSettings?.();
  if (!settings) {
    return { ok: false, httpStatus: 503, message: "설정 조회 배선 없음(getSettings) — cleanupDeepPass.entityRegister.autoApply 를 알 수 없어 처리하지 않음" };
  }

  const db = deps.store.getRawDb();
  const memo = readOriginalMemo(db, nodeId);
  if (!memo) return { ok: false, httpStatus: 404, message: `대상 부재 — 원본 메모 ${nodeId} 없음` };
  const allowed = new Set(entityRegisterTypeNames());
  const out = await processEntityRegisterMemo(
    {
      store: deps.store, proposals: new CleanupProposalsRepository(db), records: new EntityRegisterRecordsRepository(db),
      index: loadEntityNameIndex(db, allowed), allowedTypes: allowed, profile: judgeProfileFromLanguage(),
      autoApply: settings.cleanupDeepPass.entityRegister.autoApply, stageVersion: args.contract.stageVersion,
      maxAttemptsPerTarget: settings.cleanupDeepPass.reliability.maxAttemptsPerTarget, runId: null,
    },
    {
      ...memo, alreadyLinked: listAlreadyLinkedNames(db, nodeId), targetKey: args.candidate.targetKey,
      inputFingerprint: entityRegisterFingerprint(memo), stageVersion: args.contract.stageVersion,
    },
    result,
  );
  // 같은 메모를 다른 처리(서버 사이클·펫 재시도)가 잠금 대기 중에 먼저 끝냈다 — 아무것도 바꾸지 않았다.
  if (out.ledger === "already_processed") {
    return { ok: false, httpStatus: 409, message: `이미 처리된 메모 — ${out.error ?? `targetKey=${args.candidate.targetKey}`}` };
  }
  // 반영 거부(판정 뒤 상태가 바뀜)·반영 오류는 둘 다 원장에 원인과 함께 남았다. 성공처럼 돌려주지 않고 409 로
  // 알려 펫이 후보를 다시 조회하게 한다. 원인 문장은 외부로 나가므로 비밀값을 가린다.
  if (out.ledger !== "completed" && out.ledger !== "completed_noop") {
    const cause = redactSecrets(out.error ?? `반영 실패(원장 ${out.ledger})`);
    return { ok: false, httpStatus: 409, message: `${cause} — 후보를 다시 조회한 뒤 제출` };
  }
  // 서버 사이클과 같이 새 제안을 알린다(대시보드 알림). 이벤트 버스가 없는 배선(시험·직호출)은 알릴 곳이 없다.
  if (out.proposalId !== null && deps.eventBus) {
    deps.eventBus.emit(CLEANUP_PROPOSALS_READY_EVENT, { count: 1, kind: ENTITY_REGISTER_KIND });
  }
  return { ok: true, proposalId: out.proposalId, autoApplied: out.autoApplied };
}
