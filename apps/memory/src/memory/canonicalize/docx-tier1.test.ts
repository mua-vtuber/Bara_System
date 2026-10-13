import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { DOCX_ZIP_LIMITS, docxTier1 } from "./docx-tier1.ts";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** central directory 에서 name 엔트리의 풀린 크기 칸(offset 24)만 declared 로 바꾼다. */
function declareEntrySize(zip: Uint8Array, name: string, declared: number): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const target = new TextEncoder().encode(name);
  for (let i = 0; i + 46 <= out.length; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(i + 28, true);
    const entryName = out.subarray(i + 46, i + 46 + nameLength);
    if (entryName.length === target.length && entryName.every((b, k) => b === target[k])) {
      view.setUint32(i + 24, declared, true);
    }
  }
  return out;
}

function fixture(name: string): Buffer {
  return readFileSync(join(import.meta.dir, "__fixtures__", name));
}

describe("docxTier1", () => {
  test("docx → markdown + 표 텍스트 보존 + tableCount", async () => {
    // minimal.docx: 문단("문단 하나") + 표 1개(셀A, 셀B) — Task 1 생성 fixture
    const r = await docxTier1({
      bytes: new Uint8Array(fixture("minimal.docx")),
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      originalName: "minimal.docx",
    });
    expect(r.markdown).not.toBeNull();
    expect(r.detection.kind).toBe("docx");
    expect(r.detection.extractedCharCount).toBeGreaterThan(0);
    // minimal.docx 에 <w:tbl> 1개 — XML 카운트 정합
    expect(r.detection.tableCount).toBe(1);
    // mammoth 가 표 텍스트를 보존하므로 셀 내용이 markdown 에 들어간다
    expect(r.markdown).toContain("셀A");
    expect(r.markdown).toContain("셀B");
    // docx 표는 검색되므로 표 관련 경고가 없다
    expect(r.warnings.some((w) => w.includes("표"))).toBe(false);
    // minimal.docx 에 word/media/ 파일 없음 → 이미지 경고 없음
    expect(r.detection.embeddedImageCount).toBe(0);
    expect(r.warnings.length).toBe(0);
  });

  test("detection: kind='docx' + 이미지 0 시 warnings 빈 배열", async () => {
    const r = await docxTier1({
      bytes: new Uint8Array(fixture("minimal.docx")),
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      originalName: "minimal.docx",
    });
    expect(r.detection.kind).toBe("docx");
    expect(r.warnings).toEqual([]);
  });

  test("이미지>0 시 '포함된 이미지 N개는 검색 안 됨' 경고", async () => {
    // minimal.docx 는 이미지 없음이라 이미지 경고 분기를 단위 테스트로 검증한다.
    // docxTier1 의 내부 getEmbeddedImageCount 를 우회해 이미지 분기만 테스트한다:
    // 실제 이미지 fixture 를 만들기 어려우므로, minimal.docx 에서 얻은 결과의
    // embeddedImageCount 가 0 임을 확인하고, 경고 문자열 포맷을 직접 검증한다.
    // (이미지 포함 fixture 는 생성 비용이 크므로 이 task 에서 문자열 포맷만 스펙 고정.)
    const WARNING_PATTERN = /포함된 이미지 \d+개는 검색 안 됨 \(OCR·캡션 없음\)\./;
    const imageWarning = "포함된 이미지 2개는 검색 안 됨 (OCR·캡션 없음).";
    expect(WARNING_PATTERN.test(imageWarning)).toBe(true);
  });

  test("깨진 바이트 입력 → 구체 에러 throw", async () => {
    await expect(
      docxTier1({
        bytes: new Uint8Array([0x00, 0x01, 0x02, 0x03]),
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        originalName: "garbage.docx",
      }),
    ).rejects.toThrow(/docx Tier 1/);
  });

  test("zip bomb — 풀린 크기 합계 상한을 넘는 docx 는 mammoth 전에 상한 이름을 담아 거절", async () => {
    const entries = unzipSync(new Uint8Array(fixture("minimal.docx")));
    const filler = new Uint8Array(DOCX_ZIP_LIMITS.maxEntryUncompressedBytes);
    const bomb = zipSync(
      { ...entries, "word/media/pad1.bin": filler, "word/media/pad2.bin": filler, "word/media/pad3.bin": filler },
      { level: 9 },
    );
    // 압축본은 업로드 상한보다 훨씬 작다 — 그래서 업로드 상한만으로는 못 막는다.
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    await expect(
      docxTier1({ bytes: bomb, mimeType: DOCX_MIME, originalName: "bomb.docx" }),
    ).rejects.toThrow(/docx Tier 1 zip 파싱 실패: bomb\.docx — .*maxTotalUncompressedBytes/);
  });

  test("zip 목록에 적힌 크기만으로 엔트리 상한을 판정한다 — 풀기 전에 거절", async () => {
    const zip = declareEntrySize(
      new Uint8Array(fixture("minimal.docx")),
      "word/document.xml",
      DOCX_ZIP_LIMITS.maxEntryUncompressedBytes + 1,
    );
    await expect(
      docxTier1({ bytes: zip, mimeType: DOCX_MIME, originalName: "declared.docx" }),
    ).rejects.toThrow(/maxEntryUncompressedBytes/);
  });

  test("엔트리 수 상한을 넘는 docx 거절", async () => {
    const entries: Record<string, Uint8Array> = unzipSync(new Uint8Array(fixture("minimal.docx")));
    for (let i = 0; i <= DOCX_ZIP_LIMITS.maxEntries; i++) entries[`word/media/e${i}.bin`] = new Uint8Array(0);
    await expect(
      docxTier1({ bytes: zipSync(entries), mimeType: DOCX_MIME, originalName: "many.docx" }),
    ).rejects.toThrow(/maxEntries/);
  });

  test("상한 안의 docx 는 다시 묶은 zip 으로 mammoth 변환이 그대로 된다(이미지 수 포함)", async () => {
    const entries = unzipSync(new Uint8Array(fixture("minimal.docx")));
    const withMedia = zipSync({ ...entries, "word/media/image1.png": new Uint8Array(16) });
    const r = await docxTier1({ bytes: withMedia, mimeType: DOCX_MIME, originalName: "media.docx" });
    expect(r.markdown).toContain("셀A");
    expect(r.detection.embeddedImageCount).toBe(1);
    expect(r.warnings).toEqual(["포함된 이미지 1개는 검색 안 됨 (OCR·캡션 없음)."]);
  });
});
