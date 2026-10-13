/**
 * canonicalize/docx-tier1.ts — docx Tier 1 변환기 (mammoth → Markdown / Phase 14 spec 4.2).
 *
 * 순수 JS mammoth 가 .docx 를 Markdown 으로 변환한다. 표 텍스트를 그대로 보존하므로
 * docx 표는 검색된다 — 표 관련 경고를 내지 않는다(spec 4.7).
 * 표 수는 docx zip 안 word/document.xml 의 <w:tbl 태그를 직접 세어 기록한다(spec 4.6
 * 신뢰도 규칙: XML 기반 검출이 mammoth 변환 결과 Markdown 마커보다 정확).
 * 이미지 수는 zip 안 word/media/ 경로 수로 센다.
 * zip 파싱은 fflate.unzipSync (순수 JS, ARM64 안전) — DCL: fflate 추가 선택(Task 8).
 *
 * 옛 바이너리 .doc(2007 이전)는 범위 밖(LibreOffice 필요 — scope exclusion D-2026-05-27-4).
 * 변환 실패와 zip 파싱 실패는 구체 에러를 던진다 — silent fallback 금지.
 */
import type { CanonicalizeInput, CanonicalizeResult } from "./types.ts";
import { unzipSync, strFromU8 } from "fflate";

// mammoth 패키지에 공식 타입 정의가 없다(@types/mammoth 미게시 확인 — Task 1 DCL).
// runtime API 형태는 deps-smoke.test.ts 에서 검증한 경로와 동일하게 단언한다.
const mammoth = (await import("mammoth")) as unknown as {
  convertToMarkdown: (
    input: { buffer: Buffer },
  ) => Promise<{ value: string; messages: unknown[] }>;
};

/**
 * docx 바이트를 Markdown 으로 변환하고 spec 4.6 검출 metadata + 정직한 경고를 산출한다.
 * markdown 은 변환 성공 시 항상 string(docx 는 텍스트 포함 파일이라 null 이 없음).
 */
export async function docxTier1(
  input: CanonicalizeInput,
): Promise<CanonicalizeResult> {
  // 1단계: mammoth 로 Markdown 변환
  let markdown: string;
  try {
    const result = await mammoth.convertToMarkdown({
      buffer: Buffer.from(input.bytes),
    });
    markdown = result.value;
  } catch (e) {
    throw new Error(
      `docx Tier 1 변환 실패: ${input.originalName ?? "(이름 없음)"} — ${(e as Error).message}`,
    );
  }

  // 2단계: zip 파싱으로 표 수 + 이미지 수 검출
  const { tableCount, imageCount } = inspectDocxZip(
    input.bytes,
    input.originalName,
  );

  // 3단계: 경고 생성 — docx 표는 검색되므로 표 경고 없음, 이미지만
  const warnings: string[] = [];
  if (imageCount > 0) {
    warnings.push(
      `포함된 이미지 ${imageCount}개는 검색 안 됨 (OCR·캡션 없음).`,
    );
  }

  return {
    markdown,
    detection: {
      kind: "docx",
      extractedCharCount: markdown.length,
      tableCount,
      embeddedImageCount: imageCount,
    },
    warnings,
  };
}

/**
 * docx(zip 컨테이너) 내부에서 표 수와 이미지 수를 센다.
 * - 표 수: word/document.xml 안 '<w:tbl' 패턴 개수 (띄어쓰기 or '>' 뒤 모두 포함)
 * - 이미지 수: 'word/media/' 경로로 시작하는 zip 엔트리 수
 *
 * DCL(Task 8): zip 파싱 라이브러리로 fflate.unzipSync 를 선택.
 * node:zlib.unzipSync 는 단일 deflate 스트림용이라 zip 컨테이너에 쓸 수 없다.
 * fflate 는 순수 JS, 네이티브 바인딩 없음, ARM64(A1) 안전.
 */
function inspectDocxZip(
  bytes: Uint8Array,
  originalName?: string,
): { tableCount: number; imageCount: number } {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (e) {
    throw new Error(
      `docx Tier 1 zip 파싱 실패: ${originalName ?? "(이름 없음)"} — ${(e as Error).message}`,
    );
  }

  const entryNames = Object.keys(entries);

  // 이미지 수: word/media/ 아래 파일 수
  const imageCount = entryNames.filter((n) =>
    n.startsWith("word/media/"),
  ).length;

  // 표 수: word/document.xml 에서 <w:tbl 출현 횟수
  let tableCount = 0;
  const docXmlEntry = entries["word/document.xml"];
  if (docXmlEntry) {
    const xml = strFromU8(docXmlEntry);
    // <w:tbl> 또는 <w:tbl 속성... 모두 포함
    const matches = xml.match(/<w:tbl[\s>]/g);
    tableCount = matches ? matches.length : 0;
  }

  return { tableCount, imageCount };
}
