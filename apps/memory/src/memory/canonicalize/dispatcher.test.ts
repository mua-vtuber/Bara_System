/**
 * dispatcher.test.ts — canonicalize dispatcher 분기 검증 (Phase 14a Task 6).
 *
 * 분기 검증에는 주입 가능한 변환기 인자를 활용한다 — pdf/docx 실 파싱 없이
 * 분기 경로만 확인한다. passthrough 와 알 수 없는 형식은 실 로직이다.
 * 실 PDF/docx 파일이 필요한 검증은 pdf-tier1.test.ts / docx-tier1.test.ts 가 담당.
 */
import { describe, test, expect } from "bun:test";
import { canonicalize, isImageMime } from "./dispatcher.ts";
import { SUPPORTED_IMAGE_MIMES } from "../image-mime.ts";
import type { CanonicalizeResult } from "./types.ts";

describe("canonicalize dispatcher", () => {
  // passthrough 갈래

  test("text/markdown mimeType → passthrough", async () => {
    const text = "# 제목\n\n문단";
    const bytes = new TextEncoder().encode(text);
    const r = await canonicalize({ bytes, mimeType: "text/markdown", originalName: "a.md" });
    expect(r.markdown).toBe(text);
    expect(r.detection.kind).toBe("passthrough");
    expect(r.detection.extractedCharCount).toBe(text.length);
    expect(r.warnings).toEqual([]);
  });

  test("text/plain mimeType → passthrough", async () => {
    const text = "평문 본문";
    const bytes = new TextEncoder().encode(text);
    const r = await canonicalize({ bytes, mimeType: "text/plain", originalName: "a.txt" });
    expect(r.markdown).toBe(text);
    expect(r.detection.kind).toBe("passthrough");
    expect(r.detection.extractedCharCount).toBe(text.length);
  });

  test(".md 확장자 + mime 없음 → passthrough", async () => {
    const text = "확장자 분기";
    const bytes = new TextEncoder().encode(text);
    const r = await canonicalize({ bytes, originalName: "doc.md" });
    expect(r.detection.kind).toBe("passthrough");
    expect(r.markdown).toBe(text);
  });

  test(".txt 확장자 + mime 없음 → passthrough", async () => {
    const text = "txt 파일";
    const bytes = new TextEncoder().encode(text);
    const r = await canonicalize({ bytes, originalName: "note.txt" });
    expect(r.detection.kind).toBe("passthrough");
  });

  // PDF 분기

  test("application/pdf mimeType → pdfTier1 호출 (주입 가짜 변환기)", async () => {
    const fake: CanonicalizeResult = {
      markdown: "추출 텍스트",
      detection: { kind: "pdf", extractedCharCount: 7, pageCount: 1, scannedPdf: false, embeddedImageCount: 0 },
      warnings: [],
    };
    const r = await canonicalize(
      { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), mimeType: "application/pdf", originalName: "a.pdf" },
      { pdfTier1: async () => fake, docxTier1: async () => { throw new Error("unused"); } },
    );
    expect(r.detection.kind).toBe("pdf");
    expect(r.markdown).toBe("추출 텍스트");
  });

  test(".pdf 확장자 + mime 없음 → pdfTier1 호출 (주입 가짜 변환기)", async () => {
    const fake: CanonicalizeResult = {
      markdown: null,
      detection: { kind: "pdf", extractedCharCount: 0, pageCount: 2, scannedPdf: true, embeddedImageCount: 0 },
      warnings: ["스캔 PDF 로 보여 글자 검색 안 됨"],
    };
    const r = await canonicalize(
      { bytes: new Uint8Array([0x25, 0x50]), originalName: "report.pdf" },
      { pdfTier1: async () => fake, docxTier1: async () => { throw new Error("unused"); } },
    );
    expect(r.detection.kind).toBe("pdf");
    expect(r.markdown).toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  // docx 분기

  test("application/vnd.openxmlformats… mimeType → docxTier1 호출 (주입 가짜 변환기)", async () => {
    const fake: CanonicalizeResult = {
      markdown: "## 제목\n\n| A | B |\n| --- | --- |\n| 1 | 2 |",
      detection: { kind: "docx", extractedCharCount: 40, tableCount: 1, embeddedImageCount: 0 },
      warnings: [],
    };
    const r = await canonicalize(
      {
        bytes: new Uint8Array([0x50, 0x4b]),
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        originalName: "report.docx",
      },
      { pdfTier1: async () => { throw new Error("unused"); }, docxTier1: async () => fake },
    );
    expect(r.detection.kind).toBe("docx");
    expect(r.detection.tableCount).toBe(1);
  });

  test(".docx 확장자 + mime 없음 → docxTier1 호출 (주입 가짜 변환기)", async () => {
    const fake: CanonicalizeResult = {
      markdown: "문단",
      detection: { kind: "docx", extractedCharCount: 2, tableCount: 0, embeddedImageCount: 0 },
      warnings: [],
    };
    const r = await canonicalize(
      { bytes: new Uint8Array([0x50, 0x4b]), originalName: "note.docx" },
      { pdfTier1: async () => { throw new Error("unused"); }, docxTier1: async () => fake },
    );
    expect(r.detection.kind).toBe("docx");
  });

  // mime 우선 — ext 와 충돌 시 mime 을 따른다

  test("mime=text/plain 이고 ext=.pdf 이면 mime 우선 → passthrough", async () => {
    const text = "실제로 텍스트 파일";
    const bytes = new TextEncoder().encode(text);
    const r = await canonicalize(
      { bytes, mimeType: "text/plain", originalName: "misleading.pdf" },
    );
    // mime 이 text/plain 이므로 passthrough 로 처리
    expect(r.detection.kind).toBe("passthrough");
    expect(r.markdown).toBe(text);
  });

  // 알 수 없는 형식 — 구체 에러 throw

  test("지원하지 않는 mime → 구체 에러 throw", async () => {
    await expect(
      canonicalize({ bytes: new Uint8Array([1, 2]), mimeType: "application/zip", originalName: "a.zip" }),
    ).rejects.toThrow(/지원하지 않는/);
  });

  test("지원하지 않는 ext + mime 없음 → 구체 에러 throw", async () => {
    await expect(
      canonicalize({ bytes: new Uint8Array([1, 2]), originalName: "data.xlsx" }),
    ).rejects.toThrow(/지원하지 않는/);
  });

  test("에러 메시지에 mime 또는 ext 가 포함된다", async () => {
    const err = await canonicalize(
      { bytes: new Uint8Array([1]), mimeType: "video/mp4", originalName: "video.mp4" },
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/video\/mp4/);
  });

  // 이미지 mime — canonical 흐름 밖 명시 throw (라우트가 ingestImage 별 통로로 분기)

  test("image mime 이 canonicalize 까지 오면 별 통로 안내 throw (avif 포함)", async () => {
    for (const mime of ["image/png", "image/webp", "image/avif"]) {
      await expect(
        canonicalize({ bytes: new Uint8Array([1, 2]), mimeType: mime }),
      ).rejects.toThrow(/ingestImage 별 통로/);
    }
  });
});

// ── isImageMime — 코어 SUPPORTED_IMAGE_MIMES 단일 권위 정합 (Phase 11d D6) ──
// dispatcher 가 옛 별도 IMAGE_MIMES Set 정의를 버리고 image-mime.ts 의
// SUPPORTED_IMAGE_MIMES 한 곳을 import 한다 — 이 테스트가 isImageMime 가 그 코어
// 묶음과 정확히 같은 판정을 내는지 (avif 합류 포함) 대조해 권위 분기를 막는다.
describe("isImageMime — 코어 mime 권위 정합", () => {
  test("코어 SUPPORTED_IMAGE_MIMES 6 종 모두 true (avif 포함)", () => {
    expect(SUPPORTED_IMAGE_MIMES.has("image/avif")).toBe(true); // 11d D6 합류
    for (const mime of SUPPORTED_IMAGE_MIMES) {
      expect(isImageMime(mime)).toBe(true);
    }
  });

  test("코어 묶음 밖 mime 은 false (heic·svg·빈 문자열)", () => {
    expect(isImageMime("image/heic")).toBe(false); // §8 제외 결정
    expect(isImageMime("image/svg+xml")).toBe(false);
    expect(isImageMime("")).toBe(false);
    expect(isImageMime("text/plain")).toBe(false);
  });
});
