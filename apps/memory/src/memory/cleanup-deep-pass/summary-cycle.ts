/**
 * summary-cycle.ts — 데이터 정리 깊은 패스 둘째 단계(요약)의 한 사이클 글루.
 *
 * 권위 spec: docs/decisions/2026-06-05-phase7-summary-stage-spec.md 단락 3.2·3.3·4.2·4.5·4.6
 * 권위 plan: docs/decisions/2026-06-05-phase7-summary-stage-plan.md Task 6
 *
 * 이 모듈은 *스케줄러가 아니라* 한 번 호출하면 한 사이클을 도는 함수다(runRegexStrengthenCycle·
 * runMetadataInferCycle 선례 정합). Task 7 wiring 이 첫 단계 정규식 강화 사이클 *다음에*
 * 같은 runCycle 콜백 안에서 이 함수를 이어 부른다(새 스케줄러 0).
 *
 * 한 사이클 흐름:
 *   1. 후보 — findChunkSummaryCandidates(Task 4): atomic≥임계 · 청크요약 행 아직 없는
 *      document_chunk. planSummaryCallsUnderCap 으로 문서별·호출 크기(청크 수·입력 상한)별 묶음 + 묶음별 허용 개념 집합을 구한다.
 *   2-A. infer 가용 → 묶음마다 한 번씩 통합 LLM 호출(청크요약 + 관계 발굴 두 갈래). 한 묶음은
 *        한 문서의 청크 일부일 수 있다(후보 LIMIT·요약 없는 청크만·호출당 청크 수 상한).
 *        parseSummaryResponse 로 JSON 파싱(실패는 그 묶음 건너뜀 + loud warn).
 *        - 청크요약: validateChunkSummary(ID 결정적 매치) 통과분만 generated_by='llm' 저장
 *          + 임베딩. 후보 멱등(청크 행 존재)이 재처리를 막는다.
 *        - 관계요약: 묶음 개념이 2건 이상일 때만. validateRelationSummary(from·to 가 *그 묶음
 *          청크에서 나온* 개념인지) 통과분 중 그 문서에 아직 없는 개념 쌍만 relation_summaries 에
 *          개념 id·source_document_id·confidence 동반 저장 + 임베딩, gateRelationEdge(confidence
 *          임계) 통과만 addConceptEdge({relation:'llm_relation'}) — concept_edges 에 개념 쌍 엣지.
 *   2-B. infer=null(graceful) → 청크요약은 extractFirstParagraph 첫 문단 fallback 으로
 *        generated_by='first_paragraph_fallback' 저장 + 임베딩. 관계요약·엣지 둘 다 skip
 *        + 사유 로그(관계 발굴은 LLM 없이 불가 — 청크요약 한정 fallback). 자동 관계 0.
 *   3. emit — 관계 발굴이 새 엣지를 만든 사이클이면 정보성 event(버튼 없는 알림). 0건이면 0.
 *
 * graceful: cleanup LLM 미가용(infer=null) → 첫 문단 fallback 만(관계·엣지 skip). 환각·
 * 파싱 실패·LLM throw 는 전부 식별자 담은 loud console.warn(silent 0건 위장 금지).
 *
 * cross-document 관계 차단(Task 14 개념 발굴 정정): 관계 발굴 입력을 *한 문서의 한 청크 묶음*
 * 으로만 주고, validateRelationSummary 의 allowedConceptIds 를 그 묶음 청크의 허용 개념 집합
 * (planSummaryCallsUnderCap 의 group.relationConcepts — cpt_/psn_)으로 한정한다. from·to 가 모두 그
 * 묶음 개념이어야 통과하므로 cross-document 관계도, 모델이 본 적 없는 청크의 개념끼리 맺는 관계도
 * 만들어지지 않는다. 관계 발굴 멱등은 청크 묶음 단위다(2026-10-19 — 옛 문서 단위 영구 마감 폐기,
 * summary-candidate-query.ts 머리 주석). 관계는 글 노드가 아니라 개념끼리(concept_edges) 이어진다.
 */

import type { Database } from "bun:sqlite";
import type { Embedder } from "../../embedding/types.ts";
import { EVENT_TYPES, type EventPublisher } from "../events/event-contract.ts";
import { extractFirstParagraph } from "./first-paragraph.ts";
import {
  collectChunkSetConcepts,
  findChunkSummaryCandidates,
  listRelationPairsForDocument,
  planSummaryCallsUnderCap,
  relationPairKey,
  type ChunkSummaryCandidate,
  type SummaryCallGroup,
  type SummaryCallPlan,
} from "./summary-candidate-query.ts";
import {
  gateRelationEdge,
  parseSummaryResponse,
  validateChunkSummary,
  validateRelationSummary,
  type SummaryInferFn,
} from "./summary-gates.ts";
import { CleanupConfigError } from "./stage-execution.ts";
import {
  relationDiscoveryFingerprint,
  summaryFingerprint,
} from "./stage-fingerprint.ts";
import {
  filterCandidatesByLedger,
  recordStageDeterministicFailure,
  recordStageRetryable,
  recordStageSuccess,
  recordStageTerminal,
} from "./stage-results-ledger.ts";
import { DEFAULT_RETRY_REAPPEAR_DELAY_MS, nextRetryAt } from "./stage-retry.ts";
import { cleanupStageMaxItemsPerCall } from "./stage-constants.ts";
import { estimateTextTokens } from "./input-estimate.ts";
import {
  renderDocumentForPrompt,
  summaryCallFixedOverheadTokens,
  summaryChunkTokens,
} from "./summary-infer-prompt.ts";

// ── 모듈 상수 (하드코딩 금지 — 한곳에 격리) ──────────────────────────────────

/** 청크요약 출처 — LLM 생성. */
const GENERATED_BY_LLM = "llm";

/** 청크요약 출처 — 첫 문단 fallback(LLM 미가용). */
const GENERATED_BY_FALLBACK = "first_paragraph_fallback";

/**
 * 한 호출에 싣는 청크 최대 수 — 출력 한도 맵(stage-constants summary)에서 계산한 값. 첫 호출이
 * 출력 상한에 닿지 않아 잘림 재호출 여지가 남는 개수다.
 */
const SUMMARY_MAX_CHUNKS_PER_CALL = cleanupStageMaxItemsPerCall("summary");

/** 관계 발굴 원장 targetKey 의 문서 id·청크 id 목록 구분자(U+001F — 원장 targetKey 관례). */
const RELATION_TARGET_KEY_SEPARATOR = String.fromCharCode(0x1f);

/** 관계 발굴 정보성 알림 event type — 자동 적용이라 수락/거절 버튼 0(검토 게이트 아님).
 *  events/event-contract.ts `EVENT_TYPES` 카탈로그를 단일 출처로 따른다(Task 9 정합 — 문자열을 두
 *  곳에 적지 않는다). cleanup_proposals_ready 와는 다른 문자열(그건 [수락]/[거절] 카드용
 *  검토 게이트 — 요약 엣지는 자동 적용이라 버튼이 없다). payload `{ count, relationSummaries }`. */
export const RELATIONS_DISCOVERED_EVENT = EVENT_TYPES.RELATIONS_DISCOVERED;

/**
 * 요약 행을 저장하고 엣지를 만드는 store 표면(SqliteMemoryStore 가 충족). 글루가 의존하는
 * 메서드만 좁게 선언 — 함수 주입 구조라 테스트는 실 SqliteMemoryStore 를 그대로 넘긴다
 * (mock 객체 0). insert* 는 임베딩까지 한 트랜잭션으로 처리한다(summary-repository.ts).
 */
export interface SummaryCycleStore {
  insertChunkSummary(args: {
    summaryId: string;
    parentChunkId: number;
    parentDocumentId: string;
    summaryText: string;
    generatedBy: "llm" | "first_paragraph_fallback" | "user_edit";
  }): Promise<number>;
  insertRelationSummary(args: {
    summaryId: string;
    fromConceptId: string;
    toConceptId: string;
    relationName: string;
    summaryText: string;
    confidence: number;
    generatedBy: string;
    sourceDocumentId: string;
  }): Promise<number>;
  addConceptEdge(args: {
    sourceConceptId: string;
    targetConceptId: string;
    relation: "llm_relation";
    provenance: "llm_extract";
    sourceNodeId: null;
    weight: number;
  }): Promise<void>;
}

/** 한 사이클 결과 요약(관측·로그·테스트용). */
export interface SummaryCycleSummary {
  /** 저장된 청크요약 행 수(llm + first_paragraph_fallback 합산). */
  chunkSummariesCreated: number;
  /** 저장된 관계요약 행 수(엣지 보류분 포함 — 행은 항상 저장). */
  relationSummariesCreated: number;
  /** confidence 게이트 통과해 만든 llm_relation 엣지 수. */
  edgesCreated: number;
  /**
   * confidence 게이트는 통과했으나 relationAutoApply=false 라 엣지 생성을 보류한 수
   * (spec 5.B-2). 관계요약 행은 저장됨 — 엣지만 안 굳음. silent 아님(집계·로그 표기).
   */
  edgesWithheld: number;
  /** ID 검증(청크 id·관계 from/to 실재)에서 버린 환각 수. */
  rejectedHallucinations: number;
  /**
   * ID 검증은 통과했으나 같은 문서에 이미 관계요약이 있는 개념 쌍이라 저장하지 않은 수(앞선
   * 청크 묶음이 만든 쌍의 중복 — 청크 묶음 단위 관계 멱등의 짝). silent 아님(집계·로그 표기).
   */
  relationDuplicatesSkipped: number;
  /** LLM 호출이 throw 하거나 JSON 파싱이 실패해 건너뛴 문서 수. */
  inferFailures: number;
}

export interface SummaryCycleDeps {
  /** 후보 조회용 raw DB 핸들(store.getRawDb()). */
  db: Database;
  /** 요약 저장·엣지 생성 통로(임베딩 포함 — summary-repository 위임). */
  store: SummaryCycleStore;
  /** 첫 문단 fallback 임베딩 차원 검증·관측용. 저장 임베딩은 store 안에서 한다. */
  embedder: Embedder;
  /**
   * 통합 LLM 추론 함수. null 이면 graceful — 청크요약은 첫 문단 fallback, 관계·엣지는
   * skip. 함수 주입 구조라 테스트는 데이터 fixture 응답 함수를 넘긴다(mock 객체 0).
   */
  infer: SummaryInferFn | null;
  /** 알림 버스 — 새 엣지를 만든 사이클이면 정보성 emit(0건이면 emit 안 함). */
  eventBus: EventPublisher;
  /** 청크요약 대상 최소 atomic 수(설정값 — 하드코딩 0). */
  atomicThreshold: number;
  /** 한 사이클 후보 청크 최대 수(설정값 — 하드코딩 0). */
  batchSize: number;
  /** 엣지 승격 confidence 임계(0~1 / 설정값 — 하드코딩 0). */
  relationConfidenceThreshold: number;
  /**
   * 관계 엣지 자동 반영 게이트(spec 5.B-2 relationDiscovery.autoApply). true = confidence
   * 임계 통과 관계를 llm_relation 개념 엣지로 자동 반영(현행 동작). false = 엣지 자동
   * 생성 보류 — relation_summaries 행은 이 값과 무관하게 항상 저장되고(정리 자산),
   * 그래프 엣지로만 안 굳는다(적용 게이트 위치 선택 — 기능 축소 아님). 미지정 시 자동
   * 반영 ON(옛 소비처 호환 default — index 배선은 설정값을 명시로 넘긴다).
   */
  relationAutoApply?: boolean;
  /** 첫 문단 fallback 최대 글자 수(설정값 — 하드코딩 0). */
  firstParagraphMaxChars: number;
  /**
   * 단계 계약 버전(원장 재평가 신호, spec 5.B-3 summary stageVersion — 상수 맵 단일
   * 출처). summary·relation_discovery 두 stage 가 이 값을 공유한다(relation_discovery
   * 는 summary 사이클 안에 사는 stage 라 별도 맵 항목이 없다).
   */
  stageVersion: number;
  /** 결정적 실패 attempt 상한(reliability.maxAttemptsPerTarget, spec 4.A default 3). T5 전 상수. */
  maxAttemptsPerTarget: number;
  /**
   * 호출당 입력 상한(budget.maxEstimatedInputTokensPerCall, spec 4.A-6). 한 묶음 추정 입력이 이 값을
   * 넘지 않게 청크 단위로 더 작은 호출로 나누고, 청크 하나만으로도 넘으면 그 청크는 호출 없이 원장
   * terminal(input_over_cap) — 본문을 잘라 보내지 않는다(다른 단계와 같은 방식).
   */
  perCallInputCap: number;
  /** 로그 prefix. 기본 "[deep-pass:summary]". */
  logPrefix?: string;
}

/**
 * 요약 단계 한 사이클을 실행한다. infer=null 이면 첫 문단 fallback 만(관계·엣지 skip).
 * 그 외에는 문서 단위 통합 호출 → 게이트 → 저장·임베딩·엣지 → emit 까지 한다.
 *
 * @returns 사이클 요약. 후보 0건이면 전부 0.
 */
export async function runSummaryCycle(
  deps: SummaryCycleDeps,
): Promise<SummaryCycleSummary> {
  const logPrefix = deps.logPrefix ?? "[deep-pass:summary]";
  const summary: SummaryCycleSummary = {
    chunkSummariesCreated: 0,
    relationSummariesCreated: 0,
    edgesCreated: 0,
    edgesWithheld: 0,
    rejectedHallucinations: 0,
    relationDuplicatesSkipped: 0,
    inferFailures: 0,
  };

  // ── 1. 후보 조회(청크요약 멱등 제외 포함) ─────────────────────────────────
  const candidates = findChunkSummaryCandidates(
    deps.db,
    deps.atomicThreshold,
    deps.batchSize,
  );
  if (candidates.length === 0) {
    return summary;
  }

  // ── 2-B. graceful — infer=null → 첫 문단 fallback / 관계·엣지 skip ─────────
  if (deps.infer === null) {
    console.log(
      `${logPrefix} LLM 미가용 — 청크요약은 첫 문단 fallback, 관계요약·엣지는 건너뜀(후보 ${candidates.length}).`,
    );
    for (const cand of candidates) {
      const created = await saveFallbackChunkSummary(deps, cand);
      if (created) summary.chunkSummariesCreated += 1;
    }
    logCycle(logPrefix, candidates.length, summary);
    return summary;
  }

  // ── 2-A. infer 가용 — 호출 묶음 단위 통합 호출 ───────────────────────────
  // 결과 원장 2차 제외(summary stage) — chunk_summaries 존재 멱등(candidate query)에 더해,
  // completed_noop·terminal·재시도 대기 청크를 뺀다(spec 4.A-3 이중 안전벨트). 파싱·구조는
  // 청크(summary) 대상 기준이다. relation_discovery 는 그 청크 묶음 호출 안에서 함께 돌아 같은
  // 청크 멱등을 따른다(같은 문서 기존 쌍 중복은 저장 직전 차단). fallback 경로(infer=null)는 이 원장을 안 탄다 —
  // 실행층을 소비하지 않는 첫 문단 fallback 은 그 자체 chunk_summaries 멱등으로 충분.
  const llmCandidates = filterCandidatesByLedger(
    deps.db,
    "summary",
    candidates.map((c) => ({
      ...c,
      targetKey: String(c.chunkId),
      inputFingerprint: summaryFingerprint({ chunkContent: c.content, atomics: c.atomics }),
      stageVersion: deps.stageVersion,
    })),
  );
  if (llmCandidates.length === 0) {
    logCycle(logPrefix, candidates.length, summary);
    return summary;
  }
  // 후보를 문서별로 모아 호출 크기(청크 수 상한 + 호출당 입력 상한)씩 자른다 — 묶음 하나당 LLM 한 번
  // (청크요약 + 관계 두 갈래 통합). 각 묶음은 그 묶음 청크에서 나온 개념만 관계 허용 집합으로 갖는다.
  const { groups: callGroups, overCap } = planSummaryCallsForCap(
    llmCandidates,
    deps.db,
    deps.perCallInputCap,
  );
  // 청크 하나만으로도 호출당 입력 상한 초과 — 본문을 잘라 보내지 않고 호출 없이 terminal.
  for (const c of overCap) {
    recordStageTerminal(deps.db, {
      stage: "summary",
      targetKey: String(c.chunkId),
      inputFingerprint: summaryFingerprint({ chunkContent: c.content, atomics: c.atomics }),
      stageVersion: deps.stageVersion,
      lastError: `input_over_cap — 청크 하나와 지시문 추정이 호출당 상한(${deps.perCallInputCap}) 초과`,
    });
    summary.inferFailures += 1;
    console.warn(`${logPrefix} 입력 상한 초과 — 청크 ${c.chunkId} terminal(input_over_cap).`);
  }

  for (const { documentId, chunks, relationConcepts } of callGroups) {
    // 청크요약 ID 검증 집합 — 청크 노드 id(정수). 관계 발굴 개념 집합과 *분리*(spec §4.6).
    const allowedChunkIds = new Set(chunks.map((c) => c.chunkId));
    const prompt = renderDocumentForPrompt(documentId, chunks, relationConcepts ?? []);

    // 이 묶음의 원장 대상들(summary stage = 청크마다, relation_discovery = 청크 묶음). 실행층
    // 비-ok 신호가 오면 이 대상 전부에 같은 실패 원장을 남긴다(대상별 재시도·attempt 누적).
    const chunkLedgerKeys = chunks.map((c) => ({
      stage: "summary" as const,
      targetKey: String(c.chunkId),
      inputFingerprint: summaryFingerprint({ chunkContent: c.content, atomics: c.atomics }),
      stageVersion: deps.stageVersion,
    }));
    const relationLedgerKey =
      relationConcepts !== null
        ? {
            stage: "relation_discovery" as const,
            targetKey: relationDiscoveryTargetKey(documentId, chunks.map((c) => c.chunkId)),
            inputFingerprint: relationDiscoveryFingerprint({
              chunks: chunks.map((c) => ({ id: c.chunkId, content: c.content })),
              allowedConceptIds: relationConcepts.map((c) => c.conceptId),
            }),
            stageVersion: deps.stageVersion,
          }
        : null;

    const inferResult = await deps.infer(prompt, chunks.length);

    // ── 실행층 비-ok 신호 → 문서 대상 전부에 실패 원장(silent 0건 위장 금지) ────────
    if (inferResult.kind === "config") {
      // 설정 결함 = 사이클 통째 중단(대상별 기록 없음 — 대상 죄 아님).
      throw new CleanupConfigError(inferResult.reason);
    }
    if (inferResult.kind === "budget") {
      // 예산 도달 — 원장 미기록, 남은 문서 이월(다음 사이클 재등장).
      console.log(
        `${logPrefix} 예산 도달(${inferResult.dimension}: ${inferResult.detail}) — 남은 묶음 이월.`,
      );
      break;
    }
    if (inferResult.kind === "transient" || inferResult.kind === "deterministic") {
      summary.inferFailures += 1;
      const targets = relationLedgerKey ? [...chunkLedgerKeys, relationLedgerKey] : chunkLedgerKeys;
      for (const key of targets) {
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
        `${logPrefix} ${inferResult.kind} — 문서 ${JSON.stringify(documentId)} 실패 원장(청크 ${[
          ...allowedChunkIds,
        ].join(",")}): ${inferResult.reason}`,
      );
      continue;
    }

    let parsed: ReturnType<typeof parseSummaryResponse>;
    try {
      parsed = parseSummaryResponse(inferResult.parsed);
    } catch (e) {
      // 파싱 실패 = 결정적 실패(같은 입력 재시도 무의미) — 대상별 attempt 누적.
      summary.inferFailures += 1;
      const reason = `JSON 파싱 실패: ${e instanceof Error ? e.message : String(e)}`;
      const targets = relationLedgerKey ? [...chunkLedgerKeys, relationLedgerKey] : chunkLedgerKeys;
      for (const key of targets) {
        recordStageDeterministicFailure(deps.db, {
          ...key,
          maxAttemptsPerTarget: deps.maxAttemptsPerTarget,
          lastError: reason,
        });
      }
      console.warn(`${logPrefix} ${reason} — 문서 ${JSON.stringify(documentId)} 건너뜀.`);
      continue;
    }

    // ── 청크요약 저장(LLM) — ID 검증 통과분만, generated_by='llm'. ───────────
    const chunkById = new Map(chunks.map((c) => [c.chunkId, c]));
    const chunkSummarizedIds = new Set<number>();
    for (const cs of parsed.chunkSummaries) {
      if (!validateChunkSummary(cs.chunkId, allowedChunkIds, logPrefix)) {
        summary.rejectedHallucinations += 1;
        continue;
      }
      const cand = chunkById.get(cs.chunkId);
      if (cand === undefined) continue; // allowedIds 와 동기 — 도달 불가이나 방어.
      await deps.store.insertChunkSummary({
        summaryId: `cs_${crypto.randomUUID()}`,
        parentChunkId: cs.chunkId,
        parentDocumentId: cand.parentId,
        summaryText: cs.summaryText,
        generatedBy: GENERATED_BY_LLM,
      });
      summary.chunkSummariesCreated += 1;
      chunkSummarizedIds.add(cs.chunkId);
    }

    // ── 청크(summary stage) 원장 기록 — 요약 만든 청크는 completed, 안 만든 청크는
    //   completed_noop(정상 회신인데 그 청크엔 산출 0). 무산출 청크 재과금을 끊는다. ──
    for (const key of chunkLedgerKeys) {
      const chunkId = Number(key.targetKey);
      recordStageSuccess(deps.db, { ...key, noop: !chunkSummarizedIds.has(chunkId) });
    }

    // ── 관계요약 저장 + 개념 엣지 — 묶음 개념이 2건 이상일 때만. ──
    // relationConcepts 가 null 이면 이 묶음 청크에서 나온 개념이 2개 미만 — 관계 갈래 skip.
    if (relationConcepts === null || relationLedgerKey === null) continue;
    let relationCreatedForDoc = 0;
    // 그 묶음 허용 개념 id 집합(cpt_/psn_) — validateRelationSummary 가 from·to 를 이 안에서만
    // 통과시킨다(환각·cross-document·못 본 청크 개념 차단). 청크요약 집합(정수)과 분리(spec §4.6).
    const allowedConceptIds = new Set(relationConcepts.map((c) => c.conceptId));
    // 같은 문서의 앞선 묶음(이전 사이클 포함)이 이미 저장한 개념 쌍 — 이 호출 *전* 상태. 이 호출
    // 안에서 같은 쌍에 관계가 여럿 나오는 것은 옛 동작대로 허용한다(한 호출이 본 같은 글의 결과).
    const existingPairs = listRelationPairsForDocument(deps.db, documentId);
    for (const rs of parsed.relationSummaries) {
      if (
        !validateRelationSummary(rs.fromConceptId, rs.toConceptId, allowedConceptIds, logPrefix)
      ) {
        summary.rejectedHallucinations += 1;
        continue;
      }
      if (existingPairs.has(relationPairKey(rs.fromConceptId, rs.toConceptId))) {
        summary.relationDuplicatesSkipped += 1;
        console.warn(
          `${logPrefix} 관계 중복 건너뜀 — 문서 ${JSON.stringify(documentId)} 에 이미 ${rs.fromConceptId}↔${rs.toConceptId} 관계요약이 있음.`,
        );
        continue;
      }
      // 요약 문장은 항상 저장(confidence·개념 id·source_document_id 동반 — 엣지 보류분도 /
      // plan 미세 모호 확정). source_document_id 가 문서 단위 관계 멱등의 단일 출처다.
      await deps.store.insertRelationSummary({
        summaryId: `rs_${crypto.randomUUID()}`,
        fromConceptId: rs.fromConceptId,
        toConceptId: rs.toConceptId,
        relationName: rs.relationName,
        summaryText: rs.summaryText,
        confidence: rs.confidence,
        generatedBy: GENERATED_BY_LLM,
        sourceDocumentId: documentId,
      });
      summary.relationSummariesCreated += 1;
      relationCreatedForDoc += 1;

      // confidence 임계 통과만 llm_relation 개념 엣지로 승격(concept_edges — graph-hop
      // 자동 합류는 Task 15 가 개념 채널로 정정). 기존 parent_of 동작 불변(relation 추가만).
      // spec 5.B-2 — relationAutoApply=false 면 엣지 자동 생성만 보류한다(관계요약 행은
      // 위에서 이미 저장 — 정리 자산 유지). 자동 그래프 변경은 opt-in 이 안전 기본값.
      // 관계 엣지용 별도 제안 kind 는 이 plan 범위 밖이라(cleanup_proposals KNOWN_KINDS
      // 에 relation 통로 없음), OFF 시 엣지는 보류하고 요약 행으로만 남긴다.
      const relationAutoApply = deps.relationAutoApply ?? true;
      if (
        relationAutoApply &&
        gateRelationEdge(rs.confidence, deps.relationConfidenceThreshold)
      ) {
        await deps.store.addConceptEdge({
          sourceConceptId: rs.fromConceptId,
          targetConceptId: rs.toConceptId,
          relation: "llm_relation",
          provenance: "llm_extract",
          sourceNodeId: null,
          weight: rs.confidence,
        });
        summary.edgesCreated += 1;
      } else if (
        !relationAutoApply &&
        gateRelationEdge(rs.confidence, deps.relationConfidenceThreshold)
      ) {
        // 임계는 넘겼으나 자동 반영 OFF — 엣지 보류를 정직하게 집계·로그(silent 아님).
        summary.edgesWithheld += 1;
      }
    }

    // ── relation_discovery(청크 묶음 단위) 원장 기록 — 관계 만들었으면 completed, 정상 회신인데
    //   관계 0(환각·중복 전건 탈락·빈 배열)이면 completed_noop. ──
    recordStageSuccess(deps.db, { ...relationLedgerKey, noop: relationCreatedForDoc === 0 });
  }

  // ── 3. emit — 새 엣지를 만든 사이클이면 정보성 알림(0건이면 안 함). ─────────
  if (summary.edgesCreated > 0) {
    deps.eventBus.emit(RELATIONS_DISCOVERED_EVENT, {
      count: summary.edgesCreated,
      relationSummaries: summary.relationSummariesCreated,
    });
  }

  logCycle(logPrefix, candidates.length, summary);
  return summary;
}

/**
 * dryRun 후보 검출(spec 5.B-1 / DCL-6 실측 도구). runSummaryCycle 의 LLM 경로 후보
 * 프롤로그(findChunkSummaryCandidates → 결과 원장 2차 제외 → 호출 묶음 나누기)를 그대로
 * 재사용해, 이번 사이클에 실제로 LLM 을 부를 후보(청크) 수를 세고 묶음별 프롬프트
 * (renderDocumentForPrompt)의 추정 입력 토큰 합을 낸다. LLM 은 절대 안 부른다.
 *
 * fallback(infer=null) 경로는 실행층을 안 타므로 dryRun 추정 대상이 아니다 — 여기서는
 * LLM 을 부르는 문서 단위 통합 호출만 추정한다(예산 실측 도구의 의도 정합).
 */
export function detectSummaryDryRun(deps: {
  db: Database;
  atomicThreshold: number;
  batchSize: number;
  stageVersion: number;
  /** 호출당 입력 상한 — 실제 사이클과 같은 묶음 나누기로 추정한다(상한 초과 청크는 호출 0 이라 뺀다). */
  perCallInputCap: number;
}): { candidatesFound: number; estimatedInputTokens: number } {
  const candidates = findChunkSummaryCandidates(
    deps.db,
    deps.atomicThreshold,
    deps.batchSize,
  );
  if (candidates.length === 0) {
    return { candidatesFound: 0, estimatedInputTokens: 0 };
  }
  const llmCandidates = filterCandidatesByLedger(
    deps.db,
    "summary",
    candidates.map((c) => ({
      ...c,
      targetKey: String(c.chunkId),
      inputFingerprint: summaryFingerprint({
        chunkContent: c.content,
        atomics: c.atomics,
      }),
      stageVersion: deps.stageVersion,
    })),
  );
  if (llmCandidates.length === 0) {
    return { candidatesFound: 0, estimatedInputTokens: 0 };
  }
  const { groups: callGroups } = planSummaryCallsForCap(
    llmCandidates,
    deps.db,
    deps.perCallInputCap,
  );
  let estimatedInputTokens = 0;
  for (const { documentId, chunks, relationConcepts } of callGroups) {
    estimatedInputTokens += estimateTextTokens(
      renderDocumentForPrompt(documentId, chunks, relationConcepts ?? []),
    );
  }
  return {
    candidatesFound: llmCandidates.length,
    estimatedInputTokens,
  };
}

// ── 요약 단계 가동 게이트(Task 7 wiring 이 단일 출처로 활용) ───────────────────

/** shouldRunSummaryStage 입력 — 요약 단계 가동 게이트 판단 재료. */
export interface SummaryStageGateInput {
  /** 첫 단계 슬롯 토글 — settings.llm.cleanup.enabled. */
  cleanupEnabled: boolean;
  /** cleanup LLM 클라이언트 구성 성공 여부(buildLlmClient 결과 !== null). */
  cleanupLlmAvailable: boolean;
  /** 깊은 패스 주기 — settings.llm.cleanup.intervalDays(하루 미만 금지). */
  intervalDays: number;
  /** 요약 단계 토글 — settings.cleanupDeepPass.summary.enabled(default OFF). */
  summaryEnabled: boolean;
}

/**
 * 요약 단계를 이번 사이클에 돌릴지 결정하는 순수 게이트. 첫 단계 정규식 강화와 *같은
 * 가동 슬롯*(llm.cleanup)을 상속한다 — 슬롯이 안 켜졌으면 둘째 단계도 안 돈다. 거기에
 * 요약 전용 토글(summary.enabled)을 AND 로 더한다(default OFF — 강한 모델 API 비용).
 *
 * 첫 단계 스케줄러 가동 조건(index.ts) 중 regexL0·regexStrengthen.enabled 는 *정규식
 * 강화 전용* 조건이라 요약 게이트에는 안 든다 — 정규식 강화를 꺼도(또는 regexL0 미가용)
 * 슬롯만 켜져 있으면 요약은 따로 돌 수 있다. 슬롯 공통 조건(enabled·LLM·intervalDays)만
 * 상속하고 단계 전용 토글을 각자 가진다.
 *
 * @returns 슬롯 3 조건 + summary.enabled 가 모두 참이면 true(요약 단계 가동).
 */
export function shouldRunSummaryStage(input: SummaryStageGateInput): boolean {
  return (
    input.cleanupEnabled &&
    input.cleanupLlmAvailable &&
    input.intervalDays >= 1 &&
    input.summaryEnabled
  );
}

// ── 내부 helper ──────────────────────────────────────────────────────────────

/**
 * 사이클·dryRun 이 같이 쓰는 호출 묶음 나누기 — 청크 수 상한(출력 한도) + 호출당 입력 상한. 청크 몫은
 * 그 청크 블록 + 그 청크에서 닿는 개념 줄로 잰다(묶음 개념 목록은 청크별 개념의 합집합이라 이 합을
 * 넘지 않는다). 개념 조회는 청크마다 한 번 더 들지만, 상한 판정이 실제 본문보다 작게 나오지 않게 한다.
 */
function planSummaryCallsForCap(
  candidates: readonly ChunkSummaryCandidate[],
  db: Database,
  perCallInputCap: number,
): SummaryCallPlan {
  return planSummaryCallsUnderCap(candidates, db, {
    maxChunksPerCall: SUMMARY_MAX_CHUNKS_PER_CALL,
    perCallInputCap,
    fixedOverheadTokens: summaryCallFixedOverheadTokens,
    chunkTokens: (c) => summaryChunkTokens(c, collectChunkSetConcepts(db, [c.chunkId])),
  });
}

/**
 * 첫 문단 fallback 청크요약 한 건을 저장한다(LLM 미가용 graceful). 첫 문단이 비어 있으면
 * (공백뿐 청크) 정직하게 건너뛴다 — 가짜 빈 문자열 요약을 만들지 않는다([[graceful-
 * degradation-principle-2026-05-22]]). 저장 시 generated_by='first_paragraph_fallback'.
 *
 * @returns 저장했으면 true, 첫 문단이 비어 건너뛰었으면 false.
 */
async function saveFallbackChunkSummary(
  deps: SummaryCycleDeps,
  cand: ChunkSummaryCandidate,
): Promise<boolean> {
  const firstParagraph = extractFirstParagraph(cand.content, deps.firstParagraphMaxChars);
  if (firstParagraph.length === 0) return false;
  await deps.store.insertChunkSummary({
    summaryId: `cs_${crypto.randomUUID()}`,
    parentChunkId: cand.chunkId,
    parentDocumentId: cand.parentId,
    summaryText: firstParagraph,
    generatedBy: GENERATED_BY_FALLBACK,
  });
  return true;
}

/**
 * 관계 발굴 원장 targetKey — 문서 id + 그 호출 청크 id 목록(오름차순). 관계 발굴 멱등이 청크 묶음
 * 단위라 원장 행도 묶음마다 하나다(옛 문서 id 단독 키는 같은 문서의 묶음끼리 덮어썼다).
 */
export function relationDiscoveryTargetKey(
  documentId: string,
  chunkIds: readonly number[],
): string {
  const ids = [...chunkIds].sort((a, b) => a - b);
  return `${documentId}${RELATION_TARGET_KEY_SEPARATOR}${ids.join(",")}`;
}

/** 사이클 결과를 한 줄 로그(0 산출이면 침묵 — 잡음 줄임). */
function logCycle(
  logPrefix: string,
  candidatesFound: number,
  s: SummaryCycleSummary,
): void {
  if (
    s.chunkSummariesCreated > 0 ||
    s.relationSummariesCreated > 0 ||
    s.rejectedHallucinations > 0 ||
    s.relationDuplicatesSkipped > 0 ||
    s.inferFailures > 0
  ) {
    // 엣지 보류(관계 자동 반영 OFF)·관계 중복은 있을 때만 덧붙여 표기(정직한 게이트 표시).
    const withheld = s.edgesWithheld > 0 ? `, 엣지보류 ${s.edgesWithheld}` : "";
    const duplicates =
      s.relationDuplicatesSkipped > 0 ? `, 관계중복 ${s.relationDuplicatesSkipped}` : "";
    console.log(
      `${logPrefix} cycle: 후보 ${candidatesFound} → 청크요약 +${s.chunkSummariesCreated}, 관계요약 +${s.relationSummariesCreated}, 엣지 +${s.edgesCreated}${withheld}${duplicates}, 환각버림 ${s.rejectedHallucinations}, LLM실패 ${s.inferFailures}`,
    );
  }
}

// ── 통합 LLM 호출 프롬프트 + infer fn — summary-infer-prompt.ts 로 옮겼다. 배선(run-cycle-runner)·
//    테스트가 이 모듈에서 가져가던 이름은 그대로 다시 내보낸다. ──
export { buildSummaryRunRequest, createSummaryInferFn } from "./summary-infer-prompt.ts";

// SummaryCallGroup 타입은 planSummaryCalls 회신 — 명시 import 로 묶음.
export type { SummaryCallGroup };
