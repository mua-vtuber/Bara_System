/**
 * assets/released-asset-files.ts — 영구 삭제로 참조를 잃은 첨부 파일 지우기(WP-B1-20U 설계 17.17, D27·D31).
 *
 * 영구 삭제 통로는 DB 쪽 releaseRemovedAssetsSync(db/store-internal/asset-release.ts)로 기록·원장 행을 지우고, 참조를
 * 잃은 sha 목록(AssetRelease)을 얻은 채 트랜잭션을 커밋한다. 그 뒤 같은 쓰기 잠금 안에서 이 모듈의 파일 지우기
 * 함수(AssetFileRemover)가 sha 마다:
 *   1) 쓰임을 다시 판정해 아직 쓰이면 건너뛴다.
 *   2) asset_files.asset_path 의 확장자로 AssetStore.remove 를 부른다 — GET /assets/:sha 와 같은 경로 계산.
 *   3) 지웠거나 이미 없으면 asset_files 행을 지운다. 이미 없던 파일은 missingSha256s 와 오류 로그로 알린다 — DB 가
 *      있다던 파일이 없던 불일치를 숨기지 않는다.
 *   4) 지우지 못하면(권한·잠김·그 자리의 디렉토리) 행을 남겨 지우기 대기 표시로 쓰고, failed 에 경로·원인을 담아
 *      오류 로그를 남긴다. 서버 시작 때 참조 없는 행을 같은 함수로 다시 지운다.
 * 행 읽기·삭제는 저장소가 넘기는 ReleasedAssetRows 로만 한다. assets/ 는 db/ 를 import 하지 않고, db/ 는 이 파일의
 * 타입만 import 한다(한 방향).
 */

import { extOfAssetPath, type AssetRemoveOutcome, type AssetStore } from "./asset-store.ts";

/** DB 쪽 해제 결과 — 이번 영구 삭제가 지운 문서 기록 id 와, 참조를 모두 잃은 sha(둘 다 오름차순). */
export interface AssetRelease {
  documentIds: string[];
  sha256s: string[];
}

/** 지우지 못한 파일 하나 — 그 sha 의 asset_files 행은 대기 표시로 남는다. */
export interface AssetCleanupFailure {
  sha256: string;
  /** 지우려던 파일 경로(행이 없으면 빈 문자열). */
  path: string;
  /** 원인. */
  error: string;
}

/** 파일 단계 결과 — 영구 삭제 통로의 응답·요약에 그대로 담긴다. 목록은 오름차순. */
export interface AssetCleanup {
  /** 이번 영구 삭제로 지운 문서 기록(documents 행) id. */
  documentIds: string[];
  /** 파일과 asset_files 행을 지운 sha. */
  removedSha256s: string[];
  /** 지울 파일이 이미 없어 asset_files 행만 지운 sha(불일치 — 오류 로그로도 알린다). */
  missingSha256s: string[];
  /** 지우지 못한 파일. */
  failed: AssetCleanupFailure[];
}

/** 파일 지우기가 쓰는 asset_files 행 통로 — 저장소(AssetRepository)가 만족한다. */
export interface ReleasedAssetRows {
  /** asset_files 를 FK 로 가리키는 세 표(원장·documents·images)에 그 sha 행이 남았는가(설계 17.17 공유 규칙). */
  isAssetUsed(sha256: string): boolean;
  /** 그 sha 의 asset_files 행. 없으면 null. */
  getAssetFile(sha256: string): { assetPath: string } | null;
  deleteAssetFileRow(sha256: string): void;
  /** 위 세 표 어디에도 참조가 없는 asset_files 행의 sha(오름차순) — 서버 시작 때 다시 지울 대상. */
  listUnreferencedAssetSha256s(): string[];
}

/** 파일 지우기 함수 — createMemoryApi 가 부팅 때 store.setAssetFileRemover 로 한 번 넣는다. */
export type AssetFileRemover = (release: AssetRelease) => AssetCleanup;

/** /ingest 자산 묶음이 파일 자리를 정하고 쓰고, 묶음이 실패하면 새로 쓴 파일을 거두는 통로 — AssetStore 가 만족한다. */
export type AssetFileWriter = Pick<AssetStore, "placement" | "write" | "remove">;

const ascending = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 파일 지우기 함수를 만든다. 결과의 documentIds 는 받은 그대로 넘긴다. 행 읽기·삭제의 SQLite 오류는 그대로 던진다 —
 * 파일 하나의 실패만 failed 로 모은다.
 */
export function createAssetFileRemover(
  assetStore: Pick<AssetStore, "path" | "remove">,
  rows: ReleasedAssetRows,
): AssetFileRemover {
  return (release) => {
    const cleanup: AssetCleanup = {
      documentIds: [...release.documentIds], removedSha256s: [], missingSha256s: [], failed: [],
    };
    for (const sha256 of [...new Set(release.sha256s)].sort(ascending)) {
      if (rows.isAssetUsed(sha256)) continue;
      const row = rows.getAssetFile(sha256);
      if (row === null) {
        reportFailure(cleanup, { sha256, path: "", error: "asset_files 행 없음 — 지울 파일 경로를 정할 수 없습니다" });
        continue;
      }
      const ext = extOfAssetPath(row.assetPath);
      if (ext === null) {
        reportFailure(cleanup, { sha256, path: row.assetPath, error: "asset_files.asset_path 확장자 없음" });
        continue;
      }
      let path = row.assetPath;
      let outcome: AssetRemoveOutcome;
      try {
        path = assetStore.path(sha256, ext);
        outcome = assetStore.remove(sha256, ext);
      } catch (e) {
        reportFailure(cleanup, { sha256, path, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      rows.deleteAssetFileRow(sha256);
      if (outcome === "removed") {
        cleanup.removedSha256s.push(sha256);
      } else {
        cleanup.missingSha256s.push(sha256);
        console.error(
          `[asset-cleanup] 지울 파일이 이미 없음 — DB 가 있다던 파일이 없었습니다(asset_files 행은 지움): ${sha256} ${path}`,
        );
      }
    }
    return cleanup;
  };
}

/** 실패를 결과에 담고 서버 오류 로그를 남긴다 — 그 sha 의 asset_files 행은 대기 표시로 남는다. */
function reportFailure(cleanup: AssetCleanup, failure: AssetCleanupFailure): void {
  cleanup.failed.push(failure);
  console.error(
    `[asset-cleanup] 파일 지우기 실패(asset_files 행은 대기로 남고 서버 시작 때 다시 지움): ${failure.sha256} ${failure.path} — ${failure.error}`,
  );
}
