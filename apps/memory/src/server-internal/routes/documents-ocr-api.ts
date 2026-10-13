/**
 * routes/documents-ocr-api.ts — 파일 업로드 OCR API(http_file_api) 호출 한 번.
 *
 * routes/documents.ts 를 책임 경계로 분할하며 옮겨 온 모듈이다(P3 G5-a). 원본 문서 파일을 외부 OCR API 에
 * 올리고 Markdown 응답을 해석하는 통로만 담는다. 2026-10-11 문서 OCR spec D9 — 서버 자동 처리의 파일 업로드
 * 리더(document-ocr/page-reader.ts)가 이 함수를 감싸 쓰고, 옛 OpenAI 호환 vision 직접 호출 코드는 쪽 그림 리더로
 * 대체돼 지웠다. 결과를 문서에 적용하는 쪽은 documents-ocr-apply.ts.
 *
 * 실패 규칙: 2xx 가 아니면 상태 코드를 가진 HttpFileOcrError, 시간 초과면 timedOut=true — 서버 실행기가 상태
 * 코드로 일시/결정/설정을 가른다. 오류 문장의 응답 본문은 보낸 키를 가린 뒤 앞부분만 싣는다.
 */

import type { DocumentOcrSettings } from "../../settings/memory-settings.ts";
import { maskProviderText } from "../../llm/provider-http.ts";
import { parseRetryAfterMs } from "../../llm/errors.ts";

/** 파일 업로드 OCR API 전송 실패 — 상태 코드(응답이 없으면 null)·시간 초과·Retry-After 를 필드로 둔다. */
export class HttpFileOcrError extends Error {
  readonly status: number | null;
  readonly timedOut: boolean;
  readonly retryAfterMs: number | null;
  constructor(message: string, opts: { status: number | null; timedOut: boolean; retryAfterMs: number | null; cause?: unknown }) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "HttpFileOcrError";
    this.status = opts.status;
    this.timedOut = opts.timedOut;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** 파일 업로드 API 에 보낼 원본 문서. */
export interface HttpFileOcrInput {
  documentId: string;
  bytes: Uint8Array;
  mimeType: string;
  originalName: string;
}

function parseMarkdownFromApiResponse(
  raw: string,
  responseFormat: DocumentOcrSettings["api"]["responseFormat"],
): string {
  if (responseFormat === "markdown") return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OCR API JSON 응답을 해석할 수 없습니다");
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as { markdown?: unknown }).markdown === "string"
  ) {
    return (parsed as { markdown: string }).markdown;
  }
  throw new Error("OCR API JSON 응답에 markdown 문자열이 없습니다");
}

function isTimeoutAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/**
 * 파일 업로드 API 호출 한 번 → Markdown. 주소가 비면 칸 이름 오류. 성공 응답은 자르지 않고 전부 쓴다
 * (오류 문장에 싣는 본문만 앞부분으로 자른다).
 */
export async function callHttpFileOcrApi(
  settings: DocumentOcrSettings,
  input: HttpFileOcrInput,
  signal?: AbortSignal,
): Promise<string> {
  const endpoint = settings.api.endpointUrl.trim();
  if (!endpoint) throw new Error("documents.ocr.api.endpointUrl 이 비어 있습니다");
  const apiKey = settings.api.apiKey.trim();

  const form = new FormData();
  // Blob 은 ArrayBuffer 기반 보기만 받는다(브라우저 타입) — 사본으로 넘긴다.
  form.append("file", new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }), input.originalName);
  form.append("documentId", input.documentId);
  if (settings.api.model.trim()) form.append("model", settings.api.model.trim());

  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const timeoutSignal = AbortSignal.timeout(settings.schedule.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(endpoint, { method: "POST", headers, body: form, signal: combined });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = timeoutSignal.aborted || isTimeoutAbort(error);
    const reason = error instanceof Error ? error.message : String(error);
    throw new HttpFileOcrError(
      timedOut
        ? `OCR API timeout (${settings.schedule.timeoutMs}ms 초과)`
        : `OCR API 네트워크 실패: ${maskProviderText(reason, [apiKey])}`,
      { status: null, timedOut, retryAfterMs: null, cause: error },
    );
  }
  const text = await response.text();
  if (!response.ok) {
    throw new HttpFileOcrError(`OCR API HTTP ${response.status}: ${maskProviderText(text, [apiKey])}`, {
      status: response.status,
      timedOut: false,
      retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
    });
  }
  return parseMarkdownFromApiResponse(text, settings.api.responseFormat);
}
