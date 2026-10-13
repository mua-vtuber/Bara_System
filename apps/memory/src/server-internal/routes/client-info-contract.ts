/**
 * /client-info 응답 계약 상수 — 단일 출처 (PS-2 수정 — WP-B1-26).
 *
 * 권위: docs/decisions/2026-09-27-audit-fix-plan-memory-core.md WP-B1-26.
 *
 * /client-info 라우트는 이 상수들을 응답하며, 클라이언트 설정과 상호
 * 호환성 문서가 이 값을 참조한다(SHARED_MEMORY.md).
 *
 * 의존성 없음 — stats.ts 만 import 한다.
 */

/** MCP 프로토콜 버전 — 클라이언트와 서버가 호환되는지 판단하는 기준. */
export const CLIENT_INFO_PROTOCOL_VERSION = 1 as const;

/** 서버가 클라이언트에게 지원하는 기능 목록. */
export const CLIENT_CAPABILITIES = [
  "ingest-receipts",
  "capture",
  "memory-deeplink",
  "cleanup-proposals",
  "editable-memory-body",
] as const;
