/**
 * server-internal/routes/graph-nodes-shared.ts — 그래프 빌드 공유 토대.
 *
 * graph.ts(라우트)·graph-augment.ts·graph-group-nodes.ts·graph-absorb-same-label.ts·
 * graph-leaf-line.ts 가 함께 쓰는 응답 타입(GraphNode·GraphEdge…)·노드 키 빌더
 * (nodeKey·conceptKey·entityKey…)·표시 상수·노드 변환 헬퍼(toGraphNode 등)를 한곳에 모은다.
 * 책임 단위 분리(CLAUDE.md "파일 작게")로 graph.ts 에서 옮겨 왔다 — 동작 불변(순수 이동).
 *
 * 다른 graph-* 모듈은 모두 이 파일에 의존하고, 이 파일은 어느 graph-* 에도 의존하지 않는다
 * (순환 의존 차단). 쓰기 0 / 스키마 변경 0 / RRF 코어 변경 0.
 */

import type { MemoryNode, ConceptNode, Person, Project } from "../../memory/types.ts";
import {
  EN_ALIASES_ATTR_KEY,
  KO_ALIASES_ATTR_KEY,
  type EntityAttributeValue,
  type UserEntity,
} from "../../db/store-internal/entities-repository.ts";
import type { MemoryApiDeps } from "../types.ts";
import { computeNodeValue } from "../../memory/scoring.ts";
import { readDocumentChunkMetadata } from "../../memory/document-chunk-metadata.ts";
import { isProtected } from "../../memory/auto-cleanup-runner.ts";
import { representativeConceptType } from "../../memory/graph-concept-display.ts";
import { parseTags } from "../../memory/tag-extractor.ts";

// ── 상수 ──────────────────────────────────────────────────────────────────

export const DEFAULT_LIMIT = 60;
export const MAX_LIMIT = 200;

/** 한 노드에서 조회할 1-hop 이웃 엣지 상한. */
export const NEIGHBORS_PER_NODE = 8;

/** 그래프 노드 label 최대 글자 수. */
export const LABEL_MAX_CHARS = 31;

/** memory 노드 1개당 합류할 개념 엣지 상한 (과밀 조절). */
export const CONCEPTS_PER_NODE = 6;
/** memory 노드 1개당 합류할 사람 엣지 상한. */
export const PERSONS_PER_NODE = 4;
/** node→개념/사람 엣지의 표시 weight (원본 엣지에 weight 칸 없음 — 색·굵기용 기본). */
export const ENTITY_EDGE_WEIGHT = 0.6;
/** 개념끼리 llm_relation 관계선 표시 weight. */
export const CONCEPT_RELATION_WEIGHT = 0.7;

/** memory 노드 1개당 합류할 엔티티(신규 8 타입) 상한 (과밀 조절·CONCEPTS_PER_NODE 와 같은 정신). */
export const ENTITIES_PER_NODE = 6;
/** memory 노드 1개당 합류할 프로젝트 상한 (과밀 조절). 테스트가 import 해 검증한다. */
export const PROJECTS_PER_NODE = 4;
/** 엔티티 노드 ↔ 글(개념) 연결선 표시 weight (원본 엣지에 weight 없음 — 색·굵기 기본). */
export const ENTITY_NODE_EDGE_WEIGHT = 0.6;

/** 한 화면에 합류할 엔티티 관계선(entity_relation_edges) 상한. */
export const RELATION_EDGES_LIMIT = 80;
/** 엔티티끼리 관계선 표시 weight. */
export const ENTITY_RELATION_WEIGHT = 0.75;

/**
 * 검색 뷰(/graph/search) 관계선 펼침이 *새로* 끌어올 관계 상대 노드 총수 상한.
 *
 * 사용자가 이름으로 검색하면 그 엔티티에 걸린 관계 상대(작가↔작품)를 그래프로 끌어와
 * 점선으로 잇는다(revealSearchRelationEdges). 이 상한은 "새로 끌어온 노드 수"만 제한한다 —
 * 이미 노드 집합 안인 노드는 카운트하지 않는다(엣지 수는 RELATION_EDGES_LIMIT 도 함께
 * 존중한다). 한 화면 과밀·무한 확산을 막는 planner-chosen default. 라이브 sanity 에서
 * 사용자가 최종 확정한다.
 */
export const SEARCH_RELATION_PULL_LIMIT = 40;

/** 묶음→자식 소속 엣지 표시 weight (글 연결선과 같은 기본 굵기). */
export const MEMBER_OF_WEIGHT = 0.6;

/**
 * 프로젝트 → 글 허브 연결선의 엣지 type 문자열 단일 출처(하드코딩 금지).
 * web edges.ts 가 같은 값을 자기 단일 출처로 두고 전용 색으로 가른다(브라우저
 * 번들에 서버 모듈을 import 하지 않으므로 두 곳이 같은 문자열을 각자 보유).
 */
export const OWNS_MEMORY_EDGE_TYPE = "owns_memory";
/**
 * 글 → 1급 엔티티(works 행) 구조 간선의 엣지 type 문자열 단일 출처(하드코딩 금지).
 *
 * graph-augment 가 분리 잎 개념을 거쳐 합류한 works 행을 글의 주 부모로 승격할 때
 * 이 type 으로 간선을 그린다. buildHierarchy(radial-hierarchy.ts)는 이 type 을
 * STRUCTURAL_PRIORITY 70(parent_of 40 < 70 < member_of 90 < owns_memory 100)으로
 * 받아, 글이 매체 허브(소설) mention 60 이 아니라 자기 works 행 아래 직접 매달리게 한다.
 * from = works 행(부모) · to = 글(자식) 컨벤션(PARENT_IS_FROM).
 *
 * web edges.ts 가 같은 값을 자기 단일 출처로 두고 전용 색으로 가른다(브라우저 번들에
 * 서버 모듈을 import 하지 않으므로 두 곳이 같은 문자열을 각자 보유 — OWNS_MEMORY 양식).
 */
export const MENTION_ENTITY_EDGE_TYPE = "mentions_entity";
/**
 * 사람 주체 글(node_person_edges 보유)의 글 → works 행 곁다리 간선 type 단일 출처
 * (하드코딩 금지·plan G4·Q2-4).
 *
 * 사람 주체 글(#사람: 선언이 글→person mention 을 만든 글)은 작품을 mention 하되 작품이
 * 글의 주 부모가 되면 안 된다(주 부모 = 사람). 그래서 글→works 행 간선을 부모 승격
 * type(MENTION_ENTITY_EDGE_TYPE·prio 70) 대신 이 비부모 type 으로 emit 한다. 이 문자열은
 * radial-hierarchy.ts 의 PARENT_IS_FROM·PARENT_IS_TO 어디에도 들지 않으므로 buildHierarchy
 * 가 부모 후보로 쓰지 않고 cross-edge(곁다리 선)로만 남긴다. 그러면 글의 주 부모가 글→사람
 * mention(60) 이 되고 작품과는 옆 연결만 유지된다. web edges.ts 의 edgeKind 도 이 미등록
 * type 을 memory_link(글 연결선 색)로 자동 처리하므로 web 색 분기 추가가 불필요하다.
 */
export const MENTION_ENTITY_SIDE_EDGE_TYPE = "mentions_entity_side";
/**
 * 글 → works 행 승격/곁다리 간선 표시 weight(planner-chosen default·plan G1·G2·G4).
 * 굵기·tie-break 미세값. 라이브 sanity 에서 사용자가 최종 확정한다.
 */
export const MENTION_ENTITY_EDGE_WEIGHT = 0.7;
/**
 * 프로젝트 → 글 owns_memory 엣지 표시 weight (planner-chosen default).
 * 굵기·투명도 버킷 색인을 정한다. 라이브 sanity 에서 사용자가 최종 확정한다.
 */
export const PROJECT_OWNS_WEIGHT = 0.7;
/**
 * 한 화면에서 owns_memory 로 *새로* 합류하는 글 총수 전역 안전 상한
 * (planner-chosen default). 프로젝트당 cap 은 없다 — 프로젝트들이 이 상한 하나를
 * 공유한다. 잔여분(상한 - 지금까지 새로 추가된 글 수)을 getProjectMemberNodes 의
 * limit 로 넘겨 과밀을 막는다. 라이브 sanity 에서 사용자가 최종 확정한다.
 */
export const PROJECT_MEMBER_NODES_LIMIT = 120;

// 옛 GROUP_TYPE_KO 정적 Record(8 타입 + person/project 만)는 plan 2026-06-28 G3 에서
// 폐기했다 — user 새 종류 koName 이 빠져 묶음 라벨이 영문 코드명으로 떴다. 묶음 라벨·
// 그룹핑·위계 루트 매칭의 koName 단일 출처는 이제 displayKindName(entity-type-classifier)
// 으로, 정적 10종 + user 동적 명부 koName 을 한 통로로 돌려준다(graph-group-nodes.ts·
// graph-absorb-same-label.ts 소비처 전부 그쪽으로 옮김).

/**
 * idle(overview) 화면에 합류할 문서·이미지 일반 별 상한.
 *
 * 문서(source_type='document')·이미지(source_type='image_asset') 노드는 이미
 * getRecent 가 섞어 돌려준다(제외 목록은 document_chunk·llm_extract·image_caption
 * 자식 종류뿐). "다 띄우기"(DCL-2) 정신으로 idle 에도 일반 별로 보이게 하되, 한
 * 화면에 너무 많이 쏟아지지 않게 합류 수를 이 상한으로 자른다. 장식 없는 일반 별이라
 * 장식 매핑 영향 0. 0건이면 가짜 노드 없이 빈 상태 유지(정직한 빈 상태).
 */
export const DOCS_IMAGES_LIMIT = 24;

/** 문서·이미지 과밀 상한 판정 대상 source_type 집합. */
export const DOCS_IMAGES_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "document",
  "image_asset",
]);

// ── 응답 타입 ──────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  /** 개념·사람 노드는 숫자 id 가 없어 선택이다(글 노드만 채움). */
  sourceId?: number;
  sourceType: string | undefined;
  label: string;
  /** 글 노드만 채우는 본문·메타 칸 — 개념·사람 노드는 비운다. */
  snippet?: string;
  importance?: number;
  confidence?: number;
  createdAt?: string;
  /** 수동 본문 수정 시각. 없으면 생성 후 수정 없음. */
  updatedAt?: string;
  /**
   * 생명력 점수 0~1 (computeNodeValue 단일 출처). 글 노드만 싣는다.
   * 색이 이 값으로 정해진다(붉은=죽어감 / 흰빛=살아있음). 개념·사람 노드는
   * 생명력 개념이 없어 undefined — web 이 nodeDefaultColor 로 칠한다.
   */
  vitality?: number;
  /**
   * 묶음 노드(sourceType="entity_group")가 묶는 자식 1급 타입(work·project·person 등).
   * 장식·라벨이 이 값으로 자식과 같은 종류를 고른다(spec §5.2 Q3). 일반 노드는 비운다.
   */
  groupType?: string;
  /**
   * 이 글이 속한 프로젝트 id(MemoryNode.projectId·길 A). 글 노드만 채운다 —
   * 단계 1.7 이 nodeById 를 순회하며 이 값을 직접 읽어 프로젝트 → 글 허브를 그린다
   * (글마다 getNode 재호출 없이·추가 DB round-trip 0). 서버 내부 타입이라 web
   * 뷰모델(별 타입)과 무관하다. 소속 없으면 undefined.
   */
  projectId?: string;
  /** 글 노드만 채우는 메타 — 마지막 접근 시각. 모달 표시용. */
  lastAccessedAt?: string;
  /** 글 노드만 채우는 메타 — 반복 언급 횟수. 모달 표시용. */
  mentionCount?: number;
  /** 사건 발생 시각(event_at·v11). 일정 탭 정렬·표기용. 없으면 undefined. */
  eventAt?: string;
  /** 일정 종료 일시(event_until·v23). 기간 표기용. 단일 시점이면 undefined. */
  eventUntil?: string;
  /**
   * 글의 종류 배지명(예 '가계부'). toGraphNode 는 안 채우고 graph 라우트가 노드를 다 만든 뒤
   * 글 본문(snippet)의 엔티티 종류를 직접 분류해 채운다 — enrichNodeKinds 가
   * displayKindName(classifyEntityTypeDeterministic(content).typeName) 으로 산출한다(순수
   * 함수·DB 왕복 0·N+1 없음). 본문에 종류 신호가 없으면 undefined. 2026-06-28 "종류" 허브
   * 버그 수정 전엔 getNodeKinds("종류" 분류 꼬리표 bulk)로 채웠으나, 그 꼬리표가 허브 원인이라
   * 본문 typeName 직접 산출로 옮겼다(spec §4.3 B). 종류 배지의 유일한 라이브 render 경로
   * (fromGraphHit/fromGraphNode)가 이 칸을 읽는다.
   */
  kind?: string;
  /** 표시 전용 확장 메타. 엔티티 노드는 칸/라벨/별칭을 여기에 싣는다. */
  meta?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  weight: number;
  /** 표시 전용 확장 메타. relation edge 출처 등 렌더 힌트를 싣는다. */
  meta?: Record<string, unknown>;
}

export interface GraphOverviewResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    totalNodes: number;
    totalEdges: number;
  };
}

export interface GraphSearchHit {
  nodeId: string;
  score: number;
  sources?: string[];
  components?: Record<string, number>;
  revision?: { superseded: boolean; supersedes: boolean };
}

export interface GraphSearchFocus {
  centerNodeId: string;
  highlightedNodeIds: string[];
  highlightedEdgeIds: string[];
}

export interface GraphSearchResponse {
  query: string;
  count: number;
  hits: GraphSearchHit[];
  top3: GraphSearchHit[];
  subgraph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  focus: GraphSearchFocus;
}

/** Task 4(관계선)·buildGroupNodes(묶음 노드)가 재사용할 합류 엔티티/사람 식별자 묶음. */
export interface AugmentResult {
  /**
   * 합류된 엔티티 행 (typeName,id). type 은 string — 정적 8 타입(EntityTypeName) +
   * 사용자 새 종류(런타임 string·ldg_ 등) 둘 다 담는다(plan 2026-06-28 G2·RC2). 옛날엔
   * EntityTypeName union 이라 exhaustive switch 를 컴파일러가 잡았으나, user 종류가
   * 런타임 string 이라 union 으로 못 닫는다 — buildGroupNodes(groupType:string)·refNodeKey
   * (type:string)는 이미 string 을 받으므로 묶음 노드·관계선 합류가 user 종류에도 닿는다.
   */
  entityRefs: { type: string; id: string }[];
  /** 합류된 사람 personId — 사람도 관계선 끝일 수 있어 함께 모은다. */
  personRefs: string[];
  /** 합류된 프로젝트 id — 묶음 노드(group:project)가 묶는다. */
  projectRefs: string[];
}

export interface GraphEntityMetaRow {
  key: string;
  value: string;
}

export interface GraphEntityInfoSection {
  title: string;
  rows: GraphEntityMetaRow[];
}

export interface GraphEntityInfo {
  sections: GraphEntityInfoSection[];
}

export interface PersonGraphNodeDetails {
  labels?: Array<{ name: string; category?: string | null }>;
  projects?: Array<{ projectId: string; name: string; role?: string }>;
}

// ── 노드 키 빌더 ──────────────────────────────────────────────────────────

export function nodeKey(id: number): string {
  return `node:${id}`;
}

export function conceptKey(conceptId: string): string {
  return `concept:${conceptId}`;
}
export function personKey(personId: string): string {
  return `person:${personId}`;
}
/** 엔티티 9종 노드 id — 글/개념/사람 키와 충돌하지 않는 별도 namespace. */
export function entityKey(typeName: string, entityId: string): string {
  return `entity:${typeName}:${entityId}`;
}
/** 프로젝트 노드 id — 글/개념/사람/엔티티 키와 충돌하지 않는 별도 namespace. */
export function projectKey(projectId: string): string {
  return `project:${projectId}`;
}
/**
 * 관계 끝 노드 키 분기 — person 끝은 personKey, project 끝은 projectKey, 그 밖 8 타입
 * 엔티티 끝은 entityKey. entity_relation_edges 의 sourceType/targetType 으로 nodeById
 * 존재를 판정한다(Task 4 불변식). hierEndpointKey(graph-augment-shared.ts)와 같은 매핑 —
 * 프로젝트 노드는 어디서나 projectKey(=project:<id>)로 nodeById 에 들어오므로
 * (projectToGraphNode·addStandaloneEntitySeeds·검색 시드), entityKey("project", id)
 * (=entity:project:<id>)로 떨어지면 실제 노드 키와 어긋나 project 끝 관계선이 끊긴
 * 엣지(검색 뷰)·전부 누락(overview)이 된다.
 */
export function refNodeKey(type: string, id: string): string {
  if (type === "person") return personKey(id);
  if (type === "project") return projectKey(id);
  return entityKey(type, id);
}

// ── 노드 변환 헬퍼 ────────────────────────────────────────────────────────

function graphMemoryLabelText(content: string): string {
  const cleanContent = parseTags(content).cleanContent.trim();
  return cleanContent.length > 0 ? cleanContent : content;
}

export function toGraphNode(node: MemoryNode): GraphNode {
  const trimmed = graphMemoryLabelText(node.content).replace(/\s+/g, " ").trim();
  const label = trimmed.length > LABEL_MAX_CHARS
    ? trimmed.slice(0, LABEL_MAX_CHARS)
    : trimmed;
  const documentChunkMeta =
    node.sourceType === "document_chunk"
      ? {
          ...(typeof node.metadata.parentId === "string"
            ? { parentId: node.metadata.parentId }
            : {}),
          ...(typeof node.metadata.chunkIndex === "number" &&
          Number.isInteger(node.metadata.chunkIndex)
            ? { chunkIndex: node.metadata.chunkIndex }
            : {}),
          ...readDocumentChunkMetadata(node.metadata),
        }
      : {};
  // 생명력 점수 — scoring.ts 의 computeNodeValue 단일 출처를 호출만 한다(공식 미변경).
  // 보호 판정은 auto-cleanup-runner.isProtected 4조건 단일 출처와 공유한다
  // (preservedRaw / is_protected / user_explicit / protectUntil 미래). 색이
  // 실제 archive(휴지통) 경계와 같은 규칙을 보도록 맞춘다 — 색=생사 약속 일치(qa M-1).
  const vitality = computeNodeValue({
    importance: node.importance,
    lastAccessedAt: node.lastAccessedAt,
    mentionCount: node.mentionCount,
    isProtected: isProtected(node, new Date()),
  });
  return {
    id: nodeKey(node.id),
    sourceId: node.id,
    sourceType: node.sourceType,
    label: label.length > 0 ? label : `#${node.id}`,
    snippet: node.content,
    importance: node.importance,
    confidence: node.confidence,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt ?? undefined,
    vitality,
    // 길 A — 글의 소속 프로젝트를 GraphNode 에 실어 단계 1.7 이 직접 읽는다.
    // 소속 없으면 undefined(검색·표시 무관·읽기 전용).
    projectId: node.projectId ?? undefined,
    lastAccessedAt: node.lastAccessedAt,
    mentionCount: node.mentionCount,
    // 일정 탭 정렬·표기용 — string | null 이라 ?? undefined 로 접어 없는 값은
    // 직렬화에서 빠진다(빈 문자열로 채우지 않는다·없는 값은 일정 탭이 정직하게 제외).
    eventAt: node.eventAt ?? undefined,
    eventUntil: node.eventUntil ?? undefined,
    ...(Object.keys(documentChunkMeta).length > 0 ? { meta: documentChunkMeta } : {}),
  };
}

export function conceptToGraphNode(concept: ConceptNode): GraphNode {
  const name = concept.koName ?? concept.name;
  const label = name.length > LABEL_MAX_CHARS ? name.slice(0, LABEL_MAX_CHARS) : name;
  // 대표 정체성 개념 > 분류 > 태그(spec §3.1·꼬임 해소 1단계 결정 1). 같은 이름
  // 태그·분류·개념이 한 concept 행으로 합류해 역할 플래그가 누적되면, 그 한 행을 한
  // 노드로 그리되 대표 type 을 우선순위로 고른다. 규칙은 web view-model 과 공유하는
  // 단일 출처(graph-concept-display.ts) — 분류 키 > 분류 값/순수 개념 = concept >
  // 태그-only = tag. 반환 리터럴이 그대로 노드 sourceType 어휘다.
  const sourceType = representativeConceptType({
    isTag: concept.isTag,
    isClassificationKey: concept.isClassificationKey,
    isClassificationValue: concept.isClassificationValue,
  });
  return {
    id: conceptKey(concept.conceptId),
    sourceType,
    label: label.length > 0 ? label : concept.conceptId,
  };
}
export function personToGraphNode(
  person: Person,
  details: PersonGraphNodeDetails = {},
): GraphNode {
  const name = person.displayName;
  const label = name.length > LABEL_MAX_CHARS ? name.slice(0, LABEL_MAX_CHARS) : name;
  const entityInfo = personInfoForGraphNode(person, details);
  const node: GraphNode = {
    id: personKey(person.personId),
    sourceType: "person",
    label: label.length > 0 ? label : person.personId,
    createdAt: person.createdAt,
  };
  if (entityInfo) node.meta = { entityInfo };
  return node;
}

export function projectToGraphNode(
  project: Project,
  entity: UserEntity | null = null,
  attributes: readonly EntityAttributeValue[] = [],
): GraphNode {
  const name = project.name;
  const label = name.length > LABEL_MAX_CHARS ? name.slice(0, LABEL_MAX_CHARS) : name;
  const entityInfo = projectInfoForGraphNode(project, entity, attributes);
  const node: GraphNode = {
    id: projectKey(project.projectId),
    sourceType: "project",
    label: label.length > 0 ? label : project.projectId,
    createdAt: project.createdAt,
  };
  if (entityInfo) node.meta = { entityInfo };
  return node;
}

export async function personToDetailedGraphNode(
  store: MemoryApiDeps["store"],
  person: Person,
): Promise<GraphNode> {
  const [labels, projectEdges] = await Promise.all([
    store.listPersonAttributeConcepts(person.personId),
    store.listPersonProjects(person.personId),
  ]);
  const projects = (
    await Promise.all(
      projectEdges.map(async (edge) => {
        const project = await store.getProject(edge.projectId);
        if (!project) return null;
        return {
          projectId: project.projectId,
          name: project.name,
          role: edge.role,
        };
      }),
    )
  ).filter((project): project is { projectId: string; name: string; role: string } =>
    project !== null
  );
  return personToGraphNode(person, { labels, projects });
}

export async function projectToDetailedGraphNode(
  store: MemoryApiDeps["store"],
  project: Project,
): Promise<GraphNode> {
  const entity = await store.entitiesRepo.get(project.projectId);
  return projectToGraphNode(
    project,
    entity,
    store.entitiesRepo.listAttributes(project.projectId),
  );
}

const TECHNICAL_ATTR_KEYS = new Set([
  "entity_id",
  "project_id",
  "person_id",
  "external_refs",
  "externalRefs",
  "embedding_text",
  "embeddingText",
  "attributes_json",
]);

const PROJECT_STATUS_ATTR_KEY = "status";
const PROJECT_SUMMARY_ATTR_KEY = "summary";
const PROJECT_EMBEDDING_TEXT_ATTR_KEY = "embedding_text";
const PROJECT_ATTRIBUTES_JSON_ATTR_KEY = "attributes_json";

function cleanText(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

function cleanDisplayValue(value: unknown): string | null {
  if (typeof value === "string") return cleanText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const items = dedupeTexts(value.map((item) => cleanDisplayValue(item) ?? ""));
    return items.length > 0 ? items.join(", ") : null;
  }
  return null;
}

function dedupeTexts(
  values: Iterable<string | null | undefined>,
  exclude: Iterable<string | null | undefined> = [],
): string[] {
  const excluded = new Set<string>();
  for (const item of exclude) {
    const text = cleanText(item);
    if (text) excluded.add(text);
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of values) {
    const text = cleanText(item);
    if (!text || excluded.has(text) || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function addSection(
  sections: GraphEntityInfoSection[],
  title: string,
  rows: readonly GraphEntityMetaRow[],
): void {
  const cleanedRows = rows
    .map((row) => ({
      key: cleanText(row.key),
      value: cleanText(row.value),
    }))
    .filter((row): row is GraphEntityMetaRow => row.key !== null && row.value !== null);
  if (cleanedRows.length > 0) sections.push({ title, rows: cleanedRows });
}

function infoFromSections(sections: GraphEntityInfoSection[]): GraphEntityInfo | null {
  return sections.length > 0 ? { sections } : null;
}

function shouldHideAttributeKey(key: string): boolean {
  return (
    key === KO_ALIASES_ATTR_KEY ||
    key === EN_ALIASES_ATTR_KEY ||
    TECHNICAL_ATTR_KEYS.has(key)
  );
}

function aliasSectionRows(aliases: readonly string[]): GraphEntityMetaRow[] {
  return aliases.length > 0 ? [{ key: "별칭", value: aliases.join(", ") }] : [];
}

function entityInfoForGraphNode(
  entity: UserEntity,
  attributes: readonly EntityAttributeValue[],
  scheduleOccurrences: readonly GraphEntityMetaRow[] = [],
): GraphEntityInfo | null {
  const columns: GraphEntityMetaRow[] = [];
  const labels: GraphEntityMetaRow[] = [];

  const medium = cleanText(entity.medium);
  if (medium) columns.push({ key: "매체", value: medium });
  const createdBy = cleanText(entity.createdBy);
  if (createdBy) columns.push({ key: "작가", value: createdBy });

  for (const attr of attributes) {
    if (shouldHideAttributeKey(attr.key)) continue;
    const key = cleanText(attr.key);
    const value = cleanText(attr.value);
    if (!key || !value) continue;
    const row = { key, value };
    if (attr.isColumn) columns.push(row);
    else labels.push(row);
  }

  const aliases = dedupeTexts(
    [...entity.koAliases, ...entity.enAliases],
    [entity.name, entity.koName],
  );
  const sections: GraphEntityInfoSection[] = [];
  addSection(sections, "칸", columns);
  addSection(sections, "라벨", labels);
  addSection(sections, "별칭", aliasSectionRows(aliases));
  if (entity.typeName === "schedule") {
    addSection(sections, "일정", scheduleOccurrences);
  }
  return infoFromSections(sections);
}

function personInfoForGraphNode(
  person: Person,
  details: PersonGraphNodeDetails,
): GraphEntityInfo | null {
  const sections: GraphEntityInfoSection[] = [];
  addSection(sections, "기본 정보", [
    { key: "생일", value: person.birthday ?? "" },
    { key: "주소", value: person.address ?? "" },
    { key: "성별", value: person.gender ?? "" },
  ]);
  addSection(
    sections,
    "특성 라벨",
    (details.labels ?? []).map((label) => ({
      key: label.category ?? "라벨",
      value: label.name,
    })),
  );
  addSection(
    sections,
    "별칭",
    aliasSectionRows(dedupeTexts(person.aliases, [person.displayName])),
  );
  addSection(
    sections,
    "참여 프로젝트",
    (details.projects ?? []).map((project) => ({
      key: "프로젝트",
      value: project.name,
    })),
  );
  return infoFromSections(sections);
}

function projectInfoForGraphNode(
  project: Project,
  entity: UserEntity | null,
  attributes: readonly EntityAttributeValue[],
): GraphEntityInfo | null {
  const columns: GraphEntityMetaRow[] = [];
  const labels: GraphEntityMetaRow[] = [];

  const summary = cleanText(project.summary);
  if (summary) columns.push({ key: "요약", value: summary });
  if (project.status !== "active") {
    const status = cleanText(project.status);
    if (status) columns.push({ key: "상태", value: status });
  }

  for (const attr of attributes) {
    if (
      shouldHideAttributeKey(attr.key) ||
      attr.key === PROJECT_STATUS_ATTR_KEY ||
      attr.key === PROJECT_SUMMARY_ATTR_KEY ||
      attr.key === PROJECT_EMBEDDING_TEXT_ATTR_KEY ||
      attr.key === PROJECT_ATTRIBUTES_JSON_ATTR_KEY
    ) {
      continue;
    }
    const key = cleanText(attr.key);
    const value = cleanText(attr.value);
    if (!key || !value) continue;
    const row = { key, value };
    if (attr.isColumn) columns.push(row);
    else labels.push(row);
  }

  for (const [key, rawValue] of Object.entries(project.attributes)) {
    if (shouldHideAttributeKey(key)) continue;
    const value = cleanDisplayValue(rawValue);
    if (value) labels.push({ key, value });
  }

  const aliases = entity
    ? dedupeTexts([...entity.koAliases, ...entity.enAliases], [entity.name, entity.koName])
    : [];
  const sections: GraphEntityInfoSection[] = [];
  addSection(sections, "칸", columns);
  addSection(sections, "라벨", labels);
  addSection(sections, "별칭", aliasSectionRows(aliases));
  return infoFromSections(sections);
}

export function entityToGraphNode(
  entity: UserEntity,
  attributes: readonly EntityAttributeValue[] = [],
  scheduleOccurrences: readonly GraphEntityMetaRow[] = [],
): GraphNode {
  const name = entity.koName ?? entity.name;
  const label = name.length > LABEL_MAX_CHARS ? name.slice(0, LABEL_MAX_CHARS) : name;
  const entityInfo = entityInfoForGraphNode(
    entity,
    attributes,
    scheduleOccurrences,
  );
  const node: GraphNode = {
    id: entityKey(entity.typeName, entity.id),
    sourceType: entity.typeName,
    label: label.length > 0 ? label : entity.id,
    createdAt: entity.createdAt,
  };
  if (entityInfo) node.meta = { entityInfo };
  return node;
}

function displayEventRange(eventAt: string, eventUntil: string | null): string {
  return eventUntil && eventUntil !== eventAt
    ? `${eventAt} ~ ${eventUntil}`
    : eventAt;
}

export function scheduleOccurrenceRowsForEntity(
  store: MemoryApiDeps["store"],
  entity: UserEntity,
  limit = 8,
): GraphEntityMetaRow[] {
  if (entity.typeName !== "schedule") return [];
  const rows = store
    .getRawDb()
    .query(
      `SELECT DISTINCT kn.event_at AS event_at, kn.event_until AS event_until
       FROM entity_concept_edges ece
       JOIN node_concept_edges nce
         ON nce.concept_id = ece.concept_id
        AND nce.role = 'classification'
       JOIN knowledge_nodes kn ON kn.id = nce.node_id
       WHERE ece.entity_id = ?
         AND ece.role = 'identity'
         AND kn.event_at IS NOT NULL
       ORDER BY kn.event_at ASC, kn.id ASC
       LIMIT ?`,
    )
    .all(entity.id, limit) as Array<{
      event_at: string;
      event_until: string | null;
    }>;
  const key = cleanText(entity.koName ?? entity.name);
  if (!key) return [];
  return rows.map((row) => ({
    key,
    value: displayEventRange(row.event_at, row.event_until),
  }));
}

/**
 * typeName 으로 엔티티 행 단건 조회를 한다 — 단계4 T4 가 전용 getX 8-case switch 를
 * 범용 단건 조회 store.getEntity(typeName, id) 한 통로로 모았다(결정 3·전용 테이블 흡수).
 * 8 타입은 EntityBase(id·name·koName) 를 공유하고, 범용 UserEntity 가 그 칸을 모두
 * 노출하므로 그래프 렌더가 옛 도메인 view 와 같은 칸을 읽는다. 미존재 행이면 null
 * (엣지 양끝 불변식이 그 노드 합류를 막는다).
 *
 * typeName 은 string — 정적 8 타입 + user 새 종류(plan 2026-06-28 G2) 둘 다 받는다.
 * store.getEntity(_typeName, id) 는 entity_id 단독으로 entitiesRepo.get(id) 에 위임하므로
 * (id 전역 UNIQUE) user 종류 string 도 같은 통로로 행을 돌려준다.
 */
export async function getEntityRowById(
  store: MemoryApiDeps["store"],
  typeName: string,
  id: string,
): Promise<UserEntity | null> {
  return store.getEntity(typeName, id);
}
