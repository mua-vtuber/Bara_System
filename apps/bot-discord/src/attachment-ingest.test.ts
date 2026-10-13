/**
 * attachment-ingest 순수 함수 단위 테스트 (Phase 14b T5 + Phase 11a T7).
 *
 * mock 객체 없음 (CLAUDE.md 정책) — discord.js Client/Message 를 가짜로 구현하지
 * 않는다. 디스코드 첨부 메타를 흉내낸 plain object(fixture data)로 순수 함수를 덮는다.
 * 다운로드 byte 상한(ingestAttachment)만 서버가 필요해 loopback Bun.serve 와 진짜
 * MemoryApiClient 로 확인한다 — fetch 를 교체하거나 호출자를 손으로 만들지 않는다.
 * 문서·이미지가 실 코어에 저장되는 글루 흐름은 attachment-ingest.integration.test.ts 가 덮는다.
 *
 * 검증 항목:
 *   ① classifyAttachment — 14a 가 받는 형식(텍스트·MD·PDF·docx) + 11a 가 받는
 *      이미지 6 종(png/jpeg/gif/webp/apng/avif — 11d D6) 통과. 받지 않는 이미지
 *      (svg+xml·tiff·bmp)는 image/* 정직 알림으로 거부. 그 외(mp3 등)는 일반 거부.
 *   ② buildIngestPayload — payload 형태(source/content/attribution/originalName/
 *      mimeType/sourceMessage)가 PostIngestArgs 와 맞는지. 텍스트·MD 는 type:"text" + UTF-8 문자열,
 *      PDF·docx 는 type:"auto" + base64, 이미지는 type:"image" + base64.
 *   ③ formatIngestResponse — outcome 갈래별 한 줄 표시(11a T7) — 이미지 갈래는
 *      sha 앞 12 + 크기 + 움직임/경고 합류 표시, 거부·실패는 사유 동반.
 *   ④ ingestAttachment 다운로드 byte 상한 — Content-Length 선차단, 스트림 누적 차단,
 *      상한과 같은 크기는 통과해 API 까지 감.
 */

import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import type { Server, TCPSocketListener } from "bun";
import {
  classifyAttachment,
  buildIngestPayload,
  formatIngestResponse,
  ingestAttachment,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  type AttachmentMetaLike,
  type AttachmentSourceMessage,
} from "./attachment-ingest.ts";
import { MemoryApiClient, type IngestImageItem } from "../../memory/src/api-client.ts";
import { SUPPORTED_IMAGE_MIMES } from "../../memory/src/memory/ingest-image.ts";

// ── fixture: 첨부를 보낸 메시지(WP-B1-20U 설계 17.8) ──────────────────────────

const MESSAGE: AttachmentSourceMessage = {
  platform: "discord",
  messageId: "msg-1",
  channelId: "channel-1",
  guildId: "guild-1",
};
const ATTACHMENT_MESSAGE = { ...MESSAGE, attachmentId: "att-1" };

// ── fixture: 디스코드 첨부 메타 흉내 (plain object) ──────────────────────────

const PDF: AttachmentMetaLike = {
  id: "att-1",
  name: "회의록.pdf",
  contentType: "application/pdf",
  url: "https://cdn.example/회의록.pdf",
  size: 1024,
};
const DOCX: AttachmentMetaLike = {
  id: "att-2",
  name: "기획서.docx",
  contentType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  url: "https://cdn.example/기획서.docx",
  size: 2048,
};
const TXT: AttachmentMetaLike = {
  id: "att-3",
  name: "메모.txt",
  contentType: "text/plain",
  url: "https://cdn.example/메모.txt",
  size: 128,
};
const MD: AttachmentMetaLike = {
  id: "att-4",
  name: "노트.md",
  contentType: "text/markdown",
  url: "https://cdn.example/노트.md",
  size: 256,
};
const PNG: AttachmentMetaLike = {
  id: "att-5",
  name: "그림.png",
  contentType: "image/png",
  url: "https://cdn.example/그림.png",
  size: 4096,
};
const JPEG: AttachmentMetaLike = {
  id: "att-6",
  name: "사진.jpg",
  contentType: "image/jpeg",
  url: "https://cdn.example/사진.jpg",
  size: 5120,
};
const GIF: AttachmentMetaLike = {
  id: "att-7",
  name: "짤.gif",
  contentType: "image/gif",
  url: "https://cdn.example/짤.gif",
  size: 6144,
};
const WEBP: AttachmentMetaLike = {
  id: "att-8",
  name: "그림.webp",
  contentType: "image/webp",
  url: "https://cdn.example/그림.webp",
  size: 3072,
};
const APNG: AttachmentMetaLike = {
  id: "att-9",
  name: "움직임.apng",
  contentType: "image/apng",
  url: "https://cdn.example/움직임.apng",
  size: 7168,
};
const AVIF: AttachmentMetaLike = {
  id: "att-10",
  name: "최신.avif",
  contentType: "image/avif",
  url: "https://cdn.example/최신.avif",
  size: 2048,
};
const SVG: AttachmentMetaLike = {
  id: "att-11",
  name: "벡터.svg",
  contentType: "image/svg+xml",
  url: "https://cdn.example/벡터.svg",
  size: 2048,
};
const TIFF: AttachmentMetaLike = {
  id: "att-12",
  name: "tif원본.tiff",
  contentType: "image/tiff",
  url: "https://cdn.example/tif원본.tiff",
  size: 10240,
};
const BMP: AttachmentMetaLike = {
  id: "att-13",
  name: "비트맵.bmp",
  contentType: "image/bmp",
  url: "https://cdn.example/비트맵.bmp",
  size: 16384,
};
const MP3: AttachmentMetaLike = {
  id: "att-14",
  name: "녹음.mp3",
  contentType: "audio/mpeg",
  url: "https://cdn.example/녹음.mp3",
  size: 8192,
};

describe("classifyAttachment — 14a 가 받는 형식만 통과", () => {
  test("PDF 는 받음 (kind=document, mimeType 확정)", () => {
    const r = classifyAttachment(PDF);
    expect(r.accepted).toBe(true);
    if (r.accepted) {
      expect(r.kind).toBe("document");
      expect(r.mimeType).toBe("application/pdf");
    }
  });

  test("docx 는 받음 (kind=document)", () => {
    const r = classifyAttachment(DOCX);
    expect(r.accepted).toBe(true);
    if (r.accepted) {
      expect(r.kind).toBe("document");
      expect(r.mimeType).toContain("wordprocessingml");
    }
  });

  test("txt 는 받음 (kind=text)", () => {
    const r = classifyAttachment(TXT);
    expect(r.accepted).toBe(true);
    if (r.accepted) {
      expect(r.kind).toBe("text");
      expect(r.mimeType).toBe("text/plain");
    }
  });

  test("md 는 받음 (kind=text)", () => {
    const r = classifyAttachment(MD);
    expect(r.accepted).toBe(true);
    if (r.accepted) {
      expect(r.kind).toBe("text");
      expect(r.mimeType).toBe("text/markdown");
    }
  });

  test("mp3 는 거부 + 사람이 읽을 사유", () => {
    const r = classifyAttachment(MP3);
    expect(r.accepted).toBe(false);
    if (!r.accepted) {
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  test("contentType 없고 확장자만 .pdf — 확장자로 받음", () => {
    const r = classifyAttachment({
      id: "att-inline-1",
      name: "확장자만.pdf",
      contentType: null,
      url: "https://cdn.example/확장자만.pdf",
      size: 10,
    });
    expect(r.accepted).toBe(true);
    if (r.accepted) {
      expect(r.kind).toBe("document");
      expect(r.mimeType).toBe("application/pdf");
    }
  });

  test("contentType 없고 확장자만 .md — 확장자로 받음 (text)", () => {
    const r = classifyAttachment({
      id: "att-inline-2",
      name: "확장자만.md",
      contentType: undefined,
      url: "https://cdn.example/확장자만.md",
      size: 10,
    });
    expect(r.accepted).toBe(true);
    if (r.accepted) expect(r.kind).toBe("text");
  });

  test("contentType·확장자 둘 다 모르는 형식 — 거부", () => {
    const r = classifyAttachment({
      id: "att-inline-3",
      name: "수수께끼.bin",
      contentType: "application/octet-stream",
      url: "https://cdn.example/수수께끼.bin",
      size: 10,
    });
    expect(r.accepted).toBe(false);
  });

  test("text/plain 에 charset 붙은 contentType 도 text 로 받음", () => {
    const r = classifyAttachment({
      id: "att-inline-4",
      name: "메모.txt",
      contentType: "text/plain; charset=utf-8",
      url: "https://cdn.example/메모.txt",
      size: 10,
    });
    expect(r.accepted).toBe(true);
    if (r.accepted) expect(r.kind).toBe("text");
  });
});

describe("classifyAttachment — 이미지 6 종 합류(11a T7 / 11d D6)", () => {
  test("png 는 받음 (kind=image, mimeType=image/png)", () => {
    const r = classifyAttachment(PNG);
    expect(r.accepted).toBe(true);
    if (r.accepted) {
      expect(r.kind).toBe("image");
      expect(r.mimeType).toBe("image/png");
    }
  });

  test("jpeg 는 받음 (kind=image, mimeType=image/jpeg)", () => {
    const r = classifyAttachment(JPEG);
    expect(r.accepted).toBe(true);
    if (r.accepted) {
      expect(r.kind).toBe("image");
      expect(r.mimeType).toBe("image/jpeg");
    }
  });

  test("gif 는 받음 (kind=image)", () => {
    const r = classifyAttachment(GIF);
    expect(r.accepted).toBe(true);
    if (r.accepted) expect(r.kind).toBe("image");
  });

  test("webp 는 받음 (kind=image)", () => {
    const r = classifyAttachment(WEBP);
    expect(r.accepted).toBe(true);
    if (r.accepted) expect(r.kind).toBe("image");
  });

  test("apng 는 받음 (kind=image)", () => {
    const r = classifyAttachment(APNG);
    expect(r.accepted).toBe(true);
    if (r.accepted) expect(r.kind).toBe("image");
  });

  test("avif 는 받음 (kind=image, mimeType=image/avif) — 11d D6", () => {
    const r = classifyAttachment(AVIF);
    expect(r.accepted).toBe(true);
    if (r.accepted) {
      expect(r.kind).toBe("image");
      expect(r.mimeType).toBe("image/avif");
    }
  });

  test("contentType 없고 확장자만 .avif — 확장자로 받음 (image) — 11d D6", () => {
    const r = classifyAttachment({
      id: "att-inline-5",
      name: "확장자만.avif",
      contentType: null,
      url: "https://cdn.example/확장자만.avif",
      size: 100,
    });
    expect(r.accepted).toBe(true);
    if (r.accepted) {
      expect(r.kind).toBe("image");
      expect(r.mimeType).toBe("image/avif");
    }
  });

  test("svg+xml 은 거부 + 이미지 형식 안내 사유", () => {
    const r = classifyAttachment(SVG);
    expect(r.accepted).toBe(false);
    if (!r.accepted) {
      expect(r.reason).toContain("이미지 형식");
      expect(r.reason).toContain("svg+xml");
    }
  });

  test("tiff 는 거부 + 이미지 형식 안내 사유", () => {
    const r = classifyAttachment(TIFF);
    expect(r.accepted).toBe(false);
    if (!r.accepted) {
      expect(r.reason).toContain("이미지 형식");
      expect(r.reason).toContain("tiff");
    }
  });

  test("bmp 는 거부 + 이미지 형식 안내 사유", () => {
    const r = classifyAttachment(BMP);
    expect(r.accepted).toBe(false);
    if (!r.accepted) {
      expect(r.reason).toContain("이미지 형식");
      expect(r.reason).toContain("bmp");
    }
  });

  test("contentType 없고 확장자만 .png — 확장자로 받음 (image)", () => {
    const r = classifyAttachment({
      id: "att-inline-6",
      name: "확장자만.png",
      contentType: null,
      url: "https://cdn.example/확장자만.png",
      size: 100,
    });
    expect(r.accepted).toBe(true);
    if (r.accepted) {
      expect(r.kind).toBe("image");
      expect(r.mimeType).toBe("image/png");
    }
  });

  test("contentType 없고 확장자만 .jpg — 확장자로 받음 (image)", () => {
    const r = classifyAttachment({
      id: "att-inline-7",
      name: "사진만.jpg",
      contentType: undefined,
      url: "https://cdn.example/사진만.jpg",
      size: 100,
    });
    expect(r.accepted).toBe(true);
    if (r.accepted) {
      expect(r.kind).toBe("image");
      expect(r.mimeType).toBe("image/jpeg");
    }
  });

  // ── Phase 11d D6: 코어 SUPPORTED_IMAGE_MIMES 단일 권위 정합 ──
  // 봇은 contentType 분기에서 코어 SUPPORTED_IMAGE_MIMES 를 직접 import 해 쓴다.
  // 이 테스트가 코어 묶음의 모든 mime 을 classifyAttachment 에 넣어 kind=image 로
  // 받는지 대조 — 코어가 늘면 봇도 자동 합류, 따로 손볼 곳이 없음을 보장한다.
  test("코어 SUPPORTED_IMAGE_MIMES 모든 mime 이 kind=image 로 받힌다 (avif 포함)", () => {
    expect(SUPPORTED_IMAGE_MIMES.has("image/avif")).toBe(true);
    for (const mime of SUPPORTED_IMAGE_MIMES) {
      const r = classifyAttachment({
        id: "att-inline-8",
        name: `자산-${mime.replace("/", "-")}`,
        contentType: mime,
        url: "https://cdn.example/x",
        size: 100,
      });
      expect(r.accepted).toBe(true);
      if (r.accepted) {
        expect(r.kind).toBe("image");
        expect(r.mimeType).toBe(mime);
      }
    }
  });
});

describe("buildIngestPayload — PostIngestArgs 형태 정합", () => {
  const attribution = { author: "서버닉", userId: "user_42" };

  test("PDF — type:auto + base64 data + mimeType + originalName", () => {
    const payload = buildIngestPayload({
      classified: { accepted: true, kind: "document", mimeType: "application/pdf" },
      data: "QkFTRTY0",
      originalName: "회의록.pdf",
      source: "discord-dm",
      attribution,
      sourceMessage: ATTACHMENT_MESSAGE,
    });
    expect(payload.content.type).toBe("auto");
    expect(payload.content.data).toBe("QkFTRTY0");
    expect(payload.content.mimeType).toBe("application/pdf");
    expect(payload.content.originalName).toBe("회의록.pdf");
    expect(payload.source).toBe("discord-dm");
    expect(payload.attribution).toEqual(attribution);
  });

  test("docx — type:auto + base64", () => {
    const payload = buildIngestPayload({
      classified: {
        accepted: true,
        kind: "document",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      data: "ZG9jeA==",
      originalName: "기획서.docx",
      source: "discord-channel",
      attribution,
      sourceMessage: ATTACHMENT_MESSAGE,
    });
    expect(payload.content.type).toBe("auto");
    expect(payload.content.mimeType).toContain("wordprocessingml");
  });

  test("txt/md — type:text + UTF-8 문자열 (base64 아님)", () => {
    const payload = buildIngestPayload({
      classified: { accepted: true, kind: "text", mimeType: "text/markdown" },
      data: "# 안녕\n위 줄",
      originalName: "노트.md",
      source: "discord-dm",
      attribution,
      sourceMessage: ATTACHMENT_MESSAGE,
    });
    expect(payload.content.type).toBe("text");
    expect(payload.content.data).toBe("# 안녕\n위 줄");
    expect(payload.content.mimeType).toBe("text/markdown");
    expect(payload.content.originalName).toBe("노트.md");
  });

  test("이미지 png — type:image + base64 + mimeType + originalName (11a T7)", () => {
    const payload = buildIngestPayload({
      classified: { accepted: true, kind: "image", mimeType: "image/png" },
      data: "iVBORw0KGgo=",
      originalName: "그림.png",
      source: "discord-dm",
      attribution,
      sourceMessage: ATTACHMENT_MESSAGE,
    });
    expect(payload.content.type).toBe("image");
    expect(payload.content.data).toBe("iVBORw0KGgo=");
    expect(payload.content.mimeType).toBe("image/png");
    expect(payload.content.originalName).toBe("그림.png");
    expect(payload.source).toBe("discord-dm");
    expect(payload.attribution).toEqual(attribution);
  });

  test("이미지 gif — type:image + base64 (움직임 갈래도 형식 한 한)", () => {
    const payload = buildIngestPayload({
      classified: { accepted: true, kind: "image", mimeType: "image/gif" },
      data: "R0lGODlh",
      originalName: "짤.gif",
      source: "discord-channel",
      attribution,
      sourceMessage: ATTACHMENT_MESSAGE,
    });
    expect(payload.content.type).toBe("image");
    expect(payload.content.mimeType).toBe("image/gif");
  });

  test("sourceMessage — 세 갈래 모두 메시지·채널·서버·첨부 id 를 그대로 싣는다(WP-B1-20U 설계 17.8)", () => {
    const kinds = [
      { accepted: true, kind: "text", mimeType: "text/markdown" },
      { accepted: true, kind: "document", mimeType: "application/pdf" },
      { accepted: true, kind: "image", mimeType: "image/png" },
    ] as const;
    for (const classified of kinds) {
      const payload = buildIngestPayload({
        classified, data: "eA==", originalName: "첨부", source: "discord-channel", attribution,
        sourceMessage: ATTACHMENT_MESSAGE,
      });
      expect(payload.sourceMessage).toEqual({
        platform: "discord", messageId: "msg-1", channelId: "channel-1", guildId: "guild-1", attachmentId: "att-1",
      });
    }
    // DM(서버 없음)은 guildId null 그대로.
    const dm = buildIngestPayload({
      classified: kinds[0], data: "x", originalName: "메모.txt", source: "discord-dm", attribution,
      sourceMessage: { ...ATTACHMENT_MESSAGE, guildId: null },
    });
    expect(dm.sourceMessage).toEqual({
      platform: "discord", messageId: "msg-1", channelId: "channel-1", guildId: null, attachmentId: "att-1",
    });
  });
});

describe("formatIngestResponse — outcome 갈래별 한 줄 표시(11a T7)", () => {
  test("ingested(텍스트·문서) → 📝 documentId 라벨", () => {
    const line = formatIngestResponse({
      status: "ingested",
      name: "회의록.pdf",
      documentId: "doc_abc123",
    });
    expect(line).toContain("회의록.pdf");
    expect(line).toContain("doc_abc123");
    expect(line).toContain("📝");
  });

  test("ingested-image → 🖼️ sha 앞 12 + 가로×세로 + 경고 합류", () => {
    const image: IngestImageItem = {
      assetSha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      thumbSha256: "thumb000000000000000000000000000000000000000000000000000000000000",
      nodeId: 42,
      width: 1024,
      height: 768,
      isAnimated: false,
      warnings: ["원본 GIF — 첫 프레임 PNG 강등"],
      mime: "image/png",
    };
    const line = formatIngestResponse({
      status: "ingested-image",
      name: "그림.png",
      image,
    });
    expect(line).toContain("🖼️");
    expect(line).toContain("그림.png");
    expect(line).toContain("abcdef012345");
    expect(line).toContain("1024×768");
    expect(line).toContain("첫 프레임 PNG 강등");
  });

  test("ingested-image 움직임 → 'movement' 라벨 합류", () => {
    const image: IngestImageItem = {
      assetSha256: "111111111111111111111111111111111111111111111111111111111111aaaa",
      thumbSha256: "2222222222222222222222222222222222222222222222222222222222222222",
      nodeId: 7,
      width: 320,
      height: 240,
      isAnimated: true,
      warnings: [],
      mime: "image/gif",
    };
    const line = formatIngestResponse({
      status: "ingested-image",
      name: "춤.gif",
      image,
    });
    expect(line).toContain("움직이는 이미지");
    expect(line).toContain("320×240");
  });

  test("rejected → 🚫 + 사유", () => {
    const line = formatIngestResponse({
      status: "rejected",
      name: "벡터.svg",
      reason: "image/svg+xml 이미지 형식은 아직 안 받아요",
    });
    expect(line).toContain("🚫");
    expect(line).toContain("벡터.svg");
    expect(line).toContain("svg+xml");
  });

  test("failed → ⚠️ + 사유", () => {
    const line = formatIngestResponse({
      status: "failed",
      name: "사진.jpg",
      reason: "다운로드 실패 (HTTP 404 Not Found)",
    });
    expect(line).toContain("⚠️");
    expect(line).toContain("사진.jpg");
    expect(line).toContain("404");
  });
});

// ── byte 상한 — ingestAttachment 다운로드 제한 ────────────────────────────────
//
// 진짜 loopback 서버 + 진짜 MemoryApiClient. mock 클래스·fetch 교체 없음(CLAUDE.md 정책).
//   - 파일 서버: 첨부 URL 이 가리키는 곳. 상한과 같은 크기의 정상 응답은 Bun.serve 로 내려준다.
//     Bun.serve 는 본문 길이에 맞춰 Content-Length 를 다시 쓰고 작은 스트림도 길이를 정해 보내므로,
//     "헤더만 상한 초과" 와 "Content-Length 없는 chunked 본문" 은 raw TCP 소켓으로 응답 바이트를 그대로 보낸다.
//     그래서 헤더 선차단이 빠지면 본문 읽기에서 연결 오류가 나고, 스트림 누적 차단이 빠지면 API 까지 가버린다.
//   - API 서버: POST /ingest 에 닿은 요청을 세고 500 으로 답한다. 상한 판정이 다운로드 단계에서
//     끝나는지(닿은 요청 0 건), 상한과 같은 크기는 막히지 않고 API 까지 가는지(1 건) 가린다.
//     문서가 실제로 저장되는 흐름은 attachment-ingest.integration.test.ts 가 실 코어로 검증한다.

const CAP = 100; // 테스트용 작은 상한(100 byte)

const ATTRIBUTION = { author: "테스트닉", userId: "u_test_42" };
const SOURCE = "discord-dm";

const PATH_EXACT_CAP = "/exact-cap.txt";

/** HTTP/1.1 의 줄 구분. */
const CRLF = "\r\n";

/** 지정한 헤더 줄과 본문을 그대로 돌려주는 raw TCP 서버(HTTP/1.1 200). 연결마다 한 번 응답하고 닫는다. */
function listenRaw(headerLines: string[], body: string): TCPSocketListener<undefined> {
  return Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        socket.end(["HTTP/1.1 200 OK", ...headerLines, "Connection: close", "", body].join(CRLF));
      },
    },
  });
}

let fileServer: Server<undefined>;
/** Content-Length 만 상한을 넘고 본문은 4 byte 뿐인 응답. */
let declaredOverServer: TCPSocketListener<undefined>;
/** Content-Length 없이 상한을 넘는 본문을 chunked 한 덩어리로 보내는 응답. */
let streamOverServer: TCPSocketListener<undefined>;
let apiServer: Server<undefined>;
let apiClient: MemoryApiClient;
/** API 서버에 닿은 요청("METHOD /path") — 다운로드 단계에서 끝난 시험은 비어 있어야 한다. */
let apiRequests: string[];

beforeEach(() => {
  apiRequests = [];
  fileServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (new URL(req.url).pathname === PATH_EXACT_CAP) {
        return new Response(new Uint8Array(CAP).fill(65), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  declaredOverServer = listenRaw([`Content-Length: ${CAP + 1}`], "AAAA");
  // chunked 본문 = "<16진수 길이>CRLF<데이터>CRLF" 한 덩어리 + 끝 표시 "0CRLFCRLF".
  const overSize = CAP + 10;
  streamOverServer = listenRaw(
    ["Transfer-Encoding: chunked"],
    [overSize.toString(16), "A".repeat(overSize), "0", "", ""].join(CRLF),
  );
  apiServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      apiRequests.push(`${req.method} ${new URL(req.url).pathname}`);
      return new Response(JSON.stringify({ error: "강제 500" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    },
  });
  apiClient = new MemoryApiClient(`http://127.0.0.1:${apiServer.port}`);
});

afterEach(() => {
  fileServer.stop(true);
  declaredOverServer.stop(true);
  streamOverServer.stop(true);
  apiServer.stop(true);
});

function attachmentAt(url: string, name: string, id: string, size: number): AttachmentMetaLike {
  return { id, name, contentType: "text/plain", url, size };
}

describe("ingestAttachment — byte 상한 (Content-Length + 실제 스트림)", () => {
  test("Content-Length 가 상한 초과 → 본문 읽기 없이 failed + API 에 요청 안 감", async () => {
    const outcome = await ingestAttachment(
      apiClient,
      attachmentAt(`http://127.0.0.1:${declaredOverServer.port}/declared-over.txt`, "큰파일.txt", "att-15", CAP + 1),
      SOURCE,
      ATTRIBUTION,
      MESSAGE,
      CAP,
    );

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.name).toBe("큰파일.txt");
    // 사유 안에 상한 숫자가 포함되어야 한다(어떤 상한인지 알 수 있게).
    expect(outcome.reason).toContain(String(CAP));
    expect(apiRequests).toEqual([]);
  });

  test("Content-Length 없고 본문이 상한 초과 → 스트림 읽다가 failed + API 에 요청 안 감", async () => {
    const outcome = await ingestAttachment(
      apiClient,
      attachmentAt(`http://127.0.0.1:${streamOverServer.port}/stream-over.txt`, "큰스트림.txt", "att-16", CAP + 10),
      SOURCE,
      ATTRIBUTION,
      MESSAGE,
      CAP,
    );

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.name).toBe("큰스트림.txt");
    expect(outcome.reason).toContain(String(CAP));
    expect(apiRequests).toEqual([]);
  });

  test("상한과 같은 크기 첨부 → 상한에 막히지 않고 POST /ingest 까지 간다", async () => {
    const outcome = await ingestAttachment(
      apiClient,
      attachmentAt(`http://127.0.0.1:${fileServer.port}${PATH_EXACT_CAP}`, "경계파일.txt", "att-17", CAP),
      SOURCE,
      ATTRIBUTION,
      MESSAGE,
      CAP,
    );

    // API 서버가 500 으로 답하므로 failed 이지만, 사유는 상한이 아니라 POST /ingest 단계다.
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.reason).toContain("POST /ingest 실패");
    expect(outcome.reason).not.toContain("너무 큽니다");
    expect(apiRequests).toEqual(["POST /ingest"]);
  });

  test("DEFAULT_MAX_ATTACHMENT_BYTES 는 64 MiB (64 * 1024 * 1024)", () => {
    expect(DEFAULT_MAX_ATTACHMENT_BYTES).toBe(64 * 1024 * 1024);
  });
});
