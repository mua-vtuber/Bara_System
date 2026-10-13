/**
 * canonicalize/types.ts — Tier 1 변환 결과 + 검출 metadata 타입 (Phase 14 spec 단락 4.6).
 *
 * PDF 에는 tableCount 를 기록하지 않는다 (pdf.js 기반 추출에서 표 구조를 신뢰성 있게
 * 셀 수 없어 spec 4.6 신뢰도 규칙에 따라 약속하지 않음 — 기록 자체를 배제).
 * tableCount 는 docx 전용 (mammoth 의 XML 기반 <w:tbl> 검출이 신뢰 가능).
 */

/** spec 4.6 검출 metadata. kind 별 허용 칸:
 *  - passthrough: extractedCharCount 만
 *  - pdf: extractedCharCount + pageCount + scannedPdf + embeddedImageCount (tableCount 없음)
 *  - docx: extractedCharCount + tableCount + embeddedImageCount
 */
export interface Tier1Detection {
  kind: "passthrough" | "pdf" | "docx";
  extractedCharCount: number;
  pageCount?: number;
  scannedPdf?: boolean;
  embeddedImageCount?: number;
  /** docx 한정 (PDF 는 기록 안 함 — spec 4.6 신뢰도 규칙). */
  tableCount?: number;
}

/** canonicalize 결과. markdown=null = canonical .md 없음 (스캔 PDF 등 — 원본은 보존). */
export interface CanonicalizeResult {
  markdown: string | null;
  detection: Tier1Detection;
  warnings: string[];
}

/** canonicalize 함수 입력. */
export interface CanonicalizeInput {
  bytes: Uint8Array;
  mimeType?: string;
  originalName?: string;
}
