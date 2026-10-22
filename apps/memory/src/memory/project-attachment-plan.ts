/**
 * memory/project-attachment-plan.ts — 이 글이 저장되면 어느 프로젝트에 붙는지 저장 *전에* 정하는 단일 출처
 * (2026-10-21 mcp-usage-and-guidance spec 20.3).
 *
 * 저장 경로(resolveProjectDeclaration)는 이 계획대로 붙이고, 저장 전 쪽(근거 기억 프로젝트 검사, 해시태그 경고의
 * 애매함 확인)은 같은 계획으로 결과를 미리 본다 — 판정 출처가 하나라 예측과 실제가 어긋나지 않는다.
 * 예외: wireHashtagEntitiesSafe 가 실패를 삼키면 붙이는 단계가 아예 돌지 않는다(기존 구조, spec 20.11).
 *
 * 판정 순서: 프로젝트 선언(parseHashtagEntities) → 첫 선언의 사슬 끝 이름과 "행을 만들지 않음" 판정
 * (decideProjectDeclaration) → 만들 사슬이면 resolveProjectName(이름·별칭)으로 기존·애매·새로 가른다.
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import { classifyEntityTypeDeterministic } from "./entity-type-classifier.ts";
import {
  buildForwardChainSubContent,
  resolveChainLeafValue,
  isMidChainNode,
} from "./entity-placement-loop.ts";
import { shouldCreateEntityRow } from "./entity-row-gate.ts";
import { parseHashtagEntities } from "./parsers/hashtag-entity-parser.ts";
import { projectGroupForWrite, type WriteProjectGroup } from "./project-scope-resolver.ts";
import { toNfc } from "./nfc.ts";
import { resolveProjectName } from "./project-name-lookup.ts";

/** 프로젝트 선언 판정 — planProjectAttachment 의 store 를 보지 않는 앞 단계. */
export interface ProjectDeclarationDecision {
  /** 쓰이는 선언(첫 번째) — `#프로젝트:` 바로 뒤 값. */
  declared: string;
  /** 사슬을 끝까지 따라간 끝 값 — 만들거나 찾을 프로젝트 이름. */
  projectName: string;
  /** false = 사슬이 분류 폴더·중간 마디에서 끝나 프로젝트 행을 만들지 않는다. */
  create: boolean;
}

/**
 * store 를 보지 않는 앞 단계 판정 — 사슬 끝 값과 "행을 만들지 않음" 여부. 선언이 없으면 null.
 * 해시태그 경고(hashtag-chain-check.ts)가 저장 때와 같은 판정을 보도록 resolveProjectDeclaration
 * 에서 떼어 낸 순수 함수다(동작 변화 없음).
 */
export function decideProjectDeclaration(
  content: string,
  projectDeclarations: readonly string[],
): ProjectDeclarationDecision | null {
  if (projectDeclarations.length === 0) return null;
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
  return {
    declared: declaredProject,
    projectName,
    create: projGate.create && !chainEndsInCategory,
  };
}


export type ProjectAttachmentPlan =
  | { kind: "none" }
  | { kind: "not_attached"; reason: "ends_in_category" | "ambiguous"; name: string }
  | { kind: "existing"; projectId: string; name: string }
  | { kind: "new"; name: string };

/**
 * 이 글의 프로젝트 사슬이 저장 때 어떻게 붙는지. projectDeclarations 를 주지 않으면 글에서 직접 뽑는다
 * (저장 경로는 이미 뽑은 선언을 넘긴다). 조회 실패는 그대로 던진다.
 */
export async function planProjectAttachment(
  store: SqliteMemoryStore,
  content: string,
  projectDeclarations: readonly string[] = parseHashtagEntities(content).projectDeclarations,
): Promise<ProjectAttachmentPlan> {
  const decision = decideProjectDeclaration(content, projectDeclarations);
  if (decision === null) return { kind: "none" };
  if (!decision.create) return { kind: "not_attached", reason: "ends_in_category", name: decision.projectName };
  const resolved = await resolveProjectName(store, decision.projectName);
  if (resolved.kind === "ambiguous") return { kind: "not_attached", reason: "ambiguous", name: decision.projectName };
  if (resolved.kind === "existing") return resolved;
  return { kind: "new", name: decision.projectName };
}

/** 저장될 프로젝트 예측(spec 20.3 표). */
export interface WriteProjectPrediction {
  plan: ProjectAttachmentPlan;
  /** 저장될 프로젝트가 어디서 왔나 — 사슬, project 인자, 없음(전역). */
  source: "chain" | "argument" | "none";
  /** 같은 프로젝트로 보는 저장 값 묶음. 전역이면 null. */
  group: WriteProjectGroup | null;
  /** 사슬이 다른 프로젝트의 project 인자를 덮어쓰면 그 인자 값. */
  overriddenArgument: string | null;
}

/**
 * 이 기억이 저장될 프로젝트. 사슬이 붙으면 사슬(지금 실제로 저장되는 값과 같다), 아니면 project 인자,
 * 둘 다 없으면 전역. projectArgument 는 저장 경로와 같이 normalizeProjectId 를 거친 값. plan 을 주면
 * 다시 조회하지 않는다(잠금 밖 1회 계산을 넘길 때).
 */
export async function predictWriteProject(
  store: SqliteMemoryStore,
  content: string,
  projectArgument: string | null,
  plan?: ProjectAttachmentPlan,
): Promise<WriteProjectPrediction> {
  const attachment = plan ?? await planProjectAttachment(store, content);
  const argumentGroup = projectArgument === null
    ? null
    : await projectGroupForWrite(store, { kind: "value", value: projectArgument });
  if (attachment.kind === "none" || attachment.kind === "not_attached") {
    return {
      plan: attachment, source: argumentGroup === null ? "none" : "argument", group: argumentGroup, overriddenArgument: null,
    };
  }
  const chainGroup = attachment.kind === "existing"
    ? await projectGroupForWrite(store, { kind: "value", value: attachment.projectId })
    : await projectGroupForWrite(store, { kind: "new_project", name: attachment.name });
  const sameAsArgument = projectArgument === null
    || argumentGroup!.projectIds.some((value) => chainGroup.projectIds.includes(value))
    || (attachment.kind === "new" && toNfc(projectArgument).trim() === toNfc(attachment.name).trim());
  return {
    plan: attachment, source: "chain", group: chainGroup, overriddenArgument: sameAsArgument ? null : projectArgument,
  };
}
