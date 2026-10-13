/**
 * document-ocr/runtime.ts — 서버 OCR 실행기 관리자 (2026-10-11 document-ocr spec D15·D17, 사용자 결정 Q9).
 *
 * 설정을 저장하면 바로 반영한다: index.ts 의 reloadBus 구독이 reconfigure() 를 부른다. 문서 OCR 설정이 실제로
 * 바뀌었을 때만 지금 사이클의 호출을 끊고(끊긴 쪽은 시도로 세지 않음) 끝나기를 기다린 뒤 새 설정으로 켜거나 끈다.
 * 다른 설정 묶음만 저장했으면 아무것도 하지 않는다. 다른 설정 묶음의 "재시작 후 적용" 은 바꾸지 않는다.
 *
 * 사이클은 늘 한 번에 하나다: 정기 사이클·수동 실행 모두 이 관리자가 쥔 "지금 사이클"을 거친다. 그래서 스케줄러를
 * 바꾸는 동안에도 isRunning·상태 화면·409·데이터 초기화 막기가 실제로 도는 사이클을 본다.
 *
 * 켜는 조건: mode ∈ {local, api} + intervalMin ≥ 1 + 자산 저장소 + 리더 생성 성공 + 임대 시간 조건. 하나라도 아니면
 * 끄고 사유를 남긴다(로그 + 상태 화면). 리더는 사이클마다 새 설정으로 다시 만든다(키·모델 변경이 다음 사이클에 바로).
 */

import type { MemoryApiDeps } from "../types.ts";
import type { DocumentOcrCycleSummary, DocumentOcrServerStatus } from "../../api-client-types.ts";
import { nowKst } from "../../db/store-internal/helpers.ts";
import {
  OCR_AUTOMATIC_PARSE_STATUSES,
  OCR_RESULT_APPLICABLE_PARSE_STATUSES,
  isDocumentParseLeaseActive,
  readDocumentParseMetadata,
} from "../../memory/document-parse-status.ts";
import { nextClockAlignedRunAt } from "../../scheduler-core.ts";
import { SERVER_OCR_WORKER_ID, isDocumentOcrServerMode } from "../../settings/document-ocr-api-providers.ts";
import type { DocumentOcrSettings, MemorySettings } from "../../settings/memory-settings.ts";
import {
  documentOcrDay,
  emptyDocumentOcrCycleSummary,
  leaseConfigProblem,
  runDocumentOcrCycle,
  type DocumentOcrCycleOptions,
} from "./cycle.ts";
import { maskOcrErrorText } from "./error-classify.ts";
import { DocumentOcrLedger } from "./ledger.ts";
import { createDocumentPageImageSource, documentOcrEligibility, type DocumentPageImageSource } from "./page-images.ts";
import { createDocumentOcrReader, type FixedAddressOverrides } from "./page-reader.ts";
import { documentOcrOffsetMin, startDocumentOcrScheduler, type DocumentOcrSchedulerHandle } from "./scheduler.ts";
import { DocumentOcrConfigError } from "./types.ts";
import type { DocumentOcrRunOnceResult, DocumentOcrRuntime } from "./runtime-types.ts";

/** "서버 OCR 대상 아님" 묶음을 셀 때 훑는 후보 수 상한(claim 과 같은 500). */
const NOT_PROCESSABLE_SCAN_LIMIT = 500;

export interface DocumentOcrRuntimeOptions {
  /** 문서 적용·실패 기록에 쓰는 서버 의존(store·assetStore·eventBus 등). */
  api: MemoryApiDeps;
  /** 살아 있는 설정 — index.ts 가 reloadBus 로 갱신하는 변수를 읽는다. */
  getSettings: () => MemorySettings;
  logPrefix?: string;
  /** 테스트 전용 — 고정 주소 업체를 대역 서버로. 운영 배선은 넘기지 않는다. */
  readerOverrides?: FixedAddressOverrides;
  /** 테스트 전용 — 쪽 그림 모듈 바꿔 넣기. */
  pageImages?: () => DocumentPageImageSource;
  /** 테스트 전용 — 스케줄러 시계·타이머. */
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

/** 켤 수 없는 사유 — null 이면 켤 수 있음. kind=off 는 사용자가 끈 상태, config 는 설정 결함. */
function startProblem(
  settings: DocumentOcrSettings,
  api: MemoryApiDeps,
  overrides: FixedAddressOverrides,
): { kind: "off" | "config"; reason: string } | null {
  if (!isDocumentOcrServerMode(settings.mode)) {
    return { kind: "off", reason: `documents.ocr.mode=${settings.mode} — 서버 자동 처리 안 함` };
  }
  if (!(settings.schedule.intervalMin >= 1)) {
    return { kind: "config", reason: `documents.ocr.schedule.intervalMin=${settings.schedule.intervalMin} 은 1 이상이어야 함` };
  }
  if (!api.assetStore) return { kind: "config", reason: "assetStore 미설정 — OCR 에 보낼 원본 자산을 읽을 수 없음" };
  try {
    createDocumentOcrReader(settings, overrides);
  } catch (err) {
    if (err instanceof DocumentOcrConfigError) return { kind: "config", reason: err.message };
    throw err;
  }
  const lease = leaseConfigProblem(settings);
  return lease ? { kind: "config", reason: lease } : null;
}

/** 후보 목록에서 빠진 기록 수를 상태 화면 queue 칸으로. */
function notOwnedQueueCounts(counts: { absorbed: number; legacyMerged: number }) {
  return { absorbedSharingResult: counts.absorbed, legacyMergedRecords: counts.legacyMerged };
}

export function createDocumentOcrRuntime(opts: DocumentOcrRuntimeOptions): DocumentOcrRuntime {
  const logPrefix = opts.logPrefix ?? "[document-ocr]";
  const overrides = opts.readerOverrides ?? {};
  const ledger = new DocumentOcrLedger(opts.api.store.getRawDb());
  let scheduler: DocumentOcrSchedulerHandle | null = null;
  let schedulerIntervalMin = 0;
  let problem: { kind: "off" | "config"; reason: string } | null = { kind: "off", reason: "서버 OCR 실행기가 아직 시작되지 않음" };
  let lastCycle: DocumentOcrCycleSummary | null = null;
  let progress: { documentId: string; title: string; completedPages: number; pageCount: number } | null = null;
  /** 지금 도는 사이클(정기·수동 모두) — 한 번에 하나뿐. 끝나면 null. */
  let current: { promise: Promise<DocumentOcrCycleSummary>; controller: AbortController } | null = null;
  let reconfiguring: Promise<void> = Promise.resolve();
  /** 마지막으로 적용한 문서 OCR 설정(JSON) — 같으면 재구성하지 않는다. */
  let appliedSettingsKey: string | null = null;

  const currentSettings = () => opts.getSettings().documents.ocr;

  async function executeCycle(cycleOpts: DocumentOcrCycleOptions, signal: AbortSignal): Promise<DocumentOcrCycleSummary> {
    const startedAtMs = Date.now();
    try {
      const summary = await runDocumentOcrCycle(
        {
          api: opts.api,
          ledger,
          settings: currentSettings(),
          pageImages: opts.pageImages ? opts.pageImages() : createDocumentPageImageSource(),
          createReader: (s) => createDocumentOcrReader(s, overrides),
          onProgress: (p) => { progress = p; },
          logPrefix,
          signal,
        },
        cycleOpts,
      );
      lastCycle = summary;
      if (summary.stoppedBy === "config_error") console.warn(`${logPrefix} 설정 문제로 멈춤 — ${summary.configError}`);
      else if (summary.pageCalls > 0) {
        console.log(
          `${logPrefix} cycle: 문서 ${summary.documentsApplied}건 적용 / ${summary.documentsFailed}건 실패, 쪽 호출 ${summary.pageCalls} (성공 ${summary.pagesSucceeded}·일시 ${summary.pagesTransientFailed}·결정 ${summary.pagesDeterministicFailed}), 멈춘 이유 ${summary.stoppedBy}, ${summary.durationMs}ms`,
        );
      }
      return summary;
    } catch (err) {
      // 예상하지 못한 오류 — 로그 한 줄로 끝내지 않고 마지막 사이클·상태 화면에 남긴다(키 가림 거침).
      const message = maskOcrErrorText(err instanceof Error ? err.message : String(err), []);
      console.error(`${logPrefix} 사이클 오류로 멈춤: ${message}`);
      const summary = emptyDocumentOcrCycleSummary(startedAtMs);
      summary.stoppedBy = "error";
      summary.error = message;
      summary.durationMs = Date.now() - startedAtMs;
      lastCycle = summary;
      return summary;
    } finally {
      progress = null;
    }
  }

  /** 새 사이클을 시작한다. 이미 돌고 있으면 null(겹쳐 돌리지 않음). */
  function startCycle(cycleOpts: DocumentOcrCycleOptions): Promise<DocumentOcrCycleSummary> | null {
    if (current) return null;
    const controller = new AbortController();
    const promise = executeCycle(cycleOpts, controller.signal).finally(() => {
      if (current?.promise === promise) current = null;
    });
    current = { promise, controller };
    return promise;
  }

  /** 정기 사이클 — 수동 실행이나 옛 스케줄러의 사이클이 돌고 있으면 새로 시작하지 않고 그 결과를 기다린다. */
  async function scheduledCycle(cycleOpts?: DocumentOcrCycleOptions): Promise<DocumentOcrCycleSummary> {
    const started = startCycle(cycleOpts ?? {});
    if (started) return started;
    return (current as NonNullable<typeof current>).promise;
  }

  /** 지금 사이클을 끊고 끝나기를 기다린다(정지·재구성). */
  async function abortCurrentCycle(): Promise<void> {
    const running = current;
    if (!running) return;
    running.controller.abort();
    await running.promise;
  }

  async function stopScheduler(): Promise<void> {
    const handle = scheduler;
    scheduler = null;
    if (handle) await handle.stop();
  }

  async function applyConfiguration(): Promise<void> {
    const settings = currentSettings();
    const key = JSON.stringify(settings);
    if (key === appliedSettingsKey) return;
    await abortCurrentCycle();
    await stopScheduler();
    appliedSettingsKey = key;
    problem = startProblem(settings, opts.api, overrides);
    if (problem) {
      console.log(`${logPrefix} 서버 자동 처리: off (${problem.reason})`);
      return;
    }
    schedulerIntervalMin = settings.schedule.intervalMin;
    scheduler = startDocumentOcrScheduler({
      intervalMin: schedulerIntervalMin,
      runCycle: scheduledCycle,
      logPrefix: `${logPrefix} scheduler`,
      now: opts.now,
      setTimeoutFn: opts.setTimeoutFn,
      clearTimeoutFn: opts.clearTimeoutFn,
    });
    console.log(`${logPrefix} 서버 자동 처리: 가동 (mode=${settings.mode}, interval=${schedulerIntervalMin}분)`);
  }

  function isRunning(): boolean {
    return current !== null;
  }

  function queueStatus(): DocumentOcrServerStatus["queue"] {
    const { store } = opts.api;
    const ledgerQueue = ledger.queueSummary();
    const inProgress = ledgerQueue.inProgress
      .filter((entry) => store.findDocumentNodeId(entry.documentId) !== null)
      .map((entry) => ({ ...entry, title: store.getDocument(entry.documentId)?.title ?? entry.documentId }));
    if (progress) {
      const live = progress;
      const others = inProgress.filter((entry) => entry.documentId !== live.documentId);
      inProgress.splice(0, inProgress.length, { ...live }, ...others);
    }
    const reasons = new Map<string, number>();
    for (const doc of store.listDocumentsByParseStatuses(OCR_AUTOMATIC_PARSE_STATUSES, NOT_PROCESSABLE_SCAN_LIMIT)) {
      if (store.findDocumentNodeId(doc.documentId) === null) continue;
      const sha = readDocumentParseMetadata(doc.sourceMetadata)?.originalAssetSha256 ?? doc.assetSha256;
      const verdict = documentOcrEligibility({ mimeType: store.getAssetFile(sha)?.mimeType ?? "application/octet-stream" });
      if (!verdict.ok) reasons.set(verdict.reason, (reasons.get(verdict.reason) ?? 0) + 1);
    }
    return {
      waitingRetry: ledgerQueue.waitingRetry,
      terminal: ledgerQueue.terminal,
      inProgress,
      notServerProcessable: [...reasons].map(([reason, count]) => ({ reason, count })),
      // 후보 목록에서 빠진 기록 — 조용히 사라지지 않게 두 갈래로 따로 센다.
      ...notOwnedQueueCounts(store.countNotOwnedRecordsByParseStatuses(OCR_AUTOMATIC_PARSE_STATUSES)),
    };
  }

  return {
    currentSettings,

    reconfigure() {
      // 저장이 연달아 와도 차례대로 — 앞선 재구성이 끝난 뒤 다음 설정을 읽는다.
      reconfiguring = reconfiguring.then(applyConfiguration, applyConfiguration);
      return reconfiguring;
    },

    async tryRunOnce(documentId) {
      const settings = currentSettings();
      if (!isDocumentOcrServerMode(settings.mode)) {
        return { kind: "not_server_mode", reason: `documents.ocr.mode=${settings.mode} — 서버 OCR 실행 안 함` };
      }
      if (isRunning()) return { kind: "already_running" };
      if (ledger.dailyCalls(documentOcrDay()) >= settings.schedule.maxPagesPerDay) {
        return { kind: "daily_cap", maxPagesPerDay: settings.schedule.maxPagesPerDay };
      }
      if (documentId !== undefined) {
        const doc = opts.api.store.getDocument(documentId);
        if (!doc) return { kind: "not_found" };
        const placement = opts.api.store.getDocumentRecordPlacement(documentId);
        if (placement.kind === "absorbed" || placement.kind === "legacy_merged") return { kind: "not_own", placement };
        if (opts.api.store.findDocumentNodeId(documentId) === null) return { kind: "not_found" };
        const parse = readDocumentParseMetadata(doc.sourceMetadata);
        if (!parse || !(OCR_RESULT_APPLICABLE_PARSE_STATUSES as readonly string[]).includes(parse.status)) {
          return { kind: "not_candidate" };
        }
        // 원장을 건드리기 전에 서버가 읽을 수 있는 문서인지·다른 작업자가 잡고 있지 않은지 먼저 본다.
        const sha = parse.originalAssetSha256 ?? doc.assetSha256;
        const verdict = documentOcrEligibility({ mimeType: opts.api.store.getAssetFile(sha)?.mimeType ?? "application/octet-stream" });
        if (!verdict.ok) return { kind: "not_processable", reason: verdict.reason };
        if (isDocumentParseLeaseActive(parse, nowKst()) && parse.lease?.workerId !== SERVER_OCR_WORKER_ID) {
          return { kind: "leased", reason: `${parse.lease?.workerId} 가 ${parse.lease?.leaseUntil}까지 처리 중인 문서` };
        }
        // 사용자의 명시적 요청 — 실패한 쪽 기록(멈춤 포함)만 지운다. 성공한 쪽은 지문이 같으면 다시 부르지 않는다.
        ledger.clearFailures(documentId);
      }
      const run = startCycle(documentId !== undefined ? { documentId } : {});
      if (!run) return { kind: "already_running" };
      return { kind: "ran", summary: await run } satisfies DocumentOcrRunOnceResult;
    },

    status() {
      const settings = currentSettings();
      const day = documentOcrDay(nowKst());
      const pageCalls = ledger.dailyCalls(day);
      let state: DocumentOcrServerStatus["state"];
      let reason: string | null = null;
      if (isRunning()) state = "running";
      else if (problem) {
        state = problem.kind === "off" ? "off" : "config_error";
        reason = problem.reason;
      } else if (lastCycle?.stoppedBy === "config_error") {
        state = "config_error";
        reason = lastCycle.configError;
      } else if (lastCycle?.stoppedBy === "error") {
        state = "error";
        reason = lastCycle.error;
      } else if (pageCalls >= settings.schedule.maxPagesPerDay) state = "daily_cap_reached";
      else state = "idle";
      const nextRunAt = scheduler
        ? new Date(nextClockAlignedRunAt(opts.now?.() ?? Date.now(), schedulerIntervalMin, documentOcrOffsetMin(schedulerIntervalMin))).toISOString()
        : null;
      return {
        state,
        reason,
        mode: settings.mode,
        intervalMin: settings.schedule.intervalMin,
        nextRunAt,
        lastCycle,
        today: { day, pageCalls, maxPagesPerDay: settings.schedule.maxPagesPerDay },
        queue: queueStatus(),
      };
    },

    isRunning,

    async stop() {
      // 재구성의 실패는 그 호출부(구독 로그)가 이미 알렸다 — 종료는 끝나기만 기다린다.
      await reconfiguring.catch(() => undefined);
      await abortCurrentCycle();
      await stopScheduler();
      appliedSettingsKey = null;
      problem = { kind: "off", reason: "서버가 멈추는 중" };
    },
  };
}
