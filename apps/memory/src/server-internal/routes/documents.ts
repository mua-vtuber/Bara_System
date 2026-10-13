/**
 * routes/documents.ts — 문서 처리 상태 + OCR 결과 적용 API.
 *
 * A1 코어는 OCR 모델을 실행하지 않는다. 대신 스캔/파싱 실패 문서를 표시하고,
 * 외부 OCR·PC companion·수동 작업이 만든 Markdown 을 같은 document_id 에 적용한다.
 *
 * P3 G5-a 분할(docs/decisions/2026-07-03-structure-cleanup-spec.md) — 옛 806줄
 * 단일 파일을 책임 경계로 나눴다. 이 파일은 라우트 등록 파사드로 남고(export
 * registerDocumentRoutes 이름 그대로), 공용 타입·파싱·판정·DTO 는
 * documents-ocr-shared.ts, 서버 직접 OCR API 호출은 documents-ocr-api.ts,
 * 결과 적용·실패 기록은 documents-ocr-apply.ts 가 진다. 동작 불변(코드 이동만).
 */

import type { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { err } from "../http-helpers.ts";
import { applyWriteGuard } from "../write-guard/write-guard.ts";
import { secretRejectionResponse } from "../write-guard/write-guard-http.ts";
import { nowKst } from "../../db/store-internal/helpers.ts";
import {
  isDocumentParseLeaseActive,
  readDocumentParseMetadata,
} from "../../memory/document-parse-status.ts";
import {
  MAX_LEASE_SECONDS,
  MIN_LEASE_SECONDS,
  claimDocumentOcrLease,
  documentCandidateDto,
  documentOcrSettings,
  normalizeWorkerId,
  parseClaimStatuses,
  parseLeaseSeconds,
  parseLimit,
  parseStatusFilter,
  sanitizeOcrRuntimeConfig,
  type OcrClaimBody,
  type OcrFailureBody,
  type OcrResultBody,
} from "./documents-ocr-shared.ts";
import { DocumentOcrRuntimeMissingError } from "./documents-ocr-shared.ts";
import { SERVER_OCR_WORKER_ID } from "../../settings/document-ocr-api-providers.ts";
import {
  applyOcrMarkdownToDocument,
  recordDocumentOcrFailure,
} from "./documents-ocr-apply.ts";
import { notOwnedRecordNotice, notOwnedRecordOcrRefusal } from "./document-record-messages.ts";

/** 수동 다시 읽기가 아무 쪽도 읽지 않았을 때의 사유. */
function nothingRanReason(stoppedBy: string): string {
  switch (stoppedBy) {
    case "no_candidates":
      return "지금 서버에서 읽을 수 없는 문서입니다(다른 작업이 잡고 있거나 다시 시도 대기 중)";
    case "page_cap":
      return "한 번에 읽을 최대 쪽 수(documents.ocr.schedule.maxPagesPerCycle)에 닿아 읽지 않았습니다";
    case "daily_cap":
      return "오늘 서버 OCR 한도(documents.ocr.schedule.maxPagesPerDay)에 닿아 읽지 않았습니다";
    case "aborted":
      return "서버 정지·설정 변경으로 읽기를 멈췄습니다";
    default:
      return `읽은 쪽이 없습니다 (멈춘 이유: ${stoppedBy})`;
  }
}

export function registerDocumentRoutes(app: Hono, deps: MemoryApiDeps): void {
  const { store } = deps;

  app.get("/api/documents/:documentId/status", (c) => {
    const documentId = c.req.param("documentId");
    const doc = store.getDocument(documentId);
    if (!doc) return err(c, 404, "문서를 찾을 수 없습니다");
    const placement = store.getDocumentRecordPlacement(documentId);
    if (placement.kind === "legacy_merged") {
      // 옛 버전이 이름만 같은 다른 파일·같은 글의 기억에 잘못 합쳐 둔 기록 — 삭제·휴지통도, 같은 파일도 아니다.
      // 자기 노드가 없어 노드·추출 진행 칸을 두지 않는다(남의 숫자를 보이지 않음). 다시 올리면 따로 저장된다고 알린다.
      return c.json({
        ok: true,
        document: {
          ...documentCandidateDto(deps, doc),
          leaseActive: false,
          legacyMerged: {
            nodeId: placement.ownerNodeId,
            documentId: placement.ownerDocumentId,
            inTrash: placement.ownerInTrash,
            notice: notOwnedRecordNotice(placement),
          },
        },
      });
    }
    if (placement.kind === "absorbed") {
      // 같은 파일·같은 내용으로 다른 노드에 합쳐진 기록 — 삭제·휴지통이 아니다. 주인 문서의 실제 상태를 알린다.
      // 추출 진행은 주인이 문서 노드일 때 그 문서의 숫자를 보이고, 문서 노드가 아니면 칸을 두지 않는다(가짜 0 금지).
      const document = documentCandidateDto(deps, doc);
      const extraction = placement.ownerDocumentId !== null
        ? store.getDocumentExtractionProgress(placement.ownerDocumentId)
        : undefined;
      return c.json({
        ok: true,
        document: {
          ...document,
          nodeId: placement.ownerNodeId,
          ...(extraction ? { extraction } : {}),
          leaseActive: false,
          absorbedInto: {
            nodeId: placement.ownerNodeId,
            documentId: placement.ownerDocumentId,
            inTrash: placement.ownerInTrash,
            notice: notOwnedRecordNotice(placement),
          },
        },
      });
    }
    const nodeId = store.findDocumentNodeId(documentId);
    if (nodeId === null) return c.json({ error: "문서가 삭제되었거나 휴지통으로 이동했습니다" }, 410);
    // 완료 판정의 단일 출처는 extraction-state-sql.ts(claimAwaitsExtractionSql) —
    // 백필 후보 판정(getBackfillCandidates)과 같은 조각을 쓴다(WP-B1-24).
    // documents.has_extracted 는 청크 추출 스케줄러가 관리하지 않아 쓰지 않는다.
    const extraction = store.getDocumentExtractionProgress(documentId);
    const document = documentCandidateDto(deps, doc);
    const leaseActive = document.parse ? isDocumentParseLeaseActive(document.parse, nowKst()) : false;
    return c.json({ ok: true, document: { ...document, nodeId, extraction, leaseActive } });
  });

  app.get("/api/documents/ocr-runtime-config", (c) => {
    if (!deps.documentOcrRuntime) return err(c, 503, new DocumentOcrRuntimeMissingError().message);
    return c.json({
      ok: true,
      config: sanitizeOcrRuntimeConfig(documentOcrSettings(deps)),
    });
  });

  app.get("/api/documents/ocr-candidates", (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const statuses = parseStatusFilter(c.req.query("status"));
    const docs = store.listDocumentsByParseStatuses(statuses, limit);
    return c.json({
      ok: true,
      candidates: docs.map((doc) => documentCandidateDto(deps, doc)),
    });
  });

  app.post("/api/documents/ocr-jobs/claim", async (c) => {
    let body: OcrClaimBody;
    try {
      body = (await c.req.json()) as OcrClaimBody;
    } catch {
      return err(c, 400, "JSON body 필요");
    }

    const workerId = normalizeWorkerId(body.workerId);
    if (!workerId) return err(c, 400, "workerId 는 비어 있지 않은 문자열이어야 합니다");
    if (workerId === SERVER_OCR_WORKER_ID) {
      return err(c, 400, `workerId=${SERVER_OCR_WORKER_ID} 는 서버 OCR 전용으로 예약된 ID 입니다 — 다른 ID 를 쓰세요`);
    }

    const leaseSeconds = parseLeaseSeconds(body.leaseSeconds);
    if (leaseSeconds === null) {
      return err(
        c,
        400,
        `leaseSeconds 는 ${MIN_LEASE_SECONDS}~${MAX_LEASE_SECONDS} 사이 정수여야 합니다`,
      );
    }

    const statuses = parseClaimStatuses(body.statuses);
    const now = nowKst();
    const candidates = store.listDocumentsByParseStatuses(statuses, 500, "oldest");

    for (const candidate of candidates) {
      if (!claimDocumentOcrLease(store, candidate, workerId, leaseSeconds, now)) continue;

      const claimedDoc = store.getDocument(candidate.documentId);
      if (!claimedDoc) continue;
      return c.json({
        ok: true,
        job: documentCandidateDto(deps, claimedDoc),
      });
    }

    return c.json({ ok: true, job: null });
  });

  app.post("/api/documents/:documentId/ocr-result", async (c) => {
    const documentId = c.req.param("documentId");
    let body: OcrResultBody;
    try {
      body = (await c.req.json()) as OcrResultBody;
    } catch {
      return err(c, 400, "JSON body 필요");
    }

    if (typeof body.markdown !== "string" || body.markdown.trim().length === 0) {
      return err(c, 400, "markdown 은 비어 있지 않은 문자열이어야 합니다");
    }

    // T15 수정 1회차 — 이 markdown 은 **클라이언트가 보낸 값**이다(PC 컴패니언 등
    // 외부 OCR 워커). applyOcrMarkdownToDocument 안에서 문서 노드 본문 덮어쓰기
    // (editNodeContent)·청크 노드 생성(addNode)·canonical .md 디스크 기록
    // (store.recordOcrCanonicalAsset) 세 곳으로 흘러가므로, 그 앞에서 관문을 태워야 한다. 스캔한
    // 서류에 키가 찍혀 있으면 OCR 이 그것을 글자로 만들어 그대로 저장하게 된다.
    // 정책(D-C 확정): 문서·OCR 통로도 다른 사용자 글과 동일하게 기본 거부이며,
    // 정당한 문서는 settings 토글로 통과시킨다(경고 후 저장 같은 예외 갈래 없음).
    let guardedMarkdown: string;
    try {
      guardedMarkdown = applyWriteGuard(body.markdown, deps.getSettings?.().writeGuard);
    } catch (e) {
      const rejected = secretRejectionResponse(c, e);
      if (rejected) return rejected;
      throw e;
    }

    const applied = await applyOcrMarkdownToDocument(deps, documentId, {
      markdown: guardedMarkdown,
      source: body.source,
      providerName: body.providerName,
      workerId: body.workerId,
    });
    if (!applied.ok) return err(c, applied.status, applied.error);
    return c.json(applied);
  });

  // 서버 OCR 수동 1회(문서 카드 "서버에서 다시 읽기" 포함) — 실행기 관리자가 작업 임대·원장·한도를 거쳐 돌린다.
  app.post("/api/documents/ocr-jobs/run-server-once", async (c) => {
    const runtime = deps.documentOcrRuntime;
    if (!runtime) return err(c, 503, new DocumentOcrRuntimeMissingError().message);
    const requestedDocumentId = c.req.query("documentId")?.trim() || undefined;
    const result = await runtime.tryRunOnce(requestedDocumentId);
    switch (result.kind) {
      case "not_server_mode":
        return c.json({ ok: true, ran: false, reason: result.reason });
      case "already_running":
        return err(c, 409, "서버 OCR 사이클이 이미 진행 중");
      case "daily_cap":
        return err(c, 409, `오늘 서버 OCR 한도(documents.ocr.schedule.maxPagesPerDay=${result.maxPagesPerDay}) 도달`);
      case "not_found":
        return err(c, 404, "문서를 찾을 수 없습니다");
      case "not_candidate":
        return err(c, 409, "서버 OCR 처리 대상 상태가 아닙니다");
      case "not_own":
        return err(c, 409, notOwnedRecordOcrRefusal(result.placement));
      case "not_processable":
      case "leased":
        return err(c, 409, result.reason);
    }
    const summary = result.summary;
    // 사이클이 실패로 멈췄을 때 사람이 읽을 사유(설정 문제·예상하지 못한 오류).
    const stopError = summary.stoppedBy === "config_error" ? summary.configError : summary.stoppedBy === "error" ? summary.error : null;
    if (!requestedDocumentId) {
      if (stopError !== null) {
        return c.json({ ok: false, ran: true, error: stopError, summary }, 502);
      }
      return c.json({ ok: true, ran: summary.pageCalls > 0 || summary.documentsApplied > 0, summary });
    }
    const doc = store.getDocument(requestedDocumentId);
    const parse = doc ? readDocumentParseMetadata(doc.sourceMetadata) : null;
    if (stopError !== null) {
      return c.json({ ok: false, ran: true, documentId: requestedDocumentId, error: stopError, parse, summary }, 502);
    }
    if (parse?.status === "ocr_succeeded") {
      return c.json({ ok: true, ran: true, documentId: requestedDocumentId, parse, chunkCount: doc?.chunkCount ?? 0, summary });
    }
    if (parse?.status === "ocr_failed" && summary.documentsFailed > 0) {
      return c.json({ ok: false, ran: true, documentId: requestedDocumentId, error: parse.errorMessage ?? "OCR 실패", parse, summary }, 502);
    }
    if (summary.pageCalls === 0) {
      // 아무 쪽도 읽지 않았다 — 왜 아무것도 안 했는지 알린다(진행분이 있는 것처럼 보이지 않게).
      return c.json(
        { ok: false, ran: false, documentId: requestedDocumentId, error: nothingRanReason(summary.stoppedBy), parse, summary },
        409,
      );
    }
    // 쪽 한도·하루 한도에 닿아 진행분만 남긴 경우 — 다음 사이클이 이어서 처리한다.
    return c.json({ ok: true, ran: true, documentId: requestedDocumentId, parse, summary });
  });

  app.get("/api/documents/ocr-jobs/server-status", (c) => {
    const runtime = deps.documentOcrRuntime;
    if (!runtime) return err(c, 503, new DocumentOcrRuntimeMissingError().message);
    return c.json({ ok: true, status: runtime.status() });
  });

  app.post("/api/documents/:documentId/ocr-failure", async (c) => {
    const documentId = c.req.param("documentId");
    let body: OcrFailureBody;
    try {
      body = (await c.req.json()) as OcrFailureBody;
    } catch {
      return err(c, 400, "JSON body 필요");
    }

    if (typeof body.errorMessage !== "string" || body.errorMessage.trim().length === 0) {
      return err(c, 400, "errorMessage 는 비어 있지 않은 문자열이어야 합니다");
    }

    const failed = recordDocumentOcrFailure(deps, documentId, body);
    if (!failed.ok) return err(c, failed.status, failed.error);
    return c.json({
      ok: true,
      documentId,
      parse: failed.parse,
    });
  });
}
