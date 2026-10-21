/**
 * Shared memory domain types.
 *
 * Ports of the relevant parts of:
 *   - backend/app/models/memory.py (MemoryType, ...)
 *
 * Only the surface used by ported modules is included here. Other fields
 * (subject/predicate/object for triples, etc.) are added when the modules
 * that need them are ported.
 */

/**
 * Types of knowledge stored in the graph — 허용값의 단일 출처. MemoryType 은 이 목록에서
 * 파생되므로 값을 추가·삭제하면 검색 입구·MCP 도구·추출 파서·추출 지시문이 한꺼번에 따라온다.
 */
export const MEMORY_TYPES = [
  "fact",
  "preference",
  "triple",
  "insight",
  "episode",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * D7 — 감정 극성 라벨. knowledge_nodes.polarity 칸 값(기준 스키마).
 * NULL = 라벨 없음. 1.1c polarity 필터(spec 5.5)가 이 값을 읽어 후보를 거른다.
 */
export const POLARITIES = ["positive", "negative", "neutral"] as const;
export type Polarity = (typeof POLARITIES)[number];

/** How a knowledge node was created. */
export type SourceType =
  | "auto_capture"
  | "llm_extract"
  | "reflection"
  | "user_explicit"
  | "user_tag"
  /** Phase 14a — 문서 자산 노드. metadata.documentId / assetSha256 / title 보유. */
  | "document"
  /** Phase 14a — 문서 청크 노드. metadata.parentId(documentId) / chunkIndex / assetSha256 보유. */
  | "document_chunk"
  /** Phase 11a — 이미지 자산 atomic 노드. metadata.asset_sha256 + 해상도·mime·is_animated·warnings 보유. embedding_text=NULL (이미지는 텍스트 임베딩 없음 / image_vec 별도 채널). */
  | "image_asset"
  /**
   * Phase 11b T10 — VLM 자동 생성 캡션 자식 노드. metadata.parentId(image_asset 노드 id) +
   * captionRole='auto' 보유. content = VLM 회수 캡션 글 → bge-m3 텍스트 임베딩 자연 합류
   * (NodeRepository.addNode 통로). knowledge_edges 안 parent_of (caption → image_asset)
   * 한 줄. graceful — VLM 호출 실패 시 본 노드 생성 안 함 (자산 저장 흐름 차단 X).
   */
  | "image_caption";

/** Conversation turn shape consumed by extractors. */
export interface ConversationTurn {
  user?: string;
  bot?: string;
  author?: string;
}

/**
 * Knowledge node row from the store.
 *
 * Ported subset of backend/app/models/memory.py::KnowledgeNode. Embeddings
 * live in the vec0 virtual table `vec_nodes` and are reachable through
 * `MemoryStore.getVectorById` / `getVectorsByIds` — they no longer ride
 * along on every node row.
 *
 * (옛 `isConcept` 는 1.0b 에서 제거 — 개념은 전용 테이블 `concept_nodes`
 *  로 분리됐다. ConceptNode 참조.)
 */
export interface MemoryNode {
  id: number;
  content: string;
  memoryType: MemoryType;
  sourceType: SourceType;
  author: string;
  platform: string;
  importance: number;
  confidence: number;
  createdAt: string;
  /** 수동 본문 수정 시각. null = 생성 후 본문 수정 없음. */
  updatedAt: string | null;
  lastAccessedAt: string;
  /**
   * Phase 7 갈래 1 — 사건이 *언제* 일어났나(과거 포함). 등록 시각인 createdAt 과
   * 별개다. null = 사건 시각 미상(현재 운영 write 경로는 채우지 않아 전부 NULL).
   * 입력 통로 = AddNodeArgs.eventAt / NodeRepository.setEventAt. 후속 Task 가
   * 추출기에서 날짜를 뽑아 채우고(Task 4), 검색에서 COALESCE(event_at, created_at)
   * 범위로 거른다(Task 5).
   */
  eventAt: string | null;
  /**
   * 활용 단계2 ① — 일정 종료 일시(event_until·v23). null = 단일 시점.
   * 기간 표기용(표시 배지·검색 구간 겹침). rowToNode 가 DB 칼럼을 그대로 싣는다.
   */
  eventUntil: string | null;
  accessCount: number;
  mentionCount: number;
  lastMentionedAt: string | null;
  metadata: Record<string, unknown>;
  /**
   * D7 감정 극성 라벨(knowledge_nodes.polarity / 1.0a ALTER). null = 라벨 없음.
   * 입력 통로 = AddNodeArgs.polarity(1.1c T1). 자동 채움(regex/LLM 추론)은 Phase 6
   * cleanup-AI(spec 3.3.1) — 현재 운영 write 경로 0건이라 운영 노드는 전부 NULL.
   * 1.1c polarity 한정 query 필터(spec 5.5)가 이 값을 읽어 후보를 거른다.
   */
  polarity: Polarity | null;
  /**
   * 이 글이 속한 프로젝트(knowledge_nodes.project_id). null = 소속 프로젝트 없음.
   * 그래프 조립이 프로젝트 → 글 연결선을 그리는 입력이다. 검색·RRF 와 무관(표시
   * 전용 읽기) — eventAt·polarity 와 같이 string|null 명시 채움으로 일관성을 지킨다.
   */
  projectId: string | null;
}

/** A node that has been moved to the archive (휴지통). */
export interface ArchivedNode extends MemoryNode {
  archivedAt: string;
}

/**
 * Summary of one evolver cycle, stored in evolver_activity.
 *
 * 1.2 T13(spec 10.2 A-3): 옛 `conceptsEmerged` / `conceptsArchived` 두 칸을 제거.
 * 채우는 호출처가 0이고 봇·라우트 round-trip 도 안 읽던 죽은 값이었다.
 */
export interface EvolverActivitySummary {
  ranAt: string;
  clusterEdgesAdded: number;
  nodesArchived: number;
  nodesPurged: number;
  soonToPurgeCount: number;
}

/**
 * knowledge_edges 의 relation — 자산 글 ↔ 자산 글 관계만.
 *
 * 개념·사람 관계(옛 mentions/is_a/tagged_with/parent_of)는 1.0b 에서 전용
 * 테이블로 분리: node_concept_edges(role) / concept_edges(relation) /
 * node_person_edges(relation). ConceptRole / ConceptEdgeRelation / PersonRelation 참조.
 *
 * CHECK 제약은 DB에 두지 않음 (코드 레벨 검증) — 향후 새 relation 추가 시
 * 마이그레이션 비용 회피.
 */
export type EdgeRelation =
  | "supersedes"
  | "related_to"
  | "merged_into"
  | "contradicts"
  | "links_to"
  /** Phase 14a — document_chunk → document 노드 계층 연결. weight 1.0. */
  | "parent_of";

/**
 * node_concept_edges.role — 자산 글이 개념을 어떤 양식으로 가리키나.
 *
 * 'visual' (image-search-foundation Task 5 / D-B3) — 이미지의 SigLIP 임베딩과
 * 개념의 SigLIP 임베딩이 threshold 이상 닮았을 때 자동으로 잇는 시각 연결.
 * 사용자 손 태그('tag')와 갈래를 나눠 추적·디버깅·되돌리기가 가능하게 별 role 로
 * 둔다. node_concept_edges.role 칸은 TEXT 무제약이라 DB 스키마 변경은 0이다.
 */
export type ConceptRole = "tag" | "classification" | "mention" | "visual";

/** node_person_edges.relation — 자산 글이 사람과 맺는 관계. */
export type PersonRelation = "mentions" | "authored_by";

/**
 * concept_edges.relation — 개념 ↔ 개념.
 *
 * - parent_of (1.0b) — 태그 위계(parent → child). 콜론 선언(`#category:value`)은
 *   사용자의 명시 선언이라 weight 0.9 확정으로 잇는다(promoter 단계 승격은 폐기).
 * - llm_relation (요약 단계 정밀화 / 2026-06-05 Q14) — 강한 LLM 이 발굴한 이름 있는
 *   의미 관계(라이벌/소속/인과 등). 코사인 related_to 와 별 갈래. weight = LLM confidence.
 *   1차 구현이 knowledge_edges(글끼리)에 두었던 것을 개념 ↔ 개념(concept_edges)으로
 *   옮긴다 — "캐릭터 A —(라이벌)— 캐릭터 B" 처럼 명명 개념 사이라야 그래프가
 *   사람이 읽는 의미를 가진다(spec §4·§7·§11 Q14).
 * - has_attribute (1.2 T5) — 사람 → 개념(특성 라벨). 통일 원칙상 여러 사람이
 *   공유하는 특성(직업·회사 등)은 칸이 아니라 개념 라벨로 잇는다. source 가
 *   psn_ 인 엣지로, "개발자인 사람들" 역방향 조회(getPersonsByAttributeConcept)의
 *   재료다. parent_of(위계)·llm_relation(의미 관계)과 갈래가 다르다 —
 *   getLlmRelationNeighborConceptIds 는 relation='llm_relation' 만 보므로 영향 0.
 */
export type ConceptEdgeRelation = "parent_of" | "llm_relation" | "has_attribute";

/**
 * 개념 노드(concept_nodes). 태그·분류가 다중 역할로 한 노드에 합류.
 * 같은 이름 = 같은 노드(name UNIQUE).
 */
export interface ConceptNode {
  conceptId: string;                 // 'cpt_' + crypto.randomUUID()
  name: string;
  koName: string | null;
  koAliases: string[];               // JSON array (빈 배열 default)
  enAliases: string[];
  description: string | null;
  isTag: boolean;
  isClassificationKey: boolean;
  isClassificationValue: boolean;
  tagUsageCount: number;
  classificationUsageCount: number;
  searchBlacklist: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 사람 신원(persons). external_refs 안 어댑터별 user_id 로 합류.
 *
 * 1.2 확장 — 통일 원칙: 그 사람만의 고유 사실은 칸으로 고정(생일·주소·성별),
 * 여러 사람이 공유하는 특성은 개념 라벨로 잇는다(직업·회사는 concept_edges
 * 'has_attribute'). attributes 는 혈액형·MBTI 같은 자유형 사실로 검색에는
 * 노출하지 않는다(spec 통일 원칙·Q5).
 */
export interface Person {
  personId: string;                  // 'psn_' + crypto.randomUUID()
  displayName: string;
  aliases: string[];
  externalRefs: Record<string, string>;   // {discord_user_id, notion_user_id, ...}
  birthday: string | null;           // 생일 (고유 사실 / persons_fts 부분 매치)
  address: string | null;            // 주소 (고유 사실 / lookup·표시 중심)
  gender: string | null;             // 성별 (고유 사실 / lookup·표시 중심)
  attributes: Record<string, unknown>;     // 혈액형·MBTI 등 자유형 (검색 비노출)
  embeddingText: string | null;      // person_vec 임베딩 입력 (NULL 시 displayName fallback)
  createdAt: string;
  updatedAt: string;
}

/**
 * projects.status — 프로젝트 진행 상태. 애플리케이션 단계에서 검증하는 enum(Q1).
 * DB 칸은 TEXT 무제약(default 'active')이라 잘못된 값은 도메인 입력 통로에서 막는다.
 */
export type ProjectStatus = "active" | "done" | "paused";

/**
 * project_concept_edges.role — 프로젝트가 개념을 어떤 양식으로 가리키나.
 * 'classification' = 분류 라벨, 'tag' = 손 태그. DB 칸은 TEXT 무제약이다.
 */
export type ProjectConceptRole = "classification" | "tag";

/**
 * 프로젝트 1급 엔티티(projects). 같은 이름 = 같은 프로젝트(name UNIQUE).
 *
 * summary 는 짧은 정체성으로 의미 채널 임베딩 입력에 쓴다. attributes 는 저장소
 * URL 같은 자유형 사실로 검색에는 노출하지 않는다(Q5). embeddingText 가 NULL 이면
 * summary→name 순서로 임베딩 입력을 대체한다.
 */
export interface Project {
  projectId: string;                 // 'prj_' + crypto.randomUUID()
  name: string;
  summary: string | null;
  status: ProjectStatus;
  attributes: Record<string, unknown>;    // 저장소 URL 등 (검색 비노출)
  embeddingText: string | null;      // 요약 임베딩 입력 (NULL 시 summary→name fallback)
  createdAt: string;
  updatedAt: string;
}

/** 신규 8 엔티티 공통 토대 — name UNIQUE, 한/영 별칭, 자유 사실, 임베딩 입력. */
export interface EntityBase {
  id: string;                            // '<prefix>_' + crypto.randomUUID()
  name: string;                          // canonical (UNIQUE)
  koName: string | null;
  koAliases: string[];                   // JSON array (null/깨짐 → [])
  enAliases: string[];
  description: string | null;
  attributes: Record<string, unknown>;   // attributes_json (자유 사실 / 검색 비노출)
  embeddingText: string | null;          // <type>_vec 입력 (NULL → name fallback)
  createdAt: string;
  updatedAt: string;
}

export interface Creature extends EntityBase {}
export interface Thing extends EntityBase {}
export interface Work extends EntityBase {
  medium: string | null;                 // 매체 (B2 정체성 키 축·읽기 노출)
  createdBy: string | null;              // 작가 display_name 스냅샷 (B2 정체성 키 축·읽기 노출)
}
export interface Material extends EntityBase {
  topic: string | null;                  // 주제 (고유 사실 / 자유글)
}
export interface Intake extends EntityBase {
  expiresAt: string | null;              // 유통기한 (고유 사실 / 날짜)
}
export interface Usable extends EntityBase {
  usageInstructions: string | null;      // 사용법 (자유글)
}
export interface Place extends EntityBase {
  address: string | null;                // 주소 (고유 사실)
}
// 일정(schedule)은 전용 칸이 없는 0칸 종류다(creature·thing·material 동형). 옛 eventAt 칸은
// 글 노드 event_at 과 연동되지 않아 시간 검색에 안 잡히는 함정이라 제거했다 — 일정 날짜는 글
// event_at(knowledge_nodes.event_at) 하나로 모은다(spec 2026-06-28). eventAt 필드를 읽는
// 런타임 코드는 0건이라(grep 확인) EntityBase 만 남겨 0칸 종류로 정합한다.
export interface Schedule extends EntityBase {}

/** project_concept_edges 한 행 — 프로젝트 → 개념(특성 라벨). */
export interface ProjectConceptEdge {
  projectId: string;
  conceptId: string;
  role: ProjectConceptRole;
  createdAt: string;
}

/**
 * 프로젝트↔사람 참여 관계 — entity_relation_edges(participated_by)에서 재조립한
 * 도메인 타입(옛 전용 project_person_edges 테이블은 S4 가 제거했다).
 */
export interface ProjectPersonEdge {
  projectId: string;
  personId: string;
  /** 통합 후 role 추적 안 함 — 빈 문자열로 채운다(정직한 표현). */
  role: string;
  createdAt: string;
}

/** concept_edges 한 행 — 개념 위계 + 강도. */
export interface ConceptEdge {
  sourceConceptId: string;
  targetConceptId: string;
  relation: ConceptEdgeRelation;
  weight: number;
  createdAt: string;
  updatedAt: string;
}

/** node_concept_edges 한 행. */
export interface NodeConceptEdge {
  nodeId: number;
  conceptId: string;
  role: ConceptRole;
  createdAt: string;
}

/** node_person_edges 한 행. */
export interface NodePersonEdge {
  nodeId: number;
  personId: string;
  relation: PersonRelation;
  createdAt: string;
}

/** A row from `knowledge_edges`. */
export interface MemoryEdge {
  id: number;
  sourceId: number;
  targetId: number;
  relation: EdgeRelation;
  weight: number;
  createdAt: string;
}

/**
 * 노드 변경 이력 (memory_revisions 테이블). 2026-05-16 spec section 4.3.
 *
 * - `conflict_supersede`: ConflictChecker가 자동 supersede 판정
 * - `manual`: 사용자가 명시적으로 변경 (REST/봇 명령)
 * - `evolution`: evolver 사이클 안 자동 변환 (예: cluster → 상위 개념)
 * - `duplicate_merge`: dedup으로 다른 노드로 흡수 (mention_count만 올림)
 *
 * `newNodeId` 가 null 이면 순수 비활성화 (supersede 대상 없이 archive).
 * `similarityScore` 는 supersede/merge 시점 cosine 유사도 기록 (선택).
 */
export type RevisionType =
  | "conflict_supersede"
  | "manual"
  | "evolution"
  | "duplicate_merge";

export interface MemoryRevision {
  id: number;
  oldNodeId: number;
  newNodeId: number | null;
  revisionType: RevisionType;
  reason: string | null;
  similarityScore: number | null;
  oldContent: string | null;
  newContent: string | null;
  editor: string | null;
  editSource: string | null;
  createdAt: string;
}

export type {
  Provenance,
} from "./provenance-vocabulary.ts";

/**
 * Storage contract used by memory consumers (conflict checker, retriever,
 * extractor, etc.). The concrete implementation is `SqliteMemoryStore` in
 * `apps/memory/src/db/store.ts`; this contract exists so consumers stay
 * agnostic to the storage substrate.
 */
export interface MemoryStore {
  /** Full-text search returning `[nodeId, ftsScore]` pairs (higher = better). */
  ftsSearch(query: string, limit: number): Promise<Array<[number, number]>>;

  /** Fetch a single node, or `null` if absent. */
  getNode(id: number): Promise<MemoryNode | null>;

  /** Fetch nodes by id. Order is not guaranteed; callers re-sort if needed. */
  getNodesByIds(ids: readonly number[]): Promise<MemoryNode[]>;

  /**
   * Fetch the stored embedding for a single node. Returns `null` if the
   * node has no vec_nodes row (e.g. embedding insertion failed).
   */
  getVectorById(nodeId: number): Promise<Float32Array | null>;

  /**
   * Bulk variant of `getVectorById`. Returned map only contains ids that
   * had a vec_nodes row — missing ids are silently dropped.
   */
  getVectorsByIds(ids: readonly number[]): Promise<Map<number, Float32Array>>;

  /** Create a knowledge graph edge. Duplicate (source, target, relation) is silently ignored. */
  addEdge(args: {
    sourceId: number;
    targetId: number;
    relation: EdgeRelation;
    provenance: import("./provenance-vocabulary.ts").Provenance;
    sourceNodeId: number | null;
    weight: number;
  }): Promise<void>;

  /**
   * 한 노드에 붙은 'supersedes' 엣지 전체(source·target 양방향).
   * 편집 후 충돌 재검사(ConflictChecker.recheckAfterEdit)가 기존 충돌 상대를
   * 재평가하는 재료. 0건 = 빈 배열.
   */
  getSupersedeEdges(nodeId: number): Promise<MemoryEdge[]>;

  /**
   * knowledge_edges 한 개 삭제(멱등 no-op). (source, target, relation) UNIQUE 라
   * 최대 1행. 편집 후 충돌 재검사가 band 를 벗어난 stale supersedes 엣지를 걷는 통로.
   */
  removeEdge(
    sourceId: number,
    targetId: number,
    relation: EdgeRelation,
  ): Promise<void>;

  /** Update a node's importance value. */
  updateNodeImportance(nodeId: number, importance: number): Promise<void>;

  /**
   * Fetch all active (non-archived) nodes up to `limit`. Used by the evolver
   * for full-graph passes (value scoring + cluster edge building).
   */
  getAllNodes(limit?: number): Promise<MemoryNode[]>;

  /**
   * Record a node-revision row and return its id. ConflictChecker calls this
   * with `revisionType: "conflict_supersede"` after superseding an old node,
   * so the change shows up in revision history.
   */
  insertRevision(args: {
    oldNodeId: number;
    newNodeId: number | null;
    revisionType: RevisionType;
    reason?: string | null;
    similarityScore?: number | null;
    oldContent?: string | null;
    newContent?: string | null;
    editor?: string | null;
    editSource?: string | null;
  }): Promise<number>;

  /** All revisions touching a node (old or new side), newest first. */
  getRevisionsForNode(nodeId: number): Promise<MemoryRevision[]>;
}
