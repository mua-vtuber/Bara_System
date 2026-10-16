import type { CardView } from "../ui/card-view.ts";
import type { GraphEdge, GraphNode } from "../graph/graph-view-model.ts";

export interface DashboardStats {
  totalMemories?: number;
  memoriesLast7Days?: number;
  totalEdges?: number;
  schemaVersion?: number;
  version?: string;
}

export interface MemorySummary {
  id: number;
  content: string;
  memoryType?: string;
  importance?: number;
  confidence?: number;
  createdAt?: string;
  updatedAt?: string | null;
  lastAccessedAt?: string;
  mentionCount?: number;
  sourceType?: string;
  /** 작성자(knowledge_nodes.author) — 상세 응답에만 있다. */
  author?: string;
  /** 저장 경로(knowledge_nodes.platform) — 상세 응답에만 있다. */
  platform?: string;
  eventAt?: string | null;
  eventUntil?: string | null;
  /** 장소 — 서버가 GET /memories/:id 에 싣는다(없으면 null). 옛 서버는 칸 자체가 없다. */
  place?: string | null;
  places?: string[];
  kind?: string | null;
  metadata?: Record<string, unknown>;
  imageAttachments?: ImageAttachment[];
}

export interface ImageAttachment {
  nodeId: number;
  content: string;
  assetSha256: string;
  thumbSha256?: string;
  width?: number;
  height?: number;
  mime?: string;
  originalName?: string;
}

export interface MemoriesResponse {
  count: number;
  memories: MemorySummary[];
}

export interface MemoryDetailResponse {
  memory: MemorySummary & Record<string, unknown>;
}

export interface PersonDetailResponse {
  person: { personId: string; displayName: string };
}

export interface ProjectDetailResponse {
  project: { projectId: string; name: string; attributes: Record<string, unknown> };
}

export interface SearchResult extends MemorySummary {
  score: number;
  sources: string[];
  components: Record<string, number>;
  taggedWith?: Array<{ category: string; value: string }>;
  revision?: { superseded: boolean; supersedes: boolean };
}

export interface SearchResponse {
  query: string;
  count: number;
  results: SearchResult[];
}

export interface DashboardSearchOptions {
  limit?: number;
  kind?: string;
  subcategory?: string;
  since?: string;
  until?: string;
}

export interface DateOccurrenceTarget {
  nodeId: string;
  type: string;
  id: string | number;
  label: string;
}

export interface DateOccurrence {
  kind: "event" | "birthday" | "column_date";
  date: string;
  dateTime?: string;
  endDateTime?: string;
  columnKey?: string;
  role: "event" | "birthday" | "expiration" | "generic";
  title: string;
  target: DateOccurrenceTarget;
  originalDateText?: string;
}

export interface DateOccurrencesResponse {
  upcoming: DateOccurrence[];
  past: DateOccurrence[];
  window: {
    today: string;
    until: string;
    pastSince: string;
    days: number;
    pastDays: number;
  };
  generatedAt: string;
}

export interface GraphOverviewResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats?: {
    totalNodes?: number;
    totalEdges?: number;
    totalMemories?: number;
    memoriesLast7Days?: number;
  };
}

export type SelectionSource = "latest" | "search" | "schedule" | "mini-graph";

export type DashboardSelection =
  | {
      kind: "memory";
      memoryId: number;
      graphNodeId: string;
      source: SelectionSource;
      view?: CardView;
      /** 상세 로딩 완료 후 채워지는 metadata — 삭제 버튼의 파생 건수 표시에 재사용(재조회 없음). */
      metadata?: Record<string, unknown>;
      memory?: MemorySummary;
    }
  | {
      kind: "graph-node";
      graphNodeId: string;
      source: "mini-graph";
      view: CardView;
    }
  | { kind: "none" };

export interface ArchiveItem {
  id: number;
  content?: string;
  archivedAt?: string;
  purgeAt?: string;
  [key: string]: unknown;
}

export interface ArchivePage {
  archive: ArchiveItem[];
  total: number;
  nextCursor: string | null;
}

export interface CleanupProposal {
  id: string;
  kind: string;
  status: string;
  payload?: unknown;
  reason?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface CleanupProposalItem {
  itemKey: string;
  group: string;
  key: string;
  value: unknown;
}

export interface CleanupProposalItemOutcome {
  itemKey: string;
  status: "applied" | "skipped" | "failed";
  detail: string | null;
}

export interface CleanupProposalDetail extends CleanupProposal {
  items: CleanupProposalItem[];
  journal: CleanupProposalItemOutcome[];
}

export interface CleanupProposalActionResult {
  approved?: string;
  rejected?: string;
  status?: string;
  appliedCount?: number;
  items?: CleanupProposalItemOutcome[];
  error?: string;
}

export type DashboardPage = "main" | "archive" | "proposals";

export interface CleanupRunAvailability { available: boolean; running: boolean; reasons: string[] }

export interface CleanupRunStageView {
  stage: string;
  processed: number;
  completed: number;
  completedNoop: number;
  failures: number;
  terminal: number;
  autoApplied?: number;
  proposed?: number;
  alreadyProcessed?: number;
  failureReasons?: string[];
}

export interface CleanupRunView {
  runId: string;
  status: "running" | "completed" | "cancelled" | "failed";
  /** stopReason = run 이 failed 로 멈춘 원인(키 이름만, 값 없음). */
  aggregates: { stageAggregates: CleanupRunStageView[]; stopReason?: string } | null;
}

export interface RecentAutoRegisterItem {
  id: number;
  itemKind: "entity_created" | "entity_linked" | "schedule_created" | "memo_date_filled";
  targetType: string;
  targetId: string;
  name: string;
  sourceNodeId: number;
  /** null = 원본 메모 없음(휴지통으로 갔거나 영구 삭제됨). */
  memoContent: string | null;
  date: string | null;
  runId: string | null;
  createdAt: string;
}

export interface EntityRegisterRevertResult {
  recordId: number;
  removedEdges: number;
  deletedRow: { typeName: string; id: string } | null;
  keptRowReason: string | null;
  removedAlias: string | null;
  trashedScheduleNodeId: number | null;
  /** 메모 날짜 기록을 되돌려 지운 날짜. 안 지웠으면(그 사이 바뀜·메모 없음·다른 기록) null. */
  clearedMemoDate: string | null;
}
