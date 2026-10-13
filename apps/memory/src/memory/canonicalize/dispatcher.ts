/**
 * canonicalize/dispatcher.ts — 입력 형식 감지 후 적절한 변환기로 분기 (Phase 14 spec 단락 4).
 *
 * 분기 우선순위: mimeType 먼저, 없거나 알 수 없으면 originalName 확장자.
 *
 * - 텍스트·Markdown: bytes 를 UTF-8 디코딩해 그대로 통과 (passthrough, 변환 없음).
 * - PDF: pdf-tier1 로 위임 (unpdf 텍스트 레이어 추출).
 * - docx: docx-tier1 로 위임 (mammoth Markdown 변환).
 * - 그 외: 구체 에러 throw — silent passthrough 금지(CLAUDE.md: 실패는 명확히 드러낸다).
 *
 * pdfTier1 / docxTier1 을 주입 인자로 받으므로 테스트에서 가짜 변환기를 넣어
 * 분기 경로만 검증할 수 있다. 운영 경로는 default 인자가 실 변환기를 가리킨다.
 *
 * HTML·JSON 은 코어 1급 입력이 아니다(D-2026-05-27-2 — 대시보드·어댑터 몫):
 * 여기까지 오면 "지원하지 않는 형식" 에러를 낸다.
 */
import type { CanonicalizeInput, CanonicalizeResult } from "./types.ts";
import { pdfTier1 as realPdfTier1 } from "./pdf-tier1.ts";
import { docxTier1 as realDocxTier1 } from "./docx-tier1.ts";
import { SUPPORTED_IMAGE_MIMES } from "../image-mime.ts";

// ---- mime 상수 ----

const MIME_TEXT_PLAIN = "text/plain";
const MIME_TEXT_MARKDOWN = "text/markdown";
const MIME_PDF = "application/pdf";
const MIME_DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * 이미지 mime 갈래 분별 — POST /ingest 라우트가 image 갈래를 별 통로 (ingestImage)
 * 로 보내기 전 검사. mime 이 빈 문자열이면 false (호출자가 originalName 확장자로
 * 보완하거나 14a 의 기존 텍스트 분기로 fallback).
 *
 * 묶음은 image-mime.ts 의 SUPPORTED_IMAGE_MIMES 한 곳을 import 해서 쓴다 (Phase
 * 11d D6 — 단일 권위, 옛 dispatcher 별도 Set 정의 제거). 이미지는 텍스트 추출이
 * 없어 본 dispatcher 의 canonical .md 흐름에 합류하지 않는다 — 라우트가 isImageMime
 * 으로 분별해 ingestImage 별 통로로 보낸다.
 */
export function isImageMime(mime: string): boolean {
  return SUPPORTED_IMAGE_MIMES.has(mime);
}

// ---- 주입 가능 의존 타입 ----

export interface CanonicalizeDeps {
  pdfTier1?: (input: CanonicalizeInput) => Promise<CanonicalizeResult>;
  docxTier1?: (input: CanonicalizeInput) => Promise<CanonicalizeResult>;
}

// ---- 내부 유틸 ----

/** originalName 에서 소문자 확장자(".pdf" 형태)를 뽑아 낸다. */
function extOf(name: string | undefined): string {
  if (!name) return "";
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx).toLowerCase();
}

// ---- 공개 함수 ----

/**
 * 입력 형식을 감지해 적절한 Tier 1 변환기로 분기하고 CanonicalizeResult 를 반환한다.
 *
 * @param input  bytes + 선택적 mimeType / originalName
 * @param deps   선택적 주입 변환기 (테스트에서 가짜 변환기를 넣어 분기 검증 가능)
 * @throws       지원하지 않는 형식이면 mime/ext 를 명시한 구체 에러
 */
export async function canonicalize(
  input: CanonicalizeInput,
  deps: CanonicalizeDeps = {},
): Promise<CanonicalizeResult> {
  const mime = input.mimeType ?? "";
  const ext = extOf(input.originalName);

  // 1. mimeType 기준 분기 (mime 이 있으면 ext 를 무시한다)
  if (mime === MIME_TEXT_PLAIN || mime === MIME_TEXT_MARKDOWN) {
    return passthroughFromBytes(input.bytes);
  }
  if (mime === MIME_PDF) {
    return (deps.pdfTier1 ?? realPdfTier1)(input);
  }
  if (mime === MIME_DOCX) {
    return (deps.docxTier1 ?? realDocxTier1)(input);
  }
  // 이미지 mime 은 본 dispatcher 의 canonical .md 흐름에 합류하지 않는다 (Phase 11a T5).
  // POST /ingest 라우트가 isImageMime 으로 먼저 분기해 ingestImage 별 통로로 보낸다 —
  // 여기까지 도달했다는 것은 라우트 분기 누락 신호라 명시 throw (silent passthrough 금지).
  if (SUPPORTED_IMAGE_MIMES.has(mime)) {
    throw new Error(
      `canonicalize: 이미지 mime '${mime}' 은 canonical 흐름 밖 — ingestImage 별 통로 사용 (Phase 11a T5).`,
    );
  }

  // 2. mime 이 없거나 알 수 없을 때 확장자 기반 분기
  if (mime === "") {
    if (ext === ".md" || ext === ".txt") {
      return passthroughFromBytes(input.bytes);
    }
    if (ext === ".pdf") {
      return (deps.pdfTier1 ?? realPdfTier1)(input);
    }
    if (ext === ".docx") {
      return (deps.docxTier1 ?? realDocxTier1)(input);
    }
  }

  // 3. 지원하지 않는 형식 — 식별자를 명시한 구체 에러 (silent passthrough 금지)
  const detail = mime
    ? `mime='${mime}'${ext ? ` ext='${ext}'` : ""}`
    : `ext='${ext || "(없음)"}'`;
  throw new Error(
    `지원하지 않는 입력 형식: ${detail} — 코어 1급 입력은 텍스트·마크다운·PDF·docx. ` +
      "HTML·JSON 은 어댑터·대시보드 몫(D-2026-05-27-2).",
  );
}

// ---- 내부 함수 ----

/** bytes 를 UTF-8 텍스트로 디코딩해 passthrough 결과를 만든다. */
function passthroughFromBytes(bytes: Uint8Array): CanonicalizeResult {
  const markdown = new TextDecoder().decode(bytes);
  return {
    markdown,
    detection: { kind: "passthrough", extractedCharCount: markdown.length },
    warnings: [],
  };
}
