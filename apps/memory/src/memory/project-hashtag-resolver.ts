/**
 * project-hashtag-resolver.ts — `#프로젝트:...` 에서 project_id 를 얻는 좁은 통로.
 *
 * 문서·이미지처럼 원본 노드를 저장하기 전에 project_id 가 필요한 입력 경로가 쓴다.
 * full entity wiring 을 태우지 않아 사람·라벨 등 다른 엔티티를 새로 만들지 않고,
 * 기존 프로젝트 선언 규칙(사슬 끝-실체·분류 폴더 gate·별칭 모호성)만 공유한다.
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import { parseHashtagEntities } from "./parsers/hashtag-entity-parser.ts";
import { planProjectAttachment } from "./project-attachment-plan.ts";
import { ambiguousProjectNameWarning } from "./project-name-lookup.ts";

export {
  decideProjectDeclaration,
  type ProjectDeclarationDecision,
} from "./project-attachment-plan.ts";

export interface ProjectDeclarationResolution {
  projectId: string | null;
  warnings: string[];
  touched: boolean;
}

/**
 * 프로젝트 선언을 글에 붙인다. 붙일지·어디에 붙일지는 planProjectAttachment(저장 전 예측과 같은 함수)가
 * 정하고, 여기서는 그 계획대로 기존 프로젝트에 붙이거나(existing), 만들어 붙이거나(new), 붙이지 않는다.
 */
export async function resolveProjectDeclaration(
  store: SqliteMemoryStore,
  content: string,
  projectDeclarations: string[],
  originNodeId: number | null,
): Promise<ProjectDeclarationResolution> {
  const result: ProjectDeclarationResolution = {
    projectId: null,
    warnings: [],
    touched: false,
  };
  const plan = await planProjectAttachment(store, content, projectDeclarations);
  if (plan.kind === "none") return result;
  if (plan.kind === "not_attached") {
    result.warnings.push(plan.reason === "ends_in_category"
      ? `프로젝트 사슬이 분류 폴더/중간 마디 '${plan.name}' 에서 끝나 1급 project 행을 만들지 않음(개념·위계만)`
      : ambiguousProjectNameWarning(plan.name));
    return result;
  }

  const projectId = plan.kind === "existing"
    ? plan.projectId
    : (await store.findOrCreateProject({ name: plan.name })).projectId;
  result.projectId = projectId;
  if (originNodeId !== null) {
    await store.setNodeProjectId(originNodeId, projectId);
  }
  result.touched = true;
  if (projectDeclarations.length > 1) {
    result.warnings.push(
      `프로젝트 선언이 ${projectDeclarations.length}개 — ` +
        `첫 선언 '${plan.name}' 만 이 글에 연결`,
    );
  }
  return result;
}

export async function resolveProjectIdFromHashtagContent(
  store: SqliteMemoryStore,
  content: string,
): Promise<{ projectId: string | null; warnings: string[] }> {
  const parsed = parseHashtagEntities(content);
  const resolved = await resolveProjectDeclaration(
    store,
    content,
    parsed.projectDeclarations,
    null,
  );
  return { projectId: resolved.projectId, warnings: resolved.warnings };
}
