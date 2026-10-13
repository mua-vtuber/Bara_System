import type { Database } from "bun:sqlite";

export type RelationLayer =
  | "memory"
  | "concept"
  | "person"
  | "entity"
  | "hierarchy"
  | "classification";

export type RelationFkPolicy = "foreign_key" | "polymorphic_no_fk";
export type RelationColumnKind = "relation" | "role";
export type RelationTableName =
  | "knowledge_edges"
  | "node_concept_edges"
  | "node_person_edges"
  | "concept_edges"
  | "entity_concept_edges"
  | "entity_relation_edges"
  | "hierarchy_edges";

export type RelationEndpointKindRule =
  | { kind: "fixed"; value: "memory" | "concept" | "person" }
  | { kind: "id_prefix" }
  | { kind: "type_column"; column: string }
  | { kind: "entity_type_lookup"; fallbackKind: "entity" };

export interface RelationEndpointSpec {
  idColumn: string;
  kindRule: RelationEndpointKindRule;
}

export interface RelationTableSpec {
  tableName: RelationTableName;
  layer: RelationLayer;
  fkPolicy: RelationFkPolicy;
  source: RelationEndpointSpec;
  target: RelationEndpointSpec;
  relationColumn: {
    name: string;
    kind: RelationColumnKind;
  };
  provenanceColumn: string;
  sourceNodeIdColumn: string;
  weightColumn: string | null;
  createdAtColumn: string | null;
  duplicateTupleColumns: readonly string[];
  orderBy: readonly string[];
  reader: {
    tableAlias: string;
    fromSql: string;
    sourceKindSql?: string;
    targetKindSql?: string;
  };
}

export const RELATION_TABLE_SPECS = [
  {
    tableName: "knowledge_edges",
    layer: "memory",
    fkPolicy: "foreign_key",
    source: { idColumn: "source_id", kindRule: { kind: "fixed", value: "memory" } },
    target: { idColumn: "target_id", kindRule: { kind: "fixed", value: "memory" } },
    relationColumn: { name: "relation", kind: "relation" },
    provenanceColumn: "provenance",
    sourceNodeIdColumn: "source_node_id",
    weightColumn: "weight",
    createdAtColumn: "created_at",
    duplicateTupleColumns: ["source_id", "target_id", "relation"],
    orderBy: ["id"],
    reader: { tableAlias: "ke", fromSql: "knowledge_edges ke" },
  },
  {
    tableName: "node_concept_edges",
    layer: "concept",
    fkPolicy: "foreign_key",
    source: { idColumn: "node_id", kindRule: { kind: "fixed", value: "memory" } },
    target: { idColumn: "concept_id", kindRule: { kind: "fixed", value: "concept" } },
    relationColumn: { name: "role", kind: "role" },
    provenanceColumn: "provenance",
    sourceNodeIdColumn: "source_node_id",
    weightColumn: null,
    createdAtColumn: "created_at",
    duplicateTupleColumns: ["node_id", "concept_id", "role"],
    orderBy: ["node_id", "concept_id", "role"],
    reader: { tableAlias: "nce", fromSql: "node_concept_edges nce" },
  },
  {
    tableName: "node_person_edges",
    layer: "person",
    fkPolicy: "foreign_key",
    source: { idColumn: "node_id", kindRule: { kind: "fixed", value: "memory" } },
    target: { idColumn: "person_id", kindRule: { kind: "fixed", value: "person" } },
    relationColumn: { name: "relation", kind: "relation" },
    provenanceColumn: "provenance",
    sourceNodeIdColumn: "source_node_id",
    weightColumn: null,
    createdAtColumn: "created_at",
    duplicateTupleColumns: ["node_id", "person_id", "relation"],
    orderBy: ["node_id", "person_id", "relation"],
    reader: { tableAlias: "npe", fromSql: "node_person_edges npe" },
  },
  {
    tableName: "concept_edges",
    layer: "concept",
    fkPolicy: "polymorphic_no_fk",
    source: {
      idColumn: "source_concept_id",
      kindRule: { kind: "id_prefix" },
    },
    target: {
      idColumn: "target_concept_id",
      kindRule: { kind: "id_prefix" },
    },
    relationColumn: { name: "relation", kind: "relation" },
    provenanceColumn: "provenance",
    sourceNodeIdColumn: "source_node_id",
    weightColumn: "weight",
    createdAtColumn: "created_at",
    duplicateTupleColumns: ["source_concept_id", "target_concept_id", "relation"],
    orderBy: ["source_concept_id", "target_concept_id", "relation"],
    reader: { tableAlias: "ce", fromSql: "concept_edges ce" },
  },
  {
    tableName: "entity_concept_edges",
    layer: "classification",
    fkPolicy: "foreign_key",
    source: {
      idColumn: "entity_id",
      kindRule: { kind: "entity_type_lookup", fallbackKind: "entity" },
    },
    target: { idColumn: "concept_id", kindRule: { kind: "fixed", value: "concept" } },
    relationColumn: { name: "role", kind: "role" },
    provenanceColumn: "provenance",
    sourceNodeIdColumn: "source_node_id",
    weightColumn: "weight",
    createdAtColumn: "created_at",
    duplicateTupleColumns: ["entity_id", "concept_id", "role"],
    orderBy: ["entity_id", "concept_id", "role"],
    reader: {
      tableAlias: "ece",
      fromSql: "entity_concept_edges ece LEFT JOIN entities e ON e.entity_id = ece.entity_id",
      sourceKindSql: "e.type_name",
    },
  },
  {
    tableName: "entity_relation_edges",
    layer: "entity",
    fkPolicy: "polymorphic_no_fk",
    source: {
      idColumn: "source_id",
      kindRule: { kind: "type_column", column: "source_type" },
    },
    target: {
      idColumn: "target_id",
      kindRule: { kind: "type_column", column: "target_type" },
    },
    relationColumn: { name: "relation", kind: "relation" },
    provenanceColumn: "provenance",
    sourceNodeIdColumn: "source_node_id",
    weightColumn: "weight",
    createdAtColumn: "created_at",
    duplicateTupleColumns: ["source_type", "source_id", "target_type", "target_id", "relation"],
    orderBy: ["source_type", "source_id", "target_type", "target_id", "relation"],
    reader: { tableAlias: "ere", fromSql: "entity_relation_edges ere" },
  },
  {
    tableName: "hierarchy_edges",
    layer: "hierarchy",
    fkPolicy: "polymorphic_no_fk",
    source: {
      idColumn: "source_id",
      kindRule: { kind: "type_column", column: "source_type" },
    },
    target: {
      idColumn: "target_id",
      kindRule: { kind: "type_column", column: "target_type" },
    },
    relationColumn: { name: "relation", kind: "relation" },
    provenanceColumn: "provenance",
    sourceNodeIdColumn: "source_node_id",
    weightColumn: "weight",
    createdAtColumn: "created_at",
    duplicateTupleColumns: ["source_type", "source_id", "target_type", "target_id", "relation"],
    orderBy: ["source_type", "source_id", "target_type", "target_id", "relation"],
    reader: { tableAlias: "he", fromSql: "hierarchy_edges he" },
  },
] as const satisfies readonly RelationTableSpec[];

export const RELATION_TABLE_NAMES = RELATION_TABLE_SPECS.map(
  (spec) => spec.tableName,
) as RelationTableName[];

const SPEC_BY_TABLE = new Map<string, RelationTableSpec>(
  RELATION_TABLE_SPECS.map((spec) => [spec.tableName, spec]),
);

export function relationSpecByTable(tableName: string): RelationTableSpec | null {
  return SPEC_BY_TABLE.get(tableName) ?? null;
}

export function hasRelationTable(db: Database, tableName: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','virtual table') AND name = ?",
    )
    .get(tableName) as { ok: number } | null;
  return row !== null;
}

export function endpointKindFromId(id: string): string {
  if (id.startsWith("cpt_")) return "concept";
  if (id.startsWith("psn_")) return "person";
  if (id.startsWith("prj_")) return "project";
  if (id.startsWith("cre_")) return "creature";
  if (id.startsWith("thg_")) return "thing";
  if (id.startsWith("itk_")) return "intake";
  if (id.startsWith("usb_")) return "usable";
  if (id.startsWith("wrk_")) return "work";
  if (id.startsWith("mat_")) return "material";
  if (id.startsWith("plc_")) return "place";
  if (id.startsWith("sch_")) return "schedule";
  return "unknown";
}

export function endpointKindFromRow(
  endpoint: RelationEndpointSpec,
  row: Record<string, unknown>,
): string {
  const rule = endpoint.kindRule;
  if (rule.kind === "fixed") return rule.value;
  if (rule.kind === "id_prefix") {
    const id = row[endpoint.idColumn];
    return typeof id === "string" ? endpointKindFromId(id) : "unknown";
  }
  if (rule.kind === "type_column") {
    const value = row[rule.column];
    return typeof value === "string" && value.trim() ? value.trim() : "unknown";
  }
  const lookupKind = row[`${endpoint.idColumn}__kind`];
  return typeof lookupKind === "string" && lookupKind.trim()
    ? lookupKind.trim()
    : rule.fallbackKind;
}
