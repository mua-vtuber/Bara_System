/**
 * server-internal/classification-vocabulary.ts — 지금 쓰이는 분류 값·프로젝트 목록
 * (2026-10-21 mcp-usage-and-guidance spec 12.3). get_usage_guide 응답이 싣는다.
 *
 * "기존 값을 재사용하라"는 지침을 AI 가 실제로 따를 수 있게, 저장소에 있는 분류 사슬 뿌리와 그 자식,
 * 프로젝트(번호·이름·별칭·함께 읽히는 옛 글자값)를 돌려준다.
 *
 * - 분류 뿌리: concept_nodes 중 분류 키(is_classification_key = 1)이면서 다른 개념의 자식(hierarchy_edges
 *   parent_of 의 concept 대상)이 아닌 것. 사용 횟수(classification_usage_count + tag_usage_count) 많은 순.
 *   기존 listConcepts 는 5000개 상한·태그 사용 순 정렬이라 뿌리를 빠짐없이 고르지 못해 SQL 로 직접 고른다.
 * - 자식: 뿌리가 부모인 parent_of 대상 중 개념(concept)만. 실제 저장 결과로 확인한 위계 줄 모양은
 *   concept→concept(#일상:건강) 과 concept→project(#코딩:bara_system 의 끝 실체) 두 가지이고, 프로젝트는
 *   아래 projects 목록이 따로 보여 주므로 분류 자식에는 개념만 싣는다.
 * - 프로젝트: 프로젝트 실체 전부 + 실체에 묶이지 않는 옛 글자값. 묶음 규칙은 범위 해석기와 같은
 *   legacyProjectValues(memory/project-scope-resolver.ts) — 안내가 보여 주는 묶음 = 실제 범위 해석.
 *   기억 수는 파생 노드(SHARED_MEMORY_DERIVED_SOURCE_TYPES)를 뺀다.
 *
 * 조회 실패는 그대로 던진다(호출자가 도구 오류 INTERNAL 로 돌려준다) — 빈 목록으로 가리지 않는다.
 * 진짜 0개면 빈 배열이다.
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import { PROJECT_TYPE_NAME } from "../db/store-internal/project-repository.ts";
import { ENTITY_LIST_LIMIT_MAX } from "../db/store-internal/entities-repository.ts";
import { legacyProjectValues } from "../memory/project-scope-resolver.ts";
import { SHARED_MEMORY_DERIVED_SOURCE_TYPES } from "../memory/shared-memory-contract.ts";

/** 응답 상한 — 넘치면 앞에서부터 이만큼과 truncated: true. */
export const CLASSIFICATION_VOCABULARY_LIMITS = Object.freeze({
  roots: 30,
  childrenPerRoot: 15,
  projects: 50,
});

/** 프로젝트 실체를 읽어 오는 최대 개수 — entitiesRepo.list 의 상한 그대로. */
const PROJECT_SCAN_MAX = ENTITY_LIST_LIMIT_MAX;

export interface ClassificationValue {
  name: string;
  uses: number;
}

export interface ClassificationRoot extends ClassificationValue {
  children: ClassificationValue[];
}

export interface ProjectVocabularyValue {
  /** prj_ 번호. 실체 없는 옛 글자값이면 null. */
  projectId: string | null;
  /** 실체 이름 또는 옛 글자값. */
  name: string;
  aliases: string[];
  /** 이 프로젝트로 함께 묶여 읽히는 옛 글자값. */
  legacyValues: string[];
  /** 묶인 값 전부의 기억 수(파생 노드 제외). */
  memories: number;
}

export interface ClassificationVocabulary {
  classifications: { roots: ClassificationRoot[]; truncated: boolean };
  projects: { values: ProjectVocabularyValue[]; truncated: boolean };
  limits: typeof CLASSIFICATION_VOCABULARY_LIMITS;
}

const CONCEPT = "concept";
const PARENT_OF = "parent_of";

function readRoots(store: SqliteMemoryStore): { roots: ClassificationRoot[]; truncated: boolean } {
  const db = store.getRawDb();
  const limits = CLASSIFICATION_VOCABULARY_LIMITS;
  const rootRows = db.query(
    `SELECT c.concept_id AS id, c.name AS name, c.classification_usage_count + c.tag_usage_count AS uses
     FROM concept_nodes c
     WHERE c.is_classification_key = 1
       AND NOT EXISTS (
         SELECT 1 FROM hierarchy_edges h
         WHERE h.relation = ? AND h.source_type = ? AND h.target_type = ? AND h.target_id = c.concept_id
       )
     ORDER BY uses DESC, c.name
     LIMIT ?`,
  ).all(PARENT_OF, CONCEPT, CONCEPT, limits.roots + 1) as Array<{ id: string; name: string; uses: number }>;

  const childQuery = db.query(
    `SELECT c.name AS name, c.classification_usage_count + c.tag_usage_count AS uses
     FROM hierarchy_edges h JOIN concept_nodes c ON c.concept_id = h.target_id
     WHERE h.relation = ? AND h.source_type = ? AND h.source_id = ? AND h.target_type = ?
     ORDER BY uses DESC, c.name
     LIMIT ?`,
  );
  let truncated = rootRows.length > limits.roots;
  const roots: ClassificationRoot[] = [];
  for (const root of rootRows.slice(0, limits.roots)) {
    const children = childQuery.all(PARENT_OF, CONCEPT, root.id, CONCEPT, limits.childrenPerRoot + 1) as ClassificationValue[];
    if (children.length > limits.childrenPerRoot) truncated = true;
    roots.push({ name: root.name, uses: root.uses, children: children.slice(0, limits.childrenPerRoot) });
  }
  return { roots, truncated };
}

/** knowledge_nodes.project_id 값별 기억 수(파생 노드 제외). */
function memoriesByProjectValue(store: SqliteMemoryStore): Map<string, number> {
  const derived = SHARED_MEMORY_DERIVED_SOURCE_TYPES;
  const rows = store.getRawDb()
    // dynamic SQL: placeholder count follows the derived type list, keep prepare()
    .prepare(`SELECT project_id AS value, COUNT(*) AS n FROM knowledge_nodes
      WHERE project_id IS NOT NULL AND source_type NOT IN (${derived.map(() => "?").join(", ")})
      GROUP BY project_id`)
    .all(...derived) as Array<{ value: string; n: number }>;
  return new Map(rows.map((row) => [row.value, row.n]));
}

async function readProjects(store: SqliteMemoryStore): Promise<{ values: ProjectVocabularyValue[]; truncated: boolean }> {
  const counts = memoriesByProjectValue(store);
  const entities = await store.entitiesRepo.list(PROJECT_TYPE_NAME, { limit: PROJECT_SCAN_MAX });
  const claimed = new Set<string>();
  const values: ProjectVocabularyValue[] = [];
  for (const entity of entities) {
    const legacy = legacyProjectValues(store, { projectId: entity.id, ...entity });
    claimed.add(entity.id);
    for (const value of legacy) claimed.add(value);
    values.push({
      projectId: entity.id,
      name: entity.name,
      aliases: [...entity.koAliases, ...entity.enAliases],
      legacyValues: legacy,
      memories: [entity.id, ...legacy].reduce((sum, value) => sum + (counts.get(value) ?? 0), 0),
    });
  }
  for (const [value, memories] of counts) {
    if (claimed.has(value)) continue;
    values.push({ projectId: null, name: value, aliases: [], legacyValues: [], memories });
  }
  values.sort((a, b) => b.memories - a.memories || a.name.localeCompare(b.name));
  const limit = CLASSIFICATION_VOCABULARY_LIMITS.projects;
  return {
    values: values.slice(0, limit),
    truncated: values.length > limit || entities.length >= PROJECT_SCAN_MAX,
  };
}

export async function readClassificationVocabulary(store: SqliteMemoryStore): Promise<ClassificationVocabulary> {
  return {
    classifications: readRoots(store),
    projects: await readProjects(store),
    limits: CLASSIFICATION_VOCABULARY_LIMITS,
  };
}
