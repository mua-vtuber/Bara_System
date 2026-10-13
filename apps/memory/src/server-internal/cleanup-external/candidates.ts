/**
 * cleanup-external/candidates.ts — 정리 외부 표면 후보 조회 + 지문 재계산 (spec 6.1).
 *
 * REST 3표면(후보 조회·제안 등록·무산출 신고)과 MCP 도구가 공유하는 서비스층. 내부 정리
 * 사이클이 LLM 을 부르기 직전까지 쓰는 순수 후보 검출 함수를 그대로 재사용해, 같은 후보를
 * 외부(다른 PC·폰의 강모델)에 노출한다 — 검출·지문·원장 판정을 여기서 재구현하지 않고
 * 기존 함수를 호출만 한다(단일 출처 보존).
 *
 * content 칸 계약(spec 6.1)은 각 검출 함수의 기존 산출을 그대로 직렬화한다(재료 축소·가공
 * 금지):
 *   - regexStrengthen: { id, content, atomics }  (MissedCandidate 그대로)
 *                      + 응답 top-level shared { instruction }(서버 원본 지시문, 후보 하나용 "single" 모양)
 *   - personLink:      { nodeId, content, personCandidates, existingPersonIds, topKPersonIds }
 *                      + 응답 top-level shared { people }(사람 명단을 후보마다 반복하지 않고 한 번 동봉)
 *   - lensDraft:       { typeName, entityId, name, emptyColumnKeys, filledColumns,
 *                        evidenceNodeIds, lens }  (LensDraftCandidate 에서 원장 키 3열쇠를 분리)
 *   - entityRegister:  { nodeId, content, createdAt, alreadyLinked, allowedTypes }
 *                      + 응답 top-level shared { instruction }(서버 원본 지시문, 메모 하나용)
 *
 * nodeIds 는 메모 단위 단계(personLink·entityRegister)에서만 받는다. 다른 단계에 주면 무시하지 않고
 * CleanupExternalInputError 로 멈춘다(라우트 400, MCP INVALID_INPUT).
 *
 * 원장 필터는 각 검출 함수 안에서 이미 적용된다(collectPersonLinkCandidates·
 * detectLensDraftCandidates). regexStrengthen 만 findRegexMissedCandidates 가 원장 미적용이라
 * 여기서 probe → filterCandidatesByLedger 를 명시로 건다.
 */

import type { MemoryApiDeps } from "../types.ts";
import type { ExternalCandidateStage } from "./stage-map.ts";
import { externalStageContractOf } from "./stage-map.ts";
import { findRegexMissedCandidates } from "../../memory/cleanup-deep-pass/candidate-query.ts";
import {
  regexFingerprint,
  personLinkFingerprint,
  lensDraftFingerprint,
  entityRegisterFingerprint,
} from "../../memory/cleanup-deep-pass/stage-fingerprint.ts";
import { filterCandidatesByLedger } from "../../memory/cleanup-deep-pass/stage-results-ledger.ts";
import {
  detectLensDraftCandidates,
  serializeLens,
  lensToApplyView,
  listEvidenceNodeIds,
  parseEntityTargetKey,
} from "../../memory/cleanup-deep-pass/lens-draft-candidate-query.ts";
import { serializeEntityStructuredValue } from "../../memory/cleanup-deep-pass/lens-apply.ts";
import { buildEntityLens } from "../../memory/cleanup-deep-pass/entity-lens.ts";
import { prefilterPersonCandidates } from "../../memory/person-link-prefilter.ts";
import { isPlacementType } from "../../memory/concept-type-vocabulary.ts";
import { CLEANUP_STAGE_LLM_LIMITS } from "../../memory/cleanup-deep-pass/stage-constants.ts";
import {
  collectEntityRegisterCandidates,
  readOriginalMemo,
} from "../../memory/cleanup-deep-pass/entity-register/candidate-query.ts";
import {
  ENTITY_REGISTER_EXTERNAL_STAGE,
  entityRegisterTypeNames,
} from "../../memory/cleanup-deep-pass/entity-register/constants.ts";
import { buildEntityRegisterInstruction } from "../../memory/cleanup-deep-pass/entity-register/prompt.ts";
import { buildRegexStrengthenInstruction } from "../../memory/cleanup-deep-pass/regex-strengthen-cycle.ts";
import {
  collectPersonLinkCandidates,
  loadPeople,
  readPersonCandidates,
  PERSON_LINK_PREFILTER_TOP_K,
} from "../../memory/person-link-candidate-query.ts";

/**
 * 의존 부재(정직한 비활성) — 라우트가 503 + 이 메시지(누락 식별자 포함)로 매핑한다.
 * silent fallback(빈 목록으로 위장) 금지 — 어느 설정이 꺼져 후보를 낼 수 없는지 드러낸다.
 */
export class CleanupExternalDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleanupExternalDisabledError";
  }
}

/**
 * 호출자 입력 오류(정직한 거부) — 라우트가 400, MCP 가 INVALID_INPUT 으로 옮긴다. 메모 단위가 아닌 단계에
 * nodeIds 를 준 경우처럼, 무시하면 호출자가 "그 메모만 받았다"고 오해하는 입력을 막는다.
 */
export class CleanupExternalInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleanupExternalInputError";
  }
}

/** 한 번에 받는 nodeIds 최대 개수 — REST 쿼리와 MCP 입력 스키마가 같이 쓴다. */
export const EXTERNAL_NODE_IDS_MAX = 100;

/** nodeIds 를 받는 메모 단위 단계. */
const MEMO_SCOPED_STAGES: ReadonlySet<ExternalCandidateStage> = new Set<ExternalCandidateStage>([
  "personLink",
  ENTITY_REGISTER_EXTERNAL_STAGE,
]);

/** 한 외부 후보 — 원장 키 3열쇠 + content(검출 함수 산출 그대로). */
export interface ExternalCandidate {
  targetKey: string;
  inputFingerprint: string;
  stageVersion: number;
  content: Record<string, unknown>;
}

/** 외부 후보 목록 회신 — personLink 는 shared { people }, entityRegister·regexStrengthen 은 shared { instruction } 를 동봉한다. */
export interface ExternalCandidateList {
  stage: ExternalCandidateStage;
  stageVersion: number;
  count: number;
  candidates: ExternalCandidate[];
  /** personLink — 사람 명단 { people }, entityRegister·regexStrengthen — 지시문 { instruction }(후보마다 반복하지 않고 한 번 동봉). */
  shared?: Record<string, unknown>;
}

/**
 * 한 stage 의 후보를 원장 필터 적용 후 회신한다(spec 6.1). completed/noop/terminal 제외,
 * retryable 은 next_retry_at 경과 시 포함. regexStrengthen 은 deps.regexL0 미주입 시
 * CleanupExternalDisabledError(누락 식별자 포함) — 라우트가 503 으로 옮긴다. nodeIds 를 주면 그 메모만 본다
 * (메모 단위 단계 한정 — 그 밖의 단계는 CleanupExternalInputError).
 */
export async function listExternalCandidates(
  deps: MemoryApiDeps,
  stage: ExternalCandidateStage,
  limit: number,
  nodeIds?: readonly number[],
): Promise<ExternalCandidateList> {
  const contract = externalStageContractOf(stage)!;
  const stageVersion = contract.stageVersion;
  const db = deps.store.getRawDb();
  if (nodeIds !== undefined && !MEMO_SCOPED_STAGES.has(stage)) {
    throw new CleanupExternalInputError(
      `nodeIds 는 ${[...MEMO_SCOPED_STAGES].join("·")} 단계에서만 쓸 수 있음 (받은 stage: ${stage})`,
    );
  }
  // nodeIds 를 주면 그 메모를 모두 본다 — limit 이 더 작아 일부를 조용히 잘라 내지 않는다.
  const effectiveLimit = nodeIds !== undefined ? Math.max(limit, nodeIds.length) : limit;

  if (stage === ENTITY_REGISTER_EXTERNAL_STAGE) {
    // 원장 필터는 collectEntityRegisterCandidates 안에서 이미 적용된다.
    const allowedTypes = entityRegisterTypeNames();
    const rows = collectEntityRegisterCandidates({ db, stageVersion, limit: effectiveLimit, ...(nodeIds ? { nodeIds } : {}) });
    const candidates: ExternalCandidate[] = rows.map((r) => ({
      targetKey: r.targetKey,
      inputFingerprint: r.inputFingerprint,
      stageVersion,
      content: { nodeId: r.nodeId, content: r.content, createdAt: r.createdAt, alreadyLinked: r.alreadyLinked, allowedTypes },
    }));
    return {
      stage,
      stageVersion,
      count: candidates.length,
      candidates,
      shared: { instruction: buildEntityRegisterInstruction(allowedTypes, "single") },
    };
  }

  if (stage === "regexStrengthen") {
    if (!deps.regexL0) {
      throw new CleanupExternalDisabledError(
        "정리 후보 조회 비활성 — regexL0 미주입 (settings.extractor.regex.enabled=false)",
      );
    }
    const missed = findRegexMissedCandidates(db, deps.regexL0, limit);
    const probes = missed.map((m) => ({
      targetKey: String(m.id),
      inputFingerprint: regexFingerprint({ content: m.content }),
      stageVersion,
      candidate: m,
    }));
    const kept = filterCandidatesByLedger(db, "regex_strengthen", probes);
    const candidates: ExternalCandidate[] = kept.map((p) => ({
      targetKey: p.targetKey,
      inputFingerprint: p.inputFingerprint,
      stageVersion,
      content: {
        id: p.candidate.id,
        content: p.candidate.content,
        atomics: p.candidate.atomics,
      },
    }));
    return {
      stage,
      stageVersion,
      count: candidates.length,
      candidates,
      shared: { instruction: buildRegexStrengthenInstruction("single") },
    };
  }

  if (stage === "personLink") {
    // 원장 필터는 collectPersonLinkCandidates 안에서 이미 적용된다(personLimit 200 default 유지).
    const { people, rows } = await collectPersonLinkCandidates({
      db,
      store: deps.store,
      batchSize: effectiveLimit,
      stageVersion,
      ...(nodeIds ? { nodeIds } : {}),
    });
    const candidates: ExternalCandidate[] = rows.map((r) => ({
      targetKey: r.targetKey,
      inputFingerprint: r.inputFingerprint,
      stageVersion,
      content: {
        nodeId: r.id,
        content: r.content,
        personCandidates: r.personCandidates,
        existingPersonIds: r.existingPersonIds,
        topKPersonIds: r.topKPersonIds,
      },
    }));
    return {
      stage,
      stageVersion,
      count: candidates.length,
      candidates,
      shared: { people },
    };
  }

  // lensDraft — 원장 필터는 detectLensDraftCandidates 안에서 이미 적용된다.
  const drafts = await detectLensDraftCandidates({
    deps: { store: deps.store },
    batchSize: limit,
    stageVersion,
  });
  const candidates: ExternalCandidate[] = drafts.map((d) => ({
    targetKey: d.targetKey,
    inputFingerprint: d.inputFingerprint,
    stageVersion,
    content: {
      typeName: d.typeName,
      entityId: d.entityId,
      name: d.name,
      emptyColumnKeys: d.emptyColumnKeys,
      filledColumns: d.filledColumns,
      evidenceNodeIds: d.evidenceNodeIds,
      lens: d.lens,
    },
  }));
  return { stage, stageVersion, count: candidates.length, candidates };
}

/**
 * 현행 재료로 지문을 재계산한다(등록·무산출 신고의 409 대조 재료 / spec 6.2·6.3). 대상이
 * 사라졌으면 null — 호출부가 404 로 매핑한다. 검출 함수와 같은 지문 산출식을 쓴다(단일
 * 출처): 대상이 바뀌면 재계산 지문이 달라져 stale 등록을 409 로 거른다.
 */
export async function recomputeExternalFingerprint(
  deps: MemoryApiDeps,
  stage: ExternalCandidateStage,
  targetKey: string,
): Promise<string | null> {
  const db = deps.store.getRawDb();

  if (stage === ENTITY_REGISTER_EXTERNAL_STAGE) {
    const nodeId = Number(targetKey);
    if (!Number.isInteger(nodeId)) return null;
    const memo = readOriginalMemo(db, nodeId);
    return memo ? entityRegisterFingerprint(memo) : null;
  }

  if (stage === "regexStrengthen") {
    const nodeId = Number(targetKey);
    if (!Number.isInteger(nodeId)) return null;
    const row = db
      .prepare("SELECT content FROM knowledge_nodes WHERE id = ?")
      .get(nodeId) as { content: string } | null;
    if (!row) return null;
    return regexFingerprint({ content: row.content });
  }

  if (stage === "personLink") {
    const nodeId = Number(targetKey);
    if (!Number.isInteger(nodeId)) return null;
    const row = db
      .prepare("SELECT content, metadata_json FROM knowledge_nodes WHERE id = ?")
      .get(nodeId) as { content: string; metadata_json: string } | null;
    if (!row) return null;
    const people = await loadPeople(deps.store, 200);
    const personCandidates = readPersonCandidates(row.metadata_json);
    const prefilterPeople = people.map((p) => ({
      personId: p.personId,
      displayName: p.displayName,
      aliases: p.aliases,
      labels: p.attributes.map((a) => a.name),
    }));
    const topKByNode = prefilterPersonCandidates(
      [{ id: nodeId, content: row.content, personCandidates }],
      prefilterPeople,
      PERSON_LINK_PREFILTER_TOP_K,
    );
    return personLinkFingerprint({
      content: row.content,
      personCandidates,
      topKPersonIds: topKByNode.get(nodeId) ?? [],
    });
  }

  // lensDraft — targetKey 를 (typeName, entityId) 로 되돌려 현행 구조화 값·렌즈·근거로 재계산.
  const parsed = parseEntityTargetKey(targetKey);
  if (!parsed) return null;
  if (!isPlacementType(parsed.typeName)) return null;
  // 대상 엔티티 존재 확인 — regexStrengthen·personLink 갈래와 같은 계약(대상 부재 → null →
  // 호출부가 404 로 매핑, spec 6.2). parseEntityTargetKey·isPlacementType 통과만으로는
  // entityId 가 실존하는 엔티티를 가리키는지 보증하지 못한다(삭제된 엔티티의 stale 재제출이
  // "빈 엔티티" 지문으로 정상 계산되는 결함 차단).
  const entityRow = db
    .prepare("SELECT 1 AS hit FROM entities WHERE entity_id = ? LIMIT 1")
    .get(parsed.entityId) as { hit: number } | null;
  if (!entityRow) return null;
  const lens = lensToApplyView(buildEntityLens(parsed.typeName));
  return lensDraftFingerprint({
    entityStructuredValue: serializeEntityStructuredValue(
      { store: deps.store },
      parsed.entityId,
    ),
    lensSerialization: serializeLens(lens),
    evidenceNodeIds: listEvidenceNodeIds(db, parsed.entityId),
  });
}
