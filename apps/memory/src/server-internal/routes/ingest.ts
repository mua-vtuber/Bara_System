/**
 * server-internal/routes/ingest.ts — POST /ingest (Phase 14a T12).
 *
 * 자산(텍스트·Markdown·docx·PDF)을 받아 원본 보존 + canonical .md 저장 + documents 등록
 * + 청크 분해 + 노드 저장 + attribution + 정직한 경고를 한 흐름으로 잇는다.
 *
 * POST /memories 구조를 거울처럼 따른다 — localhost-신뢰(토큰 검사 0 / server.ts 주석
 * "인증·권한은 모듈 코어 밖"). 어댑터 등록·events·토큰은 Phase 7 권위라 여기 없다.
 *
 * deps.assetStore 는 호출 시점 lookup (구조분해 금지 — 부팅 시점 고정 방지).
 * assetStore 미주입이면 503 (정직한 비활성 — silent no-op 아님).
 *
 * P3 G5-a 분할(docs/decisions/2026-07-03-structure-cleanup-spec.md) — 옛 892줄
 * 단일 파일을 책임 경계로 나눴다. 이 파일은 입력 파싱·검증(1~2단계)과 분기 선택만
 * 남은 파사드다(export registerIngestRoutes·originalExt 이름 그대로 — originalExt 는
 * ingest-helpers.ts 로 옮기고 재노출). 세 분기의 흐름은:
 *   · 이미지 mime (2.5단계) → ingest-image-flow.ts (ingestImage·SigLIP·VLM 캡션)
 *   · 순수 타이핑 글 (2.6단계) → ingest-text-flow.ts (saveTextInput·종류/글-칸·일정 날짜)
 *   · 문서 파일 (3~11단계) → ingest-document-flow.ts (자산 보존·canonical·documents·청크)
 * 공용 타입·판별 헬퍼는 ingest-helpers.ts. 동작 불변(코드 이동만).
 *
 * body.hashtags 는 document 노드 metadata.tags 로 저장해 유실을 막는다 — 개념 노드
 * 승격은 후속 wave 14.9 범위라 여기선 보존까지만 한다. body.options(skipExtractor 등)는
 * LLM 보강 항목이라 Phase 7 로 연기 — 지금 동작 없음(받기만 하고 처리 안 함).
 *
 * body.sourceMessage(WP-B1-20U 설계 17.8) — 이 입력을 보낸 외부 메시지. 모양을 검사해 틀리면 400(어느 칸인지
 * 문구에), 맞으면 세 갈래 모두에 넘긴다: 문서 노드·이미지 노드는 그 메시지의 출처 행(첨부면 첨부 키)을, 글 갈래는
 * 저장 metadata 표시로 메시지 출처(첨부 id 없음)를 받는다. 메시지 삭제가 그 행으로 노드를 찾는다.
 */

import type { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { err } from "../http-helpers.ts";
import { isImageMime } from "../../memory/canonicalize/dispatcher.ts";
import { normalizeProjectId } from "../../memory/project-scope.ts";
import {
  isBinaryContent,
  originalExt,
  parseSourceMessage,
  type IngestParsedInput,
  type IngestRequestBody,
} from "./ingest-helpers.ts";
import { handleImageIngest } from "./ingest-image-flow.ts";
import { handleTextIngest } from "./ingest-text-flow.ts";
import { handleDocumentIngest } from "./ingest-document-flow.ts";
import { IngestReceipts, INGEST_REQUEST_ID } from "./ingest-receipts.ts";
import { MCP_ADAPTER_ID_VAR } from "../auth-gate.ts";
import { parseCapture } from "./capture.ts";
import { withMemoryWriteActivity } from "../../memory/shared-memory-mutation-lock.ts";

// 외부 import 표면 보존 — originalExt 는 옛 ingest.ts export 였다(ingest.test.ts 참조).
export { originalExt } from "./ingest-helpers.ts";

function positiveIntegerOption(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function parseAttachToNodeId(options: unknown): number | null {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return null;
  }
  const record = options as Record<string, unknown>;
  return (
    positiveIntegerOption(record.attachToNodeId) ??
    positiveIntegerOption(record.parentNodeId)
  );
}

// ── 라우트 등록기 ─────────────────────────────────────────────────────────────

/**
 * POST /ingest 를 app 에 등록한다.
 * deps 객체 자체를 받는다 (assetStore / getSettings / autoCleanupTrigger 는
 * 동적 lookup — 구조분해 금지).
 */
export function registerIngestRoutes(app: Hono, deps: MemoryApiDeps): void {
  const { store } = deps;
  const receipts = new IngestReceipts();

  app.get("/ingest/status/:requestId", (c) => {
    c.header("Cache-Control", "no-store");
    const requestId = c.req.param("requestId");
    if (!INGEST_REQUEST_ID.test(requestId)) return err(c, 400, "invalid requestId");
    const receipt = receipts.get(c.get(MCP_ADAPTER_ID_VAR), requestId);
    return receipt?.state === "saved"
      ? c.json({ state: "saved", result: receipt.result })
      : c.json({ state: receipt?.state ?? "unknown" });
  });

  app.post("/ingest", (c) => withMemoryWriteActivity(store, async () => {
    // This flag is cleared before any ingest branch can produce side effects.
    c.header("X-Ingest-Retryable", "true");
    c.header("Cache-Control", "no-store");
    // ── 1) 입력 파싱 ───────────────────────────────────────────────────────
    let body: IngestRequestBody;
    try {
      body = await c.req.json<IngestRequestBody>();
    } catch {
      return err(c, 400, "invalid JSON body");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return err(c, 400, "invalid JSON body");
    if (body.requestId !== undefined && (typeof body.requestId !== "string" || !INGEST_REQUEST_ID.test(body.requestId))) {
      return err(c, 400, "invalid requestId");
    }
    let capture;
    try { capture = parseCapture(body.capture); }
    catch { return err(c, 400, "capture must contain a valid kind and source"); }
    const sourceMessage = parseSourceMessage(body.sourceMessage);
    if (!sourceMessage.ok) return err(c, 400, sourceMessage.error);

    // assetStore 미주입 = 비활성(정직한 503 — silent no-op 금지)
    if (!deps.assetStore) {
      return err(c, 503, "asset store not configured (BARA_ASSET_DIR / settings.assets.dir 미설정)");
    }

    const content = body.content;
    if (
      !content ||
      typeof content.data !== "string" ||
      content.data.length === 0
    ) {
      return err(c, 400, "content.data must be a non-empty string");
    }

    const source = typeof body.source === "string" && body.source.length > 0
      ? body.source
      : "unknown";
    const contentType =
      typeof content.type === "string" ? content.type : "auto";
    const rawMimeType =
      typeof content.mimeType === "string" ? content.mimeType : "";
    // content.type === "text" 이고 mimeType 이 없으면 text/markdown 으로 확정한다.
    // 클라이언트가 type:"text" 만 보내는 경우(mimeType 생략)는 텍스트 passthrough 의도이므로
    // 명시적 "text/markdown" 을 effective mimeType 으로 채워 canonicalize dispatcher 분기에
    // 진입할 수 있게 한다. type:"auto" 는 기존 감지 흐름(mimeType/originalName 기반) 그대로.
    const mimeType =
      contentType === "text" && rawMimeType === "" ? "text/markdown" : rawMimeType;
    const originalName =
      typeof content.originalName === "string" ? content.originalName : "";
    const author =
      typeof body.attribution?.author === "string" ? body.attribution.author : "";
    const userId =
      typeof body.attribution?.userId === "string" ? body.attribution.userId : "";
    const projectId = normalizeProjectId(body.projectId ?? body.project);
    const classification =
      body.classification &&
      typeof body.classification === "object" &&
      !Array.isArray(body.classification)
        ? (body.classification as Record<string, string>)
        : undefined;
    // hashtags — 문자열 배열만 추려 document metadata.tags 로 보존(유실 차단).
    // 개념 노드 승격은 후속 wave 14.9 범위라 여기선 저장까지만.
    const hashtags = Array.isArray(body.hashtags)
      ? body.hashtags.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      : [];
    const attachToNodeId = parseAttachToNodeId(body.options);

    // ── 2) 원본 bytes 준비 ─────────────────────────────────────────────────
    // 텍스트 = UTF-8 인코딩 / binary(PDF·docx·image) = base64 디코드.
    const binary = isBinaryContent(mimeType, contentType);
    let originalBytes: Uint8Array;
    try {
      originalBytes = binary
        ? Uint8Array.from(Buffer.from(content.data, "base64"))
        : new TextEncoder().encode(content.data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(c, 400, `base64 디코드 실패: ${msg}`);
    }
    const ext = originalExt(mimeType, originalName);

    // 세 분기 공용 파싱 결과 묶음 — assetStore 는 위 503 가드를 통과한 요청 시점
    // lookup 값(부팅 시점 고정 아님).
    const input: IngestParsedInput = {
      body,
      data: content.data,
      source,
      contentType,
      mimeType,
      originalName,
      author,
      userId,
      projectId,
      classification,
      capture,
      hashtags,
      originalBytes,
      ext,
      assetStore: deps.assetStore,
      attachToNodeId,
      sourceMessage: sourceMessage.value,
    };

    const claim = typeof body.requestId === "string"
      ? receipts.begin(c.get(MCP_ADAPTER_ID_VAR), body.requestId, body)
      : undefined;
    if (claim?.kind === "full") return err(c, 503, "처리 중인 입력이 많습니다. 잠시 뒤 다시 전송하세요.");
    c.header("X-Ingest-Retryable", undefined);
    if (claim?.kind === "conflict") return err(c, 409, "requestId was already used with different input");
    if (claim?.kind === "existing") {
      const response = claim.receipt.response;
      return response ? new Response(response.body, { status: response.status, headers: response.headers })
        : c.json({ error: "결과 확인 필요", state: claim.receipt.state }, 409);
    }

    const dispatch = async () => {
      // ── 2.5) 이미지 mime 분기 (Phase 11a T5) — ingest-image-flow.ts ────────
      if (isImageMime(mimeType)) return handleImageIngest(c, deps, store, input);

      // ── 2.6) 순수 타이핑 글 분기 (입력 통로 통합 spec §3 D1·D4) ────────────
      // content.type === "text" 이고 originalName 이 없을 때만 "사용자가 직접 친 글"이다.
      // 이 글의 원본은 노드 content 자체이므로 자산 파일(asset_files)·documents 행을 만들지
      // 않고(고아 메타 회피 / spec §3 P1), saveTextInput 으로 원본 한 노드 + 길이 조건부
      // 청크를 저장한다 — ingest-text-flow.ts.
      //
      // originalName 이 있는 .txt/.md 는 "텍스트 파일"이다 — content.type 은 "text"(UTF-8
      // passthrough)이지만 사용자가 파일을 올린 보관 의도가 명확하므로 spec §3/D4("파일은
      // 길이 무관하게 원본 자산까지 보존")에 따라 아래 자산 보존·documents 흐름을 탄다.
      // PDF·docx(type="auto" + binary)와 같은 파일 취급이되, 텍스트라 canonicalize 가
      // passthrough 로 원문을 그대로 markdown 으로 회신한다. 대시보드 buildTextFilePayload /
      // 봇 attachment-ingest 가 .txt/.md 에 originalName 을 채워 보내는 것이 이 구분의 신호다.
      if (contentType === "text" && originalName === "") return handleTextIngest(c, deps, store, input);

      // ── 3~11) 문서(파일) 분기 — ingest-document-flow.ts ────────────────────
      return handleDocumentIngest(c, deps, store, input);
    };
    try {
      const response = await dispatch();
      if (claim?.kind === "started") {
        if (!response.ok && response.headers.get("X-Ingest-Retryable") === "true")
          receipts.release(c.get(MCP_ADAPTER_ID_VAR), body.requestId as string, claim.receipt);
        else await receipts.finish(claim.receipt, response);
      }
      return response;
    } catch (error) {
      if (claim?.kind === "started") await receipts.finish(claim.receipt);
      throw error;
    }
  }));
}
