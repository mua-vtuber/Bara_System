/**
 * entity-register/cycle.ts — 항목·일정 자동 등록 정리 사이클 한 번(spec 3장).
 * 후보 → 묶음(batchSize, 그 안에서 호출당 입력 상한 microbatch) → infer → 메모별 처리(process.ts).
 * 형식 오류·응답 누락 묶음은 같은 사이클에서 메모 하나씩 다시 보낸다. 하나씩 보내도 어긋나면
 * 결정적 실패로 attempt 를 올리고, 상한이면 terminal(다시 보내지 않음, 사유 기록 — spec 9장).
 * 설정 결함(config)은 기존 단계와 같이 사이클 전체를 멈추고(CleanupConfigError), 예산 도달은 남은 묶음을 이월한다.
 */
import type { Database } from "bun:sqlite";
import type { SqliteMemoryStore } from "../../../db/store.ts";
import { CleanupProposalsRepository } from "../../../db/store-internal/cleanup-proposals-repository.ts";
import type { EventPublisher } from "../../events/event-contract.ts";
import { CLEANUP_PROPOSALS_READY_EVENT } from "../../person-link-infer-cycle.ts";
import { withMemoryMutationLock } from "../../shared-memory-mutation-lock.ts";
import type { StageCycleRecord } from "../cycle-budget.ts";
import { splitIntoMicrobatches } from "../input-estimate.ts";
import { redactSecrets } from "../redact-secrets.ts";
import { CleanupConfigError } from "../stage-execution.ts";
import { recordStageDeterministicFailure, recordStageRetryable, recordStageTerminal } from "../stage-results-ledger.ts";
import { DEFAULT_RETRY_REAPPEAR_DELAY_MS, nextRetryAt } from "../stage-retry.ts";
import { collectEntityRegisterCandidates, type EntityRegisterCandidateRow } from "./candidate-query.ts";
import { ENTITY_REGISTER_CYCLE_STAGE, ENTITY_REGISTER_KIND, ENTITY_REGISTER_LEDGER_STAGE, ENTITY_REGISTER_LIMITS, entityRegisterTypeNames } from "./constants.ts";
import { judgeProfileFromLanguage } from "./judge.ts";
import { loadEntityNameIndex } from "./name-index.ts";
import { isEntityRegisterMemoCompleted, processEntityRegisterMemo, type ProcessDeps } from "./process.ts";
import { entityRegisterFixedOverheadTokens, estimateEntityRegisterMemoTokens, type EntityRegisterInferFn } from "./prompt.ts";
import { EntityRegisterRecordsRepository } from "./records-repository.ts";

export interface EntityRegisterCycleDeps {
  store: SqliteMemoryStore;
  infer: EntityRegisterInferFn | null;
  eventBus: EventPublisher;
  /** 한 번에 보내는 메모 수(cleanupDeepPass.entityRegister.batchSize). */
  batchSize: number;
  autoApply: boolean;
  stageVersion: number;
  maxAttemptsPerTarget: number;
  perCallInputCap: number;
  runId: string | null;
  nodeIds?: readonly number[];
  logPrefix?: string;
}

export interface EntityRegisterCycleSummary {
  candidatesFound: number; completed: number; completedNoop: number; failures: number; terminal: number;
  autoApplied: number; proposalsInserted: number; coverageMisses: number; failureReasons: string[];
  /** 보내지 않은 메모 번호로 온 답 수(버림 — 묶음 안 메모는 커버리지 재전송이 구한다). */
  strayAnswers: number;
  /** 행 생성 기준에 걸려 등록하지 않은 이름 수(사유는 failureReasons 의 실패 사유 뒤 남는 자리에 남긴다). */
  skippedByGate: number;
  /** 이 사이클이 닿기 전에 다른 처리(펫 제출 등)가 같은 내용으로 먼저 끝낸 메모 수(건너뜀 — 원장은 그대로). */
  alreadyProcessed: number;
  /** 답을 쓸 수 없어(형식 오류·잘림·같은 메모 답 중복) 메모 하나씩 다시 보낸 묶음 수. */
  batchesSplit: number;
  /** 그렇게 하나씩 다시 보낸 메모 수 — 묶음 하나가 메모 수만큼 호출로 늘어난 양. */
  memosResentAlone: number;
}

function emptySummary(): EntityRegisterCycleSummary {
  return {
    candidatesFound: 0, completed: 0, completedNoop: 0, failures: 0, terminal: 0, autoApplied: 0, proposalsInserted: 0,
    coverageMisses: 0, failureReasons: [], strayAnswers: 0, skippedByGate: 0, alreadyProcessed: 0,
    batchesSplit: 0, memosResentAlone: 0,
  };
}

function assertBatchSize(batchSize: number): void {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`entity-register 사이클: cleanupDeepPass.entityRegister.batchSize 는 1 이상의 정수여야 함 (받은 값: ${batchSize})`);
  }
}

export interface EntityRegisterBatchPlan {
  batches: EntityRegisterCandidateRow[][];
  /** 메모 하나 + 지시문만으로 호출당 상한을 넘는 메모(호출하지 않는다). */
  oversized: EntityRegisterCandidateRow[];
  /** 호출마다 붙는 지시문 몫(추정 토큰). */
  fixedOverheadTokens: number;
}

/**
 * 후보를 호출 단위로 나눈다 — batchSize 개씩 끊고, 그 안에서 호출당 입력 상한 microbatch. 사이클과 dryRun 이
 * 같은 함수를 써서 추정과 실제 호출 수가 어긋나지 않게 한다.
 */
export function planEntityRegisterBatches(
  rows: readonly EntityRegisterCandidateRow[],
  opts: { allowedTypes: readonly string[]; batchSize: number; perCallInputCap: number },
): EntityRegisterBatchPlan {
  assertBatchSize(opts.batchSize);
  const fixedOverheadTokens = entityRegisterFixedOverheadTokens(opts.allowedTypes);
  const plan: EntityRegisterBatchPlan = { batches: [], oversized: [], fixedOverheadTokens };
  for (const group of chunk(rows, opts.batchSize)) {
    const { batches, oversized } = splitIntoMicrobatches(group, {
      fixedOverheadTokens,
      perCallCap: opts.perCallInputCap,
      tokensOf: estimateEntityRegisterMemoTokens,
    });
    plan.batches.push(...batches);
    plan.oversized.push(...oversized);
  }
  return plan;
}

/** run 집계 한 줄(요약 로그·cleanup_runs 원장) — 대시보드가 자동 N / 제안 M / 실패 K 와 사유를 읽는다. */
export function entityRegisterStageRecord(summary: EntityRegisterCycleSummary): StageCycleRecord {
  return {
    stage: ENTITY_REGISTER_CYCLE_STAGE,
    processed: summary.candidatesFound,
    completed: summary.completed,
    completedNoop: summary.completedNoop,
    failures: summary.failures,
    terminal: summary.terminal,
    autoApplied: summary.autoApplied,
    proposed: summary.proposalsInserted,
    alreadyProcessed: summary.alreadyProcessed,
    batchesSplit: summary.batchesSplit,
    memosResentAlone: summary.memosResentAlone,
    failureReasons: summary.failureReasons,
  };
}

function keyOf(m: EntityRegisterCandidateRow) {
  return { stage: ENTITY_REGISTER_LEDGER_STAGE, targetKey: m.targetKey, inputFingerprint: m.inputFingerprint, stageVersion: m.stageVersion };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function runEntityRegisterCycle(deps: EntityRegisterCycleDeps): Promise<EntityRegisterCycleSummary> {
  const logPrefix = deps.logPrefix ?? "[entity-register]";
  const summary = emptySummary();
  assertBatchSize(deps.batchSize);
  if (deps.infer === null) {
    console.log(`${logPrefix} LLM 미가용 — entity_register 한 사이클 건너뜀(no-op).`);
    return summary;
  }
  const infer = deps.infer;
  const db = deps.store.getRawDb();
  const allowedTypes = entityRegisterTypeNames();
  const allowed = new Set(allowedTypes);
  const rows = collectEntityRegisterCandidates({
    db, stageVersion: deps.stageVersion,
    limit: deps.nodeIds ? deps.nodeIds.length : ENTITY_REGISTER_LIMITS.maxCandidatesPerCycle,
    ...(deps.nodeIds ? { nodeIds: deps.nodeIds } : {}),
  });
  summary.candidatesFound = rows.length;
  if (rows.length === 0) return summary;

  // 사유는 run 집계(GET /api/cleanup-runs/:id)로 나가므로 공급자 오류에 실린 키·토큰을 가린 뒤 담는다.
  const reason = (text: string) => {
    if (summary.failureReasons.length < ENTITY_REGISTER_LIMITS.failureReasonsKept) summary.failureReasons.push(redactSecrets(text));
  };
  // 등록 안 함(행 생성 기준) 사유는 따로 모았다가 끝에 남는 자리만 채운다 — 이름이 많은 메모 하나가
  // 상한을 먼저 차지해 진짜 실패 사유가 빠지는 일을 막는다(집계 모양은 그대로).
  const skipReasons: string[] = [];
  // 묶음을 하나씩 다시 보낸 사유도 따로 모아 진짜 실패 사유 뒤에 남긴다 — 실패는 아니지만 호출 수가 메모 수만큼
  // 늘어나는 일이라 run 결과에서 보여야 한다(조용히 쪼개면 예산이 왜 일찍 찼는지 알 수 없다).
  const splitReasons: string[] = [];
  const resendAlone = (batch: EntityRegisterCandidateRow[], why: string) => {
    summary.batchesSplit += 1;
    summary.memosResentAlone += batch.length;
    const text = `묶음 답을 쓸 수 없어 메모 ${batch.length}개(${batch.map((m) => m.nodeId).join(",")})를 하나씩 다시 보냄 — ${why}`;
    console.warn(`${logPrefix} ${redactSecrets(text)}`);
    if (splitReasons.length < ENTITY_REGISTER_LIMITS.failureReasonsKept) splitReasons.push(text);
    queue.unshift(...batch.map((m) => [m]));
  };
  const proc: ProcessDeps = {
    store: deps.store, proposals: new CleanupProposalsRepository(db), records: new EntityRegisterRecordsRepository(db),
    index: loadEntityNameIndex(db, allowed), allowedTypes: allowed, profile: judgeProfileFromLanguage(),
    autoApply: deps.autoApply, stageVersion: deps.stageVersion, maxAttemptsPerTarget: deps.maxAttemptsPerTarget, runId: deps.runId,
  };

  const plan = planEntityRegisterBatches(rows, { allowedTypes, batchSize: deps.batchSize, perCallInputCap: deps.perCallInputCap });
  for (const m of plan.oversized) {
    recordStageTerminal(db, { ...keyOf(m), lastError: `input_over_cap — 메모 하나와 지시문이 호출당 상한(${deps.perCallInputCap}) 초과` });
    summary.failures += 1;
    summary.terminal += 1;
    reason(`메모 ${m.nodeId}: 너무 길어 처리 불가(input_over_cap)`);
  }
  const queue: EntityRegisterCandidateRow[][] = [...plan.batches];

  // 실패를 쓰기 직전에 기억 쓰기 잠금 안에서 원장을 다시 본다. infer 를 기다리는 사이 펫 제출 등이 같은 지문·단계
  // 버전으로 먼저 끝냈으면 쓰지 않고 already_processed 로 센다 — 완료 원장을 실패로 덮어써 다시 과금하는 일을 막는다.
  const unlessCompleted = <T>(m: EntityRegisterCandidateRow, write: () => T): Promise<T | null> =>
    withMemoryMutationLock(deps.store, async () => (isEntityRegisterMemoCompleted(db, m) ? null : write()));

  const failSingle = async (m: EntityRegisterCandidateRow, why: string) => {
    const r = await unlessCompleted(m, () => recordStageDeterministicFailure(db, { ...keyOf(m), maxAttemptsPerTarget: deps.maxAttemptsPerTarget, lastError: why }));
    if (r === null) {
      summary.alreadyProcessed += 1;
      return;
    }
    summary.failures += 1;
    if (r.status === "terminal_failure") {
      summary.terminal += 1;
      reason(`메모 ${m.nodeId}: ${why} — ${r.attemptCount}번 실패해 처리 불가로 확정`);
    }
  };

  while (queue.length > 0) {
    const batch = queue.shift()!;
    const res = await infer({ memos: batch.map((m) => ({ nodeId: m.nodeId, content: m.content, createdAt: m.createdAt, alreadyLinked: m.alreadyLinked })), allowedTypes });
    if (res.kind === "config") throw new CleanupConfigError(res.reason);
    if (res.kind === "budget") {
      console.log(`${logPrefix} 예산 도달(${res.dimension}: ${res.detail}) — 남은 entity_register 묶음 이월.`);
      break;
    }
    if (res.kind === "transient") {
      const retryAt = nextRetryAt(res.retryAfterMs, DEFAULT_RETRY_REAPPEAR_DELAY_MS);
      let deferred = 0;
      for (const m of batch) {
        const written = await unlessCompleted(m, () => {
          recordStageRetryable(db, { ...keyOf(m), nextRetryAt: retryAt, lastError: res.reason });
          return true;
        });
        if (written === null) summary.alreadyProcessed += 1;
        else deferred += 1;
      }
      summary.failures += deferred;
      if (deferred > 0) reason(`일시 오류로 ${deferred}개 메모를 다음 정리로 미룸: ${res.reason}`);
      continue;
    }
    if (res.kind === "deterministic") {
      if (batch.length > 1) resendAlone(batch, res.reason);
      else await failSingle(batch[0]!, res.reason);
      continue;
    }
    const inBatch = new Set(batch.map((m) => m.nodeId));
    const stray = res.parsed.filter((r) => !inBatch.has(r.nodeId));
    if (stray.length > 0) {
      const ids = [...new Set(stray.map((r) => r.nodeId))].join(",");
      summary.strayAnswers += stray.length;
      console.warn(`${logPrefix} 보내지 않은 메모 번호로 온 답 ${stray.length}개를 버림(nodeIds=${ids}).`);
      reason(`보내지 않은 메모 번호(${ids})로 온 답 ${stray.length}개를 버림`);
    }
    const answered = res.parsed.filter((r) => inBatch.has(r.nodeId));
    const seen = new Set<number>();
    const duplicated = new Set<number>();
    for (const r of answered) {
      if (seen.has(r.nodeId)) duplicated.add(r.nodeId);
      seen.add(r.nodeId);
    }
    if (duplicated.size > 0) {
      // 같은 메모에 답이 둘 이상 = 형식 오류. 어느 답을 믿을지 고르지 않고 형식 오류 경로(하나씩 다시 보내기)로 보낸다.
      const why = `응답에 같은 메모(${[...duplicated].join(",")})의 답이 둘 이상(형식 오류)`;
      if (batch.length > 1) resendAlone(batch, why);
      else {
        console.warn(`${logPrefix} ${why}.`);
        await failSingle(batch[0]!, why);
      }
      continue;
    }
    const byNode = new Map(answered.map((r) => [r.nodeId, r]));
    const missing = batch.filter((m) => !byNode.has(m.nodeId));
    if (missing.length > 0) {
      summary.coverageMisses += missing.length;
      if (batch.length > 1) queue.unshift(...missing.map((m) => [m]));
      else await failSingle(missing[0]!, "응답에 이 메모의 답이 없음");
    }
    for (const m of batch) {
      const result = byNode.get(m.nodeId);
      if (!result) continue;
      const out = await processEntityRegisterMemo(proc, m, result);
      if (out.ledger === "already_processed") {
        summary.alreadyProcessed += 1;
        continue;
      }
      summary.skippedByGate += out.skipped.length;
      for (const sk of out.skipped) {
        if (skipReasons.length < ENTITY_REGISTER_LIMITS.failureReasonsKept) skipReasons.push(`메모 ${m.nodeId}: '${sk.memoName}'(${sk.type}) 등록 안 함 — ${sk.reason}`);
      }
      if (out.ledger === "completed" || out.ledger === "completed_noop") {
        if (out.ledger === "completed") summary.completed += 1;
        else summary.completedNoop += 1;
        summary.autoApplied += out.autoApplied;
        if (out.proposalId) summary.proposalsInserted += 1;
        continue;
      }
      summary.failures += 1;
      if (out.ledger === "terminal_failure") summary.terminal += 1;
      reason(`메모 ${m.nodeId}: ${out.error}`);
    }
  }

  for (const text of splitReasons) reason(text);
  for (const text of skipReasons) reason(text);
  if (summary.proposalsInserted > 0) {
    deps.eventBus.emit(CLEANUP_PROPOSALS_READY_EVENT, { count: summary.proposalsInserted, kind: ENTITY_REGISTER_KIND });
  }
  console.log(`${logPrefix} cycle: 후보 ${summary.candidatesFound} → 자동 ${summary.autoApplied}, 제안 +${summary.proposalsInserted}, 실패 ${summary.failures}, 처리 불가 ${summary.terminal}, 하나씩 다시 보낸 묶음 ${summary.batchesSplit}(메모 ${summary.memosResentAlone})`);
  return summary;
}

/**
 * 정리 없이 후보 수와 추정 입력 토큰만 센다(LLM 호출 0). 사이클과 같은 나누기(planEntityRegisterBatches)를 써서
 * 호출 수 × 지시문 몫 + 메모 몫으로 잰다. 호출당 상한을 넘는 메모는 보내지 않으므로 빼고 센다.
 */
export function detectEntityRegisterDryRun(deps: {
  db: Database; stageVersion: number; batchSize: number; perCallInputCap: number;
}): { candidatesFound: number; estimatedInputTokens: number } {
  const rows = collectEntityRegisterCandidates({ db: deps.db, stageVersion: deps.stageVersion, limit: ENTITY_REGISTER_LIMITS.maxCandidatesPerCycle });
  const plan = planEntityRegisterBatches(rows, { allowedTypes: entityRegisterTypeNames(), batchSize: deps.batchSize, perCallInputCap: deps.perCallInputCap });
  let tokens = plan.batches.length * plan.fixedOverheadTokens;
  for (const batch of plan.batches) for (const m of batch) tokens += estimateEntityRegisterMemoTokens(m);
  return { candidatesFound: rows.length, estimatedInputTokens: tokens };
}
