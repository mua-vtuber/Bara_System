/**
 * NodeMixin — 노드 CRUD·수명주기·출처 가드 칸 위임 묶음(facade 분해 C2/store).
 * NodeRepository / RevisionRepository 위임 + setPlace 출처 가드 글루. 동작 무변경.
 */

import type {
  MemoryNode,
  MemoryRevision,
  RevisionType,
} from "../../memory/types.ts";
import type {
  CompleteMessageSplitArgs,
  DeleteBySourceNodesResult,
  EditNodeContentArgs,
  EditNodeContentResult,
  MessageAttachmentRemovalResult,
  MessageSourceRows,
} from "../store-internal/args-types.ts";
import type { FieldSource } from "../../memory/field-provenance.ts";
import type { NodeProvenance } from "../../memory/node-sources/source-ref.ts";
import type { AbsorbInputResult } from "../store-internal/node-absorption.ts";
import type { DeleteNodeResult } from "../store-internal/node-removal.ts";
import {
  setPlaceFlow,
  type SetPlaceResult,
} from "../../memory/place-provenance-flow.ts";
import type { SqliteMemoryStore } from "../store.ts";
import type { Constructor, StoreInternals } from "./base.ts";

export function NodeMixin<TBase extends Constructor<StoreInternals>>(
  Base: TBase,
) {
  return class NodeMixed extends Base {
    /**
     * 자산 글 목록(메모리). 1.0b 이후 knowledge_nodes 에는 자산 글만 남는다.
     */
    async listMemoryNodes(options: { limit?: number } = {}): Promise<MemoryNode[]> {
      return this.nodeRepo.listMemoryNodes(options);
    }

    // ── Revision 이력 CRUD (spec section 4.3) — RevisionRepository 위임 ─

    async insertRevision(args: {
      oldNodeId: number;
      newNodeId: number | null;
      revisionType: RevisionType;
      reason?: string | null;
      similarityScore?: number | null;
      oldContent?: string | null;
      newContent?: string | null;
      editor?: string | null;
      editSource?: string | null;
    }): Promise<number> {
      return this.revisionRepo.insertRevision(args);
    }

    async getRevisionsForNode(nodeId: number): Promise<MemoryRevision[]> {
      return this.revisionRepo.getRevisionsForNode(nodeId);
    }

    async listRecentRevisions(
      options: {
        since?: string;
        revisionType?: RevisionType;
        limit?: number;
      } = {},
    ): Promise<MemoryRevision[]> {
      return this.revisionRepo.listRecentRevisions(options);
    }

    async getNode(id: number): Promise<MemoryNode | null> {
      return this.nodeRepo.getNode(id);
    }

    /**
     * P0-A 입력 멱등성 — (정규화 content_hash, project_id) 로 기존 노드 id 를
     * 조회한다(없으면 null). immediate 추출 갈래가 무거운 LLM 추출 전에 재입력을
     * 미리 감지하는 프리체크에 쓴다(project 분리 계약 보존 — 다른 project 의 같은
     * 글은 재입력이 아니다).
     */
    async findNodeIdByContentHash(
      content: string,
      projectId: string | null = null,
    ): Promise<number | null> {
      return this.nodeRepo.findNodeIdByContentHash(content, projectId);
    }

    async getNodesByIds(ids: readonly number[]): Promise<MemoryNode[]> {
      return this.nodeRepo.getNodesByIds(ids);
    }

    async editNodeContent(args: EditNodeContentArgs): Promise<EditNodeContentResult | null> {
      return this.nodeRepo.editNodeContent(args);
    }

    /**
     * 노드 한 개 영구 삭제 — 출처 없는 계보 자손·수정 이력·그 노드에만 기대던 휴지통 노드까지 쓰기 잠금 안
     * 한 트랜잭션에서 정리한다(WP-B1-20U 설계 17.3). 없으면 null. 규칙 = NodeRepository.deleteNode.
     */
    async deleteNode(id: number): Promise<DeleteNodeResult | null> {
      return this.nodeRepo.deleteNode(id);
    }

    /**
     * 외부 메시지 삭제 동기화(Discord MessageDelete 등) — 그 메시지의 출처 행을 지우고, 출처 행도 살아
     * 남는 계보 부모도 없게 된 노드를 계보 자손과 함께 영구 삭제한다. 휴지통에 있던 그 메시지의 노드도
     * 정리한다(WP-B1-20T 설계 5.3·5.5). 규칙·단계 = NodeRepository.deleteBySource.
     */
    async deleteBySource(opts: {
      messageId: string;
      platform?: string;
    }): Promise<DeleteBySourceNodesResult> {
      return this.nodeRepo.deleteBySource(opts);
    }

    /**
     * 메시지 수정에서 뺀 첨부 — 그 메시지의 첨부 출처 행 중 keepAttachmentIds 에 없는 것을 메시지 삭제와 같은 제거
     * 루틴으로 지우고 첨부 파일까지 정리한다(WP-B1-20U 설계 17.9). 규칙·단계 = NodeRepository.removeMessageAttachments.
     */
    async removeMessageAttachments(opts: {
      messageId: string;
      platform?: string;
      keepAttachmentIds: readonly string[];
    }): Promise<MessageAttachmentRemovalResult> {
      return this.nodeRepo.removeMessageAttachments(opts);
    }

    async findNodesBySource(opts: {
      messageId: string;
      platform?: string;
    }): Promise<MemoryNode[]> {
      return this.nodeRepo.findNodesBySource(opts);
    }

    /** 메시지 수정 분리 판정 — 노드마다 그 메시지 행과 나머지 출처 행(NodeRepository.readMessageSources). */
    readMessageSources(opts: { messageId: string; platform?: string }): Map<number, MessageSourceRows> {
      return this.nodeRepo.readMessageSources(opts);
    }

    /** 메시지 수정 분리의 옛 노드 쪽 마무리(NodeRepository.completeMessageSplit). 쓰기 잠금 안에서 부른다. */
    completeMessageSplit(args: CompleteMessageSplitArgs): MemoryRevision {
      return this.nodeRepo.completeMessageSplit(args);
    }

    async touchNodesBatch(ids: readonly number[]): Promise<void> {
      return this.nodeRepo.touchNodesBatch(ids);
    }

    /**
     * Increment mention_count and apply a small importance boost, capped at
     * MAX_IMPORTANCE. Used when an existing node is re-mentioned in new
     * input — keeps recurring topics relevant without unbounded inflation.
     */
    async bumpMention(id: number): Promise<void> {
      return this.nodeRepo.bumpMention(id);
    }

    /**
     * 흡수 한 번 — 재언급 신호와 이번 입력의 출처(출처 행 또는 계보 엣지, WP-B1-20T). 흡수
     * 통로는 bumpMention 대신 이것을 쓴다(NodeRepository.absorbInput 주석 참조).
     */
    async absorbInput(id: number, provenance: NodeProvenance): Promise<AbsorbInputResult> {
      return this.nodeRepo.absorbInput(id, provenance);
    }

    async updateNodeImportance(id: number, importance: number): Promise<void> {
      return this.nodeRepo.updateNodeImportance(id, importance);
    }

    /**
     * Phase 7 갈래 1 + 활용 단계1 — 한 노드의 event_at 을 갱신한다. 출처 우선순위
     * 가드 적용(direct>system>inferred). 실제로 썼으면 true, skip 이면 false.
     * 상세 = NodeRepository.setEventAt.
     */
    async setEventAt(
      nodeId: number,
      eventAt: string,
      source: FieldSource,
    ): Promise<boolean> {
      return this.nodeRepo.setEventAt(nodeId, eventAt, source);
    }

    /**
     * 활용 단계2 ② — 한 노드의 event_until(일정 종료 일시)을 갱신한다. 출처
     * 우선순위 가드 적용(direct>system>inferred). 실제로 썼으면 true, skip 이면 false.
     * 상세 = NodeRepository.setEventUntil.
     */
    async setEventUntil(
      nodeId: number,
      eventUntil: string,
      source: FieldSource,
    ): Promise<boolean> {
      return this.nodeRepo.setEventUntil(nodeId, eventUntil, source);
    }

    async clearEventAt(
      nodeId: number,
      source: FieldSource,
    ): Promise<boolean> {
      return this.nodeRepo.clearEventAt(nodeId, source);
    }

    async clearEventUntil(
      nodeId: number,
      source: FieldSource,
    ): Promise<boolean> {
      return this.nodeRepo.clearEventUntil(nodeId, source);
    }

    /**
     * 활용 단계6 T3b — 한 노드의 종류별 동적 칸(글-칸) 값을 갱신한다. 출처 우선순위
     * 가드 적용(direct>system>inferred). 실제로 썼으면 true, skip 이면 false.
     * 상세 = NodeRepository.setGlobField.
     */
    async setGlobField(
      nodeId: number,
      key: string,
      value: string,
      source: FieldSource,
    ): Promise<boolean> {
      return this.nodeRepo.setGlobField(nodeId, key, value, source);
    }

    /**
     * 활용 단계2 ③ — 장소를 글에 붙이는 출처 가드 진입점. 상세 = setPlaceFlow.
     *
     * source 에 따라 데이터가 갈린다(C-1 수정): direct(직접 입력)만 콜론 #장소 경로와
     * 같은 행 게이트를 거쳐 고유명사를 1급 places 행으로 승격하고(seed·일반명사는 무행
     * 수렴), system/inferred(추출·추론)는 concept 위계만 만든다(거짓 엔티티 방지).
     * 더 높은 출처가 이미 채운 글 장소 칸은 안 덮는다(직접 입력 보호).
     *
     * @returns {wrote, skipReason?} — 성공/출처 충돌/게이트 거부를 사유와 함께 가른다
     *          (호출처가 정직한 경고로 드러낸다·silent 금지).
     */
    async setPlace(
      nodeId: number,
      value: string,
      source: FieldSource,
    ): Promise<SetPlaceResult> {
      // setPlaceFlow 의 store 의존은 합성된 SqliteMemoryStore 표면이라 mixin this 를
      // 그 타입으로 캐스트한다(런타임 this 는 모든 메서드를 가진 합성 인스턴스).
      const result = await setPlaceFlow(
        { store: this as unknown as SqliteMemoryStore, db: this.db },
        nodeId,
        value,
        source,
      );
      // 글 metadata·엔티티 합류 변동을 검색 캐시 키 카운터에 합류시킨다(setEventAt 선례 —
      // node-repository 의 dbRevision 단일 출처에 bump 통로로 모은다·새 신호 안 만듦).
      if (result.wrote) this.nodeRepo.bumpDbRevision();
      return result;
    }

    /**
     * 공통 인프라 1.2 T10 — 한 노드를 한 프로젝트(prj_)에 잇는다(project_id 칸).
     * 해시태그 `#프로젝트:X` 입력 시점 wiring 이 origin 노드를 그 프로젝트로 묶는다.
     * 상세 = NodeRepository.setNodeProjectId.
     */
    async setNodeProjectId(nodeId: number, projectId: string): Promise<void> {
      return this.nodeRepo.setNodeProjectId(nodeId, projectId);
    }

    /** Count of nodes with `created_at > since` (ISO timestamp). */
    async countNodesSince(since: string): Promise<number> {
      return this.nodeRepo.countNodesSince(since);
    }

    /**
     * Most-recently-created nodes, newest first. Ties on `created_at`
     * (SQLite's `datetime('now', 'localtime')` has only second-level precision, so
     * bursts of insertions share a timestamp) are broken by descending id —
     * i.e. the most recently allocated rowid wins.
     */
    async getRecent(limit: number): Promise<MemoryNode[]> {
      return this.nodeRepo.getRecent(limit);
    }

    /**
     * 프로젝트 노드 D2 — 한 프로젝트의 글을 최신순으로(자식 종류 제외) 돌려준다.
     * 그래프 조립이 프로젝트 → 글 허브 선을 그릴 표시 전용 읽기다. 검색 채널의
     * getNodesByProjectId 와 별개(이름·반환형 분리·RRF 경로 불변).
     */
    async getProjectMemberNodes(
      projectId: string,
      limit: number,
    ): Promise<MemoryNode[]> {
      return this.nodeRepo.getProjectMemberNodes(projectId, limit);
    }

    /**
     * 추출 대상 노드(짧은 raw `auto_capture` + 긴 글·문서의 검색용 청크
     * `document_chunk`)를 정해진 주기 추출 대상으로 조회. extractor 가 차례로 처리해
     * atomic 자식으로 세분화한다.
     *
     * 입력 통로 통합 Task 5 (spec §4 / D5·P1) — 미추출 판정은 metadata 플래그
     * (`extracted` / `extractedTo`)다. 청크=parent_of, atomic=merged_into 라 엣지
     * relation 혼동을 피하려고 완료 표시를 metadata 로 통일한다. 상세 =
     * NodeRepository.getBackfillCandidates.
     *
     * @param opts.limit          한 호출당 최대 갯수.
     * @param opts.since          ISO 시각 — 이 시점 이후 created_at 만.
     * @param opts.minImportance  importance 하한 (낮은 importance 는 노이즈
     *                            가능성 → 추출 우선순위 낮음).
     */
    async getBackfillCandidates(opts: {
      limit: number;
      since?: string;
      minImportance?: number;
    }): Promise<MemoryNode[]> {
      return this.nodeRepo.getBackfillCandidates(opts);
    }

    /**
     * 추출 완료 노드의 metadata 에 완료 플래그(`extracted:true` + `extractedTo:[ids]`)를
     * 기록한다. scheduler 가 한 후보 추출 직후 호출 — 다음 사이클에서 같은 노드가 다시
     * 줍히지 않게 한다(입력 통로 통합 Task 5). 상세 = NodeRepository.markNodeExtracted.
     */
    async markNodeExtracted(
      nodeId: number,
      extractedTo: readonly number[],
    ): Promise<void> {
      return this.nodeRepo.markNodeExtracted(nodeId, extractedTo);
    }

    /**
     * Phase 11e G2-3 (T7 / DCL-1) — VLM 캡션이 아직 없는 image_asset 후보 조회.
     * vision backfill 스케줄러가 주기마다 줍는다. has_caption_auto=0 + created_at ASC
     * + LIMIT batchSize (오래된 미캡션 우선). 상세 = NodeRepository.getUncaptionedImageCandidates.
     */
    getUncaptionedImageCandidates(opts: {
      limit: number;
    }): Array<{ nodeId: number; assetSha256: string; mime: string }> {
      return this.nodeRepo.getUncaptionedImageCandidates(opts);
    }

    /**
     * 전체 노드를 삽입 순서(id ASC)로 반환. evolver 사이클이 호출하는 메서드.
     * 운영 DB 크기를 고려해 limit 를 항상 명시할 것.
     */
    async getAllNodes(limit: number = 10_000): Promise<MemoryNode[]> {
      return this.nodeRepo.getAllNodes(limit);
    }

    /**
     * id > afterId 노드를 id ASC 로 limit 개 — 자동 정리 전량 순회 페이지 통로.
     * 상세 = NodeRepository.getNodesAfterId.
     */
    async getNodesAfterId(afterId: number, limit: number): Promise<MemoryNode[]> {
      return this.nodeRepo.getNodesAfterId(afterId, limit);
    }
  };
}
