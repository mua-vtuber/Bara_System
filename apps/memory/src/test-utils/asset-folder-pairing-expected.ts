/**
 * test-utils/asset-folder-pairing-expected.ts — DB·첨부 폴더 짝 멈춤 문구(설계 17.19 설계 2)를 설계 문서 그대로 적은 기대값.
 * 테스트 전용: 제품 코드가 import 하지 않는다. 제품 쪽 문구(assets/asset-folder-pairing.ts)와 따로 적어, 문구가 바뀌면
 * 테스트가 깨진다.
 */

const TAIL =
  "DB 파일은 설정 키 db.path 또는 env MEMORY_DB_PATH, 첨부 파일 폴더는 설정 키 assets.dir 또는 env BARA_ASSET_DIR 가 " +
  "가리킵니다. 아무 파일도 지우지 않고 멈췄습니다.";

export const EXPECTED_PAIRING_STOP = {
  S1:
    "첨부 파일 폴더의 content/ 에 파일이 있지만 짝 표시 파일 bara-asset-pairing.json 이 없어, 지금 DB 의 첨부 파일인지 " +
    "확인할 수 없습니다. 다른(옛) DB 의 파일이면 폴더를 그 DB 와 함께 다른 곳으로 옮기고, 필요 없으면 폴더를 비우고, " +
    "지금 DB 를 새 폴더로 시작하려면 assets.dir(env BARA_ASSET_DIR)을 아직 없는 폴더로 바꾸세요. " +
    TAIL,
  S2:
    "첨부 파일 폴더가 다른 DB 의 짝입니다(두 곳의 짝 표시가 다릅니다). 그 폴더를 쓰던 DB 로 시작하려면 " +
    "db.path(env MEMORY_DB_PATH)를 그 DB 파일로 바꾸고, 지금 DB 로 시작하려면 assets.dir(env BARA_ASSET_DIR)을 " +
    "지금 DB 의 폴더나 아직 없는 폴더로 바꾸세요. " +
    TAIL,
  S3: (rows: number): string =>
    `DB 에 첨부 기록(asset_files)이 ${rows}건 있지만 짝 표시가 없습니다 — 짝 표시가 생기기 전 버전이 만든 DB 입니다. ` +
    "DB 파일과 첨부 파일 폴더를 함께 다른 곳으로 옮긴 뒤 빈 DB·빈 폴더로 새로 시작하세요. " +
    TAIL,
  S4: (cause: string): string =>
    `첨부 파일 폴더의 짝 표시 파일 bara-asset-pairing.json 을 읽을 수 없습니다(${cause}). 백업에서 그 파일을 되살리거나, ` +
    "지금 DB 를 새 폴더로 시작하려면 assets.dir(env BARA_ASSET_DIR)을 아직 없는 폴더로 바꾸세요. " +
    TAIL,
  S5: "첨부 파일 폴더가 정해지지 않았습니다(빈 값) — 설정 키 assets.dir 또는 env BARA_ASSET_DIR 에 폴더를 지정하세요.",
} as const;

/** 회차 복원이 다른 DB 의 폴더를 만났을 때(설계 17.19 설계 3). */
export const EXPECTED_RESTORE_PAIRING_MISMATCH =
  "복원할 첨부 파일 폴더가 다른 DB 의 것이거나 짝 표시 없이 파일이 있습니다 — 빈 폴더로 복원하거나 그 폴더를 다른 곳으로 옮긴 뒤 다시 하세요";
