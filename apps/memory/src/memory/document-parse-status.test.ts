/**
 * document-parse-status.test.ts — parse 상태 helper 회귀 검증.
 */

import { describe, expect, test } from "bun:test";
import {
  buildFailedParseMetadata,
  buildOcrFailedParseMetadata,
  isDocumentParseLeaseActive,
  isPasswordRequiredError,
  readDocumentParseMetadata,
  withDocumentParseLease,
} from "./document-parse-status.ts";

describe("document parse status helpers", () => {
  test("암호/encrypted 계열 에러는 password_required 로 분류한다", () => {
    expect(isPasswordRequiredError("PDF is encrypted and requires a password")).toBe(true);
    expect(isPasswordRequiredError("암호가 걸린 PDF 입니다")).toBe(true);

    const parse = buildFailedParseMetadata({
      originalAssetSha256: "sha_pdf",
      errorMessage: "PDF is encrypted and requires a password",
    });
    expect(parse.status).toBe("password_required");
  });

  test("일반 파싱 실패는 parse_failed 로 분류한다", () => {
    const parse = buildFailedParseMetadata({
      originalAssetSha256: "sha_pdf",
      errorMessage: "Invalid PDF structure",
    });
    expect(parse.status).toBe("parse_failed");
  });

  test("lease metadata 를 읽고 만료 여부를 판정한다", () => {
    const parse = readDocumentParseMetadata({
      parse: {
        status: "needs_ocr",
        method: "tier1",
        originalAssetSha256: "sha_pdf",
        warnings: [],
        lease: {
          workerId: "worker-a",
          claimedAt: "2026-07-01 10:00:00",
          leaseUntil: "2026-07-01 10:30:00",
        },
      },
    });
    expect(parse?.lease?.workerId).toBe("worker-a");
    expect(isDocumentParseLeaseActive(parse!, "2026-07-01 10:10:00")).toBe(true);
    expect(isDocumentParseLeaseActive(parse!, "2026-07-01 10:30:01")).toBe(false);
  });

  test("OCR 실패 metadata 는 기존 lease 를 제거한다", () => {
    const leased = withDocumentParseLease(
      {
        status: "needs_ocr",
        method: "tier1",
        originalAssetSha256: "sha_pdf",
        warnings: [],
      },
      {
        workerId: "worker-a",
        claimedAt: "2026-07-01 10:00:00",
        leaseUntil: "2026-07-01 10:30:00",
      },
    );
    const failed = buildOcrFailedParseMetadata({
      original: leased,
      errorMessage: "OCR command failed",
      source: "companion",
      providerName: "fixture",
      updatedAt: "2026-07-01 10:05:00",
    });
    expect(failed.status).toBe("ocr_failed");
    expect(failed.lease).toBeUndefined();
    expect(failed.errorMessage).toBe("OCR command failed");
    expect(failed.providerName).toBe("fixture");
  });
});
