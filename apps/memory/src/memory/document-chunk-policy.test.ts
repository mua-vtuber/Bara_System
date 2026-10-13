import { describe, expect, test } from "bun:test";
import {
  chunkDocumentByPolicy,
  selectDocumentChunkStrategy,
} from "./document-chunk-policy.ts";

describe("document chunk policy", () => {
  test("Markdown 파일은 heading 이 있으면 heading_path, 없으면 paragraph", () => {
    expect(
      selectDocumentChunkStrategy({
        markdown: "# 제목\n본문",
        originalName: "guide.md",
        mimeType: "text/markdown",
      }),
    ).toBe("heading_path");
    expect(
      selectDocumentChunkStrategy({
        markdown: "그냥 문단",
        originalName: "guide.md",
        mimeType: "text/markdown",
      }),
    ).toBe("paragraph");
  });

  test("docx 변환 결과는 heading 유무에 따라 자동 선택한다", () => {
    expect(
      selectDocumentChunkStrategy({
        markdown: "## 섹션\n본문",
        detection: { kind: "docx", extractedCharCount: 8 },
        originalName: "report.docx",
      }),
    ).toBe("heading_path");
    expect(
      selectDocumentChunkStrategy({
        markdown: "본문만 있는 문서",
        detection: { kind: "docx", extractedCharCount: 9 },
        originalName: "report.docx",
      }),
    ).toBe("paragraph");
  });

  test("PDF Tier 1 텍스트 레이어는 heading 모양이 있어도 paragraph", () => {
    expect(
      selectDocumentChunkStrategy({
        markdown: "# PDF 제목처럼 보이는 줄\n본문",
        detection: { kind: "pdf", extractedCharCount: 20, scannedPdf: false },
        originalName: "paper.pdf",
      }),
    ).toBe("paragraph");
  });

  test("OCR Markdown 은 heading 유무에 따라 자동 선택한다", () => {
    expect(
      selectDocumentChunkStrategy({
        markdown: "# OCR 제목\n본문",
        source: "ocr",
      }),
    ).toBe("heading_path");
    expect(
      selectDocumentChunkStrategy({
        markdown: "OCR 본문만 있음",
        source: "ocr",
      }),
    ).toBe("paragraph");
  });

  test("정책으로 만든 청크는 저장용 chunkingStrategy 를 싣는다", () => {
    const headingChunks = chunkDocumentByPolicy({
      markdown: "# 제목\n본문",
      originalName: "guide.md",
    });
    expect(headingChunks[0]!.chunkingStrategy).toBe("heading_path");
    expect(headingChunks[0]!.headingPath).toEqual(["제목"]);

    const paragraphChunks = chunkDocumentByPolicy({
      markdown: "본문만 있음",
      originalName: "guide.md",
    });
    expect(paragraphChunks[0]!.chunkingStrategy).toBe("paragraph");
    expect(paragraphChunks[0]!.headingPath).toBeUndefined();
  });

  test("heading 앞 머리말 청크는 paragraph metadata 로 남긴다", () => {
    const chunks = chunkDocumentByPolicy(
      {
        markdown: "머리말입니다.\n\n# 제목\n본문",
        originalName: "guide.md",
      },
      { minChunkTokens: 0 },
    );
    expect(chunks.map((chunk) => chunk.chunkingStrategy)).toEqual(["paragraph", "heading_path"]);
    expect(chunks[0]!.headingPath).toBeUndefined();
    expect(chunks[1]!.headingPath).toEqual(["제목"]);
  });
});
