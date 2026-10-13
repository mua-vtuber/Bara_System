/**
 * document-ocr/runtime-types.ts — 서버 OCR 실행기 관리자의 계약(순수 타입). server-internal/types.ts 가 이 파일만
 * import 한다(types.ts → runtime-types.ts 한 방향, 2026-10-11 document-ocr spec 6장).
 */

import type { DocumentOcrCycleSummary, DocumentOcrServerStatus } from "../../api-client-types.ts";
import type { DocumentOcrSettings } from "../../settings/memory-settings-slots.ts";
import type { NotOwnedPlacement } from "../../db/store-internal/document-repository.ts";

export type { DocumentOcrCycleSummary, DocumentOcrServerStatus };

/** 수동 1회 실행 결과 — 라우트가 HTTP 응답으로 바꾼다. */
export type DocumentOcrRunOnceResult =
  | { kind: "not_server_mode"; reason: string }
  | { kind: "already_running" }
  | { kind: "daily_cap"; maxPagesPerDay: number }
  | { kind: "not_found" }
  /** 자기 노드가 아닌 곳에 놓인 기록(같은 파일로 합쳐짐·옛 버전이 잘못 합침) — 결과를 붙일 노드가 없어 읽지 않는다. */
  | { kind: "not_own"; placement: NotOwnedPlacement }
  | { kind: "not_candidate" }
  /** 서버가 읽을 수 없는 문서(docx 등) — 사유를 사람이 읽게. */
  | { kind: "not_processable"; reason: string }
  /** 다른 작업자(내 PC 보조 프로그램 등)가 임대 중. */
  | { kind: "leased"; reason: string }
  | { kind: "ran"; summary: DocumentOcrCycleSummary };

export interface DocumentOcrRuntime {
  /** 살아 있는 설정(저장 즉시 새 값). */
  currentSettings(): DocumentOcrSettings;
  /** 지금 스케줄러를 멈추고(진행 중 사이클 기다림) 새 설정으로 켜거나 끈다. */
  reconfigure(): Promise<void>;
  /** 수동 1회 — 사이클이 돌고 있으면 already_running. documentId 를 주면 그 문서 원장을 지우고 그 문서만. */
  tryRunOnce(documentId?: string): Promise<DocumentOcrRunOnceResult>;
  status(): DocumentOcrServerStatus;
  /** 사이클이 돌고 있는지(데이터 초기화가 물러날지 판단). */
  isRunning(): boolean;
  /** 종료 절차 — 스케줄러 정지(진행 중 사이클 기다림). */
  stop(): Promise<void>;
}
