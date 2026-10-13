/**
 * lens-draft-cycle.ts — 데이터 정리 AI 렌즈 소비 단계 한 사이클 (spec 6.C-2 / DCL-4).
 *
 * 렌즈가 정의된 종류의 기존 엔티티 중 구조화 칸이 빈 것을 강한 cleanup LLM 이 렌즈 계약
 * 안에서 채워 구조화 초안(cleanup_proposals kind=lens_draft)으로 만든다. 4번째 깊은 패스
 * 단계로, 앞선 세 단계(regex_strengthen·summary·person_link)와 같은 표준 실행 파이프라인
 * (spec 4.A-4)을 따른다: 후보 검출 + fingerprint → 실행층 호출 → 결정적 검증 → 결과 원장
 * 기록 → 제안 insert.
 *
 * 이 단계가 앞 단계와 다른 두 축(spec 6.C-2):
 *   1. **자동 적용 0** — 구조화 초안은 다중 칸 동시 변경이라 오적용 파급이 person_link 의
 *      단일 연결보다 크다. person_link 의 conf>=0.9 자동 예외를 승계하지 않는다. 통과분은
 *      전부 cleanup_proposals 로만 남고, approve 는 선행 정비된 공유 적용 함수(applyLensDraft
 *      aiPath:true — 재검증 + 트랜잭션 + fingerprint 재대조)를 탄다.
 *   2. **생성 직후 적용 측 사전 필터** — LLM 이 낸 초안을 제안으로 넣기 *전에* 적용 측
 *      검증(validateDraftShape)을 사전 필터로 태운다(입력 조립 공유 로직 직접 호출 —
 *      HTTP 자기호출 금지). 탈락은 completed_noop 이 아니라 검증 탈락 사유를 원장에 기록 +
 *      loud 로그(결함 초안을 조용히 삼키지 않는다). 통과분만 제안이 된다.
 *
 * 불변식 동결(features 문서 / spec 6.C-2): 새 값 허용은 labels·columns 값에 한정하고,
 * 관계 대상·사람은 기존 id 만, 렌즈 밖 키는 거부한다 — validateDraftShape 가 이 셋을 전부
 * 판정한다(렌즈에 없는 키 거부 / person columns 광고-거부 / 관계값 기존 id 모양 / dataType).
 *
 * mock 클래스 0 — infer 함수(주입)와 실 SQLite + 실 store 로 검증한다.
 *
 * 파일 분할(크기 상한 정합): 후보 검출·직렬화·근거 노드 조회는 lens-draft-candidate-query.ts,
 * 한 배치 결정 처리(사전 필터·제안 insert·커버리지 원장)는 lens-draft-batch.ts, 프롬프트·
 * infer·파싱은 lens-draft-infer-prompt.ts. 이 파일은 사이클 오케스트레이션(후보 조립 →
 * microbatch → 실행층 호출 → 배치 위임)과 dryRun 만 맡는다.
 */

import type { Database } from "bun:sqlite";
import type { EventPublisher } from "../events/event-contract.ts";
import {
  CleanupConfigError,
  type StageInferResult,
} from "./stage-execution.ts";
import {
  recordStageDeterministicFailure,
  recordStageRetryable,
  recordStageTerminal,
} from "./stage-results-ledger.ts";
import {
  DEFAULT_RETRY_REAPPEAR_DELAY_MS,
  nextRetryAt,
} from "./stage-retry.ts";
import { splitIntoMicrobatches } from "./input-estimate.ts";
import type {
  LensApplyView,
  LensDraftValues,
  LensStoreDeps,
} from "./lens-apply.ts";
import {
  detectLensDraftCandidates,
  LENS_DRAFT_KIND,
  serializeLens,
  type LensDraftCandidate,
} from "./lens-draft-candidate-query.ts";
import {
  processLensDraftBatch,
  readEvidenceContents,
} from "./lens-draft-batch.ts";
import {
  estimateLensDraftCandidateTokens,
  lensDraftFixedOverheadTokens,
} from "./lens-draft-infer-prompt.ts";

export { LENS_DRAFT_KIND } from "./lens-draft-candidate-query.ts";
export const CLEANUP_PROPOSALS_READY_EVENT = "cleanup_proposals_ready";

/** LLM 에 넘길 한 후보의 입력 컨텍스트(엔티티 + 렌즈 + 근거 원문). */
export interface LensDraftEntityContext {
  typeName: string;
  entityId: string;
  name: string;
  /** 채울 여지가 있는 빈 렌즈 column key 목록. */
  emptyColumnKeys: string[];
  /** 이미 채워진 칸 값(현 상태). */
  filledColumns: Record<string, string>;
  /** 근거 노드 원문(id + content) — LLM 이 값을 근거로 채우게. */
  evidence: Array<{ nodeId: number; content: string }>;
  /** 렌즈 계약(채울 수 있는 columns·labels·relations·metadata 키). */
  lens: LensApplyView;
}

export interface LensDraftInferInput {
  entities: LensDraftEntityContext[];
}

/**
 * LLM 이 낸 한 엔티티의 구조화 초안 값. columns·labels 는 새 값 허용, relations 는 기존 id
 * 객체, metadata 는 렌즈가 광고한 키만. entityId 로 어느 후보에 대한 초안인지 가른다.
 */
export interface LensDraftDecision {
  typeName: string;
  entityId: string;
  values: LensDraftValues;
}

export type LensDraftInferFn = (
  input: LensDraftInferInput,
) => Promise<StageInferResult<LensDraftDecision[]>>;

export interface LensDraftInferCycleDeps {
  /** store 만 있으면 되므로 좁힌 deps(후보 검출·직렬화·근거 원문 조회). */
  deps: LensStoreDeps;
  infer: LensDraftInferFn | null;
  eventBus: EventPublisher;
  batchSize: number;
  /** 단계 계약 버전(원장 재평가 신호, 상수 맵 단일 출처). */
  stageVersion: number;
  /** 결정적 실패 attempt 상한(reliability.maxAttemptsPerTarget). */
  maxAttemptsPerTarget: number;
  /** 호출당 입력 상한(budget.maxEstimatedInputTokensPerCall, spec 4.A-6). */
  perCallInputCap: number;
  logPrefix?: string;
}

export interface LensDraftInferCycleSummary {
  candidatesFound: number;
  /** cleanup_proposals kind=lens_draft insert 수(검증 통과분). */
  proposalsInserted: number;
  /** 사전 필터(validateDraftShape) 탈락 수 — 원장에 결정적 실패로 기록. */
  rejectedInvalid: number;
  inferFailures: number;
  /** 원장 completed 기록 수(제안 산출 있는 엔티티). */
  completed: number;
  /** 원장 completed_noop 기록 수(정상 회신인데 채울 값 0 — 빈 초안). */
  completedNoop: number;
  /** 커버리지 미달 엔티티 수(입력에 실었는데 응답에 결정 없음 — 원장 미기록). */
  coverageMisses: number;
}

export async function runLensDraftCycle(
  deps: LensDraftInferCycleDeps,
): Promise<LensDraftInferCycleSummary> {
  const logPrefix = deps.logPrefix ?? "[lens-draft]";
  const summary: LensDraftInferCycleSummary = {
    candidatesFound: 0,
    proposalsInserted: 0,
    rejectedInvalid: 0,
    inferFailures: 0,
    completed: 0,
    completedNoop: 0,
    coverageMisses: 0,
  };

  if (deps.infer === null) {
    console.log(`${logPrefix} LLM 미가용 — lens_draft 한 사이클 건너뜀(no-op).`);
    return summary;
  }

  const db = deps.deps.store.getRawDb();
  const candidates = await detectLensDraftCandidates({
    deps: deps.deps,
    batchSize: deps.batchSize,
    stageVersion: deps.stageVersion,
  });
  summary.candidatesFound = candidates.length;
  if (candidates.length === 0) {
    return summary;
  }

  // 각 후보의 근거 노드 원문을 읽어 입력 컨텍스트로 조립한다.
  const contexts: LensDraftEntityContext[] = candidates.map((cand) => ({
    typeName: cand.typeName,
    entityId: cand.entityId,
    name: cand.name,
    emptyColumnKeys: cand.emptyColumnKeys,
    filledColumns: cand.filledColumns,
    evidence: readEvidenceContents(db, cand.evidenceNodeIds),
    lens: cand.lens,
  }));
  const ledgerKeyByEntity = new Map(
    candidates.map((c) => [
      c.entityId,
      {
        stage: "lens_draft" as const,
        targetKey: c.targetKey,
        inputFingerprint: c.inputFingerprint,
        stageVersion: c.stageVersion,
      },
    ]),
  );
  const lensByEntity = new Map(candidates.map((c) => [c.entityId, c.lens]));
  // 오래된 초안 방어 seam(spec 6.C-2 point 6) — 초안 시점 fingerprint·렌즈 직렬화·근거
  // 노드를 제안 payload 에 실어, approve 가 승인 시점 엔티티 현재 값과 재대조해 어긋나면
  // 적용을 거부하게 한다(제안 생성과 승인 사이 엔티티·렌즈 변경 경합 방어).
  const guardByEntity = new Map(
    candidates.map((c) => [
      c.entityId,
      {
        expectedFingerprint: c.inputFingerprint,
        lensSerialization: serializeLens(c.lens),
        evidenceNodeIds: c.evidenceNodeIds,
      },
    ]),
  );

  // ── 토큰 인지 microbatch(spec 4.A-6) — 엔티티를 고정 개수가 아니라 추정 입력 토큰 합이
  //   호출당 상한 안에 들도록 묶는다. 공유 오버헤드 = system 프롬프트. 엔티티별 비용 =
  //   렌즈 계약 + 근거 원문. 엔티티 하나 + 오버헤드로도 상한을 넘으면 호출 없이 terminal.
  const fixedOverhead = lensDraftFixedOverheadTokens();
  const { batches, oversized } = splitIntoMicrobatches(contexts, {
    fixedOverheadTokens: fixedOverhead,
    perCallCap: deps.perCallInputCap,
    tokensOf: (ctx) => estimateLensDraftCandidateTokens(ctx),
  });
  for (const ctx of oversized) {
    const key = ledgerKeyByEntity.get(ctx.entityId)!;
    recordStageTerminal(db, {
      ...key,
      lastError: `input_over_cap — 엔티티 렌즈+근거 추정이 호출당 상한(${deps.perCallInputCap}) 초과`,
    });
    summary.inferFailures += 1;
    console.warn(
      `${logPrefix} 입력 상한 초과 — entity ${ctx.entityId} terminal(input_over_cap).`,
    );
  }

  for (const batch of batches) {
    const batchKeys = new Map(
      batch.map((c) => [c.entityId, ledgerKeyByEntity.get(c.entityId)!]),
    );
    const inferResult = await deps.infer({ entities: batch });

    if (inferResult.kind === "config") {
      // 설정 결함 = 사이클 통째 중단(대상별 기록 없음).
      throw new CleanupConfigError(inferResult.reason);
    }
    if (inferResult.kind === "budget") {
      console.log(
        `${logPrefix} 예산 도달(${inferResult.dimension}: ${inferResult.detail}) — 남은 lens_draft 배치 이월.`,
      );
      break;
    }
    if (inferResult.kind === "transient" || inferResult.kind === "deterministic") {
      summary.inferFailures += 1;
      for (const key of batchKeys.values()) {
        if (inferResult.kind === "transient") {
          recordStageRetryable(db, {
            ...key,
            nextRetryAt: nextRetryAt(
              inferResult.retryAfterMs,
              DEFAULT_RETRY_REAPPEAR_DELAY_MS,
            ),
            lastError: inferResult.reason,
          });
        } else {
          recordStageDeterministicFailure(db, {
            ...key,
            maxAttemptsPerTarget: deps.maxAttemptsPerTarget,
            lastError: inferResult.reason,
          });
        }
      }
      console.warn(
        `${logPrefix} ${inferResult.kind} — lens_draft 배치 실패 원장(entityIds=${batch
          .map((c) => c.entityId)
          .join(",")}): ${inferResult.reason}`,
      );
      continue;
    }

    processLensDraftBatch({
      db,
      logPrefix,
      batch,
      decisions: inferResult.parsed,
      batchKeys,
      lensByEntity,
      guardByEntity,
      maxAttemptsPerTarget: deps.maxAttemptsPerTarget,
      summary,
    });
  }

  if (summary.coverageMisses > 0) {
    console.warn(
      `${logPrefix} 커버리지 미달 ${summary.coverageMisses}건 — 응답에 결정 없는 엔티티는 완료 처리 안 함(다음 배치 후보 잔존).`,
    );
  }
  if (summary.rejectedInvalid > 0) {
    console.warn(
      `${logPrefix} 사전 필터 탈락 ${summary.rejectedInvalid}건 — 검증 탈락 초안은 제안이 안 되고 결정적 실패로 원장 기록(loud).`,
    );
  }
  if (summary.proposalsInserted > 0) {
    deps.eventBus.emit(CLEANUP_PROPOSALS_READY_EVENT, {
      count: summary.proposalsInserted,
      kind: LENS_DRAFT_KIND,
    });
  }
  if (
    summary.proposalsInserted > 0 ||
    summary.rejectedInvalid > 0 ||
    summary.inferFailures > 0
  ) {
    console.log(
      `${logPrefix} cycle: 후보 ${summary.candidatesFound} → 제안 +${summary.proposalsInserted}, 사전필터 탈락 ${summary.rejectedInvalid}, 실패 ${summary.inferFailures}`,
    );
  }

  return summary;
}

/**
 * dryRun 후보 검출(spec 5.B-1 / DCL-6 실측 도구). runLensDraftCycle 의 후보 프롤로그를
 * 재사용해 이번 사이클에 실제로 LLM 을 부를 엔티티 수를 세고, microbatch 추정과 같은 방식
 * (고정 오버헤드 + 엔티티별 추정 합)으로 입력 토큰을 추정한다. LLM 은 절대 안 부른다.
 */
export async function detectLensDraftDryRun(deps: {
  deps: LensStoreDeps;
  batchSize: number;
  stageVersion: number;
}): Promise<{ candidatesFound: number; estimatedInputTokens: number }> {
  const db = deps.deps.store.getRawDb();
  const candidates = await detectLensDraftCandidates({
    deps: deps.deps,
    batchSize: deps.batchSize,
    stageVersion: deps.stageVersion,
  });
  if (candidates.length === 0) {
    return { candidatesFound: 0, estimatedInputTokens: 0 };
  }
  let estimatedInputTokens = lensDraftFixedOverheadTokens();
  for (const cand of candidates) {
    estimatedInputTokens += estimateLensDraftCandidateTokens({
      typeName: cand.typeName,
      entityId: cand.entityId,
      name: cand.name,
      emptyColumnKeys: cand.emptyColumnKeys,
      filledColumns: cand.filledColumns,
      evidence: readEvidenceContents(db, cand.evidenceNodeIds),
      lens: cand.lens,
    });
  }
  return { candidatesFound: candidates.length, estimatedInputTokens };
}

// ── 프롬프트·infer·파싱·토큰 추정은 lens-draft-infer-prompt.ts 로 분리(파일 크기 상한). ──
export {
  createLensDraftInferFn,
  parseLensDraftResponse,
} from "./lens-draft-infer-prompt.ts";
export type { LensDraftCandidate } from "./lens-draft-candidate-query.ts";
