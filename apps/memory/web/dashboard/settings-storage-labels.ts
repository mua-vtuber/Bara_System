/**
 * 저장 위치 설정 한국어 문구 — i18n-ready 로 한 곳에 모음(settings-backup-labels.ts 선례).
 *
 * "메모리 파일 위치"(db.path)와 "원본 파일 저장 위치"(assets.dir)는 한 쌍이다. 서버는 시작할 때 DB 와 첨부 파일
 * 폴더의 짝 표시를 맞춰 보고, 한쪽만 바뀌었으면 아무 파일도 지우지 않고 멈춘다(설계 17.19, 멈춤 S1·S2).
 * settings.ts 의 MEMORY_SCHEMA_OVERRIDES 가 두 칸의 제목·설명을 여기서 가져간다.
 */

const DB_PATH_TITLE = "메모리 파일 위치";
const ASSETS_DIR_TITLE = "원본 파일 저장 위치";
/** 두 설명이 같이 쓰는 규칙 문장 — 한쪽만 고쳐 문구가 어긋나지 않게 한 번만 적는다. */
const PAIR_RULE =
  "옮기거나 바꿀 때는 두 값을 함께 바꾼다. 하나만 바꾸면 다음 시작 때 짝이 맞지 않아 서버가 멈춘다(파일은 지우지 않는다).";

export const STORAGE_LOCATION_LABELS = {
  dbPathTitle: DB_PATH_TITLE,
  dbPathDescription: `${ASSETS_DIR_TITLE}와 한 쌍이다. ${PAIR_RULE}`,
  assetsDirTitle: ASSETS_DIR_TITLE,
  assetsDirDescription: `${DB_PATH_TITLE}와 한 쌍이다. ${PAIR_RULE}`,
} as const;
