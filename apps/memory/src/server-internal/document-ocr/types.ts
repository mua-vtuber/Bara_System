/**
 * document-ocr/types.ts — 서버 문서 OCR 모듈들이 같이 쓰는 값 모양과 오류 (2026-10-11 spec D9·D10).
 * 다른 모듈을 import 하지 않는 순수 타입·오류 파일이다.
 */

/** OCR 대상 원본 자산(문서가 처음 들어올 때의 파일). */
export interface OcrAsset {
  sha256: string;
  bytes: Uint8Array;
  mimeType: string;
  originalName: string;
}

/** AI 에 보낼 쪽 그림 한 장. pageIndex 는 0 부터. */
export interface OcrPageImage {
  pageIndex: number;
  pageCount: number;
  mimeType: "image/png";
  bytes: Uint8Array;
}

/** 쪽(파일 업로드 API 는 문서 1건) 하나를 읽은 결과. 사용량은 공급자가 준 경우만(없으면 null). */
export interface OcrPageResult {
  markdown: string;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  /** 공급자가 정상 종료했는데 글이 없던 빈 쪽(markdown 은 ""). */
  blank: boolean;
}

/** 오류 3분류 — 정리 깊은 패스와 같은 뜻. */
export type OcrErrorClass = "transient" | "deterministic" | "config";

/** 설정 결함(칸 비어 있음·지원 안 하는 조합·쪽 그림 모듈 로드 실패) — 분류 "config", 문서 탓이 아님. */
export class DocumentOcrConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DocumentOcrConfigError";
  }
}

/** 분류를 마친 쪽 실패. 문장은 이미 키 가림을 거쳤다. */
export class OcrPageError extends Error {
  readonly klass: OcrErrorClass;
  readonly retryAfterMs: number | null;
  /** 공급자가 돌려준 HTTP 상태(전송 오류일 때). 응답 없음·우리 판정은 null. */
  readonly httpStatus: number | null;
  constructor(message: string, klass: OcrErrorClass, retryAfterMs: number | null = null, httpStatus: number | null = null) {
    super(message);
    this.name = "OcrPageError";
    this.klass = klass;
    this.retryAfterMs = retryAfterMs;
    this.httpStatus = httpStatus;
  }
}
