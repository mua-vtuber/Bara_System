/**
 * StatsAssetMixin — 통계·유지보수·자산 보관·문서 메타 위임 묶음(facade 분해 C2/store).
 * StatsRepository / AssetRepository / DocumentRepository 위임. 동작 무변경.
 */

import type {
  ArchivedNode,
  EvolverActivitySummary,
  MemoryNode,
} from "../../memory/types.ts";
import type {
  PurgeOldArchiveResult,
  ResetMemoryCounts,
  TrashNodesResult,
} from "../store-internal/stats-repository.ts";
import { releaseDocumentRecordsSync, removeReleasedAssetFiles } from "../store-internal/asset-release.ts";
import { DocumentOwnerRepository } from "../store-internal/document-owner-repository.ts";
import type { ExplicitRemovalPolicy } from "../../memory/lineage-removal.ts";
import { withMemoryMutationLock } from "../../memory/shared-memory-mutation-lock.ts";
import type { ArchivePage, ArchivePageOptions } from "../store-internal/archive-page.ts";
import {
  assetLedgerRef,
  type AssetBundleFile,
  type AssetFileRow,
  type WrittenAssetFile,
} from "../store-internal/asset-repository.ts";
import type { AssetCleanup, AssetFileWriter, AssetRelease } from "../../assets/released-asset-files.ts";
import type {
  DocumentExtractionProgress,
  DocumentListOrder,
  DocumentOcrCandidateRow,
  DocumentRecordPlacement,
  DocumentRow,
} from "../store-internal/document-repository.ts";
import type { DocumentParseStatus } from "../../memory/document-parse-status.ts";
import type { Constructor, StoreInternals } from "./base.ts";

/**
 * abandonDocumentRecord 결과 — kept: 주인 행이 있어(노드 저장이 커밋된 뒤의 실패) 기록을 그대로 뒀다. released: 기록·원장
 * 행을 지웠고 assetCleanup 은 그 뒤 파일 단계 결과다(failed 가 있으면 그 asset_files 행은 지우기 대기로 남는다).
 */
export type AbandonedDocumentRecord =
  | { outcome: "kept" }
  | { outcome: "released"; assetCleanup: AssetCleanup };

export function StatsAssetMixin<TBase extends Constructor<StoreInternals>>(
  Base: TBase,
) {
  return class StatsAssetMixed extends Base {
    // ── 통계·유지보수 — StatsRepository 위임 ────────────────────────────

    /** Aggregate counters for the /stats endpoint and dashboards. */
    async getStats(): Promise<{
      totalMemories: number;
      memoriesLast7Days: number;
      totalEdges: number;
    }> {
      return this.statsRepo.getStats();
    }

    resetAllMemory(): ResetMemoryCounts {
      return this.statsRepo.resetAllMemory();
    }

    /**
     * 명시적 휴지통 이동의 단일 진입점(WP-B1-20U 설계 17.3) — 사용자 휴지통·중복 원문 정리는 cascade,
     * 자동 정리는 selected_only. 쓰기 잠금을 스스로 잡고(이미 쥔 흐름은 재진입), 옮긴 노드가 있으면 검색
     * 캐시 키(dbRevision)를 올린다. 규칙 = StatsRepository.trashNodesSync.
     */
    async trashNodes(rootIds: readonly number[], policy: ExplicitRemovalPolicy): Promise<TrashNodesResult> {
      return withMemoryMutationLock(this, async () => {
        const result = this.statsRepo.trashNodesSync(rootIds, policy);
        if (result.movedIds.length > 0) this.nodeRepo.bumpDbRevision();
        return result;
      });
    }

    /** trashNodes 와 같은 계획을 읽기만 해서 돌려준다 — 정리 스크립트 dry-run 용(StatsRepository.previewTrash). */
    previewTrash(rootIds: readonly number[], policy: ExplicitRemovalPolicy): TrashNodesResult {
      return this.statsRepo.previewTrash(rootIds, policy);
    }

    async getArchive(
      options: { since?: string; limit?: number } = {},
    ): Promise<ArchivedNode[]> {
      return this.statsRepo.getArchive(options);
    }

    /**
     * 휴지통에서 되살린다. 보관된 출처 행을 되돌리고, 되돌릴 행이 없으면 restore:<actor> 출처 행을
     * 더한다(WP-B1-20T 설계 5.4). actor = 복원을 요청한 행위자.
     *
     * WP-B1-20U 설계 17.4 — 보관 행 스냅샷(부른 그 자리에서, 첫 await 전에 읽는다)과 임베딩은 쓰기 잠금 밖이다.
     * 잠금 안 한 트랜잭션에서 보관 행을 다시 읽어 견준다: 그 사이 메시지 삭제 등이 지웠으면 아무것도 쓰지 않고
     * null(라우트 404), 같은 번호의 행이 바뀌었으면 ArchivedNodeChangedError(라우트 409). 되살렸으면 검색 캐시
     * 키(dbRevision)를 올린다 — 복원도 검색 결과를 바꾼다.
     */
    async restoreArchived(id: number, actor: string): Promise<MemoryNode | null> {
      const prepared = await this.statsRepo.prepareRestore(id);
      if (prepared === null) return null;
      return withMemoryMutationLock(this, async () => {
        const restored = this.statsRepo.commitRestoreSync(prepared, actor);
        if (restored !== null) this.nodeRepo.bumpDbRevision();
        return restored;
      });
    }

    async getArchivePage(options: ArchivePageOptions = {}): Promise<ArchivePage> {
      return this.statsRepo.getArchivePage(options);
    }

    /**
     * 휴지통 보관 만료(trash cron, WP-B1-20U 설계 17.17·위험 14). 쓰기 잠금 안 한 트랜잭션에서 보관 기간이 지난 보관
     * 노드와 그 수정 이력을 지우고 그 노드들이 주인인 문서 기록·원장 행을 해제한다(StatsRepository.purgeOldArchiveSync).
     * 커밋 뒤 같은 잠금 안에서 참조를 잃은 첨부 파일과 그 asset_files 행을 파일 지우기 함수로 지워 결과를 assetCleanup 에
     * 담는다 — 잠금이 /ingest 자산 묶음과 겹치지 않게 해, 다른 저장이 같은 파일을 막 쓰는 중에 그 파일을 지우지 않는다.
     */
    async purgeOldArchive(maxAgeDays: number): Promise<PurgeOldArchiveResult> {
      return withMemoryMutationLock(this, async () => {
        const { nodesPurged, assetRelease } = this.statsRepo.purgeOldArchiveSync(maxAgeDays);
        const assetCleanup = removeReleasedAssetFiles(this.db, this.nodeRepo.assetFileRemover, assetRelease);
        return { nodesPurged, assetCleanup };
      });
    }

    async getArchiveSoonToPurge(
      warnDays: number,
      maxAgeDays: number,
    ): Promise<ArchivedNode[]> {
      return this.statsRepo.getArchiveSoonToPurge(warnDays, maxAgeDays);
    }

    async logAutoCleanupActivity(summary: {
      clusterEdgesAdded: number;
      nodesArchived: number;
    }): Promise<void> {
      return this.statsRepo.logAutoCleanupActivity(summary);
    }

    async logTrashActivity(summary: {
      nodesPurged: number;
      soonToPurgeCount: number;
    }): Promise<void> {
      return this.statsRepo.logTrashActivity(summary);
    }

    async getEvolverActivity(
      limit: number = 7,
    ): Promise<EvolverActivitySummary[]> {
      return this.statsRepo.getEvolverActivity(limit);
    }

    // ── 자산 보관 (Phase 14a) — AssetRepository 위임 ─────────────────────

    /**
     * 자산 row 를 만든다. 같은 sha256 이 이미 있으면 no-op(첫 row 보존).
     * created=true 이면 신규 INSERT, false 이면 기존 유지.
     */
    upsertAssetFile(args: {
      sha256: string;
      assetType: string;
      assetPath: string;
      byteSize: number;
      mimeType?: string;
      originalName?: string;
    }): { created: boolean } {
      return this.assetRepo.upsertAssetFile(args);
    }

    /**
     * import 시점별 attribution row 를 추가한다. import_id 반환.
     * 같은 자산을 두 번 가져오면 두 row 가 생긴다.
     */
    addAssetImport(args: {
      assetSha256: string;
      source: string;
      sourceRef?: string;
      originalName?: string;
      author: string;
      userId: string;
    }): string {
      return this.assetRepo.addAssetImport(args);
    }

    /**
     * sha256 으로 자산 메타를 반환한다. 없으면 null.
     */
    getAssetFile(sha256: string): AssetFileRow | null {
      return this.assetRepo.getAssetFile(sha256);
    }

    /**
     * /ingest 문서 갈래의 자산 묶음(WP-B1-20U 설계 17.17 D29). 쓰기 잠금 안 한 트랜잭션에서 asset_files 행(기록된
     * 확장자 우선 — 한 sha 에 디스크 파일 하나), 문서 기록(documents 행), 원장 행(파일마다 `document:<id>`)을 쓰고
     * 마지막에 파일을 쓴다. 그래서 다른 요청이 같은 파일을 막 쓰는 중에 메시지 삭제가 그 파일을 지우지 않는다.
     * files 는 이 기록이 쓰는 파일(원본, 원본과 sha 가 다를 때만 변환본). 반환: 문서 기록 id 와 파일별 결과(입력 순서).
     */
    async recordDocumentAssets(args: {
      writer: AssetFileWriter;
      files: readonly AssetBundleFile[];
      document: { assetSha256: string; title: string; documentType: string; sourceMetadata: Record<string, unknown> };
      ledger: { source: string; author: string; userId: string; originalName?: string };
    }): Promise<{ documentId: string; files: WrittenAssetFile[] }> {
      return withMemoryMutationLock(this, async () => {
        const { result: documentId, files } = this.assetRepo.writeAssetBundleSync(args.writer, args.files, () => {
          const id = this.documentRepo.createDocument(args.document);
          const sourceRef = assetLedgerRef({ kind: "document", documentId: id });
          for (const sha256 of new Set(args.files.map((file) => file.sha256))) {
            this.assetRepo.addAssetImport({ assetSha256: sha256, sourceRef, ...args.ledger });
          }
          return id;
        });
        return { documentId, files };
      });
    }

    /**
     * /ingest 문서 갈래의 보상(WP-B1-20U 설계 17.18 설계 3) — recordDocumentAssets 가 커밋한 기록 뒤 문서 노드 저장 블록이
     * 실패하면 라우트(ingest-document-compensation.ts)가 부른다. 쓰기 잠금 안 한 트랜잭션에서 그 기록의 주인 행이 있으면
     * (노드 저장 커밋 뒤 실패) 아무것도 하지 않고 kept. 없으면 영구 삭제와 같은 해제 루틴(releaseDocumentRecordsSync)으로
     * documents 행과 원장 행(`document:<id>`)을 지우고 참조를 잃은 sha 를 골라 커밋한 뒤, 같은 잠금 안에서 파일 지우기
     * 함수로 파일과 asset_files 행을 지운다(removeReleasedAssetFiles — 영구 삭제 통로와 같은 순서). 기록 행이 이미 없으면
     * OwnedDocumentRecordMissingError, SQLite 오류는 그대로 던진다 — 호출자가 두 원인을 함께 알린다.
     */
    async abandonDocumentRecord(documentId: string): Promise<AbandonedDocumentRecord> {
      return withMemoryMutationLock(this, async () => {
        const release = this.db.transaction((): AssetRelease | null => {
          if (new DocumentOwnerRepository(this.db).ownerNodeIdSync(documentId) !== null) return null;
          const released = releaseDocumentRecordsSync(this.db, [documentId]);
          return {
            documentIds: released.documentIds,
            sha256s: released.sha256s.filter((sha) => !this.assetRepo.isAssetUsed(sha)).sort(),
          };
        })();
        if (release === null) return { outcome: "kept" };
        return { outcome: "released", assetCleanup: removeReleasedAssetFiles(this.db, this.nodeRepo.assetFileRemover, release) };
      });
    }

    /**
     * OCR 변환본(canonical markdown) 파일의 자산 묶음(WP-B1-20U 설계 17.18 설계 4). 쓰기 잠금 안 한 트랜잭션에서
     * asset_files 행(그 sha 의 행이 이미 있으면 그 행의 확장자 — `.txt` 행이면 `.md` 사본을 쓰지 않는다)과 그 기록의
     * 원장 행(`document:<id>`, 같은 기록이 같은 sha 의 원장 행을 이미 가지면 겹쳐 쓰지 않는다)을 쓰고 마지막에 파일을
     * 쓴다. 쓰는 순간부터 파일이 기록에 묶여 다른 삭제가 지우지 못하고, 기록이 지워질 때 원장 행 해제로 함께 지워진다.
     * 기록(documents 행)이 그 사이 지워졌으면 아무것도 쓰지 않고 null(라우트 404) — 존재 확인과 묶음 쓰기가 같은 동기
     * 실행이라 그 사이에 기록이 지워질 틈이 없다. 밀려난 옛 변환본은 기록이 지워질 때까지 남는다. 바이트 확인은 묶음이
     * 진다(AssetBundleBytesMismatchError).
     */
    async recordOcrCanonicalAsset(args: {
      writer: AssetFileWriter;
      documentId: string;
      file: AssetBundleFile;
      ledger: { source: string; author: string; userId: string; originalName?: string };
    }): Promise<WrittenAssetFile | null> {
      return withMemoryMutationLock(this, async () => {
        if (this.documentRepo.getDocument(args.documentId) === null) return null;
        const { files } = this.assetRepo.writeAssetBundleSync(args.writer, [args.file], () => {
          const sourceRef = assetLedgerRef({ kind: "document", documentId: args.documentId });
          if (!this.assetRepo.hasLedgerRow(sourceRef, args.file.sha256)) {
            this.assetRepo.addAssetImport({ assetSha256: args.file.sha256, sourceRef, ...args.ledger });
          }
        });
        return files[0]!;
      });
    }

    // ── 문서 메타 (Phase 14a) — DocumentRepository 위임 ──────────────────

    /**
     * 문서 메타 row 를 생성한다. document_id = 'doc_' + uuid 반환.
     * sourceMetadata 미지정 시 {} 저장.
     */
    createDocument(args: {
      assetSha256: string;
      title: string;
      documentType: string;
      sourceMetadata?: Record<string, unknown>;
    }): string {
      return this.documentRepo.createDocument(args);
    }

    /**
     * chunk_count 를 갱신하고 updated_at 을 현재 시각으로 올린다.
     */
    setChunkCount(documentId: string, count: number): void {
      return this.documentRepo.setChunkCount(documentId, count);
    }

    /**
     * document_id 로 문서 메타를 반환한다. 없으면 null.
     * sourceMetadata 는 JSON.parse 한 객체로 반환.
     */
    getDocument(documentId: string): DocumentRow | null {
      return this.documentRepo.getDocument(documentId);
    }

    listDocumentsByParseStatuses(
      statuses: readonly DocumentParseStatus[],
      limit?: number,
      order?: DocumentListOrder,
      offset?: number,
    ): DocumentOcrCandidateRow[] {
      return this.documentRepo.listDocumentsByParseStatuses(statuses, limit, order, offset);
    }

    findDocumentNodeId(documentId: string): number | null {
      return this.documentRepo.findDocumentNodeId(documentId);
    }

    /** 기록이 놓인 곳(자기 노드·휴지통·같은 파일로 합쳐짐·옛 버전의 잘못된 합침·없음). */
    getDocumentRecordPlacement(documentId: string): DocumentRecordPlacement {
      return this.documentRepo.getDocumentRecordPlacement(documentId);
    }

    /** OCR 후보 목록이 빼는 기록 수(같은 파일로 합쳐짐 / 옛 버전의 잘못된 합침). */
    countNotOwnedRecordsByParseStatuses(statuses: readonly DocumentParseStatus[]): { absorbed: number; legacyMerged: number } {
      return this.documentRepo.countNotOwnedRecordsByParseStatuses(statuses);
    }

    /**
     * 문서의 추출 진행 집계(WP-B1-24). 라우트가 getRawDb() 로 직접 SQL 을 들고 있던 것을
     * 저장소 계층으로 옮겼다 — 완료 판정이 백필 후보 판정과 같은 SQL 조각을 쓴다.
     */
    getDocumentExtractionProgress(documentId: string): DocumentExtractionProgress {
      return this.documentRepo.getDocumentExtractionProgress(documentId);
    }

    listDocumentChunkNodeIds(documentId: string): number[] {
      return this.documentRepo.listDocumentChunkNodeIds(documentId);
    }

    updateDocumentAfterOcr(args: {
      documentId: string;
      assetSha256: string;
      chunkCount: number;
      sourceMetadata: Record<string, unknown>;
    }): boolean {
      return this.documentRepo.updateDocumentAfterOcr(args);
    }

    updateDocumentSourceMetadata(args: {
      documentId: string;
      sourceMetadata: Record<string, unknown>;
    }): boolean {
      return this.documentRepo.updateDocumentSourceMetadata(args);
    }

    updateDocumentSourceMetadataIfCurrent(args: {
      documentId: string;
      currentSourceMetadata: Record<string, unknown>;
      nextSourceMetadata: Record<string, unknown>;
    }): boolean {
      return this.documentRepo.updateDocumentSourceMetadataIfCurrent(args);
    }
  };
}
