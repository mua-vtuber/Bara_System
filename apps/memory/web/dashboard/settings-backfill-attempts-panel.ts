/**
 * dashboard/settings-backfill-attempts-panel.ts — 자동 추출·캡션 실패 기록 패널 (2026-10-14 backfill-retry-ledger spec 6장).
 *
 * GET /api/backfill-attempts/status?kind= 를 읽어 "다시 시도 대기 N · 멈춤 N" 줄과 실패 목록(기억 번호·앞부분·시도 횟수·
 * 마지막 오류·시각)을 보이고, 기억별 [다시 시도]와 멈춤이 있으면 [모두 다시 시도]를 둔다. 다시 시도는 줄을 지울 뿐
 * 즉시 실행하지 않는다(다음 주기에 다시 후보). 처음 그릴 때·[새로 고침]·다시 시도 뒤에만 불러온다(주기 자동 갱신 없음 —
 * 문서 OCR 상태 패널과 같다). 불러오기·다시 시도 실패는 빈 목록으로 보이지 않고 빨간 줄에 서버 오류 문장을 그대로 보인다.
 * 응답에 칸이 빠지면 칸 이름을 든 오류로 멈춘다(readBackfillAttemptsStatus).
 */
import { apiFetch } from "./api-fetch";
import { parseResponseError } from "./settings-document-ocr-controls";
import { BACKFILL_ATTEMPTS_LABELS as L } from "./settings-backfill-attempts-labels";
import {
  BACKFILL_ATTEMPTS_RETRY_PATH,
  BACKFILL_ATTEMPTS_STATUS_PATH,
  type BackfillAttemptKind,
  type BackfillAttemptStatusItem,
  type BackfillAttemptsStatusResponse,
  type BackfillRetryRequest,
} from "../../src/memory/backfill-attempts/contract";

export interface BackfillAttemptsPanel {
  element: HTMLElement;
  /** 상태를 다시 불러온다. */
  refresh(): Promise<void>;
}

const LINE_CLASS = "backfill-attempts-line";
const ERROR_LINE_CLASS = `${LINE_CLASS} error`;

function line(text: string, className = LINE_CLASS): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = className;
  p.textContent = text;
  return p;
}

function actionButton(text: string, action: "retry-one" | "retry-all" | "refresh", targetKey?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "au-btn backfill-attempts-button";
  button.dataset.action = action;
  if (targetKey !== undefined) button.dataset.targetKey = targetKey;
  button.textContent = text;
  return button;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const ITEM_NUMBER_FIELDS = ["nodeId", "attemptCount"] as const;
const ITEM_STRING_FIELDS = ["targetKey", "preview", "lastError", "lastAttemptAt", "status"] as const;

/** 상태 응답 모양 확인 — 화면이 읽는 칸이 빠졌으면 어느 칸인지 적은 오류를 던진다(0·빈 목록으로 읽지 않음). */
export function readBackfillAttemptsStatus(raw: unknown, kind: BackfillAttemptKind): BackfillAttemptsStatusResponse {
  if (raw === null || typeof raw !== "object") throw new Error(L.responseNotObject);
  const rec = raw as Record<string, unknown>;
  if (rec.kind !== kind) throw new Error(L.responseKindMismatch(kind, String(rec.kind)));
  for (const key of ["waitingRetry", "stopped"] as const) {
    if (typeof rec[key] !== "number") throw new Error(L.responseFieldInvalid(key, "숫자"));
  }
  if (typeof rec.truncated !== "boolean") throw new Error(L.responseFieldInvalid("truncated", "참거짓"));
  if (!Array.isArray(rec.items)) throw new Error(L.responseFieldInvalid("items", "배열"));
  rec.items.forEach((item: unknown, index: number) => {
    const path = `items[${index}]`;
    if (item === null || typeof item !== "object") throw new Error(L.responseFieldInvalid(path, "객체"));
    const it = item as Record<string, unknown>;
    for (const key of ITEM_NUMBER_FIELDS) {
      if (typeof it[key] !== "number") throw new Error(L.responseFieldInvalid(`${path}.${key}`, "숫자"));
    }
    for (const key of ITEM_STRING_FIELDS) {
      if (typeof it[key] !== "string") throw new Error(L.responseFieldInvalid(`${path}.${key}`, "문자열"));
    }
    if (it.nextRetryAt !== null && typeof it.nextRetryAt !== "string") {
      throw new Error(L.responseFieldInvalid(`${path}.nextRetryAt`, "문자열 또는 null"));
    }
  });
  return raw as BackfillAttemptsStatusResponse;
}

function itemRow(item: BackfillAttemptStatusItem): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "backfill-attempts-item";
  li.dataset.targetKey = item.targetKey;
  const state = item.status === "terminal_failure" ? L.statusStopped : L.statusWaiting;
  const times = item.nextRetryAt === null
    ? L.lastAttempt(item.lastAttemptAt)
    : `${L.lastAttempt(item.lastAttemptAt)} · ${L.nextRetry(item.nextRetryAt)}`;
  li.append(
    line(`${L.memoryNumber(item.nodeId)} · ${state} · ${L.attempts(item.attemptCount)}`),
    line(item.preview, "backfill-attempts-preview"),
    line(L.lastError(item.lastError), "backfill-attempts-error-text"),
    line(times),
    actionButton(L.retryOne, "retry-one", item.targetKey),
  );
  return li;
}

/** 상태 응답 → 화면 줄들(순수 함수 — 시험이 문구를 바로 본다). */
export function describeBackfillAttempts(status: BackfillAttemptsStatusResponse): HTMLElement[] {
  const out: HTMLElement[] = [line(L.summary(status.waitingRetry, status.stopped))];
  if (status.items.length === 0) {
    out.push(line(L.empty));
    return out;
  }
  const list = document.createElement("ul");
  list.className = "backfill-attempts-list";
  for (const item of status.items) list.appendChild(itemRow(item));
  out.push(list);
  if (status.truncated) out.push(line(L.truncated(status.items.length)));
  if (status.stopped > 0) out.push(actionButton(L.retryAll, "retry-all"));
  return out;
}

export function renderBackfillAttemptsPanel(kind: BackfillAttemptKind): BackfillAttemptsPanel {
  const element = document.createElement("section");
  element.className = "backfill-attempts";
  element.dataset.section = `backfill-attempts-${kind}`;
  const heading = document.createElement("h3");
  heading.className = "llm-block-title";
  heading.textContent = L.title[kind];
  const body = document.createElement("div");
  body.className = "backfill-attempts-body";
  body.setAttribute("role", "status");
  const refreshButton = actionButton(L.refresh, "refresh");
  element.append(heading, body, refreshButton);

  let seq = 0;
  async function refresh(): Promise<void> {
    const mine = ++seq;
    refreshButton.disabled = true;
    body.replaceChildren(line(L.loading));
    try {
      const res = await apiFetch(`${BACKFILL_ATTEMPTS_STATUS_PATH}?kind=${encodeURIComponent(kind)}`);
      const data = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) throw new Error(parseResponseError(data, `HTTP ${res.status}`));
      const status = readBackfillAttemptsStatus(data, kind);
      if (mine !== seq) return;
      body.replaceChildren(...describeBackfillAttempts(status));
    } catch (err) {
      if (mine !== seq) return;
      body.replaceChildren(line(L.loadFailed(messageOf(err)), ERROR_LINE_CLASS));
    } finally {
      if (mine === seq) refreshButton.disabled = false;
    }
  }

  async function retry(request: BackfillRetryRequest): Promise<void> {
    try {
      const res = await apiFetch(BACKFILL_ATTEMPTS_RETRY_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const data = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) throw new Error(parseResponseError(data, `HTTP ${res.status}`));
    } catch (err) {
      body.replaceChildren(line(L.retryFailed(messageOf(err)), ERROR_LINE_CLASS));
      return;
    }
    await refresh();
  }

  body.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement | null)?.closest("button[data-action]") as HTMLButtonElement | null;
    if (button === null) return;
    if (button.dataset.action === "retry-one" && button.dataset.targetKey) {
      void retry({ kind, targetKeys: [button.dataset.targetKey] });
    } else if (button.dataset.action === "retry-all") {
      void retry({ kind, all: true });
    }
  });
  refreshButton.addEventListener("click", () => void refresh());
  return { element, refresh };
}
