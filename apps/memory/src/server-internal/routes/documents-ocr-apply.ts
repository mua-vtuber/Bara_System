/**
 * routes/documents-ocr-apply.ts — OCR 결과 Markdown 적용 + OCR 실패 기록.
 *
 * routes/documents.ts 를 책임 경계로 분할하며 옮겨 온 모듈이다(P3 G5-a —
 * docs/decisions/2026-07-03-structure-cleanup-spec.md). 외부 OCR·PC companion·수동
 * 작업이 만든 Markdown 을 같은 document_id 에 적용하는 흐름(자산 저장 → 문서 노드
 * 갱신 → 옛 청크 삭제 → 새 청크 저장 → parse metadata 갱신)과, 실패를 parse
 * metadata 에 기록하는 흐름을 담는다. 라우트 등록은 documents.ts 파사드.
 *
 * 자산 저장은 /ingest 와 같은 자산 묶음이다(WP-B1-20U 설계 17.18 설계 4) — 변환본 파일을 따로 쓰지 않고
 * store.recordOcrCanonicalAsset 이 쓰기 잠금 안에서 asset_files 행(이미 있는 sha 는 그 행의 확장자)·그 기록의
 * 원장 행(`document:<id>`)·파일을 한 번에 쓴다. 그래서 변환본은 쓰는 순간부터 기록에 묶여 다른 삭제가 지우지
 * 못하고, 기록이 지워질 때 함께 지워진다.
 */

import type { MemoryApiDeps } from "../types.ts";
import { EVENT_TYPES } from "../event-bus.ts";
import { documentChunkMetadata } from "../../memory/document-chunk-metadata.ts";
import { chunkDocumentByPolicy } from "../../memory/document-chunk-policy.ts";
import { autoLinkMentions } from "../../memory/auto-mention.ts";
import { assetSha256 } from "../../assets/asset-store.ts";
import { nowKst } from "../../db/store-internal/helpers.ts";
import { notOwnedRecordOcrRefusal } from "./document-record-messages.ts";
import {
  OCR_RESULT_APPLICABLE_PARSE_STATUSES,
  buildOcrFailedParseMetadata,
  buildOcrSucceededParseMetadata,
  readDocumentParseMetadata,
  type DocumentParseStatus,
} from "../../memory/document-parse-status.ts";
import {
  isLeaseWorkerAllowed,
  isOcrCandidateStatus,
  normalizeOcrSource,
  normalizeProviderName,
  normalizeWorkerId,
  type OcrFailureBody,
} from "./documents-ocr-shared.ts";

export interface ApplyOcrMarkdownArgs {
  markdown: string;
  source?: unknown;
  providerName?: unknown;
  workerId?: unknown;
  /** 서버 OCR 이 빈 쪽으로 읽은 쪽 수(서버 실행기만 넘긴다). */
  blankPageCount?: number;
}

export type ApplyOcrMarkdownResult =
  | {
      ok: true;
      documentId: string;
      assetSha256: string;
      parse: ReturnType<typeof buildOcrSucceededParseMetadata>;
      chunkCount: number;
      nodeIds: number[];
    }
  | { ok: false; status: 400 | 404 | 409 | 503; error: string };

type ApplyOcrErrorStatus = 400 | 404 | 409 | 503;
export type RecordOcrFailureResult =
  | {
      ok: true;
      parse: ReturnType<typeof buildOcrFailedParseMetadata>;
    }
  | { ok: false; status: 404 | 409; error: string };

const REAPPLY_ALLOWED_STATUS: DocumentParseStatus = "ocr_succeeded";

/** OCR 변환본(canonical markdown) 파일의 확장자·mime. 그 sha 의 행이 이미 있으면 행의 확장자가 우선한다. */
const OCR_CANONICAL_EXT = "md";
const OCR_CANONICAL_MIME = "text/markdown";
/** 문서 노드 수정 이력의 editor 이자 변환본 원장 행의 source·author. */
const OCR_ACTOR = "document-ocr";

function applyOcrError(
  status: ApplyOcrErrorStatus,
  error: string,
): ApplyOcrMarkdownResult {
  return { ok: false, status, error };
}

function updateDocumentNodeAssetMetadata(
  deps: MemoryApiDeps,
  nodeId: number,
  assetSha256: string,
): void {
  const db = deps.store.getRawDb();
  const row = db
    .query("SELECT metadata_json FROM knowledge_nodes WHERE id = ?")
    .get(nodeId) as { metadata_json: string } | null;
  if (!row) return;
  const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
  metadata.assetSha256 = assetSha256;
  db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?").run(
    JSON.stringify(metadata),
    nodeId,
  );
}

export function recordDocumentOcrFailure(
  deps: MemoryApiDeps,
  documentId: string,
  body: OcrFailureBody,
): RecordOcrFailureResult {
  const doc = deps.store.getDocument(documentId);
  if (!doc) return { ok: false, status: 404, error: "문서 없음 — documentId 확인" };

  const currentParse = readDocumentParseMetadata(doc.sourceMetadata);
  if (!currentParse || !isOcrCandidateStatus(currentParse.status)) {
    return { ok: false, status: 409, error: "OCR 실패 기록 대상 상태가 아닙니다" };
  }

  const workerId = normalizeWorkerId(body.workerId);
  const now = nowKst();
  if (!isLeaseWorkerAllowed(currentParse, now, workerId)) {
    return { ok: false, status: 409, error: "다른 OCR worker 가 처리 중인 문서입니다" };
  }

  const nextParse = buildOcrFailedParseMetadata({
    original: currentParse,
    errorMessage: String(body.errorMessage).trim(),
    source: normalizeOcrSource(body.source),
    providerName: normalizeProviderName(body.providerName),
    updatedAt: now,
  });
  const updated = deps.store.updateDocumentSourceMetadata({
    documentId,
    sourceMetadata: {
      ...doc.sourceMetadata,
      parse: nextParse,
    },
  });
  if (!updated) return { ok: false, status: 404, error: "문서 없음 — documentId 확인" };
  return { ok: true, parse: nextParse };
}

export async function applyOcrMarkdownToDocument(
  deps: MemoryApiDeps,
  documentId: string,
  args: ApplyOcrMarkdownArgs,
): Promise<ApplyOcrMarkdownResult> {
  const { store } = deps;
  if (!deps.assetStore) {
    return applyOcrError(
      503,
      "assetStore 미설정 — OCR 결과 Markdown 자산을 저장할 수 없음",
    );
  }

  const doc = store.getDocument(documentId);
  if (!doc) return applyOcrError(404, "문서 없음 — documentId 확인");

  const currentParse = readDocumentParseMetadata(doc.sourceMetadata);
  if (!currentParse) {
    return applyOcrError(409, "문서 parse metadata 없음 — OCR 적용 대상이 아님");
  }

  const workerId = normalizeWorkerId(args.workerId);
  const now = nowKst();
  if (!isLeaseWorkerAllowed(currentParse, now, workerId)) {
    return applyOcrError(409, "다른 OCR worker 가 처리 중인 문서입니다");
  }

  const isCandidate = (
    OCR_RESULT_APPLICABLE_PARSE_STATUSES as readonly DocumentParseStatus[]
  ).includes(currentParse.status);
  const isSafeReapply = currentParse.status === REAPPLY_ALLOWED_STATUS;
  if (!isCandidate && !isSafeReapply) {
    return applyOcrError(409, `OCR 적용 불가 상태: ${currentParse.status}`);
  }
  if ((doc.hasExtracted !== 0 || doc.hasSummary !== 0) && isSafeReapply) {
    return applyOcrError(409, "이미 추출/요약 산출물이 있어 OCR 재적용을 중단합니다");
  }
  if (doc.hasExtracted !== 0 || doc.hasSummary !== 0) {
    return applyOcrError(409, "이미 추출/요약 산출물이 있어 OCR 적용을 중단합니다");
  }

  const placement = store.getDocumentRecordPlacement(documentId);
  if (placement.kind === "absorbed" || placement.kind === "legacy_merged") {
    return applyOcrError(409, notOwnedRecordOcrRefusal(placement));
  }
  const documentNodeId = store.findDocumentNodeId(documentId);
  if (documentNodeId === null) {
    return applyOcrError(409, "문서 노드 없음 — document metadata 정합 확인 필요");
  }

  const documentNode = await store.getNode(documentNodeId);
  if (!documentNode) {
    return applyOcrError(409, "문서 노드 없음 — knowledge_nodes 정합 확인 필요");
  }

  // 원장 행의 사용자는 문서 노드가 저장될 때 받은 user_id 다. 없으면 정할 수 없어 멈춘다 — 다른 값으로 채우지 않는다.
  const userId = documentNode.metadata.user_id;
  if (typeof userId !== "string" || userId.length === 0) {
    return applyOcrError(
      409,
      "문서 노드 metadata 에 user_id 없음 — OCR 변환본 원장 행의 사용자를 정할 수 없음 (document metadata 정합 확인 필요)",
    );
  }

  const markdown = args.markdown;
  const canonicalBytes = new TextEncoder().encode(markdown);
  const canonicalSha256 = assetSha256(canonicalBytes);
  const canonicalName = `${doc.title}.ocr.md`;
  const canonical = await store.recordOcrCanonicalAsset({
    writer: deps.assetStore,
    documentId,
    file: {
      sha256: canonicalSha256,
      byteSize: canonicalBytes.byteLength,
      bytes: canonicalBytes,
      ext: OCR_CANONICAL_EXT,
      assetType: "text",
      mimeType: OCR_CANONICAL_MIME,
      originalName: canonicalName,
    },
    ledger: { source: OCR_ACTOR, author: OCR_ACTOR, userId, originalName: canonicalName },
  });
  // 기록이 라우트의 첫 확인과 묶음 쓰기 사이에 지워졌다 — 아무것도 쓰지 않았다.
  if (canonical === null) return applyOcrError(404, "문서 없음 — documentId 확인");

  const settings = deps.getSettings?.();
  const chunks = chunkDocumentByPolicy(
    {
      markdown,
      source: "ocr",
      mimeType: OCR_CANONICAL_MIME,
      originalName: canonicalName,
    },
    {
      tokenCap: settings?.chunking?.tokenCap,
      minChunkTokens: settings?.chunking?.minChunkTokens,
    },
  );

  const edit = await store.editNodeContent({
    nodeId: documentNodeId,
    content: markdown,
    reason: "OCR 결과 적용",
    editor: OCR_ACTOR,
    editSource: normalizeOcrSource(args.source),
  });
  if (!edit) {
    return applyOcrError(409, "문서 노드 갱신 실패 — node id 확인 필요");
  }
  updateDocumentNodeAssetMetadata(deps, documentNodeId, canonicalSha256);
  await autoLinkMentions(store, { id: documentNodeId, content: markdown });

  const oldChunkIds = store.listDocumentChunkNodeIds(documentId);
  for (const chunkId of oldChunkIds) {
    await store.deleteNode(chunkId);
  }

  // OCR 청크는 문서 노드의 파생이다(WP-B1-20T) — 청크 → 문서 parent_of 계보 엣지는 저장소
  // 흡수 규칙이 청크 INSERT 와 같은 트랜잭션에서 쓴다.
  const chunkNodeIds: number[] = [];
  for (const chunk of chunks) {
    const chunkNodeId = await store.addNode({
      content: chunk.text,
      sourceType: "document_chunk",
      author: documentNode.author,
      platform: documentNode.platform,
      project_id: documentNode.projectId,
      metadata: {
        parentId: documentId,
        chunkIndex: chunk.index,
        assetSha256: canonicalSha256,
        documentType: doc.documentType,
        ...documentChunkMetadata(chunk),
      },
      provenance: { kind: "derived", parentId: documentNodeId, relation: "parent_of", edgeProvenance: "system" },
    });
    chunkNodeIds.push(chunkNodeId);
  }

  const nextParse = buildOcrSucceededParseMetadata({
    original: currentParse,
    canonicalAssetSha256: canonicalSha256,
    chunkCount: chunkNodeIds.length,
    source: normalizeOcrSource(args.source),
    providerName: normalizeProviderName(args.providerName),
    updatedAt: now,
    ...(args.blankPageCount ? { blankPageCount: args.blankPageCount } : {}),
  });
  const updated = store.updateDocumentAfterOcr({
    documentId,
    assetSha256: canonicalSha256,
    chunkCount: chunkNodeIds.length,
    sourceMetadata: {
      ...doc.sourceMetadata,
      parse: nextParse,
    },
  });
  if (!updated) return applyOcrError(404, "문서 없음 — documentId 확인");

  deps.autoCleanupTrigger?.emit("external-sdk-write");
  deps.eventBus?.emit(EVENT_TYPES.GRAPH_CHANGED, { reason: "document-ocr-applied" });

  return {
    ok: true,
    documentId,
    assetSha256: canonicalSha256,
    parse: nextParse,
    chunkCount: chunkNodeIds.length,
    nodeIds: [documentNodeId, ...chunkNodeIds],
  };
}
