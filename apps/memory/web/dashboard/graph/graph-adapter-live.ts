import {
  type DashboardGraphViewModel,
  type GraphClassification,
  type GraphDocumentRef,
  type GraphEdge,
  type GraphImageCaptions,
  type GraphNode,
  type GraphNodeRef,
  type GraphNodeRevision,
  type GraphNodeType,
  type GraphSearchView,
  emptyGraphViewModel,
  labelFromContent,
  nodeKey,
  normalizeGraphNodeType,
  uniqueGraphEdges,
  uniqueGraphNodes,
} from "./graph-view-model";

export interface ApiStats {
  totalMemories?: number;
  memoriesLast7Days?: number;
  totalEdges?: number;
}

export interface ApiRecentMemory {
  id: number;
  content: string;
  memoryType?: string;
  importance?: number;
  confidence?: number;
  createdAt?: string;
  updatedAt?: string | null;
  lastAccessedAt?: string;
  sourceType?: string;
  meta?: Record<string, unknown>;
}

interface ApiDocumentChunkMetadata {
  headingPath?: string[];
  headingTitle?: string;
  headingDepth?: number;
  parentHeadingPath?: string[];
  sectionChunkIndex?: number;
  sectionChunkCount?: number;
  chunkingStrategy?: "paragraph" | "heading" | "heading_path";
}

type ApiDocumentChunkMetadataRecord = ApiDocumentChunkMetadata & Record<string, unknown>;

export interface ApiNeighborChunk extends ApiDocumentChunkMetadata {
  id: number;
  chunkIndex: number;
  content: string;
}

export interface ApiSearchResult extends ApiRecentMemory {
  score: number;
  sources: string[];
  components: Record<string, number>;
  concepts?: unknown;
  neighbors?: ApiNeighborChunk[];
  documentRef?: GraphDocumentRef | null;
  assetSha256?: string | null;
  captions?: GraphImageCaptions;
  taggedWith?: GraphClassification[];
  revision?: GraphNodeRevision;
}

export interface ApiSearchResponse {
  query: string;
  count: number;
  results: ApiSearchResult[];
}

export interface BuildLiveGraphViewModelInput {
  stats?: ApiStats;
  recent?: ApiRecentMemory[];
  search?: ApiSearchResponse | null;
}

export function graphNodeFromMemory(memory: ApiRecentMemory): GraphNode {
  const type = normalizeGraphNodeType(memory.sourceType ?? memory.memoryType);
  return {
    id: nodeKey(memory.id),
    sourceId: memory.id,
    type,
    sourceType: memory.sourceType,
    label: labelFromContent(memory.content, `#${memory.id}`),
    snippet: memory.content,
    importance: memory.importance,
    confidence: memory.confidence,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    meta: memory.meta,
  };
}

export function graphNodeFromSearchResult(result: ApiSearchResult): GraphNode {
  const node = graphNodeFromMemory(result);
  return {
    ...node,
    score: result.score,
    sources: result.sources,
    components: result.components,
    revision: result.revision ?? { superseded: false, supersedes: false },
    captions: result.captions,
    classifications: result.taggedWith,
    document: result.documentRef ?? undefined,
    meta: nodeMetaForSearchResult(result),
  };
}

function nodeMetaForSearchResult(result: ApiSearchResult): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  if (result.assetSha256) meta.assetSha256 = result.assetSha256;
  Object.assign(meta, headingMetadataFrom(result.documentRef ?? undefined));
  return Object.keys(meta).length > 0 ? meta : undefined;
}

export function buildLiveGraphViewModel(
  input: BuildLiveGraphViewModelInput,
): DashboardGraphViewModel {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const memory of input.recent ?? []) nodes.push(graphNodeFromMemory(memory));

  let searchView: GraphSearchView | undefined;
  if (input.search) {
    const hitRefs = input.search.results.map((result) => ({
      nodeId: nodeKey(result.id),
      score: result.score,
      sources: result.sources,
      components: result.components,
      revision: result.revision,
    }));
    searchView = {
      query: input.search.query,
      count: input.search.count,
      top3: hitRefs.slice(0, 3),
      hits: hitRefs,
      highlightedNodeIds: hitRefs.map((hit) => hit.nodeId),
      highlightedEdgeIds: [],
    };

    for (const result of input.search.results) {
      const sourceNodeId = nodeKey(result.id);
      nodes.push(graphNodeFromSearchResult(result));
      appendDocumentContext(nodes, edges, result);
      appendClassificationContext(nodes, edges, sourceNodeId, result.taggedWith ?? []);
    }
  }

  const uniqueNodes = uniqueGraphNodes(nodes);
  const uniqueEdges = uniqueGraphEdges(edges);
  if (searchView) {
    searchView.highlightedEdgeIds = uniqueEdges.map((edge) => edge.id);
  }

  return {
    nodes: uniqueNodes,
    edges: uniqueEdges,
    clusters: buildTypeClusters(uniqueNodes),
    stats: {
      totalNodes: uniqueNodes.length,
      totalEdges: uniqueEdges.length,
      totalMemories: input.stats?.totalMemories,
      memoriesLast7Days: input.stats?.memoriesLast7Days,
    },
    recent: (input.recent ?? []).map((memory) => ({ nodeId: nodeKey(memory.id) })),
    ...(searchView ? { search: searchView } : {}),
  };
}

function appendDocumentContext(
  nodes: GraphNode[],
  edges: GraphEdge[],
  result: ApiSearchResult,
): void {
  const documentRef = result.documentRef;
  if (!documentRef) return;

  const documentNodeId = `document:${documentRef.parentId}`;
  const centerNodeId = nodeKey(result.id);
  nodes.push({
    id: documentNodeId,
    type: "document",
    label: documentRef.title ?? `Document ${documentRef.parentId}`,
    document: documentRef,
  });
  appendDocumentChunkContainment(
    nodes,
    edges,
    documentNodeId,
    centerNodeId,
    documentRef,
    result.content,
  );

  for (const neighbor of result.neighbors ?? []) {
    const neighborNodeId = nodeKey(neighbor.id);
    const neighborDocumentRef = documentRefForChunk(
      documentRef,
      neighbor.chunkIndex,
      headingMetadataFrom(neighbor),
    );
    nodes.push({
      id: neighborNodeId,
      sourceId: neighbor.id,
      type: "document_chunk",
      sourceType: "document_chunk",
      label: labelFromContent(neighbor.content, `#${neighbor.chunkIndex + 1}`),
      snippet: neighbor.content,
      document: neighborDocumentRef,
      meta: headingMetadataFrom(neighbor),
    });
    appendDocumentChunkContainment(
      nodes,
      edges,
      documentNodeId,
      neighborNodeId,
      neighborDocumentRef,
      neighbor.content,
    );
  }
}

function appendDocumentChunkContainment(
  nodes: GraphNode[],
  edges: GraphEdge[],
  documentNodeId: string,
  chunkNodeId: string,
  documentRef: GraphDocumentRef,
  chunkContent?: string,
): void {
  const headingPath = documentRef.headingPath;
  if (headingPath && headingPath.length > 0) {
    const sectionNodeId = appendDocumentSectionPath(
      nodes,
      edges,
      documentNodeId,
      documentRef,
      chunkContent,
    );
    edges.push({
      id: `edge:${sectionNodeId}->${chunkNodeId}:contains_chunk`,
      from: sectionNodeId,
      to: chunkNodeId,
      type: "contains_chunk",
      weight: 1,
    });
    return;
  }

  edges.push({
    id: `edge:${documentNodeId}->${chunkNodeId}:contains`,
    from: documentNodeId,
    to: chunkNodeId,
    type: "contains_chunk",
    weight: 1,
  });
}

function appendDocumentSectionPath(
  nodes: GraphNode[],
  edges: GraphEdge[],
  documentNodeId: string,
  documentRef: GraphDocumentRef,
  chunkContent?: string,
): string {
  const headingPath = documentRef.headingPath ?? [];
  let parentId = documentNodeId;
  const path: string[] = [];

  for (let i = 0; i < headingPath.length; i++) {
    const title = headingPath[i]!;
    path.push(title);
    const sectionNodeId = documentSectionNodeId(documentNodeId, path);
    const isLeaf = i === headingPath.length - 1;
    const depth = isLeaf && documentRef.headingDepth ? documentRef.headingDepth : i + 1;
    const sectionDocument: GraphDocumentRef = {
      parentId: documentRef.parentId,
      centerIndex: documentRef.centerIndex,
      title: documentRef.title,
      totalChunks: documentRef.totalChunks,
      headingPath: [...path],
      headingTitle: title,
      headingDepth: depth,
      parentHeadingPath: path.slice(0, -1),
      chunkingStrategy: "heading_path",
    };
    upsertDocumentSectionNode(nodes, {
      id: sectionNodeId,
      type: "document_section",
      sourceType: "document_section",
      label: `${"#".repeat(Math.max(1, Math.min(6, depth)))} ${title}`,
      snippet: normalizeSectionPreview(chunkContent),
      path: [...path],
      document: sectionDocument,
      meta: headingMetadataFrom(sectionDocument),
    });
    edges.push({
      id: `edge:${parentId}->${sectionNodeId}:contains_section`,
      from: parentId,
      to: sectionNodeId,
      type: "contains_section",
      weight: 1,
    });
    parentId = sectionNodeId;
  }

  return parentId;
}

function upsertDocumentSectionNode(nodes: GraphNode[], next: GraphNode): void {
  const existing = nodes.find((node) => node.id === next.id);
  if (!existing) {
    nodes.push(next);
    return;
  }
  existing.snippet = mergeSectionPreview(existing.snippet, next.snippet);
  existing.document = next.document ?? existing.document;
  existing.meta = { ...(existing.meta ?? {}), ...(next.meta ?? {}) };
}

function normalizeSectionPreview(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function mergeSectionPreview(
  previous: string | undefined,
  next: string | undefined,
): string | undefined {
  const cleanNext = normalizeSectionPreview(next);
  if (!cleanNext) return previous;
  const cleanPrevious = normalizeSectionPreview(previous);
  if (!cleanPrevious) return cleanNext;
  if (cleanPrevious === cleanNext || cleanPrevious.includes(cleanNext)) return cleanPrevious;
  return `${cleanPrevious}\n\n${cleanNext}`;
}

function documentSectionNodeId(documentNodeId: string, headingPath: string[]): string {
  return `document-section:${encodeURIComponent(documentNodeId)}:${headingPath
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

function documentRefForChunk(
  documentRef: GraphDocumentRef,
  chunkIndex: number,
  metadata: ApiDocumentChunkMetadata,
): GraphDocumentRef {
  return {
    parentId: documentRef.parentId,
    centerIndex: chunkIndex,
    title: documentRef.title,
    totalChunks: documentRef.totalChunks,
    ...metadata,
  };
}

function headingMetadataFrom(value: unknown): ApiDocumentChunkMetadataRecord {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const metadata: ApiDocumentChunkMetadataRecord = {};
  const headingPath = stringArray(record.headingPath);
  if (headingPath && headingPath.length > 0) metadata.headingPath = headingPath;
  if (typeof record.headingTitle === "string" && record.headingTitle.length > 0) {
    metadata.headingTitle = record.headingTitle;
  }
  if (typeof record.headingDepth === "number" && Number.isInteger(record.headingDepth)) {
    metadata.headingDepth = record.headingDepth;
  }
  const parentHeadingPath = stringArray(record.parentHeadingPath);
  if (parentHeadingPath) metadata.parentHeadingPath = parentHeadingPath;
  if (isNonNegativeInteger(record.sectionChunkIndex)) {
    metadata.sectionChunkIndex = record.sectionChunkIndex;
  }
  if (isPositiveInteger(record.sectionChunkCount)) {
    metadata.sectionChunkCount = record.sectionChunkCount;
  }
  if (
    record.chunkingStrategy === "paragraph" ||
    record.chunkingStrategy === "heading" ||
    record.chunkingStrategy === "heading_path"
  ) {
    metadata.chunkingStrategy = record.chunkingStrategy;
  }
  return metadata;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item) => typeof item === "string")) return undefined;
  return [...value];
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function appendClassificationContext(
  nodes: GraphNode[],
  edges: GraphEdge[],
  sourceNodeId: string,
  tags: GraphClassification[],
): void {
  for (const tag of tags) {
    const tagNodeId = `classification:${tag.category}:${tag.value}`;
    nodes.push({
      id: tagNodeId,
      type: "tag",
      label: `${tag.category}: ${tag.value}`,
      classifications: [tag],
    });
    edges.push({
      id: `edge:${sourceNodeId}->${tagNodeId}:classified_as`,
      from: sourceNodeId,
      to: tagNodeId,
      type: "classified_as",
    });
  }
}

function buildTypeClusters(nodes: GraphNode[]): { id: string; label: string; nodeIds: string[] }[] {
  const byType = new Map<GraphNodeType, string[]>();
  for (const node of nodes) {
    const list = byType.get(node.type) ?? [];
    list.push(node.id);
    byType.set(node.type, list);
  }
  return [...byType.entries()].map(([type, nodeIds]) => ({
    id: type,
    label: type,
    nodeIds,
  }));
}

// ── /graph/overview · /graph/search 응답 전용 어댑터 ──────────────────────

/**
 * GET /graph/overview 서버 응답 노드 항목 형태.
 * server-internal/routes/graph.ts GraphNode 와 정합하되, 어댑터 쪽에서
 * 독립적으로 선언해 서버 파일을 브라우저 번들에 포함시키지 않는다.
 */
interface GraphOverviewNode {
  id: string;
  sourceId?: number;
  sourceType?: string;
  label: string;
  snippet?: string;
  importance?: number;
  /** 생명력 0~1 — 글 노드 색 입력. 개념·사람 노드는 undefined. */
  vitality?: number;
  confidence?: number;
  createdAt?: string;
  updatedAt?: string | null;
  /** 묶음 노드가 묶는 자식 1급 타입(서버 GraphNode.groupType). */
  groupType?: string;
  lastAccessedAt?: string;
  mentionCount?: number;
  /** 일정 탭 정렬·표기용(서버 GraphNode.eventAt). 글·문서·이미지 노드만 채움. */
  eventAt?: string;
  /** 단계6 — 일정 종료 일시(event_until). 기간 표기용. 단일 시점이면 undefined. */
  eventUntil?: string;
  /** 단계6 T1c — 글의 분류 종류명. graph 라우트 bulk enrich 로 채워진다. 없으면 undefined. */
  kind?: string;
  /** 서버 GraphNode.meta. 엔티티 칸/라벨 등 표시 전용 메타. */
  meta?: Record<string, unknown>;
}

/** GET /graph/overview 서버 응답 전체 형태. */
export interface GraphOverviewResponse {
  nodes: GraphOverviewNode[];
  edges: GraphEdge[];
  stats?: {
    totalNodes?: number;
    totalEdges?: number;
    totalMemories?: number;
    memoriesLast7Days?: number;
  };
}

/** POST /graph/search 서버 응답 전체 형태. */
export interface GraphSearchApiResponse {
  query: string;
  count: number;
  hits: GraphNodeRef[];
  top3: GraphNodeRef[];
  subgraph: {
    nodes: GraphOverviewNode[];
    edges: GraphEdge[];
  };
  focus: {
    centerNodeId: string;
    highlightedNodeIds: string[];
    highlightedEdgeIds: string[];
  };
}

function mapOverviewNode(n: GraphOverviewNode): GraphNode {
  return {
    id: n.id,
    sourceId: n.sourceId,
    type: normalizeGraphNodeType(n.sourceType),
    sourceType: n.sourceType,
    groupType: n.groupType,
    label: n.label,
    snippet: n.snippet,
    importance: n.importance,
    vitality: n.vitality,
    confidence: n.confidence,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    lastAccessedAt: n.lastAccessedAt,
    mentionCount: n.mentionCount,
    eventAt: n.eventAt,
    eventUntil: n.eventUntil,
    kind: n.kind,
    meta: n.meta,
  };
}

function normalizeDocumentSectionView(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const normalizedNodes = [...nodes];
  const normalizedEdges: GraphEdge[] = [];

  for (const edge of edges) {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    const fromIsChunk = from?.type === "document_chunk";
    const toIsChunk = to?.type === "document_chunk";
    const fromIsDocument = from?.type === "document";
    const toIsDocument = to?.type === "document";

    if (edge.type === "parent_of" && fromIsChunk && toIsDocument && from && to) {
      const documentRef = documentRefFromOverviewChunk(to, from);
      normalizedNodes.push({
        ...from,
        document: documentRef,
        meta: { ...(from.meta ?? {}), ...headingMetadataFrom(documentRef) },
      });
      appendDocumentChunkContainment(
        normalizedNodes,
        normalizedEdges,
        to.id,
        from.id,
        documentRef,
        from.snippet,
      );
      continue;
    }

    if (edge.type === "parent_of" && fromIsDocument && toIsChunk && from && to) {
      const documentRef = documentRefFromOverviewChunk(from, to);
      normalizedNodes.push({
        ...to,
        document: documentRef,
        meta: { ...(to.meta ?? {}), ...headingMetadataFrom(documentRef) },
      });
      appendDocumentChunkContainment(
        normalizedNodes,
        normalizedEdges,
        from.id,
        to.id,
        documentRef,
        to.snippet,
      );
      continue;
    }

    normalizedEdges.push(edge);
  }

  return { nodes: normalizedNodes, edges: normalizedEdges };
}

function documentRefFromOverviewChunk(
  documentNode: GraphNode,
  chunkNode: GraphNode,
): GraphDocumentRef {
  const metadata = chunkNode.meta ?? {};
  const parentId =
    typeof metadata.parentId === "string" && metadata.parentId.length > 0
      ? metadata.parentId
      : String(documentNode.sourceId ?? documentNode.id);
  const chunkIndex =
    typeof metadata.chunkIndex === "number" && Number.isInteger(metadata.chunkIndex)
      ? metadata.chunkIndex
      : chunkNode.document?.centerIndex ?? -1;
  return {
    parentId,
    centerIndex: chunkIndex,
    title: documentNode.document?.title ?? documentNode.label ?? null,
    totalChunks: documentNode.document?.totalChunks ?? null,
    ...headingMetadataFrom(metadata),
  };
}

/**
 * GET /graph/overview 응답을 DashboardGraphViewModel 로 변환한다.
 * null 또는 빈 응답이면 emptyGraphViewModel() 와 동등한 값을 반환한다.
 */
export function buildOverviewViewModel(
  resp: GraphOverviewResponse | null,
): DashboardGraphViewModel {
  if (!resp) return emptyGraphViewModel();
  const sectioned = normalizeDocumentSectionView(
    (resp.nodes ?? []).map(mapOverviewNode),
    resp.edges ?? [],
  );
  const nodes = uniqueGraphNodes(sectioned.nodes);
  const edges = uniqueGraphEdges(sectioned.edges);
  return {
    nodes,
    edges,
    clusters: buildTypeClusters(nodes),
    stats: {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      totalMemories: resp.stats?.totalMemories,
      memoriesLast7Days: resp.stats?.memoriesLast7Days,
    },
    recent: nodes.map((n) => ({ nodeId: n.id })),
  };
}

/**
 * POST /graph/search 응답을 DashboardGraphViewModel 로 변환한다.
 * search 칸(query·count·top3·hits·highlightedNodeIds·highlightedEdgeIds)을 포함한다.
 * null 응답이면 emptyGraphViewModel() 와 동등한 값을 반환한다.
 */
export function buildSearchViewModel(
  resp: GraphSearchApiResponse | null,
): DashboardGraphViewModel {
  if (!resp) return emptyGraphViewModel();
  const base = buildOverviewViewModel({
    nodes: resp.subgraph.nodes,
    edges: resp.subgraph.edges,
  });
  const searchView: GraphSearchView = {
    query: resp.query,
    count: resp.count,
    top3: resp.top3,
    hits: resp.hits,
    highlightedNodeIds: resp.focus.highlightedNodeIds,
    highlightedEdgeIds: resp.focus.highlightedEdgeIds,
  };
  return { ...base, search: searchView };
}
