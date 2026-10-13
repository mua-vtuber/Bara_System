/**
 * store-internal/args-types.ts — store.ts 공개 인자·결과 타입 모음.
 *
 * AddNodeArgs / FtsHit / VectorHit 는 store.ts 에서 re-export 하므로
 * 외부 호출자(store.test.ts 등)가 from "./store.ts" 로 가져올 수 있다.
 */

import type { MemoryNode, MemoryRevision, MemoryType, Polarity, SourceType } from "../../memory/types.ts";
import type { NodeProvenance } from "../../memory/node-sources/source-ref.ts";
import type { NodeSourceRow } from "./node-source-repository.ts";
import type { AssetCleanup } from "../../assets/released-asset-files.ts";

/** Inputs to `addNode`. Everything except `content` has a sensible default. */
export interface AddNodeArgs {
  content: string;
  memoryType?: MemoryType;
  sourceType?: SourceType;
  importance?: number;
  confidence?: number;
  platform?: string;
  author?: string;
  metadata?: Record<string, unknown>;
  /**
   * Optional pre-computed embedding. If omitted, the store calls
   * `embedder.embed(content)` itself. Useful when the caller already has
   * the vector (e.g. extractor reused it for similarity dedup before
   * insertion).
   */
  embedding?: Float32Array;
  /**
   * D8 — 다중 프로젝트 어휘 가르마(knowledge_nodes.project_id, 기준 스키마).
   * 미지정 시 NULL 로 들어간다(라벨 없음 = 공통 어휘).
   */
  project_id?: string | null;
  /**
   * D7 — 감정 극성 라벨(knowledge_nodes.polarity, 기준 스키마).
   * 'positive' | 'negative' | 'neutral'. 미지정 시 NULL 로 들어간다(라벨 없음).
   *
   * 1.1c 는 이 칸을 *읽어 거르는* polarity 필터(spec 5.5)와 *입력 시점 수동 라벨*
   * 통로만 더한다. 자동 채움(regex/LLM 추론)은 Phase 6 cleanup-AI(spec 3.3.1).
   * project_id 와 동일한 입력 통로 패턴(1.1b T1).
   */
  polarity?: Polarity;
  /**
   * Phase 7 갈래 1 — 사건 발생 시각(knowledge_nodes.event_at, 기준 스키마).
   * "이 사건이 언제 일어났나"(과거 포함)를 ISO 날짜·시각 문자열로 담는다. 등록 시각
   * created_at 과 별개다. 미지정 시 NULL 로 들어간다(시각 미상). 자동 채움(추출기에서
   * 날짜 추출)은 후속 Task 4. project_id / polarity 와 동일한 입력 통로 패턴.
   */
  eventAt?: string | null;
  /**
   * WP-B1-20T — 이 저장·흡수 한 번의 출처(설계 3.5·3.6). source 면 새 노드든 흡수든 출처 행
   * (memory_node_sources)을 남기고, derived 면 계보 부모로 가는 엣지를 남긴다. 운영 코드는 항상
   * 명시한다(production-node-provenance.test.ts 가 강제). 비어 있으면 저장소가 인자에서 결정적으로
   * 정한다 — 파생 모양이면 부모 없는 derived, 아니면 describeInputSource(platform, author, metadata).
   * 이 도출은 테스트의 짧은 호출(`store.addNode({ content })`)을 위한 것이다.
   */
  provenance?: NodeProvenance;
}

/**
 * Result of `addNodeIdempotent` — the node id plus whether an existing node was
 * reused (P0-A input idempotency). `reused: true` means an exact-duplicate
 * (normalized content_hash match) was found and its mention was bumped instead
 * of inserting a new node; `id` is the existing node's id.
 */
export interface AddNodeResult {
  id: number;
  reused: boolean;
}

/** Inputs to an in-place memory edit. The node id is preserved. */
export interface EditNodeContentArgs {
  nodeId: number;
  content: string;
  /** Optional for legacy callers; checked again after embedding, inside the write transaction. */
  expectedRevision?: number;
  reason?: string | null;
  editor?: string | null;
  editSource?: string | null;
  /** Validated user-facing classification. Undefined preserves the previous value. */
  capture?: { kind: string; source: "user" | "ai" } | null;
  /**
   * WP-B1-20U 설계 17.6 — 외부 메시지 수정 동기화(PATCH by-source)의 같은 id 수정일 때만 준다. 수정 이력 행에
   * 메시지 id 와 그 노드의 이 메시지 출처 행 플랫폼을 적어, 메시지가 지워지면 deleteBySource 가 그 행의 본문을
   * 지운다. by-id 편집(대시보드·AI·봇 /edit)은 주지 않는다 — 그 행은 본문이 남는다(17.6 알려진 차이).
   */
  sourceMessage?: { messageId: string; platform: string | null };
}

/** Result of an in-place content edit plus its revision snapshot. */
export interface EditNodeContentResult {
  node: MemoryNode;
  revision: MemoryRevision;
  affectedNodeIds: number[];
  /** The stored content (including hashtags) changed; the embedding was replaced. */
  contentChanged: boolean;
  /**
   * The claim the extractor reads (content without hashtags) changed. Only then are
   * derived memories invalidated and a backfill source marked as waiting for extraction.
   */
  claimChanged: boolean;
}

/**
 * 출처 삭제(deleteBySource) 결과 — 노드 id 목록(WP-B1-20T 설계 5.3, 16절: 휴지통 이동 칸 없음).
 * 모든 목록은 오름차순이다.
 */
export interface DeleteBySourceNodesResult {
  /** 이 메시지의 출처 행을 가졌고 영구 삭제된 노드. */
  deletedIds: number[];
  /** 계보로 함께 영구 삭제된 노드(이 메시지의 출처 행은 없었다). */
  derivedDeletedIds: number[];
  /** 이 메시지의 출처 행을 잃었지만 다른 출처 행이나 살아 남는 계보 부모로 남은 노드. */
  keptIds: number[];
  /**
   * 휴지통에서 영구 삭제한 노드 — 메시지 삭제의 보관표 정리(설계 5.5)와, 아래 철회된 파생을 지울 때 그 노드에만
   * 기대던 보관 노드(WP-B1-20U 설계 17.7).
   */
  archivePurgedIds: number[];
  /**
   * 이 메시지의 동기 수정이 남긴 수정 이력 행 중 본문을 지운 행 수(WP-B1-20U 설계 17.6) — 다른 출처로 살아 남은
   * 노드와 휴지통에 남은 노드의 행. 영구 삭제된 노드의 행은 통째로 지워져 여기 세지 않는다.
   */
  revisionBodiesCleared: number;
  /**
   * 살아 남은 기억 아래에서 영구 삭제한 철회된 옛 파생(WP-B1-20U 설계 17.7) — 이 메시지의 동기 수정이 계보 무효화로
   * 철회했고(sharedMemory.invalidatedByRevision) 자기 출처 행이 없던 노드와, 그 노드에만 기대던 출처 없는 자손.
   */
  retractedDerivedDeletedIds: number[];
  /**
   * 첨부 파일 정리(WP-B1-20U 설계 17.17) — 영구 삭제한 노드가 주인이던 문서 기록, 지운 파일, 이미 없던 파일, 지우지
   * 못한 파일(경로·원인, asset_files 행은 대기로 남아 서버 시작 때 다시 지운다). 기억 삭제는 이미 커밋됐다.
   */
  assetCleanup: AssetCleanup;
}

/**
 * 메시지 수정에서 뺀 첨부의 제거(removeMessageAttachments) 결과 — WP-B1-20U 설계 17.9. 메시지 삭제와 같은 제거
 * 루틴을 그 첨부 키에만 돌린 결과라 칸의 뜻은 DeleteBySourceNodesResult 와 같다. 모든 목록은 오름차순이고, 뺀 첨부가
 * 없으면 빈 배열들이다.
 */
export interface MessageAttachmentRemovalResult {
  /** 지운 첨부 출처 행의 키(살아 있는 표와 휴지통 노드의 보관표). */
  removedAttachmentKeys: string[];
  deletedIds: number[];
  derivedDeletedIds: number[];
  keptIds: number[];
  archivePurgedIds: number[];
  assetCleanup: AssetCleanup;
}

/**
 * 메시지 수정 분리 판정(WP-B1-20T 설계 5.6 2단계) — 그 메시지의 출처 행을 가진 노드 하나의 출처 행.
 * messageRows 는 이 메시지의 글 행(첨부 id 없는 키 — 플랫폼을 주지 않은 조회면 여러 플랫폼 키일 수 있다),
 * otherRows 는 그 밖의 행(같은 메시지의 첨부 행 포함, WP-B1-20U 설계 17.8).
 */
export interface MessageSourceRows {
  messageRows: NodeSourceRow[];
  otherRows: NodeSourceRow[];
}

/** 메시지 수정 분리의 옛 노드 쪽 마무리(WP-B1-20T 설계 5.6 2단계 (b)(c)). */
export interface CompleteMessageSplitArgs {
  /** 다른 출처로 남는 옛 노드 E. 본문·파생은 바뀌지 않는다. */
  fromNodeId: number;
  /** 새 본문을 가진 노드 N(새로 만들었거나 같은 본문으로 다시 쓴 노드). */
  toNodeId: number;
  messageId: string;
  /** 주면 같은 플랫폼의 메시지 행만, 없으면 플랫폼 무관(출처 삭제와 같은 일치 규칙). */
  platform?: string;
  /** memory_revisions.reason — 분리 표시를 담는다. */
  reason: string;
  editor: string | null;
  editSource: string;
}

/** A single FTS5 hit returned by `searchByFts`. Higher score = better match. */
export interface FtsHit {
  nodeId: number;
  score: number;
}

/** A single vec0 KNN hit. Distance is cosine in [0, 2] (0 = identical). */
export interface VectorHit {
  nodeId: number;
  distance: number;
}
