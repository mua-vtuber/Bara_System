/**
 * lens-draft-batch.ts — 렌즈 소비 단계 한 microbatch 결정 처리 (spec 6.C-2).
 *
 * lens-draft-cycle.ts 에서 배치 처리(사전 필터 → 제안 insert → 커버리지 원장 기록)와 근거
 * 원문 조회·제안 insert 를 떼어낸 모듈(파일 크기 상한 정합). 사이클은 후보 검출·microbatch
 * 구성·실행층 호출을 맡고, 이 모듈은 한 배치 응답을 검증·기록으로 옮긴다.
 */

import type { Database } from "bun:sqlite";
import {
  LensApplyError,
  validateDraftShape,
  type LensApplyView,
  type LensDraftFingerprintGuard,
  type LensDraftValues,
} from "./lens-apply.ts";
import {
  recordStageDeterministicFailure,
  recordStageSuccess,
} from "./stage-results-ledger.ts";
import { LENS_DRAFT_KIND } from "./lens-draft-candidate-query.ts";
import type {
  LensDraftDecision,
  LensDraftEntityContext,
  LensDraftInferCycleSummary,
} from "./lens-draft-cycle.ts";

/** 한 대상의 원장 키. */
export interface LensDraftLedgerKey {
  stage: "lens_draft";
  targetKey: string;
  inputFingerprint: string;
  stageVersion: number;
}

/** processLensDraftBatch 인자. */
export interface ProcessBatchInput {
  db: Database;
  logPrefix: string;
  batch: LensDraftEntityContext[];
  decisions: LensDraftDecision[];
  batchKeys: Map<string, LensDraftLedgerKey>;
  lensByEntity: Map<string, LensApplyView>;
  guardByEntity: Map<string, LensDraftFingerprintGuard>;
  maxAttemptsPerTarget: number;
  summary: LensDraftInferCycleSummary;
}

/**
 * 한 microbatch 의 초안을 처리한다 — 사전 필터(validateDraftShape) → 제안 insert / 검증
 * 탈락 원장 → 엔티티 단위 커버리지 기록. 커버리지(spec 4.A-7)는 *이 배치 엔티티* 안에서만
 * 판정한다: 응답에 그 엔티티 결정이 있으면 커버됨, 통째 누락이면 원장 미기록(다음 사이클
 * 후보 잔존). 배치 밖 entityId(환각)는 무시한다.
 */
export function processLensDraftBatch(args: ProcessBatchInput): void {
  const {
    db,
    logPrefix,
    batch,
    decisions,
    batchKeys,
    lensByEntity,
    guardByEntity,
    maxAttemptsPerTarget,
    summary,
  } = args;

  const allowedEntityIds = new Set(batch.map((c) => c.entityId));
  // 커버됨 = 응답에 그 엔티티 결정이 하나라도 있는 엔티티.
  const coveredEntityIds = new Set<string>();
  // 제안을 낸 엔티티(검증 통과분 insert).
  const producedEntityIds = new Set<string>();
  // 검증 탈락만 받은 엔티티(사전 필터 전건 탈락 → 결정적 실패).
  const rejectedEntityIds = new Set<string>();

  for (const decision of decisions) {
    if (
      typeof decision.entityId !== "string" ||
      !allowedEntityIds.has(decision.entityId)
    ) {
      continue; // 배치 밖·환각 entityId 무시(커버 판정에 안 넣는다).
    }
    coveredEntityIds.add(decision.entityId);
    const lens = lensByEntity.get(decision.entityId);
    if (!lens) continue; // 방어(도달 불가 — 배치 안이면 map 에 있다).

    // ── 렌즈 초안 AI 는 relations·metadata 를 채우지 않는다(지시문: 항상 {}). 어기고 채워 와도
    //   그 두 칸만 버리고 columns·labels 는 살린다(엔티티 통째 거부는 유료 호출 낭비). 버린 수는
    //   요약에 세고 사이클 끝에 한 줄로 알린다. ──
    const stripped = stripLensDraftRelationsAndMetadata(decision.values);
    if (stripped.dropped) {
      summary.droppedRelationsMetadata += 1;
      decision.values = stripped.values;
    }

    // ── 생성 직후 적용 측 사전 필터(spec 6.C-2) — 렌즈 밖 키·person columns·관계값 모양·
    //   dataType 을 적용 전에 판정한다. 탈락은 completed_noop 이 아니라 결정적 실패로
    //   원장에 사유 기록 + loud(결함 초안을 조용히 삼키지 않는다). ──
    try {
      validateDraftShape(lens, decision.values);
    } catch (e) {
      if (e instanceof LensApplyError) {
        rejectedEntityIds.add(decision.entityId);
        summary.rejectedInvalid += 1;
        console.warn(
          `${logPrefix} 사전 필터 탈락 — entity ${decision.entityId}: ${e.message}`,
        );
        continue;
      }
      throw e;
    }

    // 채울 값이 하나도 없는 초안(빈 columns·labels·relations·metadata)은 산출 0 — 제안을
    // 만들지 않고 completed_noop 로 남긴다(정직한 무산출, 재과금 끊기).
    if (isEmptyDraft(decision.values)) {
      // producedEntityIds 에 안 넣음 → 아래 커버리지 기록에서 completed_noop.
      continue;
    }

    const guard = guardByEntity.get(decision.entityId);
    if (!guard) continue; // 방어(도달 불가 — 배치 안이면 map 에 있다).
    insertLensDraftProposal(db, decision, guard);
    producedEntityIds.add(decision.entityId);
    summary.proposalsInserted += 1;
  }

  // ── 엔티티 단위 커버리지 원장 기록 ──
  //   제안 산출 → completed / 커버됐으나 검증 탈락만 → 결정적 실패(attempt++) /
  //   커버됐고 검증은 통과했으나 채울 값 0 → completed_noop / 통째 누락 → 원장 미기록.
  for (const [entityId, key] of batchKeys) {
    if (!coveredEntityIds.has(entityId)) {
      summary.coverageMisses += 1;
      continue;
    }
    if (producedEntityIds.has(entityId)) {
      recordStageSuccess(db, { ...key, noop: false });
      summary.completed += 1;
    } else if (rejectedEntityIds.has(entityId)) {
      recordStageDeterministicFailure(db, {
        ...key,
        maxAttemptsPerTarget,
        lastError: "lens_draft 초안 사전 필터 전건 탈락(렌즈 밖 키·형식·관계 모양)",
      });
    } else {
      // 커버됐고 검증도 통과했으나 채울 값 0(빈 초안) — 정직한 무산출.
      recordStageSuccess(db, { ...key, noop: true });
      summary.completedNoop += 1;
    }
  }
}

/**
 * 렌즈 초안 AI 출력에서 relations·metadata 를 비운다(순수 함수). 둘 중 하나라도 비어 있지
 * 않았으면 dropped=true. 내부 사이클과 외부 AI 제출 경로가 같은 규칙을 쓰도록 공유한다.
 * 다른 출처 제안(승인 시 적용 경로)의 relations·metadata 처리에는 관여하지 않는다.
 */
export function stripLensDraftRelationsAndMetadata(values: LensDraftValues): {
  values: LensDraftValues;
  dropped: boolean;
} {
  const dropped =
    (values.relations !== undefined && Object.keys(values.relations).length > 0) ||
    (values.metadata !== undefined && Object.keys(values.metadata).length > 0);
  return { values: { ...values, relations: {}, metadata: {} }, dropped };
}

/** 초안에 채울 값이 하나도 없으면 true(빈 columns·labels·relations·metadata). */
function isEmptyDraft(values: LensDraftValues): boolean {
  return (
    Object.keys(values.columns).length === 0 &&
    Object.keys(values.labels).length === 0 &&
    Object.keys(values.relations).length === 0 &&
    Object.keys(values.metadata).length === 0
  );
}

/**
 * 근거 노드 id 목록의 원문을 읽는다(knowledge_nodes.content). 삭제·부재 노드는 뺀다
 * (거짓 근거 0). 순서는 id 정렬(입력 순서 보존 — fingerprint 와 짝).
 */
export function readEvidenceContents(
  db: Database,
  nodeIds: readonly number[],
): Array<{ nodeId: number; content: string }> {
  const out: Array<{ nodeId: number; content: string }> = [];
  for (const nodeId of nodeIds) {
    const row = db
      .prepare("SELECT content FROM knowledge_nodes WHERE id = ?")
      .get(nodeId) as { content: string } | null;
    if (row) out.push({ nodeId, content: row.content });
  }
  return out;
}

/**
 * lens_draft 제안을 insert 한다. payload 는 approve 경로(cleanup-proposals.ts)가 공유 적용
 * 함수 applyLensDraft 를 부르는 데 필요한 전부를 담는다 — typeName·entityId·values +
 * fingerprint guard(초안 시점 fingerprint·렌즈 직렬화·근거 노드). approve 가 이 guard 로
 * 승인 시점 엔티티 현재 값과 재대조해 어긋나면 적용을 거부한다(오래된 초안 방어).
 */
function insertLensDraftProposal(
  db: Database,
  decision: LensDraftDecision,
  guard: LensDraftFingerprintGuard,
): void {
  const payload = {
    typeName: decision.typeName,
    entityId: decision.entityId,
    values: decision.values,
    // 오래된 초안 방어 seam — approve 가 applyLensDraft 에 그대로 넘긴다.
    fingerprintGuard: {
      expectedFingerprint: guard.expectedFingerprint,
      lensSerialization: guard.lensSerialization,
      evidenceNodeIds: guard.evidenceNodeIds,
    },
  };
  db.prepare(
    "INSERT INTO cleanup_proposals (id, kind, payload_json) VALUES (?, ?, ?)",
  ).run(`cp_${crypto.randomUUID()}`, LENS_DRAFT_KIND, JSON.stringify(payload));
}
