/**
 * ingest-form 단위 테스트 (Phase 14b T6 / Phase 11a T6 합류).
 *
 * 검증 정신 — mock 0:
 *   대상은 ingest-form.js 의 *순수 로직* 뿐이다 — 태그 추출(extractHashtags),
 *   payload 조립(buildTextPayload / buildFilePayload), detection 풀이(describeDetection),
 *   image 응답 풀이(describeImageResult), image mime 식별(isImageMimeClient).
 *   fetch / FileReader / DOM 부수효과(mountIngestForm)는 단위 테스트에서 안 건드린다
 *   (그 통로는 curl sanity + 사용자 수동 sanity 가 맡는다). 그래서 fetch mock 도, 가짜
 *   인터페이스 구현도 만들지 않는다 — fixture 데이터를 넣어 반환값만 확인한다.
 *
 * 검증 갈래:
 *   1) extractHashtags — 태그 추출 / 중복 제거 / 순서 보존 / 한글·영문·숫자 / 빈 입력.
 *   2) buildTextPayload — type="text" + mimeType 없음(14a 핫픽스 정합) + attribution + hashtags 분기.
 *   3) buildFilePayload — type="auto" + mimeType/originalName + base64 + hashtags 분기.
 *   4) describeDetection — kind 라벨 + 약속한 칸만 풀이 + scannedPdf 안내.
 *   5) classifyFileKind — 텍스트/바이너리 가르기(봇 classifyAttachment 정합 — mime → 확장자).
 *   6) buildTextFilePayload — type="text" + 글자 그대로(base64 아님) + mimeType/originalName 보존.
 *      ← 텍스트 파일을 base64-as-content 로 저장하던 버그의 재발 차단이 핵심.
 *   7) isImageMimeClient — Phase 11a 합류. 지원 image mime 5 (png/jpeg/gif/webp/apng) 식별.
 *      서버 ingest-image.ts SUPPORTED_IMAGE_MIMES 와 같은 묶음 — 두 권위 수동 정합 (정착 한국어 룰 정합).
 *   8) describeImageResult — Phase 11a 합류. images 응답 객체 → 한 줄 배열 풀이.
 *      자산 sha256 / 미리보기 sha256 / 가로×세로 / 움직임 / 경고 한 줄씩. 자산 fetch 라우트
 *      미정착 자리라 미리보기는 sha 한 줄 표시 (정직한 표시 정신 — 라우트 없음을 인라인 <img>
 *      깨진 src 로 위장하지 않음).
 */

import { describe, test, expect } from "bun:test";
import {
  extractHashtags,
  buildTextPayload,
  buildFilePayload,
  buildTextFilePayload,
  classifyFileKind,
  describeDetection,
  describeExtractionStatus,
  describeImageResult,
  isImageMimeClient,
  isValidNumericInput,
  SUPPORTED_IMAGE_MIMES_CLIENT,
  DASHBOARD_SOURCE,
  DASHBOARD_ATTRIBUTION,
} from "./ingest-form.js";
// 코어 mime 권위 — 클라이언트 묶음과 정합 대조용 (Phase 11d D6 단일 권위).
import { SUPPORTED_IMAGE_MIMES as CORE_SUPPORTED_IMAGE_MIMES } from "../../src/memory/image-mime.ts";

describe("extractHashtags — #태그 추출", () => {
  test("한글·영문·숫자·밑줄 태그를 추린다", () => {
    const tags = extractHashtags("오늘 #작업컴퓨터 견적 #PC2025 #ram_16gb 정리");
    expect(tags).toEqual(["작업컴퓨터", "PC2025", "ram_16gb"]);
  });

  test("중복 태그는 첫 등장만 남기고 순서를 보존한다", () => {
    const tags = extractHashtags("#회의 메모 #일정 그리고 다시 #회의");
    expect(tags).toEqual(["회의", "일정"]);
  });

  test("문장부호·공백에서 태그가 끊긴다", () => {
    const tags = extractHashtags("#태그1, #태그2. #태그3!");
    expect(tags).toEqual(["태그1", "태그2", "태그3"]);
  });

  test("콜론 태그는 값까지 보존한다", () => {
    const tags = extractHashtags("#프로젝트:바라 시스템 #회의, 본문");
    expect(tags).toEqual(["프로젝트:바라 시스템", "회의"]);
  });

  test("콜론 태그 값은 쉼표 앞에서 끊어 파일 분류로 보낸다", () => {
    const tags = extractHashtags(
      "#컴퓨터사양:작업컴, 주로 사용하는 작업 컴퓨터의 그래픽카드는 4080S",
    );
    expect(tags).toEqual(["컴퓨터사양:작업컴"]);
  });

  test("태그가 없으면 빈 배열", () => {
    expect(extractHashtags("그냥 평범한 메모입니다")).toEqual([]);
  });

  test("빈 문자열·비문자열은 빈 배열", () => {
    expect(extractHashtags("")).toEqual([]);
    // 비문자열 입력 방어 확인
    expect(extractHashtags(null)).toEqual([]);
  });
});

describe("buildTextPayload — 글만 보낼 때", () => {
  test("type='text' + mimeType 없음 + source + attribution", () => {
    const payload = buildTextPayload("간단한 메모");
    expect(payload.source).toBe(DASHBOARD_SOURCE);
    expect(payload.content).toEqual({ type: "text", data: "간단한 메모" });
    // 14a 핫픽스 정합: type='text' 면 mimeType 을 안 보낸다(라우트가 text/markdown 으로 채움).
    expect("mimeType" in payload.content).toBe(false);
    expect(payload.attribution).toEqual(DASHBOARD_ATTRIBUTION);
    // 태그 없으면 hashtags 칸 자체가 없다.
    expect("hashtags" in payload).toBe(false);
  });

  test("입력 글의 #태그는 hashtags 칸으로 함께 전달(원문은 그대로 보존)", () => {
    const payload = buildTextPayload("점심 #식단 기록 #건강");
    expect(payload.content.data).toBe("점심 #식단 기록 #건강"); // 원문 보존
    expect(payload.hashtags).toEqual(["식단", "건강"]);
  });

  test("입력 글의 줄바꿈은 payload 에 그대로 남긴다", () => {
    const raw = "첫 줄\n\n둘째 줄\n셋째 줄";
    const payload = buildTextPayload(raw);
    expect(payload.content.data).toBe(raw);
  });

  test("attribution 은 매 호출 새 객체(공유 mutation 방지)", () => {
    const a = buildTextPayload("a");
    const b = buildTextPayload("b");
    expect(a.attribution).not.toBe(b.attribution);
    expect(a.attribution).toEqual(b.attribution);
  });
});

describe("buildFilePayload — 파일 보낼 때", () => {
  test("type='auto' + base64 + mimeType + originalName", () => {
    const payload = buildFilePayload({
      base64: "QUJD",
      mimeType: "application/pdf",
      originalName: "회의록.pdf",
    });
    expect(payload.source).toBe(DASHBOARD_SOURCE);
    expect(payload.content).toEqual({
      type: "auto",
      data: "QUJD",
      mimeType: "application/pdf",
      originalName: "회의록.pdf",
    });
    expect(payload.attribution).toEqual(DASHBOARD_ATTRIBUTION);
    expect("hashtags" in payload).toBe(false);
  });

  test("hashtags 가 있으면 파일에도 함께 단다", () => {
    const payload = buildFilePayload(
      { base64: "QQ==", mimeType: "text/markdown", originalName: "노트.md" },
      ["프로젝트:바라", "메모"],
    );
    expect(payload.hashtags).toEqual(["프로젝트:바라", "메모"]);
  });

  test("attachToNodeId 가 있으면 파일 payload options 로 싣는다", () => {
    const payload = buildFilePayload(
      { base64: "QQ==", mimeType: "image/png", originalName: "사진.png" },
      ["컴퓨터사양:작업컴"],
      42,
    );
    expect(payload.options).toEqual({ attachToNodeId: 42 });
  });
});

describe("classifyFileKind — 텍스트/바이너리 가르기", () => {
  test("text/plain · text/markdown mime 은 kind='text' + 확정 mimeType", () => {
    expect(classifyFileKind("메모.txt", "text/plain")).toEqual({
      kind: "text",
      mimeType: "text/plain",
    });
    expect(classifyFileKind("노트.md", "text/markdown")).toEqual({
      kind: "text",
      mimeType: "text/markdown",
    });
  });

  test("charset 파라미터가 붙은 contentType 도 텍스트로 본다", () => {
    expect(classifyFileKind("메모.txt", "text/plain; charset=utf-8")).toEqual({
      kind: "text",
      mimeType: "text/plain",
    });
  });

  test(".txt · .md 확장자는 mime 없어도 확장자 fallback 으로 kind='text'", () => {
    expect(classifyFileKind("메모.txt", "")).toEqual({
      kind: "text",
      mimeType: "text/plain",
    });
    expect(classifyFileKind("노트.md", "")).toEqual({
      kind: "text",
      mimeType: "text/markdown",
    });
    // mime 이 octet-stream 으로 와도 확장자가 .md 면 텍스트로 fallback.
    expect(classifyFileKind("노트.md", "application/octet-stream")).toEqual({
      kind: "text",
      mimeType: "text/markdown",
    });
  });

  test("PDF·docx 는 kind='binary' (입력 mimeType 그대로)", () => {
    expect(classifyFileKind("회의록.pdf", "application/pdf")).toEqual({
      kind: "binary",
      mimeType: "application/pdf",
    });
    const docxMime =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(classifyFileKind("문서.docx", docxMime)).toEqual({
      kind: "binary",
      mimeType: docxMime,
    });
    // mime 없이 확장자만 .pdf 여도 텍스트가 아니라 binary 통로.
    expect(classifyFileKind("회의록.pdf", "")).toEqual({
      kind: "binary",
      mimeType: "",
    });
  });

  test("모르는 형식도 binary 로 보낸다(라우트 detection/warnings 가 정직하게 응답)", () => {
    expect(classifyFileKind("사진.png", "image/png")).toEqual({
      kind: "binary",
      mimeType: "image/png",
    });
  });
});

describe("buildTextFilePayload — 텍스트 파일(.txt·.md) 보낼 때", () => {
  test("content.type='text' + data 가 입력 텍스트 원문 그대로 + mimeType/originalName 보존", () => {
    const payload = buildTextFilePayload({
      text: "# 제목\n본문 줄",
      mimeType: "text/markdown",
      originalName: "노트.md",
    });
    expect(payload.source).toBe(DASHBOARD_SOURCE);
    // 재발 차단 핵심 단언: type 은 'text' 여야 한다(절대 'auto'/base64 아님).
    expect(payload.content.type).toBe("text");
    expect(payload.content.type).not.toBe("auto");
    // 글자 그대로 — base64 인코딩 안 함.
    expect(payload.content.data).toBe("# 제목\n본문 줄");
    expect(payload.content.mimeType).toBe("text/markdown");
    expect(payload.content.originalName).toBe("노트.md");
    expect(payload.attribution).toEqual(DASHBOARD_ATTRIBUTION);
    expect("hashtags" in payload).toBe(false);
  });

  test("hashtags 가 있으면 파일에도 함께 단다", () => {
    const payload = buildTextFilePayload(
      { text: "회의 메모", mimeType: "text/plain", originalName: "회의.txt" },
      ["회의", "메모"],
    );
    expect(payload.content.type).toBe("text");
    expect(payload.hashtags).toEqual(["회의", "메모"]);
  });

  test("attachToNodeId 가 있으면 텍스트 파일 payload options 로 싣는다", () => {
    const payload = buildTextFilePayload(
      { text: "첨부 설명", mimeType: "text/plain", originalName: "설명.txt" },
      [],
      77,
    );
    expect(payload.options).toEqual({ attachToNodeId: 77 });
  });

  test("attribution 은 매 호출 새 객체(공유 mutation 방지)", () => {
    const a = buildTextFilePayload({ text: "a", mimeType: "text/plain", originalName: "a.txt" });
    const b = buildTextFilePayload({ text: "b", mimeType: "text/plain", originalName: "b.txt" });
    expect(a.attribution).not.toBe(b.attribution);
    expect(a.attribution).toEqual(b.attribution);
  });
});

describe("describeDetection — 정직한 검출 풀이", () => {
  test("passthrough — 형식 라벨 + 글자수", () => {
    const lines = describeDetection({ kind: "passthrough", extractedCharCount: 42 });
    expect(lines).toContain("형식: 텍스트/마크다운");
    expect(lines).toContain("추출 글자수: 42");
  });

  test("스캔 PDF — scannedPdf 안내 노출(검색 안 됨 정직 표시)", () => {
    const lines = describeDetection({
      kind: "pdf",
      extractedCharCount: 0,
      pageCount: 3,
      scannedPdf: true,
    });
    expect(lines).toContain("형식: PDF");
    expect(lines).toContain("페이지: 3");
    expect(lines.some((l) => l.includes("스캔본"))).toBe(true);
  });

  test("docx — 표·삽입 이미지 개수", () => {
    const lines = describeDetection({
      kind: "docx",
      extractedCharCount: 500,
      tableCount: 2,
      embeddedImageCount: 1,
    });
    expect(lines).toContain("표: 2개");
    expect(lines).toContain("삽입 이미지: 1개");
  });

  test("약속하지 않은 칸은 풀이에 안 나온다(PDF tableCount 없음)", () => {
    const lines = describeDetection({ kind: "pdf", extractedCharCount: 10, pageCount: 1 });
    expect(lines.some((l) => l.startsWith("표:"))).toBe(false);
  });

  test("detection 이 없으면 빈 배열", () => {
    expect(describeDetection(null)).toEqual([]);
    expect(describeDetection(undefined)).toEqual([]);
  });
});

describe("describeExtractionStatus — 추출 상태 정직 표시 (Task 7 / D8)", () => {
  test("짧은 글 immediate 추출 — 의미추출 완료 M개", () => {
    const lines = describeExtractionStatus({
      type: "text",
      extracted: [101, 102],
      bumped: [],
      pendingChunks: 0,
    });
    expect(lines).toContain("의미추출 완료 2개");
    // 대기·합쳐짐 줄은 0 이라 안 나온다.
    expect(lines.some((l) => l.includes("추출 대기"))).toBe(false);
    expect(lines.some((l) => l.includes("합쳐짐"))).toBe(false);
  });

  test("긴 문서 — 추출 대기 N개 (비동기 backfill 정직 표시 — 완료 위장 안 함)", () => {
    const lines = describeExtractionStatus({
      type: "text",
      extracted: [],
      bumped: [],
      pendingChunks: 5,
    });
    expect(lines.some((l) => l.includes("추출 대기 5개"))).toBe(true);
    // 대기를 "완료"로 위장하지 않는다 — 완료 줄은 안 나온다.
    expect(lines.some((l) => l.includes("의미추출 완료"))).toBe(false);
  });

  test("추출 + 대기 + 합쳐짐 동시 — 세 줄 모두 정직 노출", () => {
    const lines = describeExtractionStatus({
      type: "text",
      extracted: [1, 2, 3],
      bumped: [9],
      pendingChunks: 2,
    });
    expect(lines).toContain("의미추출 완료 3개");
    expect(lines).toContain("추출 대기 2개 (주기마다 자동 처리)");
    expect(lines).toContain("기존 메모 1개에 합쳐짐");
  });

  test("추출 0 + 대기 0 — 줄 0 (없는 걸 '0개'로 떠벌리지 않음)", () => {
    const lines = describeExtractionStatus({
      type: "text",
      extracted: [],
      bumped: [],
      pendingChunks: 0,
    });
    expect(lines).toEqual([]);
  });

  test("긴 문서 응답(documentId + pendingChunks) — 추출 대기 줄만 (extracted/bumped 칸 없음)", () => {
    // PDF·docx·.txt/.md 파일 갈래 응답 — 라우트가 pendingChunks 만 싣고 extracted/bumped 는
    // 없다(spec §5 일관성). describeExtractionStatus 가 없는 칸을 방어하므로 대기 줄만 나온다.
    const lines = describeExtractionStatus({
      ok: true,
      documentId: "doc_abc",
      nodeIds: [10, 11, 12],
      detection: { kind: "pdf", extractedCharCount: 4000, pageCount: 8 },
      pendingChunks: 2,
    });
    expect(lines).toEqual(["추출 대기 2개 (주기마다 자동 처리)"]);
  });

  test("스캔 PDF 등 청크 0 문서 응답 — 추출 대기 줄 없음 (없는 걸 떠벌리지 않음)", () => {
    const lines = describeExtractionStatus({
      ok: true,
      documentId: "doc_scan",
      nodeIds: [20],
      detection: { kind: "pdf", extractedCharCount: 0, scannedPdf: true },
      pendingChunks: 0,
    });
    expect(lines).toEqual([]);
  });

  test("pendingChunks 칸 자체가 없으면(옛 응답) 빈 배열 (없는 정보 지어내지 않음)", () => {
    expect(describeExtractionStatus({ documentId: "doc-1", detection: {} })).toEqual([]);
    expect(describeExtractionStatus({})).toEqual([]);
  });

  test("비객체 입력 — 빈 배열 (방어)", () => {
    expect(describeExtractionStatus(null)).toEqual([]);
    expect(describeExtractionStatus(undefined)).toEqual([]);
  });

  test("pendingChunks 가 음수·비숫자면 대기 줄 안 만든다 (방어)", () => {
    // 비숫자 방어 확인
    expect(describeExtractionStatus({ extracted: [], pendingChunks: "3" })).toEqual([]);
    expect(describeExtractionStatus({ extracted: [], pendingChunks: -1 })).toEqual([]);
  });

  test("extracted·bumped 가 비배열이면 그 줄 안 만든다 (방어)", () => {
    const lines = describeExtractionStatus({
      // 비배열 방어 확인
      extracted: null,
      // 비배열 방어 확인
      bumped: 5,
      pendingChunks: 0,
    });
    expect(lines).toEqual([]);
  });
});

describe("isImageMimeClient — Phase 11a/11d image mime 식별", () => {
  test("지원 image mime 6 (png/jpeg/gif/webp/apng/avif) 모두 true", () => {
    expect(isImageMimeClient("image/png")).toBe(true);
    expect(isImageMimeClient("image/jpeg")).toBe(true);
    expect(isImageMimeClient("image/gif")).toBe(true);
    expect(isImageMimeClient("image/webp")).toBe(true);
    expect(isImageMimeClient("image/apng")).toBe(true);
    expect(isImageMimeClient("image/avif")).toBe(true); // 11d D6 합류
  });

  test("charset 등 파라미터 붙은 mime 도 본체로 식별", () => {
    expect(isImageMimeClient("image/png; charset=binary")).toBe(true);
    expect(isImageMimeClient("IMAGE/JPEG")).toBe(true); // 대소문자 무관
    expect(isImageMimeClient("image/avif; foo=bar")).toBe(true);
  });

  test("지원 안 하는 image mime 은 false (서버 측 권위와 정합)", () => {
    // svg / bmp / tiff / heic — 11d 범위 밖 (heic 는 §8 제외 결정).
    expect(isImageMimeClient("image/svg+xml")).toBe(false);
    expect(isImageMimeClient("image/bmp")).toBe(false);
    expect(isImageMimeClient("image/heic")).toBe(false);
  });

  test("image 아닌 mime 은 false", () => {
    expect(isImageMimeClient("application/pdf")).toBe(false);
    expect(isImageMimeClient("text/plain")).toBe(false);
    expect(isImageMimeClient("")).toBe(false);
    // 비문자열 입력 방어 확인
    expect(isImageMimeClient(null)).toBe(false);
  });

  test("SUPPORTED_IMAGE_MIMES_CLIENT 묶음에 정확히 6 개 + avif 포함", () => {
    expect(SUPPORTED_IMAGE_MIMES_CLIENT.size).toBe(6);
    expect(SUPPORTED_IMAGE_MIMES_CLIENT.has("image/png")).toBe(true);
    expect(SUPPORTED_IMAGE_MIMES_CLIENT.has("image/jpeg")).toBe(true);
    expect(SUPPORTED_IMAGE_MIMES_CLIENT.has("image/gif")).toBe(true);
    expect(SUPPORTED_IMAGE_MIMES_CLIENT.has("image/webp")).toBe(true);
    expect(SUPPORTED_IMAGE_MIMES_CLIENT.has("image/apng")).toBe(true);
    expect(SUPPORTED_IMAGE_MIMES_CLIENT.has("image/avif")).toBe(true);
  });

  // ── Phase 11d D6: 클라이언트 묶음 ↔ 코어 권위 정합 (단일 권위 대조) ──
  // 대시보드는 브라우저 ES 모듈이라 .ts 코어를 import 못 해 묶음을 손으로 정합한다.
  // 이 테스트가 가벼운 코어 SUPPORTED_IMAGE_MIMES 를 직접 import 해 한 글자도 안 어긋나는지
  // 대조 — 두 곳이 갈라지면 여기서 빨갛게 잡힌다.
  test("코어 SUPPORTED_IMAGE_MIMES 와 글자 그대로 정합", () => {
    const coreSorted = [...CORE_SUPPORTED_IMAGE_MIMES].sort();
    const clientSorted = [...SUPPORTED_IMAGE_MIMES_CLIENT].sort();
    expect(clientSorted).toEqual(coreSorted);
  });
});

describe("describeImageResult — Phase 11a image 응답 풀이", () => {
  test("정지 이미지 — sha / 미리보기 sha / 가로×세로 / 움직임 없음 / 경고 없음", () => {
    const lines = describeImageResult({
      assetSha256: "abc1234567890def" + "0".repeat(48),
      thumbSha256: "thumb1234567890" + "0".repeat(49),
      nodeId: 42,
      width: 1024,
      height: 768,
      isAnimated: false,
      warnings: [],
      mime: "image/jpeg",
    });
    // 자산 sha 한 줄 (전체 sha 포함 — 사용자 복사 가능 / 위장 0).
    expect(lines.some((l) => l.includes("자산 sha256"))).toBe(true);
    expect(lines.some((l) => l.includes("abc1234567890def"))).toBe(true);
    // 미리보기 sha 한 줄.
    expect(lines.some((l) => l.includes("미리보기 sha256"))).toBe(true);
    expect(lines.some((l) => l.includes("thumb1234567890"))).toBe(true);
    // 가로×세로 표기.
    expect(lines.some((l) => l.includes("1024 × 768"))).toBe(true);
    // mime 노출.
    expect(lines.some((l) => l.includes("image/jpeg"))).toBe(true);
    // 움직임 없음 — "움직이는 이미지" 줄 안 나옴.
    expect(lines.some((l) => l.includes("움직이는 이미지"))).toBe(false);
  });

  test("움직이는 이미지 — '움직이는 이미지' 줄 합류", () => {
    const lines = describeImageResult({
      assetSha256: "g".repeat(64),
      thumbSha256: "h".repeat(64),
      nodeId: 7,
      width: 320,
      height: 240,
      isAnimated: true,
      warnings: [],
      mime: "image/gif",
    });
    expect(lines.some((l) => l.includes("움직이는 이미지"))).toBe(true);
    expect(lines.some((l) => l.includes("320 × 240"))).toBe(true);
  });

  test("warnings 배열 — 한 줄씩 풀이 표시", () => {
    const lines = describeImageResult({
      assetSha256: "x".repeat(64),
      thumbSha256: "y".repeat(64),
      nodeId: 1,
      width: 4096,
      height: 3072,
      isAnimated: true,
      warnings: [
        "원본 움직이는 이미지 — 첫 프레임 정지 PNG 사본 한 한 보관.",
        "큰 이미지 — smart 분기로 축소된 사본 저장.",
      ],
      mime: "image/png",
    });
    expect(lines.some((l) => l.includes("첫 프레임 정지 PNG"))).toBe(true);
    expect(lines.some((l) => l.includes("smart 분기로 축소"))).toBe(true);
    // 경고 표시 prefix 가 사용자에게 정직하게 noticeable (⚠ 등).
    const warningLines = lines.filter((l) => l.includes("첫 프레임 정지 PNG"));
    expect(warningLines.length).toBe(1);
    expect(warningLines[0]!.startsWith("⚠")).toBe(true);
  });

  test("warnings 빈 배열 — 경고 줄 0 (정상 갈래 정직 표시)", () => {
    const lines = describeImageResult({
      assetSha256: "a".repeat(64),
      thumbSha256: "b".repeat(64),
      nodeId: 1,
      width: 256,
      height: 256,
      isAnimated: false,
      warnings: [],
      mime: "image/png",
    });
    // ⚠ prefix 줄 0.
    expect(lines.some((l) => l.startsWith("⚠"))).toBe(false);
  });

  test("warnings 비배열 (방어) — 경고 줄 0", () => {
    const lines = describeImageResult({
      assetSha256: "a".repeat(64),
      thumbSha256: "b".repeat(64),
      nodeId: 1,
      width: 100,
      height: 100,
      isAnimated: false,
      // 비배열 방어 확인
      warnings: null,
      mime: "image/png",
    });
    expect(lines.some((l) => l.startsWith("⚠"))).toBe(false);
  });

  test("입력이 비객체 — 빈 배열 (silent fallback 정합 — 위장 0)", () => {
    expect(describeImageResult(null)).toEqual([]);
    expect(describeImageResult(undefined)).toEqual([]);
  });
});

// ──────────────────────────────────────────────
// 9. isValidNumericInput — 폼 숫자형 칸 입력 검증 (단계6b T4)
// ──────────────────────────────────────────────
describe("isValidNumericInput — 숫자형 칸 입력 검증", () => {
  test("순수 숫자·콤마·소수점·부호 허용(parseNumericFieldValue 정합)", () => {
    expect(isValidNumericInput("3000")).toBe(true);
    expect(isValidNumericInput("3,000")).toBe(true);
    expect(isValidNumericInput("1,234.56")).toBe(true);
    expect(isValidNumericInput("-5")).toBe(true);
    expect(isValidNumericInput("+12.5")).toBe(true);
  });

  test("빈 문자열·공백은 유효(미입력은 거부 대상 아님)", () => {
    expect(isValidNumericInput("")).toBe(true);
    expect(isValidNumericInput("   ")).toBe(true);
  });

  test("입력 중간 상태(부호만·소수점 끝)도 타이핑 막지 않음", () => {
    expect(isValidNumericInput("-")).toBe(true);
    expect(isValidNumericInput("12.")).toBe(true);
    expect(isValidNumericInput(".")).toBe(true);
  });

  test("한글·단위 문자가 섞이면 거부(폼 입력값 항상 파싱 가능)", () => {
    expect(isValidNumericInput("비쌈")).toBe(false);
    expect(isValidNumericInput("3000원")).toBe(false);
    expect(isValidNumericInput("12kg")).toBe(false);
    expect(isValidNumericInput("abc")).toBe(false);
  });

  test("비문자열 입력은 거부(방어)", () => {
    // 비문자열 입력 방어 확인
    expect(isValidNumericInput(123)).toBe(false);
    // 비문자열 입력 방어 확인
    expect(isValidNumericInput(null)).toBe(false);
  });
});
