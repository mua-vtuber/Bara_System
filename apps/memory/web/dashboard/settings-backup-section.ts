/**
 * dashboard/settings-backup-section.ts — 설정 메모리 탭 하단 "백업" 절 (P4 T6).
 *
 * renderAdvancedMemorySection 이 renderDangerZone() 앞에 배치한다("초기화 전 백업"
 * 동선). 두 가지 일을 한다:
 *   1) mount 시 GET /backup/status 를 호출해 마지막 백업 결과·다음 예약·회차 개수와
 *      앱/스키마 버전 한 줄(spec D4-b)을 표시. fetch 실패 시 에러 문구를 노출한다
 *      (silent 빈칸 금지 — danger-zone runDataReset 양식 정합).
 *   2) [백업 다운로드] 버튼 = GET /backup/download → blob → objectURL → 동적
 *      <a download> click → revokeObjectURL. raw fetch/<a href> 는 Authorization
 *      헤더가 없어 401 이라 반드시 apiFetch 통로를 탄다.
 *
 * 주입형 설계 — renderBackupSection(deps?) 의 default 인자가 apiFetch 실구현을
 * 감싼다. 테스트는 fetchStatus/downloadBlob 두 함수에 데이터 fixture 를 주입한다
 * (데이터 주입이지 인터페이스 Mock 클래스가 아님).
 */

import { showToast } from "./form/toast";
import { apiFetch } from "./api-fetch";
import { BACKUP_LABELS } from "./settings-backup-labels.ts";

/** GET /backup/status 응답 계약 (T5 backup.ts 라우트와 정합). */
export interface BackupStatusResponse {
  lastResult:
    | { ok: boolean; at: string; roundDir?: string; error?: string }
    | null;
  nextRunAt: string | null;
  appVersion: string;
  schemaVersion: number;
  rounds: {
    dir: string;
    timestamp: string;
    files: number;
    assets: number;
    bytes: number;
  }[];
}

/** 주입 계약 — default 는 apiFetch 실구현을 감싼다. */
export interface BackupSectionDeps {
  /** GET /backup/status 를 호출해 상태를 회신한다. 실패 시 throw. */
  fetchStatus: () => Promise<BackupStatusResponse>;
  /** GET /backup/download 를 호출해 zip blob 을 회신한다. 실패 시 throw. */
  downloadBlob: () => Promise<Blob>;
}

/** default fetchStatus — apiFetch 로 GET /backup/status, 비-2xx 는 throw. */
async function defaultFetchStatus(): Promise<BackupStatusResponse> {
  const res = await apiFetch("/backup/status");
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as BackupStatusResponse;
}

/** default downloadBlob — apiFetch 로 GET /backup/download, 비-2xx 는 throw. */
async function defaultDownloadBlob(): Promise<Blob> {
  const res = await apiFetch("/backup/download");
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return await res.blob();
}

/**
 * 메모리 탭 하단 "백업" 절 — 상태 표시 + 다운로드 버튼.
 *
 * deps 미주입 시 default 가 apiFetch 실구현을 감싼다. 마운트 직후 상태를 비동기로
 * 가져와 채우며, 그 사이 상태 줄은 "..." 로 둔다(빈칸 아님).
 */
export function renderBackupSection(
  deps: BackupSectionDeps = {
    fetchStatus: defaultFetchStatus,
    downloadBlob: defaultDownloadBlob,
  },
): HTMLElement {
  const section = document.createElement("section");
  section.className = "backup-section";
  section.dataset.section = "backup";

  const title = document.createElement("h2");
  title.textContent = BACKUP_LABELS.title;
  section.appendChild(title);

  const desc = document.createElement("p");
  desc.className = "backup-section-desc";
  desc.textContent = BACKUP_LABELS.desc;
  section.appendChild(desc);

  // 상태 줄 — mount 시 fetchStatus 로 채운다. 채워지기 전에는 로딩 표시.
  const statusLine = document.createElement("p");
  statusLine.className = "backup-section-status";
  statusLine.textContent = "...";
  section.appendChild(statusLine);

  // 앱/스키마 버전 줄 (spec D4-b) — 상태 fetch 성공 시에만 채운다.
  const versionLine = document.createElement("p");
  versionLine.className = "backup-section-version";
  versionLine.textContent = "";
  section.appendChild(versionLine);

  // 다운로드 사본 제외 안내 — 완전 복구 기대를 정직하게 차단.
  const note = document.createElement("p");
  note.className = "backup-section-note";
  note.textContent = BACKUP_LABELS.downloadNote;
  section.appendChild(note);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "backup-section-btn";
  btn.textContent = BACKUP_LABELS.downloadBtn;
  section.appendChild(btn);

  // 다운로드 실패 문구 표시용(성공은 토스트, 실패는 인라인 + 토스트).
  const dlStatus = document.createElement("p");
  dlStatus.className = "backup-section-status";
  dlStatus.textContent = "";
  section.appendChild(dlStatus);

  const restore = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = BACKUP_LABELS.restoreTitle;
  restore.appendChild(summary);
  const steps = document.createElement("p");
  steps.textContent = BACKUP_LABELS.restoreSteps;
  restore.appendChild(steps);
  const command = document.createElement("textarea");
  command.dataset.backupRestoreCommand = "";
  command.readOnly = true;
  command.rows = 3;
  command.style.width = "100%";
  command.style.boxSizing = "border-box";
  command.setAttribute("aria-label", BACKUP_LABELS.restoreCommandLabel);
  command.value = BACKUP_LABELS.restoreCommand;
  restore.appendChild(command);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = BACKUP_LABELS.restoreCopy;
  const copyStatus = document.createElement("p");
  copyStatus.setAttribute("role", "status");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(command.value);
      copyStatus.textContent = BACKUP_LABELS.restoreCopied;
    } catch {
      command.focus();
      command.select();
      copyStatus.textContent = BACKUP_LABELS.restoreCopyFallback;
    }
  });
  restore.append(copy, copyStatus);
  for (const text of [BACKUP_LABELS.restorePaths, BACKUP_LABELS.restoreRoundNote]) {
    const note = document.createElement("p");
    note.textContent = text;
    restore.appendChild(note);
  }
  section.appendChild(restore);

  btn.addEventListener("click", () => {
    void runDownload(btn, dlStatus, deps);
  });

  void loadStatus(statusLine, versionLine, deps);

  return section;
}

/**
 * 상태 fetch → 마지막 결과·다음 예약·회차 개수·버전 줄 반영.
 *
 * 실패 시 상태 줄에 에러 접두 + 원인 메시지를 노출한다(silent 빈칸 금지 —
 * danger-zone runDataReset 실패 양식 정합). 버전 줄은 그대로 비운다.
 */
async function loadStatus(
  statusLine: HTMLElement,
  versionLine: HTMLElement,
  deps: BackupSectionDeps,
): Promise<void> {
  try {
    const s = await deps.fetchStatus();

    const last =
      s.lastResult === null
        ? BACKUP_LABELS.noHistory
        : s.lastResult.ok
          ? `${formatStamp(s.lastResult.at)} 성공`
          : `${formatStamp(s.lastResult.at)} 실패 (${s.lastResult.error ?? "원인 불명"})`;
    const next =
      s.nextRunAt === null ? BACKUP_LABELS.noHistory : formatStamp(s.nextRunAt);
    const rounds =
      s.rounds.length === 0
        ? BACKUP_LABELS.noHistory
        : `${s.rounds.length}건`;

    statusLine.classList.remove("error");
    statusLine.textContent =
      `${BACKUP_LABELS.lastResultPrefix}: ${last} · ` +
      `${BACKUP_LABELS.nextRunPrefix}: ${next} · ` +
      `${BACKUP_LABELS.roundsPrefix}: ${rounds}`;

    versionLine.textContent =
      `${BACKUP_LABELS.appVersionPrefix} ${s.appVersion} · ` +
      `${BACKUP_LABELS.schemaVersionPrefix} v${s.schemaVersion}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    statusLine.classList.add("error");
    statusLine.textContent = `${BACKUP_LABELS.statusFailPrefix}: ${message}`;
    versionLine.textContent = "";
  }
}

/**
 * 다운로드 실행 — downloadBlob → objectURL → 동적 <a download> click →
 * revokeObjectURL. danger-zone runDataReset 양식 정합: 버튼 비활성 + "다운로드
 * 중..." + 성공/실패 토스트, 실패는 인라인 문구도 남긴다(silent skip 금지).
 *
 * 파일명은 Content-Disposition 파싱 대신 로컬 시각으로 클라이언트 조립한다
 * (bara-backup-<로컬시각>.zip).
 */
async function runDownload(
  btn: HTMLButtonElement,
  dlStatus: HTMLElement,
  deps: BackupSectionDeps,
): Promise<void> {
  btn.disabled = true;
  btn.textContent = BACKUP_LABELS.downloadBtnBusy;
  dlStatus.textContent = "";
  dlStatus.classList.remove("error");
  let url: string | null = null;
  try {
    const blob = await deps.downloadBlob();
    url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bara-backup-${localStamp()}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast(BACKUP_LABELS.downloadDoneToast, "success");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dlStatus.classList.add("error");
    dlStatus.textContent = `${BACKUP_LABELS.downloadFailPrefix}: ${message}`;
    showToast(`${BACKUP_LABELS.downloadFailPrefix}: ${message}`, "error");
  } finally {
    if (url !== null) URL.revokeObjectURL(url);
    btn.disabled = false;
    btn.textContent = BACKUP_LABELS.downloadBtn;
  }
}

/** ISO 문자열을 로컬 표시용으로 간략화한다. 파싱 실패 시 원문 그대로. */
function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/** 파일명용 로컬 시각 도장 — 콜론·점을 파일명 안전 문자로 치환. */
function localStamp(): string {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
}
