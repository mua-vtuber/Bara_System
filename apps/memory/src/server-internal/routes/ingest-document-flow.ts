/**
 * routes/ingest-document-flow.ts — POST /ingest 문서(파일) 분기: 원본 자산 보존 +
 * canonical .md + documents 행 + 청크 + attribution.
 *
 * routes/ingest.ts 를 책임 경계로 분할하며 옮겨 온 모듈이다(P3 G5-a —
 * docs/decisions/2026-07-03-structure-cleanup-spec.md). 옛 파일 흐름 3)~11) 단계를
 * 그대로 담는다:
 *   3) 원본 sha 계산 (파일·행은 6 의 자산 묶음이 쓴다)
 *   4) canonicalize → markdown + detection + warnings (실패 = 파싱 실패 metadata 로 보존)
 *   5) canonical .md sha 계산 — 원본과 sha 가 다를 때만 변환본 파일을 묶음에 넣는다
 *   6) 자산 묶음(WP-B1-20U 설계 17.17 D29) — 쓰기 잠금 안 한 트랜잭션에서 asset_files 행(이미 있는 sha 는 그 행의
 *      확장자 — 한 sha 에 디스크 파일 하나) + documents 행(canonical sha / 스캔 PDF 면 orig sha) + 원장 행
 *      (asset_file_imports, 파일마다 source_ref `document:<id>`) + 파일 쓰기 (store.recordDocumentAssets)
 *   7) 청크 분해 (스캔 PDF = 빈 배열)
 *   8) ingestDocument — document 노드 1 + chunk 노드 N + parent_of 엣지. 6) 반환부터 8) 반환까지가 실패하면 6) 의
 *      기록을 되돌리고 그 결과를 500 문구에 붙인다(ingest-document-compensation.ts, 설계 17.18 설계 3 — 파싱 실패 갈래도)
 *   9) attribution (linkAuthorPerson) + 개념 mentions (autoLinkMentions)
 *  10) autoCleanupTrigger 신호 (POST /memories 선례 정합)
 *  11) 응답 { ok, assetSha256, documentId, nodeIds, cacheHit, warnings, detection, absorbedInto }
 *      absorbedInto = 같은 본문의 노드에 합쳐졌으면 그 노드 id(새 노드면 null) — 합쳐짐을 조용히 넘기지 않는다.
 * 분기 선택(이미지·텍스트 갈래 제외 후 도달)은 ingest.ts 파사드가 진다.
 */

import type { Context } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { err } from "../http-helpers.ts";
import { EVENT_TYPES } from "../event-bus.ts";
import { canonicalize } from "../../memory/canonicalize/dispatcher.ts";
import { chunkDocumentByPolicy } from "../../memory/document-chunk-policy.ts";
import { ingestDocument } from "../../memory/ingest-document.ts";
import { resolveProjectIdFromHashtagContent } from "../../memory/project-hashtag-resolver.ts";
import { linkAuthorPerson } from "../../memory/person-link.ts";
import { autoLinkMentions } from "../../memory/auto-mention.ts";
import {
  buildFailedParseMetadata,
  buildTier1ParseMetadata,
} from "../../memory/document-parse-status.ts";
import {
  detectDocumentType,
  isBinaryContent,
  type IngestParsedInput,
} from "./ingest-helpers.ts";
import { applyWriteGuard } from "../write-guard/write-guard.ts";
import { secretRejectionResponse } from "../write-guard/write-guard-http.ts";
import {
  hashtagListToContent,
  wireFileHashtagsToNodes,
} from "./ingest-file-tags.ts";
import { assetSha256 } from "../../assets/asset-store.ts";
import type { AssetBundleFile } from "../../db/store-internal/asset-repository.ts";
import { runDocumentRecordBlock } from "./ingest-document-compensation.ts";
import { buildDocumentPlaceholderContent } from "../../memory/document-placeholder-content.ts";

/** 변환본(canonical markdown) 파일의 확장자·mime. */
const CANONICAL_EXT = "md";
const CANONICAL_MIME = "text/markdown";

async function resolveDocumentProjectId(
  store: MemoryApiDeps["store"],
  explicitProjectId: string | null,
  rawContent: string | null,
  hashtags: string[],
): Promise<{ projectId: string | null; warnings: string[] }> {
  if (explicitProjectId !== null) {
    return { projectId: explicitProjectId, warnings: [] };
  }

  const tagContent = hashtagListToContent(hashtags);
  const hintContent = [tagContent, rawContent ?? ""]
    .filter((part) => part.trim().length > 0)
    .join("\n");
  if (hintContent.length === 0) {
    return { projectId: null, warnings: [] };
  }

  try {
    return await resolveProjectIdFromHashtagContent(store, hintContent);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      projectId: null,
      warnings: [`프로젝트 태그 해석 실패 — project_id 미반영 (${msg})`],
    };
  }
}

export async function handleDocumentIngest(
  c: Context,
  deps: MemoryApiDeps,
  store: MemoryApiDeps["store"],
  input: IngestParsedInput,
) {
  const {
    source,
    contentType,
    mimeType,
    originalName,
    author,
    userId,
    projectId: explicitProjectId,
    classification,
    hashtags,
    originalBytes,
    ext,
    assetStore,
    capture,
    sourceMessage,
  } = input;

  // ── 2.9) 저장 관문 — 글자 그대로 올라온 파일(.txt/.md)만 (T15 수정 1회차) ──
  // ingest.ts 는 `contentType === "text" && originalName === ""` 일 때만 관문이 걸린
  // handleTextIngest 로 보낸다. 파일 이름이 붙은 .txt/.md 는 여기로 오는데, 본문이
  // 사용자가 쓴 글자 그대로라 관문 없이 저장되면 그 자체가 우회 통로가 된다.
  // 관문은 **자산 기록(assetStore.write) 앞**이다 — 거부될 입력이 디스크에 파일로
  // 남으면 DB 를 막아도 값이 남는다.
  //
  // 이진 파일(PDF·docx 등)은 대상이 아니다. originalBytes 가 압축·이진 구조라 원문
  // 정규식이 의미를 갖지 못하고, 파싱 산출(canonicalize markdown)은 서버가 만든
  // 파생물이라 클라이언트 제출 글과 성격이 다르다.
  if (!isBinaryContent(mimeType, contentType)) {
    try {
      // 반환값(울타리 sanitize 산출)은 의도적으로 버린다 — 이 통로는 본문을 input.data 가
      // 아니라 originalBytes 에서 다시 만들어 쓰므로 치환이 downstream 으로 이어지지 않는다.
      // 원본 자산 바이트 보존(spec §3/D4)이 우선이라는 재정에 따른 것이고, 울타리 태그는
      // 조립 시점 2차 방어(context-assembler.ts sanitizeFenceBreakout)가 잡는다.
      // 여기서 쓰는 것은 예외(비밀값 거부)뿐이다. `input.data = applyWriteGuard(...)` 로
      // "고치면" 원본 파일이 서버에서 변조된다 — 하지 말 것.
      applyWriteGuard(input.data, deps.getSettings?.().writeGuard);
    } catch (e) {
      const rejected = secretRejectionResponse(c, e);
      if (rejected) {
        // Plain-text file guard runs before assetStore.write and DB inserts.
        rejected.headers.set("X-Ingest-Retryable", "true");
        return rejected;
      }
      throw e;
    }
  }

  // ── 3) 원본 sha (항상 보존 — 형식 무관) ───────────────────────────────
  // 파일·asset_files·원장 행은 기록(documents 행)과 함께 6) 자산 묶음 한 트랜잭션이 쓴다(설계 17.17 D29).
  const origFile: AssetBundleFile = {
    sha256: assetSha256(originalBytes),
    byteSize: originalBytes.byteLength,
    bytes: originalBytes,
    ext,
    assetType: contentType === "image" ? "image" : "text",
    mimeType: mimeType || undefined,
    originalName: originalName || undefined,
  };
  const orig = { sha256: origFile.sha256 };
  const ledger = { source, author, userId, originalName: originalName || undefined };

  // ── 4) canonicalize → markdown + detection + warnings ─────────────────
  // 실패 = 구체 에러 throw — 빈 결과로 둔갑 금지 (CLAUDE.md "실패 ≠ 빈 결과").
  let canon: Awaited<ReturnType<typeof canonicalize>>;
  try {
    canon = await canonicalize({
      bytes: originalBytes,
      mimeType: mimeType || undefined,
      originalName: originalName || undefined,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const parse = buildFailedParseMetadata({
      originalAssetSha256: orig.sha256,
      errorMessage: msg,
      warnings: ["문서 파싱 실패 — 원본은 보존됨."],
    });
    // 공백뿐인 이름은 이름이 없는 것으로 본다 — 대기 본문 첫 줄이 비지 않게(document-placeholder-content.ts).
    const title = originalName.trim() || "(파싱 실패 문서)";
    const documentType = detectDocumentType(null, classification);
    const project = await resolveDocumentProjectId(
      store,
      explicitProjectId,
      null,
      hashtags,
    );
    const recorded = await store.recordDocumentAssets({
      writer: assetStore,
      files: [origFile],
      document: {
        assetSha256: orig.sha256,
        title,
        documentType,
        sourceMetadata: {
          source,
          classification: classification ?? {},
          parse,
        },
      },
      ledger,
    });
    const documentId = recorded.documentId;

    // 설계 17.18 설계 3 — 기록 커밋 뒤 노드 저장이 실패하면 기록을 되돌리고 그 결과를 500 문구에 붙인다.
    const block = await runDocumentRecordBlock(store, documentId, () =>
      ingestDocument(store, {
        documentId,
        assetSha256: orig.sha256,
        title,
        // 본문 글자가 없다 — 파일 이름 + 상태 문구 + 원본 sha 대기 본문(이름만 같은 다른 파일과 안 합쳐지게).
        rawContent: buildDocumentPlaceholderContent("parse_failed", title, orig.sha256),
        documentType,
        chunks: [],
        author,
        platform: source,
        projectId: project.projectId,
        documentMetadata: {
          user_id: userId,
          source,
          ...(hashtags.length > 0 ? { tags: hashtags } : {}),
          ...(capture ? { capture } : {}),
        },
        sourceMessage,
      }),
    );
    if (!block.ok) return err(c, 500, block.message);
    const ingestResult = block.value;

    await linkAuthorPerson(store, {
      nodeId: ingestResult.documentNodeId,
      author,
      metadata: { user_id: userId, source },
    });
    await wireFileHashtagsToNodes(
      store,
      ingestResult.nodeIds,
      hashtags,
      deps.autoCleanupTrigger,
      "POST /ingest document",
    );
    deps.autoCleanupTrigger?.emit("external-sdk-write");
    deps.eventBus?.emit(EVENT_TYPES.GRAPH_CHANGED, { reason: "ingested" });

    return c.json(
      {
        ok: true,
        assetSha256: orig.sha256,
        documentId,
        nodeIds: ingestResult.nodeIds,
        cacheHit: recorded.files[0]!.cacheHit,
        warnings: [...parse.warnings, ...project.warnings],
        detection: null,
        parse,
        pendingChunks: 0,
        absorbedInto: ingestResult.documentAbsorbed ? ingestResult.documentNodeId : null,
      },
      201,
    );
  }

  // ── 5) canonical .md sha (markdown 있고 + sha 가 원본과 다를 때만 파일) ────
  // 스캔 PDF 등 markdown=null 이면 원본 sha 를 그대로 canonical 로 쓴다(원본 보존).
  // sha 만 먼저 계산해 원본과 같은지 비교 — passthrough(텍스트·Markdown)는 canonical 바이트가 원본과 동일해
  // sha 도 같다. 같으면 변환본 파일을 쓰지 않는다 — 원본 sha 의 `.md` 사본이 기록 없이 따로 생기지 않는다(설계
  // 17.17 D29, 한 sha 에 디스크 파일 하나). PDF·docx 처럼 변환으로 내용이 달라지면 변환본 파일을 묶음에 넣는다.
  let canonicalSha = orig.sha256;
  const bundleFiles: AssetBundleFile[] = [origFile];
  if (canon.markdown !== null) {
    const canonicalBytes = new TextEncoder().encode(canon.markdown);
    canonicalSha = assetSha256(canonicalBytes);
    if (canonicalSha !== orig.sha256) {
      bundleFiles.push({
        sha256: canonicalSha,
        byteSize: canonicalBytes.byteLength,
        bytes: canonicalBytes,
        ext: CANONICAL_EXT,
        assetType: "text",
        mimeType: CANONICAL_MIME,
        originalName: originalName || undefined,
      });
    }
  }

  // ── 6) 자산 묶음 — documents 행 + asset_files·원장 행 + 파일 ─────────────
  // canonical .md 없으면 원본 sha 가리킴 (정직 / 스캔 PDF 보존 정신).
  // 제목 결정: originalName 우선 → canonical markdown 첫 줄 앞 50글자 → fallback.
  const firstLine = canon.markdown?.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  // 공백뿐인 이름은 이름이 없는 것으로 본다 — 대기 본문 첫 줄이 비지 않게(document-placeholder-content.ts).
  const title =
    originalName.trim() || firstLine.slice(0, 50) || "(제목 없음)";
  const documentType = detectDocumentType(canon.markdown, classification);
  const parse = buildTier1ParseMetadata({
    detection: canon.detection,
    warnings: canon.warnings,
    originalAssetSha256: orig.sha256,
    canonicalAssetSha256: canon.markdown !== null ? canonicalSha : orig.sha256,
    hasMarkdown: canon.markdown !== null,
  });
  const recorded = await store.recordDocumentAssets({
    writer: assetStore,
    files: bundleFiles,
    document: {
      assetSha256: canon.markdown !== null ? canonicalSha : orig.sha256,
      title,
      documentType,
      sourceMetadata: {
        tier1: canon.detection,
        source,
        classification: classification ?? {},
        parse,
      },
    },
    ledger,
  });
  const documentId = recorded.documentId;

  // 7)~8) 은 한 보상 블록이다(설계 17.18 설계 3) — 기록 커밋 뒤 어디서 실패하든 기록을 되돌리고 결과를 500 문구에 붙인다.
  const block = await runDocumentRecordBlock(store, documentId, async () => {
    // ── 7) 청크 분해 (스캔 PDF = 빈 배열 → document 노드만) ──────────────
    const settings = deps.getSettings?.();
    const chunks =
      canon.markdown !== null
        ? chunkDocumentByPolicy(
            {
              markdown: canon.markdown,
              detection: canon.detection,
              mimeType,
              originalName,
              source: "document",
            },
            {
              tokenCap: settings?.chunking?.tokenCap,
              minChunkTokens: settings?.chunking?.minChunkTokens,
            },
          )
        : [];

    const project = await resolveDocumentProjectId(
      store,
      explicitProjectId,
      canon.markdown,
      hashtags,
    );

    // ── 8) ingestDocument — document 노드 + chunk 노드 + parent_of 엣지 ──
    const ingested = await ingestDocument(store, {
      documentId,
      assetSha256: canon.markdown !== null ? canonicalSha : orig.sha256,
      title,
      // document 노드 content = 원문(canonical markdown) 전체 — 안 잘림.
      // 스캔 PDF 등 markdown=null 이면 본문 텍스트가 없다 — 파일 이름 + "글자 인식 대기" + 원본 sha 대기 본문을 쓴다.
      // 파일 이름만 쓰면 이름만 같은 다른 스캔본·같은 글의 기억과 합쳐진다. 이름이 첫 줄이라 글자 색인(FTS)과 그래프
      // 이름표·본문 첫 줄 제목에는 대기 중에도 파일 이름이 잡힌다. POST /search 응답은 글자 인식이 안 끝난 문서를
      // 일부러 뺀다(search-enrich.ts filterOcrIncompleteResults) — 그 설계는 그대로다.
      rawContent: canon.markdown ?? buildDocumentPlaceholderContent("ocr_pending", title, orig.sha256),
      documentType,
      chunks,
      author,
      platform: source,
      projectId: project.projectId,
      documentMetadata: {
        user_id: userId,
        source,
        ...(hashtags.length > 0 ? { tags: hashtags } : {}),
        ...(capture ? { capture } : {}),
      },
      // WP-B1-20U 설계 17.8 — 외부 메시지의 첨부면 문서 노드가 그 메시지의 출처 행(첨부 키)을 받는다.
      sourceMessage,
    });
    return { project, ingestResult: ingested };
  });
  if (!block.ok) return err(c, 500, block.message);
  const { project, ingestResult } = block.value;

  // ── 9) attribution + 개념 mentions (POST /memories 정합) ──────────────
  await linkAuthorPerson(store, {
    nodeId: ingestResult.documentNodeId,
    author,
    metadata: { user_id: userId, source },
  });
  await wireFileHashtagsToNodes(
    store,
    ingestResult.nodeIds,
    hashtags,
    deps.autoCleanupTrigger,
    "POST /ingest document",
  );
  if (canon.markdown) {
    await autoLinkMentions(store, {
      id: ingestResult.documentNodeId,
      content: canon.markdown,
    });
  }

  // ── 10) autoCleanupTrigger 신호 ────────────────────────────────────────
  // deps.autoCleanupTrigger 는 동적 lookup (구조분해 금지)
  deps.autoCleanupTrigger?.emit("external-sdk-write");
  // 그래프 라이브 연출 2a — 문서 입력이 진짜 저장된 끝에서 graph_changed 발행.
  // eventBus 미주입이면 no-op. 저장 성공 경로에서만(에러 응답은 여기 못 온다).
  deps.eventBus?.emit(EVENT_TYPES.GRAPH_CHANGED, { reason: "ingested" });

  // ── 11) 응답 ──────────────────────────────────────────────────────────
  return c.json(
    {
      ok: true,
      assetSha256: orig.sha256,
      documentId,
      nodeIds: ingestResult.nodeIds,
      cacheHit: recorded.files[0]!.cacheHit,
      warnings: [...canon.warnings, ...project.warnings],
      detection: canon.detection,
      parse,
      // 문서(PDF·docx·.txt/.md 파일)의 청크는 source_type='document_chunk' 라 Task 5
      // backfill 추출 대상이다 — 텍스트 갈래(type="text")의 pendingChunks 와 칸 이름을
      // 정합시켜 대시보드가 "추출 대기 N개"를 같은 규칙으로 표시하게 한다(spec §5 일관성).
      // 스캔 PDF 등 청크 0 이면 0 — describeExtractionStatus 가 0 을 줄로 만들지 않는다.
      pendingChunks: ingestResult.chunkNodeIds.length,
      absorbedInto: ingestResult.documentAbsorbed ? ingestResult.documentNodeId : null,
    },
    201,
  );
}
