/**
 * document-placeholder-content.ts — 본문 글자가 없는 문서(스캔 PDF·파싱 실패)의 문서 노드 본문 문구와 판별.
 *
 * 문서 노드는 본문이 같으면 하나로 합쳐진다(content_hash 흡수 — 글자가 있는 문서의 의도된 중복 제거, 설계
 * 2026-09-29-source-provenance-design.md §2.1·17.17·17.18 D32). 옛 흐름은 글자가 없는 문서의 본문을 파일 이름으로만
 * 채워서, 이름만 같은 다른 스캔본끼리, 또 파일 이름과 같은 글을 가진 평범한 기억과 문서가 하나로 합쳐졌다.
 *
 * 그래서 대기 본문은 "파일 이름 + 상태 문구 + 원본 파일 전체 sha256" 세 줄로 만든다(사용자 결정 2026-10-12).
 *   - 이름과 바이트가 같으면 → 같은 본문 → 노드 하나(같은 파일을 같은 이름으로 다시 올림).
 *   - 이름이 같아도 바이트가 다르면 → 본문이 달라 노드가 따로 생긴다.
 *   - 바이트가 같아도 이름이 다르면 → 노드가 따로 생기고 글자 인식도 따로 한다(드문 경우라 받아들인 비용).
 *   - 평범한 기억과 우연히 같아질 일은 사실상 없다(64자리 sha 포함).
 * 첫 줄이 파일 이름이라, 본문만 담는 색인(글자·의미)과 본문 첫 줄을 제목으로 쓰는 화면(최근 목록·그래프 이름표)에
 * 대기 중에도 파일 이름이 잡힌다(POST /search 응답은 글자 인식이 안 끝난 문서를 일부러 뺀다 — 별개 설계). 글자 인식(OCR) 결과를 붙이면 본문 전체가 그 글로
 * 바뀌어(applyOcrMarkdownToDocument → editNodeContent) 이 문구는 사라진다.
 */

/** 대기 본문의 종류 — 스캔 문서(글자 인식 대기)와 파싱 실패. */
export type DocumentPlaceholderKind = "ocr_pending" | "parse_failed";

/**
 * 종류별 상태 문구(둘째 줄). 이 영역 문구의 단일 출처.
 *
 * 주의: 이 문구와 아래 sha 앞머리는 대기 본문의 일부라 본문 중복 제거 열쇠(content_hash)에 들어간다. 바꾸면 바꾸기
 * 전에 올린 같은 파일을 다시 올렸을 때 옛 노드에 합쳐지지 않고 새 노드가 생긴다(합쳐짐 동작이 바뀐다). 화면 문구를
 * 다듬는 일과 다르니, 바꿀 때는 그 영향을 함께 결정한다.
 */
export const DOCUMENT_PLACEHOLDER_STATUS_TEXT: Readonly<Record<DocumentPlaceholderKind, string>> = {
  ocr_pending: "스캔 문서 · 글자 인식 대기",
  parse_failed: "읽지 못한 문서 · 파싱 실패, 원본만 보존",
};

/** 셋째 줄 앞머리 — 뒤에 원본 파일 전체 sha256(소문자 16진수 64자리)이 온다. 중복 제거 열쇠의 일부(위 주의 참조). */
export const DOCUMENT_PLACEHOLDER_SHA_PREFIX = "원본 sha256 ";

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** 줄 끝 문자 전부 — \n·\r·\v·\f 와 유니코드 줄 끝(U+0085 NEL, U+2028 줄 구분, U+2029 문단 구분). */
const LINE_BREAKS = /\s*[\n\r\v\f\u0085\u2028\u2029]+\s*/g;

/** 첫 줄에 넣을 파일 이름 — 줄 끝 문자는 공백으로 바꿔 본문이 어떤 줄 나눔 기준으로도 늘 세 줄이게 한다. */
function titleLine(title: string): string {
  return title.replace(LINE_BREAKS, " ").trim();
}

/**
 * 대기 본문을 만든다. 제목이 비었거나 sha 가 sha256 16진수 64자리가 아니면 호출 결함이라 멈춘다(호출처는 늘 파일
 * 이름이나 대체 제목을 넘긴다).
 */
export function buildDocumentPlaceholderContent(kind: DocumentPlaceholderKind, title: string, originalSha256: string): string {
  const line = titleLine(title);
  if (line.length === 0) throw new Error("문서 대기 본문을 만들 제목이 비어 있음 (파일 이름이나 대체 제목이 필요함)");
  if (!SHA256_HEX.test(originalSha256)) {
    throw new Error(`문서 대기 본문을 만들 원본 sha256 이 올바르지 않음: "${originalSha256}" (소문자 16진수 64자리여야 함)`);
  }
  return `${line}\n${DOCUMENT_PLACEHOLDER_STATUS_TEXT[kind]}\n${DOCUMENT_PLACEHOLDER_SHA_PREFIX}${originalSha256}`;
}
