/**
 * entity-register/apply.ts — 메모 하나의 반영(spec 5장). 자동 반영(process.ts)과 승인(proposal.ts)이
 * 같은 함수를 쓴다. 준비(게이트·대상 확인·identity 개념 확보·일정 임베딩) → 잠금 + 트랜잭션 안 쓰기 →
 * 커밋 뒤 신호.
 *
 * 연결 규칙(plan 13-1):
 *   사람      메모·일정 노드 --node_person_edges(mentions)--> 사람
 *   다른 항목 메모·일정 노드 --node_concept_edges(mention)--> identity 개념 <--entity_concept_edges(identity)-- 항목 행
 *   일정 노드 메모에서 파생(merged_into 계보, source_type=llm_extract, event_at=inferred). schedule 항목 행은 만들지 않는다.
 *
 * identity 개념은 해시태그 항목 경로(place-entity-type.ts·place-provenance-flow.ts·place-user-entity-type.ts)와
 * 같은 종류(분류 값 개념, findOrCreateConcept + isClassificationValue)로 만든다. 사용자가 쓴 #태그 개념
 * (findOrCreateTagConcept, is_tag=1)으로 표시하지 않는다. 엣지는 정적 종류면 linkEntityIdentity, 사용자 종류면
 * (linkEntityIdentity 가 정적 8 종류만 받으므로) place-user-entity-type.ts 처럼 addEntityConceptEdge 를 직접 부른다.
 *
 * 알려진 한계(사용자 수용): 새 개념은 임베딩이 필요해 트랜잭션 전에 확보한다. 그래서 쓰기가 실패하면 연결 없는
 * 개념 행이 남을 수 있다. 사람·항목 행·엣지·일정·기록은 하나도 남지 않는다(apply.test.ts 가 고정).
 */
import type { SqliteMemoryStore } from "../../../db/store.ts";
import type { PlacementTypeName } from "../../concept-type-vocabulary.ts";
import { contentHash } from "../../content-hash.ts";
import { linkEntityIdentity } from "../../entity-attribute-wiring.ts";
import { isMidChainNode } from "../../entity-placement-loop-internal/chain-structure.ts";
import { createEntityRow, ENTITY_REGISTER_GATE_SOURCE, shouldCreateEntityRow } from "../../entity-row-gate.ts";
import { toNfc } from "../../nfc.ts";
import { withMemoryMutationLock } from "../../shared-memory-mutation-lock.ts";
import { runImmediateTransactionAsync } from "./apply-transaction.ts";
import {
  ENTITY_REGISTER_EDGE_PROVENANCE, ENTITY_REGISTER_EXCLUDED_TYPES, ENTITY_REGISTER_METADATA_KEY, SCHEDULE_OCCURRENCE_KEY, SCHEDULE_SOURCE_NODE_KEY,
} from "./constants.ts";
import { emptyRecordDetail, type EntityRegisterRecordsRepository, type RecordedEdge } from "./records-repository.ts";
import type { RecordDecidedBy } from "./types.ts";

export interface EntityApplication {
  memoName: string;
  type: string;
  action:
    | { kind: "link"; targetId: string; targetName: string; addAlias: boolean }
    | { kind: "create"; name: string; aliasFromMemo: string | null };
}

export interface ScheduleApplication { title: string; date: string; dateText: string; replaceNodeId: number | null }

export interface ApplyContext {
  store: SqliteMemoryStore;
  records: EntityRegisterRecordsRepository;
  memo: { nodeId: number; content: string; createdAt: string };
  runId: string | null;
  proposalId: string | null;
  decidedBy: RecordDecidedBy;
}

export interface AppliedEntity {
  memoName: string;
  type: string;
  id: string;
  name: string;
  created: boolean;
  aliasAdded: string | null;
  recordId: number | null;
}

export interface ApplyOutcome {
  entities: AppliedEntity[];
  skipped: Array<{ memoName: string; type: string; reason: string }>;
  scheduleNodeId: number | null;
  scheduleRecordId: number | null;
}

const PERSON_TYPE = "person";
const ERROR_PREFIX = "entity-register 반영";

/**
 * 요청이 지금 상태와 맞지 않아 반영을 거부함 — 연결 대상이 사라졌거나 종류가 다름, 제외 종류 요청,
 * 일정 교체 대상이 살아 있는 일정과 다름. 쓰기 트랜잭션 전에(또는 트랜잭션 안에서 되돌림과 함께) 던진다.
 * 승인 경로는 이 오류만 "오래된 제안"으로 닫고, 다른 오류(DB·임베딩 실패 등)는 그대로 올려 보낸다.
 */
export class EntityRegisterApplyRefusedError extends Error {
  constructor(message: string) {
    super(`${ERROR_PREFIX}: ${message}`);
    this.name = "EntityRegisterApplyRefusedError";
  }
}

interface PreparedEntity { app: EntityApplication; conceptId: string | null }
interface LinkTarget { type: string; id: string; conceptId: string | null }

function existingIdentityConcept(store: SqliteMemoryStore, type: string, entityId: string): string | null {
  return store.getEntityConceptEdges(type, entityId, "identity")[0]?.conceptId ?? null;
}

/** 항목 행의 identity 개념 — 행에 이미 있으면 그것, 없으면 해시태그 항목 경로와 같은 분류 값 개념을 확보한다. */
async function identityConceptFor(store: SqliteMemoryStore, type: string, entityId: string | null, name: string): Promise<string> {
  const existing = entityId === null ? null : existingIdentityConcept(store, type, entityId);
  return existing ?? store.findOrCreateConcept(name, { isClassificationValue: true });
}

/** 연결 대상 항목 행을 확인한다(사람 제외). 없거나 종류가 다르면 id 를 담아 멈춘다. */
async function requireEntity(store: SqliteMemoryStore, type: string, id: string) {
  const entity = await store.entitiesRepo.get(id);
  if (!entity) throw new EntityRegisterApplyRefusedError(`항목 ${type}/${id} 가 없음`);
  if (entity.typeName !== type) throw new EntityRegisterApplyRefusedError(`항목 ${id} 의 종류가 ${entity.typeName} 인데 ${type} 로 요청됨`);
  return entity;
}

/** 이름이 같은 기존 행 id 들 — 행 생성 경로가 새 행을 만들었는지 가린다(work 는 같은 이름 행이 여럿일 수 있다). */
async function existingRowIds(store: SqliteMemoryStore, type: string, name: string): Promise<Set<string>> {
  if (type === PERSON_TYPE) {
    const person = await store.findPersonByName(name);
    return new Set(person ? [person.personId] : []);
  }
  const rows = store.getRawDb()
    .query("SELECT entity_id FROM entities WHERE type_name = ? AND name = ?")
    .all(type, toNfc(name).trim()) as Array<{ entity_id: string }>;
  return new Set(rows.map((r) => r.entity_id));
}

function linkIdentity(store: SqliteMemoryStore, type: string, id: string, conceptId: string, prov: RecordDecidedBy, memoId: number): boolean {
  const provenance = ENTITY_REGISTER_EDGE_PROVENANCE[prov];
  if (store.entityTypeRegistryDb.isUserEntityType(type)) {
    return store.addEntityConceptEdge(type, id, conceptId, "identity", provenance, memoId);
  }
  return linkEntityIdentity(store, type, id, conceptId, provenance, memoId);
}

/** 별칭을 더했으면 저장한 정규화 별칭, 이미 있었으면 null — 되돌리기가 원래 있던 별칭을 지우지 않게 정규화한 값으로 비교한다. */
async function addAlias(store: SqliteMemoryStore, type: string, id: string, rawAlias: string): Promise<string | null> {
  const alias = toNfc(rawAlias).trim();
  if (!alias) throw new Error(`${ERROR_PREFIX}: ${type}/${id} 에 더할 별칭이 비어 있음`);
  if (type === PERSON_TYPE) {
    const before = await store.getPerson(id);
    if (!before) throw new EntityRegisterApplyRefusedError(`사람 ${id} 가 없음`);
    // 저장소(person-repository addPersonAlias)와 똑같이 저장된 쪽도 NFC 로 맞춰 비교한다 — 저장소는 중복이어도
    // null 이 아닌 사람을 돌려주므로, 여기서 같은 규칙으로 걸러야 더하지 않은 별칭을 기록하지 않는다.
    if (before.aliases.some((a) => toNfc(a) === alias) || toNfc(before.displayName) === alias) return null;
    if (!(await store.addPersonAlias(id, alias))) throw new Error(`${ERROR_PREFIX}: 사람 ${id} 에 별칭을 더하지 못함`);
    return alias;
  }
  const entity = await requireEntity(store, type, id);
  if (toNfc(entity.name) === alias || entity.koAliases.some((a) => toNfc(a) === alias)) return null;
  store.entitiesRepo.setKoAliases(id, [...entity.koAliases, alias]);
  return alias;
}

async function linkNode(store: SqliteMemoryStore, nodeId: number, memoId: number, target: LinkTarget, prov: RecordDecidedBy): Promise<RecordedEdge | null> {
  const provenance = ENTITY_REGISTER_EDGE_PROVENANCE[prov];
  if (target.type === PERSON_TYPE) {
    const added = await store.addNodePersonEdge(nodeId, target.id, "mentions", provenance, memoId);
    return added ? { table: "node_person_edges", nodeId, personId: target.id, relation: "mentions" } : null;
  }
  if (target.conceptId === null) throw new Error(`${ERROR_PREFIX}: 항목 ${target.type}/${target.id} 의 identity 개념이 없음`);
  const added = await store.addNodeConceptEdge(nodeId, target.conceptId, "mention", provenance, memoId);
  return added ? { table: "node_concept_edges", nodeId, conceptId: target.conceptId, role: "mention" } : null;
}

/** 준비 단계 — 게이트를 거르고, 연결 대상을 확인하고, identity 개념을 확보한다(새 개념은 여기서 임베딩된다). */
async function prepareEntities(ctx: ApplyContext, entities: EntityApplication[], skipped: ApplyOutcome["skipped"]): Promise<PreparedEntity[]> {
  const { store, memo } = ctx;
  // schedule 항목 행을 만들지 않는다는 사용자 결정·project 는 명시 태그로만 — 자동 반영과 승인의 유일한
  // 쓰기 입구라 여기서 스스로 막는다(어떤 쓰기·개념 확보보다 먼저).
  for (const app of entities) {
    if (ENTITY_REGISTER_EXCLUDED_TYPES.has(app.type)) {
      throw new EntityRegisterApplyRefusedError(`메모 ${memo.nodeId} 의 '${app.memoName}' 종류 ${app.type} 는 이 단계가 다루지 않는 종류임`);
    }
  }
  const prepared: PreparedEntity[] = [];
  for (const app of entities) {
    const { action } = app;
    if (action.kind === "create") {
      const gate = shouldCreateEntityRow({
        typeName: app.type as PlacementTypeName, candidateName: action.name, source: ENTITY_REGISTER_GATE_SOURCE,
        hasAttributes: false, subcategory: null, isMidChainNode: isMidChainNode(action.name, memo.content),
      });
      if (!gate.create) {
        skipped.push({ memoName: app.memoName, type: app.type, reason: gate.reason });
        continue;
      }
    }
    if (app.type === PERSON_TYPE) {
      prepared.push({ app, conceptId: null });
      continue;
    }
    if (action.kind === "link") {
      const entity = await requireEntity(store, app.type, action.targetId);
      prepared.push({ app, conceptId: await identityConceptFor(store, app.type, entity.id, entity.name) });
    } else {
      const existing = await store.entitiesRepo.findByName(app.type, action.name);
      prepared.push({ app, conceptId: await identityConceptFor(store, app.type, existing?.id ?? null, action.name) });
    }
  }
  return prepared;
}

/** 이 메모에서 앞서 이어 둔 항목 — 새 일정 노드도 그 항목에 잇는다(spec 4.5 끝 줄). */
function earlierLinkTargets(ctx: ApplyContext): LinkTarget[] {
  return ctx.records.listActiveForMemo(ctx.memo.nodeId)
    .filter((r) => r.itemKind !== "schedule_created")
    .map((r) => ({
      type: r.targetType,
      id: r.targetId,
      conceptId: r.targetType === PERSON_TYPE ? null : existingIdentityConcept(ctx.store, r.targetType, r.targetId),
    }));
}

export async function applyMemoChanges(
  ctx: ApplyContext,
  changes: { entities: EntityApplication[]; schedule: ScheduleApplication | null },
): Promise<ApplyOutcome> {
  const { store, records, memo } = ctx;
  const db = store.getRawDb();
  const provenance = ENTITY_REGISTER_EDGE_PROVENANCE[ctx.decidedBy];

  return withMemoryMutationLock(store, async () => {
    // ── 준비(트랜잭션 밖): 실제로 기다리는 I/O(임베딩)는 여기서 끝낸다 ──
    // 일정 요청 검사는 개념 확보·임베딩보다 먼저 — 잘못된 요청이 개념 행을 남기지 않게.
    const existingSchedule = records.activeScheduleForMemo(memo.nodeId);
    const schedule = changes.schedule;
    if (schedule) {
      if (schedule.replaceNodeId !== null && existingSchedule?.nodeId !== schedule.replaceNodeId) {
        throw new EntityRegisterApplyRefusedError(
          `바꿀 일정 노드 ${schedule.replaceNodeId} 가 메모 ${memo.nodeId} 의 살아 있는 일정이 아님` +
            ` (현재 일정 노드: ${existingSchedule?.nodeId ?? "없음"})`,
        );
      }
      if (schedule.replaceNodeId === null && existingSchedule) {
        throw new EntityRegisterApplyRefusedError(`메모 ${memo.nodeId} 에 이미 일정 노드 ${existingSchedule.nodeId} 가 있는데 바꿀 대상 없이 새 일정을 요청함`);
      }
    }
    const replacing = schedule && existingSchedule ? existingSchedule : null;
    const replacingRecord = replacing ? records.get(replacing.recordId) : null;
    if (replacing && !replacingRecord) throw new Error(`${ERROR_PREFIX}: 일정 기록 ${replacing.recordId} 가 없음`);
    const skipped: ApplyOutcome["skipped"] = [];
    const prepared = await prepareEntities(ctx, changes.entities, skipped);
    const scheduleTitle = schedule ? toNfc(schedule.title) : null;
    const scheduleVector = scheduleTitle !== null ? await store.embedder.embed(scheduleTitle) : null;
    const earlierTargets = schedule ? earlierLinkTargets(ctx) : [];

    // ── 쓰기(트랜잭션 안): 본문이 동기 SQL 인 저장소 메서드만 기다린다 ──
    const outcome = await runImmediateTransactionAsync(db, async (): Promise<ApplyOutcome> => {
      const applied: AppliedEntity[] = [];
      const linkTargets: LinkTarget[] = [];
      for (const { app, conceptId } of prepared) {
        const detail = emptyRecordDetail();
        let id: string;
        let name: string;
        let created = false;
        if (app.action.kind === "create") {
          const before = await existingRowIds(store, app.type, app.action.name);
          const row = await createEntityRow(store, app.type, app.action.name);
          id = row.id;
          name = row.name;
          created = !before.has(id);
          if (created) detail.createdRow = { typeName: app.type, id };
        } else {
          id = app.action.targetId;
          name = app.action.targetName;
          if (app.type === PERSON_TYPE && !(await store.getPerson(id))) throw new EntityRegisterApplyRefusedError(`사람 ${id} 가 없음`);
        }
        if (conceptId !== null && linkIdentity(store, app.type, id, conceptId, ctx.decidedBy, memo.nodeId)) {
          detail.edges.push({ table: "entity_concept_edges", entityId: id, conceptId, role: "identity" });
        }
        const alias = app.action.kind === "create" ? app.action.aliasFromMemo : app.action.addAlias ? app.memoName : null;
        const aliasAdded = alias === null ? null : await addAlias(store, app.type, id, alias);
        if (aliasAdded !== null) detail.aliasAdded = { typeName: app.type, id, alias: aliasAdded };
        const target: LinkTarget = { type: app.type, id, conceptId };
        const memoEdge = await linkNode(store, memo.nodeId, memo.nodeId, target, ctx.decidedBy);
        if (memoEdge) detail.edges.push(memoEdge);
        if (existingSchedule && !schedule) {
          const scheduleEdge = await linkNode(store, existingSchedule.nodeId, memo.nodeId, target, ctx.decidedBy);
          if (scheduleEdge) detail.edges.push(scheduleEdge);
        }
        const changed = created || aliasAdded !== null || detail.edges.length > 0;
        const recordId = changed
          ? records.insert({
              runId: ctx.runId, proposalId: ctx.proposalId, sourceNodeId: memo.nodeId,
              itemKind: created ? "entity_created" : "entity_linked", targetType: app.type, targetId: id,
              name: app.memoName, decidedBy: ctx.decidedBy, detail,
            })
          : null;
        applied.push({ memoName: app.memoName, type: app.type, id, name, created, aliasAdded, recordId });
        linkTargets.push(target);
      }

      let scheduleNodeId: number | null = null;
      let scheduleRecordId: number | null = null;
      if (schedule && scheduleTitle !== null && scheduleVector !== null) {
        scheduleNodeId = store.nodeRepo.insertNodeWithVecSync(
          {
            content: scheduleTitle,
            sourceType: "llm_extract",
            metadata: {
              [SCHEDULE_OCCURRENCE_KEY]: true,
              [SCHEDULE_SOURCE_NODE_KEY]: memo.nodeId,
              [ENTITY_REGISTER_METADATA_KEY]: { runId: ctx.runId, decidedBy: ctx.decidedBy, dateText: schedule.dateText },
            },
            provenance: {
              kind: "derived", parentId: memo.nodeId, relation: "merged_into",
              edgeProvenance: provenance, extractionOriginId: memo.nodeId,
            },
          },
          scheduleTitle, contentHash(scheduleTitle), scheduleVector,
        );
        if (!(await store.setEventAt(scheduleNodeId, schedule.date, "inferred"))) {
          throw new Error(`${ERROR_PREFIX}: 일정 노드 ${scheduleNodeId} 에 날짜 ${schedule.date} 를 쓰지 못함`);
        }
        const detail = { ...emptyRecordDetail(), scheduleNodeId, date: schedule.date };
        for (const t of [...linkTargets, ...earlierTargets]) {
          const edge = await linkNode(store, scheduleNodeId, memo.nodeId, t, ctx.decidedBy);
          if (edge) detail.edges.push(edge);
        }
        scheduleRecordId = records.insert({
          runId: ctx.runId, proposalId: ctx.proposalId, sourceNodeId: memo.nodeId, itemKind: "schedule_created",
          targetType: "schedule", targetId: String(scheduleNodeId), name: scheduleTitle, decidedBy: ctx.decidedBy, detail,
        });
        if (replacing && replacingRecord) {
          if (!records.markReverted(replacing.recordId, replacingRecord.detail)) {
            throw new Error(`${ERROR_PREFIX}: 일정 기록 ${replacing.recordId} 를 되돌림으로 표시하지 못함`);
          }
          // 옛 일정 노드를 같은 트랜잭션에서 휴지통으로 — 새 일정과 옛 일정이 함께 살아남지 않는다.
          // 잠금은 다시 들어갈 수 있고(shared-memory-mutation-lock.ts), 안쪽 db.transaction 은 SAVEPOINT 가 된다.
          const trashed = await store.trashNodes([replacing.nodeId], "selected_only");
          if (!trashed.movedIds.includes(replacing.nodeId)) {
            throw new Error(`${ERROR_PREFIX}: 옛 일정 노드 ${replacing.nodeId} 를 휴지통으로 옮기지 못함`);
          }
        }
      }
      return { entities: applied, skipped, scheduleNodeId, scheduleRecordId };
    });

    if (outcome.scheduleNodeId !== null) store.nodeRepo.emitRawMemoryAdded();
    return outcome;
  });
}
