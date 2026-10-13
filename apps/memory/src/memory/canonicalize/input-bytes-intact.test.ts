/**
 * input-bytes-intact.test.ts — canonicalize 는 호출자가 넘긴 바이트를 비우거나 바꾸지 않는다.
 *
 * POST /ingest 는 원본 바이트의 sha 를 먼저 계산하고, 같은 Uint8Array 를 canonicalize 에 넘긴 뒤 그 바이트를 원본 자산
 * 파일로 쓴다. pdf.js(unpdf getDocumentProxy)는 받은 바이트의 ArrayBuffer 를 워커로 넘겨(transfer) 비우므로, 변환기가
 * 사본을 넘기지 않으면 원본 PDF 가 0바이트 파일로 저장된다(U9a 회귀). 형식마다 변환 뒤 길이·내용이 그대로인지 본다.
 * 실제 변환기 + 저장소의 실제 fixture 파일. mock 0.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize } from "./dispatcher.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const cases: Array<{ name: string; mimeType: string; bytes: () => Uint8Array }> = [
  { name: "text.pdf", mimeType: "application/pdf", bytes: () => new Uint8Array(readFileSync(join(FIXTURES, "text.pdf"))) },
  { name: "scanned.pdf", mimeType: "application/pdf", bytes: () => new Uint8Array(readFileSync(join(FIXTURES, "scanned.pdf"))) },
  { name: "minimal.docx", mimeType: DOCX_MIME, bytes: () => new Uint8Array(readFileSync(join(FIXTURES, "minimal.docx"))) },
  { name: "note.txt", mimeType: "text/plain", bytes: () => new TextEncoder().encode("캠핑 준비물\n\n텐트와 침낭") },
];

describe("canonicalize — 호출자의 바이트를 그대로 둔다", () => {
  for (const c of cases) {
    test(`${c.name} — 변환 뒤에도 넘긴 Uint8Array 의 길이·내용·ArrayBuffer 가 그대로다`, async () => {
      const bytes = c.bytes();
      const expected = bytes.slice();
      expect(bytes.byteLength).toBeGreaterThan(0);

      await canonicalize({ bytes, mimeType: c.mimeType, originalName: c.name });

      expect((bytes.buffer as ArrayBuffer).detached).toBe(false);
      expect(bytes.byteLength).toBe(expected.byteLength);
      expect(bytes).toEqual(expected);
    });
  }
});
