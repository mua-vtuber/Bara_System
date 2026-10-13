/**
 * store-internal/node-repo-lifecycle-mixin.ts — 노드 수정·삭제·접근 갱신 묶음
 * (P3 G5-a 분해 — 옛 node-repository.ts 에서 이동, 내용 무변경).
 *
 * emit 보존: deleteNode → 'node-deleted', updateNodeImportance → 'node-edited',
 * editNodeContent → 'node-edited'(본문이 바뀐 편집만 — 분류만 바꾼 편집은 보내지 않는다).
 */

import type { MemoryNode, MemoryRevision } from "../../memory/types.ts";
import type {
  CompleteMessageSplitArgs,
  DeleteBySourceNodesResult,
  EditNodeContentArgs,
  EditNodeContentResult,
  MessageAttachmentRemovalResult,
  MessageSourceRows,
} from "./args-types.ts";
import type { KnowledgeNodeRow, MemoryRevisionRow } from "./row-types.ts";
import { nowKst, rowToMemoryRevision, rowToNode } from "./helpers.ts";
import { toNfc } from "../../memory/nfc.ts";
import { contentHash } from "../../memory/content-hash.ts";
import { readSharedMemory } from "../../memory/shared-memory-contract.ts";
import { SharedMemoryMutationError } from "../../memory/shared-memory-mutation-error.ts";
import { invalidateSharedMemoryDerivatives } from "../../memory/shared-memory-invalidation.ts";
import { withMemoryMutationLock } from "../../memory/shared-memory-mutation-lock.ts";
import { extractionClaimChanged } from "../../memory/claim-text.ts";
import {
  EXTRACTED_PATH,
  EXTRACTED_TO_PATH,
  EXTRACTION_PENDING,
  isBackfillSourceType,
  markExtractionPendingInMetadata,
} from "./extraction-state-sql.ts";
import type { Constructor, NodeRepoInternals } from "./node-repo-base.ts";
import { inIdBatches, sqlPlaceholders } from "./id-batches.ts";
import { deleteNodeWithLineageSync, type DeleteNodeResult } from "./node-removal.ts";
import {
  editedOutAttachmentKeysSync,
  removeMessageSourceSync,
  stripSourceMessageMarkersSync,
} from "./message-source-removal.ts";
import { isMessageTextRow } from "./node-source-repository.ts";
import {
  RemovedAssetHolders,
  noAssetCleanup,
  releaseRemovedAssetsSync,
  removeReleasedAssetFiles,
} from "./asset-release.ts";

export function NodeRepoLifecycleMixin<
  TBase extends Constructor<NodeRepoInternals>,
>(Base: TBase) {
  return class NodeRepoLifecycleMixed extends Base {
    /**
     * 기존 노드 id 를 유지한 채 content 와 텍스트 임베딩을 교체한다.
     *
     * 수동 편집은 "새 노드로 대체"가 아니라 같은 id 의 오탈자/내용 정정이다. 그래서
     * old_node_id/new_node_id 둘 다 같은 id 인 revision snapshot 을 남기고, 검색 파생물은
     * 새 본문 기준으로 갱신한다. hashtag/mention 재배선은 라우트가 이어서 호출하므로,
     * 여기서는 이 노드 자신이 만든 직접 edge 만 걷어 새 배선이 중복 없이 들어갈 공간을 만든다.
     *
     * NFC 정규화 경계(G3-a) — addNodeIdempotent 와 같은 규칙. 진입 시 `args.content` 를
     * NFC 로 한 번 통일해 로컬 `content` 로 고정하고, 임베딩·UPDATE·revision 스냅샷의
     * new_content 가 모두 이 로컬을 쓴다(trim 없음 — 저장 content 계약 동일).
     *
     * PS-1 — 분류(capture)만 바꾸는 편집은 저장 본문이 같아 임베딩을 계산하지 않는다. 판단은
     * 쓰기 잠금 안에서 읽은 저장 본문으로 한다. 'node-edited' 신호는 본문이 바뀐 편집만 보내고,
     * 검색 캐시 키(dbRevision)는 metadata 가 바뀌므로 항상 올린다.
     */
    async editNodeContent(args: EditNodeContentArgs): Promise<EditNodeContentResult | null> {
      return withMemoryMutationLock(this, async () => {
      const content = toNfc(args.content);
      const stored = this.db.query("SELECT content FROM knowledge_nodes WHERE id = ?")
        .get(args.nodeId) as { content: string } | null;
      if (!stored) return null;
      const vector = stored.content === content ? null : await this.embedder.embed(content);
      const result = this.editNodeContentPrepared({ ...args, content }, vector);
      if (result) {
        if (result.contentChanged) this.autoCleanupTrigger?.emit("node-edited");
        this.dbRevision += 1;
      }
      return result;
      });
    }

    /**
     * Synchronous commit half, also used inside a versioned mutation's ledger transaction.
     * `vector` is the embedding of the new content, or null when the caller read the same
     * stored content; a content change without a vector means the row was written outside
     * the mutation lock after that read, and the edit stops.
     *
     * Only a changed claim (the body the extractor reads, without hashtags) invalidates
     * derived memories. Such an edit also marks a backfill source as waiting for extraction,
     * so the backfill extracts the new claim instead of trusting the old record.
     */
    editNodeContentPrepared(args: EditNodeContentArgs, vector: Float32Array | null): EditNodeContentResult | null {
      const content = toNfc(args.content);
      if (vector !== null && vector.length !== this.embedder.dimension) {
        throw new Error(
          `editNodeContent embedding dim mismatch: got ${vector.length}, expected ${this.embedder.dimension}`,
        );
      }

      const updateNode = this.db.query(
        "UPDATE knowledge_nodes SET content = ?, content_hash = ?, metadata_json = ?, updated_at = ? WHERE id = ?",
      );
      const deleteVec = this.db.query("DELETE FROM vec_nodes WHERE node_id = ?");
      const insertVec = this.db.query(
        "INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)",
      );
      const deleteOwnConceptEdges = this.db.query(
        "DELETE FROM node_concept_edges WHERE node_id = ? AND source_node_id = ?",
      );
      const deleteOwnPersonEdges = this.db.query(
        `DELETE FROM node_person_edges
         WHERE node_id = ? AND source_node_id = ? AND relation <> 'authored_by'`,
      );
      const insertRevision = this.db.query(
        `INSERT INTO memory_revisions
          (old_node_id, new_node_id, revision_type, reason, similarity_score,
           old_content, new_content, editor, edit_source, created_at, source_message_id, source_platform)
         VALUES (?, ?, 'manual', ?, NULL, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      );

      const tx = this.db.transaction((): EditNodeContentResult | null => {
        const oldRow = this.db.query("SELECT * FROM knowledge_nodes WHERE id = ?")
          .get(args.nodeId) as KnowledgeNodeRow | null;
        if (!oldRow) return null;
        const oldNode = rowToNode(oldRow);
        const state = readSharedMemory(oldNode.metadata);
        if (args.expectedRevision !== undefined) {
          if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0) {
            throw new SharedMemoryMutationError("INVALID_INPUT", "expectedRevision must be a non-negative integer", args.nodeId);
          }
          if (args.expectedRevision !== state.revision) {
            throw new SharedMemoryMutationError("CONFLICT", "memory changed since it was read", args.nodeId, state.revision);
          }
        }
        const contentChanged = content !== oldRow.content;
        let newVector: Float32Array | null = null;
        if (contentChanged) {
          if (vector === null) {
            throw new Error(
              `editNodeContent: memory ${args.nodeId} content changed outside the mutation lock after it was read; the new content has no embedding`,
            );
          }
          newVector = vector;
        }
        // SL-2 — tags are not part of the claim, so a tag-only edit keeps derived memories.
        const claimChanged = contentChanged && extractionClaimChanged(oldRow.content, content);
        const metadata: Record<string, unknown> = { ...oldNode.metadata, sharedMemory: { ...state, revision: state.revision + 1 } };
        if (args.capture === null) delete metadata.capture;
        else if (args.capture !== undefined) metadata.capture = args.capture;
        if (claimChanged && isBackfillSourceType(oldRow.source_type)) markExtractionPendingInMetadata(metadata);
        const editedAt = nowKst();
        updateNode.run(content, contentHash(content), JSON.stringify(metadata), editedAt, args.nodeId);
        if (newVector !== null) {
          deleteVec.run(args.nodeId);
          insertVec.run(args.nodeId, newVector);
          deleteOwnConceptEdges.run(args.nodeId, args.nodeId);
          deleteOwnPersonEdges.run(args.nodeId, args.nodeId);
        }

        const revisionRow = insertRevision.get(
          args.nodeId,
          args.nodeId,
          args.reason ?? null,
          oldRow.content,
          content,
          args.editor ?? null,
          args.editSource ?? null,
          editedAt,
          args.sourceMessage?.messageId ?? null,
          args.sourceMessage?.platform ?? null,
        ) as MemoryRevisionRow;

        // WP-B1-20U 설계 17.7 — 철회한 파생에 이 편집의 이력 행 id 를 적는다. 메시지 동기 수정이면 그 메시지 삭제가
        // 이 id 로 남는 기억 아래의 철회된 옛 파생을 찾아 지운다.
        const affectedNodeIds = claimChanged
          ? [args.nodeId, ...invalidateSharedMemoryDerivatives(this.db, oldNode, revisionRow.id)]
          : [args.nodeId];
        // Read the edited row after the invalidation: detaching a kept node rewrites the extractedTo
        // lists of the withdrawn lineage, and a caller that writes this snapshot back (MCP update_memory)
        // must not restore a stale list.
        const nextRow = this.db
          .query("SELECT * FROM knowledge_nodes WHERE id = ?")
          .get(args.nodeId) as KnowledgeNodeRow;

        return {
          node: rowToNode(nextRow),
          revision: rowToMemoryRevision(revisionRow),
          affectedNodeIds,
          contentChanged,
          claimChanged,
        };
      });

      return tx();
    }

    /**
     * 원문을 "추출 대기"로 표시한다(extracted = 0, extractedTo 삭제). 편집 뒤 재청크
     * (rechunkEditedOrigin)가 짧은 본문인데 살아 있는 청크 없이 계보 무효화된 청크만 남은
     * 원문을 직접 추출 후보로 되돌릴 때 쓴다. markNodeExtracted 선례대로 검색 캐시 키를 올린다.
     */
    markExtractionPending(nodeId: number): void {
      this.db
        .query(
          `UPDATE knowledge_nodes
           SET metadata_json = json_remove(json_set(COALESCE(metadata_json, '{}'), ?, ?), ?)
           WHERE id = ?`,
        )
        .run(EXTRACTED_PATH, EXTRACTION_PENDING, EXTRACTED_TO_PATH, nodeId);
      this.dbRevision += 1;
    }

    /**
     * 추출 대기 표시를 거둔다. 긴 본문을 새 청크로 나눈 뒤 부른다 — 청크가 추출 단위이고
     * 원문은 청크를 가진 긴 글(추출 기록 없음)로 돌아간다. 대기 표시가 없으면 바꾸지 않는다.
     */
    clearExtractionPending(nodeId: number): void {
      const { changes } = this.db
        .query(
          `UPDATE knowledge_nodes
           SET metadata_json = json_remove(metadata_json, ?)
           WHERE id = ? AND metadata_json ->> ? IS ?`,
        )
        .run(EXTRACTED_PATH, nodeId, EXTRACTED_PATH, EXTRACTION_PENDING);
      if (changes > 0) this.dbRevision += 1;
    }

    /**
     * 노드 한 개 영구 삭제(REST DELETE /memories/:id, 봇 /forget, OCR 청크 교체). WP-B1-20U 설계 17.3:
     * 쓰기 잠금(재진입) 안 한 트랜잭션에서 explicit/cascade 계획으로 출처 없는 자손을 함께 영구 삭제하고,
     * 그 노드들의 수정 이력(설계 15절)과 그 노드들에만 기대던 휴지통 노드까지 정리한다(본체 =
     * node-removal.ts). 존재 확인도 잠금 안이라 확인과 삭제 사이에 다른 쓰기가 끼지 못한다. 노드가 없으면
     * 아무것도 쓰지 않고 null — 신호도 캐시 키도 그대로다. 휴지통에 있는 노드는 이 통로로 지우지 않는다.
     * 첨부 해제(WP-B1-20U 설계 17.17): 같은 트랜잭션 끝에서 영구 삭제한 노드 행(holders)으로 그 노드들이 주인인 문서
     * 기록·원장 행을 지우고(releaseRemovedAssetsSync), 커밋 뒤 같은 잠금 안에서 참조를 잃은 첨부 파일과 그 asset_files
     * 행을 파일 지우기 함수로 지워 결과를 assetCleanup 에 담는다(D27 — 기억 삭제를 먼저 확정한다). 청크는 기록의 주인이
     * 아니라 청크만 지우면(OCR 청크 교체) 기록·파일이 남는다.
     */
    async deleteNode(id: number): Promise<DeleteNodeResult | null> {
      return withMemoryMutationLock(this, async () => {
        const holders = new RemovedAssetHolders();
        const removal = this.db.transaction(() => {
          const removed = deleteNodeWithLineageSync(this.db, this.nodeSources, id, holders);
          return removed === null ? null : { removed, assetRelease: releaseRemovedAssetsSync(this.db, holders) };
        })();
        if (removal === null) return null;
        // Phase 5.7.3 W3 — 데이터 변동 신호. trigger 미주입 시 no-op.
        this.autoCleanupTrigger?.emit("node-deleted");
        // Phase 6b T3 (R4) — 검색 캐시 키용 변동 카운터 상승(같은 지점 합류).
        this.dbRevision += 1;
        const assetCleanup = removeReleasedAssetFiles(this.db, this.assetFileRemover, removal.assetRelease);
        return { ...removal.removed, assetCleanup };
      });
    }

    /**
     * 한 외부 메시지의 출처 행(memory_node_sources, kind 'message' — 글 행과 첨부 행 모두)을 가진 노드(id
     * 오름차순). platform 을 주면 같은 플랫폼 행만, 주지 않으면 플랫폼 무관(WP-B1-20T 설계 5.3 1단계와 같은 조회).
     * PATCH by-source 가 맞춘 노드를 모으는 데 쓰고, 고칠 대상은 readMessageSources 의 글 행으로 가린다(WP-B1-20U
     * 설계 17.8). metadata 의 messageId 표시는 보지 않는다 — 원문 metadata 를 물려받은 추출 자식은 출처 행이 없어
     * 걸리지 않는다(설계 5.6 알려진 차이).
     */
    async findNodesBySource(opts: {
      messageId: string;
      platform?: string;
    }): Promise<MemoryNode[]> {
      if (!opts.messageId) return [];
      const ids = [...new Set(
        this.nodeSources.findMessageSync(opts.messageId, opts.platform ?? null).map((row) => row.nodeId),
      )];
      const nodes: MemoryNode[] = [];
      for (const batch of inIdBatches(ids)) {
        // dynamic SQL: placeholder count varies, keep prepare()
        const rows = this.db
          .prepare(`SELECT * FROM knowledge_nodes WHERE id IN (${sqlPlaceholders(batch.length)}) ORDER BY id`)
          .all(...batch) as KnowledgeNodeRow[];
        for (const row of rows) nodes.push(rowToNode(row));
      }
      return nodes.sort((a, b) => a.id - b.id);
    }

    /**
     * 메시지 수정 분리 판정(WP-B1-20T 설계 5.6 2단계): 그 메시지의 출처 행을 가진 노드마다 그 메시지의 글 행과
     * 나머지 출처 행. 일치 규칙은 findNodesBySource·deleteBySource 와 같은 findMessageSync 다. 글 수정의 "이 메시지
     * 행"은 첨부 id 없는 글 행뿐이라(WP-B1-20U 설계 17.8), 같은 메시지의 첨부 행은 나머지 행(otherRows)에 든다 —
     * 글을 고쳐도 첨부 파일은 그대로다. 첨부 행만 가진 노드도 항목이 있고 messageRows 가 비어 있다.
     */
    readMessageSources(opts: { messageId: string; platform?: string }): Map<number, MessageSourceRows> {
      const out = new Map<number, MessageSourceRows>();
      if (!opts.messageId) return out;
      const messageKeys = new Map<number, Set<string>>();
      for (const row of this.nodeSources.findMessageSync(opts.messageId, opts.platform ?? null)) {
        const keys = messageKeys.get(row.nodeId) ?? new Set<string>();
        if (isMessageTextRow(row, opts.messageId)) keys.add(row.key);
        messageKeys.set(row.nodeId, keys);
      }
      for (const [nodeId, rows] of this.nodeSources.listSync([...messageKeys.keys()])) {
        const keys = messageKeys.get(nodeId)!;
        out.set(nodeId, {
          messageRows: rows.filter((row) => keys.has(row.key)),
          otherRows: rows.filter((row) => !keys.has(row.key)),
        });
      }
      return out;
    }

    /**
     * 메시지 수정 분리의 옛 노드 쪽 마무리(WP-B1-20T 설계 5.6 2단계 (b)(c)). 새 본문 노드 N 을 만든 뒤
     * 호출자(PATCH by-source, 쓰기 잠금 안)가 부른다. 한 트랜잭션에서:
     *   1) 옛 노드 E 의 이 메시지 글 행을 N 으로 옮긴다(N 에 같은 키가 이미 있으면 그 행을 둔다). 같은 메시지의
     *      첨부 행은 옮기지 않는다 — 글을 고쳐도 첨부 파일은 그대로다(WP-B1-20U 설계 17.8).
     *   2) E 에 다른 출처 행이 남는지 확인한다 — 남지 않으면 분리가 아니라 같은 id 편집 대상이라 멈춘다.
     *   3) E 의 metadata messageId 가 이 메시지면 표시 세 칸을 거둔다(출처 삭제가 남는 뿌리에 하는 것과 같다).
     *   4) memory_revisions 에 E -> N 한 줄(revision_type manual)을 남긴다. 그 행에 메시지 id 와 옮긴 메시지 행의
     *      플랫폼을 적어, 메시지가 지워지면 deleteBySource 가 그 행의 본문을 지운다(WP-B1-20U 설계 17.6). 플랫폼은
     *      요청 인자가 아니라 행에서 읽는다 — 플랫폼 없이 부른 수정도 플랫폼 준 삭제가 찾을 수 있게(같은 id 수정에서
     *      memories-edit-split.ts 가 넘기는 행과 같은 첫 키의 행).
     * E 의 본문·파생·공유 기억 revision 은 바꾸지 않는다. 반환: 남긴 수정 이력 행.
     */
    completeMessageSplit(args: CompleteMessageSplitArgs): MemoryRevision {
      if (args.fromNodeId === args.toNodeId) {
        throw new Error(`completeMessageSplit: 옛 기억과 새 기억이 같은 기억 ${args.fromNodeId} 입니다`);
      }
      const selectNode = this.db.query("SELECT * FROM knowledge_nodes WHERE id = ?");
      const insertRevision = this.db.query(
        `INSERT INTO memory_revisions
          (old_node_id, new_node_id, revision_type, reason, similarity_score,
           old_content, new_content, editor, edit_source, created_at, source_message_id, source_platform)
         VALUES (?, ?, 'manual', ?, NULL, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      );
      const revision = this.db.transaction((): MemoryRevision => {
        const from = selectNode.get(args.fromNodeId) as KnowledgeNodeRow | null;
        if (!from) throw new Error(`completeMessageSplit: 옛 기억 ${args.fromNodeId} 가 없습니다`);
        const to = selectNode.get(args.toNodeId) as KnowledgeNodeRow | null;
        if (!to) throw new Error(`completeMessageSplit: 새 기억 ${args.toNodeId} 가 없습니다`);
        const keys = this.nodeSources
          .findMessageSync(args.messageId, args.platform ?? null)
          .filter((row) => row.nodeId === args.fromNodeId && isMessageTextRow(row, args.messageId))
          .map((row) => row.key);
        if (keys.length === 0) {
          throw new Error(`completeMessageSplit: 기억 ${args.fromNodeId} 에 메시지 ${args.messageId} 의 글 출처 행이 없습니다`);
        }
        const movedKeys = new Set(keys);
        const [movedRow] = this.nodeSources
          .listSync([args.fromNodeId])
          .get(args.fromNodeId)!
          .filter((row) => movedKeys.has(row.key));
        if (movedRow === undefined) {
          throw new Error(`completeMessageSplit: 기억 ${args.fromNodeId} 의 메시지 ${args.messageId} 출처 행을 다시 읽지 못했습니다`);
        }
        for (const key of keys) this.nodeSources.moveRowSync(args.fromNodeId, args.toNodeId, key);
        if (this.nodeSources.listSync([args.fromNodeId]).get(args.fromNodeId)!.length === 0) {
          throw new Error(
            `completeMessageSplit: 기억 ${args.fromNodeId} 에 다른 출처 행이 남지 않습니다 — 분리가 아니라 같은 id 편집 대상입니다`,
          );
        }
        stripSourceMessageMarkersSync(this.db, [args.fromNodeId], args.messageId);
        const row = insertRevision.get(
          args.fromNodeId,
          args.toNodeId,
          args.reason,
          from.content,
          to.content,
          args.editor,
          args.editSource,
          nowKst(),
          args.messageId,
          movedRow.platform,
        ) as MemoryRevisionRow;
        return rowToMemoryRevision(row);
      })();
      this.dbRevision += 1;
      return revision;
    }

    /**
     * 외부 메시지 삭제 동기화(Discord MessageDelete 등, DELETE /memories/by-source). WP-B1-20T 설계 5.3·5.5,
     * WP-B1-20U 설계 17.6·17.7. 쓰기 잠금 안 한 트랜잭션의 본체는 message-source-removal.ts(removeMessageSourceSync):
     * 출처 행 삭제 → 생존 규칙 계획 → 영구 삭제와 그 수정 이력 삭제 → 남는 뿌리의 메시지 표시 거둠 → 보관표 정리 →
     * 이 메시지의 동기 수정이 철회한 옛 파생 영구 삭제 → 이 메시지의 동기 수정이 남긴 이력 행의 본문 지움 → 첨부 해제
     * (문서 기록·원장 행). 커밋 뒤 같은 잠금 안에서 참조를 잃은 첨부 파일과 그 asset_files 행을 파일 지우기 함수로
     * 지우고 결과를 assetCleanup 에 담는다(설계 17.17 D27 — 기억 삭제를 먼저 확정한다).
     */
    async deleteBySource(opts: {
      messageId: string;
      platform?: string;
    }): Promise<DeleteBySourceNodesResult> {
      if (!opts.messageId) {
        return {
          deletedIds: [], derivedDeletedIds: [], keptIds: [], archivePurgedIds: [], revisionBodiesCleared: 0,
          retractedDerivedDeletedIds: [], assetCleanup: noAssetCleanup(),
        };
      }
      return withMemoryMutationLock(this, async () => {
        const { result, changed, assetRelease } = removeMessageSourceSync(
          this.db, this.nodeSources, { messageId: opts.messageId, platform: opts.platform ?? null },
        );
        // Phase 6b T3 (R4) — 출처 행·노드·보관 행·이력 행 중 무엇이든 바뀌었을 때만 검색 캐시 키 변동 카운터를
        // 올린다(일치 0개면 데이터 불변이라 안 올린다 — 불필요한 캐시 무효 회피).
        if (changed) this.dbRevision += 1;
        const assetCleanup = removeReleasedAssetFiles(this.db, this.assetFileRemover, assetRelease);
        return { ...result, assetCleanup };
      });
    }

    /**
     * 메시지 수정에서 뺀 첨부(PATCH /memories/by-source 의 attachmentIds, WP-B1-20U 설계 17.9 — Q6 기본값).
     * keepAttachmentIds 는 수정 뒤 그 메시지에 남은 첨부 id 전부다. 쓰기 잠금 안 한 트랜잭션에서 그 메시지의 첨부 행
     * (살아 있는 표와 휴지통 노드의 보관표) 중 남은 첨부의 키가 아닌 것을 고르고(editedOutAttachmentKeysSync), 메시지
     * 삭제와 같은 제거 루틴을 그 키에만 돌린다(removeMessageSourceSync 의 키 목록 규칙). 커밋 뒤 같은 잠금 안에서 참조를
     * 잃은 첨부 파일과 그 asset_files 행을 파일 지우기 함수로 지워 assetCleanup 에 담는다(설계 17.17 D27 — deleteBySource
     * 와 같은 순서). 뺀 첨부가 없으면 아무것도 쓰지 않고 빈 결과다.
     */
    async removeMessageAttachments(opts: {
      messageId: string;
      platform?: string;
      keepAttachmentIds: readonly string[];
    }): Promise<MessageAttachmentRemovalResult> {
      if (!opts.messageId) throw new Error("removeMessageAttachments: messageId 가 비었습니다");
      const platform = opts.platform ?? null;
      return withMemoryMutationLock(this, async () => {
        const removal = this.db.transaction(() => {
          const keys = editedOutAttachmentKeysSync(this.nodeSources, opts.messageId, platform, opts.keepAttachmentIds);
          if (keys.length === 0) return null;
          const removed = removeMessageSourceSync(this.db, this.nodeSources, {
            messageId: opts.messageId, platform, keys: new Set(keys),
          });
          return { keys, ...removed };
        })();
        if (removal === null) {
          return {
            removedAttachmentKeys: [], deletedIds: [], derivedDeletedIds: [], keptIds: [], archivePurgedIds: [],
            assetCleanup: noAssetCleanup(),
          };
        }
        if (removal.changed) this.dbRevision += 1;
        const assetCleanup = removeReleasedAssetFiles(this.db, this.assetFileRemover, removal.assetRelease);
        const { deletedIds, derivedDeletedIds, keptIds, archivePurgedIds } = removal.result;
        return { removedAttachmentKeys: removal.keys, deletedIds, derivedDeletedIds, keptIds, archivePurgedIds, assetCleanup };
      });
    }

    async touchNodesBatch(ids: readonly number[]): Promise<void> {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => "?").join(",");
      this.db
        // dynamic SQL: placeholder count varies, keep prepare()
        .prepare(
          `UPDATE knowledge_nodes
           SET last_accessed_at = ?,
               access_count = access_count + 1
           WHERE id IN (${placeholders})`,
        )
        .run(nowKst(), ...ids);
    }

    async updateNodeImportance(id: number, importance: number): Promise<void> {
      this.db
        .query("UPDATE knowledge_nodes SET importance = ? WHERE id = ?")
        .run(importance, id);
      // Phase 5.7.3 W3 — 데이터 변동 신호. trigger 미주입 시 no-op.
      this.autoCleanupTrigger?.emit("node-edited");
      // Phase 6b T3 (R4) — 검색 캐시 키용 변동 카운터 상승(같은 지점 합류).
      this.dbRevision += 1;
    }
  };
}
