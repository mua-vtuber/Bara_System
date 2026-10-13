/**
 * store-internal/asset-release.ts — 영구 삭제의 DB 쪽 첨부 해제(WP-B1-20U 설계 17.17, 17.18 설계 1·2, 결정 D31~D34).
 *
 * 영구 삭제 통로는 어느 것이든 트랜잭션 끝에서 releaseRemovedAssetsSync 를 부른다. holders 는 그 트랜잭션이 영구
 * 삭제한 노드 id 다 — 삭제 기본 함수(deleteNodesPermanentlySync·purgeArchiveNodesWithoutRows·purgeOldArchiveSync)가 선택
 * 인자 RemovedAssetHolders 를 받으면 `DELETE … RETURNING id` 로 채운다(따로 읽지 않는다). 지운 id 500개 묶음마다:
 *   (a) 주인 표(document_record_owners, v46)에서 그 노드들이 주인인 문서 기록을 고르고, releaseDocumentRecordsSync 가
 *       documents 행(주인 행은 외래 키 CASCADE)과 그 원장 행(`document:<id>`)을 지운다.
 *   (b) 이미지 원장 행(`image:<node_id>`)을 지운다. images 행은 기존 트리거(images_node_delete)가 지운다.
 *   (c) 이번에 참조를 하나라도 잃은 sha 를 쓰임 판정(AssetRepository.isAssetUsed)으로 걸러 AssetRelease 로 돌려준다.
 *       asset_files 행은 지우지 않는다 — 파일 지우기 대기 표시다. 파일과 그 행은 커밋 뒤 같은 쓰기 잠금 안에서
 *       파일 지우기 함수(assets/released-asset-files.ts)가 지운다(removeReleasedAssetFiles).
 * 노드 metadata 는 읽지 않는다(D33): 주인을 metadata(documentId·absorbedDocumentIds)로 판정하던 때는 클라이언트가 그 칸을
 * 써서 남의 기록을 지우거나 형식이 틀린 값 하나로 삭제·보관 만료를 멈출 수 있었다(재QA A1·A2·A3·B1·B2). 청크·추출
 * 자식은 주인 행을 갖지 않아 기록을 지우지 않는다.
 * 비용: 지운 노드당 색인 조회 2번(idx_document_record_owners_node·idx_asset_file_imports_source_ref) + 지운 기록당 PK 삭제
 * 1·원장 삭제 1. 표 훑기·metadata 파싱이 없다. 16절 새로 시작 — 옛 행의 주인·원장은 추론하지 않는다.
 */

import type { Database } from "bun:sqlite";
import type {
  AssetCleanup,
  AssetFileRemover,
  AssetRelease,
} from "../../assets/released-asset-files.ts";
import { AssetRepository, assetLedgerRef } from "./asset-repository.ts";
import { DocumentOwnerRepository } from "./document-owner-repository.ts";
import { DocumentRepository } from "./document-repository.ts";
import { inIdBatches } from "./id-batches.ts";

/** 영구 삭제 문장에 붙여 holders 를 채우는 RETURNING 칸 — 지운 노드 id 만(D33). */
export const REMOVED_HOLDER_RETURNING = "RETURNING id";

/** 영구 삭제 문장이 돌려준 노드 행(RETURNING id). */
export interface RemovedNodeRow {
  id: number;
}

/**
 * 한 영구 삭제 트랜잭션이 지운 노드 id(살아 있는 표·보관표 모두, 노드 번호는 두 표에서 같다). 어느 노드가 기록의 주인인지는
 * 해제 때 주인 표로 판정한다.
 */
export class RemovedAssetHolders {
  private readonly ids = new Set<number>();

  addRows(rows: readonly RemovedNodeRow[]): void {
    for (const row of rows) this.ids.add(row.id);
  }

  nodeIds(): number[] {
    return [...this.ids];
  }
}

/** 주인 표가 가리키는 문서 기록이 documents 에 없을 때(설계 17.18 설계 2) — 외래 키를 끈 외부 도구가 DB 를 바꾼 경우뿐이다. */
export class OwnedDocumentRecordMissingError extends Error {
  constructor(readonly documentIds: readonly string[]) {
    super(
      `첨부 해제 중단: 주인 표(document_record_owners)가 가리키는 문서 기록이 documents 에 없습니다 — ` +
        `외래 키를 끈 채 바뀐 DB 입니다: ${documentIds.join(", ")}`,
    );
    this.name = "OwnedDocumentRecordMissingError";
  }
}

/** 해제한 문서 기록 — 지운 기록 id(오름차순)와 그 기록·원장 행이 가리키던 sha(참조를 잃은 sha 후보, 중복 없음). */
export interface ReleasedDocumentRecords {
  documentIds: string[];
  sha256s: string[];
}

const ascending = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 위 (a)~(c). 호출자 트랜잭션 안에서 부른다. */
export function releaseRemovedAssetsSync(db: Database, holders: RemovedAssetHolders): AssetRelease {
  const assets = new AssetRepository(db);
  const owners = new DocumentOwnerRepository(db);
  const documentIds: string[] = [];
  const touched = new Set<string>();
  for (const batch of inIdBatches(holders.nodeIds())) {
    const released = releaseDocumentRecordsSync(db, owners.listOwnedDocumentIdsSync(batch));
    documentIds.push(...released.documentIds);
    for (const sha of released.sha256s) touched.add(sha);
    const imageRefs = batch.map((nodeId) => assetLedgerRef({ kind: "image", nodeId }));
    for (const sha of assets.deleteLedgerRowsByRefs(imageRefs)) touched.add(sha);
  }
  return {
    documentIds: documentIds.sort(ascending),
    sha256s: [...touched].filter((sha) => !assets.isAssetUsed(sha)).sort(ascending),
  };
}

/**
 * 문서 기록 documentIds 를 지운다: documents 행(PK 삭제 — 주인 행과 요약·발굴 산출은 외래 키 CASCADE)과 그 원장 행
 * (`document:<id>`, source_ref 색인). 호출자 트랜잭션 안에서 부른다. 고른 기록 중 documents 행이 없는 것이 있으면 그 id
 * 를 담은 OwnedDocumentRecordMissingError 로 멈춘다(설계 2) — 호출자 트랜잭션이 되돌아가 아무것도 지우지 않고, 요청은
 * 500 으로 끝나며 서버 오류 로그에 그 id 가 남는다.
 */
export function releaseDocumentRecordsSync(db: Database, documentIds: readonly string[]): ReleasedDocumentRecords {
  const documents = new DocumentRepository(db);
  const released: string[] = [];
  const missing: string[] = [];
  const shas = new Set<string>();
  for (const documentId of new Set(documentIds)) {
    const recordShas = documents.deleteDocumentSync(documentId);
    if (recordShas === null) {
      missing.push(documentId);
      continue;
    }
    released.push(documentId);
    for (const sha of recordShas) shas.add(sha);
  }
  if (missing.length > 0) throw new OwnedDocumentRecordMissingError(missing.sort(ascending));
  const ledgerRefs = released.map((documentId) => assetLedgerRef({ kind: "document", documentId }));
  for (const sha of new AssetRepository(db).deleteLedgerRowsByRefs(ledgerRefs)) shas.add(sha);
  return { documentIds: released.sort(ascending), sha256s: [...shas] };
}

/** 지운 첨부가 없을 때의 파일 단계 결과. */
export function noAssetCleanup(): AssetCleanup {
  return { documentIds: [], removedSha256s: [], missingSha256s: [], failed: [] };
}

/** remover 를 넣지 않은 저장소의 실패 원인(설계 17.17 한계 3). */
export const ASSET_FILE_REMOVER_MISSING = "setAssetFileRemover 미설정 — 파일 지우기 함수가 저장소에 주입되지 않았습니다";

/**
 * 커밋 뒤 같은 쓰기 잠금 안에서 부르는 파일 단계(D27). remover 를 넣지 않은 저장소는 파일을 지우지 않고, 참조를
 * 잃은 sha 마다 failed 에 ASSET_FILE_REMOVER_MISSING 을 담아 오류 로그를 남긴다 — asset_files 행은 대기로 남아 서버
 * 시작 때 다시 지워진다.
 */
export function removeReleasedAssetFiles(
  db: Database,
  remover: AssetFileRemover | undefined,
  release: AssetRelease,
): AssetCleanup {
  if (remover !== undefined) return remover(release);
  const assets = new AssetRepository(db);
  const failed = release.sha256s.map((sha256) => ({
    sha256,
    path: assets.getAssetFile(sha256)?.assetPath ?? "",
    error: ASSET_FILE_REMOVER_MISSING,
  }));
  for (const failure of failed) {
    console.error(`[asset-cleanup] 파일 지우기 안 함(asset_files 행은 대기로 남음): ${failure.sha256} ${failure.path} — ${failure.error}`);
  }
  return { ...noAssetCleanup(), documentIds: [...release.documentIds], failed };
}
