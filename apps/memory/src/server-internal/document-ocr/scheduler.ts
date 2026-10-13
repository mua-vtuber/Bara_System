/**
 * document-ocr/scheduler.ts — 서버 OCR 정기 사이클 스케줄러 (2026-10-11 document-ocr spec D11).
 *
 * 추출·이미지 캡션·정리 깊은 패스와 같은 시계 정렬 골격(scheduler-core.ts)을 OCR 요약 타입으로 쓴다 — 시계 정렬·
 * 겹침 방지·정지 때 진행 중 사이클 기다리기·60초 미만 거부를 다시 쓰지 않는다. 격자 오프셋은 floor(간격/2)
 * (이미지 캡션 선례 — 같은 Ollama 를 쓸 때 추출 사이클과 같은 분에 시작하지 않게).
 */

import type { DocumentOcrCycleSummary } from "../../api-client-types.ts";
import { startClockAlignedScheduler, type ClockAlignedSchedulerHandle } from "../../scheduler-core.ts";
import { emptyDocumentOcrCycleSummary, type DocumentOcrCycleOptions } from "./cycle.ts";

export type DocumentOcrSchedulerHandle = ClockAlignedSchedulerHandle<DocumentOcrCycleSummary, DocumentOcrCycleOptions>;

/** 격자 오프셋(분) — 한 곳에서만 계산한다. */
export function documentOcrOffsetMin(intervalMin: number): number {
  return Math.floor(intervalMin / 2);
}

export interface DocumentOcrSchedulerOptions {
  intervalMin: number;
  runCycle: (opts?: DocumentOcrCycleOptions) => Promise<DocumentOcrCycleSummary>;
  logPrefix?: string;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export function startDocumentOcrScheduler(options: DocumentOcrSchedulerOptions): DocumentOcrSchedulerHandle {
  return startClockAlignedScheduler<DocumentOcrCycleSummary, DocumentOcrCycleOptions>({
    intervalMs: options.intervalMin * 60_000,
    intervalMin: options.intervalMin,
    offsetMin: documentOcrOffsetMin(options.intervalMin),
    logPrefix: options.logPrefix ?? "[document-ocr scheduler]",
    runCycle: options.runCycle,
    emptySummary: emptyDocumentOcrCycleSummary,
    now: options.now,
    setTimeoutFn: options.setTimeoutFn,
    clearTimeoutFn: options.clearTimeoutFn,
  });
}
