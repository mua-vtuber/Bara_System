import { describe, test, expect } from "bun:test";

describe("Task 1 — unpdf + mammoth import smoke", () => {
  test("unpdf extractText 가 최소 PDF 1쪽에서 텍스트를 돌려준다", async () => {
    const { extractText, getDocumentProxy } = await import("unpdf");
    // 최소 유효 PDF — 텍스트 'Hello bara' 한 줄. unpdf 가 Uint8Array 를 받는다.
    const minimalPdf = buildMinimalPdf("Hello bara");
    const pdf = await getDocumentProxy(minimalPdf);
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    expect(typeof text).toBe("string");
    expect(totalPages).toBeGreaterThanOrEqual(1);
  });

  test("mammoth convertToMarkdown 가 docx 버퍼에서 Markdown 을 돌려준다", async () => {
    // mammoth 패키지에 타입 정의 파일이 없다(@types/mammoth 도 미게시).
    // tsc 추론이 불완전하므로 unknown 로 받고 실제 호출 경로를 타입 단언으로 명시한다.
    // 런타임 API 존재 여부는 이 테스트 자체가 검증한다.
    const mammoth = (await import("mammoth")) as unknown as {
      convertToMarkdown: (input: { buffer: Buffer }) => Promise<{ value: string; messages: unknown[] }>;
    };
    const docxBuffer = buildMinimalDocx("문단 하나");
    const result = await mammoth.convertToMarkdown({ buffer: docxBuffer });
    expect(typeof result.value).toBe("string");
    expect(Array.isArray(result.messages)).toBe(true);
  });
});

/** zlib·바이너리 docx 합성은 무거우므로, 테스트 자산은 fixtures 디렉토리에서 읽는다. */
function buildMinimalDocx(_text: string): Buffer {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  return readFileSync(join(import.meta.dir, "__fixtures__", "minimal.docx"));
}
function buildMinimalPdf(_text: string): Uint8Array {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  return new Uint8Array(readFileSync(join(import.meta.dir, "__fixtures__", "minimal.pdf")));
}
