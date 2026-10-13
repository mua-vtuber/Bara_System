/**
 * document-parse-status.ts — 문서 파싱/OCR 상태 metadata 표준형.
 *
 * DB 스키마를 늘리지 않고 documents.source_metadata.parse 한 칸에 저장한다.
 * A1 코어는 OCR 모델을 직접 실행하지 않고, 어떤 문서가 외부 OCR 결과를 기다리는지와
 * 결과가 붙었는지를 정직하게 표시한다.
 */

import type { Tier1Detection } from "./canonicalize/types.ts";

export type DocumentParseStatus =
  | "text_succeeded"
  | "needs_ocr"
  | "password_required"
  | "parse_failed"
  | "ocr_succeeded"
  | "ocr_failed";

export interface DocumentParseLease {
  workerId: string;
  claimedAt: string;
  leaseUntil: string;
}

export interface DocumentParseMetadata {
  status: DocumentParseStatus;
  method: "tier1" | "ocr";
  originalAssetSha256: string;
  canonicalAssetSha256?: string;
  extractedCharCount?: number;
  pageCount?: number;
  /** 서버 OCR 이 빈 쪽(정상 종료·글 없음)으로 읽은 쪽 수. 0 이거나 모르면 없음. */
  blankPageCount?: number;
  warnings: string[];
  errorMessage?: string;
  source?: "manual" | "companion";
  providerName?: string;
  lease?: DocumentParseLease;
  updatedAt?: string;
}

export const OCR_CANDIDATE_PARSE_STATUSES: readonly DocumentParseStatus[] = [
  "needs_ocr",
  "password_required",
  "parse_failed",
  "ocr_failed",
] as const;

export const OCR_AUTOMATIC_PARSE_STATUSES: readonly DocumentParseStatus[] = [
  "needs_ocr",
  "parse_failed",
  "ocr_failed",
] as const;

export const OCR_RESULT_APPLICABLE_PARSE_STATUSES: readonly DocumentParseStatus[] = [
  "needs_ocr",
  "parse_failed",
  "ocr_failed",
] as const;

export const OCR_INCOMPLETE_PARSE_STATUSES: readonly DocumentParseStatus[] = [
  "needs_ocr",
  "password_required",
  "parse_failed",
  "ocr_failed",
] as const;

export function isDocumentParseStatus(value: unknown): value is DocumentParseStatus {
  return (
    value === "text_succeeded" ||
    value === "needs_ocr" ||
    value === "password_required" ||
    value === "parse_failed" ||
    value === "ocr_succeeded" ||
    value === "ocr_failed"
  );
}

export function readDocumentParseMetadata(
  sourceMetadata: Record<string, unknown>,
): DocumentParseMetadata | null {
  const raw = sourceMetadata.parse;
  if (!raw || typeof raw !== "object") return null;
  const parse = raw as Record<string, unknown>;
  if (!isDocumentParseStatus(parse.status)) return null;
  if (parse.method !== "tier1" && parse.method !== "ocr") return null;
  if (typeof parse.originalAssetSha256 !== "string") return null;
  return {
    status: parse.status,
    method: parse.method,
    originalAssetSha256: parse.originalAssetSha256,
    canonicalAssetSha256:
      typeof parse.canonicalAssetSha256 === "string" ? parse.canonicalAssetSha256 : undefined,
    extractedCharCount:
      typeof parse.extractedCharCount === "number" ? parse.extractedCharCount : undefined,
    pageCount: typeof parse.pageCount === "number" ? parse.pageCount : undefined,
    blankPageCount: typeof parse.blankPageCount === "number" ? parse.blankPageCount : undefined,
    warnings: Array.isArray(parse.warnings)
      ? parse.warnings.filter((item): item is string => typeof item === "string")
      : [],
    errorMessage: typeof parse.errorMessage === "string" ? parse.errorMessage : undefined,
    source:
      parse.source === "manual" || parse.source === "companion" ? parse.source : undefined,
    providerName: typeof parse.providerName === "string" ? parse.providerName : undefined,
    lease: readDocumentParseLease(parse.lease),
    updatedAt: typeof parse.updatedAt === "string" ? parse.updatedAt : undefined,
  };
}

function readDocumentParseLease(value: unknown): DocumentParseLease | undefined {
  if (!value || typeof value !== "object") return undefined;
  const lease = value as Record<string, unknown>;
  if (
    typeof lease.workerId !== "string" ||
    typeof lease.claimedAt !== "string" ||
    typeof lease.leaseUntil !== "string"
  ) {
    return undefined;
  }
  return {
    workerId: lease.workerId,
    claimedAt: lease.claimedAt,
    leaseUntil: lease.leaseUntil,
  };
}

export function isDocumentParseLeaseActive(
  parse: DocumentParseMetadata,
  now: string,
): boolean {
  return Boolean(parse.lease && parse.lease.leaseUntil > now);
}

export function withDocumentParseLease(
  parse: DocumentParseMetadata,
  lease: DocumentParseLease,
): DocumentParseMetadata {
  return {
    ...parse,
    lease,
    updatedAt: lease.claimedAt,
  };
}

export function withoutDocumentParseLease(
  parse: DocumentParseMetadata,
): DocumentParseMetadata {
  const { lease: _lease, ...rest } = parse;
  return rest;
}

export function buildTier1ParseMetadata(args: {
  detection: Tier1Detection;
  warnings: string[];
  originalAssetSha256: string;
  canonicalAssetSha256: string;
  hasMarkdown: boolean;
}): DocumentParseMetadata {
  return {
    status: args.hasMarkdown ? "text_succeeded" : "needs_ocr",
    method: "tier1",
    originalAssetSha256: args.originalAssetSha256,
    canonicalAssetSha256: args.canonicalAssetSha256,
    extractedCharCount: args.detection.extractedCharCount,
    pageCount: args.detection.pageCount,
    warnings: args.warnings,
  };
}

export function buildFailedParseMetadata(args: {
  originalAssetSha256: string;
  errorMessage: string;
  warnings?: string[];
}): DocumentParseMetadata {
  const status = isPasswordRequiredError(args.errorMessage)
    ? "password_required"
    : "parse_failed";
  return {
    status,
    method: "tier1",
    originalAssetSha256: args.originalAssetSha256,
    warnings: args.warnings ?? [],
    errorMessage: args.errorMessage,
  };
}

export function buildOcrSucceededParseMetadata(args: {
  original: DocumentParseMetadata;
  canonicalAssetSha256: string;
  chunkCount: number;
  source: "manual" | "companion";
  providerName?: string;
  updatedAt: string;
  /** 서버 OCR 의 빈 쪽 수(있을 때만). */
  blankPageCount?: number;
}): DocumentParseMetadata {
  return {
    status: "ocr_succeeded",
    method: "ocr",
    originalAssetSha256: args.original.originalAssetSha256,
    canonicalAssetSha256: args.canonicalAssetSha256,
    extractedCharCount: undefined,
    pageCount: args.original.pageCount,
    warnings: [
      `OCR 결과 적용 완료 — 청크 ${args.chunkCount}개 생성.`,
      ...(args.blankPageCount ? [`빈 쪽 ${args.blankPageCount}개 — 글이 없는 쪽으로 읽음.`] : []),
    ],
    ...(args.blankPageCount ? { blankPageCount: args.blankPageCount } : {}),
    source: args.source,
    providerName: args.providerName,
    updatedAt: args.updatedAt,
  };
}

export function buildOcrFailedParseMetadata(args: {
  original: DocumentParseMetadata;
  errorMessage: string;
  source: "manual" | "companion";
  providerName?: string;
  updatedAt: string;
}): DocumentParseMetadata {
  return {
    status: "ocr_failed",
    method: "ocr",
    originalAssetSha256: args.original.originalAssetSha256,
    canonicalAssetSha256: args.original.canonicalAssetSha256,
    extractedCharCount: args.original.extractedCharCount,
    pageCount: args.original.pageCount,
    warnings: args.original.warnings,
    errorMessage: args.errorMessage,
    source: args.source,
    providerName: args.providerName,
    updatedAt: args.updatedAt,
  };
}

export function isPasswordRequiredError(message: string): boolean {
  return /password|encrypted|encrypt|비밀번호|암호|잠김|보호/i.test(message);
}
