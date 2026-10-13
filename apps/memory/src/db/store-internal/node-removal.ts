/**
 * store-internal/node-removal.ts — 노드 영구 삭제의 실행 본체(WP-B1-20U 설계 17.3, 15절).
 *
 * 단건 영구 삭제(REST DELETE /memories/:id, 봇 /forget, OCR 청크 교체)는 메시지 삭제와 같은 생존 규칙을
 * 따른다: 고른 노드를 뿌리로 explicit/cascade 계획을 세워, 자기 출처 행도 살아 남는 다른 계보 부모도 없는
 * 자손을 함께 영구 삭제한다. 그래서 원문을 먼저 지워도 출처 없는 추출 자식이 부모 없이 남지 않는다 —
 * 메시지 삭제는 출처 행으로만 뿌리를 찾으므로, 남았다면 그 자식은 영영 찾을 수 없었다.
 *
 * 영구 삭제된 노드를 가리키는 수정 이력 행은 같은 트랜잭션에서 지우고(설계 15절), 휴지통에서 그 노드에만
 * 기대던 보관 노드(archived_lineage 행만 가진 것)도 함께 지운다(설계 5.5 의 3단계 반복). 호출자가 쓰기
 * 잠금을 쥔다. 함수는 모두 동기다.
 *
 * 첨부 해제(설계 17.17·17.18): 선택 인자 holders 를 주면 영구 삭제한 노드 id(살아 있는 표·보관표 모두)를 DELETE …
 * RETURNING id 로 거기 모은다. 호출자가 트랜잭션 끝에서 releaseRemovedAssetsSync(asset-release.ts)에 넘겨 주인 표로 해제할
 * 기록을 고르고, 커밋 뒤 같은 쓰기 잠금 안에서 파일 단계를 거쳐 결과에 assetCleanup 을 더한다(단건 영구 삭제 =
 * store.deleteNode).
 */

import type { Database } from "bun:sqlite";
import { planSourceRemoval } from "../../memory/lineage-removal.ts";
import { inIdBatches, sqlPlaceholders } from "./id-batches.ts";
import type { NodeSourceRepository } from "./node-source-repository.ts";
import { deleteRevisionsOfRemovedNodesSync } from "./revision-repository.ts";
import {
  REMOVED_HOLDER_RETURNING,
  type RemovedAssetHolders,
  type RemovedNodeRow,
} from "./asset-release.ts";
import type { AssetCleanup } from "../../assets/released-asset-files.ts";

/** 단건 영구 삭제 한 번의 결과. 목록은 오름차순. */
export interface DeleteNodeResult {
  /** 고른 노드. */
  deletedId: number;
  /** 계보로 함께 영구 삭제된 노드(자기 출처 행도 살아 남는 다른 계보 부모도 없던 자손). */
  derivedDeletedIds: number[];
  /** 휴지통에서 영구 삭제한 노드 — archived_lineage 로 이번에 지운 노드에만 기대던 보관 노드. */
  archivePurgedIds: number[];
  /**
   * 첨부 파일 정리(WP-B1-20U 설계 17.17) — 영구 삭제한 노드가 주인이던 문서 기록, 지운 파일, 이미 없던 파일, 지우지
   * 못한 파일(경로·원인, asset_files 행은 대기로 남아 서버 시작 때 다시 지운다). 기억 삭제는 이미 커밋됐다.
   */
  assetCleanup: AssetCleanup;
}

/** 단건 영구 삭제의 트랜잭션 쪽 결과 — 파일 단계 결과 assetCleanup 은 호출자가 커밋 뒤 더한다. */
export type NodeLineageRemoval = Omit<DeleteNodeResult, "assetCleanup">;

/**
 * 노드 묶음 영구 삭제 + 그 노드들을 가리키는 수정 이력 행 삭제. 호출자 트랜잭션 안에서 부른다.
 * 계보 엣지·출처 행은 ON DELETE CASCADE, 벡터·FTS·이미지 행·청크 요약은 노드 삭제 트리거가 정리한다.
 * holders 를 주면 지운 노드 id 를 거기 모은다(첨부 해제용).
 */
export function deleteNodesPermanentlySync(
  db: Database,
  ids: readonly number[],
  holders?: RemovedAssetHolders,
): void {
  const returning = holders === undefined ? "" : ` ${REMOVED_HOLDER_RETURNING}`;
  for (const batch of inIdBatches(ids)) {
    // dynamic SQL: placeholder count varies, keep prepare()
    const rows = db
      .prepare(`DELETE FROM knowledge_nodes WHERE id IN (${sqlPlaceholders(batch.length)})${returning}`)
      .all(...batch) as RemovedNodeRow[];
    holders?.addRows(rows);
  }
  deleteRevisionsOfRemovedNodesSync(db, ids);
}

/**
 * 한 노드를 계보 정리와 함께 영구 삭제한다. 한 트랜잭션에서:
 *   1) explicit/cascade 계획(고른 노드는 출처 행이 있어도 없앤다).
 *   2) 없앨 노드 영구 삭제 + 그 수정 이력 삭제.
 *   3) 보관표 정리(sweepArchiveForDeletedNodesSync) + 거기서 지운 보관 노드의 수정 이력 삭제.
 * 노드가 없으면 아무것도 쓰지 않고 null. holders 를 주면 2)·3)에서 지운 노드 id 를 거기 모은다(첨부 해제용).
 */
export function deleteNodeWithLineageSync(
  db: Database,
  nodeSources: NodeSourceRepository,
  id: number,
  holders?: RemovedAssetHolders,
): NodeLineageRemoval | null {
  return db.transaction((): NodeLineageRemoval | null => {
    const plan = planSourceRemoval(db, { kind: "explicit", rootIds: [id], policy: "cascade" });
    if (plan.rootIds.length === 0) return null;
    deleteNodesPermanentlySync(db, plan.removeIds, holders);
    const archivePurgedIds = nodeSources.sweepArchiveForDeletedNodesSync(plan.removeIds, holders);
    deleteRevisionsOfRemovedNodesSync(db, archivePurgedIds);
    return {
      deletedId: id,
      derivedDeletedIds: plan.removeIds.filter((removed) => removed !== id),
      archivePurgedIds,
    };
  })();
}
