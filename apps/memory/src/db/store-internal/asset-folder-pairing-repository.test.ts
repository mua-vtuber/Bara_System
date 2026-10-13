/**
 * asset-folder-pairing-repository.test.ts — AssetFolderPairingRepository: DB·첨부 폴더 짝 표
 * (asset_folder_pairing)의 행 하나 규칙과 asset_files 행 수 조회.
 *
 * 옛 asset-folder-pairing-migration.test.ts 에서 옮겼다(저장소 시험만). 표 모양·옛 버전 DB 경로는
 * 옮기지 않았다 — 모양은 schema-snapshot.test.ts 가 고정한다.
 *
 * Mock 0: 실제 openMemoryDatabase + 실제 저장소.
 */
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../migrations.ts";
import { AssetFolderPairingRepository } from "./asset-folder-pairing-repository.ts";

const DIM = 8;
const PAIRING_TABLE = "asset_folder_pairing";
const X = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const Y = "12345678-9abc-4def-8123-456789abcdef";
const CREATED_AT = "2026-10-02 09:00:00";

function rowsOf(db: Database): unknown[] {
  return db.query(`SELECT * FROM ${PAIRING_TABLE} ORDER BY id`).all();
}

describe("AssetFolderPairingRepository", () => {
  test("행은 하나 — 먼저 쓴 번호를 지키고, asset_files 행 수를 센다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
    try {
      const repo = new AssetFolderPairingRepository(db);
      expect(repo.getPairingIdSync()).toBeNull();
      repo.insertPairingIfAbsentSync(X, CREATED_AT);
      repo.insertPairingIfAbsentSync(Y, CREATED_AT);
      expect(repo.getPairingIdSync()).toBe(X);
      expect(rowsOf(db)).toEqual([{ id: 1, pairing_id: X, created_at: CREATED_AT }]);

      expect(repo.countAssetFilesSync()).toBe(0);
      for (const sha of ["sha_1", "sha_2"]) {
        db.run(
          `INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, first_imported_at)
           VALUES (?, 'text', ?, 10, ?)`,
          [sha, `/x/${sha}.md`, CREATED_AT],
        );
      }
      expect(repo.countAssetFilesSync()).toBe(2);
    } finally {
      db.close();
    }
  });
});
