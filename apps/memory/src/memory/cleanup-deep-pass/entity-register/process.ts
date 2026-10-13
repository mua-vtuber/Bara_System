/**
 * entity-register/process.ts — 메모 하나: 판정 → 자동 반영 → 제안 → 결과 원장. 서버 사이클과 펫 제출(D7)이
 * 같은 함수를 지난다.
 *
 * 자동 반영이 실패하면 그 메모의 반영 전체가 취소되고(트랜잭션 — spec 9장) 제안도 만들지 않는다. 원장은 둘로 가른다.
 *   - 반영 거부(EntityRegisterApplyRefusedError): 판정 뒤 상태가 바뀌어(연결 대상이 사라짐·일정이 생김 등) 판정이
 *     낡은 경우다(spec 6장 오래된 제안과 같은 뜻). 낡은 판정으로 제안을 만들지 않고, 결정적 실패로 시도 횟수를
 *     올린다. 다음 정리 때 새 상태로 다시 판정하고, 같은 거부가 maxAttemptsPerTarget 번 되풀이되면(판정·반영
 *     규칙 어긋남) 처리 불가로 굳혀 재과금을 끊는다.
 *   - 그 밖의 오류(DB·임베딩 실패 등): 처음에는 retryable 로 남겨 다음 정리 때 다시 처리한다. 같은 지문으로
 *     반영 오류만 maxAttemptsPerTarget 번 이어지면 처리 불가로 굳힌다(recordApplyError).
 * 어느 쪽이든 원인 문장을 원장 last_error 와 결과(error)에 남긴다 — 조용히 건너뛰지 않는다.
 *
 * 같은 메모가 동시에 두 번 처리될 수 있다(펫 제출과 서버 사이클, 펫 재시도). 그래서 판정부터 원장 기록까지
 * 전체를 기억 쓰기 잠금(withMemoryMutationLock, 재진입 가능) 안에서 하고, 잠금을 잡은 뒤 원장을 다시 읽는다.
 * 같은 지문·단계 버전으로 이미 완료된 메모면 아무것도 바꾸지 않고 already_processed 로 돌려준다 — 먼저 끝난
 * 처리의 completed 원장을 실패로 덮어써 다시 과금하는 일을 막는다.
 */
import type { Database } from "bun:sqlite";
import type { SqliteMemoryStore } from "../../../db/store.ts";
import type { CleanupProposalsRepository } from "../../../db/store-internal/cleanup-proposals-repository.ts";
import { withMemoryMutationLock } from "../../shared-memory-mutation-lock.ts";
import { getStageResult, recordStageDeterministicFailure, recordStageRetryable, recordStageSuccess, recordStageTerminal } from "../stage-results-ledger.ts";
import { DEFAULT_RETRY_REAPPEAR_DELAY_MS, nextRetryAt } from "../stage-retry.ts";
import { applyMemoChanges, EntityRegisterApplyRefusedError, type ApplyOutcome, type EntityApplication, type ScheduleApplication } from "./apply.ts";
import type { EntityRegisterCandidateRow } from "./candidate-query.ts";
import { ENTITY_REGISTER_LEDGER_STAGE } from "./constants.ts";
import { judgeMemo, type JudgeProfile } from "./judge.ts";
import { addToNameIndex } from "./name-index.ts";
import { buildEntityRegisterProposal, insertEntityRegisterProposal, type AutoAppliedNote } from "./proposal.ts";
import type { EntityRegisterRecordsRepository } from "./records-repository.ts";
import type { EntityNameIndex, EntityRegisterAiResult, MemoJudgement } from "./types.ts";

export interface ProcessDeps {
  store: SqliteMemoryStore;
  proposals: CleanupProposalsRepository;
  records: EntityRegisterRecordsRepository;
  index: EntityNameIndex;
  allowedTypes: ReadonlySet<string>;
  profile: JudgeProfile;
  autoApply: boolean;
  stageVersion: number;
  /** 반영 거부·반영 오류가 되풀이될 때 처리 불가로 굳히는 시도 상한(cleanupDeepPass.reliability.maxAttemptsPerTarget). */
  maxAttemptsPerTarget: number;
  runId: string | null;
}

export interface ProcessMemoOutcome {
  nodeId: number;
  autoApplied: number;
  proposalId: string | null;
  /**
   * deterministic_failure = 자동 반영 거부(판정이 낡음), retryable = 그 밖의 반영 오류, terminal_failure = 둘 중
   * 하나가 상한만큼 되풀이됨.
   * already_processed = 다른 처리가 같은 지문·단계 버전으로 먼저 끝냄(아무것도 바꾸지 않았고 원장도 그대로).
   */
  ledger: "completed" | "completed_noop" | "retryable" | "deterministic_failure" | "terminal_failure" | "already_processed";
  error: string | null;
  /** 행 생성 기준(entity-row-gate)에 걸려 등록하지 않은 이름과 그 사유 — "왜 안 들어갔나"를 추적한다. */
  skipped: ApplyOutcome["skipped"];
}

function toApplications(j: MemoJudgement): { entities: EntityApplication[]; schedule: ScheduleApplication | null } {
  const entities: EntityApplication[] = [];
  for (const d of j.entities) {
    if (d.action === "auto_link") entities.push({ memoName: d.name, type: d.type, action: { kind: "link", targetId: d.target.id, targetName: d.target.name, addAlias: false } });
    if (d.action === "auto_create") entities.push({ memoName: d.name, type: d.type, action: { kind: "create", name: d.name, aliasFromMemo: null } });
  }
  const schedule: ScheduleApplication | null = j.schedule.action === "auto"
    ? { title: j.schedule.title, date: j.schedule.date, dateText: j.schedule.dateText, replaceNodeId: null }
    : null;
  return { entities, schedule };
}

export async function processEntityRegisterMemo(deps: ProcessDeps, memo: EntityRegisterCandidateRow, result: EntityRegisterAiResult): Promise<ProcessMemoOutcome> {
  if (result.nodeId !== memo.nodeId) {
    throw new Error(`entity-register 처리: 메모 ${memo.nodeId} 에 다른 메모(${result.nodeId})의 답이 넘어옴`);
  }
  return withMemoryMutationLock(deps.store, () => processUnderLock(deps, memo, result));
}

/**
 * 같은 지문·단계 버전으로 이미 완료(completed·completed_noop)된 메모인가. 기억 쓰기 잠금 안에서 불러야
 * 다른 처리(펫 제출 등)와 겹치지 않는다 — 메모 처리와 사이클의 실패 기록이 모두 이것으로 먼저 확인한다.
 */
export function isEntityRegisterMemoCompleted(db: Database, memo: EntityRegisterCandidateRow): boolean {
  const row = getStageResult(db, ENTITY_REGISTER_LEDGER_STAGE, memo.targetKey);
  return row !== null
    && (row.status === "completed" || row.status === "completed_noop")
    && row.inputFingerprint === memo.inputFingerprint
    && row.stageVersion === memo.stageVersion;
}

/** 거부가 아닌 반영 오류의 원장 사유 머리말 — 같은 머리말이 이어지는 동안만 연속 반영 오류로 센다. */
const APPLY_ERROR_PREFIX = "반영 실패(이 메모 반영 전체 취소)";

/**
 * 거부가 아닌 반영 오류(DB 잠김·임베딩 실패 등). 처음 몇 번은 retryable 로 두어 일시적인 잠김은 다음 정리 때
 * 풀린다. 같은 지문으로 반영 오류만 maxAttemptsPerTarget 번 이어지면 일시 문제가 아니라고 보고 원인을 담아
 * 처리 불가로 굳힌다 — 매 정리마다 같은 메모를 다시 보내 영구 재과금하는 일을 끊는다. 사이에 다른 종류의
 * 실패(공급자 일시 오류 등)가 끼면 세기를 1 부터 다시 한다(외부 장애로 메모를 굳히지 않는다).
 */
function recordApplyError(
  deps: ProcessDeps, memo: EntityRegisterCandidateRow,
  key: { stage: typeof ENTITY_REGISTER_LEDGER_STAGE; targetKey: string; inputFingerprint: string; stageVersion: number },
  error: string,
): ProcessMemoOutcome {
  const db = deps.store.getRawDb();
  const prev = getStageResult(db, ENTITY_REGISTER_LEDGER_STAGE, memo.targetKey);
  const consecutive = prev !== null && prev.status === "retryable_failure"
    && prev.inputFingerprint === memo.inputFingerprint && (prev.lastError ?? "").startsWith(APPLY_ERROR_PREFIX)
    ? prev.attemptCount : 0;
  const attemptCount = consecutive + 1;
  if (attemptCount >= deps.maxAttemptsPerTarget) {
    const terminalError = `${error} — 반영 오류가 ${attemptCount}번 이어져 처리 불가로 확정`;
    recordStageTerminal(db, { ...key, lastError: terminalError });
    return { nodeId: memo.nodeId, autoApplied: 0, proposalId: null, ledger: "terminal_failure", error: terminalError, skipped: [] };
  }
  recordStageRetryable(db, { ...key, attemptCount, nextRetryAt: nextRetryAt(null, DEFAULT_RETRY_REAPPEAR_DELAY_MS), lastError: error });
  return { nodeId: memo.nodeId, autoApplied: 0, proposalId: null, ledger: "retryable", error, skipped: [] };
}

async function processUnderLock(deps: ProcessDeps, memo: EntityRegisterCandidateRow, result: EntityRegisterAiResult): Promise<ProcessMemoOutcome> {
  if (isEntityRegisterMemoCompleted(deps.store.getRawDb(), memo)) {
    return {
      nodeId: memo.nodeId, autoApplied: 0, proposalId: null, ledger: "already_processed",
      error: `메모 ${memo.nodeId} 는 같은 내용으로 이미 처리됨(다른 정리가 먼저 끝냄)`, skipped: [],
    };
  }
  const db = deps.store.getRawDb();
  const key = { stage: ENTITY_REGISTER_LEDGER_STAGE, targetKey: memo.targetKey, inputFingerprint: memo.inputFingerprint, stageVersion: memo.stageVersion };
  const active = deps.records.activeScheduleForMemo(memo.nodeId);
  const j = judgeMemo({
    memo, result, index: deps.index, allowedTypes: deps.allowedTypes,
    ignoredNames: deps.records.ignoredNameKeys(memo.nodeId), scheduleIgnored: deps.records.isScheduleIgnored(memo.nodeId),
    activeSchedule: active ? { nodeId: active.nodeId, date: active.date, title: active.title } : null,
    autoApply: deps.autoApply, profile: deps.profile,
  });

  const { entities, schedule } = toApplications(j);
  const notes: AutoAppliedNote[] = [];
  let autoApplied = 0;
  let skipped: ApplyOutcome["skipped"] = [];
  if (entities.length > 0 || schedule) {
    try {
      const out = await applyMemoChanges(
        { store: deps.store, records: deps.records, memo, runId: deps.runId, proposalId: null, decidedBy: "auto" },
        { entities, schedule },
      );
      skipped = out.skipped;
      for (const e of out.entities) {
        if (e.recordId === null) continue;
        autoApplied += 1;
        notes.push({ type: e.type, name: e.name, action: e.created ? "created" : "linked" });
        if (e.created) addToNameIndex(deps.index, { typeName: e.type, id: e.id, name: e.name, aliases: [] });
      }
      if (out.scheduleRecordId !== null) {
        autoApplied += 1;
        notes.push({ type: "schedule", name: schedule!.title, action: "schedule" });
      }
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      if (e instanceof EntityRegisterApplyRefusedError) {
        const error = `자동 반영 거부(판정 뒤 상태가 바뀜, 이 메모 반영 전체 취소): ${cause}`;
        const r = recordStageDeterministicFailure(db, { ...key, maxAttemptsPerTarget: deps.maxAttemptsPerTarget, lastError: error });
        const ledger = r.status === "terminal_failure" ? "terminal_failure" : "deterministic_failure";
        return { nodeId: memo.nodeId, autoApplied: 0, proposalId: null, ledger, error, skipped: [] };
      }
      return recordApplyError(deps, memo, key, `${APPLY_ERROR_PREFIX}: ${cause}`);
    }
  }

  const payload = buildEntityRegisterProposal(j, { inputFingerprint: memo.inputFingerprint, stageVersion: memo.stageVersion, runId: deps.runId, autoApplied: notes });
  const proposalId = payload ? insertEntityRegisterProposal(deps.proposals, payload) : null;
  const noop = autoApplied === 0 && proposalId === null;
  recordStageSuccess(db, { ...key, noop });
  return { nodeId: memo.nodeId, autoApplied, proposalId, ledger: noop ? "completed_noop" : "completed", error: null, skipped };
}
