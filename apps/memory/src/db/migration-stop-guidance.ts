/**
 * migration-stop-guidance.ts — 메모리 DB 를 열지 않고 멈추는 오류들이 공유하는 사용자 안내 문구.
 *
 * 왜 별 파일인가: 버전 판정의 옛 DB 멈춤(SchemaVersionTooOldError, schema-version-gate.ts), 차원 불일치
 * (EmbeddingDimMismatchError, vec-dimension-guard.ts), doctor 안내가 같은 문장을 써야 한다. 어느 한 오류 파일에 두면
 * 다른 쪽이 그 파일에 기대게 되므로, 어떤 판정에도 속하지 않는 이 파일에 둔다.
 */

/**
 * DB 는 asset_folder_pairing 행(기준 스키마)에, 첨부 파일 폴더는 최상위 표시 파일에 같은 짝 번호를 갖는다. 서버는 시작할 때 두 번호가
 * 맞을 때만 content/ 의 파일을 지우고, 맞지 않는 폴더(다른 DB 의 짝·표시 없는 파일·읽을 수 없는 표시)는 아무 파일도 지우지
 * 않고 멈춘다(assets/asset-folder-pairing.ts). 그래서 옛 DB 를 남겨 두려면 DB 와 폴더를 함께 옮기라고 안내하고, DB 만 옮기고
 * 폴더를 그대로 두면 새 DB 의 시작이 멈춘다는 점을 적는다. 키 이름만 적고 값은 적지 않는다.
 */
export const KEEP_OLD_MEMORY_ASSET_FOLDER_GUIDANCE =
  "옛 기억을 나중에 되살릴 수 있게 남겨 두려면, DB 파일과 첨부 파일 폴더(설정 키 assets.dir(기본 data/assets) 또는 env BARA_ASSET_DIR)를 " +
  "함께 다른 곳으로 옮긴 뒤 다시 시작하세요. 두 곳에는 같은 짝 표시가 있어, 서버는 짝이 맞지 않는 폴더를 만나면 아무 파일도 지우지 않고 멈춥니다 — " +
  "DB 만 옮기고 폴더를 그대로 두면 새 DB 의 시작이 멈춥니다.";
