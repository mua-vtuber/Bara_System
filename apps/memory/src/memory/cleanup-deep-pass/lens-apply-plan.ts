/**
 * cleanup-deep-pass/lens-apply-plan.ts — 렌즈 초안 검증·해소(트랜잭션 앞 단계).
 *
 * lens-apply.ts 의 applyLensDraft 가 부르는 검증·async 해소 로직을 분리한다(파일 크기
 * 경계). 여기서 초안 전체를 검증하고 async 의존(label 개념 id·관계 대상 존재)을 해소해
 * 동기 쓰기 계획(WritePlan)을 만든다 — 실제 쓰기(단일 트랜잭션)는 lens-apply.ts 가 한다.
 *
 * 이 파일의 함수는 아무 것도 쓰지 않는다(읽기·검증·개념 upsert 만). 그래서 여기서 던지는
 * 예외는 엔티티 구조화 쓰기가 시작되기 전이라 부분 잔류가 없다(단일 트랜잭션 처방의 앞단).
 */

import type { SqliteMemoryStore } from "../../db/store.ts";
import type { ColumnDataType } from "../../db/store-internal/entity-type-registry.ts";

/**
 * 렌즈 적용·후보 검출이 의존하는 좁은 구조 계약 — store 한 칸(계층 역전, G5-b).
 * server-internal 의 MemoryApiDeps 는 store 를 필수 칸으로 가지므로 이 인터페이스에
 * 구조적으로 그대로 대입된다 — 라우트·approve 호출부는 full deps 를 그대로 넘긴다.
 * memory/ 쪽은 이 계약만 알면 되므로 server-internal 로의 역방향 import 가 생기지
 * 않는다(events/event-contract.ts 의 EventPublisher 선례 / layering.test.ts 가 지킨다).
 */
export interface LensStoreDeps {
  store: SqliteMemoryStore;
}

/** 렌즈 columns 한 칸(적용 검증에 필요한 최소 계약). */
export interface LensApplyColumn {
  key: string;
  dataType: ColumnDataType;
}

/** 렌즈 relations 한 칸(적용 검증·엣지 방향 판정에 필요한 최소 계약). */
export interface LensApplyRelation {
  key: string;
  relation: string;
  targetTypes: string[];
  defaultTargetType: string;
}

/** 적용에 필요한 렌즈 계약 뷰 — buildEntityLens 산출의 부분집합. */
export interface LensApplyView {
  typeName: string;
  columns: LensApplyColumn[];
  attributeKeys: string[];
  relations: LensApplyRelation[];
  metadataKeys: string[];
}

/** 적용할 값 묶음(검증 통과 전 raw). columns·labels 값만 새로 허용된다. */
export interface LensDraftValues {
  columns: Record<string, unknown>;
  labels: Record<string, unknown>;
  relations: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

/** 적용 검증 실패 — 라우트가 400 으로, 사이클이 원장 사유로 옮긴다(loud fail). */
export class LensApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LensApplyError";
  }
}

/** 트랜잭션에 넣을 동기 쓰기 계획 — 검증·async 해소가 끝난 확정 연산 묶음. */
export interface WritePlan {
  /** 범용 본체(비-project) 칸 쓰기. */
  entityColumnWrites: Array<{ key: string; value: string }>;
  /** project 칸 병합 결과(attributes 라벨 통째 저장 — 병합은 미리 끝냄). null=변경 없음. */
  projectAttributesMerged: Record<string, unknown> | null;
  /** label 개념 엣지 쓰기(개념 id 는 이미 해소). */
  labelEdges: Array<{ conceptId: string }>;
  /** relation 엣지 쓰기(대상 존재 검증 완료). */
  relationEdges: Array<{
    relationKey: string;
    targetType: string;
    targetId: string;
    relation: string;
  }>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 스칼라(문자열·유한 숫자·불리언)를 정규화 문자열로. 빈 문자열·비스칼라는 null. */
export function stringifyScalar(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return null;
}

/** 라벨 값(문자열·배열)을 평탄화한 문자열 목록으로. 빈 값은 뺀다. */
function valueList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => valueList(v));
  const scalar = stringifyScalar(value);
  return scalar === null ? [] : [scalar];
}

function relationValueList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * dataType 형식 검증(spec 6.C-2 point 5). date 는 YYYY-MM-DD, number 는 유한 숫자
 * 문자열만 통과. text 는 무제약. 어긋나면 LensApplyError.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateColumnDataType(
  key: string,
  dataType: ColumnDataType,
  value: string,
): void {
  if (dataType === "date") {
    if (!DATE_RE.test(value)) {
      throw new LensApplyError(
        `columns.${key} 은 date 형식(YYYY-MM-DD)이어야 함: '${value}'`,
      );
    }
    return;
  }
  if (dataType === "number") {
    if (!Number.isFinite(Number(value))) {
      throw new LensApplyError(`columns.${key} 은 숫자여야 함: '${value}'`);
    }
    return;
  }
  // text — 형식 무제약.
}

/** 한 엔티티(범용 본체)의 칸 attr(is_column=1) 현재 값을 key→value map 으로 읽는다. */
function readEntityColumnValues(
  deps: LensStoreDeps,
  entityId: string,
): Map<string, string> {
  const rows = deps.store.entitiesRepo.listAttributes(entityId);
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.isColumn) map.set(r.key, r.value);
  }
  return map;
}

/**
 * fill-only 판정(spec 6.C-2 point 3). 현재 값이 비어 있으면(칸 부재 또는 빈 문자열) 채운다.
 * 채워져 있으면 overwriteColumns 에 포함된 키만 덮고, 아니면 건너뛴다.
 */
function shouldWriteColumn(
  key: string,
  current: string | undefined,
  overwriteColumns: ReadonlySet<string> | undefined,
): boolean {
  const isEmpty = current === undefined || current.trim().length === 0;
  if (isEmpty) return true;
  return overwriteColumns?.has(key) ?? false;
}

/**
 * 프로젝트 종류의 현재 attributes(라벨 JSON) 를 읽는다. project columns 은 project
 * attributes_json 라벨에 칸 단위 병합되므로, 병합 기준 현재 값이 필요하다.
 */
async function readProjectAttributes(
  deps: LensStoreDeps,
  projectId: string,
): Promise<Record<string, unknown>> {
  const project = await deps.store.getProject(projectId);
  if (!project) {
    throw new LensApplyError(`기존 projectId 없음: ${projectId}`);
  }
  return project.attributes;
}

/**
 * 엔티티 현재 구조화 값을 결정적 문자열로 직렬화한다(fingerprint 재산출 입력). 칸(is_column=1)
 * 값을 key 정렬 후 이어붙인다 — 초안 생성 시점(C-2b)이 같은 직렬화로 fingerprint 를 만들고,
 * 승인 시점에 이 함수가 현재 값으로 다시 만들어 대조한다.
 */
export function serializeEntityStructuredValue(
  deps: LensStoreDeps,
  entityId: string,
): string {
  const cols = readEntityColumnValues(deps, entityId);
  return [...cols.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
}

/**
 * 초안 전체를 검증하고 async 의존(개념 id·대상 존재)을 해소해 동기 쓰기 계획을 만든다.
 * 여기서 던지는 예외는 아무 것도 쓰기 전이라 부분 잔류가 없다(단일 트랜잭션 처방의 앞단).
 */
/**
 * 엔티티·DB 없이 할 수 있는 값 형식 검증(spec 6.C-2 "전 검증"의 앞단). 렌즈 밖 키 거부
 * (columns·labels·relations·metadata) + 관계값 모양(문자열 이름 거부·기존 id 객체 요구·
 * targetType 허용 여부) + columns dataType 형식(date/number/text)을 본다. 대상 존재
 * (DB 조회)·개념 upsert 는 여기서 안 한다 — 그건 buildWritePlan 이 엔티티 해소 뒤에 한다.
 *
 * 핵심 목적: route(HTTP)가 엔티티를 만들거나(findOrCreateProject/Entity) 찾기 *전에* 이
 * 검증을 먼저 돌려, 거부되는 초안이 새 엔티티를 남기지 않게 한다(불변식 "거부된 적용은
 * 엔티티를 만들지 않는다"). 아무 것도 안 읽고·안 쓰므로 부수효과 0.
 */
export function validateDraftShape(lens: LensApplyView, values: LensDraftValues): void {
  const typeName = lens.typeName;

  // ── 렌즈 밖 키 거부(불변식) ──
  assertKnownKeys("columns", values.columns, lens.columns.map((c) => c.key));
  assertKnownKeys("labels", values.labels, lens.attributeKeys);
  assertKnownKeys("relations", values.relations, lens.relations.map((r) => r.key));
  assertKnownKeys("metadata", values.metadata, lens.metadataKeys);

  // ── person columns 계약 정합(광고 0 이지만 직접 호출 방어) ──
  if (typeName === "person" && Object.keys(values.columns).length > 0) {
    throw new LensApplyError(
      "person 렌즈는 columns 를 광고하지 않는다 — person columns 적용 불가",
    );
  }

  // ── columns dataType 형식 검증 ──
  const columnByKey = new Map(lens.columns.map((c) => [c.key, c]));
  for (const [key, raw] of Object.entries(values.columns)) {
    const value = stringifyScalar(raw);
    if (value === null) continue;
    const col = columnByKey.get(key);
    if (col) validateColumnDataType(key, col.dataType, value);
  }

  // ── relation 값 모양 검증(존재 검증 제외 — DB 없이) ──
  const relationByKey = new Map(lens.relations.map((r) => [r.key, r]));
  for (const [key, raw] of Object.entries(values.relations)) {
    const relation = relationByKey.get(key);
    if (!relation) throw new LensApplyError(`렌즈에 없는 relation 키: ${key}`);
    for (const value of relationValueList(raw)) {
      resolveRelationTargetShape(relation, value);
    }
  }
}

export async function buildWritePlan(
  deps: LensStoreDeps,
  lens: LensApplyView,
  entityId: string,
  values: LensDraftValues,
  overwriteColumns: ReadonlySet<string> | undefined,
): Promise<WritePlan> {
  const typeName = lens.typeName;

  // ── 값 형식·렌즈 밖 키·관계 모양 검증(엔티티 없이·부수효과 0). route 는 엔티티 해소
  //    전에 이미 이 검증을 돌리지만, 사이클(C-2b)·직접 호출 경로 방어로 여기서 한 번 더
  //    돌린다(멱등 — 통과분은 그대로 진행). ──
  validateDraftShape(lens, values);

  // ── columns: fill-only 병합(형식·person 검증은 validateDraftShape 가 이미 끝냄) ──
  const entityColumnWrites: Array<{ key: string; value: string }> = [];
  let projectAttributesMerged: Record<string, unknown> | null = null;

  if (typeName === "person") {
    // person columns 은 validateDraftShape 가 이미 거부한다(여기 오면 columns 는 비어 있음).
  } else if (typeName === "project") {
    const current = await readProjectAttributes(deps, entityId);
    const merged: Record<string, unknown> = { ...current };
    let changed = false;
    for (const [key, raw] of Object.entries(values.columns)) {
      const value = stringifyScalar(raw);
      if (value === null) continue;
      const existing = stringifyScalar(current[key]);
      if (shouldWriteColumn(key, existing ?? undefined, overwriteColumns)) {
        merged[key] = value;
        changed = true;
      }
    }
    projectAttributesMerged = changed ? merged : null;
  } else {
    const current = readEntityColumnValues(deps, entityId);
    for (const [key, raw] of Object.entries(values.columns)) {
      const value = stringifyScalar(raw);
      if (value === null) continue;
      if (shouldWriteColumn(key, current.get(key), overwriteColumns)) {
        entityColumnWrites.push({ key, value });
      }
    }
  }

  // ── labels: 개념 id 해소(async — 트랜잭션 앞에서 끝냄) ──
  const labelEdges: Array<{ conceptId: string }> = [];
  if (typeName !== "person") {
    for (const rawValue of Object.values(values.labels)) {
      for (const value of valueList(rawValue)) {
        const conceptId = await deps.store.findOrCreateTagConcept(value);
        labelEdges.push({ conceptId });
      }
    }
  }

  // ── relations: 대상 존재 검증(async — 모양 검증은 validateDraftShape 가 이미 끝냄) ──
  const relationByKey = new Map(lens.relations.map((r) => [r.key, r]));
  const relationEdges: WritePlan["relationEdges"] = [];
  for (const [key, raw] of Object.entries(values.relations)) {
    const relation = relationByKey.get(key);
    if (!relation) throw new LensApplyError(`렌즈에 없는 relation 키: ${key}`);
    for (const value of relationValueList(raw)) {
      const shape = resolveRelationTargetShape(relation, value);
      await assertExistingTarget(deps, shape.typeName, shape.id);
      relationEdges.push({
        relationKey: key,
        targetType: shape.typeName,
        targetId: shape.id,
        relation: relation.relation,
      });
    }
  }

  return { entityColumnWrites, projectAttributesMerged, labelEdges, relationEdges };
}

function assertKnownKeys(
  name: string,
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const set = new Set(allowed);
  const bad = Object.keys(record).filter((k) => !set.has(k));
  if (bad.length > 0) {
    throw new LensApplyError(`렌즈에 없는 ${name} 키: ${bad.join(", ")}`);
  }
}

/**
 * relation 값(기존 id 객체)의 *모양* 만 검증한다 — 문자열 이름 거부, 사람은 기존 personId,
 * 그 외는 기존 targetId/id, targetType 허용 여부. DB 조회 없음(부수효과 0). 대상 *존재*
 * 는 buildWritePlan 이 assertExistingTarget 으로 따로 확인한다(엔티티 해소 뒤). 이 분리로
 * validateDraftShape 가 엔티티 생성 전에 모양을 걸러낼 수 있다(거부 초안 = 새 엔티티 0).
 */
function resolveRelationTargetShape(
  relation: LensApplyRelation,
  value: unknown,
): { typeName: string; id: string } {
  if (!isRecord(value)) {
    throw new LensApplyError(
      `${relation.key} 관계값은 문자열 이름이 아니라 기존 id 객체여야 함`,
    );
  }
  const targetType =
    typeof value.targetType === "string" && value.targetType.trim()
      ? value.targetType.trim()
      : relation.defaultTargetType;
  if (!relation.targetTypes.includes(targetType)) {
    throw new LensApplyError(
      `${relation.key} targetType 불가: ${targetType} (허용: ${relation.targetTypes.join(", ")})`,
    );
  }
  const id =
    targetType === "person"
      ? typeof value.personId === "string"
        ? value.personId.trim()
        : ""
      : typeof value.targetId === "string"
        ? value.targetId.trim()
        : typeof value.id === "string"
          ? value.id.trim()
          : "";
  if (!id) {
    throw new LensApplyError(`${relation.key} 관계값은 기존 ${targetType} id 필요`);
  }
  return { typeName: targetType, id };
}

/**
 * AI 경로 source 엔티티 존재 확인(spec 6.C-2 point 2). 종류별 1급 통로로 조회한다 —
 * person=getPerson, project=getProject, 그 외=entitiesRepo.get + type 일치. 없으면 거부.
 */
export async function assertExistingSourceEntity(
  deps: LensStoreDeps,
  typeName: string,
  entityId: string,
): Promise<void> {
  if (typeName === "person") {
    if (!(await deps.store.getPerson(entityId))) {
      throw new LensApplyError(
        `AI 경로는 기존 personId 필수 — 없음: ${entityId} (새 사람 생성 불가)`,
      );
    }
    return;
  }
  if (typeName === "project") {
    if (!(await deps.store.getProject(entityId))) {
      throw new LensApplyError(
        `AI 경로는 기존 projectId 필수 — 없음: ${entityId} (새 프로젝트 생성 불가)`,
      );
    }
    return;
  }
  const entity = await deps.store.entitiesRepo.get(entityId);
  if (!entity || entity.typeName !== typeName) {
    throw new LensApplyError(
      `AI 경로는 기존 ${typeName} entityId 필수 — 없음/종류 불일치: ${entityId}`,
    );
  }
}

async function assertExistingTarget(
  deps: LensStoreDeps,
  targetType: string,
  id: string,
): Promise<void> {
  if (targetType === "person") {
    if (!(await deps.store.getPerson(id))) {
      throw new LensApplyError(`기존 personId 없음: ${id}`);
    }
    return;
  }
  if (targetType === "project") {
    if (!(await deps.store.getProject(id))) {
      throw new LensApplyError(`기존 projectId 없음: ${id}`);
    }
    return;
  }
  const entity = await deps.store.entitiesRepo.get(id);
  if (!entity || entity.typeName !== targetType) {
    throw new LensApplyError(`기존 ${targetType} entityId 없음: ${id}`);
  }
}
