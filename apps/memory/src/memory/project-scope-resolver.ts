/**
 * memory/project-scope-resolver.ts — 기억 읽기 범위(scope.projectId) 해석기 (2026-10-21 spec 10.1).
 *
 * 문제: 범위 비교가 문자열 완전 일치였다. 해시태그 사슬로 저장한 기억은 project_id 가
 * 프로젝트 번호(prj_…)이고, store_memory 의 project 인자로 저장한 기억은 글자값
 * ("bara_system")이라, AI 가 프로젝트 이름으로 범위를 주면 사슬 기억이 빠졌다.
 *
 * 해석 순서(v = scope.projectId, 앞뒤 공백 제거·NFC):
 *   1. scope 없음 → 입구별 기본값("unfiltered" = 거름 없음, "global" = 프로젝트 없는 기억만)
 *   2. v === null → 전역
 *   3. v 가 프로젝트 번호와 정확히 같음 → 그 프로젝트
 *   4. 이름 → 별칭(store.findProjectByNameOrAlias, 기존 규칙 그대로) — 모호하면 오류
 *   5. 프로젝트는 없지만 project_id = v 인 기억이 있음 → 옛 글자값 단독 범위
 *   6. 그 밖 → UNKNOWN_PROJECT 오류(빈 결과·전역 대체 금지)
 * 3·4 에서 찾은 프로젝트는 번호 + 그 프로젝트의 이름·별칭과 같은 옛 글자값 중 실제로
 * 쓰이는 것을 함께 본다(legacyProjectValues). 저장된 값은 다시 쓰지 않는다(spec P15).
 *
 * 해석 결과는 요청 하나 안에서만 쓴다(캐시 없음 — 새 프로젝트가 즉시 반영된다).
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import { PROJECT_TYPE_NAME } from "../db/store-internal/project-repository.ts";
import { toNfc } from "./nfc.ts";
import type { MemoryReadScope, ResolvedMemoryScope } from "./shared-memory-contract.ts";

export type { ResolvedMemoryScope } from "./shared-memory-contract.ts";

export const PROJECT_SCOPE_ERROR_CODES = ["UNKNOWN_PROJECT", "AMBIGUOUS_PROJECT"] as const;
export type ProjectScopeErrorCode = (typeof PROJECT_SCOPE_ERROR_CODES)[number];

export interface ProjectScopeCandidate {
  projectId: string;
  name: string;
}

/**
 * 범위 오류·안내 문구 단일 출처(spec 10.3·10.4). 소비자가 AI 라 영어다.
 * get_usage_guide 는 같은 배포에 들어가는 묶음 B 의 도구다(spec 17절 병합 순서).
 */
export const PROJECT_SCOPE_MESSAGES = {
  UNKNOWN_PROJECT: (value: string) =>
    `No project matches scope.projectId "${value}". Call get_usage_guide for project names and ids.`,
  AMBIGUOUS_PROJECT: (value: string, candidates: readonly ProjectScopeCandidate[]) =>
    `scope.projectId "${value}" matches more than one project: `
    + candidates.map((c) => `${c.projectId} (${c.name})`).join(", ")
    + ". Pass one of these projectIds instead.",
} as const satisfies Record<ProjectScopeErrorCode, (...args: never[]) => string>;

/** 범위 없이 부른 recall_context·get_profile 응답에 싣는 고정 안내(spec 10.4·P16). */
export const SCOPE_NOTE_WHEN_ABSENT =
  "No scope was given, so only memories outside any project were considered. "
  + "Pass scope.projectId (a project name works) to include a project's memories.";

/** 모르는·애매한 범위 값. 빈 결과나 전역으로 바꾸지 않고 값을 밝혀 실패한다. */
export class ProjectScopeError extends Error {
  readonly code: ProjectScopeErrorCode;
  readonly value: string;
  readonly candidates: readonly ProjectScopeCandidate[];

  constructor(code: "UNKNOWN_PROJECT", value: string);
  constructor(code: "AMBIGUOUS_PROJECT", value: string, candidates: readonly ProjectScopeCandidate[]);
  constructor(code: ProjectScopeErrorCode, value: string, candidates: readonly ProjectScopeCandidate[] = []) {
    super(code === "UNKNOWN_PROJECT"
      ? PROJECT_SCOPE_MESSAGES.UNKNOWN_PROJECT(value)
      : PROJECT_SCOPE_MESSAGES.AMBIGUOUS_PROJECT(value, candidates));
    this.name = "ProjectScopeError";
    this.code = code;
    this.value = value;
    this.candidates = candidates;
  }

  /** REST(400)·MCP(toolError) 가 함께 쓰는 { code, message, details } 본문. */
  toPayload(): { code: ProjectScopeErrorCode; message: string; details: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      details: this.code === "AMBIGUOUS_PROJECT"
        ? { value: this.value, candidates: this.candidates }
        : { value: this.value },
    };
  }
}

/** 범위가 없을 때 입구가 쓰는 기본값. "unfiltered" = 거름 없음(undefined 반환). */
export type ScopeDefaultWhenAbsent = "unfiltered" | "global";

/** 범위 없이 부른 recall_context·get_profile 의 기본 범위 — 프로젝트 없는 기억만(spec P16). */
export const GLOBAL_READ_SCOPE: ResolvedMemoryScope = Object.freeze({
  projectIds: null, includeGlobal: false, requested: null, resolvedFrom: "global", projectName: null,
});

/** 범위를 안 준 호출에만 scopeNote 칸을 싣는다(준 경우에는 칸 자체를 생략). */
export function scopeNoteFields(scope: MemoryReadScope | undefined): { scopeNote?: string } {
  return scope === undefined ? { scopeNote: SCOPE_NOTE_WHEN_ABSENT } : {};
}

/** 프로젝트 이름·별칭 — findByNameOrAlias 가 맞추는 바로 그 글자들(이름, 한·영 별칭). */
export interface ProjectLabels {
  name: string;
  koAliases: readonly string[];
  enAliases: readonly string[];
}

/**
 * 저장된 project_id 와 견줄 글자 형태. 비교 규칙은 findByNameOrAlias 와 같은 NFC 일치다.
 * 옛 글자값은 저장 때 NFC 로 바꾸지 않았으므로(normalizeProjectId 는 공백만 자름) NFD 로
 * 저장된 값도 같은 글자로 보려면 두 형태를 함께 찾는다(색인 조회를 그대로 쓰기 위함).
 */
function storedForms(values: Iterable<string>): string[] {
  const forms = new Set<string>();
  for (const value of values) {
    const nfc = toNfc(value).trim();
    if (nfc.length === 0) continue;
    forms.add(nfc);
    forms.add(nfc.normalize("NFD"));
  }
  return [...forms];
}

/** knowledge_nodes.project_id 로 실제로 쓰이는 값 중 forms 에 든 것(idx_knowledge_nodes_project). */
function usedProjectValues(store: SqliteMemoryStore, forms: readonly string[]): string[] {
  if (forms.length === 0) return [];
  const rows = store.getRawDb()
    // dynamic SQL: placeholder count varies, keep prepare()
    .prepare(`SELECT DISTINCT project_id FROM knowledge_nodes WHERE project_id IN (${forms.map(() => "?").join(", ")})`)
    .all(...forms) as Array<{ project_id: string }>;
  return rows.map((row) => row.project_id);
}

/**
 * 한 프로젝트로 함께 묶여 읽히는 옛 글자값 — 이름·별칭과 같은 글자로 실제 저장된 project_id.
 * 프로젝트 번호 자체는 넣지 않는다. 안내 도구(묶음 B)의 프로젝트 목록도 이 함수를 쓴다.
 */
export function legacyProjectValues(
  store: SqliteMemoryStore,
  project: { projectId: string } & ProjectLabels,
): string[] {
  const forms = storedForms([project.name, ...project.koAliases, ...project.enAliases])
    .filter((form) => form !== project.projectId);
  return usedProjectValues(store, forms).sort();
}

async function projectScope(
  store: SqliteMemoryStore,
  projectId: string,
  scope: MemoryReadScope,
  resolvedFrom: "project_id" | "project_name" | "project_alias",
): Promise<ResolvedMemoryScope> {
  const entity = await store.entitiesRepo.get(projectId);
  if (entity === null || entity.typeName !== PROJECT_TYPE_NAME) {
    throw new Error(`project-scope-resolver: 프로젝트 ${projectId} 를 다시 읽지 못했습니다`);
  }
  const legacy = legacyProjectValues(store, { projectId: entity.id, ...entity });
  return {
    projectIds: [entity.id, ...legacy],
    includeGlobal: scope.includeGlobal === true,
    requested: scope.projectId,
    resolvedFrom,
    projectName: entity.name,
  };
}

/**
 * 밖에서 받은 범위를 안쪽 형식으로 바꾼다. 모르는 값은 UNKNOWN_PROJECT, 둘 이상과
 * 겹치는 이름·별칭은 AMBIGUOUS_PROJECT 로 던진다.
 */
export function resolveMemoryReadScope(
  store: SqliteMemoryStore, scope: MemoryReadScope | undefined, defaultWhenAbsent: "global",
): Promise<ResolvedMemoryScope>;
export function resolveMemoryReadScope(
  store: SqliteMemoryStore, scope: MemoryReadScope | undefined, defaultWhenAbsent: ScopeDefaultWhenAbsent,
): Promise<ResolvedMemoryScope | undefined>;
export async function resolveMemoryReadScope(
  store: SqliteMemoryStore,
  scope: MemoryReadScope | undefined,
  defaultWhenAbsent: ScopeDefaultWhenAbsent,
): Promise<ResolvedMemoryScope | undefined> {
  if (scope === undefined) return defaultWhenAbsent === "global" ? GLOBAL_READ_SCOPE : undefined;
  if (scope.projectId === null) {
    return { ...GLOBAL_READ_SCOPE, includeGlobal: scope.includeGlobal === true };
  }
  const value = toNfc(scope.projectId).trim();
  if (value.length === 0) throw new ProjectScopeError("UNKNOWN_PROJECT", scope.projectId);

  const byId = await store.entitiesRepo.get(value);
  if (byId !== null && byId.typeName === PROJECT_TYPE_NAME) {
    return projectScope(store, byId.id, scope, "project_id");
  }

  const lookup = await store.findProjectByNameOrAlias(value);
  if (lookup.ambiguous) {
    if (lookup.candidates === undefined) {
      throw new Error(`project-scope-resolver: '${value}' 이 모호한데 후보 목록이 없습니다`);
    }
    throw new ProjectScopeError("AMBIGUOUS_PROJECT", scope.projectId, lookup.candidates);
  }
  if (lookup.project !== null) {
    const from = lookup.project.name === value ? "project_name" : "project_alias";
    return projectScope(store, lookup.project.projectId, scope, from);
  }

  const legacy = usedProjectValues(store, storedForms([value]));
  if (legacy.length > 0) {
    return {
      projectIds: legacy.sort(),
      includeGlobal: scope.includeGlobal === true,
      requested: scope.projectId,
      resolvedFrom: "legacy_value",
      projectName: null,
    };
  }
  throw new ProjectScopeError("UNKNOWN_PROJECT", scope.projectId);
}

/** 저장 쪽 "같은 프로젝트" 묶음(projectGroupForWrite 결과). */
export interface WriteProjectGroup {
  /** 이 프로젝트로 함께 읽히는 저장 값들 — 근거 기억의 project_id 가 여기 있으면 같은 프로젝트다. */
  projectIds: string[];
  /** 사람이 읽을 이름 — 프로젝트 이름, 없으면 글자값 그대로. */
  label: string;
  /** 프로젝트 실체 이름(실체를 정할 수 없으면 null). */
  projectName: string | null;
  /** 프로젝트 번호(실체를 정할 수 없거나 아직 없으면 null). */
  projectId: string | null;
}

/**
 * 저장 쪽 판정용 "같은 프로젝트" 묶음(2026-10-21 spec 20.4). 읽기 해석기(resolveMemoryReadScope)와 같은 규칙
 * — 번호 + 이름·별칭과 같은 옛 글자값(legacyProjectValues) — 을 쓰되, 모르는 값·애매한 값에서 던지지 않는다.
 * 저장은 그 글자값을 그대로 쓰기 때문이다.
 *   - prj_ 번호, 또는 이름·별칭이 프로젝트 하나와 맞는 값 → [번호, …옛 글자값, 그 값]
 *   - 이름·별칭이 둘 이상과 겹치는 값 → [그 값] (어느 프로젝트인지 정할 수 없다)
 *   - 프로젝트도 아닌 값 → [그 값, …같은 글자로 실제 쓰이는 값]
 *   - 사슬이 새로 만들 프로젝트(new_project) → 그 이름과 같은 글자로 실제 쓰이는 값들(번호는 아직 없다)
 */
export async function projectGroupForWrite(
  store: SqliteMemoryStore,
  target: { kind: "value"; value: string } | { kind: "new_project"; name: string },
): Promise<WriteProjectGroup> {
  if (target.kind === "new_project") {
    const name = toNfc(target.name).trim();
    return { projectIds: usedProjectValues(store, storedForms([name])).sort(), label: name, projectName: name, projectId: null };
  }
  const raw = target.value;
  const value = toNfc(raw).trim();
  const unique = (values: string[]) => [...new Set(values)].sort();
  const entityGroup = (entity: { id: string; name: string } & ProjectLabels): WriteProjectGroup => ({
    projectIds: unique([entity.id, ...legacyProjectValues(store, { projectId: entity.id, ...entity }), raw]),
    label: entity.name,
    projectName: entity.name,
    projectId: entity.id,
  });

  const byId = await store.entitiesRepo.get(value);
  if (byId !== null && byId.typeName === PROJECT_TYPE_NAME) return entityGroup(byId);
  const lookup = await store.findProjectByNameOrAlias(value);
  if (lookup.ambiguous) return { projectIds: [raw], label: raw, projectName: null, projectId: null };
  if (lookup.project !== null) {
    const entity = await store.entitiesRepo.get(lookup.project.projectId);
    if (entity === null || entity.typeName !== PROJECT_TYPE_NAME) {
      throw new Error(`project-scope-resolver: 프로젝트 ${lookup.project.projectId} 를 다시 읽지 못했습니다`);
    }
    return entityGroup(entity);
  }
  return {
    projectIds: unique([raw, ...usedProjectValues(store, storedForms([value]))]),
    label: raw, projectName: null, projectId: null,
  };
}
