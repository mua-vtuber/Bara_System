/**
 * canonicalize/docx-tier1.ts — docx Tier 1 변환기 (mammoth → Markdown / Phase 14 spec 4.2).
 *
 * 순수 JS mammoth 가 .docx 를 Markdown 으로 변환한다. 표 텍스트를 그대로 보존하므로
 * docx 표는 검색된다 — 표 관련 경고를 내지 않는다(spec 4.7).
 * 표 수는 docx zip 안 word/document.xml 의 <w:tbl 태그를 직접 세어 기록한다(spec 4.6
 * 신뢰도 규칙: XML 기반 검출이 mammoth 변환 결과 Markdown 마커보다 정확).
 * 이미지 수는 zip 안 word/media/ 경로 수로 센다.
 * zip 풀기는 bounded-unzip.ts(node:zlib, 상한 검사), 다시 묶기는 fflate.zipSync (순수 JS,
 * ARM64 안전) — DCL: fflate 추가 선택(Task 8).
 *
 * 옛 바이너리 .doc(2007 이전)는 범위 밖(LibreOffice 필요 — scope exclusion D-2026-05-27-4).
 * 변환 실패와 zip 파싱 실패는 구체 에러를 던진다 — silent fallback 금지.
 *
 * zip bomb 방어: zip 은 DOCX_ZIP_LIMITS 안에서만 푼다(bounded-unzip.ts — 풀기 전에 zip
 * 목록의 크기·개수 검사, 풀 때는 목록에 적힌 크기를 넘는 순간 중단). mammoth 는 원본 바이트가 아니라 상한 안에서 풀린 엔트리를
 * 무압축으로 다시 묶은 zip 을 받는다 — mammoth 안의 jszip 은 크기 상한 없이 풀기 때문에,
 * 원본을 넘기면 zip 목록에 거짓 크기를 적은 문서가 그 안에서 다시 부풀 수 있다.
 */
import type { CanonicalizeInput, CanonicalizeResult } from "./types.ts";
import { strFromU8, zipSync } from "fflate";
import { unzipWithinLimits, type UnzippedEntries, type ZipExtractionLimits } from "./bounded-unzip.ts";

const BYTES_PER_MIB = 1024 * 1024;

/**
 * docx zip 을 풀 때의 상한. 업로드 상한 기본값(security.maxAssetBytes = 64 MiB)의 3배를
 * 합계로 잡았다 — 이미지처럼 이미 압축된 내용은 거의 부풀지 않고, 글(XML)은 5~10배 부풀지만
 * 글만으로 수십 MB 압축 docx 는 실사용에서 나오지 않는다. 엔트리 하나는 합계의 절반,
 * 엔트리 수는 이미지가 많은 문서(수백 개)를 넉넉히 넘는 값이다.
 */
export const DOCX_ZIP_LIMITS: Readonly<ZipExtractionLimits> = Object.freeze({
  maxEntries: 5_000,
  maxEntryUncompressedBytes: 96 * BYTES_PER_MIB,
  maxTotalUncompressedBytes: 192 * BYTES_PER_MIB,
});

/** mammoth 에 넘길 zip 을 다시 묶을 때의 압축 수준. 0 = 무압축(빠르고, 크기는 이미 검사됨). */
const REZIP_STORE_LEVEL = 0;

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
  // 1단계: 상한 안에서 zip 을 풀고 표 수 + 이미지 수 검출. 상한을 넘으면 여기서 던져
  // mammoth 까지 가지 않는다.
  let entries: UnzippedEntries | null = unzipDocx(input.bytes, input.originalName);
  const { tableCount, imageCount } = inspectDocxEntries(entries);

  // 2단계: 검사를 마친 엔트리만 다시 묶어 mammoth 로 Markdown 변환. 다시 묶은 뒤에는 풀린
  // 엔트리를 놓아 mammoth 가 도는 동안 같은 내용을 두 벌 들고 있지 않는다. Buffer 는 다시 묶은
  // 바이트를 복사하지 않고 그대로 감싼다.
  const rezipped = zipSync(entries, { level: REZIP_STORE_LEVEL });
  entries = null;
  let markdown: string;
  try {
    const result = await mammoth.convertToMarkdown({
      buffer: Buffer.from(rezipped.buffer, rezipped.byteOffset, rezipped.byteLength),
    });
    markdown = result.value;
  } catch (e) {
    throw new Error(
      `docx Tier 1 변환 실패: ${input.originalName ?? "(이름 없음)"} — ${(e as Error).message}`,
    );
  }

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
 * docx(zip 컨테이너)를 DOCX_ZIP_LIMITS 안에서 푼다. 상한 초과·깨진 zip 모두 파일 이름을
 * 담은 구체 에러로 던진다(상한 초과는 넘은 상한 이름과 값이 메시지에 들어 있다).
 *
 * zip 목록은 bounded-unzip.ts 가 직접 읽고 엔트리마다 node:zlib inflateRawSync 로 푼다
 * (fflate.unzipSync 는 크기를 속인 엔트리에서 CPU 를 오래 붙잡아 쓰지 않는다).
 */
function unzipDocx(bytes: Uint8Array, originalName?: string): UnzippedEntries {
  try {
    return unzipWithinLimits(bytes, DOCX_ZIP_LIMITS);
  } catch (e) {
    throw new Error(
      `docx Tier 1 zip 파싱 실패: ${originalName ?? "(이름 없음)"} — ${(e as Error).message}`,
    );
  }
}

/**
 * 풀린 docx 엔트리에서 표 수와 이미지 수를 센다.
 * - 표 수: word/document.xml 안 '<w:tbl' 패턴 개수 (띄어쓰기 or '>' 뒤 모두 포함)
 * - 이미지 수: 'word/media/' 경로로 시작하는 zip 엔트리 수
 */
function inspectDocxEntries(
  entries: UnzippedEntries,
): { tableCount: number; imageCount: number } {
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
