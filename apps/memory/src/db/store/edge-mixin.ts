/**
 * EdgeMixin — 엣지·요약·개념 엣지·위계 엣지 위임 묶음(facade 분해 C2/store).
 * EdgeRepository / SummaryRepository / HierarchyEdgeRepository 위임. 동작 무변경.
 * findFlatParentTagNodes·detachParentTagEdge 가 여기 있어 ConceptMixin 의
 * addClassificationTag 가 store 자신을 ReflowStore 로 넘길 때 합성 인스턴스가 만족한다.
 */

import type {
  ConceptEdge,
  ConceptEdgeRelation,
  EdgeRelation,
  MemoryEdge,
} from "../../memory/types.ts";
import type {
  ChunkSummaryRow,
  InsertChunkSummaryArgs,
  InsertRelationSummaryArgs,
  RelationSummaryRow,
} from "../store-internal/summary-repository.ts";
import type {
  AddHierarchyEdgeArgs,
  HierarchyEndpoint,
  HierarchyEdgeRow,
  ReducedHierarchyWriteResult,
} from "../store-internal/hierarchy-edge-repository.ts";
import type { Constructor, StoreInternals } from "./base.ts";
import type { Provenance } from "../../memory/provenance-vocabulary.ts";

export function EdgeMixin<TBase extends Constructor<StoreInternals>>(
  Base: TBase,
) {
  return class EdgeMixed extends Base {
    // ── Edges — EdgeRepository 위임 ────────────────────────────────────

    async addEdge(args: {
      sourceId: number;
      targetId: number;
      relation: EdgeRelation;
      provenance: Provenance;
      sourceNodeId: number | null;
      weight: number;
    }): Promise<void> {
      return this.edgeRepo.addEdge(args);
    }

    async getNeighbors(nodeId: number, limit = 20): Promise<MemoryEdge[]> {
      return this.edgeRepo.getNeighbors(nodeId, limit);
    }

    /**
     * 한 노드에 붙은 'supersedes' 엣지 전체(양방향). 편집 후 충돌 재검사 재료.
     * EdgeRepository 위임. 상세는 그 메서드 JSDoc 참조.
     */
    async getSupersedeEdges(nodeId: number): Promise<MemoryEdge[]> {
      return this.edgeRepo.getSupersedeEdges(nodeId);
    }

    /** knowledge_edges 한 개 삭제(멱등 no-op). EdgeRepository 위임. */
    async removeEdge(
      sourceId: number,
      targetId: number,
      relation: EdgeRelation,
    ): Promise<void> {
      return this.edgeRepo.removeEdge(sourceId, targetId, relation);
    }

    // ── 요약 단계(Phase 7 깊은 패스 둘째) — SummaryRepository 위임 ──────

    /**
     * 청크요약 한 행을 임베딩과 함께 저장한다(행 + vec + has_embedding=1 한 트랜잭션).
     * Phase 7 요약 단계 글루(runSummaryCycle)가 호출. additive — 기존 메서드 불변.
     */
    async insertChunkSummary(args: InsertChunkSummaryArgs): Promise<number> {
      return this.summaryRepo.insertChunkSummary(args);
    }

    /**
     * 관계요약 한 행을 임베딩과 함께 저장한다(confidence 동반 / 행 + vec + has_embedding=1).
     * 엣지(llm_relation) 승격은 호출자가 confidence 게이트 통과분만 addEdge 로 별도 처리.
     */
    async insertRelationSummary(args: InsertRelationSummaryArgs): Promise<number> {
      return this.summaryRepo.insertRelationSummary(args);
    }

    /** 한 청크 노드의 청크요약을 읽는다(열람·검색 채널용). 없으면 null. */
    getChunkSummary(parentChunkId: number): ChunkSummaryRow | null {
      return this.summaryRepo.getChunkSummary(parentChunkId);
    }

    /** 한 개념(cpt_/psn_)이 from·to 어느 쪽에든 든 관계요약을 양방향으로 읽는다(열람용). */
    listRelationSummariesForConcept(conceptId: string): RelationSummaryRow[] {
      return this.summaryRepo.listRelationSummariesForConcept(conceptId);
    }

    // ── concept_edges (개념 ↔ 개념 위계) — EdgeRepository 위임 ─────────

    async addConceptEdge(args: {
      sourceConceptId: string;
      targetConceptId: string;
      relation: ConceptEdgeRelation;
      provenance: Provenance;
      sourceNodeId: number | null;
      weight?: number;
    }): Promise<void> {
      return this.edgeRepo.addConceptEdge(args);
    }

    async listConceptEdges(
      options: { relation?: ConceptEdgeRelation; limit?: number } = {},
    ): Promise<ConceptEdge[]> {
      return this.edgeRepo.listConceptEdges(options);
    }

    async getConceptNeighbors(conceptId: string, limit = 20): Promise<ConceptEdge[]> {
      return this.edgeRepo.getConceptNeighbors(conceptId, limit);
    }

    /**
     * Phase 7 둘째 단계 Task 15 — 한 개념의 `llm_relation` 1-hop 이웃 개념 id 회신
     * (검색 개념 채널 펼침 재료). EdgeRepository 위임. 상세는 그 메서드 JSDoc 참조.
     */
    getLlmRelationNeighborConceptIds(conceptId: string): string[] {
      return this.edgeRepo.getLlmRelationNeighborConceptIds(conceptId);
    }

    // ── hierarchy_edges (위계 단일 출처) — HierarchyEdgeRepository 위임 ──
    // 위계의 단일 출처 테이블 위 헬퍼. 모든 위계 쓰기·읽기가 이 통로 한 곳을 거친다
    // (S3 에서 옛 concept_edges parent_of 위계 메서드를 정리해 통로가 하나로 남았다).
    // 끝점 종류가 섞이므로(concept·person·8 엔티티·project) Hierarchy 접두로 이름을 둬
    // 개념 전용 메서드(addConceptEdge 의 llm_relation·has_attribute 등)와 구분한다.
    // 상세는 그 repository JSDoc 참조.

    /** 위계 엣지 추가(parent_of·weight 기본 0.9·멱등 신규 true/중복 false). */
    addHierarchyEdge(args: AddHierarchyEdgeArgs): boolean {
      return this.hierarchyEdgeRepo.addHierarchyEdge(args);
    }

    /** 지름길 감축 위계 엣지 추가(parent_of 직통 shortcut skip + target 기준 소급 prune). */
    addReducedHierarchyEdge(
      args: AddHierarchyEdgeArgs,
    ): ReducedHierarchyWriteResult {
      return this.hierarchyEdgeRepo.addReducedHierarchyEdge(args);
    }

    /** target leaf 기준으로 이미 저장된 shortcut parent_of 직통을 소급 제거한다. */
    pruneHierarchyShortcutParentsOf(endpoint: HierarchyEndpoint): number {
      return this.hierarchyEdgeRepo.pruneHierarchyShortcutParentsOf(endpoint);
    }

    /** 위계 엣지 한 개 삭제(멱등 no-op). */
    removeHierarchyEdge(
      sourceType: string,
      sourceId: string,
      targetType: string,
      targetId: string,
    ): void {
      this.hierarchyEdgeRepo.removeHierarchyEdge(sourceType, sourceId, targetType, targetId);
    }

    /** 위계 자식 BFS(downward only·weight ≥ minWeight·limit·종류 섞임·빈 seed → []). */
    getHierarchyChildrenTransitive(
      seedIds: string[],
      minWeight: number,
      limit: number,
    ): string[] {
      return this.hierarchyEdgeRepo.getParentOfChildrenTransitive(seedIds, minWeight, limit);
    }

    /** 위계 직접 자식(깊이1) id 목록. */
    getHierarchyDirectChildren(id: string): string[] {
      return this.hierarchyEdgeRepo.getDirectChildConceptIds(id);
    }

    /** 위계 직접 부모(깊이1) id 목록. */
    getHierarchyDirectParents(id: string): string[] {
      return this.hierarchyEdgeRepo.getDirectParentConceptIds(id);
    }

    /**
     * 입력 id 집합 안 양끝 매칭 parent_of 위계 엣지 조회(잎 판정·그래프 위계선 재료).
     * 옛 getParentOfEdgesWithin(concept_edges·개념 전용)의 hierarchy_edges 짝 — 끝점
     * 종류를 가리지 않는다(cpt_·psn_·엔티티 섞임). 빈 배열 입력 → 빈 배열. 상세는
     * HierarchyEdgeRepository JSDoc 참조.
     */
    getHierarchyEdgesWithin(ids: string[]): HierarchyEdgeRow[] {
      return this.hierarchyEdgeRepo.getHierarchyEdgesWithin(ids);
    }

    async countConceptCoOccurrence(
      parentConceptId: string,
      childConceptId: string,
    ): Promise<number> {
      return this.edgeRepo.countConceptCoOccurrence(parentConceptId, childConceptId);
    }

    /**
     * 자동 재정리(spec §4.2.1 B1) — 부모+자식 둘 다 role='tag' 로 붙은 과거 글 node_id
     * 회신. EdgeRepository 위임. 빈 children → 빈 배열. 상세는 그 메서드 JSDoc.
     */
    async findFlatParentTagNodes(
      parentConceptId: string,
      childConceptIds: string[],
    ): Promise<number[]> {
      return this.edgeRepo.findFlatParentTagNodes(parentConceptId, childConceptIds);
    }

    /**
     * 자동 재정리(spec §4.2.1 B1) — 한 글에서 부모 tag 엣지 한 개만 떼고 tag_reflow_log
     * 에 기록(한 트랜잭션). EdgeRepository 위임. 상세는 그 메서드 JSDoc.
     */
    async detachParentTagEdge(
      nodeId: number,
      parentConceptId: string,
      triggerHierarchy: string,
    ): Promise<void> {
      return this.edgeRepo.detachParentTagEdge(nodeId, parentConceptId, triggerHierarchy);
    }

    async getConnectedNodes(
      seedIds: readonly number[],
      options: { maxHops?: number; limit?: number } = {},
    ): Promise<Array<[number, number]>> {
      return this.edgeRepo.getConnectedNodes(seedIds, options);
    }

    /** Return the subset of `nodeIds` that are targets of a 'supersedes' edge. */
    async getSupersededNodeIds(
      nodeIds: readonly number[],
    ): Promise<Set<number>> {
      return this.edgeRepo.getSupersededNodeIds(nodeIds);
    }

    /**
     * Return the subset of `nodeIds` that are *sources* of a 'supersedes' edge
     * (the new nodes overriding an older one). Symmetric to
     * `getSupersededNodeIds`. 검색 라우트가 "갱신함" 플래그를 batch 로 붙인다.
     */
    async getSupersedingNodeIds(
      nodeIds: readonly number[],
    ): Promise<Set<number>> {
      return this.edgeRepo.getSupersedingNodeIds(nodeIds);
    }
  };
}
