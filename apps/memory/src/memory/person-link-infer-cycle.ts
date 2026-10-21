/**
 * person-link-infer-cycle.ts — 데이터 정리 AI 의 기존 사람 연결 한 사이클.
 *
 * 의미추출 후처리는 사람을 만들지 않고, 본명/별칭이 정확히 1명으로 닫힐 때만
 * 즉시 mentions edge 를 붙인다. 이 모듈은 그보다 애매한 경우를 깊은 정리 AI 에
 * 맡기되, AI 에게도 사람 생성 권한을 주지 않는다. 출력은 반드시 기존 personId
 * 또는 빈 값이며, 서버 검증을 통과한 기존 personId 만 자동 연결 또는
 * cleanup_proposals(kind='person_link') 로 남긴다.
 */

import type { Database } from "bun:sqlite";
import type { EventPublisher } from "./events/event-contract.ts";
import {
  CleanupConfigError,
  type StageInferResult,
} from "./cleanup-deep-pass/stage-execution.ts";
import {
  recordStageDeterministicFailure,
  recordStageRetryable,
  recordStageSuccess,
  recordStageTerminal,
} from "./cleanup-deep-pass/stage-results-ledger.ts";
import {
  DEFAULT_RETRY_REAPPEAR_DELAY_MS,
  nextRetryAt,
} from "./cleanup-deep-pass/stage-retry.ts";
import { splitIntoMicrobatches } from "./cleanup-deep-pass/input-estimate.ts";
import { cleanupStageMaxItemsPerCall } from "./cleanup-deep-pass/stage-constants.ts";
import { resolveNodePersonLinks } from "./person-link-resolve.ts";
// 후보 프롤로그(사람 로드·SQL 후보·언급 필터·top-K·지문·원장 제외·existingPersonIds)는
// person-link-candidate-query.ts 로 추출됐다(사이클·dryRun·외부 표면 공유 / spec 6.1).
// 옛 공개 이름은 이 파일 하단에서 re-export 한다(import 경로 무변경 — prompt 분리 선례).
import {
  collectPersonLinkCandidates,
  PERSON_LINK_KIND,
  type PersonLinkCycleStore,
  type PersonLinkNodeContext,
  type PersonLinkPersonContext,
} from "./person-link-candidate-query.ts";
// 프롬프트·infer·파싱은 person-link-infer-prompt.ts 로 분리(파일 800줄 상한). 사이클은
// microbatch 추정(오버헤드·노드 토큰)과 선택 칸 정규화(trimOptional)만 여기서 소비한다.
import {
  estimatePersonLinkNodeTokens,
  personLinkFixedOverheadTokens,
  trimOptional,
} from "./person-link-infer-prompt.ts";

export const CLEANUP_PROPOSALS_READY_EVENT = "cleanup_proposals_ready";
export const PERSON_LINK_AUTO_CONFIDENCE = 0.9;
export const PERSON_LINK_PROPOSAL_CONFIDENCE = 0.6;
/**
 * 한 호출에 싣는 노드 수 상한 — 출력 한도(기본 몫 + 노드 수 × 노드 몫)가 첫 호출부터 상한에
 * 닿지 않는 개수(stage-constants cleanupStageMaxItemsPerCall 단일 출처). 설정 batchSize 는 한
 * 사이클에 줍는 후보 수라 이보다 클 수 있다 — microbatch 가 이 개수씩 나눠 부른다.
 */
export const PERSON_LINK_MAX_NODES_PER_CALL = cleanupStageMaxItemsPerCall("person_link");

export interface PersonLinkInferInput {
  nodes: PersonLinkNodeContext[];
  people: PersonLinkPersonContext[];
}

export interface PersonLinkDecision {
  nodeId: number;
  /** 연결할 기존 personId. 없거나 애매하면 null/빈 문자열. */
  personId: string | null;
  confidence: number;
  candidateText?: string;
  evidence?: string;
  reason?: string;
  /** 모델이 "이 언급이 누구인지 확실하지 않다" 고 표시한 연결(자동 연결 안 함, 검토 제안). */
  uncertain?: boolean;
  /** 회신 모양이 계약과 어긋난 결정(파서가 단다) — 노드는 답한 것으로 세되 결정은 버린다. */
  invalidReason?: string;
}

export type PersonLinkInferFn = (
  input: PersonLinkInferInput,
) => Promise<StageInferResult<PersonLinkDecision[]>>;

export interface PersonLinkInferCycleDeps {
  db: Database;
  store: PersonLinkCycleStore;
  infer: PersonLinkInferFn | null;
  eventBus: EventPublisher;
  batchSize: number;
  personLimit?: number;
  autoConfidenceThreshold?: number;
  proposalConfidenceThreshold?: number;
  /**
   * conf>=0.9 자동 연결 게이트(spec 5.B-2 personLink.autoApply). true = 확실한 연결을
   * 자동 mentions 엣지로. false = 확실한 연결도 검토 제안(cleanup_proposals)으로 보낸다
   * (자동 쓰기 skip — 기능 축소가 아니라 적용 게이트 위치 선택). 미지정 시 자동 연결 ON
   * (옛 소비처 호환 default — index 배선은 설정값을 명시로 넘긴다).
   */
  autoApply?: boolean;
  /**
   * 단계 계약 버전(원장 재평가 신호, spec 5.B-3 person_link stageVersion — 상수 맵 단일
   * 출처).
   */
  stageVersion: number;
  /** 결정적 실패 attempt 상한(reliability.maxAttemptsPerTarget, spec 4.A default 3). T5 전 상수. */
  maxAttemptsPerTarget: number;
  /**
   * 노드별 top-K 사전 필터 상한(spec 4.A-7 / 5.B-3 person_link prefilterTopK, 상수 맵 단일
   * 출처). 미지정 시 모듈 default(PERSON_LINK_PREFILTER_TOP_K)를 쓴다.
   */
  prefilterTopK?: number;
  /**
   * 호출당 입력 상한(budget.maxEstimatedInputTokensPerCall, spec 4.A-6). 노드를 고정 개수가
   * 아니라 추정 입력 토큰 합(공유 사람 명단 오버헤드 + 노드별 줄)이 이 상한 안에 들도록 묶어
   * (microbatch) 배치별로 부른다. 노드 하나 + 공유 오버헤드만으로도 상한을 넘는 노드는 호출
   * 없이 원장 terminal(input_over_cap). 설정에서 T5 가 등록한 budget 값을 index 가 넘긴다.
   */
  perCallInputCap: number;
  /** 이 메모들만 후보로(입력 직후 정리·펫 바로 정리, CleanupRunContext.nodeIds). */
  nodeIds?: readonly number[];
  logPrefix?: string;
}

export interface PersonLinkInferCycleSummary {
  candidatesFound: number;
  peopleLoaded: number;
  autoLinked: number;
  proposalsInserted: number;
  rejectedInvalid: number;
  inferFailures: number;
  /** 원장 completed 기록 수(연결/제안 산출 있는 노드). */
  completed: number;
  /** 원장 completed_noop 기록 수(정상 회신인데 그 노드 산출 0 — 빈 값 결정). */
  completedNoop: number;
  /**
   * 커버리지 미달 노드 수(spec 4.A-7) — 입력에 실었는데 응답에 그 노드 결정이 하나도 없고,
   * 노드 하나만 실은 단독 재호출에서도 또 없었던 노드. 결정적 실패(attempt++)로 원장에
   * 기록된다(여러 노드 배치에서 빠졌다가 단독 재호출에서 답을 받은 노드는 세지 않는다).
   */
  coverageMisses: number;
}

export async function runPersonLinkInferCycle(
  deps: PersonLinkInferCycleDeps,
): Promise<PersonLinkInferCycleSummary> {
  const logPrefix = deps.logPrefix ?? "[person-link-infer]";
  const summary: PersonLinkInferCycleSummary = {
    candidatesFound: 0,
    peopleLoaded: 0,
    autoLinked: 0,
    proposalsInserted: 0,
    rejectedInvalid: 0,
    inferFailures: 0,
    completed: 0,
    completedNoop: 0,
    coverageMisses: 0,
  };

  if (deps.infer === null) {
    console.log(`${logPrefix} LLM 미가용 — person_link 한 사이클 건너뜀(no-op).`);
    return summary;
  }

  // 후보 프롤로그(사람 로드 → SQL 후보 → 언급/후보 필터 → top-K 사전 필터 → 지문 →
  // 결과 원장 2차 제외 → existingPersonIds)는 collectPersonLinkCandidates 로 추출됐다
  // (사이클·dryRun·외부 표면 공유 / spec 6.1). 계산 시점·순서는 그대로다.
  const { people, rows } = await collectPersonLinkCandidates({
    db: deps.db,
    store: deps.store,
    batchSize: deps.batchSize,
    stageVersion: deps.stageVersion,
    personLimit: deps.personLimit,
    prefilterTopK: deps.prefilterTopK,
    ...(deps.nodeIds ? { nodeIds: deps.nodeIds } : {}),
  });
  summary.peopleLoaded = people.length;
  if (people.length === 0) {
    return summary;
  }
  summary.candidatesFound = rows.length;
  if (rows.length === 0) {
    return summary;
  }

  // 노드별 실행층 입력 컨텍스트 + 원장 키(fingerprint 동반).
  const nodeContexts: PersonLinkNodeContext[] = rows.map((row) => ({
    id: row.id,
    content: row.content,
    personCandidates: row.personCandidates,
    existingPersonIds: row.existingPersonIds,
    topKPersonIds: row.topKPersonIds,
  }));
  const ledgerKeyByNode = new Map(
    rows.map((r) => [
      r.id,
      {
        stage: "person_link" as const,
        targetKey: r.targetKey,
        inputFingerprint: r.inputFingerprint,
        stageVersion: r.stageVersion,
      },
    ]),
  );

  // ── 토큰 인지 microbatch(spec 4.A-6) — 노드를 고정 개수가 아니라 추정 입력 토큰 합이
  //   호출당 상한 안에 들도록 묶는다. 공유 오버헤드 = system 프롬프트 + 사람 명단(배치마다
  //   다시 실린다). 노드별 비용 = 그 노드 프롬프트 줄. 노드 하나 + 공유 오버헤드만으로도
  //   상한을 넘는 노드는 oversized → 호출 없이 terminal(input_over_cap).
  const fixedOverhead = personLinkFixedOverheadTokens(people);
  const { batches, oversized } = splitIntoMicrobatches(nodeContexts, {
    fixedOverheadTokens: fixedOverhead,
    perCallCap: deps.perCallInputCap,
    tokensOf: (node) => estimatePersonLinkNodeTokens(node),
    // 출력이 노드 수에 비례 — 첫 호출이 출력 상한에 닿지 않는 개수로도 자른다.
    maxItemsPerBatch: PERSON_LINK_MAX_NODES_PER_CALL,
  });
  for (const node of oversized) {
    const key = ledgerKeyByNode.get(node.id)!;
    recordStageTerminal(deps.db, {
      ...key,
      lastError: `input_over_cap — 노드 프롬프트 추정 + 사람 명단이 호출당 상한(${deps.perCallInputCap}) 초과`,
    });
    summary.inferFailures += 1;
    console.warn(
      `${logPrefix} 입력 상한 초과 — node ${node.id} terminal(input_over_cap).`,
    );
  }

  const autoThreshold =
    deps.autoConfidenceThreshold ?? PERSON_LINK_AUTO_CONFIDENCE;
  const proposalThreshold =
    deps.proposalConfidenceThreshold ?? PERSON_LINK_PROPOSAL_CONFIDENCE;
  const knownPersonIds = new Set(people.map((p) => p.personId));

  // ── 배치별 실행층 호출 + 결정 처리(커버리지는 배치 안에서만 판정) ─────────────────
  //   한 배치의 노드는 그 배치 응답으로만 커버 판정한다 — 배치 1 노드를 배치 2 응답이
  //   안 가리켰다고 커버리지 미달로 몰지 않는다. config 는 사이클 통째 중단, budget 은
  //   남은 배치 이월(원장 미기록 → 다음 사이클 재등장).
  //   응답에서 통째 누락된 노드는 여러 노드 배치였다면 노드 하나짜리 배치로 다시 큐 앞에
  //   넣어 재호출하고(entity_register 단계와 같은 방식), 하나짜리 호출에서도 누락이면 결정적
  //   실패(attempt++ → 상한에서 terminal)로 기록한다 — 원장 미기록으로 매 사이클 유료 모델에
  //   재전송되는 무한 재과금을 막는다.
  const queue: PersonLinkNodeContext[][] = [...batches];
  while (queue.length > 0) {
    const batch = queue.shift()!;
    const batchLedgerKeys = new Map(
      batch.map((n) => [n.id, ledgerKeyByNode.get(n.id)!]),
    );
    const inferResult = await deps.infer({ nodes: batch, people });

    if (inferResult.kind === "config") {
      // 설정 결함 = 사이클 통째 중단(대상별 기록 없음 — 대상 죄 아님).
      throw new CleanupConfigError(inferResult.reason);
    }
    if (inferResult.kind === "budget") {
      // 예산 도달 — 이 배치·남은 배치 원장 미기록(다음 사이클 재등장).
      console.log(
        `${logPrefix} 예산 도달(${inferResult.dimension}: ${inferResult.detail}) — 남은 person_link 배치 이월.`,
      );
      break;
    }
    if (inferResult.kind === "transient" || inferResult.kind === "deterministic") {
      summary.inferFailures += 1;
      for (const key of batchLedgerKeys.values()) {
        if (inferResult.kind === "transient") {
          recordStageRetryable(deps.db, {
            ...key,
            nextRetryAt: nextRetryAt(inferResult.retryAfterMs, DEFAULT_RETRY_REAPPEAR_DELAY_MS),
            lastError: inferResult.reason,
          });
        } else {
          recordStageDeterministicFailure(deps.db, {
            ...key,
            maxAttemptsPerTarget: deps.maxAttemptsPerTarget,
            lastError: inferResult.reason,
          });
        }
      }
      console.warn(
        `${logPrefix} ${inferResult.kind} — person_link 배치 실패 원장(nodeIds=${batch
          .map((n) => n.id)
          .join(",")}): ${inferResult.reason}`,
      );
      continue;
    }

    const missing = await processPersonLinkBatch({
      deps,
      logPrefix,
      batch,
      decisions: inferResult.parsed,
      batchLedgerKeys,
      knownPersonIds,
      autoThreshold,
      proposalThreshold,
      // spec 5.B-2 — 미지정 시 자동 연결 ON(옛 소비처 호환). index 배선은 설정값 명시.
      autoApply: deps.autoApply ?? true,
      summary,
    });
    if (missing.length === 0) continue;
    if (batch.length > 1) {
      queue.unshift(...missing.map((n) => [n]));
      continue;
    }
    // 하나만 보냈는데도 답이 없다 — 결정적 실패 기록(재전송 무한 반복 차단).
    const node = missing[0]!;
    summary.coverageMisses += 1;
    recordStageDeterministicFailure(deps.db, {
      ...ledgerKeyByNode.get(node.id)!,
      maxAttemptsPerTarget: deps.maxAttemptsPerTarget,
      lastError: "person_link 응답에 이 메모의 결정이 없음(단독 재호출에서도 누락)",
    });
  }

  if (summary.coverageMisses > 0) {
    console.warn(
      `${logPrefix} 커버리지 미달 ${summary.coverageMisses}건 — 단독 재호출에서도 결정이 없는 노드는 결정적 실패로 원장 기록.`,
    );
  }

  if (summary.proposalsInserted > 0) {
    deps.eventBus.emit(CLEANUP_PROPOSALS_READY_EVENT, {
      count: summary.proposalsInserted,
      kind: PERSON_LINK_KIND,
    });
  }

  if (
    summary.autoLinked > 0 ||
    summary.proposalsInserted > 0 ||
    summary.rejectedInvalid > 0 ||
    summary.inferFailures > 0
  ) {
    console.log(
      `${logPrefix} cycle: 후보 ${summary.candidatesFound} / 사람 ${summary.peopleLoaded} → 자동연결 +${summary.autoLinked}, 제안 +${summary.proposalsInserted}, 거부 ${summary.rejectedInvalid}`,
    );
  }

  return summary;
}

/**
 * dryRun 후보 검출(spec 5.B-1 / DCL-6 실측 도구). runPersonLinkInferCycle 의 후보
 * 프롤로그(사람 로드 → 후보 조회 → 언급/후보 필터 → top-K 사전 필터 → 결과 원장 2차
 * 제외)를 그대로 재사용해 이번 사이클에 실제로 LLM 을 부를 노드 수를 세고, microbatch
 * 추정과 같은 방식(고정 오버헤드 + 노드별 추정 합)으로 입력 토큰을 추정한다. LLM 은
 * 절대 안 부른다. 사람 0명(연결 대상 없음)이면 후보 0.
 */
export async function detectPersonLinkDryRun(deps: {
  db: Database;
  store: PersonLinkCycleStore;
  batchSize: number;
  stageVersion: number;
  personLimit?: number;
  prefilterTopK?: number;
}): Promise<{ candidatesFound: number; estimatedInputTokens: number }> {
  const { people, rows } = await collectPersonLinkCandidates({
    db: deps.db,
    store: deps.store,
    batchSize: deps.batchSize,
    stageVersion: deps.stageVersion,
    personLimit: deps.personLimit,
    prefilterTopK: deps.prefilterTopK,
  });
  if (people.length === 0) {
    return { candidatesFound: 0, estimatedInputTokens: 0 };
  }
  if (rows.length === 0) {
    return { candidatesFound: 0, estimatedInputTokens: 0 };
  }
  const nodeContexts: PersonLinkNodeContext[] = rows.map((row) => ({
    id: row.id,
    content: row.content,
    personCandidates: row.personCandidates,
    existingPersonIds: row.existingPersonIds,
    topKPersonIds: row.topKPersonIds,
  }));
  // microbatch 추정과 같은 셈 — 배치 오버헤드는 배치마다 다시 실리므로 정확한 배치 분할
  // 없이는 상한이 걸리나, dryRun 추정은 "한 번에 다 부른다면" 기준의 하한 추정이다:
  // 고정 오버헤드 한 번 + 노드별 추정 합(예산 실측의 보수적 자료).
  const fixedOverhead = personLinkFixedOverheadTokens(people);
  let estimatedInputTokens = fixedOverhead;
  for (const node of nodeContexts) {
    estimatedInputTokens += estimatePersonLinkNodeTokens(node);
  }
  return { candidatesFound: rows.length, estimatedInputTokens };
}

/** 한 대상의 원장 키(성공/실패 기록 재사용). */
interface PersonLinkLedgerKey {
  stage: "person_link";
  targetKey: string;
  inputFingerprint: string;
  stageVersion: number;
}

/** processPersonLinkBatch 인자 — 한 배치의 결정을 검증·적용·원장 기록한다. */
interface ProcessBatchInput {
  deps: PersonLinkInferCycleDeps;
  logPrefix: string;
  batch: PersonLinkNodeContext[];
  decisions: PersonLinkDecision[];
  batchLedgerKeys: Map<number, PersonLinkLedgerKey>;
  knownPersonIds: ReadonlySet<string>;
  autoThreshold: number;
  proposalThreshold: number;
  /** conf>=0.9 자동 연결 게이트(spec 5.B-2). false 면 확실한 연결도 제안 경유. */
  autoApply: boolean;
  summary: PersonLinkInferCycleSummary;
}

/**
 * 한 microbatch 의 결정을 처리한다 — 검증 → 자동 연결/제안 → 노드 단위 커버리지 원장 기록.
 * 커버리지(spec 4.A-7)는 *이 배치 노드* 안에서만 판정한다: 응답에 그 노드 결정이 있으면
 * 커버됨, 통째 누락이면 원장에 쓰지 않고 호출자에 돌려준다(재호출/실패 기록은 호출자). 배치 밖 nodeId(환각)는 무시한다.
 */
async function processPersonLinkBatch(
  args: ProcessBatchInput,
): Promise<PersonLinkNodeContext[]> {
  const {
    deps,
    logPrefix,
    batch,
    decisions,
    batchLedgerKeys,
    knownPersonIds,
    autoThreshold,
    proposalThreshold,
    autoApply,
    summary,
  } = args;

  const allowedNodeIds = new Set(batch.map((n) => n.id));
  const existingByNode = new Map(
    batch.map((n) => [n.id, new Set(n.existingPersonIds)]),
  );
  const byNode = new Map<number, PersonLinkDecision[]>();
  // 커버됨 = 응답에 그 노드 결정(연결·제안·빈 값 어느 것이든)이 하나라도 있는 노드.
  const coveredNodeIds = new Set<number>();
  // 커버된 노드 중 검증 탈락이 아닌 결정을 하나라도 받은 노드(정상 무산출·산출). 커버는
  // 됐지만 여기 없는 노드는 그 노드 결정이 전부 검증 탈락 → completed_noop 아닌 결정적 실패.
  const nonInvalidNodeIds = new Set<number>();

  for (const decision of decisions) {
    const validation = validateDecision(
      decision,
      allowedNodeIds,
      knownPersonIds,
      existingByNode,
    );
    if (validation !== "unknown-node") {
      coveredNodeIds.add(decision.nodeId);
    }
    if (validation === "empty") {
      nonInvalidNodeIds.add(decision.nodeId);
      continue;
    }
    if (validation !== "valid" && validation !== "already-linked") {
      summary.rejectedInvalid += 1;
      console.warn(
        `${logPrefix} 잘못된 person_link 결정 버림 — ${validation}: ${JSON.stringify(decision)}`,
      );
      continue;
    }
    // valid·already-linked 둘 다 담는다 — 이미 연결된 사람도 "같은 언급이 여러 사람으로
    // 갈렸는가" 판정에는 들어가야 한다(쓰기는 아래에서 이미 연결된 사람을 건너뛴다).
    nonInvalidNodeIds.add(decision.nodeId);
    const bucket = byNode.get(decision.nodeId) ?? [];
    bucket.push({
      ...decision,
      personId: decision.personId!.trim(),
      candidateText: trimOptional(decision.candidateText),
      evidence: trimOptional(decision.evidence),
      reason: trimOptional(decision.reason),
    });
    byNode.set(decision.nodeId, bucket);
  }

  // 산출을 낸 노드(자동 연결·제안). 나머지 커버 노드는 completed_noop.
  const producedByNode = new Set<number>();
  for (const [nodeId, group] of byNode) {
    const existing = existingByNode.get(nodeId)!;
    // 사람마다 연결 하나로 합치고 애매함을 정한다(person-link-resolve.ts). 한 메모의 서로 다른
    // 사람은 각자 연결 대상이고, 애매함은 같은 언급이 여러 사람으로 갈렸거나 모델이 불확실을
    // 표시한 연결에만 붙는다.
    for (const { decision, ambiguous } of resolveNodePersonLinks(group)) {
      if (existing.has(decision.personId!)) continue; // 이미 연결됨 — 판정에만 쓰고 쓰기 없음.
      // conf>=0.9 + 애매하지 않은 연결 — autoApply=true 면 자동 mentions 엣지, false 면 확실한
      // 연결도 검토 제안으로 보낸다(spec 5.B-2 적용 게이트 위치 선택 — 산출은 유지, 자동
      // 쓰기만 skip). 낮은 확신(0.6~0.9)·애매한 연결은 autoApply 와 무관하게 늘 제안 경유.
      if (!ambiguous && decision.confidence >= autoThreshold) {
        if (autoApply) {
          const added = await deps.store.addNodePersonEdge(
            nodeId,
            decision.personId!,
            "mentions",
            "llm_extract",
            nodeId,
          );
          if (added) {
            summary.autoLinked += 1;
            producedByNode.add(nodeId);
          }
          continue;
        }
        // autoApply=false — 확실한 연결을 제안으로. autoApplyWithheld 로 표기해 카드가
        // "자동 연결 대상이었으나 검토 대기" 임을 드러낸다(정직한 게이트 표시).
        insertPersonLinkProposal(deps.db, {
          nodeId,
          personId: decision.personId!,
          confidence: decision.confidence,
          candidateText: decision.candidateText,
          evidence: decision.evidence ?? decision.reason,
          ambiguous: false,
          autoApplyWithheld: true,
        });
        summary.proposalsInserted += 1;
        producedByNode.add(nodeId);
        continue;
      }
      if (decision.confidence < proposalThreshold) continue;
      insertPersonLinkProposal(deps.db, {
        nodeId,
        personId: decision.personId!,
        confidence: decision.confidence,
        candidateText: decision.candidateText,
        evidence: decision.evidence ?? decision.reason,
        ambiguous,
      });
      summary.proposalsInserted += 1;
      producedByNode.add(nodeId);
    }
  }

  // ── 결과 원장 기록(노드 단위 커버리지) — 커버된 노드만 남긴다:
  //     산출 낸 노드 → completed / 빈 값·이미 연결됨 → completed_noop /
  //     전건 검증 탈락 → 결정적 실패(attempt++, 상한 시 terminal).
  //   통째 누락 노드는 원장 미기록 → 다음 사이클 후보 잔존(영구 미처리 제거).
  const missing: PersonLinkNodeContext[] = [];
  for (const [nodeId, key] of batchLedgerKeys) {
    if (!coveredNodeIds.has(nodeId)) {
      // 통째 누락 — 원장 기록은 호출자가 한다(배치면 단독 재호출, 단독이면 결정적 실패).
      missing.push(batch.find((n) => n.id === nodeId)!);
      continue;
    }
    if (producedByNode.has(nodeId)) {
      recordStageSuccess(deps.db, { ...key, noop: false });
      summary.completed += 1;
    } else if (nonInvalidNodeIds.has(nodeId)) {
      recordStageSuccess(deps.db, { ...key, noop: true });
      summary.completedNoop += 1;
    } else {
      recordStageDeterministicFailure(deps.db, {
        ...key,
        maxAttemptsPerTarget: deps.maxAttemptsPerTarget,
        lastError: "person_link 결정 전건 검증 탈락(unknown-person/bad-confidence/malformed)",
      });
    }
  }
  return missing;
}

type DecisionValidation =
  | "valid"
  | "empty"
  | "already-linked"
  | "unknown-node"
  | "malformed"
  | "unknown-person"
  | "bad-confidence";

function validateDecision(
  decision: PersonLinkDecision,
  allowedNodeIds: ReadonlySet<number>,
  knownPersonIds: ReadonlySet<string>,
  existingByNode: ReadonlyMap<number, ReadonlySet<string>>,
): DecisionValidation {
  if (!Number.isInteger(decision.nodeId) || !allowedNodeIds.has(decision.nodeId)) {
    return "unknown-node";
  }
  if (decision.invalidReason !== undefined) {
    return "malformed";
  }
  const personId =
    typeof decision.personId === "string" ? decision.personId.trim() : "";
  if (!personId) {
    return "empty";
  }
  if (!knownPersonIds.has(personId)) {
    return "unknown-person";
  }
  if (!Number.isFinite(decision.confidence)) {
    return "bad-confidence";
  }
  if (existingByNode.get(decision.nodeId)?.has(personId)) {
    return "already-linked";
  }
  return "valid";
}

function insertPersonLinkProposal(
  db: Database,
  proposal: {
    nodeId: number;
    personId: string;
    confidence: number;
    candidateText?: string;
    evidence?: string;
    ambiguous?: boolean;
    /**
     * conf>=0.9 로 자동 연결 대상이었으나 personLink.autoApply=false 라 제안으로 돌린
     * 건임을 표기(spec 5.B-2). 카드가 "확실한 연결이나 검토 게이트 경유" 를 드러낸다.
     */
    autoApplyWithheld?: boolean;
  },
): void {
  const payload: Record<string, unknown> = {
    nodeId: proposal.nodeId,
    personId: proposal.personId,
    confidence: proposal.confidence,
  };
  if (proposal.candidateText) payload.candidateText = proposal.candidateText;
  if (proposal.evidence) payload.evidence = proposal.evidence;
  if (proposal.ambiguous === true) payload.ambiguous = true;
  if (proposal.autoApplyWithheld === true) payload.autoApplyWithheld = true;

  db
    .prepare(
      "INSERT INTO cleanup_proposals (id, kind, payload_json) VALUES (?, ?, ?)",
    )
    .run(`cp_${crypto.randomUUID()}`, PERSON_LINK_KIND, JSON.stringify(payload));
}

// ── 프롬프트·infer·파싱·토큰 추정은 person-link-infer-prompt.ts 로 분리(파일 800줄 상한
//   정합). 옛 소비처(index.ts·테스트) 호환을 위해 공개 이름을 여기서 re-export 한다 —
//   import 경로 변경 0. trimOptional 은 이 파일 내부(processPersonLinkBatch)에서도 쓴다.
export {
  createOllamaPersonLinkInferFn,
  parsePersonLinkResponse,
  personLinkFixedOverheadTokens,
  estimatePersonLinkNodeTokens,
} from "./person-link-infer-prompt.ts";

// ── 후보 프롤로그는 person-link-candidate-query.ts 로 추출됐다(사이클·dryRun·외부 표면
//   공유 / spec 6.1). 옛 소비처(index.ts·테스트) 호환을 위해 공개 이름을 여기서 re-export
//   한다 — import 경로 변경 0(prompt 분리 선례). PERSON_LINK_KIND·collectPersonLinkCandidates·
//   PersonLinkNodeContext·PersonLinkPersonContext·PersonLinkCycleStore 는 이 모듈이 값·타입으로
//   직접 쓰려고 상단에서 import 했으므로, 그 로컬 바인딩을 그대로 re-export 한다(중복 선언 회피).
export {
  PERSON_LINK_KIND,
  collectPersonLinkCandidates,
};
export type {
  PersonLinkCycleStore,
  PersonLinkNodeContext,
  PersonLinkPersonContext,
};
export {
  PERSON_LINK_PREFILTER_TOP_K,
  PERSON_LINK_CANDIDATE_SOURCE_TYPES,
} from "./person-link-candidate-query.ts";
export type {
  PersonLinkCandidateRow,
  CollectPersonLinkCandidatesDeps,
} from "./person-link-candidate-query.ts";
