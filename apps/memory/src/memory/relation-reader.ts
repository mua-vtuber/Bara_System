/**
 * relation-reader.ts — read-only logical view over the existing relation tables.
 *
 * This file intentionally does not create a SQL view, migrate data, repair rows,
 * or change graph/search consumers. It only reads the current tables into one
 * common shape so later integration decisions can compare relation coverage.
 */

import type { Database } from "bun:sqlite";
import {
  RELATION_TABLE_SPECS,
  endpointKindFromRow,
  hasRelationTable,
  relationSpecByTable,
  type RelationEndpointSpec,
  type RelationFkPolicy,
  type RelationLayer,
  type RelationTableName,
  type RelationTableSpec,
} from "./relation-registry.ts";

export type { RelationLayer, RelationTableName } from "./relation-registry.ts";

export interface UnifiedRelationEdge {
  tableName: string;
  rowId: number | string | null;
  sourceKind: string;
  sourceId: string;
  targetKind: string;
  targetId: string;
  relation: string;
  provenance: string;
  sourceNodeId: number | null;
  layer: RelationLayer;
  fkPolicy: RelationFkPolicy;
  weight: number | null;
  createdAt: string | null;
}

export interface RelationEndpointFilter {
  kind?: string;
  id?: string | number;
}

export interface RelationAroundFilter {
  kind: string;
  id: string | number;
}

export interface RelationEdgeFilter {
  tableName?: RelationTableName | readonly RelationTableName[];
  layer?: RelationLayer | readonly RelationLayer[];
  relation?: string | readonly string[];
  source?: RelationEndpointFilter;
  target?: RelationEndpointFilter;
  around?: RelationAroundFilter;
}

type RelationRow = Record<string, unknown> & {
  __rowid?: number | string | null;
  __source_id: unknown;
  __target_id: unknown;
  __relation: unknown;
  __provenance: unknown;
  __source_node_id: unknown;
  __weight: unknown;
  __created_at: unknown;
};

function values<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

function filterSpecs(filter?: RelationEdgeFilter): readonly RelationTableSpec[] {
  const tableNames = values(filter?.tableName);
  if (tableNames.length === 0) return RELATION_TABLE_SPECS;
  return tableNames
    .map((tableName) => relationSpecByTable(tableName))
    .filter((spec): spec is RelationTableSpec => spec !== null);
}

function q(alias: string, column: string): string {
  return `${alias}.${column}`;
}

function endpointKindColumns(spec: RelationTableSpec): string[] {
  const cols: string[] = [];
  for (const endpoint of [spec.source, spec.target]) {
    const rule = endpoint.kindRule;
    if (rule.kind === "type_column") {
      cols.push(`${q(spec.reader.tableAlias, rule.column)} AS ${rule.column}`);
    } else if (rule.kind === "entity_type_lookup") {
      const expr =
        endpoint === spec.source
          ? spec.reader.sourceKindSql
          : spec.reader.targetKindSql;
      if (expr) cols.push(`${expr} AS ${endpoint.idColumn}__kind`);
    }
  }
  return cols;
}

/** 한 endpoint 의 kind 를 SQL 에서 가리키는 표현식(alias 포함). pushdown 불가면 null. */
function endpointKindSqlExpr(
  spec: RelationTableSpec,
  endpoint: RelationEndpointSpec,
): string | null {
  const rule = endpoint.kindRule;
  if (rule.kind === "type_column") return q(spec.reader.tableAlias, rule.column);
  if (rule.kind === "entity_type_lookup") {
    return endpoint === spec.source
      ? spec.reader.sourceKindSql ?? null
      : spec.reader.targetKindSql ?? null;
  }
  // fixed·id_prefix 는 가리킬 컬럼이 없다.
  return null;
}

/**
 * fixed kind endpoint 가 filter 의 kind 요구와 어긋나면 그 spec 은 한 행도 못 맞춘다.
 * 컬럼이 없어 SQL WHERE 로 못 줄이는 대신, spec 자체를 결과에서 빼는 신호를 준다
 * (정직한 빈 결과 — 그 테이블에는 맞는 행이 진짜 없다). 일치하면 조건은 무시한다.
 */
function fixedKindExcludesSpec(
  endpoint: RelationEndpointSpec,
  requiredKind: string | undefined,
): boolean {
  if (requiredKind === undefined) return false;
  if (endpoint.kindRule.kind !== "fixed") return false;
  return endpoint.kindRule.value !== requiredKind;
}

export interface RelationSelect {
  sql: string;
  params: string[];
}

/**
 * spec 한 표를 읽는 SELECT 와 바인딩 파라미터를 만든다. filter 의 id·relation·kind
 * 조건을 가능한 한 WHERE 절로 내려(pushdown) indexed 조회를 회복한다. 어느 조건이
 * 그 spec 의 fixed kind 와 어긋나 한 행도 못 맞추면 null 을 돌려 spec 을 통째로 건너뛴다.
 *
 * WHERE 는 "읽는 행 수를 줄이는 최적화"일 뿐이고 최종 정확성은 호출부의 앱 필터
 * matchesEdgeFilter 가 보장한다. 그래서 pushdown 못 하는 조건(id_prefix kind·around
 * 의 kind)은 그냥 앱 필터에 맡긴다.
 */
export function relationSelectSql(
  spec: RelationTableSpec,
  filter?: RelationEdgeFilter,
): RelationSelect | null {
  const alias = spec.reader.tableAlias;
  const weightSql = spec.weightColumn ? q(alias, spec.weightColumn) : "NULL";
  const createdAtSql = spec.createdAtColumn ? q(alias, spec.createdAtColumn) : "NULL";
  const columns = [
    `${alias}.rowid AS __rowid`,
    `${q(alias, spec.source.idColumn)} AS __source_id`,
    `${q(alias, spec.target.idColumn)} AS __target_id`,
    `${q(alias, spec.relationColumn.name)} AS __relation`,
    `${q(alias, spec.provenanceColumn)} AS __provenance`,
    `${q(alias, spec.sourceNodeIdColumn)} AS __source_node_id`,
    `${weightSql} AS __weight`,
    `${createdAtSql} AS __created_at`,
    ...endpointKindColumns(spec),
  ];

  const conditions: string[] = [];
  const params: string[] = [];

  // source.id / target.id → idColumn = ? (가장 쓸모 큰 indexed 조회 회복).
  if (filter?.source?.id !== undefined) {
    conditions.push(`${q(alias, spec.source.idColumn)} = ?`);
    params.push(String(filter.source.id));
  }
  if (filter?.target?.id !== undefined) {
    conditions.push(`${q(alias, spec.target.idColumn)} = ?`);
    params.push(String(filter.target.id));
  }

  // relation (string | 배열) → relationColumn IN (?, ...).
  const relationValues = values(filter?.relation);
  if (relationValues.length > 0) {
    const placeholders = relationValues.map(() => "?").join(", ");
    conditions.push(`${q(alias, spec.relationColumn.name)} IN (${placeholders})`);
    params.push(...relationValues);
  }

  // around.id → (source = ? OR target = ?). around 자체가 한쪽만 맞으면 되는 OR 구조라
  // kind 는 양쪽 AND 로 내리면 틀린다 → around 의 kind 는 앱 필터에 맡긴다(id 만 pushdown).
  if (filter?.around?.id !== undefined) {
    conditions.push(
      `(${q(alias, spec.source.idColumn)} = ? OR ${q(alias, spec.target.idColumn)} = ?)`,
    );
    const aroundId = String(filter.around.id);
    params.push(aroundId, aroundId);
  }

  // source.kind / target.kind → type_column·entity_type_lookup 은 표현식 = ? 로 내린다.
  // fixed 는 컬럼이 없어 못 내리지만, 어긋나면 spec 통째 제외(아래 null 반환).
  // id_prefix 는 내리지 않고 앱 필터에 맡긴다(id 필터가 이미 좁혀준다).
  for (const [endpoint, endpointFilter] of [
    [spec.source, filter?.source] as const,
    [spec.target, filter?.target] as const,
  ]) {
    const requiredKind = endpointFilter?.kind;
    if (requiredKind === undefined) continue;
    if (fixedKindExcludesSpec(endpoint, requiredKind)) return null;
    const kindExpr = endpointKindSqlExpr(spec, endpoint);
    if (kindExpr !== null) {
      conditions.push(`${kindExpr} = ?`);
      params.push(requiredKind);
    }
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const orderBy = spec.orderBy.map((column) => q(alias, column)).join(", ");
  const sql = `SELECT ${columns.join(", ")} FROM ${spec.reader.fromSql}${where} ORDER BY ${orderBy}`;
  return { sql, params };
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function rowToEdge(spec: RelationTableSpec, row: RelationRow): UnifiedRelationEdge {
  const sourceId = stringValue(row.__source_id);
  const targetId = stringValue(row.__target_id);
  return {
    tableName: spec.tableName,
    rowId: row.__rowid ?? null,
    sourceKind: endpointKindFromRow(spec.source, {
      ...row,
      [spec.source.idColumn]: sourceId,
    }),
    sourceId,
    targetKind: endpointKindFromRow(spec.target, {
      ...row,
      [spec.target.idColumn]: targetId,
    }),
    targetId,
    relation: stringValue(row.__relation),
    provenance: stringValue(row.__provenance),
    sourceNodeId: nullableNumber(row.__source_node_id),
    layer: spec.layer,
    fkPolicy: spec.fkPolicy,
    weight: nullableNumber(row.__weight),
    createdAt: nullableString(row.__created_at),
  };
}

function matchesValue<T extends string>(
  actual: T,
  expected: T | readonly T[] | undefined,
): boolean {
  const expectedValues = values(expected);
  return expectedValues.length === 0 || expectedValues.includes(actual);
}

function endpointMatches(
  edgeKind: string,
  edgeId: string,
  filter: RelationEndpointFilter | undefined,
): boolean {
  if (filter === undefined) return true;
  if (filter.kind !== undefined && edgeKind !== filter.kind) return false;
  if (filter.id !== undefined && edgeId !== String(filter.id)) return false;
  return true;
}

function matchesEdgeFilter(
  edge: UnifiedRelationEdge,
  filter: RelationEdgeFilter | undefined,
): boolean {
  if (filter === undefined) return true;
  if (!matchesValue(edge.tableName as RelationTableName, filter.tableName)) return false;
  if (!matchesValue(edge.layer, filter.layer)) return false;
  if (!matchesValue(edge.relation, filter.relation)) return false;
  if (!endpointMatches(edge.sourceKind, edge.sourceId, filter.source)) return false;
  if (!endpointMatches(edge.targetKind, edge.targetId, filter.target)) return false;
  if (filter.around !== undefined) {
    const id = String(filter.around.id);
    const sourceHit = edge.sourceKind === filter.around.kind && edge.sourceId === id;
    const targetHit = edge.targetKind === filter.around.kind && edge.targetId === id;
    if (!sourceHit && !targetHit) return false;
  }
  return true;
}

export function* streamRelationEdges(
  db: Database,
  filter?: RelationEdgeFilter,
): Generator<UnifiedRelationEdge> {
  for (const spec of filterSpecs(filter)) {
    if (!hasRelationTable(db, spec.tableName)) continue;
    const select = relationSelectSql(spec, filter);
    // fixed kind 가 filter 와 어긋나는 spec 은 한 행도 못 맞춰 select 가 null 이다 → 건너뛴다.
    if (select === null) continue;
    const rows = db.prepare(select.sql).all(...select.params) as RelationRow[];
    for (const row of rows) {
      const edge = rowToEdge(spec, row);
      if (matchesEdgeFilter(edge, filter)) yield edge;
    }
  }
}

export function listRelationEdges(
  db: Database,
  filter?: RelationEdgeFilter,
): UnifiedRelationEdge[] {
  return [...streamRelationEdges(db, filter)];
}
