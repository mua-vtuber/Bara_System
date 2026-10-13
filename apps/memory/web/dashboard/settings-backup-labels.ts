/**
 * 백업 절 한국어 라벨 (P4 T6) — i18n-ready 로 한 곳에 모음.
 *
 * settings-backup-section.ts 가 노출하는 사용자 문자열을 전부 여기 모은다.
 * 번역 시점에 이 파일 하나만 갈아끼우면 되게
 * 하려는 분리 — 섹션 코드에는 사용자 문자열 리터럴을 직접 기재하지 않는다.
 */

export const BACKUP_LABELS = {
  /** 섹션 제목. */
  title: "백업",
  /** 절 안내 — 다운로드 사본에 빠지는 것을 정직하게 밝힌다. */
  desc:
    "저장된 메모리 DB와 설정을 한 파일로 내려받는다. 데이터 초기화 전에 먼저 받아 두면 안전하다.",
  /** 마지막 백업 결과 접두. */
  lastResultPrefix: "마지막 백업",
  /** 다음 예약 실행 접두. */
  nextRunPrefix: "다음 예약",
  /** 회차 이력 개수 접두. */
  roundsPrefix: "보관 회차",
  /** 회차 이력이 하나도 없을 때. */
  noHistory: "이력 없음",
  /** 다운로드 버튼 라벨. */
  downloadBtn: "백업 다운로드",
  /** 다운로드 진행 중 버튼 라벨. */
  downloadBtnBusy: "다운로드 중...",
  /**
   * 다운로드 사본이 무엇을 담지 않는지 알리는 안내 — 사용자가 이 zip 하나로
   * 완전 복구를 기대하지 않게 정직하게 알린다.
   */
  downloadNote:
    "다운로드 ZIP은 DB·설정 사본이다. 문서 원본·이미지·API 키·인증 토큰은 포함하지 않는다. 원본을 열거나 OCR을 다시 실행하려면 별도 자산 백업이 필요하다.",
  restoreTitle: "다운로드 사본 복원 방법",
  restoreSteps: "서버를 먼저 정지하고 apps/memory 폴더에서 실행한다. 아래 ZIP 이름을 내려받은 파일 경로로 바꾸고, 비어 있는 새 복원 폴더를 지정한다. 기존 데이터가 있는 폴더에는 복원하지 않는다.",
  restoreCommand: 'bun run scripts/restore-backup.ts "bara-backup.zip" --data-dir "data-restored" --yes',
  restoreCommandLabel: "다운로드 ZIP 복원 명령",
  restoreCopy: "복원 명령 복사",
  restoreCopied: "복원 명령을 복사했다. ZIP 경로와 새 폴더를 확인한 뒤 실행한다.",
  restoreCopyFallback: "명령을 선택했다. 직접 복사해 사용한다.",
  restorePaths: "복원된 설정의 DB·자산·백업 경로는 새 폴더로 맞추며 나머지 설정은 보존한다. 시작 시 MEMORY_SETTINGS_PATH와 MEMORY_DB_PATH·BARA_ASSET_DIR를 복원된 파일·폴더로 명시한다. 변수 해제만 하면 Bun이 .env의 운영 경로를 다시 읽을 수 있다. CLI가 안내하는 비밀값·토큰 경로를 지정하고 키와 연결을 다시 설정한다.",
  restoreRoundNote: "서버 회차 복원은 회차 폴더와 같은 위치의 assets-mirror 폴더를 함께 보관해야 한다. 같은 CLI에 회차 폴더를 입력하면 해당 자산까지 복구한다. 다운로드 ZIP 복원은 512 MiB 이내 사본을 지원하며, 큰 사본은 서버 회차 복원을 사용한다.",
  /** 앱 버전 접두 (spec D4-b 대시보드 표시). */
  appVersionPrefix: "앱 버전",
  /** 스키마 버전 접두. */
  schemaVersionPrefix: "스키마",
  /** 상태 fetch 실패 접두. */
  statusFailPrefix: "상태 조회 실패",
  /** 다운로드 실패 접두. */
  downloadFailPrefix: "다운로드 실패",
  /** 다운로드 성공 토스트. */
  downloadDoneToast: "백업 다운로드 완료",
} as const;
