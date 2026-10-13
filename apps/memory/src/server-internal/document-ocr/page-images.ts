/**
 * document-ocr/page-images.ts — 문서를 AI 에 보낼 쪽 그림(png)으로 만든다 (2026-10-11 spec D10, 사용자 결정 Q7).
 *
 * 사용자 결정(Q4·Q7): AI 에는 그림만 보내고, PDF 는 쪽을 화면에 보이는 그대로 그린다 —
 * unpdf `renderPageAsImage` + 그림 그리는 부품 `@napi-rs/canvas`(네이티브 모듈).
 *
 *   - application/pdf → 쪽마다 png. 긴 변이 documents.ocr.pageImage.maxEdgePx 가 되게 비율을 맞춘다.
 *   - image/*        → 1쪽. 같은 긴 변 규칙으로 줄여 png 로 다시 만든다(지금은 문서로 들어오지 않지만 규칙상 허용).
 *   - docx·그 밖     → 서버 OCR 대상이 아님(사유를 돌려줌 — 원장에 실패를 쌓지 않고 후보에서만 뺀다).
 *
 * 그림 부품을 불러오지 못하면(설치 누락·플랫폼 미지원) DocumentOcrConfigError("쪽 그림 모듈(@napi-rs/canvas)을
 * 불러오지 못함: <원인>") — 조용히 건너뛰지 않고 상태 화면에 설정 문제로 보인다. 손상 PDF·쪽 그리기 실패는
 * 일반 오류(결정적 실패)로 던진다.
 */

import { createIsomorphicCanvasFactory, getDocumentProxy, renderPageAsImage } from "unpdf";
import { DocumentOcrConfigError, type OcrAsset, type OcrPageImage } from "./types.ts";

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const CANVAS_MODULE = "@napi-rs/canvas";

type CanvasModule = typeof import("@napi-rs/canvas");
type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

export interface DocumentPageImageSource {
  /** 이 자산이 서버 OCR 대상인지. 아니면 사람이 읽을 사유(상태 화면 "서버 OCR 대상 아님" 묶음). */
  eligibility(asset: { mimeType: string }): { ok: true } | { ok: false; reason: string };
  pageCount(asset: OcrAsset): Promise<number>;
  renderPage(asset: OcrAsset, pageIndex: number, maxEdgePx: number): Promise<OcrPageImage>;
  /** 열어 둔 PDF 를 닫는다(사이클 끝). */
  dispose(): Promise<void>;
}

/** 서버 OCR 대상 판정 — 그림 부품 없이도 판단한다(상태 화면이 쓴다). */
export function documentOcrEligibility(asset: { mimeType: string }): { ok: true } | { ok: false; reason: string } {
  const mime = asset.mimeType.toLowerCase();
  if (mime === PDF_MIME || mime.startsWith("image/")) return { ok: true };
  if (mime === DOCX_MIME) return { ok: false, reason: "docx 는 서버 OCR 대상이 아님 — 내 PC 보조 프로그램을 쓰세요" };
  return { ok: false, reason: `${asset.mimeType} 형식은 서버 OCR 대상이 아님 — 내 PC 보조 프로그램을 쓰세요` };
}

/** 긴 변을 maxEdgePx 에 맞추는 배율. */
function scaleFor(width: number, height: number, maxEdgePx: number): number {
  const longest = Math.max(width, height);
  if (!(longest > 0)) throw new Error(`쪽 크기를 알 수 없음 (width=${width}, height=${height})`);
  return maxEdgePx / longest;
}

let canvasLoad: Promise<CanvasModule> | null = null;

/** 그림 부품을 한 번만 불러온다. 실패는 이름 있는 설정 오류(다음 호출에서 다시 시도). */
export async function loadCanvasModule(importer: () => Promise<CanvasModule> = () => import(CANVAS_MODULE)): Promise<CanvasModule> {
  if (!canvasLoad) {
    canvasLoad = importer().then((mod) => {
      if (typeof mod.createCanvas !== "function") throw new Error("createCanvas 가 없음");
      return mod;
    });
    canvasLoad.catch(() => { canvasLoad = null; });
  }
  try {
    return await canvasLoad;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new DocumentOcrConfigError(`쪽 그림 모듈(${CANVAS_MODULE})을 불러오지 못함: ${reason}`, { cause: err });
  }
}

export interface PdfPageImageSourceOptions {
  /** 테스트 전용 — 그림 부품 불러오기를 바꿔 로드 실패를 재현한다. 운영 배선은 넘기지 않는다. */
  canvasImporter?: () => Promise<CanvasModule>;
}

export function createDocumentPageImageSource(options: PdfPageImageSourceOptions = {}): DocumentPageImageSource {
  const importer = options.canvasImporter;
  let open: { sha256: string; pdf: PdfDocument } | null = null;

  async function canvas(): Promise<CanvasModule> {
    return importer ? loadCanvasModuleFresh(importer) : loadCanvasModule();
  }

  async function pdfFor(asset: OcrAsset): Promise<PdfDocument> {
    if (open && open.sha256 === asset.sha256) return open.pdf;
    const mod = await canvas();
    if (open) await open.pdf.destroy();
    open = null;
    const CanvasFactory = await createIsomorphicCanvasFactory(() => Promise.resolve(mod));
    // pdf.js 가 받은 버퍼를 넘겨받아 비우므로 사본을 준다.
    const pdf = await getDocumentProxy(new Uint8Array(asset.bytes), { CanvasFactory });
    open = { sha256: asset.sha256, pdf };
    return pdf;
  }

  async function renderImageAsset(asset: OcrAsset, maxEdgePx: number): Promise<Uint8Array> {
    const mod = await canvas();
    const image = await mod.loadImage(Buffer.from(asset.bytes));
    const scale = Math.min(1, scaleFor(image.width, image.height, maxEdgePx));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const target = mod.createCanvas(width, height);
    target.getContext("2d").drawImage(image, 0, 0, width, height);
    return new Uint8Array(await target.encode("png"));
  }

  return {
    eligibility: documentOcrEligibility,

    async pageCount(asset) {
      const verdict = documentOcrEligibility(asset);
      if (!verdict.ok) throw new Error(verdict.reason);
      if (asset.mimeType.toLowerCase() !== PDF_MIME) return 1;
      return (await pdfFor(asset)).numPages;
    },

    async renderPage(asset, pageIndex, maxEdgePx) {
      if (asset.mimeType.toLowerCase() !== PDF_MIME) {
        if (pageIndex !== 0) throw new Error(`그림 자산은 1쪽뿐 (pageIndex=${pageIndex})`);
        return { pageIndex: 0, pageCount: 1, mimeType: "image/png", bytes: await renderImageAsset(asset, maxEdgePx) };
      }
      const mod = await canvas();
      const pdf = await pdfFor(asset);
      const page = await pdf.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 1 });
      const png = await renderPageAsImage(pdf, pageIndex + 1, {
        canvasImport: () => Promise.resolve(mod),
        scale: scaleFor(viewport.width, viewport.height, maxEdgePx),
      });
      return { pageIndex, pageCount: pdf.numPages, mimeType: "image/png", bytes: new Uint8Array(png) };
    },

    async dispose() {
      if (open) await open.pdf.destroy();
      open = null;
    },
  };
}

/** 주입한 불러오기 함수로 매번 불러온다(캐시 없음 — 테스트에서 실패 재현용). */
async function loadCanvasModuleFresh(importer: () => Promise<CanvasModule>): Promise<CanvasModule> {
  try {
    const mod = await importer();
    if (typeof mod.createCanvas !== "function") throw new Error("createCanvas 가 없음");
    return mod;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new DocumentOcrConfigError(`쪽 그림 모듈(${CANVAS_MODULE})을 불러오지 못함: ${reason}`, { cause: err });
  }
}
