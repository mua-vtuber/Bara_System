/**
 * memory/project-name-lookup.ts — "이 이름은 어느 프로젝트인가"의 단일 출처 (2026-10-22 별칭 갈라짐 결함).
 *
 * 프로젝트 이름은 이름과 별칭을 함께 본다(store.findProjectByNameOrAlias). 글을 프로젝트에 붙이는 단계,
 * 그래프 배치, 관계 대상 해석, 행 생성 함수가 모두 이 함수를 거친다. 한 곳이라도 이름만 보고 행을 만들면
 * 별칭으로 쓴 이름이 같은 이름의 프로젝트를 하나 더 만들고, 그 뒤 저장부터 기억이 그쪽으로 갈라진다.
 * 다른 memory 모듈을 불러오지 않는다(entity-row-gate·project-attachment-plan 양쪽이 순환 없이 쓴다).
 */

import type { SqliteMemoryStore } from "../db/store.ts";

export type ProjectNameResolution =
  | { kind: "existing"; projectId: string; name: string }
  | { kind: "ambiguous" }
  | { kind: "missing" };

/** 이름이나 별칭이 맞는 프로젝트. 여러 프로젝트에 겹치면 ambiguous, 어디에도 없으면 missing. */
export async function resolveProjectName(
  store: SqliteMemoryStore,
  name: string,
): Promise<ProjectNameResolution> {
  const lookup = await store.findProjectByNameOrAlias(name);
  if (lookup.ambiguous) return { kind: "ambiguous" };
  if (lookup.project === null) return { kind: "missing" };
  return { kind: "existing", projectId: lookup.project.projectId, name: lookup.project.name };
}

/** 애매한 이름 경고 — 붙이는 단계와 그래프 배치가 같은 글을 써서 한 저장에서 한 줄로 합쳐진다. */
export function ambiguousProjectNameWarning(name: string): string {
  return `프로젝트 이름/별칭 '${name}' 이 2개+ 프로젝트에 겹쳐 모호 — 글에 붙이지 않고 새 프로젝트도 만들지 않음`;
}
