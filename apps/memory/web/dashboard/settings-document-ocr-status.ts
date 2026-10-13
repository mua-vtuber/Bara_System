/**
 * dashboard/settings-document-ocr-status.ts — 서버 OCR 처리 상태 줄 (2026-10-11 document-ocr spec 8.3).
 *
 * GET /api/documents/ocr-jobs/server-status 를 읽어 상태(off·idle·running·config_error·daily_cap_reached)와
 * 대기·멈춤·대상 아님 개수를 보인다. 불러오기 실패는 빨간 줄에 서버 오류 문장을 그대로(빈 상태로 바꾸지 않음).
 * 저장 뒤와 [새로 고침] 버튼으로만 다시 부른다(주기 자동 갱신은 하지 않음).
 */

import { apiFetch } from "./api-fetch";
import type { DocumentOcrServerStatus } from "../../src/api-client-types";
import { DOCUMENT_OCR_LABELS as L, DOCUMENT_OCR_STOPPED_BY_LABELS } from "./settings-document-ocr-labels";
import { parseResponseError } from "./settings-document-ocr-controls";

export const DOCUMENT_OCR_SERVER_STATUS_PATH = "/api/documents/ocr-jobs/server-status";

export interface DocumentOcrStatusPanel {
  element: HTMLElement;
  /** 상태를 다시 불러온다. */
  refresh(): Promise<void>;
}

function line(text: string, className = "document-ocr-status-line"): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = className;
  p.textContent = text;
  return p;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** 상태 화면이 반드시 읽는 queue 숫자 칸 — 없으면 0 으로 읽지 않고 칸 이름을 든 오류로 멈춘다. */
const REQUIRED_QUEUE_COUNTS = ["waitingRetry", "terminal", "absorbedSharingResult", "legacyMergedRecords"] as const;

/**
 * 상태 응답 모양 확인 — 화면이 읽는 칸이 빠졌으면 어느 칸인지 적은 오류를 던진다(서버·화면 버전 어긋남을 숨기지 않음).
 * 통과하면 그 값을 DocumentOcrServerStatus 로 돌려준다.
 */
export function readDocumentOcrServerStatus(raw: unknown): DocumentOcrServerStatus {
  if (raw === null || typeof raw !== "object") throw new Error("응답에 status 가 없음");
  const status = raw as Partial<DocumentOcrServerStatus>;
  const queue = status.queue as Record<string, unknown> | undefined;
  if (queue === undefined || queue === null || typeof queue !== "object") {
    throw new Error("응답 status.queue 가 없음 — 서버·화면 버전을 확인하세요");
  }
  for (const key of REQUIRED_QUEUE_COUNTS) {
    if (typeof queue[key] !== "number") {
      throw new Error(`응답 status.queue.${key} 가 숫자가 아님 — 서버·화면 버전을 확인하세요`);
    }
  }
  for (const key of ["inProgress", "notServerProcessable"] as const) {
    if (!Array.isArray(queue[key])) throw new Error(`응답 status.queue.${key} 가 배열이 아님 — 서버·화면 버전을 확인하세요`);
  }
  return status as DocumentOcrServerStatus;
}

/** 상태 응답 → 화면 줄들(순수 함수 — 시험이 문구를 바로 본다). */
export function describeDocumentOcrStatus(status: DocumentOcrServerStatus): HTMLElement[] {
  const lines: HTMLElement[] = [];
  switch (status.state) {
    case "off":
      lines.push(line(L.statusOff(status.reason ?? "")));
      break;
    case "config_error":
      lines.push(line(L.statusConfigError(status.reason ?? ""), "document-ocr-status-line error"));
      break;
    case "error":
      lines.push(line(L.statusError(status.reason ?? ""), "document-ocr-status-line error"));
      break;
    case "daily_cap_reached":
      lines.push(line(L.statusDailyCap(status.today.maxPagesPerDay)));
      break;
    case "running": {
      const live = status.queue.inProgress[0];
      lines.push(line(live ? L.statusRunning(live.title, live.completedPages, live.pageCount) : L.statusRunningNoDoc));
      break;
    }
    case "idle":
      lines.push(line(L.statusIdle(status.nextRunAt ? formatTime(status.nextRunAt) : "-", status.today.pageCalls, status.today.maxPagesPerDay)));
      break;
  }
  if (status.lastCycle && status.state !== "off") {
    const c = status.lastCycle;
    lines.push(line(L.statusLastCycle(c.documentsApplied, c.documentsFailed, c.pageCalls, c.pagesBlank, DOCUMENT_OCR_STOPPED_BY_LABELS[c.stoppedBy] ?? c.stoppedBy)));
  }
  lines.push(line(L.statusQueue(status.queue.waitingRetry, status.queue.terminal)));
  for (const item of status.queue.notServerProcessable) lines.push(line(L.statusNotProcessable(item.reason, item.count)));
  if (status.queue.absorbedSharingResult > 0) lines.push(line(L.statusAbsorbed(status.queue.absorbedSharingResult)));
  if (status.queue.legacyMergedRecords > 0) {
    lines.push(line(L.statusLegacyMerged(status.queue.legacyMergedRecords), "document-ocr-status-line error"));
  }
  return lines;
}

export function renderDocumentOcrStatusPanel(): DocumentOcrStatusPanel {
  const element = document.createElement("section");
  element.className = "document-ocr-status";
  element.dataset.section = "ocr-server-status";
  const heading = document.createElement("h3");
  heading.className = "document-ocr-panel-title";
  heading.textContent = L.statusTitle;
  const body = document.createElement("div");
  body.className = "document-ocr-status-body";
  body.setAttribute("role", "status");
  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "au-btn document-ocr-status-refresh";
  refreshButton.textContent = L.refresh;
  element.append(heading, body, refreshButton);

  let seq = 0;
  async function refresh(): Promise<void> {
    const mine = ++seq;
    refreshButton.disabled = true;
    body.replaceChildren(line(L.statusLoading));
    try {
      const res = await apiFetch(DOCUMENT_OCR_SERVER_STATUS_PATH);
      const data = (await res.json().catch(() => null)) as { status?: DocumentOcrServerStatus } | null;
      if (!res.ok) throw new Error(parseResponseError(data, `HTTP ${res.status}`));
      const status = readDocumentOcrServerStatus(data?.status ?? null);
      if (mine !== seq) return;
      body.replaceChildren(...describeDocumentOcrStatus(status));
    } catch (err) {
      if (mine !== seq) return;
      body.replaceChildren(
        line(L.statusLoadFailed(err instanceof Error ? err.message : String(err)), "document-ocr-status-line error"),
      );
    } finally {
      if (mine === seq) refreshButton.disabled = false;
    }
  }
  refreshButton.addEventListener("click", () => void refresh());
  return { element, refresh };
}
