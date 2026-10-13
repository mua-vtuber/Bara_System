/**
 * 쪽 그림 만들기 — 실제 @napi-rs/canvas + 실제 PDF fixture (2026-10-11 document-ocr spec T6, 사용자 결정 Q7).
 * 로드 확인은 실제 로드로 한다(이 기계의 플랫폼에서). 로드 실패 재현만 불러오기 함수를 바꿔 넣는다.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDocumentPageImageSource, documentOcrEligibility, loadCanvasModule } from "./page-images.ts";
import { DocumentOcrConfigError, type OcrAsset } from "./types.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__");

function asset(file: string, mimeType = "application/pdf"): OcrAsset {
  return { sha256: `sha-${file}`, bytes: new Uint8Array(readFileSync(join(FIXTURES, file))), mimeType, originalName: file };
}

/** png 머리의 가로·세로(IHDR). */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("그림 부품 로드", () => {
  test(`이 기계(${process.platform}-${process.arch})의 Bun 에서 @napi-rs/canvas 가 실제로 로드된다`, async () => {
    const mod = await loadCanvasModule();
    const canvas = mod.createCanvas(4, 4);
    const png = await canvas.encode("png");
    expect(pngSize(new Uint8Array(png))).toEqual({ width: 4, height: 4 });
  });

  test("로드 실패는 이유를 담은 설정 오류(조용히 건너뛰지 않음)", async () => {
    const source = createDocumentPageImageSource({
      canvasImporter: () => Promise.reject(new Error("Cannot find native binding")),
    });
    const err = await source.pageCount(asset("scanned-2page.pdf")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DocumentOcrConfigError);
    expect((err as Error).message).toBe("쪽 그림 모듈(@napi-rs/canvas)을 불러오지 못함: Cannot find native binding");
  });
});

describe("PDF → 쪽 그림", () => {
  test("텍스트 없는 스캔형 2쪽 PDF — 쪽 수와 쪽 png, 긴 변 = maxEdgePx", async () => {
    const source = createDocumentPageImageSource();
    try {
      const pdf = asset("scanned-2page.pdf");
      expect(await source.pageCount(pdf)).toBe(2);
      for (const index of [0, 1]) {
        const page = await source.renderPage(pdf, index, 900);
        expect(page.pageIndex).toBe(index);
        expect(page.pageCount).toBe(2);
        expect(page.mimeType).toBe("image/png");
        // 쪽 크기 400x600 → 긴 변 900 이면 600x900.
        expect(pngSize(page.bytes)).toEqual({ width: 600, height: 900 });
      }
    } finally {
      await source.dispose();
    }
  });

  test("기존 스캔 fixture(1쪽)도 그린다", async () => {
    const source = createDocumentPageImageSource();
    try {
      const pdf = asset("../../../memory/canonicalize/__fixtures__/scanned.pdf");
      expect(await source.pageCount(pdf)).toBe(1);
      const size = pngSize((await source.renderPage(pdf, 0, 1600)).bytes);
      expect(Math.max(size.width, size.height)).toBe(1600);
    } finally {
      await source.dispose();
    }
  });

  test("손상 PDF 는 일반 오류(결정적 실패 계열) — 설정 오류가 아니다", async () => {
    const source = createDocumentPageImageSource();
    const err = await source.pageCount(asset("corrupt.pdf")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DocumentOcrConfigError);
    await source.dispose();
  });

  test("그림 자산은 1쪽, 긴 변을 줄여 png 로", async () => {
    const source = createDocumentPageImageSource();
    const mod = await loadCanvasModule();
    const big = mod.createCanvas(2000, 1000);
    big.getContext("2d").fillRect(0, 0, 2000, 1000);
    const image: OcrAsset = { sha256: "img", bytes: new Uint8Array(await big.encode("jpeg")), mimeType: "image/jpeg", originalName: "a.jpg" };
    expect(await source.pageCount(image)).toBe(1);
    expect(pngSize((await source.renderPage(image, 0, 1000)).bytes)).toEqual({ width: 1000, height: 500 });
  });
});

describe("서버 OCR 대상 판정", () => {
  test("PDF·그림은 대상, docx·그 밖은 사유와 함께 대상 아님", () => {
    expect(documentOcrEligibility({ mimeType: "application/pdf" })).toEqual({ ok: true });
    expect(documentOcrEligibility({ mimeType: "image/png" })).toEqual({ ok: true });
    expect(documentOcrEligibility({ mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).toEqual({
      ok: false, reason: "docx 는 서버 OCR 대상이 아님 — 내 PC 보조 프로그램을 쓰세요",
    });
    const other = documentOcrEligibility({ mimeType: "text/plain" });
    expect(other.ok).toBe(false);
  });
});
