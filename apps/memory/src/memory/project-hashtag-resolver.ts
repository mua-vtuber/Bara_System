/**
 * project-hashtag-resolver.ts — `#프로젝트:...` 에서 project_id 를 얻는 좁은 통로.
 *
 * 문서·이미지처럼 원본 노드를 저장하기 전에 project_id 가 필요한 입력 경로가 쓴다.
 * full entity wiring 을 태우지 않아 사람·라벨 등 다른 엔티티를 새로 만들지 않고,
 * 기존 프로젝트 선언 규칙(사슬 끝-실체·분류 폴더 gate·별칭 모호성)만 공유한다.
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import {
  classifyEntityTypeDeterministic,
} from "./entity-type-classifier.ts";
import {
  buildForwardChainSubContent,
  resolveChainLeafValue,
  isMidChainNode,
} from "./entity-placement-loop.ts";
import { shouldCreateEntityRow } from "./entity-row-gate.ts";
import { parseHashtagEntities } from "./parsers/hashtag-entity-parser.ts";

export interface ProjectDeclarationResolution {
  projectId: string | null;
  warnings: string[];
  touched: boolean;
}

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
  if (projectDeclarations.length === 0) return result;

  const declaredProject = projectDeclarations[0]!;
  const projectName = resolveChainLeafValue(declaredProject, content);
  const projGate = shouldCreateEntityRow({
    typeName: "project",
    candidateName: projectName,
    source: "explicit",
    hasAttributes: false,
    subcategory: null,
    isMidChainNode: isMidChainNode(projectName, content),
  });
  const projectChainClassification = classifyEntityTypeDeterministic(
    buildForwardChainSubContent(
      { rawCategory: "프로젝트", value: declaredProject },
      content,
      new Set(),
    ),
  );
  const chainEndsInCategory =
    projectChainClassification.typeName === "project" &&
    projectChainClassification.chainStop?.reason === "ended-in-category";
  if (!projGate.create || chainEndsInCategory) {
    result.warnings.push(
      `프로젝트 사슬이 분류 폴더/중간 마디 '${projectName}' 에서 끝나 1급 project 행을 만들지 않음(개념·위계만)`,
    );
    return result;
  }

  const lookup = await store.findProjectByNameOrAlias(projectName);
  if (lookup.ambiguous) {
    result.warnings.push(
      `프로젝트 이름/별칭 '${projectName}' 이 2개+ 프로젝트에 겹쳐 모호 — project_id 미반영`,
    );
    return result;
  }

  const project = lookup.project ?? await store.findOrCreateProject({ name: projectName });
  result.projectId = project.projectId;
  if (originNodeId !== null) {
    await store.setNodeProjectId(originNodeId, project.projectId);
  }
  result.touched = true;
  if (projectDeclarations.length > 1) {
    result.warnings.push(
      `프로젝트 선언이 ${projectDeclarations.length}개 — ` +
        `첫 선언 '${projectName}' 만 이 글에 연결`,
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
