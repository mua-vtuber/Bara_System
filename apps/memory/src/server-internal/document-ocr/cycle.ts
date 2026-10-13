/**
 * document-ocr/cycle.ts — 서버 OCR 사이클 한 번 (2026-10-11 document-ocr-api-providers spec D13·D14·D16).
 *
 * 흐름: 하루 한도 확인 → 리더 만들기(설정 결함이면 config_error) → 후보 조회(휴지통·다른 작업자 임대·대상 아님·
 * 원장상 대기/terminal 거르기) → 문서마다 서버 전용 임대 → 쪽마다 [원장 판단 → 한도 확인 → 임대 연장 →
 * 하루 호출 수 +1(호출 직전, 실패도 셈) → 쪽 그림 → AI 읽기 → 원장 기록] → 모든 쪽 성공이면 이어 붙여 적용.
 *
 * 실패 3분류(정리 깊은 패스와 같음):
 *   - 일시: retryable(시도 수 그대로, next_retry_at = 지금 + max(Retry-After, 재시도 대기)), 문서 ocr_failed + 재시도 안내.
 *     연달아 circuitBreakerThreshold 번이면 사이클 중단.
 *   - 결정적: 시도 수 +1, 상한이면 terminal. 문서 ocr_failed + 사유(terminal 이면 멈춤 안내). 다음 문서로.
 *   - 설정: 원장·문서 상태를 건드리지 않고 사이클 즉시 중단(config_error + 사유).
 * 이미 성공한 쪽은 다시 부르지 않는다(지문이 같으면 원장 글 재사용) — 진행분은 다음 사이클이 이어 받는다.
 */

import { createHash } from "node:crypto";
import type { MemoryApiDeps } from "../types.ts";
import type { DocumentOcrCycleSummary } from "../../api-client-types.ts";
import { nowKst, pastCutoffInZone } from "../../db/store-internal/helpers.ts";
import {
  OCR_AUTOMATIC_PARSE_STATUSES,
  isDocumentParseLeaseActive,
  readDocumentParseMetadata,
} from "../../memory/document-parse-status.ts";
import { SERVER_OCR_WORKER_ID } from "../../settings/document-ocr-api-providers.ts";
import type { DocumentOcrSettings } from "../../settings/memory-settings.ts";
import { applyOcrMarkdownToDocument, recordDocumentOcrFailure } from "../routes/documents-ocr-apply.ts";
import {
  claimDocumentOcrLease,
  readOriginalAssetForDocument,
  releaseDocumentOcrLease,
  renewDocumentOcrLease,
  type DocumentRow,
} from "../routes/documents-ocr-shared.ts";
import { classifyOcrError, countsTowardCircuitBreaker } from "./error-classify.ts";
import { DocumentOcrLedger, pageDecision } from "./ledger.ts";
import type { DocumentPageImageSource } from "./page-images.ts";
import { DOCUMENT_OCR_PROMPT_VERSION, type DocumentOcrReader } from "./page-reader.ts";
import { DocumentOcrConfigError, OcrPageError, type OcrAsset, type OcrPageResult } from "./types.ts";

/** 쪽 글을 이을 때 넣는 구분. */
export const DOCUMENT_OCR_PAGE_SEPARATOR = "\n\n";
/** 임대 시간이 한 쪽 처리 한도보다 이만큼은 길어야 한다. */
export const DOCUMENT_OCR_LEASE_MARGIN_MS = 60_000;
/** 후보 조회 한도 = batchSize × 이 배수(기존 claim 의 500 을 넘지 않음). */
export const DOCUMENT_OCR_CANDIDATE_SCAN_FACTOR = 20;
export const DOCUMENT_OCR_CANDIDATE_SCAN_MAX = 500;

export interface DocumentOcrCycleDeps {
  /** 문서 적용·실패 기록이 쓰는 서버 의존(store·assetStore·eventBus 등). */
  api: MemoryApiDeps;
  ledger: DocumentOcrLedger;
  settings: DocumentOcrSettings;
  pageImages: DocumentPageImageSource;
  /** 지금 설정으로 리더를 만든다(설정 결함이면 DocumentOcrConfigError). */
  createReader: (settings: DocumentOcrSettings) => DocumentOcrReader;
  /** 처리 중 문서·쪽 진행 알림(상태 화면 running). */
  onProgress?: (progress: { documentId: string; title: string; completedPages: number; pageCount: number }) => void;
  logPrefix?: string;
  /**
   * 서버 정지·설정 재구성 때 진행 중 호출을 끊는 신호. 끊긴 쪽은 시도로 세지 않고(원장·문서 상태 안 씀) 임대를 푼다.
   * 이미 보낸 호출은 하루 호출 수에 남는다(공급자가 과금했을 수 있음).
   */
  signal?: AbortSignal;
}

export interface DocumentOcrCycleOptions {
  /** 이 문서 하나만 처리(수동 다시 읽기). */
  documentId?: string;
}

/** 설정 시간대 날짜(YYYY-MM-DD) — 하루 한도의 기준. */
export function documentOcrDay(now: string = nowKst()): string {
  return now.slice(0, 10);
}

/** 쪽 입력 지문 — 리더 정보(공급자·모델·한도·지시문 버전)·쪽 그림 크기·원본 자산·쪽 번호. */
export function documentOcrPageFingerprint(
  reader: DocumentOcrReader,
  settings: DocumentOcrSettings,
  originalAssetSha256: string,
  pageIndex: number,
): string {
  const payload = {
    reader: reader.fingerprintParts,
    // 파일 업로드 API 는 쪽 그림을 만들지 않으므로 그림 크기를 지문에 넣지 않는다(바꿔도 다시 부를 이유가 없음).
    maxEdgePx: reader.kind === "vision" ? settings.pageImage.maxEdgePx : null,
    originalAssetSha256,
    pageIndex,
    promptVersion: DOCUMENT_OCR_PROMPT_VERSION,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** 사이클 시작 조건(D14-4) — 임대가 한 쪽 처리 한도 + 여유보다 짧으면 설정 문제. 통과하면 null. */
export function leaseConfigProblem(settings: DocumentOcrSettings): string | null {
  if (settings.schedule.leaseSeconds * 1000 >= settings.schedule.timeoutMs + DOCUMENT_OCR_LEASE_MARGIN_MS) return null;
  return `documents.ocr.schedule.leaseSeconds(${settings.schedule.leaseSeconds}초) 가 한 쪽 처리 한도(documents.ocr.schedule.timeoutMs=${settings.schedule.timeoutMs}ms) + ${DOCUMENT_OCR_LEASE_MARGIN_MS / 1000}초보다 짧음`;
}

/** 0건 요약 — 사이클 시작 값이자 정지 뒤 tickNow 의 회신. */
export function emptyDocumentOcrCycleSummary(startedAtMs: number = Date.now()): DocumentOcrCycleSummary {
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: 0,
    documentsTouched: 0,
    documentsApplied: 0,
    documentsFailed: 0,
    pagesSucceeded: 0,
    pagesTransientFailed: 0,
    pagesDeterministicFailed: 0,
    pageCalls: 0,
    pagesBlank: 0,
    stoppedBy: "done",
    configError: null,
    error: null,
  };
}

/** 처리할 문서 하나. */
interface Candidate {
  doc: DocumentRow;
}

/** 원장에 대기·terminal 쪽이 있는지 — 있으면 이번 사이클에서 그 문서를 건너뛴다. */
function ledgerBlocks(
  ledger: DocumentOcrLedger,
  reader: DocumentOcrReader,
  settings: DocumentOcrSettings,
  doc: DocumentRow,
  originalSha: string,
  now: string,
): boolean {
  for (const row of ledger.rowsForDocument(doc.documentId)) {
    const decision = pageDecision(row, documentOcrPageFingerprint(reader, settings, originalSha, row.pageIndex), now);
    if (decision === "wait_retry" || decision === "terminal") return true;
  }
  return false;
}

/** 지금 서버가 처리할 수 있는 후보인지(휴지통·다른 작업자 임대·대상 아님·원장 대기/멈춤이면 아님). */
function isProcessableCandidate(d: DocumentOcrCycleDeps, reader: DocumentOcrReader, doc: DocumentRow, now: string): boolean {
  const { store } = d.api;
  const parse = readDocumentParseMetadata(doc.sourceMetadata);
  if (!parse || !(OCR_AUTOMATIC_PARSE_STATUSES as readonly string[]).includes(parse.status)) return false;
  // 휴지통·삭제. 다른 노드에 놓인 기록(같은 파일로 합쳐짐·옛 버전이 잘못 합침)은 후보 목록(listDocumentsByParseStatuses)이
  // 이미 빼고 상태 화면 queue 가 따로 센다. 한 문서만 다시 읽기는 실행기 관리자(runtime.tryRunOnce)가 먼저 거른다.
  if (store.findDocumentNodeId(doc.documentId) === null) return false;
  if (isDocumentParseLeaseActive(parse, now) && parse.lease?.workerId !== SERVER_OCR_WORKER_ID) return false;
  const originalSha = parse.originalAssetSha256 ?? doc.assetSha256;
  const mimeType = store.getAssetFile(originalSha)?.mimeType ?? "application/octet-stream";
  if (!d.pageImages.eligibility({ mimeType }).ok) return false;
  return !ledgerBlocks(d.ledger, reader, d.settings, doc, originalSha, now);
}

/**
 * 처리할 수 있는 후보를 오래된 순서로 하나씩 낸다. 대상이 아닌 문서·멈춘 문서가 앞쪽을 차지해도 새 문서가 굶지 않게,
 * 조회 창(batchSize × 배수, 최대 500)을 넘겨 가며 목록 끝까지 본다 — 필요한 만큼만 읽고 멈춘다(호출부가 그만 받으면 끝).
 */
function* candidates(d: DocumentOcrCycleDeps, reader: DocumentOcrReader, opts: DocumentOcrCycleOptions): Generator<Candidate> {
  const { store } = d.api;
  const now = nowKst();
  if (opts.documentId) {
    const doc = store.getDocument(opts.documentId);
    if (doc && isProcessableCandidate(d, reader, doc, now)) yield { doc };
    return;
  }
  const pageSize = Math.min(d.settings.schedule.batchSize * DOCUMENT_OCR_CANDIDATE_SCAN_FACTOR, DOCUMENT_OCR_CANDIDATE_SCAN_MAX);
  for (let offset = 0; ; offset += pageSize) {
    const rows = store.listDocumentsByParseStatuses(OCR_AUTOMATIC_PARSE_STATUSES, pageSize, "oldest", offset);
    for (const doc of rows) {
      if (isProcessableCandidate(d, reader, doc, now)) yield { doc };
    }
    if (rows.length < pageSize) return;
  }
}

/** 다음 재시도 시각 — 지금 + max(Retry-After, 재시도 대기). 설정 시간대 문자열. */
function retryAt(settings: DocumentOcrSettings, retryAfterMs: number | null): string {
  const delay = Math.max(retryAfterMs ?? 0, settings.reliability.retryDelayMinutes * 60_000);
  return pastCutoffInZone(Date.now() + delay);
}

type DocOutcome = "applied" | "failed" | "paused" | "abandoned";
type StopReason = DocumentOcrCycleSummary["stoppedBy"] | null;

/** 사이클 한 번. 설정 결함·한도·차단기는 요약 stoppedBy 로 알린다(던지지 않음). */
export async function runDocumentOcrCycle(
  d: DocumentOcrCycleDeps,
  opts: DocumentOcrCycleOptions = {},
): Promise<DocumentOcrCycleSummary> {
  const startedAtMs = Date.now();
  const summary = emptyDocumentOcrCycleSummary(startedAtMs);
  const logPrefix = d.logPrefix ?? "[document-ocr]";
  const finish = (stoppedBy: DocumentOcrCycleSummary["stoppedBy"], configError: string | null = null) => {
    summary.stoppedBy = stoppedBy;
    summary.configError = stoppedBy === "config_error" ? configError : null;
    summary.durationMs = Date.now() - startedAtMs;
    return summary;
  };

  d.ledger.pruneNonCandidateDocuments(OCR_AUTOMATIC_PARSE_STATUSES);
  const day = documentOcrDay();
  if (d.ledger.dailyCalls(day) >= d.settings.schedule.maxPagesPerDay) return finish("daily_cap");

  let reader: DocumentOcrReader;
  try {
    reader = d.createReader(d.settings);
  } catch (err) {
    if (err instanceof DocumentOcrConfigError) return finish("config_error", err.message);
    throw err;
  }
  const leaseProblem = leaseConfigProblem(d.settings);
  if (leaseProblem) return finish("config_error", leaseProblem);
  if (!d.api.assetStore) return finish("config_error", "assetStore 미설정 — OCR 에 보낼 원본 자산을 읽을 수 없음");

  if (d.signal?.aborted) return finish("aborted");

  let consecutiveFailures = 0;
  let stop: StopReason = null;
  let configError: string | null = null;
  let sawCandidate = false;

  try {
    // 처리하며 updated_at 이 바뀌어 같은 문서가 뒤쪽 창에 다시 나올 수 있다 — 한 사이클에 한 번만 다룬다.
    const seen = new Set<string>();
    for (const candidate of candidates(d, reader, opts)) {
      if (seen.has(candidate.doc.documentId)) continue;
      seen.add(candidate.doc.documentId);
      sawCandidate = true;
      if (summary.documentsTouched >= d.settings.schedule.batchSize) break;
      const result = await processDocument(candidate);
      if (result === "applied") summary.documentsApplied += 1;
      if (result === "failed") summary.documentsFailed += 1;
      if (stop) break;
    }
  } finally {
    await d.pageImages.dispose();
  }
  if (stop) return finish(stop, configError);
  if (!sawCandidate) return finish("no_candidates");
  return finish("done");

  async function processDocument({ doc }: Candidate): Promise<DocOutcome | null> {
    const { store } = d.api;
    let metadata = claimDocumentOcrLease(store, doc, SERVER_OCR_WORKER_ID, d.settings.schedule.leaseSeconds, nowKst(), {
      allowSameWorker: true,
    });
    if (!metadata) return null;
    summary.documentsTouched += 1;
    const release = () => { if (metadata) releaseDocumentOcrLease(store, doc.documentId, metadata); };
    const secrets: string[] = [];

    let asset: OcrAsset;
    let pageCount: number;
    try {
      asset = await readOriginalAssetForDocument(d.api, doc);
      pageCount = reader.kind === "file" ? 1 : await d.pageImages.pageCount(asset);
    } catch (err) {
      const failure = classifyOcrError(err, secrets);
      if (failure.klass === "config") {
        release();
        stop = "config_error";
        configError = failure.message;
        return null;
      }
      const originalSha = readDocumentParseMetadata(doc.sourceMetadata)?.originalAssetSha256 ?? doc.assetSha256;
      return recordPageFailure(doc, 0, 0, documentOcrPageFingerprint(reader, d.settings, originalSha, 0), failure);
    }

    const pages: string[] = [];
    let blankPages = 0;
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      if (d.signal?.aborted) {
        release();
        stop = "aborted";
        return null;
      }
      const fingerprint = documentOcrPageFingerprint(reader, d.settings, asset.sha256, pageIndex);
      const row = d.ledger.rowsForDocument(doc.documentId).find((r) => r.pageIndex === pageIndex) ?? null;
      const decision = pageDecision(row, fingerprint, nowKst());
      if (decision === "reuse_completed" && row) {
        if (row.status === "completed_blank") blankPages += 1;
        else if (row.markdown) pages.push(row.markdown);
        continue;
      }
      if (decision === "wait_retry" || decision === "terminal") {
        release();
        return "paused";
      }
      if (summary.pageCalls >= d.settings.schedule.maxPagesPerCycle) {
        release();
        stop = "page_cap";
        return "paused";
      }
      if (d.ledger.dailyCalls(day) >= d.settings.schedule.maxPagesPerDay) {
        release();
        stop = "daily_cap";
        return "paused";
      }
      const renewed = renewDocumentOcrLease(store, doc.documentId, metadata, SERVER_OCR_WORKER_ID, d.settings.schedule.leaseSeconds, nowKst());
      if (!renewed) {
        console.warn(`${logPrefix} ${doc.documentId} 임대 연장 실패 — 다른 작업이 문서를 바꿔 이 문서를 버림(적용 안 함)`);
        metadata = null;
        return "abandoned";
      }
      metadata = renewed;
      d.onProgress?.({ documentId: doc.documentId, title: doc.title, completedPages: pages.length, pageCount });

      let result: OcrPageResult;
      try {
        d.ledger.incrementDailyCalls(day);
        summary.pageCalls += 1;
        if (reader.kind === "file") {
          result = await reader.readDocument(doc.documentId, asset, d.signal);
        } else {
          const image = await d.pageImages.renderPage(asset, pageIndex, d.settings.pageImage.maxEdgePx);
          result = await reader.readPage(image, d.signal);
        }
      } catch (err) {
        if (d.signal?.aborted) {
          // 정지·재구성으로 끊음 — 쪽 탓이 아니라 시도로 세지 않고 문서 상태도 건드리지 않는다.
          release();
          stop = "aborted";
          return null;
        }
        const failure = err instanceof OcrPageError ? err : classifyOcrError(err, secrets);
        if (failure.klass === "config") {
          release();
          stop = "config_error";
          configError = failure.message;
          return null;
        }
        return recordPageFailure(doc, pageIndex, pageCount, fingerprint, failure);
      }
      d.ledger.recordCompleted(doc.documentId, pageIndex, pageCount, fingerprint, result.markdown, result.usage, result.blank);
      summary.pagesSucceeded += 1;
      consecutiveFailures = 0;
      if (result.blank) {
        // 빈 쪽 — 실패가 아니다(사용자 결정 H3). 글이 없으니 이어 붙일 것도 없다.
        blankPages += 1;
        summary.pagesBlank += 1;
      } else {
        pages.push(result.markdown);
      }
    }

    if (pages.length === 0) {
      // 모든 쪽이 빈 쪽 — 적용할 글이 없다. 0쪽을 멈춤으로 굳혀 다시 읽기 전까지 부르지 않는다(재과금 없음).
      const reason = `모든 쪽(${pageCount}쪽)이 빈 쪽이라 읽은 글이 없음 — 내용이 있는 문서라면 쪽 그림 크기·모델을 바꾸거나 [서버에서 다시 읽기]를 누르세요`;
      d.ledger.recordTerminal(doc.documentId, 0, pageCount, documentOcrPageFingerprint(reader, d.settings, asset.sha256, 0), reason);
      const recorded = recordDocumentOcrFailure(d.api, doc.documentId, {
        errorMessage: reason, source: "companion", providerName: reader.providerName, workerId: SERVER_OCR_WORKER_ID,
      });
      if (!recorded.ok) console.warn(`${logPrefix} ${doc.documentId} 실패 기록 못 함 (${recorded.status}): ${recorded.error}`);
      return "failed";
    }

    // 모든 쪽 성공 — 임대 주인 확인 뒤 이어 붙여 적용.
    const current = store.getDocument(doc.documentId);
    if (!current || JSON.stringify(current.sourceMetadata) !== JSON.stringify(metadata)) {
      console.warn(`${logPrefix} ${doc.documentId} 적용 직전 메타가 바뀜 — 적용하지 않음`);
      return "abandoned";
    }
    const applied = await applyOcrMarkdownToDocument(d.api, doc.documentId, {
      markdown: pages.join(DOCUMENT_OCR_PAGE_SEPARATOR),
      source: "companion",
      providerName: reader.providerName,
      workerId: SERVER_OCR_WORKER_ID,
      ...(blankPages > 0 ? { blankPageCount: blankPages } : {}),
    });
    if (!applied.ok) {
      console.warn(`${logPrefix} ${doc.documentId} 적용 실패 (${applied.status}): ${applied.error}`);
      release();
      return "failed";
    }
    d.ledger.clearDocument(doc.documentId);
    return "applied";
  }

  function recordPageFailure(
    doc: DocumentRow,
    pageIndex: number,
    pageCount: number,
    fingerprint: string,
    failure: OcrPageError,
  ): DocOutcome {
    const pageNo = pageIndex + 1;
    let message: string;
    if (failure.klass === "transient") {
      const next = retryAt(d.settings, failure.retryAfterMs);
      d.ledger.recordTransient(doc.documentId, pageIndex, pageCount, fingerprint, failure.message, next);
      summary.pagesTransientFailed += 1;
      message = `${pageNo}쪽 일시 실패 — ${next} 이후 자동 재시도: ${failure.message}`;
    } else {
      const max = d.settings.reliability.maxAttemptsPerPage;
      const recorded = d.ledger.recordDeterministic(
        doc.documentId, pageIndex, pageCount, fingerprint, failure.message, max, retryAt(d.settings, null),
      );
      summary.pagesDeterministicFailed += 1;
      message = `${pageNo}쪽: ${failure.message} (시도 ${recorded.attemptCount}/${max})`;
      if (recorded.status === "terminal_failure") {
        message += " 자동 재시도 멈춤 — 설정을 바꾸거나 [서버에서 다시 읽기]를 누르세요";
      }
    }
    // 연속 실패 차단기 — 일시 실패와 400(설정 탓일 수 있음)을 이어서 센다. 성공하면 0 으로.
    if (countsTowardCircuitBreaker(failure)) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= d.settings.reliability.circuitBreakerThreshold) stop = "circuit_breaker";
    }
    // 실패 기록이 임대도 지운다(buildOcrFailedParseMetadata).
    const recordedFailure = recordDocumentOcrFailure(d.api, doc.documentId, {
      errorMessage: message,
      source: "companion",
      providerName: reader.providerName,
      workerId: SERVER_OCR_WORKER_ID,
    });
    if (!recordedFailure.ok) {
      console.warn(`${logPrefix} ${doc.documentId} 실패 기록 못 함 (${recordedFailure.status}): ${recordedFailure.error}`);
    }
    return "failed";
  }
}
