/**
 * attachment-ingest.ts — 디스코드 첨부 → 14a/11a 문서 라우트(POST /ingest) 다리의 순수 부분.
 *
 * Phase 14b T5 가 텍스트·MD·PDF·docx 갈래를 정착했고, Phase 11a T7 가 image 5 종
 * (png/jpeg/gif/webp/apng) 갈래를 합류시킨다. 봇 single-path(글은 POST /memories)
 * 정신은 그대로 두고, 메시지에 붙은 첨부만 14a/11a 코어가 받는 형식으로 추려 보낸다.
 *
 * 이 파일은 discord.js 를 import 하지 않는다 — 형식 판정·payload 조립을 순수 함수로
 * 분리해 plain object fixture 로 단위 검증한다(mock 객체 금지, CLAUDE.md 정책).
 * 다운로드(fetch)·base64 인코딩·react 같은 부수효과는 index.ts 핸들러의 얇은 가지에 둔다.
 *
 * 받는 형식 판정 규칙(14a/11a dispatcher 정합):
 *   - 텍스트  : contentType text/plain · text/markdown, 또는 확장자 .txt · .md → kind="text"
 *   - 문서    : contentType application/pdf 또는 …wordprocessingml.document,
 *               또는 확장자 .pdf · .docx → kind="document"
 *   - 이미지  : contentType image/png · image/jpeg · image/gif · image/webp · image/apng ·
 *               image/avif → kind="image" (Phase 11a T7 / 11d D6 — SUPPORTED_IMAGE_MIMES
 *               코어 권위 import. avif 합류는 코어 묶음 갱신으로 자동 반영)
 *   - 그 외   : 받지 않는 이미지(image/svg+xml · image/tiff · image/bmp 등)와 그 외
 *               형식 모두 거부(accepted=false) — silent drop 금지.
 *
 * 14a/11a 라우트로 보낼 때:
 *   - 텍스트(text/md) : content.type="text" + UTF-8 문자열(라우트가 mimeType 생략 시
 *     text/markdown 으로 확정). base64 아님 — isBinaryContent 가 text mime 을 binary 로
 *     보지 않아 base64 문자열을 그대로 인코딩해버리는 사고를 막는다.
 *   - 문서(pdf/docx) : content.type="auto" + base64 문자열 + mimeType(라우트가 base64 디코드).
 *   - 이미지         : content.type="image" + base64 문자열 + mimeType(라우트가 isImageMime
 *                      으로 image 분기 → ingestImage 별 통로 — 청크·canonical .md 흐름 X).
 */

import type {
  InputSourceMessage,
  PostIngestArgs,
  PostIngestApiResult,
  IngestImageResponse,
  IngestImageItem,
} from "../../memory/src/api-client.ts";
import { SUPPORTED_IMAGE_MIMES } from "../../memory/src/memory/image-mime.ts";

// ── mime / 확장자 상수 (14a dispatcher 정합) ──────────────────────────────────

const MIME_TEXT_PLAIN = "text/plain";
const MIME_TEXT_MARKDOWN = "text/markdown";
const MIME_PDF = "application/pdf";
const MIME_DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// ── image 확장자 → mime 매핑(확장자 fallback 용, 11a T7) ──────────────────────
// SUPPORTED_IMAGE_MIMES(코어 권위)와 같은 가족. contentType 비어 있어도 확장자로
// 받기 가능. Phase 11d D6: .avif 합류 — 매핑 값은 모두 코어 묶음 안 mime 이라야
// 한다(IMAGE_EXT_TO_MIME 정합 테스트가 SUPPORTED_IMAGE_MIMES 와 대조).
const IMAGE_EXT_TO_MIME: ReadonlyMap<string, string> = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".apng", "image/apng"],
  [".avif", "image/avif"],
]);

// ── 입력 형태 — 디스코드 Attachment 의 슬림 인터페이스 ──────────────────────────

/**
 * discord.js `Attachment` 가 자연스럽게 만족하는 최소 형태.
 * 정밀 타입을 import 하지 않고 슬림하게 받아 fixture data 로 테스트 가능하게 둔다.
 */
export interface AttachmentMetaLike {
  /** 디스코드 첨부 id. 메시지 출처의 첨부 키(WP-B1-20U 설계 17.8)가 첨부마다 갈리게 sourceMessage 에 싣는다. */
  id: string;
  /** 파일 이름(예: "회의록.pdf"). 확장자 판정에 사용. */
  name: string;
  /** 디스코드가 추측한 MIME. 없을 수 있음(null/undefined) → 확장자로 fallback. */
  contentType?: string | null;
  /** 다운로드 URL. 핸들러가 fetch. */
  url: string;
  /** 바이트 크기. */
  size: number;
}

// ── 판정 결과 ─────────────────────────────────────────────────────────────────

/** 받을 첨부 — 어떤 통로(text/document/image)로 어떤 mimeType 으로 보낼지. */
export interface AcceptedAttachment {
  accepted: true;
  /**
   * "text"     = UTF-8 passthrough(텍스트·MD),
   * "document" = base64(PDF·docx),
   * "image"    = base64(png/jpeg/gif/webp/apng — Phase 11a T7).
   */
  kind: "text" | "document" | "image";
  /** 14a/11a 로 넘길 확정 mimeType. */
  mimeType: string;
}

/** 못 받을 첨부 — 사람이 읽을 사유 동반(silent drop 금지). */
export interface RejectedAttachment {
  accepted: false;
  /** "이 형식은 아직 안 받아요" 류의 사람이 읽을 사유. */
  reason: string;
}

export type AttachmentClassification = AcceptedAttachment | RejectedAttachment;

// ── 내부 유틸 ─────────────────────────────────────────────────────────────────

/** contentType 에서 charset 등 파라미터를 떼고 소문자 mime 본체만 남긴다. */
function baseMime(contentType: string | null | undefined): string {
  if (!contentType) return "";
  const semi = contentType.indexOf(";");
  const head = semi === -1 ? contentType : contentType.slice(0, semi);
  return head.trim().toLowerCase();
}

/** 파일 이름에서 소문자 확장자(".pdf" 형태)를 뽑는다. */
function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx).toLowerCase();
}

/**
 * 거부 안내에 쓸 "받는 이미지 형식" 라벨을 코어 SUPPORTED_IMAGE_MIMES 에서 뽑는다.
 * "image/" prefix 를 떼고 " · " 로 잇는다(예: "png · jpeg · gif · webp · apng · avif").
 * 코어 묶음이 바뀌면 안내도 자동 동기 — 손으로 적은 목록이 어긋날 일이 없다.
 */
function supportedImageLabel(): string {
  return [...SUPPORTED_IMAGE_MIMES]
    .map((m) => m.replace(/^image\//, ""))
    .join(" · ");
}

// ── 공개 함수 ─────────────────────────────────────────────────────────────────

/**
 * 첨부 메타를 보고 14a 코어가 받는 형식인지 판정한다.
 * mimeType 우선, 없거나 모르는 형식이면 확장자로 fallback(14a dispatcher 와 같은 순서).
 * 받으면 보낼 통로(kind)와 확정 mimeType 을, 못 받으면 사람이 읽을 사유를 돌려준다.
 */
export function classifyAttachment(
  meta: AttachmentMetaLike,
): AttachmentClassification {
  const mime = baseMime(meta.contentType);
  const ext = extOf(meta.name);

  // 1. mimeType 기준 — text/document/image 분기.
  if (mime === MIME_TEXT_PLAIN || mime === MIME_TEXT_MARKDOWN) {
    return { accepted: true, kind: "text", mimeType: mime };
  }
  if (mime === MIME_PDF) {
    return { accepted: true, kind: "document", mimeType: MIME_PDF };
  }
  if (mime === MIME_DOCX) {
    return { accepted: true, kind: "document", mimeType: MIME_DOCX };
  }
  // 이미지 5 종(11a T7) — 코어 SUPPORTED_IMAGE_MIMES 와 같은 묶음(단일 권위).
  if (SUPPORTED_IMAGE_MIMES.has(mime)) {
    return { accepted: true, kind: "image", mimeType: mime };
  }
  // 받지 않는 이미지(image/svg+xml · image/tiff · image/bmp 등) — 정직한 거부.
  // image/* 갈래는 사람이 "이미지 형식 안내" 로 더 좁게 알려준다 — silent drop 금지.
  // 받는 형식 목록은 코어 SUPPORTED_IMAGE_MIMES 에서 뽑아 동기 어긋남을 막는다.
  if (mime.startsWith("image/")) {
    return {
      accepted: false,
      reason: `${meta.name}: ${mime} 이미지 형식은 아직 안 받아요 (${supportedImageLabel()} 만 처리)`,
    };
  }

  // 2. mime 이 없거나 모르는 형식이면 확장자로 fallback.
  if (ext === ".txt") {
    return { accepted: true, kind: "text", mimeType: MIME_TEXT_PLAIN };
  }
  if (ext === ".md") {
    return { accepted: true, kind: "text", mimeType: MIME_TEXT_MARKDOWN };
  }
  if (ext === ".pdf") {
    return { accepted: true, kind: "document", mimeType: MIME_PDF };
  }
  if (ext === ".docx") {
    return { accepted: true, kind: "document", mimeType: MIME_DOCX };
  }
  // 이미지 확장자 fallback(11a T7) — 동영상·SVG 등은 여기 못 들어옴.
  const imageMimeByExt = IMAGE_EXT_TO_MIME.get(ext);
  if (imageMimeByExt) {
    return { accepted: true, kind: "image", mimeType: imageMimeByExt };
  }

  // 3. 못 받는 형식 — 사람이 읽을 사유로 거부(silent drop 금지).
  const shown = mime || (ext ? `확장자 ${ext}` : "형식 불명");
  return {
    accepted: false,
    reason: `${meta.name}: ${shown} 형식은 아직 안 받아요 (텍스트·마크다운·PDF·docx·이미지 만 처리)`,
  };
}

// ── payload 조립 ──────────────────────────────────────────────────────────────

export interface BuildIngestPayloadArgs {
  /** 받기로 판정된 첨부(accepted=true). */
  classified: AcceptedAttachment;
  /**
   * 보낼 본문 데이터. kind="text" 면 UTF-8 문자열, kind="document" 면 base64 문자열.
   * 다운로드·인코딩은 핸들러가 끝낸 뒤 이 함수로 넘긴다.
   */
  data: string;
  /** 원본 파일 이름. */
  originalName: string;
  /** 출처(예: "discord-dm", "discord-channel"). baseMetadata.source 와 정합. */
  source: string;
  /** Attribution(author=display name, userId=영구 식별자). */
  attribution: { author: string; userId: string };
  /**
   * 이 첨부를 보낸 메시지와 첨부 id(WP-B1-20U 설계 17.8). 코어가 문서·이미지 노드에 첨부별 메시지 출처 행을 남겨
   * 메시지 삭제(MessageDelete → DELETE /memories/by-source)가 그 노드를 지운다.
   */
  sourceMessage: InputSourceMessage;
  /** 사용자 손 태그(선택). */
  hashtags?: string[];
}

/**
 * 받기로 판정된 첨부를 14a/11a POST /ingest body(PostIngestArgs)로 조립한다.
 *
 * - kind="text"     → content.type="text"(UTF-8 passthrough). data 는 디코드된 문자열.
 * - kind="document" → content.type="auto"(라우트가 mime/ext 로 감지 + base64 디코드).
 *                     data 는 base64 문자열.
 * - kind="image"    → content.type="image"(라우트가 isImageMime 분기 + base64 디코드).
 *                     data 는 base64 문자열(11a T7).
 * 세 갈래 모두 sourceMessage 를 그대로 싣는다.
 */
export function buildIngestPayload(args: BuildIngestPayloadArgs): PostIngestArgs {
  const { classified, data, originalName, source, attribution, sourceMessage, hashtags } = args;
  const type: PostIngestArgs["content"]["type"] =
    classified.kind === "text"
      ? "text"
      : classified.kind === "image"
        ? "image"
        : "auto";
  const payload: PostIngestArgs = {
    source,
    content: {
      type,
      data,
      mimeType: classified.mimeType,
      originalName,
    },
    attribution,
    sourceMessage,
  };
  if (hashtags && hashtags.length > 0) payload.hashtags = hashtags;
  return payload;
}

// ── 다운로드 byte 상한 ────────────────────────────────────────────────────────

/**
 * 첨부 다운로드 기본 byte 상한 (64 MiB).
 * 메모리 코어 settings db.maxAssetBytes 기본값(64 MiB)과 맞춘다.
 * ingestAttachment 의 limitBytes 파라미터에 주입하거나, 생략 시 이 값이 사용된다.
 */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

// ── 다리 — 첨부 한 건을 14a/11a POST /ingest 로 보낸다 ───────────────────────

/**
 * 첨부 한 건 처리 결과 — 합산 react / 콘솔 보고 / 동반 메시지 표시에 사용.
 *
 * 텍스트·문서 갈래는 `status: "ingested"` + documentId 한 정.
 * 이미지 갈래(11a T7)는 `status: "ingested-image"` + image 응답 항목 한 한 —
 * documents·청크 흐름이 없어 documentId 가 없고, 그 대신 자산 sha·미리보기·크기·
 * 움직임·경고·노드 id 묶음을 그대로 전달해 표시 흐름에서 정직한 피드백을 만든다.
 */
export type AttachmentOutcome =
  | { status: "ingested"; name: string; documentId: string }
  | {
      status: "ingested-image";
      name: string;
      /** T5 응답 안 images[0] — 자산·미리보기·크기·움직임·경고·노드 id 묶음. */
      image: IngestImageItem;
    }
  | { status: "rejected"; name: string; reason: string }
  | { status: "failed"; name: string; reason: string };

/**
 * postIngest / postIngestImage 만 요구하는 슬림 인터페이스 — discord.js 와 무관하게
 * 두기 위해 MemoryApiClient 전체가 아닌 호출 표면만 의존한다.
 *
 * 두 메서드는 같은 라우트(POST /ingest)이지만 응답 양식이 갈라져 별 메서드로 둔다 —
 * 텍스트·문서 응답은 PostIngestApiResult(union), 이미지 응답은 IngestImageResponse.
 *
 * postIngest 반환은 union(document·text·entity_patch 세 갈래)이라야 MemoryApiClient.
 * postIngest 와 정합한다 — MemoryApiClient 는 세 갈래 어느 것이든 돌려줄 수 있으므로,
 * 여기서 document 갈래로 좁혀 요구하면 대입이 막힌다(반환 타입 공변성). 봇 문서첨부는
 * 항상 originalName 을 채워 document 갈래만 오지만(런타임 안전), text·entity_patch 가
 * 오면 아래 ingestAttachment 의 런타임 가드가 정직한 에러로 멈춘다(silent 무시 금지).
 */
export interface IngestCaller {
  postIngest(args: PostIngestArgs): Promise<PostIngestApiResult>;
  postIngestImage(args: PostIngestArgs): Promise<IngestImageResponse>;
}

/** 첨부를 보낸 메시지(플랫폼·메시지 id·채널·서버). 첨부 id 는 ingestAttachment 가 첨부마다 attachment.id 로 채운다. */
export type AttachmentSourceMessage = Omit<InputSourceMessage, "attachmentId">;

/**
 * 첨부 한 건을 14a 문서 라우트(POST /ingest)로 보낸다.
 *
 * 흐름: 형식 판정(classifyAttachment) → 못 받는 형식이면 거부(silent drop 금지) →
 * 받는 형식이면 url 다운로드 → text 는 UTF-8 문자열·document 는 base64 로 인코딩 →
 * buildIngestPayload → postIngest. 다운로드 실패·비2xx 는 구체 사유로 돌려준다.
 * payload 의 sourceMessage 는 message 에 이 첨부의 id 를 더한 값이다(WP-B1-20U 설계 17.8).
 *
 * 부수효과(fetch)는 이 함수에 두고, 형식 판정·payload 조립은 위 순수 함수에
 * 위임한다 — discord.js 를 import 하지 않으므로 순수 함수는 fixture data 로 검증.
 */
export async function ingestAttachment(
  apiClient: IngestCaller,
  attachment: AttachmentMetaLike,
  source: string,
  attribution: { author: string; userId: string },
  message: AttachmentSourceMessage,
  limitBytes: number = DEFAULT_MAX_ATTACHMENT_BYTES,
): Promise<AttachmentOutcome> {
  const classified = classifyAttachment(attachment);
  if (!classified.accepted) {
    return { status: "rejected", name: attachment.name, reason: classified.reason };
  }

  // 다운로드 — Content-Length 상한 + 실제 누적 byte 상한 두 겹으로 방어.
  // 실패는 구체 사유로 돌려준다(silent 무시 금지).
  let buf: ArrayBuffer;
  try {
    const res = await fetch(attachment.url);
    if (!res.ok) {
      return {
        status: "failed",
        name: attachment.name,
        reason: `다운로드 실패 (HTTP ${res.status} ${res.statusText})`,
      };
    }
    // 1단계: Content-Length 헤더가 있고 상한을 초과하면 본문 읽기 없이 차단.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limitBytes) {
      return {
        status: "failed",
        name: attachment.name,
        reason: `첨부가 너무 큽니다 (최대 ${limitBytes} byte)`,
      };
    }
    // 2단계: 스트림을 청크 단위로 읽으면서 누적 byte 를 측정.
    // Content-Length 가 없거나 신뢰할 수 없을 때도 실제 크기를 측정해 차단.
    const reader = res.body?.getReader();
    if (!reader) {
      return { status: "failed", name: attachment.name, reason: "본문 없음" };
    }
    let total = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel();
        return {
          status: "failed",
          name: attachment.name,
          reason: `첨부가 너무 큽니다 (최대 ${limitBytes} byte)`,
        };
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let off = 0;
    for (const ch of chunks) {
      merged.set(ch, off);
      off += ch.byteLength;
    }
    buf = merged.buffer;
  } catch (e) {
    return {
      status: "failed",
      name: attachment.name,
      reason: `다운로드 실패 (${e instanceof Error ? e.message : String(e)})`,
    };
  }

  // text = UTF-8 문자열 passthrough / document(PDF·docx) + image = base64.
  const data =
    classified.kind === "text"
      ? new TextDecoder().decode(new Uint8Array(buf))
      : Buffer.from(buf).toString("base64");

  const payload = buildIngestPayload({
    classified,
    data,
    originalName: attachment.name,
    source,
    attribution,
    sourceMessage: { ...message, attachmentId: attachment.id },
  });

  // 이미지 갈래(11a T7) — 응답 양식이 텍스트와 갈라져 별 메서드로 부른다.
  if (classified.kind === "image") {
    try {
      const result = await apiClient.postIngestImage(payload);
      const item = result.images[0];
      if (!item) {
        // T5 라우트가 항상 images 1 건을 돌려준다 — 빈 묶음은 계약 위반(silent 빈 결과 금지).
        return {
          status: "failed",
          name: attachment.name,
          reason: "POST /ingest 응답에 image 항목 없음 (계약 위반)",
        };
      }
      return { status: "ingested-image", name: attachment.name, image: item };
    } catch (e) {
      return {
        status: "failed",
        name: attachment.name,
        reason: `POST /ingest 실패 (${e instanceof Error ? e.message : String(e)})`,
      };
    }
  }

  try {
    const result = await apiClient.postIngest(payload);
    // 응답은 union(document·text·entity_patch) — 문서 갈래만 documentId 를 가진다.
    // 봇 문서첨부는 originalName 을 채워 항상 document 갈래로 오지만, text·
    // entity_patch 갈래가 오면 documentId 가 없다. undefined 를 그대로 흘리지 않고
    // 정직한 에러로 멈춘다(silent 무시 금지). image 갈래의 "계약 위반" 처리와 정합.
    if (!("documentId" in result) || typeof result.documentId !== "string") {
      return {
        status: "failed",
        name: attachment.name,
        reason: "POST /ingest 가 문서 갈래가 아닌 응답 반환 (계약 위반)",
      };
    }
    return { status: "ingested", name: attachment.name, documentId: result.documentId };
  } catch (e) {
    return {
      status: "failed",
      name: attachment.name,
      reason: `POST /ingest 실패 (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

// ── 표시 helper — 첨부 결과 한 줄 동반 메시지(11a T7) ────────────────────────

/**
 * AttachmentOutcome 한 건을 사람이 읽을 한 줄로 풀이한다. 봇 핸들러가 console.log /
 * console.warn 와 함께 디스코드 답장 등에 합류할 때 쓰는 표시 양식.
 *
 * - ingested(텍스트·문서) : "📝 {파일명} → document {documentId}"
 * - ingested-image       : "🖼️ {파일명} → 자산 sha {앞12} ({W×H}{,움직임}{,경고})"
 * - rejected             : "🚫 {파일명}: {사유}"
 * - failed               : "⚠️ {파일명} 실패: {사유}"
 *
 * sha256 은 앞 12 글자만 — 64 글자 전체는 노이즈. width/height/움직임/경고는 14b
 * 문서 분기 양식과 정합되는 정직한 보고(11a spec 4.6 정합 — 자산 보존 본질 표시).
 */
export function formatIngestResponse(outcome: AttachmentOutcome): string {
  if (outcome.status === "ingested") {
    return `📝 ${outcome.name} → document ${outcome.documentId}`;
  }
  if (outcome.status === "ingested-image") {
    const img = outcome.image;
    const parts: string[] = [`${img.width}×${img.height}`];
    if (img.isAnimated) parts.push("움직이는 이미지");
    if (img.warnings.length > 0) parts.push(`경고: ${img.warnings.join(" / ")}`);
    return `🖼️ ${outcome.name} → 자산 sha ${img.assetSha256.slice(0, 12)}… (${parts.join(", ")})`;
  }
  if (outcome.status === "rejected") {
    return `🚫 ${outcome.name}: ${outcome.reason}`;
  }
  return `⚠️ ${outcome.name} 실패: ${outcome.reason}`;
}
