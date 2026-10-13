/**
 * ingest-form.js — 대시보드 메인 화면 채팅창 입력 폼 (Phase 14b T6 / 결정 1·4).
 *
 * 메인 화면에서 문서·메모를 *넣는* 통로다. 채팅창 한 줄 + [+] 첨부 + 드래그앤드롭 +
 * 전송으로 14a POST /ingest 라우트를 호출한다. 빌드 도구 없이 브라우저가 그대로 읽는
 * ES 모듈이다. 전송 상태는 빌드된 ingest-submission.js 가 담당한다. 순수 로직(태그 추출·
 * payload 조립)은 export 해 단위 테스트(ingest-form.test.ts)가 fixture 데이터로 검증한다.
 *
 * 결정 1 — 진행 표시 = 동기 응답 + "처리 중" 로더. SSE·polling 없음. POST /ingest 가
 *   끝나면 결과(저장 + warnings/detection)를 한 번에 받고, 그 사이 로더 + 안내만 보인다.
 * 결정 4 — 입력 폼 = 메인 화면 통합. 별 페이지 아님. 한 줄 채팅창 + [+] 버튼 + 드래그앤드롭.
 *
 * 정직한 표시:
 *   - 응답 warnings(스캔 PDF "검색 안 됨" / PDF 표 "글자 뒤섞일 수 있음" / docx 표 검색 됨 등)
 *     를 그대로 노출한다 — 빈 결과로 위장하지 않는다.
 *   - 비2xx·예외는 구체 에러 사유를 보여 준다(silent fallback 금지).
 *
 * Attribution: 라우트가 attribution 을 optional(author/userId 기본 "")로 받는다. 대시보드는
 *   작성자 추적(spec 4.5 — 모듈 정상 기능)을 위해 author="dashboard", userId="owner" 를 보낸다.
 *   #태그는 입력 글에서 추려 hashtags 칸으로 전달한다(개념 승격은 14.9 — 여기선 전달까지).
 */

import { createIngestSubmission } from "./ingest-submission.js";
// 미리보기 패널(S7)·# 자동완성(S6)·종류 칸 자동 표시(결정 6) 배선은 보조 파일로 뗐다(S8·파일 작게).
import { wireIngestExtras } from "./graph/input/wire-ingest-form.js";
// 숫자형 칸 입력 검증은 numeric-input.js 단일 출처에서 가져온다(순환 차단·S1). 옛 import
// 계약(ingest-form.js 에서 isValidNumericInput)을 깨지 않으려 여기서 그대로 re-export 한다.
import { isValidNumericInput } from "./numeric-input.js";

export { isValidNumericInput };

// ── 상수 (출처·attribution — 하드코딩 금지 규칙: 의미 있는 식별자는 한 곳에 모은다) ──
export const DASHBOARD_SOURCE = "dashboard:manual";
// author 는 빈 문자열 — 대시보드 수동 입력은 소유자 본인 글이라, 채널 이름이
// 작성자 사람으로 굳지 않게 한다. linkAuthorPerson 은 author 가 비면 no-op 이라
// 별도 작성자 사람 노드를 만들지 않는다(출처는 platform DASHBOARD_SOURCE 로만 남음).
export const DASHBOARD_ATTRIBUTION = { author: "", userId: "owner" };

// 한국어·영문·숫자·밑줄을 한 태그 키로 본다. 콜론 태그는 값까지 보존한다.
const HASHTAG_KEY_RE = /[0-9A-Za-z_가-힣㄰-㆏-]/;

// ── mime / 확장자 상수 (봇 attachment-ingest.ts 판정 규칙 정합) ──────────────
const MIME_TEXT_PLAIN = "text/plain";
const MIME_TEXT_MARKDOWN = "text/markdown";

/**
 * 지원 image mime 6 종 — Phase 11a T6 / 11d D6 클라이언트 측 묶음.
 * 서버 `apps/memory/src/memory/image-mime.ts` 안 `SUPPORTED_IMAGE_MIMES` 가
 * 코어 권위이고, 이 묶음은 그것과 글자 그대로 정합해야 한다. 빌드 도구 없이
 * 브라우저가 그대로 읽는 ES 모듈이라 .ts 권위에서 import 안 한다 — 이 자리에서
 * 직접 작성하되, ingest-form.test.ts 의 정합 테스트가 코어 SUPPORTED_IMAGE_MIMES
 * 를 import 해 이 묶음과 한 글자도 안 어긋나는지 대조한다.
 *
 * 두 묶음이 어긋나도 사용자 입력이 서버 분기에서 silent 한 갈래로 흐르지는 않는다
 * — 서버가 isImageMime 으로 한 번 더 검사 후 throw / 라우트 분기를 하므로 클라이언트
 * 측은 *식별 + 응답 분기* 한정. Phase 11d D6: avif 합류.
 */
export const SUPPORTED_IMAGE_MIMES_CLIENT = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/apng",
  "image/avif",
]);

// ── 순수 로직 (단위 테스트 대상) ──────────────────────────────────────────────

/** contentType 에서 charset 등 파라미터를 떼고 소문자 mime 본체만 남긴다(봇 baseMime 정합). */
function baseMime(contentType) {
  if (!contentType || typeof contentType !== "string") return "";
  const semi = contentType.indexOf(";");
  const head = semi === -1 ? contentType : contentType.slice(0, semi);
  return head.trim().toLowerCase();
}

/** 파일 이름에서 소문자 확장자(".pdf" 형태)를 뽑는다(봇 extOf 정합). */
function extOf(name) {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx).toLowerCase();
}

/**
 * 입력 글에서 `#태그` / `#키:값` 을 추려 중복 없는 배열로 돌려준다.
 * 콜론 태그 값은 다음 쉼표·줄바꿈·다음 `#` 전까지 보존한다. 순서는 첫 등장 순서를
 * 보존한다. 파일 첨부 시 이 배열만 서버로 넘어가므로 `#프로젝트:바라` 의 `:바라`
 * 부분을 잃으면 문서 project_id 를 복구할 수 없다.
 * @param {string} text
 * @returns {string[]}
 */
export function extractHashtags(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const seen = new Set();
  const out = [];

  let i = 0;
  while (i < text.length) {
    if (text[i] !== "#") {
      i += 1;
      continue;
    }
    const keyStart = i + 1;
    if (!HASHTAG_KEY_RE.test(text[keyStart] ?? "")) {
      i += 1;
      continue;
    }

    let keyEnd = keyStart;
    while (HASHTAG_KEY_RE.test(text[keyEnd] ?? "")) keyEnd += 1;

    let tag = text.slice(keyStart, keyEnd);
    let end = keyEnd;
    if (text[keyEnd] === ":") {
      const valueStart = keyEnd + 1;
      const rest = text.slice(valueStart);
      const boundary = rest.search(/[,\n#]/);
      end = boundary === -1 ? text.length : valueStart + boundary;
      const value = text.slice(valueStart, end).trim();
      if (value.length > 0) tag = `${tag}:${value}`;
    }

    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
    i = end;
  }
  return out;
}

/**
 * 글만 보내는 경우의 POST /ingest body 를 조립한다.
 * 14a 핫픽스 정합: content.type="text" + mimeType 없음 → 라우트가 text/markdown 으로 채운다.
 * @param {string} text  입력 글(태그 포함 원문 그대로 보낸다 — 라우트가 원문 보존).
 * @returns {object}
 */
export function buildTextPayload(text) {
  const hashtags = extractHashtags(text);
  const payload = {
    source: DASHBOARD_SOURCE,
    content: { type: "text", data: text },
    attribution: { ...DASHBOARD_ATTRIBUTION },
  };
  if (hashtags.length > 0) payload.hashtags = hashtags;
  return payload;
}

function attachOptions(attachToNodeId) {
  if (
    typeof attachToNodeId !== "number" ||
    !Number.isInteger(attachToNodeId) ||
    attachToNodeId <= 0
  ) {
    return null;
  }
  return { attachToNodeId };
}

/**
 * 파일 한 개를 텍스트로 보낼지(.txt·.md) base64 바이너리로 보낼지(PDF·docx 등) 가른다.
 * 봇 attachment-ingest.ts 의 classifyAttachment 와 같은 순서로 판정한다 — mimeType 우선,
 * 없거나 모르는 형식이면 확장자로 fallback. 텍스트면 확정 mimeType(text/plain·text/markdown)을
 * 동반해 라우트가 글자 그대로 저장하게 한다(base64 문자열을 글 본문으로 저장하던 사고 차단).
 *
 * 봇과 달리 "못 받는 형식 거부"까지 가지 않는다 — 명백한 텍스트만 text 통로로 보내고,
 * 그 외는 binary 로 보내 라우트의 detection/warnings 가 정직하게 응답하게 둔다.
 *
 * @param {string} name      파일 이름(확장자 판정에 사용).
 * @param {string} mimeType  브라우저가 추측한 MIME(File.type). 없을 수 있음 → 확장자 fallback.
 * @returns {{ kind: "text"|"binary", mimeType: string }}
 *   kind="text" 면 mimeType 은 확정 text/plain·text/markdown. kind="binary" 면 입력 mimeType 그대로.
 */
export function classifyFileKind(name, mimeType) {
  const mime = baseMime(mimeType);
  const ext = extOf(typeof name === "string" ? name : "");

  // 1. mimeType 기준 — 명백한 텍스트면 text 통로.
  if (mime === MIME_TEXT_PLAIN || mime === MIME_TEXT_MARKDOWN) {
    return { kind: "text", mimeType: mime };
  }

  // 2. mime 이 없거나 텍스트가 아니면 확장자로 fallback.
  if (ext === ".txt") return { kind: "text", mimeType: MIME_TEXT_PLAIN };
  if (ext === ".md") return { kind: "text", mimeType: MIME_TEXT_MARKDOWN };

  // 3. 그 외는 모두 binary(PDF·docx 등) — 라우트가 형식 감지 + base64 디코드.
  return { kind: "binary", mimeType: typeof mimeType === "string" ? mimeType : "" };
}

/**
 * 텍스트 파일(.txt·.md)을 보내는 경우의 POST /ingest body 를 조립한다.
 * content.type="text" + 글자 그대로(data) — base64 가 아니라 UTF-8 문자열을 보낸다.
 * 타이핑 메모용 buildTextPayload 와 달리 파일은 originalName 을 보존해 제목이 파일명으로 잡히게 한다.
 *
 * @param {{ text: string, mimeType: string, originalName: string }} file
 *   text=글자 그대로, mimeType=확정 text/plain·text/markdown, originalName=파일 이름.
 * @param {string[]} [hashtags]  입력 글에서 추린 태그(파일에도 함께 단다).
 * @param {number|null} [attachToNodeId]  함께 작성한 글 원본 노드 id. 있으면 파일을 그 아래에 붙인다.
 * @returns {object}
 */
export function buildTextFilePayload(file, hashtags = [], attachToNodeId = null) {
  const payload = {
    source: DASHBOARD_SOURCE,
    content: {
      type: "text",
      data: file.text,
      mimeType: file.mimeType,
      originalName: file.originalName,
    },
    attribution: { ...DASHBOARD_ATTRIBUTION },
  };
  if (Array.isArray(hashtags) && hashtags.length > 0) payload.hashtags = hashtags;
  const options = attachOptions(attachToNodeId);
  if (options) payload.options = options;
  return payload;
}

/**
 * 파일 한 개를 보내는 경우의 POST /ingest body 를 조립한다.
 * content.type="auto" — 라우트가 mimeType/originalName 으로 형식을 감지하고 base64 를 디코드한다
 * (봇 buildIngestPayload 의 document 통로와 같은 정신). PDF·docx 등 바이너리 전용.
 * @param {{ base64: string, mimeType: string, originalName: string }} file
 * @param {string[]} [hashtags]  입력 글에서 추린 태그(파일에도 함께 단다).
 * @param {number|null} [attachToNodeId]  함께 작성한 글 원본 노드 id. 있으면 파일을 그 아래에 붙인다.
 * @returns {object}
 */
export function buildFilePayload(file, hashtags = [], attachToNodeId = null) {
  const payload = {
    source: DASHBOARD_SOURCE,
    content: {
      type: "auto",
      data: file.base64,
      mimeType: file.mimeType,
      originalName: file.originalName,
    },
    attribution: { ...DASHBOARD_ATTRIBUTION },
  };
  if (Array.isArray(hashtags) && hashtags.length > 0) payload.hashtags = hashtags;
  const options = attachOptions(attachToNodeId);
  if (options) payload.options = options;
  return payload;
}

/**
 * detection 객체를 사람이 읽는 한 줄들로 풀어 준다(정직한 표시 보조).
 * 약속하지 않는 칸(예: PDF tableCount)은 애초에 detection 에 없으므로 자연히 빠진다.
 * @param {object} detection  { kind, extractedCharCount, pageCount?, scannedPdf?, embeddedImageCount?, tableCount? }
 * @returns {string[]}  사람이 읽는 설명 줄(없으면 빈 배열).
 */
export function describeDetection(detection) {
  if (!detection || typeof detection !== "object") return [];
  const lines = [];
  const kindLabel =
    detection.kind === "pdf" ? "PDF"
    : detection.kind === "docx" ? "docx"
    : detection.kind === "passthrough" ? "텍스트/마크다운"
    : String(detection.kind ?? "");
  if (kindLabel) lines.push(`형식: ${kindLabel}`);
  if (typeof detection.extractedCharCount === "number") {
    lines.push(`추출 글자수: ${detection.extractedCharCount}`);
  }
  if (typeof detection.pageCount === "number") {
    lines.push(`페이지: ${detection.pageCount}`);
  }
  if (typeof detection.tableCount === "number") {
    lines.push(`표: ${detection.tableCount}개`);
  }
  if (typeof detection.embeddedImageCount === "number") {
    lines.push(`삽입 이미지: ${detection.embeddedImageCount}개`);
  }
  if (detection.scannedPdf === true) {
    lines.push("스캔본 PDF — 글자 레이어 없음");
  }
  return lines;
}

/**
 * 텍스트·글 입력 응답(POST /ingest 의 type="text" 갈래)을 "추출 상태" 한 줄들로
 * 풀어 준다 (입력 통로 통합 Task 7 / spec §5 표시 상세 · D8).
 *
 * 비동기(backfill) 추출을 "완료"로 위장하지 않고 정직하게 알리는 자료다(CLAUDE.md
 * "실패·대기 ≠ 빈 결과"). 라우트 응답 칸을 *있는 그대로* 읽는다 — 없는 정보는
 * 지어내지 않는다:
 *   - body.extracted (atomic 자식 id 배열) → 길이 M>0 이면 "의미추출 완료 M개".
 *     짧은 글 immediate LLM 추출 + regex Level 0 atomic 을 합산한 산출(save-input.ts
 *     SaveTextInputResult.extracted 계약). M=0 이면 줄 안 만든다(없는 걸 "0개"로
 *     떠벌리지 않는다 — 추출 안 한 짧은 메모가 흔한 정상 갈래).
 *   - body.pendingChunks (긴 글의 backfill 대상 청크 수 = chunkNodeIds.length) →
 *     N>0 이면 "추출 대기 N개 (주기마다 자동 처리)". 긴 문서는 청크가 추출 단위라
 *     업로드 즉시 추출하지 않고 스케줄러가 나중에 처리한다 — 그 대기 상태를 정직하게
 *     노출한다. 응답에 pendingChunks 칸이 없으면(옛 응답·다른 갈래) 줄 안 만든다.
 *   - body.bumped (dedup 으로 기존 노드 mention 만 올린 id 배열) → 길이 K>0 이면
 *     "기존 메모 K개에 합쳐짐". 새 추출이 아니라 기존 기억 강화라 따로 알린다.
 *
 * PDF·docx document 갈래(documentId 응답)에는 extracted/bumped 칸이 없고 pendingChunks
 * 만 라우트가 실어 준다(spec §5 일관성 — 문서 청크도 backfill 추출 대상). 그래서 이
 * 함수를 그대로 호출하면 "추출 대기 N개" 줄만 자연 표시되고, 청크 0(스캔 PDF 등)이면
 * 줄이 안 나온다(없는 추출 진행을 지어내지 않는다 — 있는 데이터만 정직하게 표시).
 *
 * @param {object} body  POST /ingest type="text" 응답 ({ extracted?, pendingChunks?, bumped? })
 * @returns {string[]}  사람이 읽는 추출 상태 줄(해당 없으면 빈 배열).
 */
export function describeExtractionStatus(body) {
  if (!body || typeof body !== "object") return [];
  const lines = [];
  const extracted = Array.isArray(body.extracted) ? body.extracted.length : 0;
  const pending =
    typeof body.pendingChunks === "number" && body.pendingChunks > 0
      ? body.pendingChunks
      : 0;
  const bumped = Array.isArray(body.bumped) ? body.bumped.length : 0;

  if (extracted > 0) lines.push(`의미추출 완료 ${extracted}개`);
  if (pending > 0) lines.push(`추출 대기 ${pending}개 (주기마다 자동 처리)`);
  if (bumped > 0) lines.push(`기존 메모 ${bumped}개에 합쳐짐`);
  return lines;
}

/**
 * 입력 mime 이 11a 지원 image 5 종에 들어가는지 확인 (Phase 11a T6).
 * baseMime 으로 charset 등 파라미터를 떼고 소문자 본체만 SUPPORTED_IMAGE_MIMES_CLIENT
 * 와 대조한다. 비문자열 입력은 false 로 방어.
 *
 * @param {string} mime
 * @returns {boolean}
 */
export function isImageMimeClient(mime) {
  if (typeof mime !== "string" || mime.length === 0) return false;
  return SUPPORTED_IMAGE_MIMES_CLIENT.has(baseMime(mime));
}

/**
 * ingestImage 응답 객체 (POST /ingest 의 body.images[i]) 를 사람이 읽는 한 줄들로
 * 풀어 준다 (Phase 11a T6).
 *
 * 표시 칸:
 *   - 자산 sha256 (전체 64자 — 사용자 복사 가능 / 위장 없음)
 *   - 미리보기 sha256 (전체 64자)
 *   - 가로 × 세로 (px)
 *   - mime (입력 또는 사본 결과 mime)
 *   - "움직이는 이미지" 줄 (isAnimated=true 일 때만 합류)
 *   - warnings 배열 한 줄씩 ("⚠ " prefix — 정직한 표시 정신)
 *
 * 미리보기 자산을 인라인 <img> 로 표시하지 않는다 — 자산 fetch 라우트 (예:
 * GET /assets/{sha256}) 가 14a/14b 까지 정착돼 있지 않다. 깨진 <img> src 로 위장
 * 하기보다 sha 한 줄로 정직하게 노출한다 (CLAUDE.md 정직한 표시 정합). 자산 fetch
 * 라우트가 후 phase 에 정착하면 그때 인라인 미리보기 합류.
 *
 * @param {object} img  ingestImage 응답 한 한 (assetSha256·thumbSha256·width·height·isAnimated·warnings·mime·nodeId)
 * @returns {string[]}  사람이 읽는 설명 줄 (입력이 비객체면 빈 배열)
 */
export function describeImageResult(img) {
  if (!img || typeof img !== "object") return [];
  const lines = [];
  if (typeof img.assetSha256 === "string" && img.assetSha256.length > 0) {
    lines.push(`자산 sha256: ${img.assetSha256}`);
  }
  if (typeof img.thumbSha256 === "string" && img.thumbSha256.length > 0) {
    lines.push(`미리보기 sha256: ${img.thumbSha256}`);
  }
  if (typeof img.width === "number" && typeof img.height === "number") {
    lines.push(`크기: ${img.width} × ${img.height}`);
  }
  if (typeof img.mime === "string" && img.mime.length > 0) {
    lines.push(`형식: ${img.mime}`);
  }
  if (img.isAnimated === true) {
    lines.push("움직이는 이미지");
  }
  const warnings = Array.isArray(img.warnings) ? img.warnings : [];
  for (const w of warnings) {
    lines.push(`⚠ ${String(w)}`);
  }
  return lines;
}

// 종류·칸·날짜는 더 이상 폼이 보내지 않는다(S8·결정 1). 사용자가 본문에 `#종류:`·`#금액:`·
// `#날짜:` 처럼 태그로 치면 서버 /ingest 가 본문에서 인식한다(S5). 그래서 옛 buildDynamicPayload
// (kind/fields/eventAt 합류)는 제거됐고, 글 전송은 buildTextPayload 한 통로로 단순화됐다.

// ── DOM 부수효과 (수동 sanity 대상 — fetch/FileReader 는 단위 테스트에서 안 건드림) ──

/**
 * File 한 개를 base64(데이터 부분만)로 읽는다. FileReader 의 dataURL 에서 콤마 뒤만 떼어 낸다.
 * @param {File} file
 * @returns {Promise<string>}
 */
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error(`파일 읽기 실패: ${file.name}`));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * 입력 폼을 메인 화면에 붙이고 동작을 잇는다.
 *
 * @param {object} ctx  graph-entry 가 넘기는 의존:
 *   - mountEl: HTMLElement      폼을 붙일 컨테이너
 *   - apiBase: string           API 베이스(보통 "" same-origin)
 *   - escapeHtml: (s)=>string   XSS 방어 escape(기존 유틸 재사용)
 *   - onIngested: ()=>void      성공 시 호출(최근 목록·통계 새로고침)
 *   - el: (tag, props?, ...children)=>HTMLElement  DOM 헬퍼(ui/dom.ts el 주입·S8).
 *       미리보기 패널·칸 자동 표시 노드를 이 헬퍼로 조립한다. ingest-form.js 는 빌드 없는
 *       브라우저 ES 모듈이라 .ts 인 ui/dom.ts 를 직접 import 못 하므로 호출부가 주입한다
 *       (ingest-preview.js·compute-tab.js 의 el 주입 선례와 같은 양식).
 */
export function mountIngestForm(ctx) {
  const { mountEl, apiBase = "", escapeHtml, onIngested, el } = ctx;
  if (!mountEl) throw new Error("mountIngestForm: mountEl 이 필요합니다");
  if (typeof escapeHtml !== "function") {
    throw new Error("mountIngestForm: escapeHtml 함수가 필요합니다");
  }
  if (typeof el !== "function") {
    throw new Error("mountIngestForm: el 헬퍼가 필요합니다(미리보기·칸 자동 표시 배선)");
  }

  // 첨부 파일 목록(전송 전 메모리에만 들고 있음).
  /** @type {File[]} */
  let attachedFiles = [];


  // ── 마크업 ──────────────────────────────────────────────────────────────
  // S8(결정 1): 종류 드롭다운·일정 date·동적 칸 마크업을 걷어냈다. 종류·칸·날짜는 사용자가
  // 본문에 `#종류:`·`#금액:`·`#날짜:` 태그로 치면 서버 /ingest 가 본문에서 인식한다(S5).
  // 대신 입력창 위에 떠 있는 미리보기 패널(data-ingest-preview)을 둬 "이렇게 이해했어요"를
  // 실시간으로 보인다(S7). 자동완성 드롭다운은 textarea 옆 래퍼에 자리한다(S6).
  // 기존 data-속성(data-ingest-box·add·input·send·file·attachments·status·result)은
  // 기존 배선이 참조하므로 그대로 유지한다.
  mountEl.innerHTML = `
    <div class="ingest-box" data-ingest-box>
      <div class="ingest-preview" data-ingest-preview></div>
      <div class="ingest-row">
        <button type="button" class="ingest-add-btn" data-ingest-add title="파일 첨부">+</button>
        <div class="ingest-input-wrap" data-ingest-input-wrap>
          <textarea class="ingest-input" data-ingest-input rows="1"
            placeholder="여기에 메모를 적거나 파일을 끌어다 놓으세요 (#종류:값 #금액:값 #날짜:값 가능)"></textarea>
        </div>
        <button type="button" class="ingest-send-btn" data-ingest-send>전송</button>
      </div>
      <input type="file" data-ingest-file multiple hidden>
      <div class="ingest-attachments" data-ingest-attachments></div>
      <div class="ingest-status" data-ingest-status hidden></div>
      <div class="ingest-result" data-ingest-result hidden></div>
    </div>
  `;

  const boxEl = mountEl.querySelector("[data-ingest-box]");
  const addBtn = mountEl.querySelector("[data-ingest-add]");
  const inputEl = mountEl.querySelector("[data-ingest-input]");
  const inputWrapEl = mountEl.querySelector("[data-ingest-input-wrap]");
  const sendBtn = mountEl.querySelector("[data-ingest-send]");
  const fileEl = mountEl.querySelector("[data-ingest-file]");
  const attachEl = mountEl.querySelector("[data-ingest-attachments]");
  const statusEl = mountEl.querySelector("[data-ingest-status]");
  const resultEl = mountEl.querySelector("[data-ingest-result]");
  const previewEl = mountEl.querySelector("[data-ingest-preview]");

  // ── 미리보기·자동완성·칸 자동 표시 배선(S8·결정 1·6) ──────────────────
  // 입력창 위 떠 있는 미리보기 패널(S7)·`#` 자동완성 드롭다운(S6)·종류 인식 시 칸 자동
  // 표시(결정 6)를 한 보조 파일(wire-ingest-form.js)이 잇는다. 800줄 상한에 닿아 배선 책임을
  // 그쪽으로 떼었다. search 모드 picker 무접촉(spec §11) — entity-types 를 따로 읽는다.
  wireIngestExtras({ inputEl, inputWrapEl, previewEl, apiBase, el });

  // ── 첨부 목록 렌더 ────────────────────────────────────────────────────────
  function renderAttachments() {
    if (attachedFiles.length === 0) {
      attachEl.replaceChildren();
      return;
    }
    const frag = document.createDocumentFragment();
    attachedFiles.forEach((file, idx) => {
      const chip = document.createElement("span");
      chip.className = "ingest-chip";
      const name = document.createElement("span");
      name.className = "ingest-chip-name";
      name.textContent = file.name; // textContent — XSS 안전
      const size = document.createElement("span");
      size.className = "ingest-chip-size";
      size.textContent = formatBytes(file.size);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ingest-chip-remove";
      remove.textContent = "×";
      remove.title = "첨부 제거";
      remove.addEventListener("click", () => {
        attachedFiles.splice(idx, 1);
        renderAttachments();
      });
      chip.append(name, size, remove);
      frag.appendChild(chip);
    });
    attachEl.replaceChildren(frag);
  }

  function formatBytes(n) {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  }

  function addFiles(fileList) {
    for (const f of fileList) attachedFiles.push(f);
    renderAttachments();
  }

  // ── 상태/결과 표시 ────────────────────────────────────────────────────────
  function showStatus(message) {
    statusEl.hidden = false;
    const loader = document.createElement("span");
    loader.className = "dash-square-loader dash-square-loader--sm";
    loader.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = message;
    statusEl.replaceChildren(loader, text);
  }
  function hideStatus() {
    statusEl.hidden = true;
    statusEl.replaceChildren();
  }
  function resetInputAfterSuccess() {
    inputEl.value = "";
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    // input 이벤트의 자동 높이 계산이 남긴 inline height 를 지워 CSS 기본 한 줄 높이로 되돌린다.
    inputEl.style.height = "";
  }

  /** 한 건 결과 블록을 그린다(성공·실패 공용). 외부 문자열은 전부 escape. */
  function renderResultBlock(label, state, lines) {
    const block = document.createElement("div");
    block.className = `ingest-result-block ${state === "saved" ? "ok" : state === "failed" ? "fail" : "pending"}`;
    const head = document.createElement("div");
    head.className = "ingest-result-head";
    head.textContent = `${state === "saved" ? "저장됨" : state === "failed" ? "실패" : state === "unknown" ? "결과 확인 필요" : "처리 중"} · ${label}`;
    block.appendChild(head);
    for (const line of lines) {
      const p = document.createElement("div");
      p.className = "ingest-result-line";
      p.textContent = line; // textContent — escape 불필요(직접 노드 텍스트)
      block.appendChild(p);
    }
    return block;
  }

  /** 응답 body 에서 정직한 결과 줄(detection + warnings)을 뽑는다. */
  function resultLinesFromBody(body) {
    // Phase 11a T6 — image 응답 갈래. 라우트는 { ok, type:"image", images:[imageResult] }
    // 양식을 돌려준다. images 배열의 각 img 를 describeImageResult 로 풀어 한 결과 블록에 합류.
    if (body && body.type === "image" && Array.isArray(body.images)) {
      const lines = [];
      if (typeof body.attachedToNodeId === "number") {
        lines.push(`상위 노드 #${body.attachedToNodeId}`);
      }
      for (const img of body.images) {
        if (typeof img.nodeId === "number") lines.push(`노드 #${img.nodeId}`);
        for (const d of describeImageResult(img)) lines.push(d);
      }
      return lines;
    }
    // 순수 타이핑 글·텍스트 파일 갈래 — type="text" (saveTextInput 응답).
    // 추출 상태(완료 M / 대기 N / 합쳐짐 K)를 정직하게 노출한다(Task 7 / D8). 긴 글은
    // pendingChunks 로 "추출 대기 N개" 가 보이고, 짧은 글 immediate 추출은 "의미추출 완료
    // M개" 로 보인다 — 비동기 backfill 을 "완료"로 위장하지 않는다(CLAUDE.md 정직한 표시).
    if (body && body.type === "text") {
      const textLines = [];
      if (typeof body.originNodeId === "number") {
        textLines.push(`원본 노드 #${body.originNodeId}`);
      }
      for (const s of describeExtractionStatus(body)) textLines.push(s);
      return textLines;
    }
    // 14a/14b 문서 갈래(PDF·docx·.txt/.md 파일) — documentId 응답. 라우트가 텍스트 갈래와
    // 같은 이름의 pendingChunks 칸을 실어 주므로(spec §5 일관성), 문서 청크의 추출 대기도
    // describeExtractionStatus 로 "추출 대기 N개 (주기마다 자동 처리)" 를 자연 표시한다.
    // 문서 응답엔 extracted/bumped 가 없어 그 줄은 안 나오고 대기 줄만 나온다(없는 칸 방어).
    // 긴 문서 청크의 추출은 backfill 스케줄러가 처리하며, 처리 후 새로고침 시 자식 노드는
    // 최근 목록에서 자식으로 접힌다(Task 4) — 원본 카드는 그대로 남는다.
    const lines = [];
    if (typeof body.documentId === "string") lines.push(`문서 #${body.documentId}`);
    if (body.cacheHit === true) lines.push("이미 보관된 자산 재사용");
    for (const d of describeDetection(body.detection)) lines.push(d);
    for (const s of describeExtractionStatus(body)) lines.push(s);
    const warnings = Array.isArray(body.warnings) ? body.warnings : [];
    for (const w of warnings) lines.push(`⚠ ${String(w)}`);
    return lines;
  }

  // ── 전송 ──────────────────────────────────────────────────────────────────
  const submit = createIngestSubmission({
    apiBase, inputEl, sendBtn, resultEl, onIngested, showStatus, hideStatus,
    getFiles: () => attachedFiles,
    removeFile: (file) => {
      attachedFiles = attachedFiles.filter((current) => current !== file);
      renderAttachments();
    },
    resetInput: resetInputAfterSuccess,
    textPayload: buildTextPayload,
    filePayload: async (file, text, parent) => {
      const hashtags = extractHashtags(text);
      const classified = classifyFileKind(file.name, file.type);
      if (classified.kind === "text") {
        return buildTextFilePayload(
          { text: await file.text(), mimeType: classified.mimeType, originalName: file.name },
          hashtags, parent,
        );
      }
      return buildFilePayload(
        { base64: await readFileAsBase64(file), mimeType: file.type || "", originalName: file.name },
        hashtags, parent,
      );
    },
    resultLines: resultLinesFromBody,
    renderBlock: renderResultBlock,
  });
  // ── 이벤트 배선 ────────────────────────────────────────────────────────────
  addBtn.addEventListener("click", () => fileEl.click());
  fileEl.addEventListener("change", () => {
    if (fileEl.files) addFiles(fileEl.files);
    fileEl.value = ""; // 같은 파일 재선택 허용
  });
  sendBtn.addEventListener("click", submit);
  inputEl.addEventListener("keydown", (e) => {
    // Enter = 전송 / Shift+Enter = 줄바꿈.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    }
  });
  // textarea 자동 높이(한 줄 채팅창이 글 길이에 맞춰 늘어남 — 결정 4 절제).
  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 200)}px`;
  });

  // 드래그앤드롭(입력 칸 위에 파일을 끌어다 놓으면 첨부).
  ["dragenter", "dragover"].forEach((evt) =>
    boxEl.addEventListener(evt, (e) => {
      e.preventDefault();
      boxEl.classList.add("dragover");
    }),
  );
  ["dragleave", "drop"].forEach((evt) =>
    boxEl.addEventListener(evt, (e) => {
      e.preventDefault();
      if (evt === "dragleave" && boxEl.contains(e.relatedTarget)) return;
      boxEl.classList.remove("dragover");
    }),
  );
  boxEl.addEventListener("drop", (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  });
}
