/**
 * 어댑터 토큰 승인·발급 화면 한국어 라벨 (WP-B1-14) — i18n-ready 로 한 곳에 모음.
 *
 * settings-adapter-tokens.ts 가 노출하는 사용자 문자열을 전부 여기 모은다.
 * 번역 시점에 이 파일 하나만 갈아끼우면 되게 하려는 분리 —
 * 패널·행 렌더 코드에는 사용자 문자열 리터럴을 직접 기재하지 않는다
 * (settings-backup-labels.ts 선례).
 */

import type { TokenScope } from "../../src/federation/token-scope";

/** scope 선택 UI 표시 순서 — 약함 → full (token-scope.ts TOKEN_SCOPES 와 동일 순서). */
export const ADAPTER_TOKEN_SCOPE_LABELS: Record<TokenScope, string> = {
  "read-only": "읽기 전용",
  "mcp-standard": "표준",
  full: "전체 관리",
};

/**
 * 대기 요청 행의 상태 배지 문구. AdapterTokenRequestDTO["status"] 와 같은
 * 값 리터럴("pending" | "approved" | "rejected")을 직접 키로 쓴다 — DTO
 * 타입을 이 라벨 모듈이 import 하면 settings-adapter-tokens.ts ↔ 라벨
 * 모듈 순환 참조가 생기므로, 값만 맞춰 독립적으로 둔다(QA 후속: 옛 위치는
 * settings-adapter-tokens.ts 안이었다).
 */
export const ADAPTER_REQUEST_STATUS_LABELS: Record<
  "pending" | "approved" | "rejected",
  string
> = {
  pending: "승인 대기",
  approved: "승인됨",
  rejected: "거절됨",
};

/** scope 선택 옆에 붙는 한 줄 설명 — 관리자가 승인 전에 권한 범위를 이해하게 한다. */
export const ADAPTER_TOKEN_SCOPE_DESCRIPTIONS: Record<TokenScope, string> = {
  "read-only": "메모리 조회만 가능합니다. 저장·삭제·설정 변경은 할 수 없습니다.",
  "mcp-standard": "메모리 저장·검색과 일반 기능을 사용할 수 있습니다. 통계·삭제·정리 등 관리 기능은 제외됩니다.",
  full: "통계 조회, 삭제, 정리 작업, 문서 처리 등 관리 기능을 포함한 모든 권한을 사용할 수 있습니다.",
};

/** 발급 행의 옛 토큰(scope 미지정 = full) 배지 문구. */
export const ADAPTER_TOKEN_LEGACY_SUFFIX = "권한 미지정 옛 토큰 = full";

export const ADAPTER_TOKEN_LABELS = {
  /** 패널 제목. */
  panelTitle: "어댑터 관리",
  /** 패널 안내. */
  panelIntro:
    "메모리에 연결할 앱의 요청을 승인하거나 거절합니다. 승인한 앱에는 연결 토큰이 전달되며, 연결을 해제하려면 '토큰 회수'를 누르세요.",
  pendingSectionTitle: "승인 대기",
  issuedSectionTitle: "발급됨",
  pendingEmpty: "승인 대기 중인 어댑터 없음",
  issuedEmpty: "발급된 어댑터 토큰 없음",

  approveBtn: "승인",
  rejectBtn: "거절",
  revokeBtn: "토큰 회수",
  changeScopeBtn: "권한 변경 적용",

  approveSuccessToast: "어댑터 토큰 승인 완료",
  rejectSuccessToast: "어댑터 토큰 요청 거절",
  revokeSuccessToast: "어댑터 토큰 회수 완료",
  scopeChangeSuccessToast: "어댑터 권한 변경 완료",

  /** 권한 선택 라벨(승인 폼 select 위 label). */
  scopeSelectLabel: "부여할 권한",
  /** 요청자가 밝힌 요청 권한 접두. */
  requestedScopePrefix: "요청한 권한",
  /** 요청자가 권한을 밝히지 않은 경우. */
  requestedScopeUnspecified: "요청한 권한 없음",
  /** 발급 행의 현재 권한 배지 접두. */
  currentScopePrefix: "현재 권한",

  /** full 권한을 관리자가 직접 고르기 전에는 승인 버튼을 막는 안내. */
  fullScopeConfirmNotice:
    "요청한 권한이 '전체 관리'입니다. 승인하려면 부여할 권한에서 '전체 관리'를 직접 선택하세요.",

  /** 기존 어댑터 재등록 경고 — existingAdapter 가 있을 때. */
  existingAdapterWarningPrefix: "이미 연결된 어댑터(현재 권한",
  existingAdapterWarningSuffix:
  ")입니다. 공유 승인은 요청자에게 기존 토큰을 그대로 전달합니다.",
  existingAdapterLegacyNote: "옛 토큰이면 '권한 미지정 옛 토큰 = full'",

  /** 기존 토큰 처리 선택 라벨·옵션. */
  existingTokenChoiceLabel: "기존 연결 처리",
  existingTokenChoiceShare: "기존 토큰 공유",
  existingTokenChoiceRotate: "토큰 교체(기존 연결 끊김)",
  /** 고른 권한이 이 어댑터의 모든 연결에 적용됨을 알리는 안내(공유 승인 시). */
  existingAdapterScopeAppliesNotice:
    "고른 권한은 이 어댑터의 기존 연결에도 함께 적용됩니다.",

  /** 오류 표시 접두 — API 실패 원인을 그대로 붙인다(silent 실패 금지). */
  errorPrefix: "오류",
} as const;
