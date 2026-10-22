/**
 * routes/search-ancillary-visibility.ts — 검색 부가 출력의 출처 판정(WP-B1-03 / SL-1).
 *
 * 검색 응답은 결과 노드 말고도 부모 치환·이웃 청크·요약·엔티티·개념 확장·이미지 캡션을
 * 싣는다. 이 부가 출력은 결과 노드가 아니라 *다른* 노드·문서에서 온다. 그래서 항목마다 그
 * 항목이 실제로 온 출처를, 결과를 거른 것과 같은 가시성 스냅샷의 같은 (scope,
 * includeInactive) 보기로 판정한다. 출처가 허용되지 않은 항목만 빼고, 이번 응답에서 실제로
 * 뺀 항목이 1개 이상인 종류만 omittedAncillary 에 적는다. DB 어딘가의 무관한 비활성 노드는
 * 판정에 끼지 않는다(옛 전역 `restricted` 판정이 부가 출력 전부를 끄던 결함의 해소).
 *
 * 종류별 규칙(이 모듈이 단일 출처):
 *   - parentSubstitution: 부모 id 가 허용일 때만 자식을 부모로 바꾼다. 아니면 자식 그대로.
 *   - neighborContext: getNeighborChunks 후보를 id 로 거른 뒤 묶는다.
 *   - imageCaptions: 역할별 후보(최신순) 중 허용된 가장 최신 캡션. 더 최신 캡션을 빼면 기록.
 *   - summaries: 청크요약 = 청크와 그 청크의 llm_extract 자식이 모두 허용(요약 입력이 그
 *     자식 원자 기억이다). 관계요약 = source_document_id 의 document 노드가 허용.
 *   - conceptExpansion: 결과 노드의 직접 개념은 유지. 이웃 개념은 연결 엣지의 출처로 거른다
 *     (아래 CONCEPT_EDGE_SOURCE_CLASS 표).
 *   - entityHits: entity_concept_edges.source_node_id 출처 노드 중 하나라도 허용이면 포함.
 *     노드 출처가 없는 엔티티(대시보드에서 사용자가 만든 것)는 scope 없는 검색에서만 포함하고,
 *     scope 검색에서는 프로젝트를 증명할 수 없어 뺀다.
 *   - 이미지 taggedWith 는 결과 이미지 자신의 분류라 판정 대상이 아니다.
 */

import type { SqliteMemoryStore } from "../../db/store.ts";
import type {
  ConceptExpansion,
  ConceptNeighborEdge,
  ImageCaptionCandidate,
  ImageCaptionCandidates,
} from "../../db/store-internal/search-repo-node-meta.ts";
import type { RelationSummaryRow } from "../../db/store-internal/summary-repository.ts";
import {
  assembleNeighborContext,
  type CenterChunk,
  type NeighborChunk,
  type NeighborContext,
} from "../../memory/neighbor-chunks.ts";
import { isProvenance, type Provenance } from "../../memory/provenance-vocabulary.ts";
import { listRelationEdges } from "../../memory/relation-reader.ts";
import type { ResolvedMemoryScope } from "../../memory/shared-memory-contract.ts";
import {
  getMemoryVisibilitySnapshot,
  type MemoryVisibilityView,
} from "../../memory/shared-memory-read.ts";

/** omittedAncillary 에 적는 종류 — 이 순서가 회신 순서다. */
export const ANCILLARY_KINDS = [
  "conceptExpansion",
  "neighborContext",
  "parentSubstitution",
  "summaries",
  "entityHits",
  "imageCaptions",
] as const;

export type AncillaryKind = (typeof ANCILLARY_KINDS)[number];

/**
 * concept_edges 이웃 엣지의 출처 부류.
 *   - sourceNode: 글 내용에서 나온 관계 — source_node_id 가 가리키는 노드가 허용이어야 한다.
 *   - relationSummaryDocument: 문서에서 발굴한 관계 — 같은 방향 개념 쌍의 relation_summaries
 *     중 하나라도 source_document_id 의 document 노드가 허용이어야 한다.
 *   - vocabulary: 사용자·시스템이 만든 어휘 관계 — 기억 내용에서 오지 않아 항상 유지한다.
 */
export type ConceptEdgeSourceClass = "sourceNode" | "relationSummaryDocument" | "vocabulary";

/**
 * concept_edges.provenance → 출처 부류. source_node_id 가 있는 엣지는 부류와 무관하게 그
 * 노드로 판정하고, 이 표는 source_node_id 가 없는 엣지에 쓴다. 코드상 concept_edges 작성자:
 *   - hashtag     → hashtag-entity-wiring 의 addPersonAttributeConcept(원본 노드 id 기록).
 *   - llm_extract → cleanup summary-cycle 의 addConceptEdge(relation 'llm_relation',
 *                   source_node_id 없음 — 근거 문서는 relation_summaries.source_document_id).
 *   - user_input  → persons 라벨 REST, 글 없는 엔티티 입력(source_node_id 없음 — 사용자 어휘).
 *   - regex·image·evolver → concept_edges 작성자 없음. 글 내용에서 나오는 관계라 출처 노드가
 *                   없으면 증명할 수 없다(뺀다).
 *   - system·migration → concept_edges 작성자 없음. 글과 무관한 구조·이전 데이터라 어휘로 본다.
 * 표에 없는 provenance 값(손상 행)은 출처를 증명할 수 없어 뺀다.
 */
export const CONCEPT_EDGE_SOURCE_CLASS: Readonly<Record<Provenance, ConceptEdgeSourceClass>> = {
  hashtag: "sourceNode",
  regex: "sourceNode",
  image: "sourceNode",
  evolver: "sourceNode",
  llm_extract: "relationSummaryDocument",
  user_input: "vocabulary",
  system: "vocabulary",
  migration: "vocabulary",
};

/**
 * 한 검색 응답의 부가 출력 판정기 + omittedAncillary 수집기. 응답 하나에 하나를 만들고,
 * 결과 필터와 모든 부가 출력이 같은 스냅샷 보기를 쓴다(한 응답 = 한 시점).
 *
 * 결과 항목에 붙는 부가 출력의 생략은 그 항목(표시 노드 id)에 묶어 기록한다. full 모드는
 * 개념 펼침을 자식→부모 치환 *전에* 모든 결과에 계산하므로, 부모로 바뀌어 보이지 않게 된
 * 자식의 생략은 이번 응답에서 뺀 항목이 아니다 — omittedKinds 가 실제 표시 항목만 센다.
 */
export class AncillaryVisibility {
  /** 결과 항목에 묶이지 않는 생략(entityHits). */
  private readonly omittedForResponse = new Set<AncillaryKind>();
  /** 표시 노드 id → 그 항목에서 뺀 부가 출력 종류. */
  private readonly omittedByItem = new Map<number, Set<AncillaryKind>>();
  /** document_id → 그 document 노드가 이번 응답에서 허용인지(응답 안 캐시). */
  private readonly documentAllowed = new Map<string, boolean>();
  /** concept_id → 그 개념이 든 관계요약 행(응답 안 캐시). */
  private readonly summariesByConcept = new Map<string, RelationSummaryRow[]>();

  constructor(
    private readonly store: SqliteMemoryStore,
    private readonly view: MemoryVisibilityView,
    private readonly scoped: boolean,
  ) {}

  /** 이 노드가 이번 응답의 조회 규칙(scope·includeInactive)을 통과하는가. */
  admits(nodeId: number): boolean {
    return this.view.isAllowed(nodeId);
  }

  /**
   * 이번 응답에서 실제로 뺀 항목이 있는 종류(ANCILLARY_KINDS 순서). 결과 항목에 묶인 생략은
   * 실제로 표시한 항목(displayedItemIds)의 것만 센다. 없으면 빈 배열.
   */
  omittedKinds(displayedItemIds: Iterable<number>): AncillaryKind[] {
    const kinds = new Set(this.omittedForResponse);
    for (const itemId of displayedItemIds) {
      for (const kind of this.omittedByItem.get(itemId) ?? []) kinds.add(kind);
    }
    return ANCILLARY_KINDS.filter((kind) => kinds.has(kind));
  }

  private omitFor(itemId: number, kind: AncillaryKind): void {
    const kinds = this.omittedByItem.get(itemId);
    if (kinds) kinds.add(kind);
    else this.omittedByItem.set(itemId, new Set([kind]));
  }

  /** 자식 항목을 이 부모로 바꿔 보여도 되는가. 아니면 기록하고 자식을 그대로 둔다. */
  substitutesParent(childId: number, parentId: number): boolean {
    if (this.admits(parentId)) return true;
    this.omitFor(childId, "parentSubstitution");
    return false;
  }

  /**
   * 허용된 이웃 청크만으로 묶는다. 판정 없이 묶었을 때 실제로 보였을 이웃이 빠졌을 때만
   * 기록한다(토큰 한도 밖이라 원래 안 보였을 이웃은 뺀 항목이 아니다).
   */
  assembleNeighbors(
    centerId: number,
    center: CenterChunk,
    candidates: NeighborChunk[],
    maxContextTokens: number,
  ): NeighborContext {
    const admitted = candidates.filter((chunk) => this.admits(chunk.id));
    const assembled = assembleNeighborContext({ center, neighbors: admitted, maxContextTokens });
    if (admitted.length < candidates.length) {
      const unfiltered = assembleNeighborContext({ center, neighbors: candidates, maxContextTokens });
      if (unfiltered.neighbors.some((chunk) => !this.admits(chunk.id))) {
        this.omitFor(centerId, "neighborContext");
      }
    }
    return assembled;
  }

  /** 역할별로 허용된 가장 최신 캡션. 그보다 최신인 캡션을 건너뛰었으면 기록한다. */
  pickImageCaptions(
    imageId: number,
    candidates: ImageCaptionCandidates,
  ): { user: string | null; auto: string | null } {
    return {
      user: this.newestAdmittedCaption(imageId, candidates.user),
      auto: this.newestAdmittedCaption(imageId, candidates.auto),
    };
  }

  private newestAdmittedCaption(imageId: number, newestFirst: ImageCaptionCandidate[]): string | null {
    for (const caption of newestFirst) {
      if (this.admits(caption.id)) return caption.content;
      this.omitFor(imageId, "imageCaptions");
    }
    return null;
  }

  /**
   * 청크요약이 있는 노드 중 요약을 보여도 되는 노드. 노드와 그 노드의 llm_extract 자식이
   * 모두 허용이어야 한다. 자식 조회는 배치 1회(요약 있는 노드가 없으면 0회).
   */
  admitChunkSummaries(summarizedNodeIds: readonly number[]): Set<number> {
    const admitted = new Set<number>();
    if (summarizedNodeIds.length === 0) return admitted;
    const childrenByNode = this.store.getLlmExtractChildIds(summarizedNodeIds);
    for (const nodeId of summarizedNodeIds) {
      const children = childrenByNode.get(nodeId) ?? [];
      if (this.admits(nodeId) && children.every((child) => this.admits(child))) admitted.add(nodeId);
      else this.omitFor(nodeId, "summaries");
    }
    return admitted;
  }

  /** 이 항목에 관계요약을 보여도 되는가 — 근거 문서(document 노드)가 허용이어야 한다. */
  admitsRelationSummary(itemId: number, row: RelationSummaryRow): boolean {
    if (this.admitsDocument(row.sourceDocumentId)) return true;
    this.omitFor(itemId, "summaries");
    return false;
  }

  /**
   * 결과 노드의 개념 펼침. 직접 개념은 그대로, 이웃은 연결 엣지 출처로 거른다. 판정 없이
   * 펼쳤을 때 보였을 이웃 항목이 빠지거나 바뀌었으면 기록한다.
   */
  async expandConcepts(nodeId: number): Promise<ConceptExpansion> {
    const expansion = await this.store.getNodeConceptExpansion(
      nodeId,
      (edge) => this.admitsConceptEdge(edge),
    );
    if (expansion.omittedNeighbors > 0) this.omitFor(nodeId, "conceptExpansion");
    return { direct: expansion.direct, neighbors: expansion.neighbors };
  }

  /**
   * 새 종류 엔티티를 회신해도 되는가(retrieveEntities 의 admit). 출처 노드가 있으면 그중
   * 하나라도 허용이어야 하고, 없으면 scope 없는 검색에서만 받는다.
   */
  admitsEntityHit(entityId: string): boolean {
    const sourceNodeIds = new Set<number>();
    const edges = listRelationEdges(this.store.getRawDb(), {
      tableName: "entity_concept_edges",
      source: { id: entityId },
    });
    for (const edge of edges) {
      if (edge.sourceNodeId !== null) sourceNodeIds.add(edge.sourceNodeId);
    }
    const admitted = sourceNodeIds.size > 0
      ? [...sourceNodeIds].some((nodeId) => this.admits(nodeId))
      : !this.scoped;
    if (!admitted) this.omittedForResponse.add("entityHits");
    return admitted;
  }

  private admitsConceptEdge(edge: ConceptNeighborEdge): boolean {
    if (edge.sourceNodeId !== null) return this.admits(edge.sourceNodeId);
    const sourceClass = isProvenance(edge.provenance) ? CONCEPT_EDGE_SOURCE_CLASS[edge.provenance] : undefined;
    if (sourceClass === "vocabulary") return true;
    if (sourceClass === "relationSummaryDocument") {
      return this.relationSummariesFor(edge.sourceConceptId)
        .some((row) => row.fromConceptId === edge.sourceConceptId
          && row.toConceptId === edge.targetConceptId
          && this.admitsDocument(row.sourceDocumentId));
    }
    // sourceNode 부류인데 출처 노드가 없거나 표에 없는 provenance — 출처를 증명할 수 없다.
    return false;
  }

  private relationSummariesFor(conceptId: string): RelationSummaryRow[] {
    let rows = this.summariesByConcept.get(conceptId);
    if (rows === undefined) {
      rows = this.store.listRelationSummariesForConcept(conceptId);
      this.summariesByConcept.set(conceptId, rows);
    }
    return rows;
  }

  private admitsDocument(documentId: string): boolean {
    let allowed = this.documentAllowed.get(documentId);
    if (allowed === undefined) {
      // document 노드가 없으면(삭제된 문서의 남은 요약) 근거를 증명할 수 없어 뺀다.
      const documentNodeId = this.store.findDocumentNodeId(documentId);
      allowed = documentNodeId !== null && this.admits(documentNodeId);
      this.documentAllowed.set(documentId, allowed);
    }
    return allowed;
  }
}

/** 이번 응답의 판정기를 만든다 — 스냅샷은 여기서 한 번 읽는다(WP-B1-02 캐시 재사용). */
export function readAncillaryVisibility(
  store: SqliteMemoryStore,
  scope: ResolvedMemoryScope | undefined,
  includeInactive: boolean,
  now: number = Date.now(),
): AncillaryVisibility {
  const view = getMemoryVisibilitySnapshot(store, now).view(scope, includeInactive);
  return new AncillaryVisibility(store, view, scope !== undefined);
}
