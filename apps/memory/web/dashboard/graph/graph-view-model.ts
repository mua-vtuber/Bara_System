export type GraphNodeType =
  | "project"
  | "concept"
  | "person"
  | "document"
  | "document_section"
  | "document_chunk"
  | "image"
  | "image_caption"
  | "llm_extract"
  | "decision"
  | "tag"
  | "memory"
  | "unknown"
  // Phase 8 재매핑 Task 1 — 엔티티 타입 키(선택지 B·spec 3.10). 장식은 다 고리로
  // 정규화하되(Task 6) 타입 라벨은 보존해 클릭 시 작품/장소/일정 등이 구별돼 뜬다.
  | "creature"
  | "thing"
  | "intake"
  | "usable"
  | "work"
  | "material"
  | "place"
  | "schedule"
  // 콜론 위계 분류 키(isClassificationKey) — 유리조각 역할(Task 6).
  | "classification_key"
  // 그래프 타입 묶음 노드(가상) — 같은 1급 타입 점들의 머리 노드(Q3).
  | "entity_group";

export type GraphIconKind = "folder" | "note" | "page" | "image" | "pin";

export interface GraphNodeRevision {
  superseded: boolean;
  supersedes: boolean;
}

export interface GraphImageCaptions {
  user: string | null;
  auto: string | null;
}

export interface GraphClassification {
  category: string;
  value: string;
}

export interface GraphDocumentRef {
  parentId: string;
  centerIndex: number;
  title: string | null;
  totalChunks: number | null;
  headingPath?: string[];
  headingTitle?: string;
  headingDepth?: number;
  parentHeadingPath?: string[];
  sectionChunkIndex?: number;
  sectionChunkCount?: number;
  chunkingStrategy?: "paragraph" | "heading" | "heading_path";
}

export interface GraphNode {
  id: string;
  sourceId?: number | string;
  type: GraphNodeType;
  /** 묶음 노드(type="entity_group")가 묶는 자식 1급 타입. 장식·라벨 분기용. */
  groupType?: string;
  sourceType?: string;
  label: string;
  snippet?: string;
  path?: string[];
  importance?: number;
  /** 생명력 0~1 (서버 computeNodeValue). 글 노드 색의 입력. 개념·사람은 없음. */
  vitality?: number;
  confidence?: number;
  score?: number;
  sources?: string[];
  components?: Record<string, number>;
  createdAt?: string;
  updatedAt?: string | null;
  /** 글 노드만 채우는 메타 — 마지막 접근 시각. 모달 표시용. */
  lastAccessedAt?: string;
  /** 글 노드만 채우는 메타 — 반복 언급 횟수. 모달 표시용. */
  mentionCount?: number;
  /** 일정 탭 정렬·표기용. 글·문서·이미지 노드만 채움. */
  eventAt?: string;
  /** 단계6 — 일정 종료 일시(event_until). 기간 표기용. 단일 시점이면 undefined. */
  eventUntil?: string;
  /** 단계6 T1c — 글의 분류 종류명. graph 라우트 bulk enrich 로 채워진다. 없으면 undefined. */
  kind?: string;
  memoryAt?: string;
  revision?: GraphNodeRevision;
  captions?: GraphImageCaptions;
  classifications?: GraphClassification[];
  document?: GraphDocumentRef;
  meta?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  weight?: number;
  confidence?: number;
  meta?: Record<string, unknown>;
}

export interface GraphCluster {
  id: string;
  label: string;
  nodeIds: string[];
}

export interface GraphStats {
  totalNodes: number;
  totalEdges: number;
  totalMemories?: number;
  memoriesLast7Days?: number;
}

export interface GraphNodeRef {
  nodeId: string;
  score?: number;
  sources?: string[];
  components?: Record<string, number>;
  revision?: { superseded: boolean; supersedes: boolean };
}

export interface GraphSearchView {
  query: string;
  count: number;
  top3: GraphNodeRef[];
  hits: GraphNodeRef[];
  highlightedNodeIds: string[];
  highlightedEdgeIds: string[];
}

export interface GraphEvent {
  id?: string | number;
  type: string;
  nodeId?: string;
  edgeId?: string;
  title?: string;
  meta?: Record<string, unknown>;
}

export interface DashboardGraphViewModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: GraphCluster[];
  stats: GraphStats;
  recent: GraphNodeRef[];
  search?: GraphSearchView;
  events?: GraphEvent[];
}

const SOURCE_TYPE_MAP: Record<string, GraphNodeType> = {
  project: "project",
  concept: "concept",
  person: "person",
  document: "document",
  document_section: "document_section",
  document_chunk: "document_chunk",
  chunk: "document_chunk",
  image: "image",
  image_asset: "image",
  image_caption: "image_caption",
  llm_extract: "llm_extract",
  decision: "decision",
  tag: "tag",
  // Phase 8 재매핑 Task 1 — 서버가 싣는 엔티티 sourceType 문자열.
  creature: "creature",
  thing: "thing",
  intake: "intake",
  usable: "usable",
  work: "work",
  material: "material",
  place: "place",
  schedule: "schedule",
  classification_key: "classification_key",
  entity_group: "entity_group",
  auto_capture: "memory",
  user_explicit: "memory",
  atomic: "memory",
  raw: "memory",
  memory: "memory",
};

export function nodeKey(id: number | string): string {
  if (typeof id === "number") return `node:${id}`;
  if (/^[a-z]+:/.test(id)) return id;
  return `node:${id}`;
}

export function normalizeGraphNodeType(sourceType: unknown): GraphNodeType {
  if (typeof sourceType !== "string") return "memory";
  return SOURCE_TYPE_MAP[sourceType] ?? "unknown";
}

// 대표 정체성 표시 규칙(개념>분류>태그·spec §3.1)은 서버 graph.ts 와 공유하는
// 단일 출처다. tsconfig 가 web/dashboard 를 컴파일에서 제외해 서버가 web 을 못
// import 하므로 규칙은 양쪽이 닿는 src/ 에 두고, 여기서 재export 해 web 의 기존
// import 경로(./graph-view-model)를 보존한다. ConceptDisplayType 리터럴은 web
// GraphNodeType 의 부분집합이라 노드 type 으로 그대로 쓸 수 있다.
export type {
  ConceptRoleFlags,
  ConceptDisplayType,
} from "../../../src/memory/graph-concept-display.ts";
export { representativeConceptType } from "../../../src/memory/graph-concept-display.ts";

export function iconKindForGraphType(type: GraphNodeType): GraphIconKind {
  if (type === "document_chunk" || type === "document_section") return "page";
  if (type === "project" || type === "concept" || type === "person") return "folder";
  // Task 6 장식 재매핑 전까지 엔티티·사람·개념·프로젝트는 모두 folder 아이콘.
  if (
    type === "creature" || type === "thing" || type === "intake" ||
    type === "usable" || type === "work" || type === "material" ||
    type === "place" || type === "schedule"
  ) return "folder";
  if (type === "image") return "image";
  if (type === "tag" || type === "classification_key") return "pin";
  return "note";
}

export function labelFromContent(content: unknown, fallback = "Untitled"): string {
  if (typeof content !== "string") return fallback;
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return fallback;
  return collapsed.length > 32 ? `${collapsed.slice(0, 31)}...` : collapsed;
}

export function emptyGraphViewModel(): DashboardGraphViewModel {
  return {
    nodes: [],
    edges: [],
    clusters: [],
    stats: { totalNodes: 0, totalEdges: 0 },
    recent: [],
  };
}

export function uniqueGraphNodes(nodes: GraphNode[]): GraphNode[] {
  const byId = new Map<string, GraphNode>();
  for (const node of nodes) {
    const previous = byId.get(node.id);
    if (!previous) {
      byId.set(node.id, node);
      continue;
    }
    byId.set(node.id, {
      ...previous,
      ...node,
      score: Math.max(previous.score ?? 0, node.score ?? 0),
      sources: node.sources ?? previous.sources,
      components: node.components ?? previous.components,
      revision: node.revision ?? previous.revision,
      captions: node.captions ?? previous.captions,
      classifications: node.classifications ?? previous.classifications,
      document: node.document ?? previous.document,
      meta: node.meta ?? previous.meta,
    });
  }
  return [...byId.values()];
}

export function uniqueGraphEdges(edges: GraphEdge[]): GraphEdge[] {
  const byId = new Map<string, GraphEdge>();
  for (const edge of edges) byId.set(edge.id, edge);
  return [...byId.values()];
}
