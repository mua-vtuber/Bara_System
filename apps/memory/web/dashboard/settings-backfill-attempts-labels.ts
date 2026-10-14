/**
 * dashboard/settings-backfill-attempts-labels.ts — 추출·캡션 실패 기록 패널과 재시도 설정 칸 문구 (2026-10-14 spec 6장).
 * 대시보드에는 i18n 층이 없어 문구를 이 모듈 한 곳에 모은다.
 */
import type { BackfillAttemptKind } from "../../src/memory/backfill-attempts/contract";

export const BACKFILL_ATTEMPTS_LABELS = {
  title: { extraction: "추출 실패 기록", caption: "이미지 설명 실패 기록" } as Readonly<Record<BackfillAttemptKind, string>>,
  summary: (waiting: number, stopped: number) => `다시 시도 대기 ${waiting} · 멈춤 ${stopped}`,
  refresh: "새로 고침",
  loading: "불러오는 중",
  empty: "실패해서 기다리거나 멈춘 기억이 없습니다.",
  retryOne: "다시 시도",
  retryAll: "모두 다시 시도",
  statusStopped: "멈춤",
  statusWaiting: "다시 시도 대기",
  memoryNumber: (nodeId: number) => `기억 ${nodeId}번`,
  attempts: (count: number) => `시도 ${count}회`,
  lastError: (message: string) => `마지막 오류: ${message}`,
  lastAttempt: (at: string) => `마지막 시도 ${at}`,
  nextRetry: (at: string) => `다음 시도 ${at}`,
  truncated: (shown: number) => `목록은 앞의 ${shown}개만 보입니다.`,
  loadFailed: (message: string) => `실패 기록을 불러오지 못했습니다: ${message}`,
  retryFailed: (message: string) => `다시 시도 요청이 실패했습니다: ${message}`,
  responseNotObject: "응답이 객체가 아님 — 서버·화면 버전을 확인하세요",
  responseKindMismatch: (expected: string, got: string) => `응답 kind 가 ${expected} 가 아님 (받은 값: ${got}) — 서버·화면 버전을 확인하세요`,
  responseFieldInvalid: (path: string, expected: string) => `응답 ${path} 가 ${expected} 형식이 아님 — 서버·화면 버전을 확인하세요`,
} as const;

/** 추출·캡션 블록의 자동 재시도 설정 칸 라벨(설명은 서버 스키마 memory-schema-groups-backfill-retry.ts 가 단일 출처). */
export const BACKFILL_RETRY_FIELD_LABELS = {
  maxAttempts: "자동 재시도 최대 횟수",
  retryDelayMin: "첫 재시도 대기 (분)",
  retryMaxDelayMin: "최대 재시도 대기 (분)",
} as const;
