/**
 * store-internal/message-source-removal.ts — 외부 메시지 삭제 동기화의 실행 본체(Discord MessageDelete 등,
 * DELETE /memories/by-source)와 메시지 수정에서 뺀 첨부의 제거(PATCH /memories/by-source 의 attachmentIds).
 * WP-B1-20T 설계 5.3·5.5, WP-B1-20U 설계 17.6·17.7·17.9.
 *
 * 호출자(NodeRepository.deleteBySource·removeMessageAttachments)가 쓰기 잠금을 쥐고 부른다. 한 트랜잭션 안에서:
 *   1) 출처 표에서 그 메시지 행(kind 'message', external_id = messageId, platform 을 주면 같은 플랫폼만)을 모두
 *      찾아 지운다. 그 행을 가졌던 노드가 뿌리다. metadata 의 messageId 표시로 찾지 않는다(전체 훑기 없음, 색인
 *      idx_mns_external).
 *   2) planSourceRemoval(message 방아쇠) — 노드는 남은 출처 행이나 살아 남는 계보 부모가 있으면 남고, 아니면 계보
 *      자손과 함께 영구 삭제된다(설계 3.4). 같은 본문의 두 메시지(행 {M1, M2})는 두 메시지가 모두 지워질 때 지워진다.
 *   3) 없앨 노드를 영구 삭제하고, 그 노드를 가리키는 수정 이력 행을 지운다(설계 15절).
 *   4) 남는 뿌리 중 metadata 의 messageId 가 이 메시지인 것은 표시 세 칸(messageId·channelId·guildId)을 거둔다 —
 *      지워진 메시지를 더는 가리키지 않게. source·author·user_id 는 남긴다.
 *   5) 보관표 정리(설계 5.5): 휴지통에 있는 노드의 이 메시지 행을 지우고, 출처 행이 하나도 남지 않은 보관 노드와
 *      그 노드(또는 3의 삭제 노드)만 계보 부모로 가졌던 보관 노드를 영구 삭제한다. 그 노드들의 수정 이력 행도 지운다.
 *   6) 남는 기억의 철회된 옛 파생(설계 17.7, Q4 기본값): 이 메시지의 동기 수정이 남긴 수정 이력 행의 (id, 고친 노드)를
 *      모아, 살아 있는 고친 노드에서 계보 자손을 걸어 그 이력 id 로 철회된(sharedMemory.invalidatedByRevision) 출처
 *      없는 노드를 explicit/cascade 로 영구 삭제한다(단건 영구 삭제와 같은 deleteNodeWithLineageSync).
 *   7) 이 메시지의 동기 수정(PATCH by-source 의 같은 id 수정·분리 이력)이 남긴 수정 이력 행의 본문을 지운다(설계
 *      17.6) — 살아 남은 노드와 휴지통에 남은 노드의 행. 누가·언제·왜는 남는다. 이 단계가 메시지 칸도 비우므로
 *      6단계가 먼저 행을 모은다.
 * 트랜잭션 끝에서 첨부 해제(설계 17.17): 3·5·6단계가 영구 삭제한 노드 행(holders)으로 releaseRemovedAssetsSync 가 그
 * 노드들이 주인인 문서 기록·원장 행을 지우고 참조를 잃은 sha 를 돌려준다(assetRelease). 파일과 asset_files 행은 커밋
 * 뒤 같은 쓰기 잠금 안에서 호출자(deleteBySource)가 파일 지우기 함수로 지운다.
 *
 * 키 목록(설계 17.9, 메시지 수정에서 뺀 첨부): keys 를 주면 메시지 전체가 아니라 그 메시지 행 중 키가 keys 에 든 행만
 * 지운다 — 1단계(살아 있는 표)와 5단계(보관표)가 그 키의 행만 고르고, 2·3단계는 같다. 4단계는 남는 뿌리 중 이 메시지의
 * 행을 더 갖지 않은 노드만 표시를 거둔다(같은 메시지의 글 행이나 다른 첨부 행이 남은 노드는 그 메시지를 계속 가리킨다).
 * 6·7단계는 하지 않는다 — 그 둘은 메시지 글의 동기 수정이 남긴 이력을 다루고, 메시지는 남아 있다.
 */

import type { Database } from "bun:sqlite";
import type { DeleteBySourceNodesResult } from "./args-types.ts";
import type { KnowledgeNodeRow } from "./row-types.ts";
import { rowToNode } from "./helpers.ts";
import { planSourceRemoval } from "../../memory/lineage-removal.ts";
import { readSourceMessageId, withoutSourceMessageMarker } from "../../memory/source-message.ts";
import {
  isLineageInvalidated,
  readSharedMemory,
  SHARED_MEMORY_LINEAGE_RELATIONS,
} from "../../memory/shared-memory-contract.ts";
import { sourceKeyOf } from "../../memory/node-sources/source-ref.ts";
import { inIdBatches, sqlPlaceholders } from "./id-batches.ts";
import { isMessageTextRow, type NodeSourceRepository } from "./node-source-repository.ts";
import {
  clearMessageRevisionBodiesSync,
  deleteRevisionsOfRemovedNodesSync,
  listMessageEditRevisionsSync,
  type MessageEditRevision,
} from "./revision-repository.ts";
import { deleteNodesPermanentlySync, deleteNodeWithLineageSync } from "./node-removal.ts";
import { RemovedAssetHolders, releaseRemovedAssetsSync } from "./asset-release.ts";
import type { AssetRelease } from "../../assets/released-asset-files.ts";

const LINEAGE_PLACEHOLDERS = sqlPlaceholders(SHARED_MEMORY_LINEAGE_RELATIONS.length);
const ascending = (a: number, b: number) => a - b;

/**
 * 메시지 삭제 한 번의 결과(파일 단계 결과 assetCleanup 은 호출자가 커밋 뒤 더한다), 출처 행·노드·보관 행·이력 행 중
 * 무엇이든 바뀌었는지(검색 캐시 키 판단용), 첨부 해제 결과.
 */
export interface MessageSourceRemoval {
  result: Omit<DeleteBySourceNodesResult, "assetCleanup">;
  changed: boolean;
  assetRelease: AssetRelease;
}

/** 제거 대상 — 한 메시지(platform 이 null 이면 플랫폼 무관)와, 주면 그 메시지 행 중 지울 키(설계 17.9). */
export interface MessageSourceRemovalTarget {
  messageId: string;
  platform: string | null;
  keys?: ReadonlySet<string>;
}

/** 위 1~7단계와 첨부 해제를 한 트랜잭션으로 실행한다(keys 를 주면 위 키 목록 규칙). */
export function removeMessageSourceSync(
  db: Database,
  nodeSources: NodeSourceRepository,
  target: MessageSourceRemovalTarget,
): MessageSourceRemoval {
  const { messageId, platform, keys } = target;
  return db.transaction((): MessageSourceRemoval => {
    const holders = new RemovedAssetHolders();
    const rows = nodeSources.findMessageSync(messageId, platform).filter((row) => keys === undefined || keys.has(row.key));
    for (const row of rows) nodeSources.deleteSync(row.nodeId, row.key);
    const rootIds = [...new Set(rows.map((row) => row.nodeId))];
    const plan = planSourceRemoval(db, { kind: "message", rootIds });
    deleteNodesPermanentlySync(db, plan.removeIds, holders);
    const roots = new Set(plan.rootIds);
    const keptIds = plan.keptIds.filter((id) => roots.has(id));
    const unmarkedIds = keys === undefined ? keptIds : withoutMessageRows(nodeSources, keptIds, messageId);
    stripSourceMessageMarkersSync(db, unmarkedIds, messageId);
    const sweptIds = nodeSources.sweepArchiveForMessageSync(messageId, platform, plan.removeIds, holders, keys);
    deleteRevisionsOfRemovedNodesSync(db, sweptIds);
    const retracted = keys === undefined
      ? removeRetractedMessageDerivativesSync(db, nodeSources, listMessageEditRevisionsSync(db, messageId, platform), holders)
      : { deletedIds: [], archivePurgedIds: [] };
    const archivePurgedIds = [...new Set([...sweptIds, ...retracted.archivePurgedIds])].sort(ascending);
    const revisionBodiesCleared = keys === undefined ? clearMessageRevisionBodiesSync(db, messageId, platform) : 0;
    const assetRelease = releaseRemovedAssetsSync(db, holders);
    return {
      assetRelease,
      result: {
        deletedIds: plan.removeIds.filter((id) => roots.has(id)),
        derivedDeletedIds: plan.removeIds.filter((id) => !roots.has(id)),
        keptIds,
        archivePurgedIds,
        revisionBodiesCleared,
        retractedDerivedDeletedIds: retracted.deletedIds,
      },
      changed: rows.length > 0 || archivePurgedIds.length > 0 || revisionBodiesCleared > 0
        || retracted.deletedIds.length > 0,
    };
  })();
}

/**
 * 키 목록 4단계 — ids 중 이 메시지 id 의 출처 행이 더 남지 않은 노드. 표시 칸(messageId)에 플랫폼이 없어 남은 행은
 * 플랫폼과 상관없이 센다.
 */
function withoutMessageRows(nodeSources: NodeSourceRepository, ids: readonly number[], messageId: string): number[] {
  if (ids.length === 0) return [];
  const holding = new Set(nodeSources.findMessageSync(messageId, null).map((row) => row.nodeId));
  return ids.filter((id) => !holding.has(id));
}

/**
 * 메시지 수정에서 뺀 첨부의 출처 키(설계 17.9, 오름차순) — 그 메시지의 첨부 행(살아 있는 표와 휴지통 노드의 보관표) 중
 * 키가 { sourceKeyOf(message, 행의 플랫폼, messageId, a) | a ∈ keptAttachmentIds } 에 없는 행의 키. 글 행은 고르지
 * 않는다. 키는 행의 플랫폼으로 만들어 비교한다 — 키 문자열을 쪼개 읽지 않는다(isMessageTextRow 와 같은 규칙).
 * 호출자 트랜잭션 안에서 부르고, 고른 키를 같은 트랜잭션에서 removeMessageSourceSync 의 keys 로 넘긴다.
 */
export function editedOutAttachmentKeysSync(
  nodeSources: NodeSourceRepository,
  messageId: string,
  platform: string | null,
  keptAttachmentIds: readonly string[],
): string[] {
  const keptKeysByPlatform = new Map<string | null, Set<string>>();
  const keptKeysOf = (rowPlatform: string | null): Set<string> => {
    let kept = keptKeysByPlatform.get(rowPlatform);
    if (kept === undefined) {
      kept = new Set(keptAttachmentIds.map((attachmentId) =>
        sourceKeyOf({ kind: "message", platform: rowPlatform, messageId, attachmentId })));
      keptKeysByPlatform.set(rowPlatform, kept);
    }
    return kept;
  };
  const keys = new Set<string>();
  const rows = [...nodeSources.findMessageSync(messageId, platform), ...nodeSources.findArchivedMessageSync(messageId, platform)];
  for (const row of rows) {
    if (isMessageTextRow(row, messageId) || keptKeysOf(row.platform).has(row.key)) continue;
    keys.add(row.key);
  }
  return [...keys].sort();
}

/** 6단계 결과 — 영구 삭제한 살아 있던 노드와, 그 삭제로 휴지통에서 지운 보관 노드(둘 다 오름차순). */
interface RetractedDerivativeRemoval {
  deletedIds: number[];
  archivePurgedIds: number[];
}

/**
 * 6단계(설계 17.7). 고른 노드마다 단건 영구 삭제와 같은 explicit/cascade 정리를 한다 — 그 노드에만 기대던 출처 없는
 * 자손, 그 노드들의 수정 이력, 그 노드들에만 기대던 휴지통 노드까지(설계 17.3). 앞 노드의 정리가 이미 지운 노드는
 * 다시 지우지 않는다.
 */
function removeRetractedMessageDerivativesSync(
  db: Database,
  nodeSources: NodeSourceRepository,
  revisions: readonly MessageEditRevision[],
  holders: RemovedAssetHolders,
): RetractedDerivativeRemoval {
  const deletedIds = new Set<number>();
  const archivePurgedIds = new Set<number>();
  for (const id of retractedMessageDerivativesSync(db, nodeSources, revisions)) {
    if (deletedIds.has(id)) continue;
    const removed = deleteNodeWithLineageSync(db, nodeSources, id, holders);
    if (removed === null) {
      throw new Error(`메시지 삭제: 철회된 파생 기억 ${id} 를 고른 뒤 같은 트랜잭션에서 찾지 못했습니다`);
    }
    for (const removedId of [removed.deletedId, ...removed.derivedDeletedIds]) deletedIds.add(removedId);
    for (const purgedId of removed.archivePurgedIds) archivePurgedIds.add(purgedId);
  }
  return {
    deletedIds: [...deletedIds].sort(ascending),
    archivePurgedIds: [...archivePurgedIds].sort(ascending),
  };
}

/**
 * 이 메시지의 동기 수정이 철회한 옛 파생 중 지울 노드(오름차순, 설계 17.7 (2)).
 *
 * 걷기 시작점은 그 수정 이력 행이 고친 노드(old_node_id) 중 살아 있는 것이다 — 다른 출처로 남은 뿌리이거나, 같은 id
 * 수정 뒤 분리 수정으로 이 메시지 행을 새 노드에 넘기고 다른 출처로 남은 노드. 휴지통에 있는 노드는 걷지 않는다(그
 * 아래 철회 자손은 보관 기간 만료까지 남는 알려진 한계). 시작점에서 계보 자식 방향(merged_into·parent_of 엣지의
 * target → source)으로 층마다 500개씩 묶어 엣지 색인(idx_ke_target)을 탄다 — 비용은 시작점들의 계보 크기에 비례하고
 * 표 전체를 훑지 않는다. 순환은 방문 표시로 끊는다.
 *
 * 고르는 노드: 계보 무효화로 철회됐고(status retracted, invalidatedBy 있음) 그 무효화의 이력 행
 * (invalidatedByRevision)이 이 메시지의 동기 수정 행이며, 자기 출처 행이 없는 노드. 대시보드·AI 의 by-id 편집이
 * 철회한 노드는 이력 행에 메시지 칸이 없어 고르지 않는다. 자기 출처 행이 있는 자식은 무효화가 철회하지 않는다(설계 5.8).
 */
function retractedMessageDerivativesSync(
  db: Database,
  nodeSources: NodeSourceRepository,
  revisions: readonly MessageEditRevision[],
): number[] {
  if (revisions.length === 0) return [];
  const revisionIds = new Set(revisions.map((revision) => revision.id));
  const starts = liveNodeIds(db, [...new Set(revisions.map((revision) => revision.oldNodeId))]);
  const visited = new Set(starts);
  const candidates: number[] = [];
  let layer = starts;
  while (layer.length > 0) {
    const next: number[] = [];
    for (const batch of inIdBatches(layer)) {
      // dynamic SQL: placeholder count varies, keep prepare()
      const children = db
        .prepare(
          `SELECT n.* FROM knowledge_edges e JOIN knowledge_nodes n ON n.id = e.source_id
           WHERE e.target_id IN (${sqlPlaceholders(batch.length)}) AND e.relation IN (${LINEAGE_PLACEHOLDERS})`,
        )
        .all(...batch, ...SHARED_MEMORY_LINEAGE_RELATIONS) as KnowledgeNodeRow[];
      for (const child of children) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        next.push(child.id);
        const state = readSharedMemory(rowToNode(child).metadata);
        if (!isLineageInvalidated(state) || state.invalidatedByRevision === undefined) continue;
        if (revisionIds.has(state.invalidatedByRevision)) candidates.push(child.id);
      }
    }
    layer = next;
  }
  const sources = nodeSources.listSync(candidates);
  return candidates.filter((id) => sources.get(id)!.length === 0).sort(ascending);
}

/** ids 중 knowledge_nodes 에 있는(살아 있는) 노드(오름차순). */
function liveNodeIds(db: Database, ids: readonly number[]): number[] {
  const out: number[] = [];
  for (const batch of inIdBatches(ids)) {
    // dynamic SQL: placeholder count varies, keep prepare()
    const records = db
      .prepare(`SELECT id FROM knowledge_nodes WHERE id IN (${sqlPlaceholders(batch.length)})`)
      .all(...batch) as Array<{ id: number }>;
    for (const record of records) out.push(record.id);
  }
  return out.sort(ascending);
}

/**
 * ids 중 metadata 의 messageId 가 messageId 인 노드의 출처 메시지 표시(messageId·channelId·guildId)를 거둔다.
 * 메시지 삭제(남는 뿌리)와 메시지 수정 분리(옛 노드)가 부른다. 호출자 트랜잭션 안에서 부른다.
 */
export function stripSourceMessageMarkersSync(db: Database, ids: readonly number[], messageId: string): void {
  const updateMetadata = db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?");
  for (const batch of inIdBatches(ids)) {
    // dynamic SQL: placeholder count varies, keep prepare()
    const rows = db
      .prepare(`SELECT * FROM knowledge_nodes WHERE id IN (${sqlPlaceholders(batch.length)})`)
      .all(...batch) as KnowledgeNodeRow[];
    for (const row of rows) {
      const { metadata } = rowToNode(row);
      if (readSourceMessageId(metadata) !== messageId) continue;
      updateMetadata.run(JSON.stringify(withoutSourceMessageMarker(metadata)), row.id);
    }
  }
}
