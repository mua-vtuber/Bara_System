/**
 * lens-draft-candidate-query.ts — 렌즈 소비 단계 후보 검출 (spec 6.C-2 단계 설계).
 *
 * 후보 = 렌즈가 정의된 종류의 *기존 엔티티* 중 구조화 칸(렌즈 columns)이 하나라도 빈 것.
 * 렌즈는 종류별로 채울 수 있는 칸을 광고하고(buildEntityLens), 그 칸이 아직 비어 있는
 * 엔티티만 정리 AI 가 채울 여지가 있다. 이 모듈은 종류별 엔티티를 훑어 그 후보를 모으고,
 * 각 후보에 대해:
 *   - 현재 구조화 값 직렬화(serializeEntityStructuredValue) — fingerprint 입력 1.
 *   - 렌즈 직렬화(serializeLens) — fingerprint 입력 2(렌즈가 바뀌면 재평가).
 *   - 근거 노드 id 목록(엔티티 라벨·관계 엣지의 source_node_id) — fingerprint 입력 3 +
 *     LLM 프롬프트에 실을 근거 원문의 출처.
 * 세 입력으로 lensDraftFingerprint 를 산출한다(spec 4.A-3 표 lens_draft 행).
 *
 * 두 겹 멱등(spec 6.C-2):
 *   1. kind=lens_draft 제안이 이미 있는 엔티티 제외(SQL 1차 거름 — payload_json 의
 *      entityId·typeName 매칭). 사용자가 아직 승인/거절 안 한 초안을 다시 만들지 않는다.
 *   2. 결과 원장 2차 거름(filterCandidatesByLedger) — 이미 처리된(완료·무산출·terminal·
 *      재시도 대기) 엔티티 제외. fingerprint·stage_version 이 같으면 재과금하지 않고,
 *      엔티티·렌즈·근거가 바뀌면 fingerprint 가 달라져 자연 재평가된다.
 *
 * 이 모듈은 LLM 을 부르지 않는다(순수 조회 + 직렬화). 사이클(lens-draft-cycle.ts)과
 * dryRun 이 같은 후보 프롤로그를 공유한다.
 */

import type { Database } from "bun:sqlite";
import { buildEntityLens, type EntityLens } from "./entity-lens.ts";
import { placementTypeNames } from "../concept-type-vocabulary.ts";
import {
  serializeEntityStructuredValue,
  type LensApplyView,
  type LensStoreDeps,
} from "./lens-apply.ts";
import { lensDraftFingerprint } from "./stage-fingerprint.ts";
import { filterCandidatesByLedger } from "./stage-results-ledger.ts";

export const LENS_DRAFT_KIND = "lens_draft";

/**
 * 원장 target_key·pending 제안 키·렌즈 직렬화 필드 경계 구분자(U+001F Unit Separator).
 * typeName 과 entityId 를 이 문자로 끊어 "material"+"mat_x" 와 "materialm"+"at_x" 같은
 * 우연한 결합 충돌을 막는다(stage-fingerprint.ts FIELD_SEP 선례). 코드에 보이지 않는
 * 제어문자를 리터럴로 두지 않으려고 명시 상수로 둔다.
 */
const KEY_SEP = String.fromCharCode(0x1f);

/** (typeName, entityId) 를 원장/제안 대조용 단일 키로 만든다(구분자로 충돌 차단). */
export function entityTargetKey(typeName: string, entityId: string): string {
  return `${typeName}${KEY_SEP}${entityId}`;
}

/**
 * 원장 targetKey 를 (typeName, entityId) 로 되돌린다 — KEY_SEP 미포함·2분할 실패 시 null.
 * 외부 표면(candidates.ts recomputeExternalFingerprint lensDraft 갈래)이 targetKey 로
 * 대상 엔티티를 되찾을 때 쓴다. entityTargetKey 의 역함수(같은 KEY_SEP 단일 출처).
 */
export function parseEntityTargetKey(
  targetKey: string,
): { typeName: string; entityId: string } | null {
  const idx = targetKey.indexOf(KEY_SEP);
  if (idx <= 0 || idx === targetKey.length - 1) return null;
  return { typeName: targetKey.slice(0, idx), entityId: targetKey.slice(idx + 1) };
}

/** 한 후보 엔티티 — 렌즈 초안을 만들 수 있는 빈 칸 엔티티. */
export interface LensDraftCandidate {
  typeName: string;
  entityId: string;
  /** 표시 이름(프롬프트 라벨). */
  name: string;
  /** 아직 비어 있는 렌즈 column key 목록(채울 여지가 있는 칸). */
  emptyColumnKeys: string[];
  /** 현재 채워진 칸 값(key→value, is_column=1) — 프롬프트에 현 상태를 싣는다. */
  filledColumns: Record<string, string>;
  /** 근거 노드 id 목록(엔티티 엣지 source_node_id, 정렬·중복 제거). */
  evidenceNodeIds: number[];
  /** 적용 검증에 넘길 렌즈 뷰(applyLensDraft 계약). */
  lens: LensApplyView;
  /** 원장 대조 키. */
  targetKey: string;
  inputFingerprint: string;
  stageVersion: number;
}

/** buildEntityLens 산출을 적용 함수용 LensApplyView 로 좁힌다(route toApplyView 와 동형). */
export function lensToApplyView(lens: EntityLens): LensApplyView {
  return {
    typeName: lens.typeName,
    columns: lens.columns.map((c) => ({ key: c.key, dataType: c.dataType })),
    attributeKeys: lens.attributes.map((a) => a.key),
    relations: lens.relations.map((r) => ({
      key: r.key,
      relation: r.relation,
      targetTypes: r.targetTypes,
      defaultTargetType: r.defaultTargetType,
    })),
    metadataKeys: lens.metadataFields.map((m) => m.key),
  };
}

/**
 * 렌즈를 결정적 문자열로 직렬화한다(fingerprint 입력 2). 렌즈 계약(columns·attributes·
 * relations·metadata 키 + column dataType)을 정렬해 이어붙인다 — 렌즈 정의가 바뀌면
 * (칸 추가·dataType 변경 등) 이 직렬화가 달라져 그 종류의 후보가 자연 재평가된다.
 */
export function serializeLens(lens: LensApplyView): string {
  const cols = lens.columns
    .map((c) => `${c.key}:${c.dataType}`)
    .sort()
    .join(",");
  const attrs = [...lens.attributeKeys].sort().join(",");
  const rels = lens.relations
    .map((r) => `${r.key}:${r.relation}:${[...r.targetTypes].sort().join("|")}`)
    .sort()
    .join(",");
  const meta = [...lens.metadataKeys].sort().join(",");
  return `${lens.typeName}${KEY_SEP}cols=${cols}${KEY_SEP}attrs=${attrs}${KEY_SEP}rels=${rels}${KEY_SEP}meta=${meta}`;
}

/**
 * 한 엔티티의 근거 노드 id 목록 — 라벨(entity_concept_edges) + 관계(entity_relation_edges)
 * 엣지의 source_node_id. 그 엔티티의 구조화를 낳은 원문 노드들이다. NULL source_node_id 는
 * 뺀다(근거 없는 엣지). 정렬·중복 제거로 결정적 순서(fingerprint 안정).
 */
export function listEvidenceNodeIds(db: Database, entityId: string): number[] {
  const rows = db
    .prepare(
      `SELECT source_node_id FROM entity_concept_edges
        WHERE entity_id = ? AND source_node_id IS NOT NULL
       UNION
       SELECT source_node_id FROM entity_relation_edges
        WHERE (source_id = ? OR target_id = ?) AND source_node_id IS NOT NULL`,
    )
    .all(entityId, entityId, entityId) as Array<{ source_node_id: number }>;
  const ids = new Set<number>();
  for (const r of rows) ids.add(r.source_node_id);
  return [...ids].sort((a, b) => a - b);
}

/** 이미 pending lens_draft 제안이 있는 (typeName, entityId) 집합을 읽는다(1차 멱등). */
function pendingProposalKeys(db: Database): Set<string> {
  const rows = db
    .prepare(
      `SELECT payload_json FROM cleanup_proposals
        WHERE kind = ? AND status = 'pending'`,
    )
    .all(LENS_DRAFT_KIND) as Array<{ payload_json: string }>;
  const set = new Set<string>();
  for (const r of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.payload_json);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const p = parsed as Record<string, unknown>;
    if (typeof p.typeName === "string" && typeof p.entityId === "string") {
      set.add(entityTargetKey(p.typeName, p.entityId));
    }
  }
  return set;
}

/** detectLensDraftCandidates 입력. store 만 있으면 되므로 좁힌 deps 를 받는다. */
export interface DetectLensDraftCandidatesArgs {
  deps: LensStoreDeps;
  batchSize: number;
  stageVersion: number;
}

/**
 * 렌즈 소비 단계 후보를 검출한다(순수 조회 + 직렬화, LLM 미호출). 종류별로 엔티티를 훑어
 * 렌즈 column 중 빈 칸이 하나라도 있는 엔티티를 모으고, pending 제안 1차 멱등 + 결과 원장
 * 2차 멱등을 건 뒤, batchSize 개까지 회신한다. person 렌즈는 columns 를 광고하지 않으므로
 * (buildEntityLens) 자연히 후보가 안 나온다.
 */
export async function detectLensDraftCandidates(
  args: DetectLensDraftCandidatesArgs,
): Promise<LensDraftCandidate[]> {
  const { deps, batchSize, stageVersion } = args;
  const db = deps.store.getRawDb();
  const pending = pendingProposalKeys(db);

  const withFp: LensDraftCandidate[] = [];
  for (const typeName of placementTypeNames()) {
    const lens = lensToApplyView(buildEntityLens(typeName as string));
    // 렌즈가 채울 칸을 광고하지 않는 종류(person 등)는 후보 대상이 아니다.
    if (lens.columns.length === 0) continue;
    const lensSerialization = serializeLens(lens);
    const columnKeys = lens.columns.map((c) => c.key);

    const entities = await deps.store.entitiesRepo.list(typeName as string, {
      limit: 5000,
    });
    for (const entity of entities) {
      if (pending.has(entityTargetKey(typeName as string, entity.id))) continue;

      const filledColumns = readEntityColumns(db, entity.id);
      const emptyColumnKeys = columnKeys.filter((key) => {
        const value = filledColumns[key];
        return value === undefined || value.trim().length === 0;
      });
      // 빈 칸이 하나도 없으면 채울 여지가 없다(후보 아님).
      if (emptyColumnKeys.length === 0) continue;

      const evidenceNodeIds = listEvidenceNodeIds(db, entity.id);
      const inputFingerprint = lensDraftFingerprint({
        entityStructuredValue: serializeEntityStructuredValue(deps, entity.id),
        lensSerialization,
        evidenceNodeIds,
      });
      withFp.push({
        typeName: typeName as string,
        entityId: entity.id,
        name: entity.name,
        emptyColumnKeys,
        filledColumns,
        evidenceNodeIds,
        lens,
        targetKey: entityTargetKey(typeName as string, entity.id),
        inputFingerprint,
        stageVersion,
      });
    }
  }

  // 결과 원장 2차 멱등(spec 4.A-3 이중 안전벨트) — 처리 완료·무산출·terminal·재시도 대기
  // 엔티티를 뺀다. fingerprint 변화·stageVersion 상승만 재평가로 통과.
  const kept = filterCandidatesByLedger(db, "lens_draft", withFp);
  return kept.slice(0, batchSize);
}

/** 한 엔티티의 칸(is_column=1) 값을 key→value map 으로 읽는다. */
function readEntityColumns(db: Database, entityId: string): Record<string, string> {
  const rows = db
    .prepare(
      `SELECT attr_key, attr_value FROM entity_attributes
        WHERE entity_id = ? AND is_column = 1`,
    )
    .all(entityId) as Array<{ attr_key: string; attr_value: string }>;
  const out: Record<string, string> = {};
  for (const r of rows) out[r.attr_key] = r.attr_value;
  return out;
}
