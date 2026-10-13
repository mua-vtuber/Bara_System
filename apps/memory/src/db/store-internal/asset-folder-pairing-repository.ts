/**
 * store-internal/asset-folder-pairing-repository.ts — DB 쪽 짝 표시(asset_folder_pairing, 기준 스키마)의 읽기·쓰기와 판정에
 * 쓰는 asset_files 행 수(WP-B1-20U 설계 17.19 설계 1·2, 결정 D39·D40).
 *
 * 짝 행은 하나뿐이다(id = 1). 서버 시작 판정(ensureAssetFolderPairing)이 쓰기 잠금 안에서 부르고, 회차 복원(backup/
 * restore.ts)은 복원할 스냅샷을 읽기 전용으로 열어 짝 번호를 읽는다 — 복원 검사가 기준 스키마 이전 스냅샷을 먼저 거부하므로
 * 표는 늘 있다. 메서드는 동기다.
 */

import type { Database } from "bun:sqlite";

/** 짝 표 이름 — 기준 스키마 04-assets-cleanup.sql 의 asset_folder_pairing 과 같다. */
export const ASSET_FOLDER_PAIRING_TABLE = "asset_folder_pairing";

/** 짝 행의 고정 PK — 표의 CHECK (id = 1) 과 같다. */
const PAIRING_ROW_ID = 1;

export class AssetFolderPairingRepository {
  constructor(private readonly db: Database) {}

  /** DB 의 짝 번호. 행이 없으면 null. */
  getPairingIdSync(): string | null {
    const row = this.db
      .query(`SELECT pairing_id FROM ${ASSET_FOLDER_PAIRING_TABLE} WHERE id = ?`)
      .get(PAIRING_ROW_ID) as { pairing_id: string } | null;
    return row?.pairing_id ?? null;
  }

  /**
   * 짝 행이 없을 때만 넣는다(INSERT OR IGNORE). 같은 DB 파일을 다른 프로세스가 먼저 채웠으면 그 행이 남고, 호출자가 다시
   * 읽어 판정한다. 호출자 트랜잭션이 없으면 바로 커밋된다 — 폴더 표시보다 먼저 써야 하는 이유는 설계 2.
   */
  insertPairingIfAbsentSync(pairingId: string, createdAt: string): void {
    this.db
      .query(`INSERT OR IGNORE INTO ${ASSET_FOLDER_PAIRING_TABLE} (id, pairing_id, created_at) VALUES (?, ?, ?)`)
      .run(PAIRING_ROW_ID, pairingId, createdAt);
  }

  /** asset_files 행 수 — 짝 행 없는 DB 가 첨부 기록을 가졌는지(S3) 가른다. */
  countAssetFilesSync(): number {
    return (this.db.query("SELECT COUNT(*) AS c FROM asset_files").get() as { c: number }).c;
  }
}
