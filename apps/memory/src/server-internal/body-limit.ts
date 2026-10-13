/**
 * body-limit.ts — 입력 byte 상한 미들웨어
 *
 * 두 단계로 상한을 강제한다:
 *   1단계: Content-Length 헤더가 상한을 초과하면 본문을 읽기 전에 즉시 413 반환.
 *   2단계: 헤더가 없거나 실제 본문이 선언보다 크면, 스트림을 읽으면서 누적 byte 가
 *          상한을 넘는 순간 읽기를 취소하고 413 반환.
 *
 * 경로 분기:
 *   /ingest 및 /ingest/*, /api/documents/:id/ocr-result
 *     → maxAssetBytes 적용 (파일·이미지·OCR Markdown 등 대형 자산)
 *   그 외 모든 경로 → maxTextBytes 적용 (텍스트 글 입력)
 *
 * getLimits 는 요청마다 호출하므로, 설정 변경이 다음 재시작 후 즉시 반영된다.
 */

import type { MiddlewareHandler } from "hono";

/** 경로별 byte 상한 쌍. 단위: byte. */
export interface BodyLimits {
  maxTextBytes: number;
  maxAssetBytes: number;
}

/** 대형 자산 body 를 받을 수 있는 경로인지 판단한다. */
function isAssetPath(path: string): boolean {
  return (
    path === "/ingest" ||
    path.startsWith("/ingest/") ||
    /^\/api\/documents\/[^/]+\/ocr-result$/.test(path)
  );
}

/** 초과 시 반환할 오류 메시지 — 상한 값을 명시한다. */
function overLimitMessage(limit: number): string {
  return `입력이 너무 큽니다 — 최대 ${limit} byte 까지 허용됩니다.`;
}

/**
 * byte 상한 미들웨어를 생성한다.
 *
 * @param getLimits - 요청 처리 시점에 현재 상한을 반환하는 함수.
 *                   값을 한 번만 읽어 고정하지 말고 항상 이 함수를 통해 조회한다.
 */
export function createBodyLimit(getLimits: () => BodyLimits): MiddlewareHandler {
  return async (c, next) => {
    const limits = getLimits();
    const limit = isAssetPath(c.req.path) ? limits.maxAssetBytes : limits.maxTextBytes;

    // 1단계: Content-Length 헤더 선검사 — 본문 스트리밍 전에 빠르게 차단
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > limit) {
      return c.json({ error: overLimitMessage(limit) }, 413);
    }

    // 2단계: 실제 byte 누적 확인
    const rawBody = c.req.raw.body;
    if (rawBody) {
      let total = 0;
      const reader = rawBody.getReader();
      const chunks: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          // 읽기를 취소해 네트워크 자원을 해제한다
          await reader.cancel();
          return c.json({ error: overLimitMessage(limit) }, 413);
        }
        chunks.push(value);
      }

      // 읽은 청크를 하나의 버퍼로 합쳐 새 Request 를 만든다.
      // c.req.raw 를 재할당하면 Hono 가 하위 핸들러에서 이 Request 를 읽는다
      // (Hono 4.x — 프로브로 검증 완료).
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }

      c.req.raw = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: total > 0 ? merged : undefined,
      });
    }

    await next();
  };
}
