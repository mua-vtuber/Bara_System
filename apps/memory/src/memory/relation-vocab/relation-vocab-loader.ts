/**
 * relation-vocab-loader.ts — relation_vocabulary.yaml 기본 씨앗 로더 (분류 단계3 T7a).
 *
 * 통합 cross-type 관계명 기본 씨앗(기본 관계명 + 한국어 태그 키 매핑)을 yaml 에서 한 번
 * 읽어 RelationSpec 맵으로 빌드한다. concept-type-vocabulary.ts 의 readFileSync + yaml.parse
 * + 구체 에러 throw(silent fallback 금지) 양식 정합 — 미등록 타입·형식 불일치를 가리지 않는다.
 *
 * yaml 두 절:
 *   relations  — 관계명 → {sourceTypes, targetTypes, defaultTargetType}.
 *   tag_keys   — 한국어 태그 키 → 관계명(한 관계명에 키 여럿 가능).
 *
 * 산출 = `Map<태그키, RelationSpec>`(RELATION_TAG_KEYS 와 같은 모양). entity-relation-
 * vocabulary 의 코드 상수 씨앗(SEED_RELATION_TAG_KEYS)과 동행 테스트가 대조해 회귀 0 을
 * 가드한다. 이 모듈은 DB 접근 0 — 순수 파일 읽기·파싱이다.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { PlacementTypeName } from "../concept-type-vocabulary.ts";

/** 관계 태그 한 키의 명세 — entity-relation-vocabulary 의 RelationSpec 과 같은 모양. */
export interface SeedRelationSpec {
  relation: string;
  sourceTypes: PlacementTypeName[];
  targetTypes: PlacementTypeName[];
  defaultTargetType: PlacementTypeName;
}

/** yaml relations 절 한 항목의 raw 형태(파싱 전 검증용). */
interface RelationBody {
  sourceTypes: PlacementTypeName[];
  targetTypes: PlacementTypeName[];
  defaultTargetType: PlacementTypeName;
}

const YAML_FILENAME = "relation_vocabulary.yaml";

/** 기본 씨앗 모듈 캐시 — process 안 한 번 로드. resetRelationVocabSeedCache 가 비운다. */
let cachedSeed: Map<string, SeedRelationSpec> | null = null;

function operationalPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", YAML_FILENAME);
}

function requireStringArray(val: unknown, field: string, key: string, path: string): string[] {
  if (!Array.isArray(val) || !val.every((x) => typeof x === "string")) {
    throw new Error(
      `relation-vocab-loader: '${key}.${field}' 가 문자열 배열이 아님 (${path})`,
    );
  }
  return val as string[];
}

/**
 * relation_vocabulary.yaml 을 파싱해 `Map<태그키, SeedRelationSpec>` 으로 빌드한다.
 * relations 절로 관계명 명세를 읽고, tag_keys 절의 키마다 그 관계명 명세를 붙인다.
 * 미등록 관계명을 가리키는 태그 키·형식 불일치는 식별자 담아 throw(silent fallback 금지).
 */
export function parseRelationVocabulary(path: string): Map<string, SeedRelationSpec> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`relation-vocab-loader: 파일을 읽지 못함 (${path}): ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (e) {
    throw new Error(`relation-vocab-loader: yaml 파싱 실패 (${path}): ${(e as Error).message}`);
  }

  const root = parsed as { relations?: unknown; tag_keys?: unknown } | null;
  const relations = root?.relations;
  if (!relations || typeof relations !== "object" || Array.isArray(relations)) {
    throw new Error(`relation-vocab-loader: 'relations' 매핑이 없음 (${path})`);
  }
  const tagKeys = root?.tag_keys;
  if (!tagKeys || typeof tagKeys !== "object" || Array.isArray(tagKeys)) {
    throw new Error(`relation-vocab-loader: 'tag_keys' 매핑이 없음 (${path})`);
  }

  // relations 절 — 관계명 → RelationBody. defaultTargetType 이 targetTypes 안에 있는지 검증.
  const relBodies = new Map<string, RelationBody>();
  for (const [relName, body] of Object.entries(relations as Record<string, unknown>)) {
    const b = body as Record<string, unknown>;
    const sourceTypes = requireStringArray(b.sourceTypes, "sourceTypes", relName, path) as PlacementTypeName[];
    const targetTypes = requireStringArray(b.targetTypes, "targetTypes", relName, path) as PlacementTypeName[];
    if (typeof b.defaultTargetType !== "string") {
      throw new Error(`relation-vocab-loader: '${relName}.defaultTargetType' 가 문자열이 아님 (${path})`);
    }
    const defaultTargetType = b.defaultTargetType as PlacementTypeName;
    if (!targetTypes.includes(defaultTargetType)) {
      throw new Error(
        `relation-vocab-loader: '${relName}' 의 defaultTargetType '${defaultTargetType}' 가 targetTypes 안에 없음 (거짓 기본 타입) (${path})`,
      );
    }
    relBodies.set(relName, { sourceTypes, targetTypes, defaultTargetType });
  }

  // tag_keys 절 — 한국어 키 → 관계명. 그 관계명 명세를 SeedRelationSpec 으로 붙인다.
  const out = new Map<string, SeedRelationSpec>();
  for (const [tagKey, relNameRaw] of Object.entries(tagKeys as Record<string, unknown>)) {
    if (typeof relNameRaw !== "string") {
      throw new Error(`relation-vocab-loader: tag_keys '${tagKey}' 값이 관계명 문자열이 아님 (${path})`);
    }
    const body = relBodies.get(relNameRaw);
    if (!body) {
      throw new Error(
        `relation-vocab-loader: tag_keys '${tagKey}' 가 가리키는 관계명 '${relNameRaw}' 가 relations 절에 없음 (${path})`,
      );
    }
    out.set(tagKey, {
      relation: relNameRaw,
      sourceTypes: body.sourceTypes,
      targetTypes: body.targetTypes,
      defaultTargetType: body.defaultTargetType,
    });
  }
  return out;
}

/**
 * 기본 씨앗 맵을 돌려준다. 인자 path 면 그 경로를 매번 파싱(fixture 용·캐시 미적용),
 * 없으면 운영 yaml 을 한 번 로드해 캐시한다(concept-type-vocabulary 양식).
 */
export function loadRelationVocabularySeed(path?: string): Map<string, SeedRelationSpec> {
  if (path) return parseRelationVocabulary(path);
  if (cachedSeed) return cachedSeed;
  cachedSeed = parseRelationVocabulary(operationalPath());
  return cachedSeed;
}

/** 씨앗 모듈 캐시를 비운다(테스트·yaml 직접 편집 후 재로드). */
export function resetRelationVocabSeedCache(): void {
  cachedSeed = null;
}
