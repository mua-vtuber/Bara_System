/**
 * cleanup-deep-pass/lens-apply.ts — 렌즈 초안 적용 공유 함수 (spec 6.C-2 선행 정비).
 *
 * `routes/entity-lenses.ts` 의 HTTP 적용 경로와 미래의 lens_draft 단계(C-2b)가 같은
 * 의미론으로 초안을 적용하도록 조립·검증·적용 로직을 여기 한 곳에 모은다. route 는 이
 * 함수의 HTTP 표면일 뿐이고, 정리 AI 사이클은 HTTP 자기호출 없이 이 함수를 직접 부른다
 * (spec 결정 #7 — 자기 HTTP 는 인증·오류 이중화만 낳는다). 검증·해소(트랜잭션 앞 단계)는
 * lens-apply-plan.ts 로 분리했다(파일 크기 경계) — 여기는 fingerprint 재대조 + 단일
 * 트랜잭션 쓰기 + metadata 적용 오케스트레이션만 맡는다.
 *
 * 리뷰 검증 결함 6종의 처방(spec 6.C-2 선행 정비):
 *   1. 전 검증 후 단일 트랜잭션 — 엔티티 구조화 쓰기(columns·labels·relations)를 먼저
 *      전부 검증·해소(buildWritePlan)한 뒤, 실제 쓰기를 하나의 db.transaction() 으로 묶어
 *      어느 하나라도 실패하면 전부 롤백한다. 옛 순차 await(entity-lenses.ts:154-176)의 부분
 *      실패 잔류 제거.
 *   2. AI 경로는 기존 entityId 필수 — aiPath=true 면 새 엔티티(project·범용) 생성을 금지하고
 *      기존 id 만 받는다(사람 등록 금지 불변식과 같은 급). HTTP 경로(aiPath=false)는 route 가
 *      엔티티를 먼저 해소한 뒤 넘겨 옛 findOrCreate 동작을 보존한다.
 *   3. fill-only 기본 — 비어 있는 칸만 채운다. overwrite 초안은 overwriteColumns 로만 덮는다.
 *   4. person columns 계약 정합 — 렌즈가 광고하지 않는 칸은 여기서도 안 받는다.
 *   5. dataType 검증 — 렌즈 columns[].dataType(date/number/text)에 맞는 형식만 통과.
 *   6. 오래된 초안 방어 — 초안 시점 fingerprint 를 받아 적용 직전 엔티티 현재 값으로 재산출해
 *      대조한다. 어긋나면 적용 거부(제안 생성과 승인 사이 엔티티·렌즈 변경 경합 방어).
 *
 * 트랜잭션 경계 주의(설계 사실): bun:sqlite 의 db.transaction() 콜백은 반드시 *동기* 다.
 * findOrCreateTagConcept(임베딩)·setPlace(장소 엔티티 생성 + 임베딩)·setEventAt/Until 은
 * async 라 트랜잭션 콜백 안에서 부를 수 없다. 그래서:
 *   - label 개념 id 해소(findOrCreateTagConcept)는 buildWritePlan 이 트랜잭션 *앞* 에서
 *     끝내 동기 엣지 쓰기만 트랜잭션에 넣는다(concept-repo-crud-mixin:38 "await embed 는
 *     트랜잭션 밖에서" 선례 그대로).
 *   - metadata(setPlace·setEventAt·setEventUntil)는 근거 노드(sourceNodeId)의 metadata 를
 *     자체 출처 우선순위 가드로 갱신하는 async·임베딩 경로다. 엔티티 구조화 트랜잭션과 다른
 *     대상이라 트랜잭션 *뒤* 에 적용한다 — 구조화 쓰기가 롤백되면 metadata 는 아예 시작하지
 *     않는다(엔티티 실패가 근거 노드 metadata 를 남기지 않는다).
 */

import type { PlacementTypeName } from "../concept-type-vocabulary.ts";
import { lensDraftFingerprint } from "./stage-fingerprint.ts";
import {
  assertExistingSourceEntity,
  buildWritePlan,
  LensApplyError,
  serializeEntityStructuredValue,
  stringifyScalar,
  type LensApplyView,
  type LensDraftValues,
  type LensStoreDeps,
} from "./lens-apply-plan.ts";

export {
  LensApplyError,
  serializeEntityStructuredValue,
  validateColumnDataType,
  validateDraftShape,
} from "./lens-apply-plan.ts";
export type {
  LensApplyColumn,
  LensApplyRelation,
  LensApplyView,
  LensDraftValues,
  LensStoreDeps,
} from "./lens-apply-plan.ts";

/**
 * 오래된 초안 방어 seam — 초안 생성 시점 fingerprint 와 그 산출에 쓰인 렌즈 직렬화·근거
 * 노드 목록을 받는다. 적용 직전 엔티티 *현재* 구조화 값으로 fingerprint 를 다시 만들어
 * expectedFingerprint 와 대조한다. lensSerialization·evidenceNodeIds 는 초안 시점 값이라
 * 엔티티만 바뀌어도 재산출 fingerprint 가 달라져 어긋난다. 초안 생성(C-2b)이 이 세 값을
 * 함께 저장했다가 승인 시 넘긴다. HTTP 경로는 미지정(방어 없음 — 즉시 적용).
 */
export interface LensDraftFingerprintGuard {
  expectedFingerprint: string;
  lensSerialization: string;
  evidenceNodeIds: readonly number[];
}

/** applyLensDraft 입력. */
export interface ApplyLensDraftArgs {
  lens: LensApplyView;
  entityId: string;
  values: LensDraftValues;
  sourceNodeId: number | null;
  /**
   * AI 소비 경로 여부. true 면 새 엔티티 생성을 금지한다(entityId 는 이미 해소된 기존
   * id 여야 한다). 사이클(C-2b)·approve 경로는 true, HTTP 경로는 route 가 엔티티를
   * 먼저 해소한 뒤 값에 따라 넘긴다(현행 동작 보존).
   */
  aiPath: boolean;
  /**
   * fill-only 예외 — 채워진 칸을 덮어써도 되는 column key 집합(spec 6.C-2 point 3
   * "덮어쓰기가 필요한 초안은 명시"). 미지정·미포함 칸은 빈 칸만 채운다.
   */
  overwriteColumns?: ReadonlySet<string>;
  /** 초안 방어 seam(C-2b 승인 경로). 미지정이면 fingerprint 재대조를 건너뛴다. */
  fingerprintGuard?: LensDraftFingerprintGuard;
}

/** applyLensDraft 산출. */
export interface ApplyLensDraftResult {
  applied: true;
  typeName: string;
  entityId: string;
  relationCount: number;
}

/**
 * 렌즈 초안을 검증·적용한다. 전 검증 후 엔티티 구조화 쓰기(columns·labels·relations)를
 * 단일 트랜잭션으로 묶는다. metadata 는 근거 노드 대상 async·임베딩 경로라 트랜잭션 뒤에
 * 적용한다(파일 헤더 트랜잭션 경계 주의 참조).
 *
 * @throws LensApplyError 검증 실패·대상 부재·fingerprint 어긋남 — 호출처(route=400·
 *   사이클=원장 사유)가 loud 로 옮긴다.
 */
export async function applyLensDraft(
  deps: LensStoreDeps,
  args: ApplyLensDraftArgs,
): Promise<ApplyLensDraftResult> {
  const { lens, entityId, values, sourceNodeId, fingerprintGuard } = args;
  const typeName = lens.typeName;

  // metadata 적용에는 근거 노드가 필요하다(옛 route 계약 보존).
  if (Object.keys(values.metadata).length > 0 && sourceNodeId === null) {
    throw new LensApplyError("metadata 적용에는 sourceNodeId(number)가 필요");
  }

  // ── AI 경로는 기존 entityId 필수(spec 6.C-2 point 2) ──
  // 새 엔티티 생성은 사람 등록 금지와 같은 급의 명시 사용자 행위다. AI 소비 경로(사이클·
  // approve)는 이미 존재하는 후보만 다루므로, 넘어온 entityId 가 그 종류의 실제 행인지
  // 여기서 loud 로 확인한다 — 없으면 거부(자동화가 몰래 새 엔티티를 만들지 않는다).
  if (args.aiPath) {
    await assertExistingSourceEntity(deps, typeName, entityId);
  }

  // ── 오래된 초안 방어(spec 6.C-2 point 6) — 적용 직전 재대조 ──
  if (fingerprintGuard) {
    const current = lensDraftFingerprint({
      entityStructuredValue: serializeEntityStructuredValue(deps, entityId),
      lensSerialization: fingerprintGuard.lensSerialization,
      evidenceNodeIds: fingerprintGuard.evidenceNodeIds,
    });
    if (current !== fingerprintGuard.expectedFingerprint) {
      throw new LensApplyError(
        "초안 생성 이후 엔티티/렌즈가 바뀌어 적용을 거부한다 — 재평가 필요",
      );
    }
  }

  // ── 전 검증 + async 해소 → 동기 쓰기 계획 ──
  const plan = await buildWritePlan(
    deps,
    lens,
    entityId,
    values,
    args.overwriteColumns,
  );

  // ── 단일 트랜잭션: 엔티티 구조화 쓰기 전부 or 전무 ──
  const tx = deps.store.db.transaction(() => {
    // columns
    if (typeName === "project") {
      if (plan.projectAttributesMerged !== null) {
        // project attributes 는 칸 단위 병합 결과를 통째 저장한다(fill-only 병합은 계획
        // 단계에서 끝냈다 — 여기 값은 이미 최종본). updateProject 는 async 지만 본체가
        // 동기 setAttribute 라 트랜잭션 안에서 await 없이 부르면 promise 를 버리게 되므로,
        // 동기 저장 통로(setAttribute)로 직접 쓴다(project attributes_json 라벨·is_column=0).
        deps.store.entitiesRepo.setAttribute(
          entityId,
          "attributes_json",
          JSON.stringify(plan.projectAttributesMerged),
          false,
        );
      }
    } else {
      for (const w of plan.entityColumnWrites) {
        deps.store.entitiesRepo.setAttribute(entityId, w.key, w.value, true);
      }
    }

    // labels — 둘 다 동기 통로 addEntityConceptEdge(entity_concept_edges·INSERT OR IGNORE)
    // 로 쓴다. project 는 role='classification'(옛 addProjectConceptEdge 와 같은 테이블·
    // 같은 role·같은 멱등), 그 외는 role='has_attribute'. async projectRepo.addProject
    // ConceptEdge 를 트랜잭션 콜백에서 부르면 promise 를 버리게 되므로 동기 통로로 통일한다.
    for (const edge of plan.labelEdges) {
      const role = typeName === "project" ? "classification" : "has_attribute";
      deps.store.addEntityConceptEdge(
        typeName,
        entityId,
        edge.conceptId,
        role,
        "evolver",
        sourceNodeId,
      );
    }

    // relations
    let relationCount = 0;
    for (const edge of plan.relationEdges) {
      if (typeName === "project" && edge.targetType === "person") {
        // project→person 참여자 엣지(addProjectPersonEdge 와 같은 범용 엣지·participated_by).
        const added = deps.store.entityRelationEdgeRepo.addEntityRelationEdge(
          "project",
          entityId,
          "person",
          edge.targetId,
          "participated_by",
          "evolver",
          sourceNodeId,
        );
        if (added) relationCount += 1;
      } else {
        const added = deps.store.addEntityRelationEdge(
          typeName as PlacementTypeName,
          entityId,
          edge.targetType as PlacementTypeName,
          edge.targetId,
          edge.relation,
          "evolver",
          sourceNodeId,
        );
        if (added) relationCount += 1;
      }
    }
    return relationCount;
  });

  const relationCount = tx() as number;

  // ── metadata: 근거 노드 대상 async·임베딩 경로(트랜잭션 뒤) ──
  await applyMetadata(deps, values.metadata, sourceNodeId);

  return { applied: true, typeName, entityId, relationCount };
}

async function applyMetadata(
  deps: LensStoreDeps,
  metadata: Record<string, unknown>,
  sourceNodeId: number | null,
): Promise<void> {
  if (sourceNodeId === null) return;
  const place = stringifyScalar(metadata.place);
  if (place !== null) {
    await deps.store.setPlace(sourceNodeId, place, "inferred");
  }
  const eventAt = stringifyScalar(metadata.event_at);
  if (eventAt !== null) {
    await deps.store.setEventAt(sourceNodeId, eventAt, "inferred");
  }
  const eventUntil = stringifyScalar(metadata.event_until);
  if (eventUntil !== null) {
    await deps.store.setEventUntil(sourceNodeId, eventUntil, "inferred");
  }
}
