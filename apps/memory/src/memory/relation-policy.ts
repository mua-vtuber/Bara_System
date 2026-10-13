import { SEED_RELATION_NAMES } from "./entity-relation-vocabulary.ts";
import type { RelationTableName } from "./relation-registry.ts";

/**
 * Standard relation/role vocabulary shared by graph tables.
 *
 * This is a code-level policy list only. The DB intentionally keeps TEXT
 * columns unconstrained so future vocabulary additions do not require schema
 * migrations. check-relations reports values outside these lists; it does not
 * block writes or repair rows.
 */
export const STANDARD_KNOWLEDGE_EDGE_RELATIONS = [
  "supersedes",
  "related_to",
  "merged_into",
  "contradicts",
  "links_to",
  // Document chunks and generated image captions use node -> parent links here.
  "parent_of",
] as const;

export const STANDARD_NODE_CONCEPT_ROLES = [
  "tag",
  "classification",
  "mention",
  // SigLIP image-concept linking keeps visual matches separate from hand tags.
  "visual",
  // Some graph grouping fixtures and old rows may carry identity on node edges.
  "identity",
] as const;

export const STANDARD_NODE_PERSON_RELATIONS = [
  "authored_by",
  "mentions",
] as const;

export const STANDARD_CONCEPT_EDGE_RELATIONS = [
  "parent_of",
  "llm_relation",
  "has_attribute",
] as const;

export const STANDARD_ENTITY_CONCEPT_ROLES = [
  "tag",
  "classification",
  "identity",
  // Repository comments reserve this role for shared entity/person attributes.
  "has_attribute",
] as const;

export const STANDARD_HIERARCHY_RELATIONS = ["parent_of"] as const;

export const STANDARD_RELATION_NAMES = [
  ...new Set([
    ...SEED_RELATION_NAMES,
    ...STANDARD_KNOWLEDGE_EDGE_RELATIONS,
    ...STANDARD_NODE_CONCEPT_ROLES,
    ...STANDARD_NODE_PERSON_RELATIONS,
    ...STANDARD_CONCEPT_EDGE_RELATIONS,
    ...STANDARD_ENTITY_CONCEPT_ROLES,
    ...STANDARD_HIERARCHY_RELATIONS,
  ]),
] as const;

export type StandardRelationName = string;

const STANDARD_RELATION_NAME_SET = new Set<string>(STANDARD_RELATION_NAMES);

export type RelationPolicyTable = RelationTableName;
export type RelationPolicyColumn = "relation" | "role";

export function standardNamesForRelationColumn(
  table: RelationPolicyTable,
  column: "relation" | "role",
  extraEntityRelationNames: Iterable<string> = [],
): ReadonlySet<string> {
  if (table === "knowledge_edges" && column === "relation") {
    return new Set(STANDARD_KNOWLEDGE_EDGE_RELATIONS);
  }
  if (table === "node_concept_edges" && column === "role") {
    return new Set(STANDARD_NODE_CONCEPT_ROLES);
  }
  if (table === "node_person_edges" && column === "relation") {
    return new Set(STANDARD_NODE_PERSON_RELATIONS);
  }
  if (table === "concept_edges" && column === "relation") {
    return new Set(STANDARD_CONCEPT_EDGE_RELATIONS);
  }
  if (table === "entity_concept_edges" && column === "role") {
    return new Set(STANDARD_ENTITY_CONCEPT_ROLES);
  }
  if (table === "entity_relation_edges" && column === "relation") {
    return new Set([...SEED_RELATION_NAMES, ...extraEntityRelationNames]);
  }
  if (table === "hierarchy_edges" && column === "relation") {
    return new Set(STANDARD_HIERARCHY_RELATIONS);
  }
  return STANDARD_RELATION_NAME_SET;
}

export type RelationNameCheck =
  | { ok: true; relation: string }
  | {
      ok: false;
      relation: string | null;
      reason: "non_string" | "empty" | "non_standard";
    };

export function normalizeRelationName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const relation = raw.trim();
  return relation.length > 0 ? relation : null;
}

export function isStandardRelationName(raw: string): boolean {
  return STANDARD_RELATION_NAME_SET.has(raw);
}

export function checkRelationName(
  raw: unknown,
  allowedNames: ReadonlySet<string> = STANDARD_RELATION_NAME_SET,
): RelationNameCheck {
  if (typeof raw !== "string") {
    return { ok: false, relation: null, reason: "non_string" };
  }
  const relation = normalizeRelationName(raw);
  if (relation === null) {
    return { ok: false, relation: null, reason: "empty" };
  }
  if (!allowedNames.has(relation)) {
    return { ok: false, relation, reason: "non_standard" };
  }
  return { ok: true, relation };
}

export function checkRelationNameForTable(
  table: RelationPolicyTable,
  column: RelationPolicyColumn,
  raw: unknown,
  extraEntityRelationNames: Iterable<string> = [],
): RelationNameCheck {
  return checkRelationName(
    raw,
    standardNamesForRelationColumn(table, column, extraEntityRelationNames),
  );
}

export function relationWriteWarningMessage(
  table: RelationPolicyTable,
  column: RelationPolicyColumn,
  raw: unknown,
  extraEntityRelationNames: Iterable<string> = [],
): string | null {
  const check = checkRelationNameForTable(
    table,
    column,
    raw,
    extraEntityRelationNames,
  );
  if (check.ok) return null;
  const value = check.relation ?? String(raw);
  return `[relation-policy] non-standard ${table}.${column}: ${value} (${check.reason})`;
}

/**
 * 비표준 관계명을 console.warn 으로만 알리는 약한 검증 경로다(쓰기를 막지 않는다).
 *
 * entity_relation_edges 쓰기는 이 경로를 의도적으로 거치지 않는다 — repository 의
 * addEntityRelationEdge 가 쓰기 직전 assertRelationName 으로 strict 검증을 해서,
 * 허용 목록 밖 관계명이면 식별자와 함께 loud throw 로 멈춘다. entity_relation_edges
 * 는 어느 타입 행이든 가리키는 polymorphic 테이블이라 단일 칸 FK 를 둘 수 없고, 그래서
 * DB 가 잘못된 관계를 막아 주지 못한다. FK 없는 이 테이블은 약한 경고로 흘려보내는 대신
 * 동적 화이트리스트(seed + 사용자 등록 관계명) 기반의 강한 단언으로 끊는 것이 옳다.
 * 여기에 warn 까지 더하면 더 약하고 부정확한 중복 검증이 되어 오히려 퇴보한다.
 */
export function warnOnRelationPolicy(
  table: RelationPolicyTable,
  column: RelationPolicyColumn,
  raw: unknown,
  extraEntityRelationNames: Iterable<string> = [],
): void {
  const message = relationWriteWarningMessage(
    table,
    column,
    raw,
    extraEntityRelationNames,
  );
  if (message !== null) console.warn(message);
}
