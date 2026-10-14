/**
 * routes/documents-ocr-api — 파일 업로드 OCR API 요청 옵션과 설정 제한 시간 초과 (2026-10-14 backfill-retry-ledger spec 3장·7장 A).
 * 공급자 자리에 진짜 로컬 HTTP 서버(Bun.serve)를 세운다(mock 클래스 0).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MEMORY_DEFAULTS } from "../../settings/memory-schema.ts";
import type { DocumentOcrSettings } from "../../settings/memory-settings.ts";
import { startProviderStandIn, type ProviderStandIn } from "../../test-utils/provider-stand-in.ts";
import { buildHttpFileOcrInit, callHttpFileOcrApi, HttpFileOcrError } from "./documents-ocr-api.ts";

let standIn: ProviderStandIn;
beforeAll(() => { standIn = startProviderStandIn(); });
afterAll(() => standIn.stop());

function fileApiSettings(timeoutMs: number): DocumentOcrSettings {
  const s = structuredClone(MEMORY_DEFAULTS.documents.ocr) as unknown as DocumentOcrSettings;
  s.mode = "api";
  s.api.provider = "http_file_api";
  s.api.endpointUrl = `${standIn.origin}/ocr`;
  s.api.apiKey = "";
  s.schedule.timeoutMs = timeoutMs;
  return s;
}

const INPUT = { documentId: "doc_1", bytes: new Uint8Array([1, 2, 3]), mimeType: "application/pdf", originalName: "scan.pdf" };

describe("파일 업로드 OCR API", () => {
  test("요청 옵션에 timeout:false 와 시간 제한 signal 이 실린다", () => {
    const form = new FormData();
    const signal = AbortSignal.timeout(1000);
    const init = buildHttpFileOcrInit({ Authorization: "Bearer k" }, form, signal);
    expect(init).toMatchObject({ method: "POST", timeout: false, headers: { Authorization: "Bearer k" } });
    expect(init.body).toBe(form);
    expect(init.signal).toBe(signal);
  });

  test("설정 제한(80ms)에서 끊기면 timedOut=true 와 'timeout (80ms 초과)' 문장", async () => {
    standIn.reply = () => ({ hang: true });
    let caught: unknown;
    try {
      await callHttpFileOcrApi(fileApiSettings(80), INPUT);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpFileOcrError);
    expect((caught as HttpFileOcrError).timedOut).toBe(true);
    expect((caught as HttpFileOcrError).message).toBe("OCR API timeout (80ms 초과)");
  });
});
