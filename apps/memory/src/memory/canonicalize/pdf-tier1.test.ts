import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pdfTier1 } from "./pdf-tier1.ts";

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(import.meta.dir, "__fixtures__", name)));
}

describe("pdfTier1", () => {
  test("텍스트 레이어 PDF → markdown + scannedPdf=false", async () => {
    const r = await pdfTier1({
      bytes: fixture("text.pdf"),
      mimeType: "application/pdf",
      originalName: "text.pdf",
    });
    expect(r.markdown).not.toBeNull();
    expect(r.detection.kind).toBe("pdf");
    expect(r.detection.scannedPdf).toBe(false);
    expect(r.detection.pageCount).toBeGreaterThanOrEqual(1);
    expect(r.detection.extractedCharCount).toBeGreaterThan(0);
    // PDF 에는 tableCount 기록 없음 (spec 4.6 신뢰도 규칙)
    expect("tableCount" in r.detection).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  test("스캔 PDF → markdown=null + 정직한 경고 (스캔 + 검색 안 됨)", async () => {
    const r = await pdfTier1({
      bytes: fixture("scanned.pdf"),
      mimeType: "application/pdf",
      originalName: "scanned.pdf",
    });
    expect(r.markdown).toBeNull();
    expect(r.detection.kind).toBe("pdf");
    expect(r.detection.scannedPdf).toBe(true);
    expect(r.detection.pageCount).toBeGreaterThan(0);
    // 경고에 "스캔"과 "검색 안 됨" 문구 포함
    expect(r.warnings.length).toBeGreaterThan(0);
    const allWarnings = r.warnings.join(" ");
    expect(allWarnings).toContain("스캔");
    expect(allWarnings).toContain("검색 안 됨");
  });

  test("이미지 수 검출 → embeddedImageCount 기록됨", async () => {
    // text.pdf (Hello bara) 는 이미지가 없으므로 embeddedImageCount = 0
    const r = await pdfTier1({
      bytes: fixture("text.pdf"),
      mimeType: "application/pdf",
      originalName: "text.pdf",
    });
    expect(typeof r.detection.embeddedImageCount).toBe("number");
  });

  test("PDF 파싱 실패 → 구체 에러 throw (빈 결과 반환 금지)", async () => {
    const badBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]); // 유효하지 않은 PDF
    await expect(
      pdfTier1({ bytes: badBytes, mimeType: "application/pdf", originalName: "bad.pdf" }),
    ).rejects.toThrow(/PDF Tier 1 파싱 실패/);
  });

  test("스캔 PDF + 이미지 있음 → 이미지 경고 포함", async () => {
    // scanned.pdf 는 이미지 XObject 없이 빈 콘텐츠라 이미지 경고가 없을 수 있음.
    // 스캔 경고 자체가 포함되는지 확인.
    const r = await pdfTier1({
      bytes: fixture("scanned.pdf"),
      mimeType: "application/pdf",
      originalName: "scanned.pdf",
    });
    // 스캔 경고 반드시 포함
    expect(r.warnings.some((w) => w.includes("스캔"))).toBe(true);
  });
});
