/**
 * canonicalize/pdf-tier1.ts — PDF Tier 1 텍스트 레이어 추출 (Phase 14 spec 단락 4.3).
 *
 * 순수 JS unpdf 로 텍스트 레이어를 추출한다. OCR·표 구조는 없다(Tier 2 외부 도구 몫).
 * 추출 글자가 SCANNED_CHAR_THRESHOLD 이하 이고 페이지가 있으면 스캔 PDF 로 판정해
 * canonical .md 를 만들지 않고(markdown=null) 정직한 "검색 안 됨" 경고를 단다.
 * 원본 자산 보존은 상위 ingest 흐름이 담당한다.
 *
 * PDF 표 수는 pdf.js 기반 추출로 신뢰 가능하게 셀 수 없어 기록·약속하지 않는다
 * (spec 4.6 신뢰도 규칙). tableCount 필드를 결과에 넣지 않는다.
 *
 * 이미지 수: getOperatorList() 의 fnArray 에서 paintImageXObject(85) /
 * paintInlineImageXObject(86) 연산 개수를 센다. 실패 페이지는 0 으로 계산한다
 * (개수 추정값 — 스캔 판정은 글자 수 기반이라 이미지 수에 의존하지 않는다).
 */
import { extractText, getDocumentProxy } from "unpdf";
import type { CanonicalizeInput, CanonicalizeResult } from "./types.ts";

/** 추출 글자(trim 후)가 이 길이 이하 이고 페이지가 있으면 스캔 PDF 로 판정한다. */
const SCANNED_CHAR_THRESHOLD = 4;

/**
 * pdf.js OPS 상수 — getOperatorList() fnArray 에 들어오는 연산 코드.
 * paintImageXObject = 85, paintInlineImageXObject = 86.
 * unpdf 는 pdf.js 의 OPS 네임스페이스를 직접 노출하지 않으므로 숫자 상수를 사용한다.
 */
const OPS_PAINT_IMAGE_XOBJECT = 85;
const OPS_PAINT_INLINE_IMAGE_XOBJECT = 86;

export async function pdfTier1(input: CanonicalizeInput): Promise<CanonicalizeResult> {
  let rawText: string;
  let totalPages: number;
  let embeddedImageCount: number;

  try {
    // pdf.js(unpdf getDocumentProxy)는 받은 바이트의 ArrayBuffer 를 워커로 넘겨(transfer) 비운다. input.bytes 는
    // 호출자가 원본 자산 파일로 쓸 바이트라 사본을 넘긴다 — 그대로 넘기면 원본 PDF 가 0바이트 파일로 저장된다.
    const pdf = await getDocumentProxy(input.bytes.slice());
    const extracted = await extractText(pdf, { mergePages: true });
    // unpdf extractText 는 mergePages=true 시 text 가 string 으로 반환된다.
    // 타입 보호: string 이 아닌 경우(string[]) 를 join 으로 통합.
    rawText =
      typeof extracted.text === "string"
        ? extracted.text
        : (extracted.text as string[]).join("\n");
    totalPages = extracted.totalPages;
    embeddedImageCount = await countEmbeddedImages(pdf, totalPages);
  } catch (e) {
    throw new Error(
      `PDF Tier 1 파싱 실패: ${input.originalName ?? "(이름 없음)"} — ${(e as Error).message}`,
    );
  }

  const trimmed = rawText.trim();
  const extractedCharCount = trimmed.length;
  const scannedPdf = extractedCharCount <= SCANNED_CHAR_THRESHOLD && totalPages > 0;

  if (scannedPdf) {
    const warnings: string[] = [
      "스캔 PDF 로 보여 글자 검색 안 됨 (원본은 보존 / OCR 동반 도구 필요).",
    ];
    return {
      markdown: null,
      detection: {
        kind: "pdf",
        extractedCharCount,
        pageCount: totalPages,
        scannedPdf: true,
        embeddedImageCount,
      },
      warnings,
    };
  }

  const warnings: string[] = [];
  if (embeddedImageCount > 0) {
    warnings.push(
      `포함된 이미지 ${embeddedImageCount}개는 검색 안 됨 (OCR·캡션 없음).`,
    );
  }

  return {
    markdown: trimmed,
    detection: {
      kind: "pdf",
      extractedCharCount,
      pageCount: totalPages,
      scannedPdf: false,
      embeddedImageCount,
    },
    warnings,
  };
}

/**
 * 페이지별 이미지 XObject 연산 개수를 센다.
 * 한 페이지의 getOperatorList() 호출이 실패해도 전체 추출은 이미 완료된 이후라
 * 해당 페이지를 0 으로 계산하고 계속 진행한다 (이미지 수는 추정값).
 */
async function countEmbeddedImages(
  pdf: Awaited<ReturnType<typeof getDocumentProxy>>,
  totalPages: number,
): Promise<number> {
  let count = 0;
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    try {
      const page = await pdf.getPage(pageNum);
      const ops = await page.getOperatorList();
      for (const fn of ops.fnArray as number[]) {
        if (fn === OPS_PAINT_IMAGE_XOBJECT || fn === OPS_PAINT_INLINE_IMAGE_XOBJECT) {
          count++;
        }
      }
    } catch {
      // 한 페이지 연산 목록 열람 실패는 이미지 개수 추정에서 제외한다.
      // 전체 텍스트 추출은 이미 성공했으므로 계속 진행한다.
    }
  }
  return count;
}
